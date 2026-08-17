import { cloneRegion, replaceRegion } from '../audio/AudioDocument';
import { getEffect } from '../effects/EffectRegistry';
import type { EffectParamValue, EffectReport } from '../effects/types';
import { useAppStore } from '../stores/appStore';
import { createDspWorker } from '../workers/createDspWorker';
import type { DspWorkerReply, DspWorkerRunMessage } from '../workers/dspWorkerMessages';
import { applyEdit } from './editOps';
import type { MarkerRemap } from './editOps';
import { resolveRegion } from './selectionRegion';

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

/** What one worker run produced — the `done` message, minus its routing id. */
export interface EffectRunOutput {
  channels: Float32Array[];
  removedSpans?: { start: number; end: number }[];
  report?: EffectReport;
}

/** Options for `runEffectOnChannels` — the subset of `RunEffectOptions` that
 * concerns the worker leg rather than the commit leg. */
export interface RunOnChannelsOptions {
  onProgress?: (fraction: number) => void;
  extra?: unknown;
}

/**
 * THE worker leg, shared by every caller (F7). Ships `channels` to a one-shot
 * DSP worker, runs `effectId` on them, and resolves with what came back. It
 * does NOT touch the store, does not commit an edit, and shows no dialog.
 *
 * REJECTS on failure — worker error reply, worker load failure, or an
 * unpostable message — where `runEffectOnSelection` swallows the same failures
 * into an error dialog. That asymmetry is the point: a single Apply has nothing
 * left to do after a failure, while the Vocal Chain has to stop the remaining
 * stages and leave the document untouched, and it can only do that if the
 * failure propagates. Both surfaces still end at the same error dialog, one
 * level up.
 *
 * The worker is terminated on every exit path, and the input channel buffers
 * are TRANSFERRED (detached) — callers must not read `channels` afterwards.
 */
export function runEffectOnChannels(
  effectId: string,
  channels: Float32Array[],
  sampleRate: number,
  params: Record<string, EffectParamValue>,
  opts: RunOnChannelsOptions = {}
): Promise<EffectRunOutput> {
  const { onProgress, extra } = opts;
  const runId = nextRunId++;
  const worker = createDspWorker();

  return new Promise<EffectRunOutput>((resolve, reject) => {
    // Every settle path goes through here so the worker cannot outlive the
    // promise, and so a late duplicate reply cannot settle it twice.
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      worker.terminate();
      fn();
    };

    worker.onmessage = (e: MessageEvent) => {
      const msg = e.data as DspWorkerReply;
      if (msg.id !== runId) return;
      if (msg.type === 'progress') {
        onProgress?.(msg.fraction);
        return;
      }
      if (msg.type === 'done') {
        finish(() =>
          resolve({ channels: msg.channels, removedSpans: msg.removedSpans, report: msg.report })
        );
        return;
      }
      finish(() => reject(new Error(msg.message)));
    };

    // A worker that fails to even LOAD (missing/unparsable script, blocked by
    // CSP, ...) never reaches `onmessage` — without this the promise would
    // never settle, hanging the caller forever and leaking the worker
    // (Task M9 / F28).
    worker.onerror = (ev: ErrorEvent) => {
      finish(() => reject(new Error(ev.message || 'DSP worker failed to load')));
    };

    // The post is wrapped for the same reason `tempoAnalysis.ts` wraps its
    // own: a throw here (an unclonable `params`/`extra`, an already-detached
    // transfer buffer, ...) is caught by the Promise machinery and would
    // silently reject WITHOUT terminating, leaking one thread per call. A
    // `try` around `new Promise(...)` cannot catch it; it has to be inside
    // the executor.
    try {
      const transfer = channels.map((c) => c.buffer as ArrayBuffer);
      // Typed for the same reason as the worker's done message: postMessage
      // takes `unknown`, so the shared contract is enforced at the literal.
      const runMessage: DspWorkerRunMessage = {
        type: 'run',
        id: runId,
        effectId,
        channels,
        sampleRate,
        params,
        extra,
      };
      worker.postMessage(runMessage, transfer);
    } catch (err) {
      finish(() => reject(err instanceof Error ? err : new Error(String(err))));
    }
  });
}

/**
 * How many "Effect failed" dialogs have been raised in this renderer session.
 *
 * A counter, not new behaviour: nothing in the app reads it, and the dialog it
 * counts is unchanged. It exists because the failure path is FIRE AND FORGET —
 * `reportEffectFailure` shows the dialog and the surrounding call resolves
 * normally — so from outside, a crashed effect and a clean refusal are the same
 * observation: the promise settled and the document did not change. The
 * packaged smoke's tiny-document step asserted exactly that pair and therefore
 * could not fail, whatever the worker did. `testHooks` reads this so the step
 * can assert the counter did not move.
 */
let effectFailureCount = 0;

/** The reading `testHooks.effectFailureCount()` exposes. */
export function getEffectFailureCount(): number {
  return effectFailureCount;
}

/** Shows the standard "Effect failed" dialog. Shared by every surface that
 * turns a `runEffectOnChannels` rejection into something the user can see, so
 * one failure never produces two different-looking reports. */
