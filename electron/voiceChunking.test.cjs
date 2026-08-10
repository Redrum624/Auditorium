'use strict';

/**
 * voiceChunking.cjs — the F3 pure-math layer: OpenVoice's spectrogram (ported
 * via the spike harness) and the stem-reference overlap-add chunking with the
 * VC constants.
 *
 * Discipline notes:
 *  - Every comparison is probed per operand role, below/on/above, sized so
 *    the boundary can move the output (the brief's rule).
 *  - The spectrogram is checked against an INDEPENDENT naive DFT written in
 *    this file from the spec (reflect pad, periodic Hann, magnitude floor) —
 *    not against the implementation's own helpers.
 */

const {
  VC_SAMPLE_RATE,
  N_FFT,
  HOP_LENGTH,
  SPEC_BINS,
  REFLECT_PAD,
  MIN_INPUT_SAMPLES,
  SEGMENT_SAMPLES,
  OVERLAP_SAMPLES,
  STRIDE_SAMPLES,
  WEIGHT_EPSILON,
  framesForSamples,
  spectrogram,
  toFramesBins,
  planVoiceSegments,
  makeVoiceWindow,
  createVoiceAccumulator,
  accumulateVoiceSegment,
  voiceFinalizedEnd,
  extractVoiceFinalized,
  padToHopMultiple,
} = require('./voiceChunking.cjs');

describe('constants — every derivation restated independently', () => {
  test('model parameters match the spike tensor signature', () => {
    expect(VC_SAMPLE_RATE).toBe(22050);
    expect(N_FFT).toBe(1024);
    expect(HOP_LENGTH).toBe(256);
    expect(SPEC_BINS).toBe(513); // 1024/2 + 1
    expect(REFLECT_PAD).toBe(384); // (1024 - 256) / 2
    expect(MIN_INPUT_SAMPLES).toBe(385); // head reflection reads x[384]
  });

  test('segment constants: ~30 s, HOP-aligned, reference overlap proportion', () => {
    expect(SEGMENT_SAMPLES).toBe(661504);
    // 30 s at 22050 = 661,500; SEGMENT is the next HOP multiple above it.
    expect(SEGMENT_SAMPLES % HOP_LENGTH).toBe(0);
    expect(SEGMENT_SAMPLES - 30 * VC_SAMPLE_RATE).toBeGreaterThanOrEqual(0);
    expect(SEGMENT_SAMPLES - 30 * VC_SAMPLE_RATE).toBeLessThan(HOP_LENGTH);
    expect(OVERLAP_SAMPLES).toBe(SEGMENT_SAMPLES / 4); // stem reference: N // 4
    expect(OVERLAP_SAMPLES % HOP_LENGTH).toBe(0);
    expect(STRIDE_SAMPLES).toBe(SEGMENT_SAMPLES - OVERLAP_SAMPLES);
    expect(STRIDE_SAMPLES % HOP_LENGTH).toBe(0);
    // The plan's drop-short-tail rule is only safe while OVERLAP >= MIN.
    expect(OVERLAP_SAMPLES).toBeGreaterThanOrEqual(MIN_INPUT_SAMPLES);
  });
});

