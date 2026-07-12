// Peak pyramid for waveform rendering.
//
// Level 0 (blockSize=256) is built directly from raw per-channel samples in
// a single pass. Each subsequent level (1024, 4096, 16384) is derived from
// the previous level by aggregating consecutive groups of 4 blocks, rather
// than re-scanning raw samples — this keeps buildPeaks close to O(n) even on
// multi-minute files with tens of millions of samples.

export interface PeakLevel {
  blockSize: number;
  min: Float32Array; // one entry per block
  max: Float32Array; // one entry per block
}

export interface PeakPyramid {
  levels: PeakLevel[]; // blockSizes 256, 1024, 4096, 16384
}

const BLOCK_SIZES = [256, 1024, 4096, 16384] as const;
const GROUP_FACTOR = 4; // each level's blockSize is 4x the previous
const RAW_SCAN_THRESHOLD = 256;

function buildBaseLevel(channel: Float32Array, blockSize: number): PeakLevel {
  const n = channel.length;
  const blockCount = n === 0 ? 0 : Math.ceil(n / blockSize);
  const min = new Float32Array(blockCount);
  const max = new Float32Array(blockCount);

  for (let block = 0; block < blockCount; block++) {
    const start = block * blockSize;
    const end = Math.min(start + blockSize, n); // last block may be partial
    let blockMin = channel[start];
    let blockMax = channel[start];
    for (let i = start + 1; i < end; i++) {
      const v = channel[i];
      if (v < blockMin) blockMin = v;
      if (v > blockMax) blockMax = v;
    }
    min[block] = blockMin;
    max[block] = blockMax;
  }

  return { blockSize, min, max };
}

function buildNextLevel(prev: PeakLevel, blockSize: number): PeakLevel {
  const prevCount = prev.min.length;
  const blockCount = Math.ceil(prevCount / GROUP_FACTOR);
  const min = new Float32Array(blockCount);
  const max = new Float32Array(blockCount);

  for (let block = 0; block < blockCount; block++) {
    const start = block * GROUP_FACTOR;
    const end = Math.min(start + GROUP_FACTOR, prevCount); // last group may be partial
    let blockMin = prev.min[start];
    let blockMax = prev.max[start];
    for (let i = start + 1; i < end; i++) {
      if (prev.min[i] < blockMin) blockMin = prev.min[i];
      if (prev.max[i] > blockMax) blockMax = prev.max[i];
    }
    min[block] = blockMin;
    max[block] = blockMax;
  }

  return { blockSize, min, max };
}

export function buildPeaks(channel: Float32Array): PeakPyramid {
  const levels: PeakLevel[] = [buildBaseLevel(channel, BLOCK_SIZES[0])];
  for (let i = 1; i < BLOCK_SIZES.length; i++) {
    levels.push(buildNextLevel(levels[i - 1], BLOCK_SIZES[i]));
  }
  return { levels };
}

function zeroBuckets(buckets: number): { min: Float32Array; max: Float32Array } {
  return { min: new Float32Array(buckets), max: new Float32Array(buckets) };
}

export function getPeaksForRange(
  pyramid: PeakPyramid,
  channel: Float32Array,
  startSample: number,
  endSample: number,
  buckets: number
): { min: Float32Array; max: Float32Array } {
  const length = channel.length;
  const start = Math.min(Math.max(startSample, 0), length);
  const end = Math.min(Math.max(endSample, 0), length);

  if (start >= end) {
    // Covers both an invalid/empty request and a request that lies entirely
    // beyond the channel end (both clamp to `length`, so start === end).
    return zeroBuckets(buckets);
  }

  const min = new Float32Array(buckets);
  const max = new Float32Array(buckets);
  const samplesPerBucket = (end - start) / buckets;

  if (samplesPerBucket < RAW_SCAN_THRESHOLD) {
    for (let i = 0; i < buckets; i++) {
      const bucketStart = Math.floor(start + i * samplesPerBucket);
      // Force the last bucket's end to the (already-clamped) `end` so
      // rounding never reads past real data or drops the final samples.
      const bucketEnd = i === buckets - 1 ? end : Math.floor(start + (i + 1) * samplesPerBucket);
      if (bucketEnd <= bucketStart) {
        if (bucketStart < length) {
          min[i] = channel[bucketStart];
          max[i] = channel[bucketStart];
        }
        continue;
      }
      let bucketMin = channel[bucketStart];
      let bucketMax = channel[bucketStart];
      for (let s = bucketStart + 1; s < bucketEnd; s++) {
        const v = channel[s];
        if (v < bucketMin) bucketMin = v;
        if (v > bucketMax) bucketMax = v;
      }
      min[i] = bucketMin;
      max[i] = bucketMax;
    }
    return { min, max };
  }

  // Pick the largest level whose blockSize <= samplesPerBucket, so each
  // bucket aggregates as few pre-computed blocks as possible.
  let level = pyramid.levels[0];
  for (const candidate of pyramid.levels) {
    if (candidate.blockSize <= samplesPerBucket) {
      level = candidate;
    }
  }
  const blockSize = level.blockSize;
  const blockCount = level.min.length;

  for (let i = 0; i < buckets; i++) {
    const bucketStartF = start + i * samplesPerBucket;
    const bucketEndF = start + (i + 1) * samplesPerBucket;

    // Aggregate every block overlapping [bucketStartF, bucketEndF). Block
    // boundaries generally don't line up with bucket boundaries, so this
    // can pull in a sliver of samples just outside the bucket at either
    // edge (partial block over-scan) — acceptable for waveform display.
    const firstBlock = Math.max(0, Math.floor(bucketStartF / blockSize));
    const lastBlock = Math.min(blockCount - 1, Math.ceil(bucketEndF / blockSize) - 1);

    if (firstBlock >= blockCount || firstBlock > lastBlock) {
      continue; // no data in range -> leave bucket as 0/0
    }

    let bucketMin = level.min[firstBlock];
    let bucketMax = level.max[firstBlock];
    for (let b = firstBlock + 1; b <= lastBlock; b++) {
      if (level.min[b] < bucketMin) bucketMin = level.min[b];
      if (level.max[b] > bucketMax) bucketMax = level.max[b];
    }
    min[i] = bucketMin;
    max[i] = bucketMax;
  }

  return { min, max };
}
