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
      sampleRate: SR,
      scale: 'linear',
    });
    expect(mags.length).toBe(width * height);
  });

  it('locates a constant sine at a stable row near the expected linear bin (scale: linear)', () => {
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
      sampleRate: SR,
      scale: 'linear',
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

  it('defaults to the log scale when `scale` is omitted', () => {
    const freq = 1000;
    const channel = new Float32Array(SR);
    for (let n = 0; n < channel.length; n++) channel[n] = Math.sin((2 * Math.PI * freq * n) / SR);
    const width = 10;
    const height = 64;

    const withDefault = computeSpectrogramColumns({
      channel,
      startSample: 0,
      endSample: channel.length,
      width,
      height,
      fftSize: FFT,
      sampleRate: SR,
    });
    const withExplicitLog = computeSpectrogramColumns({
      channel,
      startSample: 0,
      endSample: channel.length,
      width,
      height,
      fftSize: FFT,
      sampleRate: SR,
      scale: 'log',
    });

    expect(Array.from(withDefault)).toEqual(Array.from(withExplicitLog));
  });

  it('spreads its columns across exactly [startSample, endSample] even when the span is narrow', () => {
    // Regression (v1.1 release smoke): with span/width < 128 the old hop clamp
    // (min 128) made the columns stride PAST endSample, so the right part of the
    // raster windowed silence beyond the doc and painted black — horizontally
    // compressing the image and misaligning it with the ruler/overlays. Columns
    // must always cover the requested span and nothing more: here every column
    // of a full-span sine must be loud, including the last one.
    const channel = new Float32Array(8000);
    for (let n = 0; n < channel.length; n++) channel[n] = Math.sin((2 * Math.PI * 1000 * n) / SR);
    const width = 100; // span/width = 80 < 128 -> the old clamp overshot the span
    const height = 64;
    const mags = computeSpectrogramColumns({
      channel,
      startSample: 0,
      endSample: channel.length,
      width,
      height,
      fftSize: FFT,
      sampleRate: SR,
      scale: 'linear',
    });
    for (let col = 0; col < width; col++) {
      let maxDb = -Infinity;
      for (let row = 0; row < height; row++) maxDb = Math.max(maxDb, mags[col * height + row]);
      expect(maxDb).toBeGreaterThan(-30);
    }
  });

  it('locates a constant sine at the expected log-mapped row (scale: log, Task F4)', () => {
    // 440 Hz sine @ 44100, height 256: argmax row ~= round((h-1)*log(440/20)/log(22050/20)).
    // Row 0 = 20 Hz (the LOWEST frequency), consistent with the linear scale's
    // row 0 = DC; SpectrogramView's paint step flips rows so row 0 is drawn at
    // the BOTTOM of the canvas (low frequencies at the bottom, like Audition).
    const freq = 440;
    const channel = new Float32Array(SR);
    for (let n = 0; n < channel.length; n++) channel[n] = Math.sin((2 * Math.PI * freq * n) / SR);
    const width = 40;
    const height = 256;
    const mags = computeSpectrogramColumns({
      channel,
      startSample: 0,
      endSample: channel.length,
      width,
      height,
      fftSize: FFT,
      sampleRate: SR,
      scale: 'log',
    });

    const fnyq = SR / 2;
    const fmin = 20;
    const expectedRow = Math.round(((height - 1) * Math.log(freq / fmin)) / Math.log(fnyq / fmin));

    const rows: number[] = [];
    for (let col = 5; col < width - 5; col++) rows.push(argmaxRow(mags, col, height));

    // ±3: bin quantization puts the argmax at exactly 2 rows from the continuous
    // formula for this fixture (rows 111/112 share the peak bin); ±2 was zero-margin.
    for (const r of rows) expect(Math.abs(r - expectedRow)).toBeLessThanOrEqual(3);

    const min = Math.min(...rows);
    const max = Math.max(...rows);
    expect(max - min).toBeLessThanOrEqual(1);
  });
});
