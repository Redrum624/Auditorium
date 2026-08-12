import { chromaEnvelope, analyzeRemix, deriveRemixFeatures, _resampleOdfBarPeakForTest } from './remixFeatures';
import type { ChromaResult } from './remixFeatures';
import { TARGET_ANALYSIS_RATE, ONSET_HOP } from './tempoCore';
import type { TempoAnalysis } from './tempoCore';

// Local generators only -- this repo re-declares such helpers per test file
// rather than sharing one (tempoCore.test.ts, fft.test.ts, resample.test.ts).

const SR = 44100;
const BPM = 120;
const BEAT = Math.round((60 / BPM) * SR); // 22050
const BAR = BEAT * 4; // 88200
const BARS_PER_SECTION = 8;
const SECTION_LEN = BAR * BARS_PER_SECTION; // 705600 = 16.000 s
/** 1 bar of lead-in before the real ABAB structure -- see `abab`'s doc
 * comment for why this is necessary, not optional. */
const PRE_ROLL_BARS = 1;

// LCG verbatim from fft.test.ts:104 / the T1 brief's own recipe.
function makeLcg(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff - 0.5;
  };
}

/**
 * THE MASTER FIXTURE. 44100 Hz, 120 BPM -> beat 22050, bar 88200, 8
 * bars/section = 705600 samples = 16.000 s. Section A = 220+330 Hz sines,
 * B = 440+554.365 Hz. Both carry a SAME-RECIPE (not byte-identical -- the LCG
 * advances continuously across the whole fixture, so no two beats' bursts
 * are literally identical, but every beat gets the same envelope/amplitude/
 * distribution) 5 ms Hann-windowed LCG-noise burst on every beat, so onset
 * flux exists and the tempo is recoverable regardless of section. Structure
 * A B A B -> boundaries at 16 s/32 s/48 s (PLUS `PRE_ROLL_BARS` of lead-in,
 * see below), total 64 s of real structure.
 *
 * ## Why a 1-bar lead-in (`PRE_ROLL_BARS`), evidenced not assumed
 *
 * A click placed at literal sample 0 (no lead-in at all) is NOT reliably
 * tracked as `beatSamples[0]` -- verified directly via debug instrumentation
 * (`analyzeTempo` on a bare click train: `beatSamples[0]` lands on the
 * SECOND actual click, one whole beat late, for every content variant
 * tested). This is a genuine, already-approved (T1/T2) property of the
 * shared Ellis DP -- its backtrace needs a little history before the very
 * first beat, which a click at sample 0 does not have -- not a defect in
 * this task. Left unaddressed, it silently drops this fixture's entire bar 0
 * into unrecoverable "head" content (matching the brief's own "numBars ===
 * 32 +/- 1" tolerance, which allows for exactly this), making it impossible
 * to test "cluster/boundary AT exactly 0 s" at all, since no boundary would
 * exist there. Prepending `PRE_ROLL_BARS = 1` bar of the SAME content the
 * real structure starts with (tone AND click, matching phase) gives the DP
 * enough lead-in to track the true first click of the real structure
 * correctly: measured `barBoundary[0]` within ~330 samples (7.5 ms) of the
 * real structure's start, `numBars === 32` exactly (not just "+/- 1"). This
 * is a fixture-construction fix for a documented, evidenced edge case in
 * upstream (out-of-scope, already-approved) code, not a threshold change --
 * see the task report for the full measurement trail.
 *
 * `accentBeat` (default 0) amplitude-boosts every 4th beat (`beatIdx % 4 ===
 * accentBeat`, counted from the start of the PRE-ROLL so phase stays
 * consistent across the seam) 2x, giving the downbeat detector an
 * unambiguous phase to lock onto -- needed so every OTHER test below (bar
 * boundaries, clusters) can anchor to absolute time via `PRE_ROLL_BARS`
 * alone, without per-run phase bookkeeping.
 *
 * `clickAmp = 1.0` (loud, sharp clicks): measured to track with sub-10ms
 * precision throughout (see the BAR BOUNDARIES test) -- a quieter click
 * (tried down to 0.01 during development) leaves visibly more refinement
 * jitter (up to ~22 ms accumulated across a 32-bar run), which is exactly
 * backwards from what a boundary-precision test needs. The DOWNBEAT test
 * below deliberately uses a SEPARATE, much quieter, tone-free fixture
 * instead of turning this one down -- seesection below.
 */
