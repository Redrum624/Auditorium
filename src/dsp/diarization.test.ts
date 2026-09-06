import {
  DIARIZE_THRESHOLD,
  FRAME_SHIFT,
  LOCAL_SPEAKERS,
  MAX_SPEAKERS,
  MIN_CLUSTER_SIZE,
  MIN_EMBED_FRAMES,
  MIN_OFF_S,
  MIN_ON_S,
  MIN_SPEAKER_SHARE,
  MODEL_SAMPLE_RATE,
  ONSET,
  OFFSET,
  POWERSET,
  RECEPTIVE_FIELD,
  SEG_FRAMES,
  SEG_SHIFT,
  SEG_WINDOW,
  agglomerateAverage,
  applyShareFloor,
  assembleDiarization,
  assembledFrameCount,
  cosineDistance,
  embeddableFragments,
  expectedWindowCount,
  foldSmallClusters,
  fragmentSampleRange,
  frameToSample16k,
  hasPaddedLastWindow,
  localSpeakerSpans,
  mergeAndFilterSpans16k,
  powersetToLocal,
  reclusterDiarization,
  segmentsToDocSamples,
  speakerCountPerFrame,
  totalFrameCount,
  windowStartFrame,
  type Diarization,
  type DiarizationSegment,
  type DiarizationEvidence,
} from './diarization';
import { unitVector } from './testVectors';

// ---------------------------------------------------------------- helpers

/** Deterministic LCG — no Math.random in a clustering test, or a red run is
 * not reproducible. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
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

/** A unit vector at cosine `c` to axis 0, tilted into `plane`. Lets a fixture
 * name its cosine DISTANCE (1 − c) directly. */
function atCosine(c: number, dim = 4, plane = 1): Float32Array {
  const v = new Float32Array(dim);
  v[0] = c;
  v[plane] = Math.sqrt(1 - c * c);
  return v;
}

/** `direction` plus a ±0.01 wobble per dimension, renormalised — the
 * `unitVector` recipe for an arbitrary direction instead of a basis axis. */
function wobbled(direction: Float32Array, seed: number): Float32Array {
  const rand = lcg(seed);
  const v = new Float32Array(direction.length);
  let norm = 0;
  for (let i = 0; i < v.length; i++) {
    v[i] = direction[i] + 0.02 * (rand() - 0.5);
    norm += v[i] * v[i];
  }
  norm = Math.sqrt(norm);
  for (let i = 0; i < v.length; i++) v[i] /= norm;
  return v;
}

function axis(dim: number, k: number): Float32Array {
  const v = new Float32Array(dim);
  v[k] = 1;
  return v;
}

/** A window whose class bytes come from `runs` of (class, fromFrame, toFrame)
 * half-open spans; everything else is class 0 (no speaker). */
function windowOf(runs: readonly [cls: number, from: number, to: number][]): Uint8Array {
  const w = new Uint8Array(SEG_FRAMES);
  for (const [cls, from, to] of runs) for (let f = from; f < to; f++) w[f] = cls;
  return w;
}

/** One window's class bytes from its LOCAL SLOTS: `[local, from, to)` in
 * GLOBAL frames. Unlike `evidenceFromTimeline` this builds each window on its
 * own, so two windows may disagree about a frame — which is what the real
 * model does (`powerset_max_classes` is 2, so a three-way overlap forces each
 * window to pick a different pair) and the only way to pin what the per-frame
 * vote does across a window boundary. */
function windowFromSlots(windowIndex: number, slots: readonly [local: number, from: number, to: number][]): Uint8Array {
  const start = windowStartFrame(windowIndex);
  const w = new Uint8Array(SEG_FRAMES);
  for (let f = 0; f < SEG_FRAMES; f++) {
    const g = start + f;
    const active = [...new Set(slots.filter(([, a, b]) => g >= a && g < b).map(([l]) => l))].sort((a, b) => a - b);
    const cls = POWERSET.findIndex((set) => set.length === active.length && set.every((v, k) => v === active[k]));
    if (cls < 0) throw new Error(`window ${windowIndex} frame ${g}: locals ${active} are not a powerset class`);
    w[f] = cls;
  }
  return w;
}

/**
 * Four unit vectors realising a named cosine-distance table: a tight pair
 * P1/P2, a P3 equidistant from both, and a singleton Q. Sizes 3 vs 1 are the
 * smallest case where size-weighted (UPGMA) linkage and a plain mean of the
 * two children (WPGMA) part company, so a fixture that discriminates them
 * needs a cluster of three — every equal-size merge makes the two rules agree.
 */
function threeAndOne(dPair: number, dToP3: number, dPQ: number, dP3Q: number): Float32Array[] {
  const c = Math.sqrt((2 - dPair) / 2); // cos(P1,P2) = 2c² − 1 = 1 − dPair
  const s = Math.sqrt(1 - c * c);
  const p = (1 - dToP3) / c; // cos(P1,P3) = cos(P2,P3) = c·p
  const q = Math.sqrt(1 - p * p);
  const u = (1 - dPQ) / c; // cos(P1,Q) = cos(P2,Q) = c·u
  const v = (1 - dP3Q - p * u) / q; // cos(P3,Q) = p·u + q·v
  const w = Math.sqrt(1 - u * u - v * v);
  return [
    new Float32Array([c, s, 0, 0]),
    new Float32Array([c, -s, 0, 0]),
    new Float32Array([p, 0, q, 0]),
    new Float32Array([u, 0, v, w]),
  ];
}

interface SpeakerLine {
  /** Embedding direction for every fragment of this speaker. */
  direction: Float32Array;
  /** GLOBAL frame spans, half-open. */
  spans: readonly [start: number, end: number][];
}

/**
 * Builds evidence the way the host would from a known timeline: per window,
 * local slots are handed out in order of first appearance inside that
 * window, the class byte is the powerset index of the active local set, and
 * one embedding exists per (window, local) with ≥ MIN_EMBED_FRAMES active
 * frames. Only the constants are shared with production — the frame
 * arithmetic they pin is asserted separately below.
 */
function evidenceFromTimeline(totalSamples16k: number, speakers: readonly SpeakerLine[]): DiarizationEvidence {
  const windowCount = expectedWindowCount(totalSamples16k);
  const windows: Uint8Array[] = [];
  const embeddings: DiarizationEvidence['embeddings'] = [];
  let seed = 1;
  for (let i = 0; i < windowCount; i++) {
    const start = windowStartFrame(i);
    const slot = new Map<number, number>();
    const classes = new Uint8Array(SEG_FRAMES);
    for (let f = 0; f < SEG_FRAMES; f++) {
      const g = start + f;
      const locals: number[] = [];
      speakers.forEach((sp, si) => {
        if (!sp.spans.some(([a, b]) => g >= a && g < b)) return;
        let local = slot.get(si);
        if (local === undefined) {
          if (slot.size >= LOCAL_SPEAKERS) throw new Error(`window ${i}: more than ${LOCAL_SPEAKERS} speakers`);
          local = slot.size;
          slot.set(si, local);
        }
        locals.push(local);
      });
      locals.sort((a, b) => a - b);
      const cls = POWERSET.findIndex((set) => set.length === locals.length && set.every((v, k) => v === locals[k]));
      if (cls < 0) throw new Error(`frame ${g}: ${locals.length} simultaneous speakers exceed the powerset`);
      classes[f] = cls;
    }
    windows.push(classes);
    for (const [si, local] of slot) {
      let activeFrames = 0;
      for (let f = 0; f < SEG_FRAMES; f++) if (POWERSET[classes[f]].includes(local)) activeFrames++;
      if (activeFrames < MIN_EMBED_FRAMES) continue;
      embeddings.push({ windowIndex: i, localSpeaker: local, activeFrames, vector: wobbled(speakers[si].direction, seed++) });
    }
  }
  return { totalSamples16k, windows, embeddings };
}

