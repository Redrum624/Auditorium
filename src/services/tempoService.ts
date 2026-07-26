/**
 * Feature 2 service (Task T7): change a document's BPM without changing its
 * pitch. REUSE, NOT REBUILD — the DSP itself is `timeStretchLinked`
 * (`../dsp/wsola.ts`): pitch-preserving, stereo-linked WSOLA with ONE shared
 * similarity search on the mid signal (so stereo phase stays locked) and
 * `outLen = round(N*ratio)` exactly. It is already wrapped as the
 * 'time-stretch' effect and therefore already reachable off-thread — with
 * the one-shot DSP worker, throttled progress, cancellation-safe error
 * handling and the single `applyEdit` undo path — through
 * `runEffectOnSelection` (`./effectRunner.ts`). This module is a RATIO
 * CALCULATOR plus guards on top of that existing path; it does not touch
 * the DSP.
 *
 * `tempoRatio(sourceBpm, targetBpm) = sourceBpm/targetBpm` is exactly the
 * output/input length ratio `timeStretchLinked` expects: a slower target
 * (lower BPM) makes `ratio > 1` (longer output), a faster target makes
 * `ratio < 1` (shorter output).
 *
 * `checkTempoChange` refuses a ratio outside `[MIN_RATIO, MAX_RATIO]`
 * (`wsola.ts`) rather than letting `planStretch` silently clamp it — a
 * clamped stretch would hand back audio at a DIFFERENT ratio than the one
 * requested, with nothing to signal the mismatch.
 *
 * QUALITY BANDS (surfaced verbatim by the UI, T8): +/-12% (ratio 0.88-1.14)
 * transparent; 0.5-2x good with mild transient smearing; 0.25-0.5x / 2-4x
 * extreme with audible artifacts; outside `[0.25, 4]` blocked entirely.
 * Justification: this WSOLA has 40ms analysis/synthesis frames, a 20ms
 * synthesis hop and a +/-10ms similarity search (`wsola.ts`), with NO
 * crossfade into the surrounding, un-stretched audio and NO transient
 * detection — so a selection-scoped stretch always produces a seam at both
 * edges of the region, and at the larger ratios many synthesis frames reuse
 * near-identical spans (flanging on sustained tones). Documented limitation
 * of the underlying DSP, not something this service can hide or fix.
 *
 * Optional beat markers are laid down as a SECOND, separately-labelled undo
 * step (`pushMarkerUndo`) AFTER the stretch resolves — `applyEdit`'s marker
 * remap (`editOps.ts`) can only transform EXISTING markers, never invent new
 * ones, so seeding a beat grid cannot ride inside the stretch's own entry.
 */

import type { AudioDocument } from '../audio/AudioDocument';
import { cloneRegion, docLength, mixDown } from '../audio/AudioDocument';
import type { Marker } from '../stores/appStore';
import { nextId, useAppStore } from '../stores/appStore';
import { analyzeTempo } from '../dsp/tempoCore';
import { MIN_RATIO, MAX_RATIO } from '../dsp/wsola';
import { runEffectOnSelection } from './effectRunner';
import { pushMarkerUndo } from './editOps';

/** Why `checkTempoChange`/`applyTempoChange` refused to run. */
export type TempoRefusal = 'no-document' | 'invalid-bpm' | 'no-op' | 'out-of-range';

export interface TempoChangeRequest {
  sourceBpm: number;
  targetBpm: number;
}

export interface ApplyTempoChangeRequest extends TempoChangeRequest {
  /** When true, and `firstBeatSample` is known, lays down a beat grid over
   * the stretched region as a second, separately-labelled undo step. */
  addBeatMarkers?: boolean;
  /** Sample position (PRE-stretch, in the same coordinates as the resolved
   * region) of the first beat inside the region — typically the detected
   * grid's first in-region beat. `null`/`undefined` skips beat-marker
   * creation even when `addBeatMarkers` is true. */
  firstBeatSample?: number | null;
}

export type TempoCheckResult = { ok: true; ratio: number } | { ok: false; reason: TempoRefusal };

export interface TempoChangeOutcome {
  ok: boolean;
  reason?: TempoRefusal;
}

export interface RegionTempoDetection {
  bpm: number | null;
  confidence: number;
}

