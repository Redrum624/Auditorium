import { registerAllEffects } from '../effects/registerAll';
import { getEffect } from '../effects/EffectRegistry';
import type { EffectParamValue } from '../effects/types';

// Effects must be registered in the worker's own module scope (it does not share
// the renderer's registry).
registerAllEffects();

interface RunMessage {
  type: 'run';
  id: number;
  effectId: string;
  channels: Float32Array[];
  sampleRate: number;
  params: Record<string, EffectParamValue>;
  extra?: unknown;
}

// The worker global. Typed via a narrow cast so this file compiles under the DOM
// lib without pulling in the conflicting `webworker` lib `self` declaration.
const ctx = self as unknown as {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent<RunMessage>) => void) | null;
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
    // the exact per-cut rule; plain numbers, so no transfer list entry.
    ctx.postMessage(
      { type: 'done', id: msg.id, channels: result.channels, removedSpans: result.removedSpans },
      transfer
    );
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
