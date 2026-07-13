import { computeSpectrogramColumns } from './spectrogramCore';

const SR = 44100;
const FFT = 2048;

/** Argmax row within column `col` of the width*height (col-major) grid. */
function argmaxRow(mags: Float32Array, col: number, height: number): number {
  let best = 0;
  let bestV = -Infinity;
  for (let row = 0; row < height; row++) {
    const v = mags[col * height + row];
    if (v > bestV) {
      bestV = v;
      best = row;
    }
  }
  return best;
}

describe('computeSpectrogramColumns', () => {
  it('returns a width*height grid', () => {
    const channel = new Float32Array(SR);
    for (let n = 0; n < channel.length; n++) channel[n] = Math.sin((2 * Math.PI * 1000 * n) / SR);
    const width = 80;
    const height = 128;
    const mags = computeSpectrogramColumns({
      channel,
      startSample: 0,
      endSample: channel.length,
      width,
      height,
      fftSize: FFT,
    });
    expect(mags.length).toBe(width * height);
  });

  it('locates a constant sine at a stable row near the expected linear bin', () => {
    const freq = 1000;
    const channel = new Float32Array(SR);
    for (let n = 0; n < channel.length; n++) channel[n] = Math.sin((2 * Math.PI * freq * n) / SR);
    const width = 100;
    const height = 256;
    const mags = computeSpectrogramColumns({
      channel,
      startSample: 0,
      endSample: channel.length,
      width,
      height,
      fftSize: FFT,
    });

    const halfBins = FFT / 2; // 1024
    const bin = (freq * FFT) / SR; // ~46.4
    const expectedRow = (bin * height) / halfBins; // ~11.6

    const rows: number[] = [];
    for (let col = 5; col < width - 5; col++) rows.push(argmaxRow(mags, col, height));

    // Each interior column's peak row is close to the expected linear-mapped row.
    for (const r of rows) expect(Math.abs(r - expectedRow)).toBeLessThanOrEqual(3);

    // ...and the peak row is stable across columns (constant tone).
    const min = Math.min(...rows);
    const max = Math.max(...rows);
    expect(max - min).toBeLessThanOrEqual(1);
  });
});
