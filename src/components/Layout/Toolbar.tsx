import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { Circle, Magnet, Minus, Pause, Play, Plus, Repeat, SkipBack, Square } from 'lucide-react';
import { docLength } from '../../audio/AudioDocument';
import type { AudioDocument } from '../../audio/AudioDocument';
import { playbackEngine } from '../../audio/PlaybackEngine';
import { multitrackPlayer } from '../../multitrack/MultitrackPlayer';
import { multitrackRecorder } from '../../multitrack/multitrackRecord';
import { useSessionStore } from '../../multitrack/sessionStore';
import { runCommand } from '../../services/menuActions';
import { toggleSnap, useSnapEnabled } from '../../services/snapPreference';
import { canRecord } from '../../services/transportService';
import { defaultZoom, useAppStore } from '../../stores/appStore';
import { formatTime } from '../../utils/timeFormat';
import { MIN_SPP, ZOOM_FACTOR } from '../Editor/useEditorGestures';
import { ChromePill } from '../UI/glass';

/**
 * v1.6 G3: the retired bottom TransportBar reborn as Vitrine's floating top
 * chrome pill (photo_app Layout/Toolbar.tsx anatomy) plus the top-left file
 * chip. Since G6 the band truly FLOATS over the radial stage (mockup
 * `.toolbar` / `.filechip` absolute placement — the sidebars it used to
 * avoid are floating overlays themselves now): an absolute z-20 band whose
 * empty stretches ignore pointer events so the stage beneath stays live.
 *
 *   [file chip]        [Open Save Export | ⏮ ⏹ ▶ ⏺ ⟳ | views | − % + Fit]
 *
 * Every control keeps its command id, aria-label, enabled-state and testid
 * from the bottom bar (plan ruling 4). This component also inherits, verbatim,
 * the TransportBar's store↔engine wiring: it owns loading the active document
 * into the PlaybackEngine, mirroring each engine's state, and pumping its play
 * position (routed by the active view) so the waveform playhead and the
 * multitrack playhead both track their engine. The big time readout moved to
 * the bottom status pill (StatusBar) and the level meter moved with it.
 */

// Base layout for an idle pill button — interactive :hover/:disabled states
// come from .glass-pill-btn in index.css (inline styles can't express
// pseudo-classes). Vitrine Toolbar.tsx `pillBtn`, verbatim.
const pillBtn: CSSProperties = {
  height: '30px',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: '0 10px',
  gap: '5px',
  fontSize: '12.5px',
  borderRadius: '9px',
  border: '1px solid transparent',
  background: 'transparent',
  color: 'var(--glass-text-chrome-primary)',
  cursor: 'pointer',
  whiteSpace: 'nowrap',
};

const pillIconBtn: CSSProperties = { ...pillBtn, width: '30px', padding: '0' };

const divider: CSSProperties = {
  width: '1px',
  height: '18px',
  margin: '0 4px',
  background: 'var(--glass-border)',
  flexShrink: 0,
};

// A control that is "on" (playing Play, active view, Loop while looping) reads
// as an accent-soft tile (Vitrine Toolbar.tsx `toggleActive`, verbatim).
const toggleActive: CSSProperties = {
  background: 'var(--accent-soft)',
  border: '1px solid var(--accent-ring)',
  color: 'var(--accent)',
};

function Divider() {
  return <div aria-hidden="true" style={divider} />;
}

interface PillButtonProps {
  label: string;
  onClick?: () => void;
  disabled?: boolean;
  active?: boolean;
  title?: string;
  icon?: boolean;
  children: ReactNode;
}

/** One pill control. `label` doubles as the aria-label/title contract carried
 * over from the TransportBar's buttons; `active` applies the accent tile. */
function PillButton({ label, onClick, disabled, active, title, icon, children }: PillButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      title={title ?? label}
      disabled={disabled}
      onClick={onClick}
      className="glass-pill-btn"
      style={{ ...(icon ? pillIconBtn : pillBtn), ...(active ? toggleActive : null) }}
    >
      {children}
    </button>
  );
}

/** '100%' is the activation default (whole doc across ~1600px, appStore's
 * defaultZoom); zooming in grows the number. Shared by the chip and the pill. */
