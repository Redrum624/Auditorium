import { useEffect } from 'react';
import WaveformView from './components/Editor/WaveformView';
import PanelShell from './components/Layout/PanelShell';
import StatusBar from './components/Layout/StatusBar';
import TitleBar from './components/Layout/TitleBar';
import TransportBar from './components/Layout/TransportBar';
import { installShortcuts } from './services/shortcuts';
import { useAppStore } from './stores/appStore';

export default function App() {
  const documents = useAppStore((s) => s.documents);
  const activeDocumentId = useAppStore((s) => s.activeDocumentId);
  const view = useAppStore((s) => s.view);
  const doc = documents.find((d) => d.id === activeDocumentId) ?? null;

  // Global keyboard shortcuts (Task 8): mounted once for the app's lifetime.
  useEffect(() => installShortcuts(window), []);

  return (
    <div
      data-testid="app-root"
      className="flex h-screen w-screen flex-col bg-[#1a1a1e] text-[#d4d4d8]"
    >
      <TitleBar />
      <div className="flex min-h-0 flex-1">
        <div className="flex w-[240px] flex-col border-r border-[#3a3a42] bg-[#232328]">
          <PanelShell title="Files" />
          <PanelShell title="Effects" />
        </div>
        <div className="flex min-w-0 flex-1 flex-col bg-[#1a1a1e]">
          {doc && view === 'waveform' ? (
            <WaveformView doc={doc} />
          ) : (
            <div className="flex flex-1 items-center justify-center text-[#8b8b92]">
              Open an audio file to begin
            </div>
          )}
        </div>
        <div className="flex w-[280px] flex-col border-l border-[#3a3a42] bg-[#232328]">
          <PanelShell title="History" />
          <PanelShell title="Markers" />
        </div>
      </div>
      <TransportBar />
      <StatusBar />
    </div>
  );
}
