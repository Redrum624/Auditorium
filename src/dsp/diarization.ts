/**
 * Speaker diarization — the renderer half of Separate Speakers (D1, D3).
 *
 * The utility-process host (`electron/diarizeHost.cjs`, D2) runs
 * pyannote-segmentation-3.0 over 10 s windows and embeds each (window, local
 * speaker) fragment with WeSpeaker ResNet34-LM. Everything AFTER the models —
 * clustering the fragment embeddings, voting per frame, turning frames into
 * segments — is plain maths and lives here, pure and tested, so the policy the
 * sweep measured is pinned by unit tests rather than by a model run.
 *
 * Ported from sherpa-onnx `python-api-examples/speaker-diarization-onnx.py`
 * (Apache-2.0 © 2024 Xiaomi Corp.), the reference recipe D1 names; the
 * measured semantics are the plan's `diarcore.cjs` / `sweep.cjs` scripts.
 * `foldSmallClusters` ports pyannote-audio's `min_cluster_size` rule
 * (`pipelines/clustering.py`, MIT) — with the plan's fixed size, see below.
 *
 * Numbers: every constant here is either model metadata (the segmentation
 * model's `custom_metadata_map`) or a value the sweep measured on the four
 * test recordings (design-notes "Sweep result"). None is tuned in place — a
 * re-tune is a new bench run (Task 7).
 *
 * Pure: no DOM, no Electron, no audio I/O.
 */

import { MAX_SPEAKERS, clusterSpeakers, cosineSimilarity, l2Normalize } from './speakerClustering';

export { MAX_SPEAKERS };

// ------------------------------------------------------------ model geometry

/** Model rate: pyannote-segmentation-3.0 metadata `sample_rate`. */
export const MODEL_SAMPLE_RATE = 16000;
/** Metadata `window_size`: 10 s at 16 kHz. */
export const SEG_WINDOW = 160000;
/** The reference's `window_shift = int(0.1 · window_size)`: 1 s. */
export const SEG_SHIFT = 16000;
/** Output frames per window — verified `y` shape [N, 589, 7] in the app's ORT. */
export const SEG_FRAMES = 589;
/** Metadata `receptive_field_size`, in samples. */
export const RECEPTIVE_FIELD = 991;
/** Metadata `receptive_field_shift`: 270 samples = 16.875 ms per frame. */
export const FRAME_SHIFT = 270;
/** Metadata `num_speakers`: local speaker slots per window. */
export const LOCAL_SPEAKERS = 3;
/**
 * Metadata `num_classes` 7 with `powerset_max_classes` 2: class → active local
 * speakers. Row order is the reference's `get_powerset_mapping` (none, the
 * three singles, then the three pairs) — overlap IS modelled.
 */
export const POWERSET: readonly (readonly number[])[] = [[], [0], [1], [2], [0, 1], [0, 2], [1, 2]];

// ------------------------------------------------------- assembly constants

/**
 * A local speaker is embedded only with at least this many active frames in
 * its window — the reference's `frames.sum() < 10 → skip` (≈ 0.17 s of speech;
 * shorter fragments give the embedder too little to work on).
 */
export const MIN_EMBED_FRAMES = 10;
/** Reference `onset` / `offset` on the 0/1 final assignment. */
export const ONSET = 0.5;
export const OFFSET = 0.5;
/** Reference `min_duration_on`: segments shorter than this are dropped. */
export const MIN_ON_S = 0.3;
/** Reference `min_duration_off`: same-speaker segments this close merge. */
export const MIN_OFF_S = 0.5;

// -------------------------------------------------------- clustering policy

/**
 * Average-linkage cut on cosine DISTANCE (1 − cos). MEASURED: the sweep's 4/4
 * plateau on the four recordings is t ∈ [0.50, 0.60] (3/4 over 0.35–0.80)
 * with the ResNet34-LM + CMN embedder; 0.55 is the plateau centre, chosen for
 * width, not for a single lucky cell (design-notes "Sweep result").
 */
export const DIARIZE_THRESHOLD = 0.55;
/**
 * Clusters with fewer fragments than this fold into the nearest large cluster.
 * MEASURED: m = 4 in the sweep's grid {1, 4, 8, 12}; m ≥ 8 collapsed the
 * 14-fragment 16 s file (every cluster "small"). FIXED — pyannote's
 * `min(m, round(0.1·n))` cap is deliberately NOT applied: on that 16 s file it
 * would give m = 1 and disable folding altogether (D3).
 */
export const MIN_CLUSTER_SIZE = 4;
/**
 * A cluster is an output speaker only with at least this share of the
 * ASSEMBLED speech time — the sweep scored "output speakers" this way, and the
 * spike showed forced k leaving 0 s / 0.74 s clusters on the Mandarin file.
 */
export const MIN_SPEAKER_SHARE = 0.05;

// ----------------------------------------------------------------- types