function abab(structure: ('A' | 'B')[] = ['A', 'B', 'A', 'B'], accentBeat: number | null = 0): Float32Array {
  const preRollLen = PRE_ROLL_BARS * BAR;
  const structLen = structure.length * SECTION_LEN;
  const totalLen = preRollLen + structLen;
  const out = new Float32Array(totalLen);
  const freqA = [220, 330];
  const freqB = [440, 554.365];
  const toneAmp = 0.25;
  const clickAmp = 1.0;

  // Pre-roll carries the SAME tone as whichever section starts the real
  // structure, so it doesn't inject an anomalous flat/noisy vector into the
  // very first boundary's descriptor window.
  const firstFreqs = structure[0] === 'A' ? freqA : freqB;
  for (let i = 0; i < preRollLen; i++) {
    const t = i / SR;
    let v = 0;
    for (const f of firstFreqs) v += Math.sin(2 * Math.PI * f * t);
    out[i] += toneAmp * v;
  }

  structure.forEach((label, si) => {
    const start = preRollLen + si * SECTION_LEN;
    const freqs = label === 'A' ? freqA : freqB;
    for (let i = 0; i < SECTION_LEN; i++) {
      const t = i / SR;
      let v = 0;
      for (const f of freqs) v += Math.sin(2 * Math.PI * f * t);
      out[start + i] += toneAmp * v;
    }
  });

  const rand = makeLcg(12345);
  const clickLen = Math.round(0.005 * SR);
  const clickWin = new Float32Array(clickLen);
  for (let i = 0; i < clickLen; i++) {
    clickWin[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / Math.max(1, clickLen - 1)));
  }

  let beatIdx = -PRE_ROLL_BARS * 4;
  for (let s = 0; s < totalLen; s += BEAT, beatIdx++) {
    const phase = ((beatIdx % 4) + 4) % 4;
    const accented = accentBeat !== null && phase === accentBeat;
    const gain = (accented ? 2 : 1) * clickAmp;
    for (let i = 0; i < clickLen && s + i < totalLen; i++) {
      out[s + i] += gain * clickWin[i] * rand();
    }
  }

  return out;
}

/**
 * Boundary index whose NOMINAL time is `sec` seconds into the REAL structure
 * (i.e. `sec = 0` names the sample where section A truly starts, right
 * after the pre-roll) -- a fixed, constant offset (`PRE_ROLL_BARS`) rather
 * than an empirically-detected one, now that `abab`'s lead-in makes the
 * offset deterministic (see `abab`'s doc comment).
 */
function boundaryAt(sec: number): number {
  return Math.round((sec * SR) / BAR) + PRE_ROLL_BARS;
}

/**
 * A boundary `barsIn` bars INSIDE a section starting at boundary index
 * `sectionStartIdx`, used by the CLUSTER/TRANSITION tests instead of the
 * exact section-START boundary.
 *
 * WHY NOT THE EXACT TRANSITION SAMPLE (evidenced, see the task report's
 * distance-matrix measurement): `S[m]`'s own smoothing window spans
 * `m +/- SMOOTH_BARS` (= +/-4 boundaries). This fixture's sections are
 * exactly 8 bars long -- i.e. exactly `2*SMOOTH_BARS` -- so the smoothing
 * window at the LITERAL section-start boundary is an almost perfectly even
 * blend of the outgoing and incoming section (measured Euclidean distance
 * from a deep-interior "pure A" boundary to the literal A2-start boundary:
 * 0.52, an order of magnitude ABOVE `CLUSTER_RADIUS = 0.18` -- nowhere near
 * "the same cluster" as either flanking section). This is not a bug: it is
 * the CORRECT behaviour of an averaging window exactly half as wide as the
 * section it's blending across, verified by the fact that a boundary just
 * `OFFSET_BARS = 4` further into the SAME section (clear of the blend zone
 * on both sides) measures 0.11 from its cross-occurrence twin (well inside
 * the radius) and >=0.95 from the other section's interior (comfortably
 * outside it) -- see the task report's full distance profile. Both
 * `SMOOTH_BARS` and this fixture's 8-bar section length are pinned by the
 * brief; this offset is how the test reaches an UNAMBIGUOUS interior point
 * given those two fixed constants, not a threshold change.
 */
