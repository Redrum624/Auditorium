import { type AudioDocument } from '../audio/AudioDocument';
import { warmClipResample } from './mixdown';
import { createClip, documentClipLength, type Clip } from './session';
import { adoptSessionRate, useSessionStore } from './sessionStore';
import { withSessionGesture } from './sessionUndo';

/**
 * MT2 — THE placement path: "put these documents on this track, starting here".
 *
 * Three call sites used to state this independently — Insert Active File
 * (`services/menuActions`), a Files-panel/Explorer drop (`laneDrop`), and the
 * `insertActiveDocAsClip` test hook (`services/testHooks`, the path the latency
 * rig and the e2e walkers drive) — and two of the three had their own inlined
 * copy of the doc-rate/session-rate conversion `documentClipLength` already
 * owns. Three copies of a placement is three places for a rate rule to be
 * missing from, which is exactly how the reported stall reached a release: the
 * rate ADOPTION below has to happen before the clip is built, in every path, or
 * the path without it silently keeps the resample.
 */

/** One placed clip, as the callers report it back to their own callers. */
export interface PlacedClip {
  clipId: string;
  lengthSample: number;
  startSample: number;
}

/**
 * Places one clip per document, laid end to end from `startSample`, inside ONE
 * undo entry ('Add clip' / 'Add clips' — N files from one gesture are one
 * Ctrl+Z), and selects the last of them unless `select: false`.
 *
 * `startSample` is stated in the session's rate AS OF THE CALL, which for a
 * drop is the rate the lane's pixel mapping resolved the drop x against. When
 * an empty session ADOPTS the first document's rate, that number is
 * re-denominated by the adoption ratio — otherwise a clip dropped at 1.000 s
 * into an empty 44.1 kHz session with a 48 kHz file would land at 0.919 s,
 * visibly not where it was let go.
 *
 * Clips land VERBATIM at the requested position: overlap is first-class since
 * X5, and a programmatic placement writes no fade keys.
 *
 * Returns the clips placed, newest last; `[]` for an unknown track or no
 * documents.
 */
export function placeDocumentsOnTrack(
  docs: readonly AudioDocument[],
  trackId: string,
  startSample: number,
  opts?: { select?: boolean }
): PlacedClip[] {
  if (docs.length === 0) return [];
  if (!useSessionStore.getState().session.tracks.some((t) => t.id === trackId)) return [];

  const built: { doc: AudioDocument; clip: Clip }[] = [];
  let sessionRate = useSessionStore.getState().session.sampleRate;
  withSessionGesture(docs.length === 1 ? 'Add clip' : 'Add clips', () => {
    // Before the first clip is built, so the clip is built against the rate the
    // session ENDS at. A multi-document drop adopts from the first of them; the
    // rest are placed against that rate exactly as they would be against any
    // other non-empty session's rate.
    const ratio = adoptSessionRate(docs[0].sampleRate);
    const store = useSessionStore.getState();
    sessionRate = store.session.sampleRate;

    let next = Math.max(0, Math.round(startSample * ratio));
    for (const doc of docs) {
      const lengthSample = documentClipLength(doc, sessionRate);
      const clip = createClip({
        documentId: doc.id,
        startSample: next,
        offsetSample: 0,
        lengthSample,
      });
      store.addClip(trackId, clip);
      built.push({ doc, clip });
      next += lengthSample;
    }

    if (opts?.select !== false) store.setSelectedClip(built[built.length - 1].clip.id);
  });

  // MT2-2 — a clip that WILL need converting gets converted now, off the play
  // path, when the renderer is next idle. A no-op when the rates agree, which
  // after the adoption above is the whole of the reported flow; it exists for
  // the genuinely mixed-rate session, so `play()` finds the samples ready
  // instead of running the sinc over all of them while the user waits.
  for (const { doc, clip } of built) warmClipResample(doc, clip, sessionRate);

  return built.map(({ clip }) => ({
    clipId: clip.id,
    lengthSample: clip.lengthSample,
    startSample: clip.startSample,
  }));
}
