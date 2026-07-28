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
// Codec lifetime on the error path (v1.5.0 hardening item 9)
// -----------------------------------------------------------------------------

describe('encodeOggOpus — an errored codec is still closed', () => {
  let closeCalls = 0;
  let flushCalls = 0;

  /** Minimal WebCodecs stand-in: reports an encode error on the first
   * `encode()` (exactly how a real AudioEncoder surfaces one — via the error
   * callback, not a throw) and then REJECTS `flush()`, which is what a real
   * errored AudioEncoder does. */
  function installFakeWebCodecs(): void {
    closeCalls = 0;
    flushCalls = 0;
    class FakeAudioEncoder {
      encodeQueueSize = 0;
      private onError: (e: DOMException) => void;
      constructor(init: { output: unknown; error: (e: DOMException) => void }) {
        this.onError = init.error;
      }
      configure(): void {}
      encode(): void {
        this.onError(new Error('codec exploded') as unknown as DOMException);
      }
      async flush(): Promise<void> {
        flushCalls++;
        throw new Error('Cannot call flush on a closed codec');
      }
      close(): void {
        closeCalls++;
      }
    }
    class FakeAudioData {
      constructor(_init: unknown) {}
      close(): void {}
    }
    (globalThis as Record<string, unknown>).AudioEncoder = FakeAudioEncoder;
    (globalThis as Record<string, unknown>).AudioData = FakeAudioData;
  }

  afterEach(() => {
    delete (globalThis as Record<string, unknown>).AudioEncoder;
    delete (globalThis as Record<string, unknown>).AudioData;
  });

  it('closes the encoder and reports the ENCODE error, not the flush rejection', async () => {
    installFakeWebCodecs();

    // Before the fix, `if (encodeError) break` fell straight into
    // `await encoder.flush()`, whose rejection propagated past
    // `encoder.close()` — leaking the codec and masking the real cause.
    await expect(encodeOggOpus([new Float32Array(4800)], 48000)).rejects.toThrow('codec exploded');

    expect(flushCalls).toBe(1);
    expect(closeCalls).toBe(1);
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
