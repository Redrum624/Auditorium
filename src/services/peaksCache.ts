// Memoizes peak pyramids per document so the waveform view never rebuilds
// pyramids on every draw. Keyed by doc id; rebuilds only when a channel array
// identity changes (mutators produce new Float32Array instances). Pure module —
// it never subscribes to the store.

import type { AudioDocument } from '../audio/AudioDocument';
import { buildPeaks, type PeakPyramid } from '../audio/peaks';

interface CacheEntry {
  channelRefs: Float32Array[];
  pyramids: PeakPyramid[];
}

const cache = new Map<string, CacheEntry>();

function sameChannelRefs(a: Float32Array[], b: Float32Array[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/** Returns the (cached) peak pyramids for a document, rebuilding per channel
 * only when that channel's array identity has changed since the last call. */
export function getPyramids(doc: AudioDocument): PeakPyramid[] {
  const existing = cache.get(doc.id);
  if (existing && sameChannelRefs(existing.channelRefs, doc.channels)) {
    return existing.pyramids;
  }

  // Reuse a channel's pyramid when only some channels changed.
  const pyramids = doc.channels.map((channel, i) => {
    if (existing && existing.channelRefs[i] === channel) {
      return existing.pyramids[i];
    }
    return buildPeaks(channel);
  });

  cache.set(doc.id, { channelRefs: doc.channels.slice(), pyramids });
  return pyramids;
}

/** Drop the cached pyramids for a document (call on close or forced rebuild). */
export function invalidatePeaks(docId: string): void {
  cache.delete(docId);
}

/** Clear the entire cache — primarily for test isolation. */
export function clearAllPeaks(): void {
  cache.clear();
}
