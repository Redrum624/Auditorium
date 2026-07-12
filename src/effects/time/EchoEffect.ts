import type { EffectDefinition } from '../types';
import { maybeReportProgress } from '../dynamics/envelope';

const MAX_TAIL_SECONDS = 10;

/**
 * Number of echo repeats needed for `feedback^n` to decay below -60dB
 * (0.001 linear), times the delay length — this is how far past the input
 * the echo tail needs to extend before it's inaudible. `feedback` is floored
 * at 0.01 so a near-zero feedback still yields a small, finite tail (a single
 * audible repeat) rather than a division producing a huge/negative result.
 * Capped at `MAX_TAIL_SECONDS` so pathological params (long delay, feedback
 * near the 0.9 max) can't produce an unbounded output length.
 */
function computeTailSamples(delaySamples: number, feedback: number, sampleRate: number): number {
  const fb = Math.max(feedback, 0.01);
  const repeats = Math.max(1, Math.ceil(Math.log(0.001) / Math.log(fb)));
  const tail = delaySamples * repeats;
  return Math.min(tail, Math.round(MAX_TAIL_SECONDS * sampleRate));
}

/**
 * Feedback delay ("echo"). Convention (documented since the brief leaves the
 * exact split ambiguous): the wet accumulator `wet[i] = in[i] + feedback *
 * wet[i-D]` (input treated as 0 beyond the source length) holds the full
 * feedback chain; the audible output reads it ONE delay late, so for an
 * impulse at t=0 the DRY sample at t=0 carries amplitude `(1-mix)`, the first
 * echo at t=D carries `mix` (== mix * wet[0] == mix * 1), the second at t=2D
 * carries `mix * feedback`, etc.
 *
 * `pingPong` (stereo only, ignored for mono): the wet accumulators cross-feed
 * from the OPPOSITE channel (`wetL[i] = inL[i] + fb*wetR[i-D]`), and the
 * output also READS the opposite channel's accumulator. Net effect: for an
 * impulse in L only, the first repeat (t=D) appears in R, the second (t=2D)
 * bounces back to L, alternating and decaying by `feedback` each hop.
 */
export const echoEffect: EffectDefinition = {
  id: 'echo',
  name: 'Echo',
  category: 'Delay & Reverb',
  params: [
    { id: 'delayMs', label: 'Delay', type: 'number', min: 1, max: 2000, step: 1, unit: 'ms', default: 350 },
    { id: 'feedback', label: 'Feedback', type: 'number', min: 0, max: 0.9, step: 0.01, default: 0.35 },
    { id: 'mix', label: 'Mix', type: 'number', min: 0, max: 1, step: 0.01, default: 0.35 },
    { id: 'pingPong', label: 'Ping-Pong', type: 'boolean', default: false },
  ],
  process(channels, sampleRate, params, onProgress) {
    const delayMs = Number(params.delayMs ?? 350);
    const feedback = Number(params.feedback ?? 0.35);
    const mix = Number(params.mix ?? 0.35);
    const numCh = channels.length;
    const pingPong = Boolean(params.pingPong ?? false) && numCh === 2;

    const N = channels[0]?.length ?? 0;
    const D = Math.max(1, Math.round((delayMs / 1000) * sampleRate));
    const tail = computeTailSamples(D, feedback, sampleRate);
    const outLen = N + tail;

    const wet: Float32Array[] = Array.from({ length: numCh }, () => new Float32Array(outLen));
    const out: Float32Array[] = Array.from({ length: numCh }, () => new Float32Array(outLen));

    for (let i = 0; i < outLen; i++) {
      // Accumulate the feedback chain first (cross-fed from the opposite
      // channel's accumulator when ping-ponging), then read it for output.
      for (let ch = 0; ch < numCh; ch++) {
        const dry = i < N ? channels[ch][i] : 0;
        const sourceCh = pingPong ? 1 - ch : ch;
        const fed = i - D >= 0 ? wet[sourceCh][i - D] : 0;
        wet[ch][i] = dry + feedback * fed;
      }
      for (let ch = 0; ch < numCh; ch++) {
        const dry = i < N ? channels[ch][i] : 0;
        const readCh = pingPong ? 1 - ch : ch;
        const wetDelayed = i - D >= 0 ? wet[readCh][i - D] : 0;
        out[ch][i] = dry * (1 - mix) + mix * wetDelayed;
      }
      maybeReportProgress(onProgress, i, outLen);
    }

    return { channels: out };
  },
};
