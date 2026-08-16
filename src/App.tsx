import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { X } from 'lucide-react';
import WaveformView from './components/Editor/WaveformView';
import SpectrogramView from './components/Editor/SpectrogramView';
import MultitrackView from './components/Multitrack/MultitrackView';
import ConvertDialog from './components/Dialogs/ConvertDialog';
import EffectDialog from './components/Dialogs/EffectDialog';
import ExportDialog from './components/Dialogs/ExportDialog';
import NewFileDialog from './components/Dialogs/NewFileDialog';
import RecordDialog from './components/Dialogs/RecordDialog';
// U2: the nine pipeline tools are no longer mounted here as modals — they are
// mounted by the host card, in the module column, unchanged. See
// components/Dialogs/PipelineToolHost.tsx for the registry and the width.
import PipelineToolHost, { TOOL_HOST_WIDTH } from './components/Dialogs/PipelineToolHost';
import EffectsPanel from './components/Panels/EffectsPanel';
import FilesPanel from './components/Panels/FilesPanel';
import HistoryPanel from './components/Panels/HistoryPanel';
import MarkersPanel from './components/Panels/MarkersPanel';
// U2: the Pipeline module's card — the Pipeline menu's tools, same registry.
import PipelinePanel from './components/Panels/PipelinePanel';
import PropertiesPanel from './components/Panels/PropertiesPanel';
import RemixPanel from './components/Panels/RemixPanel';
import SpatialPanel from './components/Panels/SpatialPanel';
import TranscriptPanel from './components/Panels/TranscriptPanel';
import EditToolbar from './components/Layout/EditToolbar';
import ModuleStrip, {
  // U2: the app-start card, derived from the strip registry's lead entry.
  DEFAULT_PANEL,
  MODULE_COLUMN_WIDTH,
  MODULE_PANELS,
  type PanelId,
} from './components/Layout/ModuleStrip';
import StatusBar from './components/Layout/StatusBar';
import TempoCard from './components/Layout/TempoCard';
import TitleBar from './components/Layout/TitleBar';
import Toolbar from './components/Layout/Toolbar';
import { GlassCard, IconTile } from './components/UI/glass';
import { registerAllEffects } from './effects/registerAll';
import {
  registerDialogSetters,
  setHostedToolRunning,
  type ConvertMode,
} from './services/dialogBus';
import { getInFlightSaveCount, hasUnsavedWork } from './services/fileService';
import { getRemixSession, useRemixVersion } from './services/remixService';
import { getStemBusyCount } from './services/stemService';
import { getTranscribeBusyCount } from './services/transcribeService';
import { getVoiceBusyCount } from './services/voiceService';
import { getAlignBusyCount } from './services/alignLyricsService';
import { registerEffectCommands } from './services/menuActions';
// U2-3: the running tool's own label, for the refusal message.
import { getPipelineGroups } from './services/pipelineTools';
import { installShortcuts } from './services/shortcuts';
import { installTestHooks } from './services/testHooks';
import { stopAll } from './services/transportService';
import { useAppStore } from './stores/appStore';

// G4: the two flat sidebars (left Files/Effects column + right tab strip)
// became ONE icon rail driving a single glass panel card, with
// Files and Effects as additive entries now that the always-visible left
// column is retired (user-approved via the 2026-07-28 mockup). 'remix' is
// also reachable through `focusRemixPanel()` (dialogBus) the moment a remix
// document is created, without the user finding the rail entry first.
//
// F11-8: that "also" is the whole rule now for three of the panels. The strip
// draws five permanent icons; Remix appears only while a remix document exists,
// and Spatial and Transcript have no icon at all — they are single tools, so
// their commands (`spatial.position`, `edit.transcribe`) put their panels in
// this same card through the bus. The card renders from MODULE_PANELS, which is
// the wider list.
//
// U1: the rail rotated horizontal and moved into components/Layout/
// ModuleStrip.tsx (layout E2) — same ids, same order, same `sidebar-tabs`
// testid and accessible names; see that file for the anatomy and for why the
// active entry now toggles its card closed.

