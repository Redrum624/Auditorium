import {
  DETECT_ATTACK_MS,
  DETECT_RELEASE_MS,
  SPLICE_XFADE_MS,
  detectSilentRuns,
  findRunsBelow,
  planSilenceCuts,
  spliceCuts,
  type SampleSpan,
  type SilenceCut,
} from './silenceDetect';
import { envelopeFollower, maxAcrossChannels } from './envelope';

const SR = 44100;

/** 2^-10 — exactly representable in float32, so `0.5 ± STEP` probes sit
 * exactly one clean quantum on either side of the 0.5 boundary. */
const STEP = 2 ** -10;

function spans(runs: SampleSpan[]): number[][] {
  return runs.map((r) => [r.start, r.end]);
}

describe('findRunsBelow — the threshold comparison, probed per operand role', () => {
  it('env below / ON / above the threshold: a sample exactly AT the threshold is silent (pins <=, the gate convention)', () => {
    // Three candidate runs of 3, differing only in level vs threshold 0.5.
    const below = Float32Array.of(1, 0.5 - STEP, 0.5 - STEP, 0.5 - STEP, 1);
    const on = Float32Array.of(1, 0.5, 0.5, 0.5, 1);
    const above = Float32Array.of(1, 0.5 + STEP, 0.5 + STEP, 0.5 + STEP, 1);
    expect(spans(findRunsBelow(below, 0.5, 3))).toEqual([[1, 4]]);
    expect(spans(findRunsBelow(on, 0.5, 3))).toEqual([[1, 4]]); // equality is silent
    expect(spans(findRunsBelow(above, 0.5, 3))).toEqual([]);
  });

  it('threshold operand: same env, threshold below / ON / above the env level', () => {
    const env = Float32Array.of(0.5, 0.5, 0.5);
    expect(spans(findRunsBelow(env, 0.5 - STEP, 3))).toEqual([]);
    expect(spans(findRunsBelow(env, 0.5, 3))).toEqual([[0, 3]]); // equality is silent
    expect(spans(findRunsBelow(env, 0.5 + STEP, 3))).toEqual([[0, 3]]);
  });
});

describe('findRunsBelow — the minimum-run comparison, probed per operand role', () => {
  // One interior run of exactly 5 silent samples.
  const env = Float32Array.of(1, 0, 0, 0, 0, 0, 1);

  it('minRunSamples below / ON / above the run length: a run exactly the minimum qualifies (pins >=)', () => {
    expect(spans(findRunsBelow(env, 0.5, 4))).toEqual([[1, 6]]);
    expect(spans(findRunsBelow(env, 0.5, 5))).toEqual([[1, 6]]); // exact length qualifies
    expect(spans(findRunsBelow(env, 0.5, 6))).toEqual([]);
  });

  it('run-length operand: fixed minimum 5, runs of length 4 / 5 / 6', () => {
    const run4 = Float32Array.of(1, 0, 0, 0, 0, 1);
    const run6 = Float32Array.of(1, 0, 0, 0, 0, 0, 0, 1);
    expect(spans(findRunsBelow(run4, 0.5, 5))).toEqual([]);
    expect(spans(findRunsBelow(env, 0.5, 5))).toEqual([[1, 6]]);
    expect(spans(findRunsBelow(run6, 0.5, 5))).toEqual([[1, 7]]);
  });
});

describe('findRunsBelow — run geometry', () => {
  it('reports leading, trailing, and whole-buffer runs (edge silence is still silence)', () => {
    expect(spans(findRunsBelow(Float32Array.of(0, 0, 0, 1, 1), 0.5, 2))).toEqual([[0, 3]]);
    expect(spans(findRunsBelow(Float32Array.of(1, 1, 0, 0, 0), 0.5, 2))).toEqual([[2, 5]]);
    expect(spans(findRunsBelow(Float32Array.of(0, 0, 0, 0), 0.5, 2))).toEqual([[0, 4]]);
  });

  it('a single loud sample splits two runs (no bridging)', () => {
    const env = Float32Array.of(0, 0, 0, 1, 0, 0, 0);
    expect(spans(findRunsBelow(env, 0.5, 3))).toEqual([
      [0, 3],
      [4, 7],
    ]);
  });

  it('empty env yields no runs', () => {
    expect(findRunsBelow(new Float32Array(0), 0.5, 1)).toEqual([]);
  });
});

