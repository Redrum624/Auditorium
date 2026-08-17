import { silenceRemoverEffect } from './SilenceRemoverEffect';
import { registerAllEffects } from '../registerAll';
import { getAllEffects } from '../EffectRegistry';
import { envelopeFollower, maxAcrossChannels } from '../../dsp/envelope';
import type { SampleSpan } from '../../dsp/silenceDetect';

const SR = 44100;
const XFADE = 441; // SPLICE_XFADE_MS (10 ms) at 44.1 kHz

/** Cosine burst — first sample is `amp`, so the envelope leaves silence on
 * the burst's very first sample and detected runs end exactly at bursts. */
function cosBurst(samples: number, amp: number, freqHz = 1000): Float32Array {
  const out = new Float32Array(samples);
  for (let n = 0; n < samples; n++) out[n] = amp * Math.cos((2 * Math.PI * freqHz * n) / SR);
  return out;
}

function dc(samples: number, level: number): Float32Array {
  return new Float32Array(samples).fill(level);
}

/** Deterministic LCG noise, |value| <= amp. */
function noise(samples: number, amp: number, seed = 12345): Float32Array {
  const out = new Float32Array(samples);
  let x = seed;
  for (let n = 0; n < samples; n++) {
    x = (1103515245 * x + 12345) % 2147483648;
    out[n] = (x / 2147483648 - 0.5) * 2 * amp;
  }
  return out;
}

function concat(...parts: Float32Array[]): Float32Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Float32Array(total);
  let pos = 0;
  for (const p of parts) {
    out.set(p, pos);
    pos += p.length;
  }
  return out;
}

/** Independent reference for what the effect must pass its detector: the
 * shared envelope at LITERAL attack 1 / release 20, threshold 10^(dB/20),
 * minimum Math.round(ms/1000*sr) — the F1 lesson pins the wiring, not just
 * the pure stages. */
function referenceRuns(channel: Float32Array, thresholdDb: number, minSilenceMs: number): SampleSpan[] {
  const env = envelopeFollower(maxAcrossChannels([channel]), SR, 1, 20);
  const threshold = Math.pow(10, thresholdDb / 20);
  const minRun = Math.round((minSilenceMs / 1000) * SR);
  const runs: SampleSpan[] = [];
  let runStart = -1;
  for (let i = 0; i <= env.length; i++) {
    const silent = i < env.length && env[i] <= threshold;
    if (silent && runStart < 0) runStart = i;
    if (!silent && runStart >= 0) {
      if (i - runStart >= minRun) runs.push({ start: runStart, end: i });
      runStart = -1;
    }
  }
  return runs;
}

function run(
  channels: Float32Array[],
  params: Record<string, number | string | boolean> = {}
): { channels: Float32Array[]; removedSpans?: { start: number; end: number }[] } {
  return silenceRemoverEffect.process(channels, SR, params);
}

function expectByteIdentical(out: Float32Array, input: Float32Array): void {
  expect(out.length).toBe(input.length);
  // indexOf-style scan keeps the failure message small on long buffers.
  let firstDiff = -1;
  for (let i = 0; i < out.length; i++) {
    if (out[i] !== input[i]) {
      firstDiff = i;
      break;
    }
  }
  expect(firstDiff).toBe(-1);
}

describe('registration', () => {
  it('remove-silence is registered under Restoration with mode defaulting to Shorten', () => {
    registerAllEffects();
    const def = getAllEffects().find((e) => e.id === 'remove-silence');
    expect(def).toBeDefined();
    expect(def!.category).toBe('Restoration');
    expect(def!.params.find((p) => p.id === 'mode')!.default).toBe('shorten');
  });

  it('pins the derived parameter defaults (threshold -50 dB = the gate precedent; min 500 ms; pad 100 ms; target 400 ms)', () => {
    const byId = Object.fromEntries(silenceRemoverEffect.params.map((p) => [p.id, p.default]));
    expect(byId).toEqual({ thresholdDb: -50, minSilenceMs: 500, padMs: 100, mode: 'shorten', targetMs: 400 });
  });
});

