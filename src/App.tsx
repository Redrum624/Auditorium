import { useEffect, useRef, useState, type CSSProperties } from 'react';
import WaveformView from './components/Editor/WaveformView';
import SpectrogramView from './components/Editor/SpectrogramView';
import MultitrackView from './components/Multitrack/MultitrackView';
import ConvertDialog from './components/Dialogs/ConvertDialog';
import EffectDialog from './components/Dialogs/EffectDialog';
import ExportDialog from './components/Dialogs/ExportDialog';
import NewFileDialog from './components/Dialogs/NewFileDialog';
import RecordDialog from './components/Dialogs/RecordDialog';
import RemixDialog from './components/Dialogs/RemixDialog';
import SeparateDialog from './components/Dialogs/SeparateDialog';
import TempoDialog from './components/Dialogs/TempoDialog';
import TranscribeDialog from './components/Dialogs/TranscribeDialog';
import VoiceChangerDialog from './components/Dialogs/VoiceChangerDialog';
import AlignTimingDialog from './components/Dialogs/AlignTimingDialog';
import AlignLyricsDialog from './components/Dialogs/AlignLyricsDialog';
import VocalChainDialog from './components/Dialogs/VocalChainDialog';
import CoverChainDialog from './components/Dialogs/CoverChainDialog';
import EffectsPanel from './components/Panels/EffectsPanel';
import FilesPanel from './components/Panels/FilesPanel';
import HistoryPanel from './components/Panels/HistoryPanel';
import MarkersPanel from './components/Panels/MarkersPanel';
import PropertiesPanel from './components/Panels/PropertiesPanel';
import RemixPanel from './components/Panels/RemixPanel';
import SpatialPanel from './components/Panels/SpatialPanel';
import TranscriptPanel from './components/Panels/TranscriptPanel';
import EditToolbar from './components/Layout/EditToolbar';
import ModuleStrip, {
  MODULE_COLUMN_WIDTH,
  SIDEBAR_TABS,
  type SidebarTab,
} from './components/Layout/ModuleStrip';
import StatusBar from './components/Layout/StatusBar';
import TempoCard from './components/Layout/TempoCard';
import TitleBar from './components/Layout/TitleBar';
import Toolbar from './components/Layout/Toolbar';
import { GlassCard, IconTile } from './components/UI/glass';
import { registerAllEffects } from './effects/registerAll';
import { registerDialogSetters, type ConvertMode } from './services/dialogBus';
import { getInFlightSaveCount, hasUnsavedWork } from './services/fileService';
import { getStemBusyCount } from './services/stemService';
import { getTranscribeBusyCount } from './services/transcribeService';
import { getVoiceBusyCount } from './services/voiceService';
import { getAlignBusyCount } from './services/alignLyricsService';
import { registerEffectCommands } from './services/menuActions';
import { installShortcuts } from './services/shortcuts';
import { installTestHooks } from './services/testHooks';
import { stopAll } from './services/transportService';
import { useAppStore } from './stores/appStore';

