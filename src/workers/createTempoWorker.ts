/**
 * Sole creation point for the tempo/remix worker — isolated so Jest can map it
 * to a synchronous mock (`src/__mocks__/createTempoWorkerMock.ts`). Vite
 * bundles the referenced worker module into its own chunk.
 */
export function createTempoWorker(): Worker {
  return new Worker(new URL('./tempo.worker.ts', import.meta.url), { type: 'module' });
}