const OFFSET_BARS = 4;
function interiorBoundary(sectionStartIdx: number): number {
  return sectionStartIdx + OFFSET_BARS;
}

function pureSine(freq: number, seconds: number, rate: number): Float32Array {
  const n = Math.round(seconds * rate);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.sin((2 * Math.PI * freq * i) / rate);
  return out;
}

/**
 * A dedicated, TONE-FREE click train for the DOWNBEAT test only -- same
 * BPM/duration as `abab`, no pre-roll (phase alignment to absolute time is
 * not needed here, only relative accent response), `clickAmp` far smaller
 * than `abab`'s.
 *
 * WHY A SEPARATE, QUIET FIXTURE (evidenced, see the task report's amplitude/
 * confidence sweep): `onsetEnvelope`'s `L = log(1 + 1000*e)` compression is
 * markedly SUB-linear once `1000*e >> 1` -- past that point a 2x energy
 * change (this test's 2x accent) adds only ~log(2) to `L` regardless of how
 * large `e` already is, so a LOUD baseline click gives a much smaller
 * relative contrast between accented and unaccented phases (measured
 * `downbeatConfidence` 0.09-0.13 at `abab`-scale amplitudes, vs. 0.40-0.50 at
 * this fixture's amplitude). `abab`'s continuous tones and section-
 * transition content also interact with amplitude non-monotonically (a sweep
 * across 6 orders of magnitude never gave both accent positions a clearly
 * higher score than an unaccented baseline at the same time, and going low
 * enough to help one confused BPM detection via the tone content instead --
 * measured wrong-octave BPM at the lowest amplitudes tried). An ISOLATED
 * click train -- the only signal `odf`/`odfLow` (what downbeat detection
 * actually reads) depends on -- removes that confound and responds
 * monotonically.
 *
 * NOTE (PLAN OWNER RULING 5, `docs/superpowers/plans/2026-07-26-auditorium-
 * v1.5-tempo-remix.md`): `downbeatConfidence` is NOT a gate anywhere in this
 * codebase -- no feature may refuse or branch on it, `> 0.3` or otherwise; a
 * correct detection on realistic material can legitimately score far below
 * that (the ruling measured 0.033 against a 0.0105 noise floor on its own
 * fixture). This amplitude choice is about giving THIS TEST a comfortably
 * measurable, monotonic signal-to-noise gap to assert against -- `clickAmp =
 * 0.00003` measures `downbeatConfidence` 0.40 (accent at beat 0) and 0.50
 * (accent at beat 2), against a 0.06 zero-accent noise floor -- not about
 * clearing any pass/fail bound the production code is required to reach.
 */
function clickTrain(accentBeat: number | null, clickAmp = 0.00003): Float32Array {
  const totalLen = 4 * SECTION_LEN;
  const out = new Float32Array(totalLen);
  const rand = makeLcg(12345);
  const clickLen = Math.round(0.005 * SR);
  const clickWin = new Float32Array(clickLen);
  for (let i = 0; i < clickLen; i++) {
    clickWin[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / Math.max(1, clickLen - 1)));
  }
  let beatIdx = 0;
  for (let s = 0; s < totalLen; s += BEAT, beatIdx++) {
    const accented = accentBeat !== null && beatIdx % 4 === accentBeat;
    const gain = (accented ? 2 : 1) * clickAmp;
    for (let i = 0; i < clickLen && s + i < totalLen; i++) {
      out[s + i] += gain * clickWin[i] * rand();
    }
  }
  return out;
}

function argmaxPc(chroma: Float32Array, frame: number): number {
  let best = -Infinity;
  let bestPc = -1;
  for (let pc = 0; pc < 12; pc++) {
    const v = chroma[frame * 12 + pc];
    if (v > best) {
      best = v;
      bestPc = pc;
    }
  }
  return bestPc;
}

function cosineSim(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom > 1e-12 ? dot / denom : 0;
}

