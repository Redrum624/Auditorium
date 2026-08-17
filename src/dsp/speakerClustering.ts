/**
 * Speaker clustering — the maths half of F4 diarization.
 *
 * This reproduces the DOCUMENTED behaviour of scikit-learn's agglomerative
 * clustering with silhouette-based model selection, as used by the standard
 * Python diarization recipe (speaker embeddings fed to scikit-learn) — "the
 * reference recipe" below. No Python runtime loads here: the clustering is
 * ~100 lines of plain maths, so it is implemented directly against
 * scikit-learn's documented semantics.
 *
 * What the reference recipe does, and therefore what this reproduces:
 *   - `AgglomerativeClustering(n_clusters=n)` with scikit-learn's DEFAULTS,
 *     i.e. **Ward linkage on squared Euclidean distance** — not cosine. The
 *     embeddings are L2-normalised, so Euclidean and cosine are monotonically
 *     related on the unit sphere (`d^2 = 2 - 2*cos`); Ward is still meaningful.
 *   - `silhouette_score(embeddings, labels)` with its default Euclidean metric,
 *     maximised over a candidate range of k, to pick the speaker count.
 *
 * Where this deliberately DIVERGES from the reference, and why:
 *   - The reference's auto-detect range starts at `min_speakers = 2`, so a
 *     recording of ONE person is always split into at least two "speakers".
 *     A confident wrong label is worse than an honest one, so `clusterSpeakers`
 *     finishes with a merge pass that folds clusters back together when they
 *     are too similar to be different people — which is what lets it return
 *     k = 1. See SAME_SPEAKER_COSINE for the measurement behind the threshold,
 *     and note in particular that the obvious alternative (thresholding the
 *     silhouette score) was MEASURED AND REJECTED: on the F4 bench material
 *     single-speaker sets scored up to 0.379 and the weakest genuine
 *     two-speaker set also scored 0.379, so no silhouette cut separates them.
 *
 * Pure maths: no DOM, no Electron, no audio I/O. Embedding EXTRACTION lives in
 * the utility process (`electron/transcribeHost.cjs`); this module only ever
 * sees the resulting vectors.
 */

/**
 * Largest speaker count auto-detection will consider.
 *
 * The reference recipe's `max_speakers` default of 6. It is a candidate-range
 * bound rather than a quality threshold — raising it only lets silhouette
 * selection consider more partitions, at O(k) more silhouette evaluations.
 */
export const MAX_SPEAKERS = 6;

/**
 * Average-linkage cosine similarity at or above which two clusters are judged
 * to be the SAME person and merged.
 *
 * MEASURED, not chosen — F4 diarization bench (gitignored working note, not published).
 * Real speech, 2 s chunks, CAM++ embeddings, ground truth known by construction
 * (every chunk is cut from a single-speaker recording). The quantity below is
 * the average-linkage cosine between the two clusters of the best 2-way split:
 *
 *   single-speaker sets  0.554  0.682  0.685  0.718  0.890   (min 0.554)
 *   multi-speaker  sets  0.231  0.244  0.258  0.260  0.262   (max 0.262)
 *
 * The populations are cleanly separated with no overlap; 0.40 is the midpoint
 * of the [0.262, 0.554] gap, so it is roughly equidistant from both and does
 * not sit near either population's edge.
 */
export const SAME_SPEAKER_COSINE = 0.4;

/** Smallest cluster count auto-detection will consider once the single-speaker
 * guard has been passed. Matches the reference's `min_speakers` default. */
const MIN_MULTI_SPEAKERS = 2;

export interface SpeakerClusterOptions {
  /**
   * Fixed speaker count. When provided, silhouette selection is skipped
   * entirely and exactly this many clusters are produced (clamped to the
   * number of embeddings). This is the reference's `num_speakers` argument and
   * is how the UI offers "I know there are N speakers".
   */
  speakerCount?: number;
  /** Upper bound for auto-detection. Defaults to {@link MAX_SPEAKERS}. */
  maxSpeakers?: number;
  /**
   * Average-linkage cosine at or above which two clusters are merged as one
   * person. Defaults to {@link SAME_SPEAKER_COSINE}. Pass `Infinity` to
   * disable merging and reproduce the reference's behaviour of never
   * returning k = 1.
   */
  sameSpeakerCosine?: number;
}

