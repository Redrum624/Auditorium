import { playbackEngine, type PlaybackPlayOptions } from '../audio/PlaybackEngine';
import { multitrackPlayer } from '../multitrack/MultitrackPlayer';
import { useSessionStore } from '../multitrack/sessionStore';
import type { AppState } from '../stores/appStore';
import { useAppStore } from '../stores/appStore';

/**
 * View-routed transport. The transport UI and shortcuts always dispatch the
 * same `transport.playPause` / `transport.stop` command ids; this service picks
 * the engine by the active view — the single-document `PlaybackEngine` for the
 * waveform/spectral editor (behavior preserved verbatim from the original
 * menuActions implementation) or the `MultitrackPlayer` for the multitrack view.
 *
 * The multitrack player has no pause (v1): play/pause toggles play↔stop and
 * always plays from the multitrack cursor. State/position are mirrored back into
 * the session store by the TransportBar (which owns the rAF position pump and
 * the onStateChange subscriptions), mirroring how the waveform transport works.
 */

function activeDoc(s: AppState) {
  return s.documents.find((d) => d.id === s.activeDocumentId) ?? null;
}

/** Snapshot of the currently open documents as an id→document lookup. */
function documentsMap() {
  return new Map(useAppStore.getState().documents.map((d) => [d.id, d]));
}

export function transportPlayPause(): void {
  const app = useAppStore.getState();

  if (app.view === 'multitrack') {
    if (multitrackPlayer.state === 'playing') {
      multitrackPlayer.stop();
      return;
    }
    const { session, mtCursorSample } = useSessionStore.getState();
    multitrackPlayer.play(mtCursorSample, session, documentsMap());
    return;
  }

  // --- Single-document (waveform/spectral) transport — unchanged semantics ---
  if (!activeDoc(app)) return;
  const { selection, cursorSample, playback, setPlayback } = app;

  // Playing -> pause, keeping the current position.
  if (playbackEngine.state === 'playing') {
    playbackEngine.pause();
    setPlayback({ state: 'paused' });
    return;
  }

  // Resume from the paused sample, else start at the selection or cursor.
  const from =
    playbackEngine.state === 'paused'
      ? playbackEngine.getPositionSample()
      : selection
        ? selection.start
        : cursorSample;

  const opts: PlaybackPlayOptions = {};
  if (selection) {
    if (playback.loop) opts.loopRegion = selection;
    else opts.playRegion = selection;
  }
  playbackEngine.play(from, opts);
  setPlayback({ state: 'playing', positionSample: from });
}

/**
 * Stops BOTH engines unconditionally, regardless of the active view (Task 23).
 * Switching views mid-playback (waveform/spectral <-> multitrack) otherwise
 * orphans whichever engine was playing, since transportStop() only routes to
 * the engine for the CURRENT view. App.tsx calls this whenever the view
 * changes. Both engines' stop() are already idempotent/no-op-safe when not
 * playing, so calling both unconditionally is cheap and side-effect-free.
 */
export function stopAll(): void {
  playbackEngine.stop();
  multitrackPlayer.stop();
}

export function transportStop(): void {
  const app = useAppStore.getState();

  if (app.view === 'multitrack') {
    multitrackPlayer.stop();
    return;
  }

  playbackEngine.stop();
  useAppStore
    .getState()
    .setPlayback({ state: 'stopped', positionSample: playbackEngine.getPositionSample() });
}
