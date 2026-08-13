/**
 * Sole creation point for the WAV decode worker — isolated so Jest can map it
 * to a synchronous mock (`src/__mocks__/createWavDecodeWorkerMock.ts`). Vite
 * bundles the referenced worker module into its own chunk. Same shape as
 * createTempoWorker.ts / createSpectrogramWorker.ts.
 */
export function createWavDecodeWorker(): Worker {
  return new Worker(new URL('./wavDecode.worker.ts', import.meta.url), { type: 'module' });
}
