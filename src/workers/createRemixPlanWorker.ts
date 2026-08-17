/**
 * Sole creation point for the session-scoped remix PLAN worker — isolated so
 * Jest can map it to a synchronous mock
 * (`src/__mocks__/createRemixPlanWorkerMock.ts`), exactly like
 * `createTempoWorker.ts`. Vite bundles the referenced worker module into its
 * own chunk.
 *
 * Unlike the tempo worker (one-shot per analysis run, terminated on every
 * terminal branch), this one lives for the life of a remix SESSION — see
 * `remixPlan.worker.ts` for why the analysis is resident, and
 * `remixService.ts` for the exact termination points.
 */
export function createRemixPlanWorker(): Worker {
  return new Worker(new URL('./remixPlan.worker.ts', import.meta.url), { type: 'module' });
}
