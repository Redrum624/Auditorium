import { planRemix } from '../dsp/remixPlan';
import type { PlanRemixOptions } from '../dsp/remixPlan';
import type { RemixAnalysis } from '../dsp/remixFeatures';

export type RemixPlanMessage =
  | { type: 'init'; analysis: RemixAnalysis }
  | { type: 'plan'; id: number; options: PlanRemixOptions };

// Test-only fault injection: when set, every 'plan' request replies with an
// `error` message instead of planning (mirrors createTempoWorkerMock's
// `_setTempoWorkerError`).
let injectedError: string | null = null;

export function _setRemixPlanWorkerError(message: string | null): void {
  injectedError = message;
}

// Test-only fault injection: when set, every FakeRemixPlanWorker instance
// fires `onerror` instead of ever processing a message — simulating a worker
// that fails to even LOAD (createDspWorkerMock's `_setDspWorkerLoadFailure`).
let loadFailureMessage: string | null = null;

export function _setRemixPlanWorkerLoadFailure(message: string | null): void {
  loadFailureMessage = message;
}

let lastMessage: RemixPlanMessage | null = null;

export function _getLastRemixPlanMessage(): RemixPlanMessage | null {
  return lastMessage;
}

let createCount = 0;
let terminateCount = 0;
/** How many 'plan' requests were actually served — the memo's own hit rate is
 * measured against this (a memo hit must never reach the worker). */
let planRequestCount = 0;

export function _getRemixPlanWorkerCreateCount(): number {
  return createCount;
}

export function _getRemixPlanWorkerTerminateCount(): number {
  return terminateCount;
}

export function _getRemixPlanRequestCount(): number {
  return planRequestCount;
}

export function _resetRemixPlanWorkerTestState(): void {
  injectedError = null;
  loadFailureMessage = null;
  lastMessage = null;
  createCount = 0;
  terminateCount = 0;
  planRequestCount = 0;
}

/**
 * Test double for the session-scoped plan worker: keeps the `init` analysis
 * resident and runs the SAME pure `planRemix` core the real
 * `remixPlan.worker.ts` calls, synchronously behind a microtask, emitting the
 * same message shapes — with a `terminated` guard so a terminated instance
 * never emits again.
 */
class FakeRemixPlanWorker {
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  private terminated = false;
  private resident: RemixAnalysis | null = null;

  postMessage(message: unknown): void {
    const msg = message as RemixPlanMessage;
    if (this.terminated || !msg) return;
    lastMessage = msg;

    if (loadFailureMessage !== null) {
      const failure = loadFailureMessage;
      queueMicrotask(() => {
        if (this.terminated) return;
        this.onerror?.({ message: failure } as ErrorEvent);
      });
      return;
    }

    if (msg.type === 'init') {
      this.resident = msg.analysis;
      return;
    }
    if (msg.type !== 'plan') return;
    planRequestCount++;

    queueMicrotask(() => {
      if (this.terminated) return;
      try {
        if (injectedError !== null) throw new Error(injectedError);
        if (!this.resident) throw new Error('remixPlan worker: received a plan request before init');
        const result = planRemix(this.resident, msg.options);
        this.emit({ type: 'planned', id: msg.id, result });
      } catch (err) {
        this.emit({
          type: 'error',
          id: msg.id,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    });
  }

  private emit(data: unknown): void {
    if (this.terminated) return;
    this.onmessage?.({ data } as MessageEvent);
  }

  terminate(): void {
    this.terminated = true;
    terminateCount++;
  }

  addEventListener(): void {}
  removeEventListener(): void {}
}

export function createRemixPlanWorker(): Worker {
  createCount++;
  return new FakeRemixPlanWorker() as unknown as Worker;
}
