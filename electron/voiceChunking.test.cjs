'use strict';

/**
 * voiceChunking.cjs — the F3 pure-math layer: OpenVoice's spectrogram (ported
 * via the spike harness) and the measured seam design (constant-power 25 ms
 * crossfades with edge-frame discard — see the module header for the
 * measurements that forced it).
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
  EDGE_DISCARD_SAMPLES,
  CROSSFADE_SAMPLES,
  OVERLAP_SAMPLES,
  STRIDE_SAMPLES,
  CROSSFADE_OFFSET,
  framesForSamples,
  spectrogram,
  toFramesBins,
  planVoiceSegments,
  crossfadeStart,
  createVoiceAccumulator,
  accumulateVoiceSegment,
  voiceFinalizedEnd,
  extractVoiceFinalized,
  padToHopMultiple,
} = require('./voiceChunking.cjs');

/** The constant-power pair at crossfade position k, restated independently. */
function fadeIn(k) {
  return Math.sin((Math.PI / 2) * ((k + 0.5) / CROSSFADE_SAMPLES));
}
function fadeOut(k) {
  return Math.cos((Math.PI / 2) * ((k + 0.5) / CROSSFADE_SAMPLES));
}

describe('constants — every derivation restated independently', () => {
  test('model parameters match the spike tensor signature', () => {
    expect(VC_SAMPLE_RATE).toBe(22050);
    expect(N_FFT).toBe(1024);
    expect(HOP_LENGTH).toBe(256);
    expect(SPEC_BINS).toBe(513); // 1024/2 + 1
    expect(REFLECT_PAD).toBe(384); // (1024 - 256) / 2
    expect(MIN_INPUT_SAMPLES).toBe(385); // head reflection reads x[384]
  });

  test('segment/seam constants: ~30 s HOP-aligned segments, measured seam geometry', () => {
    expect(SEGMENT_SAMPLES).toBe(661504);
    // 30 s at 22050 = 661,500; SEGMENT is the next HOP multiple above it.
    expect(SEGMENT_SAMPLES % HOP_LENGTH).toBe(0);
    expect(SEGMENT_SAMPLES - 30 * VC_SAMPLE_RATE).toBeGreaterThanOrEqual(0);
    expect(SEGMENT_SAMPLES - 30 * VC_SAMPLE_RATE).toBeLessThan(HOP_LENGTH);
    // 64 STFT frames — the MEASURED extent of a chunk's context deficiency
    // (voiceChunking.cjs's header; sample level clean past 14,000 samples,
    // envelope artefact gone by ~20 frames). Deliberately NOT the 2-frame
    // figure the spectrogram geometry alone suggests: the decoder's context
    // reaches ~32x further than its analysis window does.
    expect(EDGE_DISCARD_SAMPLES).toBe(64 * HOP_LENGTH);
    expect(EDGE_DISCARD_SAMPLES).toBe(16384);
    expect(EDGE_DISCARD_SAMPLES).toBeGreaterThan(14000); // the measured floor
    // The remix engine's shipped default join crossfade: 25 ms.
    expect(CROSSFADE_SAMPLES).toBe(Math.round(0.025 * VC_SAMPLE_RATE));
    expect(CROSSFADE_SAMPLES).toBe(551);
    // Smallest HOP multiple that fits both margins plus the crossfade.
    expect(OVERLAP_SAMPLES).toBe(33536);
    expect(OVERLAP_SAMPLES % HOP_LENGTH).toBe(0);
    expect(OVERLAP_SAMPLES).toBeGreaterThanOrEqual(2 * EDGE_DISCARD_SAMPLES + CROSSFADE_SAMPLES);
    expect(OVERLAP_SAMPLES - HOP_LENGTH).toBeLessThan(2 * EDGE_DISCARD_SAMPLES + CROSSFADE_SAMPLES);
    expect(STRIDE_SAMPLES).toBe(SEGMENT_SAMPLES - OVERLAP_SAMPLES);
    expect(STRIDE_SAMPLES % HOP_LENGTH).toBe(0);
    // Crossfade centred between the discard margins.
    expect(CROSSFADE_OFFSET).toBe(
      EDGE_DISCARD_SAMPLES +
        Math.floor((OVERLAP_SAMPLES - 2 * EDGE_DISCARD_SAMPLES - CROSSFADE_SAMPLES) / 2)
    );
    expect(CROSSFADE_OFFSET + CROSSFADE_SAMPLES + EDGE_DISCARD_SAMPLES).toBeLessThanOrEqual(OVERLAP_SAMPLES);
    // The plan's drop-short-tail proof needs OVERLAP >= MIN.
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
        expect(Math.abs(spec[k * frames + f] - expected[k])).toBeLessThan(1e-3);
      }
    }
  });

  test('reflection matters: mutating the head of the input changes frame 0 but not an interior frame', () => {
    const n = 2048;
    const a = new Float32Array(n).fill(0.1);
    const b = Float32Array.from(a);
    b[0] = 0.9;
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

describe('planVoiceSegments — the chunk law plus the short-tail rule', () => {
  test('boundary: below MIN throws, MIN plans one chunk', () => {
    expect(() => planVoiceSegments(MIN_INPUT_SAMPLES - 1)).toThrow(/>= 385/);
    expect(planVoiceSegments(MIN_INPUT_SAMPLES)).toEqual([{ start: 0, end: MIN_INPUT_SAMPLES }]);
  });

  test('single chunk up to STRIDE; one past STRIDE plans a 1-sample tail that is dropped', () => {
    expect(planVoiceSegments(STRIDE_SAMPLES)).toEqual([{ start: 0, end: STRIDE_SAMPLES }]);
    expect(planVoiceSegments(STRIDE_SAMPLES + 1)).toEqual([{ start: 0, end: STRIDE_SAMPLES + 1 }]);
  });

  test('short-tail rule boundary: a tail of OVERLAP−1 is dropped, OVERLAP is kept, OVERLAP+1 is kept', () => {
    const dropped = planVoiceSegments(STRIDE_SAMPLES + OVERLAP_SAMPLES - 1);
    expect(dropped).toHaveLength(1);
    expect(dropped[0]).toEqual({ start: 0, end: STRIDE_SAMPLES + OVERLAP_SAMPLES - 1 });

    const keptOn = planVoiceSegments(STRIDE_SAMPLES + OVERLAP_SAMPLES);
    expect(keptOn).toHaveLength(2);
    expect(keptOn[1]).toEqual({
      start: STRIDE_SAMPLES,
      end: STRIDE_SAMPLES + OVERLAP_SAMPLES,
    });

    expect(planVoiceSegments(STRIDE_SAMPLES + OVERLAP_SAMPLES + 1)).toHaveLength(2);
  });

  test('a dropped tail is always already covered by the previous chunk', () => {
    for (const total of [
      STRIDE_SAMPLES + 1,
      2 * STRIDE_SAMPLES + OVERLAP_SAMPLES - 1,
      3 * STRIDE_SAMPLES + 100,
    ]) {
      const plan = planVoiceSegments(total);
      expect(plan[plan.length - 1].end).toBe(total);
    }
  });

  test('every surviving seam has EXACTLY the full overlap, HOP-aligned starts, contiguous tiling', () => {
    for (const total of [
      STRIDE_SAMPLES + OVERLAP_SAMPLES,
      2 * STRIDE_SAMPLES + 50000,
      3 * STRIDE_SAMPLES + SEGMENT_SAMPLES, // forces a full-length interior chunk
      5 * STRIDE_SAMPLES + 123456,
    ]) {
      const plan = planVoiceSegments(total);
      expect(plan.length).toBeGreaterThan(1);
      for (let i = 0; i < plan.length; i++) {
        expect(plan[i].start).toBe(i * STRIDE_SAMPLES);
        expect(plan[i].start % HOP_LENGTH).toBe(0);
        expect(plan[i].end).toBe(Math.min(i * STRIDE_SAMPLES + SEGMENT_SAMPLES, total));
        if (i > 0) {
          // The seam invariant the splice geometry depends on.
          expect(plan[i - 1].end - plan[i].start).toBe(OVERLAP_SAMPLES);
        }
      }
      expect(plan[plan.length - 1].end).toBe(total);
    }
  });

  test("crossfadeStart sits past the later chunk's discard margin and inside the overlap", () => {
    const plan = planVoiceSegments(2 * STRIDE_SAMPLES + 50000);
    for (let i = 0; i + 1 < plan.length; i++) {
      const xf = crossfadeStart(plan, i);
      expect(xf).toBe(plan[i + 1].start + CROSSFADE_OFFSET);
      expect(xf).toBeGreaterThanOrEqual(plan[i + 1].start + EDGE_DISCARD_SAMPLES);
      expect(xf + CROSSFADE_SAMPLES).toBeLessThanOrEqual(plan[i].end - EDGE_DISCARD_SAMPLES);
    }
  });
});

describe('the constant-power splice', () => {
  test('the two fades sum to power 1 at every probed crossfade position', () => {
    for (const k of [0, 1, Math.floor(CROSSFADE_SAMPLES / 2), CROSSFADE_SAMPLES - 2, CROSSFADE_SAMPLES - 1]) {
      expect(fadeIn(k) ** 2 + fadeOut(k) ** 2).toBeCloseTo(1, 12);
    }
  });

  test('two chunks of ones splice to exactly 1 outside the crossfade and to the analytic sin+cos inside', () => {
    const total = STRIDE_SAMPLES + OVERLAP_SAMPLES;
    const plan = planVoiceSegments(total);
    expect(plan).toHaveLength(2);
    const acc = createVoiceAccumulator(total);
    for (let i = 0; i < plan.length; i++) {
      accumulateVoiceSegment(acc, plan, i, new Float32Array(plan[i].end - plan[i].start).fill(1));
    }
    const out = extractVoiceFinalized(acc, total).data;
    const xf = crossfadeStart(plan, 0);

    // Outside the crossfade: bit-exact ones — including sample 0 (the old
    // overlap-add's zero-weight quirk is gone by construction) and the seam's
    // both edges.
    for (const t of [0, 1, 1000, xf - 2, xf - 1, xf + CROSSFADE_SAMPLES, total - 1]) {
      expect(out[t]).toBe(1);
    }
    // Inside: the constant-power pair applied to identical material sums
    // above 1 (up to √2) — the analytic value, exactly.
    for (const k of [0, 1, Math.floor(CROSSFADE_SAMPLES / 2), CROSSFADE_SAMPLES - 1]) {
      expect(out[xf + k]).toBeCloseTo(fadeIn(k) + fadeOut(k), 5);
    }
    expect(out[xf + Math.floor(CROSSFADE_SAMPLES / 2)]).toBeGreaterThan(1.4);
  });

  test('EDGE DISCARD: contaminated chunk-edge samples never reach the output (boundaries probed)', () => {
    const total = STRIDE_SAMPLES + OVERLAP_SAMPLES;
    const plan = planVoiceSegments(total);
    const S = plan[1].start;
    const xf = crossfadeStart(plan, 0);
    const POISON = 999;
    /** Chunk 0's index for global sample t (its start is 0, but say so). */
    const i0 = (t) => t - plan[0].start;
    const i1 = (t) => t - S;

    /** Splices both chunks from all-ones after `mutate` poisons samples. */
    function splice(mutate) {
      const d0 = new Float32Array(plan[0].end - plan[0].start).fill(1);
      const d1 = new Float32Array(plan[1].end - plan[1].start).fill(1);
      if (mutate) mutate(d0, d1);
      const acc = createVoiceAccumulator(total);
      accumulateVoiceSegment(acc, plan, 0, d0);
      accumulateVoiceSegment(acc, plan, 1, d1);
      return extractVoiceFinalized(acc, total).data;
    }
    function maxAbsDiff(a, b) {
      let m = 0;
      for (let t = 0; t < total; t++) m = Math.max(m, Math.abs(a[t] - b[t]));
      return m;
    }
    function maxOf(a) {
      let m = 0;
      for (let t = 0; t < total; t++) m = Math.max(m, a[t]);
      return m;
    }

    // The clean splice every probe below is measured against.
    const baseline = splice(null);
    expect(maxOf(baseline)).toBeLessThan(1.5); // ones, plus sin+cos <= sqrt(2)

    // ---- POSITIVE: the whole discarded region is invisible -----------------
    // Poison chunk 1's samples BEFORE the crossfade (its 512-sample
    // reflection-contaminated head plus the centring slack) and chunk 0's
    // samples AFTER its contribution window (which covers its own
    // contaminated 512-sample tail — asserted below, not assumed).
    expect(xf - S).toBeGreaterThanOrEqual(EDGE_DISCARD_SAMPLES);
    expect(plan[0].end - (xf + CROSSFADE_SAMPLES)).toBeGreaterThanOrEqual(EDGE_DISCARD_SAMPLES);
    const discarded = splice((d0, d1) => {
      for (let t = 0; t < xf - S; t++) d1[t] = POISON;
      for (let t = i0(xf + CROSSFADE_SAMPLES); t < d0.length; t++) d0[t] = POISON;
    });
    // Not merely "bounded" — BIT-IDENTICAL to the clean splice. A 999 in the
    // discard margin does not perturb the output by one ulp.
    expect(maxAbsDiff(discarded, baseline)).toBe(0);
    expect(maxOf(discarded)).toBeLessThan(1.5);

    // ---- NEGATIVE CONTROL: the same poison INSIDE the window surfaces ------
    // Without this the assertion above is vacuous. Probed at BOTH ends of the
    // weight range, because the constant-power fade spans three orders of
    // magnitude across the seam and a single threshold cannot judge both.
    //
    // (a) Full weight (w = 1) — chunk 0's body, and chunk 1's body past the
    //     crossfade. The poison arrives EXACTLY, 666x above the 1.5 bound the
    //     positive assertion uses, so the two blocks are the same measurement.
    const body = splice((d0, d1) => {
      d0[i0(1000)] = POISON;
      d1[i1(xf + CROSSFADE_SAMPLES)] = POISON;
    });
    expect(body[1000]).toBe(POISON);
    expect(body[xf + CROSSFADE_SAMPLES]).toBe(POISON);
    expect(maxOf(body)).toBeGreaterThan(1.5); // breaks the positive bound

    // (b) ON the boundary — the FIRST sample chunk 1 contributes and the LAST
    //     sample chunk 0 contributes. These are the weakest points the discard
    //     margin defends: the constant-power weight there is
    //     sin(pi/2 * 0.5/551) = 0.00142540, so a 999 poison can only move the
    //     output by 1.42. That is why this probe is judged against the
    //     ANALYTIC value rather than a round threshold — and 1.42 is still
    //     enough to break the 1.5 bound above, which is the point: even at its
    //     weakest, an unguarded edge sample WOULD be visible.
    const onEdge = splice((d0, d1) => {
      d0[i0(xf + CROSSFADE_SAMPLES - 1)] = POISON; // last contributing sample
      d1[i1(xf)] = POISON; // first contributing sample
    });
    const k = CROSSFADE_SAMPLES - 1;
    expect(onEdge[xf]).toBeCloseTo(fadeOut(0) + POISON * fadeIn(0), 4);
    expect(onEdge[xf + k]).toBeCloseTo(POISON * fadeOut(k) + fadeIn(k), 4);
    expect(onEdge[xf] - baseline[xf]).toBeCloseTo((POISON - 1) * fadeIn(0), 4);
    expect(maxOf(onEdge)).toBeGreaterThan(1.5); // breaks the positive bound too
    // Sanity on the weight itself, so the small numbers above are understood
    // as the fade's design and not as the probe failing to land.
    expect(fadeIn(0)).toBeCloseTo(0.00142540453, 10);

    // (c) JUST OUTSIDE the boundary — one sample earlier for chunk 1, one
    //     later for chunk 0. Nothing changes, anywhere, at all. Together with
    //     (b) this pins the contribution window's extent to the exact sample
    //     in both directions rather than merely pinning that it exists.
    const offEdge = splice((d0, d1) => {
      d0[i0(xf + CROSSFADE_SAMPLES)] = POISON; // first NON-contributing sample
      d1[i1(xf - 1)] = POISON; // last discarded sample
    });
    expect(maxAbsDiff(offEdge, baseline)).toBe(0);
  });

  test('progressive extraction equals one-shot, split at the seam law voiceFinalizedEnd states', () => {
    const total = STRIDE_SAMPLES + OVERLAP_SAMPLES;
    const plan = planVoiceSegments(total);
    const data = plan.map((seg) => {
      const d = new Float32Array(seg.end - seg.start);
      for (let i = 0; i < d.length; i++) d[i] = Math.sin((seg.start + i) / 7);
      return d;
    });

    const progressive = createVoiceAccumulator(total);
    const flushed = [];
    for (let i = 0; i < plan.length; i++) {
      accumulateVoiceSegment(progressive, plan, i, data[i]);
      const region = extractVoiceFinalized(progressive, voiceFinalizedEnd(plan, i, total));
      if (region) flushed.push(region);
    }
    expect(flushed[0].offset).toBe(0);
    expect(flushed[0].samples).toBe(crossfadeStart(plan, 0)); // the seam law
    expect(flushed[1].offset + flushed[1].samples).toBe(total);

    const oneShot = createVoiceAccumulator(total);
    for (let i = 0; i < plan.length; i++) accumulateVoiceSegment(oneShot, plan, i, data[i]);
    const whole = extractVoiceFinalized(oneShot, total).data;
    let cursor = 0;
    for (const region of flushed) {
      for (let t = 0; t < region.samples; t++) {
        expect(region.data[t]).toBe(whole[cursor + t]);
      }
      cursor += region.samples;
    }
    expect(cursor).toBe(total);
  });

  test('boundaries: short data throws, flushing past total throws, empty flush is null', () => {
    const plan = [{ start: 0, end: 1000 }];
    const acc = createVoiceAccumulator(1000);
    expect(() => accumulateVoiceSegment(acc, plan, 0, new Float32Array(999))).toThrow(
      /999 < segment length 1000/
    );
    accumulateVoiceSegment(acc, plan, 0, new Float32Array(1000));
    expect(() => extractVoiceFinalized(acc, 1001)).toThrow(/past total/);
    extractVoiceFinalized(acc, 1000);
    expect(extractVoiceFinalized(acc, 1000)).toBeNull();
  });

  test('a single-chunk plan is a bit-exact copy end to end', () => {
    const plan = planVoiceSegments(4096);
    const data = new Float32Array(4096);
    for (let i = 0; i < data.length; i++) data[i] = Math.cos(i / 11);
    const acc = createVoiceAccumulator(4096);
    accumulateVoiceSegment(acc, plan, 0, data);
    const out = extractVoiceFinalized(acc, 4096).data;
    for (const t of [0, 1, 2048, 4094, 4095]) expect(out[t]).toBe(data[t]);
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