describe('no-op configurations are byte-identical pass-throughs (ruling 4)', () => {
  it('nothing qualifies by duration: a 300 ms gap under the 500 ms minimum', () => {
    const input = concat(cosBurst(13230, 0.5), new Float32Array(13230), cosBurst(13230, 0.5));
    const result = run([input]);
    expect(result.removedSpans).toEqual([]);
    expect(result.channels[0]).not.toBe(input); // fresh array, never an alias
    expectByteIdentical(result.channels[0], input);
  });

  it('nothing qualifies by level: -45 dB room tone never drops below the -50 dB threshold', () => {
    const input = concat(cosBurst(13230, 0.5), dc(35280, 0.00562), cosBurst(13230, 0.5));
    const result = run([input]);
    expect(result.removedSpans).toEqual([]);
    expectByteIdentical(result.channels[0], input);
  });
});

describe('the speech-like fixture: exact gap count, exact removed duration (defaults: shorten to 400 ms)', () => {
  // 300 ms burst | 800 ms digital silence | 300 ms burst | 700 ms low noise
  // (0.001 ~ -60 dB, below the -50 dB threshold) | 300 ms burst.
  const burst = () => cosBurst(13230, 0.5);
  const input = concat(burst(), new Float32Array(35280), burst(), noise(30870, 0.001), burst());

  it('removes exactly the two qualifying gaps, each down to exactly 400 ms, with spans summing to the length delta', () => {
    const runs = referenceRuns(input, -50, 500);
    expect(runs).toHaveLength(2); // sanity: both gaps qualify, nothing else does
    expect(runs[0].end).toBe(13230 + 35280); // runs end exactly at the bursts
    expect(runs[1].end).toBe(13230 + 35280 + 13230 + 30870);

    const keptLen = Math.round(0.4 * SR); // 17640 > 2*pad + xfade = 9261
    const head = Math.floor((keptLen - XFADE) / 2); // 8599
    const tail = keptLen - XFADE - head; // 8600
    const expectedSpans = runs.map((r) => ({ start: r.start + head + XFADE, end: r.end - tail }));

    const result = run([input]);
    expect(result.removedSpans).toEqual(expectedSpans);

    const removedTotal = expectedSpans.reduce((n, s) => n + (s.end - s.start), 0);
    const out = result.channels[0];
    expect(out.length).toBe(input.length - removedTotal); // spans sum to the delta
    // Sanity: both runs strictly exceed the kept length (each gap shrank to
    // exactly keptLen = head + blend + tail = 400 ms, by the span geometry).
    for (const r of runs) expect(r.end - r.start).toBeGreaterThan(keptLen);

    // Untouched segments are byte-identical at their shifted positions
    // (output position of input p = p minus the removal before p).
    const cut0 = expectedSpans[0];
    const cut1 = expectedSpans[1];
    const len0 = cut0.end - cut0.start;
    // [0, blend0) verbatim — includes burst A and the head of gap 1.
    expect(Array.from(out.subarray(0, cut0.start - XFADE))).toEqual(
      Array.from(input.subarray(0, cut0.start - XFADE))
    );
    // Between the blends: tail of gap 1 + burst B + head of gap 2. The
    // resume point input[cut0.end] lands at output cut0.start (= cut0.end - len0).
    expect(Array.from(out.subarray(cut0.start, cut1.start - XFADE - len0))).toEqual(
      Array.from(input.subarray(cut0.end, cut1.start - XFADE))
    );
    // After blend 2: tail of gap 2 + burst C, shifted by both removals; the
    // resume point input[cut1.end] lands at output cut1.start - len0.
    expect(Array.from(out.subarray(cut1.start - len0))).toEqual(Array.from(input.subarray(cut1.end)));
  });

  it('does not mutate its input', () => {
    const copy = Float32Array.from(input);
    run([input]);
    expect(Array.from(input)).toEqual(Array.from(copy));
  });
});

