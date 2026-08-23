import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { Circle, Magnet, Minus, Pause, Play, Plus, Repeat, SkipBack, Square } from 'lucide-react';
import { docLength } from '../../audio/AudioDocument';
import type { AudioDocument } from '../../audio/AudioDocument';
import { playbackEngine } from '../../audio/PlaybackEngine';
import { multitrackPlayer } from '../../multitrack/MultitrackPlayer';
import { multitrackRecorder } from '../../multitrack/multitrackRecord';
import { applySessionZoom, useSessionStore } from '../../multitrack/sessionStore';
import type { Session } from '../../multitrack/session';
import { defaultSessionZoom, sessionTimelineLength } from '../../multitrack/sessionZoom';
import { isCommandEnabled, runCommand, showEditorView } from '../../services/menuActions';
import { useHistoryVersion } from '../../services/undoHistory';
import { toggleSnap, useSnapEnabled } from '../../services/snapPreference';
import { canRecord } from '../../services/transportService';
// F11-9: the zoom limits are the store's now, so the toolbar imports the one
// resolver instead of re-stating MIN_SPP and a ceiling of its own.
import { applyEditorZoom, defaultZoom, useAppStore } from '../../stores/appStore';
import { ZOOM_FACTOR } from '../Editor/useEditorGestures';
import { ChromePill } from '../UI/glass';

/**
 * v1.6 G3: the retired bottom TransportBar reborn as Vitrine's floating top
 * chrome pill (photo_app Layout/Toolbar.tsx anatomy). Since G6 the band truly
 * FLOATS over the radial stage (mockup `.toolbar` absolute placement — the
 * sidebars it used to avoid are floating overlays themselves now): an absolute
 * z-20 band whose empty stretches ignore pointer events so the stage beneath
 * stays live.
 *
 *   [Open | Save Export | ⏮ ⏹ ▶ ⏺ ⟳ | views | − % + Fit]        [module strip]
 *
 * U1 (layout E2): the top-left file chip is GONE. Its identity readout —
 * name · duration · rate · channels — folded into the bottom bar, where the
 * eye already goes for time and levels, and its zoom % died with it: the same
 * number is live two controls away in this pill's own − % + group, so the
 * chip was spending a whole floating surface on a duplicate. The band now
 * centres the pill on the waveform instead of the window (see the wrapper).
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
  return <div data-testid="toolbar-divider" aria-hidden="true" style={divider} />;
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

/**
 * F11-3 — THE ZOOM-% SEMANTICS, stated once, here.
 *
 * 100% is Fit: the whole track exactly fills the editor lane. Zooming in raises
 * the number — 200% shows half the track — and because Fit is also the furthest
 * the editor zooms out, the readout never drops below 100%.
 *
 * This is a deliberate change of meaning, not drift. Before F11-3, 100% meant
 * "the whole track across a nominal 1600 px viewport", which was the real lane
 * only by coincidence and was NOT the zoom-out limit (the wheel went 32x
 * further out, which is F11-9's bug). Anchoring the readout to the real fit
 * makes 100% a state the user can see and reach — it is what the Fit button
 * lands on, and what a freshly opened document starts at — instead of a
 * hardcoded number nothing on screen corresponds to.
 */
function zoomPercent(doc: AudioDocument, samplesPerPixel: number): number {
  return Math.round((defaultZoom(doc).samplesPerPixel / samplesPerPixel) * 100);
}

// F11-9: still used for the cursor anchor below; the ZOOM clamps are gone.
function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}

/** Zoom the single-document editor by `factor`, anchored on the cursor (the
 * only viewport-independent anchor available up here — the wheel gesture
 * anchors on the pointer instead).
 *
 * F11-9: no clamping here any more. This function used to re-state its own
 * `MIN_SPP` floor and `length / 50` ceiling "so the button path can never leave
 * the wheel range", which is exactly the kind of duplicate that drifts —
 * neither limit was the fit, so both buttons and wheel could zoom out into the
 * range where the waveform freezes and the tics keep moving. It now states a
 * request and `applyEditorZoom` resolves it against the one shared limit. */
