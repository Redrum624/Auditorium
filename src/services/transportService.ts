import { playbackEngine, type PlaybackPlayOptions } from '../audio/PlaybackEngine';
import { multitrackPlayer } from '../multitrack/MultitrackPlayer';
import { multitrackRecorder } from '../multitrack/multitrackRecord';
import { useSessionStore } from '../multitrack/sessionStore';
import type { AppState } from '../stores/appStore';
import { useAppStore } from '../stores/appStore';
import { openRecordDialog } from './dialogBus';

/**
 * View-routed transport. The transport UI and shortcuts always dispatch the
 * same `transport.playPause` / `transport.stop` command ids; this service picks
 * the engine by the active view — the single-document `PlaybackEngine` for the
 * waveform/spectral editor or the `MultitrackPlayer` for the multitrack view.
 *
 * D2 — in the waveform/spectral editor the CURSOR BAR is where Play starts,
 * always: Pause writes the paused position back to `cursorSample` and Play
 * reads only the bar (never the engine's hidden paused position). The editor
 * draws the playhead line only while playing, so after a pause the bar is the
 * only line on screen; starting anywhere else is a start the user cannot see.
 *
 * The multitrack player has no pause (v1): play/pause toggles play↔stop and
 * always plays from the multitrack cursor. State/position are mirrored back into
 * the session store by the transport Toolbar (which owns the rAF position pump
 * and the onStateChange subscriptions), mirroring how the waveform transport
 * works.
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
    // Play/Pause is the play↔stop toggle in multitrack (no pause). While a
    // punch-in take is running it commits the take (the recorder stops the
    // monitor player), so Space never leaves the recorder orphaned.
    if (multitrackRecorder.isRecording()) {
      void multitrackRecorder.stop();
      return;
    }
    if (multitrackPlayer.state === 'playing') {
      multitrackPlayer.stop();
      return;
    }
    const { session, mtCursorSample } = useSessionStore.getState();
    multitrackPlayer.play(mtCursorSample, session, documentsMap());
    return;
  }

  // --- Single-document (waveform/spectral) transport — D2 ---
  if (!activeDoc(app)) return;
  const { selection, cursorSample, playback, setCursor, setPlayback } = app;

  // Playing -> pause, and MOVE THE BAR to where playback stopped (D2). The bar
  // is the only line left on screen once the playhead stops drawing, so it has
  // to be the paused position — that is what keeps Space·Space a resume.
  if (playbackEngine.state === 'playing') {
    playbackEngine.pause();
    const positionSample = playbackEngine.getPositionSample();
    setCursor(positionSample);
    setPlayback({ state: 'paused', positionSample });
    return;
  }

  // Start at the bar (D2) — the engine's paused position is never consulted.
  // One exception: with a selection whose span does NOT contain the bar, Play
  // starts at `selection.start`, because the region it is about to play is the
  // selection and starting in front of it would play nothing. A bar INSIDE the
  // selection starts there and still plays to the selection end.
  const from =
    selection && !(cursorSample >= selection.start && cursorSample < selection.end)
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
  if (multitrackRecorder.isRecording()) void multitrackRecorder.stop();
  playbackEngine.stop();
  multitrackPlayer.stop();
}

export function transportStop(): void {
  const app = useAppStore.getState();

  if (app.view === 'multitrack') {
    // A running punch-in take is stopped too (the recorder stops the player and
    // commits the take); the extra player.stop() below is an idempotent no-op.
    if (multitrackRecorder.isRecording()) void multitrackRecorder.stop();
    multitrackPlayer.stop();
    return;
  }

  playbackEngine.stop();
  useAppStore
    .getState()
    .setPlayback({ state: 'stopped', positionSample: playbackEngine.getPositionSample() });
}

/** Single source of `transport.record` enablement (menuActions and the
 * transport Toolbar both consult this): the multitrack view needs at least one armed track
 * (nothing to punch into otherwise) — except while a take is already running,
 * which must stay stoppable via the record toggle even if the user disarms
 * every track mid-take. The waveform/spectral views open the Record dialog,
 * which owns device/permission errors itself, so recording is always available
 * there. */
export function canRecord(): boolean {
  if (useAppStore.getState().view !== 'multitrack') return true;
  if (multitrackRecorder.isRecording()) return true;
  return useSessionStore.getState().session.tracks.some((t) => t.armed);
}

/**
 * View-routed record command. In the multitrack view it TOGGLES punch-in
 * recording onto the armed tracks (start when idle, stop when recording); any
 * error surfaces via a native message box and leaves the transport state
 * unchanged. In the waveform/spectral views it opens the single-file Record
 * dialog (behavior preserved from the original menuActions implementation).
 */
export async function transportRecord(): Promise<void> {
  if (useAppStore.getState().view !== 'multitrack') {
    openRecordDialog();
    return;
  }
  try {
    if (multitrackRecorder.isRecording()) await multitrackRecorder.stop();
    else await multitrackRecorder.start();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    void window.electronAPI?.showMessageBox({
      type: 'error',
      title: 'Recording failed',
      message: `Could not record: ${message}`,
    });
  }
}
