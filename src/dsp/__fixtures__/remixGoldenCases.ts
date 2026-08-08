/**
 * The deterministic auto-remix renders the golden pin is taken over (v1.9 X1,
 * ruling 9 / trap T1). Kept in its own module, separate from both the stored
 * expectations (`remixGolden.ts`) and the assertions
 * (`../remixRender.golden.test.ts`), so a later task can render exactly the
 * same inputs -- to regenerate the pin, or to compare its own output against
 * it -- without copying a fixture and drifting from it.
 *
 * ## What the four cases exist to cover
 *
 * Between them they drive EVERY gain-shaping path `renderRemix` has, which is
 * the set of code X1 hoists into `src/dsp/fades.ts`:
 *
 * | case                | covers                                                       |
 * |---------------------|--------------------------------------------------------------|
 * | `centred-cap-tail`  | `crossfadeGains` on the centred branch, at the QUARTER-BEAT   |
 * |                     | width cap (trap T48), plus the 1500 ms quarter-cosine tail    |
 * |                     | fade (equal-power, buffer-end anchored)                       |
 * | `preroll-cap`       | `crossfadeGains` on the pre-roll branch (which reads back its |
 * |                     | own already-written, already-float32-rounded output), also at |
 * |                     | the cap; no tail fade                                         |
 * | `exact-trim`        | the 5 ms end-anchored linear fade after an exact-length trim  |
 * |                     | (equal-gain, buffer-end anchored) on sliced COPIES            |
 * | `tail-overflow`     | the tail-overflow taper ending at an arbitrary position       |
 * |                     | (equal-gain, arbitrary end position), reaching BACKWARD past  |
 * |                     | cursor into the previous segment's audio                      |
 *
 * ## Why the widths are what they are
 *
 * The first two cases run a 150 BPM beat grid (beat period 17640 samples at
 * 44.1 kHz) and request 120 ms. `crossfadeBaseSample` caps the request at a
 * quarter beat period -- 4410 samples, 100 ms -- so the rendered width is the
 * CAP's, not the request's. That is the path auto-remix actually takes at any
 * tempo above ~125 BPM, and a pin that stopped short of it would not cover it
 * (trap T48). Those cases carry `expect.requestedMsAboveCap`, which the test
 * turns into an assertion that the cap really bites AND that the render at
 * the cap is identical to the render at the request -- so a future edit to the
 * fixture cannot silently stop exercising it.
 */
import type { RemixAnalysis } from '../remixFeatures';
import type { RemixSegment, RemixJoin } from '../remixPlan';
import type { RemixPlan, RenderRemixOptions } from '../remixRender';

export const GOLDEN_SR = 44100;

const NUM_BANDS = 23;
const BEATS_PER_BAR = 4;
const R_DIMS = 4 * BEATS_PER_BAR;

/** Deterministic LCG, verbatim recipe from `fft.test.ts` / `remixPlan.test.ts`
 * / `remixRender.test.ts` -- this repo's own precedent for reproducible
 * synthetic noise, never `Math.random()`. A golden pin is worthless if its
 * input is not reproducible, so this is load-bearing here, not stylistic. */
function makeLcg(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff - 0.5;
  };
}

function noise(n: number, seed: number): Float32Array {
  const rand = makeLcg(seed);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = rand();
  return out;
}

function sine(freq: number, n: number, sr = GOLDEN_SR, amp = 1): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / sr);
  return out;
}

function beatGrid(bpm: number, count = 64): Int32Array {
  const period = Math.round((60 / bpm) * GOLDEN_SR);
  return Int32Array.from({ length: count }, (_, i) => i * period);
}

interface AnalysisOverrides {
  numBars: number;
  barBoundary: Int32Array;
  analyzedEndSample: number;
  beatSamples?: Int32Array;
}

/** Minimal hand-built `RemixAnalysis` -- only the fields `remixRender.ts`
 * actually reads carry meaningful values, matching `remixRender.test.ts`'s own
 * fixture convention. `odf` is empty on purpose: with no onset data every
 * boundary strength is 0, so `selectShape`'s onset clause never fires and the
 * shape is decided by `rho` alone -- which is what makes "this case is centred
 * / this one is pre-roll" a property of the SOURCE material rather than of an
 * arbitrary onset fixture. */
