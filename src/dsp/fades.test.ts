import {
  FADE_CURVES,
  FADE_CURVE_LABELS,
  FADE_CURVE_DESCRIPTIONS,
  fadeInShape,
  fadeOutShape,
  fadeInGainAt,
  fadeOutGainAt,
  applyFadeIn,
  applyFadeOut,
  applyFadeInStartingAt,
  applyFadeOutEndingAt,
  crossfadeGains,
} from './fades';
import type { FadeCurve } from './fades';

/** Dense sweep of ramp positions, including both endpoints and the exact
 * centre (where every level claim in the module doc is stated). */
const US = Array.from({ length: 201 }, (_, i) => i / 200);

/** dB of a linear amplitude ratio, for the level claims. */
function db(ratio: number): number {
  return 20 * Math.log10(ratio);
}

function filled(value: number, n: number, channels = 1): Float32Array[] {
  return Array.from({ length: channels }, () => Float32Array.from({ length: n }, () => value));
}

// ---------------------------------------------------------------------------
// 1. The curve set as an interface (these names reach the UI in X4)
// ---------------------------------------------------------------------------

describe('the curve set', () => {
  it('offers exactly the four curves the plan requires, each with a label and a description', () => {
    expect([...FADE_CURVES].sort()).toEqual(['equal-gain', 'equal-power', 'exponential', 'smooth']);
    for (const curve of FADE_CURVES) {
      expect(FADE_CURVE_LABELS[curve].length).toBeGreaterThan(0);
      expect(FADE_CURVE_DESCRIPTIONS[curve].length).toBeGreaterThan(0);
    }
  });

  it('offers equal-power first -- it is the safe default for two different sources', () => {
    expect(FADE_CURVES[0]).toBe('equal-power');
  });
});

// ---------------------------------------------------------------------------
// 2. Shape invariants -- what makes something usable as a SOLO fade
// ---------------------------------------------------------------------------

describe.each(FADE_CURVES)('%s shape', (curve: FadeCurve) => {
  it('terminates at 0 and 1, in both directions', () => {
    expect(fadeInShape(0, curve)).toBe(0);
    expect(fadeInShape(1, curve)).toBe(1);
    expect(fadeOutShape(0, curve)).toBe(1);
    // `equal-power` is the one curve whose fade-out does not reach LITERAL
    // zero: `Math.cos(Math.PI / 2)` is 6.123e-17, about -324 dB. That
    // residue is in the shipped auto-remix tail fade and is pinned by the
    // golden fixture (its last sample is 6.98e-19, exactly this residue
    // times the source sample), so forcing an exact zero here would change
    // rendered output. Asserted as "inaudibly zero", which is the truth,
    // rather than papered over.
    expect(Math.abs(fadeOutShape(1, curve))).toBeLessThan(1e-15);
  });

  it('reaches exactly zero at the end of the fade-out, except for equal-power', () => {
    // Split out from the assertion above so the exception is explicit and a
    // regression in one of the other three curves cannot hide behind it.
    if (curve === 'equal-power') {
      expect(fadeOutShape(1, curve)).toBe(Math.cos(Math.PI / 2));
      expect(fadeOutShape(1, curve)).not.toBe(0);
    } else {
      expect(fadeOutShape(1, curve)).toBe(0);
    }
  });

  it('never exceeds unity anywhere -- a solo fade may not boost', () => {
    for (const u of US) {
      expect(fadeInShape(u, curve)).toBeLessThanOrEqual(1);
      expect(fadeOutShape(u, curve)).toBeLessThanOrEqual(1);
      expect(fadeInShape(u, curve)).toBeGreaterThanOrEqual(0);
      expect(fadeOutShape(u, curve)).toBeGreaterThanOrEqual(0);
    }
  });

  it('is monotonic: the fade-in never falls, the fade-out never rises', () => {
    let prevIn = -Infinity;
    let prevOut = Infinity;
    for (const u of US) {
      const gIn = fadeInShape(u, curve);
      const gOut = fadeOutShape(u, curve);
      expect(gIn).toBeGreaterThanOrEqual(prevIn);
      expect(gOut).toBeLessThanOrEqual(prevOut);
      prevIn = gIn;
      prevOut = gOut;
    }
  });

  it('is the mirror of itself: fadeOut(u) === fadeIn(1 - u) to within 1e-12', () => {
    // Deliberately NOT bit-exact: the two sides are written as separate
    // expressions on purpose (each in the float form the shipped code used),
    // so they agree mathematically, not necessarily in the last bit. This
    // test is what would catch one of them being edited on its own.
    for (const u of US) {
      expect(fadeOutShape(u, curve)).toBeCloseTo(fadeInShape(1 - u, curve), 12);
    }
  });

  it('clamps out-of-range positions instead of extrapolating', () => {
    expect(fadeInShape(-5, curve)).toBe(fadeInShape(0, curve));
    expect(fadeInShape(7, curve)).toBe(fadeInShape(1, curve));
    expect(fadeOutShape(-5, curve)).toBe(fadeOutShape(0, curve));
    expect(fadeOutShape(7, curve)).toBe(fadeOutShape(1, curve));
  });
});