export interface DiarizationEmbedding {
  windowIndex: number;
  /** 0..LOCAL_SPEAKERS−1 */
  localSpeaker: number;
  /** Active frames of that local speaker in its window (≥ MIN_EMBED_FRAMES). */
  activeFrames: number;
  /** L2-normalised embedding (256-d from the host; any length ≥ 1 here). */
  vector: Float32Array;
}

/** What the host produced for one run — everything the assembly needs, so a
 * re-cluster at a different speaker count never re-runs a model (D3). */
export interface DiarizationEvidence {
  /** Length of the 16 kHz mono signal the host windowed. */
  totalSamples16k: number;
  /** One `Uint8Array(SEG_FRAMES)` per window; each byte is the argmax class 0..6. */
  windows: Uint8Array[];
  embeddings: DiarizationEmbedding[];
}

export interface DiarizationSegment {
  /**
   * 16 kHz positions at frame centres: `frame·270 + 991/2` (D3), so they end
   * in .5 — half-sample precision, rounded only when mapped to a document by
   * `segmentsToDocSamples`. The closing segment of a run that reaches the end
   * of the assembled range may exceed `totalSamples16k` by under half a
   * receptive field, as in the reference; the document mapping clamps.
   */
  startSample16k: number;
  endSample16k: number;
  /** Output speaker, numbered by first appearance in time. */
  speaker: number;
}

export interface OverlapSegment {
  startSample16k: number;
  endSample16k: number;
  /** Two or more output speakers active together, ascending. */
  speakers: number[];
}

export interface Diarization {
  /** Output speakers — clusters that ended up with at least one segment. */
  speakerCount: number;
  /** Clusters straight out of the threshold cut (auto) — the forced count in forced mode. */
  preFoldClusterCount: number;
  /** Clusters after `foldSmallClusters` — the sweep's "raw"; the forced count in forced mode. */
  rawClusterCount: number;
  segments: DiarizationSegment[];
  overlapSegments: OverlapSegment[];
  /** Per output speaker, seconds of assembled speech. */
  speechSeconds: number[];
}

export interface AssembleOptions {
  /** Forced speaker count (the review select). Omit for the measured auto policy. */
  speakerCount?: number;
}

export interface FrameSpan {
  startFrame: number;
  endFrame: number;
}

/** A half-open span in 16 kHz samples. */
export interface SampleSpan16k {
  start: number;
  end: number;
}

// ------------------------------------------------------- window arithmetic

/** The reference's `has_last_chunk`: audio shorter than a window, or not
 * ending on a shift boundary, gets a zero-padded final window. */
export function hasPaddedLastWindow(totalSamples16k: number): boolean {
  return totalSamples16k < SEG_WINDOW || (totalSamples16k - SEG_WINDOW) % SEG_SHIFT > 0;
}

/** Windows the host produces for `totalSamples16k`: the full ones plus the padded tail. */
export function expectedWindowCount(totalSamples16k: number): number {
  const full = totalSamples16k >= SEG_WINDOW ? Math.floor((totalSamples16k - SEG_WINDOW) / SEG_SHIFT) + 1 : 0;
  return full + (hasPaddedLastWindow(totalSamples16k) ? 1 : 0);
}

/** First global frame of window `i`: the reference's `int(i·shift/rf_shift + 0.5)`. */
export function windowStartFrame(windowIndex: number): number {
  return Math.trunc((windowIndex * SEG_SHIFT) / FRAME_SHIFT + 0.5);
}

/** Global frame count the reference allocates for `windowCount` windows:
 * `int((window + (W−1)·shift) / rf_shift) + 1`. Zero windows → zero frames. */
export function totalFrameCount(windowCount: number): number {
  if (windowCount <= 0) return 0;
  return Math.trunc((SEG_WINDOW + (windowCount - 1) * SEG_SHIFT) / FRAME_SHIFT) + 1;
}

/**
 * Frames the assembly keeps: with a padded last window the reference cuts at
 * `int(audio / rf_shift)` so the padding never becomes speech; an exact fit
 * keeps the full count (its last few frames are covered by no window and stay
 * silent).
 */
export function assembledFrameCount(totalSamples16k: number, windowCount: number): number {
  const frames = totalFrameCount(windowCount);
  if (!hasPaddedLastWindow(totalSamples16k)) return frames;
  return Math.min(frames, Math.trunc(totalSamples16k / FRAME_SHIFT));
}

/** Frame → 16 kHz sample at the receptive-field centre: `frame·270 + 991/2` (D3). */
export function frameToSample16k(frame: number): number {
  return frame * FRAME_SHIFT + RECEPTIVE_FIELD / 2;
}

/**
 * Sample range of a fragment run inside window `windowIndex`: the reference's
 * `int(frame / num_frames · window_size) + sample_offset`, in that operation
 * order so the truncation is bit-identical to the measured fragments. The
 * host rebuilds fragment audio from the job buffer with this (D2).
 */
