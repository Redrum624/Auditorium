import { envelopeFollower } from './envelope';
import { compressorEffect, reductionDb } from './CompressorEffect';
import { limiterEffect } from './LimiterEffect';
import { FADE_FLOOR_DB, GATE_SILENT_RUN_MS, noiseGateEffect } from './NoiseGateEffect';
import { getAllEffects } from '../EffectRegistry';
import { NOISE_WINDOW_MAX_SILENT_FRACTION } from '../../dsp/chainAnalysis';
import { registerAllEffects } from '../registerAll';
import type { EffectDefinition, EffectParamValue } from '../types';

const SR = 44100;

function snapshot(channels: Float32Array[]): number[][] {
  return channels.map((c) => Array.from(c));
}

function expectUnmutated(channels: Float32Array[], before: number[][]): void {
  channels.forEach((c, i) => expect(Array.from(c)).toEqual(before[i]));
}

function run(
  def: EffectDefinition,
  channels: Float32Array[],
  params: Record<string, EffectParamValue> = {}
): Float32Array[] {
  const before = snapshot(channels);
  const result = def.process(channels, SR, params);
  expectUnmutated(channels, before);
  return result.channels;
}

function sine(freq: number, seconds: number, amplitude = 1, sr = SR): Float32Array {
  const n = Math.round(seconds * sr);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amplitude * Math.sin((2 * Math.PI * freq * i) / sr);
  return out;
}

function rms(signal: Float32Array, start = 0, end = signal.length): number {
  let sum = 0;
  let count = 0;
  for (let i = start; i < end; i++) {
    sum += signal[i] * signal[i];
    count++;
  }
  return count > 0 ? Math.sqrt(sum / count) : 0;
}

function maxAbs(signal: Float32Array, start = 0, end = signal.length): number {
  let m = 0;
  for (let i = start; i < end; i++) m = Math.max(m, Math.abs(signal[i]));
  return m;
}

function dbToLin(db: number): number {
  return Math.pow(10, db / 20);
}

function dbGain(inSignal: Float32Array, outSignal: Float32Array, start: number, end: number): number {
  const inR = rms(inSignal, start, end);
  const outR = rms(outSignal, start, end);
  return 20 * Math.log10(outR / inR);
}

describe('envelopeFollower', () => {
  it('rises to ~63% of a step level within ~attackMs (+/-30%)', () => {
    const attackMs = 10;
    const releaseMs = 100;
    const attackSamples = Math.round((attackMs / 1000) * SR);
    // Long constant-1 signal so we can sample the rise in isolation.
    const input = new Float32Array(attackSamples * 20).fill(1);
    const env = envelopeFollower(input, SR, attackMs, releaseMs);
    const at = env[attackSamples - 1];
    expect(at).toBeGreaterThan(0.632 * 0.7);
    expect(at).toBeLessThan(0.632 * 1.3);
  });

  it('decays to ~36.8% of the held level within ~releaseMs after the step ends (+/-30%)', () => {
    const attackMs = 10;
    const releaseMs = 100;
    const attackSamples = Math.round((attackMs / 1000) * SR);
    const releaseSamples = Math.round((releaseMs / 1000) * SR);
    const rampUp = new Float32Array(attackSamples * 20).fill(1); // settle near 1
    const rampDown = new Float32Array(releaseSamples * 5); // zeros
    const input = new Float32Array(rampUp.length + rampDown.length);
    input.set(rampUp, 0);
    input.set(rampDown, rampUp.length);
    const env = envelopeFollower(input, SR, attackMs, releaseMs);
    const dropIndex = rampUp.length;
    const levelAtDrop = env[dropIndex - 1];
    const at = env[dropIndex + releaseSamples - 1];
    expect(at).toBeGreaterThan(levelAtDrop * 0.368 * 0.7);
    expect(at).toBeLessThan(levelAtDrop * 0.368 * 1.3);
  });

  it('env[-1] starts at 0: first sample of a constant signal moves only partway', () => {
    const input = new Float32Array(4).fill(1);
    const env = envelopeFollower(input, SR, 10, 100);
    expect(env[0]).toBeGreaterThan(0);
    expect(env[0]).toBeLessThan(1);
  });
});

