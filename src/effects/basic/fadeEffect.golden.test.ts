/**
 * THE DOCUMENT-FADE GOLDEN PIN (v1.9 X6).
 *
 * ## Why this file exists
 *
 * X6 routes the destructive document-level Fade effect through the shared
 * curve family in `src/dsp/fades.ts` and adds a curve and a length parameter.
 * Users have projects rendered with the three curves that already shipped
 * (`linear`, `exponential`, `cosine`); a silent change to what any of them
 * renders is the same class of harm ruling 10 forbids for sessions. This pin
 * makes "the refactor changed nothing" falsifiable: every sample of every
 * case below is stored as an EXACT source literal (via `numberLiteral`, which
 * round-trips the sign of zero), generated from the code as it stood BEFORE
 * the refactor and committed first. A one-ulp drift in any curve fails the
 * comparison and names the sample.
 *
 * The cases cover: all three shipped curves x both directions on an awkward
 * stereo buffer (values that do not survive float32 rounding trivially), the
 * one-sample selection (where fade-in zeroes the sample -- signed zero
 * included -- and fade-out leaves it), the empty selection, the no-channel
 * call, the all-defaults call, and an unknown curve id (which falls back to
 * linear). Together those drive every branch the v1.8.0 implementation had.
 *
 * ## Regenerating (deliberately awkward)
 *
 *     FADE_GOLDEN_PRINT=1 npx jest src/effects/basic/fadeEffect.golden.test.ts
 *
 * prints a ready-to-paste `FADE_GOLDEN` block and skips the comparisons. Do
 * that only when the document fade's rendered output was MEANT to move, and
 * commit the regeneration on its own with the reason.
 */
import { fadeEffect } from './FadeEffect';
import { numberLiteral } from '../../dsp/__fixtures__/float32Digest';

const SR = 44100;
const PRINT_MODE = process.env.FADE_GOLDEN_PRINT === '1';

/** Awkward stereo material: mixed signs, values that round on the way into
 * float32 (1/3, 2/3, 1/7, 0.925), and exact endpoints (-1, 0.8). */
const stereo7 = (): Float32Array[] => [
  Float32Array.from([0.1, -0.9, 1 / 3, 0.7, -0.25, 2 / 3, -1]),
  Float32Array.from([-0.6, 0.45, -1 / 7, 0.925, 0.005, -0.375, 0.8]),
];

/** One negative sample: pins that a fade-in's zeroing multiply produces the
 * SIGNED zero the shipped code produced (`-0.7 * 0` is `-0`, not `0`). */
const mono1 = (): Float32Array[] => [Float32Array.from([-0.7])];

const mono5 = (): Float32Array[] => [Float32Array.from([0.5, -0.5, 0.25, -0.125, 1])];

const mono0 = (): Float32Array[] => [new Float32Array(0)];

interface PinCase {
  key: string;
  channels: () => Float32Array[];
  params: Record<string, number | string | boolean>;
}

const CURVES = ['linear', 'exponential', 'cosine'] as const;
const DIRECTIONS = ['in', 'out'] as const;

const PIN_CASES: PinCase[] = [
  ...CURVES.flatMap((curve) =>
    DIRECTIONS.flatMap((direction) => [
      { key: `${curve}-${direction}-stereo7`, channels: stereo7, params: { curve, direction } },
      { key: `${curve}-${direction}-mono1`, channels: mono1, params: { curve, direction } },
    ])
  ),
  // All defaults: direction 'in', curve 'linear'.
  { key: 'defaults-mono5', channels: mono5, params: {} },
  // Unknown curve id falls into the switch's default branch: linear.
  { key: 'unknown-curve-out-mono5', channels: mono5, params: { curve: 'wavelet', direction: 'out' } },
  { key: 'linear-in-mono0', channels: mono0, params: { curve: 'linear', direction: 'in' } },
];

function renderLiterals(c: PinCase): string[][] {
  const result = fadeEffect.process(c.channels(), SR, c.params);
  return result.channels.map((ch) => Array.from(ch).map(numberLiteral));
}

