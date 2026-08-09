import { cloneRegion, docLength, replaceRegion } from '../audio/AudioDocument';
import { getEffect } from '../effects/EffectRegistry';
import type { EffectParamValue } from '../effects/types';
import { useAppStore } from '../stores/appStore';
import { createDspWorker } from '../workers/createDspWorker';
import type { DspWorkerReply, DspWorkerRunMessage } from '../workers/dspWorkerMessages';
import { applyEdit } from './editOps';
import type { MarkerRemap } from './editOps';

/**
 * Human-readable summary of what a span-deleting effect removed (ruling 5:
 * the user must be able to see the effect DID something). Rendered into the
 * default History label because a param `readout` cannot know it — readouts
 * see only the param value and the region length, never the samples, and the
 * removal is only known after the effect has run. Sub-second totals are shown
 * in ms so a small removal never reads as "0.0 s"; the rounded ms value picks
 * the unit, so 999.7 ms shows as "1.00 s", not "1000 ms".
 */
export function describeRemoval(spans: { start: number; end: number }[], sampleRate: number): string {
  if (spans.length === 0) return 'nothing removed';
  let total = 0;
  for (const s of spans) total += s.end - s.start;
  const ms = Math.round((total / sampleRate) * 1000);
  const amount = ms < 1000 ? `${ms} ms` : `${(total / sampleRate).toFixed(2)} s`;
  return `${spans.length} gap${spans.length === 1 ? '' : 's'}, ${amount} removed`;
}

let nextRunId = 1;

/** Trailing options for `runEffectOnSelection`. An options object rather than
 * more positionals (v1.9.2): with `extra` typed `unknown`, a transposed
 * `(extra, label)` pair would type-check silently, and every caller needing a
 * late option had to pad the earlier slots with `undefined`. */
export interface RunEffectOptions {
  onProgress?: (fraction: number) => void;
  /** Opaque payload forwarded to the worker's `__effectExtra` side channel
   * (Task 19's noise profile). */
  extra?: unknown;
  /** Overrides the undo/History label. Default: `Effect: ${def.name}`. Used by
   * Match Tempo (v1.9.2), which runs the Time Stretch effect but should show up
   * in History as what the USER asked for, not how the work was done. The label
   * is display-only and in-memory (never serialized into `.audm`). */
  label?: string;
}

/**
 * Runs an effect over the target region (the active selection, or the whole
 * document when there is none) on a one-shot DSP worker. On success the result is
 * committed through `applyEdit` (so it is undoable), replacing the region — which
 * also handles length-changing effects — and the selection is updated to span the
 * new region extent. On worker error, an error dialog is shown and NO edit is made.
 *
 * The promise ALWAYS resolves (never rejects, never hangs): if applying the result
 * fails — e.g. the document was closed while the worker was busy — the failure is
 * surfaced via an error dialog and the promise resolves with no edit applied, so
 * callers (EffectDialog's busy state) reliably settle.
 */
