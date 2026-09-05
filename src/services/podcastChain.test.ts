import {
  PODCAST_CHAIN_MAX_CHANNELS,
  PODCAST_CHAIN_STAGES,
  PODCAST_CHAIN_UNDO_LABEL,
  PODCAST_CHANNEL_REFUSAL,
  PODCAST_COMPRESSOR_OFFSET_DB,
  PODCAST_COMPRESSOR_RATIO,
  PODCAST_EQ_HP_HZ,
  PODCAST_EQ_MUD_GAIN_DB,
  PODCAST_EQ_MUD_HZ,
  PODCAST_EQ_PRESENCE_GAIN_DB,
  PODCAST_EQ_PRESENCE_HZ,
  PODCAST_LIMITER_CEILING_DB,
  PODCAST_SILENCE_TARGET_MS,
  PODCAST_TARGET_LUFS_MONO,
  PODCAST_TARGET_LUFS_STEREO,
  defaultPodcastStageSelection,
  deriveLoudness,
  podcastStageById,
  resolvePodcastStage,
  runPodcastChain,
  type PodcastChainReport,
  type PodcastChainStageId,
} from './podcastChain';
import { registerAllEffects } from '../effects/registerAll';
import { createDocument, docLength } from '../audio/AudioDocument';
import { useAppStore, makeInitialState } from '../stores/appStore';
import { getHistory, undo } from './undoHistory';
import { gatedLevelDb } from '../dsp/coverMatch';
import { integratedLoudness, samplePeakDb } from '../dsp/loudness';
import { detectSilentRuns } from '../dsp/silenceDetect';
import { envelopeFollower, maxAcrossChannels } from '../dsp/envelope';
import { reductionDb } from '../effects/dynamics/CompressorEffect';
import { GATE_HEADROOM_DB, GATE_MIN_REGION_MS, deriveRemoveSilence } from './vocalChain';
import { _resetDspWorkerTestState, _setDspWorkerLoadFailure } from '../__mocks__/createDspWorkerMock';
import { readFileSync } from 'fs';
import { join } from 'path';

registerAllEffects();

const SR = 44100;
/** A run of the chain over the 10 s fixture is eight worker legs plus two
 * loudness passes; the default 5 s Jest budget is not for that. */
const RUN_TIMEOUT_MS = 120_000;

// ── The speech-like fixture (D6 acceptance) ─────────────────────────────────
// Bursts of a 200 Hz + 2 kHz tone at -20 dBFS peak separated by 1.2 s pauses at
// a -60 dBFS floor, 44100 Hz. Deliberately off every identity value: the two
// channels carry DIFFERENT amplitudes and different floor seeds, so a stage
// that only ever touches channel 0 cannot pass.

const BURST_MS = 1000;
const PAUSE_MS = 1200;
const BURSTS = 4;
const BURST_SAMPLES = Math.round((BURST_MS / 1000) * SR);
const PAUSE_SAMPLES = Math.round((PAUSE_MS / 1000) * SR);
/** pause, burst, pause, burst, pause, burst, pause, burst, pause. */
const TAKE_SAMPLES = (BURSTS + 1) * PAUSE_SAMPLES + BURSTS * BURST_SAMPLES;

interface TakeOptions {
  /** Peak amplitude of the two-tone burst (the two tones sum to `2 * a`). */
  amplitude: number;
  /** Floor RMS in dBFS, or `null` for exact digital silence in the pauses. */
  floorDb: number | null;
  seed: number;
}

function speechChannel({ amplitude, floorDb, seed }: TakeOptions): Float32Array {
  const out = new Float32Array(TAKE_SAMPLES);
  let s = seed >>> 0;
  const rnd = (): number => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return (s / 0xffffffff) * 2 - 1;
  };
  // Uniform noise has RMS a/sqrt(3), so the amplitude that lands ON a stated
  // RMS is that scaled back up.
  const floorAmp = floorDb === null ? 0 : Math.pow(10, floorDb / 20) * Math.sqrt(3);
  if (floorAmp > 0) for (let i = 0; i < TAKE_SAMPLES; i++) out[i] = rnd() * floorAmp;

  const fade = Math.round(0.01 * SR);
  for (let b = 0; b < BURSTS; b++) {
    const at = (b + 1) * PAUSE_SAMPLES + b * BURST_SAMPLES;
    for (let i = 0; i < BURST_SAMPLES; i++) {
      const t = (at + i) / SR;
      let env = 1;
      if (i < fade) env = 0.5 - 0.5 * Math.cos((Math.PI * i) / fade);
      else if (i >= BURST_SAMPLES - fade) {
        env = 0.5 - 0.5 * Math.cos((Math.PI * (BURST_SAMPLES - 1 - i)) / fade);
      }
      out[at + i] +=
        env * (amplitude / 2) * (Math.sin(2 * Math.PI * 200 * t) + Math.sin(2 * Math.PI * 2000 * t));
    }
  }
  return out;
}

