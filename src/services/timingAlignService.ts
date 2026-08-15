/**
 * Task F9 service — turns "these markers are syllables, that is the grid" into
 * an anchor list, and runs the warp through the ordinary effect path.
 *
 * ---------------------------------------------------------------------------
 * WHY THE ANCHORS ARE MARKERS
 * ---------------------------------------------------------------------------
 * `timingWarp.ts` measured spectral-flux onset detection on the user's real
 * solo vocal: at the parameters tempo detection ships with, 44 % of the
 * reported onsets are not note attacks (breaths, note endings, portamento
 * slides, vibrato peaks), and the best voice-tuned parameterisation still
 * reaches only 0.88 precision / 0.65 recall at a ±50 ms tolerance — with the
 * threshold chosen in-sample, so even that is optimistic. A false anchor is not
 * a missed opportunity, it is active damage: it drags a syllable-sized span of
 * audio onto a beat it never belonged on, manufacturing a timing error where
 * there was none.
 *
 * So the anchors this service warps are **markers**, which the user placed or
 * accepted, and nothing else. That is F9's brief answer to its own ruling 3:
 * ship the manual mode, because it cannot mis-place a syllable the way a bad
 * detector can. Markers are the right carrier rather than a bespoke
 * anchor-editing surface because the app already has the whole loop — place,
 * name, drag, delete, undo, save into `.audm` — and reusing it means the
 * confirmation step is a real editing session with the waveform in front of the
 * user, not a checkbox list.
 *
 * {@link suggestSyllableMarkers} is the convenience on top: it runs the
 * detector and writes its proposals in AS MARKERS, as their own undo step, so
 * the user edits and deletes them with the tools they already know before
 * anything is stretched. The detector never reaches the audio directly.
 *
 * ---------------------------------------------------------------------------
 * WHY THE GRID IS CONFIRMED, NOT DETECTED
 * ---------------------------------------------------------------------------
 * On the user's material the drums read 159.83 BPM while five other sources
 * agree at ~109.4 — a ~3:2 hemiola that is a property of the music, with every
 * confidence between 0.003 and 0.084 against `CONFIDENCE_LOW = 0.35`. Picking
 * one automatically is a coin flip that makes every correction 2/3 or 1.5x
 * wrong. The subdivision matters just as much: the same 23 marked attacks sit a
 * median of 120 ms from the nearest quarter but only 25 ms from the nearest
 * sixteenth, so snapping that take to quarters would move syllables by up to
 * 260 ms. {@link buildAlignPlan} therefore reports every move it intends to
 * make, and `AlignTimingDialog` will not enable Apply until the user has ticked
 * that the grid is right.
 */

import { cloneRegion, docLength, nextId, type AudioDocument } from '../audio/AudioDocument';
import { activeRegion } from './selectionRegion';
import {
  buildWarpMap,
  detectVocalOnsets,
  subdivideBeats,
  synthesisPosAt,
  DEFAULT_ONSET_THRESHOLD,
  type TimingAnchor,
  type WarpMap,
} from '../dsp/timingWarp';
import { useAppStore, type Marker } from '../stores/appStore';
import { getBeatGrid, type BeatGrid } from './beatGrid';
import { pushMarkerUndo } from './editOps';
import { runEffectOnSelection } from './effectRunner';
import { ALIGN_TIMING_EFFECT_ID, type AlignTimingExtra } from '../effects/time/AlignTimingEffect';

/**
 * Ceiling on markers one {@link suggestSyllableMarkers} call can add, mirroring
 * `tempoService.ts`'s `MAX_BEAT_MARKERS`. A 142 s vocal yields ~260 detections,
 * so this is not a limit the normal case meets; it exists so a pathological
 * detection on noise cannot dump an unbounded list into the document.
 */
export const MAX_SYLLABLE_MARKERS = 512;

/** Longest span {@link suggestSyllableMarkers} analyses in one call. Detection
 * runs synchronously on the UI thread — the same trade `detectRegionTempo`
 * already makes — and measured 350 ms for 30 s and 1.6 s for the full 142 s
 * vocal at 48 kHz. 180 s keeps the worst case near 2 s for an explicit,
 * one-shot button press while covering a whole song. */
export const MAX_SUGGEST_SECONDS = 180;

export type AlignRefusal =
  | 'no-document'
  | 'no-grid'
  | 'no-anchors'
  | 'no-change'
  | 'region-too-short'
  /** T6-3 — the user left while the warp was running. Distinct from
   * `'no-change'`, which is what an un-plumbed cancellation used to look like
   * from outside: both leave the document untouched, but only one of them is
   * something the user did on purpose, and telling them "nothing to move at
   * this strength" for their own cancel is the app misreading the room. */
  | 'cancelled';