export async function runEffectOnSelection(
  effectId: string,
  params: Record<string, EffectParamValue>,
  opts: RunEffectOptions = {}
): Promise<void> {
  const { onProgress, extra, label } = opts;
  const state = useAppStore.getState();
  const doc = state.documents.find((d) => d.id === state.activeDocumentId) ?? null;
  if (!doc) return;
  const def = getEffect(effectId);
  if (!def) return;

  const selection = state.selection;
  const start = selection ? selection.start : 0;
  const end = selection ? selection.end : docLength(doc);
  const docId = doc.id;
  const sampleRate = doc.sampleRate;
  const regionChannels = cloneRegion(doc, start, end);

  const runId = nextRunId++;
  const worker = createDspWorker();

  await new Promise<void>((resolve) => {
    worker.onmessage = (e: MessageEvent) => {
      const msg = e.data as DspWorkerReply;
      if (msg.id !== runId) return;

      if (msg.type === 'progress') {
        onProgress?.(msg.fraction);
        return;
      }

      if (msg.type === 'done') {
        worker.terminate();
        const resultChannels = msg.channels;
        const resultLen = resultChannels[0]?.length ?? 0;
        // Most effects are equal-length (no remap needed), but length-changing
        // ones (Time Stretch, Pitch Shift) TRANSFORM the region rather than
        // replacing it with unrelated content, so interior markers ride the
        // stretch proportionally instead of dropping (Task M3 fix round 2 —
        // 'replace' was ruled wrong here: it drops every interior marker,
        // including all of them on a whole-file Time Stretch). Markers at/
        // after the region still shift by the same length delta either way.
        //
        // A proportional stretch is WRONG, however, for an effect that deletes
        // discontiguous interior spans (Remove Silence, F2): there a marker on
        // speech after a removed gap must shift by exactly the removal before
        // it, not by the region's average shrink ratio. Such effects report
        // their `removedSpans` (region-relative; made absolute here) and get
        // the exact piecewise 'cuts' remap instead.
        const remap: MarkerRemap = msg.removedSpans
          ? { type: 'cuts', cuts: msg.removedSpans.map((s) => ({ start: start + s.start, end: start + s.end })) }
          : { type: 'stretch', start, end, length: resultLen };
        try {
          applyEdit(
            // Ruling 5 (F2): a span-deleting effect's default label reports
            // what it removed; an explicit caller label still wins.
            label ??
              (msg.removedSpans
                ? `Effect: ${def.name} (${describeRemoval(msg.removedSpans, sampleRate)})`
                : `Effect: ${def.name}`),
            docId,
            (d) => replaceRegion(d, start, end, resultChannels),
            { selection: { start, end: start + resultLen }, cursorSample: start },
            remap
          );
          onProgress?.(1);
        } catch (err) {
          // The doc may have been closed/removed while the worker was busy.
          // Surface it and settle — no edit was applied.
          void window.electronAPI?.showMessageBox({
            type: 'error',
            title: 'Effect failed',
            message: err instanceof Error ? err.message : String(err),
          });
        } finally {
          resolve();
        }
        return;
      }

      // error
      worker.terminate();
      void window.electronAPI?.showMessageBox({
        type: 'error',
        title: 'Effect failed',
        message: msg.message,
      });
      resolve();
    };

    // A worker that fails to even LOAD (missing/unparsable script, blocked by
    // CSP, ...) never reaches the `onmessage` handler above — without this,
    // the promise would never settle, hanging the Apply call forever and
    // leaking the worker (Task M9 / F28). Mirrors the in-band 'error' branch:
    // terminate + discard the worker, surface via the same error dialog.
    worker.onerror = (ev: ErrorEvent) => {
      worker.terminate();
      void window.electronAPI?.showMessageBox({
        type: 'error',
        title: 'Effect failed',
        message: ev.message || 'DSP worker failed to load',
      });
      resolve();
    };

    // The post is wrapped for the same reason `tempoAnalysis.ts:636-643`
    // wraps its own: a throw here (an unclonable `params`/`extra`, an
    // already-detached transfer buffer, ...) is caught by the Promise
    // machinery and would silently REJECT this promise — so the `terminate()`
    // calls above are never reached and the worker created at :50 leaks, one
    // thread per Apply. A `try` around `new Promise(...)` cannot catch it;
    // it has to be inside the executor.
    try {
      const transfer = regionChannels.map((c) => c.buffer as ArrayBuffer);
      // Typed for the same reason as the worker's done message: postMessage
      // takes `unknown`, so the shared contract is enforced at the literal.
      const runMessage: DspWorkerRunMessage = {
        type: 'run',
        id: runId,
        effectId,
        channels: regionChannels,
        sampleRate,
        params,
        extra,
      };
      worker.postMessage(runMessage, transfer);
    } catch (err) {
      try {
        worker.terminate();
      } catch {
        /* best-effort — the worker never successfully posted, nothing more to clean up */
      }
      void window.electronAPI?.showMessageBox({
        type: 'error',
        title: 'Effect failed',
        message: err instanceof Error ? err.message : String(err),
      });
      resolve();
    }
  });
}
