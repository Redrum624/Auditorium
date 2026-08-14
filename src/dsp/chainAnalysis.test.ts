import {
  HUM_EXCESS_THRESHOLD_DB,
  NOISE_WINDOW_MS,
  dcOffsets,
  detectMainsHum,
  goertzelAmplitude,
  humMeasurable,
  measureNoiseWindow,
  measureNoiseWindows,
  measureStageDelta,
  monoMix,
  peakDb,
  programmeRmsDb,
  toDb,
  toneExcessDb,
} from './chainAnalysis';
import { SILENCE_RMS } from './pitchDetect';

const SR = 8000; // low rate keeps the fixtures small; every rule here is rate-relative

/** White-ish but DETERMINISTIC noise: a seeded LCG, so a boundary test that
 * passes once passes always. */
function noise(n: number, amplitude: number, seed = 1): Float32Array {
  const out = new Float32Array(n);
  let s = seed >>> 0;
  for (let i = 0; i < n; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    out[i] = ((s / 0xffffffff) * 2 - 1) * amplitude;
  }
  return out;
}

function tone(n: number, freqHz: number, amplitude: number, sr = SR): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amplitude * Math.sin((2 * Math.PI * freqHz * i) / sr);
  return out;
}

function add(a: Float32Array, b: Float32Array): Float32Array {
  const out = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] + b[i];
  return out;
}

/** A `quietSec` stretch of quiet noise inside a `loudSec` stretch of loud noise. */
function quietPassage(loudSec: number, quietSec: number, loudAmp: number, quietAmp: number) {
  const loud = Math.round(loudSec * SR);
  const quiet = Math.round(quietSec * SR);
  const out = new Float32Array(loud + quiet + loud);
  const a = noise(loud, loudAmp, 7);
  const b = noise(quiet, quietAmp, 11);
  const c = noise(loud, loudAmp, 13);
  out.set(a, 0);
  out.set(b, loud);
  out.set(c, loud + quiet);
  return { signal: out, quietStart: loud, quietLength: quiet };
}

describe('toDb', () => {
  it('is the ordinary 20*log10 for normal magnitudes, and sign-independent', () => {
    expect(toDb(1)).toBeCloseTo(0, 12);
    expect(toDb(0.5)).toBeCloseTo(-6.0206, 3);
    expect(toDb(-0.5)).toBeCloseTo(toDb(0.5), 12);
  });

  it('floors at -240 dBFS instead of returning -Infinity', () => {
    expect(toDb(0)).toBeCloseTo(-240, 6);
    expect(Number.isFinite(toDb(0))).toBe(true);
  });
});

describe('programmeRmsDb', () => {
  it('is the RMS over every sample of every channel, not of a downmix', () => {
    // A downmix of these two channels is silent; the programme is not.
    const left = Float32Array.from([0.5, 0.5, 0.5, 0.5]);
    const right = Float32Array.from([-0.5, -0.5, -0.5, -0.5]);
    expect(programmeRmsDb([left, right])).toBeCloseTo(toDb(0.5), 6);
    expect(programmeRmsDb([monoMix([left, right])])).toBeCloseTo(-240, 6);
  });

  it('weights both channels — a loud second channel raises it', () => {
    const quiet = new Float32Array(1000);
    const loud = Float32Array.from(new Array(1000).fill(1));
    // Only the second channel carries signal: mean square = 0.5 => -3.01 dB.
    expect(programmeRmsDb([quiet, loud])).toBeCloseTo(toDb(Math.SQRT1_2), 5);
  });
});

describe('peakDb', () => {
  it('finds the peak in ANY channel, not only the first', () => {
    const flat = Float32Array.from([0.1, 0.1, 0.1]);
    const spike = Float32Array.from([0.1, 0.9, 0.1]);
    expect(peakDb([spike, flat])).toBeCloseTo(toDb(0.9), 6);
    expect(peakDb([flat, spike])).toBeCloseTo(toDb(0.9), 6);
  });

  it('finds a peak at the LAST sample, not only an early one', () => {
    expect(peakDb([Float32Array.from([0.1, 0.2, 0.8])])).toBeCloseTo(toDb(0.8), 6);
  });
});

