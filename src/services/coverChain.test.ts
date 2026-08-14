import {
  COVER_CHAIN_CONFIRM_SENTENCE,
  COVER_CHAIN_GOOD_TAKE_SENTENCE,
  COVER_CHAIN_RESIDUAL_SENTENCE,
  COVER_CHAIN_SHAPING_SENTENCE,
  COVER_CHAIN_STAGES,
  COVER_CHAIN_UNDO_LABEL,
  RESIDUAL_BAND_HI_HZ,
  RESIDUAL_BAND_LO_HZ,
  RESIDUAL_BELOW_BED_DB,
  RESIDUAL_BELOW_VOCAL_DB,
  RESIDUAL_IN_BAND_BEST_DB,
  RESIDUAL_IN_BAND_WORST_DB,
  RESIDUAL_SECOND_PASS_DB,
  RESIDUAL_SECOND_PASS_WORST_OCTAVE_DB,
  REFERENCE_BELOW_MIX_FLOOR_DB,
  RESIDUAL_WORST_SECOND_DB,
  coverStageById,
  defaultCoverStageSelection,
  describeStage,
  deriveMatchEq,
  deriveMatchLoudness,
  deriveMatchReverb,
  matchDistanceDb,
  measureReference,
  runCoverChain,
  type CoverChainStageId,
  type CoverChainStageProgress,
  type CoverChainStageResult,
  type ReferenceMeasurements,
} from './coverChain';
import { getEffect } from '../effects/EffectRegistry';
import { registerAllEffects } from '../effects/registerAll';
import { GRAPHIC_EQ_BANDS } from '../effects/eq/GraphicEqEffect';
import { createDocument, docLength } from '../audio/AudioDocument';
import { useAppStore, makeInitialState } from '../stores/appStore';
import { getHistory, undo } from './undoHistory';
import { peakDb } from '../dsp/chainAnalysis';
import {
  ACTIVE_GATE_DB,
  LTAS_FFT_SIZE,
  MATCH_BAND_CENTRES_HZ,
  MATCH_BOUND_DB,
  MATCH_MIN_CENTRE_HZ,
  bandLevelDb,
  gatedLevelDb,
  longTermAverageSpectrum,
  reverbRt60Seconds,
  type Ltas,
} from '../dsp/coverMatch';
import * as coverMatch from '../dsp/coverMatch';
import { SOLVE_TOLERANCE_DB, realisedBandEnergyDb } from '../dsp/graphicEqCascade';
import { _resetDspWorkerTestState, _setDspWorkerLoadFailure } from '../__mocks__/createDspWorkerMock';
import {
  STAGE_MEASURING_DETAIL,
  STAGE_RENDERING_DETAIL,
  stageRenderingDetail,
  type StageStatus,
} from './vocalChain';

registerAllEffects();

const SR = 16000;
const N = SR * 2; // 2 s — 62 LTAS frames at 2048/512

/** At 16 kHz the octaves at 500 / 1000 / 2000 / 4000 Hz lie entirely under
 * Nyquist and are matched; 31.25–250 Hz are below the measured range and 8 k /
 * 16 k reach above Nyquist. Four matched bands, which is what makes the
 * centring arithmetic in these fixtures predictable. */
const MATCHED_CENTRES = [500, 1000, 2000, 4000];
const BAND_EDGE = Math.SQRT2;

function noise(n: number, amplitude: number, seed = 1): Float32Array {
  const out = new Float32Array(n);
  let s = seed >>> 0;
  for (let i = 0; i < n; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    out[i] = ((s / 0xffffffff) * 2 - 1) * amplitude;
  }
  return out;
}

function tone(n: number, freqHz: number, amplitude: number, sampleRate = SR): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amplitude * Math.sin((2 * Math.PI * freqHz * i) / sampleRate);
  return out;
}

/** Alternating +/-amplitude at exactly `levelDb`: |x| is that amplitude at every
 * sample, so both the RMS and the detector envelope settle ON the figure rather
 * than near it, and a reported level can be asserted against a literal. */
function flatAt(n: number, levelDb: number): Float32Array {
  const amp = Math.pow(10, levelDb / 20);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = i % 2 === 0 ? amp : -amp;
  return out;
}

/**
 * A long-term spectrum with EXACTLY the given octave-band levels. Built rather
 * than measured so a fixture can be placed on a dB boundary by arithmetic: every
 * bin inside a band carries the same power, so `bandLevelDb` (the mean over the
 * band's bins) returns that level to the last decimal.
 */
function synthLtas(levelsDb: Record<number, number>, sampleRate = SR): Ltas {
  const bins = LTAS_FFT_SIZE / 2 + 1;
  const power = new Float64Array(bins);
  for (let k = 1; k < bins; k++) {
    const f = (k * sampleRate) / LTAS_FFT_SIZE;
    for (const centre of MATCH_BAND_CENTRES_HZ) {
      const level = levelsDb[centre];
      if (level === undefined) continue;
      if (f >= centre / BAND_EDGE && f < centre * BAND_EDGE) power[k] = Math.pow(10, level / 10);
    }
  }
  return { power, frames: 40, sampleRate };
}

/** The take's own measured band levels, so a reference can be placed a chosen
 * number of dB away from it in a chosen band. */
function takeBandLevels(channels: Float32Array[], sampleRate = SR): Record<number, number> {
  const ltas = longTermAverageSpectrum(channels, sampleRate);
  const out: Record<number, number> = {};
  for (const centre of MATCHED_CENTRES) {
    const level = bandLevelDb(ltas, centre / BAND_EDGE, centre * BAND_EDGE);
    if (level !== null) out[centre] = level;
  }
  return out;
}

function reference(over: Partial<ReferenceMeasurements> = {}): ReferenceMeasurements {
  return {
    ltas: null,
    gatedLevelDb: null,
    decay: null,
    sampleRate: SR,
    name: 'Song — Vocals',
    // CC4 (CJ-3): no mix by default — the standalone chain's shape, where the
    // plausibility floor is inert and every existing expectation here holds.
    mixGatedLevelDb: null,
    mixName: null,
    ...over,
  };
}

function seedDoc(channels: Float32Array[], name = 'take', sampleRate = SR): string {
  const doc = createDocument({ name, sampleRate, channels });
  useAppStore.getState().addDocument(doc);
  return doc.id;
}

function activeDoc() {
  const s = useAppStore.getState();
  return s.documents.find((d) => d.id === s.activeDocumentId)!;
}

/** All stages off, then only the named ones on. */
function only(...ids: CoverChainStageId[]): Record<CoverChainStageId, boolean> {
  const enabled = {} as Record<CoverChainStageId, boolean>;
  for (const stage of COVER_CHAIN_STAGES) enabled[stage.id] = false;
  for (const id of ids) enabled[id] = true;
  return enabled;
}

function resultFor(stages: CoverChainStageResult[], id: CoverChainStageId): CoverChainStageResult {
  const found = stages.find((s) => s.id === id);
  if (!found) throw new Error(`no result for ${id}`);
  return found;
}

beforeEach(() => {
  useAppStore.setState(makeInitialState());
  _resetDspWorkerTestState();
});

afterEach(() => {
  _resetDspWorkerTestState();
});

// ── The registry ────────────────────────────────────────────────────────────

describe('COVER_CHAIN_STAGES', () => {
  /**
   * Enumerated from the TYPE, not from the cases that came to mind — v1.21.0
   * shipped a property test asserting an invariant across "all eight
   * combinations" that was eight of twelve because a three-valued field was
   * hardcoded to two of its values.
   *
   * The `Record<CoverChainStageId, true>` is what makes the COMPILER check the
   * list, and it has to be a Record rather than an array: a
   * `CoverChainStageId[]` literal is not exhaustiveness-checked at all
   * (`const a: ('x'|'y')[] = ['x']` compiles), so the annotation this was first
   * written with enforced nothing. With the Record, adding a member to the union
   * without adding it here is a compile error, and removing one is too.
   */
  const EVERY_STAGE_ID: Record<CoverChainStageId, true> = {
    separate: true,
    clean: true,
    lyrics: true,
    timing: true,
    matchEq: true,
    matchReverb: true,
    matchLoudness: true,
    headroom: true,
    place: true,
  };
  /** The ORDER is a separate claim from the membership, so it is a separate
   * list — and it is checked against the Record above, which is the half the
   * compiler can enforce. */
  const ALL_STAGE_IDS: CoverChainStageId[] = [
    'separate',
    'clean',
    'lyrics',
    'timing',
    'matchEq',
    'matchReverb',
    'matchLoudness',
    'headroom',
    'place',
  ];

  it('registers every id the type declares, in order, and only those', () => {
    expect([...ALL_STAGE_IDS].sort()).toEqual(Object.keys(EVERY_STAGE_ID).sort());
    expect(ALL_STAGE_IDS).toHaveLength(9);
    expect(COVER_CHAIN_STAGES.map((s) => s.id)).toEqual(ALL_STAGE_IDS);
  });

  it('runs the Limiter LAST of every stage that touches the audio', () => {
    // Not tidiness — the stage's own note tells the user that nothing
    // downstream can lift the output back over the ceiling, and `runCoverChain`
    // iterates this array in order. Match Reverb used to sit after it: a signal
    // limited to -0.3 dBFS with this reverb on top comes back at +0.37 dBFS on a
    // 220 Hz tone and +5.34 dBFS on noise at its SHORTEST room, and `encodeWav`
    // and the MP3 encoder both hard-clip. The end-to-end proof is in the Ruling C
    // test below; this is the structural half, so the order cannot drift back
    // without a failure that names the reason.
    const touchesAudio = COVER_CHAIN_STAGES.filter((s) => s.effectId !== null);
    expect(touchesAudio[touchesAudio.length - 1].id).toBe('headroom');
    expect(coverStageById('headroom').note).toMatch(/Last of every stage that touches the audio/);
    // And the two stages that can raise a peak both sit ahead of it.
    const order = COVER_CHAIN_STAGES.map((s) => s.id);
    expect(order.indexOf('matchReverb')).toBeLessThan(order.indexOf('headroom'));
    expect(order.indexOf('matchLoudness')).toBeLessThan(order.indexOf('headroom'));
    // Match Reverb also precedes Match Loudness, because the tail moves the
    // level that stage promises to set.
    expect(order.indexOf('matchReverb')).toBeLessThan(order.indexOf('matchLoudness'));
  });

  it('names a registered effect for every automatic stage and none for a manual one', () => {
    let automatic = 0;
    let manual = 0;
    for (const stage of COVER_CHAIN_STAGES) {
      if (stage.effectId === null) {
        manual++;
        expect(stage.weight).toBe(0);
      } else {
        automatic++;
        expect(getEffect(stage.effectId)).toBeTruthy();
        expect(stage.weight).toBeGreaterThanOrEqual(1);
      }
    }
    // The extent of the loop, counted, so a stage silently changing kind fails.
    expect(automatic).toBe(4);
    expect(manual).toBe(5);
  });

  it('gives every stage a note the user can act on', () => {
    for (const stage of COVER_CHAIN_STAGES) {
      expect(stage.note.length).toBeGreaterThan(80);
    }
  });

  it('opens with exactly the four automatic match stages minus the one that adds a tail', () => {
    const selection = defaultCoverStageSelection();
    expect(Object.keys(selection).sort()).toEqual([...COVER_CHAIN_STAGES.map((s) => s.id)].sort());
    expect(selection.matchEq).toBe(true);
    expect(selection.matchLoudness).toBe(true);
    expect(selection.headroom).toBe(true);
    expect(selection.matchReverb).toBe(false);
  });

  it('throws on an unknown stage rather than returning undefined', () => {
    expect(coverStageById('matchEq').label).toBe('Match EQ to the Original Vocal');
    expect(() => coverStageById('nope' as CoverChainStageId)).toThrow(/Unknown cover chain stage/);
  });
});