// ---------------------------------------------------------------------------
// 3. Power preservation, per curve (the plan's own acceptance criterion)
//
// "Power-preserving" is not one property -- it depends on how the two sides
// sum. Identical material sums by AMPLITUDE, independent material sums by
// POWER, and a curve that is exact for one is wrong for the other. Each curve
// is asserted against the claim its own description makes, and against the
// measured size of the error it makes in the other case. A test that only
// checked the good case would pass for a curve that was wrong everywhere.
// ---------------------------------------------------------------------------

/** Level of the sum of two signals with correlation `rho`, given the two
 * gains -- the same expression the gain law's exactness proof uses. */
function summedLevel(gOut: number, gIn: number, rho: number): number {
  return Math.sqrt(gOut * gOut + gIn * gIn + 2 * rho * gOut * gIn);
}

describe('power preservation of the raw shapes (no correlation compensation)', () => {
  it('equal-power holds the level of UNCORRELATED material exactly', () => {
    for (const u of US) {
      expect(summedLevel(fadeOutShape(u, 'equal-power'), fadeInShape(u, 'equal-power'), 0)).toBeCloseTo(1, 12);
    }
  });

  it('equal-power BUMPS +3.01 dB at the centre on identical material -- the reason it is not the only curve', () => {
    const g = summedLevel(fadeOutShape(0.5, 'equal-power'), fadeInShape(0.5, 'equal-power'), 1);
    expect(db(g)).toBeCloseTo(3.0103, 3);
  });

  it('equal-gain holds the level of IDENTICAL material exactly', () => {
    for (const u of US) {
      expect(summedLevel(fadeOutShape(u, 'equal-gain'), fadeInShape(u, 'equal-gain'), 1)).toBeCloseTo(1, 12);
    }
  });

  it('equal-gain DIPS -3.01 dB at the centre on uncorrelated material', () => {
    const g = summedLevel(fadeOutShape(0.5, 'equal-gain'), fadeInShape(0.5, 'equal-gain'), 0);
    expect(db(g)).toBeCloseTo(-3.0103, 3);
  });

  it('smooth holds the level of IDENTICAL material exactly, like equal-gain, but with eased ends', () => {
    for (const u of US) {
      expect(summedLevel(fadeOutShape(u, 'smooth'), fadeInShape(u, 'smooth'), 1)).toBeCloseTo(1, 12);
    }
    // The distinguishing property: zero slope at both ends, where equal-gain
    // has slope 1. Measured over the first 1/200 of the ramp.
    const smoothSlope = fadeInShape(1 / 200, 'smooth') * 200;
    const linearSlope = fadeInShape(1 / 200, 'equal-gain') * 200;
    expect(smoothSlope).toBeLessThan(linearSlope / 10);
  });

  it('exponential is deliberately NOT level-preserving: -6.02 dB by amplitude at the centre', () => {
    const gOut = fadeOutShape(0.5, 'exponential');
    const gIn = fadeInShape(0.5, 'exponential');
    expect(db(summedLevel(gOut, gIn, 1))).toBeCloseTo(-6.0206, 3);
    expect(db(summedLevel(gOut, gIn, 0))).toBeCloseTo(-9.0309, 3);
  });
});

