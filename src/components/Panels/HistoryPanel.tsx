import { useAppStore } from '../../stores/appStore';
import { getHistory, useHistoryVersion } from '../../services/undoHistory';
import { undo as undoDoc, redo as redoDoc } from '../../services/undoHistory';
import {
  SESSION_UNDO_KEY,
  redoSession,
  undoSession,
} from '../../multitrack/sessionUndo';

/**
 * Undo history for whatever is active (R3 / ruling 1): in the multitrack view
 * this is the SESSION's stack (keyed by the reserved session id); in the
 * waveform/spectral editors it is the active document's. Applied edits are
 * listed oldest->newest with the current position highlighted; undone edits
 * follow, grayed out. Clicking an applied edit undoes back to it; clicking an
 * undone edit redoes up to and including it. Re-renders on any history change
 * via useHistoryVersion.
 *
 * Session clicks route through undoSession/redoSession — NOT the raw
 * undo/redo — so the coalescing memory resets and the transaction-open guard
 * holds (a click mid-drag must not fight the pointer's live writes).
 */
export default function HistoryPanel() {
  useHistoryVersion();
  const activeDocumentId = useAppStore((s) => s.activeDocumentId);
  const view = useAppStore((s) => s.view);

  const isSession = view === 'multitrack';
  const key = isSession ? SESSION_UNDO_KEY : activeDocumentId;
  const undoOnce = isSession ? undoSession : () => activeDocumentId && undoDoc(activeDocumentId);
  const redoOnce = isSession ? redoSession : () => activeDocumentId && redoDoc(activeDocumentId);

  if (!key) {
    return <div className="p-2 text-sm text-[#8b8b92]">No document open.</div>;
  }

  const { done, undone } = getHistory(key);
  if (done.length === 0 && undone.length === 0) {
    return <div className="p-2 text-sm text-[#8b8b92]">No edits yet.</div>;
  }

  const doneCount = done.length;

  return (
    <ul data-testid="history-list" className="flex flex-col py-1 text-sm">
      {done.map((label, i) => {
        const isCurrent = i === doneCount - 1;
        return (
          <li key={`done-${i}`} data-testid="history-item">
            <button
              type="button"
              aria-current={isCurrent ? 'true' : undefined}
              // Undo every edit applied after this one, making it the last applied edit.
              onClick={() => {
                for (let k = 0; k < doneCount - 1 - i; k++) undoOnce();
              }}
              className={`w-full px-3 py-1 text-left hover:bg-[#2e2e34] ${
                isCurrent ? 'bg-[#2e2e34] text-[#26c6da]' : 'text-[#d4d4d8]'
              }`}
            >
              {label}
            </button>
          </li>
        );
      })}
      {undone.map((label, j) => (
        <li key={`undone-${j}`} data-testid="history-item">
          <button
            type="button"
            // Redo up to and including this undone edit.
            onClick={() => {
              for (let k = 0; k <= j; k++) redoOnce();
            }}
            className="w-full px-3 py-1 text-left italic text-[#8b8b92] hover:bg-[#2e2e34]"
          >
            {label}
          </button>
        </li>
      ))}
    </ul>
  );
}
