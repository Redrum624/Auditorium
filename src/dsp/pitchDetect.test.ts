/**
 * Detector accuracy is pinned against SYNTHESISED fixtures of known f0, with
 * bounds set from MEASURED errors (recorded 2026-08-08 on this implementation,
 * commented per assertion) plus 2–3× headroom — never invented tolerances.
 *
 * Octave errors are the known, architecturally-ungatable failure mode of every
 * periodicity detector. On THESE fixtures the measured octave-error count is
 * zero, and the assertions pin that as a regression guard for these specific
 * fixtures — it is NOT a claim of general immunity.
 */
import {
  detectPitch,
  F0_MAX_HZ,
  HOP_MS,
  SILENCE_RMS,
  YIN_THRESHOLD,
  type PitchTrack,
} from './pitchDetect';

const SR = 44100;

function sine(freq: number, seconds: number, amplitude = 1): Float32Array {
  const n = Math.round(seconds * SR);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amplitude * Math.sin((2 * Math.PI * freq * i) / SR);
  return out;
}

function sawtooth(freq: number, seconds: number): Float32Array {
  const n = Math.round(seconds * SR);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const ph = (freq * i) / SR;
    out[i] = 2 * (ph - Math.floor(ph)) - 1;
  }
  return out;
}

/** Phase-integrated sine whose instantaneous f0 at sample i is f(i). */
function fmSine(seconds: number, f: (i: number) => number): Float32Array {
  const n = Math.round(seconds * SR);
  const out = new Float32Array(n);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    out[i] = Math.sin(phase);
    phase += (2 * Math.PI * f(i)) / SR;
  }
  return out;
}

/** ±depthCents vibrato at rateHz around a carrier (Sundberg 1994: 5–7 Hz, ~±1 st). */
const vibratoF = (carrier: number, depthCents: number, rateHz: number) => (i: number) =>
  carrier * Math.pow(2, (depthCents * Math.sin((2 * Math.PI * rateHz * i) / SR)) / 1200);

/** Exponential glide f0→f1 (linear in cents — how melodic slides move). */
const glideF = (f0: number, f1: number, seconds: number) => (i: number) =>
  f0 * Math.pow(f1 / f0, i / (seconds * SR));

/** Deterministic uniform noise in [−amplitude, amplitude) (LCG, Numerical Recipes constants). */
function noise(seconds: number, amplitude: number, seed: number): Float32Array {
  const n = Math.round(seconds * SR);
  const out = new Float32Array(n);
  let state = seed >>> 0;
  for (let i = 0; i < n; i++) {
    state = (state * 1664525 + 1013904223) >>> 0;
    out[i] = amplitude * (state / 2147483648 - 1);
  }
  return out;
}

function cents(a: number, b: number): number {
  return 1200 * Math.log2(a / b);
}

function voicedCount(track: PitchTrack): number {
  return track.frames.filter((f) => f.f0Hz !== null).length;
}

/** Max |cents error| across voiced frames vs a constant true f0; throws if any frame is unvoiced. */
function maxAbsCentsSteady(track: PitchTrack, trueF0: number): number {
  let worst = 0;
  for (const fr of track.frames) {
    if (fr.f0Hz === null) throw new Error('unexpected unvoiced frame in steady fixture');
    worst = Math.max(worst, Math.abs(cents(fr.f0Hz, trueF0)));
  }
  return worst;
}

/** Max |cents error| vs the true instantaneous f0 at each frame CENTRE. */
function maxAbsCentsTracked(track: PitchTrack, f: (i: number) => number): number {
  const center = track.frameSamples / 2;
  let worst = 0;
  track.frames.forEach((fr, k) => {
    if (fr.f0Hz === null) throw new Error('unexpected unvoiced frame in tracked fixture');
    worst = Math.max(worst, Math.abs(cents(fr.f0Hz, f(k * track.hopSamples + center))));
  });
  return worst;
}

describe('detectPitch — frame geometry', () => {
  // τ_max = ⌈44100/40⌉ = 1103 ⇒ frame 2206; hop = round(44100·10/1000) = 441.
  it('derives hop 441 and frame 2206 samples at 44.1 kHz from F0_MIN_HZ/HOP_MS', () => {
    const track = detectPitch(sine(440, 0.1), SR);
    expect(track.hopSamples).toBe(441);
    expect(track.frameSamples).toBe(2206);
    expect(HOP_MS).toBe(10);
  });

  // Boundary trio on `N >= frameSamples` / the frame loop: one sample below the
  // frame length ⇒ 0 frames; exactly one frame ⇒ 1; one hop more ⇒ 2.
  it('input one sample shorter than a frame yields zero frames', () => {
    expect(detectPitch(new Float32Array(2205), SR).frames.length).toBe(0);
  });
  it('input of exactly one frame yields one frame', () => {
    expect(detectPitch(new Float32Array(2206), SR).frames.length).toBe(1);
  });
  it('input of one frame plus one hop yields two frames', () => {
    expect(detectPitch(new Float32Array(2206 + 441), SR).frames.length).toBe(2);
  });
});

