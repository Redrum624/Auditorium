import { amplifyEffect } from './AmplifyEffect';
import { normalizeEffect } from './NormalizeEffect';
import { fadeEffect } from './FadeEffect';
import { reverseEffect } from './ReverseEffect';
import { invertEffect } from './InvertEffect';
import { dcRemoveEffect } from './DcRemoveEffect';
import type { EffectDefinition } from '../types';

const SR = 44100;

/** Snapshot every input channel so we can assert the effect never mutated them. */
function snapshot(channels: Float32Array[]): number[][] {
  return channels.map((c) => Array.from(c));
}

function expectUnmutated(channels: Float32Array[], before: number[][]): void {
  channels.forEach((c, i) => {
    expect(Array.from(c)).toEqual(before[i]);
  });
}

function run(
  def: EffectDefinition,
  channels: Float32Array[],
  params: Record<string, number | string | boolean> = {}
): Float32Array[] {
  const before = snapshot(channels);
  const result = def.process(channels, SR, params);
  expectUnmutated(channels, before);
  return result.channels;
}

function maxAbs(channels: Float32Array[]): number {
  let m = 0;
  for (const c of channels) for (const v of c) m = Math.max(m, Math.abs(v));
  return m;
}

function mean(c: Float32Array): number {
  let s = 0;
  for (const v of c) s += v;
  return s / c.length;
}

describe('AmplifyEffect', () => {
  it('scales by 10^(gainDb/20) (+6 dB)', () => {
    const factor = Math.pow(10, 6 / 20);
    const input = [Float32Array.from([0.1, 0.2, 0.3, -0.4])];
    const out = run(amplifyEffect, input, { gainDb: 6 });
    out[0].forEach((v, i) => expect(v).toBeCloseTo(input[0][i] * factor, 4));
  });

  it('is identity at 0 dB', () => {
    const input = [Float32Array.from([0.5, -0.25])];
    const out = run(amplifyEffect, input, { gainDb: 0 });
    expect(Array.from(out[0])).toEqual([0.5, -0.25]);
  });
});

describe('NormalizeEffect', () => {
  it('peak mode brings the global max to the target dB', () => {
    const target = Math.pow(10, -0.3 / 20);
    const input = [Float32Array.from([0.25, -0.5, 0.1]), Float32Array.from([0.2, 0.3, -0.4])];
    const out = run(normalizeEffect, input, { targetDb: -0.3, mode: 'peak' });
    expect(maxAbs(out)).toBeCloseTo(target, 4);
  });

  it('peak mode measures ACROSS channels: stereo balance survives, only the loudest channel reaches the target', () => {
    // L peaks at 0.5, R at 0.4 — a 0.8 balance the effect must not touch. One
    // global scale factor preserves it; measuring per channel would drive BOTH
    // to the target and silently re-centre the image.
    const target = Math.pow(10, -0.3 / 20);
    const input = [Float32Array.from([0.25, -0.5, 0.1]), Float32Array.from([0.2, 0.3, -0.4])];
    const out = run(normalizeEffect, input, { targetDb: -0.3, mode: 'peak' });

    const peakL = maxAbs([out[0]]);
    const peakR = maxAbs([out[1]]);
    expect(peakL).toBeCloseTo(target, 5); // the loud channel defines the scale
    expect(peakR).toBeCloseTo(target * 0.8, 5); // the quiet one stays 0.8 of it
    expect(peakR / peakL).toBeCloseTo(0.4 / 0.5, 5);
  });

  it('rms mode measures ACROSS channels too: a quiet channel is not pumped up to match a loud one', () => {
    const loud = Float32Array.from([0.5, -0.5, 0.5, -0.5]);
    const quiet = Float32Array.from([0.05, -0.05, 0.05, -0.05]);
    const out = run(normalizeEffect, [loud, quiet], { targetDb: -20, mode: 'rms' });
    // One global RMS scale keeps the 10:1 level relationship intact.
    expect(maxAbs([out[1]]) / maxAbs([out[0]])).toBeCloseTo(0.1, 5);
  });

  it('leaves an all-zero (silent) input unchanged', () => {
    const input = [new Float32Array(8)];
    const out = run(normalizeEffect, input, { targetDb: -0.3, mode: 'peak' });
    expect(maxAbs(out)).toBe(0);
  });

  it('rms mode hard-clamps to +/-1', () => {
    const input = [Float32Array.from([0.02, -0.02, 0.02, -0.02])];
    const out = run(normalizeEffect, input, { targetDb: -0.3, mode: 'rms' });
    expect(maxAbs(out)).toBeLessThanOrEqual(1 + 1e-6);
  });
});

