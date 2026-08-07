'use strict';

/**
 * Port-faithfulness tests for the HF reference segmentation
 * (StemSplitio/htdemucs-onnx `infer.py`, MIT) — plan ruling 5: ported, not
 * reinvented. Every constant and every property asserted here is the
 * reference's own behaviour, including its edge quirks (sample 0 gets zero
 * window weight and therefore normalises to exactly 0).
 */

const {
  MODEL_SAMPLE_RATE,
  SEGMENT_SAMPLES,
  OVERLAP_SAMPLES,
  STRIDE_SAMPLES,
  STEM_NAMES,
  STEM_COUNT,
  MODEL_CHANNELS,
  makeWindow,
  planSegments,
  createAccumulator,
  accumulateSegment,
  finalizedEnd,
  extractFinalized,
} = require('./stemSegmentation.cjs');

describe('constants (reference: infer.py)', () => {
  test('match the HF reference exactly', () => {
    expect(MODEL_SAMPLE_RATE).toBe(44100);
    // int(7.8 * 44100)
    expect(SEGMENT_SAMPLES).toBe(343980);
    // N_SAMPLES // 4
    expect(OVERLAP_SAMPLES).toBe(85995);
    expect(STRIDE_SAMPLES).toBe(343980 - 85995);
    expect(STEM_NAMES).toEqual(['drums', 'bass', 'other', 'vocals']);
    expect(STEM_COUNT).toBe(4);
    expect(MODEL_CHANNELS).toBe(2);
  });
});

describe('makeWindow (reference: _make_window)', () => {
  // Use a small window so endpoints are cheap to reason about; the production
  // window is the same code at (SEGMENT_SAMPLES, OVERLAP_SAMPLES).
  const n = 32;
  const overlap = 8;
  const w = makeWindow(n, overlap);

  test('linspace fade endpoints: w[0]=0, w[overlap-1]=1, w[n-overlap]=1, w[n-1]=0', () => {
    // np.linspace(0, 1, overlap) INCLUDES both endpoints; the tail is the
    // same ramp reversed. These endpoint values are the reference's exact
    // behaviour (fade[k] = k/(overlap-1)).
    expect(w[0]).toBe(0);
    expect(w[overlap - 1]).toBe(1);
    expect(w[n - overlap]).toBe(1);
    expect(w[n - 1]).toBe(0);
  });

  test('interior is exactly 1', () => {
    for (let i = overlap; i < n - overlap; i++) expect(w[i]).toBe(1);
  });

  test('fade is linear: fade[k] = k/(overlap-1)', () => {
    for (let k = 0; k < overlap; k++) {
      expect(w[k]).toBeCloseTo(k / (overlap - 1), 6);
      expect(w[n - 1 - k]).toBeCloseTo(k / (overlap - 1), 6);
    }
  });

  test('overlapped fade-out + next fade-in sum to 1 (weight complementarity)', () => {
    // In the overlap-add loop, absolute sample stride+k receives chunk i's
    // window[stride+k] (fade-out) and chunk i+1's window[k] (fade-in);
    // the linspace ramps are complementary so the summed weight is 1.
    for (let k = 0; k < overlap; k++) {
      expect(w[n - overlap + k] + w[k]).toBeCloseTo(1, 5);
    }
  });

  test('production window has the reference length', () => {
    const prod = makeWindow();
    expect(prod.length).toBe(SEGMENT_SAMPLES);
    expect(prod[0]).toBe(0);
    expect(prod[OVERLAP_SAMPLES - 1]).toBe(1);
  });
});

