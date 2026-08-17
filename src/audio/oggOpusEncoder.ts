/**
 * Encode PCM channel data to an Ogg Opus (`.ogg`) bitstream using the browser's
 * WebCodecs `AudioEncoder` for the Opus packets and the pure-TS muxer in
 * `oggPage.ts` for the container. Opus is canonically 48 kHz, so non-48 kHz
 * input is resampled first (the original rate is still recorded in OpusHead).
 *
 * WebCodecs is only present in a real Chromium renderer, never under jsdom, so
 * `encodeOggOpus` throws a typed {@link OggEncoderUnavailableError} when the API
 * is missing; callers (fileService) catch it and fall back to save-as WAV. The
 * real encode path is exercised by the packaged-app smoke test.
 */

import { resampleChannel } from '../dsp/resample';
import { muxOpusStream, type EncodedOpusPacket } from './oggPage';
import { buildChapterComments, type ChapterMarker } from './chapterTags';

/** Thrown when WebCodecs `AudioEncoder`/`AudioData` are unavailable (e.g. jsdom). */
export class OggEncoderUnavailableError extends Error {
  constructor(message = 'WebCodecs AudioEncoder is not available in this environment') {
    super(message);
    this.name = 'OggEncoderUnavailableError';
  }
}

/** Opus is always 48 kHz internally. */
const OPUS_RATE = 48000;
/** 20 ms frame at 48 kHz — the granularity we feed the encoder. */
const FRAME_SAMPLES = 960;
/** libopus default encoder look-ahead (used when the encoder reports no OpusHead). */
const DEFAULT_PRE_SKIP = 312;
/** Fixed, deterministic bitstream serial (single stream per file). */
const STREAM_SERIAL = 0x41756469; // 'Audi'
/** Yield to the event loop for encoder callbacks when the queue grows past this. */
const QUEUE_YIELD_THRESHOLD = 48;

// --- Minimal WebCodecs typings (avoids depending on lib.dom having them) ----

interface EncodedChunkLike {
  readonly byteLength: number;
  readonly duration: number | null;
  copyTo(destination: BufferSource): void;
}
interface EncoderMetadataLike {
  decoderConfig?: { description?: ArrayBuffer | ArrayBufferView };
}
interface AudioEncoderInitLike {
  output: (chunk: EncodedChunkLike, metadata?: EncoderMetadataLike) => void;
  error: (error: DOMException) => void;
}
interface AudioEncoderConfigLike {
  codec: string;
  sampleRate: number;
  numberOfChannels: number;
  bitrate: number;
}
interface AudioEncoderLike {
  readonly encodeQueueSize: number;
  configure(config: AudioEncoderConfigLike): void;
  encode(data: AudioDataLike): void;
  flush(): Promise<void>;
  close(): void;
}
interface AudioEncoderCtor {
  new (init: AudioEncoderInitLike): AudioEncoderLike;
}
interface AudioDataInitLike {
  format: string;
  sampleRate: number;
  numberOfFrames: number;
  numberOfChannels: number;
  timestamp: number;
  data: BufferSource;
}
interface AudioDataLike {
  close(): void;
}
interface AudioDataCtor {
  new (init: AudioDataInitLike): AudioDataLike;
}

function webCodecs(): { AudioEncoder: AudioEncoderCtor; AudioData: AudioDataCtor } {
  const g = globalThis as unknown as {
    AudioEncoder?: AudioEncoderCtor;
    AudioData?: AudioDataCtor;
  };
  if (typeof g.AudioEncoder === 'undefined' || typeof g.AudioData === 'undefined') {
    throw new OggEncoderUnavailableError();
  }
  return { AudioEncoder: g.AudioEncoder, AudioData: g.AudioData };
}

/**
 * Convert marker positions from the source document's sample rate to Opus's
 * canonical 48 kHz file rate (Task K5), rounding each converted position to
 * the nearest sample. Exported so the rate-mapping math can be unit-tested
 * directly — `encodeOggOpus` itself cannot run under jsdom (no WebCodecs).
 */
export function markersToOpusRate(markers: ChapterMarker[], sourceRate: number): ChapterMarker[] {
  return markers.map((m) => ({
    positionSample: Math.round((m.positionSample * OPUS_RATE) / sourceRate),
    name: m.name,
  }));
}

/** Parse the pre-skip (uint16 LE at offset 10) from an OpusHead description. */
function parsePreSkip(description: ArrayBuffer | ArrayBufferView): number | null {
  const bytes =
    description instanceof ArrayBuffer
      ? new Uint8Array(description)
      : new Uint8Array(description.buffer, description.byteOffset, description.byteLength);
  if (bytes.length < 12) return null;
  const magic = String.fromCharCode(...bytes.subarray(0, 8));
  if (magic !== 'OpusHead') return null;
  return bytes[10] | (bytes[11] << 8);
}

