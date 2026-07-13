import { resampleChannel } from './resample';

/** Count sign changes (zero crossings) in a signal, ignoring exact zeros. */
function countZeroCrossings(x: Float32Array, start = 0, end = x.length): number {
  let count = 0;
  let prevSign = 0;
  for (let i = start; i < end; i++) {
    const s = x[i] > 0 ? 1 : x[i] < 0 ? -1 : 0;
    if (s !== 0) {
      if (prevSign !== 0 && s !== prevSign) count++;
      prevSign = s;
    }
  }
  return count;
}

describe('resampleChannel', () => {
  it('returns a copy (not the same reference) for identical rates', () => {
    const input = Float32Array.from([0.1, 0.2, 0.3, 0.4]);
    const out = resampleChannel(input, 44100, 44100);
    expect(out).not.toBe(input);
    expect(Array.from(out)).toEqual([
      0.1, 0.2, 0.3, 0.4,
    ].map((v) => Math.fround(v)));
  });

  it('handles empty input', () => {
    const out = resampleChannel(new Float32Array(0), 44100, 48000);
    expect(out).toHaveLength(0);
  });

  it('halves the length when downsampling 44100 -> 22050 (within +/-1)', () => {
    const input = new Float32Array(44100);
    for (let i = 0; i < input.length; i++) input[i] = Math.sin((2 * Math.PI * 440 * i) / 44100);
    const out = resampleChannel(input, 44100, 22050);
    expect(Math.abs(out.length - 22050)).toBeLessThanOrEqual(1);
  });

  it('doubles-ish the length when upsampling 44100 -> 48000', () => {
    const input = new Float32Array(44100);
    const out = resampleChannel(input, 44100, 48000);
    expect(out.length).toBe(Math.round(44100 * (48000 / 44100)));
  });

  it('preserves a 440Hz sine as 440Hz after 44100 -> 48000 (zero-crossing count within +/-1)', () => {
    const inLen = 44100; // 1.0s
    const input = new Float32Array(inLen);
    for (let i = 0; i < inLen; i++) input[i] = Math.sin((2 * Math.PI * 440 * i) / 44100);
    const out = resampleChannel(input, 44100, 48000);
    // Count zero crossings across an interior 0.5s window to avoid edge windowing.
    const start = 12000; // 0.25s into 48kHz output
    const end = start + 24000; // 0.5s window
    const crossings = countZeroCrossings(out, start, end);
    // 440 Hz over 0.5s -> 220 cycles -> 440 zero crossings.
    expect(Math.abs(crossings - 440)).toBeLessThanOrEqual(1);
  });

  it('keeps a constant 0.7 signal ~= 0.7 in the interior (edges excluded)', () => {
    const input = new Float32Array(4000);
    input.fill(0.7);
    const out = resampleChannel(input, 44100, 48000);
    const mid = Math.floor(out.length / 2);
    for (let i = mid - 50; i < mid + 50; i++) {
      expect(out[i]).toBeCloseTo(0.7, 3);
    }
  });

  it('resamples 1,000,000 samples 44100 -> 48000 in under 2 seconds', () => {
    const input = new Float32Array(1_000_000);
    for (let i = 0; i < input.length; i++) input[i] = Math.sin((2 * Math.PI * 1000 * i) / 44100);
    const t0 = performance.now();
    const out = resampleChannel(input, 44100, 48000);
    const elapsedMs = performance.now() - t0;
    expect(out.length).toBe(Math.round(1_000_000 * (48000 / 44100)));
    expect(elapsedMs).toBeLessThan(2000);
  });

  it('reports progress ending at exactly 1.0', () => {
    const input = new Float32Array(20000);
    for (let i = 0; i < input.length; i++) input[i] = Math.sin(i * 0.1);
    const fractions: number[] = [];
    resampleChannel(input, 44100, 48000, (f) => fractions.push(f));
    expect(fractions.length).toBeGreaterThan(0);
    expect(fractions[fractions.length - 1]).toBe(1);
    for (const f of fractions) {
      expect(f).toBeGreaterThanOrEqual(0);
      expect(f).toBeLessThanOrEqual(1);
    }
  });
});
