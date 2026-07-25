import { cloneRegion, docLength, replaceRegion } from '../audio/AudioDocument';
import { getEffect } from '../effects/EffectRegistry';
import type { EffectParamValue } from '../effects/types';
import { useAppStore } from '../stores/appStore';
import { createDspWorker } from '../workers/createDspWorker';
import { applyEdit } from './editOps';

type WorkerReply =
  | { type: 'progress'; id: number; fraction: number }
  | { type: 'done'; id: number; channels: Float32Array[] }
  | { type: 'error'; id: number; message: string };

let nextRunId = 1;

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
 *
 * `extra` is an opaque payload forwarded to the worker's `__effectExtra` side
 * channel (reserved for Task 19's noise profile).
 */
export async function runEffectOnSelection(
  effectId: string,
  params: Record<string, EffectParamValue>,
  onProgress?: (fraction: number) => void,
  extra?: unknown
): Promise<void> {
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
      const msg = e.data as WorkerReply;
      if (msg.id !== runId) return;

      if (msg.type === 'progress') {
        onProgress?.(msg.fraction);
        return;
      }

      if (msg.type === 'done') {
        worker.terminate();
        const resultChannels = msg.channels;
        const resultLen = resultChannels[0]?.length ?? 0;
        try {
          applyEdit(
            `Effect: ${def.name}`,
            docId,
            (d) => replaceRegion(d, start, end, resultChannels),
            { selection: { start, end: start + resultLen }, cursorSample: start },
            // Most effects are equal-length (no remap needed), but length-changing
            // ones (Time Stretch, Pitch Shift) move everything after the region —
            // and everything strictly inside it stops existing at its old position.
            // Same 'replace' rule as pasteAtCursor's replace-selection path (Task
            // M3 fix round 1): markers this region's length change would otherwise
            // leave stale (or past-EOF on disk) ride the same undo entry.
            { type: 'replace', start, end, length: resultLen }
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

    const transfer = regionChannels.map((c) => c.buffer as ArrayBuffer);
    worker.postMessage(
      { type: 'run', id: runId, effectId, channels: regionChannels, sampleRate, params, extra },
      transfer
    );
  });
}
