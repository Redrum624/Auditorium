import type { EffectDefinition } from '../types';
import { maybeReportProgress } from '../dynamics/envelope';

// Freeverb comb/allpass delay tunings, in samples at the 44.1kHz reference
// rate. Scaled per-instance by `sampleRate / 44100` (rounded) so the same
// topology holds its character at other sample rates.
const COMB_TUNING_44K = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617];
const ALLPASS_TUNING_44K = [556, 441, 341, 225];
const ALLPASS_G = 0.5;
const STEREO_SPREAD_SAMPLES = 23; // right channel only, added post-scaling

/** Schroeder comb filter with damped feedback (the Freeverb variant): the
 * feedback path passes through a one-pole lowpass (`filterStore`) so higher
 * `damping` darkens the decay, matching hardware plate/room reverbs. */
class Comb {
  private readonly buffer: Float32Array;
  private idx = 0;
  private filterStore = 0;

  constructor(
    delaySamples: number,
    private readonly feedback: number,
    private readonly damping: number
  ) {
    this.buffer = new Float32Array(Math.max(1, delaySamples));
  }

  process(input: number): number {
    const output = this.buffer[this.idx];
    this.filterStore = output * (1 - this.damping) + this.filterStore * this.damping;
    this.buffer[this.idx] = input + this.filterStore * this.feedback;
    this.idx = (this.idx + 1) % this.buffer.length;
    return output;
  }
}

/** Schroeder allpass filter, fixed gain `g` (0.5, per Freeverb). */
class Allpass {
  private readonly buffer: Float32Array;
  private idx = 0;

  constructor(
    delaySamples: number,
    private readonly g: number
  ) {
    this.buffer = new Float32Array(Math.max(1, delaySamples));
  }

  process(input: number): number {
    const bufOut = this.buffer[this.idx];
    const output = -input + bufOut;
    this.buffer[this.idx] = input + bufOut * this.g;
    this.idx = (this.idx + 1) % this.buffer.length;
    return output;
  }
}

function scaleDelay(base44k: number, sampleRate: number, spread: number): number {
  return Math.round((base44k * sampleRate) / 44100) + spread;
}

/**
 * Freeverb-topology reverb: per channel, 8 parallel damped combs feed 4
 * series allpasses. Right channel delays get +23 samples (stereo spread) so
 * L/R decay textures differ slightly; mono has none. `preDelayMs` silences
 * the wet path's input for that long before the reverb network sees it (the
 * dry path is untouched, so `mix=0` is an exact passthrough for `[0,N)`).
 * Tail: 3s at `roomSize<=0.5`, scaling linearly up to 8s at `roomSize=1`.
 */
export const reverbEffect: EffectDefinition = {
  id: 'reverb',
  name: 'Reverb',
  category: 'Delay & Reverb',
  params: [
    { id: 'roomSize', label: 'Room Size', type: 'number', min: 0, max: 1, step: 0.01, default: 0.5 },
    { id: 'damping', label: 'Damping', type: 'number', min: 0, max: 1, step: 0.01, default: 0.5 },
    { id: 'mix', label: 'Mix', type: 'number', min: 0, max: 1, step: 0.01, default: 0.3 },
    { id: 'preDelayMs', label: 'Pre-Delay', type: 'number', min: 0, max: 200, step: 1, unit: 'ms', default: 10 },
  ],
  process(channels, sampleRate, params, onProgress) {
    const roomSize = Number(params.roomSize ?? 0.5);
    const damping = Number(params.damping ?? 0.5);
    const mix = Number(params.mix ?? 0.3);
    const preDelayMs = Number(params.preDelayMs ?? 10);

    const N = channels[0]?.length ?? 0;
    const numCh = channels.length;
    const preDelaySamples = Math.max(0, Math.round((preDelayMs / 1000) * sampleRate));
    const tailSeconds = roomSize <= 0.5 ? 3 : 3 + (roomSize - 0.5) * 10;
    const outLen = N + Math.round(tailSeconds * sampleRate);
    const combFeedback = 0.7 + 0.28 * roomSize;

    const out: Float32Array[] = [];
    const totalSamples = outLen * numCh;
    let processed = 0;

    for (let ch = 0; ch < numCh; ch++) {
      const spread = numCh === 2 && ch === 1 ? STEREO_SPREAD_SAMPLES : 0;
      const combs = COMB_TUNING_44K.map(
        (base) => new Comb(scaleDelay(base, sampleRate, spread), combFeedback, damping)
      );
      const allpasses = ALLPASS_TUNING_44K.map(
        (base) => new Allpass(scaleDelay(base, sampleRate, spread), ALLPASS_G)
      );

      const src = channels[ch];
      const dst = new Float32Array(outLen);
      for (let i = 0; i < outLen; i++) {
        const wetSrcIdx = i - preDelaySamples;
        const wetIn = wetSrcIdx >= 0 && wetSrcIdx < N ? src[wetSrcIdx] : 0;

        let combSum = 0;
        for (const comb of combs) combSum += comb.process(wetIn);
        combSum /= combs.length;

        let wet = combSum;
        for (const allpass of allpasses) wet = allpass.process(wet);

        const dry = i < N ? src[i] : 0;
        dst[i] = dry * (1 - mix) + wet * mix;

        processed++;
        maybeReportProgress(onProgress, processed - 1, totalSamples);
      }
      out.push(dst);
    }

    return { channels: out };
  },
};