export function reportEffectFailure(err: unknown): void {
  effectFailureCount++;
  void window.electronAPI?.showMessageBox({
    type: 'error',
    title: 'Effect failed',
    message: err instanceof Error ? err.message : String(err),
  });
}

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
  /**
   * T6-3 — "is this run still wanted?", asked ONCE, after the worker has
   * returned and before anything is committed.
   *
   * The Cover Chain's engine has polled a predicate of this shape between its
   * stages since CC; a single run has no between, so the only moment that
   * matters is the seam between the audio arriving and `applyEdit` writing it.
   * That seam is inside THIS function, which is why the option is here rather
   * than in the two dialogs that pass it: a caller awaiting this promise cannot
   * get between the two, and by the time it is resumed the edit has landed.
   *
   * Returning `true` makes the run commit NOTHING — no document write, no undo
   * entry, no selection or cursor move (`applyEdit` writes both of those
   * globally, so a half-cancelled run would move the user's caret in whatever
   * document they moved on to) — and resolve `'cancelled'` so the caller can
   * say so instead of reporting the run as a no-op.
   *
   * Omitted means "always wanted", which is every existing caller's behaviour
   * unchanged.
   */
  shouldCancel?: () => boolean;
}

/**
 * What one {@link runEffectOnSelection} call did. `'refused'` covers every
 * path that already resolved silently — no document, unknown effect, a worker
 * failure that has shown its own dialog, a commit that threw — and is kept
 * distinct from `'cancelled'` because the caller acts differently on them: a
 * failure has already been reported to the user, a cancellation must stay
 * silent, because the user is the one who caused it.
 */
export type EffectRunOutcome = 'committed' | 'cancelled' | 'refused';

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
 * T6-3: it resolves with WHICH of those happened ({@link EffectRunOutcome}), so
 * a caller can tell a cancelled pass from one that found nothing to do. Callers
 * that ignore the value are unaffected.
 */
export async function runEffectOnSelection(
  effectId: string,
  params: Record<string, EffectParamValue>,
  opts: RunEffectOptions = {}
): Promise<EffectRunOutcome> {
  const { onProgress, extra, label, shouldCancel } = opts;
  const state = useAppStore.getState();
  const doc = state.documents.find((d) => d.id === state.activeDocumentId) ?? null;
  if (!doc) return 'refused';
  const def = getEffect(effectId);
  if (!def) return 'refused';

  // ONE resolved region, read by every consumer below — the worker's audio, the
  // `replaceRegion` write, the marker remap, and the post-edit selection/cursor.
  // `cloneRegion` and `replaceRegion` clamp to [0, docLength] internally, while
  // `setSelection` stores whatever it is handed, so reading the raw selection
  // HERE gave the markers a different region from the one the audio used: an
  // `end` past the document scaled interior markers against a span that was
  // never stretched, and a negative `start` mapped them below zero, where
  // `remapMarkers`' floor piled them onto sample 0 — and left the document
  // selected from a negative sample afterwards. Third instance of one defect
  // (R7's plan.regionStart, L1's resolveRegion): the ruling is resolve once, not
  // clamp twice and hope the two agree. T6-1: and the ruling is now the import
  // below, because six modules had each written this arithmetic out for
  // themselves — which is how the family reached fourteen members.
  const { start, end } = resolveRegion(doc, state.selection);
  const docId = doc.id;
  const sampleRate = doc.sampleRate;
  const regionChannels = cloneRegion(doc, start, end);

  let output: EffectRunOutput;
  try {
    output = await runEffectOnChannels(effectId, regionChannels, sampleRate, params, { onProgress, extra });
  } catch (err) {
    // Worker error / load failure / unpostable message — all three used to be
    // handled by three separate copies of this dialog call inside the executor.
    reportEffectFailure(err);
    return 'refused';
  }

  // T6-3: the ONE seam a walk-away can be observed at. Everything from here to
  // `applyEdit` is synchronous, so nothing can unmount, close a document or
  // change the active one between this answer and the commit — which is what
  // makes "a cancelled pass commits nothing" a property rather than a hope.
  // Silent by design: the user caused this, and a dialog telling them so would
  // be the app arguing with a decision they already made.
  if (shouldCancel?.()) return 'cancelled';

  const resultChannels = output.channels;
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
  const remap: MarkerRemap = output.removedSpans
    ? { type: 'cuts', cuts: output.removedSpans.map((s) => ({ start: start + s.start, end: start + s.end })) }
    : { type: 'stretch', start, end, length: resultLen };
  try {
    applyEdit(
      // Ruling 5 (F2): a span-deleting effect's default label reports
      // what it removed; an explicit caller label still wins.
      label ??
        (output.removedSpans
          ? `Effect: ${def.name} (${describeRemoval(output.removedSpans, sampleRate)})`
          : `Effect: ${def.name}`),
      docId,
      (d) => replaceRegion(d, start, end, resultChannels),
      { selection: { start, end: start + resultLen }, cursorSample: start },
      remap
    );
    onProgress?.(1);
    return 'committed';
  } catch (err) {
    // The doc may have been closed/removed while the worker was busy.
    // Surface it and settle — no edit was applied.
    reportEffectFailure(err);
    return 'refused';
  }
}