const f16 = (frame: number): number => frameToSample16k(frame);
const FRAME_S = FRAME_SHIFT / MODEL_SAMPLE_RATE;

/** Four full windows, exact fit (no padded tail): frames 0..770. */
const FOUR_WINDOWS = SEG_WINDOW + 3 * SEG_SHIFT;
/** Two full windows, exact fit. */
const TWO_WINDOWS = SEG_WINDOW + SEG_SHIFT;

function segmentsOf(d: Diarization, speaker: number): { start: number; end: number }[] {
  return d.segments.filter((s) => s.speaker === speaker).map((s) => ({ start: s.startSample16k, end: s.endSample16k }));
}

// ---------------------------------------------------------------- constants

describe('constants (D3, model metadata and the sweep)', () => {
  it('pins the model geometry', () => {
    expect(SEG_WINDOW).toBe(160000);
    expect(SEG_SHIFT).toBe(16000);
    expect(SEG_FRAMES).toBe(589);
    expect(RECEPTIVE_FIELD).toBe(991);
    expect(FRAME_SHIFT).toBe(270);
    expect(LOCAL_SPEAKERS).toBe(3);
    expect(MODEL_SAMPLE_RATE).toBe(16000);
  });

  it('pins the powerset table: none, three singles, three pairs', () => {
    expect(POWERSET).toEqual([[], [0], [1], [2], [0, 1], [0, 2], [1, 2]]);
    expect(POWERSET).toHaveLength(7);
  });

  it('pins the assembly and clustering policy numbers', () => {
    expect(MIN_EMBED_FRAMES).toBe(10);
    expect(ONSET).toBe(0.5);
    expect(OFFSET).toBe(0.5);
    expect(MIN_ON_S).toBe(0.3);
    expect(MIN_OFF_S).toBe(0.5);
    expect(DIARIZE_THRESHOLD).toBe(0.55);
    expect(MIN_CLUSTER_SIZE).toBe(4);
    expect(MIN_SPEAKER_SHARE).toBe(0.05);
    expect(MAX_SPEAKERS).toBe(6);
  });
});

// ---------------------------------------------------------- frame arithmetic

describe('window and frame arithmetic', () => {
  it('window start frames follow trunc(i·16000/270 + 0.5)', () => {
    // 59.26 → 59 ; 118.52 + 0.5 → 119 ; 177.78 + 0.5 → 178 ; 296.3 → 296
    expect(windowStartFrame(0)).toBe(0);
    expect(windowStartFrame(1)).toBe(59);
    expect(windowStartFrame(2)).toBe(119);
    expect(windowStartFrame(3)).toBe(178);
    expect(windowStartFrame(5)).toBe(296);
  });

  it('total frames follow trunc((160000 + (W−1)·16000)/270) + 1', () => {
    expect(totalFrameCount(0)).toBe(0);
    expect(totalFrameCount(1)).toBe(593);
    expect(totalFrameCount(2)).toBe(652);
    expect(totalFrameCount(3)).toBe(712);
  });

  it('three windows: 184,000 samples = two full windows plus a padded tail', () => {
    const total = SEG_WINDOW + SEG_SHIFT + 8000;
    expect(hasPaddedLastWindow(total)).toBe(true);
    expect(expectedWindowCount(total)).toBe(3);
    // the reference truncates the assembled range at trunc(audio / 270)
    expect(assembledFrameCount(total, 3)).toBe(681);
    expect(assembledFrameCount(total, 3)).toBeLessThan(totalFrameCount(3));
  });

  it('an exact fit has no padded window and keeps the full frame range', () => {
    expect(hasPaddedLastWindow(TWO_WINDOWS)).toBe(false);
    expect(expectedWindowCount(TWO_WINDOWS)).toBe(2);
    expect(assembledFrameCount(TWO_WINDOWS, 2)).toBe(652);
    // one sample past the fit: a third, padded window appears
    expect(hasPaddedLastWindow(TWO_WINDOWS + 1)).toBe(true);
    expect(expectedWindowCount(TWO_WINDOWS + 1)).toBe(3);
  });

  it('audio shorter than one window is one padded window', () => {
    expect(hasPaddedLastWindow(SEG_WINDOW - 1)).toBe(true);
    expect(expectedWindowCount(SEG_WINDOW - 1)).toBe(1);
    expect(expectedWindowCount(SEG_WINDOW)).toBe(1);
    expect(assembledFrameCount(0, 1)).toBe(0);
  });

  it('frame → 16 kHz sample is frame·270 + 991/2 (the receptive-field centre)', () => {
    expect(frameToSample16k(0)).toBe(495.5);
    expect(frameToSample16k(20)).toBe(20 * 270 + 495.5);
    expect(frameToSample16k(250) - frameToSample16k(20)).toBe(230 * 270);
  });

  it('fragment samples follow trunc(frame/589·160000) + i·16000 (the reference sample_offset)', () => {
    expect(fragmentSampleRange(0, 0, 589)).toEqual({ start: 0, end: 160000 });
    // 100/589·160000 = 27164.68 → 27164 ; 200/589·160000 = 54329.37 → 54329
    expect(fragmentSampleRange(0, 100, 200)).toEqual({ start: 27164, end: 54329 });
    expect(fragmentSampleRange(3, 100, 200)).toEqual({ start: 27164 + 48000, end: 54329 + 48000 });
  });
});

// ------------------------------------------------------- powerset and spans

describe('powersetToLocal', () => {
  it('expands class bytes to the three local speakers', () => {
    const w = windowOf([
      [1, 0, 2],
      [4, 2, 4],
      [6, 4, 5],
    ]);
    const local = powersetToLocal(w);
    expect(local).toHaveLength(SEG_FRAMES * LOCAL_SPEAKERS);
    expect(Array.from(local.subarray(0, 15))).toEqual([1, 0, 0, 1, 0, 0, 1, 1, 0, 1, 1, 0, 0, 1, 1]);
    expect(Array.from(local.subarray(15, 18))).toEqual([0, 0, 0]);
  });

  it('refuses a class byte outside the seven classes', () => {
    const w = new Uint8Array(SEG_FRAMES);
    w[3] = 7;
    expect(() => powersetToLocal(w)).toThrow(/class/);
  });

  it('refuses a window that is not 589 frames', () => {
    expect(() => powersetToLocal(new Uint8Array(588))).toThrow(/589/);
  });
});

