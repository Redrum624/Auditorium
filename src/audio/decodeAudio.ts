import { decodeWav } from './wavCodec';

export interface DecodedAudio {
  channels: Float32Array[];
  sampleRate: number;
}

/**
 * Decode an encoded audio file's bytes into per-channel Float32 sample data.
 *
 * WAV files (detected by the `.wav` extension of `hintedName`, case-insensitive)
 * go through our own `decodeWav`, preserving the exact samples and original
 * sample rate. Everything else is decoded via the Web Audio API's
 * `decodeAudioData`, which resamples the output to the OfflineAudioContext's
 * rate — so all non-WAV imports arrive at 48000 Hz. This is intended v1 behavior
 * (see docs/KNOWN_LIMITATIONS.md). More than two channels are truncated to the
 * first two (L/R).
 *
 * jsdom has no OfflineAudioContext, so non-WAV decoding throws there; tests mock
 * this module or supply WAV bytes.
 */
export async function decodeArrayBuffer(buf: ArrayBuffer, hintedName: string): Promise<DecodedAudio> {
  if (/\.wav$/i.test(hintedName)) {
    const { channels, sampleRate } = decodeWav(buf);
    return { channels, sampleRate };
  }

  if (typeof OfflineAudioContext === 'undefined') {
    throw new Error('Audio decoding for non-WAV files is not available in this environment');
  }

  const ctx = new OfflineAudioContext(1, 1, 48000);
  // decodeAudioData detaches the buffer it is given; pass a copy so the caller's
  // ArrayBuffer stays usable.
  const audioBuffer = await ctx.decodeAudioData(buf.slice(0));

  const numChannels = Math.min(2, audioBuffer.numberOfChannels);
  const channels: Float32Array[] = [];
  for (let c = 0; c < numChannels; c++) {
    // Copy out of the AudioBuffer so we own the memory (getChannelData returns a
    // live view into the buffer).
    channels.push(audioBuffer.getChannelData(c).slice());
  }
  return { channels, sampleRate: audioBuffer.sampleRate };
}
