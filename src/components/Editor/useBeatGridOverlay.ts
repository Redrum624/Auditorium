/**
 * Task B2 — the adapter between the beat-grid DATA layer (`services/beatGrid`)
 * and the pure drawing layer (`waveformRender`). It exists so that
 * `waveformRender.ts` never has to import the store (it must stay importable
 * from a worker and drivable by a recording stub) and so both editor views —
 * `WaveformView` and `SpectrogramView` — get identical tics from identical
 * rules rather than each assembling their own.
 *
 * Three things happen here and nowhere else:
 *
 * 1. **The honesty mapping (plan ruling 6).** The status bar already marks a
 *    stale tempo with `*` and a below-`CONFIDENCE_LOW` one with `?`
 *    (`StatusBar.tsx`). The drawn grid gets the same two signals collapsed into
 *    one `provisional` flag, so the tics are dimmed and dashed under exactly
 *    the conditions that put a `*` or a `?` in the readout. A doubtful grid is
 *    never presented as fact, and a grid is never silently hidden either.
 *
 * 2. **Downbeats only when measured (AMENDED RULING 1).** `isDownbeat` is
 *    passed through ONLY when the grid actually carries `beatsPerBar` — with no
 *    remix-level analysis the predicate is `undefined` and the renderer draws
 *    beats alone. 4/4 is never assumed.
 *
 * 3. **Reactivity + a stable identity.** `getBeatGrid` builds a fresh object on
 *    every call, so an unmemoised read would change the render effect's deps on
 *    every render and repaint the canvas constantly. The memo is keyed on
 *    everything the grid can actually depend on:
 *      - `useBeatGridVersion()` — analysis start/progress/completion/
 *        invalidation plus provenance-link changes (B1 added it precisely
 *        because `useTempoVersion()` alone does not cover the link half);
 *      - `channels` — an audio EDIT replaces the channel arrays and makes the
 *        cached grid stale, and `getTempo` only mutates `.stale` when it is
 *        next read, so nothing bumps a version counter at that moment. Without
 *        this dep the tics would keep claiming to be fresh until an unrelated
 *        analysis happened.
 *
 * Reading never starts an analysis — that guarantee lives in `getBeatGrid` and
 * is asserted there.
 */
import { useMemo } from 'react';
import { getBeatGrid, isDownbeat, useBeatGridVersion } from '../../services/beatGrid';
import { useBeatGridVisible } from '../../services/beatGridDisplay';
import { CONFIDENCE_LOW } from '../../dsp/tempoCore';
import type { BeatGridOverlay } from './waveformRender';

/**
 * The beat-tic overlay to draw for `docId`, or `null` when there is nothing to
 * draw (toggle off, or no cached grid). `channels` is the live document's
 * channel array — passed in rather than looked up so an audio edit invalidates
 * the memo, see (3) above.
 */
export function useBeatGridOverlay(
  docId: string,
  channels: Float32Array[]
): BeatGridOverlay | null {
  const visible = useBeatGridVisible();
  const version = useBeatGridVersion();

  return useMemo(() => {
    if (!visible) return null;
    const grid = getBeatGrid(docId);
    if (!grid) return null;
    return {
      beats: grid.beatSamples,
      // Only when the analysis genuinely measured a metre — never a default.
      isDownbeat:
        grid.beatsPerBar === null ? undefined : (index: number) => isDownbeat(grid, index),
      endSample: grid.analyzedEndSample,
      provisional: grid.stale || grid.confidence < CONFIDENCE_LOW,
    };
    // `version` and `channels` are change tokens, not values read in the body.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId, visible, version, channels]);
}