describe('FadeEffect', () => {
  it('linear fade-in: 0 at start, ~half at midpoint, ~original at end', () => {
    const input = [Float32Array.from([1, 1, 1, 1, 1])];
    const out = run(fadeEffect, input, { direction: 'in', curve: 'linear' });
    expect(out[0][0]).toBeCloseTo(0, 6);
    expect(out[0][2]).toBeCloseTo(0.5, 6);
    expect(out[0][4]).toBeCloseTo(1, 6);
  });

  it('linear fade-out: original at start, ~half at midpoint, 0 at end', () => {
    const input = [Float32Array.from([1, 1, 1, 1, 1])];
    const out = run(fadeEffect, input, { direction: 'out', curve: 'linear' });
    expect(out[0][0]).toBeCloseTo(1, 6);
    expect(out[0][2]).toBeCloseTo(0.5, 6);
    expect(out[0][4]).toBeCloseTo(0, 6);
  });

  it('cosine fade-in is 0.5 at the midpoint', () => {
    const input = [Float32Array.from([1, 1, 1, 1, 1])];
    const out = run(fadeEffect, input, { direction: 'in', curve: 'cosine' });
    expect(out[0][2]).toBeCloseTo(0.5, 6);
  });
});

describe('FadeEffect curve routing (X6): persisted ids onto the shared fades.ts family', () => {
  const unity = () => [Float32Array.from([1, 1, 1, 1, 1])];

  it('equal-power fade-in: 0 at start, sin(pi/4) at the midpoint, 1 at the end', () => {
    const out = run(fadeEffect, unity(), { direction: 'in', curve: 'equal-power' });
    expect(out[0][0]).toBe(0);
    expect(out[0][2]).toBe(Math.fround(Math.sin(Math.PI / 4)));
    expect(out[0][2]).toBeCloseTo(Math.SQRT1_2, 7);
    expect(out[0][4]).toBe(1);
  });

  it('equal-power fade-out ends at the documented cos(pi/2) residue, not a literal zero', () => {
    const out = run(fadeEffect, unity(), { direction: 'out', curve: 'equal-power' });
    expect(out[0][0]).toBe(1);
    expect(out[0][4]).toBe(Math.fround(Math.cos(Math.PI / 2)));
    expect(out[0][4]).not.toBe(0);
    expect(out[0][4]).toBeLessThan(1e-15);
  });

  it('every persisted id renders its mapped shape at the midpoint of a 5-sample ramp', () => {
    const mid = (curve: string) => run(fadeEffect, unity(), { direction: 'in', curve })[0][2];
    expect(mid('linear')).toBe(0.5); // equal-gain: t
    expect(mid('exponential')).toBe(0.25); // t^2
    expect(mid('cosine')).toBe(0.5); // smooth: (1 - cos(pi t)) / 2
    expect(mid('equal-power')).toBe(Math.fround(Math.sin(Math.PI / 4)));
  });

  it('an unknown persisted id falls back to the linear ramp, as the v1.8.0 default branch did', () => {
    const out = run(fadeEffect, unity(), { direction: 'in', curve: 'wavelet' });
    expect(Array.from(out[0])).toEqual([0, 0.25, 0.5, 0.75, 1]);
  });
});