export interface SpeakerClusterResult {
  /**
   * One cluster index per input embedding, numbered by FIRST APPEARANCE, so
   * label 0 is whoever speaks first. Agglomerative merge order is an internal
   * detail and must never leak into user-visible speaker numbering.
   */
  labels: number[];
  speakerCount: number;
  /**
   * Silhouette of the returned partition, or `null` when no silhouette was
   * computed — a fixed `speakerCount`, or fewer than 3 embeddings (silhouette
   * needs at least one cluster with 2+ members AND 2+ clusters to mean
   * anything).
   */
  silhouette: number | null;
}

/**
 * Returns an L2-normalised copy. A zero vector has no direction, so it is
 * returned unchanged rather than divided by zero — callers that care must
 * reject empty/silent segments upstream.
 */
export function l2Normalize(v: Float32Array): Float32Array {
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += v[i] * v[i];
  const norm = Math.sqrt(sum);
  const out = new Float32Array(v.length);
  if (norm === 0) return out;
  for (let i = 0; i < v.length; i++) out[i] = v[i] / norm;
  return out;
}

/**
 * Cosine similarity in [-1, 1]. Normalises internally, so it is correct for
 * un-normalised input; a zero-norm operand yields 0 (no direction, so no
 * agreement) rather than NaN.
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new Error(`cosineSimilarity: length mismatch (${a.length} vs ${b.length})`);
  }
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function squaredEuclidean(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    sum += d * d;
  }
  return sum;
}

function euclidean(a: Float32Array, b: Float32Array): number {
  return Math.sqrt(squaredEuclidean(a, b));
}

/**
 * Relabels an arbitrary cluster assignment so labels appear in ascending order
 * of first occurrence: the first point gets 0, the first point belonging to a
 * different cluster gets 1, and so on.
 */
function relabelByFirstAppearance(raw: number[]): number[] {
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

/**
 * Agglomerative clustering with Ward linkage, cut at exactly `k` clusters.
 *
 * Ward merges the pair whose union increases the total within-cluster sum of
 * squares (ESS) least. For singletons that increase is `0.5 * ||xi - xj||^2`;
 * thereafter the Lance-Williams recurrence keeps the merge cost exact without
 * ever recomputing a centroid:
 *
 *   D(I∪J, K) = [ (nI+nK)·D(I,K) + (nJ+nK)·D(J,K) − nK·D(I,J) ] / (nI+nJ+nK)
 *
 * The recurrence is homogeneous in D, so scaling every initial distance by a
 * constant leaves the merge ORDER — and therefore the clustering — unchanged.
 * That is why initialising with `0.5*d^2` (the true ESS increase) and with
 * `d^2` (what several textbook implementations use) agree.
 *
 * Ties are broken by lowest index pair, so the result is deterministic.
 *
 * Cost: the naive "rescan the whole matrix per merge" is O(n^3), which is too
 * slow for the ~1000 segments a two-hour transcript produces. This keeps a
 * per-cluster nearest-neighbour cache so each merge costs O(n) plus an O(n)
 * rescan only for clusters whose nearest neighbour was consumed by the merge.
 */
export function wardClusterLabels(points: readonly Float32Array[], k: number): number[] {
  const n = points.length;
  if (n === 0) return [];
  if (k <= 1) return new Array<number>(n).fill(0);
  if (k >= n) return points.map((_, i) => i);

  // Full symmetric cost matrix, addressed as d[i * n + j].
  const d = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const cost = 0.5 * squaredEuclidean(points[i], points[j]);
      d[i * n + j] = cost;
      d[j * n + i] = cost;
    }
  }

  const active = new Uint8Array(n).fill(1);
  const size = new Float64Array(n).fill(1);
  /** Cluster index -> the original point indices it contains. */
  const members: number[][] = points.map((_, i) => [i]);

  const nn = new Int32Array(n).fill(-1);
  const nnDist = new Float64Array(n).fill(Infinity);
  const refreshNn = (i: number): void => {
    let best = -1;
    let bestDist = Infinity;
    for (let j = 0; j < n; j++) {
      if (j === i || !active[j]) continue;
      const cost = d[i * n + j];
      if (cost < bestDist) {
        bestDist = cost;
        best = j;
      }
    }
    nn[i] = best;
    nnDist[i] = bestDist;
  };
  for (let i = 0; i < n; i++) refreshNn(i);

  let clusters = n;
  while (clusters > k) {
    // Global minimum over the nearest-neighbour cache. Scanning i ascending
    // and taking strictly-smaller keeps the lowest-index tie-break.
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
    if (a < 0 || b < 0) break; // defensive: nothing left to merge
    if (b < a) {
      const swap = a;
      a = b;
      b = swap;
    }

    // Lance-Williams update of a against every other surviving cluster.
    const nA = size[a];
    const nB = size[b];
    for (let m = 0; m < n; m++) {
      if (m === a || m === b || !active[m]) continue;
      const nM = size[m];
      const updated =
        ((nA + nM) * d[a * n + m] + (nB + nM) * d[b * n + m] - nM * d[a * n + b]) / (nA + nB + nM);
      d[a * n + m] = updated;
      d[m * n + a] = updated;
    }

    members[a] = members[a].concat(members[b]);
    size[a] = nA + nB;
    active[b] = 0;
    members[b] = [];
    clusters--;

    // `a`'s distances all changed and `b` is gone, so any cluster pointing at
    // either needs a fresh nearest neighbour.
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
  return relabelByFirstAppearance(raw);
}