describe('dcOffsets', () => {
  it('reports the mean of each channel independently', () => {
    const offsets = dcOffsets([Float32Array.from([0.5, 0.5]), Float32Array.from([-0.25, -0.75])]);
    expect(offsets[0]).toBeCloseTo(0.5, 6);
    expect(offsets[1]).toBeCloseTo(-0.5, 6);
  });

  it('reports 0 for an empty channel rather than NaN', () => {
    expect(dcOffsets([new Float32Array(0)])[0]).toBe(0);
  });
});

describe('measureNoiseWindow — the region-length boundary', () => {
  const winSamples = Math.round((NOISE_WINDOW_MS / 1000) * SR);

  it.each([
    ['one sample short of one window', winSamples - 1, null],
    ['exactly one window', winSamples, 'found'],
    ['one sample over one window', winSamples + 1, 'found'],
  ])('%s', (_name, length, expected) => {
    const channels = [noise(length, 0.01)];
    const result = measureNoiseWindow(channels, SR);
    if (expected === null) expect(result).toBeNull();
    else expect(result).not.toBeNull();
  });
});

describe('measureNoiseWindow — the digital-silence rejection boundary', () => {
  const winSamples = Math.round((NOISE_WINDOW_MS / 1000) * SR);

  /** A signal held at EXACTLY `level` everywhere — alternating +/-level, whose
   * RMS is `level` by construction, so every candidate window reads the same
   * value and the only thing that can decide the outcome is the comparison
   * against the digital-silence floor.
   *
   * A quiet window embedded in loud material does NOT test this: the scan then
   * falls back to a window STRADDLING the boundary, which is far above the
   * floor and gets accepted either way. That version of this test passed with
   * the comparison mutated and is what this one replaces. */
  function uniform(level: number): Float32Array[] {
    const out = new Float32Array(winSamples * 6);
    for (let i = 0; i < out.length; i++) out[i] = i % 2 === 0 ? level : -level;
    return [out];
  }

  it('rejects material BELOW the digital-silence floor — there is nothing to learn from', () => {
    expect(measureNoiseWindow(uniform(SILENCE_RMS / 2), SR)).toBeNull();
  });

  it('rejects material sitting EXACTLY ON the floor — the comparison is strict', () => {
    // Exact by construction: |sample| is SILENCE_RMS, a power of two and so
    // representable, and the mean of equal squares is that square exactly.
    expect(measureNoiseWindow(uniform(SILENCE_RMS), SR)).toBeNull();
  });

  it('accepts material JUST ABOVE the floor', () => {
    const result = measureNoiseWindow(uniform(SILENCE_RMS * 1.0001), SR);
    expect(result).not.toBeNull();
    expect(result!.rmsDb).toBeCloseTo(toDb(SILENCE_RMS * 1.0001), 6);
  });

  it('rejects a digitally silent passage and settles for a louder one', () => {
    // The reference take opens with literal zeros; this is that case.
    const out = new Float32Array(winSamples * 6);
    const loud = noise(winSamples * 4, 0.01, 3);
    out.set(loud, winSamples * 2);
    const result = measureNoiseWindow([out], SR);
    expect(result).not.toBeNull();
    expect(result!.rmsDb).toBeGreaterThan(toDb(SILENCE_RMS));
  });

  it('returns null when EVERY window is digital silence', () => {
    expect(measureNoiseWindow([new Float32Array(winSamples * 4)], SR)).toBeNull();
  });

  it('breaks a tie towards the FIRST window, so the result is deterministic', () => {
    const win = Math.round((NOISE_WINDOW_MS / 1000) * SR);
    const signal = new Float32Array(win * 6);
    for (let i = 0; i < signal.length; i++) signal[i] = i % 2 === 0 ? 0.5 : -0.5;
    const quiet = 0.001;
    for (let i = win; i < win * 2; i++) signal[i] = i % 2 === 0 ? quiet : -quiet;
    for (let i = win * 4; i < win * 5; i++) signal[i] = i % 2 === 0 ? quiet : -quiet;
    // Both candidates have exactly the same RMS; the earlier one must win.
    expect(measureNoiseWindow([signal], SR)!.startSample).toBe(win);
  });
});

