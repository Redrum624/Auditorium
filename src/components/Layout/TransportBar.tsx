import { useEffect, type ReactNode } from 'react';
import { Circle, Pause, Play, Repeat, Square } from 'lucide-react';
import { playbackEngine } from '../../audio/PlaybackEngine';
import { multitrackPlayer } from '../../multitrack/MultitrackPlayer';
import { useSessionStore } from '../../multitrack/sessionStore';
import { runCommand } from '../../services/menuActions';
import { useAppStore } from '../../stores/appStore';
import { formatTime } from '../../utils/timeFormat';
import LevelMeter from './LevelMeter';

interface TransportButtonProps {
  label: string;
  onClick?: () => void;
  disabled?: boolean;
  active?: boolean;
  children: ReactNode;
}

function TransportButton({ label, onClick, disabled, active, children }: TransportButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={`flex h-9 w-9 items-center justify-center rounded border border-[#3a3a42] text-[#d4d4d8] transition-colors disabled:cursor-default disabled:opacity-40 ${
        active ? 'bg-[#26c6da] text-[#101014]' : 'bg-[#2e2e34] enabled:hover:bg-[#3a3a42]'
      }`}
    >
      {children}
    </button>
  );
}

/**
 * Bottom transport bar: stop / play-pause / loop / record buttons, an
 * editor-view segmented control (Waveform | Spectral | Multitrack), a large
 * monospace time readout, and the level meter. It owns the store↔engine wiring
 * for BOTH engines: loading the active document into the PlaybackEngine, and
 * mirroring each engine's state + pumping its play position (routed by the
 * active view) so the waveform playhead and the multitrack playhead both track
 * their engine.
 */
export default function TransportBar() {
  const doc = useAppStore((s) => s.documents.find((d) => d.id === s.activeDocumentId) ?? null);
  const playback = useAppStore((s) => s.playback);
  const cursorSample = useAppStore((s) => s.cursorSample);
  const view = useAppStore((s) => s.view);

  const mtSampleRate = useSessionStore((s) => s.session.sampleRate);
  const mtCursorSample = useSessionStore((s) => s.mtCursorSample);
  const mtPlayState = useSessionStore((s) => s.mtPlayState);
  const mtPlayheadSample = useSessionStore((s) => s.mtPlayheadSample);

  const hasDoc = doc !== null;
  const isMultitrack = view === 'multitrack';
  const canTransport = hasDoc || isMultitrack;
  const isPlaying = isMultitrack ? mtPlayState === 'playing' : playback.state === 'playing';

  // Load the active document into the engine whenever its identity changes.
  useEffect(() => {
    if (doc) playbackEngine.load(doc);
  }, [doc]);

  // Mirror PlaybackEngine state transitions into the app store (covers natural end).
  useEffect(() => {
    return playbackEngine.onStateChange((state) => {
      useAppStore
        .getState()
        .setPlayback({ state, positionSample: playbackEngine.getPositionSample() });
    });
  }, []);

  // Mirror MultitrackPlayer state transitions into the session store (covers
  // natural end); push the final playhead so it snaps to rest on stop.
  useEffect(() => {
    return multitrackPlayer.onStateChange((state) => {
      const s = useSessionStore.getState();
      s.setMtPlayState(state);
      s.setMtPlayheadSample(multitrackPlayer.getPositionSample());
    });
  }, []);

  // Waveform/spectral position pump (only while that view is playing).
  useEffect(() => {
    if (isMultitrack || playback.state !== 'playing') return;
    let raf = 0;
    const tick = () => {
      useAppStore.getState().setPlayback({ positionSample: playbackEngine.getPositionSample() });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playback.state, isMultitrack]);

  // Multitrack position pump (only while the multitrack view is playing).
  useEffect(() => {
    if (!isMultitrack || mtPlayState !== 'playing') return;
    let raf = 0;
    const tick = () => {
      useSessionStore.getState().setMtPlayheadSample(multitrackPlayer.getPositionSample());
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [isMultitrack, mtPlayState]);

  // Live multitrack parameters: while the multitrack view is playing, push track
  // volume/pan/mute/solo changes into the running graph as they happen (the store
  // replaces the tracks array on every edit). Unsubscribes on stop/view change/
  // unmount so no stray updates hit a torn-down graph.
  useEffect(() => {
    if (!isMultitrack || mtPlayState !== 'playing') return;
    return useSessionStore.subscribe((state, prev) => {
      if (state.session.tracks !== prev.session.tracks) {
        multitrackPlayer.applyTrackParams(state.session.tracks);
      }
    });
  }, [isMultitrack, mtPlayState]);

  const readoutRate = isMultitrack ? mtSampleRate : (doc?.sampleRate ?? 44100);
  const readoutSample = isMultitrack
    ? mtPlayState === 'playing'
      ? mtPlayheadSample
      : mtCursorSample
    : isPlaying
      ? playback.positionSample
      : cursorSample;

  return (
    <div className="flex h-14 items-center gap-3 border-t border-[#3a3a42] bg-[#232328] px-3">
      <TransportButton
        label="Stop"
        disabled={!canTransport}
        onClick={() => void runCommand('transport.stop')}
      >
        <Square size={16} fill="currentColor" />
      </TransportButton>

      <TransportButton
        label={isPlaying ? 'Pause' : 'Play'}
        disabled={!canTransport}
        onClick={() => void runCommand('transport.playPause')}
      >
        {isPlaying ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" />}
      </TransportButton>

      <TransportButton
        label="Loop"
        disabled={!hasDoc}
        active={playback.loop}
        onClick={() => void runCommand('transport.toggleLoop')}
      >
        <Repeat size={16} />
      </TransportButton>

      <TransportButton label="Record" onClick={() => void runCommand('transport.record')}>
        <Circle size={16} fill="currentColor" className="text-[#ef5350]" />
      </TransportButton>

      {/* Editor view toggle: Waveform | Spectral | Multitrack. Multitrack works
          without an open document; the single-doc views require one. */}
      <div
        className="ml-2 flex overflow-hidden rounded border border-[#3a3a42]"
        data-testid="view-toggle"
      >
        {(['waveform', 'spectral', 'multitrack'] as const).map((v) => (
          <button
            key={v}
            type="button"
            aria-label={`${v} view`}
            aria-pressed={view === v}
            disabled={v !== 'multitrack' && !hasDoc}
            onClick={() => useAppStore.getState().setView(v)}
            className={`px-2.5 py-1 text-xs capitalize transition-colors disabled:cursor-default disabled:opacity-40 ${
              view === v
                ? 'bg-[#26c6da] text-[#101014]'
                : 'bg-[#2e2e34] text-[#d4d4d8] enabled:hover:bg-[#3a3a42]'
            }`}
          >
            {v}
          </button>
        ))}
      </div>

      <div
        data-testid="transport-time"
        className="ml-2 font-mono text-2xl tabular-nums text-[#d4d4d8]"
      >
        {formatTime(readoutSample, readoutRate)}
      </div>

      <div className="ml-auto">
        <LevelMeter channels={doc?.channels.length ?? 2} />
      </div>
    </div>
  );
}
