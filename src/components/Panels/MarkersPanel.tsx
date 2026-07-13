import { useState } from 'react';
import { Flag, X } from 'lucide-react';
import { useAppStore } from '../../stores/appStore';
import type { Marker } from '../../stores/appStore';
import { formatTime } from '../../utils/timeFormat';

// Stable empty-array reference: `s.markers[id] ?? []` would otherwise
// allocate a NEW array on every selector call when the doc has no markers,
// which breaks useSyncExternalStore's snapshot-equality check and causes an
// infinite render loop ("Maximum update depth exceeded").
const NO_MARKERS: Marker[] = [];

/**
 * Marker list for the active document (Task 23). Each row is a plain (non-
 * interactive) container holding sibling controls — deliberately NOT a
 * clickable row: a real browser fires click, click, dblclick for a double-
 * click, so a row-level onClick would navigate twice before a name-dblclick
 * rename could open (review finding). Instead the time readout is an explicit
 * "Go to" button that moves the cursor and re-centers the view; double-
 * clicking the name switches it to an inline input (Enter/blur commits,
 * Escape cancels); the trailing ✕ removes the marker. Markers are
 * session-only — see docs/KNOWN_LIMITATIONS.md.
 */
export default function MarkersPanel() {
  const activeDocumentId = useAppStore((s) => s.activeDocumentId);
  const doc = useAppStore((s) => s.documents.find((d) => d.id === s.activeDocumentId) ?? null);
  const markers = useAppStore((s) =>
    activeDocumentId ? (s.markers[activeDocumentId] ?? NO_MARKERS) : NO_MARKERS
  );
  const zoom = useAppStore((s) => s.zoom);
  const setCursor = useAppStore((s) => s.setCursor);
  const setZoom = useAppStore((s) => s.setZoom);
  const renameMarker = useAppStore((s) => s.renameMarker);
  const removeMarker = useAppStore((s) => s.removeMarker);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  if (!doc || !activeDocumentId) {
    return <div className="p-2 text-sm text-[#8b8b92]">No document open.</div>;
  }

  if (markers.length === 0) {
    return <div className="p-2 text-sm text-[#8b8b92]">No markers — press M at the cursor.</div>;
  }

  const commitRename = (markerId: string) => {
    const name = draft.trim();
    if (name) renameMarker(activeDocumentId, markerId, name);
    setEditingId(null);
  };

  const goTo = (positionSample: number) => {
    setCursor(positionSample);
    // The panel doesn't know the viewport's pixel width (only WaveformView /
    // SpectrogramView do), so centering is approximated for a ~800px-wide
    // viewport: half of that, in samples, is samplesPerPixel * 400.
    const halfViewportSamples = zoom.samplesPerPixel * 400;
    setZoom({ ...zoom, scrollSample: Math.max(0, positionSample - halfViewportSamples) });
  };

  return (
    <ul data-testid="markers-list" className="flex flex-col py-1 text-sm">
      {markers.map((m) => (
        <li key={m.id} data-testid="markers-item" className="group">
          <div
            data-testid="markers-row"
            className="flex items-center gap-2 px-2 py-1 hover:bg-[#2e2e34]"
          >
            <Flag size={12} className="shrink-0" style={{ color: '#ff8a65' }} aria-hidden="true" />

            {editingId === m.id ? (
              <input
                autoFocus
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitRename(m.id);
                  else if (e.key === 'Escape') setEditingId(null);
                }}
                onBlur={() => commitRename(m.id)}
                className="min-w-0 flex-1 rounded border border-[#26c6da] bg-[#1a1a1e] px-1 py-0.5 text-xs text-[#d4d4d8] outline-none"
              />
            ) : (
              <span
                onDoubleClick={() => {
                  setDraft(m.name);
                  setEditingId(m.id);
                }}
                title="Double-click to rename"
                className="min-w-0 flex-1 cursor-text truncate text-[#d4d4d8]"
              >
                {m.name}
              </span>
            )}

            <button
              type="button"
              aria-label={`Go to ${m.name}`}
              title="Go to marker"
              onClick={() => goTo(m.positionSample)}
              className="shrink-0 rounded px-1 py-0.5 tabular-nums text-xs text-[#8b8b92] transition-colors hover:bg-[#3a3a42] hover:text-[#26c6da]"
            >
              {formatTime(m.positionSample, doc.sampleRate)}
            </button>

            <button
              type="button"
              aria-label={`Delete ${m.name}`}
              title="Delete marker"
              onClick={() => removeMarker(activeDocumentId, m.id)}
              className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-[#8b8b92] opacity-0 transition-opacity hover:bg-[#3a3a42] hover:text-[#d4d4d8] group-hover:opacity-100"
            >
              <X size={14} />
            </button>
          </div>
        </li>
      ))}
    </ul>
  );
}
