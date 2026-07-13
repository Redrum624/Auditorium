import { computeSpectrogramColumns } from '../workers/spectrogramCore';

interface ComputeMessage {
  type: 'compute';
  id: number;
  channel: Float32Array;
  sampleRate: number;
  startSample: number;
  endSample: number;
  width: number;
  height: number;
  fftSize: number;
}

/**
 * Test double for the spectrogram worker: computes the magnitude grid
 * SYNCHRONOUSLY on the main thread behind a microtask, emitting the same `done`
 * message as the real worker. Lets SpectrogramView be exercised without a real
 * Worker, and shares the exact pure core (`computeSpectrogramColumns`).
 */
class FakeSpectrogramWorker {
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  private terminated = false;

  postMessage(message: unknown, _transfer?: Transferable[]): void {
    const msg = message as ComputeMessage;
    if (this.terminated || !msg || msg.type !== 'compute') return;
    queueMicrotask(() => {
      if (this.terminated) return;
      const mags = computeSpectrogramColumns({
        channel: msg.channel,
        startSample: msg.startSample,
        endSample: msg.endSample,
        width: msg.width,
        height: msg.height,
        fftSize: msg.fftSize,
      });
      this.onmessage?.({
        data: { type: 'done', id: msg.id, mags, width: msg.width, height: msg.height },
      } as MessageEvent);
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
