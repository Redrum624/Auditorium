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
 */
export async function runEffectOnSelection(
  effectId: string,
  params: Record<string, EffectParamValue>,
  onProgress?: (fraction: number) => void
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
        applyEdit(
          `Effect: ${def.name}`,
          docId,
          (d) => replaceRegion(d, start, end, resultChannels),
          { selection: { start, end: start + resultLen }, cursorSample: start }
        );
        onProgress?.(1);
        resolve();
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
      { type: 'run', id: runId, effectId, channels: regionChannels, sampleRate, params },
      transfer
    );
  });
}