describe('planSegments (reference: chunk loop)', () => {
  test('short input (< one segment) is a single chunk ending at total', () => {
    const plan = planSegments(1000);
    expect(plan).toEqual([{ start: 0, end: 1000 }]);
  });

  test('n_chunks = max(1, ceil(total / stride)), start = i*stride, end = min(start+N, total)', () => {
    const total = MODEL_SAMPLE_RATE * 30; // the 30 s bench length
    const plan = planSegments(total);
    const expectedChunks = Math.ceil(total / STRIDE_SAMPLES);
    expect(plan.length).toBe(expectedChunks);
    plan.forEach((seg, i) => {
      expect(seg.start).toBe(i * STRIDE_SAMPLES);
      expect(seg.end).toBe(Math.min(seg.start + SEGMENT_SAMPLES, total));
    });
    // Full coverage: last chunk reaches the end.
    expect(plan[plan.length - 1].end).toBe(total);
  });

  test('exact multiple of stride does not produce an empty trailing chunk', () => {
    const total = STRIDE_SAMPLES * 3;
    const plan = planSegments(total);
    expect(plan.length).toBe(3);
    expect(plan[2].end).toBe(total);
    expect(plan[2].end - plan[2].start).toBeGreaterThan(0);
  });

  test('rejects nonsense totals', () => {
    expect(() => planSegments(0)).toThrow();
    expect(() => planSegments(-5)).toThrow();
    expect(() => planSegments(1.5)).toThrow();
    expect(() => planSegments(NaN)).toThrow();
  });
});

/** Builds a fake model output for a segment: each stem s and channel c gets
 * the chunk input scaled by a distinct factor, so cross-wiring of the
 * [stem][channel] layout shows up as a wrong scale. Layout matches the ORT
 * output tensor (1,4,2,SEGMENT_SAMPLES) row-major. */
function fakeStems(chunkL, chunkR, scale) {
  const data = new Float32Array(STEM_COUNT * MODEL_CHANNELS * SEGMENT_SAMPLES);
  for (let s = 0; s < STEM_COUNT; s++) {
    for (let c = 0; c < MODEL_CHANNELS; c++) {
      const src = c === 0 ? chunkL : chunkR;
      const base = (s * MODEL_CHANNELS + c) * SEGMENT_SAMPLES;
      const k = scale(s, c);
      for (let t = 0; t < src.length; t++) data[base + t] = src[t] * k;
    }
  }
  return data;
}

/** Zero-padded chunk of `src` covering [start, start+SEGMENT_SAMPLES). */
function chunkOf(src, start) {
  const out = new Float32Array(SEGMENT_SAMPLES);
  const end = Math.min(start + SEGMENT_SAMPLES, src.length);
  for (let t = start; t < end; t++) out[t - start] = src[t];
  return out;
}