function makeAnalysis(o: AnalysisOverrides): RemixAnalysis {
  const { numBars, barBoundary, analyzedEndSample } = o;
  const numBoundaries = numBars + 1;
  const beatSamples = o.beatSamples ?? Int32Array.from({ length: numBoundaries * BEATS_PER_BAR }, (_, i) => i * 30000);

  return {
    bpm: 120,
    confidence: 1,
    beatSamples,
    salience: 1,
    peakRatio: 1,
    ibiCv: 0,
    truncated: false,
    analyzedEndSample,
    odf: new Float32Array(0),
    periodFrames: 20,
    decimationFactor: 1,
    bands: new Float32Array(0),
    numBands: NUM_BANDS,
    odfLow: new Float32Array(0),
    chroma: new Float32Array(0),
    numChromaFrames: 0,
    chromaRate: 10,
    beatsPerBar: BEATS_PER_BAR,
    downbeatPhase: 0,
    downbeatConfidence: 0,
    barBoundary,
    numBars,
    T: new Float32Array(numBoundaries * NUM_BANDS),
    C: new Float32Array(numBoundaries * 12),
    L: new Float32Array(numBoundaries),
    R: new Float32Array(numBoundaries * R_DIMS),
    S: new Float32Array(numBoundaries * (NUM_BANDS + 12)),
    cluster: Int32Array.from({ length: numBoundaries }, (_, i) => i),
    transitionSeen: new Set<string>(),
  };
}

function makePlan(segments: RemixSegment[], joins: RemixJoin[], outputSample: number, targetSample?: number): RemixPlan {
  return {
    ok: true,
    segments,
    joins,
    outputSample,
    targetSample: targetSample ?? outputSample,
    totalCost: 0,
    minOutputSample: outputSample,
    maxOutputSample: outputSample,
    maxBarUse: 1,
    canReroll: joins.length > 0,
  };
}

function join(fromBar: number, toBar: number): RemixJoin {
  return {
    fromBar,
    toBar,
    cost: { timbre: 0, chroma: 0, loudness: 0, rhythm: 0, struct: 0, phrase: 0, total: 0 },
  };
}

export interface GoldenCase {
  name: string;
  source: Float32Array[];
  analysis: RemixAnalysis;
  plan: RemixPlan;
  opts: RenderRemixOptions;
  /** Fixture-sanity expectations -- asserted alongside the pin so a future
   * edit cannot leave the case rendering something that no longer covers the
   * path it was written for. */
  expect: {
    /** Which crossfade branch each join must take. */
    shapes: readonly ('centred' | 'pre-roll')[];
    /** Set when the case must exercise the quarter-beat width cap (T48): the
     * requested width in ms, which the cap must reduce. */
    requestedMsAboveCap?: number;
    /** Set when the case must exercise the tail-overflow taper. Both numbers
     * are derived from the case's own constants, not observed from a render:
     * `overflowSamples` is how far the tail read runs past the end of source
     * (already-silent, zero-padded output), and `fadeLen` is the taper the
     * renderer applies to the real audio immediately before it. */
    tailTaper?: { overflowSamples: number; fadeLen: number };
    /** Set when the case must exercise the 1500 ms quarter-cosine tail fade
     * WITHOUT it swallowing the whole buffer (so the un-faded prefix pins the
     * fade's start position too). */
    quarterCosineTailFade?: boolean;
  };
}

/**
 * Case 1 -- centred crossfade at the quarter-beat cap, then the 1500 ms
 * quarter-cosine tail fade. A 220 Hz sine correlates with itself, so `rho`
 * lands well above `SHAPE_RHO_THRESHOLD` (0.35) and the centred branch is
 * selected. `analyzedEndSample < sourceLen` (real audio exists past the
 * analysed end) is what triggers the tail fade; the output is 70000 samples,
 * longer than the 66150-sample (1.5 s) fade, so the fade's start position is
 * pinned by the un-faded prefix rather than being lost in a
 * whole-buffer ramp.
 */
function caseCentredCapTail(): GoldenCase {
  const aEnd = 40000;
  const bStart = 60000;
  const bEnd = 85000;
  const analyzedEndSample = 90000;
  const sourceLen = 95000;

  const segments: RemixSegment[] = [
    { start: 0, end: aEnd },
    { start: bStart, end: bEnd },
  ];
  const outputSample = aEnd + (bEnd - bStart) + (analyzedEndSample - bEnd);

  return {
    name: 'centred-cap-tail',
    source: [sine(220, sourceLen)],
    analysis: makeAnalysis({
      numBars: 3,
      barBoundary: Int32Array.from([0, aEnd, bStart, bEnd]),
      analyzedEndSample,
      beatSamples: beatGrid(150),
    }),
    plan: makePlan(segments, [join(1, 2)], outputSample),
    opts: { sampleRate: GOLDEN_SR, crossfadeMs: 120, maxNudgeMs: 10 },
    expect: { shapes: ['centred'], requestedMsAboveCap: 120, quarterCosineTailFade: true },
  };
}