export function fragmentSampleRange(windowIndex: number, startFrame: number, endFrame: number): SampleSpan16k {
  const offset = windowIndex * SEG_SHIFT;
  return {
    start: Math.trunc((startFrame / SEG_FRAMES) * SEG_WINDOW) + offset,
    end: Math.trunc((endFrame / SEG_FRAMES) * SEG_WINDOW) + offset,
  };
}

// ------------------------------------------------------- powerset and spans

function checkWindow(classes: Uint8Array, where: string): void {
  if (classes.length !== SEG_FRAMES) {
    throw new RangeError(`${where}: a window has ${classes.length} frames, expected ${SEG_FRAMES}`);
  }
  for (let f = 0; f < SEG_FRAMES; f++) {
    if (classes[f] >= POWERSET.length) {
      throw new RangeError(`${where}: frame ${f} carries class ${classes[f]}, outside the ${POWERSET.length} powerset classes`);
    }
  }
}

/**
 * Class bytes → the reference's multi-label `[F, num_speakers]` (flat,
 * `frame·3 + local`), 1 where that local speaker is active. Throws on a
 * malformed window rather than assembling silence out of corrupt bytes.
 */
export function powersetToLocal(classes: Uint8Array): Uint8Array {
  checkWindow(classes, 'powersetToLocal');
  const out = new Uint8Array(SEG_FRAMES * LOCAL_SPEAKERS);
  for (let f = 0; f < SEG_FRAMES; f++) {
    for (const local of POWERSET[classes[f]]) out[f * LOCAL_SPEAKERS + local] = 1;
  }
  return out;
}

/**
 * Half-open frame spans where `localSpeaker` is active in the window, with the
 * reference's tail rule: a run still open after the last frame closes at F−1
 * (its `k` is `num_frames` after the loop and it uses `k − 1`), so a run that
 * reaches the window's end loses its last frame in the fragment audio — the
 * measured fragments were built that way, and the host must match them (D1).
 * A run consisting of the last frame alone is therefore empty and dropped.
 */
export function localSpeakerSpans(classes: Uint8Array, localSpeaker: number): FrameSpan[] {
  checkWindow(classes, 'localSpeakerSpans');
  const spans: FrameSpan[] = [];
  let start = -1;
  for (let k = 0; k < SEG_FRAMES; k++) {
    if (POWERSET[classes[k]].includes(localSpeaker)) {
      if (start < 0) start = k;
    } else if (start >= 0) {
      spans.push({ startFrame: start, endFrame: k });
      start = -1;
    }
  }
  if (start >= 0 && start < SEG_FRAMES - 1) spans.push({ startFrame: start, endFrame: SEG_FRAMES - 1 });
  return spans;
}

export interface EmbeddableFragment {
  localSpeaker: number;
  /** Every active frame, the tail frame included — the reference's `frames.sum()`. */
  activeFrames: number;
  spans: FrameSpan[];
}

/** The local speakers of a window the host embeds: those with at least
 * MIN_EMBED_FRAMES active frames, with the spans whose audio is concatenated. */
export function embeddableFragments(classes: Uint8Array): EmbeddableFragment[] {
  checkWindow(classes, 'embeddableFragments');
  const out: EmbeddableFragment[] = [];
  for (let local = 0; local < LOCAL_SPEAKERS; local++) {
    let activeFrames = 0;
    for (let f = 0; f < SEG_FRAMES; f++) if (POWERSET[classes[f]].includes(local)) activeFrames++;
    if (activeFrames < MIN_EMBED_FRAMES) continue;
    out.push({ localSpeaker: local, activeFrames, spans: localSpeakerSpans(classes, local) });
  }
  return out;
}

/**
 * The reference's `speaker_count`: per global frame, the number of active
 * local speakers averaged over every window covering that frame, rounded half
 * up (`int(mean + 0.5)`). Length is `totalFrameCount(windows.length)` — the
 * assembly truncates, not this.
 */
export function speakerCountPerFrame(windows: readonly Uint8Array[]): Uint8Array {
  const frames = totalFrameCount(windows.length);
  const sum = new Float64Array(frames);
  const cover = new Float64Array(frames);
  for (let i = 0; i < windows.length; i++) {
    const classes = windows[i];
    checkWindow(classes, `speakerCountPerFrame window ${i}`);
    const start = windowStartFrame(i);
    for (let f = 0; f < SEG_FRAMES; f++) {
      sum[start + f] += POWERSET[classes[f]].length;
      cover[start + f] += 1;
    }
  }
  const out = new Uint8Array(frames);
  for (let g = 0; g < frames; g++) out[g] = Math.trunc(sum[g] / Math.max(cover[g], 1e-12) + 0.5);
  return out;
}

// ---------------------------------------------------------------- clustering

