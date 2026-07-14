import { decodeWav } from './wavCodec';
import { sniffSampleRate } from './sniffSampleRate';

export interface DecodedAudio {
  channels: Float32Array[];
  sampleRate: number;
}

// -3 dB (1/√2) fold gain applied to the surround/extra channels when downmixing.
const EXTRA_CHANNEL_GAIN = Math.SQRT1_2;

const clamp1 = (v: number): number => (v > 1 ? 1 : v < -1 ? -1 : v);

/**
 * Downmix an arbitrary channel layout to stereo.
 *
 * Mono and stereo pass through untouched. For more than two channels the extra
 * channels (index ≥ 2) are folded into BOTH L and R at −3 dB rather than being
 * discarded, so their energy is preserved:
 *
 *   mix  = 0.7071 · mean(ch2 … chN-1)
 *   L'   = clamp(ch0 + mix, −1, +1)
 *   R'   = clamp(ch1 + mix, −1, +1)
 *
 * (This replaces the previous take-first-two truncation.)
 */
export function downmixToStereo(channels: Float32Array[]): Float32Array[] {
  const n = channels.length;
  if (n <= 2) return channels;

  const length = channels[0].length;
  const extra = n - 2;
  const L = new Float32Array(length);
  const R = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    let sum = 0;
    for (let c = 2; c < n; c++) sum += channels[c][i];
    const mix = EXTRA_CHANNEL_GAIN * (sum / extra);
    L[i] = clamp1(channels[0][i] + mix);
    R[i] = clamp1(channels[1][i] + mix);
  }
  return [L, R];
}

/**
 * Decode an encoded audio file's bytes into per-channel Float32 sample data.
 *
 * WAV files (detected by the `.wav` extension of `hintedName`, case-insensitive)
 * go through our own `decodeWav`, preserving the exact samples and original
 * sample rate. Everything else is decoded via the Web Audio API's
 * `decodeAudioData`, which resamples output to the OfflineAudioContext's rate.
 * To keep non-WAV imports at their NATIVE rate we first sniff the container
 * header (`sniffSampleRate`) and build the context at that rate; only genuinely
 * unsniffable/exotic containers fall back to 48000 Hz. More than two channels
 * are down-mixed to stereo via `downmixToStereo` (see its −3 dB fold law).
 *
 * jsdom has no OfflineAudioContext, so non-WAV decoding throws there; tests mock
 * this module, supply WAV bytes, or stub OfflineAudioContext.
 */
export async function decodeArrayBuffer(buf: ArrayBuffer, hintedName: string): Promise<DecodedAudio> {
  if (/\.wav$/i.test(hintedName)) {
    const { channels, sampleRate } = decodeWav(buf);
    return { channels, sampleRate };
  }

  if (typeof OfflineAudioContext === 'undefined') {
    throw new Error('Audio decoding for non-WAV files is not available in this environment');
  }

  const rate = sniffSampleRate(buf, hintedName) ?? 48000;
  const ctx = new OfflineAudioContext(1, 1, rate);
  // decodeAudioData detaches the buffer it is given; pass a copy so the caller's
  // ArrayBuffer stays usable.
  const audioBuffer = await ctx.decodeAudioData(buf.slice(0));

  const all: Float32Array[] = [];
  for (let c = 0; c < audioBuffer.numberOfChannels; c++) {
    // Copy out of the AudioBuffer so we own the memory (getChannelData returns a
    // live view into the buffer).
    all.push(audioBuffer.getChannelData(c).slice());
  }
  return { channels: downmixToStereo(all), sampleRate: audioBuffer.sampleRate };
}