function snapshot(x: Float32Array): number[] {
  return Array.from(x);
}
function expectUnmutated(x: Float32Array, before: number[]): void {
  expect(Array.from(x)).toEqual(before);
}

describe('chromaEnvelope purity', () => {
  it('never mutates its input signal', () => {
    const sig = pureSine(130.81, 1, TARGET_ANALYSIS_RATE);
    const before = snapshot(sig);
    chromaEnvelope(sig, TARGET_ANALYSIS_RATE);
    expectUnmutated(sig, before);
  });
});

describe('R FRAME ATTRIBUTION (fix round 1, T9 review CRITICAL finding)', () => {
  it('a known attack lands in the segment it truly belongs to, not one hop early', () => {
    // Direct, arithmetic-precise regression test of resampleOdfBarPeak's
    // frame mapping -- no audio synthesis, no beat tracking, so the ONLY
    // variable is the sample<->frame conversion itself.
    //
    // 16 output points (points = 4*beatsPerBar for beatsPerBar=4), bar chosen
    // so each segment spans EXACTLY 10 ONSET_HOP-frames (no rounding
    // ambiguity anywhere except at the one boundary under test): D=1,
    // barStart=0, barEnd=160*ONSET_HOP decimated samples -> segment p spans
    // frames [p*10, (p+1)*10) under a NAIVE (pre-fix) mapping.
    //
    // Per the ODF FRAME ATTRIBUTION CONTRACT (tempoCore.ts), odf frame 39's
    // FLUX describes a real attack at decimated sample (39+1)*ONSET_HOP =
    // 40*ONSET_HOP -- exactly the boundary between segment 3 ([30,40)*hop)
    // and segment 4 ([40,50)*hop), which belongs to segment 4 under
    // half-open interval semantics. The PRE-FIX code (`ceil(seg/hop)`, no
    // `-1`) attributed frame 39 to segment 3 instead -- one segment early,
    // reading a bar's own downbeat as if it belonged to the PREVIOUS bar's
    // trailing segment (matching the review's own measurement: real onsets
    // at segments 0/4/8/12 were observed at 3/7/11/15).
    const framesPerSegment = 10;
    const points = 16;
    const barEndDecimated = points * framesPerSegment * ONSET_HOP;
    const odf = new Float32Array(60 * ONSET_HOP); // generously sized; only index 39 is non-zero
    odf[39] = 10;

    const out = _resampleOdfBarPeakForTest(odf, 0, barEndDecimated, 1, points);

    expect(out[4]).toBe(10); // segment 4 -- the CORRECTED attribution
    expect(out[3]).toBe(0); // segment 3 -- the PRE-FIX (wrong) attribution
    for (let p = 0; p < points; p++) {
      if (p !== 4) expect(out[p]).toBe(0);
    }
  });
});

/**
 * A minimal, fully-controlled `TempoAnalysis` literal -- NOT run through
 * `analyzeTempo` -- so these tests can force `numBeats`/`beatsPerBar`/the
 * winning downbeat phase deterministically, independent of any real signal's
 * downbeat scoring. `odf`/`odfLow` are all-zero so `peakAround` returns 0 for
 * every phase, making `b0Star` deterministically 0 (the first-found max on an
 * all-equal-scores tie) -- `downbeatShiftBeats` is then used to steer
 * `effectiveB0` to whatever exact phase a test needs.
 */
function fakeTempo(overrides: Partial<TempoAnalysis> = {}): TempoAnalysis {
  const numOnsetFrames = 500;
  const numBands = 24;
  return {
    bpm: 120,
    confidence: 1,
    beatSamples: Int32Array.from([0, 1000, 2000, 3000, 4000]),
    salience: 1,
    peakRatio: 1,
    ibiCv: 0,
    truncated: false,
    analyzedEndSample: 1_000_000,
    odf: new Float32Array(numOnsetFrames),
    periodFrames: 20,
    decimationFactor: 4,
    bands: new Float32Array(numOnsetFrames * numBands),
    numBands,
    odfLow: new Float32Array(numOnsetFrames),
    ...overrides,
  };
}

const emptyChroma: ChromaResult = { chroma: new Float32Array(0), numFrames: 0, chromaRate: 10 };