function zoomEditorBy(factor: number): void {
  const s = useAppStore.getState();
  const doc = s.documents.find((d) => d.id === s.activeDocumentId) ?? null;
  if (!doc) return;
  const anchor = clamp(s.cursorSample, 0, docLength(doc));
  // Keep the anchor at the same on-screen x: x = (anchor - scroll) / sppOld.
  const x = (anchor - s.zoom.scrollSample) / s.zoom.samplesPerPixel;
  applyEditorZoom({
    samplesPerPixel: s.zoom.samplesPerPixel * factor,
    scrollSample: (spp) => anchor - x * spp,
  });
}

/** F11-3: Fit means the whole track across the MEASURED lane — and, since
 * F11-9, that is also the furthest the editor zooms out, so Fit is spelled as
 * "as far out as this document goes" rather than as a second copy of the fit
 * formula. */
function zoomEditorFit(): void {
  applyEditorZoom({ samplesPerPixel: Number.POSITIVE_INFINITY, scrollSample: 0 });
}

// ---------------------------------------------------------------------------
// MT1-1 — the same three gestures, for the session
// ---------------------------------------------------------------------------
/*
 * The cluster used to be editor-only, and said so: "Multitrack keeps its own
 * Ctrl+wheel mtZoom, so the cluster follows the single-document editor only."
 * That was the reported bug's other half. In the multitrack view the buttons
 * were live but drove the ZOOM OF A DOCUMENT THE USER WAS NOT LOOKING AT (or
 * were dead, with no document open), so "the tracks should appear Fit on the
 * longest one" had no control that could make it so — Fit fitted the editor.
 *
 * Each of the three below is the exact session twin of the editor function
 * above it, differing only in which store it resolves against. The percentage
 * means the same thing on both surfaces (100% == fit == the zoom-out limit), so
 * the readout does not change meaning when the user switches view.
 */
function sessionZoomPercent(session: Session, samplesPerPixel: number): number {
  return Math.round((defaultSessionZoom(session).samplesPerPixel / samplesPerPixel) * 100);
}

/** Zoom the session by `factor`, anchored on the multitrack cursor — the same
 * viewport-independent anchor `zoomEditorBy` uses, for the same reason. */
function zoomSessionBy(factor: number): void {
  const s = useSessionStore.getState();
  const anchor = clamp(s.mtCursorSample, 0, sessionTimelineLength(s.session));
  const x = (anchor - s.mtZoom.scrollSample) / s.mtZoom.samplesPerPixel;
  applySessionZoom({
    samplesPerPixel: s.mtZoom.samplesPerPixel * factor,
    scrollSample: (spp) => anchor - x * spp,
  });
}

/** Fit the SESSION: the longest track laid across the measured lane. Spelled as
 * "as far out as this session goes" so it cannot drift from the fit. */