function relabelByFirstAppearance(raw: readonly number[]): number[] {
  const remap = new Map<number, number>();
  const out = new Array<number>(raw.length);
  for (let i = 0; i < raw.length; i++) {
    let mapped = remap.get(raw[i]);
    if (mapped === undefined) {
      mapped = remap.size;
      remap.set(raw[i], mapped);
    }
    out[i] = mapped;
  }
  return out;
}

function distinctCount(labels: readonly number[]): number {
  return new Set(labels).size;
}

function dotUnit(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

/**
 * Cosine distance `1 − cos` as the clustering computes it: both operands
 * L2-normalised first (float32), then a double dot product. Exposed so a test
 * can place a fixture exactly ON the threshold with the same arithmetic.
 */
export function cosineDistance(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) throw new Error(`cosineDistance: length mismatch (${a.length} vs ${b.length})`);
  return 1 - dotUnit(l2Normalize(a), l2Normalize(b));
}

export interface AgglomerateResult {
  /** One cluster per vector, numbered by first appearance. */
  labels: number[];
  clusterCount: number;
}

/**
 * Average-linkage agglomerative clustering on cosine distance, cut at a
 * threshold: merges while the smallest inter-cluster linkage is `<= threshold`
 * (the sweep's `cutThreshold` keeps merges with `h <= t`). This is the
 * measured auto policy (D3, sweep P2-average).
 *
 * Linkage is kept exact by the Lance–Williams recurrence for UPGMA,
 *   D(I∪J, K) = (nI·D(I,K) + nJ·D(J,K)) / (nI + nJ),
 * on a full distance matrix. Ties break on the lowest index pair, so the
 * result is deterministic and equals the sweep's compacted-scan order (the
 * surviving cluster keeps the lower id, which is its smallest member).
 *
 * Cost: a per-cluster nearest-neighbour cache makes each merge O(n) plus a
 * rescan only for clusters whose neighbour was consumed — the average of two
 * distances can never undercut a third cluster's current nearest, so nobody
 * else's cache goes stale. The full O(n²·dim) matrix is the floor; at the
 * 15-minute cap (~1,300 fragments × 256 dims, 216 M multiply-adds) it is
 * memory-bound in V8, so it is built four rows at a time — each element of
 * row i is loaded once per four pairs — which measured 225 ms against 360 ms
 * for the plain double loop (scratch bench, this machine). Each pair still
 * accumulates over k in order, so a distance here is bit-identical to
 * {@link cosineDistance} on the same two vectors.
 */
export function agglomerateAverage(vectors: readonly Float32Array[], options: { threshold: number }): AgglomerateResult {
  const n = vectors.length;
  if (n === 0) return { labels: [], clusterCount: 0 };
  if (n === 1) return { labels: [0], clusterCount: 1 };
  const { threshold } = options;

  const dim = vectors[0].length;
  // float32-rounded unit vectors widened to doubles: the values dotUnit reads
  const rows = vectors.map((v, i) => {
    if (v.length !== dim) throw new Error(`agglomerateAverage: vector ${i} has ${v.length} dims, expected ${dim}`);
    return Float64Array.from(l2Normalize(v));
  });

  const d = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    const ui = rows[i];
    let j = i + 1;
    for (; j + 3 < n; j += 4) {
      const r0 = rows[j];
      const r1 = rows[j + 1];
      const r2 = rows[j + 2];
      const r3 = rows[j + 3];
      let s0 = 0;
      let s1 = 0;
      let s2 = 0;
      let s3 = 0;
      for (let k = 0; k < dim; k++) {
        const u = ui[k];
        s0 += u * r0[k];
        s1 += u * r1[k];
        s2 += u * r2[k];
        s3 += u * r3[k];
      }
      d[i * n + j] = 1 - s0;
      d[j * n + i] = 1 - s0;
      d[i * n + j + 1] = 1 - s1;
      d[(j + 1) * n + i] = 1 - s1;
      d[i * n + j + 2] = 1 - s2;
      d[(j + 2) * n + i] = 1 - s2;
      d[i * n + j + 3] = 1 - s3;
      d[(j + 3) * n + i] = 1 - s3;
    }
    for (; j < n; j++) {
      const rj = rows[j];
      let s = 0;
      for (let k = 0; k < dim; k++) s += ui[k] * rj[k];
      d[i * n + j] = 1 - s;
      d[j * n + i] = 1 - s;
    }
  }

  const active = new Uint8Array(n).fill(1);
  const size = new Float64Array(n).fill(1);
  const members: number[][] = vectors.map((_, i) => [i]);
  const nn = new Int32Array(n).fill(-1);
  const nnDist = new Float64Array(n).fill(Infinity);
  const refreshNn = (i: number): void => {
    let best = -1;
    let bestDist = Infinity;
    for (let j = 0; j < n; j++) {
      if (j === i || !active[j]) continue;
      const dist = d[i * n + j];
      if (dist < bestDist) {
        bestDist = dist;
        best = j;
      }
    }
    nn[i] = best;
    nnDist[i] = bestDist;
  };
  for (let i = 0; i < n; i++) refreshNn(i);

  let clusters = n;
  while (clusters > 1) {
    let a = -1;
    let b = -1;
    let best = Infinity;
    for (let i = 0; i < n; i++) {
      if (!active[i] || nn[i] < 0) continue;
      if (nnDist[i] < best) {
        best = nnDist[i];
        a = i;
        b = nn[i];
      }
    }
    if (a < 0 || b < 0 || !(best <= threshold)) break;
    if (b < a) {
      const swap = a;
      a = b;
      b = swap;
    }

    const nA = size[a];
    const nB = size[b];
    for (let m = 0; m < n; m++) {
      if (m === a || m === b || !active[m]) continue;
      const updated = (nA * d[a * n + m] + nB * d[b * n + m]) / (nA + nB);
      d[a * n + m] = updated;
      d[m * n + a] = updated;
    }
    members[a] = members[a].concat(members[b]);
    members[b] = [];
    size[a] = nA + nB;
    active[b] = 0;
    clusters--;

    refreshNn(a);
    for (let i = 0; i < n; i++) {
      if (!active[i] || i === a) continue;
      if (nn[i] === a || nn[i] === b) refreshNn(i);
    }
  }

  const raw = new Array<number>(n).fill(0);
  for (let c = 0; c < n; c++) {
    if (!active[c]) continue;
    for (const point of members[c]) raw[point] = c;
  }
  const labels = relabelByFirstAppearance(raw);
  return { labels, clusterCount: clusters };
}