/** Longest excerpt `detectRegionTempo` analyzes, regardless of selection size. */
const MAX_DETECT_SECONDS = 30;

/** Ceiling on beat markers a single `applyTempoChange` call can add — past
 * this the list is truncated and one info dialog is shown instead of
 * silently generating an unbounded marker list. */
export const MAX_BEAT_MARKERS = 512;

function activeDoc(): AudioDocument | null {
  const s = useAppStore.getState();
  return s.documents.find((d) => d.id === s.activeDocumentId) ?? null;
}

/** `sourceBpm/targetBpm` — the output/input length ratio `timeStretchLinked`
 * expects (a slower target makes the result longer: ratio > 1). */
export function tempoRatio(sourceBpm: number, targetBpm: number): number {
  return sourceBpm / targetBpm;
}

/**
 * Guards, evaluated in order: no active document -> 'no-document'; either
 * bpm non-finite or <= 0 -> 'invalid-bpm'; the resulting ratio within 1e-6
 * of 1.0 -> 'no-op' (never push an empty undo entry for an identical
 * tempo); ratio outside `[MIN_RATIO, MAX_RATIO]` (`wsola.ts`) ->
 * 'out-of-range' — refusing rather than relying on `planStretch`'s own
 * silent clamp, which would otherwise hand back a duration that doesn't
 * match the requested tempo.
 */
export function checkTempoChange(req: TempoChangeRequest): TempoCheckResult {
  if (!activeDoc()) return { ok: false, reason: 'no-document' };

  const { sourceBpm, targetBpm } = req;
  if (!Number.isFinite(sourceBpm) || sourceBpm <= 0 || !Number.isFinite(targetBpm) || targetBpm <= 0) {
    return { ok: false, reason: 'invalid-bpm' };
  }

  const ratio = tempoRatio(sourceBpm, targetBpm);
  if (Math.abs(ratio - 1) < 1e-6) return { ok: false, reason: 'no-op' };
  if (ratio < MIN_RATIO || ratio > MAX_RATIO) return { ok: false, reason: 'out-of-range' };

  return { ok: true, ratio };
}

/**
 * Candidate beat-marker positions inside the POST-stretch region:
 * `newFirstBeat + round(i*spacing)` while `< start + round((end-start)*ratio)`,
 * each clamped to `[0, newLen]`, capped at `MAX_BEAT_MARKERS`. Returns the
 * capped list and whether the true (uncapped) count would have exceeded it.
 */
function computeBeatMarkerPositions(
  start: number,
  end: number,
  ratio: number,
  targetBpm: number,
  sampleRate: number,
  firstBeatSample: number,
  newLen: number
): { positions: number[]; truncated: boolean } {
  const newFirstBeat = start + Math.round((firstBeatSample - start) * ratio);
  const spacing = (60 / targetBpm) * sampleRate;
  const regionEnd = start + Math.round((end - start) * ratio);

  const positions: number[] = [];
  let truncated = false;
  for (let i = 0; ; i++) {
    const pos = newFirstBeat + Math.round(i * spacing);
    if (pos >= regionEnd) break;
    if (positions.length >= MAX_BEAT_MARKERS) {
      truncated = true;
      break;
    }
    positions.push(Math.max(0, Math.min(newLen, pos)));
  }
  return { positions, truncated };
}

/** Lays down the beat grid as a SECOND, separately-labelled undo step (see
 * the module doc comment for why this cannot ride inside the stretch's own
 * `applyEdit` entry). No-ops (no undo entry, no dialog) when the region
 * yields zero beat positions. */
function addBeatMarkersAfterStretch(
  docId: string,
  start: number,
  end: number,
  ratio: number,
  targetBpm: number,
  sampleRate: number,
  firstBeatSample: number
): void {
  const newDoc = useAppStore.getState().documents.find((d) => d.id === docId);
  if (!newDoc) return; // document closed while the stretch was running

  const { positions, truncated } = computeBeatMarkerPositions(
    start,
    end,
    ratio,
    targetBpm,
    sampleRate,
    firstBeatSample,
    docLength(newDoc)
  );
  if (positions.length === 0) return;

  const store = useAppStore.getState();
  const before: Marker[] = store.markers[docId] ?? [];
  for (let i = 0; i < positions.length; i++) {
    store.addMarker(docId, { id: nextId('marker'), name: `Beat ${i + 1}`, positionSample: positions[i] });
  }
  const after: Marker[] = useAppStore.getState().markers[docId] ?? [];
  pushMarkerUndo('Add Beat Markers', docId, before, after);

  if (truncated) {
    void window.electronAPI?.showMessageBox({
      type: 'info',
      title: 'Beat Markers',
      message: `Only the first ${MAX_BEAT_MARKERS} beat markers were added — the stretched region contains more beats than that.`,
    });
  }
}

