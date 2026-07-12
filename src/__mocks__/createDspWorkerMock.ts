import { registerAllEffects } from '../effects/registerAll';
import { getEffect } from '../effects/EffectRegistry';
import type { EffectParamValue } from '../effects/types';

interface RunMessage {
  type: 'run';
  id: number;
  effectId: string;
  channels: Float32Array[];
  sampleRate: number;
  params: Record<string, EffectParamValue>;
  extra?: unknown;
}

/**
 * Test double for the DSP worker: runs the registered effect SYNCHRONOUSLY on the
 * main thread behind a microtask, emitting the same message objects as the real
 * worker (a single `progress` 0.5 then `done`, or `error` on throw). Lets
 * effectRunner be exercised end-to-end without a real Worker.
 */
class FakeDspWorker {
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  private terminated = false;

  postMessage(message: unknown, _transfer?: Transferable[]): void {
    const msg = message as RunMessage;
    if (this.terminated || !msg || msg.type !== 'run') return;
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
        this.emit({ type: 'done', id: msg.id, channels: result.channels });
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
  }

  addEventListener(): void {}
  removeEventListener(): void {}
}

export function createDspWorker(): Worker {
  return new FakeDspWorker() as unknown as Worker;
}