/** Cosine burst at `amp` — first sample is `amp` (NOT zero), so the envelope
 * jumps above any pause threshold on the burst's very first sample and a
 * detected run's end lands exactly at the burst boundary. */
function cosBurst(samples: number, amp: number, freqHz = 1000): Float32Array {
  const out = new Float32Array(samples);
  for (let n = 0; n < samples; n++) out[n] = amp * Math.cos((2 * Math.PI * freqHz * n) / SR);
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

describe('detectSilentRuns — wiring of detector signal, envelope constants and unit conversions', () => {
  it('matches an independent reference scan: envelope of max(|ch|) at attack 1 ms / release 20 ms, threshold 10^(dB/20), min Math.round(ms/1000*sr)', () => {
    // 300 ms burst, 800 ms digital silence, 300 ms burst. The run starts
    // where the release decay crosses the threshold (~101 ms into the gap for
    // 0.5 vs -50 dB) and ends exactly at the second burst's first sample.
    const channel = concat(cosBurst(13230, 0.5), new Float32Array(35280), cosBurst(13230, 0.5));
    // Reference: the constants are written as literals HERE so a drifted
    // DETECT_ATTACK_MS / DETECT_RELEASE_MS in the implementation goes red.
    const env = envelopeFollower(maxAcrossChannels([channel]), SR, 1, 20);
    const threshold = Math.pow(10, -50 / 20);
    const minRun = Math.round((500 / 1000) * SR);
    const expected: SampleSpan[] = [];
    let runStart = -1;
    for (let i = 0; i <= env.length; i++) {
      const silent = i < env.length && env[i] <= threshold;
      if (silent && runStart < 0) runStart = i;
      if (!silent && runStart >= 0) {
        if (i - runStart >= minRun) expected.push({ start: runStart, end: i });
        runStart = -1;
      }
    }
    expect(expected).toHaveLength(1); // sanity: the fixture produces one qualifying run
    expect(expected[0].end).toBe(13230 + 35280); // ends exactly at the second burst
    expect(detectSilentRuns([channel], SR, -50, 500)).toEqual(expected);
  });

  it('uses max across ALL channels: a gap on one channel is not silence while another channel is loud', () => {
    // ch0 is all digital silence (a whole-file run on its own); ch1 is loud
    // throughout. A detector reading only channels[0] would report a run.
    const ch0 = new Float32Array(SR);
    const ch1 = cosBurst(SR, 0.5);
    expect(detectSilentRuns([ch0, ch1], SR, -50, 500)).toEqual([]);
    // Control: ch0 alone IS one whole-file run.
    expect(spans(detectSilentRuns([ch0], SR, -50, 500))).toEqual([[0, SR]]);
  });

  it('empty input yields no runs', () => {
    expect(detectSilentRuns([], SR, -50, 500)).toEqual([]);
    expect(detectSilentRuns([new Float32Array(0)], SR, -50, 500)).toEqual([]);
  });
});

describe('planSilenceCuts — kept-length arithmetic', () => {
  const PAD = 100;
  const X = 441;

  it('remove mode: keeps exactly pad + blend + pad, removes the rest', () => {
    const cuts = planSilenceCuts([{ start: 1000, end: 11000 }], {
      mode: 'remove',
      padSamples: PAD,
      targetSamples: 99999, // must be ignored in remove mode
      xfadeSamples: X,
    });
    expect(cuts).toEqual([
      {
        fadeOutStart: 1100, // run.start + pad
        fadeInStart: 10459, // run.end - pad - xfade
        xfade: X,
        removed: { start: 1541, end: 10900 }, // length 9359 = 10000 - (2*100+441)
      },
    ]);
  });

  it('run length below / ON / above keptLen: a run exactly keptLen long is skipped, one sample longer removes exactly one sample', () => {
    const opts = { mode: 'remove' as const, padSamples: PAD, targetSamples: 0, xfadeSamples: X };
    const kept = 2 * PAD + X; // 641
    expect(planSilenceCuts([{ start: 0, end: kept - 1 }], opts)).toEqual([]);
    expect(planSilenceCuts([{ start: 0, end: kept }], opts)).toEqual([]); // nothing to remove
    const cuts = planSilenceCuts([{ start: 0, end: kept + 1 }], opts);
    expect(cuts).toHaveLength(1);
    expect(cuts[0].removed.end - cuts[0].removed.start).toBe(1);
  });

  it('shorten mode: target below / ON / above the padded floor (2*pad + xfade) — the floor wins below and on, the target above', () => {
    const runs = [{ start: 0, end: 2000 }];
    const floor = 2 * PAD + X; // 641
    const removedLen = (target: number) => {
      const [cut] = planSilenceCuts(runs, { mode: 'shorten', padSamples: PAD, targetSamples: target, xfadeSamples: X });
      return cut.removed.end - cut.removed.start;
    };
    expect(removedLen(floor - 1)).toBe(2000 - floor);
    expect(removedLen(floor)).toBe(2000 - floor);
    expect(removedLen(floor + 1)).toBe(2000 - floor - 1);
  });

  it('splits the kept non-blend silence head = floor, tail = the odd sample', () => {
    const [cut] = planSilenceCuts([{ start: 0, end: 2000 }], {
      mode: 'shorten',
      padSamples: PAD,
      targetSamples: 642, // keptLen 642, minus xfade 441 -> 201: head 100, tail 101
      xfadeSamples: X,
    });
    expect(cut.fadeOutStart).toBe(100);
    expect(cut.removed).toEqual({ start: 541, end: 1899 }); // end - tail = 2000 - 101
    expect(cut.fadeInStart).toBe(1899 - 441);
  });

  it('a non-positive xfade request is clamped to one sample (pure-function guard)', () => {
    const [cut] = planSilenceCuts([{ start: 0, end: 100 }], {
      mode: 'remove',
      padSamples: 2,
      targetSamples: 0,
      xfadeSamples: 0,
    });
    expect(cut.xfade).toBe(1);
    expect(cut.removed).toEqual({ start: 3, end: 98 });
  });

  it('plans one cut per qualifying run, in order', () => {
    const cuts = planSilenceCuts(
      [
        { start: 0, end: 5000 },
        { start: 6000, end: 6100 }, // too short: skipped
        { start: 9000, end: 15000 },
      ],
      { mode: 'remove', padSamples: PAD, targetSamples: 0, xfadeSamples: X }
    );
    expect(cuts.map((c) => c.removed)).toEqual([
      { start: 541, end: 4900 }, // run.start + pad + xfade = 0 + 100 + 441
      { start: 9541, end: 14900 },
    ]);
  });
});

describe('spliceCuts — assembly and the crossfade law', () => {
  function ramp(n: number): Float32Array {
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = i;
    return out;
  }

  const CUT: SilenceCut = { fadeOutStart: 500, fadeInStart: 900, xfade: 100, removed: { start: 600, end: 1000 } };

  it('zero cuts: byte-identical pass-through into NEW arrays (never aliases the input)', () => {
    const input = cosBurst(1000, 0.5);
    const [out] = spliceCuts([input], []);
    expect(out).not.toBe(input);
    expect(Array.from(out)).toEqual(Array.from(input));
  });

  it('copies verbatim outside the blend, is sample-continuous at both blend boundaries, and shortens by exactly the removed span', () => {
    const input = ramp(2000);
    const [out] = spliceCuts([input], [CUT]);
    expect(out.length).toBe(1600);
    // Verbatim before the blend, including the blend's first sample (t=0:
    // gains are exactly 1/0, so out[500] IS input[500]).
    expect(Array.from(out.subarray(0, 501))).toEqual(Array.from(input.subarray(0, 501)));
    // Last blend sample (t=1): sin(pi/2)=1 exactly, cos(pi/2)~6e-17, so it
    // equals the gap-tail sample to a ~1e-14 residue.
    expect(out[599]).toBeCloseTo(input[999], 7);
    // Verbatim from the resume point.
    expect(Array.from(out.subarray(600))).toEqual(Array.from(input.subarray(1000)));
  });

  it('blends through crossfadeGains at rho 0: two equal DC sides hold sqrt(2) at the centre, never a dip', () => {
    // Equal DC on both sides of the blend: at t=0.5 the equal-power pair at
    // rho 0 sums to (cos+sin)(pi/4) = sqrt(2) — the law is level-preserving
    // for UNCORRELATED sides; identical DC is the worst-case correlated
    // fixture and bounds the bump at +3.01 dB. xfade 101 (odd) so sample
    // i=50 sits at exactly t = 50/100 = 0.5.
    const input = new Float32Array(2000).fill(0.001);
    const cut: SilenceCut = { fadeOutStart: 500, fadeInStart: 899, xfade: 101, removed: { start: 601, end: 1000 } };
    const [out] = spliceCuts([input], [cut]);
    expect(out[550]).toBeCloseTo(0.001 * Math.SQRT2, 9);
    // At the CENTRE every k-normalised curve coincides on equal DC (mutation
    // check: swapping the curve survived a centre-only probe), so the curve
    // identity is pinned OFF-centre: at t=0.25 equal-power sums to
    // cos(pi/8)+sin(pi/8) = 1.30656, where normalised equal-gain would give
    // 1.0/sqrt(0.625) = 1.26491.
    expect(out[525]).toBeCloseTo(0.001 * (Math.cos(Math.PI / 8) + Math.sin(Math.PI / 8)), 9);
  });

  it('singleton blend (xfade 1) uses the t=0.5 convention from mixdown.ts', () => {
    const input = ramp(30);
    const cut: SilenceCut = { fadeOutStart: 10, fadeInStart: 19, xfade: 1, removed: { start: 11, end: 20 } };
    const [out] = spliceCuts([input], [cut]);
    const g = Math.SQRT1_2; // cos(pi/4) = sin(pi/4), k = 1 at rho 0
    expect(out[10]).toBeCloseTo(g * (input[10] + input[19]), 5); // float32 store rounds the last digit
    expect(out.length).toBe(30 - 9);
  });

  it('two cuts: cumulative shifts place every kept segment exactly', () => {
    const input = ramp(500);
    const cuts: SilenceCut[] = [
      { fadeOutStart: 100, fadeInStart: 190, xfade: 10, removed: { start: 110, end: 200 } },
      { fadeOutStart: 300, fadeInStart: 390, xfade: 10, removed: { start: 310, end: 400 } },
    ];
    const [out] = spliceCuts([input], cuts);
    expect(out.length).toBe(500 - 180);
    // Between the cuts: input[200..300) lands at out[110..210).
    expect(Array.from(out.subarray(110, 210))).toEqual(Array.from(input.subarray(200, 300)));
    // After the second cut: input[400..500) lands at out[220..320).
    expect(Array.from(out.subarray(220))).toEqual(Array.from(input.subarray(400)));
  });

  it('splices every channel at identical positions', () => {
    const left = ramp(2000);
    const right = ramp(2000).map((v) => -v);
    const [outL, outR] = spliceCuts([left, right], [CUT]);
    expect(outL.length).toBe(outR.length);
    expect(Array.from(outR)).toEqual(Array.from(outL.map((v) => -v)));
  });
});

describe('detection constants', () => {
  it('pins the derived constants: attack 1 ms (gate onset accuracy), release 20 ms (bridges a 75 Hz glottal period within 6 dB), splice 10 ms (below the documented level-change audibility bound, 5x the 2 ms click floor)', () => {
    expect(DETECT_ATTACK_MS).toBe(1);
    expect(DETECT_RELEASE_MS).toBe(20);
    expect(SPLICE_XFADE_MS).toBe(10);
  });
});
