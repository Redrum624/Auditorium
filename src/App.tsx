import { useEffect, useState } from 'react';
import WaveformView from './components/Editor/WaveformView';
import SpectrogramView from './components/Editor/SpectrogramView';
import ConvertDialog from './components/Dialogs/ConvertDialog';
import EffectDialog from './components/Dialogs/EffectDialog';
import ExportDialog from './components/Dialogs/ExportDialog';
import NewFileDialog from './components/Dialogs/NewFileDialog';
import EffectsPanel from './components/Panels/EffectsPanel';
import FilesPanel from './components/Panels/FilesPanel';
import HistoryPanel from './components/Panels/HistoryPanel';
import PanelShell from './components/Layout/PanelShell';
import StatusBar from './components/Layout/StatusBar';
import TitleBar from './components/Layout/TitleBar';
import TransportBar from './components/Layout/TransportBar';
import { registerAllEffects } from './effects/registerAll';
import { registerDialogSetters, type ConvertMode } from './services/dialogBus';
import { registerEffectCommands } from './services/menuActions';
import { installShortcuts } from './services/shortcuts';
import { installTestHooks } from './services/testHooks';
import { useAppStore } from './stores/appStore';

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

  // Global keyboard shortcuts (Task 8): mounted once for the app's lifetime.
  useEffect(() => installShortcuts(window), []);

  // Let the file.new / file.export commands open these React dialogs (Task 11).
  useEffect(
    () =>
      registerDialogSetters({
        openNewFileDialog: () => setNewFileOpen(true),
        openExportDialog: () => setExportOpen(true),
        openEffectDialog: (effectId) => setEffectDialogId(effectId),
        openConvertDialog: (mode) => setConvertMode(mode),
      }),
    []
  );

  // Scripted-smoke test hooks — only when the preload flagged test mode.
  useEffect(() => {
    if ((window as unknown as { __auditoriumTest?: boolean }).__auditoriumTest) {
      installTestHooks();
    }
  }, []);

  // Best-effort guard against losing unsaved edits on window close/reload.
  // Full native close interception is a v2 item (see task brief).
  const hasDirty = documents.some((d) => d.dirty);
  useEffect(() => {
    if (!hasDirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [hasDirty]);

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
          {doc && view === 'spectral' ? (
            <SpectrogramView doc={doc} />
          ) : doc ? (
            <WaveformView doc={doc} />
          ) : (
            <div className="flex flex-1 items-center justify-center text-[#8b8b92]">
              Open an audio file to begin
            </div>
          )}
        </div>
        <div className="flex w-[280px] flex-col border-l border-[#3a3a42] bg-[#232328]">
          <PanelShell title="History">
            <HistoryPanel />
          </PanelShell>
          <PanelShell title="Markers" />
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
    </div>
  );
}