// ---------------------------------------------------------------------------
// The soft knee is the SHIPPED default (kneeDb default = 6) and is what the
// Vocal Chain inherits, so its law is pinned here directly rather than only
// through the kneeDb: 0 early return the process-level tests below take.
// ---------------------------------------------------------------------------
describe('reductionDb — soft-knee law at ratio 4, knee 6dB (slope = 0.75)', () => {
  // Quadratic interpolation inside the knee: slope*(over + knee/2)^2 / (2*knee).
  // The knee spans over ∈ [-3, +3]; at both edges it must meet the neighbouring
  // branch exactly (0 below, over*slope above), and the /(2*knee) divisor is
  // what makes those two joins line up.
  it.each([
    [-4, 0], // below the knee entirely: 2*over < -knee
    [-3, 0], // lower knee edge: joins the "no reduction" branch
    [0, 0.5625], // knee centre: 0.75 * 3^2 / 12
    [3, 2.25], // upper knee edge: joins over*slope = 3*0.75
    [6, 4.5], // above the knee: linear over*slope
  ])('reductionDb(%f, 4, 6) === %f', (over, expected) => {
    expect(reductionDb(over, 4, 6)).toBeCloseTo(expected, 10);
  });

  it('starts reducing BELOW threshold and rises monotonically across the knee', () => {
    // The knee is centred on the threshold, so unlike a hard knee it is already
    // reducing at over = -1.5 (where a hard knee does nothing at all).
    expect(reductionDb(-1.5, 4, 6)).toBeGreaterThan(0);
    expect(reductionDb(-1.5, 4, 0)).toBe(0);
    const curve = [-3, -1.5, 0, 1.5, 3].map((o) => reductionDb(o, 4, 6));
    for (let i = 1; i < curve.length; i++) expect(curve[i]).toBeGreaterThan(curve[i - 1]);
  });

  it('kneeDb <= 0 takes the hard-knee branch', () => {
    expect(reductionDb(4, 4, 0)).toBeCloseTo(3, 10);
    expect(reductionDb(-4, 4, 0)).toBe(0);
  });
});

describe('compressorEffect', () => {
  it('registers as compressor in category Dynamics', () => {
    expect(compressorEffect.id).toBe('compressor');
    expect(compressorEffect.category).toBe('Dynamics');
  });

  it('14dB over threshold at ratio 4 (knee 0) reduces RMS by ~10.5dB (+/-1.5dB)', () => {
    // -6dBFS sine, threshold -20dB -> 14dB over. reduction = 14*(1-1/4) = 10.5dB.
    const amp = dbToLin(-6);
    const input = sine(1000, 0.5, amp);
    const params = {
      thresholdDb: -20,
      ratio: 4,
      attackMs: 5,
      releaseMs: 20,
      kneeDb: 0,
      makeupDb: 0,
    };
    const out = run(compressorEffect, [input], params);
    const skip = 5000; // let the envelope settle past attack/release
    const gain = dbGain(input, out[0], skip, input.length);
    expect(gain).toBeGreaterThan(-12);
    expect(gain).toBeLessThan(-9);
  });

  it('a signal well under threshold is left ~untouched (+/-0.5dB)', () => {
    const amp = dbToLin(-40);
    const input = sine(1000, 0.5, amp);
    const params = {
      thresholdDb: -20,
      ratio: 4,
      attackMs: 5,
      releaseMs: 20,
      kneeDb: 0,
      makeupDb: 0,
    };
    const out = run(compressorEffect, [input], params);
    const gain = dbGain(input, out[0], 5000, input.length);
    expect(Math.abs(gain)).toBeLessThan(0.5);
  });

  it('makeup +6dB raises an untouched (quiet) signal by ~6dB', () => {
    const amp = dbToLin(-40);
    const input = sine(1000, 0.5, amp);
    const params = {
      thresholdDb: -20,
      ratio: 4,
      attackMs: 5,
      releaseMs: 20,
      kneeDb: 0,
      makeupDb: 6,
    };
    const out = run(compressorEffect, [input], params);
    const gain = dbGain(input, out[0], 5000, input.length);
    expect(gain).toBeCloseTo(6, 1);
  });

  it('sidechain uses max(|L|,|R|): a loud L channel drags down a quiet R channel by the same gain', () => {
    const loud = sine(1000, 0.5, dbToLin(-6)); // 14dB over threshold
    const quiet = sine(1000, 0.5, dbToLin(-40)); // alone would be untouched
    const params = {
      thresholdDb: -20,
      ratio: 4,
      attackMs: 5,
      releaseMs: 20,
      kneeDb: 0,
      makeupDb: 0,
    };
    const out = run(compressorEffect, [loud, quiet], params);
    const skip = 5000;
    const gainR = dbGain(quiet, out[1], skip, quiet.length);
    // R alone is 34dB under threshold and would normally be untouched, but the
    // shared (max) sidechain detector should apply L's ~10.5dB reduction to it too.
    expect(gainR).toBeGreaterThan(-12);
    expect(gainR).toBeLessThan(-9);
  });

  it('the DEFAULT knee (6dB) is the soft one: a signal exactly at threshold is reduced by ~0.5625dB, where knee 0 leaves it alone', () => {
    // Constant 0.1 = -20dBFS, so the settled envelope sits exactly on the
    // -20dB threshold (overDb = 0) — the middle of the 6dB knee. Hard knee:
    // no reduction at all. Soft knee: 0.75 * (0 + 3)^2 / (2*6) = 0.5625dB.
    const input = new Float32Array(Math.round(0.5 * SR)).fill(0.1);
    const common = { thresholdDb: -20, ratio: 4, attackMs: 5, releaseMs: 20, makeupDb: 0 };
    const skip = 5000;

    const softOut = run(compressorEffect, [input], common); // kneeDb omitted -> default 6
    const softGain = dbGain(input, softOut[0], skip, input.length);
    expect(softGain).toBeCloseTo(-0.5625, 2);

    const hardOut = run(compressorEffect, [input], { ...common, kneeDb: 0 });
    const hardGain = dbGain(input, hardOut[0], skip, input.length);
    expect(hardGain).toBeCloseTo(0, 3);
  });
});

