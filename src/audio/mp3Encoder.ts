import { Mp3Encoder } from '@breezystack/lamejs';

/** Samples per MP3 granule pair; lamejs expects blocks of this size. */
const BLOCK_SIZE = 1152;

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
 */
export function encodeMp3(
  channels: Float32Array[],
  sampleRate: number,
  kbps: 128 | 192 | 256 | 320
): ArrayBuffer {
  const numChannels = channels.length === 1 ? 1 : 2;
  const encoder = new Mp3Encoder(numChannels, sampleRate, kbps);

  const left = floatToInt16(channels[0] ?? new Float32Array(0));
  const right = numChannels === 2 ? floatToInt16(channels[1] ?? new Float32Array(0)) : null;
  const length = left.length;

  const chunks: Uint8Array[] = [];
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