/** The stereo take: two DISTINCT channels, neither a copy of the other. */
function stereoTake(floorDb: number | null = -60): Float32Array[] {
  return [
    speechChannel({ amplitude: 0.1, floorDb, seed: 11 }),
    speechChannel({ amplitude: 0.09, floorDb, seed: 29 }),
  ];
}

function monoTake(floorDb: number | null = -60): Float32Array[] {
  return [speechChannel({ amplitude: 0.1, floorDb, seed: 11 })];
}

function seedDoc(channels: Float32Array[], sampleRate = SR): string {
  const doc = createDocument({ name: 'podcast', sampleRate, channels });
  useAppStore.getState().addDocument(doc);
  return doc.id;
}

function activeDoc() {
  const s = useAppStore.getState();
  return s.documents.find((d) => d.id === s.activeDocumentId)!;
}

/** All stages off, then only the named ones on. */
function only(...ids: PodcastChainStageId[]): Record<PodcastChainStageId, boolean> {
  const enabled = {} as Record<PodcastChainStageId, boolean>;
  for (const stage of PODCAST_CHAIN_STAGES) enabled[stage.id] = false;
  for (const id of ids) enabled[id] = true;
  return enabled;
}

/** The default selection with the named stages forced off. */
function defaultsWithout(...ids: PodcastChainStageId[]): Record<PodcastChainStageId, boolean> {
  const enabled = defaultPodcastStageSelection();
  for (const id of ids) enabled[id] = false;
  return enabled;
}

/**
 * The low-level stretches, measured with the app's own silence detector.
 *
 * The threshold is RELATIVE to the signal's own peak, deliberately: the chain
 * moves the absolute level by design (Noise Reduction takes 11 dB off the floor,
 * the loudness stage puts several dB back on the lot), so an absolute threshold
 * measures a different thing before and after and the comparison would be
 * meaningless. 25 dB under the peak sits far below the speech and far above the
 * floor at both ends of the chain.
 */
function lowLevelRuns(channels: Float32Array[], sampleRate = SR): { start: number; end: number }[] {
  return detectSilentRuns(channels, sampleRate, samplePeakDb(channels) - 25, 200);
}

function totalRunSamples(runs: { start: number; end: number }[]): number {
  return runs.reduce((sum, r) => sum + (r.end - r.start), 0);
}

/**
 * Index of the first sample where `after[i - shift]` differs from `before[i]`
 * over `[from, to)`, or -1 when the span is identical.
 *
 * A byte-identity claim over 441000 samples is 441000 `expect` calls otherwise,
 * which is most of what a test like that costs. This asserts once and names the
 * offending sample when it fails, which is strictly more than a bare pass/fail
 * per index gave.
 */
function firstDifference(
  after: Float32Array,
  before: Float32Array,
  from = 0,
  to = before.length,
  shift = 0
): number {
  for (let i = from; i < to; i++) if (after[i - shift] !== before[i]) return i;
  return -1;
}

beforeEach(() => {
  useAppStore.setState(makeInitialState());
  _resetDspWorkerTestState();
});

afterEach(() => {
  _resetDspWorkerTestState();
});

// ── The stage table ─────────────────────────────────────────────────────────

describe('PODCAST_CHAIN_STAGES', () => {
  it('runs D6’s order exactly', () => {
    expect(PODCAST_CHAIN_STAGES.map((s) => s.id)).toEqual([
      'dc',
      'noise',
      'hum',
      'silence',
      'gate',
      'compressor',
      'deEsser',
      'eq',
      'loudness',
      'limiter',
    ]);
  });

  it('normalises loudness AFTER every stage that shapes the voice and BEFORE the limiter', () => {
    const ids = PODCAST_CHAIN_STAGES.map((s) => s.id);
    expect(ids.indexOf('loudness')).toBeGreaterThan(ids.indexOf('eq'));
    expect(ids.indexOf('loudness')).toBeLessThan(ids.indexOf('limiter'));
    expect(ids[ids.length - 1]).toBe('limiter');
  });

  it('shortens the pauses BEFORE the dynamics stages, so nothing lifts a floor that is about to go', () => {
    const ids = PODCAST_CHAIN_STAGES.map((s) => s.id);
    expect(ids.indexOf('silence')).toBeLessThan(ids.indexOf('compressor'));
    expect(ids.indexOf('deEsser')).toBeGreaterThan(ids.indexOf('compressor'));
  });

  it('gives every stage a note and a positive progress weight', () => {
    for (const stage of PODCAST_CHAIN_STAGES) {
      expect(stage.note.length).toBeGreaterThan(40);
      expect(stage.weight).toBeGreaterThan(0);
    }
  });

  it('has exactly ONE stage the chain applies itself — the loudness stage carries no effect id', () => {
    const own = PODCAST_CHAIN_STAGES.filter((s) => s.effectId === null);
    expect(own.map((s) => s.id)).toEqual(['loudness']);
  });

  it('shortens pauses BY DEFAULT — unlike the vocal chain, this pass is for spoken word', () => {
    const enabled = defaultPodcastStageSelection();
    expect(enabled.silence).toBe(true);
    expect(enabled.loudness).toBe(true);
    expect(enabled.limiter).toBe(true);
  });

  it('podcastStageById throws on an unknown id rather than returning undefined', () => {
    expect(() => podcastStageById('nope' as PodcastChainStageId)).toThrow();
  });
});

