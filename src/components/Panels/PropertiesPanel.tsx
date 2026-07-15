import { useRef, useState } from 'react';
import { docLength } from '../../audio/AudioDocument';
import { useAppStore } from '../../stores/appStore';
import { useSessionStore } from '../../multitrack/sessionStore';
import type { Clip } from '../../multitrack/session';
import { formatTime } from '../../utils/timeFormat';

const GAIN_MIN = -24;
const GAIN_MAX = 24;

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 px-2 py-1 text-xs">
      <span className="shrink-0 text-[#8b8b92]">{label}</span>
      <span className="min-w-0 truncate text-right text-[#d4d4d8]">{value}</span>
    </div>
  );
}

function SectionLabel({ children }: { children: string }) {
  return (
    <div className="mt-2 border-t border-[#3a3a42] px-2 pt-2 text-xs font-semibold uppercase tracking-wide text-[#8b8b92]">
      {children}
    </div>
  );
}

/** Active document facts + selection info (waveform/spectral views). */
function DocumentProperties() {
  const doc = useAppStore((s) => s.documents.find((d) => d.id === s.activeDocumentId) ?? null);
  const selection = useAppStore((s) => s.selection);

  if (!doc) {
    return <div className="p-2 text-sm text-[#8b8b92]">No document open.</div>;
  }

  const length = docLength(doc);
  const hasSelection = selection !== null && selection.end > selection.start;

  return (
    <div className="flex flex-col py-1" data-testid="properties-document">
      <Row label="Name" value={doc.name} />
      <Row label="Path" value={doc.filePath ?? '—'} />
      <Row label="Sample Rate" value={`${doc.sampleRate} Hz`} />
      <Row label="Channels" value={doc.channels.length === 1 ? 'Mono' : 'Stereo'} />
      {/* All in-memory audio is Float32Array. When the source file's bit depth
          is known (WAV/FLAC, recorded on import — Task F7), show it alongside
          the internal float format; otherwise report the internal fact alone
          (lossy sources like MP3/OGG carry no meaningful source depth). */}
      <Row
        label="Bit Depth"
        value={
          doc.sourceBitDepth
            ? `${doc.sourceBitDepth}-bit source → 32-bit float`
            : '32-bit float (internal)'
        }
      />
      <Row label="Duration" value={formatTime(length, doc.sampleRate)} />
      <Row label="Samples" value={length.toLocaleString()} />
      <Row label="Dirty" value={doc.dirty ? 'Yes' : 'No'} />

      {hasSelection && (
        <>
          <SectionLabel>Selection</SectionLabel>
          <Row label="Start" value={formatTime(selection.start, doc.sampleRate)} />
          <Row label="End" value={formatTime(selection.end, doc.sampleRate)} />
          <Row label="Length" value={formatTime(selection.end - selection.start, doc.sampleRate)} />
        </>
      )}
    </div>
  );
}

/**
 * Clip gain editor with a local draft string, committed (parsed + clamped)
 * on blur/Enter only; Escape reverts the draft to the committed value and
 * blurs without committing (Task F8). Binding value={clip.gainDb} directly and
 * committing in onChange snapped intermediate keystrokes — typing '1.' became
 * '1' because Number('1.') round-tripped through the store re-render (review
 * minor). The parent keys this component by clip id so the draft resets when
 * the selection moves to a different clip.
 */
function GainInput({
  gainDb,
  onCommit,
}: {
  gainDb: number;
  onCommit: (gainDb: number) => void;
}) {
  const [draft, setDraft] = useState(String(gainDb));
  // True only across the synchronous blur dispatched by Escape's .blur() call,
  // so that blur's commit is skipped (the stale draft closure would otherwise
  // commit the exact value Escape just abandoned).
  const escapingRef = useRef(false);

  const commit = () => {
    if (escapingRef.current) return;
    const n = Number(draft);
    if (draft.trim() !== '' && Number.isFinite(n)) {
      const clamped = Math.min(GAIN_MAX, Math.max(GAIN_MIN, n));
      onCommit(clamped);
      setDraft(String(clamped)); // reflect the store's clamp in the field
    } else {
      setDraft(String(gainDb)); // revert garbage/empty to the current value
    }
  };

  return (
    // type="text" (not "number"): the number input's value-sanitization
    // discards intermediate drafts like '1.' (→ ''), which is the exact
    // snap this draft state exists to prevent. Range is enforced by the
    // commit-time clamp (and again by the store).
    <input
      type="text"
      inputMode="decimal"
      value={draft}
      aria-label="Clip gain (dB)"
      title={`Gain in dB, ${GAIN_MIN} to +${GAIN_MAX}`}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit();
        if (e.key === 'Escape') {
          setDraft(String(gainDb)); // revert to the committed value
          escapingRef.current = true;
          e.currentTarget.blur(); // dispatches blur synchronously
          escapingRef.current = false;
        }
      }}
      className="w-16 rounded border border-[#3a3a42] bg-[#1a1a1e] px-1 py-0.5 text-right text-[#d4d4d8] outline-none focus:border-[#26c6da]"
    />
  );
}

/** Selected clip facts + editable gain (multitrack view). */
function ClipProperties() {
  const documents = useAppStore((s) => s.documents);
  const session = useSessionStore((s) => s.session);
  const selectedClipId = useSessionStore((s) => s.selectedClipId);
  const setClipGain = useSessionStore((s) => s.setClipGain);

  let clip: Clip | null = null;
  let trackName = '';
  for (const track of session.tracks) {
    const found = track.clips.find((c) => c.id === selectedClipId);
    if (found) {
      clip = found;
      trackName = track.name;
      break;
    }
  }

  if (!clip) {
    return <div className="p-2 text-sm text-[#8b8b92]">No clip selected.</div>;
  }

  const srcDoc = documents.find((d) => d.id === clip!.documentId);

  return (
    <div className="flex flex-col py-1" data-testid="properties-clip">
      <Row label="Source" value={srcDoc?.name ?? '—'} />
      <Row label="Track" value={trackName} />
      <Row label="Start" value={formatTime(clip.startSample, session.sampleRate)} />
      <Row label="Offset" value={formatTime(clip.offsetSample, session.sampleRate)} />
      <Row label="Length" value={formatTime(clip.lengthSample, session.sampleRate)} />

      <label className="flex items-center justify-between gap-2 px-2 py-1.5 text-xs">
        <span className="text-[#8b8b92]">Gain (dB)</span>
        {/* key={clip.id}: reset the draft when a different clip is selected. */}
        <GainInput
          key={clip.id}
          gainDb={clip.gainDb}
          onCommit={(g) => setClipGain(clip!.id, g)}
        />
      </label>
    </div>
  );
}

/**
 * Right-sidebar Properties tab (Task 23): active document facts + selection
 * info in the waveform/spectral views, or the selected multitrack clip's
 * facts (with an editable gain input) in the multitrack view.
 */
export default function PropertiesPanel() {
  const view = useAppStore((s) => s.view);
  return view === 'multitrack' ? <ClipProperties /> : <DocumentProperties />;
}