describe('Ruling A — the residual is stated with its measured numbers', () => {
  it('holds the figures the measurement produced, as literals', () => {
    // LITERAL, not `String(THE_CONSTANT)`. A sweep caught the first version of
    // this test: comparing the sentence against the constant it is built from
    // moves both sides together, so the assertion could not fail whatever the
    // constant said. These are the numbers from the report's §1, written out.
    expect(RESIDUAL_BELOW_BED_DB).toBe(17.95);
    expect(RESIDUAL_BELOW_VOCAL_DB).toBe(11.28);
    expect(RESIDUAL_WORST_SECOND_DB).toBe(8.9);
    expect(RESIDUAL_BAND_LO_HZ).toBe(250);
    expect(RESIDUAL_BAND_HI_HZ).toBe(4000);
    expect(RESIDUAL_IN_BAND_WORST_DB).toBe(9.5);
    expect(RESIDUAL_IN_BAND_BEST_DB).toBe(11.8);
    // V4: the user's own suggestion, measured with the real model before it was
    // believed — `docs/bench/stem-second-pass-rejected.json`, produced by
    // `scripts/stem-second-pass-probe.cjs`.
    expect(RESIDUAL_SECOND_PASS_DB).toBe(0);
    expect(RESIDUAL_SECOND_PASS_WORST_OCTAVE_DB).toBe(0.04);
  });

  it('renders every one of them into the sentence the user reads', () => {
    // All SEVEN constants, not six: 11.28 dB was exported, asserted as a
    // literal above, and then rendered nowhere \u2014 a measured figure the user
    // never saw, which is the one thing Ruling A's premise rules out. The loop
    // below is checked against the constants themselves for extent, so a new
    // constant that goes unrendered fails here rather than being forgotten.
    // One row per exported constant, paired with the text it turns into \u2014 4000
    // reads "4 kHz" and the two in-band figures share one range, so a sweep over
    // the raw numbers would not do.
    const shown: { value: number; text: string }[] = [
      { value: RESIDUAL_BELOW_BED_DB, text: '17.95 dB' },
      { value: RESIDUAL_BELOW_VOCAL_DB, text: '11.28 dB' },
      { value: RESIDUAL_WORST_SECOND_DB, text: '8.9 dB' },
      { value: RESIDUAL_BAND_LO_HZ, text: '250 Hz' },
      { value: RESIDUAL_BAND_HI_HZ, text: '4 kHz' },
      { value: RESIDUAL_IN_BAND_WORST_DB, text: '9.5\u201311.8 dB' },
      { value: RESIDUAL_IN_BAND_BEST_DB, text: '9.5\u201311.8 dB' },
      // V4: two more measured figures, and the same rule applies to them \u2014 a
      // number that is measured and then not shown is a number the user is
      // entitled to and does not get.
      { value: RESIDUAL_SECOND_PASS_DB, text: '0.00 dB' },
      { value: RESIDUAL_SECOND_PASS_WORST_OCTAVE_DB, text: '0.04 dB' },
    ];
    expect(shown).toHaveLength(9);
    for (const { value, text } of shown) {
      expect(Number.isFinite(value)).toBe(true);
      expect(COVER_CHAIN_RESIDUAL_SENTENCE).toContain(text);
    }
  });

  it('says the limitation is what separation does NOT promise, not a footnote', () => {
    expect(COVER_CHAIN_RESIDUAL_SENTENCE).toMatch(/ghost of the original\s+singer/);
    expect(COVER_CHAIN_RESIDUAL_SENTENCE).toMatch(/sum back to the mix exactly/);
  });

  // V4 — the obvious remedy, answered in the copy so it is answered for good.
  it('closes off the second pass, saying it was MEASURED rather than assumed', () => {
    // A user looking at a ghost asks the same question every time: run it
    // again on what is left. The sentence has to say that this was tried with
    // the real model and what came back, or the suggestion is re-asked every
    // release and re-argued from first principles every time.
    expect(COVER_CHAIN_RESIDUAL_SENTENCE).toMatch(/second pass/i);
    expect(COVER_CHAIN_RESIDUAL_SENTENCE).toMatch(/measured/i);
    // The reason, not just the verdict: a verdict with no mechanism reads as an
    // implementation excuse, and this one has a mechanism.
    expect(COVER_CHAIN_RESIDUAL_SENTENCE).toMatch(/same answer/i);
  });

  it('is stated verbatim by both stages that put a cover near the bed', () => {
    expect(coverStageById('separate').note).toContain(COVER_CHAIN_RESIDUAL_SENTENCE);
    expect(coverStageById('place').note).toContain(COVER_CHAIN_RESIDUAL_SENTENCE);
    // And by no other stage — the sentence belongs where the bed is, so a
    // third copy would mean it had been pasted rather than placed.
    const carriers = COVER_CHAIN_STAGES.filter((s) =>
      s.note.includes(COVER_CHAIN_RESIDUAL_SENTENCE)
    );
    expect(carriers.map((s) => s.id)).toEqual(['separate', 'place']);
  });
});

describe('Ruling D and E — the sentences that refuse to over-promise', () => {
  it('describes a shaping rather than a transformation, with the measured size', () => {
    expect(COVER_CHAIN_SHAPING_SENTENCE).toContain('1.2 dB');
    expect(COVER_CHAIN_SHAPING_SENTENCE).toMatch(/it is a small one/);
  });

  it('says a single take still has to be a good take, and who picks the bad word', () => {
    expect(COVER_CHAIN_GOOD_TAKE_SENTENCE).toMatch(/good take/);
    expect(COVER_CHAIN_GOOD_TAKE_SENTENCE).toMatch(/you choose that/);
    expect(coverStageById('lyrics').note).toContain(COVER_CHAIN_GOOD_TAKE_SENTENCE);
  });

  it('refuses to pick key or tempo, with the measurement that says why', () => {
    expect(COVER_CHAIN_CONFIRM_SENTENCE).toContain('160');
    expect(COVER_CHAIN_CONFIRM_SENTENCE).toContain('109');
    expect(coverStageById('timing').note).toContain(COVER_CHAIN_CONFIRM_SENTENCE);
  });
});

// ── Match EQ ────────────────────────────────────────────────────────────────

