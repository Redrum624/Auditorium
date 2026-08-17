/**
 * Sole creation point for the DSP worker — isolated so Jest can map it to a
 * synchronous mock (`src/__mocks__/createDspWorkerMock.ts`). Vite bundles the
 * referenced worker module into its own chunk.
 */
export function createDspWorker(): Worker {
  return new Worker(new URL('./dsp.worker.ts', import.meta.url), { type: 'module' });
}