// ── The per-stage settings ──────────────────────────────────────────────────

describe('the podcast settings resolution', () => {
  it('sets the compressor to 3:1 with the threshold 6 dB under the GATED programme level', () => {
    const channels = stereoTake();
    const level = gatedLevelDb(channels, SR)!;

    const resolved = resolvePodcastStage(podcastStageById('compressor'), channels, SR);

    expect(resolved.run).toBe(true);
    if (!resolved.run) return;
    expect(Number(resolved.params.ratio)).toBe(PODCAST_COMPRESSOR_RATIO);
    expect(Number(resolved.params.thresholdDb)).toBeCloseTo(level + PODCAST_COMPRESSOR_OFFSET_DB, 6);
    expect(resolved.derived.length).toBeGreaterThan(0);
  });

  /**
   * C4 — the reduction the Compressor's note claims, MEASURED through the
   * shipped detector rather than derived from the threshold offset.
   *
   * The offset alone says 4 dB (6 dB over the threshold at 3:1), and that is
   * wrong: the threshold is placed under the GATED RMS level, while the effect's
   * detector is an envelope follower on max|x| — a peak-ish quantity that sits
   * ABOVE that RMS, so the sounding material runs further over the threshold
   * than the offset says and lands more reduction. This runs the effect's own
   * `reductionDb` over the effect's own detector, on the burst windows only
   * (the pauses are what the gate is for), so the note's figure is pinned to
   * something the code actually does.
   */
  it('lands the gain reduction its note claims — measured through the shipped detector', () => {
    const channels = stereoTake();
    const resolved = resolvePodcastStage(podcastStageById('compressor'), channels, SR);
    expect(resolved.run).toBe(true);
    if (!resolved.run) return;
    const thresholdDb = Number(resolved.params.thresholdDb);
    const env = envelopeFollower(
      maxAcrossChannels(channels),
      SR,
      Number(resolved.params.attackMs),
      Number(resolved.params.releaseMs)
    );
    const fade = Math.round(0.01 * SR); // the fixture's own burst fades
    const reductions: number[] = [];
    for (let b = 0; b < BURSTS; b++) {
      const at = (b + 1) * PAUSE_SAMPLES + b * BURST_SAMPLES;
      for (let i = fade; i < BURST_SAMPLES - fade; i++) {
        const envDb = 20 * Math.log10(Math.max(env[at + i], 1e-6));
        reductions.push(
          reductionDb(envDb - thresholdDb, Number(resolved.params.ratio), Number(resolved.params.kneeDb))
        );
      }
    }
    reductions.sort((a, b) => a - b);
    const median = reductions[Math.floor(reductions.length / 2)];
    // 6.82 dB when this was written — the note says "about 7 dB", and the band
    // is wide enough that a rounding change in the fixture does not fail it and
    // narrow enough that the offset-only 4 dB would.
    expect(median).toBeGreaterThan(5.5);
    expect(median).toBeLessThan(7.5);
  });

  it('declines the compressor when nothing sounds — a gated level of nothing is not a threshold', () => {
    const silent = [new Float32Array(SR), new Float32Array(SR)];
    const resolved = resolvePodcastStage(podcastStageById('compressor'), silent, SR);
    expect(resolved.run).toBe(false);
    if (resolved.run) return;
    expect(resolved.reason.length).toBeGreaterThan(10);
  });

  it('sets the limiter ceiling to -1.0 dBFS SAMPLE peak', () => {
    const resolved = resolvePodcastStage(podcastStageById('limiter'), stereoTake(), SR);
    expect(resolved.run).toBe(true);
    if (!resolved.run) return;
    expect(Number(resolved.params.ceilingDb)).toBe(PODCAST_LIMITER_CEILING_DB);
    expect(PODCAST_LIMITER_CEILING_DB).toBe(-1);
  });

  it('calls the ceiling a SAMPLE peak, and mentions true peak only to deny it', () => {
    // The limiter is not oversampled, so "true peak"/"dBTP" is a claim the DSP
    // cannot support. Saying "this is NOT a true-peak reading" is the disclosure
    // that rule exists for, so the pin is on the claim, not on the word.
    expect(podcastStageById('limiter').note).toMatch(/sample peak/i);

    // Every string this module can put in front of a user: the stage notes, the
    // refusal, and every derived label/value/from the stages produce — the
    // limiter's `from` says "not a true-peak figure" and is only reachable this
    // way.
    const channels = stereoTake();
    const derivedText = PODCAST_CHAIN_STAGES.filter((st) => st.effectId !== null)
      .map((st) => resolvePodcastStage(st, channels, SR))
      .flatMap((r) => (r.run ? r.derived : [{ label: '', value: '', from: r.reason }]))
      .map((d) => `${d.label} ${d.value} ${d.from}`);
    const facing = [
      ...PODCAST_CHAIN_STAGES.map((st) => `${st.label} ${st.note}`),
      PODCAST_CHANNEL_REFUSAL,
      ...derivedText,
    ];
    expect(facing.some((t) => /sample peak/i.test(t))).toBe(true);

    // ...and the source file itself, comments included, so the docblock cannot
    // drift into claiming a reading the DSP does not take. Context rather than
    // sentence-splitting: a denial can sit either side of the phrase.
    const source = readFileSync(join(__dirname, 'podcastChain.ts'), 'utf8');
    const scanned = [...facing, source];
    for (const text of scanned) {
      const re = /dBTP|true[- ]peak/gi;
      let match: RegExpExecArray | null;
      while ((match = re.exec(text)) !== null) {
        const context = text.slice(Math.max(0, match.index - 140), match.index + 140);
        // Mentioned only to deny it — never as a label for what is measured.
        expect(context).toMatch(/\b(not|never|nothing|no)\b/i);
      }
    }
  });

  it('shortens pauses to 400 ms rather than removing them', () => {
    const resolved = resolvePodcastStage(podcastStageById('silence'), stereoTake(), SR);
    expect(resolved.run).toBe(true);
    if (!resolved.run) return;
    expect(resolved.params.mode).toBe('shorten');
    expect(Number(resolved.params.targetMs)).toBe(PODCAST_SILENCE_TARGET_MS);
    expect(PODCAST_SILENCE_TARGET_MS).toBe(400);
  });

  it('clears the vocal chain’s silence threshold by the gate’s own measured headroom', () => {
    // Measured on this fixture after Noise Reduction: the settled floor grazes
    // the bare threshold by 0.32 dB, 59-85 % of each pause sits below it and the
    // longest continuous run below is 0.048-0.352 s — so against the 500 ms
    // minimum NOTHING is detected and no pause is shortened. GATE_HEADROOM_DB is
    // the vocal chain's own measurement of that graze, reused rather than
    // re-derived.
    const channels = stereoTake();
    const bare = deriveRemoveSilence(channels, SR);
    const resolved = resolvePodcastStage(podcastStageById('silence'), channels, SR);

    expect(bare.run).toBe(true);
    expect(resolved.run).toBe(true);
    if (!bare.run || !resolved.run) return;
    expect(Number(resolved.params.thresholdDb)).toBeCloseTo(
      Number(bare.params.thresholdDb) + GATE_HEADROOM_DB,
      6
    );
  });

  it('shapes the EQ for speech: 80 Hz high-pass, -2 dB at 250 Hz, +2 dB at 3 kHz', () => {
    const resolved = resolvePodcastStage(podcastStageById('eq'), stereoTake(), SR);
    expect(resolved.run).toBe(true);
    if (!resolved.run) return;
    const p = resolved.params;
    expect(p.hpEnabled).toBe(true);
    expect(Number(p.hpFreq)).toBe(PODCAST_EQ_HP_HZ);

    const bands = [1, 2, 3, 4, 5].map((n) => ({
      enabled: p[`band${n}Enabled`] === true,
      freq: Number(p[`band${n}Freq`]),
      gain: Number(p[`band${n}Gain`]),
    }));
    const mud = bands.find((b) => b.enabled && b.freq === PODCAST_EQ_MUD_HZ);
    const presence = bands.find((b) => b.enabled && b.freq === PODCAST_EQ_PRESENCE_HZ);
    expect(mud?.gain).toBe(PODCAST_EQ_MUD_GAIN_DB);
    expect(presence?.gain).toBe(PODCAST_EQ_PRESENCE_GAIN_DB);
    // Every other enabled band stays flat: this chain shapes two places, and a
    // band left on at a gain nobody chose is a third.
    for (const band of bands) {
      if (!band.enabled) continue;
      if (band.freq === PODCAST_EQ_MUD_HZ || band.freq === PODCAST_EQ_PRESENCE_HZ) continue;
      expect(band.gain).toBe(0);
    }
    // The live line must not claim "this stage derives nothing" while three
    // parameters were overridden.
    expect(resolved.derived.length).toBeGreaterThan(0);
  });

  it('resolving the loudness stage through the effect path is a programming error', () => {
    expect(() => resolvePodcastStage(podcastStageById('loudness'), stereoTake(), SR)).toThrow();
  });
});

