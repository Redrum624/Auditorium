import { encodeOggOpus, OggEncoderUnavailableError } from './oggOpusEncoder';

// jsdom has no WebCodecs AudioEncoder/AudioData, so encodeOggOpus must fail with
// a typed error (the real encode path is covered by the packaged-app smoke).

describe('encodeOggOpus (WebCodecs unavailable)', () => {
  const channels = [new Float32Array(1000), new Float32Array(1000)];

  it('rejects with OggEncoderUnavailableError when AudioEncoder is missing', async () => {
    expect(typeof (globalThis as { AudioEncoder?: unknown }).AudioEncoder).toBe('undefined');
    await expect(encodeOggOpus(channels, 44100)).rejects.toBeInstanceOf(
      OggEncoderUnavailableError
    );
  });

  it('rejects before doing any work (no resample, no output) when unavailable', async () => {
    await expect(encodeOggOpus(channels, 48000, 96_000)).rejects.toThrow(
      /AudioEncoder is not available/
    );
  });

  it('exposes a named error type distinct from a plain Error', () => {
    const err = new OggEncoderUnavailableError();
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('OggEncoderUnavailableError');
  });
});