describe('limiterEffect', () => {
  it('registers as limiter in category Dynamics', () => {
    expect(limiterEffect.id).toBe('limiter');
    expect(limiterEffect.category).toBe('Dynamics');
  });

  it('0dBFS sine with ceiling -6dB sits near the ceiling without exceeding it', () => {
    const input = sine(1000, 0.3, 1);
    const params = { ceilingDb: -6, releaseMs: 50 };
    const out = run(limiterEffect, [input], params);
    const ceilLin = dbToLin(-6);
    const peak = maxAbs(out[0]);
    expect(peak).toBeLessThanOrEqual(ceilLin + 1e-4);
    expect(peak).toBeGreaterThanOrEqual(ceilLin * 0.9);
  });

  it('never exceeds the ceiling even immediately at a sharp onset', () => {
    const input = new Float32Array(2000).fill(1); // instant full-scale step
    const params = { ceilingDb: -3, releaseMs: 50 };
    const out = run(limiterEffect, [input], params);
    const ceilLin = dbToLin(-3);
    expect(maxAbs(out[0])).toBeLessThanOrEqual(ceilLin + 1e-4);
  });

  it('a quiet signal well under the ceiling passes through ~unchanged', () => {
    const input = sine(1000, 0.3, dbToLin(-20));
    const params = { ceilingDb: -6, releaseMs: 50 };
    const out = run(limiterEffect, [input], params);
    const gain = dbGain(input, out[0], 1000, input.length);
    expect(Math.abs(gain)).toBeLessThan(1);
  });

  it('silence in produces silence out (no NaN/Infinity)', () => {
    const input = new Float32Array(1000);
    const out = run(limiterEffect, [input], { ceilingDb: -6, releaseMs: 50 });
    out[0].forEach((v) => {
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeCloseTo(0, 6);
    });
  });

  it('forward-looking alignment: no zero pre-roll head, no dropped tail, length preserved', () => {
    const input = sine(1000, 0.3, 1); // full-scale; ~2.2 cycles per 100 samples @44.1k
    const out = run(limiterEffect, [input], { ceilingDb: -6, releaseMs: 50 });
    const ceilLin = dbToLin(-6);
    expect(out[0].length).toBe(input.length);
    // FIRST 100 samples must already sit near the ceiling — the delayed-output
    // design emitted a 5ms (221-sample) zero pre-roll from the delay-line fill.
    const headPeak = maxAbs(out[0], 0, 100);
    expect(headPeak).toBeGreaterThanOrEqual(ceilLin * 0.9);
    expect(headPeak).toBeLessThanOrEqual(ceilLin + 1e-4);
    // LAST 100 samples near the ceiling too (no dropped tail; release-edge tolerance).
    const tailPeak = maxAbs(out[0], out[0].length - 100, out[0].length);
    expect(tailPeak).toBeGreaterThanOrEqual(ceilLin * 0.85);
    expect(tailPeak).toBeLessThanOrEqual(ceilLin + 1e-4);
  });

  it('preserves content in the final lookahead window (burst in the last 50 samples)', () => {
    const n = 2000;
    const input = new Float32Array(n);
    for (let i = n - 50; i < n; i++) input[i] = 1; // full-scale burst at the very end
    const out = run(limiterEffect, [input], { ceilingDb: -6, releaseMs: 50 });
    const ceilLin = dbToLin(-6);
    // The delayed-output design never emitted the last L input samples — this
    // burst vanished entirely. It must appear in place, limited to the ceiling.
    const burstPeak = maxAbs(out[0], n - 50, n);
    expect(burstPeak).toBeGreaterThanOrEqual(ceilLin * 0.9);
    expect(maxAbs(out[0])).toBeLessThanOrEqual(ceilLin + 1e-4);
  });

  it('keeps a quiet signal sample-aligned (no lookahead time shift)', () => {
    const input = sine(1000, 0.1, dbToLin(-20)); // far below ceiling -> gain stays 1
    const out = run(limiterEffect, [input], { ceilingDb: -6, releaseMs: 50 });
    for (let i = 0; i < input.length; i += 7) {
      expect(out[0][i]).toBeCloseTo(input[i], 5);
    }
  });
});

