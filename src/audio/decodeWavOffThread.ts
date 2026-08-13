import { decodeWav } from './wavCodec';
import { createWavDecodeWorker } from '../workers/createWavDecodeWorker';
import type { WavDecodeResponse } from '../workers/wavDecodeMessages';

/** What `decodeWav` returns — decoding off-thread must produce exactly this,
 * whichever route it took. */
export type WavDecodeResult = ReturnType<typeof decodeWav>;

let nextRequestId = 1;

/**
 * Decode a WAV off the renderer's main thread.
 *
 * `bytes` is CONSUMED: it is transferred into the worker, which detaches the
 * caller's reference. That is the whole point — the file's bytes and the
 * decoded samples never both sit in the renderer's main heap at once — so no
 * caller may read `bytes` after calling this.
 *
 * One worker per decode, terminated in `finally`. A resident worker would hold
 * its module and its last decode's allocations for the rest of the session,
 * and this fix is about what stays resident; spawning costs a few
 * milliseconds against a decode measured in hundreds. Nothing is shared
 * between calls, so two opens in flight cannot interfere.
 *
 * Falls back to decoding on the main thread when no Worker can be constructed
 * at all (jsdom, or any environment without workers): the old behaviour, which
 * is slow but correct, and strictly better than refusing to open the file.
 * Once the bytes have been posted there is no falling back — they are gone
 * from this thread — so a worker that fails after that rejects, and the open
 * flow rolls back and names the file.
 */
export function decodeWavOffThread(bytes: ArrayBuffer): Promise<WavDecodeResult> {
  let worker: Worker;
  try {
    worker = createWavDecodeWorker();
  } catch {
    // No workers here. `bytes` is still intact — nothing was transferred.
    return Promise.resolve(decodeWav(bytes));
  }

  const id = nextRequestId++;
  return new Promise<WavDecodeResult>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      worker.terminate();
      fn();
    };

    worker.onmessage = (e: MessageEvent<WavDecodeResponse>) => {
      const msg = e.data;
      if (!msg || msg.id !== id) return;
      if (msg.type === 'done') {
        finish(() =>
          resolve({
            channels: msg.channels,
            sampleRate: msg.sampleRate,
            bitDepth: msg.bitDepth,
            markers: msg.markers,
            channelMask: msg.channelMask,
          })
        );
      } else {
        finish(() => reject(new Error(msg.message)));
      }
    };

    worker.onerror = (e: ErrorEvent) => {
      finish(() => reject(new Error(e.message || 'WAV decode worker failed')));
    };

    worker.postMessage({ type: 'decode', id, bytes }, [bytes]);
  });
}