describe('measureNoiseWindow — it scans the whole region, not just the start', () => {
  it.each([
    ['at the start', 0],
    ['in the middle', 1],
    ['at the end', 2],
  ])('finds the quiet passage %s', (_name, third) => {
    const win = Math.round((NOISE_WINDOW_MS / 1000) * SR);
    const total = win * 6;
    const signal = noise(total, 0.5, 5);
    const quietStart = third * (total - win) * 0.5;
    const start = Math.round(quietStart / win) * win;
    for (let i = start; i < start + win; i++) signal[i] *= 0.001;
    const result = measureNoiseWindow([signal], SR);
    expect(result).not.toBeNull();
    expect(result!.startSample).toBe(start);
  });

  it('picks the quietest of TWO quiet passages, not the first one it meets', () => {
    const win = Math.round((NOISE_WINDOW_MS / 1000) * SR);
    const signal = noise(win * 8, 0.5, 9);
    for (let i = win; i < win * 2; i++) signal[i] *= 0.01; // quiet
    for (let i = win * 5; i < win * 6; i++) signal[i] *= 0.001; // quieter
    const result = measureNoiseWindow([signal], SR);
    expect(result!.startSample).toBe(win * 5);
  });
});

describe('measureNoiseWindow — both channels count', () => {
  it('rejects a window that is quiet in one channel but loud in the other', () => {
    const win = Math.round((NOISE_WINDOW_MS / 1000) * SR);
    const left = noise(win * 6, 0.5, 21);
    const right = noise(win * 6, 0.5, 22);
    // Window A: quiet in left only. Window B: quiet in both.
    for (let i = win; i < win * 2; i++) left[i] *= 0.001;
    for (let i = win * 4; i < win * 5; i++) {
      left[i] *= 0.01;
      right[i] *= 0.01;
    }
    const result = measureNoiseWindow([left, right], SR);
    expect(result!.startSample).toBe(win * 4);
  });
});

describe('measureNoiseWindow — the envelope peak it reports', () => {
  it('sits above the window RMS, because noise peaks above its own RMS', () => {
    const { signal, quietStart } = quietPassage(1, 1, 0.5, 0.01);
    const result = measureNoiseWindow([signal], SR);
    expect(result).not.toBeNull();
    expect(result!.startSample).toBe(quietStart);
    expect(result!.envelopePeakDb).toBeGreaterThan(result!.rmsDb);
  });
});

/**
 * V2 — the search that returns MORE than the single quietest window.
 *
 * `measureNoiseWindow` answers "where is the quietest 500 ms", and one caller —
 * the gate — needs "where are the quietest N distinct 500 ms, so I can keep
 * looking when the first one turns out to be a breath". Everything below pins
 * that the multi-candidate form is the same search: same acceptance, same
 * tie-break, same first element, same eviction census.
 */
