import { useEffect, useRef, useState } from 'react';
import WaveformView from './components/Editor/WaveformView';
import SpectrogramView from './components/Editor/SpectrogramView';
import MultitrackView from './components/Multitrack/MultitrackView';
import ConvertDialog from './components/Dialogs/ConvertDialog';
import EffectDialog from './components/Dialogs/EffectDialog';
import ExportDialog from './components/Dialogs/ExportDialog';
import NewFileDialog from './components/Dialogs/NewFileDialog';
import RecordDialog from './components/Dialogs/RecordDialog';
import EffectsPanel from './components/Panels/EffectsPanel';
import FilesPanel from './components/Panels/FilesPanel';
import HistoryPanel from './components/Panels/HistoryPanel';
import MarkersPanel from './components/Panels/MarkersPanel';
import PropertiesPanel from './components/Panels/PropertiesPanel';
import PanelShell from './components/Layout/PanelShell';
import StatusBar from './components/Layout/StatusBar';
import TitleBar from './components/Layout/TitleBar';
import TransportBar from './components/Layout/TransportBar';
import { registerAllEffects } from './effects/registerAll';
import { registerDialogSetters, type ConvertMode } from './services/dialogBus';
import { getInFlightSaveCount } from './services/fileService';
import { registerEffectCommands } from './services/menuActions';
import { installShortcuts } from './services/shortcuts';
import { installTestHooks } from './services/testHooks';
import { stopAll } from './services/transportService';
import { useAppStore } from './stores/appStore';

type SidebarTab = 'history' | 'markers' | 'properties';
const SIDEBAR_TABS: { id: SidebarTab; label: string }[] = [
  { id: 'history', label: 'History' },
  { id: 'markers', label: 'Markers' },
  { id: 'properties', label: 'Properties' },
];

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
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>('history');

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
      <div className="flex min-h-0 flex-1">
        <div className="flex w-[240px] flex-col border-r border-[#3a3a42] bg-[#232328]">
          <PanelShell title="Files">
            <FilesPanel />
          </PanelShell>
          <PanelShell title="Effects">
            <EffectsPanel />
          </PanelShell>
        </div>
        <div className="flex min-w-0 flex-1 flex-col bg-[#1a1a1e]">
          {view === 'multitrack' ? (
            <MultitrackView />
          ) : doc && view === 'spectral' ? (
            <SpectrogramView doc={doc} />
          ) : doc ? (
            <WaveformView doc={doc} />
          ) : (
            <div className="flex flex-1 items-center justify-center text-center text-[#8b8b92]">
              Open an audio file (Ctrl+O) or create a new one (Ctrl+N)
            </div>
          )}
        </div>
        <div className="flex w-[280px] flex-col border-l border-[#3a3a42] bg-[#232328]">
          <div className="flex shrink-0 border-b border-[#3a3a42]" data-testid="sidebar-tabs">
            {SIDEBAR_TABS.map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setSidebarTab(tab.id)}
                className={`flex-1 border-b-2 px-2 py-1.5 text-xs font-semibold uppercase tracking-wide transition-colors ${
                  sidebarTab === tab.id
                    ? 'border-[#26c6da] text-[#26c6da]'
                    : 'border-transparent text-[#8b8b92] hover:text-[#d4d4d8]'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
          <div
            className="min-h-0 flex-1 overflow-auto"
            data-testid="sidebar-panel"
            data-active-tab={sidebarTab}
          >
            {sidebarTab === 'history' && <HistoryPanel />}
            {sidebarTab === 'markers' && <MarkersPanel />}
            {sidebarTab === 'properties' && <PropertiesPanel />}
          </div>
        </div>
      </div>
      <TransportBar />
      <StatusBar />

      {newFileOpen && <NewFileDialog onClose={() => setNewFileOpen(false)} />}
      {exportOpen && <ExportDialog onClose={() => setExportOpen(false)} />}
      {effectDialogId && (
        <EffectDialog effectId={effectDialogId} onClose={() => setEffectDialogId(null)} />
      )}
      {convertMode && (
        <ConvertDialog mode={convertMode} onClose={() => setConvertMode(null)} />
      )}
      {recordOpen && <RecordDialog onClose={() => setRecordOpen(false)} />}
    </div>
  );
}
