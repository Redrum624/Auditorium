import { X } from 'lucide-react';
import { docDuration } from '../../audio/AudioDocument';
import { DOC_DRAG_MIME, beginDocumentDrag, endDocumentDrag } from '../../multitrack/laneDrop';
import { closeDocumentFlow } from '../../services/fileService';
import { usePendingOpens } from '../../services/openProgress';
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
  // Files being read and decoded right now. A large decode runs on a worker,
  // so the app stays live for the seconds it takes — and without a row saying
  // so, "live but nothing happening" is indistinguishable from a hang. That
  // ambiguity is exactly what the incident's frozen window offered.
  const pendingOpens = usePendingOpens();

  if (documents.length === 0 && pendingOpens.length === 0) {
    return <div className="p-2 text-sm text-[#8b8b92]">No files open.</div>;
  }

  return (
    <ul data-testid="files-list" className="flex flex-col py-1 text-sm">
      {documents.map((doc) => {
        const isActive = doc.id === activeDocumentId;
        return (
          <li
            key={doc.id}
            data-testid="files-item"
            className="group"
            // F11-4 — a row IS the document, so the row is the drag source
            // (dragging the name button alone would make the ✕ and the
            // padding dead zones). The payload is the document id under a
            // private MIME: a lane can then recognise the drag from its TYPE,
            // which is all a dragover is allowed to see. `beginDocumentDrag`
            // additionally records the drag in module state so the lane's
            // ghost can snap the clip's TAIL edge too — the length is not
            // readable out of a dataTransfer until the drop.
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData(DOC_DRAG_MIME, doc.id);
              e.dataTransfer.effectAllowed = 'copy';
              beginDocumentDrag(doc.id);
            }}
            onDragEnd={() => endDocumentDrag()}
          >
            {/* G4 glass restyle (styling only): white-alpha hover/active over
                the translucent card instead of the old opaque grays. */}
            <div
              className={`mx-1 flex items-center gap-2 rounded-lg px-2 py-1 ${
                isActive ? 'bg-white/[.06]' : 'hover:bg-white/5'
              }`}
            >
              {/* v1.9.1: a "never saved to disk" marker, visually DISTINCT from
                  the dirty `*` — the two mean different things (dirty = has
                  unsaved edits; never-saved = has no file on disk at all) and a
                  document can be both. v1.6 glass language: a 2x2 amber tint dot
                  with a title tooltip (the RemixPanel quality-dot convention).
                  Sits at the row level (not inside the name span) so the name
                  stays a single text node. */}
              {doc.neverSaved && (
                <span
                  data-testid="files-neversaved"
                  title="Never saved to disk"
                  aria-label="Never saved to disk"
                  className="h-2 w-2 shrink-0 rounded-full bg-[#e0a458]"
                />
              )}
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
                className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-[#8b8b92] opacity-0 transition-opacity hover:bg-white/10 hover:text-[#d4d4d8] group-hover:opacity-100"
              >
                <X size={14} />
              </button>
            </div>
          </li>
        );
      })}

      {/* Opens in flight, below the documents that already exist. Not
          selectable and not closable: there is no document behind one yet. */}
      {pendingOpens.map((p) => (
        <li key={`opening-${p.token}`} data-testid="files-opening">
          <div className="mx-1 flex items-center gap-2 rounded-lg px-2 py-1">
            <span
              aria-hidden="true"
              className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-[#26c6da]"
            />
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-[#8b8b92]">{p.name}</span>
              <span className="text-xs text-[#8b8b92]">Opening…</span>
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}