describe('measureNoiseWindows — the quietest N, not just the quietest', () => {
  const win = Math.round((NOISE_WINDOW_MS / 1000) * SR);

  /** `levels` half-second blocks, each at a stated exact RMS. */
  function blocks(levels: number[]): Float32Array {
    const out = new Float32Array(win * levels.length);
    for (let b = 0; b < levels.length; b++) {
      for (let i = 0; i < win; i++) out[b * win + i] = (i % 2 === 0 ? 1 : -1) * levels[b];
    }
    return out;
  }

  it('returns exactly one window by default — the one `measureNoiseWindow` returns', () => {
    const signal = blocks([0.5, 0.002, 0.5, 0.001, 0.5]);
    const many = measureNoiseWindows([signal], SR);
    const one = measureNoiseWindow([signal], SR)!;
    expect(many).toHaveLength(1);
    expect(many[0]).toEqual(one);
  });

  it('returns the candidates quietest FIRST, and never more than asked for', () => {
    const signal = blocks([0.5, 0.002, 0.5, 0.001, 0.5, 0.004]);
    const got = measureNoiseWindows([signal], SR, { maxCandidates: 3 });
    expect(got).toHaveLength(3);
    expect(got[0].rmsDb).toBeLessThan(got[1].rmsDb);
    expect(got[1].rmsDb).toBeLessThan(got[2].rmsDb);
    // The three quiet blocks, in level order, not in time order.
    expect(got.map((w) => w.startSample)).toEqual([win * 3, win, win * 5]);
  });

  it('returns DISTINCT passages — no candidate overlaps another', () => {
    // One long quiet stretch. A search that just took the N lowest sliding
    // positions would return N windows one 50 ms step apart, all measuring the
    // same half-second — N answers to one question.
    const signal = new Float32Array(win * 10);
    for (let i = 0; i < signal.length; i++) signal[i] = (i % 2 === 0 ? 1 : -1) * 0.5;
    const quiet = noise(win * 4, 0.002, 31);
    signal.set(quiet, win * 2);
    const got = measureNoiseWindows([signal], SR, { maxCandidates: 4 });
    expect(got.length).toBeGreaterThan(1);
    for (let a = 0; a < got.length; a++) {
      for (let b = a + 1; b < got.length; b++) {
        const gap = Math.abs(got[a].startSample - got[b].startSample);
        expect(gap).toBeGreaterThanOrEqual(win);
      }
    }
  });

  it('returns fewer than asked for when the region holds no more distinct windows', () => {
    // Two windows' worth of material: one candidate, and asking for twelve
    // cannot invent an eleventh half-second that is not there.
    const signal = blocks([0.01, 0.5]);
    expect(measureNoiseWindows([signal], SR, { maxCandidates: 12 }).length).toBeLessThan(12);
  });

  it('returns an empty list where `measureNoiseWindow` returns null', () => {
    expect(measureNoiseWindows([new Float32Array(win * 4)], SR, { maxCandidates: 12 })).toEqual([]);
    expect(measureNoiseWindow([new Float32Array(win * 4)], SR)).toBeNull();
  });

  it('applies the mostly-silent reject to every candidate, not only the first', () => {
    // Zeros, then a quiet real stretch, then loud. The boundary windows between
    // the zeros and the real material are mostly silent and must not appear
    // ANYWHERE in the list — the whole point of the reject is that such a
    // window measures nothing, and that is as true of candidate five as of
    // candidate one.
    const signal = new Float32Array(win * 12);
    signal.set(noise(win * 4, 0.002, 41), win * 4);
    signal.set(noise(win * 4, 0.4, 42), win * 8);
    const got = measureNoiseWindows([signal], SR, { maxCandidates: 6, rejectMostlySilentWindows: true });
    expect(got.length).toBeGreaterThan(1);
    for (const w of got) {
      let zeros = 0;
      for (let i = w.startSample; i < w.startSample + w.lengthSamples; i++) if (signal[i] === 0) zeros++;
      expect(zeros / w.lengthSamples).toBeLessThanOrEqual(0.25);
    }
  });

  /**
   * The eviction census is per candidate, and it has to be: it counts the real
   * frames hidden inside evicted windows QUIETER THAN the window in hand, so a
   * louder candidate hides at least as much as a quieter one. Reporting the
   * first candidate's count against a later candidate would under-state exactly
   * the material a threshold derived there could mute.
   */
  it('reports the hidden-material census per candidate, and it never falls as the candidates get louder', () => {
    // Real material chopped into 150 ms fragments between stretches of exact
    // zeros — no window over it is three-quarters real — then two honest quiet
    // stretches at different levels, then loud material.
    const signal = new Float32Array(win * 16);
    const frag = Math.round(0.15 * SR);
    for (let k = 0; k < 10; k++) {
      const at = k * (frag * 3);
      signal.set(noise(frag, 0.0015, 50 + k), at);
    }
    signal.set(noise(win * 3, 0.004, 61), win * 6);
    signal.set(noise(win * 3, 0.02, 62), win * 10);
    signal.set(noise(win * 3, 0.4, 63), win * 13);
    const got = measureNoiseWindows([signal], SR, { maxCandidates: 6, rejectMostlySilentWindows: true });
    expect(got.length).toBeGreaterThan(2);
    for (const w of got) expect(w.hiddenRealSamples).toEqual(expect.any(Number));
    for (let i = 1; i < got.length; i++) {
      expect(got[i].hiddenRealSamples!).toBeGreaterThanOrEqual(got[i - 1].hiddenRealSamples!);
    }
    // ...and the first candidate's census is the one the single-window search
    // has always reported, unchanged.
    expect(got[0].hiddenRealSamples).toBe(
      measureNoiseWindow([signal], SR, { rejectMostlySilentWindows: true })!.hiddenRealSamples
    );
  });

  it('omits the census entirely when the caller did not ask for the reject', () => {
    const signal = blocks([0.5, 0.002, 0.5, 0.001, 0.5]);
    for (const w of measureNoiseWindows([signal], SR, { maxCandidates: 3 })) {
      expect(w.hiddenRealSamples).toBeUndefined();
    }
  });

  it('breaks a tie towards the earlier window, exactly as the single search does', () => {
    const signal = blocks([0.5, 0.001, 0.5, 0.001, 0.5]);
    const got = measureNoiseWindows([signal], SR, { maxCandidates: 2 });
    expect(got[0].startSample).toBe(win);
    expect(got[1].startSample).toBe(win * 3);
  });
});