describe('noiseGateEffect', () => {
  it('registers as noise-gate in category Dynamics', () => {
    expect(noiseGateEffect.id).toBe('noise-gate');
    expect(noiseGateEffect.category).toBe('Dynamics');
  });

  it('loud block passes ~unchanged RMS; silent block is fully closed after hold+release (<1e-3)', () => {
    const loud = sine(1000, 0.3, dbToLin(-10)); // above -50dB default threshold
    const silent = new Float32Array(Math.round(0.5 * SR)); // zeros
    const input = new Float32Array(loud.length + silent.length);
    input.set(loud, 0);
    input.set(silent, loud.length);

    const params = { thresholdDb: -50, attackMs: 1, releaseMs: 150, holdMs: 50 };
    const out = run(noiseGateEffect, [input], params);

    // Loud block: skip a short attack transient, RMS should match input closely.
    const loudGain = dbGain(input, out[0], 500, loud.length);
    expect(Math.abs(loudGain)).toBeLessThan(1); // within ~10% in linear terms is < 1dB

    // Silent block tail: well past hold (50ms) + release (150ms) = 200ms.
    const tailStart = loud.length + Math.round(0.3 * SR);
    const tailPeak = maxAbs(out[0], tailStart, input.length);
    expect(tailPeak).toBeLessThan(1e-3);
  });

  it('holds the gate open through a gap shorter than holdMs', () => {
    const loud = sine(1000, 0.2, dbToLin(-10));
    const gapMs = 20; // shorter than holdMs (50 default)
    const gap = sine(1000, gapMs / 1000, dbToLin(-60)); // below threshold, but brief
    const input = new Float32Array(loud.length + gap.length);
    input.set(loud, 0);
    input.set(gap, loud.length);

    const params = { thresholdDb: -50, attackMs: 1, releaseMs: 150, holdMs: 50 };
    const out = run(noiseGateEffect, [input], params);

    // During the held-open gap, gain should still be ~1: gap output RMS should
    // match the gap input RMS (not attenuated toward the release floor yet).
    const gapGain = dbGain(gap, out[0].subarray(loud.length), 0, gap.length);
    expect(Math.abs(gapGain)).toBeLessThan(1);
  });

  it('does not mutate input and produces only finite samples', () => {
    const input = sine(1000, 0.1, dbToLin(-10));
    const out = run(noiseGateEffect, [input], {});
    out[0].forEach((v) => expect(Number.isFinite(v)).toBe(true));
  });

  // The Vocal Chain's automatic gate decides WHERE to mute (regions between
  // vocal activity) and hands the decision to this effect through the same
  // `__effectExtra` side channel Noise Reduction's print uses. The effect's
  // job in that mode is application only: the named regions become digital
  // silence behind the same linear-in-dB edge fade the threshold machine
  // closes with, and every other sample comes back bit-identical. Without the
  // side channel nothing here runs — the threshold state machine is untouched,
  // which is what keeps the manual path byte-for-byte what it was.
  describe('the mute-region side channel (the Vocal Chain’s automatic gate)', () => {
    const setRegions = (muteRegions: { start: number; end: number }[]): void => {
      (globalThis as { __effectExtra?: unknown }).__effectExtra = { muteRegions };
    };
    afterEach(() => {
      delete (globalThis as { __effectExtra?: unknown }).__effectExtra;
    });

    const RELEASE_MS = 20;
    const releaseSamples = Math.round((RELEASE_MS / 1000) * SR);

    function takeWithRegion(): { input: Float32Array; region: { start: number; end: number } } {
      const input = sine(220, 1.0, dbToLin(-10));
      // A -0 outside the region, so bit-identity is asserted at its hardest.
      input[100] = -0;
      return { input, region: { start: Math.round(0.3 * SR), end: Math.round(0.7 * SR) } };
    }

    it('fades linear-in-dB over releaseMs, holds hard zero to the region end, and reopens instantly', () => {
      const { input, region } = takeWithRegion();
      setRegions([region]);
      const out = run(noiseGateEffect, [input], { releaseMs: RELEASE_MS });

      // Before the region: every sample bit-identical, -0 included.
      for (let i = 0; i < region.start; i++) {
        if (!Object.is(out[0][i], input[i])) throw new Error(`sample ${i} changed before the region`);
      }
      // The fade: the state machine's own arithmetic, sample for sample —
      // through Math.fround, because the store into a Float32Array rounds.
      for (let k = 0; k < releaseSamples; k++) {
        const gain = Math.pow(10, (FADE_FLOOR_DB * ((k + 1) / releaseSamples)) / 20);
        expect(out[0][region.start + k]).toBe(Math.fround(input[region.start + k] * gain));
      }
      // Hard zero from the fade's end to the region's end.
      for (let i = region.start + releaseSamples; i < region.end; i++) {
        if (out[0][i] !== 0) throw new Error(`sample ${i} not silenced inside the region`);
      }
      // Instant reopen: the very first sample past the region is bit-identical.
      for (let i = region.end; i < input.length; i++) {
        if (!Object.is(out[0][i], input[i])) throw new Error(`sample ${i} changed after the region`);
      }
    });

    it('applies the same gain to every channel, and zeros inside a region stay zeros', () => {
      const L = sine(220, 0.6, dbToLin(-10));
      const R = sine(330, 0.6, dbToLin(-14));
      // A stretch of digital silence inside the region: silence in, silence out.
      const zeroFrom = Math.round(0.3 * SR);
      const zeroTo = Math.round(0.4 * SR);
      for (let i = zeroFrom; i < zeroTo; i++) {
        L[i] = 0;
        R[i] = -0;
      }
      const region = { start: Math.round(0.2 * SR), end: Math.round(0.5 * SR) };
      setRegions([region]);
      const out = run(noiseGateEffect, [L, R], { releaseMs: RELEASE_MS });
      for (let i = zeroFrom; i < zeroTo; i++) {
        expect(out[0][i] === 0).toBe(true);
        expect(out[1][i] === 0).toBe(true);
      }
      for (let i = region.start + releaseSamples; i < region.end; i++) {
        expect(out[0][i] === 0).toBe(true);
        expect(out[1][i] === 0).toBe(true);
      }
    });

    it('never consults the threshold: audio below threshold outside a region is untouched', () => {
      // The whole take sits far under the default -50 dB threshold, so the
      // state machine would mute all of it. In region mode only the named
      // region goes — WHERE, not how loud.
      const input = sine(220, 1.0, dbToLin(-70));
      const region = { start: Math.round(0.4 * SR), end: Math.round(0.6 * SR) };
      setRegions([region]);
      const out = run(noiseGateEffect, [input], { thresholdDb: -50, releaseMs: RELEASE_MS });
      for (let i = 0; i < region.start; i++) {
        if (!Object.is(out[0][i], input[i])) throw new Error(`sample ${i} changed before the region`);
      }
      for (let i = region.start + releaseSamples; i < region.end; i++) {
        if (out[0][i] !== 0) throw new Error(`sample ${i} not silenced`);
      }
    });

    it('clamps regions to the buffer, drops empty ones, and merges overlaps instead of re-fading over zeros', () => {
      const input = sine(220, 0.5, dbToLin(-10));
      const a = { start: Math.round(0.1 * SR), end: Math.round(0.3 * SR) };
      // b starts inside a: a merge must keep a's zeros rather than fading b
      // from the SOURCE samples again, which would un-zero a's tail.
      const b = { start: Math.round(0.2 * SR), end: Math.round(0.4 * SR) };
      setRegions([b, a, { start: -50, end: 10 }, { start: 300, end: 300 }, { start: input.length - 5, end: input.length + 99 }]);
      const out = run(noiseGateEffect, [input], { releaseMs: RELEASE_MS });
      // Inside the merged [a.start, b.end): one fade at a.start, zeros after.
      for (let i = a.start + releaseSamples; i < b.end; i++) {
        if (out[0][i] !== 0) throw new Error(`sample ${i} not silenced in merged region`);
      }
      // The clamped head region [0, 10) and tail region behave.
      for (let i = 0; i < 10; i++) expect(Math.abs(out[0][i])).toBeLessThanOrEqual(Math.abs(input[i]));
      for (let i = input.length - 5; i < input.length; i++) {
        expect(Math.abs(out[0][i])).toBeLessThanOrEqual(Math.abs(input[i]));
      }
      // Between the merged region and the tail: untouched.
      for (let i = b.end; i < input.length - 5; i++) {
        if (!Object.is(out[0][i], input[i])) throw new Error(`sample ${i} changed outside regions`);
      }
    });

    it('a side channel that carries no muteRegions leaves the threshold machine in charge', () => {
      // Defensive specificity: another effect's payload shape (Noise
      // Reduction's spectra) must not switch this effect into region mode.
      (globalThis as { __effectExtra?: unknown }).__effectExtra = { spectra: [[0, 0, 0]] };
      const loud = sine(1000, 0.3, dbToLin(-10));
      const silent = new Float32Array(Math.round(0.5 * SR));
      const input = new Float32Array(loud.length + silent.length);
      input.set(loud, 0);
      const params = { thresholdDb: -50, attackMs: 1, releaseMs: 150, holdMs: 50 };
      const out = run(noiseGateEffect, [input], params);
      const tailStart = loud.length + Math.round(0.3 * SR);
      expect(maxAbs(out[0], tailStart, input.length)).toBeLessThan(1e-3);
      const loudGain = dbGain(input, out[0], 500, loud.length);
      expect(Math.abs(loudGain)).toBeLessThan(1);
    });
  });

  // N6 — quiet material bracketed by digital silence. A run of exact zeros is
  // already silent: the gate removes nothing across it, so it spends the run
  // OPEN and what comes out of the run gets the same hold a phrase's tail gets.
  // See `GATE_SILENT_RUN_MS` for both measured sides of the run bound.
  describe('a run of digital silence', () => {
    const THRESHOLD_DB = -42;

    /** Gaussian noise at a stated dBFS RMS — a floor, or a quiet island. */
    function floorDb(n: number, rmsDb: number, seed: number): Float32Array {
      let s = seed >>> 0;
      const next = (): number => {
        s = (s * 1664525 + 1013904223) >>> 0;
        return (s / 0xffffffff) * 2 - 1;
      };
      const out = new Float32Array(n);
      const k = Math.pow(10, rmsDb / 20) / Math.sqrt(4 / 3);
      for (let i = 0; i < n; i++) out[i] = (next() + next() + next() + next()) * k;
      return out;
    }

    function cat(parts: Float32Array[]): Float32Array {
      const out = new Float32Array(parts.reduce((a, p) => a + p.length, 0));
      let at = 0;
      for (const p of parts) {
        out.set(p, at);
        at += p.length;
      }
      return out;
    }

    /** How much of a span's energy the gate removed, as a percentage. */
    function removedPct(input: Float32Array, out: Float32Array, from: number, to: number): number {
      let a = 0;
      let b = 0;
      for (let i = from; i < to; i++) {
        a += input[i] * input[i];
        b += out[i] * out[i];
      }
      return (1 - b / a) * 100;
    }

    const gate = (input: Float32Array): Float32Array =>
      run(noiseGateEffect, [input], {
        thresholdDb: THRESHOLD_DB,
        attackMs: 1,
        releaseMs: 20,
        holdMs: 500,
      })[0];

    it('lets a quiet island bracketed by zeros through, where the same island beside a floor is muted', () => {
      const zeros = new Float32Array(Math.round(0.3 * SR));
      const island = floorDb(Math.round(0.2 * SR), -60, 41);
      const loud = sine(220, 0.5, 0.25);

      // Bracketed: nothing before the island but exact zeros, and the gate has
      // removed nothing across them, so it has no business closing on it.
      const bracketed = cat([zeros, island, loud, new Float32Array(zeros.length)]);
      const outBracketed = gate(bracketed);
      expect(removedPct(bracketed, outBracketed, zeros.length, zeros.length + island.length)).toBeLessThan(0.1);

      // The converse, same island, same level: reached across REAL material
      // that the gate legitimately closed on, it is still muted. The zeros are
      // what changes the verdict, not the island.
      const head = floorDb(Math.round(3.0 * SR), -60, 7);
      const beside = cat([loud, head, island, loud, new Float32Array(zeros.length)]);
      const outBeside = gate(beside);
      const at = loud.length + head.length;
      expect(removedPct(beside, outBeside, at, at + island.length)).toBeGreaterThan(99);
    });

    it('takes a run at the bound and refuses one a sample under it — behaviour, both sides', () => {
      const bound = Math.round((GATE_SILENT_RUN_MS / 1000) * SR);
      const island = floorDb(Math.round(0.2 * SR), -60, 41);
      const loud = sine(220, 0.5, 0.25);
      for (const [runSamples, expectPassed] of [
        [bound, true],
        [bound - 1, false],
      ] as const) {
        // The zeros are reached across real material the gate closes on, so the
        // ONLY thing that can hold it open at the island is the zero run itself.
        const head = floorDb(Math.round(3.0 * SR), -60, 7);
        const input = cat([loud, head, new Float32Array(runSamples), island, loud]);
        const at = loud.length + head.length + runSamples;
        const removed = removedPct(input, gate(input), at, at + island.length);
        if (expectPassed) expect(removed).toBeLessThan(0.1);
        else expect(removed).toBeGreaterThan(99);
      }
    });

    it('is not fooled by the scattered zeros an undithered floor really carries', () => {
      // 16-bit quantisation of a quiet Gaussian floor: a fifth of its samples
      // are EXACT zeros, in runs of a handful of samples. A gate that treated
      // any zero as an edit would never close on a real recording again.
      const step = Math.pow(2, -15);
      const raw = floorDb(Math.round(3.0 * SR), -84, 7);
      const quantised = new Float32Array(raw.length);
      let zeros = 0;
      let longestRun = 0;
      let currentRun = 0;
      for (let i = 0; i < raw.length; i++) {
        quantised[i] = Math.round(raw[i] / step) * step;
        if (quantised[i] === 0) {
          zeros++;
          currentRun++;
          if (currentRun > longestRun) longestRun = currentRun;
        } else currentRun = 0;
      }
      // The precondition: this really is the scattered-zeros class, and its
      // longest run is far under the bound.
      expect(zeros / quantised.length).toBeGreaterThan(0.15);
      expect(longestRun).toBeLessThan(Math.round((GATE_SILENT_RUN_MS / 1000) * SR));

      const loud = sine(220, 0.5, 0.25);
      const input = cat([loud, quantised]);
      const out = gate(input);
      // Past the hold and the fade, the floor is gone — the gate still closes.
      const tail = loud.length + Math.round(1.0 * SR);
      expect(maxAbs(out, tail, out.length)).toBeLessThan(1e-6);
    });

    it('holds for one hold and then closes — a zero run buys a hold, not an exemption', () => {
      const zeros = new Float32Array(Math.round(0.3 * SR));
      const quiet = floorDb(Math.round(3.0 * SR), -60, 7);
      const input = cat([zeros, quiet]);
      const out = gate(input);
      // The first half-second out of the silence passes at full level...
      expect(Math.abs(dbGain(input, out, zeros.length, zeros.length + Math.round(0.4 * SR)))).toBeLessThan(0.5);
      // ...and past hold + release the gate is shut again.
      const closed = zeros.length + Math.round(0.7 * SR);
      expect(maxAbs(out, closed, out.length)).toBeLessThan(1e-6);
    });

    it('lets a floor blip inside the silence through too — the cost of the rule, stated', () => {
      // The gate cannot tell a whispered pickup from a stray noise blip: both
      // are quiet material bracketed by zeros. The direction is deliberate —
      // the material was put between zeros by whoever edited the file, and
      // passing a blip costs a tick where muting a pickup costs a word.
      const zeros = new Float32Array(Math.round(0.3 * SR));
      const blip = floorDb(Math.round(0.05 * SR), -60, 3);
      const input = cat([zeros, blip, zeros]);
      const out = gate(input);
      expect(removedPct(input, out, zeros.length, zeros.length + blip.length)).toBeLessThan(0.1);
    });

    it('needs EVERY channel silent — one silent side of a stereo pair is not a pause', () => {
      // The same product-versus-sum care the noise search takes: a frame is
      // digital silence only when nothing is playing anywhere. A left channel
      // faded to zeros while the right still carries floor is a pan, not an
      // edit, and the gate goes on closing on it.
      const zeros = new Float32Array(Math.round(0.3 * SR));
      const island = floorDb(Math.round(0.2 * SR), -60, 41);
      const loud = sine(220, 0.5, 0.25);
      const head = floorDb(Math.round(3.0 * SR), -60, 7);
      const L = cat([loud, head, zeros, island, loud]);
      const at = loud.length + head.length + zeros.length;

      // Right channel silent too: the run is real and the island passes.
      const bothSilent = run(noiseGateEffect, [Float32Array.from(L), Float32Array.from(L)], {
        thresholdDb: THRESHOLD_DB,
        attackMs: 1,
        releaseMs: 20,
        holdMs: 500,
      })[0];
      expect(removedPct(L, bothSilent, at, at + island.length)).toBeLessThan(0.1);

      // Right channel still playing floor across the same span: no run, and
      // the island is gated exactly as an unbracketed one is.
      const R = Float32Array.from(L);
      R.set(floorDb(zeros.length, -60, 13), loud.length + head.length);
      const oneSilent = run(noiseGateEffect, [Float32Array.from(L), R], {
        thresholdDb: THRESHOLD_DB,
        attackMs: 1,
        releaseMs: 20,
        holdMs: 500,
      })[0];
      expect(removedPct(L, oneSilent, at, at + island.length)).toBeGreaterThan(99);
    });

    it('leaves digital silence digitally silent, held open or not', () => {
      const zeros = new Float32Array(Math.round(0.6 * SR));
      const loud = sine(220, 0.3, 0.25);
      const input = cat([loud, zeros, loud]);
      const out = gate(input);
      for (let i = loud.length; i < loud.length + zeros.length; i++) expect(out[i]).toBe(0);
    });
  });
});

