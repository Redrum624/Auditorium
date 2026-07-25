import { Mp3Encoder } from '@breezystack/lamejs';
import { buildId3Chapters, type Id3ChapterMarker } from './id3Chapters';

/** Samples per MP3 granule pair; lamejs expects blocks of this size. */
const BLOCK_SIZE = 1152;

/**
 * The CBR bitrates this app ever passes to lamejs — Save (`MP3_SAVE_KBPS` in
 * fileService.ts, fixed at 192) and Export (`ExportOptions.mp3Kbps`, user-
 * chosen from these four). `getLameOutputRate`'s tier-only rate mapping below
 * is verified correct ONLY for this set (kbps >= 128) — see that function's
 * doc comment. Widening this union to include anything below 128 (64/96/112
 * are the concrete broken cases already measured) makes the mapping silently
 * wrong and must not be done without extending `getLameOutputRate` itself to
 * take `kbps` and replicate lamejs's full lowpass-table/clamp/downgrade logic.
 * `mp3Encoder.test.ts` has a compile-time guard that trips if this happens.
 */
export type Mp3Kbps = 128 | 192 | 256 | 320;

/**
 * Mirrors @breezystack/lamejs's own output-rate selection so marker positions
 * can be rescaled to the rate the encoder ACTUALLY writes, rather than the
 * document's rate (Task M6 / F6). Pinned by reading the vendored
 * `node_modules/@breezystack/lamejs/dist/lamejs.js`, not guessed — and
 * empirically verified against the real encoder across every standard PCM
 * sample rate this app can produce or import, crossed with all four
 * supported bitrates (112 encode+decode combinations, decoding the actual
 * MPEG frame header's sample-rate bits from the produced bytes).
 *
 * **This function is valid ONLY for `kbps >= 128` (i.e. `Mp3Kbps` above) — it
 * is NOT simply "the lowpass cutoff always stays above every override
 * threshold" as an earlier version of this comment incorrectly claimed.**
 * The real mechanism, from `lame_init_params`:
 *   1. Since `Mp3Encoder` never sets `out_samplerate` (stays at its struct
 *      default 0) and this app always supplies a nonzero CBR `brate`, LAME
 *      derives `lowpassfreq` (default 0) from a CBR-bitrate table
 *      (`f(t, brate)`): 128/192/256/320 kbps -> 17000/18600/19700/20500 Hz;
 *      MONO input then multiplies that by 1.5 (a later, unconditional line
 *      in the same function — easy to miss on a first read).
 *   2. Immediately before computing the output rate, LAME CLAMPS
 *      `lowpassfreq = in_samplerate / 2` whenever `2 * lowpassfreq >
 *      in_samplerate` — which fires for MOST practical input rates at every
 *      bitrate, contrary to "never fires".
 *   3. `optimum_samplefreq(lowpassfreq, in_samplerate)` then tiers a guess
 *      from `in_samplerate` alone, lets `lowpassfreq <= 15960` Hz override it
 *      downward, and finally runs a "downgrade" pass that can push the
 *      result back up if `in_samplerate` ends up below the guess.
 * For every STANDARD PCM rate (8000/11025/12000/16000/22050/24000/32000/
 * 44100/48000/88200/96000/...) at kbps >= 128 (mono or stereo), steps 2-3
 * always renormalize back to a pure input-rate tier match, capped at 48000 —
 * confirmed both analytically (by hand, for each rate/bitrate pair) and
 * empirically (the 112-combo sweep above). Below kbps 128 that stops being
 * true, because the table's lowpass cutoff itself drops to <= 15960 Hz and
 * the override actually engages: measured directly against the real encoder,
 * kbps=64 gives 44100/48000/96000 -> 24000 (not 44100/48000/48000), kbps=96
 * gives the same three inputs -> 32000, kbps=112 gives 48000/96000 -> 44100.
 * (A truly non-standard, non-tier-boundary input rate, e.g. 20000 Hz, can in
 * principle diverge from this table even at kbps=128 — not a concern here
 * since every rate this app's NewFileDialog offers or a real decoded import
 * can carry is one of the standard rates above.)
 *
 * Tier table (valid for kbps >= 128 only, per all of the above):
 *   >=48000 -> 48000, >=44100 -> 44100, >=32000 -> 32000, >=24000 -> 24000,
 *   >=22050 -> 22050, >=16000 -> 16000, >=12000 -> 12000, >=11025 -> 11025,
 *   else -> 8000.
 *
 * 96000 -> 48000 matches the task brief's initial guess, but 88200 -> 48000
 * (NOT 44100, as the brief guessed) — 88200 already exceeds the >=48000 tier
 * threshold, so it clamps straight to the ceiling instead of falling through
 * toward 44100.
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
  kbps: Mp3Kbps,
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