describe('framesForSamples — the centre-less STFT frame law', () => {
  test('boundary: below MIN throws, MIN yields one frame', () => {
    expect(() => framesForSamples(MIN_INPUT_SAMPLES - 1)).toThrow(/>= 385/);
    expect(framesForSamples(MIN_INPUT_SAMPLES)).toBe(1);
  });

  test('frame-count steps land exactly on the HOP boundary', () => {
    // 1 + floor((n + 768 - 1024)/256): steps at n = 256·k.
    expect(framesForSamples(511)).toBe(1);
    expect(framesForSamples(512)).toBe(2); // on the step
    expect(framesForSamples(513)).toBe(2);
  });

  test('a HOP multiple yields exactly n/HOP frames (the SEGMENT property)', () => {
    expect(framesForSamples(1024)).toBe(4);
    expect(framesForSamples(SEGMENT_SAMPLES)).toBe(SEGMENT_SAMPLES / HOP_LENGTH); // 2584
    // One below/above the multiple moves the count as the law says.
    expect(framesForSamples(1023)).toBe(3);
    expect(framesForSamples(1025)).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// Independent reference: reflect pad + periodic Hann + naive DFT magnitude,
// written from the spec (OpenVoice spectrogram_torch, spike step 1).
// ---------------------------------------------------------------------------

function referencePad(x) {
  const padded = new Float64Array(x.length + 2 * REFLECT_PAD);
  for (let i = 0; i < REFLECT_PAD; i++) padded[i] = x[REFLECT_PAD - i];
  for (let i = 0; i < x.length; i++) padded[REFLECT_PAD + i] = x[i];
  for (let i = 0; i < REFLECT_PAD; i++) padded[REFLECT_PAD + x.length + i] = x[x.length - 2 - i];
  return padded;
}

function referenceFrameMagnitudes(padded, frameIndex) {
  const out = new Float64Array(SPEC_BINS);
  const off = frameIndex * HOP_LENGTH;
  for (let k = 0; k < SPEC_BINS; k++) {
    let re = 0;
    let im = 0;
    for (let i = 0; i < N_FFT; i++) {
      const hann = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N_FFT);
      const v = padded[off + i] * hann;
      const phase = (-2 * Math.PI * k * i) / N_FFT;
      re += v * Math.cos(phase);
      im += v * Math.sin(phase);
    }
    out[k] = Math.sqrt(re * re + im * im + 1e-6);
  }
  return out;
}

describe('spectrogram — checked against an independent naive DFT', () => {
  test('boundary: below MIN throws, MIN works', () => {
    expect(() => spectrogram(new Float32Array(MIN_INPUT_SAMPLES - 1))).toThrow(/385/);
    expect(spectrogram(new Float32Array(MIN_INPUT_SAMPLES)).frames).toBe(1);
  });

  test('frame count matches the law', () => {
    const { frames } = spectrogram(new Float32Array(2048));
    expect(frames).toBe(framesForSamples(2048)); // 8
  });

  test('all-zero input hits exactly the 1e-6 magnitude floor in every bin of every frame', () => {
    const { spec, frames } = spectrogram(new Float32Array(1024));
    expect(frames).toBe(4);
    const floor = Math.sqrt(1e-6);
    for (let i = 0; i < spec.length; i++) {
      expect(spec[i]).toBeCloseTo(floor, 9);
    }
  });

  test('first frame (reflect-padded region) and an interior frame match the naive DFT bin-for-bin', () => {
    // Deterministic non-trivial signal: two incommensurate sines + a ramp, so
    // the reflection at the head is visible in frame 0's values.
    const n = 2048;
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      x[i] = 0.5 * Math.sin((2 * Math.PI * 331 * i) / VC_SAMPLE_RATE) +
        0.3 * Math.sin((2 * Math.PI * 1207 * i) / VC_SAMPLE_RATE) +
        0.0001 * i;
    }
    const { spec, frames } = spectrogram(x);
    const padded = referencePad(x);
    for (const f of [0, 4, frames - 1]) {
      const expected = referenceFrameMagnitudes(padded, f);
      for (let k = 0; k < SPEC_BINS; k++) {
        // float32 storage + radix-2 vs naive DFT: absolute 1e-3 on values up
        // to ~512·|x| is ~1e-6 relative.
        expect(Math.abs(spec[k * frames + f] - expected[k])).toBeLessThan(1e-3);
      }
    }
  });

  test('reflection matters: mutating the head of the input changes frame 0 but not an interior frame', () => {
    const n = 2048;
    const a = new Float32Array(n).fill(0.1);
    const b = Float32Array.from(a);
    b[0] = 0.9; // reflected into padded[REFLECT_PAD .. ] and read by frame 0 only
    const sa = spectrogram(a);
    const sb = spectrogram(b);
    let frame0Diff = 0;
    let interiorDiff = 0;
    for (let k = 0; k < SPEC_BINS; k++) {
      frame0Diff += Math.abs(sa.spec[k * sa.frames + 0] - sb.spec[k * sb.frames + 0]);
      frame0Diff += Math.abs(sa.spec[k * sa.frames + 1] - sb.spec[k * sb.frames + 1]);
      interiorDiff += Math.abs(sa.spec[k * sa.frames + 6] - sb.spec[k * sb.frames + 6]);
    }
    expect(frame0Diff).toBeGreaterThan(0.01);
    expect(interiorDiff).toBe(0);
  });
});

describe('toFramesBins — the extractor-layout transpose', () => {
  test('every entry lands transposed (full extent, not just [0][0])', () => {
    const frames = 3;
    const spec = new Float32Array(SPEC_BINS * frames);
    for (let i = 0; i < spec.length; i++) spec[i] = i + 1;
    const out = toFramesBins(spec, frames);
    expect(out.length).toBe(frames * SPEC_BINS);
    for (let f = 0; f < frames; f++) {
      for (let k = 0; k < SPEC_BINS; k++) {
        expect(out[f * SPEC_BINS + k]).toBe(spec[k * frames + f]);
      }
    }
  });
});

describe('planVoiceSegments — the reference chunk law plus the short-tail rule', () => {
  test('boundary: below MIN throws, MIN plans one chunk', () => {
    expect(() => planVoiceSegments(MIN_INPUT_SAMPLES - 1)).toThrow(/>= 385/);
    expect(planVoiceSegments(MIN_INPUT_SAMPLES)).toEqual([{ start: 0, end: MIN_INPUT_SAMPLES }]);
  });

  test('single chunk up to STRIDE; the step to two chunks lands exactly past it', () => {
    expect(planVoiceSegments(STRIDE_SAMPLES)).toEqual([{ start: 0, end: STRIDE_SAMPLES }]);
    // One past STRIDE would plan a 1-sample tail — dropped, still one chunk.
    expect(planVoiceSegments(STRIDE_SAMPLES + 1)).toEqual([{ start: 0, end: STRIDE_SAMPLES + 1 }]);
  });

  test('short-tail rule boundary: a tail of MIN−1 is dropped, MIN is kept, MIN+1 is kept', () => {
    const dropped = planVoiceSegments(STRIDE_SAMPLES + MIN_INPUT_SAMPLES - 1);
    expect(dropped).toHaveLength(1);
    expect(dropped[0]).toEqual({ start: 0, end: STRIDE_SAMPLES + MIN_INPUT_SAMPLES - 1 });

    const keptOn = planVoiceSegments(STRIDE_SAMPLES + MIN_INPUT_SAMPLES);
    expect(keptOn).toHaveLength(2);
    expect(keptOn[1]).toEqual({
      start: STRIDE_SAMPLES,
      end: STRIDE_SAMPLES + MIN_INPUT_SAMPLES,
    });

    const keptAbove = planVoiceSegments(STRIDE_SAMPLES + MIN_INPUT_SAMPLES + 1);
    expect(keptAbove).toHaveLength(2);
  });

  test('a dropped tail is always already covered by the previous chunk', () => {
    // total < last start + MIN means total <= prev start + SEGMENT because
    // OVERLAP >= MIN — so the surviving last chunk must end at total.
    for (const total of [
      STRIDE_SAMPLES + 1,
      2 * STRIDE_SAMPLES + MIN_INPUT_SAMPLES - 1,
      3 * STRIDE_SAMPLES + 100,
    ]) {
      const plan = planVoiceSegments(total);
      expect(plan[plan.length - 1].end).toBe(total);
    }
  });

  test('multi-chunk plans tile [0, total) contiguously with the reference stride and stay HOP-aligned', () => {
    const total = 2 * STRIDE_SAMPLES + 50000;
    const plan = planVoiceSegments(total);
    expect(plan).toHaveLength(3);
    for (let i = 0; i < plan.length; i++) {
      expect(plan[i].start).toBe(i * STRIDE_SAMPLES);
      expect(plan[i].start % HOP_LENGTH).toBe(0);
      expect(plan[i].end).toBe(Math.min(i * STRIDE_SAMPLES + SEGMENT_SAMPLES, total));
      if (i > 0) {
        // Each chunk starts before the previous ends — no gap, real overlap.
        expect(plan[i].start).toBeLessThan(plan[i - 1].end);
      }
    }
    expect(plan[plan.length - 1].end).toBe(total);
  });

  test('30 s exactly (one SEGMENT) still follows the reference law: two chunks', () => {
    // ceil(SEGMENT/STRIDE) = 2 — the second chunk re-covers the overlap tail.
    const plan = planVoiceSegments(SEGMENT_SAMPLES);
    expect(plan).toEqual([
      { start: 0, end: SEGMENT_SAMPLES },
      { start: STRIDE_SAMPLES, end: SEGMENT_SAMPLES },
    ]);
  });
});

describe('makeVoiceWindow — the shared crossfade window at the VC size', () => {
  const w = makeVoiceWindow();

  test('shape: SEGMENT long, 0 at both ends, 1 in the flat middle', () => {
    expect(w.length).toBe(SEGMENT_SAMPLES);
    expect(w[0]).toBe(0);
    expect(w[SEGMENT_SAMPLES - 1]).toBe(0);
    expect(w[OVERLAP_SAMPLES - 1]).toBe(1); // linspace includes both endpoints
    expect(w[OVERLAP_SAMPLES]).toBe(1);
    expect(w[Math.floor(SEGMENT_SAMPLES / 2)]).toBe(1);
  });

  test('adjacent chunks sum to 1 across the whole overlap, to float32 rounding (probed at both edges and the middle)', () => {
    // Chunk i's sample STRIDE+t coincides with chunk i+1's sample t. The ramp
    // values are stored as float32, so the sum carries ~1 ULP (≈6e-8), not
    // float64 exactness.
    for (const t of [0, 1, Math.floor(OVERLAP_SAMPLES / 2), OVERLAP_SAMPLES - 2, OVERLAP_SAMPLES - 1]) {
      expect(w[STRIDE_SAMPLES + t] + w[t]).toBeCloseTo(1, 6);
    }
  });
});

describe('overlap-add accumulator — the reference math, mono', () => {
  test('the final chunk is always truncated, so only sample 0 carries the zero-weight quirk', () => {
    // The law plans nChunks = ceil(total/STRIDE); the last chunk's length is
    // total − (n−1)·STRIDE ≤ ... < SEGMENT always (a full-length final chunk
    // would need total = start + SEGMENT, which the ceil law follows with yet
    // another chunk). Probed across shapes rather than argued once.
    for (const total of [
      SEGMENT_SAMPLES,
      SEGMENT_SAMPLES + STRIDE_SAMPLES,
      2 * STRIDE_SAMPLES + SEGMENT_SAMPLES,
      5 * STRIDE_SAMPLES + 12345,
    ]) {
      const plan = planVoiceSegments(total);
      const last = plan[plan.length - 1];
      expect(last.end - last.start).toBeLessThan(SEGMENT_SAMPLES);
    }
  });

  test('overlapping segments of ones reconstruct ones everywhere except sample 0', () => {
    const total = SEGMENT_SAMPLES + STRIDE_SAMPLES;
    const plan = planVoiceSegments(total);
    expect(plan).toHaveLength(3); // full, full, truncated-to-OVERLAP tail
    const w = makeVoiceWindow();
    const acc = createVoiceAccumulator(total);
    const out = new Float32Array(total);
    for (let i = 0; i < plan.length; i++) {
      const seg = plan[i];
      accumulateVoiceSegment(acc, seg, new Float32Array(seg.end - seg.start).fill(1), w);
      const flushed = extractVoiceFinalized(acc, voiceFinalizedEnd(plan, i, total));
      if (flushed) out.set(flushed.data, flushed.offset);
    }

    // The documented reference quirk: sample 0 has window weight exactly 0
    // and normalises to exactly 0.
    expect(out[0]).toBe(0);
    // Everything else is exactly 1 — probed deep inside both crossfades, at
    // both crossfade edges, and at the very last sample.
    for (const t of [
      1,
      100,
      OVERLAP_SAMPLES,
      STRIDE_SAMPLES - 1,
      STRIDE_SAMPLES,
      STRIDE_SAMPLES + Math.floor(OVERLAP_SAMPLES / 2),
      SEGMENT_SAMPLES,
      total - 2,
      total - 1,
    ]) {
      expect(out[t]).toBeCloseTo(1, 5);
    }
  });

  test('progressive extraction equals one-shot extraction', () => {
    const total = 4096;
    const seg = { start: 0, end: total };
    const w = makeVoiceWindow();
    const data = new Float32Array(total);
    for (let i = 0; i < total; i++) data[i] = Math.sin(i / 7);

    const progressive = createVoiceAccumulator(total);
    accumulateVoiceSegment(progressive, seg, data, w);
    const first = extractVoiceFinalized(progressive, 1000);
    const second = extractVoiceFinalized(progressive, total);

    const oneShot = createVoiceAccumulator(total);
    accumulateVoiceSegment(oneShot, seg, data, w);
    const whole = extractVoiceFinalized(oneShot, total);

    expect(first.samples + second.samples).toBe(total);
    for (let t = 0; t < 1000; t++) expect(first.data[t]).toBe(whole.data[t]);
    for (let t = 0; t < second.samples; t++) expect(second.data[t]).toBe(whole.data[1000 + t]);
  });

  test('boundaries: short data throws, exact fits, flushing past total throws, empty flush is null', () => {
    const acc = createVoiceAccumulator(1000);
    const w = makeVoiceWindow();
    expect(() => accumulateVoiceSegment(acc, { start: 0, end: 500 }, new Float32Array(499), w)).toThrow(
      /499 < segment length 500/
    );
    accumulateVoiceSegment(acc, { start: 0, end: 500 }, new Float32Array(500), w);
    expect(() => extractVoiceFinalized(acc, 1001)).toThrow(/past total/);
    extractVoiceFinalized(acc, 500);
    expect(extractVoiceFinalized(acc, 500)).toBeNull();
  });

  test('weight epsilon is the reference value', () => {
    expect(WEIGHT_EPSILON).toBe(1e-8);
  });
});

describe('padToHopMultiple', () => {
  test('an exact multiple is returned as the same instance', () => {
    const x = new Float32Array(512);
    expect(padToHopMultiple(x)).toBe(x);
  });

  test('one short pads by one; one long pads to the next multiple; content preserved, tail zero', () => {
    const a = new Float32Array(511).fill(0.5);
    const pa = padToHopMultiple(a);
    expect(pa.length).toBe(512);
    expect(pa[510]).toBe(0.5);
    expect(pa[511]).toBe(0);

    const b = new Float32Array(513).fill(0.25);
    const pb = padToHopMultiple(b);
    expect(pb.length).toBe(768);
    expect(pb[512]).toBe(0.25);
    for (let i = 513; i < 768; i++) expect(pb[i]).toBe(0);
  });
});
