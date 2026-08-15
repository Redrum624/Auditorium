import { docLength, type AudioDocument } from '../audio/AudioDocument';
import type { Clip } from './session';

/**
 * MT2-2 — the sample-rate conversion of a clip, computed once instead of once
 * per play.
 *
 * A mixed-rate session is legal and stays legal: put a 44.1 kHz file on a
 * session that already holds 48 kHz clips and one of them has to be converted.
 * What was not legal was WHERE it happened — `MultitrackPlayer.play()` called
 * `readClipSlice` for every clip, synchronously, and the 64-tap sinc ran over
 * every sample of every clip before a single note was scheduled. Two 3-minute
 * stereo clips measured 22 039 ms.
 *
 * The samples do not change between plays, so this holds them.
 *
 * ---------------------------------------------------------------------------
 * THE KEY IS THE AUDIO, NOT THE DOCUMENT ID
 * ---------------------------------------------------------------------------
 * `AudioDocument` carries no revision counter, and its id survives every edit —
 * so an id-keyed cache would serve pre-edit samples for the rest of the
 * session, which is a worse defect than the one being fixed. What DOES change
 * on every destructive edit is the channel data: `applyEdit` is the single
 * write path, its contract is that the pure `fn` never mutates its input, and
 * the `AudioDocument` helpers it calls (`replaceRegion` and everything built on
 * it) allocate fresh `Float32Array`s for every channel. So the identity of the
 * channel arrays IS the revision counter this module needs.
 *
 * It is used twice over: the `WeakMap` is keyed on the `channels` ARRAY (which
 * also means the cache is collected with the document — a session that opens
 * and closes a hundred files retains none of them), and each per-document entry
 * additionally identity-checks every channel array on lookup, so a hostile or
 * clever caller that swaps a channel under the same outer array misses too.
 * A write that mutated a channel's CONTENTS in place would go stale — which is
 * exactly why `applyEdit`'s no-mutation contract is the load-bearing one.
 *
 * ---------------------------------------------------------------------------
 * BOUNDED BY CONSTRUCTION
 * ---------------------------------------------------------------------------
 * The entries are megabytes each (a 3-minute stereo clip is ~69 MB), so
 * "cache everything" is a leak with a nicer name. Per document, the cache holds
 * at most one document's worth of samples — `docLength · channels` — evicting
 * least-recently-used windows past that, with the newest read always kept even
 * when it alone exceeds the budget. For the reported two-song session that is
 * ~138 MB warm, which is the size of the documents themselves; for a document
 * chopped into many clips it is bounded by the same number rather than by the
 * number of clips.
 *
 * THE TWO RATES IN THAT SENTENCE (MT2 review, Minor 6). The budget counts
 * DOC-rate samples (`docLength` is a length in the document's own rate) while
 * the entries it measures hold SESSION-rate samples, so "one document's worth"
 * is approximate by exactly the conversion ratio: a whole-document entry
 * upsampled 44.1 → 48 kHz is ~9 % over the budget, and a 44.1 kHz document in a
 * 96 kHz session more than twice it. It stays a BOUND either way — the ratio is
 * a constant per (document, session) pair, and the newest-kept rule already
 * admits one over-budget entry by design — but it is a bound in the session's
 * denomination, roughly `docLength · channels · sessionRate/docRate`, not the
 * document's byte size. Denominating the budget in session samples would be a
 * one-line change and is deliberately not made: `docLength` is the number this
 * module can read without asking the session anything, and the imprecision is
 * bounded by a ratio that is never large in practice.
 */

/** One document's cached conversions. `entries` is LRU by Map insertion order:
 * a hit deletes and re-inserts, so the front is the least recently used. */
interface DocCache {
  sources: readonly Float32Array[];
  entries: Map<string, Float32Array[]>;
  samples: number;
}

let caches = new WeakMap<readonly Float32Array[], DocCache>();

function keyOf(clip: Clip, sessionRate: number): string {
  return `${sessionRate}|${clip.offsetSample}|${clip.lengthSample}`;
}

function sameSources(a: readonly Float32Array[], b: readonly Float32Array[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function sampleCount(slices: readonly Float32Array[]): number {
  let n = 0;
  for (const s of slices) n += s.length;
  return n;
}

/** One document's worth of DOC-RATE samples, weighed against entries counted in
 * SESSION-rate samples — approximate by the conversion ratio, and deliberately
 * so. See BOUNDED BY CONSTRUCTION above. */
function budgetFor(doc: AudioDocument): number {
  return Math.max(1, docLength(doc) * Math.max(1, doc.channels.length));
}

/**
 * Returns the resampled slice for `clip` at `sessionRate`, computing it via
 * `build` only on a miss. `build` must be the ONLY producer of these arrays, and
 * what it returns is shared with every later caller — the `readClipSlice`
 * read-only contract covers that.
 */
export function resampledClipSlice(
  doc: AudioDocument,
  clip: Clip,
  sessionRate: number,
  build: () => Float32Array[]
): Float32Array[] {
  let cache = caches.get(doc.channels);
  if (cache && !sameSources(cache.sources, doc.channels)) cache = undefined;
  if (!cache) {
    cache = { sources: [...doc.channels], entries: new Map(), samples: 0 };
    caches.set(doc.channels, cache);
  }

  const key = keyOf(clip, sessionRate);
  const hit = cache.entries.get(key);
  if (hit) {
    cache.entries.delete(key); // re-insert at the back: most recently used
    cache.entries.set(key, hit);
    return hit;
  }

  const slices = build();
  cache.entries.set(key, slices);
  cache.samples += sampleCount(slices);

  const budget = budgetFor(doc);
  // The newest entry is never the one evicted — it is the one being played.
  for (const oldest of cache.entries.keys()) {
    if (cache.samples <= budget || cache.entries.size <= 1) break;
    cache.samples -= sampleCount(cache.entries.get(oldest) as Float32Array[]);
    cache.entries.delete(oldest);
  }
  return slices;
}

/**
 * Runs `fn` when the renderer is next idle — the warm-up's scheduler.
 *
 * `requestIdleCallback` in the real renderer (with a timeout, so a permanently
 * busy window still gets there), `setTimeout(0)` where it does not exist
 * (jsdom, and any non-browser host). Deliberately NOT a microtask: the point is
 * to be off the insert's own tick, so the drop paints before the conversion
 * starts.
 */
export const IDLE_WARMUP_TIMEOUT_MS = 2000;

export function scheduleIdle(fn: () => void): void {
  const host = globalThis as {
    requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => unknown;
  };
  if (typeof host.requestIdleCallback === 'function') {
    host.requestIdleCallback(fn, { timeout: IDLE_WARMUP_TIMEOUT_MS });
    return;
  }
  setTimeout(fn, 0);
}

/** Test-only: drops every cached conversion (same convention as
 * `_resetClipWaveformCache` / `_resetSessionUndo`). */
export function _resetClipResampleCache(): void {
  caches = new WeakMap();
}

/** Test-only: what this document currently holds, for the bound's assertions. */
export function _clipResampleCacheStats(doc: AudioDocument): {
  entries: number;
  samples: number;
} {
  const cache = caches.get(doc.channels);
  if (!cache || !sameSources(cache.sources, doc.channels)) return { entries: 0, samples: 0 };
  return { entries: cache.entries.size, samples: cache.samples };
}
