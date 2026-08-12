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
  RESIDUAL_WORST_SECOND_DB,
  coverStageById,
  defaultCoverStageSelection,
  deriveMatchEq,
  deriveMatchLoudness,
  deriveMatchReverb,
  matchDistanceDb,
  measureReference,
  runCoverChain,
  type CoverChainStageId,
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
import { realisedCascadeDb } from '../dsp/graphicEqCascade';
import { _resetDspWorkerTestState } from '../__mocks__/createDspWorkerMock';
import type { StageStatus } from './vocalChain';

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
  /** Enumerated from the TYPE, not from the cases that came to mind — v1.21.0
   * shipped a property test asserting an invariant across "all eight
   * combinations" that was eight of twelve because a three-valued field was
   * hardcoded to two of its values. The annotation is what makes the compiler
   * check the list: adding a member to `CoverChainStageId` without adding it
   * here fails to compile, and the count below fails if one is dropped. */
  const ALL_STAGE_IDS: CoverChainStageId[] = [
    'separate',
    'clean',
    'lyrics',
    'timing',
    'matchEq',
    'matchLoudness',
    'headroom',
    'matchReverb',
    'place',
  ];

  it('registers every id the type declares, in order, and only those', () => {
    expect(ALL_STAGE_IDS).toHaveLength(9);
    expect(COVER_CHAIN_STAGES.map((s) => s.id)).toEqual(ALL_STAGE_IDS);
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
  });

  it('renders every one of them into the sentence the user reads', () => {
    for (const n of ['17.95 dB', '8.9 dB', '250 Hz', '4 kHz', '9.5\u201311.8 dB']) {
      expect(COVER_CHAIN_RESIDUAL_SENTENCE).toContain(n);
    }
  });

  it('says the limitation is what separation does NOT promise, not a footnote', () => {
    expect(COVER_CHAIN_RESIDUAL_SENTENCE).toMatch(/ghost of the original\s+singer/);
    expect(COVER_CHAIN_RESIDUAL_SENTENCE).toMatch(/sum back to the mix exactly/);
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
    // have produced itself.
    const naive = realisedCascadeDb(
      eq.bands.map((b) => b.targetDb),
      MATCH_BAND_CENTRES_HZ,
      SR
    );
    let naiveWorst = 0;
    eq.bands.forEach((b, i) => {
      if (b.status !== 'matched') return;
      naiveWorst = Math.max(naiveWorst, Math.abs(naive[i] - b.targetDb));
    });
    expect(naiveWorst).toBeGreaterThan(0.2);

    // And after it, the realised response IS the target.
    expect(eq.worstErrorDb).toBeLessThanOrEqual(0.01);
    for (const band of eq.bands) {
      if (band.status !== 'matched') continue;
      expect(band.realisedDb).toBeCloseTo(band.targetDb, 1);
      // The gain handed to the effect differs from the target — that difference
      // IS the pre-compensation, and reporting the target as if it were the
      // gain (or the gain as if it were the response) is what Ruling B forbids.
      expect(band.bandGainDb).not.toBeCloseTo(band.targetDb, 5);
    }
    // The `Realised` line says so in the words the dialog renders.
    const realisedLine = resolution.derived.find((d) => d.label === 'Realised')!;
    expect(realisedLine.from).toMatch(/what the audio receives, not what was requested/);
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
  const channels = [tone(N, 1000, 0.5)];

  it('measures only what the enabled stages need', () => {
    const none = measureReference(channels, SR, 'ref', { ltas: false, level: false, decay: false });
    expect(none.ltas).toBeNull();
    expect(none.gatedLevelDb).toBeNull();
    expect(none.decay).toBeNull();

    const all = measureReference(channels, SR, 'ref', { ltas: true, level: true, decay: true });
    expect(all.ltas!.frames).toBeGreaterThan(0);
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

  it('reaches all four stage statuses the type declares, and each on the right stage', async () => {
    // Enumerated from `StageStatus`, not from the ones that came to mind.
    const ALL_STATUSES: StageStatus[] = ['applied', 'declined', 'off', 'manual'];
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

  it('the limiter says it did nothing when it had nothing to catch', async () => {
    const { refId } = seedPair([tone(N, 1000, 0.1)], refAudio());
    const report = await runCoverChain({ enabled: only('headroom'), referenceDocId: refId });
    expect(resultFor(report!.stages, 'headroom').detail).toMatch(/nothing to do/);
    expect(resultFor(report!.stages, 'headroom').delta!.identicalFraction).toBe(1);
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
});