// G4: the two flat sidebars (left Files/Effects column + right tab strip)
// became ONE right-edge icon rail driving a single glass panel card, with
// Files and Effects as additive entries now that the always-visible left
// column is retired (user-approved via the 2026-07-28 mockup). 'remix' is
// also reachable through `focusRemixPanel()` (dialogBus) the moment a remix
// document is created, without the user finding the rail entry first.
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
  const [tempoOpen, setTempoOpen] = useState(false);
  const [remixOpen, setRemixOpen] = useState(false);
  const [separateOpen, setSeparateOpen] = useState(false);
  const [transcribeOpen, setTranscribeOpen] = useState(false);
  const [voiceChangerOpen, setVoiceChangerOpen] = useState(false);
  const [alignTimingOpen, setAlignTimingOpen] = useState(false);
  const [vocalChainOpen, setVocalChainOpen] = useState(false);
  const [coverChainOpen, setCoverChainOpen] = useState(false);
  const [alignLyricsOpen, setAlignLyricsOpen] = useState(false);
  // U1: null = no panel card open. The strip's active entry closes it, which
  // is what lets the stage take the column's width (E2's "the waveform takes
  // every liberated pixel").
  const [sidebarTab, setSidebarTab] = useState<SidebarTab | null>('history');
  const activeTab = SIDEBAR_TABS.find((t) => t.id === sidebarTab) ?? null;
  const ActiveIcon = activeTab?.Icon ?? null;

  // Global keyboard shortcuts (Task 8): mounted once for the app's lifetime.
  useEffect(() => installShortcuts(window), []);

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
  useEffect(
    () =>
      registerDialogSetters({
        openNewFileDialog: () => setNewFileOpen(true),
        openExportDialog: () => setExportOpen(true),
        openEffectDialog: (effectId) => setEffectDialogId(effectId),
        openConvertDialog: (mode) => setConvertMode(mode),
        openRecordDialog: () => setRecordOpen(true),
        openTempoDialog: () => setTempoOpen(true),
        openRemixDialog: () => setRemixOpen(true),
        openSeparateDialog: () => setSeparateOpen(true),
        openTranscribeDialog: () => setTranscribeOpen(true),
        openVoiceChangerDialog: () => setVoiceChangerOpen(true),
        openAlignTimingDialog: () => setAlignTimingOpen(true),
        openVocalChainDialog: () => setVocalChainOpen(true),
        openCoverChainDialog: () => setCoverChainOpen(true),
        openAlignLyricsDialog: () => setAlignLyricsOpen(true),
        focusRemixPanel: () => setSidebarTab('remix'),
        focusTranscriptPanel: () => setSidebarTab('transcript'),
      }),
    []
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
            '--stage-inset-right': `${
              sidebarTab === null ? COLUMN_MARGIN : STAGE_INSET_RIGHT_OPEN
            }px`,
          } as CSSProperties
        }
      >
        {view === 'multitrack' ? (
          <MultitrackView />
        ) : doc && view === 'spectral' ? (
          <SpectrogramView doc={doc} />
        ) : doc ? (
          <WaveformView doc={doc} />
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
          {activeTab && ActiveIcon && (
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
                <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--glass-text-title)' }}>
                  {activeTab.label}
                </span>
              </div>
              <div className="min-h-0 overflow-auto">
                {sidebarTab === 'files' && <FilesPanel />}
                {sidebarTab === 'effects' && <EffectsPanel />}
                {sidebarTab === 'history' && <HistoryPanel />}
                {sidebarTab === 'markers' && <MarkersPanel />}
                {sidebarTab === 'properties' && <PropertiesPanel />}
                {sidebarTab === 'remix' && <RemixPanel />}
                {sidebarTab === 'spatial' && <SpatialPanel />}
                {sidebarTab === 'transcript' && <TranscriptPanel />}
              </div>
            </GlassCard>
          )}
        </div>

        {/* U1: the module strip — the G4 icon rail rotated horizontal, sitting
            in the toolbar band at the column's width and driving the card
            below it. */}
        <ModuleStrip activeTab={sidebarTab} onSelect={setSidebarTab} />

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
      {tempoOpen && <TempoDialog onClose={() => setTempoOpen(false)} />}
      {remixOpen && <RemixDialog onClose={() => setRemixOpen(false)} />}
      {separateOpen && <SeparateDialog onClose={() => setSeparateOpen(false)} />}
      {transcribeOpen && <TranscribeDialog onClose={() => setTranscribeOpen(false)} />}
      {voiceChangerOpen && <VoiceChangerDialog onClose={() => setVoiceChangerOpen(false)} />}
      {alignTimingOpen && <AlignTimingDialog onClose={() => setAlignTimingOpen(false)} />}
      {vocalChainOpen && <VocalChainDialog onClose={() => setVocalChainOpen(false)} />}
      {coverChainOpen && <CoverChainDialog onClose={() => setCoverChainOpen(false)} />}
      {alignLyricsOpen && <AlignLyricsDialog onClose={() => setAlignLyricsOpen(false)} />}
    </div>
  );
}
