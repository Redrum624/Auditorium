import {
  ACTIVE_GATE_DB,
  DETECTOR_ATTACK_MS,
  DETECTOR_RELEASE_MS,
  LTAS_FFT_SIZE,
  LTAS_HOP,
  MATCH_BAND_CENTRES_HZ,
  MATCH_BOUND_DB,
  MATCH_MIN_CENTRE_HZ,
  REVERB_LONGEST_COMB_44K,
  activeEnvelopeSpread,
  activeThresholdDb,
  bandLevelDb,
  estimateDecay,
  gatedLevelDb,
  longTermAverageSpectrum,
  matchCurve,
  reverbRt60Seconds,
  type Ltas,
  type MatchBandStatus,
} from './coverMatch';
import { GRAPHIC_EQ_BANDS } from '../effects/eq/GraphicEqEffect';
import { reverbEffect } from '../effects/time/ReverbEffect';
import { compressorEffect } from '../effects/dynamics/CompressorEffect';

const SR = 16000; // low rate keeps fixtures small; every rule here is rate-relative

/** Deterministic noise (seeded LCG) so a boundary test that passes once always
 * passes. */
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

function scaled(x: Float32Array, g: number): Float32Array {
  const out = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) out[i] = x[i] * g;
  return out;
}

/** Alternating +/-amplitude at exactly `levelDb`: |x| is that amplitude at every
 * sample, so the detector envelope settles ON the figure rather than near it and
 * a percentile can be asserted against a literal. */
function flatAt(n: number, levelDb: number): Float32Array {
  const amp = Math.pow(10, levelDb / 20);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = i % 2 === 0 ? amp : -amp;
  return out;
}

/** A signal at `loudAmp` for `loudSec`, then `quietAmp` for `quietSec`. */
function loudThenQuiet(loudSec: number, quietSec: number, loudAmp: number, quietAmp: number): Float32Array {
  const loud = Math.round(loudSec * SR);
  const quiet = Math.round(quietSec * SR);
  const out = new Float32Array(loud + quiet);
  out.set(noise(loud, loudAmp, 7), 0);
  out.set(noise(quiet, quietAmp, 11), loud);
  return out;
}

// ── the gate ────────────────────────────────────────────────────────────────

describe('activeThresholdDb', () => {
  it('is ACTIVE_GATE_DB below the p95 of the signal\'s own detector, not below its noise floor', () => {
    // Same programme, two different noise floors 30 dB apart. A floor-derived
    // gate would put the threshold 30 dB apart too; a relative one must not.
    const loud = noise(6 * SR, 0.5, 3);
    const withHighFloor = new Float32Array(loud.length);
    const withLowFloor = new Float32Array(loud.length);
    for (let i = 0; i < loud.length; i++) {
      withHighFloor[i] = loud[i] + noise(1, 0.01, i + 1)[0];
      withLowFloor[i] = loud[i] + noise(1, 0.0003, i + 1)[0];
    }
    const a = activeThresholdDb([withHighFloor], SR);
    const b = activeThresholdDb([withLowFloor], SR);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(Math.abs((a as number) - (b as number))).toBeLessThan(0.5);
  });

  it('tracks the signal level: scaling the input by g moves the threshold by exactly g', () => {
    const x = noise(4 * SR, 0.3, 5);
    const base = activeThresholdDb([x], SR) as number;
    const half = activeThresholdDb([scaled(x, 0.5)], SR) as number;
    expect(half).toBeCloseTo(base - 20 * Math.log10(2), 6);
  });

  it('returns null when there is nothing to measure', () => {
    expect(activeThresholdDb([], SR)).toBeNull();
    expect(activeThresholdDb([new Float32Array(0)], SR)).toBeNull();
  });

  it('uses the compressor effect\'s own detector times', () => {
    const attack = compressorEffect.params.find((p) => p.id === 'attackMs');
    const release = compressorEffect.params.find((p) => p.id === 'releaseMs');
    expect(attack?.default).toBe(DETECTOR_ATTACK_MS);
    expect(release?.default).toBe(DETECTOR_RELEASE_MS);
  });
});