/**
 * Case 2 -- pre-roll crossfade at the quarter-beat cap, no tail fade. Two
 * independent noise windows leave the alignment search below `MIN_ALIGN_RHO`,
 * so the guard returns lag 0 with the correlation measured AT lag 0 -- a
 * `rho` far below 0.35, which selects the pre-roll branch. That branch reads
 * back its own already-written output as the outgoing side (so the outgoing
 * sample is already float32-rounded before the gain applies), a numeric
 * detail no other case exercises. `analyzedEndSample === sourceLen` keeps the
 * tail fade out of the way so the crossfade samples are pinned unmodulated.
 */
function casePreRollCap(): GoldenCase {
  const aEnd = 40000;
  const bStart = 60000;
  const bEnd = 85000;
  const sourceLen = 90000;

  const segments: RemixSegment[] = [
    { start: 0, end: aEnd },
    { start: bStart, end: bEnd },
  ];
  const outputSample = aEnd + (bEnd - bStart) + (sourceLen - bEnd);

  return {
    name: 'preroll-cap',
    source: [noise(sourceLen, 4242)],
    analysis: makeAnalysis({
      numBars: 3,
      barBoundary: Int32Array.from([0, aEnd, bStart, bEnd]),
      analyzedEndSample: sourceLen,
      beatSamples: beatGrid(150),
    }),
    plan: makePlan(segments, [join(1, 2)], outputSample),
    opts: { sampleRate: GOLDEN_SR, crossfadeMs: 120, maxNudgeMs: 10 },
    expect: { shapes: ['pre-roll'], requestedMsAboveCap: 120 },
  };
}

/**
 * Case 3 -- the exact-length trim's 5 ms end-anchored linear fade. Same
 * geometry as case 2, with `exactLength` on and a `targetSample` 1234 samples
 * short of the natural output, which is the branch that slices COPIES of the
 * channels and fades those (never the live render buffer). Stereo (two
 * independent noise streams, measured cross-correlation 0.016), so the pin
 * also covers the fade being applied to every channel from one shared gain
 * ramp, and the alignment search running on the MONO mixdown of both.
 *
 * The mono mixdown of those two streams happens to carry a real correlation
 * peak (rho 0.49 at lag +287, measured), so this case renders CENTRED rather
 * than pre-roll -- stated here because the shape is asserted, and a reader
 * comparing it to case 2 would otherwise expect the same branch from
 * similar-looking material.
 */
function caseExactTrim(): GoldenCase {
  const aEnd = 40000;
  const bStart = 60000;
  const bEnd = 85000;
  const sourceLen = 90000;

  const segments: RemixSegment[] = [
    { start: 0, end: aEnd },
    { start: bStart, end: bEnd },
  ];
  const outputSample = aEnd + (bEnd - bStart) + (sourceLen - bEnd);

  return {
    name: 'exact-trim',
    source: [noise(sourceLen, 4242), noise(sourceLen, 8484)],
    analysis: makeAnalysis({
      numBars: 3,
      barBoundary: Int32Array.from([0, aEnd, bStart, bEnd]),
      analyzedEndSample: sourceLen,
      beatSamples: beatGrid(150),
    }),
    plan: makePlan(segments, [join(1, 2)], outputSample, outputSample - 1234),
    opts: { sampleRate: GOLDEN_SR, crossfadeMs: 120, maxNudgeMs: 10, exactLength: true },
    expect: { shapes: ['centred'], requestedMsAboveCap: 120 },
  };
}

/**
 * Case 4 -- the tail-overflow taper. Geometry lifted from the fix-round-3
 * regression fixture in `remixRender.test.ts`: the outgoing reference window
 * is planted 400 samples PAST the incoming segment's nominal start, so the
 * alignment search commits a +400 lag, and `sourceLen` is set so that reading
 * `tailLen` samples from the shifted `finalEffEnd` runs exactly 400 samples
 * past the end of source. The renderer tapers the real audio immediately
 * before that already-silent overflow -- a fade ending at an ARBITRARY
 * position that deliberately reaches backward past the cursor into the
 * previous segment's own written audio (trap T8).
 */