describe('goertzelAmplitude', () => {
  it('recovers the amplitude of a pure tone at the probed frequency', () => {
    const x = tone(SR, 200, 0.4);
    expect(goertzelAmplitude(x, 0, SR, 200, SR)).toBeCloseTo(0.4, 2);
  });

  it.each([
    ['well below', 150],
    ['just below', 195],
    ['just above', 205],
    ['well above', 260],
  ])('reads far less at a neighbouring frequency (%s)', (_name, probe) => {
    const x = tone(SR, 200, 0.4);
    expect(goertzelAmplitude(x, 0, SR, probe, SR)).toBeLessThan(0.4 * 0.5);
  });

  it('reads from `start`, not always from 0', () => {
    const half = SR / 2;
    const x = new Float32Array(SR);
    x.set(tone(half, 200, 0.4), half); // tone only in the SECOND half
    expect(goertzelAmplitude(x, half, half, 200, SR)).toBeGreaterThan(
      goertzelAmplitude(x, 0, half, 200, SR) + 0.3
    );
  });

  it('returns 0 rather than NaN for a degenerate length', () => {
    expect(goertzelAmplitude(tone(10, 200, 0.4), 0, 1, 200, SR)).toBe(0);
    expect(goertzelAmplitude(tone(10, 200, 0.4), 0, 0, 200, SR)).toBe(0);
  });
});

describe('toneExcessDb', () => {
  it('is near zero for noise with no tone in it', () => {
    const excess = toneExcessDb(noise(SR * 4, 0.2), SR, 50);
    expect(excess).not.toBeNull();
    expect(Math.abs(excess!)).toBeLessThan(6);
  });

  it('rises with the level of an added tone, monotonically', () => {
    const base = noise(SR * 4, 0.2, 31);
    const levels = [0.0005, 0.005, 0.05];
    const measured = levels.map((a) => toneExcessDb(add(base, tone(base.length, 50, a)), SR, 50)!);
    expect(measured[0]).toBeLessThan(measured[1]);
    expect(measured[1]).toBeLessThan(measured[2]);
    expect(measured[2]).toBeGreaterThan(HUM_EXCESS_THRESHOLD_DB);
  });

  it('is null when the signal is shorter than one probe block — an unmeasurable case is not "no hum"', () => {
    expect(toneExcessDb(noise(SR - 1, 0.2), SR, 50)).toBeNull();
    expect(toneExcessDb(noise(SR, 0.2), SR, 50)).not.toBeNull();
  });

  it('does not fire on a tone at a DIFFERENT frequency', () => {
    const withHum = add(noise(SR * 4, 0.2, 41), tone(SR * 4, 50, 0.05));
    expect(toneExcessDb(withHum, SR, 50)!).toBeGreaterThan(HUM_EXCESS_THRESHOLD_DB);
    expect(toneExcessDb(withHum, SR, 60)!).toBeLessThan(HUM_EXCESS_THRESHOLD_DB);
  });
});

describe('detectMainsHum — the threshold boundary', () => {
  /** Tone amplitude chosen so the measured excess lands near `targetDb`. */
  function atExcess(targetDb: number): Float32Array {
    const base = noise(SR * 4, 0.2, 53);
    let lo = 1e-6;
    let hi = 1;
    // Bisect on the amplitude: the excess is monotone in it (pinned above).
    for (let k = 0; k < 40; k++) {
      const mid = Math.sqrt(lo * hi);
      const excess = toneExcessDb(add(base, tone(base.length, 50, mid)), SR, 50)!;
      if (excess < targetDb) lo = mid;
      else hi = mid;
    }
    return add(base, tone(base.length, 50, Math.sqrt(lo * hi)));
  }

  it('does not fire two dB BELOW the threshold', () => {
    expect(detectMainsHum([atExcess(HUM_EXCESS_THRESHOLD_DB - 2)], SR)).toBeNull();
  });

  it('fires two dB ABOVE the threshold', () => {
    const hum = detectMainsHum([atExcess(HUM_EXCESS_THRESHOLD_DB + 2)], SR);
    expect(hum).not.toBeNull();
    expect(hum!.baseHz).toBe(50);
    expect(hum!.excessDb).toBeGreaterThan(HUM_EXCESS_THRESHOLD_DB);
  });

  it('is a strict comparison: an excess just under the threshold does not fire', () => {
    expect(detectMainsHum([atExcess(HUM_EXCESS_THRESHOLD_DB - 0.3)], SR)).toBeNull();
  });
});