describe('gatedLevelDb', () => {
  it('ignores the pauses: two takes with the same singing but different amounts of silence read the same', () => {
    const singing = noise(4 * SR, 0.4, 9);
    const shortPause = new Float32Array(singing.length + Math.round(0.5 * SR));
    shortPause.set(singing, 0);
    const longPause = new Float32Array(singing.length + Math.round(6 * SR));
    longPause.set(singing, 0);
    const a = gatedLevelDb([shortPause], SR) as number;
    const b = gatedLevelDb([longPause], SR) as number;
    expect(Math.abs(a - b)).toBeLessThan(0.5);

    // The ungated RMS of the same pair is NOT the same — which is the reason
    // this function exists. 12x the silence is a measurable level difference.
    const rms = (x: Float32Array) => {
      let s = 0;
      for (let i = 0; i < x.length; i++) s += x[i] * x[i];
      return 10 * Math.log10(s / x.length);
    };
    expect(Math.abs(rms(shortPause) - rms(longPause))).toBeGreaterThan(3);
  });

  it('is a level: a gain of g on the input moves it by exactly g', () => {
    const x = loudThenQuiet(3, 2, 0.4, 0.002);
    const base = gatedLevelDb([x], SR) as number;
    for (const g of [0.25, 0.5, 2]) {
      expect(gatedLevelDb([scaled(x, g)], SR) as number).toBeCloseTo(base + 20 * Math.log10(g), 5);
    }
  });

  it('returns null when nothing can be measured', () => {
    expect(gatedLevelDb([], SR)).toBeNull();
    expect(gatedLevelDb([new Float32Array(0)], SR)).toBeNull();
  });
});

// ── dynamics ────────────────────────────────────────────────────────────────

describe('activeEnvelopeSpread', () => {
  it('narrows when the material is narrowed, across the whole range of the move', () => {
    // Alternating loud/quiet blocks, both above the gate. Compressing the
    // difference between them must show up as a smaller spread — probed at
    // several compression amounts so the test pins the direction AND that the
    // measure moves with the size of the move, not just its sign.
    const build = (quietGain: number): Float32Array => {
      const block = Math.round(0.4 * SR);
      const out = new Float32Array(block * 16);
      for (let b = 0; b < 16; b++) {
        const amp = b % 2 === 0 ? 0.5 : 0.5 * quietGain;
        out.set(noise(block, amp, 100 + b), b * block);
      }
      return out;
    };
    const spreads = [1, 0.5, 0.25, 0.125].map(
      (g) => (activeEnvelopeSpread([build(g)], SR) as { spreadDb: number }).spreadDb
    );
    expect(spreads).toHaveLength(4);
    // 1.0 is flat, so its spread is small; each halving widens it further.
    for (let i = 1; i < spreads.length; i++) {
      expect(spreads[i]).toBeGreaterThan(spreads[i - 1] + 3);
    }
  });

  it('reports each percentile as the level it actually is, on a fixture whose answer is arithmetic', () => {
    // The fixture this test used to run on was `loudThenQuiet(4, 1, 0.4, 0.001)`,
    // whose quiet second is 52 dB down and therefore GATED OUT — leaving a
    // single-level active set where p10, p50 and p90 all read the same number.
    // Against that, `spreadDb === p90 - p10` is a restatement of the line above
    // it and every percentile could be any percentile.
    //
    // Two settled levels 18 dB apart, both inside the 20 dB gate, and the quiet
    // one occupying 16 % of the run: p10 lands in it, p25 and p90 do not. The
    // levels are exact because |x| is constant at each of them, so the detector
    // settles ON the figure rather than near it.
    const signal = new Float32Array(Math.round(10 * SR));
    const quietSamples = Math.round(1.6 * SR);
    signal.set(flatAt(quietSamples, -24), 0);
    signal.set(flatAt(signal.length - quietSamples, -6), quietSamples);

    const s = activeEnvelopeSpread([signal], SR);
    expect(s).not.toBeNull();
    const v = s as NonNullable<typeof s>;

    expect(v.p10Db).toBeCloseTo(-24, 1);
    expect(v.p50Db).toBeCloseTo(-6, 1);
    expect(v.p90Db).toBeCloseTo(-6, 1);
    expect(v.spreadDb).toBeCloseTo(18, 1);

    // The ordering and the identity still hold, but they are no longer the only
    // thing said about the three numbers.
    expect(v.p10Db).toBeLessThanOrEqual(v.p50Db);
    expect(v.p50Db).toBeLessThanOrEqual(v.p90Db);
    expect(v.spreadDb).toBeCloseTo(v.p90Db - v.p10Db, 10);
    expect(v.thresholdDb).toBeCloseTo(activeThresholdDb([signal], SR) as number, 10);
    expect(v.thresholdDb).toBeCloseTo(-6 - ACTIVE_GATE_DB, 1);
    // The quiet level is INSIDE the gate — the whole point of the fixture — so
    // essentially everything counts as active.
    expect(v.activeFraction).toBeGreaterThan(0.99);
    expect(v.activeFraction).toBeLessThanOrEqual(1);
  });

  it('excludes exactly what ACTIVE_GATE_DB says to exclude — swept across the boundary', () => {
    // Two thirds of the signal loud (so it sets p95) and one third quieter by a
    // swept amount. The observable is the fraction that counts as active, which
    // moves between 1 and 2/3 as the quiet third crosses the gate: a third of
    // the signal is far more than any boundary fuzz, so the crossing point is
    // attributable to the constant and to nothing else.
    const block = Math.round(1.5 * SR);
    const activeFractionAt = (belowDb: number): number => {
      const out = new Float32Array(block * 6);
      for (let b = 0; b < 6; b++) {
        const amp = b < 4 ? 0.5 : 0.5 * Math.pow(10, -belowDb / 20);
        out.set(noise(block, amp, 200 + b), b * block);
      }
      return (activeEnvelopeSpread([out], SR) as { activeFraction: number }).activeFraction;
    };

    const sweep: { belowDb: number; fraction: number }[] = [];
    for (let belowDb = 10; belowDb <= 30; belowDb++) sweep.push({ belowDb, fraction: activeFractionAt(belowDb) });
    expect(sweep).toHaveLength(21);

    // Well inside the gate the whole signal counts; well outside, only the loud
    // two thirds do.
    expect(sweep[0].fraction).toBeGreaterThan(0.95);
    expect(sweep[sweep.length - 1].fraction).toBeLessThan(0.75);
    expect(sweep[sweep.length - 1].fraction).toBeGreaterThan(0.6);

    // Monotone, and the crossing sits where the constant says. The window is
    // ABSOLUTE on purpose: comparing the crossing with ACTIVE_GATE_DB itself
    // would move with the constant and so could never fail.
    for (let i = 1; i < sweep.length; i++) {
      expect(sweep[i].fraction).toBeLessThanOrEqual(sweep[i - 1].fraction + 1e-9);
    }
    const crossing = sweep.find((s) => s.fraction < 0.85);
    expect(crossing).toBeDefined();
    expect((crossing as { belowDb: number }).belowDb).toBeGreaterThanOrEqual(17);
    expect((crossing as { belowDb: number }).belowDb).toBeLessThanOrEqual(23);
    expect(ACTIVE_GATE_DB).toBe(20);
  });

  it('returns null when there is nothing to measure', () => {
    expect(activeEnvelopeSpread([], SR)).toBeNull();
    expect(activeEnvelopeSpread([new Float32Array(0)], SR)).toBeNull();
  });
});