describe('detectPitch — accuracy on steady tones (measured errors in comments)', () => {
  // Measured max |error|: 41.203 Hz → 0.00064 c; 82.407 → 0.0033 c; 220 → 0.0083 c;
  // 440 → 0.0745 c; 1046.5 → 0.487 c; 1975.5 → 1.35 c. Pins are ~3× the measured
  // worst case per fixture — tight enough that skipping parabolic interpolation
  // (δ = 0 ⇒ ≥ 0.47 c at 41 Hz, ≥ 3.9 c at 220/440 Hz) turns them red.
  const cases: Array<[number, number]> = [
    [41.203, 0.1], // E1, lowest string of a 4-string bass — F0_MIN edge
    [82.407, 0.1], // E2
    [220, 0.1], // A3
    [440, 0.3], // A4
    [1046.5, 1.5], // C6, soprano high C
    [1975.5, 4], // B6 — near the F0_MAX edge
  ];

  it.each(cases)('sine %f Hz: every frame voiced, error under %f cents, no octave errors', (f, bound) => {
    const track = detectPitch(sine(f, 0.5), SR);
    expect(track.frames.length).toBe(45);
    expect(voicedCount(track)).toBe(45);
    expect(maxAbsCentsSteady(track, f)).toBeLessThan(bound);
  });

  it('sawtooth 220 Hz (rich harmonics): all voiced, error under 4 cents, no octave errors', () => {
    // Measured max 1.80 c; an octave error would be ≥ 1200 c, far outside the pin.
    const track = detectPitch(sawtooth(220, 0.5), SR);
    expect(voicedCount(track)).toBe(45);
    expect(maxAbsCentsSteady(track, 220)).toBeLessThan(4);
  });

  it('clean sine confidence exceeds 1 − YIN_THRESHOLD (pins the confidence formula)', () => {
    const track = detectPitch(sine(440, 0.5), SR);
    for (const fr of track.frames) expect(fr.confidence).toBeGreaterThan(1 - YIN_THRESHOLD);
  });
});

describe('detectPitch — moving pitch (vibrato and glide)', () => {
  it('±50-cent 6 Hz vibrato on 440 Hz: tracked within 35 cents of the instantaneous f0', () => {
    // Measured: median 15.0 c, max 21.4 c — the 50 ms integration window averages
    // the modulation (rectangular-window mean of a 6 Hz sinusoid over 50 ms
    // retains sinc(π·0.3) ≈ 0.86 of the excursion), so tens-of-cents tracking
    // error at the vibrato extremes is inherent to the frame size, not a bug.
    const f = vibratoF(440, 50, 6);
    const track = detectPitch(fmSine(1.0, f), SR);
    expect(voicedCount(track)).toBe(95);
    expect(maxAbsCentsTracked(track, f)).toBeLessThan(35);
  });

  it('one-octave/second glide 220→440 Hz: tracked within 25 cents, monotonically rising', () => {
    // Measured: median 13.0 c, max 13.6 c — a systematic lag of ≈11 ms at
    // 1200 cents/s, again set by the analysis window length.
    const f = glideF(220, 440, 1.0);
    const track = detectPitch(fmSine(1.0, f), SR);
    expect(voicedCount(track)).toBe(95);
    expect(maxAbsCentsTracked(track, f)).toBeLessThan(25);
    const f0s = track.frames.map((fr) => fr.f0Hz as number);
    expect(f0s[f0s.length - 1]).toBeGreaterThan(f0s[0] * 1.8);
  });
});

