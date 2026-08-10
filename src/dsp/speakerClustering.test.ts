import {
  MAX_SPEAKERS,
  SAME_SPEAKER_COSINE,
  clusterSpeakers,
  cosineSimilarity,
  l2Normalize,
  mergeSimilarClusters,
  silhouetteScore,
  wardClusterLabels,
} from './speakerClustering';

/** Deterministic LCG — no Math.random in a clustering test, or a red run is
 * not reproducible. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

/**
 * `count` unit vectors clustered around basis direction `axis` in `dims`
 * dimensions, each perturbed by up to `jitter` on the other axes. Small jitter
 * = a tight speaker; large jitter = a speaker whose segments vary.
 */
function cluster(
  axis: number,
  count: number,
  { dims = 8, jitter = 0.05, seed = 1 }: { dims?: number; jitter?: number; seed?: number } = {}
): Float32Array[] {
  const rand = lcg(seed);
  const out: Float32Array[] = [];
  for (let i = 0; i < count; i++) {
    const v = new Float32Array(dims);
    v[axis] = 1;
    for (let d = 0; d < dims; d++) {
      if (d !== axis) v[d] = (rand() * 2 - 1) * jitter;
    }
    out.push(l2Normalize(v));
  }
  return out;
}

/** Groups the indices that share a label, so tests assert PARTITIONS rather
 * than specific label numbers. */
function partition(labels: readonly number[]): number[][] {
  const groups = new Map<number, number[]>();
  for (let i = 0; i < labels.length; i++) {
    const bucket = groups.get(labels[i]);
    if (bucket) bucket.push(i);
    else groups.set(labels[i], [i]);
  }
  return [...groups.values()].map((g) => g.slice().sort((a, b) => a - b)).sort((a, b) => a[0] - b[0]);
}

describe('l2Normalize', () => {
  it('returns a unit vector', () => {
    const v = l2Normalize(new Float32Array([3, 4]));
    expect(Math.hypot(v[0], v[1])).toBeCloseTo(1, 6);
    expect(v[0]).toBeCloseTo(0.6, 6);
    expect(v[1]).toBeCloseTo(0.8, 6);
  });

  it('leaves a zero vector at zero instead of dividing by zero', () => {
    const v = l2Normalize(new Float32Array([0, 0, 0]));
    expect(Array.from(v)).toEqual([0, 0, 0]);
  });

  it('does not mutate its input', () => {
    const input = new Float32Array([3, 4]);
    l2Normalize(input);
    expect(Array.from(input)).toEqual([3, 4]);
  });
});