// ── LTAS ────────────────────────────────────────────────────────────────────

describe('longTermAverageSpectrum', () => {
  it('finds the tone it is given, and puts it in the right bin', () => {
    const x = tone(4 * SR, 1000, 0.5);
    const ltas = longTermAverageSpectrum([x], SR);
    expect(ltas.frames).toBeGreaterThan(0);
    let peak = 0;
    let peakBin = -1;
    for (let k = 1; k < ltas.power.length; k++) {
      if (ltas.power[k] > peak) {
        peak = ltas.power[k];
        peakBin = k;
      }
    }
    expect((peakBin * SR) / LTAS_FFT_SIZE).toBeCloseTo(1000, -1);
  });

  it('averages the SOUNDING frames only — appended silence does not dilute it', () => {
    const singing = tone(4 * SR, 1000, 0.5);
    const padded = new Float32Array(singing.length + 8 * SR);
    padded.set(singing, 0);
    const a = longTermAverageSpectrum([singing], SR);
    const b = longTermAverageSpectrum([padded], SR);
    const band = (l: Ltas) => bandLevelDb(l, 700, 1400) as number;
    // Within 0.5 dB, not exact: the detector's 100 ms release keeps a few frames
    // straddling the end of the tone inside the gate, and those frames are part
    // tone and part silence. Ungated, the same pair differs by over 3 dB.
    expect(Math.abs(band(b) - band(a))).toBeLessThan(0.5);
    expect(b.frames).toBeLessThan(Math.floor((padded.length - LTAS_FFT_SIZE) / LTAS_HOP));
    expect(b.frames).toBeGreaterThan(0);
  });

  it('reports zero frames rather than a spectrum when there is nothing to transform', () => {
    const short = longTermAverageSpectrum([new Float32Array(LTAS_FFT_SIZE - 1)], SR);
    expect(short.frames).toBe(0);
    expect(Array.from(short.power).every((v) => v === 0)).toBe(true);
    expect(longTermAverageSpectrum([], SR).frames).toBe(0);
  });

  it('is a power spectrum: doubling the input raises every band by 6.02 dB', () => {
    const x = noise(4 * SR, 0.3, 21);
    const a = longTermAverageSpectrum([x], SR);
    const b = longTermAverageSpectrum([scaled(x, 2)], SR);
    for (const [lo, hi] of [
      [200, 400],
      [700, 1400],
      [2800, 5600],
    ]) {
      expect((bandLevelDb(b, lo, hi) as number) - (bandLevelDb(a, lo, hi) as number)).toBeCloseTo(
        20 * Math.log10(2),
        1
      );
    }
  });
});

