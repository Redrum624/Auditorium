import { useEffect, type ReactNode } from 'react';
import { Circle, Pause, Play, Repeat, Square } from 'lucide-react';
import { playbackEngine } from '../../audio/PlaybackEngine';
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
 * Bottom transport bar: stop / play-pause / loop / record buttons, a large
 * monospace time readout, and the level meter. It owns the wiring between the
 * store and the shared PlaybackEngine: loading the active document into the
 * engine on identity change, mirroring engine state transitions back into the
 * store (covers natural end), and pumping the play position via requestAnimationFrame.
 */
export default function TransportBar() {
  const doc = useAppStore((s) => s.documents.find((d) => d.id === s.activeDocumentId) ?? null);
  const playback = useAppStore((s) => s.playback);
  const cursorSample = useAppStore((s) => s.cursorSample);
  const view = useAppStore((s) => s.view);

  const hasDoc = doc !== null;
  const isPlaying = playback.state === 'playing';

  // Load the active document into the engine whenever its identity changes
  // (a new file, or an edit that produced a new document object).
  useEffect(() => {
    if (doc) playbackEngine.load(doc);
  }, [doc]);

  // Mirror engine state transitions into the store so natural end (onended)
  // updates the UI even though no command ran.
  useEffect(() => {
    return playbackEngine.onStateChange((state) => {
      useAppStore
        .getState()
        .setPlayback({ state, positionSample: playbackEngine.getPositionSample() });
    });
  }, []);

  // While playing, pump the derived position into the store each animation frame.
  useEffect(() => {
    if (playback.state !== 'playing') return;
    let raf = 0;
    const tick = () => {
      useAppStore.getState().setPlayback({ positionSample: playbackEngine.getPositionSample() });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playback.state]);

  const sampleRate = doc?.sampleRate ?? 44100;
  const readoutSample = isPlaying ? playback.positionSample : cursorSample;

  return (
    <div className="flex h-14 items-center gap-3 border-t border-[#3a3a42] bg-[#232328] px-3">
      <TransportButton label="Stop" disabled={!hasDoc} onClick={() => void runCommand('transport.stop')}>
        <Square size={16} fill="currentColor" />
      </TransportButton>

      <TransportButton
        label={isPlaying ? 'Pause' : 'Play'}
        disabled={!hasDoc}
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

      {/* Editor view toggle: Waveform | Spectral. */}
      <div
        className="ml-2 flex overflow-hidden rounded border border-[#3a3a42]"
        data-testid="view-toggle"
      >
        {(['waveform', 'spectral'] as const).map((v) => (
          <button
            key={v}
            type="button"
            aria-label={v === 'waveform' ? 'Waveform view' : 'Spectral view'}
            aria-pressed={view === v}
            disabled={!hasDoc}
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
        {formatTime(readoutSample, sampleRate)}
      </div>

      <div className="ml-auto">
        <LevelMeter channels={doc?.channels.length ?? 2} />
      </div>
    </div>
  );
}
