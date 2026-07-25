import { Mp3Encoder } from '@breezystack/lamejs';
import { buildId3Chapters, type Id3ChapterMarker } from './id3Chapters';

/** Samples per MP3 granule pair; lamejs expects blocks of this size. */
const BLOCK_SIZE = 1152;

/**
 * Mirrors @breezystack/lamejs's own output-rate selection so marker positions
 * can be rescaled to the rate the encoder ACTUALLY writes, rather than the
 * document's rate (Task M6 / F6). Pinned by reading the vendored
 * `node_modules/@breezystack/lamejs/dist/lamejs.js`, not guessed:
 *
 * The `Mp3Encoder` wrapper (`fa.Mp3Encoder`) never sets `out_samplerate` — it
 * stays at its struct default of 0 — so `lame_init_params` derives it. With
 * `VBR` at its default `vbr_off` and a caller-supplied CBR `brate` (this app
 * always passes one of 128/192/256/320), `lame_init_params`'s
 * `compression_ratio` branch that could otherwise pick `out_samplerate` from
 * `in_samplerate` is skipped (it only fires when `compression_ratio > 0`,
 * which requires `brate === 0`). Instead `lowpassfreq` is 0 (its default), so
 * the encoder computes it from a CBR-bitrate table (`f(t, brate)`): 128/192/
 * 256/320 kbps map to lowpass cutoffs of 17000/18600/19700/20500 Hz. The
 * output-rate function (`optimum_samplefreq`-equivalent) only lets a lowpass
 * cutoff override its input-rate-tier guess when the cutoff is <= 15960 Hz —
 * every cutoff above holds for our four bitrates, so the override never fires
 * and the output rate reduces to a pure ceiling-capped tier match against the
 * INPUT rate:
 *   >=48000 -> 48000, >=44100 -> 44100, >=32000 -> 32000, >=24000 -> 24000,
 *   >=22050 -> 22050, >=16000 -> 16000, >=12000 -> 12000, >=11025 -> 11025,
 *   else -> 8000 (lamejs's own low-end "downgrade" path also bottoms out at
 *   8000 for anything below that).
 *
 * Verified against the real vendored function, not assumed: 96000 -> 48000
 * matches the task brief's initial guess, but 88200 -> 48000 (NOT 44100, as
 * the brief guessed) — 88200 already exceeds the >=48000 tier threshold, so
 * it clamps straight to the ceiling instead of falling through toward 44100.
 * Every rate the app's NewFileDialog offers (44100/48000/96000) and any rate
 * a decoded import can carry funnels through this exact table.
 */
export function getLameOutputRate(inRate: number): number {
  if (inRate >= 48000) return 48000;
  if (inRate >= 44100) return 44100;
  if (inRate >= 32000) return 32000;
  if (inRate >= 24000) return 24000;
  if (inRate >= 22050) return 22050;
  if (inRate >= 16000) return 16000;
  if (inRate >= 12000) return 12000;
  if (inRate >= 11025) return 11025;
  return 8000;
}

/** Convert a Float32 sample buffer (nominally [-1, 1]) to Int16 PCM, clamping
 * out-of-range values so overdriven audio never wraps around. */
function floatToInt16(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]));
    // Scale by 32767 (matches wavCodec's 16-bit scale) then clamp to Int16 range.
    out[i] = Math.max(-32768, Math.min(32767, Math.round(s * 32767)));
  }
  return out;
}

/**
 * Encode PCM channel data to a single MP3 ArrayBuffer using @breezystack/lamejs.
 * Mono input (1 channel) uses a 1-channel encoder; anything else encodes the
 * first two channels as stereo. Samples are converted to Int16, fed in 1152-
 * sample blocks, then the encoder is flushed and all frames concatenated.
 *
 * When `markers` is a non-empty array, an ID3v2.3 chapter tag (`buildId3Chapters`
 * — CTOC/CHAP interop frames plus the sample-exact `AUDITORIUM_MARKERS` TXXX)
 * is prepended as the first bytes of the output; both sniffers and Chromium's
 * `decodeAudioData` already skip leading ID3v2, so the file still opens
 * identically either way. Omitting `markers` (or passing `[]`) produces output
 * byte-identical to the pre-K3 encoder — no tag is written.
 *
 * `markers` arrive at `sampleRate` (the document's rate), but lamejs may
 * legally pick a different output rate (`getLameOutputRate`, Task M6 / F6) —
 * e.g. a 96kHz document always yields a 48kHz MP3. Marker positions are
 * rescaled to that TRUE output rate (`round(pos * outRate / sampleRate)`)
 * before being written, so both the TXXX exact-sample value and the CHAP
 * millisecond value are computed on the file's real clock. A no-op
 * (byte-identical to before this rescale existed) when `outRate === sampleRate`.
 */
export function encodeMp3(
  channels: Float32Array[],
  sampleRate: number,
  kbps: 128 | 192 | 256 | 320,
  markers?: Id3ChapterMarker[]
): ArrayBuffer {
  const numChannels = channels.length === 1 ? 1 : 2;
  const encoder = new Mp3Encoder(numChannels, sampleRate, kbps);
  const outRate = getLameOutputRate(sampleRate);

  const left = floatToInt16(channels[0] ?? new Float32Array(0));
  const right = numChannels === 2 ? floatToInt16(channels[1] ?? new Float32Array(0)) : null;
  const length = left.length;

  const chunks: Uint8Array[] = [];
  if (markers && markers.length > 0) {
    const scaledMarkers =
      outRate === sampleRate
        ? markers
        : markers.map((m) => ({ ...m, positionSample: Math.round((m.positionSample * outRate) / sampleRate) }));
    chunks.push(buildId3Chapters(scaledMarkers, outRate));
  }
  for (let i = 0; i < length; i += BLOCK_SIZE) {
    const leftBlock = left.subarray(i, i + BLOCK_SIZE);
    const encoded = right
      ? encoder.encodeBuffer(leftBlock, right.subarray(i, i + BLOCK_SIZE))
      : encoder.encodeBuffer(leftBlock);
    // Defensive copy: lamejs may hand back a view into a buffer it reuses across
    // calls, so snapshot each frame before the next encodeBuffer overwrites it.
    if (encoded.length > 0) chunks.push(new Uint8Array(encoded));
  }
  const tail = encoder.flush();
  if (tail.length > 0) chunks.push(new Uint8Array(tail));

  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out.buffer;
}