describe('bandLevelDb', () => {
  it('returns null for a band that holds no bin of this spectrum', () => {
    const ltas = longTermAverageSpectrum([noise(2 * SR, 0.3, 31)], SR);
    expect(bandLevelDb(ltas, SR / 2 + 1000, SR)).toBeNull();
    // Narrower than one bin spacing, between bins.
    const spacing = SR / LTAS_FFT_SIZE;
    expect(bandLevelDb(ltas, 1000 + spacing * 0.2, 1000 + spacing * 0.3)).toBeNull();
  });

  it('excludes DC — bin 0 cannot reach a band that starts at 0 Hz', () => {
    // Built by hand so the claim is about the exclusion and not about how much
    // of a DC input the analysis window leaks into bins 1 and 2.
    const ltas = syntheticLtas(SR, (f) => (f === 0 ? 100 : 0));
    expect(10 * Math.log10(ltas.power[0])).toBeCloseTo(100, 6);
    expect(bandLevelDb(ltas, 0, 200) as number).toBeCloseTo(0, 6);
    // and with bin 0 quiet instead, the same band reads the same — the band
    // value does not depend on bin 0 at all.
    expect(bandLevelDb(syntheticLtas(SR, () => 0), 0, 200) as number).toBeCloseTo(0, 6);
  });
});

// ── the match curve ─────────────────────────────────────────────────────────

/** An Ltas built by hand with a chosen level in every band — so a curve test
 * does not depend on a synthesised signal landing where it was meant to. */
function syntheticLtas(sampleRate: number, levelAt: (freqHz: number) => number): Ltas {
  const bins = LTAS_FFT_SIZE / 2 + 1;
  const power = new Float64Array(bins);
  for (let k = 0; k < bins; k++) {
    power[k] = Math.pow(10, levelAt((k * sampleRate) / LTAS_FFT_SIZE) / 10);
  }
  return { power, frames: 100, sampleRate };
}