describe('FadeEffect length parameter (X6)', () => {
  // Every value is exactly representable in float32, so byte-equality
  // assertions against these literals are assertions about the samples, not
  // about rounding on the way into the fixture.
  const SRC8 = [0.5, -0.5, 0.25, -0.25, 0.75, -0.75, 1, -1];
  const mk8 = () => [Float32Array.from(SRC8)];

  it('the default length (100%) renders byte-identically to an explicit 100 and to the v1.8.0 formula', () => {
    const dflt = run(fadeEffect, mk8(), { direction: 'in', curve: 'cosine' });
    const explicit = run(fadeEffect, mk8(), { direction: 'in', curve: 'cosine', lengthPercent: 100 });
    for (let i = 0; i < 8; i++) {
      expect(dflt[0][i]).toBe(explicit[0][i]);
      // v1.8.0: dst[i] = c[i] * (1 - cos(pi * i/(len-1))) / 2 over the WHOLE selection.
      expect(dflt[0][i]).toBe(Math.fround(SRC8[i] * ((1 - Math.cos(Math.PI * (i / 7))) / 2)));
    }
  });

  it('fade-in at 50% shapes exactly the first half; the second half is byte-identical', () => {
    const out = run(fadeEffect, mk8(), { direction: 'in', curve: 'linear', lengthPercent: 50 });
    // fadeLen = 4; ramp gains 0, 1/3, 2/3, 1.
    expect(out[0][0]).toBe(0);
    expect(out[0][1]).toBe(Math.fround(-0.5 * (1 / 3)));
    expect(out[0][2]).toBe(Math.fround(0.25 * (2 / 3)));
    expect(out[0][3]).toBe(-0.25); // last in-window sample: ramp position 1, gain exactly 1
    for (let i = 4; i < 8; i++) expect(out[0][i]).toBe(mk8()[0][i]); // first untouched index is 4
  });

  it('fade-out at 50% shapes exactly the last half; the first half is byte-identical', () => {
    const out = run(fadeEffect, mk8(), { direction: 'out', curve: 'linear', lengthPercent: 50 });
    for (let i = 0; i < 4; i++) expect(out[0][i]).toBe(mk8()[0][i]); // last untouched index is 3
    expect(out[0][4]).toBe(0.75); // first in-window sample: ramp position 0, gain exactly 1
    expect(out[0][5]).toBe(Math.fround(-0.75 * (2 / 3)));
    expect(out[0][6]).toBe(Math.fround(1 * (1 / 3)));
    expect(Object.is(out[0][7], -0)).toBe(true); // -1 * 0: the final ramp gain really lands
  });

  it('lengthPercent 100 on a 64-sample selection fades all 64 samples (the clamp boundary is inclusive)', () => {
    const out = run(fadeEffect, [new Float32Array(64).fill(1)], {
      direction: 'in',
      curve: 'linear',
      lengthPercent: 100,
    });
    for (let i = 0; i < 64; i++) expect(out[0][i]).toBe(Math.fround(i / 63));
  });

  it('lengthPercent above 100 clamps: 150 renders byte-identically to 100, both directions', () => {
    // 64 samples, not 8: the fixture must be sized so the clamp constant's own
    // boundary can move the output. Below 50 samples, 1% of the selection is
    // under half a sample and Math.round absorbs a clamp drifted to 101
    // (round(8 * 1.01) is still 8) — at 64, a 101-clamp yields fadeLen 65 and
    // the whole ramp shifts (X6 review round 1's surviving mutant).
    const src = Float32Array.from({ length: 64 }, (_, i) => (((i * 37) % 128) - 64) / 64);
    for (const direction of ['in', 'out']) {
      const a = run(fadeEffect, [Float32Array.from(src)], { direction, curve: 'exponential', lengthPercent: 150 });
      const b = run(fadeEffect, [Float32Array.from(src)], { direction, curve: 'exponential', lengthPercent: 100 });
      for (let i = 0; i < 64; i++) expect(a[0][i]).toBe(b[0][i]);
    }
  });

  it('lengthPercent 0 applies no fade: the output is a byte-identical copy, not the same array', () => {
    const input = mk8();
    const out = run(fadeEffect, input, { direction: 'in', curve: 'linear', lengthPercent: 0 });
    expect(out[0]).not.toBe(input[0]);
    for (let i = 0; i < 8; i++) expect(out[0][i]).toBe(input[0][i]);
  });

  it('a negative lengthPercent clamps to 0 and applies no fade', () => {
    const input = mk8();
    const out = run(fadeEffect, input, { direction: 'out', curve: 'cosine', lengthPercent: -10 });
    for (let i = 0; i < 8; i++) expect(out[0][i]).toBe(input[0][i]);
  });

  it('the window length rounds half up: 50% of 5 samples is a 3-sample ramp', () => {
    const out = run(fadeEffect, [Float32Array.from([1, 1, 1, 1, 1])], {
      direction: 'in',
      curve: 'linear',
      lengthPercent: 50,
    });
    expect(Array.from(out[0])).toEqual([0, 0.5, 1, 1, 1]);
  });

  it('the window length rounds down below half: 30% of 8 samples is a 2-sample ramp', () => {
    const out = run(fadeEffect, mk8(), { direction: 'in', curve: 'linear', lengthPercent: 30 });
    expect(out[0][0]).toBe(0); // ramp position 0
    expect(out[0][1]).toBe(-0.5); // ramp position 1: gain exactly 1
    for (let i = 2; i < 8; i++) expect(out[0][i]).toBe(mk8()[0][i]);
  });

  it('the window length rounds up above half: 44% of 8 samples is a 4-sample ramp', () => {
    const out = run(fadeEffect, mk8(), { direction: 'in', curve: 'linear', lengthPercent: 44 });
    expect(out[0][2]).toBe(Math.fround(0.25 * (2 / 3))); // interior gain of a 4-sample ramp
    expect(out[0][3]).toBe(-0.25); // in-window, gain 1 at the ramp end
    for (let i = 4; i < 8; i++) expect(out[0][i]).toBe(mk8()[0][i]);
  });

  it('a one-sample fade-in window zeroes exactly that sample, preserving the sign of zero', () => {
    const input = [Float32Array.from([-0.7, 0.7, 0.5, -0.5, 1])];
    const out = run(fadeEffect, input, { direction: 'in', curve: 'equal-power', lengthPercent: 20 });
    expect(Object.is(out[0][0], -0)).toBe(true); // -0.7 * 0: v1.8.0's singleton convention (t = 0)
    for (let i = 1; i < 5; i++) expect(out[0][i]).toBe(input[0][i]);
  });

  it('a one-sample fade-out window leaves the final sample alone (gain 1, the trail-off convention)', () => {
    const input = [Float32Array.from([-0.7, 0.7, 0.5, -0.5, 1])];
    const out = run(fadeEffect, input, { direction: 'out', curve: 'equal-power', lengthPercent: 20 });
    for (let i = 0; i < 5; i++) expect(out[0][i]).toBe(input[0][i]);
  });

  it('produces no NaN at selection lengths 0, 1 and 2, every curve, every length', () => {
    for (const curve of ['linear', 'exponential', 'cosine', 'equal-power']) {
      for (const direction of ['in', 'out']) {
        for (const lengthPercent of [0, 20, 50, 100]) {
          for (const len of [0, 1, 2]) {
            const out = run(fadeEffect, [new Float32Array(len).fill(1)], { curve, direction, lengthPercent });
            out[0].forEach((v) => expect(Number.isNaN(v)).toBe(false));
          }
        }
      }
    }
  });
});

