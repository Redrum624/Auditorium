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
  type PodcastChainStageId,
} from './podcastChain';
import { registerAllEffects } from '../effects/registerAll';
import { createDocument } from '../audio/AudioDocument';
import { useAppStore, makeInitialState } from '../stores/appStore';
import { getHistory, undo } from './undoHistory';
import { gatedLevelDb } from '../dsp/coverMatch';
import { integratedLoudness, samplePeakDb } from '../dsp/loudness';
import { detectSilentRuns } from '../dsp/silenceDetect';
import { GATE_MIN_REGION_MS } from './vocalChain';
import { _resetDspWorkerTestState } from '../__mocks__/createDspWorkerMock';

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
    expect(level).not.toBeNull();

    const resolved = resolvePodcastStage(podcastStageById('compressor'), channels, SR);

    expect(resolved.run).toBe(true);
    if (!resolved.run) return;
    expect(Number(resolved.params.ratio)).toBe(PODCAST_COMPRESSOR_RATIO);
    expect(Number(resolved.params.thresholdDb)).toBeCloseTo(level + PODCAST_COMPRESSOR_OFFSET_DB, 6);
    expect(resolved.derived.length).toBeGreaterThan(0);
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
    const sentences = PODCAST_CHAIN_STAGES.flatMap((s) => s.note.split(/(?<=[.:;])\s+/));
    for (const sentence of sentences) {
      if (!/dBTP|true[- ]peak/i.test(sentence)) continue;
      expect(sentence).toMatch(/\b(not|never|nothing|no)\b/i);
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
    expect(measured).not.toBeNull();

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
        for (let i = 0; i < original[c].length; i++) expect(restored[c][i]).toBe(original[c][i]);
      }
    },
    RUN_TIMEOUT_MS
  );

  it(
    'shortens the pauses to about 400 ms — same number of low-level runs, less total length',
    async () => {
      const before = stereoTake();
      const runsBefore = lowLevelRuns(before);
      seedDoc(stereoTake());

      const report = await runPodcastChain({ enabled: defaultPodcastStageSelection() });

      expect(report!.applied).toBe(true);
      const after = activeDoc().channels;
      const runsAfter = lowLevelRuns(after);
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
      const removedSeconds = (TAKE_SAMPLES - report!.outputSamples) / SR;
      expect(removedSeconds).toBeGreaterThan(3);
      expect(removedSeconds).toBeLessThan(4);
    },
    RUN_TIMEOUT_MS
  );

  it(
    'lands -16.0 LUFS on stereo with the sample peak under -1.0 dBFS',
    async () => {
      seedDoc(stereoTake());

      const report = await runPodcastChain({ enabled: defaultPodcastStageSelection() });

      const after = activeDoc().channels;
      expect(integratedLoudness(after, SR)!).toBeCloseTo(PODCAST_TARGET_LUFS_STEREO, 0);
      expect(Math.abs(integratedLoudness(after, SR)! - PODCAST_TARGET_LUFS_STEREO)).toBeLessThan(0.5);
      expect(samplePeakDb(after)).toBeLessThanOrEqual(PODCAST_LIMITER_CEILING_DB);
      // The report says the same thing the audio does.
      expect(report!.after.lufs!).toBeCloseTo(integratedLoudness(after, SR)!, 4);
      expect(report!.before.lufs).not.toBeNull();
    },
    RUN_TIMEOUT_MS
  );

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
    'reports the measured before AND after LUFS on the loudness stage',
    async () => {
      seedDoc(stereoTake());

      const report = await runPodcastChain({ enabled: defaultPodcastStageSelection() });

      const loudness = report!.stages.find((s) => s.id === 'loudness')!;
      expect(loudness.status).toBe('applied');
      const measured = loudness.loudness!;
      expect(measured.targetLufs).toBe(PODCAST_TARGET_LUFS_STEREO);
      expect(measured.gainDb).toBeCloseTo(measured.targetLufs - measured.beforeLufs, 6);
      // `afterLufs` is MEASURED on the result, not asserted from the arithmetic.
      expect(measured.afterLufs).not.toBeNull();
      expect(Math.abs(measured.afterLufs! - measured.targetLufs)).toBeLessThan(0.1);
      expect(measured.afterLufs).not.toBe(measured.beforeLufs);
    },
    RUN_TIMEOUT_MS
  );

  it(
    'leaves the level where the earlier stages put it when the loudness stage is off',
    async () => {
      seedDoc(stereoTake());
      const withLoudness = await runPodcastChain({ enabled: defaultPodcastStageSelection() });
      const measured = withLoudness!.stages.find((s) => s.id === 'loudness')!.loudness!;

      useAppStore.setState(makeInitialState());
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
      for (let c = 0; c < 3; c++) {
        for (let i = 0; i < original[c].length; i++) expect(after[c][i]).toBe(original[c][i]);
      }
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
    'still gates the pauses after Shorten Pauses has cut them, and says how much it silenced',
    async () => {
      // The interaction the two stages have BY CONSTRUCTION, pinned on the
      // measurement rather than on the arithmetic: Shorten Pauses leaves every
      // gap at PODCAST_SILENCE_TARGET_MS, which is UNDER the gate's own
      // GATE_MIN_REGION_MS minimum, and the gate applies anyway — the stretch it
      // sees is the gap plus the margins its region edges walk out to. The first
      // version of this file asserted the opposite from the constants alone and
      // was wrong; this is what the fixture actually does.
      expect(PODCAST_SILENCE_TARGET_MS).toBeLessThan(GATE_MIN_REGION_MS);
      seedDoc(stereoTake());

      const report = await runPodcastChain({ enabled: defaultPodcastStageSelection() });

      const gate = report!.stages.find((s) => s.id === 'gate')!;
      expect(gate.status).toBe('applied');
      // It muted something, and not everything.
      expect(gate.delta!.identicalFraction!).toBeLessThan(1);
      expect(gate.delta!.identicalFraction!).toBeGreaterThan(0.5);
      expect(gate.detail).toMatch(/digital silence/);
      expect(report!.applied).toBe(true);
    },
    RUN_TIMEOUT_MS
  );

  it(
    'earns its limiter: the loudness gain takes the peak over full scale and the limiter brings it to the ceiling',
    async () => {
      // Measured on this fixture: Noise Reduction raises the peak to
      // -12.4 dBFS, the loudness gain takes it to +0.6, and the limiter lands
      // -1.0. So the ceiling is doing real work here rather than being a
      // decoration that never catches anything.
      seedDoc(stereoTake());

      const report = await runPodcastChain({ enabled: defaultPodcastStageSelection() });

      const limiter = report!.stages.find((s) => s.id === 'limiter')!;
      expect(limiter.status).toBe('applied');
      expect(limiter.delta!.peakBeforeDb).toBeGreaterThan(PODCAST_LIMITER_CEILING_DB);
      expect(limiter.delta!.peakAfterDb).toBeCloseTo(PODCAST_LIMITER_CEILING_DB, 1);
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

  it(
    'says nothing about the peak when the limiter is ON to catch it',
    async () => {
      seedDoc(stereoTake());
      const report = await runPodcastChain({ enabled: defaultPodcastStageSelection() });
      expect(report!.stages.find((s) => s.id === 'loudness')!.warning).toBeUndefined();
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
      const after = activeDoc().channels;
      for (let i = 0; i < original[0].length; i++) expect(after[0][i]).toBe(original[0][i]);
    },
    RUN_TIMEOUT_MS
  );
});