describe('localSpeakerSpans and the ≥ 10-frame rule', () => {
  it('returns half-open frame spans per local speaker', () => {
    const w = windowOf([
      [1, 100, 200],
      [4, 300, 320],
      [2, 320, 350],
    ]);
    expect(localSpeakerSpans(w, 0)).toEqual([
      { startFrame: 100, endFrame: 200 },
      { startFrame: 300, endFrame: 320 },
    ]);
    expect(localSpeakerSpans(w, 1)).toEqual([{ startFrame: 300, endFrame: 350 }]);
    expect(localSpeakerSpans(w, 2)).toEqual([]);
  });

  it('a run that reaches the last frame ends at F−1 (the reference tail rule)', () => {
    const w = windowOf([[1, 500, SEG_FRAMES]]);
    expect(localSpeakerSpans(w, 0)).toEqual([{ startFrame: 500, endFrame: SEG_FRAMES - 1 }]);
    // active frames still count the last frame: 89, while the span covers 88
    expect(embeddableFragments(w)).toEqual([{ localSpeaker: 0, activeFrames: 89, spans: [{ startFrame: 500, endFrame: 588 }] }]);
  });

  it('a run of exactly the last frame is dropped (empty span)', () => {
    const w = windowOf([[2, SEG_FRAMES - 1, SEG_FRAMES]]);
    expect(localSpeakerSpans(w, 1)).toEqual([]);
  });

  it('9 active frames → no fragment; 10 → embedded', () => {
    expect(embeddableFragments(windowOf([[1, 40, 49]]))).toEqual([]);
    expect(embeddableFragments(windowOf([[1, 40, 50]]))).toEqual([
      { localSpeaker: 0, activeFrames: 10, spans: [{ startFrame: 40, endFrame: 50 }] },
    ]);
    // split runs add up: 6 + 4 = 10 embeds, 6 + 3 does not
    expect(embeddableFragments(windowOf([[3, 10, 16], [3, 30, 34]]))).toHaveLength(1);
    expect(embeddableFragments(windowOf([[3, 10, 16], [3, 30, 33]]))).toEqual([]);
  });
});

// ------------------------------------------------------- speakerCountPerFrame

describe('speakerCountPerFrame', () => {
  it('averages the local counts over the windows covering each frame and rounds half up', () => {
    // Speaker in window 0 only, frames 100..199. Window 1 (start 59) covers
    // them too and says 0 → mean 0.5 → 1. From frame 119 window 2 also
    // covers → mean 1/3 → 0.
    const windows = [windowOf([[1, 100, 200]]), new Uint8Array(SEG_FRAMES), new Uint8Array(SEG_FRAMES)];
    const spf = speakerCountPerFrame(windows);
    expect(spf).toHaveLength(totalFrameCount(3));
    expect(spf[99]).toBe(0);
    expect(spf[100]).toBe(1);
    expect(spf[118]).toBe(1);
    expect(spf[119]).toBe(0);
    expect(spf[199]).toBe(0);
  });

  it('an overlap class counts two speakers', () => {
    const spf = speakerCountPerFrame([windowOf([[4, 10, 20], [2, 20, 30]])]);
    expect(spf[15]).toBe(2);
    expect(spf[25]).toBe(1);
    expect(spf[35]).toBe(0);
    expect(spf).toHaveLength(593);
  });

  it('no windows → no frames', () => {
    expect(speakerCountPerFrame([])).toHaveLength(0);
  });
});

// --------------------------------------------------------- agglomerateAverage