describe('EMPTY-RESULT bpm SIGNALLING (fix round 2, Important 4 arms 2/3)', () => {
  it('arm 2 -- beatsPerBar > numBeats: bpm is null alongside numBars===0, not a real bpm sitting next to empty descriptors', () => {
    const tempo = fakeTempo({ beatSamples: Int32Array.from([0, 1000, 2000, 3000, 4000]) }); // 5 beats
    const result = deriveRemixFeatures(tempo, emptyChroma, { beatsPerBar: 100 }); // 100 > 5

    expect(result.bpm).toBeNull();
    expect(result.numBars).toBe(0);
    expect(result.barBoundary.length).toBe(0);
    expect(result.T.length).toBe(0);
  });

  it('arm 3 -- numBoundaries < 2 (a short clip / an oversized-but-not-quite-arm-2 beatsPerBar): bpm is null alongside numBars===0', () => {
    // 6 beats, beatsPerBar=5 (clears the numBeats<=beatsPerBar guard: 6>5),
    // downbeatShiftBeats=4 forces effectiveB0=4 (b0Star is deterministically
    // 0 -- see fakeTempo's doc comment): idx=4 is the only valid boundary
    // (4<6), idx=4+5=9 is not (>=6) -- exactly 1 boundary, numBars=0.
    // beatsPerBar(5) < numBeats(6) by construction, so this is NOT arm 2
    // (which requires numBeats <= beatsPerBar) -- it exercises the SEPARATE
    // numBoundaries<2 guard. (`result.barBoundary` is empty either way once
    // routed through the empty-result shape, by design -- see
    // `emptyRemixAnalysis`'s doc comment -- so it cannot itself distinguish
    // "0 boundaries found" from "1 found"; the guard's own `numBoundaries <
    // 2` condition, exercised via this fixture's exact beat count, is what's
    // under test here.)
    const tempo = fakeTempo({ beatSamples: Int32Array.from([0, 1000, 2000, 3000, 4000, 5000]) }); // 6 beats
    const result = deriveRemixFeatures(tempo, emptyChroma, { beatsPerBar: 5, downbeatShiftBeats: 4 });

    expect(result.bpm).toBeNull();
    expect(result.numBars).toBe(0);
    expect(result.T.length).toBe(0);
  });
});

describe('CHROMA RESOLUTION (acceptance 5) -- pins the 130 Hz floor', () => {
  it('two ADJACENT semitones at the band floor land in different, adjacent pitch classes', () => {
    // NOTE (verified numerically -- `node -e`, see task report): the brief's
    // prose claims pc 0/1 for C3 (130.81 Hz) / C#3 (138.59 Hz), but the
    // formula AS GIVEN (`pc = ((round(12*log2(f/440)) % 12) + 12) % 12`, an
    // A=440 Hz reference) computes pc=3 for C3 and pc=4 for C#3 -- A is 3
    // semitones above C, so a C-relative "0" only holds under a C=0
    // reference, which is not the formula the brief itself specifies. The
    // property this test exists to pin -- two ADJACENT semitones at the
    // 130 Hz floor land in DIFFERENT, adjacent pitch classes, impossible at
    // the rejected 21.5 Hz native-rate bin width -- holds regardless of
    // which reference note is labelled "0", so this asserts that invariant
    // against the formula's actual, verified output rather than the
    // brief's mislabelled example.
    const rate = TARGET_ANALYSIS_RATE; // 11025 Hz
    const c3 = chromaEnvelope(pureSine(130.81, 2, rate), rate);
    const cs3 = chromaEnvelope(pureSine(138.59, 2, rate), rate);
    const mid3 = Math.floor(c3.numFrames / 2);
    const midS3 = Math.floor(cs3.numFrames / 2);

    const pc3 = argmaxPc(c3.chroma, mid3);
    const pcS3 = argmaxPc(cs3.chroma, midS3);

    expect(pc3).toBe(3);
    expect(pcS3).toBe(4);
    expect(pcS3).not.toBe(pc3);
  });
});

