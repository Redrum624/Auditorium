import { noiseReductionEffect } from './NoiseReductionEffect';
import { getAllEffects } from '../EffectRegistry';
import { registerAllEffects } from '../registerAll';
import { stft } from '../../dsp/stft';

const SR = 44100;
const FFT = 2048;
const HOP = 512;

/** Deterministic LCG noise sample generator, uniform in [-amp, amp]. */
function makeNoise(seedInit: number, amp: number): () => number {
  let seed = seedInit;
  return () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return (seed / 0x7fffffff - 0.5) * 2 * amp;
  };
}

function rms(x: Float32Array, start: number, end: number): number {
  let sum = 0;
  for (let i = start; i < end; i++) sum += x[i] * x[i];
  return Math.sqrt(sum / (end - start));
}

/** Average magnitude spectrum of a noise-only buffer -> a captured noise profile. */
function averageMagnitude(region: Float32Array): Float32Array {
  const { frames } = stft(region, FFT, HOP);
  const bins = FFT / 2 + 1;
  const avg = new Float32Array(bins);
  for (const fr of frames) for (let k = 0; k < bins; k++) avg[k] += fr[k];
  for (let k = 0; k < bins; k++) avg[k] /= frames.length;
  return avg;
}

/** Build a 1s signal: uniform noise everywhere + a 440Hz sine in the 2nd half. */
function buildSignal(): { signal: Float32Array; noiseEnd: number; sineStart: number } {
  const length = SR;
  const sineStart = Math.floor(length / 2);
  const noise = makeNoise(987654321, 0.05);
  const signal = new Float32Array(length);
  for (let n = 0; n < length; n++) {
    let v = noise();
    if (n >= sineStart) v += 0.5 * Math.sin((2 * Math.PI * 440 * n) / SR);
    signal[n] = v;
  }
  return { signal, noiseEnd: sineStart, sineStart };
}

function setProfile(spectra: Float32Array[]): void {
  (globalThis as { __effectExtra?: unknown }).__effectExtra = {
    spectra: spectra.map((s) => Array.from(s)),
  };
}
function clearProfile(): void {
  delete (globalThis as { __effectExtra?: unknown }).__effectExtra;
}

afterEach(clearProfile);

describe('noiseReductionEffect', () => {
  it('registers as noise-reduction in category Restoration', () => {
    expect(noiseReductionEffect.id).toBe('noise-reduction');
    expect(noiseReductionEffect.category).toBe('Restoration');
    registerAllEffects();
    const ids = getAllEffects()
      .filter((e) => e.category === 'Restoration')
      .map((e) => e.id);
    expect(ids).toContain('noise-reduction');
  });

  it('throws when no noise print has been captured', () => {
    clearProfile();
    const { signal } = buildSignal();
    expect(() => noiseReductionEffect.process([signal], SR, {})).toThrow('No noise print captured');
  });

  it('reduces a noise-only region by >=10 dB while preserving the sine region', () => {
    const { signal, noiseEnd, sineStart } = buildSignal();
    // Capture the profile from a noise-only stretch (interior of the first half).
    const profile = averageMagnitude(signal.subarray(2048, noiseEnd - 2048));
    setProfile([profile]);

    const result = noiseReductionEffect.process([signal], SR, {
      reductionDb: 20,
      sensitivity: 2,
      smoothing: 0.5,
    });
    const out = result.channels[0];
    expect(out.length).toBe(signal.length);

    // Noise-only region (interior, away from edges/onset): >=10 dB RMS drop.
    const nStart = 4096;
    const nEnd = noiseEnd - 3000;
    const before = rms(signal, nStart, nEnd);
    const after = rms(out, nStart, nEnd);
    const reductionDb = 20 * Math.log10(before / after);
    expect(reductionDb).toBeGreaterThanOrEqual(10);

    // Sine region (interior): output RMS within +/-3 dB of the clean sine RMS.
    const cleanSineRms = 0.5 / Math.sqrt(2);
    const sStart = sineStart + 4096;
    const sEnd = signal.length - 3000;
    const sineAfter = rms(out, sStart, sEnd);
    const sineDelta = 20 * Math.log10(sineAfter / cleanSineRms);
    expect(Math.abs(sineDelta)).toBeLessThanOrEqual(3);
  });

  it('the Reduction slider sets the gain FLOOR: 6dB reduces the noise floor by ~6dB, not by everything', () => {
    // floor = 10^(-reductionDb/20). In a noise-only region the raw gain
    // (m - sensitivity*noise)/m is at or below the floor almost everywhere, so
    // the measured attenuation tracks reductionDb directly. The band is
    // two-sided on purpose: a floor stuck at 0 (or at any smaller value) gates
    // the region far harder than the slider asked for.
    const { signal, noiseEnd } = buildSignal();
    const profile = averageMagnitude(signal.subarray(2048, noiseEnd - 2048));
    setProfile([profile]);

    const nStart = 4096;
    const nEnd = noiseEnd - 3000;
    const before = rms(signal, nStart, nEnd);

    const measure = (reductionDb: number): number => {
      const out = noiseReductionEffect.process([signal], SR, {
        reductionDb,
        sensitivity: 2,
        smoothing: 0.5,
      }).channels[0];
      return 20 * Math.log10(before / rms(out, nStart, nEnd));
    };

    const at6 = measure(6);
    expect(at6).toBeGreaterThan(4);
    expect(at6).toBeLessThan(9);

    const at18 = measure(18);
    expect(at18).toBeGreaterThan(15);
    expect(at18).toBeLessThan(21);
  });

  it('does not mutate the input channels', () => {
    const { signal } = buildSignal();
    const before = Array.from(signal);
    const profile = averageMagnitude(signal.subarray(2048, 18000));
    setProfile([profile]);
    noiseReductionEffect.process([signal], SR, {});
    expect(Array.from(signal)).toEqual(before);
  });
});