describe('power preservation THROUGH the crossfade law (every curve, every rho)', () => {
  // The `k` normaliser makes the identity hold for any non-negative gain
  // pair, so the curve chooses the trajectory of the handover and never its
  // loudness. This is the property both auto-remix and the manual crossfade
  // depend on, and it is what makes offering four curves safe.
  it('holds gOut^2 + gIn^2 + 2*rho*gOut*gIn === 1 for every curve, rho and t', () => {
    let worst = 0;
    for (const curve of FADE_CURVES) {
      for (const rho of [0, 0.25, 0.5, 0.75, 1]) {
        for (const u of US) {
          const { gOut, gIn } = crossfadeGains(u, rho, curve);
          worst = Math.max(worst, Math.abs(summedLevel(gOut, gIn, rho) - 1));
        }
      }
    }
    expect(worst).toBeLessThan(1e-12);
  });

  it('never returns a gain above unity, for any curve or rho', () => {
    // `k >= sqrt(g0^2 + g1^2) >= max(g0, g1)`, so each gain is at most 1
    // however the curve and rho combine. That bound is what makes the law
    // safe to apply to already-normalised audio.
    for (const curve of FADE_CURVES) {
      for (const rho of [0, 0.25, 0.5, 0.75, 1]) {
        for (const u of US) {
          const { gOut, gIn } = crossfadeGains(u, rho, curve);
          expect(gOut).toBeLessThanOrEqual(1);
          expect(gIn).toBeLessThanOrEqual(1);
          expect(gOut).toBeGreaterThanOrEqual(0);
          expect(gIn).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });

  it('compensation only rescales -- it never reorders the handover', () => {
    // The curve chooses the trajectory and `k` chooses the level, so the
    // ratio gOut/gIn must be the raw shapes' ratio, untouched by rho.
    for (const curve of FADE_CURVES) {
      for (const rho of [0, 0.5, 1]) {
        for (const u of US.slice(1, -1)) {
          const { gOut, gIn } = crossfadeGains(u, rho, curve);
          expect(gOut / gIn).toBeCloseTo(fadeOutShape(u, curve) / fadeInShape(u, curve), 9);
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Ruling 8 / trap T9 -- a solo fade is NOT half a crossfade
// ---------------------------------------------------------------------------

describe('a solo fade is not half a crossfade', () => {
  it('crossfadeGains(...).gIn is off by 1/k in BOTH directions, so it is not a fade-in curve', () => {
    // Equal-power at rho = 1: k = sqrt(2), so `gIn` SAGS 3.01 dB below the
    // honest ramp at the centre. A clip fade-in built from it would duck.
    const sagging = crossfadeGains(0.5, 1).gIn;
    const soloPower = fadeInShape(0.5, 'equal-power');
    expect(soloPower / sagging).toBeCloseTo(Math.SQRT2, 12);
    expect(db(sagging / soloPower)).toBeCloseTo(-3.0103, 3);

    // Equal-gain at rho = 0: k = sqrt(0.5), so `gIn` BULGES 3.01 dB above
    // the honest ramp at the centre. Same function, opposite error --
    // there is no single correction that turns one into the other.
    const bulging = crossfadeGains(0.5, 0, 'equal-gain').gIn;
    const soloGain = fadeInShape(0.5, 'equal-gain');
    expect(db(bulging / soloGain)).toBeCloseTo(3.0103, 3);
  });

  it('the honest fade-in curve terminates at exactly 1, for every curve', () => {
    for (const curve of FADE_CURVES) {
      expect(fadeInShape(1, curve)).toBe(1);
    }
  });

  it('rho is not a knob: negative correlation is rendered as 0, never as an unbounded gain', () => {
    for (const rho of [-1, -0.75, -0.5, -1e-9]) {
      expect(crossfadeGains(0.5, rho)).toEqual(crossfadeGains(0.5, 0));
    }
    // Above 1 is clamped too, so a caller cannot drive k past its bound.
    expect(crossfadeGains(0.5, 5)).toEqual(crossfadeGains(0.5, 1));
  });
});

// ---------------------------------------------------------------------------
// 5. The scalar accessors and their singleton convention (trap T3)
// ---------------------------------------------------------------------------

describe('fadeInGainAt / fadeOutGainAt', () => {
  it('agree with the shapes at every step of a ramp', () => {
    const n = 64;
    for (const curve of FADE_CURVES) {
      for (let i = 0; i < n; i++) {
        expect(fadeInGainAt(i, n, curve)).toBe(fadeInShape(i / (n - 1), curve));
        expect(fadeOutGainAt(i, n, curve)).toBe(fadeOutShape(i / (n - 1), curve));
      }
    }
  });

  it('returns the caller-chosen gain for a ONE-SAMPLE window, defaulting to 1', () => {
    // The two conventions in the shipped renderer are deliberately different
    // -- a fade meeting adjacent silence must end at 0 even when it is one
    // sample long, while a fade that merely trails off must not zero a
    // legitimate final sample. Both are exercised here because neither is
    // reachable from the auto-remix fixtures.
    for (const curve of FADE_CURVES) {
      expect(fadeOutGainAt(0, 1, curve)).toBe(1);
      expect(fadeOutGainAt(0, 1, curve, 0)).toBe(0);
      expect(fadeInGainAt(0, 1, curve)).toBe(1);
      expect(fadeInGainAt(0, 1, curve, 0)).toBe(0);
      expect(fadeOutGainAt(0, 0, curve, 0.5)).toBe(0.5);
    }
  });
});

// ---------------------------------------------------------------------------
// 6. The float expressions are the ones the shipped renderer used
//
// This is the non-tautological half of "the extraction was faithful". The
// expected values below are INDEPENDENT copies of the expressions that lived
// in `remixRender.ts` before X1 moved them, asserted bit-for-bit. The
// rendered-audio golden pin cannot cover this: every fade there is applied to
// a Float32Array, and float32 store-rounding absorbs sub-ulp drift (measured
// -- see `__fixtures__/remixGoldenCases.ts`). A "simplification" of these
// expressions would leave that pin green and this test red.
// ---------------------------------------------------------------------------

describe('the extracted expressions are bit-for-bit the ones remixRender.ts shipped', () => {
  const n = 1024;

  it('equal-power fade-out is the quarter-cosine helper, verbatim', () => {
    for (let i = 0; i < n; i++) {
      const historical = n > 1 ? Math.cos((i / (n - 1)) * (Math.PI / 2)) : 1;
      expect(fadeOutGainAt(i, n, 'equal-power')).toBe(historical);
    }
  });

  it('equal-gain fade-out is the linear helper, verbatim (both singleton conventions)', () => {
    for (let i = 0; i < n; i++) {
      const historical = n > 1 ? 1 - i / (n - 1) : 1;
      expect(fadeOutGainAt(i, n, 'equal-gain')).toBe(historical);
      expect(fadeOutGainAt(i, n, 'equal-gain', 0)).toBe(n > 1 ? 1 - i / (n - 1) : 0);
    }
  });

  it('smooth and exponential are FadeEffect.ts curves, verbatim', () => {
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      expect(fadeInGainAt(i, n, 'smooth')).toBe((1 - Math.cos(Math.PI * t)) / 2);
      expect(fadeOutGainAt(i, n, 'smooth')).toBe((1 - Math.cos(Math.PI * (1 - t))) / 2);
      expect(fadeInGainAt(i, n, 'exponential')).toBe(t * t);
      expect(fadeOutGainAt(i, n, 'exponential')).toBe((1 - t) * (1 - t));
    }
  });

  it('crossfadeGains at the default curve is the renderer\'s own arithmetic, verbatim', () => {
    for (let i = 0; i < 257; i++) {
      const t = i / 256;
      for (const rho of [0, 0.3, 0.4937, 1]) {
        const tc = Math.max(0, Math.min(1, t));
        const rc = Math.max(0, Math.min(1, rho));
        const theta = (Math.PI * tc) / 2;
        const g0 = Math.cos(theta);
        const g1 = Math.sin(theta);
        const k = Math.sqrt(1 + 2 * rc * g0 * g1);
        const actual = crossfadeGains(t, rho);
        expect(actual.gOut).toBe(g0 / k);
        expect(actual.gIn).toBe(g1 / k);
      }
    }
  });

  it('the default curve IS equal-power, bit-for-bit', () => {
    for (let i = 0; i < 65; i++) {
      const t = i / 64;
      expect(crossfadeGains(t, 0.5)).toEqual(crossfadeGains(t, 0.5, 'equal-power'));
    }
  });
});

// ---------------------------------------------------------------------------
// 7. Buffer helpers: window placement, in-place mutation, float32 rounding
// ---------------------------------------------------------------------------

describe('applyFadeOut / applyFadeIn (buffer-end and buffer-start anchored)', () => {
  it('shapes only the last fadeLen samples and leaves the rest untouched', () => {
    const ch = filled(1, 100);
    applyFadeOut(ch, 10, 'equal-gain');
    for (let i = 0; i < 90; i++) expect(ch[0][i]).toBe(1);
    for (let i = 0; i < 10; i++) expect(ch[0][90 + i]).toBeCloseTo(1 - i / 9, 6);
  });

  it('shapes only the FIRST fadeLen samples for a fade-in', () => {
    const ch = filled(1, 100);
    applyFadeIn(ch, 10, 'equal-gain');
    for (let i = 0; i < 10; i++) expect(ch[0][i]).toBeCloseTo(i / 9, 6);
    for (let i = 10; i < 100; i++) expect(ch[0][i]).toBe(1);
  });

  it('mutates in place and returns nothing -- callers that must not disturb the source pass a copy', () => {
    const ch = filled(1, 8);
    const same = ch[0];
    const result: void = applyFadeOut(ch, 8, 'equal-gain');
    expect(result).toBeUndefined();
    expect(ch[0]).toBe(same);
    expect(same[7]).toBe(0);
  });

  it('applies ONE shared gain ramp across every channel', () => {
    const ch = filled(1, 32, 3);
    ch[1].fill(0.5);
    ch[2].fill(-1);
    applyFadeOut(ch, 32, 'equal-power');
    for (let i = 0; i < 32; i++) {
      const g = fadeOutGainAt(i, 32, 'equal-power');
      expect(ch[0][i]).toBe(Math.fround(g));
      expect(ch[1][i]).toBe(Math.fround(0.5 * g));
      expect(ch[2][i]).toBe(Math.fround(-g));
    }
  });

  it('rounds every faded sample to float32 -- the store rounding is part of the contract', () => {
    // A double-precision implementation would keep more bits here; the
    // renderer's pinned output depends on it not doing so.
    //
    // R2-3b (v1.9.2, round 2): probed at index 1 of a FOUR-sample exponential
    // ramp, where the gain is (1 - 1/3)^2 = 4/9 -- genuinely < 1 and NOT a
    // dyadic rational. The original probe sat at index 0 of a 3-sample ramp,
    // gain exactly 1, so both assertions held even if applyFadeOut wrote
    // nothing (the Float32Array constructor had already narrowed the source
    // on assignment); and every n=3 exponential gain (1, 0.25, 0) is
    // unity-or-dyadic, which only shifts the float exponent and cannot expose
    // the store rounding either (trap T12).
    //
    // The source is fround(0.7), CHOSEN BY EXECUTION (round 2, reviewer
    // finding): with fround(1/3), fr(x*fr(g)) === fr(x*g) at BOTH non-dyadic
    // n=4 gains, so a pre-narrowed float32 gain (e.g. a Float32Array gain
    // LUT) -- the exact refactor this test exists to catch -- still passed.
    // With fround(0.7) the three failure modes are all distinct at this
    // probe: skipping the write, keeping double bits, and pre-narrowing the
    // gain each produce a different stored value than the contract
    // fr(fround(0.7) * g_double), one narrowing at the store.
    const ch = filled(1, 4);
    ch[0][1] = 0.7;
    applyFadeOut(ch, 4, 'exponential');
    const gain = fadeOutGainAt(1, 4, 'exponential'); // (2/3)^2, double precision
    expect(gain).toBeLessThan(1);
    expect(gain).toBeGreaterThan(0);
    expect(ch[0][1]).toBe(Math.fround(Math.fround(0.7) * gain));
    expect(Object.is(ch[0][1], Math.fround(0.7) * gain)).toBe(false);
    expect(Object.is(ch[0][1], Math.fround(Math.fround(0.7) * Math.fround(gain)))).toBe(false);
  });

  it('is a no-op for a non-positive fadeLen', () => {
    const ch = filled(0.25, 16);
    applyFadeOut(ch, 0, 'equal-gain');
    applyFadeOut(ch, -5, 'equal-gain');
    applyFadeIn(ch, 0, 'equal-gain');
    for (let i = 0; i < 16; i++) expect(ch[0][i]).toBe(0.25);
  });

  it('a fadeLen longer than the buffer fades the whole buffer, it does not overrun', () => {
    const ch = filled(1, 5);
    applyFadeOut(ch, 500, 'equal-gain');
    expect(ch[0][0]).toBe(1);
    expect(ch[0][4]).toBe(0);
  });

  it('a fade-IN longer than the buffer still REACHES UNITY by the last sample', () => {
    // The counterpart of the assertion above, and the one that matters most
    // in practice: `n` is `min(fadeLen, len)`, so an over-long fade-in
    // spreads its full 0 -> 1 ramp across the buffer it actually has. Drop
    // that clamp and `n` becomes the requested length, so the visible part is
    // only the ramp's quiet beginning -- a 2 s fade-in requested on a 1 s
    // clip would play the whole clip attenuated (here: last sample at 4/499
    // instead of 1, about -42 dB) and never arrive at full level. A fade
    // handle dragged past the end of a clip reaches exactly this.
    const ch = filled(1, 5);
    applyFadeIn(ch, 500, 'equal-gain');
    expect(ch[0][0]).toBe(0);
    expect(ch[0][4]).toBe(1);
    for (let i = 0; i < 5; i++) expect(ch[0][i]).toBeCloseTo(i / 4, 6);
  });
});

describe('applyFadeOutEndingAt / applyFadeInStartingAt (arbitrary window)', () => {
  it('fades the window ending at endPos, leaving everything after it untouched', () => {
    const ch = filled(1, 100);
    applyFadeOutEndingAt(ch, 50, 10, 'equal-gain');
    for (let i = 0; i < 40; i++) expect(ch[0][i]).toBe(1);
    for (let i = 0; i < 10; i++) expect(ch[0][40 + i]).toBeCloseTo(1 - i / 9, 6);
    for (let i = 50; i < 100; i++) expect(ch[0][i]).toBe(1);
  });

  it('fades the window starting at startPos, leaving everything before it untouched', () => {
    const ch = filled(1, 100);
    applyFadeInStartingAt(ch, 50, 10, 'equal-gain');
    for (let i = 0; i < 50; i++) expect(ch[0][i]).toBe(1);
    for (let i = 0; i < 10; i++) expect(ch[0][50 + i]).toBeCloseTo(i / 9, 6);
    for (let i = 60; i < 100; i++) expect(ch[0][i]).toBe(1);
  });

  it('compresses the ramp rather than reading out of bounds when the window runs off the near edge', () => {
    const ch = filled(1, 20);
    applyFadeOutEndingAt(ch, 5, 50, 'equal-gain');
    // start clamps to 0, so the ramp spans 5 samples, not 50.
    for (let i = 0; i < 5; i++) expect(ch[0][i]).toBeCloseTo(1 - i / 4, 6);
    for (let i = 5; i < 20; i++) expect(ch[0][i]).toBe(1);
  });

  it('compresses a fade-IN window that starts before sample 0, and touches nothing past it', () => {
    // The near-edge counterpart for the fade-in direction. X5 positions
    // overlap fade-ins by absolute sample, so a window beginning before 0 is
    // routine, not a defensive corner. `start` clamps to 0 and `n` shortens
    // with it: a [-5, 5) window is a 5-sample ramp reaching unity at sample
    // 4. Without the shortening, `n` stays 10 -- the ramp lands at half
    // slope AND runs five samples past where the fade was asked to end,
    // overwriting audio that was never part of it.
    const ch = filled(1, 20);
    applyFadeInStartingAt(ch, -5, 10, 'equal-gain');
    for (let i = 0; i < 5; i++) expect(ch[0][i]).toBeCloseTo(i / 4, 6);
    for (let i = 5; i < 20; i++) expect(ch[0][i]).toBe(1);
  });

  it('does NOT consult the buffer length: a fade-in window past the end silently drops its overhang', () => {
    // Trap T8: these helpers rely on out-of-range writes being no-ops, and
    // must never clamp to "whatever the buffer happens to be".
    const ch = filled(1, 10);
    expect(() => applyFadeInStartingAt(ch, 5, 20, 'equal-gain')).not.toThrow();
    expect(ch[0][5]).toBe(0);
    for (let i = 6; i < 10; i++) expect(ch[0][i]).toBeLessThan(1);
    expect(ch[0].length).toBe(10);
  });

  it('does NOT consult the buffer length: a fade-OUT window ending past the end keeps its absolute placement', () => {
    // The failure this pins: clamping `endPos` to the buffer length would
    // still produce a monotone ramp ending at 0, so every "it fades" check
    // stays green while the ramp silently moves to a different position and
    // a different slope. Here the window is [5, 15) of a 10-sample buffer,
    // so the visible part is the ramp's FIRST half -- gains 1 down to 5/9,
    // never reaching 0 -- not a full ramp compressed into [0, 10).
    const ch = filled(1, 10);
    expect(() => applyFadeOutEndingAt(ch, 15, 10, 'equal-gain')).not.toThrow();
    for (let i = 0; i < 5; i++) expect(ch[0][i]).toBe(1);
    for (let i = 0; i < 5; i++) expect(ch[0][5 + i]).toBeCloseTo(1 - i / 9, 6);
    expect(ch[0][9]).toBeCloseTo(5 / 9, 6);
    expect(ch[0].length).toBe(10);
  });

  it('honours singletonGain 0 for a one-sample window -- the convention the tail taper needs', () => {
    const ch = filled(1, 10);
    applyFadeOutEndingAt(ch, 5, 1, 'equal-gain', 0);
    expect(ch[0][4]).toBe(0);
    expect(ch[0][3]).toBe(1);
    expect(ch[0][5]).toBe(1);
  });

  it('honours the default singletonGain 1 for a one-sample window -- the convention the trim fade needs', () => {
    const ch = filled(1, 10);
    applyFadeOutEndingAt(ch, 5, 1, 'equal-gain');
    expect(ch[0][4]).toBe(1);
  });

  it('is a no-op for a non-positive fadeLen', () => {
    const ch = filled(0.75, 10);
    applyFadeOutEndingAt(ch, 5, 0, 'equal-gain');
    applyFadeInStartingAt(ch, 5, -1, 'equal-gain');
    for (let i = 0; i < 10; i++) expect(ch[0][i]).toBe(0.75);
  });
});

// ---------------------------------------------------------------------------
// 7. Two-curve pairs (v1.9 X3): the outgoing and incoming sides of a manual
// crossfade may carry DIFFERENT curves. `curveIn` defaults to `curve`, so
// this section also pins that every pre-existing single-curve call is
// untouched by the extension.
// ---------------------------------------------------------------------------

describe('crossfadeGains with two curves', () => {
  const RHOS = [0, 0.25, 0.5, 0.75, 1];

  it('reduces exactly to the single-curve call when curveIn is omitted or equal', () => {
    for (const curve of FADE_CURVES) {
      for (const rho of RHOS) {
        for (const u of US) {
          expect(crossfadeGains(u, rho, curve)).toEqual(crossfadeGains(u, rho, curve, curve));
        }
      }
    }
  });

  it('holds the level identity gOut^2 + gIn^2 + 2*rho*gOut*gIn === 1 for every mixed pair', () => {
    for (const curveOut of FADE_CURVES) {
      for (const curveIn of FADE_CURVES) {
        for (const rho of RHOS) {
          for (const u of US) {
            const { gOut, gIn } = crossfadeGains(u, rho, curveOut, curveIn);
            expect(gOut * gOut + gIn * gIn + 2 * rho * gOut * gIn).toBeCloseTo(1, 12);
          }
        }
      }
    }
  });

  it('computes a mixed pair as the two RAW facing shapes over k, bit-for-bit', () => {
    for (const curveOut of FADE_CURVES) {
      for (const curveIn of FADE_CURVES) {
        if (curveOut === 'equal-power' && curveIn === 'equal-power') continue; // fast path, pinned elsewhere
        for (const rho of RHOS) {
          for (const u of [0, 0.1, 0.3, 0.5, 0.7, 0.9, 1]) {
            const g0 = fadeOutShape(u, curveOut);
            const g1 = fadeInShape(u, curveIn);
            const k = Math.sqrt(g0 * g0 + g1 * g1 + 2 * rho * g0 * g1);
            const { gOut, gIn } = crossfadeGains(u, rho, curveOut, curveIn);
            expect(gOut).toBe(g0 / k);
            expect(gIn).toBe(g1 / k);
          }
        }
      }
    }
  });

  it('actually honours the second curve (a mixed pair matches NEITHER same-curve law)', () => {
    const mixed = crossfadeGains(0.3, 0, 'exponential', 'equal-power');
    const allOut = crossfadeGains(0.3, 0, 'exponential');
    const allIn = crossfadeGains(0.3, 0, 'equal-power');
    expect(Math.abs(mixed.gIn - allOut.gIn)).toBeGreaterThan(1e-3);
    expect(Math.abs(mixed.gOut - allIn.gOut)).toBeGreaterThan(1e-3);
  });

  it('keeps the continuity endpoints for every mixed pair: {1, 0} at t=0 and {~0, 1} at t=1', () => {
    // These endpoints are what make a clip crossfade splice-continuous with
    // the un-faded audio on either side of the overlap.
    for (const curveOut of FADE_CURVES) {
      for (const curveIn of FADE_CURVES) {
        for (const rho of RHOS) {
          const at0 = crossfadeGains(0, rho, curveOut, curveIn);
          expect(at0.gOut).toBe(1);
          expect(at0.gIn).toBe(0);
          const at1 = crossfadeGains(1, rho, curveOut, curveIn);
          expect(at1.gOut).toBeLessThanOrEqual(6.2e-17); // equal-power's cos(pi/2) residue at most
          expect(at1.gIn).toBeCloseTo(1, 12);
        }
      }
    }
  });
});