describe('deriveMatchEq', () => {
  const take = [noise(N, 0.2), noise(N, 0.2, 7)];

  it('declines when no original vocal was chosen, and says how to fix it', () => {
    const resolution = deriveMatchEq(null, take, SR);
    expect(resolution.run).toBe(false);
    if (resolution.run) throw new Error('unreachable');
    expect(resolution.reason).toMatch(/no original vocal chosen/);
    expect(resolution.reason).toMatch(/Separate/i);
  });

  it('declines when the reference has no sounding frame to average', () => {
    const empty: Ltas = { power: new Float64Array(LTAS_FFT_SIZE / 2 + 1), frames: 0, sampleRate: SR };
    const resolution = deriveMatchEq(reference({ ltas: empty }), take, SR);
    expect(resolution.run).toBe(false);
    if (resolution.run) throw new Error('unreachable');
    expect(resolution.reason).toMatch(/Song — Vocals/);
  });

  it('declines when the take is shorter than one analysis frame', () => {
    const resolution = deriveMatchEq(
      reference({ ltas: synthLtas({ 500: -30, 1000: -30, 2000: -30, 4000: -30 }) }),
      [new Float32Array(LTAS_FFT_SIZE - 1)],
      SR
    );
    expect(resolution.run).toBe(false);
    if (resolution.run) throw new Error('unreachable');
    expect(resolution.reason).toMatch(/nothing in this take/);
  });

  it('declines when no octave survives the measured range, naming both limits', () => {
    // 4 kHz sample rate: Nyquist 2 kHz, so the lowest band the range allows
    // (500 Hz, reaching 707 Hz) is the only candidate and 1 kHz upward is gone.
    // Dropping the take to a rate where even 500 Hz's octave clears Nyquist is
    // what leaves nothing: at 1200 Hz, Nyquist is 600 Hz < 707 Hz.
    const lowRate = 1200;
    const resolution = deriveMatchEq(
      reference({ ltas: synthLtas({ 500: -30 }, lowRate), sampleRate: lowRate }),
      [noise(4096, 0.2)],
      lowRate
    );
    expect(resolution.run).toBe(false);
    if (resolution.run) throw new Error('unreachable');
    expect(resolution.reason).toContain(`${MATCH_MIN_CENTRE_HZ} Hz`);
    expect(resolution.reason).toMatch(/Nyquist/);
  });

  it('hands the Graphic EQ a gain for every band and exactly zero outside the range', () => {
    const levels = takeBandLevels(take);
    const ltas = synthLtas({
      500: levels[500] + 4,
      1000: levels[1000] - 2,
      2000: levels[2000] + 1,
      4000: levels[4000] - 3,
    });
    const resolution = deriveMatchEq(reference({ ltas }), take, SR);
    expect(resolution.run).toBe(true);
    if (!resolution.run) throw new Error('unreachable');

    let outside = 0;
    for (const band of resolution.eq!.bands) {
      if (band.status === 'matched') continue;
      outside++;
      // The bands the measurement forbids receive NO deliberate gain...
      expect(band.bandGainDb).toBe(0);
      expect(Number(resolution.params[GRAPHIC_EQ_BANDS.find((b) => b.freq === band.centreHz)!.id])).toBe(0);
    }
    expect(outside).toBe(6); // 31.25–250 below range, 8 k / 16 k above Nyquist
    expect(resolution.eq!.matchedCount).toBe(4);

    // ...and the leak into the nearest of them is REPORTED rather than assumed
    // to be zero, which is the whole of Ruling B in one assertion.
    const leaked = resolution.eq!.bands.find((b) => b.centreHz === 250)!;
    expect(leaked.bandGainDb).toBe(0);
    expect(Math.abs(leaked.realisedDb)).toBeGreaterThan(0.05);
  });

  it('reports the curve the cascade DELIVERS, pre-compensated to the target (Ruling B)', () => {
    const levels = takeBandLevels(take);
    // An alternating curve — the shape dispatch 1 measured a 1 dB realisation
    // error on. Centring removes the mean, so the four raw offsets below become
    // roughly +3 / -3 / +3 / -3 dB of shape.
    const ltas = synthLtas({
      500: levels[500] + 3,
      1000: levels[1000] - 3,
      2000: levels[2000] + 3,
      4000: levels[4000] - 3,
    });
    const resolution = deriveMatchEq(reference({ ltas }), take, SR);
    if (!resolution.run) throw new Error('unreachable');
    const eq = resolution.eq!;

    // The pre-compensation was needed: the raw target, applied as-is, would NOT
    // have produced itself. Measured in the SAME quantity the solve works in —
    // this take's octave-band energy — because a baseline taken in the centre
    // response would be comparing the un-compensated curve against one thing and
    // the compensated one against another.
    const naive = realisedBandEnergyDb(
      eq.bands.map((b) => b.targetDb),
      MATCH_BAND_CENTRES_HZ,
      SR,
      longTermAverageSpectrum(take, SR)
    );
    let naiveWorst = 0;
    eq.bands.forEach((b, i) => {
      if (b.status !== 'matched') return;
      naiveWorst = Math.max(naiveWorst, Math.abs(naive[i] - b.targetDb));
    });
    expect(naiveWorst).toBeGreaterThan(0.2);

    // And after it, the realised response IS the target.
    expect(eq.worstErrorDb).toBeLessThanOrEqual(SOLVE_TOLERANCE_DB);
    for (const band of eq.bands) {
      if (band.status !== 'matched') continue;
      expect(band.realisedDb).toBeCloseTo(band.targetDb, 1);
      // The gain handed to the effect differs from the target — that difference
      // IS the pre-compensation, and reporting the target as if it were the
      // gain (or the gain as if it were the response) is what Ruling B forbids.
      expect(band.bandGainDb).not.toBeCloseTo(band.targetDb, 5);
    }
    // The `Realised` line says so in the words the dialog renders — including
    // WHICH quantity it is, because naming the wrong one is the same defect in
    // a different place: it once said "the cascade's own measured response at
    // the band centres" while reporting octave-band energy.
    const realisedLine = resolution.derived.find((d) => d.label === 'Realised')!;
    expect(realisedLine.from).toMatch(/what the audio receives, not what was requested/);
    expect(realisedLine.from).toMatch(/octave-band energy/);
    expect(realisedLine.from).not.toMatch(/at the band centres/);
  });

  it('realises the curve on THIS take\'s spectrum, not on a flat one', () => {
    // Ruling B, in the place it was broken: the realised figure is what
    // `bandLevelDb` will read back off the processed audio, and that depends on
    // where inside each octave the take's own energy sits. A take whose 4 kHz
    // octave is dominated by a tone near the band's top edge and one whose
    // energy is spread across it must NOT be told the same realised number for
    // the same target.
    const edgeHeavy = [
      (() => {
        const out = noise(N, 0.05, 7);
        const spike = tone(N, 4000 * 1.3, 0.5);
        for (let i = 0; i < N; i++) out[i] += spike[i];
        return out;
      })(),
    ];
    const flatIsh = [noise(N, 0.2, 7)];

    const levels = takeBandLevels(edgeHeavy);
    const ltas = synthLtas({
      500: levels[500] + 3,
      1000: levels[1000] - 3,
      2000: levels[2000] + 3,
      4000: levels[4000] - 3,
    });
    const onEdgeHeavy = deriveMatchEq(reference({ ltas }), edgeHeavy, SR);
    const onFlatIsh = deriveMatchEq(reference({ ltas }), flatIsh, SR);
    if (!onEdgeHeavy.run || !onFlatIsh.run) throw new Error('unreachable');

    const gainOf = (r: typeof onEdgeHeavy, centreHz: number): number =>
      Number(r.params[GRAPHIC_EQ_BANDS.find((b) => b.freq === centreHz)!.id]);
    // The same 4 kHz target needs a different band gain on the two takes,
    // because the same filter moves their octave energies by different amounts.
    expect(Math.abs(gainOf(onEdgeHeavy, 4000) - gainOf(onFlatIsh, 4000))).toBeGreaterThan(0.1);
    // And both are still solved to the target they were given.
    expect(onEdgeHeavy.eq!.worstErrorDb).toBeLessThanOrEqual(SOLVE_TOLERANCE_DB);
  });

  it('bounds a correction larger than the reference can justify, and leaves smaller ones alone', () => {
    const levels = takeBandLevels(take);
    // With four matched bands, an offset of D dB in ONE band centres to
    // D * 3/4 there and -D/4 elsewhere. D = 4/3 * MATCH_BOUND_DB puts that one
    // band exactly ON the bound; the other three land at 3.63 dB, well inside.
    const probe = (offsetDb: number) => {
      const ltas = synthLtas({
        500: levels[500],
        1000: levels[1000],
        2000: levels[2000],
        4000: levels[4000] + offsetDb,
      });
      const resolution = deriveMatchEq(reference({ ltas }), take, SR);
      if (!resolution.run) throw new Error('unreachable');
      return {
        band: resolution.eq!.bands.find((b) => b.centreHz === 4000)!,
        resolution,
      };
    };

    // The offset that puts the 4 kHz band's centred correction exactly ON the
    // bound, found by one Newton step rather than assumed: the map from offset
    // to centred correction is affine with slope 3/4, so a single correction
    // lands it to floating-point precision.
    const guess = (4 / 3) * MATCH_BOUND_DB;
    const onBound = guess + (MATCH_BOUND_DB - probe(guess).band.targetDb) * (4 / 3);
    expect(probe(onBound).band.targetDb).toBeCloseTo(MATCH_BOUND_DB, 9);

    // Below / on / above. 0.05 dB of centred movement either side — a tenth of
    // it would still be resolved by the assertions, so the boundary can move
    // the output but the constant cannot shift by 0.1 dB unnoticed.
    const below = probe(onBound - 0.05 * (4 / 3)).band;
    const on = probe(onBound).band;
    const above = probe(onBound + 0.05 * (4 / 3)).band;

    expect(below.bounded).toBe(false);
    expect(below.targetDb).toBeCloseTo(MATCH_BOUND_DB - 0.05, 6);
    expect(above.bounded).toBe(true);
    // ON the bound the FLAG is not observable through this path and is not
    // asserted: the offset that lands the centred correction on 10.9 dB is
    // reached through two logarithms, so which side of a strict `>` it falls on
    // is a last-bit accident of the fixture rather than a property of the code.
    // (`coverMatch.test.ts` pins that comparison exactly, on arithmetic that
    // can sit on the boundary.) What IS observable here, and is the property
    // that matters, is that the correction is CONTINUOUS across it — bounding
    // or not bounding at the boundary produces the same number.
    expect(Math.abs(on.targetDb)).toBeCloseTo(MATCH_BOUND_DB, 9);
    // And the bound is what ACTS: the raw difference asked for 0.05 dB more,
    // and the correction that came out is the bound to the last digit.
    expect(above.targetDb).toBe(MATCH_BOUND_DB);

    // A 10.9 dB band-ENERGY move is more than a single octave band of this
    // cascade can deliver inside the effect's own ±12 dB — once its roll-off is
    // compensated it would need about 12.5 dB. So the realised figure falls
    // SHORT of the bound, in the right direction, and the shortfall is
    // reported rather than the target being echoed back as an outcome. That is
    // Ruling B's actual requirement, and this is the fixture that reaches it.
    const others = probe(onBound + 0.05 * (4 / 3)).resolution;
    if (!others.run) throw new Error('unreachable');
    expect(above.realisedDb).toBeGreaterThan(0);
    expect(above.realisedDb).toBeLessThan(MATCH_BOUND_DB);
    expect(others.eq!.clamped).toBe(true);
    expect(others.eq!.worstErrorDb).toBeGreaterThan(0.01);

    // The three bands that were nowhere near the bound are untouched by it.
    expect(others.eq!.bands.filter((b) => b.bounded)).toHaveLength(1);
    expect(others.derived.find((d) => d.label === 'Bounded')!.value).toContain('1 band');

    // ...and the shortfall is said in a sentence, not left to be read off the
    // table. A curve the EQ CAN deliver carries no such warning, so the line
    // observes the outcome rather than the code path.
    expect(others.warning).toMatch(/could not fully deliver/);
    expect(others.warning).toMatch(/4000 Hz/);
    expect(others.warning).toMatch(/±12 dB limit/);
    const easy = probe(0).resolution;
    expect(easy.run && easy.warning).toBeUndefined();
    // ...and a curve that never reaches the bound reports no `Bounded` line at
    // all, so the line observes the material rather than the code path.
    expect(probe(0).resolution.run && probe(0).resolution.derived.some((d) => d.label === 'Bounded')).toBe(
      false
    );
  });

  it('names EVERY band that fell short, not just the worst one', () => {
    // Ruling B's sentence exists so a shortfall is impossible to miss, and which
    // bands fall short is not a property of one fixture: any solve that ends
    // above tolerance can leave several. Every fixture in this suite left exactly
    // ONE band short, so `short.map` and `short.slice(0, 1).map` wrote the same
    // sentence and the remaining bands could go short in silence — shown in the
    // table, absent from the line that exists to be impossible to miss.
    //
    // The centring is zero-mean, so two bands cannot be pushed up without two
    // being pushed down as far: ±13 dB of offset puts all four matched bands past
    // the ±10.9 dB bound, and the Graphic EQ's own ±12 dB rail then leaves three
    // of them measurably away from their targets.
    const levels = takeBandLevels(take);
    const offset = 13;
    const ltas = synthLtas({
      500: levels[500] - offset,
      1000: levels[1000] - offset,
      2000: levels[2000] + offset,
      4000: levels[4000] + offset,
    });
    const resolution = deriveMatchEq(reference({ ltas }), take, SR);
    if (!resolution.run) throw new Error('unreachable');

    // The fixture really does miss on more than one band — without this guard the
    // test would quietly fall back to the single-band case it exists to escape.
    const short = resolution.eq!.bands.filter(
      (b) => b.status === 'matched' && Math.abs(b.realisedDb - b.targetDb) > SOLVE_TOLERANCE_DB
    );
    expect(short.map((b) => b.centreHz)).toEqual([1000, 2000, 4000]);

    const warning = resolution.warning as string;
    expect(warning).toMatch(/could not fully deliver/);
    // Every one of them is named, with ITS OWN two numbers rather than the worst
    // band's repeated.
    const signed = (v: number): string => `${v >= 0 ? '+' : ''}${v.toFixed(2)} dB`;
    for (const b of short) {
      expect(warning).toContain(
        `At ${b.centreHz} Hz it wanted ${signed(b.targetDb)} and realised ${signed(b.realisedDb)}`
      );
    }
    expect(warning.match(/At \d+ Hz it wanted/g)).toHaveLength(3);
    // …and ONLY them: the band the EQ did deliver is not named, so the sentence
    // observes the outcome rather than listing the table.
    expect(warning).not.toContain('At 500 Hz');
    // Worst first, so the sentence leads with the biggest miss.
    expect(warning.indexOf('At 1000 Hz')).toBeLessThan(warning.indexOf('At 2000 Hz'));
    expect(warning.indexOf('At 2000 Hz')).toBeLessThan(warning.indexOf('At 4000 Hz'));

    // The direction word follows the SIGN, not the magnitude. This fixture
    // misses in BOTH directions at once — the two cut bands land above their
    // targets and the two boosted ones below — and the sentence used to call
    // every one of them "short", contradicting the two signed figures printed
    // immediately before it in the same clause (L11).
    const over = short.find((b) => b.centreHz === 1000)!;
    expect(over.realisedDb).toBeGreaterThan(over.targetDb);
    expect(warning).toContain(`${Math.abs(over.realisedDb - over.targetDb).toFixed(2)} dB over`);
    expect(warning).toContain('4.29 dB over');
    expect(warning).not.toContain('4.29 dB short');

    const under = short.find((b) => b.centreHz === 4000)!;
    expect(under.realisedDb).toBeLessThan(under.targetDb);
    expect(warning).toContain(`${Math.abs(under.realisedDb - under.targetDb).toFixed(2)} dB short`);
  });

  it('hands the broadband level to the loudness stage instead of baking it into the curve', () => {
    const levels = takeBandLevels(take);
    const flatOffset = 6;
    const ltas = synthLtas({
      500: levels[500] + flatOffset,
      1000: levels[1000] + flatOffset,
      2000: levels[2000] + flatOffset,
      4000: levels[4000] + flatOffset,
    });
    const resolution = deriveMatchEq(reference({ ltas }), take, SR);
    if (!resolution.run) throw new Error('unreachable');
    // A pure level difference is ENTIRELY level: every band's shape is zero.
    expect(resolution.eq!.levelDb).toBeCloseTo(flatOffset, 2);
    for (const band of resolution.eq!.bands) {
      if (band.status !== 'matched') continue;
      expect(band.targetDb).toBeCloseTo(0, 6);
    }
    expect(resolution.derived.find((d) => d.label === 'Level removed')!.value).toContain('+6.00 dB');
  });
});

// ── Match Loudness ──────────────────────────────────────────────────────────

describe('deriveMatchLoudness', () => {
  const take = [tone(N, 1000, 0.5)];

  it('declines when no original vocal was chosen', () => {
    const resolution = deriveMatchLoudness(null, take, SR, true);
    expect(resolution.run).toBe(false);
    if (resolution.run) throw new Error('unreachable');
    expect(resolution.reason).toMatch(/no original vocal chosen/);
  });

  it('declines, differently, when the reference is open but has no sounding level', () => {
    const resolution = deriveMatchLoudness(reference(), take, SR, true);
    expect(resolution.run).toBe(false);
    if (resolution.run) throw new Error('unreachable');
    expect(resolution.reason).toMatch(/Song — Vocals/);
    expect(resolution.reason).not.toMatch(/no original vocal chosen/);
  });

  it('declines when the take has no sounding level to move', () => {
    const resolution = deriveMatchLoudness(
      reference({ gatedLevelDb: -12 }),
      [new Float32Array(0)],
      SR,
      true
    );
    expect(resolution.run).toBe(false);
    if (resolution.run) throw new Error('unreachable');
    expect(resolution.reason).toMatch(/nothing in this take/);
  });

  it('moves the take to the reference\'s gated level, exactly', () => {
    const takeLevel = gatedLevelDb(take, SR)!;
    const resolution = deriveMatchLoudness(reference({ gatedLevelDb: -12 }), take, SR, true);
    if (!resolution.run) throw new Error('unreachable');
    expect(Number(resolution.params.gainDb)).toBeCloseTo(-12 - takeLevel, 6);
    expect(resolution.warning).toBeUndefined();
  });

  it('clamps to the Amplify effect\'s own range rather than inventing one', () => {
    const range = getEffect('amplify')!.params.find((p) => p.id === 'gainDb')!;
    const resolution = deriveMatchLoudness(reference({ gatedLevelDb: 200 }), take, SR, true);
    if (!resolution.run) throw new Error('unreachable');
    expect(Number(resolution.params.gainDb)).toBe(range.max);
  });

  it('warns with the number when the limiter is off and the result would pass 0 dBFS (Ruling C)', () => {
    const takeLevel = gatedLevelDb(take, SR)!;
    const takePeak = peakDb(take);
    // Below / on / above the boundary the warning turns on, sized in whole
    // tenths of a dB so a one-sided comparison cannot pass by rounding.
    const probe = (peakAfterDb: number, headroomEnabled: boolean) =>
      deriveMatchLoudness(
        reference({ gatedLevelDb: takeLevel + (peakAfterDb - takePeak) }),
        take,
        SR,
        headroomEnabled
      );

    const below = probe(-0.3, false);
    const on = probe(0, false);
    const above = probe(0.3, false);
    if (!below.run || !on.run || !above.run) throw new Error('unreachable');
    expect(below.warning).toBeUndefined();
    expect(on.warning).toBeUndefined(); // `> 0`, so exactly 0 dBFS is not over
    expect(above.warning).toMatch(/above full scale/);
    expect(above.warning).toMatch(/\+?0\.3\d* dBFS/);

    // The same over-scale case with the limiter ON carries no warning, because
    // the stage that catches it is in the chain.
    const guarded = probe(0.3, true);
    if (!guarded.run) throw new Error('unreachable');
    expect(guarded.warning).toBeUndefined();
  });
});