describe('the minimum-duration boundary, through the effect (a detected run EXACTLY the minimum qualifies)', () => {
  // minSilenceMs 105 -> Math.round(4630.5) = 4631 samples: the .5 fraction
  // makes a round->floor mutation move the boundary by one sample, which the
  // +/-1 fixtures below turn into a cut/no-cut flip.
  const MIN_MS = 105;
  const MIN_SAMPLES = 4631;
  const PARAMS = { minSilenceMs: MIN_MS, padMs: 0, mode: 'remove' };

  function fixtureWithGap(gapSamples: number): Float32Array {
    return concat(cosBurst(8820, 0.5), new Float32Array(gapSamples), cosBurst(8820, 0.5));
  }

  // The detected run starts where the release decay crosses the threshold —
  // a fixed lag after the gap starts (the pre-gap burst is identical every
  // time) — and ends exactly at the second burst. Measure the lag once on a
  // probe gap, then size the real gap so the run is EXACTLY the minimum.
  const probeRuns = referenceRuns(fixtureWithGap(20000), -50, MIN_MS);
  const lag = probeRuns[0].start - 8820;

  it('sanity: the probe produced one run ending at the second burst', () => {
    expect(probeRuns).toHaveLength(1);
    expect(probeRuns[0].end).toBe(8820 + 20000);
    expect(lag).toBeGreaterThan(0);
  });

  it('a run exactly the minimum is cut; one sample shorter is byte-identical', () => {
    const exact = fixtureWithGap(MIN_SAMPLES + lag);
    const exactResult = run([exact], PARAMS);
    expect(exactResult.removedSpans).toHaveLength(1);
    expect(exactResult.channels[0].length).toBe(exact.length - (MIN_SAMPLES - XFADE));

    const under = fixtureWithGap(MIN_SAMPLES + lag - 1);
    const underResult = run([under], PARAMS);
    expect(underResult.removedSpans).toEqual([]);
    expectByteIdentical(underResult.channels[0], under);
  });
});

describe('gaps shorter than the minimum are left alone, and the samples around them are untouched', () => {
  it('a 300 ms gap survives byte-identically while an 800 ms gap in the same take is cut', () => {
    const burst = () => cosBurst(13230, 0.5);
    const shortGap = new Float32Array(13230);
    const longGap = new Float32Array(35280);
    const input = concat(burst(), shortGap, burst(), longGap, burst());

    const result = run([input]);
    expect(result.removedSpans).toHaveLength(1);
    const cut = result.removedSpans![0];
    // The single cut lies inside the LONG gap.
    expect(cut.start).toBeGreaterThan(13230 * 3);
    // Everything before the blend — burst A, the ENTIRE short gap, burst B and
    // the long gap's head — is byte-identical.
    const out = result.channels[0];
    expect(Array.from(out.subarray(0, cut.start - XFADE))).toEqual(
      Array.from(input.subarray(0, cut.start - XFADE))
    );
    // Everything after the cut is byte-identical at its shifted position:
    // the resume point input[cut.end] lands at output cut.start.
    expect(Array.from(out.subarray(cut.start))).toEqual(Array.from(input.subarray(cut.end)));
  });
});

