/**
 * R4 tempo A/B bench — the measurement rig P2-4 needed and never had.
 *
 * HISTORY / WHY THIS EXISTS: the outstanding-work audit quotes "63/91
 * correct, 27 octave errors, 1 non-octave" for the detector, but the
 * 91-fixture bank behind that figure was never committed — no harness script,
 * no report on disk, composition recorded nowhere. That figure is therefore
 * unreproducible and unfalsifiable, and by task-R4 RULING 1 this bank is a
 * NEW DENOMINATOR: whatever it scores on the day it lands is its own
 * baseline, and improvement claims are only ever *this bank before* versus
 * *this bank after*. Never compare its numbers to 63/91.
 *
 * DETERMINISM: the bank is a fixed, code-defined composition (below); every
 * generator is seeded (see `tempoFixtures.ts` — LCG only, never
 * `Math.random()`), every seed is a literal constant in `buildBank`, and
 * `analyzeTempo` is pure. Two runs produce byte-identical reports
 * (`scripts/tempo-bench.test.cjs` pins this).
 *
 * SCORING (per fixture):
 *  - Rhythm fixtures (`trueBpm` set): `correct` when the reported bpm is
 *    within ±`CORRECT_TOL_PCT`% of the truth; `octave` when it is within the
 *    same tolerance of truth×2 or truth÷2; `other` otherwise (including a
 *    null bpm). Tolerance rationale: the existing acceptance tests hold
 *    clean fixtures to ≤1.7% (±1.5 bpm at 90), and the widest legitimate
 *    spread in the bank — a ±10% humanly-jittered grid's LSQ fit, or a
 *    120→126 ramp scored against its midpoint — stays within ~3%; 4% covers
 *    those honestly while sitting far from the 100% error an octave miss
 *    produces, so no fixture can be "correct" and "octave" at once.
 *  - A-tempo fixtures (`trueBpm` null — pad/speech/noise): `correct` when
 *    the detector's confidence stays strictly below `CONFIDENCE_LOW` (the
 *    contract the CONFIDENCE acceptance tests already pin) or it reports no
 *    bpm at all; `other` otherwise. `octave` is impossible for these.
 *
 * The detector is INJECTED into `runBench` (defaults to the real
 * `analyzeTempo`) so the harness can prove it detects a regression: a
 * deliberately octave-broken detector must score strictly worse, otherwise
 * the harness measures nothing (the vacuity trap).
 */

import { analyzeTempo, CONFIDENCE_LOW, MAX_BPM, MIN_BPM } from '../tempoCore';
import type { TempoAnalysis } from '../tempoCore';
import {
  backbeat,
  clickTrain,
  drumLoop,
  jitterClickTrain,
  jitterDrumLoop,
  noiseOnly,
  pad,
  rampClickTrain,
  riseAttackTrain,
  speechLike,
} from './tempoFixtures';

export const BANK_VERSION = 'r4.1';
export const BANK_SAMPLE_RATE = 44100;
/** Fixture length. 20 s matches the acceptance tests' standard length (~30
 * beats at 90 bpm — enough for the DP and the LSQ regression to settle). */
export const BANK_SECONDS = 20;
export const CORRECT_TOL_PCT = 4;

export type Verdict = 'correct' | 'octave' | 'other';

export interface BenchFixture {
  /** Stable unique id, e.g. `click-120`, `jclick-120-j0.04`. */
  id: string;
  family:
    | 'click'
    | 'rise'
    | 'drum'
    | 'backbeat'
    | 'ramp'
    | 'jitter-click'
    | 'jitter-drum'
    | 'atempo';
  /** Nominal truth for rhythm fixtures; null marks an a-tempo fixture. */
  trueBpm: number | null;
  /** Built lazily so constructing the bank list is free. */
  generate: () => Float32Array;
}

export interface BenchRow {
  id: string;
  family: BenchFixture['family'];
  trueBpm: number | null;
  reportedBpm: number | null;
  confidence: number;
  verdict: Verdict;
  /** reported/true, for eyeballing which octave direction failed; null for
   * a-tempo fixtures or a null report. */
  ratio: number | null;
}

export interface BenchTally {
  correct: number;
  octave: number;
  other: number;
}

export interface BenchReport {
  bankVersion: string;
  sampleRate: number;
  seconds: number;
  tolerancePct: number;
  fixtureCount: number;
  aggregate: BenchTally;
  perFamily: Record<string, BenchTally>;
  rows: BenchRow[];
}

