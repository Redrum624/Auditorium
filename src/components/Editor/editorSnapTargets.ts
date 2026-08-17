/**
 * Task B4 — WHAT the editor's magnet snaps to, in DOCUMENT samples.
 *
 * The plan's target set is "beats, bar lines (when measured), and markers".
 * Two of those three collapse into one:
 *
 *  - **Beats** come from B1's `getBeatGrid` — a cached read that never starts an
 *    analysis — bounded at `analyzedEndSample`, because on a long file the grid
 *    legitimately covers only the analysed prefix and a target past it would be
 *    an extrapolated position the DSP never measured.
 *  - **Bar lines add nothing.** The plan's AMENDED RULING 1 established that
 *    `barBoundary` is exactly the subsequence
 *    `beatSamples[downbeatPhase + m·beatsPerBar]` — every bar line already IS
 *    one of the beats. Collecting them separately would produce duplicates and
 *    no new snap positions, so a measured metre changes the *drawing* (taller
 *    tics) and deliberately nothing here.
 *  - **Markers** come straight from the store; they are the app's existing
 *    user-placed positions and the most obviously "meant" targets in the file.
 *
 * The magnet's on/off preference is applied HERE rather than in the gesture
 * layer, so "snapping is off" has exactly one meaning — an empty target set —
 * and every consumer gets it for free.
 *
 * Deliberately NOT reactive: this is a plain function the gesture layer calls
 * at pointerdown, not a hook. A memoised hook would recompute (and re-render)
 * on every analysis version bump and marker edit for a value that is only ever
 * consumed for the duration of a drag, and the drag needs the set as it is when
 * the drag STARTS — targets appearing mid-gesture would move the pointer under
 * the user's hand.
 */
import { getBeatGrid, type BeatGrid } from '../../services/beatGrid';
import { mergeTargets } from '../../services/snap';
import { isSnapEnabled } from '../../services/snapPreference';
import { useAppStore, type Marker } from '../../stores/appStore';

/** The pure half: the ascending, duplicate-free target set for one document.
 * `grid.beatSamples` is the analysis cache's own shared `Int32Array` — it is
 * only ever read here, never sorted, copied or mutated in place. */
export function buildEditorSnapTargets(
  grid: BeatGrid | null,
  markers: readonly Marker[] | undefined
): number[] {
  const beats: number[] = [];
  if (grid) {
    for (let i = 0; i < grid.beatSamples.length; i++) {
      const b = grid.beatSamples[i];
      if (b > grid.analyzedEndSample) continue;
      beats.push(b);
    }
  }
  const markerPositions = markers ? markers.map((m) => m.positionSample) : [];
  return mergeTargets(beats, markerPositions);
}

/** The editor's snap targets for `docId`, in that document's own samples.
 * Empty — with no work done at all — whenever the magnet is off or there is no
 * document. */
export function editorSnapTargets(docId: string | null): number[] {
  if (!isSnapEnabled()) return [];
  if (docId === null) return [];
  return buildEditorSnapTargets(getBeatGrid(docId), useAppStore.getState().markers[docId]);
}