// ── CC4 (CJ-3): the plausibility floor on the separated vocal ───────────────

/**
 * A Vocals stem the separator failed on is not silent — it carries leakage, and
 * `gatedLevelDb` gates relative to the signal's OWN p95, so it still reports a
 * finite "sounding level". Match Loudness then committed `reference − take` to
 * the take (bounded only by Amplify's ±60 dB) and Match EQ shaped it toward the
 * leakage spectrum, both reporting success. This repo has MEASURED that
 * pathology on its own material: driving the real model with the smoke's
 * synthetic mix returns a Vocals stem 41 dB below the source
 * (`scripts/e2e-smoke.cjs`, source RMS −17.99 dBFS, Vocals −59.28).
 *
 * The floor is only checkable when the caller can say what the reference was
 * separated FROM, which is why it lives on the reference's own measurements and
 * is inert (`mixGatedLevelDb: null`) for the standalone chain, where the user
 * picks any document they like as the reference.
 */
describe('CC4 (CJ-3): a reference implausibly far below its own mix', () => {
  const take = [tone(N, 1000, 0.5)];

  /** The measured pathology: a Vocals stem 41 dB below the song. */
  const leakage = (): ReferenceMeasurements =>
    reference({
      gatedLevelDb: -59.28,
      mixGatedLevelDb: -17.99,
      mixName: 'song.wav',
      ltas: longTermAverageSpectrum([tone(N, 1000, 0.0011)], SR),
    });

  it('is derived from the app\'s own gate span, not chosen', () => {
    // A signal more than one full gate span below another would not clear that
    // other signal's own activity gate — the app's existing definition of "not
    // sounding". That is the derivation, and it is the same constant.
    expect(REFERENCE_BELOW_MIX_FLOOR_DB).toBe(ACTIVE_GATE_DB);
    // …and it separates the measured pathology from the measured leakage the
    // separator leaves in the BED, which is vocal content that IS there.
    expect(REFERENCE_BELOW_MIX_FLOOR_DB).toBeGreaterThan(RESIDUAL_BELOW_BED_DB);
    expect(REFERENCE_BELOW_MIX_FLOOR_DB).toBeLessThan(41.29);
  });

  it('declines Match Loudness with the measured numbers instead of crushing the take', () => {
    const resolution = deriveMatchLoudness(leakage(), take, SR, true);
    expect(resolution.run).toBe(false);
    if (resolution.run) throw new Error('unreachable');
    expect(resolution.reason).toContain('-59.28 dBFS');
    expect(resolution.reason).toContain('-17.99 dBFS');
    expect(resolution.reason).toContain('41.29');
    expect(resolution.reason).toContain(String(REFERENCE_BELOW_MIX_FLOOR_DB));
  });

  it('declines Match EQ too — the leakage spectrum is not the singer\'s', () => {
    const resolution = deriveMatchEq(leakage(), take, SR);
    expect(resolution.run).toBe(false);
    if (resolution.run) throw new Error('unreachable');
    expect(resolution.reason).toContain('41.29');
  });

  it('runs normally at the floor and declines past it — a boundary, not a mood', () => {
    const at = (belowDb: number) =>
      deriveMatchLoudness(
        reference({ gatedLevelDb: -20 - belowDb, mixGatedLevelDb: -20, mixName: 'song.wav' }),
        take,
        SR,
        true
      );
    expect(at(REFERENCE_BELOW_MIX_FLOOR_DB - 0.01).run).toBe(true);
    expect(at(REFERENCE_BELOW_MIX_FLOOR_DB).run).toBe(true); // `>`, so exactly at it still runs
    expect(at(REFERENCE_BELOW_MIX_FLOOR_DB + 0.01).run).toBe(false);
  });

  it('is inert for the standalone chain, which has no mix to compare against', () => {
    const resolution = deriveMatchLoudness(
      reference({ gatedLevelDb: -59.28, mixGatedLevelDb: null }),
      take,
      SR,
      true
    );
    // Unchanged shipped behaviour: the user picked this reference themselves.
    expect(resolution.run).toBe(true);
  });

  it('measures the mix when the caller supplies one, and reports null when it does not', () => {
    const channels = [tone(N, 440, 0.5)];
    const mix = [tone(N, 440, 0.5)];
    const without = measureReference(channels, SR, 'ref', {
      ltas: false,
      level: true,
      decay: false,
    });
    expect(without.mixGatedLevelDb).toBeNull();
    expect(without.mixName).toBeNull();

    const with_ = measureReference(
      channels,
      SR,
      'ref',
      { ltas: false, level: true, decay: false },
      { channels: mix, sampleRate: SR, name: 'song.wav' }
    );
    expect(with_.mixGatedLevelDb).toBeCloseTo(gatedLevelDb(mix, SR)!, 10);
    expect(with_.mixName).toBe('song.wav');
  });
});

// ── Match Reverb ────────────────────────────────────────────────────────────

describe('deriveMatchReverb', () => {
  const FLOOR = reverbRt60Seconds(0, SR);

  it('declines when no original vocal was chosen', () => {
    const resolution = deriveMatchReverb(null, SR);
    expect(resolution.run).toBe(false);
    if (resolution.run) throw new Error('unreachable');
    expect(resolution.reason).toMatch(/no original vocal chosen/);
  });

  it('declines when nothing in the reference decays cleanly enough to measure', () => {
    const resolution = deriveMatchReverb(reference({ decay: null }), SR);
    expect(resolution.run).toBe(false);
    if (resolution.run) throw new Error('unreachable');
    expect(resolution.reason).toMatch(/decays cleanly enough/);
  });

  it('declines below the effect\'s own floor and engages above it, with the floor as the boundary', () => {
    const at = (seconds: number) =>
      deriveMatchReverb(
        reference({ decay: { seconds, p25Seconds: seconds - 0.05, p75Seconds: seconds + 0.05, count: 40 } }),
        SR
      );
    // 0.05 s either side of a 0.71 s floor: 7 % of the quantity, far more than
    // any rounding in the comparison.
    const below = at(FLOOR - 0.05);
    const on = at(FLOOR);
    const above = at(FLOOR + 0.05);
    expect(below.run).toBe(false);
    expect(on.run).toBe(true); // `< floor` declines, so exactly the floor runs
    expect(above.run).toBe(true);
    if (below.run) throw new Error('unreachable');
    expect(below.reason).toContain(FLOOR.toFixed(2));
    expect(below.reason).toContain((FLOOR - 0.05).toFixed(2));
    expect(below.reason).toMatch(/more space than the original has/);
  });

  it('declines on the reference song\'s own measured decay, for the measured reason', () => {
    // 0.40 s is what the ground-truth original vocal reads; the app's shortest
    // is 0.710 s at both 44.1 and 48 kHz.
    for (const rate of [44100, 48000]) {
      const resolution = deriveMatchReverb(
        reference({ decay: { seconds: 0.4, p25Seconds: 0.33, p75Seconds: 0.5, count: 180 }, sampleRate: rate }),
        rate
      );
      expect(resolution.run).toBe(false);
      if (resolution.run) throw new Error('unreachable');
      expect(resolution.reason).toContain('0.40 s');
      expect(resolution.reason).toContain('0.71 s');
    }
  });

  it('derives a room size that reproduces the measured decay through the effect\'s own law', () => {
    for (const seconds of [1.0, 1.5, 2.4]) {
      const resolution = deriveMatchReverb(
        reference({ decay: { seconds, p25Seconds: seconds * 0.8, p75Seconds: seconds * 1.2, count: 60 } }),
        SR
      );
      if (!resolution.run) throw new Error('unreachable');
      const roomSize = Number(resolution.params.roomSize);
      // The inversion is pinned against the forward law, not against itself.
      expect(reverbRt60Seconds(roomSize, SR)).toBeCloseTo(seconds, 6);
      expect(roomSize).toBeGreaterThan(0);
      expect(roomSize).toBeLessThanOrEqual(1);
    }
  });

  it('clamps to the effect\'s own room-size range on a decay longer than it can make', () => {
    const resolution = deriveMatchReverb(
      reference({ decay: { seconds: 30, p25Seconds: 28, p75Seconds: 32, count: 12 } }),
      SR
    );
    if (!resolution.run) throw new Error('unreachable');
    expect(Number(resolution.params.roomSize)).toBe(1);
  });

  it('says the wet/dry balance is the effect\'s default because nothing measures it', () => {
    const resolution = deriveMatchReverb(
      reference({ decay: { seconds: 1.5, p25Seconds: 1.2, p75Seconds: 1.8, count: 60 } }),
      SR
    );
    if (!resolution.run) throw new Error('unreachable');
    expect(resolution.derived.find((d) => d.label === 'Mix')!.from).toMatch(/is not/);
  });
});

// ── measureReference ────────────────────────────────────────────────────────

describe('measureReference', () => {
  /** Exponentially decaying noise bursts with a known RT60 — material on which
   * `estimateDecay` returns a NUMBER. This fixture used to be a steady 1 kHz
   * tone, which the estimator declines on whether or not the gate is honoured:
   * `none.decay === null` was then true for a reason that had nothing to do with
   * `need.decay`, and dropping the gate — paying for a second full scan of a
   * three-minute reference on every run whose Match Reverb stage is off — left
   * this test green. Same shape as `coverMatch.test.ts`'s own decay fixtures. */
  function decayingBursts(rt60: number, count: number, gapSec: number): Float32Array {
    const burst = Math.round(gapSec * SR);
    const out = new Float32Array(burst * count);
    const perSample = Math.pow(10, -60 / (20 * rt60 * SR));
    for (let b = 0; b < count; b++) {
      const src = noise(burst, 1, 300 + b);
      let amp = 0.6;
      for (let i = 0; i < burst; i++) {
        out[b * burst + i] = src[i] * amp;
        amp *= perSample;
      }
    }
    return out;
  }

  const channels = [decayingBursts(0.3, 12, 1.2)];

  it('measures only what the enabled stages need', () => {
    const none = measureReference(channels, SR, 'ref', { ltas: false, level: false, decay: false });
    expect(none.ltas).toBeNull();
    expect(none.gatedLevelDb).toBeNull();
    expect(none.decay).toBeNull();

    const all = measureReference(channels, SR, 'ref', { ltas: true, level: true, decay: true });
    expect(all.ltas!.frames).toBeGreaterThan(0);
    // The fixture really does carry a decay the estimator can find, so the
    // `none.decay === null` above is `need.decay` acting and not the estimator
    // declining on material with nothing to fit.
    expect(all.decay).not.toBeNull();
    expect(all.decay!.seconds).toBeGreaterThan(0.3 * 0.85);
    expect(all.decay!.seconds).toBeLessThan(0.3 * 1.15);
    expect(all.gatedLevelDb).toBeCloseTo(gatedLevelDb(channels, SR)!, 6);
    expect(all.name).toBe('ref');
    expect(all.sampleRate).toBe(SR);
  });
});

