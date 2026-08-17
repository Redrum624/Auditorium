import type { EffectDefinition } from '../types';
import { designBiquad, designOnePoleLowpass, processBiquad } from '../../dsp/biquad';
import { envelopeFollower, maxAcrossChannels, maybeReportProgress } from './envelope';

/**
 * Butterworth Q. Two cascaded sections at the same corner make the sidechain
 * highpass 4th-order (Linkwitz-Riley): -6 dB at fc, -24 dB an octave below,
 * -48 dB two octaves below. The DETECTOR has to be this steep even though the
 * split is not, because it is what decides whether a vowel counts as
 * sibilance.
 */
const SIDECHAIN_Q = Math.SQRT1_2;

/**
 * Hard-knee downward reduction, in dB, for a detector sitting `overDb` above
 * the threshold. Below and exactly AT the threshold there is no reduction —
 * `overDb === 0` is the no-op case, so the de-esser only ever engages on
 * material that genuinely exceeds the threshold. `ratio === 1` is likewise a
 * no-op at any level (slope 0).
 *
 * No soft knee, unlike the compressor: the sibilance detector already smooths
 * with attack/release, and a de-esser is dialled in by ear through the Listen
 * switch, where a hard boundary is easier to hear and place than a knee.
 */
export function sibilanceReductionDb(overDb: number, ratio: number): number {
  return overDb > 0 ? overDb * (1 - 1 / ratio) : 0;
}

/**
 * Sidechain detector: the input band-limited to the sibilance region by a
 * 24 dB/oct highpass, linked across channels with `maxAcrossChannels` — the
 * same linking every dynamics effect here uses, the limiter included — then
 * smoothed by the shared attack/release `envelopeFollower`, which is the
 * compressor's and the gate's detector exactly. The limiter is NOT in that
 * second list: it has no attack, and smooths its own gain from a forward
 * lookahead window instead of following an input envelope.
 *
 * The intermediates are scoped to this function so the filtered band (one
 * Float32Array per channel) is collectable before the output pass allocates.
 */
function sibilanceEnvelope(
  channels: Float32Array[],
  sampleRate: number,
  freqHz: number,
  attackMs: number,
  releaseMs: number
): Float32Array {
  const coeffs = designBiquad('highpass', sampleRate, freqHz, SIDECHAIN_Q);
  const band = channels.map((c) => processBiquad(processBiquad(c, coeffs), coeffs));
  return envelopeFollower(maxAcrossChannels(band), sampleRate, attackMs, releaseMs);
}