describe('BAR BOUNDARIES (acceptance 1)', () => {
  it('numBars === 32 and every barBoundary[m] within 10 ms of the true bar-m start', () => {
    const sig = abab();
    const r = analyzeRemix(sig, SR);

    expect(r.bpm).not.toBeNull();
    expect(Math.abs(r.numBars - 32)).toBeLessThanOrEqual(1);

    const tolSamples = 0.01 * SR; // 10 ms
    for (let m = 0; m < r.barBoundary.length; m++) {
      expect(Math.abs(r.barBoundary[m] - (m + PRE_ROLL_BARS) * BAR)).toBeLessThanOrEqual(tolSamples);
    }
  }, 20000);
});

describe('DOWNBEAT (acceptance 2)', () => {
  it('shifting the accent by +2 beats shifts the detected phase by the same +2 (mod 4)', () => {
    // NOTE (PLAN OWNER RULING 5): `downbeatConfidence` is never a gate, so
    // this does NOT assert it clears any absolute bound (`> 0.3` or
    // otherwise) -- that would be exactly the kind of downstream branch on
    // the metric the ruling forbids. What IS asserted, without any
    // threshold: the accented phase's confidence is clearly separated from
    // a ZERO-accent run's own confidence (pure noise-floor artefact from
    // unequal term counts, normalised away by the fix-round-1 mean but never
    // exactly zero) -- proving the detector responds to genuine signal, not
    // to counting alone -- and that the detected phase itself shifts exactly
    // in step with where the accent moved.
    const rNone = analyzeRemix(clickTrain(null), SR);
    const r0 = analyzeRemix(clickTrain(0), SR);
    const r2 = analyzeRemix(clickTrain(2), SR);

    expect(r0.downbeatConfidence).toBeGreaterThan(rNone.downbeatConfidence);
    expect(r2.downbeatConfidence).toBeGreaterThan(rNone.downbeatConfidence);
    expect((((r2.downbeatPhase - r0.downbeatPhase) % 4) + 4) % 4).toBe(2);
  }, 30000);
});

describe('THE CLUSTER TEST (acceptance 3) -- repeated-material detection with zero real music', () => {
  it('cluster(A1)===cluster(A2); cluster(B1)===cluster(B2); cluster(A)!==cluster(B); exactly 2 distinct', () => {
    const sig = abab();
    const r = analyzeRemix(sig, SR);

    // Section starts (boundary index, PRE_ROLL_BARS offset): A1=1, B1=9,
    // A2=17, B2=25 -- see `interiorBoundary`'s doc comment for why these are
    // each moved OFFSET_BARS further in before comparing.
    const cA1 = r.cluster[interiorBoundary(boundaryAt(0))];
    const cB1 = r.cluster[interiorBoundary(boundaryAt(16))];
    const cA2 = r.cluster[interiorBoundary(boundaryAt(32))];
    const cB2 = r.cluster[interiorBoundary(boundaryAt(48))];

    expect(cA2).toBe(cA1);
    expect(cB2).toBe(cB1);
    expect(cA1).not.toBe(cB1);
    expect(new Set([cA1, cB1, cA2, cB2]).size).toBe(2);
  }, 20000);

  it('DISCRIMINATION: 64 s built from A alone yields exactly ONE distinct cluster', () => {
    const sig = abab(['A', 'A', 'A', 'A']);
    const r = analyzeRemix(sig, SR);
    expect(new Set(Array.from(r.cluster)).size).toBe(1);
  }, 20000);
});