function zoomSessionFit(): void {
  applySessionZoom({ samplesPerPixel: Number.POSITIVE_INFINITY, scrollSample: 0 });
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
  // MT1-1: the readout re-renders with the session's zoom and length.
  const session = useSessionStore((s) => s.session);
  const mtZoom = useSessionStore((s) => s.mtZoom);
  // Subscribe to the armed set (value unused directly) so canRecord() below is
  // re-evaluated whenever a track is armed/disarmed.
  useSessionStore((s) => s.session.tracks.some((t) => t.armed));

  // Lot A: Save / Export read the PROJECT through the commands' own
  // predicates. A clip move changes no appStore state — it writes the SESSION
  // store and pushes a history entry — so the pills also subscribe to the
  // history's version counter (MenuBar does the same), or the Save pill would
  // never light after a session edit and never dim after a save.
  useHistoryVersion();

  const hasDoc = doc !== null;
  // The Save pill's own enablement has to state the SAME condition as the
  // `file.save` command it runs, or the pill lights up for a command
  // `runCommand` will then refuse — a control that looks live and does
  // nothing. Under M4 that is the project's predicate (any document dirty,
  // the session dirty, or a never-written project with content) — asked of
  // the command itself rather than restated here.
  const canSave = isCommandEnabled('file.save');
  const isMultitrack = view === 'multitrack';
  // MT1-1: the zoom cluster is live whenever the ACTIVE surface has something to
  // zoom. In multitrack that is the session itself, which always has a timeline
  // (an empty one shows the 60 s placeholder), so the cluster no longer goes
  // dead just because no document happens to be open behind it.
  const canZoom = isMultitrack || hasDoc;
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
      className="pointer-events-none absolute inset-x-0 top-2.5 z-20 flex items-center justify-center"
      style={{
        // U1 (layout E2, element 2): the pill is centred on the WAVEFORM, not
        // on the window — the stage's own insets do it as padding, so opening
        // or closing the module card re-centres the pill in the same layout
        // pass, with nothing measured and no resize listener.
        //
        // F2: the right side used to carry `max(..., 362px)`, a clamp meant to
        // stop the pill sliding under the module strip when the card is closed
        // and the stage runs on beneath it. Measured in the built app, that
        // clamp was not protecting anything and cost the whole claim: the pill
        // is 860.5 px wide, the axis with the card closed is 799.7, so an
        // axis-centred pill ends at 1230 while the strip starts at 1237.4 — it
        // CLEARS by 7.4 px. The clamp meanwhile pushed the pill to 625.7, i.e.
        // 174 px off the axis the status and edit pills sit on, in the state
        // this layout newly made reachable. Dropped, so all three pills share
        // one axis in both card states, which is what the guide, the README and
        // the changelog have been claiming all along.
        //
        // The clearance is thin and content-dependent, so the smoke pins it
        // rather than trusting it: the only part of this pill that changes
        // width is the zoom readout, which grows once the percentage passes its
        // 46px min-width (measured: 860.5 px at "100%", 864.4 at "10842%",
        // ~3.9 px per further digit). Overlap needs the pill past 875.4 px —
        // about a nine-digit percentage, which takes a ~19-minute file at the
        // 1/32 samples-per-pixel maximum. Step 13b asserts the clearance at
        // both the default zoom and the deepest zoom the fixture allows, so
        // widening this pill fails loudly instead of quietly touching the strip.
        paddingLeft: 'var(--stage-inset-left, 14px)',
        paddingRight: 'var(--stage-inset-right, 376px)',
      }}
    >
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

        {/* Open and Save sat 3 px apart with nothing between them, and a click
            meant for Open landed on Save during a frozen frame — a full
            re-encode-and-write of a document the user never edited. The divider
            is the same one the other groups use; here it buys the pointer a
            target that is not a destructive command. */}
        <Divider />

        <PillButton
          label="Save"
          title="Save Project (Ctrl+S)"
          disabled={!canSave}
          onClick={() => void runCommand('file.save')}
        >
          Save
        </PillButton>
        <PillButton
          label="Export"
          title="Export (Ctrl+E)"
          // Lot A (M5): in the multitrack view Export renders the session, so
          // the pill follows `file.export`'s own predicate (the session
          // subscription above keeps it fresh as clips come and go).
          disabled={!isCommandEnabled('file.export')}
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
              onClick={() => (v === 'multitrack' ? useAppStore.getState().setView(v) : showEditorView(v))}
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
            (= 100%).

            F11-9: − and Fit now converge — Fit IS the furthest zoom-out, so
            holding − walks down to exactly the state Fit jumps to, and the
            readout bottoms out at 100%.

            MT1-1: and the cluster now follows the ACTIVE VIEW. It used to drive
            the editor unconditionally, which in the multitrack view meant Fit
            fitted a document the user was not looking at. Both surfaces define
            100% as their own fit, so only the target changes. */}
        <PillButton
          label="Zoom Out"
          icon
          disabled={!canZoom}
          onClick={() => (isMultitrack ? zoomSessionBy(ZOOM_FACTOR) : zoomEditorBy(ZOOM_FACTOR))}
        >
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
          {isMultitrack
            ? `${sessionZoomPercent(session, mtZoom.samplesPerPixel)}%`
            : doc
              ? `${zoomPercent(doc, zoom.samplesPerPixel)}%`
              : '—'}
        </span>
        <PillButton
          label="Zoom In"
          icon
          disabled={!canZoom}
          onClick={() => (isMultitrack ? zoomSessionBy(1 / ZOOM_FACTOR) : zoomEditorBy(1 / ZOOM_FACTOR))}
        >
          <Plus size={14} />
        </PillButton>
        <PillButton
          label="Fit"
          disabled={!canZoom}
          onClick={isMultitrack ? zoomSessionFit : zoomEditorFit}
        >
          Fit
        </PillButton>
      </ChromePill>
    </div>
  );
}