function zoomPercent(doc: AudioDocument, samplesPerPixel: number): number {
  return Math.round((defaultZoom(doc).samplesPerPixel / samplesPerPixel) * 100);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}

/** Zoom the single-document editor by `factor`, anchored on the cursor (the
 * only viewport-independent anchor available up here — the wheel gesture
 * anchors on the pointer instead). Same MIN_SPP floor and length/50 ceiling
 * as useEditorGestures, so the button path can never leave the wheel range. */
function zoomEditorBy(factor: number): void {
  const s = useAppStore.getState();
  const doc = s.documents.find((d) => d.id === s.activeDocumentId) ?? null;
  if (!doc) return;
  const len = docLength(doc);
  const maxSpp = Math.max(1, len / 50);
  const spp = clamp(s.zoom.samplesPerPixel * factor, MIN_SPP, maxSpp);
  if (spp === s.zoom.samplesPerPixel) return;
  const anchor = clamp(s.cursorSample, 0, len);
  // Keep the anchor at the same on-screen x: x = (anchor - scroll) / sppOld.
  const x = (anchor - s.zoom.scrollSample) / s.zoom.samplesPerPixel;
  // Over-scroll self-corrects on the next wheel event (see transport.goToEnd's
  // note in menuActions.ts) — clamping to the document length is enough here.
  const scrollSample = clamp(anchor - x * spp, 0, len);
  s.setZoom({ samplesPerPixel: spp, scrollSample });
}

function zoomEditorFit(): void {
  const s = useAppStore.getState();
  const doc = s.documents.find((d) => d.id === s.activeDocumentId) ?? null;
  if (!doc) return;
  s.setZoom(defaultZoom(doc));
}

/** Top-left file chip: name · duration · rate · channels · zoom %, live from
 * the store (mockup `.filechip`). */
function FileChip() {
  const doc = useAppStore((s) => s.documents.find((d) => d.id === s.activeDocumentId) ?? null);
  const zoom = useAppStore((s) => s.zoom);

  return (
    <ChromePill
      data-testid="file-chip"
      className="pointer-events-auto flex items-center"
      style={{
        justifySelf: 'start',
        maxWidth: '100%',
        minWidth: 0,
        padding: '8px 14px',
        fontSize: '12px',
        color: 'var(--glass-text-secondary)',
        whiteSpace: 'nowrap',
      }}
    >
      {doc ? (
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {doc.name} · {formatTime(docLength(doc), doc.sampleRate)} ·{' '}
          {(doc.sampleRate / 1000).toFixed(1)} kHz ·{' '}
          {doc.channels.length === 1
            ? 'mono'
            : doc.channels.length === 2
              ? 'stereo'
              : `${doc.channels.length}ch`}{' '}
          ·{' '}
          <span style={{ color: 'var(--glass-text-title)' }}>
            {zoomPercent(doc, zoom.samplesPerPixel)}%
          </span>
        </span>
      ) : (
        <span style={{ color: 'var(--glass-text-muted)' }}>no document</span>
      )}
    </ChromePill>
  );
}