describe('cosineSimilarity', () => {
  it('is 1 for identical, 0 for orthogonal, -1 for opposite directions', () => {
    const a = new Float32Array([1, 0]);
    expect(cosineSimilarity(a, new Float32Array([1, 0]))).toBeCloseTo(1, 6);
    expect(cosineSimilarity(a, new Float32Array([0, 1]))).toBeCloseTo(0, 6);
    expect(cosineSimilarity(a, new Float32Array([-1, 0]))).toBeCloseTo(-1, 6);
  });

  it('is scale invariant, so un-normalised input is still correct', () => {
    const a = new Float32Array([1, 0]);
    const b = new Float32Array([7, 0]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(1, 6);
  });

  it('returns 0 rather than NaN when an operand has no direction', () => {
    expect(cosineSimilarity(new Float32Array([0, 0]), new Float32Array([1, 0]))).toBe(0);
    expect(cosineSimilarity(new Float32Array([1, 0]), new Float32Array([0, 0]))).toBe(0);
  });

  it('throws on a length mismatch instead of silently comparing a prefix', () => {
    expect(() => cosineSimilarity(new Float32Array([1, 0]), new Float32Array([1, 0, 0]))).toThrow(
      /length mismatch/
    );
  });
});

describe('wardClusterLabels', () => {
  const groupA = cluster(0, 4, { seed: 11 });
  const groupB = cluster(1, 4, { seed: 22 });
  const points = [...groupA, ...groupB];

  it('recovers two well-separated groups at k=2', () => {
    expect(partition(wardClusterLabels(points, 2))).toEqual([
      [0, 1, 2, 3],
      [4, 5, 6, 7],
    ]);
  });

  it('recovers three well-separated groups at k=3', () => {
    const three = [...cluster(0, 3, { seed: 1 }), ...cluster(1, 3, { seed: 2 }), ...cluster(2, 3, { seed: 3 })];
    expect(partition(wardClusterLabels(three, 3))).toEqual([
      [0, 1, 2],
      [3, 4, 5],
      [6, 7, 8],
    ]);
  });

  it('numbers labels by first appearance, not by internal merge order', () => {
    // The first point must always be speaker 0 and the first point of the
    // other group must be 1, whichever order the merges happened in.
    const labels = wardClusterLabels([...groupB, ...groupA], 2);
    expect(labels[0]).toBe(0);
    expect(labels[4]).toBe(1);
    expect(new Set(labels)).toEqual(new Set([0, 1]));
  });

  // Pins the Lance-Williams update itself, not just "some linkage works".
  // 1-D points, so the right answer is checkable by hand: Ward minimises the
  // total within-cluster sum of squares, and
  //   {7.5, 9, 10.5, 13} + {18}   costs 6.25+1+0.25+9        = 16.5
  //   {7.5, 9, 10.5} + {13, 18}   costs 2.25+0+2.25+6.25+6.25 = 17.0
  // so 18 must be the lone outlier. Flipping the sign of the `- nK*D(I,J)`
  // term in the recurrence produces the 17.0 partition instead.
  it('matches hand-computed Ward on a 1-D set where the linkage recurrence decides', () => {
    const xs = [10.5, 13, 9, 7.5, 18];
    const points = xs.map((x) => new Float32Array([x]));
    expect(wardClusterLabels(points, 2)).toEqual([0, 0, 0, 0, 1]);
  });

  it('is deterministic across repeated runs', () => {
    expect(wardClusterLabels(points, 2)).toEqual(wardClusterLabels(points, 2));
    expect(wardClusterLabels(points, 3)).toEqual(wardClusterLabels(points, 3));
  });

  // k boundary, all three roles
  it('k below/at 1 collapses everything into one cluster', () => {
    expect(wardClusterLabels(points, 1)).toEqual(new Array(8).fill(0));
    expect(wardClusterLabels(points, 0)).toEqual(new Array(8).fill(0));
    expect(wardClusterLabels(points, -3)).toEqual(new Array(8).fill(0));
  });

  it('k at/above n gives every point its own cluster', () => {
    expect(wardClusterLabels(points, 8)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(wardClusterLabels(points, 9)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it('k just below n merges exactly one pair', () => {
    const labels = wardClusterLabels(points, 7);
    expect(new Set(labels).size).toBe(7);
  });

  it('handles the empty input', () => {
    expect(wardClusterLabels([], 2)).toEqual([]);
  });
});

describe('silhouetteScore', () => {
  it('is near 1 for tight, well-separated clusters', () => {
    const points = [...cluster(0, 4, { jitter: 0.01, seed: 5 }), ...cluster(1, 4, { jitter: 0.01, seed: 6 })];
    const score = silhouetteScore(points, [0, 0, 0, 0, 1, 1, 1, 1]);
    expect(score).toBeGreaterThan(0.8);
    expect(score).toBeLessThanOrEqual(1);
  });

  it('is much lower when the same points are split against their structure', () => {
    const points = [...cluster(0, 4, { jitter: 0.01, seed: 5 }), ...cluster(1, 4, { jitter: 0.01, seed: 6 })];
    const correct = silhouetteScore(points, [0, 0, 0, 0, 1, 1, 1, 1]);
    const wrong = silhouetteScore(points, [0, 1, 0, 1, 0, 1, 0, 1]);
    expect(wrong).toBeLessThan(correct);
    expect(wrong).toBeLessThan(0.1);
  });

  it('is 0 for a degenerate partition (one cluster, or fewer than 2 points)', () => {
    const points = cluster(0, 4, { seed: 7 });
    expect(silhouetteScore(points, [0, 0, 0, 0])).toBe(0);
    expect(silhouetteScore([points[0]], [0])).toBe(0);
    expect(silhouetteScore([], [])).toBe(0);
  });

  it('scores a singleton cluster as 0 rather than NaN', () => {
    const points = [...cluster(0, 3, { jitter: 0.01, seed: 8 }), ...cluster(1, 1, { jitter: 0.01, seed: 9 })];
    const score = silhouetteScore(points, [0, 0, 0, 1]);
    expect(Number.isFinite(score)).toBe(true);
    // 3 members score high, the singleton contributes exactly 0, so the mean
    // is strictly below what the 3 would average on their own.
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(0.8);
  });

  it('throws when labels do not line up with points', () => {
    expect(() => silhouetteScore(cluster(0, 3, { seed: 1 }), [0, 1])).toThrow(/3 points but 2 labels/);
  });
});

describe('mergeSimilarClusters', () => {
  // Two singletons, so average linkage between the clusters is exactly the
  // cosine between the two points — which lets the threshold be probed exactly.
  const a = l2Normalize(new Float32Array([1, 0, 0]));
  const b = l2Normalize(new Float32Array([0.5, 0.75, 0]));
  const pair = [a, b];
  const exact = cosineSimilarity(a, b);

  it('the fixture sits mid-range, so the boundary can actually move the result', () => {
    expect(exact).toBeGreaterThan(0.1);
    expect(exact).toBeLessThan(0.9);
  });

  it('threshold below the pair similarity: merges', () => {
    expect(mergeSimilarClusters(pair, [0, 1], exact - 1e-6)).toEqual([0, 0]);
  });

  it('threshold exactly at the pair similarity: merges (the test is >=)', () => {
    expect(mergeSimilarClusters(pair, [0, 1], exact)).toEqual([0, 0]);
  });

  it('threshold just above the pair similarity: keeps them apart', () => {
    expect(mergeSimilarClusters(pair, [0, 1], exact + 1e-6)).toEqual([0, 1]);
  });

  it('collapses a chain of similar clusters in one call', () => {
    const points = cluster(0, 6, { jitter: 0.02, seed: 3 });
    expect(mergeSimilarClusters(points, [0, 1, 2, 3, 4, 5], 0.4)).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it('leaves genuinely different clusters alone', () => {
    const points = [...cluster(0, 3, { seed: 4 }), ...cluster(1, 3, { seed: 5 })];
    expect(partition(mergeSimilarClusters(points, [0, 0, 0, 1, 1, 1], 0.4))).toEqual([
      [0, 1, 2],
      [3, 4, 5],
    ]);
  });

  it('merges only the similar pair when a third cluster is distinct', () => {
    const points = [
      ...cluster(0, 2, { jitter: 0.02, seed: 6 }),
      ...cluster(0, 2, { jitter: 0.02, seed: 7 }),
      ...cluster(1, 2, { jitter: 0.02, seed: 8 }),
    ];
    expect(partition(mergeSimilarClusters(points, [0, 0, 1, 1, 2, 2], 0.4))).toEqual([
      [0, 1, 2, 3],
      [4, 5],
    ]);
  });

  it('renumbers by first appearance after merging', () => {
    const points = [...cluster(1, 2, { seed: 9 }), ...cluster(0, 2, { seed: 10 })];
    const labels = mergeSimilarClusters(points, [5, 5, 9, 9], 0.4);
    expect(labels).toEqual([0, 0, 1, 1]);
  });

  it('is a no-op on a single cluster', () => {
    expect(mergeSimilarClusters(cluster(0, 3, { seed: 11 }), [0, 0, 0], 0.4)).toEqual([0, 0, 0]);
  });
});

describe('clusterSpeakers', () => {
  it('handles 0 and 1 embeddings without clustering anything', () => {
    expect(clusterSpeakers([])).toEqual({ labels: [], speakerCount: 0, silhouette: null });
    expect(clusterSpeakers(cluster(0, 1, { seed: 1 }))).toEqual({
      labels: [0],
      speakerCount: 1,
      silhouette: null,
    });
  });

  it('finds two speakers in two separated groups and groups them correctly', () => {
    const points = [...cluster(0, 4, { seed: 12 }), ...cluster(1, 4, { seed: 13 })];
    const result = clusterSpeakers(points);
    expect(result.speakerCount).toBe(2);
    expect(partition(result.labels)).toEqual([
      [0, 1, 2, 3],
      [4, 5, 6, 7],
    ]);
    expect(result.silhouette).not.toBeNull();
  });

  it('finds three speakers in three separated groups', () => {
    const points = [
      ...cluster(0, 4, { seed: 14 }),
      ...cluster(1, 4, { seed: 15 }),
      ...cluster(2, 4, { seed: 16 }),
    ];
    const result = clusterSpeakers(points);
    expect(result.speakerCount).toBe(3);
    expect(partition(result.labels)).toEqual([
      [0, 1, 2, 3],
      [4, 5, 6, 7],
      [8, 9, 10, 11],
    ]);
  });

  it('reports ONE speaker for one voice — the guard the reference lacks', () => {
    const points = cluster(0, 6, { jitter: 0.05, seed: 17 });
    const result = clusterSpeakers(points);
    expect(result.speakerCount).toBe(1);
    expect(result.labels).toEqual([0, 0, 0, 0, 0, 0]);
    expect(result.silhouette).toBeNull();
  });

  it('reproduces the reference (never k=1) when merging is disabled', () => {
    const points = cluster(0, 6, { jitter: 0.05, seed: 17 });
    expect(clusterSpeakers(points, { sameSpeakerCosine: Infinity }).speakerCount).toBe(2);
  });

  it('takes an explicit speakerCount as an assertion and does not merge it away', () => {
    const points = cluster(0, 6, { jitter: 0.05, seed: 18 });
    const result = clusterSpeakers(points, { speakerCount: 3 });
    expect(result.speakerCount).toBe(3);
    expect(result.silhouette).toBeNull();
  });

  it('clamps an explicit speakerCount to the number of embeddings', () => {
    const points = cluster(0, 3, { seed: 19 });
    expect(clusterSpeakers(points, { speakerCount: 99 }).speakerCount).toBe(3);
    expect(clusterSpeakers(points, { speakerCount: 0 }).speakerCount).toBe(1);
  });

  // n = 2: the silhouette range is empty, so the merge criterion alone decides.
  it('two similar embeddings are one speaker; two different ones are two', () => {
    const same = cluster(0, 2, { jitter: 0.02, seed: 20 });
    expect(clusterSpeakers(same).speakerCount).toBe(1);
    const different = [...cluster(0, 1, { seed: 21 }), ...cluster(1, 1, { seed: 22 })];
    expect(clusterSpeakers(different).speakerCount).toBe(2);
  });

  // maxSpeakers boundary, all three roles relative to the true group count.
  it('maxSpeakers below the true count caps the answer', () => {
    const points = [
      ...cluster(0, 3, { seed: 23 }),
      ...cluster(1, 3, { seed: 24 }),
      ...cluster(2, 3, { seed: 25 }),
    ];
    expect(clusterSpeakers(points, { maxSpeakers: 2 }).speakerCount).toBe(2);
    expect(clusterSpeakers(points, { maxSpeakers: 3 }).speakerCount).toBe(3);
    expect(clusterSpeakers(points, { maxSpeakers: 4 }).speakerCount).toBe(3);
  });

  it('never proposes more speakers than n-1 from auto-detection', () => {
    const points = [...cluster(0, 1, { seed: 26 }), ...cluster(1, 1, { seed: 27 }), ...cluster(2, 1, { seed: 28 })];
    expect(clusterSpeakers(points).speakerCount).toBeLessThanOrEqual(2);
  });

  it('sameSpeakerCosine boundary: below merges the two groups, above keeps them', () => {
    const points = [...cluster(0, 3, { seed: 29 }), ...cluster(1, 3, { seed: 30 })];
    const twoWay = wardClusterLabels(points, 2);
    // the exact criterion value for this fixture
    const groupA = twoWay.map((l, i) => (l === 0 ? i : -1)).filter((i) => i >= 0);
    const groupB = twoWay.map((l, i) => (l === 1 ? i : -1)).filter((i) => i >= 0);
    let sum = 0;
    for (const i of groupA) for (const j of groupB) sum += cosineSimilarity(points[i], points[j]);
    const criterion = sum / (groupA.length * groupB.length);

    expect(clusterSpeakers(points, { sameSpeakerCosine: criterion - 1e-6 }).speakerCount).toBe(1);
    expect(clusterSpeakers(points, { sameSpeakerCosine: criterion }).speakerCount).toBe(1);
    expect(clusterSpeakers(points, { sameSpeakerCosine: criterion + 1e-6 }).speakerCount).toBe(2);
  });

  it('the shipped default sits between the measured populations', () => {
    // Guards the constant itself: the measured single-speaker minimum was
    // 0.554 and the multi-speaker maximum 0.262, so the default must fall
    // strictly inside that gap or the guard misfires on real audio.
    expect(SAME_SPEAKER_COSINE).toBeGreaterThan(0.262);
    expect(SAME_SPEAKER_COSINE).toBeLessThan(0.554);
    expect(MAX_SPEAKERS).toBe(6);
  });
});