// The population the LOWER side of `GATE_SILENT_RUN_MS` is derived from: the
// exact zeros an undithered converter scatters through a real noise floor. The
// gate must never read one of those runs as an edit, or it would stop closing
// on real recordings — so the constant has to clear the longest run this class
// produces, and the figures behind that claim live here rather than only in the
// comment.
describe('GATE_SILENT_RUN_MS', () => {
  /** A quantised floor, and the two statistics that decide the bound. */
  function quantisedFloor(
    n: number,
    rmsDb: number,
    seed: number,
    bits: number,
    sr: number,
    tilted: boolean,
  ): { zeroFraction: number; longestRun: number; rmsDb: number } {
    let s = seed >>> 0;
    const next = (): number => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return (s / 0xffffffff) * 2 - 1;
    };
    const raw = new Float32Array(n);
    const k = Math.pow(10, rmsDb / 20) / Math.sqrt(4 / 3);
    for (let i = 0; i < n; i++) raw[i] = (next() + next() + next() + next()) * k;
    if (tilted) {
      // One pole at 400 Hz. A tilted floor is the hard case: neighbouring
      // samples are correlated, so its zeros CLUSTER instead of scattering.
      const a = Math.exp((-2 * Math.PI * 400) / sr);
      let y = 0;
      let sum = 0;
      for (let i = 0; i < n; i++) {
        y = (1 - a) * raw[i] + a * y;
        raw[i] = y;
        sum += y * y;
      }
      const g = Math.pow(10, rmsDb / 20) / Math.sqrt(sum / n);
      for (let i = 0; i < n; i++) raw[i] *= g;
    }
    const step = Math.pow(2, -(bits - 1));
    let zeros = 0;
    let run = 0;
    let longestRun = 0;
    let sumSq = 0;
    for (let i = 0; i < n; i++) {
      const q = Math.round(raw[i] / step) * step;
      sumSq += q * q;
      if (q === 0) {
        zeros++;
        run++;
        if (run > longestRun) longestRun = run;
      } else run = 0;
    }
    return {
      zeroFraction: zeros / n,
      longestRun,
      rmsDb: 20 * Math.log10(Math.max(Math.sqrt(sumSq / n), 1e-12)),
    };
  }

  it('clears the longest run of exact zeros a real quantised floor produces', () => {
    let worstRunMs = 0;
    let worstMeasurableRunMs = 0;
    let worstMostlyRealRunMs = 0;
    let worstRunMemberDb = 0;
    let worstRunMemberZeros = 0;
    let heaviestZeroFraction = 0;
    let members = 0;
    for (const sr of [8000, 44100]) {
      const bound = (GATE_SILENT_RUN_MS / 1000) * sr;
      for (const tilted of [false, true]) {
        for (const bits of [16, 12, 10, 8]) {
          for (const rmsDb of [-30, -40, -50, -60, -66, -72, -78, -84, -90]) {
            for (const seed of [7, 23]) {
              const { zeroFraction, longestRun, rmsDb: quantisedDb } = quantisedFloor(
                Math.round(3 * sr),
                rmsDb,
                seed,
                bits,
                sr,
                tilted,
              );
              // A floor that quantises away entirely IS digital silence, not a
              // floor: holding the gate open across it removes nothing.
              if (zeroFraction >= 0.999) continue;
              members++;
              heaviestZeroFraction = Math.max(heaviestZeroFraction, zeroFraction);
              const ms = (longestRun / sr) * 1000;
              if (ms > worstRunMs) {
                worstRunMs = ms;
                worstRunMemberDb = quantisedDb;
                worstRunMemberZeros = zeroFraction;
              }
              // The floors the noise search will still accept as a measurement
              // — the ones a derived threshold is actually built on.
              if (zeroFraction <= NOISE_WINDOW_MAX_SILENT_FRACTION) worstMeasurableRunMs = Math.max(worstMeasurableRunMs, ms);
              // ...and the wider class that is still more sound than silence.
              if (zeroFraction <= 0.75) worstMostlyRealRunMs = Math.max(worstMostlyRealRunMs, ms);
              expect(longestRun).toBeLessThan(bound);
            }
          }
        }
      }
    }

    // The class is real: this population genuinely reaches the zero fractions
    // the noise search's own bound is drawn against.
    expect(members).toBeGreaterThan(180);
    expect(heaviestZeroFraction).toBeGreaterThan(0.9);

    // Absolute windows, so a drift in the population fails here rather than
    // silently eating the margin. Measured over the wider sweep (4 rates x 3
    // distributions x 4 depths x 14 levels x 3 seeds): 1.00 ms among the floors
    // this app will still measure a threshold from, 5.38 ms up to
    // three-quarters zeros, 29.63 ms worst of all.
    expect(worstMeasurableRunMs).toBeLessThan(1.5);
    expect(worstMostlyRealRunMs).toBeLessThan(6);
    expect(worstRunMs).toBeGreaterThan(10);
    expect(worstRunMs).toBeLessThan(35);

    // What the narrowest margin is actually against, measured rather than
    // assumed: the member whose run comes nearest the bound is nine-tenths
    // exact zeros and sits near -80 dBFS — a converter's floor quantising away
    // under its own LSB, not a floor anything is gated against.
    expect(worstRunMemberZeros).toBeGreaterThan(0.9);
    expect(worstRunMemberDb).toBeLessThan(-70);

    // And the constant clears them, with the stated margins.
    expect(GATE_SILENT_RUN_MS).toBeGreaterThan(30 * worstMeasurableRunMs);
    expect(GATE_SILENT_RUN_MS).toBeGreaterThan(8 * worstMostlyRealRunMs);
    expect(GATE_SILENT_RUN_MS).toBeGreaterThan(worstRunMs);
    expect(GATE_SILENT_RUN_MS).toBe(50);
  }, 120000);
});

describe('dynamics effects registration', () => {
  it('registerAllEffects makes compressor, limiter, noise-gate and de-esser discoverable in category Dynamics', () => {
    registerAllEffects();
    const all = getAllEffects();
    const dynamicsIds = all.filter((e) => e.category === 'Dynamics').map((e) => e.id);
    expect(dynamicsIds).toEqual(expect.arrayContaining(['compressor', 'limiter', 'noise-gate', 'de-esser']));
  });
});
