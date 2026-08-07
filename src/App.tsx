import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Flag, Folder, History as HistoryIcon, Info, Shuffle, Sparkles } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import WaveformView from './components/Editor/WaveformView';
import SpectrogramView from './components/Editor/SpectrogramView';
import MultitrackView from './components/Multitrack/MultitrackView';
import ConvertDialog from './components/Dialogs/ConvertDialog';
import EffectDialog from './components/Dialogs/EffectDialog';
import ExportDialog from './components/Dialogs/ExportDialog';
import NewFileDialog from './components/Dialogs/NewFileDialog';
import RecordDialog from './components/Dialogs/RecordDialog';
import RemixDialog from './components/Dialogs/RemixDialog';
import TempoDialog from './components/Dialogs/TempoDialog';
import EffectsPanel from './components/Panels/EffectsPanel';
import FilesPanel from './components/Panels/FilesPanel';
import HistoryPanel from './components/Panels/HistoryPanel';
import MarkersPanel from './components/Panels/MarkersPanel';
import PropertiesPanel from './components/Panels/PropertiesPanel';
import RemixPanel from './components/Panels/RemixPanel';
import StatusBar from './components/Layout/StatusBar';
import TempoCard from './components/Layout/TempoCard';
import TitleBar from './components/Layout/TitleBar';
import Toolbar from './components/Layout/Toolbar';
import { ChromePill, GlassCard, IconTile } from './components/UI/glass';
import { registerAllEffects } from './effects/registerAll';
import { registerDialogSetters, type ConvertMode } from './services/dialogBus';
import { getInFlightSaveCount } from './services/fileService';
import { registerEffectCommands } from './services/menuActions';
import { installShortcuts } from './services/shortcuts';
import { installTestHooks } from './services/testHooks';
import { stopAll } from './services/transportService';
import { useAppStore } from './stores/appStore';

// G4: the two flat sidebars (left Files/Effects column + right tab strip)
// became ONE right-edge icon rail driving a single glass panel card. The rail
// IS the old tab strip restyled — same `sidebar-tabs` testid, same accessible
// names, same `data-active-tab` mechanism — with Files and Effects as
// additive entries now that the always-visible left column is retired
// (user-approved via the 2026-07-28 mockup). 'remix' is also reachable
// through `focusRemixPanel()` (dialogBus) the moment a remix document is
// created, without the user finding the rail entry first.
type SidebarTab = 'files' | 'effects' | 'markers' | 'history' | 'properties' | 'remix';
const SIDEBAR_TABS: { id: SidebarTab; label: string; Icon: LucideIcon }[] = [
  { id: 'files', label: 'Files', Icon: Folder },
  { id: 'effects', label: 'Effects', Icon: Sparkles },
  { id: 'markers', label: 'Markers', Icon: Flag },
  { id: 'history', label: 'History', Icon: HistoryIcon },
  { id: 'properties', label: 'Properties', Icon: Info },
  { id: 'remix', label: 'Remix', Icon: Shuffle },
];

// Vitrine IconSidebar.tsx rail-button anatomy, verbatim: 42px tile, radius 12,
// idle chrome text; interactive hover/press live in .glass-rail-btn
// (index.css). Active = accent-soft tile + accent-ring border + accent glyph +
// glow — the glow derives from the accent token (ruling 2), where Vitrine
// hardcodes its blue.
const railBtn: CSSProperties = {
  width: 42,
  height: 42,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  borderRadius: 12,
  border: '1px solid transparent',
  background: 'transparent',
  color: 'var(--glass-text-chrome-idle)',
  cursor: 'pointer',
};

const railBtnActive: CSSProperties = {
  background: 'var(--accent-soft)',
  border: '1px solid var(--accent-ring)',
  color: 'var(--accent)',
  boxShadow: '0 0 14px var(--accent-ring)',
};

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
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>('history');
  const activeTab = SIDEBAR_TABS.find((t) => t.id === sidebarTab) ?? SIDEBAR_TABS[0];
  const ActiveIcon = activeTab.Icon;

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
        focusRemixPanel: () => setSidebarTab('remix'),
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
  // intercepts the window's 'close' event and asks how many documents are
  // dirty; we answer with the count read at REQUEST time (getState, not a
  // stale render closure). Main then closes silently (0) or shows a native
  // Quit/Cancel box. See electron/closeGuard.cjs.
  useEffect(() => {
    const api = window.electronAPI;
    if (!api?.onCloseRequested) return; // jsdom / older preload
    return api.onCloseRequested(() => {
      const dirty = useAppStore.getState().documents.filter((d) => d.dirty).length;
      api.respondCloseRequest(dirty, getInFlightSaveCount());
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
        style={{ backgroundImage: 'var(--canvas-bg)' }}
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
            glass panel card for the rail's active entry. The card hugs its
            content and scrolls internally when it outgrows the column
            (scroll containment preserved). The wrapper ignores pointer
            events so the empty column strip never blocks the stage. Top is
            68 (the stage-inset top), NOT the mockup's toolbar-band top: the
            mockup stages a 1800px window where the centred pill ends well
            short of the column — at the app's real 1600px default the pill's
            zoom cluster would collide with the TEMPO card, so the column
            starts below the band, aligned with the lanes. */}
        <div
          className="pointer-events-none absolute z-20 flex w-[348px] flex-col"
          style={{ top: 68, right: 84, bottom: 58, gap: 14 }}
        >
          <TempoCard />
          <GlassCard
            data-testid="sidebar-panel"
            data-active-tab={sidebarTab}
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
            </div>
          </GlassCard>
        </div>

        {/* G4 icon rail (Vitrine IconSidebar anatomy on a ChromePill),
            floating at the right edge, vertically centred (mockup `.rail`):
            the old tab strip's testid and accessible names live here. */}
        <ChromePill
          data-testid="sidebar-tabs"
          className="absolute right-3 top-1/2 z-20 flex -translate-y-1/2 flex-col items-center"
          style={{ padding: '10px 8px', gap: 6 }}
        >
          {SIDEBAR_TABS.map(({ id, label, Icon }) => (
            <button
              key={id}
              type="button"
              aria-label={label}
              title={label}
              aria-pressed={sidebarTab === id}
              onClick={() => setSidebarTab(id)}
              className={`glass-rail-btn${sidebarTab === id ? ' is-active' : ''}`}
              style={{ ...railBtn, ...(sidebarTab === id ? railBtnActive : null) }}
            >
              <Icon size={20} />
            </button>
          ))}
        </ChromePill>

        {/* G2 status pill, floating bottom-centre (mockup `.status`). */}
        <StatusBar />
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
    </div>
  );
}
