import PanelShell from './components/Layout/PanelShell';
import StatusBar from './components/Layout/StatusBar';
import TitleBar from './components/Layout/TitleBar';

export default function App() {
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
        <div className="flex flex-1 items-center justify-center bg-[#1a1a1e] text-[#8b8b92]">
          Open an audio file to begin
        </div>
        <div className="flex w-[280px] flex-col border-l border-[#3a3a42] bg-[#232328]">
          <PanelShell title="History" />
          <PanelShell title="Markers" />
        </div>
      </div>
      {/* Task 9: transport bar */}
      <div className="h-14 border-t border-[#3a3a42] bg-[#232328]" />
      <StatusBar />
    </div>
  );
}