describe('agglomerateAverage', () => {
  it('(a) three axis groups with the 0.02 wobble → three clusters at 0.55', () => {
    const vectors = [
      ...[1, 2, 3, 4].map((s) => unitVector(16, 0, s)),
      ...[5, 6, 7, 8].map((s) => unitVector(16, 3, s)),
      ...[9, 10, 11, 12].map((s) => unitVector(16, 9, s)),
    ];
    const { labels, clusterCount } = agglomerateAverage(vectors, { threshold: DIARIZE_THRESHOLD });
    expect(clusterCount).toBe(3);
    expect(partition(labels)).toEqual([
      [0, 1, 2, 3],
      [4, 5, 6, 7],
      [8, 9, 10, 11],
    ]);
    // labels renumber by first appearance
    expect(labels.slice(0, 4)).toEqual([0, 0, 0, 0]);
    expect(labels[4]).toBe(1);
    expect(labels[8]).toBe(2);
  });

  it('(b) the linkage-discriminating chain A–B 0.45, B–C 0.45, A–C 0.95 → exactly two clusters', () => {
    // B = e0 ; A and C at 56.6° from B ; the A–C angle chosen so cos(A,C) = 0.05.
    const cosAB = 0.55;
    const sinAB = Math.sqrt(1 - cosAB * cosAB);
    const cosPhi = (0.05 - cosAB * cosAB) / (sinAB * sinAB);
    const sinPhi = Math.sqrt(1 - cosPhi * cosPhi);
    const A = new Float32Array([cosAB, sinAB, 0]);
    const B = new Float32Array([1, 0, 0]);
    const C = new Float32Array([cosAB, sinAB * cosPhi, sinAB * sinPhi]);
    expect(cosineDistance(A, B)).toBeCloseTo(0.45, 5);
    expect(cosineDistance(B, C)).toBeCloseTo(0.45, 5);
    expect(cosineDistance(A, C)).toBeCloseTo(0.95, 5);
    // A–B merge first (0.45 ≤ 0.55); then average({A,B}, C) = (0.45 + 0.95)/2 = 0.70 > 0.55.
    // Single linkage would see 0.45 and merge everything into one cluster.
    const { labels, clusterCount } = agglomerateAverage([A, B, C], { threshold: DIARIZE_THRESHOLD });
    expect(clusterCount).toBe(2);
    expect(partition(labels)).toEqual([[0, 1], [2]]);
  });

  it('(b′) average also differs from complete: {A,B} to C at 0.50/0.58 averages 0.54 and merges', () => {
    // A = e0, B at d 0.02 from A (11.5°), C at d 0.50 from A (60°) and d 0.58
    // from B (65.2°) — feasible because 65.2 − 60 < 11.5. Complete linkage
    // would see 0.58 > 0.55 and keep C apart; average sees 0.54 and merges.
    const cosB = 0.98;
    const sinB = Math.sqrt(1 - cosB * cosB);
    const cosG = 0.5;
    const sinG = Math.sqrt(1 - cosG * cosG);
    const cosPhi = (0.42 - cosB * cosG) / (sinB * sinG);
    const sinPhi = Math.sqrt(1 - cosPhi * cosPhi);
    const A = new Float32Array([1, 0, 0]);
    const B = new Float32Array([cosB, sinB, 0]);
    const C = new Float32Array([cosG, sinG * cosPhi, sinG * sinPhi]);
    expect(cosineDistance(A, B)).toBeCloseTo(0.02, 5);
    expect(cosineDistance(A, C)).toBeCloseTo(0.5, 5);
    expect(cosineDistance(B, C)).toBeCloseTo(0.58, 5);
    const { clusterCount } = agglomerateAverage([A, B, C], { threshold: DIARIZE_THRESHOLD });
    expect(clusterCount).toBe(1);
  });

  // (b″) The Lance–Williams update is SIZE-WEIGHTED (UPGMA):
  //   D(I∪J, K) = (nI·D(I,K) + nJ·D(J,K)) / (nI + nJ).
  // Every fixture above merges equal-size groups, where that collapses to the
  // plain mean (WPGMA) — so none of them can tell the shipped rule from the
  // likeliest wrong one. These two do: a 3-member cluster against a singleton,
  // with the two rules straddling 0.55 in BOTH directions. Merge order is
  // forced by the distances (P1+P2 at 0.05, then P3 at 0.10, then Q), so after
  // the second merge UPGMA reads (2·d(P,Q) + d(P3,Q))/3 while WPGMA reads
  // (d(P,Q) + d(P3,Q))/2.
  it('(b″) size-weighted linkage merges a 3-member cluster a plain mean would keep apart', () => {
    const [p1, p2, p3, q] = threeAndOne(0.05, 0.1, 0.4, 0.75);
    expect(cosineDistance(p1, p2)).toBeCloseTo(0.05, 5);
    expect(cosineDistance(p1, p3)).toBeCloseTo(0.1, 5);
    expect(cosineDistance(p2, p3)).toBeCloseTo(0.1, 5);
    expect(cosineDistance(p1, q)).toBeCloseTo(0.4, 5);
    expect(cosineDistance(p2, q)).toBeCloseTo(0.4, 5);
    expect(cosineDistance(p3, q)).toBeCloseTo(0.75, 5);
    expect((2 * 0.4 + 0.75) / 3).toBeLessThanOrEqual(DIARIZE_THRESHOLD); // UPGMA 0.5167
    expect((0.4 + 0.75) / 2).toBeGreaterThan(DIARIZE_THRESHOLD); // WPGMA 0.575
    const { labels, clusterCount } = agglomerateAverage([p1, p2, p3, q], { threshold: DIARIZE_THRESHOLD });
    expect(clusterCount).toBe(1);
    expect(labels).toEqual([0, 0, 0, 0]);
  });

  it('(b″) and keeps apart a singleton a plain mean would pull in', () => {
    const [p1, p2, p3, q] = threeAndOne(0.05, 0.1, 0.7, 0.35);
    expect(cosineDistance(p1, q)).toBeCloseTo(0.7, 5);
    expect(cosineDistance(p2, q)).toBeCloseTo(0.7, 5);
    expect(cosineDistance(p3, q)).toBeCloseTo(0.35, 5);
    expect((2 * 0.7 + 0.35) / 3).toBeGreaterThan(DIARIZE_THRESHOLD); // UPGMA 0.5833
    expect((0.7 + 0.35) / 2).toBeLessThanOrEqual(DIARIZE_THRESHOLD); // WPGMA 0.525
    const { labels, clusterCount } = agglomerateAverage([p1, p2, p3, q], { threshold: DIARIZE_THRESHOLD });
    expect(clusterCount).toBe(2);
    expect(partition(labels)).toEqual([[0, 1, 2], [3]]);
  });

  it('(c) threshold boundary on two pairs: cross 0.53 merges, cross 0.57 stays apart', () => {
    // Two TIGHT pairs (within-pair d ≈ 0.001, tilted into unused axes) whose
    // four cross distances average 1 − 0.9995·c: 0.5302 for c = 0.47 and
    // 0.5702 for c = 0.43.
    const tilt = 0.999;
    const tiltS = Math.sqrt(1 - tilt * tilt);
    const pairAt = (c: number): Float32Array[] => {
      const s = Math.sqrt(1 - c * c);
      return [
        new Float32Array([1, 0, 0, 0]),
        new Float32Array([tilt, 0, 0, tiltS]),
        new Float32Array([c, s, 0, 0]),
        new Float32Array([c, s * tilt, s * tiltS, 0]),
      ];
    };
    const nearPair = pairAt(0.47);
    expect(cosineDistance(nearPair[0], nearPair[1])).toBeLessThan(0.002);
    expect(cosineDistance(nearPair[2], nearPair[3])).toBeLessThan(0.002);
    expect(cosineDistance(nearPair[0], nearPair[2])).toBeCloseTo(0.53, 5);
    const near = agglomerateAverage(nearPair, { threshold: DIARIZE_THRESHOLD });
    expect(near.clusterCount).toBe(1);
    const farPair = pairAt(0.43);
    expect(cosineDistance(farPair[0], farPair[2])).toBeCloseTo(0.57, 5);
    const far = agglomerateAverage(farPair, { threshold: DIARIZE_THRESHOLD });
    expect(far.clusterCount).toBe(2);
    expect(partition(far.labels)).toEqual([
      [0, 1],
      [2, 3],
    ]);
  });

  it('(c) a cross distance of exactly the threshold merges; one step past it does not', () => {
    const a = atCosine(1);
    const b = atCosine(0.45);
    const exact = cosineDistance(a, b);
    expect(Math.abs(exact - 0.55)).toBeLessThan(1e-6);
    expect(agglomerateAverage([a, b], { threshold: exact }).clusterCount).toBe(1);
    expect(agglomerateAverage([a, b], { threshold: exact - 1e-9 }).clusterCount).toBe(2);
    // d = 0.55 + 1e-6 against the shipped 0.55: apart
    const past = atCosine(0.45 - 1e-6);
    expect(cosineDistance(a, past)).toBeGreaterThan(0.55);
    expect(agglomerateAverage([a, past], { threshold: DIARIZE_THRESHOLD }).clusterCount).toBe(2);
    // and d = 0.55 − 1e-6: merged
    const before = atCosine(0.45 + 1e-6);
    expect(cosineDistance(a, before)).toBeLessThan(0.55);
    expect(agglomerateAverage([a, before], { threshold: DIARIZE_THRESHOLD }).clusterCount).toBe(1);
  });

  it('(d) the shipped threshold is the sweep plateau centre', () => {
    expect(DIARIZE_THRESHOLD).toBe(0.55);
  });

  it('(e) the partition is deterministic and independent of input order', () => {
    const groups = [0, 5, 11];
    const ordered: { g: number; v: Float32Array }[] = [];
    groups.forEach((ax, gi) => {
      for (let m = 0; m < 5; m++) ordered.push({ g: gi, v: unitVector(16, ax, 100 * gi + m + 1) });
    });
    const rand = lcg(7);
    const shuffled = ordered.slice();
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    expect(shuffled.map((x) => x.g)).not.toEqual(ordered.map((x) => x.g));
    const run1 = agglomerateAverage(shuffled.map((x) => x.v), { threshold: DIARIZE_THRESHOLD });
    const run2 = agglomerateAverage(shuffled.map((x) => x.v), { threshold: DIARIZE_THRESHOLD });
    expect(run1.labels).toEqual(run2.labels);
    expect(run1.clusterCount).toBe(3);
    // same group ⇔ same label, whatever the order
    for (let i = 0; i < shuffled.length; i++) {
      for (let j = 0; j < shuffled.length; j++) {
        expect(run1.labels[i] === run1.labels[j]).toBe(shuffled[i].g === shuffled[j].g);
      }
    }
    expect(run1.labels[0]).toBe(0);
  });

  it('(f) n = 1,300 unit vectors (the 15-minute cap) cluster into the four voices, well inside a smoke bound', () => {
    // Four voices at 256-d with per-dimension noise of ±0.05 (noise norm ≈
    // 0.46, so within-voice d ≈ 0.18 and cross-voice d ≈ 1): the real
    // shape — nearly every fragment merges, ~1,296 merges in all.
    //
    // The partition (four clusters) is the assertion that matters. The time is
    // a SMOKE bound, not a benchmark: it exists to catch an algorithmic
    // regression — dropping the nearest-neighbour cache turns each of ~1,296
    // merges into a full O(n²) rescan, orders of magnitude more work — and it
    // must not measure machine load. Measured here at 318–385 ms over nine
    // isolated runs; review measured the SAME fixture at up to 1,909 ms inside
    // a loaded `--maxWorkers=14` full-file run, which is why the original
    // 1,000 ms pin failed two runs in five. 5,000 ms is ~13× the isolated
    // median and ~2.6× that worst observed spike. The per-test timeout is
    // raised past it so a slow machine fails the bound with its measurement
    // rather than a bare jest timeout.
    const rand = lcg(2026);
    const vectors: Float32Array[] = [];
    for (let i = 0; i < 1300; i++) {
      const v = new Float32Array(256);
      const ax = i % 4;
      for (let d = 0; d < 256; d++) v[d] = (rand() - 0.5) * 0.1;
      v[ax * 50] += 1;
      vectors.push(v);
    }
    const t0 = performance.now();
    const { clusterCount } = agglomerateAverage(vectors, { threshold: DIARIZE_THRESHOLD });
    const ms = performance.now() - t0;
    expect(clusterCount).toBe(4);
    expect(ms).toBeLessThan(5000);
  }, 30_000);

  it('degenerate inputs: none → none, one → one cluster', () => {
    expect(agglomerateAverage([], { threshold: DIARIZE_THRESHOLD })).toEqual({ labels: [], clusterCount: 0 });
    expect(agglomerateAverage([unitVector(4, 1, 3)], { threshold: DIARIZE_THRESHOLD })).toEqual({ labels: [0], clusterCount: 1 });
  });
});