describe('padding is honoured at both ends of every cut (remove mode keeps pad + blend + pad)', () => {
  it('keeps 100 ms of untouched silence against each speech edge on BOTH cuts', () => {
    const PAD = 4410; // 100 ms
    const burst = () => cosBurst(13230, 0.5);
    const gap = () => new Float32Array(35280);
    const input = concat(burst(), gap(), burst(), gap(), burst());
    const runs = referenceRuns(input, -50, 500);
    expect(runs).toHaveLength(2);

    const result = run([input], { mode: 'remove' });
    expect(result.removedSpans).toHaveLength(2);
    const out = result.channels[0];

    let shift = 0;
    for (let i = 0; i < 2; i++) {
      const r = runs[i];
      const span = result.removedSpans![i];
      // The cut's geometry: pad kept at the head, blend, pad kept at the tail.
      expect(span.start).toBe(r.start + PAD + XFADE);
      expect(span.end).toBe(r.end - PAD);
      // Head pad [r.start, r.start+PAD) sits verbatim before the blend.
      expect(Array.from(out.subarray(r.start - shift, r.start + PAD - shift))).toEqual(
        Array.from(input.subarray(r.start, r.start + PAD))
      );
      shift += span.end - span.start;
      // Tail pad [r.end-PAD, r.end) sits verbatim after the blend.
      expect(Array.from(out.subarray(r.end - PAD - shift, r.end - shift))).toEqual(
        Array.from(input.subarray(r.end - PAD, r.end))
      );
    }
  });
});

describe('the splice never clicks: bounded sample-to-sample step across the join', () => {
  it('joining -54 dB room tone to -60 dB room tone stays under the crossfade slope bound (a butt join would step 1e-3)', () => {
    // Gap of 1 s whose head is DC 0.002 and tail DC 0.001 — different noise
    // floors, the classic case where a butt join at a zero crossing still
    // clicks. padMs 5 keeps a DC tail pad after the blend so every step in
    // the measured window is splice-made, not the fixture's own burst onset.
    const input = concat(cosBurst(13230, 0.5), dc(22050, 0.002), dc(22050, 0.001), cosBurst(13230, 0.5));
    const result = run([input], { mode: 'remove', padMs: 5 });
    expect(result.removedSpans).toHaveLength(1);
    const span = result.removedSpans![0];
    const blendStart = span.start - XFADE; // output position === input position (before the cut)

    // |d out/d n| <= (pi/2)/(xfade-1) * (L1+L2): the gain slopes are bounded
    // by pi/2 per unit t and the sources are DC. 1.05 covers float rounding.
    const bound = ((Math.PI / 2) / (XFADE - 1)) * (0.002 + 0.001) * 1.05;
    const out = result.channels[0];
    let maxStep = 0;
    for (let n = blendStart - 2; n < blendStart + XFADE + 2; n++) {
      maxStep = Math.max(maxStep, Math.abs(out[n + 1] - out[n]));
    }
    expect(maxStep).toBeLessThan(bound); // ~1.1e-5, vs the 1e-3 butt-join step
    expect(maxStep).toBeGreaterThan(0); // sanity: the window did cross the blend
  });
});

describe('mode and unit-conversion wiring', () => {
  const burst = () => cosBurst(13230, 0.5);
  const input = concat(burst(), new Float32Array(66150), burst()); // 1.5 s gap
  const runs = referenceRuns(input, -50, 500);
  const runLen = runs[0].end - runs[0].start;

  it('shorten keeps max(target, 2*pad + blend) = 400 ms; remove keeps 2*pad + blend = 210 ms', () => {
    const shorten = run([input], { mode: 'shorten' });
    expect(shorten.channels[0].length).toBe(input.length - (runLen - 17640));
    const remove = run([input], { mode: 'remove' });
    expect(remove.channels[0].length).toBe(input.length - (runLen - (2 * 4410 + XFADE)));
  });

  it('thresholdDb reaches the detector as 10^(dB/20): -45 dB room tone flips from untouched to cut between thresholds -50 and -40', () => {
    const tone = concat(burst(), dc(35280, 0.00562), burst());
    const at50 = run([tone], { thresholdDb: -50, mode: 'remove', padMs: 0 });
    expect(at50.removedSpans).toEqual([]);
    expectByteIdentical(at50.channels[0], tone);
    const at40 = run([tone], { thresholdDb: -40, mode: 'remove', padMs: 0 });
    expect(at40.removedSpans).toHaveLength(1);
  });
});
