import {
  SPEAKER_BACK_LEFT,
  SPEAKER_BACK_RIGHT,
  SPEAKER_FRONT_CENTER,
  SPEAKER_FRONT_LEFT,
  SPEAKER_FRONT_RIGHT,
  SPEAKER_LOW_FREQUENCY,
  SPEAKER_SIDE_LEFT,
  SPEAKER_SIDE_RIGHT,
  bs775Applicable,
  downmixBs775,
} from './downmix';

// The Recommendation's coefficient, written OUT here rather than imported from
// the implementation: Rec. ITU-R BS.775-3, Annex 4, Table 2, "Stereo – 2/0"
// row — L' = 1.0000·L + 0.7071·C + 0.7071·Ls (0.7071 = 1/√2 at 4 dp; this is
// the full-precision double).
const G = 0.7071067811865476;

const MASK_5_1_BACK = SPEAKER_FRONT_LEFT | SPEAKER_FRONT_RIGHT | SPEAKER_FRONT_CENTER | SPEAKER_LOW_FREQUENCY | SPEAKER_BACK_LEFT | SPEAKER_BACK_RIGHT; // 0x3f
const MASK_5_1_SIDE = SPEAKER_FRONT_LEFT | SPEAKER_FRONT_RIGHT | SPEAKER_FRONT_CENTER | SPEAKER_LOW_FREQUENCY | SPEAKER_SIDE_LEFT | SPEAKER_SIDE_RIGHT; // 0x60f
const MASK_QUAD = SPEAKER_FRONT_LEFT | SPEAKER_FRONT_RIGHT | SPEAKER_BACK_LEFT | SPEAKER_BACK_RIGHT; // 0x33
const MASK_5_0 = SPEAKER_FRONT_LEFT | SPEAKER_FRONT_RIGHT | SPEAKER_FRONT_CENTER | SPEAKER_BACK_LEFT | SPEAKER_BACK_RIGHT; // 0x37
const MASK_7_1 = MASK_5_1_BACK | SPEAKER_SIDE_LEFT | SPEAKER_SIDE_RIGHT; // 0x63f — back AND side pairs

describe('bs775Applicable', () => {
  it.each([
    ['5.1 with back surrounds', MASK_5_1_BACK, 6],
    ['5.1 with side surrounds', MASK_5_1_SIDE, 6],
    ['5.0 (no LFE)', MASK_5_0, 5],
    ['quad (2/2)', MASK_QUAD, 4],
    ['3/0 (L R C)', SPEAKER_FRONT_LEFT | SPEAKER_FRONT_RIGHT | SPEAKER_FRONT_CENTER, 3],
    ['2.1 (L R LFE)', SPEAKER_FRONT_LEFT | SPEAKER_FRONT_RIGHT | SPEAKER_LOW_FREQUENCY, 3],
  ])('covers %s', (_name, mask, numChannels) => {
    expect(bs775Applicable(mask, numChannels)).toBe(true);
  });

  it.each([
    ['an absent mask', undefined, 6],
    ['mask 0 (unspecified layout)', 0, 6],
    ['mono/stereo (nothing to fold)', SPEAKER_FRONT_LEFT | SPEAKER_FRONT_RIGHT, 2],
    ['7.1 — both surround pairs is the 3/4 family, not in the Annex 4 2/0 table', MASK_7_1, 8],
    ['a lone surround (BL without BR)', SPEAKER_FRONT_LEFT | SPEAKER_FRONT_RIGHT | SPEAKER_BACK_LEFT, 3],
    ['a position the matrix has no column for (BACK_CENTER 0x100)', SPEAKER_FRONT_LEFT | SPEAKER_FRONT_RIGHT | 0x100, 3],
    ['a top/height position (TOP_CENTER 0x800)', MASK_5_1_BACK | 0x800, 7],
    ['missing FL/FR (the unity terms)', SPEAKER_FRONT_CENTER | SPEAKER_BACK_LEFT | SPEAKER_BACK_RIGHT, 3],
    ['popcount below the channel count', MASK_5_1_BACK, 7],
    ['popcount above the channel count', MASK_5_1_BACK, 5],
  ])('rejects %s', (_name, mask, numChannels) => {
    expect(bs775Applicable(mask as number | undefined, numChannels)).toBe(false);
  });
});

/** Channels in mask-bit order carrying distinct, easily-traced values. */
function makeChannels(values: number[][]): Float32Array[] {
  return values.map((v) => Float32Array.from(v));
}

