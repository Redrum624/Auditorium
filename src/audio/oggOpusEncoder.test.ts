import { encodeOggOpus, markersToOpusRate, OggEncoderUnavailableError } from './oggOpusEncoder';

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

  it('rejects with OggEncoderUnavailableError even when markers are passed (Task K5)', async () => {
    await expect(
      encodeOggOpus(channels, 44100, 128_000, [{ positionSample: 22050, name: 'Intro' }])
    ).rejects.toBeInstanceOf(OggEncoderUnavailableError);
  });

  it('exposes a named error type distinct from a plain Error', () => {
    const err = new OggEncoderUnavailableError();
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('OggEncoderUnavailableError');
  });
});

// -----------------------------------------------------------------------------
// markersToOpusRate (Task K5 — source-rate -> 48 kHz file-rate conversion)
// -----------------------------------------------------------------------------

describe('markersToOpusRate', () => {
  it('maps a 44.1 kHz source marker to the correct 48 kHz sample', () => {
    // 22050 samples @ 44100 Hz = 0.5s -> 24000 samples @ 48000 Hz.
    const result = markersToOpusRate([{ positionSample: 22050, name: 'Intro' }], 44100);
    expect(result).toEqual([{ positionSample: 24000, name: 'Intro' }]);
  });

  it('is a no-op (identity) mapping when the source is already 48 kHz', () => {
    const result = markersToOpusRate([{ positionSample: 12345, name: 'Hook' }], 48000);
    expect(result).toEqual([{ positionSample: 12345, name: 'Hook' }]);
  });

  it('rounds to the nearest sample rather than truncating', () => {
    // 1000 samples @ 22050 Hz -> 1000 * 48000/22050 = 2176.87... -> rounds to 2177.
    const result = markersToOpusRate([{ positionSample: 1000, name: 'x' }], 22050);
    expect(result[0].positionSample).toBe(Math.round((1000 * 48000) / 22050));
  });

  it('preserves marker order and names, converting every entry', () => {
    const markers = [
      { positionSample: 0, name: 'Start' },
      { positionSample: 44100, name: 'One second' },
      { positionSample: 88200, name: 'Two seconds' },
    ];
    const result = markersToOpusRate(markers, 44100);
    expect(result.map((m) => m.positionSample)).toEqual([0, 48000, 96000]);
    expect(result.map((m) => m.name)).toEqual(['Start', 'One second', 'Two seconds']);
  });

  it('returns an empty array for an empty input array', () => {
    expect(markersToOpusRate([], 44100)).toEqual([]);
  });
});