/**
 * Encode `channels` (1 or 2 Float32 channels, nominally [-1, 1]) to Ogg Opus.
 * Resamples to 48 kHz when `sampleRate` differs. `bitrate` is bits per second.
 * Rejects with {@link OggEncoderUnavailableError} when WebCodecs is missing.
 *
 * When `markers` is a non-empty array (Task K5), their positions (given at
 * `sampleRate`, the SOURCE rate) are converted to the 48 kHz file rate via
 * `markersToOpusRate` and written into the OpusTags packet as CHAPTERxxx +
 * AUDITORIUM_MARKERS comments (`chapterTags.ts`'s `buildChapterComments`).
 * Omitting `markers` (or passing `[]`) reproduces the pre-K5, zero-comment
 * OpusTags layout exactly.
 */
export async function encodeOggOpus(
  channels: Float32Array[],
  sampleRate: number,
  bitrate = 128_000,
  markers?: ChapterMarker[]
): Promise<Uint8Array> {
  const { AudioEncoder, AudioData } = webCodecs();

  const numberOfChannels = channels.length === 1 ? 1 : 2;
  const source = channels.slice(0, numberOfChannels);
  // Resample each channel to 48 kHz if needed (Opus is 48 kHz canonical).
  const ch48 =
    sampleRate === OPUS_RATE
      ? source.map((c) => c)
      : source.map((c) => resampleChannel(c, sampleRate, OPUS_RATE));
  const totalSamples = ch48[0]?.length ?? 0;

  const packets: EncodedOpusPacket[] = [];
  let preSkip = DEFAULT_PRE_SKIP;
  let gotPreSkip = false;
  let encodeError: DOMException | null = null;

  const encoder = new AudioEncoder({
    output: (chunk, metadata) => {
      const description = metadata?.decoderConfig?.description;
      if (!gotPreSkip && description) {
        const parsed = parsePreSkip(description);
        if (parsed != null) {
          preSkip = parsed;
          gotPreSkip = true;
        }
      }
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      const sampleCount =
        chunk.duration != null
          ? Math.round((chunk.duration * OPUS_RATE) / 1_000_000)
          : FRAME_SAMPLES;
      packets.push({ data, sampleCount });
    },
    error: (error) => {
      encodeError = error;
    },
  });

  encoder.configure({ codec: 'opus', sampleRate: OPUS_RATE, numberOfChannels, bitrate });

  let timestampUs = 0;
  for (let pos = 0; pos < totalSamples; pos += FRAME_SAMPLES) {
    const frames = Math.min(FRAME_SAMPLES, totalSamples - pos);
    // f32-planar layout: channel 0 samples, then channel 1 samples.
    const planar = new Float32Array(frames * numberOfChannels);
    for (let c = 0; c < numberOfChannels; c++) {
      planar.set(ch48[c].subarray(pos, pos + frames), c * frames);
    }
    const audioData = new AudioData({
      format: 'f32-planar',
      sampleRate: OPUS_RATE,
      numberOfFrames: frames,
      numberOfChannels,
      timestamp: timestampUs,
      data: planar,
    });
    encoder.encode(audioData);
    audioData.close();
    timestampUs += Math.round((frames * 1_000_000) / OPUS_RATE);

    // Light backpressure: let the encoder drain its output so memory stays
    // bounded by the output size, not the whole input, for long files.
    if (encoder.encodeQueueSize > QUEUE_YIELD_THRESHOLD) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    if (encodeError) break;
  }

  // `close()` has to run even when `flush()` rejects. It does reject in the one
  // case that matters: the loop above breaks out on `encodeError`, and
  // flushing an ERRORED AudioEncoder rejects — which used to skip `close()`
  // entirely and leak the underlying codec for the rest of the session. The
  // rejection is also the wrong error to surface (`encodeError` below is the
  // real cause), so it is swallowed here and the real one is thrown after.
  try {
    await encoder.flush();
  } catch (err) {
    // `encodeError` is the real cause and is thrown below; a flush rejection
    // caused by it is just the symptom. Anything else propagates.
    if (!encodeError) throw err;
  } finally {
    try {
      encoder.close();
    } catch {
      // WebCodecs already closes an encoder when it errors, and close() on an
      // already-closed encoder throws InvalidStateError. Nothing left to free.
    }
  }
  if (encodeError) throw encodeError;

  const comments =
    markers && markers.length > 0 ? buildChapterComments(markersToOpusRate(markers, sampleRate), OPUS_RATE) : [];

  return muxOpusStream({
    serial: STREAM_SERIAL,
    channelCount: numberOfChannels,
    preSkip,
    inputSampleRate: sampleRate, // ORIGINAL rate, pre-resample
    packets,
    totalSamples,
    vendor: 'audition_app',
    comments,
  });
}