describe('detectMainsHum — the threshold VALUE, not just the comparison', () => {
  /** A fixture whose measured excess is `targetDb`, built by bisecting the tone
   * amplitude with the same public primitive the detector uses. */
  function atExcess(targetDb: number): Float32Array {
    const base = noise(SR * 4, 0.2, 53);
    let lo = 1e-6;
    let hi = 1;
    for (let k = 0; k < 50; k++) {
      const mid = Math.sqrt(lo * hi);
      if (toneExcessDb(add(base, tone(base.length, 50, mid)), SR, 50)! < targetDb) lo = mid;
      else hi = mid;
    }
    return add(base, tone(base.length, 50, Math.sqrt(lo * hi)));
  }

  it('is 12 dB — the midpoint of the measured gap between clean material and the quietest hum', () => {
    expect(HUM_EXCESS_THRESHOLD_DB).toBe(12);
  });

  it('does not fire on a measured 8 dB excess', () => {
    // Between a hypothetical 6 dB threshold and the shipped 12 dB one, so
    // LOWERING the threshold turns this red rather than leaving it green.
    const fixture = atExcess(8);
    expect(toneExcessDb(fixture, SR, 50)!).toBeCloseTo(8, 1);
    expect(detectMainsHum([fixture], SR)).toBeNull();
  });

  it('fires on a measured 16 dB excess', () => {
    const fixture = atExcess(16);
    expect(toneExcessDb(fixture, SR, 50)!).toBeCloseTo(16, 1);
    expect(detectMainsHum([fixture], SR)).not.toBeNull();
  });
});

describe('toneExcessDb — the reference is probes on BOTH sides, averaged', () => {
  it('a loud tone in ONE neighbour slot lifts the reference and suppresses the verdict', () => {
    // Content sitting 5 Hz off the mains frequency is not hum, and the local
    // floor must see it. With hum at 50 Hz alone the detector fires; adding a
    // loud 55 Hz tone — one of the four reference probes — must stop it.
    // A reference built from a single probe on the other side would miss it
    // entirely and still report hum.
    const base = noise(SR * 4, 0.15, 61);
    const humOnly = add(base, tone(base.length, 50, 0.05));
    expect(detectMainsHum([humOnly], SR)).not.toBeNull();

    const withNeighbour = add(humOnly, tone(base.length, 55, 0.4));
    expect(toneExcessDb(withNeighbour, SR, 50)!).toBeLessThan(HUM_EXCESS_THRESHOLD_DB);
    expect(detectMainsHum([withNeighbour], SR)).toBeNull();
  });
});

describe('detectMainsHum — it tests BOTH mains frequencies, in both roles', () => {
  it.each([
    [50, 60],
    [60, 50],
  ])('identifies %i Hz hum and not %i Hz', (present, absent) => {
    const base = noise(SR * 4, 0.15, 61);
    const hum = detectMainsHum([add(base, tone(base.length, present, 0.05))], SR);
    expect(hum).not.toBeNull();
    expect(hum!.baseHz).toBe(present);
    expect(hum!.baseHz).not.toBe(absent);
  });

  it('returns null on clean material', () => {
    expect(detectMainsHum([noise(SR * 4, 0.2, 71)], SR)).toBeNull();
  });

  it('sees hum present in the SECOND channel only', () => {
    const clean = noise(SR * 4, 0.15, 81);
    const humming = add(noise(SR * 4, 0.15, 82), tone(SR * 4, 50, 0.1));
    expect(detectMainsHum([clean, humming], SR)).not.toBeNull();
    expect(detectMainsHum([humming, clean], SR)).not.toBeNull();
  });
});