describe('FadeEffect parameter surface (X6)', () => {
  it('persisted curve option values are unchanged, plus the new equal-power', () => {
    const curveDef = fadeEffect.params.find((p) => p.id === 'curve')!;
    expect(curveDef.options?.map((o) => o.value)).toEqual(['linear', 'exponential', 'cosine', 'equal-power']);
    expect(curveDef.default).toBe('linear');
  });

  it('curve labels: Ducked and Equal power aligned with the clip-fade picker', () => {
    const curveDef = fadeEffect.params.find((p) => p.id === 'curve')!;
    expect(curveDef.options?.map((o) => o.label)).toEqual(['Linear', 'Ducked', 'Cosine', 'Equal power']);
  });

  it('the length parameter is a clamped percentage defaulting to the whole selection', () => {
    const lenDef = fadeEffect.params.find((p) => p.id === 'lengthPercent')!;
    expect(lenDef.type).toBe('number');
    expect(lenDef.min).toBe(0);
    expect(lenDef.max).toBe(100);
    expect(lenDef.default).toBe(100);
  });
});

describe('FadeEffect lengthPercent readout (R2-2, v1.9.2)', () => {
  const readout = fadeEffect.params.find((p) => p.id === 'lengthPercent')!.readout!;

  it('mirrors the process window arithmetic: 50% of 5 samples reads as the SAME 3-sample ramp the effect writes', () => {
    // Identical boundary to the "50% of 5 samples is a 3-sample ramp" pin
    // above: Math.round(2.5) = 3, half rounds UP. sampleRate 10 makes one
    // sample = 100 ms, so a floor-based readout (2 samples -> 0:00.200) is a
    // visibly different string, not a sub-ms difference formatTime would hide
    // (trap T10: the readout must agree with what process writes exactly
    // where a user checks it — short selections).
    expect(readout(50, { regionSamples: 5, sampleRate: 10 })).toBe('≈ 0:00.300');
  });

  it('below and above the rounding boundary: 40% of 5 -> 2 samples, 60% of 5 -> 3 samples', () => {
    expect(readout(40, { regionSamples: 5, sampleRate: 10 })).toBe('≈ 0:00.200');
    expect(readout(60, { regionSamples: 5, sampleRate: 10 })).toBe('≈ 0:00.300');
  });

  it('clamps exactly like process: above 100 reads as 100, at 100 the whole region, at/below 0 nothing', () => {
    // 150 UNCLAMPED would be 15 samples = 0:01.500 — the clamp visibly moves
    // the output. (The 0-side clamp cannot be distinguished from formatTime's
    // own negative-input floor at the string level; asserted for the record.)
    expect(readout(150, { regionSamples: 10, sampleRate: 10 })).toBe('≈ 0:01.000');
    expect(readout(100, { regionSamples: 10, sampleRate: 10 })).toBe('≈ 0:01.000');
    expect(readout(0, { regionSamples: 10, sampleRate: 10 })).toBe('≈ 0:00.000');
    expect(readout(-50, { regionSamples: 10, sampleRate: 10 })).toBe('≈ 0:00.000');
  });

  it('the motivating case: 50% of a 1 s selection is 0.5 s; 50% of a 30 s selection is 15 s', () => {
    expect(readout(50, { regionSamples: 44100, sampleRate: 44100 })).toBe('≈ 0:00.500');
    expect(readout(50, { regionSamples: 30 * 44100, sampleRate: 44100 })).toBe('≈ 0:15.000');
  });
});