export interface AlignedAnchor {
  /** The marker this anchor came from. */
  markerId: string;
  markerName: string;
  /** Absolute document sample the syllable is at. */
  sourceSample: number;
  /** Absolute document sample of the grid point it will be pulled toward. */
  targetSample: number;
  /** `targetSample - sourceSample`: positive means the syllable is EARLY and
   * will be pushed later. This is the full move, before strength is applied. */
  offsetSamples: number;
}

export interface AlignPlan {
  docId: string;
  sampleRate: number;
  /** The region the effect will run over: the selection, or the whole document. */
  regionStart: number;
  regionEnd: number;
  grid: BeatGrid;
  /** Grid points after subdivision, absolute samples. */
  gridSamples: Int32Array;
  /** One row per marker inside the region, ascending by source. */
  anchors: AlignedAnchor[];
  /** Region-relative anchors, strength NOT applied — what the effect receives. */
  effectAnchors: TimingAnchor[];
  /** Markers dropped because they did not land strictly inside the region or
   * duplicated another marker's position. */
  droppedCount: number;
  /** Indices into {@link anchors} whose move the ratio bound will hold back at
   * the CURRENT strength. Non-empty means the plan will under-deliver, and the
   * dialog says so rather than letting it happen quietly. */
  clampedIndices: number[];
  /** Largest |offset| in the plan, samples — the number that betrays a wrong
   * grid or a wrong subdivision faster than any confidence score. */
  maxOffsetSamples: number;
  /** Median |offset|, samples. */
  medianOffsetSamples: number;
}

function activeDoc(): AudioDocument | null {
  const s = useAppStore.getState();
  return s.documents.find((d) => d.id === s.activeDocumentId) ?? null;
}

/**
 * The region an effect run would target: the selection clamped into the
 * document, or the whole document when there is none — the same resolve
 * `runEffectOnSelection` applies, which is what makes this the region the warp
 * will actually be handed.
 *
 * The clamp is not decoration. `setSelection` stores whatever it is handed while
 * `cloneRegion` clamps what it slices, so an out-of-bounds selection used to
 * give `buildAlignPlan` a `regionStart` the audio never started at (every
 * `effectAnchors.source` offset by the difference) and `suggestSyllableMarkers`
 * a start it wrote its proposals from, at negative samples. This function
 * claimed to mirror `runEffectOnSelection` throughout, and that claim became
 * FALSE the moment L9 made the runner resolve once — the runner clamped, this
 * did not. Fourth instance of one defect (R7's `plan.regionStart`, L1's
 * `resolveRegion`, L9's runner): resolve once, and every consumer reads that
 * pair.
 *
 * T6-1: the claim is now structural instead of documented. This and the runner
 * call the SAME function, so "the same resolve `runEffectOnSelection` applies"
 * cannot go false again the way it did last time — the only way to break it is
 * to stop calling `activeRegion`, which is a visible edit rather than a silent
 * divergence. The name stays because `buildAlignPlan`, `suggestSyllableMarkers`
 * and the test suite all read it.
 */
export function alignRegion(doc: AudioDocument): { start: number; end: number } {
  return activeRegion(doc);
}

function mixDown(channels: Float32Array[]): Float32Array {
  const n = channels[0]?.length ?? 0;
  if (channels.length === 1) return channels[0];
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (const c of channels) sum += c[i];
    out[i] = sum / channels.length;
  }
  return out;
}

/** Nearest value in an ASCENDING array, by binary search. */
function nearest(sorted: Int32Array, v: number): number {
  const n = sorted.length;
  if (n === 0) return v;
  if (v <= sorted[0]) return sorted[0];
  if (v >= sorted[n - 1]) return sorted[n - 1];
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] <= v) lo = mid;
    else hi = mid;
  }
  return v - sorted[lo] <= sorted[hi] - v ? sorted[lo] : sorted[hi];
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/**
 * Builds the full, inspectable plan: which markers move, where to, by how much,
 * and which of those moves the ratio bound will hold back.
 *
 * Pure with respect to the document — it reads the store and the (cached) beat
 * grid and allocates nothing large. `getBeatGrid` never starts an analysis, so
 * opening the dialog cannot kick off a worker.
 *
 * Returns a refusal rather than a partial plan when there is no document, no
 * cached grid, or no marker inside the region.
 */
