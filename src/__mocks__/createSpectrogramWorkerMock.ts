import { computeSpectrogramColumns } from '../workers/spectrogramCore';

export interface ComputeMessage {
  type: 'compute';
  id: number;
  channel: Float32Array;
  sampleRate: number;
  startSample: number;
  endSample: number;
  width: number;
  height: number;
  fftSize: number;
  scale?: 'log' | 'linear';
}

// Test-only fault injection (Task F8): when set, every compute request replies
// with an `error` message instead of computing, letting SpectrogramView's
// error branch be exercised deterministically. Reset it in afterEach.
let injectedError: string | null = null;

export function _setSpectrogramWorkerError(message: string | null): void {
  injectedError = message;
}

// Test-only capture (Task M9 / F17): the most recent 'compute' message posted
// to any FakeSpectrogramWorker instance, so tests can assert on the ACTUAL
// slice/offsets SpectrogramView sent (e.g. that it no longer mixes down the
// whole document on every viewport change). Reset it in afterEach.
let lastComputeMessage: ComputeMessage | null = null;

export function _getLastComputeMessage(): ComputeMessage | null {
  return lastComputeMessage;
}

export function _resetSpectrogramWorkerCapture(): void {
  lastComputeMessage = null;
}

/**
 * Test double for the spectrogram worker: computes the magnitude grid
 * SYNCHRONOUSLY on the main thread behind a microtask, emitting the same `done`
 * message as the real worker — or, mirroring the real worker's error branch
 * (Task F8), an `{type:'error', id, message}` message when the compute throws
 * (or when a test injected a fault via `_setSpectrogramWorkerError`). Lets
 * SpectrogramView be exercised without a real Worker, and shares the exact pure
 * core (`computeSpectrogramColumns`).
 */
class FakeSpectrogramWorker {
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  private terminated = false;

  postMessage(message: unknown, _transfer?: Transferable[]): void {
    const msg = message as ComputeMessage;
    if (this.terminated || !msg || msg.type !== 'compute') return;
    lastComputeMessage = msg;
    queueMicrotask(() => {
      if (this.terminated) return;
      try {
        if (injectedError !== null) throw new Error(injectedError);
        const mags = computeSpectrogramColumns({
          channel: msg.channel,
          startSample: msg.startSample,
          endSample: msg.endSample,
          width: msg.width,
          height: msg.height,
          fftSize: msg.fftSize,
          sampleRate: msg.sampleRate,
          scale: msg.scale,
        });
        this.onmessage?.({
          data: { type: 'done', id: msg.id, mags, width: msg.width, height: msg.height },
        } as MessageEvent);
      } catch (err) {
        this.onmessage?.({
          data: {
            type: 'error',
            id: msg.id,
            message: err instanceof Error ? err.message : String(err),
          },
        } as MessageEvent);
      }
    });
  }

  terminate(): void {
    this.terminated = true;
  }

  addEventListener(): void {}
  removeEventListener(): void {}
}

export function createSpectrogramWorker(): Worker {
  return new FakeSpectrogramWorker() as unknown as Worker;
}