describe('deriveLoudness', () => {
  it('targets -16 LUFS on stereo and asks for exactly the gain that lands it', () => {
    const channels = stereoTake();
    const measured = integratedLoudness(channels, SR)!;

    const resolved = deriveLoudness(channels, SR);

    expect(resolved.run).toBe(true);
    if (!resolved.run) return;
    expect(resolved.targetLufs).toBe(PODCAST_TARGET_LUFS_STEREO);
    expect(PODCAST_TARGET_LUFS_STEREO).toBe(-16);
    expect(resolved.beforeLufs).toBeCloseTo(measured, 6);
    expect(resolved.gainDb).toBeCloseTo(PODCAST_TARGET_LUFS_STEREO - measured, 6);
  });

  it('targets -19 LUFS on mono — the same programme reads 3 LU lower in one channel', () => {
    const resolved = deriveLoudness(monoTake(), SR);
    expect(resolved.run).toBe(true);
    if (!resolved.run) return;
    expect(resolved.targetLufs).toBe(PODCAST_TARGET_LUFS_MONO);
    expect(PODCAST_TARGET_LUFS_MONO).toBe(-19);
  });

  it('declines on silence rather than asking for infinite gain', () => {
    const resolved = deriveLoudness([new Float32Array(SR * 2), new Float32Array(SR * 2)], SR);
    expect(resolved.run).toBe(false);
    if (resolved.run) return;
    expect(resolved.reason.length).toBeGreaterThan(10);
  });
});