export function buildAlignPlan(opts: {
  division: number;
  strength: number;
}): { ok: true; plan: AlignPlan } | { ok: false; reason: AlignRefusal } {
  const doc = activeDoc();
  if (!doc) return { ok: false, reason: 'no-document' };

  const grid = getBeatGrid(doc.id);
  if (!grid) return { ok: false, reason: 'no-grid' };

  const { start, end } = alignRegion(doc);
  if (end - start < 2) return { ok: false, reason: 'region-too-short' };

  // One check, not two. A `grid.beatSamples.length < 2` guard here would be
  // dead: `subdivideBeats` cannot turn one beat into two points, so the single
  // check below already catches it (mutation sweep: removing the earlier guard
  // changed nothing, which is what "redundant" means). A single beat is a
  // position, not a grid — there is no interval to snap into.
  const gridSamples = subdivideBeats(grid.beatSamples, opts.division);
  if (gridSamples.length < 2) return { ok: false, reason: 'no-grid' };

  const markers = useAppStore.getState().markers[doc.id] ?? [];
  const anchors: AlignedAnchor[] = [];
  let droppedCount = 0;
  let prevSource = start;
  for (const m of markers) {
    const pos = m.positionSample;
    // Strictly inside: a marker ON either region edge is a pinned knot, so it
    // cannot move and would only waste an anchor slot. Strictly after the
    // previous one for the same reason `buildWarpMap` requires it — two anchors
    // at one sample have no span between them to stretch.
    if (pos <= prevSource || pos >= end) {
      if (pos >= start && pos <= end) droppedCount++;
      continue;
    }
    const target = nearest(gridSamples, pos);
    anchors.push({
      markerId: m.id,
      markerName: m.name,
      sourceSample: pos,
      targetSample: target,
      offsetSamples: target - pos,
    });
    prevSource = pos;
  }

  if (anchors.length === 0) return { ok: false, reason: 'no-anchors' };

  const effectAnchors: TimingAnchor[] = anchors.map((a) => ({
    source: a.sourceSample - start,
    target: a.targetSample - start,
  }));

  // The SAME pure builder the effect will run, on the SAME inputs, so the
  // clamp count shown before Apply is the clamp count that happens.
  const map = buildWarpMap(effectAnchors, end - start, { strength: opts.strength });
  const absOffsets = anchors.map((a) => Math.abs(a.offsetSamples));

  return {
    ok: true,
    plan: {
      docId: doc.id,
      sampleRate: doc.sampleRate,
      regionStart: start,
      regionEnd: end,
      grid,
      gridSamples,
      anchors,
      effectAnchors,
      droppedCount,
      clampedIndices: map.clampedIndices,
      maxOffsetSamples: absOffsets.length ? Math.max(...absOffsets) : 0,
      medianOffsetSamples: median(absOffsets),
    },
  };
}

export interface SuggestOutcome {
  added: number;
  truncated: boolean;
  analysedSeconds: number;
}

/**
 * Runs onset detection over the target region and writes the proposals in as
 * markers, in ONE `setMarkersForDoc` write with its own undo entry (the shape
 * `addBeatMarkersAfterStretch` established — per-marker `addMarker` calls
 * re-sort and re-notify for every element).
 *
 * These are PROPOSALS. `timingWarp.ts` measures roughly one in eight of them
 * wrong even at the tuned parameters, so they are deliberately delivered into
 * the surface where the user can see them against the waveform and delete the
 * bad ones, rather than straight into a warp.
 *
 * Analysis is synchronous on the calling thread (as `detectRegionTempo`
 * already is) and capped at {@link MAX_SUGGEST_SECONDS}; the analysed span is
 * reported back so the caller can say how much of the region was covered.
 */
export function suggestSyllableMarkers(
  opts: { sensitivity?: number; maxSeconds?: number } = {}
): SuggestOutcome | null {
  const doc = activeDoc();
  if (!doc) return null;

  const { start, end } = alignRegion(doc);
  const maxSamples = Math.round((opts.maxSeconds ?? MAX_SUGGEST_SECONDS) * doc.sampleRate);
  const analyseEnd = Math.min(end, start + maxSamples);
  if (analyseEnd - start < 2) return null;

  const mono = mixDown(cloneRegion(doc, start, analyseEnd));
  const { samples } = detectVocalOnsets(mono, doc.sampleRate, {
    sensitivity: opts.sensitivity ?? DEFAULT_ONSET_THRESHOLD,
  });
  if (samples.length === 0) {
    return { added: 0, truncated: false, analysedSeconds: (analyseEnd - start) / doc.sampleRate };
  }

  const truncated = samples.length > MAX_SYLLABLE_MARKERS;
  const kept = truncated ? Array.from(samples).slice(0, MAX_SYLLABLE_MARKERS) : Array.from(samples);

  const store = useAppStore.getState();
  const before: Marker[] = store.markers[doc.id] ?? [];
  const added: Marker[] = kept.map((offset, i) => ({
    id: nextId('marker'),
    name: `Syllable ${i + 1}`,
    positionSample: start + offset,
  }));
  store.setMarkersForDoc(doc.id, [...before, ...added]);
  const after: Marker[] = useAppStore.getState().markers[doc.id] ?? [];
  pushMarkerUndo('Suggest Syllable Markers', doc.id, before, after);

  return {
    added: added.length,
    truncated,
    analysedSeconds: (analyseEnd - start) / doc.sampleRate,
  };
}