describe('ReverseEffect', () => {
  it('reversing twice is the exact identity', () => {
    const input = [Float32Array.from([0.1, 0.2, 0.3, 0.4])];
    const original = Array.from(input[0]);
    const once = run(reverseEffect, input, {});
    expect(Array.from(once[0])).toEqual([...original].reverse());
    const twice = reverseEffect.process(once, SR, {}).channels;
    expect(Array.from(twice[0])).toEqual(original);
  });
});

describe('InvertEffect', () => {
  it('inverting twice is the exact identity', () => {
    const input = [Float32Array.from([0.1, -0.2, 0.3])];
    const original = Array.from(input[0]);
    const once = run(invertEffect, input, {});
    expect(Array.from(once[0])).toEqual(original.map((v) => -v));
    const twice = invertEffect.process(once, SR, {}).channels;
    expect(Array.from(twice[0])).toEqual(original);
  });
});

describe('DcRemoveEffect', () => {
  it('removes the per-channel DC offset (mean ~ 0)', () => {
    const withDc = new Float32Array(64);
    for (let i = 0; i < withDc.length; i++) {
      withDc[i] = 0.5 + 0.2 * Math.sin((2 * Math.PI * i) / 16);
    }
    const out = run(dcRemoveEffect, [withDc], {});
    expect(Math.abs(mean(out[0]))).toBeLessThan(1e-7);
  });
});