function withinPct(value: number, target: number, pct: number): boolean {
  return Math.abs(value - target) <= target * (pct / 100);
}

/**
 * Classifies a reported bpm against a rhythm fixture's truth. Boundary
 * semantics (pinned by tests, below/on/above per operand): ON the tolerance
 * edge counts as inside, per `withinPct`'s `<=`.
 */
export function classifyBpm(reportedBpm: number | null, trueBpm: number): Verdict {
  if (reportedBpm === null || !Number.isFinite(reportedBpm)) return 'other';
  if (withinPct(reportedBpm, trueBpm, CORRECT_TOL_PCT)) return 'correct';
  if (withinPct(reportedBpm, trueBpm * 2, CORRECT_TOL_PCT)) return 'octave';
  if (withinPct(reportedBpm, trueBpm / 2, CORRECT_TOL_PCT)) return 'octave';
  return 'other';
}

/**
 * Classifies an a-tempo fixture's result: the detector is correct when it
 * does NOT claim confident tempo — no bpm at all, or confidence strictly
 * below `CONFIDENCE_LOW` (matching the CONFIDENCE tests' "stays below it"
 * contract; sitting exactly ON the threshold is a claim, hence `other`).
 */
export function classifyAtempo(reportedBpm: number | null, confidence: number): Verdict {
  if (reportedBpm === null) return 'correct';
  return confidence < CONFIDENCE_LOW ? 'correct' : 'other';
}

/**
 * The documented bank. 83 fixtures, all at `BANK_SAMPLE_RATE`; the axes are
 * chosen from what the code comments say matters (tempoCore.ts
 * `chooseOctave`, the drumLoop ghost-amplitude history, the P2-4 jitter
 * mechanism):
 *
 *  - click (10): machine-regular impulse trains, 65–200 bpm. Includes the
 *    documented 200 bpm half-alias boundary and the 180 bpm limitation-1
 *    band ON PURPOSE — an honest bank contains its known losses.
 *  - rise (4): 10 ms linear-ramp attacks, 80–160 bpm.
 *  - drum (20): decaying-kick loops with a ghost note at the half period,
 *    bpm {75,90,100,120,135,150,165} × ghostAmp spanning the fixed range
 *    {0.15,0.3,0.45,0.6} on the three flagship bpm (90/120/150) and
 *    {0.3,0.6} elsewhere. ghostAmp ≥ 0.45 at 90 bpm is the evidenced
 *    content-level ambiguity (limitation 2) — kept, expected to miss.
 *  - backbeat (6): kick/snare/hat pattern, 90–180 bpm; 165/180 are
 *    limitation-1 band members.
 *  - ramp (3): 30 s linear drift ramps (±2.5% around the midpoint truth).
 *  - jitter-click (28): THE P2-4 axis. bpm {75,90,100,120,140,160,180} ×
 *    jitterFrac {0.02,0.04,0.07,0.10}, one distinct seed per fixture.
 *  - jitter-drum (9): jittered grid + ghost energy, bpm {90,120,150} ×
 *    jitter {0.03,0.06} at ghostAmp 0.3, plus jitter 0.03 at ghostAmp 0.6.
 *  - atempo (3): pad, speech-like, LCG noise — the detector must NOT claim
 *    confident tempo on these.
 *
 * Seeds: every jittered fixture's seed is `7000 + 13·k` with `k` its
 * position in the jitter sub-list — literal, stable, and recorded here so
 * the bank is reconstructible from this comment alone.
 */