// ---------------------------------------------------------- foldSmallClusters

describe('foldSmallClusters', () => {
  it('moves a 3-member cluster in n = 20 WHOLE to the nearest large centroid', () => {
    // 10 on axis 0, 7 on axis 1, 3 leaning towards axis 1 as a CENTROID even
    // though one member alone sits closer to axis 0 — per-member folding would
    // split it; pyannote's 10 %-of-n cap would make m = 2 and not fold at all.
    const dim = 4;
    const big = Array.from({ length: 10 }, (_, s) => unitVector(dim, 0, 200 + s));
    const mid = Array.from({ length: 7 }, (_, s) => unitVector(dim, 1, 300 + s));
    const small = [
      new Float32Array([0.3, 0.95, 0, 0]),
      new Float32Array([0.3, 0.95, 0, 0.05]),
      new Float32Array([0.95, 0.3, 0, 0]),
    ];
    const vectors = [...big, ...mid, ...small];
    const labels = [...big.map(() => 0), ...mid.map(() => 1), ...small.map(() => 2)];
    const out = foldSmallClusters(labels, vectors, { minClusterSize: MIN_CLUSTER_SIZE });
    expect(out.slice(17)).toEqual([1, 1, 1]);
    expect(partition(out)).toEqual([[0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [10, 11, 12, 13, 14, 15, 16, 17, 18, 19]]);
    // the member that alone would have gone to axis 0
    expect(cosineDistance(small[2], big[0])).toBeLessThan(cosineDistance(small[2], mid[0]));
  });

  it('a cluster of exactly minClusterSize stays; one member fewer folds', () => {
    const dim = 4;
    const big = Array.from({ length: 6 }, (_, s) => unitVector(dim, 0, 400 + s));
    const four = Array.from({ length: 4 }, (_, s) => unitVector(dim, 2, 500 + s));
    const keep = foldSmallClusters([...big.map(() => 0), ...four.map(() => 1)], [...big, ...four], { minClusterSize: 4 });
    expect(partition(keep)).toEqual([[0, 1, 2, 3, 4, 5], [6, 7, 8, 9]]);
    const three = four.slice(0, 3);
    const fold = foldSmallClusters([...big.map(() => 0), ...three.map(() => 1)], [...big, ...three], { minClusterSize: 4 });
    expect(fold).toEqual(new Array(9).fill(0));
  });

  it('all clusters small → everything joins the largest', () => {
    const vectors = [unitVector(4, 0, 1), unitVector(4, 0, 2), unitVector(4, 1, 3), unitVector(4, 1, 4), unitVector(4, 2, 5)];
    const out = foldSmallClusters([2, 2, 5, 5, 9], vectors, { minClusterSize: 4 });
    expect(out).toEqual([0, 0, 0, 0, 0]);
  });

  it('minClusterSize 1 is a no-op', () => {
    const vectors = [unitVector(4, 0, 1), unitVector(4, 0, 2), unitVector(4, 1, 3), unitVector(4, 2, 4)];
    expect(foldSmallClusters([0, 0, 1, 2], vectors, { minClusterSize: 1 })).toEqual([0, 0, 1, 2]);
  });

  it('renumbers by first appearance and pins the shipped size', () => {
    const vectors = [unitVector(4, 1, 1), unitVector(4, 1, 2), unitVector(4, 1, 3), unitVector(4, 1, 4), unitVector(4, 0, 5)];
    expect(foldSmallClusters([7, 7, 7, 7, 3], vectors, { minClusterSize: 4 })).toEqual([0, 0, 0, 0, 0]);
    expect(MIN_CLUSTER_SIZE).toBe(4);
  });

  it('refuses mismatched labels and vectors', () => {
    expect(() => foldSmallClusters([0, 0], [unitVector(4, 0, 1)], { minClusterSize: 4 })).toThrow(/labels/);
  });
});

// ------------------------------------------------------- mergeAndFilterSpans16k

describe('mergeAndFilterSpans16k (the reference min_duration_off / min_duration_on)', () => {
  const s = MODEL_SAMPLE_RATE;
  it('a gap of exactly 0.5 s merges; 0.6 s does not', () => {
    const merged = mergeAndFilterSpans16k([{ start: 0, end: 1 * s }, { start: 1.5 * s, end: 2.5 * s }]);
    expect(merged).toEqual([{ start: 0, end: 2.5 * s }]);
    const apart = mergeAndFilterSpans16k([{ start: 0, end: 1 * s }, { start: 1.6 * s, end: 2.6 * s }]);
    expect(apart).toEqual([{ start: 0, end: 1 * s }, { start: 1.6 * s, end: 2.6 * s }]);
    // one step past the gap
    expect(mergeAndFilterSpans16k([{ start: 0, end: 1 * s }, { start: 1.5 * s + 1, end: 2.5 * s }])).toHaveLength(2);
  });

  it('a span of exactly 0.3 s is kept; 0.25 s is dropped; one sample short is dropped', () => {
    expect(mergeAndFilterSpans16k([{ start: 2 * s, end: 2.3 * s }])).toEqual([{ start: 2 * s, end: 2.3 * s }]);
    expect(mergeAndFilterSpans16k([{ start: 2 * s, end: 2.25 * s }])).toEqual([]);
    expect(mergeAndFilterSpans16k([{ start: 2 * s, end: 2.3 * s - 1 }])).toEqual([]);
  });

  it('merges BEFORE filtering, so two short spans across a small gap survive together', () => {
    expect(mergeAndFilterSpans16k([{ start: 0, end: 0.2 * s }, { start: 0.5 * s, end: 0.7 * s }])).toEqual([{ start: 0, end: 0.7 * s }]);
  });
});

// ------------------------------------------------------------ the assembly

describe('assembleDiarization', () => {
  const dim = 8;
  const A = axis(dim, 0);
  const B = axis(dim, 1);

  it('two-window evidence, forced k = 2 → two speakers with bounds from the constants', () => {
    const ev = evidenceFromTimeline(TWO_WINDOWS, [
      { direction: A, spans: [[20, 250]] },
      { direction: B, spans: [[300, 520]] },
    ]);
    expect(ev.windows).toHaveLength(2);
    expect(ev.embeddings).toHaveLength(4);
    const d = assembleDiarization(ev, { speakerCount: 2 });
    expect(d.speakerCount).toBe(2);
    expect(d.segments).toEqual([
      { startSample16k: 20 * 270 + 495.5, endSample16k: 250 * 270 + 495.5, speaker: 0 },
      { startSample16k: 300 * 270 + 495.5, endSample16k: 520 * 270 + 495.5, speaker: 1 },
    ]);
    expect(d.speechSeconds[0]).toBeCloseTo((230 * 270) / 16000, 9);
    expect(d.speechSeconds[1]).toBeCloseTo((220 * 270) / 16000, 9);
    expect(d.overlapSegments).toEqual([]);
    expect(d.preFoldClusterCount).toBe(2);
    expect(d.rawClusterCount).toBe(2);
  });

  it('the same two-window evidence under the auto policy folds to ONE speaker (2 fragments per voice < 4)', () => {
    const ev = evidenceFromTimeline(TWO_WINDOWS, [
      { direction: A, spans: [[20, 250]] },
      { direction: B, spans: [[300, 520]] },
    ]);
    const d = assembleDiarization(ev);
    expect(d.preFoldClusterCount).toBe(2);
    expect(d.rawClusterCount).toBe(1);
    expect(d.speakerCount).toBe(1);
    expect(d.speechSeconds).toHaveLength(1);
    expect(d.speechSeconds[0]).toBeCloseTo(((230 + 220) * 270) / 16000, 9);
  });

  it('four windows, auto policy → two speakers; speech seconds match the active frames', () => {
    const ev = evidenceFromTimeline(FOUR_WINDOWS, [
      { direction: A, spans: [[20, 250]] },
      { direction: B, spans: [[300, 520]] },
    ]);
    expect(ev.embeddings).toHaveLength(8);
    const d = assembleDiarization(ev);
    expect(d.speakerCount).toBe(2);
    expect(d.preFoldClusterCount).toBe(2);
    expect(d.rawClusterCount).toBe(2);
    expect(segmentsOf(d, 0)).toEqual([{ start: f16(20), end: f16(250) }]);
    expect(segmentsOf(d, 1)).toEqual([{ start: f16(300), end: f16(520) }]);
    expect(Math.abs(d.speechSeconds[0] - 230 * FRAME_S)).toBeLessThan(FRAME_S);
    expect(Math.abs(d.speechSeconds[1] - 220 * FRAME_S)).toBeLessThan(FRAME_S);
    // the (f) partition from a different order: speaker 0 is whoever speaks first
    expect(d.segments[0].speaker).toBe(0);
  });

  it('overlap classes → both speakers active and an overlapSegments entry naming both', () => {
    const ev = evidenceFromTimeline(FOUR_WINDOWS, [
      { direction: A, spans: [[20, 250]] },
      { direction: B, spans: [[200, 520]] },
    ]);
    expect(speakerCountPerFrame(ev.windows)[225]).toBe(2);
    const d = assembleDiarization(ev);
    expect(d.speakerCount).toBe(2);
    expect(segmentsOf(d, 0)).toEqual([{ start: f16(20), end: f16(250) }]);
    expect(segmentsOf(d, 1)).toEqual([{ start: f16(200), end: f16(520) }]);
    expect(d.overlapSegments).toEqual([{ startSample16k: f16(200), endSample16k: f16(250), speakers: [0, 1] }]);
  });

  it('MIN_ON_S: a 15-frame blip (0.253 s) is dropped, an 18-frame one (0.304 s) is kept', () => {
    const dropped = assembleDiarization(
      evidenceFromTimeline(FOUR_WINDOWS, [
        { direction: A, spans: [[20, 250], [400, 415]] },
        { direction: B, spans: [[450, 700]] },
      ])
    );
    expect(dropped.speakerCount).toBe(2);
    expect(segmentsOf(dropped, 0)).toEqual([{ start: f16(20), end: f16(250) }]);
    const kept = assembleDiarization(
      evidenceFromTimeline(FOUR_WINDOWS, [
        { direction: A, spans: [[20, 250], [400, 418]] },
        { direction: B, spans: [[450, 700]] },
      ])
    );
    expect(segmentsOf(kept, 0)).toEqual([
      { start: f16(20), end: f16(250) },
      { start: f16(400), end: f16(418) },
    ]);
    expect(18 * FRAME_S).toBeGreaterThanOrEqual(MIN_ON_S);
    expect(15 * FRAME_S).toBeLessThan(MIN_ON_S);
  });

  it('MIN_OFF_S: a 29-frame gap (0.489 s) merges, a 30-frame gap (0.506 s) does not', () => {
    const merged = assembleDiarization(
      evidenceFromTimeline(FOUR_WINDOWS, [
        { direction: A, spans: [[20, 250], [279, 400]] },
        { direction: B, spans: [[450, 700]] },
      ])
    );
    expect(segmentsOf(merged, 0)).toEqual([{ start: f16(20), end: f16(400) }]);
    const apart = assembleDiarization(
      evidenceFromTimeline(FOUR_WINDOWS, [
        { direction: A, spans: [[20, 250], [280, 400]] },
        { direction: B, spans: [[450, 700]] },
      ])
    );
    expect(segmentsOf(apart, 0)).toEqual([
      { start: f16(20), end: f16(250) },
      { start: f16(280), end: f16(400) },
    ]);
    expect(29 * FRAME_S).toBeLessThanOrEqual(MIN_OFF_S);
    expect(30 * FRAME_S).toBeGreaterThan(MIN_OFF_S);
  });

  it('share floor: a 3 %-share cluster triggers the forced re-run and its frames land in a survivor', () => {
    // C tilts towards B (cos 0.4 → d 0.6 > 0.55, so it is its own cluster) so
    // the Ward re-run at k = 2 has an unambiguous nearest neighbour.
    const C = new Float32Array(dim);
    C[1] = 0.4;
    C[2] = Math.sqrt(1 - 0.16);
    const ev = evidenceFromTimeline(FOUR_WINDOWS, [
      { direction: A, spans: [[10, 380]] },
      { direction: B, spans: [[460, 760]] },
      { direction: C, spans: [[400, 424]] },
    ]);
    const cFragments = ev.embeddings.filter((e) => cosineDistance(e.vector, C) < 0.01);
    expect(cFragments).toHaveLength(4);
    const d = assembleDiarization(ev);
    expect(d.preFoldClusterCount).toBe(3);
    expect(d.rawClusterCount).toBe(3);
    expect(d.speakerCount).toBe(2);
    const total = (370 + 24 + 300) * FRAME_S;
    expect(Math.abs(d.speechSeconds.reduce((a, b) => a + b, 0) - total)).toBeLessThan(FRAME_S);
    // C's frames are now speaker 1's (B's) — never lost
    expect(segmentsOf(d, 1)).toEqual([
      { start: f16(400), end: f16(424) },
      { start: f16(460), end: f16(760) },
    ]);
    expect(segmentsOf(d, 0)).toEqual([{ start: f16(10), end: f16(380) }]);
    // the pre-floor share that tripped it
    expect((24 * FRAME_S) / total).toBeLessThan(MIN_SPEAKER_SHARE);
    // direct: the floor reports the refit and hands back two clusters
    const pre = agglomerateAverage(ev.embeddings.map((e) => e.vector), { threshold: DIARIZE_THRESHOLD }).labels;
    const floored = applyShareFloor(ev, pre);
    expect(floored.refit).toBe(true);
    expect(new Set(floored.labels).size).toBe(2);
  });

  it('share floor leaves a balanced result alone', () => {
    const ev = evidenceFromTimeline(FOUR_WINDOWS, [
      { direction: A, spans: [[20, 250]] },
      { direction: B, spans: [[300, 520]] },
    ]);
    const pre = agglomerateAverage(ev.embeddings.map((e) => e.vector), { threshold: DIARIZE_THRESHOLD }).labels;
    const floored = applyShareFloor(ev, pre);
    expect(floored.refit).toBe(false);
    expect(floored.labels).toEqual(pre);
  });

  it('preFoldClusterCount vs rawClusterCount: a 3-fragment voice folds away', () => {
    // C at frames 600..640 is covered by windows 1, 2, 3 only → 3 fragments < 4.
    const C = axis(dim, 2);
    const ev = evidenceFromTimeline(FOUR_WINDOWS, [
      { direction: A, spans: [[20, 250]] },
      { direction: B, spans: [[300, 520]] },
      { direction: C, spans: [[600, 640]] },
    ]);
    expect(ev.embeddings.filter((e) => cosineDistance(e.vector, C) < 0.01)).toHaveLength(3);
    const d = assembleDiarization(ev);
    expect(d.preFoldClusterCount).toBe(3);
    expect(d.rawClusterCount).toBe(2);
    expect(d.speakerCount).toBe(2);
    // C's 40 frames went to one of the two survivors, not nowhere
    expect(Math.abs(d.speechSeconds.reduce((a, b) => a + b, 0) - (230 + 220 + 40) * FRAME_S)).toBeLessThan(FRAME_S);
  });

  it('an auto count above MAX_SPEAKERS is forced to 6', () => {
    // Seven voices taking 300-frame turns: any 10 s window holds at most three.
    const total = SEG_WINDOW + 26 * SEG_SHIFT;
    const speakers: SpeakerLine[] = Array.from({ length: 7 }, (_, k) => ({
      direction: axis(dim, k),
      spans: [[10 + 300 * k, 10 + 300 * (k + 1)]] as [number, number][],
    }));
    const ev = evidenceFromTimeline(total, speakers);
    const d = assembleDiarization(ev);
    expect(d.preFoldClusterCount).toBe(7);
    expect(d.rawClusterCount).toBe(7);
    expect(d.speakerCount).toBe(MAX_SPEAKERS);
    expect(d.speechSeconds).toHaveLength(6);
    expect(Math.abs(d.speechSeconds.reduce((a, b) => a + b, 0) - 7 * 300 * FRAME_S)).toBeLessThan(2 * FRAME_S);
  });

  it('truncates the padded last window at trunc(audio / 270) and ends the tail run at F−1', () => {
    // 184,000 samples → frames 0..680 assembled; window 2 (start 119) still
    // reports frames up to 707. A run through the end is cut at 680 and, per
    // the reference, the closing segment ends at the LAST assembled frame.
    const total = SEG_WINDOW + SEG_SHIFT + 8000;
    const ev = evidenceFromTimeline(total, [
      { direction: A, spans: [[20, 250]] },
      { direction: B, spans: [[600, 707]] },
    ]);
    expect(ev.windows).toHaveLength(3);
    const d = assembleDiarization(ev, { speakerCount: 2 });
    expect(segmentsOf(d, 1)).toEqual([{ start: f16(600), end: f16(680) }]);
    expect(assembledFrameCount(total, 3)).toBe(681);
  });

  it('segments are sorted by start and speakers numbered by first appearance', () => {
    const ev = evidenceFromTimeline(FOUR_WINDOWS, [
      { direction: A, spans: [[300, 520]] },
      { direction: B, spans: [[20, 250]] },
    ]);
    const d = assembleDiarization(ev);
    expect(d.segments.map((s) => s.speaker)).toEqual([0, 1]);
    expect(d.segments[0].startSample16k).toBe(f16(20));
  });

  it('refuses malformed evidence instead of assembling garbage', () => {
    const ev = evidenceFromTimeline(TWO_WINDOWS, [{ direction: A, spans: [[20, 250]] }]);
    expect(() => assembleDiarization({ ...ev, embeddings: [{ ...ev.embeddings[0], windowIndex: 2 }] })).toThrow(/windowIndex/);
    expect(() => assembleDiarization({ ...ev, embeddings: [{ ...ev.embeddings[0], localSpeaker: 3 }] })).toThrow(/localSpeaker/);
    expect(() => assembleDiarization({ ...ev, windows: [ev.windows[0], new Uint8Array(10)] })).toThrow(/589/);
    expect(() => assembleDiarization(ev, { speakerCount: Number.NaN })).toThrow(/speakerCount/);
  });
});

// -------------------------------------------------- the vote across windows

describe('the per-frame vote across a window boundary', () => {
  /**
   * Every window covering a frame casts ONE vote per cluster it hears there
   * (the reference's `relabels[i, j, t] = 1`, saturated per window however
   * many local slots share the cluster, then `count[start:end] += this_chunk`
   * once per window). So a cluster heard by two windows at the same global
   * frame must score TWO — and the frame where two windows meet is exactly
   * where a per-window saturation can leak into the next window and eat one.
   *
   * The fixture is a three-way overlap at frame 59 = `windowStartFrame(1)`,
   * which the model cannot express (`powerset_max_classes` is 2), so the two
   * windows resolve it differently — the realistic disagreement the vote
   * exists to settle:
   *   truth   X 30..70, T 42..68, Y 59..130
   *   window 0 hears X 30..70 (slot 1), T 42..59 (slot 0), Y 60..130 (slot 2)
   *   window 1 hears T 59..68 (slot 0, exactly MIN_EMBED_FRAMES), Y 59..130 (slot 1)
   * Cluster ids are X = 0, Y = 1, T = 2, so T loses every tie: at frame 59 it
   * is kept only by scoring 2 against their 1. Its whole segment turns on that
   * one frame — 18 frames clears MIN_ON_S, 17 does not.
   */
  const TWO_WINDOW_SAMPLES = SEG_WINDOW + SEG_SHIFT;
  const dim = 6;
  const boundaryEvidence = (): DiarizationEvidence => ({
    totalSamples16k: TWO_WINDOW_SAMPLES,
    windows: [
      windowFromSlots(0, [[0, 42, 60], [1, 30, 71], [2, 60, 131]]),
      windowFromSlots(1, [[0, 59, 69], [1, 59, 131]]),
    ],
    embeddings: [
      { windowIndex: 0, localSpeaker: 1, activeFrames: 41, vector: axis(dim, 0) }, // X
      { windowIndex: 0, localSpeaker: 2, activeFrames: 71, vector: axis(dim, 1) }, // Y
      { windowIndex: 0, localSpeaker: 0, activeFrames: 18, vector: axis(dim, 2) }, // T
      { windowIndex: 1, localSpeaker: 0, activeFrames: MIN_EMBED_FRAMES, vector: axis(dim, 2) }, // T
      { windowIndex: 1, localSpeaker: 1, activeFrames: 72, vector: axis(dim, 1) }, // Y
    ],
  });
  /** X = 0, Y = 1, T = 2 — T last, so every tie at frame 59 goes against it. */
  const BOUNDARY_LABELS = [0, 1, 2, 2, 1];

  it('the boundary frame is shared and worth two speakers to both windows', () => {
    const ev = boundaryEvidence();
    expect(windowStartFrame(1)).toBe(59);
    expect(assembledFrameCount(TWO_WINDOW_SAMPLES, 2)).toBe(652);
    const spf = speakerCountPerFrame(ev.windows);
    // window 0 hears {T, X} at 59 and window 1 hears {T, Y}: mean 2
    expect(spf[59]).toBe(2);
    expect(spf[58]).toBe(2);
    expect(spf[60]).toBe(2);
    // one frame decides whether T's segment survives MIN_ON_S
    expect(18 * FRAME_S).toBeGreaterThanOrEqual(MIN_ON_S);
    expect(17 * FRAME_S).toBeLessThan(MIN_ON_S);
  });

  it('a cluster heard by both windows at the boundary frame keeps it — and its segment', () => {
    const floored = applyShareFloor(boundaryEvidence(), BOUNDARY_LABELS);
    expect(floored.refit).toBe(false);
    expect(floored.labels).toEqual(BOUNDARY_LABELS);
    // T (cluster 2) spans 42..59 inclusive: 18 frames, 4,860 samples.
    expect(floored.spans[2]).toEqual([{ start: f16(42), end: f16(60) }]);
    expect(floored.spans[2][0].end - floored.spans[2][0].start).toBe(18 * FRAME_SHIFT);
    // the two windows agree about the rest, and it is unaffected
    expect(floored.spans[0]).toEqual([{ start: f16(30), end: f16(71) }]);
    expect(floored.spans[1]).toEqual([{ start: f16(60), end: f16(131) }]);
    expect(floored.speechSeconds[2]).toBeCloseTo((18 * FRAME_SHIFT) / MODEL_SAMPLE_RATE, 9);
    // T's 13.8 % share clears the floor, so nothing here is the floor's doing
    const total = floored.speechSeconds.reduce((a, b) => a + b, 0);
    expect(floored.speechSeconds[2] / total).toBeGreaterThan(MIN_SPEAKER_SHARE);
  });

  it('the same evidence assembles T as a third speaker end to end', () => {
    const ev = boundaryEvidence();
    const d = assembleDiarization(ev, { speakerCount: 3 });
    expect(d.speakerCount).toBe(3);
    const t = d.segments.find((s) => s.startSample16k === f16(42));
    expect(t).toEqual({ startSample16k: f16(42), endSample16k: f16(60), speaker: expect.any(Number) });
    expect(d.speechSeconds[(t as DiarizationSegment).speaker]).toBeCloseTo((18 * FRAME_SHIFT) / MODEL_SAMPLE_RATE, 9);
  });
});

// ------------------------------------------------------------- degenerate

describe('degenerate evidence', () => {
  it('zero embeddings → the D3 empty object, no throw', () => {
    const ev: DiarizationEvidence = { totalSamples16k: TWO_WINDOWS, windows: [new Uint8Array(SEG_FRAMES), new Uint8Array(SEG_FRAMES)], embeddings: [] };
    expect(assembleDiarization(ev)).toEqual({
      speakerCount: 0,
      preFoldClusterCount: 0,
      rawClusterCount: 0,
      segments: [],
      overlapSegments: [],
      speechSeconds: [],
    });
    expect(reclusterDiarization(ev, 3)).toEqual(assembleDiarization(ev));
    expect(assembleDiarization({ totalSamples16k: 0, windows: [], embeddings: [] }).speakerCount).toBe(0);
  });

  it('one embedding → one speaker', () => {
    const ev = evidenceFromTimeline(SEG_WINDOW, [{ direction: axis(4, 0), spans: [[50, 200]] }]);
    expect(ev.embeddings).toHaveLength(1);
    const d = assembleDiarization(ev);
    expect(d.speakerCount).toBe(1);
    expect(d.segments).toEqual([{ startSample16k: f16(50), endSample16k: f16(200), speaker: 0 }]);
    expect(d.speechSeconds).toEqual([(150 * 270) / 16000]);
  });

  it('reclusterDiarization(evidence, 5) on 3 embeddings → 3 speakers', () => {
    const ev = evidenceFromTimeline(SEG_WINDOW, [
      { direction: axis(4, 0), spans: [[50, 200]] },
      { direction: axis(4, 1), spans: [[250, 400]] },
      { direction: axis(4, 2), spans: [[450, 580]] },
    ]);
    expect(ev.embeddings).toHaveLength(3);
    const d = reclusterDiarization(ev, 5);
    expect(d.speakerCount).toBe(3);
    expect(d.speechSeconds).toHaveLength(3);
    // and the auto policy on three singletons folds to one voice
    expect(assembleDiarization(ev).speakerCount).toBe(1);
    expect(assembleDiarization(ev).preFoldClusterCount).toBe(3);
  });
});

// ------------------------------------------------------- segmentsToDocSamples

describe('segmentsToDocSamples', () => {
  const d: Diarization = {
    speakerCount: 2,
    preFoldClusterCount: 2,
    rawClusterCount: 2,
    segments: [
      { startSample16k: f16(20), endSample16k: f16(250), speaker: 0 },
      { startSample16k: f16(300), endSample16k: f16(520), speaker: 1 },
      { startSample16k: f16(600), endSample16k: f16(640), speaker: 0 },
    ],
    overlapSegments: [],
    speechSeconds: [0, 0],
  };

  it('maps to 44.1 kHz with round(s16k · rate / 16000), per speaker', () => {
    const spans = segmentsToDocSamples(d, 44100, 10_000_000);
    expect(spans).toHaveLength(2);
    expect(spans[0]).toEqual([
      { startSample: Math.round((f16(20) * 44100) / 16000), endSample: Math.round((f16(250) * 44100) / 16000) },
      { startSample: Math.round((f16(600) * 44100) / 16000), endSample: Math.round((f16(640) * 44100) / 16000) },
    ]);
    expect(spans[1]).toEqual([{ startSample: Math.round((f16(300) * 44100) / 16000), endSample: Math.round((f16(520) * 44100) / 16000) }]);
    // concrete values, so a changed formula cannot hide behind the same expression
    expect(spans[0][0]).toEqual({ startSample: 16249, endSample: 187413 });
    expect(spans[0][0].startSample).not.toBe(f16(20));
  });

  it('clamps to the document length and drops what clamps away', () => {
    const cut = segmentsToDocSamples(d, 44100, 100_000);
    expect(cut[0]).toEqual([{ startSample: 16249, endSample: 100_000 }]);
    expect(cut[1]).toEqual([]);
  });

  it('gives every speaker an array even without segments', () => {
    const empty: Diarization = { ...d, speakerCount: 3, speechSeconds: [0, 0, 0] };
    expect(segmentsToDocSamples(empty, 16000, 10_000_000)).toHaveLength(3);
    expect(segmentsToDocSamples(empty, 16000, 10_000_000)[2]).toEqual([]);
  });

  it('at 16 kHz the positions round the half-sample centre up', () => {
    const same = segmentsToDocSamples(d, 16000, 10_000_000);
    expect(same[1]).toEqual([{ startSample: 300 * 270 + 496, endSample: 520 * 270 + 496 }]);
  });
});