/**
 * De-esser — sibilance control for voice. Split-band: the input is split at
 * `freqHz` into a low band and its exact complement, the high band is pulled
 * down while a sidechain detector says sibilance is present, and the bands are
 * recombined.
 *
 * SPLIT. Two cascaded `designOnePoleLowpass` sections (12 dB/oct, -6 dB at the
 * corner) give the low band; the high band is the residual `x - low`. The two
 * therefore sum back to the input SAMPLE-EXACTLY, so with no reduction the
 * output is bit-identical to the input — a de-esser that colours the signal at
 * rest would be a filter pretending to be a dynamics processor. Recombination
 * is written as `x - (1 - g) * high` rather than `low + g * high` so that
 * `g === 1` cancels the whole correction term arithmetically instead of relying
 * on `low + (x - low)` rounding back to `x`; `g === 1` is additionally
 * short-circuited to a straight copy, which makes the identity hold for -0
 * samples too.
 *
 * TWO sections, measured, not assumed. Any subtractive split leaves part of the
 * band behind in the low half, which caps how much sibilance the effect can
 * actually remove. Driven to its limit (threshold -50 dB, ratio 20) on the
 * reference vocal below, one section removes 4.2 dB from sibilant frames on
 * average (worst frame -8.5 dB), two remove 7.7 dB (worst -17.1 dB), and a
 * 2nd-order Butterworth low half removes 6.6 dB (worst -15.9 dB); the cost in
 * vowel damage over the same run is -0.01, -0.04 and -0.01 dB respectively,
 * i.e. nothing in every case, because vowels are held out by the detector
 * rather than by the split. Two sections it is. Three would reach deeper still
 * (-9.5 dB) but widen the residual's bump at the corner for less and less
 * return.
 *
 * The residual of a cascade is `1 - H^2`, which rises ABOVE unity: +0.97 dB at
 * the corner itself and peaking at +1.25 dB near `sqrt(2)*fc` (one section's
 * residual peaks nowhere — `1 - H` is monotonic up to 0 dB). That bump cannot
 * make the OUTPUT boost: the recombined response is `1 - (1 - g)(1 - H^2)`, and since
 * |H^2| <= 1 everywhere, Re(1 - H^2) >= 0, so pulling the band down can only
 * shrink the response, never lift it and never invert it. A 4th-order
 * Linkwitz-Riley low half would break that — its residual peaks +3.5 dB and
 * cancels to a null once the band is pulled past ~9.5 dB.
 *
 * DETECTION IS SEPARATE FROM THE SPLIT, and deliberately much steeper. Any
 * subtractive split has a 6 dB/oct skirt reaching down into the vowel range, so
 * using the split band as its own detector would let a loud vowel open the
 * processor. The sidechain instead runs a 24 dB/oct highpass at the same
 * corner: an octave below `freqHz` a vowel reads 24 dB lower, so it never
 * crosses the threshold and the gain stays at exactly 1 — the vowel is not
 * attenuated, it is not touched at all.
 *
 * LISTEN monitors what is being REMOVED (`x - output`), not the sibilance band
 * and not the processed signal. Silence means nothing is being removed; if you
 * hear consonant detail or breath in it rather than just "sss", the frequency
 * or the threshold is wrong. This is the only practical way to dial the effect
 * in: nobody can judge a 3 dB reduction at 6 kHz in context.
 *
 * WHERE THE DEFAULTS COME FROM. Measured on a real 142 s solo vocal
 * (`test-assets/long-real-take.wav`, 48 kHz stereo, program RMS -27.8 dBFS), frames
 * classified as sibilant (5-12 kHz band energy above the 200-1500 Hz formant
 * band energy) vs vowel (25 dB below it):
 * - `freqHz` 5500. Sweeping the crossover across 3-11 kHz and comparing the
 *   share of frame energy landing above it for the two classes, selectivity is
 *   highest at 5.5 kHz within that swept window (+30.7 dB), and falls to
 *   +25.0 dB at 4 kHz and +19.0 dB at 3 kHz as vowel and consonant energy enter
 *   the band. It is a plateau, not a spike: 5.0-6.0 kHz all sit within 0.3 dB,
 *   and 6.5-10 kHz stays within 0.6 dB of it, so the exact figure inside the
 *   plateau matters far less than staying out of the collapse below 5 kHz.
 *   This agrees with the speech-acoustics
 *   literature once you keep the crossover and the sibilant peak distinct —
 *   Jongman, Wayland & Wong, "Acoustic characteristics of English fricatives",
 *   JASA 108(3):1252-1263 (2000), put /s/ and /z/ energy above 4 kHz with major
 *   peaks at 6-8 kHz, and the crossover belongs BELOW that peak so the band
 *   captures it while staying clear of the formants. The range reaches down to
 *   2 kHz because /sh/ sits well below /s/, and up past the 10.5 kHz spectral
 *   peak measured on this take.
 * - `thresholdDb` -30. On the same take the sidechain envelope reads -21.0 dBFS
 *   at the loudest sibilant and -32.8 dBFS at the median one, while vowel
 *   frames read -50.9 dBFS at the median, -37.8 dBFS at the 99th percentile and
 *   -29.17 dBFS at the single loudest of the 11643 of them. So -30 dBFS sits
 *   inside the loudest third of the sibilants and MARGINALLY INSIDE the very
 *   loudest vowel frames — 0.83 dB below that maximum, not above it. Measured
 *   consequence at the default: exactly 1 vowel frame in 11643 has any sample
 *   changed at all, and its level change is 0.000 dB. The default is where it
 *   is because that is the operating point measured on real speech; the claim
 *   it does NOT support is "no vowel is ever touched", and the honest one is
 *   "vowels are untouched but for a hairline at the very top, with no
 *   measurable effect". It is an absolute level, like the compressor's and the
 *   gate's, so a hotter recording needs it raised — that is what Listen is for.
 *   Boosting this take by +5 dB touches 45 vowel frames (worst -0.057 dB) and
 *   by +20 dB, 5178 (worst -0.632 dB).
 * - `ratio` 4, matching the compressor's shipped default; with the threshold
 *   above, the loudest sibilants on the measured take are pulled down 6-7 dB
 *   and the quieter ones proportionally less.
 * - `attackMs` 1 / `releaseMs` 30. Measured sibilant bursts on the take run
 *   5 ms (p10), 37 ms (p50), 85 ms (p90). A 1 ms attack is >99% engaged after
 *   4.6 ms, so it catches even the shortest burst; a 30 ms release is back to
 *   within 1/e of unity inside one median burst, so the reduction does not
 *   linger over the following vowel, while still being ~165x the 0.18 ms period
 *   of the 5.5 kHz band, so it tracks the burst instead of its waveform.
 */
