import { bs775Applicable, downmixBs775, type DownmixLaw } from '../dsp/downmix';
import { type WavMarker } from './wavCodec';
import { decodeWavOffThread } from './decodeWavOffThread';
import { sniffSampleRate } from './sniffSampleRate';

export interface DecodedAudio {
  channels: Float32Array[];
  sampleRate: number;
  /** Original file bit depth when the decoder knows it (WAV only — the Web Audio
   * path yields Float32 with no source-depth info). Undefined otherwise. */
  sourceBitDepth?: number;
  /** Markers read from the WAV's cue/adtl chunks (WAV only). Undefined for
   * everything else — no other supported container has a marker chunk. */
  markers?: WavMarker[];
  /** Speaker layout: the raw `dwChannelMask` of a WAVE_FORMAT_EXTENSIBLE WAV,
   * present only when it fully describes the channels (see `decodeWav`).
   * Undefined for every other source — the Web Audio path exposes no layout
   * metadata, and an absent layout must stay absent rather than be invented. */
  channelMask?: number;
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
 * R6 — the user-selectable stereo downmix, in one place so every consumer
 * agrees on the fallback rule:
 *
 *  - `'fold'` → exactly {@link downmixToStereo}, byte-identical to the app's
 *    original law. This is the DEFAULT: a user who re-opens or re-converts a
 *    multichannel file without opting in gets the same samples as before.
 *  - `'bs775'` WITH a layout the matrix covers ({@link bs775Applicable}) →
 *    the ITU-R BS.775-3 Annex 4 2/0 matrix (see dsp/downmix.ts for the
 *    coefficients and their citation).
 *  - `'bs775'` WITHOUT one → falls back to `'fold'`. BS.775 needs to know
 *    which channel is centre/LFE/surround; applying it to an unknown order
 *    would misplace content with no error. A crude fold beats a silently
 *    wrong matrix. UI surfaces (ConvertDialog) disable the BS.775 option in
 *    exactly this case so the law in force is always the one displayed.
 */
export function downmixToStereoWithLaw(
  channels: Float32Array[],
  law: DownmixLaw,
  channelMask?: number
): Float32Array[] {
  if (law === 'bs775' && bs775Applicable(channelMask, channels.length)) {
    return downmixBs775(channels, channelMask as number);
  }
  return downmixToStereo(channels);
}

/**
 * Decode an encoded audio file's bytes into per-channel Float32 sample data.
 *
 * **`buf` is CONSUMED.** Whichever branch runs, the buffer is handed to a
 * decoder that detaches it — transferred into the decode worker for WAV, given
 * to `decodeAudioData` for everything else — so it is unreadable when this
 * resolves and no caller may keep using it. That is deliberate: the bytes and
 * the decoded samples must never both be resident, which on a 68 MB file is
 * the difference between 137 MB and 68 MB of live renderer memory. Read
 * whatever container metadata you need (bit depth, chapters, tags) BEFORE
 * calling, as `fileService.openFilePath` does.
 *
 * WAV files (detected by the `.wav` extension of `hintedName`, case-insensitive)
 * go through our own `decodeWav`, preserving the exact samples and original
 * sample rate — but on a WORKER (`decodeWavOffThread`), because that decode is
 * a multi-million-iteration loop that used to freeze the UI for the whole of a
 * large open. Everything else is decoded via the Web Audio API's
 * `decodeAudioData`, which resamples output to the OfflineAudioContext's rate.
 * To keep non-WAV imports at their NATIVE rate we first sniff the container
 * header (`sniffSampleRate`) and build the context at that rate; only genuinely
 * unsniffable/exotic containers fall back to 48000 Hz. More than two channels
 * are down-mixed to stereo via `downmixToStereo` (see its −3 dB fold law).
 *
 * jsdom has no OfflineAudioContext, so non-WAV decoding throws there; tests mock
 * this module, supply WAV bytes, or stub OfflineAudioContext. jsdom has no
 * Worker either, and the WAV branch falls back to decoding in place there.
 */
export async function decodeArrayBuffer(buf: ArrayBuffer, hintedName: string): Promise<DecodedAudio> {
  if (/\.wav$/i.test(hintedName)) {
    const { channels, sampleRate, bitDepth, markers, channelMask } = await decodeWavOffThread(buf);
    return { channels, sampleRate, sourceBitDepth: bitDepth, markers, channelMask };
  }

  if (typeof OfflineAudioContext === 'undefined') {
    throw new Error('Audio decoding for non-WAV files is not available in this environment');
  }

  // Sniffed BEFORE the decode hands the buffer over — `decodeAudioData`
  // detaches it.
  const rate = sniffSampleRate(buf, hintedName) ?? 48000;
  // A corrupt header can sniff to a rate the browser rejects (OfflineAudioContext
  // throws NotSupportedError outside roughly [3000, 768000] Hz). Rather than
  // range-capping in the sniffers (hi-res FLAC at 352.8k/384k is legal), retry
  // once at the 48000 fallback so such files still open, as they did pre-sniffing.
  let ctx: OfflineAudioContext;
  try {
    ctx = new OfflineAudioContext(1, 1, rate);
  } catch {
    ctx = new OfflineAudioContext(1, 1, 48000);
  }
  // decodeAudioData detaches the buffer it is given. It used to be handed a
  // `buf.slice(0)` copy so the caller's ArrayBuffer stayed usable; nothing
  // needs it afterwards any more (metadata is read before the call, and the
  // WAV branch above detaches too), so the copy is gone and the original is
  // handed straight over.
  const audioBuffer = await ctx.decodeAudioData(buf);

  const all: Float32Array[] = [];
  for (let c = 0; c < audioBuffer.numberOfChannels; c++) {
    // Copy out of the AudioBuffer so we own the memory (getChannelData returns a
    // live view into the buffer).
    all.push(audioBuffer.getChannelData(c).slice());
  }
  return { channels: downmixToStereo(all), sampleRate: audioBuffer.sampleRate };
}