export type AlignOutcome = { ok: true; markersMoved: number } | { ok: false; reason: AlignRefusal };

/**
 * Moves every marker inside the warped region through the SAME map the samples
 * went through, as its own undo step.
 *
 * `effectRunner` cannot do this. Its marker vocabulary is `'stretch'`
 * (proportional across the region) or `'cuts'`, and proportional is only ever
 * right where the local ratio equals the region's average. Here the average is
 * exactly 1 — the warp preserves the region's length — so the proportional rule
 * degenerates to "leave every marker alone" while the syllables slide out from
 * under them. Since the markers ARE the syllable positions this feature works
 * from, that would make a second pass operate on stale anchors and would make
 * the first pass simply look broken. F2 found the same class of defect from the
 * other direction (a proportional remap scattering markers after a removed gap,
 * 19/41 correct where 10/30 was right) and fixed it the same way: map each
 * annotation through the transform the audio actually underwent.
 *
 * A separate undo entry, mirroring `tempoService`'s `Add Beat Markers`: a
 * marker write cannot ride inside `applyEdit`'s own entry, because `applyEdit`
 * has already committed its remap by the time this runs.
 *
 * Returns how many markers moved. Writes nothing (and pushes no history entry)
 * when none of them do.
 */
function remapRegionMarkers(docId: string, plan: AlignPlan, map: WarpMap): number {
  const store = useAppStore.getState();
  // Read AFTER the audio edit: `applyEdit` has already run its own (identity)
  // remap, so this list is the one on screen.
  const before: Marker[] = store.markers[docId] ?? [];
  let moved = 0;
  const after = before.map((m) => {
    if (m.positionSample < plan.regionStart || m.positionSample > plan.regionEnd) return m;
    const warped =
      plan.regionStart + Math.round(synthesisPosAt(map, m.positionSample - plan.regionStart));
    if (warped === m.positionSample) return m;
    moved++;
    return { ...m, positionSample: warped };
  });

  if (moved === 0) return 0;
  store.setMarkersForDoc(docId, after);
  pushMarkerUndo('Align Markers', docId, before, useAppStore.getState().markers[docId] ?? []);
  return moved;
}

/**
 * Runs the warp. The plan must already have been built and confirmed by the
 * caller — this function does not re-derive the grid, so what the user saw is
 * what runs.
 *
 * Success is detected the way `applyTempoChange` does it: the document's
 * channel arrays are a NEW object after a successful `applyEdit`, and unchanged
 * if the run errored (`effectRunner` shows its own dialog and applies no edit).
 * A strength that rounds to a no-op map produces identical output and is
 * reported as `'no-change'` rather than as a silent success — the channels
 * array identity does change on a pass-through apply, so this is checked
 * against the plan instead.
 *
 * T6-3 — `shouldCancel` is polled by the runner between the warped audio
 * arriving and `applyEdit` writing it. This pass commits in TWO places: the
 * audio through the runner, and the markers through `remapRegionMarkers`
 * afterwards. Both are governed by the one answer, and they cannot come apart,
 * because everything from the runner's check to the marker write is one
 * synchronous block — there is no second await for a walk-away to land in.
 * Shaped like `runCoverJourney`'s `shouldCancel`, which is the same question
 * asked between stages rather than between the run and its commit.
 */
export async function applyTimingAlignment(
  req: { plan: AlignPlan; strength: number; shouldCancel?: () => boolean },
  onProgress?: (fraction: number) => void
): Promise<AlignOutcome> {
  const doc = activeDoc();
  if (!doc) return { ok: false, reason: 'no-document' };

  const { plan, strength, shouldCancel } = req;
  const map = buildWarpMap(plan.effectAnchors, plan.regionEnd - plan.regionStart, { strength });
  if (map.identity) return { ok: false, reason: 'no-change' };

  const extra: AlignTimingExtra = { anchors: plan.effectAnchors };
  const outcome = await runEffectOnSelection(
    ALIGN_TIMING_EFFECT_ID,
    { strengthPercent: strength * 100 },
    { onProgress, extra, label: 'Align Vocal Timing', shouldCancel }
  );
  // Before the success gate, not after it: a cancelled run leaves the channels
  // untouched, so the gate below would read it as `'no-change'` and tell the
  // user their own cancel was a strength that moved nothing.
  if (outcome === 'cancelled') return { ok: false, reason: 'cancelled' };

  const postDoc = useAppStore.getState().documents.find((d) => d.id === doc.id);
  if (!postDoc || postDoc.channels === doc.channels) return { ok: false, reason: 'no-change' };
  return { ok: true, markersMoved: remapRegionMarkers(doc.id, plan, map) };
}