function caseTailOverflow(): GoldenCase {
  const compareLen = 441; // ALIGN_COMPARE_MS (10 ms) at 44.1 kHz
  const aEnd = 50000;
  const bStartNominal = 60000;
  const lb = 8000;
  const naturalLag = 400;
  const tailLenNominal = 2100;
  const sourceLen = bStartNominal + lb + tailLenNominal;

  const src = noise(sourceLen, 200);
  const ref = noise(compareLen, 900);
  src.set(ref, aEnd - compareLen);
  src.set(ref, bStartNominal + naturalLag);

  const segments: RemixSegment[] = [
    { start: 0, end: aEnd },
    { start: bStartNominal, end: bStartNominal + lb },
  ];
  const outputSample = aEnd + lb + (sourceLen - (bStartNominal + lb));

  return {
    name: 'tail-overflow',
    source: [src],
    analysis: makeAnalysis({
      numBars: 3,
      barBoundary: Int32Array.from([0, aEnd, bStartNominal, bStartNominal + lb]),
      analyzedEndSample: sourceLen,
    }),
    plan: makePlan(segments, [join(1, 2)], outputSample),
    opts: { sampleRate: GOLDEN_SR, crossfadeMs: 25, maxNudgeMs: 10 },
    expect: {
      shapes: ['centred'],
      // The tail reads `tailLen` samples from `finalEffEnd = bStartNominal +
      // naturalLag + lb`, and `sourceLen` is exactly `bStartNominal + lb +
      // tailLen`, so the read runs `naturalLag` samples past the end. The
      // taper is `max(overflow, MIN_TAIL_FADE_MS)` long -- 2 ms is 88 samples
      // here, so the overflow itself wins.
      tailTaper: { overflowSamples: naturalLag, fadeLen: Math.max(naturalLag, Math.round((2 / 1000) * GOLDEN_SR)) },
    },
  };
}

export function goldenCases(): GoldenCase[] {
  return [caseCentredCapTail(), casePreRollCap(), caseExactTrim(), caseTailOverflow()];
}

/**
 * The `(t, rho)` grid the gain law is pinned on, at DOUBLE precision.
 *
 * WHY A SECOND PIN IS NEEDED AT ALL. The rendered-audio pin above cannot see
 * a change to `crossfadeGains`' last mantissa bits: the renderer stores every
 * crossfaded sample into a `Float32Array`, and float32 has 29 fewer mantissa
 * bits than the double the gain was computed in. Measured on this fixture's
 * own width (X = 4410, three rho values, 13230 gain pairs): rewriting
 * `g0 / k` as `g0 * (1 / k)` changes 5116 of the 13230 gains at double
 * precision and reassociating `k` changes 332 -- and ZERO of those
 * differences survive the float32 store. So the audio pin stays green through
 * exactly the rewrites trap T5 warns about.
 *
 * That is reassuring for auto-remix (its output is genuinely insensitive to
 * sub-ulp drift) but useless as a check on the law itself, which X3 and X5
 * consume directly and may well evaluate in double precision. Hence this
 * second, double-precision pin: it fails on any reassociation, any
 * reciprocal hoist, any change of clamp order.
 *
 * The `t` values are 21 evenly spaced positions plus the ones a real
 * production crossfade actually evaluates (`k / (X - 1)` at the ends, the
 * centre, and one sample either side of each), because those are where an
 * endpoint or rounding bug would hide.
 */
export function crossfadeGainsGrid(): { t: number; rho: number }[] {
  const X = 4410; // the quarter-beat cap at 150 BPM / 44.1 kHz -- cases 1-3's own width
  const productionK = [0, 1, 2, Math.floor(X / 2) - 1, Math.floor(X / 2), X - 3, X - 2, X - 1];
  const ts = [
    ...Array.from({ length: 21 }, (_, i) => i / 20),
    ...productionK.map((k) => k / (X - 1)),
  ];
  // 0 and 1 are the two exact collapses of the law (equal-power and
  // equal-gain); 0.3 and 0.35 are `MIN_ALIGN_RHO` and `SHAPE_RHO_THRESHOLD`;
  // 0.4937 is the correlation case 3 really measures.
  const rhos = [0, 0.25, 0.3, 0.35, 0.4937, 0.5, 0.75, 1];
  const out: { t: number; rho: number }[] = [];
  for (const rho of rhos) for (const t of ts) out.push({ t, rho });
  return out;
}