describe('matchDistanceDb', () => {
  it('is zero for a spectrum against itself and grows with the shape difference', () => {
    const flat = synthLtas({ 500: -30, 1000: -30, 2000: -30, 4000: -30 });
    expect(matchDistanceDb(flat, flat)).toBeCloseTo(0, 9);
    // A pure LEVEL difference is not a shape difference — it is the loudness
    // stage's, and the distance must not count it.
    const louder = synthLtas({ 500: -20, 1000: -20, 2000: -20, 4000: -20 });
    expect(matchDistanceDb(louder, flat)).toBeCloseTo(0, 9);
    const tilted = synthLtas({ 500: -24, 1000: -28, 2000: -32, 4000: -36 });
    expect(matchDistanceDb(tilted, flat)!).toBeGreaterThan(4);
  });

  it('does NOT saturate at the correction bound — it measures the gap, not the fix', () => {
    // The metric used to sum `gainDb`, which `matchCurve` has already cut to
    // +-MATCH_BOUND_DB, so it stopped growing once a band passed 10.9 dB of
    // centred difference. Two spectra can be further apart than the EQ is
    // allowed to correct, and saying so is the whole point of reporting a
    // distance: with both readings saturating the same way, the before/after
    // IMPROVEMENT this number exists to show would be compressed too.
    const take = synthLtas({ 500: -30, 1000: -30, 2000: -30, 4000: -30 });
    const near = synthLtas({ 500: -30, 1000: -30, 2000: -30, 4000: -20 });
    const far = synthLtas({ 500: -30, 1000: -30, 2000: -30, 4000: 0 });

    // The far pair is past the bound: 30 dB in one of four bands centres to
    // +22.5 there and -7.5 in the other three, so the EQ's correction is cut.
    const farCurve = MATCH_BOUND_DB; // the value the cut lands on
    expect(farCurve).toBe(10.9);
    // sqrt((22.5^2 + 3*7.5^2) / 4) = 12.99 dB of shape difference...
    expect(matchDistanceDb(far, take)!).toBeCloseTo(12.99, 1);
    // ...where the bounded sum would have returned 8.48.
    expect(matchDistanceDb(far, take)!).toBeGreaterThan(9);

    // And it is still monotone below the bound, where the two agree: 10 dB in
    // one band centres to +7.5 / -2.5.
    expect(matchDistanceDb(near, take)!).toBeCloseTo(Math.sqrt((7.5 * 7.5 + 3 * 2.5 * 2.5) / 4), 6);
    expect(matchDistanceDb(far, take)!).toBeGreaterThan(matchDistanceDb(near, take)!);
  });

  it('is null when no band is in range', () => {
    const lowRate = 1200;
    const a = synthLtas({ 500: -30 }, lowRate);
    expect(matchDistanceDb(a, a)).toBeNull();
  });
});

// ── The run ─────────────────────────────────────────────────────────────────