describe('humMeasurable', () => {
  it.each([
    ['one sample short of a block', SR - 1, false],
    ['exactly one block', SR, true],
    ['one sample over a block', SR + 1, true],
  ])('%s', (_name, samples, expected) => {
    expect(humMeasurable(samples, SR)).toBe(expected);
  });
});

describe('measureStageDelta', () => {
  it('reports 100 % identical and -240 dB difference for an untouched copy', () => {
    const a = [noise(500, 0.3, 91), noise(500, 0.3, 92)];
    const b = a.map((c) => Float32Array.from(c));
    const delta = measureStageDelta(a, b);
    expect(delta.identicalFraction).toBe(1);
    expect(delta.differenceRmsDb).toBeCloseTo(-240, 6);
    expect(delta.rmsAfterDb).toBeCloseTo(delta.rmsBeforeDb, 12);
  });

  it('counts changed samples in EVERY channel, not just the first', () => {
    const a = [new Float32Array(100), new Float32Array(100)];
    const onlySecondChanged = [Float32Array.from(a[0]), Float32Array.from(a[1])];
    onlySecondChanged[1][0] = 0.5;
    const delta = measureStageDelta(a, onlySecondChanged);
    // 1 of 200 samples changed — a first-channel-only loop would report 1.0.
    expect(delta.identicalFraction).toBeCloseTo(199 / 200, 12);
  });

  it('counts a change at the LAST sample of the last channel', () => {
    const a = [new Float32Array(100), new Float32Array(100)];
    const b = [Float32Array.from(a[0]), Float32Array.from(a[1])];
    b[1][99] = 0.5;
    expect(measureStageDelta(a, b).identicalFraction).toBeCloseTo(199 / 200, 12);
  });

  it('treats a sign flip on zero as a CHANGE — the bit-exactness claim is about -0', () => {
    const a = [Float32Array.from([0, 0, 0, 0])];
    const b = [Float32Array.from([-0, 0, 0, 0])];
    expect(a[0][0] === b[0][0]).toBe(true); // === cannot see it
    expect(measureStageDelta(a, b).identicalFraction).toBeCloseTo(3 / 4, 12);
  });

  it('reports the RMS of what changed, not of the output', () => {
    const a = [new Float32Array(1000)];
    const b = [Float32Array.from(new Array(1000).fill(0.25))];
    expect(measureStageDelta(a, b).differenceRmsDb).toBeCloseTo(toDb(0.25), 6);
  });

  it('leaves the sample-wise fields null when the length changed, and still reports levels', () => {
    // The two fills are DIFFERENT (0.5 in, 0.25 out) and each of the four level
    // fields is asserted against its own literal. With 0.5 on both sides — which
    // is what this fixture used to be, and the untouched-copy fixture above is by
    // construction — before and after are the same number, so swapping the two
    // arguments in `measureStageDelta` changed nothing any test could see, and
    // every stage line in both chain dialogs would have read backwards: a stage
    // that lifted the level would be shown lowering it.
    const a = [Float32Array.from(new Array(100).fill(0.5))];
    const b = [Float32Array.from(new Array(50).fill(0.25))];
    const delta = measureStageDelta(a, b);
    expect(delta.identicalFraction).toBeNull();
    expect(delta.differenceRmsDb).toBeNull();
    expect(delta.rmsBeforeDb).toBeCloseTo(toDb(0.5), 6);
    expect(delta.rmsAfterDb).toBeCloseTo(toDb(0.25), 6);
    expect(delta.peakBeforeDb).toBeCloseTo(toDb(0.5), 6);
    expect(delta.peakAfterDb).toBeCloseTo(toDb(0.25), 6);
  });

  it('leaves them null when the CHANNEL COUNT changed', () => {
    const a = [new Float32Array(100), new Float32Array(100)];
    const b = [new Float32Array(100)];
    expect(measureStageDelta(a, b).identicalFraction).toBeNull();
  });
});

describe('monoMix', () => {
  it('averages the channels', () => {
    const mixed = monoMix([Float32Array.from([1, 0]), Float32Array.from([0, 1])]);
    expect(Array.from(mixed)).toEqual([0.5, 0.5]);
  });

  it('returns the single channel itself for mono', () => {
    const only = Float32Array.from([0.25]);
    expect(monoMix([only])).toBe(only);
  });
});