function centroidOf(vectors: readonly Float32Array[], indices: readonly number[]): Float32Array {
  const dim = vectors[indices[0]].length;
  const acc = new Float64Array(dim);
  for (const i of indices) {
    const v = vectors[i];
    for (let k = 0; k < dim; k++) acc[k] += v[k];
  }
  const out = new Float32Array(dim);
  for (let k = 0; k < dim; k++) out[k] = acc[k] / indices.length;
  return out;
}

/**
 * pyannote-audio's `min_cluster_size` rule: every cluster with fewer than
 * `minClusterSize` members is re-assigned — WHOLE, by its centroid — to the
 * large cluster whose centroid is nearest in cosine. When no cluster is large
 * the largest stands in for the large set, so everything folds into it.
 *
 * Whole-cluster folding is pyannote's; the sweep folded member by member and
 * the two were measured to give identical partitions at t ∈ {0.475, 0.50,
 * 0.55, 0.60, 0.625} on the recordings, bar one ARI-0.917 case with the same
 * output (design-notes). The size is FIXED (D3) — no 10 %-of-n cap.
 *
 * Returns labels renumbered by first appearance; `minClusterSize <= 1` folds
 * nothing.
 */
export function foldSmallClusters(
  labels: readonly number[],
  vectors: readonly Float32Array[],
  options: { minClusterSize: number }
): number[] {
  if (labels.length !== vectors.length) {
    throw new Error(`foldSmallClusters: ${labels.length} labels but ${vectors.length} vectors`);
  }
  const n = labels.length;
  if (n === 0) return [];
  const { minClusterSize } = options;
  if (minClusterSize <= 1) return relabelByFirstAppearance(labels);

  const groups = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const bucket = groups.get(labels[i]);
    if (bucket) bucket.push(i);
    else groups.set(labels[i], [i]);
  }
  const ids = [...groups.keys()].sort((a, b) => a - b);
  let large = ids.filter((id) => (groups.get(id) as number[]).length >= minClusterSize);
  if (large.length === ids.length) return relabelByFirstAppearance(labels);
  if (large.length === 0) {
    let largest = ids[0];
    for (const id of ids) {
      if ((groups.get(id) as number[]).length > (groups.get(largest) as number[]).length) largest = id;
    }
    large = [largest];
  }

  const largeCentroids = large.map((id) => centroidOf(vectors, groups.get(id) as number[]));
  const target = new Map<number, number>();
  for (const id of ids) {
    if (large.includes(id)) {
      target.set(id, id);
      continue;
    }
    const centroid = centroidOf(vectors, groups.get(id) as number[]);
    let best = large[0];
    let bestSim = -Infinity;
    for (let k = 0; k < large.length; k++) {
      const sim = cosineSimilarity(centroid, largeCentroids[k]);
      if (sim > bestSim) {
        bestSim = sim;
        best = large[k];
      }
    }
    target.set(id, best);
  }
  return relabelByFirstAppearance(labels.map((l) => target.get(l) as number));
}

// ------------------------------------------------------------ the assembly

/** `MIN_OFF_S` and `MIN_ON_S` in 16 kHz samples — both exact integers (8,000 and 4,800). */
const MIN_OFF_SAMPLES = MIN_OFF_S * MODEL_SAMPLE_RATE;
const MIN_ON_SAMPLES = MIN_ON_S * MODEL_SAMPLE_RATE;

