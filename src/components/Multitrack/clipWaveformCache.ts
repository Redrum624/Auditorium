/**
 * Offscreen mini-waveform cache for multitrack clips (Task F8).
 *
 * Drawing a clip's peak envelope on every render (during zoom especially) meant
 * recomputing peaks and per-pixel fills each time. Instead we draw each clip's
 * waveform ONCE into an offscreen canvas, keyed by the fields that actually
 * change its pixels — (clipId, lengthSample, zoom bucket, source-channels
 * identity, height) — and blit that bitmap on subsequent renders. Zoom is
 * bucketed by `floor(log2(samplesPerPixel))` so fine-zoom within a 2x range
 * reuses one bitmap (blit-scaled to the current width by the caller). The cache
 * is a module-level Map keyed by clip id, bounded to MAX_ENTRIES with
 * oldest-first eviction so a session with thousands of clips can't grow it
 * without bound.
 */

const MAX_ENTRIES = 200;

export interface ClipWaveformKey {
  clipId: string;
  lengthSample: number;
  bucket: number;
  height: number;
  /** Offset into the source doc. Defensive: today every offset change also
   *  changes lengthSample (trim), but a future slip edit must not blit stale pixels. */
  offsetSample: number;
  /** Source-document channels; compared by identity so an edit that replaces
   *  the channel arrays invalidates the cached waveform. */
  channels: Float32Array[];
}

interface Entry extends ClipWaveformKey {
  canvas: HTMLCanvasElement;
}

const cache = new Map<string, Entry>();

/** Zoom bucket for a samplesPerPixel value: `floor(log2(spp))` (spp clamped to
 *  >= 1 so sub-pixel-per-sample zoom collapses onto bucket 0). */
export function zoomBucket(samplesPerPixel: number): number {
  return Math.floor(Math.log2(Math.max(1, samplesPerPixel)));
}

function keysMatch(entry: Entry, key: ClipWaveformKey): boolean {
  return (
    entry.lengthSample === key.lengthSample &&
    entry.bucket === key.bucket &&
    entry.height === key.height &&
    entry.offsetSample === key.offsetSample &&
    entry.channels === key.channels
  );
}

/**
 * Return the cached offscreen canvas for `key`, drawing it via `draw` on a miss.
 * `draw` is invoked at most once per distinct key; on a hit the existing bitmap
 * is returned untouched (and its recency refreshed for eviction). `width` is the
 * pixel width to size a freshly-drawn canvas to — ignored on a cache hit, so
 * callers blit-scale the returned bitmap to the current on-screen width.
 */
export function getClipWaveformCanvas(
  key: ClipWaveformKey,
  width: number,
  draw: (canvas: HTMLCanvasElement) => void
): HTMLCanvasElement {
  const existing = cache.get(key.clipId);
  if (existing && keysMatch(existing, key)) {
    // Refresh recency: delete+set moves the entry to the end of the Map's
    // insertion order, so the oldest-first eviction below keeps hot clips.
    cache.delete(key.clipId);
    cache.set(key.clipId, existing);
    return existing.canvas;
  }

  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(key.height));
  draw(canvas);

  const entry: Entry = { ...key, canvas };
  cache.delete(key.clipId);
  cache.set(key.clipId, entry);

  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }

  return canvas;
}

/**
 * Purge the cached bitmap for one clip (Task F9). Call this wherever a clip
 * dies individually — its stale offscreen canvas (and the source-doc channels
 * reference it holds) would otherwise sit in the cache, retained, until
 * LRU-evicted by unrelated clip churn.
 */
export function purgeClip(clipId: string): void {
  cache.delete(clipId);
}

/**
 * Empty the entire cache (Task F9). Closing a document can invalidate many
 * clips at once (every clip sourced from that doc) — rather than track which
 * cache entries belong to a closing doc, clear the whole (small, mini)
 * waveform cache. Worst case is a redraw of the still-open clips currently on
 * screen, which is cheap.
 */
export function clearClipWaveformCache(): void {
  cache.clear();
}

/** Test-only: empty the cache. */
export function _resetClipWaveformCache(): void {
  clearClipWaveformCache();
}

/** Test-only: current number of cached entries. */
export function _clipWaveformCacheSize(): number {
  return cache.size;
}
