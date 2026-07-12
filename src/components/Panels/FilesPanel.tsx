import { X } from 'lucide-react';
import { docDuration } from '../../audio/AudioDocument';
import { closeDocumentFlow } from '../../services/fileService';
import { useAppStore } from '../../stores/appStore';

/** Format a duration in seconds as `m:ss`. */
function formatDuration(seconds: number): string {
  const total = Math.round(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * Left-sidebar list of open documents. Each row shows the name (with a `*` when
 * dirty), duration, and sample rate. Clicking a row activates that document;
 * the hover ✕ button closes it through the shared closeDocumentFlow (which
 * prompts to save when dirty).
 */
export default function FilesPanel() {
  const documents = useAppStore((s) => s.documents);
  const activeDocumentId = useAppStore((s) => s.activeDocumentId);
  const setActiveDocument = useAppStore((s) => s.setActiveDocument);

  if (documents.length === 0) {
    return <div className="p-2 text-sm text-[#8b8b92]">No files open.</div>;
  }

  return (
    <ul data-testid="files-list" className="flex flex-col py-1 text-sm">
      {documents.map((doc) => {
        const isActive = doc.id === activeDocumentId;
        return (
          <li key={doc.id} data-testid="files-item" className="group">
            <div
              className={`flex items-center gap-2 px-2 py-1 ${
                isActive ? 'bg-[#2e2e34]' : 'hover:bg-[#2e2e34]'
              }`}
            >
              <button
                type="button"
                onClick={() => setActiveDocument(doc.id)}
                className="flex min-w-0 flex-1 flex-col text-left"
              >
                <span
                  className={`truncate ${isActive ? 'text-[#26c6da]' : 'text-[#d4d4d8]'}`}
                >
                  {doc.name}
                  {doc.dirty ? ' *' : ''}
                </span>
                <span className="text-xs text-[#8b8b92]">
                  {formatDuration(docDuration(doc))} · {(doc.sampleRate / 1000).toFixed(1)} kHz
                </span>
              </button>
              <button
                type="button"
                aria-label={`Close ${doc.name}`}
                title="Close"
                onClick={() => void closeDocumentFlow(doc.id)}
                className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-[#8b8b92] opacity-0 transition-opacity hover:bg-[#3a3a42] hover:text-[#d4d4d8] group-hover:opacity-100"
              >
                <X size={14} />
              </button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