describe('matchCurve', () => {
  it('declares the same band centres as the Graphic EQ that realises it', () => {
    expect(MATCH_BAND_CENTRES_HZ.length).toBe(GRAPHIC_EQ_BANDS.length);
    expect(Array.from(MATCH_BAND_CENTRES_HZ)).toEqual(GRAPHIC_EQ_BANDS.map((b) => b.freq));
  });

  it('gives every centre exactly one status, and the statuses are the whole type', () => {
    const ref = syntheticLtas(44100, () => 0);
    const take = syntheticLtas(48000, () => 0);
    const curve = matchCurve(ref, take);
    expect(curve.bands.map((b) => b.centreHz)).toEqual(Array.from(MATCH_BAND_CENTRES_HZ));

    // Enumerated BY THE COMPILER. A `MatchBandStatus[]` literal is not
    // exhaustiveness-checked — the annotation permits any subset — so the list
    // this was written with could neither notice a fifth member being added nor
    // one being deleted, and the assertion under it only checked that `seen` was
    // a SUBSET of the list, a direction that cannot observe the type at all.
    // The Record cannot be short, and `Object.keys` cannot be long.
    const EVERY_STATUS: Record<MatchBandStatus, true> = {
      matched: true,
      'below-range': true,
      'above-nyquist': true,
      'no-signal': true,
    };
    const all = Object.keys(EVERY_STATUS) as MatchBandStatus[];
    expect(all).toHaveLength(4);
    const seen = new Set(curve.bands.map((b) => b.status));
    for (const s of seen) expect(all).toContain(s);
    // Below-range and above-nyquist must both actually occur on this pair, or
    // this test is asserting nothing about them.
    expect(seen.has('below-range')).toBe(true);
    expect(seen.has('above-nyquist')).toBe(true);
    expect(curve.matchedCount).toBe(curve.bands.filter((b) => b.status === 'matched').length);
  });

  it('produces no-signal — the fourth status, which no other fixture reaches', () => {
    // The status the type declares and nothing else in this suite exercised.
    // Its trigger is a spectrum whose gate found NOTHING sounding: `frames` is
    // zero, so the band levels it holds are an average over no frames and there
    // is nothing to compare. That is a real answer rather than a zero, and it
    // is the case the dialog has a label for.
    const silent: Ltas = { power: new Float64Array(LTAS_FFT_SIZE / 2 + 1), frames: 0, sampleRate: 48000 };
    const curve = matchCurve(silent, syntheticLtas(48000, () => 0));
    const inRange = curve.bands.filter(
      (b) => b.centreHz >= MATCH_MIN_CENTRE_HZ && b.status !== 'above-nyquist'
    );
    expect(inRange.length).toBeGreaterThan(0);
    for (const band of inRange) {
      expect(band.status).toBe('no-signal');
      expect(band.gainDb).toBe(0);
      expect(band.rawDb).toBeNull();
      expect(band.bounded).toBe(false);
    }
    expect(curve.matchedCount).toBe(0);
    // It is the TAKE's gate as well as the reference's — both operands, so the
    // branch is not observed through one of them only.
    const other = matchCurve(syntheticLtas(48000, () => 0), silent);
    expect(other.bands.some((b) => b.status === 'no-signal')).toBe(true);
  });

  it('excludes every centre below MATCH_MIN_CENTRE_HZ and no centre above it', () => {
    const curve = matchCurve(syntheticLtas(44100, () => 0), syntheticLtas(48000, () => 0));
    for (const band of curve.bands) {
      if (band.centreHz < MATCH_MIN_CENTRE_HZ) {
        expect(band.status).toBe('below-range');
        expect(band.gainDb).toBe(0);
        expect(band.rawDb).toBeNull();
      } else {
        expect(band.status).not.toBe('below-range');
      }
    }
    // The boundary itself is IN, and the band below it is out.
    const at = curve.bands.find((b) => b.centreHz === MATCH_MIN_CENTRE_HZ);
    expect(at?.status).toBe('matched');
    expect(curve.bands.find((b) => b.centreHz === MATCH_MIN_CENTRE_HZ / 2)?.status).toBe('below-range');
  });

  it('drops a band whose octave crosses either spectrum\'s Nyquist — below / on / above', () => {
    // The 8 kHz octave reaches 8000*sqrt(2) = 11313.7 Hz. Sample rates chosen so
    // the band's top edge sits below, on and above the resulting Nyquist.
    const statusAt = (refRate: number): MatchBandStatus => {
      const c = matchCurve(syntheticLtas(refRate, () => 0), syntheticLtas(96000, () => 0));
      return c.bands.find((b) => b.centreHz === 8000)!.status;
    };
    expect(statusAt(24000)).toBe('matched'); // Nyquist 12000 > 11313.7
    expect(statusAt(22628)).toBe('matched'); // Nyquist 11314 > 11313.7, just
    expect(statusAt(22626)).toBe('above-nyquist'); // Nyquist 11313 < 11313.7
    expect(statusAt(16000)).toBe('above-nyquist');

    // EITHER side can be the binding one — the rule is min(reference, take), so
    // the same sweep is repeated with the roles swapped.
    const statusWithTakeRate = (takeRate: number): MatchBandStatus =>
      matchCurve(syntheticLtas(96000, () => 0), syntheticLtas(takeRate, () => 0)).bands.find(
        (b) => b.centreHz === 8000
      )!.status;
    expect(statusWithTakeRate(24000)).toBe('matched');
    expect(statusWithTakeRate(22628)).toBe('matched');
    expect(statusWithTakeRate(22626)).toBe('above-nyquist');
    expect(statusWithTakeRate(16000)).toBe('above-nyquist');
  });

  it('carries the SHAPE and not the level: a pure gain difference produces a flat zero curve', () => {
    const ref = syntheticLtas(44100, () => 12);
    const take = syntheticLtas(48000, () => -6);
    const curve = matchCurve(ref, take);
    expect(curve.matchedCount).toBeGreaterThan(0);
    for (const band of curve.bands) {
      if (band.status !== 'matched') continue;
      expect(band.gainDb).toBeCloseTo(0, 6);
      expect(band.rawDb as number).toBeCloseTo(18, 6);
    }
    expect(curve.levelDb).toBeCloseTo(18, 6);
  });

  it('bounds the correction at MATCH_BOUND_DB, both signs, below / on / above', () => {
    // One band pushed away from the rest by `pushDb`. After centring, that band
    // asks for roughly pushDb*(n-1)/n; the fixture uses a push far larger than
    // the bound so the raw difference plainly exceeds it (the brief's
    // requirement) and probes each side of the boundary.
    const runs: { pushDb: number; expectBounded: boolean }[] = [
      { pushDb: 6, expectBounded: false },
      { pushDb: 40, expectBounded: true },
      { pushDb: -40, expectBounded: true },
      { pushDb: -6, expectBounded: false },
    ];
    for (const { pushDb, expectBounded } of runs) {
      const ref = syntheticLtas(44100, (f) => (f >= 1000 / Math.SQRT2 && f < 1000 * Math.SQRT2 ? pushDb : 0));
      const curve = matchCurve(ref, syntheticLtas(48000, () => 0));
      const band = curve.bands.find((b) => b.centreHz === 1000)!;
      expect(band.status).toBe('matched');
      expect(band.bounded).toBe(expectBounded);
      expect(Math.abs(band.gainDb)).toBeLessThanOrEqual(MATCH_BOUND_DB + 1e-9);
      if (expectBounded) {
        expect(band.gainDb).toBeCloseTo(Math.sign(pushDb) * MATCH_BOUND_DB, 9);
        // The RAW difference is what the bound saved the user from.
        expect(Math.abs(band.rawDb as number)).toBeGreaterThan(MATCH_BOUND_DB);
      }
    }
    // The boundary itself, probed on both sides and on it. `exact` is the push
    // that makes the CENTRED value land on the bound: with n matched bands, a
    // push of p on one of them centres to p*(n-1)/n.
    const n = matchCurve(syntheticLtas(44100, () => 0), syntheticLtas(48000, () => 0)).matchedCount;
    expect(n).toBeGreaterThan(1);
    const exact = (MATCH_BOUND_DB * n) / (n - 1);
    const at = (push: number) =>
      matchCurve(
        syntheticLtas(44100, (f) => (f >= 1000 / Math.SQRT2 && f < 1000 * Math.SQRT2 ? push : 0)),
        syntheticLtas(48000, () => 0)
      ).bands.find((b) => b.centreHz === 1000)!;
    expect(at(exact * (1 - 1e-6)).bounded).toBe(false);
    expect(at(exact * (1 + 1e-6)).bounded).toBe(true);
    // Exactly on it, which side the float lands does not matter — the delivered
    // gain is the bound either way.
    expect(at(exact).gainDb).toBeCloseTo(MATCH_BOUND_DB, 9);
    // Just under the bound the gain is NOT the bound, so the assertion above is
    // not satisfied by everything.
    expect(at(exact * 0.9).gainDb).toBeLessThan(MATCH_BOUND_DB - 0.5);
  });

  it('SMOOTHS: a deep narrow notch in the reference barely moves the band', () => {
    // The failure this exists to stop, at the size it was measured: on the real
    // material the reference's spectrum falls off a cliff at the separation
    // model's 22.05 kHz Nyquist, and the worst single bin of the raw difference
    // reads -84.0 dB. Band-energy averaging must not pass that on.
    const notchLo = 1000;
    const notchHi = 1000 + (2 * 44100) / LTAS_FFT_SIZE; // two bins wide
    const ref = syntheticLtas(44100, (f) => (f >= notchLo && f < notchHi ? -84 : 0));
    const curve = matchCurve(ref, syntheticLtas(48000, () => 0));
    const band = curve.bands.find((b) => b.centreHz === 1000)!;
    expect(band.status).toBe('matched');
    expect(Math.abs(band.gainDb)).toBeLessThan(1);
    // and the neighbouring bands are untouched by it
    for (const centre of [500, 2000]) {
      expect(Math.abs(curve.bands.find((b) => b.centreHz === centre)!.gainDb)).toBeLessThan(0.5);
    }
    // A notch that fills the WHOLE band is a real band difference and must come
    // through — otherwise the assertion above would be satisfied by a function
    // that always returns zero.
    const wide = syntheticLtas(44100, (f) => (f >= 1000 / Math.SQRT2 && f < 1000 * Math.SQRT2 ? -12 : 0));
    const wideBand = matchCurve(wide, syntheticLtas(48000, () => 0)).bands.find((b) => b.centreHz === 1000)!;
    expect(wideBand.gainDb).toBeLessThan(-8);
  });

  it('is signed the right way round: the take is moved TOWARD the reference', () => {
    // Reference brighter than the take at 4 kHz -> the 4 kHz band is boosted.
    const ref = syntheticLtas(44100, (f) => (f >= 4000 / Math.SQRT2 && f < 4000 * Math.SQRT2 ? 8 : 0));
    const curve = matchCurve(ref, syntheticLtas(48000, () => 0));
    expect(curve.bands.find((b) => b.centreHz === 4000)!.gainDb).toBeGreaterThan(0);
    const dark = syntheticLtas(44100, (f) => (f >= 4000 / Math.SQRT2 && f < 4000 * Math.SQRT2 ? -8 : 0));
    expect(matchCurve(dark, syntheticLtas(48000, () => 0)).bands.find((b) => b.centreHz === 4000)!.gainDb).toBeLessThan(0);
  });

  it('says so rather than guessing when a side has no sounding frames', () => {
    const empty: Ltas = { power: new Float64Array(LTAS_FFT_SIZE / 2 + 1), frames: 0, sampleRate: 44100 };
    const curve = matchCurve(empty, syntheticLtas(48000, () => 0));
    expect(curve.matchedCount).toBe(0);
    expect(curve.levelDb).toBe(0);
    for (const band of curve.bands) {
      expect(band.gainDb).toBe(0);
      if (band.centreHz >= MATCH_MIN_CENTRE_HZ && band.centreHz * Math.SQRT2 <= 44100 / 2) {
        expect(band.status).toBe('no-signal');
      }
    }
  });

  it('stays inside the Graphic EQ\'s own parameter range', () => {
    const range = GRAPHIC_EQ_BANDS.map((b) => b.id);
    expect(range.length).toBe(MATCH_BAND_CENTRES_HZ.length);
    expect(MATCH_BOUND_DB).toBeLessThan(12); // the effect's declared max
    expect(MATCH_BOUND_DB).toBeGreaterThan(0);
  });
});

