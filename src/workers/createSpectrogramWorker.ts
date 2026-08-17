/**
 * Sole creation point for the spectrogram worker — isolated so Jest can map it to
 * a synchronous mock (`src/__mocks__/createSpectrogramWorkerMock.ts`). Vite
 * bundles the referenced worker module into its own chunk.
 */
export function createSpectrogramWorker(): Worker {
  return new Worker(new URL('./spectrogram.worker.ts', import.meta.url), { type: 'module' });
}