export function buildBank(): BenchFixture[] {
  const sr = BANK_SAMPLE_RATE;
  const secs = BANK_SECONDS;
  const bank: BenchFixture[] = [];

  for (const bpm of [65, 75, 85, 100, 120, 140, 150, 165, 180, 200]) {
    bank.push({
      id: `click-${bpm}`,
      family: 'click',
      trueBpm: bpm,
      generate: () => clickTrain(bpm, secs, sr),
    });
  }

  for (const bpm of [80, 110, 130, 160]) {
    bank.push({
      id: `rise-${bpm}`,
      family: 'rise',
      trueBpm: bpm,
      generate: () => riseAttackTrain(bpm, secs, sr),
    });
  }

  for (const bpm of [90, 120, 150]) {
    for (const ghost of [0.15, 0.3, 0.45, 0.6]) {
      bank.push({
        id: `drum-${bpm}-g${ghost}`,
        family: 'drum',
        trueBpm: bpm,
        generate: () => drumLoop(bpm, secs, ghost, sr),
      });
    }
  }
  for (const bpm of [75, 100, 135, 165]) {
    for (const ghost of [0.3, 0.6]) {
      bank.push({
        id: `drum-${bpm}-g${ghost}`,
        family: 'drum',
        trueBpm: bpm,
        generate: () => drumLoop(bpm, secs, ghost, sr),
      });
    }
  }

  for (const bpm of [90, 110, 130, 150, 165, 180]) {
    bank.push({
      id: `backbeat-${bpm}`,
      family: 'backbeat',
      trueBpm: bpm,
      generate: () => backbeat(bpm, secs, sr),
    });
  }

  for (const [lo, hi] of [
    [90, 96],
    [110, 116],
    [120, 126],
  ] as const) {
    bank.push({
      id: `ramp-${lo}-${hi}`,
      family: 'ramp',
      trueBpm: (lo + hi) / 2,
      generate: () => rampClickTrain(lo, hi, 30, sr).signal,
    });
  }

  let jitterIndex = 0;
  for (const bpm of [75, 90, 100, 120, 140, 160, 180]) {
    for (const j of [0.02, 0.04, 0.07, 0.1]) {
      const seed = 7000 + 13 * jitterIndex++;
      bank.push({
        id: `jclick-${bpm}-j${j}`,
        family: 'jitter-click',
        trueBpm: bpm,
        generate: () => jitterClickTrain(bpm, secs, j, seed, sr),
      });
    }
  }
  for (const bpm of [90, 120, 150]) {
    for (const [ghost, j] of [
      [0.3, 0.03],
      [0.3, 0.06],
      [0.6, 0.03],
    ] as const) {
      const seed = 7000 + 13 * jitterIndex++;
      bank.push({
        id: `jdrum-${bpm}-g${ghost}-j${j}`,
        family: 'jitter-drum',
        trueBpm: bpm,
        generate: () => jitterDrumLoop(bpm, secs, ghost, j, seed, sr),
      });
    }
  }

  bank.push(
    { id: 'atempo-pad', family: 'atempo', trueBpm: null, generate: () => pad(secs, sr) },
    { id: 'atempo-speech', family: 'atempo', trueBpm: null, generate: () => speechLike(secs, sr) },
    { id: 'atempo-noise', family: 'atempo', trueBpm: null, generate: () => noiseOnly(secs, sr) }
  );

  return bank;
}

export type DetectFn = (mono: Float32Array, sampleRate: number) => TempoAnalysis;

const realDetector: DetectFn = (mono, sampleRate) =>
  analyzeTempo(mono, sampleRate, { minBpm: MIN_BPM, maxBpm: MAX_BPM });

/**
 * Runs `detect` (default: the real `analyzeTempo` at the app's 60–200
 * defaults) over every fixture and tallies verdicts. Deterministic for a
 * deterministic detector; the report carries the bank's identity fields so
 * a result file is self-describing and two files diff cleanly.
 */
export function runBench(fixtures: BenchFixture[], detect: DetectFn = realDetector): BenchReport {
  const rows: BenchRow[] = [];
  const aggregate: BenchTally = { correct: 0, octave: 0, other: 0 };
  const perFamily: Record<string, BenchTally> = {};

  for (const f of fixtures) {
    const analysis = detect(f.generate(), BANK_SAMPLE_RATE);
    const verdict =
      f.trueBpm === null
        ? classifyAtempo(analysis.bpm, analysis.confidence)
        : classifyBpm(analysis.bpm, f.trueBpm);
    const row: BenchRow = {
      id: f.id,
      family: f.family,
      trueBpm: f.trueBpm,
      reportedBpm: analysis.bpm === null ? null : Number(analysis.bpm.toFixed(3)),
      confidence: Number(analysis.confidence.toFixed(4)),
      verdict,
      ratio:
        f.trueBpm !== null && analysis.bpm !== null
          ? Number((analysis.bpm / f.trueBpm).toFixed(4))
          : null,
    };
    rows.push(row);
    aggregate[verdict]++;
    const fam = (perFamily[f.family] ??= { correct: 0, octave: 0, other: 0 });
    fam[verdict]++;
  }

  return {
    bankVersion: BANK_VERSION,
    sampleRate: BANK_SAMPLE_RATE,
    seconds: BANK_SECONDS,
    tolerancePct: CORRECT_TOL_PCT,
    fixtureCount: fixtures.length,
    aggregate,
    perFamily,
    rows,
  };
}
