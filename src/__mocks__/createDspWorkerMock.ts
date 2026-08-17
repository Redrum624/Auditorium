import { registerAllEffects } from '../effects/registerAll';
import { getEffect } from '../effects/EffectRegistry';
import type { DspWorkerDoneMessage, DspWorkerRunMessage } from '../workers/dspWorkerMessages';

// Test-only fault injection (Task M9 / F28): when set, every FakeDspWorker
// instance fires `onerror` instead of ever processing the 'run' message —
// simulating a worker that fails to even LOAD (missing/unparsable script,
// blocked by CSP, ...), which never reaches `onmessage`. Lets effectRunner's
// onerror wiring be exercised deterministically. Reset both in afterEach.
let loadFailureMessage: string | null = null;
let terminateCallCount = 0;

export function _setDspWorkerLoadFailure(message: string | null): void {
  loadFailureMessage = message;
}

export function _getDspWorkerTerminateCount(): number {
  return terminateCallCount;
}

export function _resetDspWorkerTestState(): void {
  loadFailureMessage = null;
  terminateCallCount = 0;
}

/**
 * Test double for the DSP worker: runs the registered effect SYNCHRONOUSLY on the
 * main thread behind a microtask, emitting the same message objects as the real
 * worker (a single `progress` 0.5 then `done`, or `error` on throw). Lets
 * effectRunner be exercised end-to-end without a real Worker.
 */
class FakeDspWorker {
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  private terminated = false;

  postMessage(message: unknown, _transfer?: Transferable[]): void {
    const msg = message as DspWorkerRunMessage;
    if (this.terminated || !msg || msg.type !== 'run') return;
    if (loadFailureMessage !== null) {
      const failure = loadFailureMessage;
      queueMicrotask(() => {
        if (this.terminated) return;
        this.onerror?.({ message: failure } as ErrorEvent);
      });
      return;
    }
    registerAllEffects();
    queueMicrotask(() => {
      if (this.terminated) return;
      try {
        const def = getEffect(msg.effectId);
        if (!def) throw new Error(`Unknown effect: ${msg.effectId}`);

        // Mirror the real worker's Task 19 side channel exactly (dsp.worker.ts):
        // expose `extra` to process() via a module-level global, cleaned up below.
        if (msg.extra !== undefined) {
          (globalThis as { __effectExtra?: unknown }).__effectExtra = msg.extra;
        }

        this.emit({ type: 'progress', id: msg.id, fraction: 0.5 });
        const result = def.process(msg.channels, msg.sampleRate, msg.params);
        // Mirror dsp.worker.ts, on the SAME shared type, so the mock cannot
        // drift from what the real worker sends (F2 review, Important 1).
        const done: DspWorkerDoneMessage = {
          type: 'done',
          id: msg.id,
          channels: result.channels,
          removedSpans: result.removedSpans,
          report: result.report,
        };
        this.emit(done);
      } catch (err) {
        this.emit({
          type: 'error',
          id: msg.id,
          message: err instanceof Error ? err.message : String(err),
        });
      } finally {
        delete (globalThis as { __effectExtra?: unknown }).__effectExtra;
      }
    });
  }

  private emit(data: unknown): void {
    if (this.terminated) return;
    this.onmessage?.({ data } as MessageEvent);
  }

  terminate(): void {
    this.terminated = true;
    terminateCallCount++;
  }

  addEventListener(): void {}
  removeEventListener(): void {}
}

export function createDspWorker(): Worker {
  return new FakeDspWorker() as unknown as Worker;
}