// ── The run ─────────────────────────────────────────────────────────────────

describe('runPodcastChain', () => {
  it('resolves null with nothing to run on', async () => {
    expect(await runPodcastChain({ enabled: defaultPodcastStageSelection() })).toBeNull();
  });

  it(
    'commits the WHOLE chain as ONE undo entry labelled Podcast Chain',
    async () => {
      const docId = seedDoc(stereoTake());
      const historyBefore = getHistory(docId).done.length;

      const report = await runPodcastChain({ enabled: defaultPodcastStageSelection() });

      expect(report).not.toBeNull();
      expect(report!.applied).toBe(true);
      expect(report!.stages.filter((s) => s.status === 'applied').length).toBeGreaterThan(1);
      expect(getHistory(docId).done.length).toBe(historyBefore + 1);
      expect(getHistory(docId).done[getHistory(docId).done.length - 1]).toBe(
        PODCAST_CHAIN_UNDO_LABEL
      );
      expect(PODCAST_CHAIN_UNDO_LABEL).toBe('Podcast Chain');
    },
    RUN_TIMEOUT_MS
  );

  it(
    'one undo puts the whole chain back',
    async () => {
      const original = stereoTake().map((c) => Float32Array.from(c));
      const docId = seedDoc(stereoTake());

      await runPodcastChain({ enabled: defaultPodcastStageSelection() });
      expect(activeDoc().channels[0].length).not.toBe(original[0].length);

      undo(docId);

      const restored = activeDoc().channels;
      expect(restored.length).toBe(2);
      for (let c = 0; c < 2; c++) {
        expect(restored[c].length).toBe(original[c].length);
        expect(firstDifference(restored[c], original[c])).toBe(-1);
      }
    },
    RUN_TIMEOUT_MS
  );

  // ── One resolved region, every consumer ──────────────────────────────────
  // Both of these run `only('silence')` — seconds, not a ten-stage pass — and
  // both exist because a test file whose every run starts at sample 0 cannot
  // tell `start + x` from `x`. The sibling chains pin exactly this
  // (`vocalChain.test.ts` L11, `coverChain.test.ts` L11), and until these two
  // landed `start` could have been deleted from the cuts remap, from the
  // post-edit selection and from the cursor with the whole file still green.

  it(
    'edits the SELECTED region only, and offsets the new selection and cursor from its start',
    async () => {
      const original = stereoTake().map((c) => Float32Array.from(c));
      seedDoc(stereoTake());
      // 1.0 s -> 6.0 s: opens inside the first pause and closes inside the third
      // burst, so neither edge sits on a fixture boundary and neither is 0.
      const start = SR;
      const end = 6 * SR;
      useAppStore.getState().setSelection({ start, end });

      const report = await runPodcastChain({ enabled: only('silence') });

      expect(report!.regionSamples).toBe(end - start);
      expect(report!.outputSamples).toBeLessThan(report!.regionSamples);
      const removed = report!.regionSamples - report!.outputSamples;
      expect(docLength(activeDoc())).toBe(TAKE_SAMPLES - removed);

      const after = activeDoc().channels;
      for (let c = 0; c < 2; c++) {
        // Everything ahead of the region came through untouched...
        expect(firstDifference(after[c], original[c], 0, start)).toBe(-1);
        // ...and everything behind it is the same audio, moved left by the cut.
        expect(firstDifference(after[c], original[c], end, TAKE_SAMPLES, removed)).toBe(-1);
      }

      // START-relative, both of them. Drop `start` from either expression and
      // this is the assertion that says so.
      expect(useAppStore.getState().selection).toEqual({
        start,
        end: start + report!.outputSamples,
      });
      expect(useAppStore.getState().cursorSample).toBe(start);
    },
    RUN_TIMEOUT_MS
  );

  it(
    'remaps markers around the removed pauses in DOCUMENT coordinates, not region ones',
    async () => {
      const docId = seedDoc(stereoTake());
      // 5.0 s -> 8.8 s. Every cut this makes therefore lands in the SECOND half
      // of the document, which is what turns the marker ahead of the region into
      // a test of the OFFSET rather than of the remap in general: offset the
      // cuts by anything other than `start` and they slide down the document
      // until they sit in front of that marker, which then moves.
      const start = 5 * SR;
      const end = Math.round(8.8 * SR);
      useAppStore.getState().setMarkersForDoc(docId, [
        { id: 'before', positionSample: 200000, name: 'before the region' },
        { id: 'after', positionSample: 420000, name: 'after the region' },
      ]);
      useAppStore.getState().setSelection({ start, end });

      const report = await runPodcastChain({ enabled: only('silence') });

      expect(report!.applied).toBe(true);
      const removed = report!.regionSamples - report!.outputSamples;
      expect(removed).toBeGreaterThan(0);

      const markers = useAppStore.getState().markers[docId];
      // Ahead of every cut: it does not move at all.
      expect(markers.find((m) => m.id === 'before')!.positionSample).toBe(200000);
      // Behind every cut: moved left by exactly what came out.
      expect(markers.find((m) => m.id === 'after')!.positionSample).toBe(420000 - removed);
    },
    RUN_TIMEOUT_MS
  );

  // ── One default run, read by seven tests ─────────────────────────────────
  // Seven tests asserted different facets of the SAME byte-identical default run
  // over the SAME byte-identical take, and each paid for its own ten-stage pass.
  // The run is hoisted here and shared. Nothing is weakened: every assertion
  // still reads a real default-chain output. What is shared is the captured
  // RESULT — the outer `beforeEach` still wipes the store before each test, so
  // no test in here may read live store state, and none does.
  describe('one default run over the speech take', () => {
    let report: PodcastChainReport;
    let output: Float32Array[];

    beforeAll(async () => {
      useAppStore.setState(makeInitialState());
      _resetDspWorkerTestState();
      seedDoc(stereoTake());
      report = (await runPodcastChain({ enabled: defaultPodcastStageSelection() }))!;
      output = activeDoc().channels.map((c) => Float32Array.from(c));
    }, RUN_TIMEOUT_MS);

    it('applies, on a two-channel document, with no refusal', () => {
      expect(report).toBeDefined();
      expect(report.applied).toBe(true);
      expect(report.refusal).toBeNull();
      expect(output.length).toBe(2);
    });

    it('shortens the pauses to about 400 ms — same number of low-level runs, less total length', () => {
      const runsBefore = lowLevelRuns(stereoTake());
      const runsAfter = lowLevelRuns(output);
      expect(runsBefore.length).toBe(BURSTS + 1);
      expect(runsAfter.length).toBe(runsBefore.length);
      expect(totalRunSamples(runsAfter)).toBeLessThan(totalRunSamples(runsBefore));
      const targetSamples = (PODCAST_SILENCE_TARGET_MS / 1000) * SR;
      for (const run of runsAfter) {
        // A measured run is the SHORTENED gap plus the part of the preceding
        // burst's decay that sits under a threshold 25 dB down but above the
        // stage's own — measured at 0.476-0.491 s against the 0.400 s target on
        // this fixture. The bounds are that measurement with room, not zero
        // tolerance around an arithmetic ideal.
        expect(run.end - run.start).toBeGreaterThan(targetSamples * 0.8);
        expect(run.end - run.start).toBeLessThan(targetSamples * 1.6);
      }
      // Five 1.09 s gaps down to 0.40 s each: about 3.45 s comes out.
      const removedSeconds = (TAKE_SAMPLES - report.outputSamples) / SR;
      expect(removedSeconds).toBeGreaterThan(3);
      expect(removedSeconds).toBeLessThan(4);
    });

    it('lands -16.0 LUFS on stereo with the sample peak under -1.0 dBFS', () => {
      const measured = integratedLoudness(output, SR)!;
      expect(measured).toBeCloseTo(PODCAST_TARGET_LUFS_STEREO, 0);
      expect(Math.abs(measured - PODCAST_TARGET_LUFS_STEREO)).toBeLessThan(0.5);
      expect(samplePeakDb(output)).toBeLessThanOrEqual(PODCAST_LIMITER_CEILING_DB);
      // The report says the same thing the audio does.
      expect(report.after.lufs!).toBeCloseTo(measured, 4);
      expect(report.before.lufs).not.toBeNull();
    });

    it('reports the measured before AND after LUFS on the loudness stage', () => {
      const loudness = report.stages.find((s) => s.id === 'loudness')!;
      expect(loudness.status).toBe('applied');
      const measured = loudness.loudness!;
      expect(measured.targetLufs).toBe(PODCAST_TARGET_LUFS_STEREO);
      expect(measured.gainDb).toBeCloseTo(measured.targetLufs - measured.beforeLufs, 6);
      // `afterLufs` is MEASURED on the result, not asserted from the arithmetic.
      expect(measured.afterLufs).not.toBeNull();
      expect(Math.abs(measured.afterLufs! - measured.targetLufs)).toBeLessThan(0.1);
      expect(measured.afterLufs).not.toBe(measured.beforeLufs);
    });

    it('still gates the pauses after Shorten Pauses has cut them, and says how much it silenced', () => {
      // The interaction the two stages have BY CONSTRUCTION, pinned on the
      // measurement rather than on the arithmetic: Shorten Pauses leaves every
      // gap at PODCAST_SILENCE_TARGET_MS, which is UNDER the gate's own
      // GATE_MIN_REGION_MS minimum, and the gate applies anyway — the stretch it
      // sees is the gap plus the margins its region edges walk out to. The first
      // version of this file asserted the opposite from the constants alone and
      // was wrong; this is what the fixture actually does.
      expect(PODCAST_SILENCE_TARGET_MS).toBeLessThan(GATE_MIN_REGION_MS);
      const gate = report.stages.find((s) => s.id === 'gate')!;
      expect(gate.status).toBe('applied');
      // It muted something, and not everything.
      expect(gate.delta!.identicalFraction!).toBeLessThan(1);
      expect(gate.delta!.identicalFraction!).toBeGreaterThan(0.5);
      expect(gate.detail).toMatch(/digital silence/);
    });

    it('earns its limiter: the loudness gain takes the peak over full scale and the limiter brings it to the ceiling', () => {
      // Measured on this fixture: Noise Reduction raises the peak to
      // -12.4 dBFS, the loudness gain takes it to +0.6, and the limiter lands
      // -1.0. So the ceiling is doing real work here rather than being a
      // decoration that never catches anything.
      const limiter = report.stages.find((s) => s.id === 'limiter')!;
      expect(limiter.status).toBe('applied');
      expect(limiter.delta!.peakBeforeDb).toBeGreaterThan(PODCAST_LIMITER_CEILING_DB);
      expect(limiter.delta!.peakAfterDb).toBeCloseTo(PODCAST_LIMITER_CEILING_DB, 1);
    });

    it('says nothing about the peak when the limiter is ON to catch it', () => {
      expect(report.stages.find((s) => s.id === 'loudness')!.warning).toBeUndefined();
    });

    it(
      'leaves the level where the earlier stages put it when the loudness stage is off',
      async () => {
        const measured = report.stages.find((s) => s.id === 'loudness')!.loudness!;
        seedDoc(stereoTake());

        const without = await runPodcastChain({ enabled: defaultsWithout('loudness') });

        expect(without!.applied).toBe(true);
        expect(without!.stages.find((s) => s.id === 'loudness')!.status).toBe('off');
        // The level the EARLIER stages left is exactly what the loudness stage
        // measured at its own input on the other run — non-circular, because the
        // two numbers come from two different runs.
        expect(without!.after.lufs!).toBeCloseTo(measured.beforeLufs, 1);
        // And it is NOT the target: the stage was doing real work.
        expect(Math.abs(without!.after.lufs! - PODCAST_TARGET_LUFS_STEREO)).toBeGreaterThan(1);
      },
      RUN_TIMEOUT_MS
    );
  });

  it(
    'lands -19.0 LUFS on mono',
    async () => {
      seedDoc(monoTake());

      const report = await runPodcastChain({ enabled: defaultPodcastStageSelection() });

      const after = activeDoc().channels;
      expect(after.length).toBe(1);
      expect(Math.abs(integratedLoudness(after, SR)! - PODCAST_TARGET_LUFS_MONO)).toBeLessThan(0.5);
      const loudness = report!.stages.find((s) => s.id === 'loudness')!;
      expect(loudness.status).toBe('applied');
      expect(loudness.loudness!.targetLufs).toBe(PODCAST_TARGET_LUFS_MONO);
      expect(samplePeakDb(after)).toBeLessThanOrEqual(PODCAST_LIMITER_CEILING_DB);
    },
    RUN_TIMEOUT_MS
  );

  it(
    'skips Noise Reduction — not fails it — when there is no noise print to learn',
    async () => {
      // Pauses of exact digital silence: every candidate window is zeros, so no
      // print can be learned from this take at all.
      seedDoc(stereoTake(null));

      const report = await runPodcastChain({ enabled: defaultPodcastStageSelection() });

      expect(report).not.toBeNull();
      const noise = report!.stages.find((s) => s.id === 'noise')!;
      expect(noise.status).toBe('declined');
      expect(noise.reason!.length).toBeGreaterThan(20);
      // The run carried on and still landed.
      expect(report!.applied).toBe(true);
    },
    RUN_TIMEOUT_MS
  );

  it(
    'refuses a document with more than two channels, names the fix, and applies nothing',
    async () => {
      const channels = [
        speechChannel({ amplitude: 0.1, floorDb: -60, seed: 11 }),
        speechChannel({ amplitude: 0.09, floorDb: -60, seed: 29 }),
        speechChannel({ amplitude: 0.08, floorDb: -60, seed: 47 }),
      ];
      const original = channels.map((c) => Float32Array.from(c));
      const docId = seedDoc(channels);
      const historyBefore = getHistory(docId).done.length;

      const report = await runPodcastChain({ enabled: defaultPodcastStageSelection() });

      expect(report).not.toBeNull();
      expect(report!.applied).toBe(false);
      expect(report!.refusal).toBe(PODCAST_CHANNEL_REFUSAL);
      expect(report!.refusal).toMatch(/stereo/i);
      expect(report!.refusal).toContain('Convert Channels');
      expect(PODCAST_CHAIN_MAX_CHANNELS).toBe(2);
      expect(getHistory(docId).done.length).toBe(historyBefore);
      const after = activeDoc().channels;
      expect(after.length).toBe(3);
      for (let c = 0; c < 3; c++) expect(firstDifference(after[c], original[c])).toBe(-1);
      // Nothing measured a loudness it has no standard-accurate answer for.
      expect(report!.before.lufs).toBeNull();
      expect(report!.after.lufs).toBeNull();
    },
    RUN_TIMEOUT_MS
  );

  it(
    'runs a two-channel document — the refusal is >2, not "not mono"',
    async () => {
      seedDoc(stereoTake());
      const report = await runPodcastChain({ enabled: only('dc') });
      expect(report!.refusal).toBeNull();
      expect(report!.applied).toBe(true);
    },
    RUN_TIMEOUT_MS
  );

  it(
    'visits the enabled stages in chain order and reports EVERY stage, run or not',
    async () => {
      seedDoc(stereoTake());
      const started: PodcastChainStageId[] = [];
      const seen: PodcastChainStageId[] = [];

      const report = await runPodcastChain({
        enabled: only('dc', 'compressor', 'limiter'),
        onStageStart: (s) => started.push(s.id),
        onStageResult: (r) => seen.push(r.id),
      });

      expect(started).toEqual(['dc', 'compressor', 'limiter']);
      expect(seen).toEqual(PODCAST_CHAIN_STAGES.map((s) => s.id));
      expect(report!.stages.map((s) => s.id)).toEqual(PODCAST_CHAIN_STAGES.map((s) => s.id));
      for (const id of ['noise', 'hum', 'silence', 'gate', 'deEsser', 'eq', 'loudness'] as const) {
        expect(report!.stages.find((s) => s.id === id)!.status).toBe('off');
      }
    },
    RUN_TIMEOUT_MS
  );

  it(
    'warns, with the number, when the loudness gain leaves the take over full scale and the limiter is off',
    async () => {
      // The one over-scale path this chain leaves open. Measured: on this
      // fixture the loudness gain takes the peak to +0.6 dBFS, and with the
      // Limiter switched off nothing between here and the WAV writer says so.
      seedDoc(stereoTake());

      const report = await runPodcastChain({ enabled: defaultsWithout('limiter') });

      const loudness = report!.stages.find((s) => s.id === 'loudness')!;
      expect(loudness.status).toBe('applied');
      expect(loudness.delta!.peakAfterDb).toBeGreaterThan(0);
      expect(loudness.warning).toBeDefined();
      expect(loudness.warning).toMatch(/full scale/i);
      expect(loudness.warning).toContain('Limiter');
      expect(samplePeakDb(activeDoc().channels)).toBeGreaterThan(0);
    },
    RUN_TIMEOUT_MS
  );

  /**
   * C6 — the abort path, which had no test at all: `catch (err) {
   * reportEffectFailure(err); return null; }` could have been a `continue` and
   * every other test here stayed green, because nothing made a stage fail. What
   * the docblock promises is that a failure aborts the REMAINING stages and
   * leaves the document exactly as it was — a ten-stage destructive chain that
   * committed a half-processed region under one "Podcast Chain" undo entry would
   * be the worst outcome this module has. Both siblings pin it the same way
   * (`vocalChain.test.ts`, `coverChain.test.ts`).
   */
  it(
    'aborts without touching the document when a stage fails',
    async () => {
      const original = stereoTake().map((c) => Float32Array.from(c));
      const docId = seedDoc(stereoTake());
      const historyBefore = getHistory(docId).done.length;
      const showMessageBox = jest.fn();
      (window as { electronAPI?: unknown }).electronAPI = { showMessageBox };
      _setDspWorkerLoadFailure('worker exploded');

      const report = await runPodcastChain({ enabled: only('dc', 'limiter') });

      // Resolves null rather than rejecting — the dialog awaits this, and a
      // rejection would leave it busy for ever.
      expect(report).toBeNull();
      // No undo entry, and not one sample changed in EITHER channel.
      expect(getHistory(docId).done.length).toBe(historyBefore);
      const after = activeDoc().channels;
      expect(after.length).toBe(2);
      for (let c = 0; c < 2; c++) expect(firstDifference(after[c], original[c])).toBe(-1);
      // Reported ONCE, on the FIRST failing stage, rather than once per
      // remaining stage — which is what `return null` buys over `continue`.
      expect(showMessageBox).toHaveBeenCalledTimes(1);
    },
    RUN_TIMEOUT_MS
  );

  it(
    'reports a run where every stage was off without touching the document',
    async () => {
      const original = stereoTake().map((c) => Float32Array.from(c));
      const docId = seedDoc(stereoTake());
      const historyBefore = getHistory(docId).done.length;

      const report = await runPodcastChain({ enabled: only() });

      expect(report!.applied).toBe(false);
      expect(report!.refusal).toBeNull();
      expect(getHistory(docId).done.length).toBe(historyBefore);
      expect(firstDifference(activeDoc().channels[0], original[0])).toBe(-1);
    },
    RUN_TIMEOUT_MS
  );
});