/**
 * Runs `checkTempoChange`'s guards, then — if they pass — snapshots the
 * target region (selection, or the whole document, resolved exactly like
 * `runEffectOnSelection` resolves it) from LIVE state in the SAME tick, and
 * runs the existing 'time-stretch' effect over it. That single call yields,
 * for free: the one-shot DSP worker, transferred buffers, throttled
 * progress, always-settling error handling, and the undoable commit through
 * `applyEdit` with a `{type:'stretch'}` marker remap — the region is
 * TRANSFORMED, not replaced, so interior markers ride the stretch
 * proportionally (the M3 fix-round-2 ruling; `'replace'` would drop every
 * interior marker). The History label reads `Effect: Time Stretch`
 * (hardcoded at `effectRunner.ts:68`) — accepted, not worked around.
 */
export async function applyTempoChange(
  req: ApplyTempoChangeRequest,
  onProgress?: (fraction: number) => void
): Promise<TempoChangeOutcome> {
  const check = checkTempoChange(req);
  if (!check.ok) return { ok: false, reason: check.reason };
  const { ratio } = check;

  const doc = activeDoc();
  if (!doc) return { ok: false, reason: 'no-document' };
  const docId = doc.id;
  const sampleRate = doc.sampleRate;
  const selection = useAppStore.getState().selection;
  const start = selection ? selection.start : 0;
  const end = selection ? selection.end : docLength(doc);

  await runEffectOnSelection('time-stretch', { stretchPercent: ratio * 100 }, onProgress);

  if (req.addBeatMarkers && req.firstBeatSample != null) {
    addBeatMarkersAfterStretch(docId, start, end, ratio, req.targetBpm, sampleRate, req.firstBeatSample);
  }

  return { ok: true };
}

/** The centred excerpt `detectRegionTempo` analyzes: the whole resolved
 * region when it is already `<= MAX_DETECT_SECONDS`, otherwise a centred
 * sub-window of that length clamped inside the region's own bounds. */
function centeredExcerpt(start: number, end: number, sampleRate: number): { start: number; end: number } {
  const maxLen = Math.round(MAX_DETECT_SECONDS * sampleRate);
  const regionLen = end - start;
  if (regionLen <= maxLen) return { start, end };

  const center = start + regionLen / 2;
  let s = Math.round(center - maxLen / 2);
  let e = s + maxLen;
  if (s < start) {
    s = start;
    e = s + maxLen;
  }
  if (e > end) {
    e = end;
    s = e - maxLen;
  }
  return { start: s, end: e };
}

/**
 * The 'Re-detect from selection' path: resolves the region exactly like
 * `runEffectOnSelection` does (selection ?? whole document), mixes down a
 * CENTRED excerpt capped at `MAX_DETECT_SECONDS`, and calls the pure
 * `analyzeTempo` core SYNCHRONOUSLY on the main thread — the same order of
 * cost as `captureNoiseProfile`'s synchronous STFT over an arbitrary
 * selection (`noiseProfile.ts`). Deliberately UNCACHED: writing to
 * `tempoAnalysis.ts`'s shared cache here would key it on an arbitrary region
 * instead of the whole-document analysis features 1 and 3 need.
 */
export function detectRegionTempo(): RegionTempoDetection | null {
  const doc = activeDoc();
  if (!doc) return null;

  const selection = useAppStore.getState().selection;
  const start = selection ? selection.start : 0;
  const end = selection ? selection.end : docLength(doc);
  const excerpt = centeredExcerpt(start, end, doc.sampleRate);

  const mono = mixDown(cloneRegion(doc, excerpt.start, excerpt.end));
  const result = analyzeTempo(mono, doc.sampleRate);
  return { bpm: result.bpm, confidence: result.confidence };
}