/**
 * The reference's `merge_segment_list` then its `min_duration_on` filter, on
 * one speaker's spans in ascending order: consecutive spans whose gap is at
 * most MIN_OFF_S (`a.end + gap >= b.start`, strict `a.end < b.start`) merge
 * first, THEN spans shorter than MIN_ON_S are dropped — so two short bursts
 * across a small pause survive as one segment. Comparisons are in samples,
 * where both bounds are exact.
 */
export function mergeAndFilterSpans16k(spans: readonly SampleSpan16k[]): SampleSpan16k[] {
  const merged: SampleSpan16k[] = [];
  for (const s of spans) {
    const last = merged[merged.length - 1];
    if (last && last.end < s.start && last.end + MIN_OFF_SAMPLES >= s.start) last.end = s.end;
    else merged.push({ start: s.start, end: s.end });
  }
  return merged.filter((s) => s.end - s.start >= MIN_ON_SAMPLES);
}

interface AssembledLabels {
  clusterCount: number;
  /** Per cluster (label), that cluster's merged and filtered spans. */
  spans: SampleSpan16k[][];
}

function checkEvidence(evidence: DiarizationEvidence): void {
  const { totalSamples16k, windows, embeddings } = evidence;
  if (!Number.isInteger(totalSamples16k) || totalSamples16k < 0) {
    throw new RangeError(`assembleDiarization: totalSamples16k must be a non-negative integer (got ${totalSamples16k})`);
  }
  windows.forEach((w, i) => checkWindow(w, `assembleDiarization window ${i}`));
  let dim = -1;
  embeddings.forEach((e, idx) => {
    if (!Number.isInteger(e.windowIndex) || e.windowIndex < 0 || e.windowIndex >= windows.length) {
      throw new RangeError(`assembleDiarization: embedding ${idx} has windowIndex ${e.windowIndex}, outside 0..${windows.length - 1}`);
    }
    if (!Number.isInteger(e.localSpeaker) || e.localSpeaker < 0 || e.localSpeaker >= LOCAL_SPEAKERS) {
      throw new RangeError(`assembleDiarization: embedding ${idx} has localSpeaker ${e.localSpeaker}, outside 0..${LOCAL_SPEAKERS - 1}`);
    }
    if (dim < 0) dim = e.vector.length;
    if (e.vector.length !== dim || dim === 0) {
      throw new RangeError(`assembleDiarization: embedding ${idx} has ${e.vector.length} dims, expected ${dim || 'at least 1'}`);
    }
  });
}

/**
 * The reference's relabel → per-frame vote → `final`, then segments per
 * cluster. `labels[k]` is the cluster of `evidence.embeddings[k]`, numbered
 * 0..clusterCount−1 (first appearance).
 *
 * Vote: for each frame, each window covering it adds ONE vote to every
 * cluster one of its embedded local speakers is active for (the reference's
 * `relabels[i, j, t] = 1` is 0/1 per window, however many locals share the
 * cluster). The top `speakers_per_frame` clusters by vote (ties on the lower
 * id) are active. A frame the segmentation calls speech but no embedded
 * fragment covers has an all-zero vote and, exactly as in the reference's
 * `argsort`, lands on the lowest cluster id — kept verbatim because the sweep
 * scored this assembly; it only concerns runs under MIN_EMBED_FRAMES in every
 * window that sees them.
 */
function assembleLabels(evidence: DiarizationEvidence, labels: readonly number[]): AssembledLabels {
  const { windows, embeddings } = evidence;
  const clusterCount = labels.length ? Math.max(...labels) + 1 : 0;
  const frameCount = assembledFrameCount(evidence.totalSamples16k, windows.length);
  const spf = speakerCountPerFrame(windows);

  // local slot → cluster, per window (−1: not embedded)
  const slotCluster: Int32Array[] = windows.map(() => new Int32Array(LOCAL_SPEAKERS).fill(-1));
  embeddings.forEach((e, k) => {
    slotCluster[e.windowIndex][e.localSpeaker] = labels[k];
  });

  const votes = new Float64Array(frameCount * clusterCount);
  const stamp = new Int32Array(clusterCount).fill(-1);
  for (let i = 0; i < windows.length; i++) {
    const classes = windows[i];
    const start = windowStartFrame(i);
    const slots = slotCluster[i];
    for (let f = 0; f < SEG_FRAMES; f++) {
      const g = start + f;
      if (g >= frameCount) break;
      for (const local of POWERSET[classes[f]]) {
        const t = slots[local];
        if (t < 0 || stamp[t] === g) continue;
        stamp[t] = g;
        votes[g * clusterCount + t] += 1;
      }
    }
  }

  const final = new Uint8Array(frameCount * clusterCount);
  const order = new Array<number>(clusterCount);
  for (let g = 0; g < frameCount; g++) {
    const c = spf[g];
    if (c <= 0) continue;
    for (let t = 0; t < clusterCount; t++) order[t] = t;
    const row = g * clusterCount;
    order.sort((x, y) => votes[row + y] - votes[row + x] || x - y);
    for (let k = 0; k < c && k < clusterCount; k++) final[row + order[k]] = 1;
  }

  const spans: SampleSpan16k[][] = [];
  for (let t = 0; t < clusterCount; t++) {
    const raw: SampleSpan16k[] = [];
    if (frameCount > 0) {
      let isActive = final[t] > ONSET;
      let start = isActive ? 0 : -1;
      for (let g = 1; g < frameCount; g++) {
        const v = final[g * clusterCount + t];
        if (isActive) {
          if (v < OFFSET) {
            raw.push({ start: frameToSample16k(start), end: frameToSample16k(g) });
            isActive = false;
          }
        } else if (v > ONSET) {
          start = g;
          isActive = true;
        }
      }
      // the reference closes an open run at the LAST frame, not one past it
      if (isActive && start < frameCount - 1) raw.push({ start: frameToSample16k(start), end: frameToSample16k(frameCount - 1) });
    }
    spans.push(mergeAndFilterSpans16k(raw));
  }
  return { clusterCount, spans };
}

