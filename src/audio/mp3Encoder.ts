import { Mp3Encoder } from '@breezystack/lamejs';
import { buildId3Chapters, type Id3ChapterMarker } from './id3Chapters';

/** Samples per MP3 granule pair; lamejs expects blocks of this size. */
const BLOCK_SIZE = 1152;

/**
 * The CBR bitrates this app offers for MP3 encode — Save (`MP3_SAVE_KBPS` in
 * fileService.ts, fixed at 192) and Export (`ExportOptions.mp3Kbps`,
 * user-chosen from these four). Just the app's current UI options: marker-
 * rate correctness no longer depends on this set (Task M6 fix round 2 /
 * IMPORTANT A — see `readEncodedFrameSampleRate` below), since `encodeMp3`
 * measures the real output rate from the encoded bytes instead of predicting
 * it from a bitrate/rate table.
 */
export type Mp3Kbps = 128 | 192 | 256 | 320;

/** MPEG-1/2/2.5 sample-rate lookup by (version bits, rate bits) — the fixed
 * table from the MPEG audio frame header spec (ISO/IEC 11172-3), independent
 * of lamejs. `null` marks the reserved bit pattern. */
const MPEG1_SAMPLE_RATES: ReadonlyArray<number | null> = [44100, 48000, 32000, null];
const MPEG2_SAMPLE_RATES: ReadonlyArray<number | null> = [22050, 24000, 16000, null];
const MPEG25_SAMPLE_RATES: ReadonlyArray<number | null> = [11025, 12000, 8000, null];

/**
 * Reads the REAL sample rate lamejs encoded into the first MPEG audio frame
 * header of `bytes` (must start at byte 0 of an actual frame — i.e. call this
 * on the encoded audio BEFORE any ID3 tag is prepended). Returns `null` when
 * `bytes` doesn't start with a valid frame sync / sample-rate bit pattern
 * (e.g. encoding produced no frames at all), so the caller can fall back
 * instead of throwing.
 *
 * This exists because lamejs may legally pick an output rate that differs
 * from the input rate (Task M6 / F6 — e.g. any input above 48000 clamps
 * there), and — contrary to an earlier version of this module that tried to
 * MIRROR lamejs's own rate-selection logic in a lookup table
 * (`getLameOutputRate`, since removed) — that selection is NOT simply a
 * function of the input rate and bitrate. Measured directly against the real
 * encoder: 22254 Hz (classic Mac) -> 24000, 18900 Hz (CD-ROM XA) -> 22050,
 * 8012 Hz (telephony) -> 11025, 11127 Hz -> 12000 — all of which a predicted
 * table got wrong by 8-27%, on rates `decodeAudio.ts` deliberately preserves
 * from real imported files (it never forces a document onto a "standard"
 * rate). Reading the rate lamejs ACTUALLY wrote, straight from its own
 * output, is correct by construction for every input rate and bitrate — no
 * table to keep in sync with lamejs's internals, and immune to lamejs
 * updates changing its rate-selection heuristics.
 */
export function readEncodedFrameSampleRate(bytes: Uint8Array): number | null {
  if (bytes.length < 3 || bytes[0] !== 0xff || (bytes[1] & 0xe0) !== 0xe0) return null;
  const versionBits = (bytes[1] >> 3) & 0x3; // 00 = MPEG2.5, 10 = MPEG2, 11 = MPEG1
  const rateBits = (bytes[2] >> 2) & 0x3;
  const table = versionBits === 0b11 ? MPEG1_SAMPLE_RATES : versionBits === 0b10 ? MPEG2_SAMPLE_RATES : MPEG25_SAMPLE_RATES;
  return table[rateBits] ?? null;
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
 * legally pick a different output rate (Task M6 / F6) — e.g. any document
 * above 48kHz clamps there, and non-standard native import rates can land on
 * a rate nothing about `sampleRate` alone would predict. The audio is
 * therefore encoded FIRST; the real output rate is then read straight out of
 * the first produced MPEG frame's own header (`readEncodedFrameSampleRate`)
 * and marker positions are rescaled to THAT rate (`round(pos * outRate /
 * sampleRate)`) before the ID3 tag is built and prepended — so both the TXXX
 * exact-sample value and the CHAP millisecond value are computed on the
 * file's real clock, correct by construction for any input rate/bitrate. A
 * no-op (byte-identical to before this rescale existed) when
 * `outRate === sampleRate`.
 */
export function encodeMp3(
  channels: Float32Array[],
  sampleRate: number,
  kbps: Mp3Kbps,
  markers?: Id3ChapterMarker[]
): ArrayBuffer {
  const numChannels = channels.length === 1 ? 1 : 2;
  const encoder = new Mp3Encoder(numChannels, sampleRate, kbps);

  const left = floatToInt16(channels[0] ?? new Float32Array(0));
  const right = numChannels === 2 ? floatToInt16(channels[1] ?? new Float32Array(0)) : null;
  const length = left.length;

  const audioChunks: Uint8Array[] = [];
  for (let i = 0; i < length; i += BLOCK_SIZE) {
    const leftBlock = left.subarray(i, i + BLOCK_SIZE);
    const encoded = right
      ? encoder.encodeBuffer(leftBlock, right.subarray(i, i + BLOCK_SIZE))
      : encoder.encodeBuffer(leftBlock);
    // Defensive copy: lamejs may hand back a view into a buffer it reuses across
    // calls, so snapshot each frame before the next encodeBuffer overwrites it.
    if (encoded.length > 0) audioChunks.push(new Uint8Array(encoded));
  }
  const tail = encoder.flush();
  if (tail.length > 0) audioChunks.push(new Uint8Array(tail));

  const chunks: Uint8Array[] = [];
  if (markers && markers.length > 0) {
    // The very first byte of audioChunks[0] is the very first byte of the
    // encoded MPEG stream (frames always start aligned at the top — no ID3
    // tag has been prepended yet), so it's always a real frame header when
    // any audio was encoded at all. Fall back to `sampleRate` (no rescale)
    // in the degenerate case where encoding produced no frames at all
    // (e.g. an empty document) rather than guessing.
    const outRate = (audioChunks.length > 0 ? readEncodedFrameSampleRate(audioChunks[0]) : null) ?? sampleRate;
    const scaledMarkers =
      outRate === sampleRate
        ? markers
        : markers.map((m) => ({ ...m, positionSample: Math.round((m.positionSample * outRate) / sampleRate) }));
    chunks.push(buildId3Chapters(scaledMarkers, outRate));
  }
  chunks.push(...audioChunks);

  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out.buffer;
}