describe('runCoverChain', () => {
  function seedPair(takeChannels: Float32Array[], refChannels: Float32Array[]) {
    const refId = seedDoc(refChannels, 'Song — Vocals');
    const takeId = seedDoc(takeChannels, 'take');
    useAppStore.setState({ activeDocumentId: takeId });
    return { refId, takeId };
  }

  const takeAudio = () => [noise(N, 0.2), noise(N, 0.2, 7)];
  const refAudio = () => [noise(N, 0.05, 11), noise(N, 0.05, 13)];

  it('resolves null with no document, and with an empty region', async () => {
    expect(await runCoverChain({ enabled: only('matchEq'), referenceDocId: null })).toBeNull();
    const id = seedDoc([new Float32Array(0)]);
    useAppStore.setState({ activeDocumentId: id });
    expect(await runCoverChain({ enabled: only('matchEq'), referenceDocId: null })).toBeNull();
  });

  it('every stage off ⇒ byte-identical passthrough, no edit, no undo entry', async () => {
    const { refId, takeId } = seedPair(takeAudio(), refAudio());
    const beforeChannels = activeDoc().channels.map((c) => Float32Array.from(c));
    const depthBefore = getHistory(takeId).done.length;

    const report = await runCoverChain({ enabled: only(), referenceDocId: refId });
    expect(report).not.toBeNull();
    expect(report!.applied).toBe(false);
    expect(getHistory(takeId).done.length).toBe(depthBefore);

    const after = activeDoc().channels;
    expect(after.length).toBe(beforeChannels.length);
    after.forEach((c, i) => {
      expect(c.length).toBe(beforeChannels[i].length);
      for (let s = 0; s < c.length; s++) expect(c[s]).toBe(beforeChannels[i][s]);
    });
  });

  it('the WHOLE pass is one undo entry — the count, not just the final state', async () => {
    const { refId, takeId } = seedPair(takeAudio(), refAudio());
    const lengthBefore = docLength(activeDoc());
    const depthBefore = getHistory(takeId).done.length;

    const report = await runCoverChain({
      enabled: only('matchEq', 'matchLoudness', 'headroom'),
      referenceDocId: refId,
    });
    expect(report!.applied).toBe(true);
    // Three stages ran; ONE entry appeared.
    expect(report!.stages.filter((s) => s.status === 'applied')).toHaveLength(3);
    expect(getHistory(takeId).done.length - depthBefore).toBe(1);
    expect(getHistory(takeId).done[getHistory(takeId).done.length - 1]).toBe(COVER_CHAIN_UNDO_LABEL);

    undo(takeId);
    expect(getHistory(takeId).done.length - depthBefore).toBe(0);
    expect(docLength(activeDoc())).toBe(lengthBefore);
  });

  it('reports every stage, run or not, in registry order', async () => {
    const { refId } = seedPair(takeAudio(), refAudio());
    const report = await runCoverChain({ enabled: only('matchEq'), referenceDocId: refId });
    expect(report!.stages.map((s) => s.id)).toEqual(COVER_CHAIN_STAGES.map((s) => s.id));
  });

  // ── The live view (P1) ────────────────────────────────────────────────────
  // `onProgress` is ONE number over the whole pass, and the four automatic
  // stages here are weighted 56/32/1/11 — so it spends most of a run inside
  // Match EQ saying nothing about what Match EQ is doing. The same additive
  // contract the vocal chain carries, over this chain's own stage table.

  const STEPPER_IDS: CoverChainStageId[] = ['matchEq', 'matchLoudness', 'headroom'];

  it('runs every stage the live-view tests assume runs — the fixture, guarded', async () => {
    const { refId } = seedPair(takeAudio(), refAudio());
    const report = await runCoverChain({ enabled: only(...STEPPER_IDS), referenceDocId: refId });
    for (const id of STEPPER_IDS) expect(resultFor(report!.stages, id).status).toBe('applied');
  });

  it('reports stage-scoped progress against the stage that is actually running, in chain order', async () => {
    const { refId } = seedPair(takeAudio(), refAudio());
    const seen: CoverChainStageProgress[] = [];
    await runCoverChain({
      enabled: only(...STEPPER_IDS),
      referenceDocId: refId,
      onStageProgress: (p) => seen.push(p),
    });
    // GROUPED, not merely present: a set comparison is satisfied by an
    // implementation that interleaves every stage's events, which tells a
    // stepper nothing about which row to highlight.
    const runs: CoverChainStageId[] = [];
    for (const e of seen) if (runs[runs.length - 1] !== e.stageId) runs.push(e.stageId);
    expect(runs).toEqual(STEPPER_IDS);
    for (const e of seen) expect(e.label).toBe(coverStageById(e.stageId).label);
  });

  it('scopes every fraction to the ONE stage it describes, inside [0, 1]', async () => {
    const { refId } = seedPair(takeAudio(), refAudio());
    // Both callbacks captured TOGETHER, in arrival order, because the claim is a
    // relation between them: `stageFraction` must not be the overall fraction
    // under a new name, and a range-only assertion cannot reach that.
    const seen: (CoverChainStageProgress & { overall: number })[] = [];
    let overall = 0;
    await runCoverChain({
      enabled: only(...STEPPER_IDS),
      referenceDocId: refId,
      onProgress: (f) => {
        overall = f;
      },
      onStageProgress: (p) => seen.push({ ...p, overall }),
    });

    for (const e of seen) {
      expect(e.stageFraction).toBeGreaterThanOrEqual(0);
      expect(e.stageFraction).toBeLessThanOrEqual(1);
    }
    // It restarts at 0 for every stage; the overall fraction never returns to 0
    // once the first stage has moved.
    expect(seen.filter((e) => e.stageFraction === 0)).toHaveLength(6); // measuring + rendering-0, × 3
    // Match EQ carries 56 of the 68 weight, so mid-way through ITSELF it is
    // further along than the pass is; Match Loudness carries 1, so mid-way
    // through itself the pass is far ahead of it. Both directions, so no
    // rescaling of the overall fraction can pass.
    const inFlight = seen.filter((e) => e.stageFraction > 0 && e.stageFraction < 1);
    expect(inFlight.length).toBeGreaterThan(0);
    expect(inFlight.some((e) => e.stageFraction > e.overall)).toBe(true);
    expect(inFlight.some((e) => e.stageFraction < e.overall)).toBe(true);
    for (let i = 1; i < seen.length; i++) {
      if (seen[i].stageId !== seen[i - 1].stageId) continue;
      expect(seen[i].stageFraction).toBeGreaterThanOrEqual(seen[i - 1].stageFraction);
    }
  });

  // Emission ORDER is not emission VISIBILITY, and the first version of this
  // block only pinned the order. `resolveStage` is synchronous, so announcing
  // the measurement, taking it and announcing the render happened in ONE
  // non-yielding block: React collapses the two state updates into a single
  // flush and no frame paints until the task ends. This chain has the app's
  // worst case — `deriveMatchEq` computes the take's whole long-term spectrum
  // inside the loop, 1.75 s of the 2.28 s that makes Match EQ 56 of the 68
  // weight, and every bit of it ran with the previous row still on screen.
  //
  // (Match Reverb, which the symptom is easy to blame, is NOT the expensive
  // one in-loop: its decay fit is hoisted into `measureReference` before the
  // first stage. Its declining row was frozen by Match EQ's measurement, not
  // by its own.)
  //
  // The observation is a TIMER, because a timer can only have run if the engine
  // gave the main thread back. A microtask would not do: it drains before
  // paint, so a `Promise.resolve()` yield would pass an ordering test and
  // present nothing.

  it('hands the main thread back between announcing a measurement and taking it', async () => {
    const { refId } = seedPair(takeAudio(), refAudio());
    const yielded = new Set<CoverChainStageId>();
    const sawYield = new Map<CoverChainStageId, boolean>();
    await runCoverChain({
      enabled: only(...STEPPER_IDS),
      referenceDocId: refId,
      onStageProgress: (p) => {
        if (p.phase === 'measuring') {
          yielded.delete(p.stageId);
          setTimeout(() => yielded.add(p.stageId), 0);
          return;
        }
        if (!sawYield.has(p.stageId)) sawYield.set(p.stageId, yielded.has(p.stageId));
      },
    });
    expect([...sawYield.keys()]).toEqual(STEPPER_IDS);
    for (const id of STEPPER_IDS) expect(sawYield.get(id)).toBe(true);
  });

  it('yields before a DECLINE too, so the stage that refuses is still seen deciding', async () => {
    // A stage that declines still took a measurement to decide, and it is the
    // one whose row a user is most likely to be watching — Match Reverb
    // declines on most material. Announcing only the stages that go on to
    // render would leave the most common outcome in this chain with no live
    // state at all between Waiting and Did not run.
    const { refId } = seedPair(takeAudio(), refAudio());
    let yielded = false;
    let sawYield: boolean | null = null;
    const report = await runCoverChain({
      enabled: only('matchReverb'),
      referenceDocId: refId,
      onStageProgress: (p) => {
        if (p.stageId !== 'matchReverb' || p.phase !== 'measuring') return;
        setTimeout(() => {
          yielded = true;
        }, 0);
      },
      onStageResult: (r) => {
        if (r.id === 'matchReverb') sawYield = yielded;
      },
    });
    expect(resultFor(report!.stages, 'matchReverb').status).toBe('declined');
    expect(sawYield).toBe(true);
  });

  it('paints the announcement BEFORE the measurement runs, not after it', async () => {
    // The timer test proves a task boundary fell between the two
    // announcements; it cannot say which SIDE of the expensive part it is on.
    // Moving the announcement below `resolveStage` still yields, still emits in
    // order, and still freezes the main thread through the measurement with the
    // previous row on screen — and that mutation SURVIVED this suite until this
    // test existed, while the vocal chain's equivalent already killed it.
    //
    // Match EQ is the stage to aim this at, not Match Reverb: the reverb's
    // decay estimate is hoisted OUT of the loop into `measureReference`, so its
    // in-loop resolve is cheap, whereas `deriveMatchEq` computes the take's
    // whole long-term spectrum inside the loop — 1.75 s of the 2.28 s that
    // makes this stage 56 of the 68 weight.
    const { refId } = seedPair(takeAudio(), refAudio());
    const raf = jest.spyOn(window, 'requestAnimationFrame');
    const ltas = jest.spyOn(coverMatch, 'longTermAverageSpectrum');

    await runCoverChain({ enabled: only('matchEq'), referenceDocId: refId, onStageProgress: () => {} });

    expect(raf).toHaveBeenCalledTimes(1);
    const paint = raf.mock.invocationCallOrder[0];
    const spectra = ltas.mock.invocationCallOrder;
    // Two before the paint — the reference's own spectrum and the run's
    // before-metrics, neither of which is the STAGE's work — and two after it:
    // `deriveMatchEq`'s own pass over the take, and the after-metrics.
    expect(spectra).toHaveLength(4);
    expect(spectra.filter((o) => o < paint)).toHaveLength(2);
    expect(spectra.filter((o) => o > paint)).toHaveLength(2);

    ltas.mockRestore();
    raf.mockRestore();
  });

  it('yields ONLY for a consumer that asked for stage progress — the contract stays additive', async () => {
    // `testHooks` and the packaged smoke drive this chain with no callbacks and
    // must keep exactly today's timing, so the gate is part of the contract
    // rather than an optimisation. Observed at the scheduler.
    const raf = jest.spyOn(window, 'requestAnimationFrame');

    const first = seedPair(takeAudio(), refAudio());
    await runCoverChain({ enabled: only(...STEPPER_IDS), referenceDocId: first.refId });
    expect(raf).not.toHaveBeenCalled();

    useAppStore.setState(makeInitialState());
    const second = seedPair(takeAudio(), refAudio());
    await runCoverChain({
      enabled: only(...STEPPER_IDS),
      referenceDocId: second.refId,
      onStageProgress: () => {},
    });
    expect(raf.mock.calls.length).toBeGreaterThanOrEqual(STEPPER_IDS.length);

    raf.mockRestore();
    // PW1: an explicit budget, because this is the only test in the file that
    // runs TWO whole cover chains back to back, and jest's 5 s default is not a
    // budget anyone chose for that. In isolation the entire 76-test file takes
    // ~21 s; under a full `--maxWorkers=14` run it takes ~91 s, and at that
    // contention these two passes alone overran the default and failed the gate
    // at random. Nothing about what the test ASSERTS changes — a wall-clock
    // budget is not an assertion, and a genuine hang still fails here.
  }, 60_000);

  it('measures before it renders, on every stage, and says so', async () => {
    const { refId } = seedPair(takeAudio(), refAudio());
    const seen: CoverChainStageProgress[] = [];
    await runCoverChain({
      enabled: only(...STEPPER_IDS),
      referenceDocId: refId,
      onStageProgress: (p) => seen.push(p),
    });
    for (const id of STEPPER_IDS) {
      const phases = seen.filter((e) => e.stageId === id).map((e) => e.phase);
      expect(phases[0]).toBe('measuring');
      expect(phases.indexOf('rendering')).toBeGreaterThan(-1);
      expect(phases.lastIndexOf('measuring')).toBeLessThan(phases.indexOf('rendering'));
    }
    for (const e of seen.filter((p) => p.phase === 'measuring')) {
      expect(e.detail).toBe(STAGE_MEASURING_DETAIL);
    }
  });

  it("makes the rendering line the stage's OWN derived settings, not a second copy of them", async () => {
    const { refId } = seedPair(takeAudio(), refAudio());
    const seen: CoverChainStageProgress[] = [];
    const report = await runCoverChain({
      enabled: only(...STEPPER_IDS),
      referenceDocId: refId,
      onStageProgress: (p) => seen.push(p),
    });

    // The expectation is read out of the REPORT rather than written here, so a
    // drift between the live line and the finished report is a failure rather
    // than a difference nobody notices.
    const loudness = resultFor(report!.stages, 'matchLoudness');
    expect(loudness.derived.length).toBeGreaterThan(0);
    const rendering = seen.filter((e) => e.stageId === 'matchLoudness' && e.phase === 'rendering');
    expect(rendering.length).toBeGreaterThan(0);
    for (const e of rendering) {
      expect(e.detail).toBe(stageRenderingDetail(loudness.derived));
      for (const d of loudness.derived) expect(e.detail).toContain(d.value);
    }

    // The limiter derives NOTHING here either — a ceiling is an absolute level —
    // and says that instead of showing an empty line.
    const headroom = resultFor(report!.stages, 'headroom');
    expect(headroom.derived).toEqual([]);
    for (const e of seen.filter((p) => p.stageId === 'headroom' && p.phase === 'rendering')) {
      expect(e.detail).toBe(STAGE_RENDERING_DETAIL);
    }
  });

  it('hands out each stage result the moment it lands — the very objects the report carries', async () => {
    const { refId } = seedPair(takeAudio(), refAudio());
    const seen: CoverChainStageResult[] = [];
    const report = await runCoverChain({
      enabled: only(...STEPPER_IDS),
      referenceDocId: refId,
      onStageResult: (r) => seen.push(r),
    });

    // Every stage, run or not, in registry order — the same list the smoke
    // compares against `registryStageIds`, so a live view built on this cannot
    // show a different set of rows from the finished report.
    expect(seen.map((r) => r.id)).toEqual(COVER_CHAIN_STAGES.map((s) => s.id));
    // IDENTITY, not equality: there is only one object, so there is nothing to
    // keep in sync between the live row and the report.
    expect(seen).toHaveLength(report!.stages.length);
    for (let i = 0; i < seen.length; i++) expect(seen[i]).toBe(report!.stages[i]);
  });

  it('fires the result callback for a stage that DECLINES too, with its reason', async () => {
    // Match Reverb on a noise reference is the most common decline this chain
    // has. The live view must be able to say so while the rest of the pass is
    // still running, which it cannot do if only applied stages report.
    const { refId } = seedPair(takeAudio(), refAudio());
    const seen: CoverChainStageResult[] = [];
    const report = await runCoverChain({
      enabled: only('matchEq', 'matchReverb'),
      referenceDocId: refId,
      onStageResult: (r) => seen.push(r),
    });
    const reverb = seen.find((r) => r.id === 'matchReverb')!;
    expect(reverb.status).toBe('declined');
    expect(reverb.reason).toEqual(expect.any(String));
    expect(reverb).toBe(resultFor(report!.stages, 'matchReverb'));
  });

  it('reaches all four stage statuses the type declares, and each on the right stage', async () => {
    // Enumerated from `StageStatus` by the COMPILER: a bare `StageStatus[]`
    // literal is not exhaustiveness-checked, so adding a fifth member (a
    // 'failed' for the abort path, say) would leave this list at four and the
    // test still claiming completeness. The Record cannot be short.
    const EVERY_STATUS: Record<StageStatus, true> = {
      applied: true,
      declined: true,
      off: true,
      manual: true,
    };
    const ALL_STATUSES = Object.keys(EVERY_STATUS) as StageStatus[];
    expect(ALL_STATUSES).toHaveLength(4);

    const { refId } = seedPair(takeAudio(), refAudio());
    // matchEq on (applies), matchReverb on (declines — a noise reference has
    // no measurable tail longer than the effect's floor), headroom off, and
    // five manual stages that can never run.
    const report = await runCoverChain({
      enabled: only('matchEq', 'matchReverb'),
      referenceDocId: refId,
    });
    const seen = new Set(report!.stages.map((s) => s.status));
    for (const status of ALL_STATUSES) expect(seen.has(status)).toBe(true);
    expect(seen.size).toBe(ALL_STATUSES.length);

    expect(resultFor(report!.stages, 'matchEq').status).toBe('applied');
    expect(resultFor(report!.stages, 'matchReverb').status).toBe('declined');
    expect(resultFor(report!.stages, 'headroom').status).toBe('off');
    for (const id of ['separate', 'clean', 'lyrics', 'timing', 'place'] as CoverChainStageId[]) {
      expect(resultFor(report!.stages, id).status).toBe('manual');
    }
  });

  it('runs EVERY automatic stage end to end — the wiring, not just the evaluator', async () => {
    // A vocal-chain stage once shipped here that could be deleted with all
    // 3999 tests still passing, because no test enabled it end to end. This
    // enables each automatic stage ALONE and observes that the audio changed.
    const automatic = COVER_CHAIN_STAGES.filter((s) => s.effectId !== null);
    expect(automatic).toHaveLength(4);

    for (const stage of automatic) {
      useAppStore.setState(makeInitialState());
      // A reference with a real tail, so Match Reverb ENGAGES rather than
      // declining — the one stage whose shipped default is to say no.
      const decayed = (() => {
        const src = noise(N, 0.5, 3);
        const out = new Float32Array(N);
        // A 2 s exponential decay: RT60 well above the effect's 0.71 s floor.
        for (let i = 0; i < N; i++) out[i] = src[i] * Math.pow(10, (-60 * (i / SR)) / (2.0 * 20));
        return [out];
      })();
      const refChannels = stage.id === 'matchReverb' ? decayed : refAudio();
      // Broadband (so Match EQ has every band to work with), tilted (so the
      // curve is not accidentally flat) and peaking just over the limiter's
      // -0.3 dBFS ceiling (so the headroom stage has something to catch).
      const takeChannels = [
        Float32Array.from(noise(N, 0.55, 5), (v, i) => v + 0.5 * Math.sin((2 * Math.PI * 4000 * i) / SR)),
      ];
      const { refId } = seedPair(takeChannels, refChannels);
      const before = activeDoc().channels.map((c) => Float32Array.from(c));

      const report = await runCoverChain({ enabled: only(stage.id), referenceDocId: refId });
      const result = resultFor(report!.stages, stage.id);
      expect(`${stage.id}:${result.status}`).toBe(`${stage.id}:applied`);
      expect(report!.applied).toBe(true);

      // The audio really changed — a stage that resolved but was never posted
      // to the worker would leave every sample equal.
      const after = activeDoc().channels;
      const identical = after[0].length === before[0].length &&
        before[0].every((v, i) => v === after[0][i]);
      expect(`${stage.id}:changed=${!identical}`).toBe(`${stage.id}:changed=true`);
    }
  });

  it('declines every reference-dependent stage when the reference document is gone', async () => {
    const { refId } = seedPair(takeAudio(), refAudio());
    useAppStore.getState().closeDocument(refId);
    const report = await runCoverChain({
      enabled: only('matchEq', 'matchLoudness', 'matchReverb'),
      referenceDocId: refId,
    });
    expect(report!.applied).toBe(false);
    for (const id of ['matchEq', 'matchLoudness', 'matchReverb'] as CoverChainStageId[]) {
      const result = resultFor(report!.stages, id);
      expect(result.status).toBe('declined');
      expect(result.reason).toMatch(/no original vocal chosen/);
    }
    expect(report!.referenceName).toBeNull();
    expect(report!.reference).toBeNull();
  });

  it('closes the spectral distance to the original vocal — the measurement the EQ exists for', async () => {
    // A take with an audible tilt against the reference, so there is a real
    // shape difference for the stage to remove.
    const tilted = [
      Float32Array.from(noise(N, 0.2), (v, i) => v + 0.25 * Math.sin((2 * Math.PI * 4000 * i) / SR)),
    ];
    const { refId } = seedPair(tilted, [noise(N, 0.2, 11)]);
    const report = await runCoverChain({ enabled: only('matchEq'), referenceDocId: refId });
    expect(report!.before.matchDistanceDb).not.toBeNull();
    expect(report!.after.matchDistanceDb).not.toBeNull();
    expect(report!.after.matchDistanceDb!).toBeLessThan(report!.before.matchDistanceDb!);
    // And it closed most of the way, rather than merely not getting worse.
    expect(report!.after.matchDistanceDb!).toBeLessThan(report!.before.matchDistanceDb! * 0.5);
  });

  it('reports loudness, envelope spread and noise floor before and after, and the target', async () => {
    const { refId } = seedPair(takeAudio(), refAudio());
    const report = await runCoverChain({
      enabled: only('matchLoudness'),
      referenceDocId: refId,
    });
    expect(report!.referenceName).toBe('Song — Vocals');
    for (const metrics of [report!.before, report!.after, report!.reference!]) {
      expect(metrics.gatedLevelDb).not.toBeNull();
      expect(metrics.spreadDb).not.toBeNull();
      expect(metrics.noiseFloorDb).not.toBeNull();
      expect(Number.isFinite(metrics.peakDb)).toBe(true);
    }
    // The loudness stage did its job: the take's gated level is now the
    // reference's, which is the claim the stage makes.
    expect(report!.after.gatedLevelDb!).toBeCloseTo(report!.reference!.gatedLevelDb!, 1);
  });

  it('reports the spread and the floor as the numbers they are, not merely as non-null', async () => {
    // `not.toBeNull()` above is satisfied by any number at all, and two of these
    // fields are quantities the summary shows the user: putting the 90th
    // percentile of the envelope where the SPREAD belongs ships a wrong figure
    // under a right label, and passed the whole suite.
    //
    // Two settled levels 18 dB apart, both inside the 20 dB active gate, with the
    // quiet quarter first so it is also the quietest 500 ms. |x| is constant at
    // each level, so the spread is 18.0 dB and the floor -24.0 dBFS by
    // arithmetic rather than by measurement luck. Every stage is off, so the
    // after side must read back the same two numbers.
    const quietSamples = Math.round(1 * SR);
    const totalSamples = Math.round(4 * SR);
    const twoLevel = new Float32Array(totalSamples);
    twoLevel.set(flatAt(quietSamples, -24), 0);
    twoLevel.set(flatAt(totalSamples - quietSamples, -6), quietSamples);

    const { refId } = seedPair([twoLevel], refAudio());
    const report = await runCoverChain({ enabled: only(), referenceDocId: refId });

    expect(report!.before.spreadDb).toBeCloseTo(18, 1);
    expect(report!.before.noiseFloorDb).toBeCloseTo(-24, 1);
    expect(report!.before.peakDb).toBeCloseTo(-6, 1);
    expect(report!.after.spreadDb).toBeCloseTo(18, 1);
    expect(report!.after.noiseFloorDb).toBeCloseTo(-24, 1);
  });

  it('Ruling C: a match that would clip is caught by the limiter, and named when it is not', async () => {
    // The reference is a near-full-scale signal with almost no crest (its peak
    // IS its level); the take is a quiet sine, whose peak sits 3 dB above its
    // level. Matching the LEVEL therefore pushes the PEAK past full scale —
    // which is exactly the shape of the +9.61 dB / -0.07 dBFS case measured on
    // the reference material, made unambiguous.
    const flat = (level: number) => Float32Array.from({ length: N }, (_, i) => (i % 2 === 0 ? level : -level));
    const loudRef = [flat(0.9)];
    const quietTake = [tone(N, 1000, 0.1, SR)];
    const { refId } = seedPair(quietTake, loudRef);
    const predictedPeak = peakDb(quietTake) + (gatedLevelDb(loudRef, SR)! - gatedLevelDb(quietTake, SR)!);
    expect(predictedPeak).toBeGreaterThan(0); // the fixture really would clip

    const guarded = await runCoverChain({
      enabled: only('matchLoudness', 'headroom'),
      referenceDocId: refId,
    });
    expect(resultFor(guarded!.stages, 'matchLoudness').warning).toBeUndefined();
    const ceiling = Number(getEffect('limiter')!.params.find((p) => p.id === 'ceilingDb')!.default);
    expect(guarded!.after.peakDb).toBeLessThanOrEqual(ceiling + 0.01);
    expect(resultFor(guarded!.stages, 'headroom').detail).toMatch(/caught \d+\.\d\d dB of peak/);

    // The same run with the limiter off is not silently clipped: the loudness
    // stage names the peak it is about to produce.
    useAppStore.setState(makeInitialState());
    const again = seedPair([tone(N, 1000, 0.1, SR)], [flat(0.9)]);
    const unguarded = await runCoverChain({
      enabled: only('matchLoudness'),
      referenceDocId: again.refId,
    });
    expect(resultFor(unguarded!.stages, 'matchLoudness').warning).toMatch(/above full scale/);
    expect(unguarded!.after.peakDb).toBeGreaterThan(0);
  });

  it('Ruling C holds with Match Reverb ENGAGED, which is when it used to fail', async () => {
    // The defect this test exists for: Match Reverb was registered AFTER the
    // limiter, so the last thing to touch the audio was a stage that sums a wet
    // path onto the dry one and raises peaks. The limiter's own note told the
    // user that could not happen, `encodeWav` hard-clips, and no test enabled
    // the two stages together.
    //
    // The reference is loud, low-crest AND decaying — alternating near-full-scale
    // samples under a 30 dB/s fall, an RT60 of 2 s against the effect's 0.711 s
    // floor — so Match Reverb ENGAGES rather than taking its usual decline. The
    // take is dense noise 23 dB quieter, so the loudness match lifts it to within
    // 3 dB of the ceiling and leaves the reverb a signal with real energy to
    // work on. In the shipped order that combination ends at +3.09 dBFS.
    const decayingRef = (() => {
      const out = new Float32Array(N);
      const cycle = Math.round(SR * 1.0);
      for (let i = 0; i < N; i++) {
        out[i] = (i % 2 === 0 ? 0.95 : -0.95) * Math.pow(10, (-30 * ((i % cycle) / SR)) / 20);
      }
      return [out];
    })();
    const denseTake = [noise(N, 0.05, 5)];
    const { refId } = seedPair(denseTake, decayingRef);

    const report = await runCoverChain({
      enabled: only('matchLoudness', 'matchReverb', 'headroom'),
      referenceDocId: refId,
    });
    // The fixture really did exercise the path: the reverb ran, and the
    // loudness match really did push the peak up towards the ceiling.
    expect(resultFor(report!.stages, 'matchReverb').status).toBe('applied');
    expect(resultFor(report!.stages, 'matchLoudness').status).toBe('applied');
    expect(resultFor(report!.stages, 'headroom').status).toBe('applied');
    expect(report!.after.peakDb).toBeGreaterThan(report!.before.peakDb);

    // THE promise: the ceiling holds on the OUTPUT. In the shipped order this
    // came back at +3.09 dBFS.
    const ceiling = Number(getEffect('limiter')!.params.find((p) => p.id === 'ceilingDb')!.default);
    expect(report!.after.peakDb).toBeLessThanOrEqual(ceiling + 0.01);
    expect(report!.after.peakDb).toBeLessThan(0);
    // And the limiter had real work to do, so that is an outcome the chain
    // produced rather than one the fixture never threatened.
    expect(resultFor(report!.stages, 'headroom').detail).toMatch(/caught \d+\.\d\d dB of peak/);

    // Two-sided, because "the ceiling held" is worth nothing unless the stage
    // after it could have broken it. Run the same two effects in the ORDER THAT
    // SHIPPED — limiter, then reverb — on the same fixture, and the peak comes
    // back OVER full scale. The defect is reproduced from the effects
    // themselves rather than described.
    const gainDb = gatedLevelDb(decayingRef, SR)! - gatedLevelDb(denseTake, SR)!;
    const amplified = getEffect('amplify')!.process(
      denseTake.map((c) => Float32Array.from(c)),
      SR,
      { gainDb }
    ).channels;
    const limited = getEffect('limiter')!.process(
      amplified.map((c) => Float32Array.from(c)),
      SR,
      { ceilingDb: ceiling, releaseMs: 50 }
    ).channels;
    expect(peakDb(limited)).toBeLessThanOrEqual(ceiling + 0.01);
    const thenReverbed = getEffect('reverb')!.process(
      limited.map((c) => Float32Array.from(c)),
      SR,
      { roomSize: 0.646, damping: 0.5, mix: 0.3, preDelayMs: 10 }
    ).channels;
    expect(peakDb(thenReverbed)).toBeGreaterThan(0);
  });

  // ── Ruling C's remaining hole, back-ported from the chain that borrowed it ──
  // `deriveMatchLoudness` is the only place Ruling C was implemented, and it is
  // resolved ONLY for a stage that is switched on. With Match Reverb on and
  // both level stages off, the tail goes over full scale and nothing anywhere
  // said so — the case the Limiter's own note measures at +0.37 to +7.76 dBFS.
  // Same three conditions the vocal chain's `stageWarning` uses, one door along.
  describe('the over-scale tail with both level stages off (W1-4)', () => {
    // Loud, low-crest AND decaying: 2 s RT60 against the effect's 0.711 s floor,
    // so Match Reverb ENGAGES instead of taking its usual decline.
    const decayingRef = () => {
      const out = new Float32Array(N);
      const cycle = Math.round(SR * 1.0);
      for (let i = 0; i < N; i++) {
        out[i] = (i % 2 === 0 ? 0.95 : -0.95) * Math.pow(10, (-30 * ((i % cycle) / SR)) / 20);
      }
      return [out];
    };

    it('names the peak when Match Reverb runs with both level stages off, and still runs', async () => {
      // Near-full-scale take: the tail is summed onto a signal that has no room
      // left, which is the measured case.
      const { refId, takeId } = seedPair([noise(N, 1.0, 81)], decayingRef());
      const report = await runCoverChain({ enabled: only('matchReverb'), referenceDocId: refId });

      const reverb = resultFor(report!.stages, 'matchReverb');
      expect(reverb.status).toBe('applied');
      // The fixture really does come back over full scale, so the warning has
      // something to be about — it is not firing on a code path.
      expect(reverb.delta!.peakAfterDb).toBeGreaterThan(0);
      expect(report!.after.peakDb).toBeGreaterThan(0);

      expect(reverb.warning).toBeDefined();
      expect(reverb.warning).toMatch(/above full scale/);
      expect(reverb.warning).toMatch(/hard-clip/);
      // THE number, this run's own, not a figure from a document.
      expect(reverb.warning).toContain(`${reverb.delta!.peakAfterDb.toFixed(2)} dBFS`);

      // A warning, not a refusal: the stage ran and the document was edited.
      expect(report!.applied).toBe(true);
      expect(getHistory(takeId).done.length).toBeGreaterThan(0);
    });

    it('says nothing when the Limiter is on, because then the ceiling holds', async () => {
      const { refId } = seedPair([noise(N, 1.0, 81)], decayingRef());
      const report = await runCoverChain({
        enabled: only('matchReverb', 'headroom'),
        referenceDocId: refId,
      });

      const reverb = resultFor(report!.stages, 'matchReverb');
      expect(reverb.status).toBe('applied');
      // Same fixture, same over-scale peak at the reverb's OWN output — the one
      // difference is the stage that catches it afterwards.
      expect(reverb.delta!.peakAfterDb).toBeGreaterThan(0);
      expect(reverb.warning).toBeUndefined();
      const ceiling = Number(getEffect('limiter')!.params.find((p) => p.id === 'ceilingDb')!.default);
      expect(report!.after.peakDb).toBeLessThanOrEqual(ceiling + 0.01);
    });

    it('says nothing when Match Loudness is on, because that stage carries Ruling C itself', async () => {
      const { refId } = seedPair([noise(N, 1.0, 81)], decayingRef());
      const report = await runCoverChain({
        enabled: only('matchReverb', 'matchLoudness'),
        referenceDocId: refId,
      });

      const reverb = resultFor(report!.stages, 'matchReverb');
      expect(reverb.status).toBe('applied');
      expect(reverb.delta!.peakAfterDb).toBeGreaterThan(0);
      expect(reverb.warning).toBeUndefined();
      // And the stage that owns the caveat in this arm really did run.
      expect(resultFor(report!.stages, 'matchLoudness').status).toBe('applied');
    });

    it('says nothing on material the tail never takes over full scale', async () => {
      // Both level stages are off here too, so it is the PEAK doing the
      // deciding and not the stage selection.
      const { refId } = seedPair([noise(N, 0.02, 82)], decayingRef());
      const report = await runCoverChain({ enabled: only('matchReverb'), referenceDocId: refId });

      const reverb = resultFor(report!.stages, 'matchReverb');
      expect(reverb.status).toBe('applied');
      expect(reverb.delta!.peakAfterDb).toBeLessThan(0);
      expect(reverb.warning).toBeUndefined();
    });

    it('leaves every other stage unwarned — it is the tail that is unguarded, not the run', async () => {
      // Full-scale take with both level stages off and the reverb off: the
      // stages that run change the audio too, but none of them SUMS a tail.
      const { refId } = seedPair([noise(N, 1.0, 83)], decayingRef());
      const report = await runCoverChain({ enabled: only('matchEq'), referenceDocId: refId });
      for (const s of report!.stages) expect(s.warning).toBeUndefined();
    });
  });

  it('the limiter says it did nothing when it had nothing to catch', async () => {
    const { refId } = seedPair([tone(N, 1000, 0.1)], refAudio());
    const report = await runCoverChain({ enabled: only('headroom'), referenceDocId: refId });
    expect(resultFor(report!.stages, 'headroom').detail).toMatch(/nothing to do/);
    expect(resultFor(report!.stages, 'headroom').delta!.identicalFraction).toBe(1);
  });

  it('the limiter always says something, on both sides of the 0.01 dB boundary', () => {
    // Probed on the `StageDelta` the function reads, because 0.01 dB of caught
    // peak is not a quantity a fixture can be built to land either side of
    // through the real limiter — and the boundary was untested from below at a
    // size that could move it. The gap it hid: a run that caught 0.008 dB fell
    // past `> 0.01`, past `identicalFraction === 1` (samples DID change), and
    // reported as applied with no detail at all.
    const limiter = coverStageById('headroom');
    // The two peaks are given directly, and `peakAfterDb` is 0 for the boundary
    // probes, so the subtraction the function makes is exact: -0.3 + 0.01 minus
    // -0.3 is 0.010000000000000009 in binary floating point, which would put the
    // "on the boundary" probe on the wrong side of a `>` for a reason that has
    // nothing to do with the constant.
    const delta = (peakBeforeDb: number, peakAfterDb: number, identicalFraction: number | null) => ({
      rmsBeforeDb: -20,
      rmsAfterDb: -20,
      peakBeforeDb,
      peakAfterDb,
      identicalFraction,
      differenceRmsDb: identicalFraction === 1 ? null : -60,
    });
    const quiet = 'nothing to catch — the peak was already under the ceiling';

    // Below / on / above, 0.001 dB either side — a tenth of the step still
    // resolves, so the constant cannot move without a failure.
    expect(describeStage(limiter, delta(0.009, 0, 0.5))).toBe(quiet);
    expect(describeStage(limiter, delta(0.01, 0, 0.5))).toBe(quiet); // `> 0.01`, so 0.01 is not caught
    expect(describeStage(limiter, delta(0.011, 0, 0.5))).toBe('caught 0.01 dB of peak');
    expect(describeStage(limiter, delta(4.26, -0.3, 0.5))).toBe('caught 4.56 dB of peak');
    // And an untouched buffer still gets the stronger sentence, which is the
    // more specific of the two.
    expect(describeStage(limiter, delta(-0.3, -0.3, 1))).toMatch(/every sample came back unchanged/);

    // Every case is covered: no input to this branch returns undefined.
    for (const caught of [0, 0.005, 0.01, 0.02, 1]) {
      for (const fraction of [null, 0, 0.5, 1]) {
        expect(typeof describeStage(limiter, delta(caught, 0, fraction))).toBe('string');
      }
    }
    // A stage that is NOT the limiter still reports only the one thing it can
    // know from the buffers.
    expect(describeStage(coverStageById('matchEq'), delta(-0.3, -5, 0.5))).toBeUndefined();
    expect(describeStage(coverStageById('matchEq'), delta(-5, -5, 1))).toMatch(/came back unchanged/);
  });

  it('a stage that lengthens the region is still one undo entry, and the length is reported', async () => {
    const decayed = new Float32Array(N);
    const src = noise(N, 0.5, 3);
    for (let i = 0; i < N; i++) decayed[i] = src[i] * Math.pow(10, (-60 * (i / SR)) / (2.0 * 20));
    const { refId, takeId } = seedPair([tone(N, 1000, 0.25)], [decayed]);
    const depthBefore = getHistory(takeId).done.length;

    const report = await runCoverChain({ enabled: only('matchReverb'), referenceDocId: refId });
    expect(resultFor(report!.stages, 'matchReverb').status).toBe('applied');
    expect(report!.outputSamples).toBeGreaterThan(report!.regionSamples);
    expect(docLength(activeDoc())).toBe(report!.outputSamples);
    expect(getHistory(takeId).done.length - depthBefore).toBe(1);

    undo(takeId);
    expect(docLength(activeDoc())).toBe(N);
  });

  it('pushes a marker past the region back by the tail Match Reverb added', async () => {
    // The grow remap. A sweep found it could be deleted with every other test
    // still green, because nothing observed a marker through a length-changing
    // stage — the one stage in this chain that changes length.
    const decayed = new Float32Array(N);
    const src = noise(N, 0.5, 3);
    for (let i = 0; i < N; i++) decayed[i] = src[i] * Math.pow(10, (-60 * (i / SR)) / (2.0 * 20));
    const refId = seedDoc([decayed], 'Song \u2014 Vocals');
    // Room after the region for a marker to sit in, so the shift is observable.
    const takeChannels = new Float32Array(N * 2);
    takeChannels.set(tone(N, 1000, 0.25), 0);
    const takeId = seedDoc([takeChannels], 'take');
    useAppStore.setState({ activeDocumentId: takeId, selection: { start: 0, end: N } });
    useAppStore
      .getState()
      .setMarkersForDoc(takeId, [
        { id: 'inside', positionSample: N >> 1, name: 'inside' },
        { id: 'after', positionSample: N + 1000, name: 'after' },
      ]);

    const report = await runCoverChain({ enabled: only('matchReverb'), referenceDocId: refId });
    expect(resultFor(report!.stages, 'matchReverb').status).toBe('applied');
    const grew = report!.outputSamples - report!.regionSamples;
    expect(grew).toBeGreaterThan(0);

    const markers = useAppStore.getState().markers[takeId];
    expect(markers.find((m) => m.id === 'inside')!.positionSample).toBe(N >> 1);
    expect(markers.find((m) => m.id === 'after')!.positionSample).toBe(N + 1000 + grew);
  });

  it('aborts without touching the document when a stage fails', async () => {
    // The `catch` around `runEffectOnChannels` had no test at all: `return null`
    // could have been `continue` and the whole suite stayed green, because
    // nothing here ever made a stage fail. The docstring promises a failure
    // aborts the remaining stages and leaves the document exactly as it was.
    const original = takeAudio()[0];
    const { refId, takeId } = seedPair([Float32Array.from(original)], refAudio());
    const historyBefore = getHistory(takeId).done.length;
    const showMessageBox = jest.fn();
    (window as { electronAPI?: unknown }).electronAPI = { showMessageBox };
    _setDspWorkerLoadFailure('worker exploded');

    const report = await runCoverChain({
      enabled: only('matchEq', 'matchLoudness', 'headroom'),
      referenceDocId: refId,
    });

    // Resolves null rather than rejecting — the dialog awaits this, and a
    // rejection would leave it busy for ever.
    expect(report).toBeNull();
    // No undo entry, and not one sample changed.
    expect(getHistory(takeId).done.length).toBe(historyBefore);
    expect(Array.from(activeDoc().channels[0])).toEqual(Array.from(original));
    // Reported ONCE, on the first failure, rather than once per remaining stage
    // — which is what `return null` buys over `continue`.
    expect(showMessageBox).toHaveBeenCalledTimes(1);
  });

  it('runs over the SELECTION when there is one, leaving the rest untouched', async () => {
    const { refId } = seedPair(takeAudio(), refAudio());
    const before = activeDoc().channels.map((c) => Float32Array.from(c));
    useAppStore.setState({ selection: { start: 0, end: N / 2 } });
    const report = await runCoverChain({
      enabled: only('matchLoudness'),
      referenceDocId: refId,
    });
    expect(report!.regionSamples).toBe(N / 2);
    const after = activeDoc().channels[0];
    for (let i = N / 2; i < N; i++) expect(after[i]).toBe(before[0][i]);
  });

  // ── One resolved region, every consumer (L11) ─────────────────────────────
  // `setSelection` stores whatever it is handed. `cloneRegion` and
  // `replaceRegion` clamp into `[0, docLength]`, but `regionSamples` (which the
  // report shows and the tail's own length is measured against), the grow
  // remap's insert point and the post-edit selection/cursor were all built from
  // the RAW pair — so an out-of-bounds selection gave the chain's arithmetic a
  // region the audio never used. Same defect family as R7's `plan.regionStart`,
  // L1's `resolveRegion` and L9's `runEffectOnSelection`: resolve ONCE, and
  // every consumer reads that pair.

  it('measures and remaps against the CLAMPED region when a NON-ZERO start pairs with an end past the document (L11)', async () => {
    // The one stage in this chain that changes length, on the reference the
    // grow test above uses: a 2.0 s decay, which Match Reverb accepts.
    const decayed = new Float32Array(N);
    const src = noise(N, 0.5, 3);
    for (let i = 0; i < N; i++) decayed[i] = src[i] * Math.pow(10, (-60 * (i / SR)) / (2.0 * 20));
    const refId = seedDoc([decayed], 'Song — Vocals');
    const takeId = seedDoc([tone(N, 1000, 0.25)], 'take');
    useAppStore.setState({ activeDocumentId: takeId });
    useAppStore
      .getState()
      .setMarkersForDoc(takeId, [
        { id: 'inside', positionSample: N >> 1, name: 'inside' },
        { id: 'end', positionSample: N, name: 'end' },
      ]);
    // Clamps to [N / 4, N): three quarters of the take, not the raw five.
    useAppStore.getState().setSelection({ start: N / 4, end: N + N / 2 });

    const report = await runCoverChain({ enabled: only('matchReverb'), referenceDocId: refId });
    expect(resultFor(report!.stages, 'matchReverb').status).toBe('applied');

    // The region the chain SAYS it worked on is the region `cloneRegion` handed
    // the stages — against the raw pair this read 5N/4, a span longer than the
    // whole document.
    expect(report!.regionSamples).toBe((N * 3) / 4);
    const grew = report!.outputSamples - report!.regionSamples;
    expect(grew).toBeGreaterThan(0);
    // Which makes `grew` the tail Match Reverb actually added, and the document
    // agrees with it.
    expect(docLength(activeDoc())).toBe(N + grew);

    const markers = useAppStore.getState().markers[takeId];
    expect(markers.find((m) => m.id === 'inside')!.positionSample).toBe(N >> 1);
    // At the region's end, which IS the document's end: pushed back by the whole
    // tail. Against the raw pair the insert point landed at 3N/2, past every
    // marker there is, so this one stayed at N — a cue point left sitting inside
    // the tail instead of after it.
    expect(markers.find((m) => m.id === 'end')!.positionSample).toBe(N + grew);
  });

  it('offsets the post-edit selection and cursor from the CLAMPED start when the selection begins before sample 0 (L11)', async () => {
    const { refId } = seedPair(takeAudio(), refAudio());
    // Clamps to [0, 3N/4): three quarters, not the raw five.
    useAppStore.getState().setSelection({ start: -N / 2, end: (N * 3) / 4 });

    const report = await runCoverChain({ enabled: only('matchLoudness'), referenceDocId: refId });
    expect(resultFor(report!.stages, 'matchLoudness').status).toBe('applied');

    // Match Loudness preserves length, so the document is untouched in size and
    // the ONLY things the raw start reached are the report's arithmetic and the
    // state the user is left holding.
    expect(docLength(activeDoc())).toBe(N);
    expect(report!.regionSamples).toBe((N * 3) / 4);
    expect(report!.outputSamples).toBe((N * 3) / 4);
    // The raw pair left the document selected from -N/2 with the cursor there.
    expect(useAppStore.getState().selection).toEqual({ start: 0, end: (N * 3) / 4 });
    expect(useAppStore.getState().cursorSample).toBe(0);
  });
});