export default function Toolbar() {
  const doc = useAppStore((s) => s.documents.find((d) => d.id === s.activeDocumentId) ?? null);
  const playback = useAppStore((s) => s.playback);
  const view = useAppStore((s) => s.view);
  const zoom = useAppStore((s) => s.zoom);

  // Task B4 — the magnet's visible switch. A preference, not a document action,
  // so it is never disabled: the user must be able to set it before running
  // Detect Tempo, not only after (the same rule `view.beatGrid` follows).
  const snapEnabled = useSnapEnabled();

  const mtPlayState = useSessionStore((s) => s.mtPlayState);
  // Subscribe to the armed set (value unused directly) so canRecord() below is
  // re-evaluated whenever a track is armed/disarmed.
  useSessionStore((s) => s.session.tracks.some((t) => t.armed));

  const hasDoc = doc !== null;
  const isMultitrack = view === 'multitrack';
  const canTransport = hasDoc || isMultitrack;
  const isPlaying = isMultitrack ? mtPlayState === 'playing' : playback.state === 'playing';

  // Live punch-in recording state, mirrored from the multitrack recorder so the
  // Record button can pulse red while a take is running. Enablement comes from
  // transportService.canRecord() — the same source the menu command uses — and
  // is re-derived on every armed-set / view / recording-state render trigger.
  const [mtRecording, setMtRecording] = useState(() => multitrackRecorder.isRecording());
  useEffect(() => multitrackRecorder.onChange(setMtRecording), []);
  const recordEnabled = canRecord();

  // Load the active document into the engine whenever its identity (id),
  // audio data (channels array reference), or sample rate changes — but NOT on
  // a metadata-only replacement (dirty/name/filePath/sourceBitDepth), which
  // still swaps the store's doc object (every mutator, including the marker
  // actions' `markDirty`, always replaces it) without touching the audio.
  // PlaybackEngine.load() always starts with stop() + a full AudioBuffer copy,
  // so keying on the whole `doc` object here would restart playback and
  // re-copy the entire PCM on every such replacement — since M1, that includes
  // every marker add/rename/delete (Task M9 / F13). Narrowing this key can only
  // fire the effect LESS often than the old `[doc]`, never more (M7 review), so
  // it's safe from that direction.
  useEffect(() => {
    if (doc) playbackEngine.load(doc);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deliberately
    // narrower than `[doc]`; see comment above.
  }, [doc?.id, doc?.channels, doc?.sampleRate]);

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
  //
  // F0: an automation edit (a per-track `automation` reference change) first
  // re-bakes THAT track's chain in place (`refreshTracks`, ruling D — the
  // envelope is baked into the buffers, so pushing node values cannot carry
  // it), then the ordinary param push runs; `applyTrackParams` itself skips
  // baked parameters (trap T2), so the push cannot stomp a neutralised node.
  // Non-automation edits take exactly the pre-F0 path.
  useEffect(() => {
    if (!isMultitrack || mtPlayState !== 'playing') return;
    return useSessionStore.subscribe((state, prev) => {
      if (state.session.tracks === prev.session.tracks) return;
      const prevById = new Map(prev.session.tracks.map((t) => [t.id, t]));
      const changedIds = state.session.tracks
        .filter((t) => {
          const p = prevById.get(t.id);
          return p !== undefined && p.automation !== t.automation;
        })
        .map((t) => t.id);
      if (changedIds.length > 0) {
        const docs = new Map<string, AudioDocument>(
          useAppStore.getState().documents.map((d) => [d.id, d])
        );
        multitrackPlayer.refreshTracks(state.session, docs, changedIds);
      }
      multitrackPlayer.applyTrackParams(state.session.tracks);
    });
  }, [isMultitrack, mtPlayState]);

  return (
    <div
      className="pointer-events-none absolute inset-x-0 top-2.5 z-20 grid items-center gap-3 px-4"
      style={{ gridTemplateColumns: '1fr auto 1fr' }}
    >
      <FileChip />

      <ChromePill
        data-testid="toolbar-pill"
        className="pointer-events-auto flex items-center"
        style={{
          borderRadius: '14px',
          padding: '6px 8px',
          gap: '3px',
          color: 'var(--glass-text-chrome-primary)',
        }}
      >
        {/* File ops — same commands as the File menu; runCommand re-checks
            enablement so the buttons can never outrun the registry. */}
        <PillButton label="Open" title="Open (Ctrl+O)" onClick={() => void runCommand('file.open')}>
          Open
        </PillButton>
        <PillButton
          label="Save"
          title="Save (Ctrl+S)"
          disabled={!hasDoc}
          onClick={() => void runCommand('file.save')}
        >
          Save
        </PillButton>
        <PillButton
          label="Export"
          title="Export (Ctrl+E)"
          disabled={!hasDoc}
          onClick={() => void runCommand('file.export')}
        >
          Export
        </PillButton>

        <Divider />

        {/* Transport — every control the bottom bar had, plus Go to Start
            (the mockup's ⏮, backed by the existing transport.goToStart). */}
        <PillButton
          label="Go to Start"
          icon
          disabled={!hasDoc}
          onClick={() => void runCommand('transport.goToStart')}
        >
          <SkipBack size={15} />
        </PillButton>
        <PillButton
          label="Stop"
          icon
          disabled={!canTransport}
          onClick={() => void runCommand('transport.stop')}
        >
          <Square size={13} fill="currentColor" />
        </PillButton>
        <PillButton
          label={isPlaying ? 'Pause' : 'Play'}
          active={isPlaying}
          disabled={!canTransport}
          onClick={() => void runCommand('transport.playPause')}
        >
          {isPlaying ? <Pause size={15} fill="currentColor" /> : <Play size={15} fill="currentColor" />}
          {isPlaying ? 'Pause' : 'Play'}
        </PillButton>
        <PillButton
          label={mtRecording ? 'Stop recording' : 'Record'}
          icon
          disabled={!recordEnabled}
          onClick={() => void runCommand('transport.record')}
        >
          <Circle
            size={13}
            fill="currentColor"
            className={`text-[#ef5350] ${mtRecording ? 'animate-pulse' : ''}`}
          />
        </PillButton>
        <PillButton
          label="Loop"
          icon
          active={playback.loop}
          disabled={!hasDoc}
          onClick={() => void runCommand('transport.toggleLoop')}
        >
          <Repeat size={14} />
        </PillButton>

        <Divider />

        {/* Editor view segment: Waveform | Spectral | Multitrack. Multitrack
            works without an open document; the single-doc views require one.
            Testid + aria contracts moved verbatim from the bottom bar. */}
        <div className="flex items-center" style={{ gap: '2px' }} data-testid="view-toggle">
          {(['waveform', 'spectral', 'multitrack'] as const).map((v) => (
            <button
              key={v}
              type="button"
              aria-label={`${v} view`}
              aria-pressed={view === v}
              disabled={v !== 'multitrack' && !hasDoc}
              onClick={() => useAppStore.getState().setView(v)}
              className="glass-pill-btn capitalize"
              style={{ ...pillBtn, padding: '0 12px', ...(view === v ? toggleActive : null) }}
            >
              {v}
            </button>
          ))}
        </div>

        <Divider />

        {/* Task B4 — the magnet. Snapping is a global interaction preference
            (it governs the editor cursor/selection AND multitrack clip drag and
            trim), so it lives in the chrome pill rather than in either view, is
            never disabled, and shows its state with the same accent tile Loop
            and the view segment use. The title carries the escape hatch, which
            is otherwise undiscoverable. */}
        <PillButton
          label="Snap to Grid"
          title={
            snapEnabled
              ? 'Snap to Grid: on — hold Alt to suspend'
              : 'Snap to Grid: off'
          }
          icon
          active={snapEnabled}
          onClick={() => toggleSnap()}
        >
          <Magnet size={14} />
        </PillButton>

        <Divider />

        {/* Zoom cluster (mockup − · % · + · Fit): buttons over the SAME store
            zoom the wheel gesture drives; Fit restores the activation default
            (= 100%). Multitrack keeps its own Ctrl+wheel mtZoom, so the
            cluster follows the single-document editor only. */}
        <PillButton label="Zoom Out" icon disabled={!hasDoc} onClick={() => zoomEditorBy(ZOOM_FACTOR)}>
          <Minus size={14} />
        </PillButton>
        <span
          data-testid="zoom-readout"
          style={{
            minWidth: '46px',
            textAlign: 'center',
            padding: '0 6px',
            fontSize: '11.5px',
            fontVariantNumeric: 'tabular-nums',
            fontFamily: 'Consolas, monospace',
            color: 'var(--glass-text-chrome-idle)',
          }}
        >
          {doc ? `${zoomPercent(doc, zoom.samplesPerPixel)}%` : '—'}
        </span>
        <PillButton label="Zoom In" icon disabled={!hasDoc} onClick={() => zoomEditorBy(1 / ZOOM_FACTOR)}>
          <Plus size={14} />
        </PillButton>
        <PillButton label="Fit" disabled={!hasDoc} onClick={zoomEditorFit}>
          Fit
        </PillButton>
      </ChromePill>

      {/* Right cell of the band grid — keeps the pill window-centered. */}
      <div />
    </div>
  );
}
