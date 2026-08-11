import { registerAllEffects } from '../effects/registerAll';
import { getEffect } from '../effects/EffectRegistry';
import type { DspWorkerDoneMessage, DspWorkerRunMessage } from './dspWorkerMessages';

// Effects must be registered in the worker's own module scope (it does not share
// the renderer's registry).
registerAllEffects();

// The worker global. Typed via a narrow cast so this file compiles under the DOM
// lib without pulling in the conflicting `webworker` lib `self` declaration.
const ctx = self as unknown as {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent<DspWorkerRunMessage>) => void) | null;
};

const PROGRESS_INTERVAL_MS = 50;

ctx.onmessage = (e) => {
  const msg = e.data;
  if (!msg || msg.type !== 'run') return;
  try {
    const def = getEffect(msg.effectId);
    if (!def) throw new Error(`Unknown effect: ${msg.effectId}`);

    // Task 19 side channel: pass `extra` (e.g. a noise profile) to process via a
    // module-level global. Formalized later; documented here as the contract.
    if (msg.extra !== undefined) {
      (globalThis as { __effectExtra?: unknown }).__effectExtra = msg.extra;
    }

    let lastProgress = 0;
    const onProgress = (fraction: number) => {
      const now = Date.now();
      if (now - lastProgress >= PROGRESS_INTERVAL_MS) {
        lastProgress = now;
        ctx.postMessage({ type: 'progress', id: msg.id, fraction });
      }
    };

    const result = def.process(msg.channels, msg.sampleRate, msg.params, onProgress);
    const transfer = result.channels.map((c) => c.buffer as ArrayBuffer);
    // `removedSpans` (F2) rides along so effectRunner can remap markers with
    // the exact per-cut rule; plain numbers, so no transfer list entry. The
    // message is built as a TYPED value (postMessage itself takes `unknown`)
    // so a field drifting from the shared contract is a compile error here,
    // not a silent production-only remap degradation — see dspWorkerMessages.
    const done: DspWorkerDoneMessage = {
      type: 'done',
      id: msg.id,
      channels: result.channels,
      removedSpans: result.removedSpans,
      report: result.report,
    };
    ctx.postMessage(done, transfer);
  } catch (err) {
    ctx.postMessage({
      type: 'error',
      id: msg.id,
      message: err instanceof Error ? err.message : String(err),
    });
  } finally {
    delete (globalThis as { __effectExtra?: unknown }).__effectExtra;
  }
};