describe('detectPitch — unvoiced, silence and out-of-range input', () => {
  it('digital silence: frames exist and every one is unvoiced', () => {
    const track = detectPitch(new Float32Array(Math.round(0.3 * SR)), SR);
    expect(track.frames.length).toBeGreaterThan(0);
    for (const fr of track.frames) {
      expect(fr.f0Hz).toBeNull();
      expect(fr.confidence).toBe(0);
    }
  });

  it('white noise (loud and quiet) is entirely unvoiced', () => {
    expect(voicedCount(detectPitch(noise(0.5, 0.5, 12345), SR))).toBe(0);
    expect(voicedCount(detectPitch(noise(0.5, 0.05, 12345), SR))).toBe(0);
  });

  it('a DC-offset constant is unvoiced (d ≡ 0 ⇒ d′ defined as 1, never under threshold)', () => {
    const dc = new Float32Array(Math.round(0.3 * SR)).fill(0.5);
    expect(voicedCount(detectPitch(dc, SR))).toBe(0);
  });

  it('f0 below the search range (30 Hz < F0_MIN) reads as unvoiced, not a wrong pitch', () => {
    expect(voicedCount(detectPitch(sine(30, 0.5), SR))).toBe(0);
  });

  it('f0 above the search range (2200 Hz > F0_MAX) aliases to the range edge — documented, pinned', () => {
    // Measured: every frame reports 2151.2 Hz (τ clamps to τ_min − 0.5 via the
    // interpolation clamp), i.e. ≈ 47 c above F0_MAX — NOT the true 2200 Hz and
    // NOT an octave error on this fixture. Out-of-contract input stays bounded.
    const track = detectPitch(sine(2200, 0.3), SR);
    expect(voicedCount(track)).toBe(track.frames.length);
    for (const fr of track.frames) {
      expect(Math.abs(cents(fr.f0Hz as number, F0_MAX_HZ))).toBeLessThan(60);
    }
  });
});

describe('detectPitch — the YIN_THRESHOLD voiced/unvoiced decision', () => {
  // d′ minima cannot be steered exactly ONTO 0.1 analytically, so the boundary is
  // probed from both sides with measured straddling fixtures: at σ = 0.2 the CMND
  // minimum measured ≈ 0.082 (voiced, min confidence 0.918); at σ = 0.3 it sits
  // above 0.1 (unvoiced). The pair pins the threshold from below AND above.
  function noisySine(sigma: number): Float32Array {
    const base = sine(440, 0.5);
    const nz = noise(0.5, sigma * Math.sqrt(3), 999); // uniform ±a has σ = a/√3
    const mix = new Float32Array(base.length);
    for (let i = 0; i < base.length; i++) mix[i] = base[i] + nz[i];
    return mix;
  }

  it('sine + noise with CMND dip just BELOW threshold is voiced with confidence > 0.9', () => {
    const track = detectPitch(noisySine(0.2), SR);
    expect(voicedCount(track)).toBe(45);
    for (const fr of track.frames) expect(fr.confidence).toBeGreaterThan(0.9);
  });

  it('sine + noise with CMND dip just ABOVE threshold is entirely unvoiced', () => {
    expect(voicedCount(detectPitch(noisySine(0.3), SR))).toBe(0);
  });
});

describe('detectPitch — the SILENCE_RMS gate boundary (below / on / above)', () => {
  // A ±c square wave has RMS exactly c (every sample is ±c, and c = 2^−15 scaled
  // by small dyadic factors keeps the float arithmetic exact), so the gate's
  // `rms < SILENCE_RMS` comparison can be probed exactly on the equality.
  //
  // GATE is a deliberately INDEPENDENT literal, not the imported constant: fixtures
  // derived from SILENCE_RMS itself would scale along with a mutated constant and
  // pin only the comparison's strictness, never its numeric position (the
  // operand-role trap from the v1.9 mutation-testing rounds). The identity
  // assertion below makes any drift between the two an explicit failure.
  const GATE = 2 ** -15; // one LSB of 16-bit PCM

  function square(c: number): Float32Array {
    const n = Math.round(0.3 * SR);
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = i % 441 < 220 ? c : -c; // period 441 ⇒ 100 Hz
    return out;
  }

  it('SILENCE_RMS is exactly one LSB of 16-bit PCM', () => {
    expect(SILENCE_RMS).toBe(GATE);
  });

  it('RMS one-sixteenth below the gate: unvoiced despite perfect periodicity', () => {
    expect(voicedCount(detectPitch(square(GATE * (1 - 1 / 16)), SR))).toBe(0);
  });

  it('RMS exactly ON the gate: voiced (the comparison is strictly below)', () => {
    const track = detectPitch(square(GATE), SR);
    expect(voicedCount(track)).toBe(track.frames.length);
  });

  it('RMS one-sixteenth above the gate: voiced at 100 Hz within 1 cent', () => {
    // Measured f0 = 99.990 Hz (−0.17 c).
    const track = detectPitch(square(GATE * (1 + 1 / 16)), SR);
    expect(voicedCount(track)).toBe(track.frames.length);
    for (const fr of track.frames) {
      expect(Math.abs(cents(fr.f0Hz as number, 100))).toBeLessThan(1);
    }
  });
});

describe('detectPitch — progress reporting', () => {
  it('reports a terminal 1 and never regresses', () => {
    const seen: number[] = [];
    detectPitch(sine(440, 0.5), SR, (f) => seen.push(f));
    expect(seen[seen.length - 1]).toBe(1);
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]);
  });
});