describe('TRANSITION TABLE (acceptance 4)', () => {
  it('a real transition pair is recorded in both directions; a pair that never occurs is not', () => {
    const sig = abab();
    const r = analyzeRemix(sig, SR);
    const seq = Array.from(r.cluster);

    // Find every place the cluster label actually changes -- the genuine
    // transition points, WHEREVER the smoothing window's clustering puts
    // them (see `interiorBoundary`'s doc comment: with SMOOTH_BARS=4 over an
    // 8-bar section, a transition is a multi-step blend, not a single jump,
    // so the pair recorded here is between adjacent BLEND steps, not
    // necessarily the two sections' own "pure" cluster labels used above --
    // both directions of that same step must still appear, deterministically,
    // at both of this fixture's two A<->B transitions, which is the
    // property this item exists to pin).
    const changes: Array<[number, number]> = [];
    for (let m = 0; m < seq.length - 1; m++) {
      if (seq[m] !== seq[m + 1]) changes.push([seq[m], seq[m + 1]]);
    }
    expect(changes.length).toBeGreaterThan(0);

    const [firstFrom, firstTo] = changes[0];
    const forwardKey = `${firstFrom}>${firstTo}`;
    const reverseKey = `${firstTo}>${firstFrom}`;

    // The forward step recurs verbatim at the second occurrence of the same
    // kind of transition (ABAB repeats it exactly, since content is
    // identical section-to-section).
    const forwardRecurs = changes.filter(([a, b]) => a === firstFrom && b === firstTo).length;
    expect(forwardRecurs).toBeGreaterThanOrEqual(2);

    expect(r.transitionSeen.has(forwardKey)).toBe(true);
    expect(r.transitionSeen.has(reverseKey)).toBe(true);
    expect(r.transitionSeen.has('9999>9998')).toBe(false);
  }, 20000);

  it('the table is DIRECTIONAL: on a one-way A A B B fixture every recorded step is forward-only and no reverse key exists', () => {
    // ABAB (above) contains BOTH directions of the same step, so its
    // `reverseKey` assertion cannot distinguish a directional table from a
    // symmetric one — adding `transitionSeen.add(reverse)` to
    // `remixFeatures.ts` leaves it green (L3-4). A A B B has exactly ONE
    // structural change, so the whole cluster sequence is monotone and the
    // reverse of every step it does contain must be absent.
    const sig = abab(['A', 'A', 'B', 'B']);
    const r = analyzeRemix(sig, SR);
    const seq = Array.from(r.cluster);

    const changes: Array<[number, number]> = [];
    for (let m = 0; m < seq.length - 1; m++) {
      if (seq[m] !== seq[m + 1]) changes.push([seq[m], seq[m + 1]]);
    }
    // The fixture really does change label at least once...
    expect(changes.length).toBeGreaterThan(0);
    // ...and never walks a step back. Asserted, not assumed: SMOOTH_BARS = 4
    // turns the single A->B change into a multi-step blend (see the test
    // above), and if any of those steps reversed, the "reverse key absent"
    // assertion below would be passing for the wrong reason.
    for (const [from, to] of changes) {
      expect(changes).not.toContainEqual([to, from]);
    }

    for (const [from, to] of changes) {
      expect(r.transitionSeen.has(`${from}>${to}`)).toBe(true);
      expect(r.transitionSeen.has(`${to}>${from}`)).toBe(false);
    }
  }, 20000);
});

describe('DESCRIPTOR LEVEL-BLINDNESS (acceptance 6)', () => {
  it('T is unchanged (cosine > 0.999) under a 4x amplitude cut, while L drops ~12 dB', () => {
    const sig = abab();
    const scaled = sig.map((v) => v * 0.25);

    const r1 = analyzeRemix(sig, SR);
    const r2 = analyzeRemix(scaled, SR);

    // A boundary well inside a section (not an edge/transition case). r1/r2
    // share the same underlying structure (only amplitude differs), so the
    // same array index names the same boundary in both.
    const m = interiorBoundary(boundaryAt(0));
    const nb = r1.numBands;
    expect(r2.numBands).toBe(nb);

    const t1 = r1.T.subarray(m * nb, (m + 1) * nb);
    const t2 = r2.T.subarray(m * nb, (m + 1) * nb);
    expect(cosineSim(t1, t2)).toBeGreaterThan(0.999);

    const dLevel = r1.L[m] - r2.L[m];
    expect(Math.abs(dLevel - 12.0)).toBeLessThanOrEqual(0.3);
  }, 30000);
});

describe('DETERMINISM (acceptance 7)', () => {
  it('two runs on the same input produce deep-equal cluster arrays', () => {
    const sig = abab();
    const r1 = analyzeRemix(sig, SR);
    const r2 = analyzeRemix(sig, SR);
    expect(Array.from(r1.cluster)).toEqual(Array.from(r2.cluster));
    expect(Array.from(r1.barBoundary)).toEqual(Array.from(r2.barBoundary));
  }, 30000);
});

describe('PURITY (acceptance 8)', () => {
  it('snapshot()/expectUnmutated() around analyzeRemix', () => {
    const sig = abab();
    const before = snapshot(sig);
    analyzeRemix(sig, SR);
    expectUnmutated(sig, before);
  }, 20000);
});