describe('downmixBs775', () => {
  it('applies the Annex 4 Table 2 2/0 row to a 5.1 (back) layout — expectations computed inline', () => {
    // Mask-bit order: FL FR FC LFE BL BR.
    const fl = [0.1, -0.2];
    const fr = [0.05, 0.3];
    const fc = [0.2, 0.1];
    const lfe = [0.9, -0.9]; // must NOT appear in the output
    const bl = [0.1, 0.05];
    const br = [-0.1, 0.2];
    const channels = makeChannels([fl, fr, fc, lfe, bl, br]);
    const [L, R] = downmixBs775(channels, MASK_5_1_BACK);

    for (let i = 0; i < 2; i++) {
      // Same accumulation order the module documents: front + centre + surround.
      const expectedL = Math.fround(channels[0][i] + G * channels[2][i] + G * channels[4][i]);
      const expectedR = Math.fround(channels[1][i] + G * channels[2][i] + G * channels[5][i]);
      expect(L[i]).toBe(expectedL);
      expect(R[i]).toBe(expectedR);
    }
  });

  it('discards LFE: a full-scale LFE channel changes nothing', () => {
    const base = makeChannels([[0.1], [0.2], [0.3], [0], [0.1], [-0.1]]);
    const loud = makeChannels([[0.1], [0.2], [0.3], [1.0], [0.1], [-0.1]]);
    expect(downmixBs775(loud, MASK_5_1_BACK)).toEqual(downmixBs775(base, MASK_5_1_BACK));
  });

  it('treats side surrounds as the Recommendation Ls/Rs: 5.1(side) output equals 5.1(back) for the same values', () => {
    const values = [[0.1], [0.2], [0.3], [0.4], [0.15], [-0.15]];
    expect(downmixBs775(makeChannels(values), MASK_5_1_SIDE)).toEqual(
      downmixBs775(makeChannels(values), MASK_5_1_BACK)
    );
  });

  it('maps roles by MASK BITS, not fixed indices: a 5.0 layout has its surrounds at indices 3/4', () => {
    // Mask-bit order without LFE: FL FR FC BL BR — surround channels sit at
    // indices 3 and 4, where 5.1's LFE and BL sit. An index-hardcoded matrix
    // would fold the wrong channels here.
    const fl = [0.1];
    const fr = [0.2];
    const fc = [0.3];
    const bl = [0.4];
    const br = [-0.4];
    const channels = makeChannels([fl, fr, fc, bl, br]);
    const [L, R] = downmixBs775(channels, MASK_5_0);
    expect(L[0]).toBe(Math.fround(channels[0][0] + G * channels[2][0] + G * channels[3][0]));
    expect(R[0]).toBe(Math.fround(channels[1][0] + G * channels[2][0] + G * channels[4][0]));
  });

  it('a 2.1 layout passes the fronts through untouched and drops the LFE', () => {
    const channels = makeChannels([[0.25], [-0.5], [0.9]]); // FL FR LFE
    const mask = SPEAKER_FRONT_LEFT | SPEAKER_FRONT_RIGHT | SPEAKER_LOW_FREQUENCY;
    const [L, R] = downmixBs775(channels, mask);
    expect(L[0]).toBe(channels[0][0]);
    expect(R[0]).toBe(channels[1][0]);
  });

  it('a quad (2/2) layout folds only the surrounds (no centre term)', () => {
    const channels = makeChannels([[0.1], [0.2], [0.3], [-0.3]]); // FL FR BL BR
    const [L, R] = downmixBs775(channels, MASK_QUAD);
    expect(L[0]).toBe(Math.fround(channels[0][0] + G * channels[2][0]));
    expect(R[0]).toBe(Math.fround(channels[1][0] + G * channels[3][0]));
  });

  it('pins the exact coefficient: unit centre alone lands at 0.7071067811865476 on both sides', () => {
    const channels = makeChannels([[0], [0], [1], [0], [0], [0]]);
    const [L, R] = downmixBs775(channels, MASK_5_1_BACK);
    expect(L[0]).toBe(Math.fround(0.7071067811865476));
    expect(R[0]).toBe(Math.fround(0.7071067811865476));
  });

  it('hard-clamps the summed output to ±1 on both sides (the raw 2/0 sum can reach ≈2.41)', () => {
    // FL FR FC LFE BL BR: L = 0.9 + G·1 ≈ 1.61 → 1; R = −0.9 + G·(−1) ≈ −1.61 → −1.
    const hot = makeChannels([[0.9], [-0.9], [0], [0], [1], [-1]]);
    const [L, R] = downmixBs775(hot, MASK_5_1_BACK);
    expect(L[0]).toBe(1);
    expect(R[0]).toBe(-1);
  });

  it('throws on a layout it does not cover instead of guessing (callers fall back via the dispatcher)', () => {
    const channels = makeChannels([[0], [0], [0], [0], [0], [0], [0], [0]]);
    expect(() => downmixBs775(channels, MASK_7_1)).toThrow(
      'BS.775 downmix requires a known, supported channel layout'
    );
  });
});