// The module column's right/top/bottom margins. Left as constants because two
// separate surfaces have to agree on them: the column itself, and the stage
// inset the editor views lay out against.
const COLUMN_MARGIN = 14;
/** Stage clearance while a panel card is open: the column's footprint plus one
 * margin of air between the card and the waveform. */
const STAGE_INSET_RIGHT_OPEN = COLUMN_MARGIN + MODULE_COLUMN_WIDTH + COLUMN_MARGIN;
/** U2-3: the same clearance for the wider tool-host card. The host grows
 * leftward out of the 348px column (see TOOL_HOST_WIDTH), so the stage has to
 * step back by the difference or the waveform would run under it. */
const STAGE_INSET_RIGHT_HOSTED = COLUMN_MARGIN + TOOL_HOST_WIDTH + COLUMN_MARGIN;

/** U2-3: the strip's tooltip while a hosted pass is running. Stated once so the
 * sentence the user reads and the rule the code enforces are the same fact. */
const MODULE_SWITCH_LOCKED =
  'A pipeline pass is running — switching module would discard it. The waveform and transport stay usable.';

// Populate the effect registry and its menu commands once at module load — before
// the first render — so the Effects menu and panel are fully built on first paint.
registerAllEffects();
registerEffectCommands();

export default function App() {
  const documents = useAppStore((s) => s.documents);
  const activeDocumentId = useAppStore((s) => s.activeDocumentId);
  const view = useAppStore((s) => s.view);
  const doc = documents.find((d) => d.id === activeDocumentId) ?? null;

  const [exportOpen, setExportOpen] = useState(false);
  const [newFileOpen, setNewFileOpen] = useState(false);
  const [effectDialogId, setEffectDialogId] = useState<string | null>(null);
  const [convertMode, setConvertMode] = useState<ConvertMode | null>(null);
  const [recordOpen, setRecordOpen] = useState(false);
  // U2-3: the nine `useState` flags that used to mount nine modals became ONE
  // command id — the pipeline tool the module column is hosting, or null.
  // One at a time by construction, which is what makes `setHostedToolRunning`
  // a boolean rather than a counter.
  const [hostedTool, setHostedTool] = useState<string | null>(null);
  // The hosted dialog's own `dismissable`, inverted: true while a pass is
  // running and the tool refuses to be discarded.
  const [toolRunning, setToolRunning] = useState(false);
  // U1: null = no panel card open. The strip's active entry closes it, which
  // is what lets the stage take the column's width (E2's "the waveform takes
  // every liberated pixel").
  //
  // F11-8: the card is resolved against MODULE_PANELS — every panel — while the
  // strip draws icons for a subset, so `sidebarTab` can legitimately name a
  // panel with no icon (Spatial, Transcript) that a command opened.
  //
  // U2: the app opens on FILES (the user: "make 'Files' default at opening";
  // it was History). `DEFAULT_PANEL` rather than the literal, because Files
  // leading the strip and Files opening the app are ONE fact — see
  // ModuleStrip's `slot`. Nothing persists this: `sidebarTab` is plain
  // component state with no storage behind it (the session restores documents
  // and the view, never the panel), so the rule is simply "first paint opens
  // Files" and there is no restored state to fight.
  const [sidebarTab, setSidebarTab] = useState<PanelId | null>(DEFAULT_PANEL);
  const activeTab = MODULE_PANELS.find((t) => t.id === sidebarTab) ?? null;
  const ActiveIcon = activeTab?.Icon ?? null;

  // F11-8: "Remix should only appear when a remix is created" — so the entry's
  // condition is the app's own notion of a remix document existing, read from
  // remixService's session map (`getRemixSession`, the same question RemixPanel
  // asks to decide it has something to show) over the OPEN documents. No new
  // flag: a session is created by `createRemix` and dropped by
  // `invalidateRemixSession`, which `closeDocumentFlow` already calls for the
  // remix and its source. `useRemixVersion()` is the subscription that makes it
  // reactive — that map is module state behind `useSyncExternalStore`, not
  // zustand, exactly as RemixPanel documents.
  useRemixVersion();
  const hasRemix = documents.some((d) => getRemixSession(d.id) !== null);

  // The one state the contextual entry can strand: the card is showing Remix
  // when the last remix document goes. It closes — leaving it open would strand
  // a card whose strip entry has just been taken away, and E2's rule is that a
  // closed card hands the column's width back to the waveform.
  useEffect(() => {
    if (sidebarTab === 'remix' && !hasRemix) setSidebarTab(null);
  }, [sidebarTab, hasRemix]);

  /**
   * U2-3 — what happens when the user tries to leave a RUNNING pass, and why
   * it is a refusal rather than a background run that reattaches.
   *
   * The nicer answer would be to let the pass continue headless and have the
   * stepper pick it back up on return. It is not available, and the reason is
   * in the dialogs rather than in this file — but it is not one reason, it is
   * two, and an earlier draft of this comment claimed all nine shared the
   * first. They do not.
   *
   * SEVEN discard the result. They keep the pass in component state (`busy`,
   * `progress`, `liveResults`, `stageProgress`) paired with an unmount-cancel
   * ref — RemixDialog's `cancelledRef`, SeparateDialog's and TranscribeDialog's
   * `unmountedRef`, and the copies the two chains name after them. Those refs
   * do not merely silence a setState after unmount: each run body reads
   * `if (cancelledRef.current) return;` after its await and DISCARDS the
   * finished result. Unmounting one does not background it, it throws the pass
   * away — minutes of inference, silently.
   *
   * TWO used to do the opposite, and blocking was if anything more necessary
   * for them. `TempoDialog` guarded only a DOM ref, and `AlignTimingDialog` had
   * no unmount ref at all: their `applyTempoChange` / align calls resolved and
   * wrote to the store whichever way the UI went. Unmounting those mid-pass did
   * not lose the work — it ORPHANED it, committing an edit and an undo entry to
   * a document the user had walked away from, with no surface left that said it
   * happened.
   *
   * **T6-3 closed that, and the lock still stands.** Both now carry the cancel
   * ref the recorded follow-up asked for, read by `runEffectOnSelection` between
   * the audio arriving and `applyEdit` writing it, so a cancelled pass commits
   * nothing — no stretch, no marker correction, no beat grid — and says
   * `'cancelled'` rather than reporting the user's own walk-away as a no-op.
   * Every unmount-shaped exit is now genuinely safe: the strip, the ✕, another
   * pipeline tool, `focusSpatialPanel`.
   *
   * Relaxing the lock for these two was considered and REFUSED, because
   * `moduleLock` is one flag driving four things and only three of them are
   * unmount-shaped. The fourth is the keyboard suspension below, and the hazard
   * it guards happens with the tool STILL MOUNTED — so no cancel ref can see it.
   * `Ctrl+O` mid-pass makes another document active; the pass is pinned to its
   * own `docId` and commits to the right audio, but `applyEdit` writes the
   * GLOBAL selection and cursor (`editOps.ts`), which now belong to the document
   * the user moved to. `Ctrl+W` on the running document is worse: `applyEdit`
   * throws and the user is shown an "Effect failed" they did not cause. Trading
   * a lock for that race is exactly what the retrofit was not for. The two are
   * separable in principle — a second seam distinguishing "hold the module
   * column" from "hold the keyboard" — and that is a change of its own, with its
   * own evidence, not a side effect of this one.
   *
   * Worth stating plainly: even relaxed, switching module mid-pass would now
   * DISCARD the run rather than orphan it. The retrofit turned a silent wrong
   * commit into a silent loss of minutes of work. Safe is not the same as free,
   * and blocking is still the better answer to "the user is about to lose this".
   *
   * What "the app stays live" does and does not mean. MOUSE interaction is
   * untouched throughout: the waveform, the transport, the toolbar, selection,
   * the playhead and the view segment all keep working, which is the point of
   * hosting. The KEYBOARD is not — for the duration of a run only,
   * `hasOpenDialog()` reports true and `shortcuts.ts` bails out of every global
   * shortcut, so Space, Ctrl+Z and the arrows are suspended. That is deliberate
   * and it is the F10 guard kept where it is still earned: these tools resolve
   * their target document from the live `activeDocumentId`, so a Ctrl+O behind
   * a running pass would land it on a document the user had just replaced.
   */
  const toolRunningRef = useRef(false);
  const hostedToolRef = useRef<string | null>(null);
  hostedToolRef.current = hostedTool;

  const refuseWhileRunning = useCallback(() => {
    const label =
      getPipelineGroups()
        .flatMap((g) => g.commands)
        .find((c) => c.id === hostedToolRef.current)?.label ?? 'A pipeline pass';
    void window.electronAPI?.showMessageBox({
      type: 'info',
      title: 'A pass is running',
      message:
        `${label} is still running.\n\n` +
        'Its progress lives in the tool, so leaving now would discard the pass. ' +
        'Wait for it to finish — the waveform, the transport and the editor stay ' +
        'usable with the mouse while it runs (keyboard shortcuts resume when it ' +
        'is done).',
    });
  }, []);

  /** U2-3: mount a pipeline tool in the module column, with the strip showing
   * Pipeline as the active module. */
  const openTool = useCallback(
    (commandId: string) => {
      if (toolRunningRef.current) {
        refuseWhileRunning();
        return;
      }
      setSidebarTab('pipeline');
      setHostedTool(commandId);
    },
    [refuseWhileRunning]
  );

  /**
   * U2-3: put a PANEL in the card, dropping any hosted tool. The three
   * `focus*Panel` bus entries land here — and they do NOT all get the same
   * treatment, because they are not the same kind of request.
   *
   * `focusRemixPanel` and `focusTranscriptPanel` are a FINISHING TOOL handing
   * over its own result: RemixDialog calls one straight after `onClose()`,
   * TranscribeDialog calls the other straight before it, both from inside the
   * handler that has just completed the pass. Refusing those would strand the
   * user in a tool with nothing left to say — and it would happen every time,
   * because a dialog's `busy` flag and its follow-up call are the same
   * synchronous block: React has not re-rendered yet, so "is a pass running"
   * still reads true at the instant the tool says it is done. That is not a
   * race to fix here; it is the wrong question being asked of the wrong caller.
   *
   * `focusSpatialPanel` is different in kind: its only caller is the
   * `spatial.position` COMMAND, i.e. the user picking a menu row, which mid-run
   * would unmount a running tool and discard the pass exactly as switching
   * module would. So that one is guarded, and the two hand-offs are not.
   */
  const showPanel = useCallback(
    (panel: PanelId, guard: 'guard-while-running' | 'tool-handover' = 'tool-handover') => {
      if (guard === 'guard-while-running' && toolRunningRef.current) {
        refuseWhileRunning();
        return;
      }
      // The tool is going; nothing it reports after this can be trusted, and a
      // stale `true` would lock the strip for the session.
      toolRunningRef.current = false;
      setToolRunning(false);
      setHostedToolRunning(false);
      setHostedTool(null);
      setSidebarTab(panel);
    },
    [refuseWhileRunning]
  );

  /** U2-3: the host's own dismissal. Clearing the flag here is what makes
   * RemixDialog's `onClose(); focusRemixPanel();` work — by the time it closes
   * itself the pass is over, whatever its not-yet-committed state still says. */
  const closeTool = useCallback(() => {
    toolRunningRef.current = false;
    setToolRunning(false);
    setHostedToolRunning(false);
    setHostedTool(null);
  }, []);

  /** U2-3: the strip's own selection — never reached while a pass runs, because
   * the strip is disabled then (`lockedReason`). */
  const selectModule = useCallback((tab: PanelId | null) => {
    setHostedTool(null);
    setSidebarTab(tab);
  }, []);

  /**
   * U2-3: the hosted tool's module LOCK, arriving through the shell — normally
   * `!dismissable`, narrower for a tool that starts something on mount (see
   * `DialogShell`'s `moduleLock`). It is mirrored into three places because
   * three surfaces need the same fact and none of them may re-derive it: React
   * state (the strip's greying), a ref (the bus callbacks are registered once
   * and would otherwise close over a stale value), and `dialogBus` (so
   * `hasOpenDialog()` keeps the global shortcuts off a running pass's document,
   * the F10 guard hosting would otherwise have quietly removed).
   */
  const handleToolModuleLock = useCallback((running: boolean) => {
    toolRunningRef.current = running;
    setToolRunning(running);
    setHostedToolRunning(running);
  }, []);

  // Global keyboard shortcuts (Task 8): mounted once for the app's lifetime.
  useEffect(() => installShortcuts(window), []);

  // F11: the window-level FILE-drop guard.
  //
  // What this is honestly for. `navigateOnDragDrop` — the webPreferences flag
  // that would make Chromium navigate to a dropped file, replacing the whole
  // app with a file viewer — has defaulted to FALSE since Electron 3, and
  // `electron/main.cjs` never sets it. So the catastrophe this guard was
  // originally justified by is not currently reachable. It stays because the
  // insurance costs one condition and the failure mode it covers is total: if
  // that flag is ever flipped, or a future Electron changes its default back,
  // a near miss on a track lane would silently discard every open document.
  //
  // What it must NOT do is fire on anything else. The first version refused
  // EVERY drop, and the default action it was suppressing for text drags is
  // the one that inserts the text into a text control — which silently broke
  // dragging text into the lyrics, remix, voice-changer and properties fields.
  // Gating on `types` restores all of them: a text drag carries `text/plain`,
  // a clip drag carries our own MIME, and neither carries `Files`.
  //
  // It is not a competing drop handler: it reads one field and imports nothing.
  // The lane handlers are React listeners on the root container, inside
  // `window`, so they have already run by the time this fires.
  //
  // `dragover` gets the same condition, because a `drop` whose `dragover` was
  // not prevented never fires at all — treating the two differently would make
  // the guard's own behaviour depend on which half ran.
  useEffect(() => {
    const refuseFiles = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes('Files')) e.preventDefault();
    };
    window.addEventListener('dragover', refuseFiles);
    window.addEventListener('drop', refuseFiles);
    return () => {
      window.removeEventListener('dragover', refuseFiles);
      window.removeEventListener('drop', refuseFiles);
    };
  }, []);

  // Switching views mid-playback otherwise orphans whichever engine was
  // playing (transportStop() only routes to the CURRENT view's engine) — stop
  // BOTH engines whenever the view changes. Skips the initial mount (there is
  // nothing to stop yet, and stopAll() is idempotent/no-op-safe regardless).
  const prevViewRef = useRef(view);
  useEffect(() => {
    if (prevViewRef.current !== view) {
      stopAll();
    }
    prevViewRef.current = view;
  }, [view]);

  // Let the file.new / file.export commands open these React dialogs (Task 11).
  //
  // U2-3: the nine pipeline openers no longer raise a modal flag. They name the
  // command whose tool the module column should HOST, and every door the user
  // has — the Pipeline card, the Pipeline menu, the Effects card's tool rows —
  // arrives here, because all three go through `runCommand` and every one of
  // those commands' `run()` bodies calls one of these openers. Routing at the
  // bus is what made "from every door" one change rather than three.
  useEffect(
    () =>
      registerDialogSetters({
        openNewFileDialog: () => setNewFileOpen(true),
        openExportDialog: () => setExportOpen(true),
        openEffectDialog: (effectId) => setEffectDialogId(effectId),
        openConvertDialog: (mode) => setConvertMode(mode),
        openRecordDialog: () => setRecordOpen(true),
        openTempoDialog: () => openTool('tempo.match'),
        openRemixDialog: () => openTool('edit.remix'),
        openSeparateDialog: () => openTool('edit.separateStems'),
        openTranscribeDialog: () => openTool('edit.transcribe'),
        openVoiceChangerDialog: () => openTool('edit.voiceChanger'),
        openAlignTimingDialog: () => openTool('timing.align'),
        openVocalChainDialog: () => openTool('effects.vocalChain'),
        openCoverChainDialog: () => openTool('effects.coverChain'),
        openAlignLyricsDialog: () => openTool('lyrics.align'),
        // U2-3: hand-offs from a tool that has just finished — never refused.
        focusRemixPanel: () => showPanel('remix'),
        focusTranscriptPanel: () => showPanel('transcript'),
        // F11-8: the Mix command's only effect (Effects > Mix since T8,
        // Pipeline > Mix before it). Spatial is a single
        // tool rather than a module (user ruling), so this is how its panel
        // reaches the card now that the strip draws no icon for it.
        // U2-3: a user COMMAND rather than a hand-off, so it is guarded.
        focusSpatialPanel: () => showPanel('spatial', 'guard-while-running'),
      }),
    [openTool, showPanel]
  );

  // Scripted-smoke test hooks — only when the preload flagged test mode.
  useEffect(() => {
    if ((window as unknown as { __auditoriumTest?: boolean }).__auditoriumTest) {
      installTestHooks();
    }
  }, []);

  // Native close guard (Task F8, replaces the old beforeunload handler): main
  // intercepts the window's 'close' event and asks how many documents would
  // lose work; we answer with the count read at REQUEST time (getState, not a
  // stale render closure). Main then closes silently (0) or shows a native
  // Quit/Cancel box. See electron/closeGuard.cjs.
  //
  // The busy count is saves-in-flight PLUS any in-flight stem separation
  // (Task S3, ruling 7): a separation is minutes of inference the user cannot
  // get back, so quitting mid-run must warn rather than discard it silently.
  //
  // The count is `dirty || neverSaved`, matching closeDocumentFlow (Task S4):
  // a computed document (Mix Down, Remix N, a recording, a stem) is CLEAN from
  // birth, so counting `dirty` alone let Quit discard the whole thing without
  // asking — the same silent loss the per-document close prompt exists to
  // prevent, one level up.
  useEffect(() => {
    const api = window.electronAPI;
    if (!api?.onCloseRequested) return; // jsdom / older preload
    return api.onCloseRequested(() => {
      const unsaved = useAppStore
        .getState()
        .documents.filter(hasUnsavedWork).length;
      api.respondCloseRequest(
        unsaved,
        getInFlightSaveCount() +
          getStemBusyCount() +
          getTranscribeBusyCount() +
          getVoiceBusyCount() +
          getAlignBusyCount()
      );
    });
  }, []);

  return (
    <div
      data-testid="app-root"
      className="flex h-screen w-screen flex-col bg-[#1a1a1e] text-[#d4d4d8]"
    >
      <TitleBar />
      {/* G6: the editor canvas IS the stage — one relative surface carrying
          the radial --canvas-bg with the active view in flow (each view roots
          itself with .stage-inset clearance) and every piece of chrome
          floating over it as an absolute z-20 overlay: the G3 toolbar band
          (pill + file chip), the G4 card column and icon rail, and the G2
          status pill. Z-order: dialogs (DialogShell, fixed z-40) above
          chrome (z-20) above lanes (in-flow). The titlebar's menu dropdowns
          sit at z-50 in their own band above everything, as before. */}
      <div
        data-testid="editor-stage"
        className="relative flex min-h-0 min-w-0 flex-1 flex-col"
        style={
          {
            backgroundImage: 'var(--canvas-bg)',
            // U1 (layout E2): the stage's horizontal clearance, published as
            // tokens so THREE surfaces stay on one axis without measuring
            // anything — the editor views' `.stage-inset`, the toolbar band
            // and the bottom band, which centre themselves on the stage box by
            // padding rather than on the window. The right value collapses
            // when no panel card is open, and every one of them follows in the
            // same layout pass. The TEMPO card keeps floating top-right in the
            // collapsed state (it is chrome over the stage, exactly like the
            // toolbar, status and edit pills) rather than holding 362px of
            // width hostage for a 90px card.
            '--stage-inset-left': `${COLUMN_MARGIN}px`,
            // U2-3: three states now — no card, a module card, and the wider
            // tool host.
            '--stage-inset-right': `${
              hostedTool !== null
                ? STAGE_INSET_RIGHT_HOSTED
                : sidebarTab === null
                  ? COLUMN_MARGIN
                  : STAGE_INSET_RIGHT_OPEN
            }px`,
          } as CSSProperties
        }
      >
        {view === 'multitrack' ? (
          <MultitrackView />
        ) : doc && view === 'spectral' ? (
          // F11-0: the ID, never the document — a 65 MiB object graph in a
          // prop wedged React 19's dev profiler permanently (see
          // src/dev/userTimingGuard.ts).
          <SpectrogramView docId={doc.id} />
        ) : doc ? (
          <WaveformView docId={doc.id} />
        ) : (
          <div
            className="flex flex-1 items-center justify-center text-center"
            style={{ color: 'var(--glass-text-muted)' }}
          >
            Open an audio file (Ctrl+O) or create a new one (Ctrl+N)
          </div>
        )}

        {/* G3 toolbar band: transport/view/zoom pill + file chip, floating
            top-centre / top-left (mockup `.toolbar` / `.filechip`). */}
        <Toolbar />

        {/* G4 card column (mockup `.col`, 348px), floating top-right: the
            persistent TEMPO card (hidden until an analysis exists) above ONE
            glass panel card for the strip's active entry. The card hugs its
            content and scrolls internally when it outgrows the column
            (scroll containment preserved). The wrapper ignores pointer
            events so the empty column strip never blocks the stage. Top is
            68 (the stage-inset top), NOT the toolbar-band top: the strip now
            occupies the band's right end, and the column stacks beneath it
            aligned with the lanes.

            U1: the column moved from `right: 84` to the window's own 14px
            margin — the 72px the vertical rail used to hold at the edge is
            waveform now. */}
        <div
          className="pointer-events-none absolute z-20 flex flex-col"
          style={{
            top: 68,
            right: COLUMN_MARGIN,
            bottom: 58,
            width: MODULE_COLUMN_WIDTH,
            gap: 14,
          }}
        >
          <TempoCard />
          {/* U2-3: the tool host REPLACES the module card while a pipeline tool
              is open — same anchor, same glass language, wider. No backdrop and
              no focus trap: the stage behind it stays live, which is the whole
              point (watch the stepper beside the waveform). */}
          {hostedTool !== null ? (
            <PipelineToolHost
              commandId={hostedTool}
              onClose={closeTool}
              onModuleLockChange={handleToolModuleLock}
            />
          ) : (
            activeTab &&
            ActiveIcon && (
            <GlassCard
              data-testid="sidebar-panel"
              data-active-tab={activeTab.id}
              className="pointer-events-auto flex min-h-0 flex-col"
              style={{ flex: '0 1 auto', overflow: 'hidden' }}
            >
              <div
                className="flex shrink-0 items-center"
                style={{
                  padding: '13px 16px',
                  gap: 11,
                  background: 'rgba(0,0,0,.3)',
                  borderBottom: '1px solid var(--glass-border)',
                }}
              >
                <IconTile>
                  <ActiveIcon size={15} />
                </IconTile>
                <span
                  className="min-w-0 flex-1 truncate"
                  style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--glass-text-title)' }}
                >
                  {activeTab.label}
                </span>
                {/* F11-8: the card closes from its own header. Until now the
                    strip's active entry was the ONLY way to close it — which
                    stops being true the moment a card can show a panel the
                    strip draws no icon for (Spatial, Transcript, and Remix
                    after its last remix document goes). One rule for every
                    panel rather than a conditional control: a card you opened
                    is a card you can close, wherever you opened it from. */}
                <button
                  type="button"
                  data-testid="sidebar-panel-close"
                  aria-label={`Close the ${activeTab.label} panel`}
                  title="Close this panel"
                  onClick={() => setSidebarTab(null)}
                  className="glass-rail-btn flex shrink-0 items-center justify-center"
                  style={{
                    width: 22,
                    height: 22,
                    borderRadius: 7,
                    border: '1px solid transparent',
                    background: 'transparent',
                    color: 'var(--glass-text-chrome-idle)',
                    cursor: 'pointer',
                  }}
                >
                  <X size={13} />
                </button>
              </div>
              <div className="min-h-0 overflow-auto">
                {sidebarTab === 'files' && <FilesPanel />}
                {sidebarTab === 'effects' && <EffectsPanel />}
                {/* U2: the new module. */}
                {sidebarTab === 'pipeline' && <PipelinePanel />}
                {sidebarTab === 'history' && <HistoryPanel />}
                {sidebarTab === 'markers' && <MarkersPanel />}
                {sidebarTab === 'properties' && <PropertiesPanel />}
                {sidebarTab === 'remix' && <RemixPanel />}
                {sidebarTab === 'spatial' && <SpatialPanel />}
                {sidebarTab === 'transcript' && <TranscriptPanel />}
              </div>
            </GlassCard>
            )
          )}
        </div>

        {/* U1: the module strip — the G4 icon rail rotated horizontal, sitting
            in the toolbar band at the column's width and driving the card
            below it.

            U2-3: `lockedReason` is set only while a hosted pass is RUNNING —
            switching module then would unmount the tool, and every one of the
            nine discards its result on unmount (see `refuseWhileRunning`).

            W1: `toolHosted` widens the strip to the host card's own width
            while a tool is open — the user's rule that the bar and the open
            module are never unequal. */}
        <ModuleStrip
          activeTab={sidebarTab}
          hasRemix={hasRemix}
          lockedReason={toolRunning ? MODULE_SWITCH_LOCKED : null}
          toolHosted={hostedTool !== null}
          onSelect={selectModule}
        />

        {/* U1 bottom band (mockup E2): the edit pill floating ABOVE the G2
            status pill, both centred on the WAVEFORM's axis rather than the
            window's — the stage-inset tokens do the centring as padding, so
            opening or closing the module card re-centres both in the same
            layout pass. A flex COLUMN owns the 16px of clear air between
            them, so they read as two things (mockup E2's spacing, against
            option A's touching stack) whatever either pill's content does to
            its height. The edit pill renders nothing in the empty app, and
            the column collapses to the status pill alone. */}
        <div
          className="pointer-events-none absolute inset-x-0 bottom-3 z-20 flex flex-col items-center"
          style={{
            gap: 16,
            paddingLeft: 'var(--stage-inset-left)',
            paddingRight: 'var(--stage-inset-right)',
          }}
        >
          <EditToolbar />
          <StatusBar />
        </div>
      </div>

      {newFileOpen && <NewFileDialog onClose={() => setNewFileOpen(false)} />}
      {exportOpen && <ExportDialog onClose={() => setExportOpen(false)} />}
      {effectDialogId && (
        <EffectDialog effectId={effectDialogId} onClose={() => setEffectDialogId(null)} />
      )}
      {convertMode && (
        <ConvertDialog mode={convertMode} onClose={() => setConvertMode(null)} />
      )}
      {recordOpen && <RecordDialog onClose={() => setRecordOpen(false)} />}
      {/* U2-3: the nine pipeline tools used to be mounted here, each behind its
          own `useState` flag, each raising a full-screen backdrop. They are in
          the module column now (see the card column above). What stays modal is
          the set that is a QUESTION rather than a workspace: New File, Export,
          Convert, Record and the per-effect parameter dialogs each take one
          answer and close, and none of them has anything to watch on the stage
          while it is open. */}
    </div>
  );
}