/**
 * Mean silhouette coefficient over all points, Euclidean metric — the same
 * quantity `sklearn.metrics.silhouette_score` returns with its defaults.
 *
 * For point i in cluster A: `a(i)` is its mean distance to the OTHER members
 * of A, `b(i)` the smallest mean distance to any other cluster, and
 * `s(i) = (b - a) / max(a, b)`. A singleton cluster scores 0 by definition
 * (sklearn's convention) because `a(i)` is undefined for it.
 *
 * Returns 0 when the partition is degenerate (fewer than 2 clusters, or fewer
 * than 2 points) — there is no separation to score.
 */
export function silhouetteScore(points: readonly Float32Array[], labels: readonly number[]): number {
  const n = points.length;
  if (n !== labels.length) {
    throw new Error(`silhouetteScore: ${n} points but ${labels.length} labels`);
  }
  if (n < 2) return 0;

  const byLabel = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const bucket = byLabel.get(labels[i]);
    if (bucket) bucket.push(i);
    else byLabel.set(labels[i], [i]);
  }
  if (byLabel.size < 2) return 0;

  let total = 0;
  for (let i = 0; i < n; i++) {
    const own = byLabel.get(labels[i]) as number[];
    if (own.length === 1) continue; // s(i) = 0

    let intra = 0;
    for (const j of own) {
      if (j !== i) intra += euclidean(points[i], points[j]);
    }
    const a = intra / (own.length - 1);

    let b = Infinity;
    for (const [label, group] of byLabel) {
      if (label === labels[i]) continue;
      let sum = 0;
      for (const j of group) sum += euclidean(points[i], points[j]);
      const mean = sum / group.length;
      if (mean < b) b = mean;
    }

    const denom = Math.max(a, b);
    if (denom > 0) total += (b - a) / denom;
  }
  return total / n;
}

/**
 * Mean cosine similarity between every cross pair of two groups of points —
 * average linkage, the same linkage the merge criterion was measured with.
 * Returns -1 (maximally dissimilar) when either group is empty, so an empty
 * group is never merged into anything.
 */
function averageLinkageCosine(
  points: readonly Float32Array[],
  groupA: readonly number[],
  groupB: readonly number[]
): number {
  if (groupA.length === 0 || groupB.length === 0) return -1;
  let sum = 0;
  for (const i of groupA) {
    for (const j of groupB) sum += cosineSimilarity(points[i], points[j]);
  }
  return sum / (groupA.length * groupB.length);
}

/**
 * Folds clusters back together while the most similar surviving pair is at or
 * above `threshold` average-linkage cosine — the guard that lets the result
 * reach one speaker, which the reference's silhouette-only selection never can.
 *
 * Greedy and repeated: after each merge the pair similarities are recomputed,
 * so a chain of near-identical clusters collapses fully. Returns labels
 * renumbered by first appearance.
 */