// ── reverb ──────────────────────────────────────────────────────────────────

describe('reverbRt60Seconds', () => {
  it('matches the effect\'s own topology at the rates the effect scales to', () => {
    // Recomputed here from the effect's published constants rather than copied
    // from the implementation: feedback 0.7 + 0.28*roomSize, longest comb 1617
    // at 44.1 kHz scaled by round(base*rate/44100).
    for (const rate of [44100, 48000, 96000]) {
      for (const roomSize of [0, 0.25, 0.5, 0.75, 1]) {
        const g = 0.7 + 0.28 * roomSize;
        const d = Math.round((1617 * rate) / 44100);
        expect(reverbRt60Seconds(roomSize, rate)).toBeCloseTo((60 / (-20 * Math.log10(g))) * (d / rate), 9);
      }
    }
  });

  it('is monotonic in room size and floors at the effect\'s own minimum', () => {
    const at = (r: number) => reverbRt60Seconds(r, 48000);
    const min = reverbEffect.params.find((p) => p.id === 'roomSize')?.min;
    expect(min).toBe(0);
    const values = [0, 0.2, 0.4, 0.6, 0.8, 1].map(at);
    for (let i = 1; i < values.length; i++) expect(values[i]).toBeGreaterThan(values[i - 1]);
    expect(at(0)).toBeCloseTo(0.71, 2);
  });

  it('uses the effect\'s longest comb', () => {
    expect(REVERB_LONGEST_COMB_44K).toBe(1617);
  });
});

