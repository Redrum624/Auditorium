import { analyzeTempo, deriveGrid, decimateMono } from '../dsp/tempoCore';
import type { TempoAnalysis } from '../dsp/tempoCore';
import { chromaEnvelope, deriveRemixFeatures } from '../dsp/remixFeatures';
import type { RemixAnalysis } from '../dsp/remixFeatures';

export interface AnalyzeMessage {
  type: 'analyze';
  id: number;
  level: 'tempo' | 'remix' | 'regrid';
  mono: Float32Array;
  sampleRate: number;
  minBpm: number;
  maxBpm: number;
  beatsPerBar: number;
  downbeatShiftBeats: number;
  /** Only present/used when level === 'regrid'. */
  odf?: Float32Array;
  periodFrames?: number;
}

// Test-only fault injection: when set, every 'analyze' request replies with
// an `error` message instead of computing (mirrors
// createSpectrogramWorkerMock's `_setSpectrogramWorkerError`). Reset in
// afterEach via `_resetTempoWorkerTestState`.
let injectedError: string | null = null;

export function _setTempoWorkerError(message: string | null): void {
  injectedError = message;
}

// Test-only fault injection: when set, every FakeTempoWorker instance fires
// `onerror` instead of ever processing the 'analyze' message — simulating a
// worker that fails to even LOAD (mirrors createDspWorkerMock's
// `_setDspWorkerLoadFailure`). Reset in afterEach via
// `_resetTempoWorkerTestState`.
let loadFailureMessage: string | null = null;

export function _setTempoWorkerLoadFailure(message: string | null): void {
  loadFailureMessage = message;
}

// Test-only capture: the most recent 'analyze' message posted to any
// FakeTempoWorker instance (mirrors createSpectrogramWorkerMock's
// `_getLastComputeMessage`).
let lastMessage: AnalyzeMessage | null = null;

export function _getLastTempoMessage(): AnalyzeMessage | null {
  return lastMessage;
}

// Test-only capture: total terminate() calls across all FakeTempoWorker
// instances (mirrors createDspWorkerMock's `_getDspWorkerTerminateCount`).
let terminateCallCount = 0;

export function _getTempoWorkerTerminateCount(): number {
  return terminateCallCount;
}

export function _resetTempoWorkerTestState(): void {
  injectedError = null;
  loadFailureMessage = null;
  lastMessage = null;
  terminateCallCount = 0;
}

// Same throttle interval and shape as the real tempo.worker.ts.
const PROGRESS_INTERVAL_MS = 50;

/**
 * Test double for the tempo worker: runs `analyzeTempo` (the SAME pure core
 * the real tempo.worker.ts calls) SYNCHRONOUSLY on the main thread behind a
 * microtask, emitting the same message shapes as the real worker — throttled
 * `progress`, then `done` or `error` — with a `terminated` guard so a
 * terminated instance never emits again. Lets tempoAnalysis.ts (Task T4) be
 * exercised end-to-end without a real Worker.
 */
class FakeTempoWorker {
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  private terminated = false;

  postMessage(message: unknown, _transfer?: Transferable[]): void {
    const msg = message as AnalyzeMessage;
    if (this.terminated || !msg || msg.type !== 'analyze') return;
    lastMessage = msg;

    if (loadFailureMessage !== null) {
      const failure = loadFailureMessage;
      queueMicrotask(() => {
        if (this.terminated) return;
        this.onerror?.({ message: failure } as ErrorEvent);
      });
      return;
    }

    queueMicrotask(() => {
      if (this.terminated) return;
      try {
        if (injectedError !== null) throw new Error(injectedError);

        let analysis: TempoAnalysis | RemixAnalysis;
        if (msg.level === 'regrid') {
          if (!msg.odf || msg.periodFrames === undefined) {
            throw new Error('regrid request missing odf/periodFrames');
          }
          analysis = deriveGrid(msg.mono, msg.sampleRate, msg.odf, msg.periodFrames);
        } else {
          let lastProgress = 0;
          const onProgress = (fraction: number) => {
            const now = Date.now();
            if (now - lastProgress >= PROGRESS_INTERVAL_MS) {
              lastProgress = now;
              this.emit({ type: 'progress', id: msg.id, fraction });
            }
          };

          const tempo = analyzeTempo(
            msg.mono,
            msg.sampleRate,
            { minBpm: msg.minBpm, maxBpm: msg.maxBpm },
            onProgress
          );
          if (msg.level === 'remix') {
            // Mirrors tempo.worker.ts's real remix branch exactly (T9 fix
            // round 1): re-decimate the same analyzed range, run the chroma
            // pass, then deriveRemixFeatures — so this mock and the real
            // worker agree on 'remix' behaviour instead of the mock pinning
            // a stale 'not implemented' stub the real worker no longer has.
            const analyzed = msg.mono.subarray(0, tempo.analyzedEndSample);
            const { signal, rate } = decimateMono(analyzed, msg.sampleRate);
            const chroma = chromaEnvelope(signal, rate);
            analysis = deriveRemixFeatures(tempo, chroma, {
              beatsPerBar: msg.beatsPerBar,
              downbeatShiftBeats: msg.downbeatShiftBeats,
            });
          } else {
            analysis = tempo;
          }
        }

        this.emit({ type: 'done', id: msg.id, level: msg.level, analysis });
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
    terminateCallCount++;
  }

  addEventListener(): void {}
  removeEventListener(): void {}
}

export function createTempoWorker(): Worker {
  return new FakeTempoWorker() as unknown as Worker;
}