export const deEsserEffect: EffectDefinition = {
  id: 'de-esser',
  name: 'De-esser',
  category: 'Dynamics',
  params: [
    { id: 'freqHz', label: 'Frequency', type: 'number', min: 2000, max: 12000, step: 50, unit: 'Hz', default: 5500 },
    { id: 'thresholdDb', label: 'Threshold', type: 'number', min: -60, max: 0, step: 0.1, unit: 'dB', default: -30 },
    { id: 'ratio', label: 'Ratio', type: 'number', min: 1, max: 20, step: 0.1, default: 4 },
    { id: 'attackMs', label: 'Attack', type: 'number', min: 0.1, max: 50, step: 0.1, unit: 'ms', default: 1 },
    { id: 'releaseMs', label: 'Release', type: 'number', min: 5, max: 500, step: 1, unit: 'ms', default: 30 },
    { id: 'listen', label: 'Listen (removed sibilance)', type: 'boolean', default: false },
  ],
  process(channels, sampleRate, params, onProgress) {
    const freqHz = Number(params.freqHz ?? 5500);
    const thresholdDb = Number(params.thresholdDb ?? -30);
    const ratio = Number(params.ratio ?? 4);
    const attackMs = Number(params.attackMs ?? 1);
    const releaseMs = Number(params.releaseMs ?? 30);
    const listen = Boolean(params.listen ?? false);

    const length = channels[0]?.length ?? 0;
    const nyquist = sampleRate / 2;

    // A crossover at or above Nyquist (or a non-positive / NaN one) leaves no
    // sibilance band to act on, so there is nothing to remove: pass the input
    // through, or emit silence in listen mode. Matches how DeHum and the
    // parametric EQ drop filter stages at or above Nyquist rather than
    // designing a filter out of a meaningless corner.
    //
    // `>=` rather than `>` is load-bearing AT the boundary, not only past it.
    // At exactly Nyquist tan(pi*f/fs) is huge but finite, so the coefficients
    // come out b0 = b1 = 0.9999999999999999 and a1 = 0.9999999999999998 — a
    // NEAR pole-zero cancellation, off by ~2e-13, feeding a marginally stable
    // recursion whose residual neither decays nor stays negligible against a
    // decaying signal. Dropping the equality lets that residual through: on a
    // fading fixture it changes over a thousand samples. Pinned by test.
    if (!(freqHz > 0) || freqHz >= nyquist) {
      return { channels: channels.map((c) => (listen ? new Float32Array(c.length) : Float32Array.from(c))) };
    }

    // The gain is linked across channels, so it is resolved once for the whole
    // signal before any channel is written. It is folded back into the envelope
    // array in place — that array is ours and its envelope values are dead the
    // moment they become a gain, so reusing it saves a full-length allocation.
    // Storing gains at float32 costs ~1e-7 of relative precision on the
    // correction term, well under the audio LSB, and leaves the one value that
    // must stay exact — 1, the no-reduction case — exact.
    const gains = sibilanceEnvelope(channels, sampleRate, freqHz, attackMs, releaseMs);
    for (let i = 0; i < length; i++) {
      const envDb = 20 * Math.log10(Math.max(gains[i], 1e-6));
      gains[i] = Math.pow(10, -sibilanceReductionDb(envDb - thresholdDb, ratio) / 20);
    }

    // Channel-outer, so only ONE channel's low band is alive at a time rather
    // than one per channel.
    const splitCoeffs = designOnePoleLowpass(sampleRate, freqHz);
    const out = channels.map((c) => new Float32Array(c.length));
    const totalSamples = channels.length * length;
    for (let ch = 0; ch < channels.length; ch++) {
      const src = channels[ch];
      const dst = out[ch];
      const low = processBiquad(processBiquad(src, splitCoeffs), splitCoeffs);
      for (let i = 0; i < length; i++) {
        const gain = gains[i];
        if (gain === 1) {
          dst[i] = listen ? 0 : src[i];
        } else {
          const x = src[i];
          const removed = (1 - gain) * (x - low[i]);
          dst[i] = listen ? removed : x - removed;
        }
        maybeReportProgress(onProgress, ch * length + i, totalSamples);
      }
    }

    return { channels: out };
  },
};