export function mergeSimilarClusters(
  points: readonly Float32Array[],
  labels: readonly number[],
  threshold: number
): number[] {
  const groups = new Map<number, number[]>();
  for (let i = 0; i < labels.length; i++) {
    const bucket = groups.get(labels[i]);
    if (bucket) bucket.push(i);
    else groups.set(labels[i], [i]);
  }

  for (;;) {
    const keys = [...groups.keys()];
    if (keys.length < 2) break;
    let bestA = -1;
    let bestB = -1;
    let best = -Infinity;
    for (let x = 0; x < keys.length; x++) {
      for (let y = x + 1; y < keys.length; y++) {
        const sim = averageLinkageCosine(
          points,
          groups.get(keys[x]) as number[],
          groups.get(keys[y]) as number[]
        );
        if (sim > best) {
          best = sim;
          bestA = keys[x];
          bestB = keys[y];
        }
      }
    }
    if (best < threshold || bestA < 0) break;
    const merged = (groups.get(bestA) as number[]).concat(groups.get(bestB) as number[]);
    groups.set(bestA, merged);
    groups.delete(bestB);
  }

  const out = new Array<number>(labels.length).fill(0);
  for (const [label, members] of groups) {
    for (const i of members) out[i] = label;
  }
  return relabelByFirstAppearance(out);
}

/**
 * Assigns each embedding a speaker label.
 *
 * Auto-detection reproduces the reference: cluster at every k in
 * `[2, min(maxSpeakers, n-1)]`, score each partition with the silhouette
 * coefficient, keep the best. It then runs {@link mergeSimilarClusters} over
 * the winner, which is what allows a one-speaker answer.
 *
 * A caller-supplied `speakerCount` is taken as an assertion and is NOT second
 * guessed: the merge pass is skipped, so asking for k speakers returns k.
 *
 * Never throws on shape: 0 embeddings gives an empty result, 1 gives a single
 * speaker. Embeddings are used as given — normalise upstream if the model does
 * not already emit unit vectors.
 */
export function clusterSpeakers(
  embeddings: readonly Float32Array[],
  options: SpeakerClusterOptions = {}
): SpeakerClusterResult {
  const n = embeddings.length;
  if (n === 0) return { labels: [], speakerCount: 0, silhouette: null };
  if (n === 1) return { labels: [0], speakerCount: 1, silhouette: null };

  const { speakerCount, maxSpeakers = MAX_SPEAKERS, sameSpeakerCosine = SAME_SPEAKER_COSINE } = options;

  if (speakerCount !== undefined) {
    const k = Math.max(1, Math.min(Math.floor(speakerCount), n));
    const labels = wardClusterLabels(embeddings, k);
    return { labels, speakerCount: new Set(labels).size, silhouette: null };
  }

  // k = n would give every segment its own speaker, so the candidate range
  // stops at n-1. That bound is defensive rather than load-bearing: an
  // all-singleton partition scores exactly 0 (every s(i) is 0 by the singleton
  // convention) and the comparison below is a strict `>`, so an earlier k
  // already beats or ties it. With n === 2 the range is
  // empty and the merge pass alone decides, which is the honest answer: two
  // segments carry no internal evidence of separation, only their similarity.
  const kMax = Math.min(Math.floor(maxSpeakers), n - 1);
  let bestLabels: number[] = embeddings.map((_, i) => (i === 0 ? 0 : 1));
  for (let k = MIN_MULTI_SPEAKERS, bestScore = -Infinity; k <= kMax; k++) {
    const labels = wardClusterLabels(embeddings, k);
    if (new Set(labels).size < 2) continue;
    const score = silhouetteScore(embeddings, labels);
    if (score > bestScore) {
      bestScore = score;
      bestLabels = labels;
    }
  }
  if (n === 2) bestLabels = [0, 1];

  const labels = mergeSimilarClusters(embeddings, bestLabels, sameSpeakerCosine);
  const count = new Set(labels).size;
  return {
    labels,
    speakerCount: count,
    silhouette: count >= 2 ? silhouetteScore(embeddings, labels) : null,
  };
}