describe('estimateDecay', () => {
  /** An exponentially decaying noise burst with a known RT60, repeated so there
   * are enough decays to take a median over. */
  function bursts(rt60: number, count: number, gapSec: number, sr = SR): Float32Array {
    const burst = Math.round(gapSec * sr);
    const out = new Float32Array(burst * count);
    const perSample = Math.pow(10, -60 / (20 * rt60 * sr));
    for (let b = 0; b < count; b++) {
      const src = noise(burst, 1, 300 + b);
      let amp = 0.6;
      for (let i = 0; i < burst; i++) {
        out[b * burst + i] = src[i] * amp;
        amp *= perSample;
      }
    }
    return out;
  }

  it('recovers a known decay, across a range of decay times', () => {
    for (const rt60 of [0.3, 0.6, 1.2]) {
      const est = estimateDecay([bursts(rt60, 12, rt60 * 4)], SR);
      expect(est).not.toBeNull();
      const v = est as NonNullable<typeof est>;
      expect(v.count).toBeGreaterThan(4);
      expect(v.seconds).toBeGreaterThan(rt60 * 0.85);
      expect(v.seconds).toBeLessThan(rt60 * 1.15);
    }
  });

  it('separates the decays it is meant to separate — a 4x difference is 4x apart', () => {
    const short = (estimateDecay([bursts(0.3, 12, 1.2)], SR) as { seconds: number }).seconds;
    const long = (estimateDecay([bursts(1.2, 12, 4.8)], SR) as { seconds: number }).seconds;
    expect(long / short).toBeGreaterThan(3);
    expect(long / short).toBeLessThan(5);
  });

  it('reports the quartiles it took the median from, in order', () => {
    const v = estimateDecay([bursts(0.6, 16, 2.4)], SR) as NonNullable<ReturnType<typeof estimateDecay>>;
    expect(v.p25Seconds).toBeLessThanOrEqual(v.seconds);
    expect(v.seconds).toBeLessThanOrEqual(v.p75Seconds);
    expect(v.count).toBeGreaterThan(0);
  });

  it('rejects a fall that never reaches the bottom of the T20 range', () => {
    // Decays 15 dB and then holds. There is a long, clean, straight fall here —
    // it just is not a 20 dB one, and measuring T20 off it would extrapolate a
    // decay that is not happening. Without the -25 dB requirement the flat tail
    // joins the fit and the slope collapses.
    const burstLen = Math.round(2 * SR);
    const out = new Float32Array(burstLen * 10);
    const floor = 0.6 * Math.pow(10, -15 / 20);
    for (let b = 0; b < 10; b++) {
      const src = noise(burstLen, 1, 500 + b);
      const perSample = Math.pow(10, -60 / (20 * 0.5 * SR));
      let amp = 0.6;
      for (let i = 0; i < burstLen; i++) {
        out[b * burstLen + i] = src[i] * Math.max(amp, floor);
        amp *= perSample;
      }
    }
    expect(estimateDecay([out], SR)).toBeNull();
  });

  it('throws RAGGED fits away — that is what the linearity check does', () => {
    // The same 0.6 s decay with a swept amount of block-to-block jitter on it.
    // Ragged material still contains clean sub-stretches, so the check does not
    // (and should not) return null; what it does is refuse most of them. The
    // bounds below are two-sided on purpose: the clean floor fails if the
    // threshold is raised until real decays are rejected, and the ragged
    // ceilings fail if it is lowered until it accepts everything (measured with
    // the check disabled: 137 fits at 6 dB and 83 at 12 dB, against 67 and 29).
    const ragged = (jitterDb: number): Float32Array => {
      const burstLen = Math.round(2 * SR);
      const blockLen = Math.round(0.05 * SR);
      const out = new Float32Array(burstLen * 10);
      for (let b = 0; b < 10; b++) {
        const src = noise(burstLen, 1, 700 + b);
        const jitter = noise(Math.ceil(burstLen / blockLen), jitterDb, 800 + b);
        const perSample = Math.pow(10, -60 / (20 * 0.6 * SR));
        let amp = 0.6;
        for (let i = 0; i < burstLen; i++) {
          out[b * burstLen + i] = src[i] * amp * Math.pow(10, jitter[Math.floor(i / blockLen)] / 20);
          amp *= perSample;
        }
      }
      return out;
    };
    const clean = estimateDecay([ragged(0)], SR) as NonNullable<ReturnType<typeof estimateDecay>>;
    expect(clean.count).toBeGreaterThanOrEqual(8);
    expect(clean.seconds).toBeGreaterThan(0.55);
    expect(clean.seconds).toBeLessThan(0.65);

    const at6 = estimateDecay([ragged(6)], SR) as NonNullable<ReturnType<typeof estimateDecay>>;
    const at12 = estimateDecay([ragged(12)], SR) as NonNullable<ReturnType<typeof estimateDecay>>;
    expect(at6.count).toBeLessThan(100);
    expect(at12.count).toBeLessThan(60);
    // and raggedness shows up where it should: in the quartile spread.
    expect(at12.p75Seconds / at12.p25Seconds).toBeGreaterThan(clean.p75Seconds / clean.p25Seconds);
    expect(at12.p75Seconds / at12.p25Seconds).toBeLessThan(2.2);
  });

  it('LIMITATION: a curved fall with no reverb in it is accepted, and read as reverb', () => {
    // Pinned because the module claims it. Amplitude falling linearly is bent in
    // dB and contains no reverberation whatsoever, yet it clears the linearity
    // check by more than either validated reverb control does — so a decay this
    // estimator reports is evidence of a fall, not proof of a room. It is why
    // the report recommends the matched-reverb stage stay off rather than
    // trusting a number this returns.
    const burstLen = Math.round(2 * SR);
    const out = new Float32Array(burstLen * 10);
    for (let b = 0; b < 10; b++) {
      const src = noise(burstLen, 1, 700 + b);
      for (let i = 0; i < burstLen; i++) {
        out[b * burstLen + i] = src[i] * 0.6 * Math.max(0, 1 - i / burstLen);
      }
    }
    const est = estimateDecay([out], SR);
    expect(est).not.toBeNull();
    expect((est as { seconds: number }).seconds).toBeGreaterThan(1);
  });

  it('returns null rather than a number when nothing decays cleanly', () => {
    expect(estimateDecay([], SR)).toBeNull();
    expect(estimateDecay([new Float32Array(4)], SR)).toBeNull();
    // Steady noise has no offsets to measure.
    expect(estimateDecay([noise(4 * SR, 0.4, 41)], SR)).toBeNull();
    // Digital silence decays nowhere.
    expect(estimateDecay([new Float32Array(4 * SR)], SR)).toBeNull();
  });

  it('measures the app\'s own reverb close to its closed form', () => {
    // The end-to-end claim the report rests on, at the smallest scale that can
    // carry it: a click train through the real effect, against the formula.
    const clicks = new Float32Array(6 * SR);
    for (let i = 0; i < 6; i++) clicks[i * SR] = 1;
    const roomSize = 1;
    const wet = reverbEffect.process([clicks], SR, { roomSize, damping: 0, mix: 1, preDelayMs: 0 });
    const est = estimateDecay(wet.channels, SR);
    expect(est).not.toBeNull();
    const expected = reverbRt60Seconds(roomSize, SR);
    const measured = (est as { seconds: number }).seconds;
    expect(measured).toBeGreaterThan(expected * 0.7);
    expect(measured).toBeLessThan(expected * 1.3);
  });
});
