import { decodeWavOffThread } from './decodeWavOffThread';
import { encodeWav } from './wavCodec';
import {
  _getLastWavDecodeTransfer,
  _getWavDecodeWorkerCounts,
  _resetWavDecodeWorkerTestState,
  _setWavDecodeWorkerConstructionFailure,
  _setWavDecodeWorkerError,
  _setWavDecodeWorkerLoadFailure,
} from '../__mocks__/createWavDecodeWorkerMock';

// jest.config maps `createWavDecodeWorker` to the double above, so this
// exercises the real client against a worker that answers the real protocol.

/** A small but genuine 2-channel WAV, so the decode under test is the real
 * `decodeWav` and its output can be checked sample by sample. */
function wavBytes(frames = 64, sampleRate = 44100): ArrayBuffer {
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    left[i] = Math.sin((i / frames) * Math.PI * 2);
    right[i] = -left[i];
  }
  return encodeWav([left, right], sampleRate, 32);
}

afterEach(() => {
  _resetWavDecodeWorkerTestState();
});

describe('decodeWavOffThread', () => {
  it('returns exactly what an in-place decodeWav would have', async () => {
    const result = await decodeWavOffThread(wavBytes(64, 48000));

    expect(result.sampleRate).toBe(48000);
    expect(result.bitDepth).toBe(32);
    expect(result.channels).toHaveLength(2);
    expect(result.channels[0]).toHaveLength(64);
    // Channel 1 is the negation of channel 0 by construction — proof the
    // samples came through in order and per channel, not merely in bulk.
    for (let i = 0; i < 64; i++) {
      expect(result.channels[1][i]).toBeCloseTo(-result.channels[0][i], 6);
    }
  });

  it('asks for a TRANSFER of the input, not a clone', async () => {
    // A clone would put the file's bytes in the worker while the renderer
    // still holds its own copy: two full copies of every file opened, which is
    // the cost this whole path exists to avoid.
    const bytes = wavBytes();
    await decodeWavOffThread(bytes);

    expect(_getLastWavDecodeTransfer()).toEqual([bytes]);
  });

  it('leaves the caller’s buffer DETACHED — the bytes really are gone', async () => {
    // The contract every caller has to respect, and the one the double has to
    // enforce: after handing the bytes over there is nothing left to read.
    // `decodeArrayBuffer` documents it, and `openFilePath` is built around it
    // (all container metadata is lifted out first).
    const bytes = wavBytes();
    expect(bytes.byteLength).toBeGreaterThan(0);

    await decodeWavOffThread(bytes);

    expect(bytes.byteLength).toBe(0); // detached
    expect(() => new DataView(bytes).getUint8(0)).toThrow();
  });

  it('the in-place fallback does NOT detach — nothing was ever posted', async () => {
    _setWavDecodeWorkerConstructionFailure('Worker is not defined');
    const bytes = wavBytes();

    const result = await decodeWavOffThread(bytes);

    expect(result.channels[0].length).toBeGreaterThan(0);
    expect(bytes.byteLength).toBeGreaterThan(0);
  });

  it('uses one worker per decode and terminates every one of them', async () => {
    await decodeWavOffThread(wavBytes());
    await decodeWavOffThread(wavBytes());

    // A resident worker would hold its module and its last decode's
    // allocations for the rest of the session.
    expect(_getWavDecodeWorkerCounts()).toEqual({ constructed: 2, terminated: 2 });
  });

  it('rejects with the worker’s message when the decode throws, and still terminates', async () => {
    _setWavDecodeWorkerError('Not a WAV file');

    await expect(decodeWavOffThread(wavBytes())).rejects.toThrow('Not a WAV file');
    expect(_getWavDecodeWorkerCounts().terminated).toBe(1);
  });

  it('rejects when the worker fails to load, and still terminates', async () => {
    // The bytes were already transferred by then, so there is nothing left to
    // fall back to — this has to surface as a failed open, not a hang.
    _setWavDecodeWorkerLoadFailure('failed to load worker script');

    await expect(decodeWavOffThread(wavBytes())).rejects.toThrow('failed to load worker script');
    expect(_getWavDecodeWorkerCounts().terminated).toBe(1);
  });

  it('falls back to decoding in place when no Worker can be constructed', async () => {
    // jsdom, or any environment without workers. Nothing was transferred yet,
    // so the bytes are intact and the file still opens — slowly, but it opens.
    _setWavDecodeWorkerConstructionFailure('Worker is not defined');

    const result = await decodeWavOffThread(wavBytes(32, 22050));

    expect(result.sampleRate).toBe(22050);
    expect(result.channels[0]).toHaveLength(32);
    expect(_getWavDecodeWorkerCounts().constructed).toBe(0);
  });

  it('keeps two concurrent decodes apart', async () => {
    const [a, b] = await Promise.all([
      decodeWavOffThread(wavBytes(16, 8000)),
      decodeWavOffThread(wavBytes(48, 32000)),
    ]);

    expect(a.sampleRate).toBe(8000);
    expect(a.channels[0]).toHaveLength(16);
    expect(b.sampleRate).toBe(32000);
    expect(b.channels[0]).toHaveLength(48);
  });
});