function spanSeconds(spans: readonly SampleSpan16k[]): number {
  let total = 0;
  for (const s of spans) total += s.end - s.start;
  return total / MODEL_SAMPLE_RATE;
}

export interface ShareFloorResult {
  /** One cluster per embedding, numbered by first appearance. */
  labels: number[];
  /** True when the forced re-run replaced the input labels. */
  refit: boolean;
  /** Per cluster (label), its assembled spans in 16 kHz samples, after MIN_OFF_S / MIN_ON_S. */
  spans: SampleSpan16k[][];
  /** Per cluster, seconds of assembled speech — the quantities whose shares the floor judged. */
  speechSeconds: number[];
}

/**
 * The share floor (D3): assembles `labels`, and if any cluster holds under
 * MIN_SPEAKER_SHARE of the assembled speech, re-runs the FORCED policy at the
 * surviving count so every fragment lands in a surviving speaker — the
 * dropped cluster's speech is re-assigned, never lost. Once: if a cluster is
 * still under the floor afterwards the result stands. Nothing to do when no
 * speech was assembled at all or when no cluster clears the floor (a forced
 * count far above the material — the caller sees the honest small shares).
 */
export function applyShareFloor(evidence: DiarizationEvidence, labels: readonly number[]): ShareFloorResult {
  const first = assembleLabels(evidence, labels);
  const seconds = first.spans.map(spanSeconds);
  const total = seconds.reduce((a, b) => a + b, 0);
  const surviving = total > 0 ? seconds.filter((s) => s / total >= MIN_SPEAKER_SHARE).length : first.clusterCount;
  if (surviving === first.clusterCount || surviving === 0) {
    return { labels: labels.slice(), refit: false, spans: first.spans, speechSeconds: seconds };
  }
  const vectors = evidence.embeddings.map((e) => e.vector);
  const refit = clusterSpeakers(vectors, { speakerCount: surviving }).labels;
  const second = assembleLabels(evidence, refit);
  return { labels: refit, refit: true, spans: second.spans, speechSeconds: second.spans.map(spanSeconds) };
}

function emptyDiarization(): Diarization {
  return { speakerCount: 0, preFoldClusterCount: 0, rawClusterCount: 0, segments: [], overlapSegments: [], speechSeconds: [] };
}

/** Cluster spans → the public shape: speakers numbered by first appearance in
 * time, segments sorted, per-speaker seconds, and the overlap runs. */
function finalize(spans: readonly SampleSpan16k[][], preFoldClusterCount: number, rawClusterCount: number): Diarization {
  const all: { start: number; end: number; cluster: number }[] = [];
  spans.forEach((list, cluster) => {
    for (const s of list) all.push({ start: s.start, end: s.end, cluster });
  });
  all.sort((a, b) => a.start - b.start || a.cluster - b.cluster);

  const speakerOf = new Map<number, number>();
  const segments: DiarizationSegment[] = [];
  const speechSeconds: number[] = [];
  for (const s of all) {
    let speaker = speakerOf.get(s.cluster);
    if (speaker === undefined) {
      speaker = speakerOf.size;
      speakerOf.set(s.cluster, speaker);
      speechSeconds.push(0);
    }
    segments.push({ startSample16k: s.start, endSample16k: s.end, speaker });
    speechSeconds[speaker] += (s.end - s.start) / MODEL_SAMPLE_RATE;
  }

  // Sweep line over segment edges: between consecutive edges the active set
  // is constant; runs with two or more speakers are overlap.
  const events: { at: number; delta: 1 | -1; speaker: number }[] = [];
  for (const s of segments) {
    events.push({ at: s.startSample16k, delta: 1, speaker: s.speaker });
    events.push({ at: s.endSample16k, delta: -1, speaker: s.speaker });
  }
  events.sort((a, b) => a.at - b.at || a.delta - b.delta);
  const overlapSegments: OverlapSegment[] = [];
  const activeSet = new Set<number>();
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e.delta === 1) activeSet.add(e.speaker);
    else activeSet.delete(e.speaker);
    const next = events[i + 1];
    if (!next || next.at === e.at || activeSet.size < 2) continue;
    overlapSegments.push({ startSample16k: e.at, endSample16k: next.at, speakers: [...activeSet].sort((a, b) => a - b) });
  }

  return { speakerCount: speakerOf.size, preFoldClusterCount, rawClusterCount, segments, overlapSegments, speechSeconds };
}