if (PRINT_MODE) {
  it('prints the FADE_GOLDEN block (print mode; comparisons skipped)', () => {
    const lines = PIN_CASES.map((c) => {
      const chans = renderLiterals(c)
        .map((chan) => `[${chan.map((v) => `'${v}'`).join(', ')}]`)
        .join(', ');
      return `  '${c.key}': [${chans}],`;
    });
    // eslint-disable-next-line no-console
    console.log(`const FADE_GOLDEN: Record<string, string[][]> = {\n${lines.join('\n')}\n};`);
  });
} else {
  describe('document Fade effect golden pin (three shipped curves, byte-exact)', () => {
    it.each(PIN_CASES.map((c) => [c.key, c] as const))('%s renders byte-identically', (_key, c) => {
      const expected = FADE_GOLDEN[c.key];
      expect(expected).toBeDefined();
      const actual = renderLiterals(c);
      expect(actual).toEqual(expected);
    });

    it('reports one progress tick per channel, as fractions of the channel count', () => {
      const ticks: number[] = [];
      fadeEffect.process(stereo7(), SR, { curve: 'cosine', direction: 'out' }, (f) => ticks.push(f));
      expect(ticks).toEqual([0.5, 1]);
    });

    it('a call with zero channels returns zero channels and never reports progress', () => {
      const ticks: number[] = [];
      const result = fadeEffect.process([], SR, { curve: 'linear', direction: 'in' }, (f) => ticks.push(f));
      expect(result.channels).toEqual([]);
      expect(ticks).toEqual([]);
    });
  });
}

// Generated with FADE_GOLDEN_PRINT=1 against the v1.8.0 implementation
// (three curves, fade spanning the whole selection), BEFORE the X6 refactor.
const FADE_GOLDEN: Record<string, string[][]> = {
  'linear-in-stereo7': [['0', '-0.14999999105930328', '0.1111111119389534', '0.3499999940395355', '-0.1666666716337204', '0.5555555820465088', '-1'], ['-0', '0.07499999552965164', '-0.0476190485060215', '0.4625000059604645', '0.003333333181217313', '-0.3125', '0.800000011920929']],
  'linear-in-mono1': [['-0']],
  'linear-out-stereo7': [['0.10000000149011612', '-0.75', '0.2222222238779068', '0.3499999940395355', '-0.0833333358168602', '0.1111111119389534', '-0'], ['-0.6000000238418579', '0.375', '-0.095238097012043', '0.4625000059604645', '0.0016666665906086564', '-0.0625', '0']],
  'linear-out-mono1': [['-0.699999988079071']],
  'exponential-in-stereo7': [['0', '-0.02499999850988388', '0.03703703731298447', '0.17499999701976776', '-0.1111111119389534', '0.4629629850387573', '-1'], ['-0', '0.01249999925494194', '-0.01587301678955555', '0.23125000298023224', '0.002222222276031971', '-0.2604166567325592', '0.800000011920929']],
  'exponential-in-mono1': [['-0']],
  'exponential-out-stereo7': [['0.10000000149011612', '-0.625', '0.14814814925193787', '0.17499999701976776', '-0.02777777798473835', '0.018518518656492233', '-0'], ['-0.6000000238418579', '0.3125', '-0.0634920671582222', '0.23125000298023224', '0.0005555555690079927', '-0.010416666977107525', '0']],
  'exponential-out-mono1': [['-0.699999988079071']],
  'cosine-in-stereo7': [['0', '-0.06028856709599495', '0.0833333358168602', '0.3499999940395355', '-0.1875', '0.6220085024833679', '-1'], ['-0', '0.030144283547997475', '-0.0357142873108387', '0.4625000059604645', '0.0037499999161809683', '-0.34987977147102356', '0.800000011920929']],
  'cosine-in-mono1': [['-0']],
  'cosine-out-stereo7': [['0.10000000149011612', '-0.8397114276885986', '0.25', '0.3499999940395355', '-0.0625', '0.044658198952674866', '-0'], ['-0.6000000238418579', '0.4198557138442993', '-0.1071428656578064', '0.4625000059604645', '0.0012499999720603228', '-0.025120235979557037', '0']],
  'cosine-out-mono1': [['-0.699999988079071']],
  'defaults-mono5': [['0', '-0.125', '0.125', '-0.09375', '1']],
  'unknown-curve-out-mono5': [['0.5', '-0.375', '0.125', '-0.03125', '0']],
  'linear-in-mono0': [[]],
};