describe('overlap-add accumulation + progressive finalize (reference: out/weight loops)', () => {
  // Total spanning 3 chunks with real overlaps, small enough to run fast:
  // use the real constants — 2.2 strides worth.
  const total = Math.floor(STRIDE_SAMPLES * 2.2);

  function runPipeline(scale) {
    // Deterministic pseudo-audio, distinct per channel.
    const left = new Float32Array(total);
    const right = new Float32Array(total);
    let x = 123456789;
    for (let t = 0; t < total; t++) {
      x = (x * 1103515245 + 12345) & 0x7fffffff;
      left[t] = (x / 0x3fffffff) - 1;
      right[t] = Math.sin(t * 0.01) * 0.5;
    }

    const plan = planSegments(total);
    const window = makeWindow();
    const acc = createAccumulator(total);
    const flushes = [];
    for (let i = 0; i < plan.length; i++) {
      const seg = plan[i];
      const stems = fakeStems(chunkOf(left, seg.start), chunkOf(right, seg.start), scale);
      accumulateSegment(acc, seg, stems, window);
      const upTo = finalizedEnd(plan, i, total);
      const flushed = extractFinalized(acc, upTo);
      if (flushed) flushes.push(flushed);
    }
    return { left, right, plan, flushes };
  }

  test('identity model reconstructs the input except the reference\'s zero-weight endpoints', () => {
    const { left, right, flushes } = runPipeline(() => 1);
    // Reassemble the flushed regions into full stem tracks.
    const stems = [];
    for (let i = 0; i < STEM_COUNT * MODEL_CHANNELS; i++) stems.push(new Float32Array(total));
    let covered = 0;
    for (const f of flushes) {
      expect(f.offset).toBe(covered); // contiguous, in order
      const len = f.samples;
      for (let sc = 0; sc < STEM_COUNT * MODEL_CHANNELS; sc++) {
        stems[sc].set(f.data.subarray(sc * len, (sc + 1) * len), f.offset);
      }
      covered = f.offset + len;
    }
    expect(covered).toBe(total);

    // Reference quirk, ported faithfully: sample 0 has window weight 0 in the
    // ONLY chunk that covers it, so it normalises to exactly 0.
    for (let sc = 0; sc < STEM_COUNT * MODEL_CHANNELS; sc++) {
      expect(stems[sc][0]).toBe(0);
    }
    // Everywhere else the weight-normalised overlap-add reproduces the input.
    for (let s = 0; s < STEM_COUNT; s++) {
      for (const [c, src] of [[0, left], [1, right]]) {
        const got = stems[s * MODEL_CHANNELS + c];
        let maxErr = 0;
        for (let t = 1; t < total; t++) {
          const err = Math.abs(got[t] - src[t]);
          if (err > maxErr) maxErr = err;
        }
        expect(maxErr).toBeLessThan(1e-5);
      }
    }
  });

  test('distinct per-stem/channel scales land in the right slots (no cross-wiring)', () => {
    const scale = (s, c) => 1 + s * 2 + c * 0.25;
    const { left, right, flushes } = runPipeline(scale);
    // Probe a mid-file sample far from any fade edge.
    const probe = Math.floor(STRIDE_SAMPLES * 1.5);
    let f = null;
    for (const cand of flushes) {
      if (probe >= cand.offset && probe < cand.offset + cand.samples) f = cand;
    }
    expect(f).not.toBeNull();
    const local = probe - f.offset;
    for (let s = 0; s < STEM_COUNT; s++) {
      for (const [c, src] of [[0, left], [1, right]]) {
        const got = f.data[(s * MODEL_CHANNELS + c) * f.samples + local];
        expect(got).toBeCloseTo(src[probe] * scale(s, c), 4);
      }
    }
  });

  test('progressive extraction equals the reference all-at-end normalisation', () => {
    // Reference computes out /= max(weight, 1e-8) over the WHOLE track at the
    // end; our per-segment flush must be numerically identical because each
    // flushed sample has already received every contribution.
    const scale = (s, c) => (s === 1 && c === 1 ? 0.5 : 1);
    const { flushes, plan, left, right } = runPipeline(scale);

    // Reference re-computation, single pass at the end.
    const window = makeWindow();
    const acc = createAccumulator(total);
    for (const seg of plan) {
      const stems = fakeStems(chunkOf(left, seg.start), chunkOf(right, seg.start), scale);
      accumulateSegment(acc, seg, stems, window);
    }
    const all = extractFinalized(acc, total);
    expect(all.offset).toBe(0);
    expect(all.samples).toBe(total);

    for (const f of flushes) {
      const len = f.samples;
      for (let sc = 0; sc < STEM_COUNT * MODEL_CHANNELS; sc++) {
        for (let t = 0; t < len; t += 997) { // stride the comparison, full compare is slow
          const ref = all.data[sc * total + (f.offset + t)];
          expect(f.data[sc * len + t]).toBe(ref);
        }
      }
    }
  });

  test('finalizedEnd: a sample is final once no later segment can touch it', () => {
    const plan = planSegments(total);
    for (let i = 0; i < plan.length - 1; i++) {
      expect(finalizedEnd(plan, i, total)).toBe(plan[i + 1].start);
    }
    expect(finalizedEnd(plan, plan.length - 1, total)).toBe(total);
  });

  test('extractFinalized returns null when nothing new is finalized, and never re-flushes', () => {
    const plan = planSegments(total);
    const window = makeWindow();
    const acc = createAccumulator(total);
    const seg = plan[0];
    const stems = fakeStems(chunkOf(new Float32Array(total), 0), chunkOf(new Float32Array(total), 0), () => 1);
    accumulateSegment(acc, seg, stems, window);
    const first = extractFinalized(acc, plan[1].start);
    expect(first).not.toBeNull();
    expect(extractFinalized(acc, plan[1].start)).toBeNull(); // same bound again
    expect(() => extractFinalized(acc, total + 1)).toThrow(); // beyond the track
  });
});