/**
 * Evidence → speakers and their segments (D3).
 *
 * Auto policy (measured): `agglomerateAverage` at DIARIZE_THRESHOLD, then
 * `foldSmallClusters` at MIN_CLUSTER_SIZE; a fold count above MAX_SPEAKERS is
 * forced down to MAX_SPEAKERS with the forced policy. Forced policy:
 * `clusterSpeakers({ speakerCount })` — Ward, k clamped to the fragment count
 * as that function documents; its algorithm and constants are not touched
 * (D7). Both then pass the share floor. `preFoldClusterCount` /
 * `rawClusterCount` report the auto cut before and after folding; in forced
 * mode both are the forced count (there is no fold to report).
 *
 * `speakerCount` is the number of speakers that ended with at least one
 * segment, which is why "Asked for K — N had enough speech to keep" can differ
 * from K. Never throws on shape: zero embeddings → the empty result; one
 * embedding → one speaker (given at least MIN_ON_S of speech).
 */
export function assembleDiarization(evidence: DiarizationEvidence, options: AssembleOptions = {}): Diarization {
  checkEvidence(evidence);
  const { speakerCount } = options;
  if (speakerCount !== undefined && !Number.isFinite(speakerCount)) {
    throw new RangeError(`assembleDiarization: speakerCount must be a finite number (got ${speakerCount})`);
  }
  const embeddings = evidence.embeddings;
  if (embeddings.length === 0) return emptyDiarization();
  const vectors = embeddings.map((e) => e.vector);

  let labels: number[];
  let preFoldClusterCount: number;
  let rawClusterCount: number;
  if (speakerCount !== undefined) {
    labels = clusterSpeakers(vectors, { speakerCount }).labels;
    preFoldClusterCount = distinctCount(labels);
    rawClusterCount = preFoldClusterCount;
  } else {
    const cut = agglomerateAverage(vectors, { threshold: DIARIZE_THRESHOLD }).labels;
    preFoldClusterCount = distinctCount(cut);
    const folded = foldSmallClusters(cut, vectors, { minClusterSize: MIN_CLUSTER_SIZE });
    rawClusterCount = distinctCount(folded);
    labels = rawClusterCount > MAX_SPEAKERS ? clusterSpeakers(vectors, { speakerCount: MAX_SPEAKERS }).labels : folded;
  }

  const floored = applyShareFloor(evidence, labels);
  return finalize(floored.spans, preFoldClusterCount, rawClusterCount);
}

/** The review select: the same evidence at a forced count, no model re-run. */
export function reclusterDiarization(evidence: DiarizationEvidence, speakerCount: number): Diarization {
  return assembleDiarization(evidence, { speakerCount });
}

/**
 * Per output speaker, the segments as document sample spans:
 * `round(s16k · docRate / 16000)` clamped to `[0, docLength]` (D3); a span
 * that clamps to nothing is dropped. Every speaker gets an array, so the
 * result indexes by `segment.speaker` and has `speakerCount` entries — the
 * shape `landSpeakers` takes (D4).
 */
export function segmentsToDocSamples(
  diarization: Diarization,
  docRate: number,
  docLength: number
): { startSample: number; endSample: number }[][] {
  if (!(docRate > 0)) throw new RangeError(`segmentsToDocSamples: docRate must be positive (got ${docRate})`);
  if (!(docLength >= 0)) throw new RangeError(`segmentsToDocSamples: docLength must be non-negative (got ${docLength})`);
  const out: { startSample: number; endSample: number }[][] = Array.from({ length: diarization.speakerCount }, () => []);
  const clamp = (v: number): number => Math.min(docLength, Math.max(0, v));
  for (const s of diarization.segments) {
    if (s.speaker < 0 || s.speaker >= out.length) continue;
    const startSample = clamp(Math.round((s.startSample16k * docRate) / MODEL_SAMPLE_RATE));
    const endSample = clamp(Math.round((s.endSample16k * docRate) / MODEL_SAMPLE_RATE));
    if (endSample > startSample) out[s.speaker].push({ startSample, endSample });
  }
  return out;
}
