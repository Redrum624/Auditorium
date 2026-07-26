import { useRef, useState } from 'react';
import { docLength, type AudioDocument } from '../../audio/AudioDocument';
import { useAppStore } from '../../stores/appStore';
import { useSessionStore } from '../../multitrack/sessionStore';
import type { Clip } from '../../multitrack/session';
import { formatTime } from '../../utils/timeFormat';
import {
  getTempo,
  isTempoRunning,
  getTempoProgress,
  runTempoAnalysis,
  regridTempo,
  useTempoVersion,
  type TempoEntry,
} from '../../services/tempoAnalysis';
import { CONFIDENCE_LOW, MIN_ANALYSIS_SECONDS } from '../../dsp/tempoCore';

const GAIN_MIN = -24;
const GAIN_MAX = 24;

function Row({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 px-2 py-1 text-xs">
      <span className="shrink-0 text-[#8b8b92]">{label}</span>
      <span className={`min-w-0 truncate text-right ${muted ? 'text-[#8b8b92]' : 'text-[#d4d4d8]'}`}>{value}</span>
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

function formatBpm(bpm: number): string {
  return `${bpm.toFixed(1)} BPM`;
}

/** Builds the Tempo row's display string: the BPM (or a '—' + reason when
 * `bpm` is null), with '(stale)'/'(first 10 min)' appended per Decision #4 /
 * Ruling 2.11. `analyzedSeconds` distinguishes the two null reasons — 'too
 * short' below `MIN_ANALYSIS_SECONDS`, else 'no rhythm detected' (every other
 * degenerate-analysis guard in `tempoCore.ts`). */
function formatTempoValue(entry: TempoEntry, analyzedSeconds: number): string {
  let value =
    entry.bpm === null
      ? `— (${analyzedSeconds < MIN_ANALYSIS_SECONDS ? 'too short' : 'no rhythm detected'})`
      : formatBpm(entry.bpm);
  if (entry.stale) value += ' (stale)';
  if (entry.truncated) value += ' (first 10 min)';
  return value;
}

/**
 * Feature 1 UI (Task T5): tempo readout + Detect/Re-analyze + the x2//2
 * octave-correction control. Per the plan amendment (post-T4-review
 * measurement: a 60 BPM loop misdetected as 120 scored the HIGHEST
 * confidence in the whole fixture bank), confidence cannot gate octave
 * errors — so the x2//2 control is mandatory here and exempt from the
 * release's otherwise-minimal UI ruling.
 *
 * Calls `useTempoVersion()` FIRST (module-level reactivity — HistoryPanel.tsx
 * :11 precedent) so a run start/progress/completion/invalidation event
 * re-renders this section; `getTempo(doc)` is read fresh every render (never
 * memoized on the entry reference — an edit flips only `.stale` in place on
 * the SAME object).
 *
 * The x2//2 buttons call `regridTempo`, never a local BPM relabel (T2
 * carry-forward): at a half-tempo detection `beatSamples` physically
 * contains only every other beat, so relabelling alone would show the right
 * number while the remix planner (a later feature) splices on a
 * half-density grid. `regridTempo` resolves `null` when the corrected period
 * is degenerate, leaving the previous (still-good) grid in the cache
 * untouched — surfaced here as an inline notice rather than silently
 * reverting with no explanation.
 */
function TempoSection({ doc }: { doc: AudioDocument }) {
  useTempoVersion();
  const [correctionFailed, setCorrectionFailed] = useState(false);
  // `regridTempo`'s own promise resolving is this component's most direct
  // signal that the correction it just requested has settled — rather than
  // relying solely on the separate `useTempoVersion()` subscription noticing
  // the cache write, force a render right here so `getTempo(doc)` is re-read
  // immediately. A monotonic counter (not a boolean) so this never bails out
  // on React's same-value state optimization when the outcome repeats.
  const [, forceRerender] = useState(0);

  const running = isTempoRunning(doc.id);
  const entry = getTempo(doc);

  async function correct(newPeriodFrames: number): Promise<void> {
    setCorrectionFailed(false);
    const result = await regridTempo(doc.id, newPeriodFrames);
    setCorrectionFailed(result === null);
    forceRerender((n) => n + 1);
  }

  // Detect/Re-analyze replace the cache row with a brand-new entry (unlike a
  // stale flip, which mutates the SAME object in place) — clear a leftover
  // correction-failed notice so it can't linger over an unrelated fresh run.
  function detectOrReanalyze(): void {
    setCorrectionFailed(false);
    void runTempoAnalysis(doc);
  }

  return (
    <div className="flex flex-col" data-testid="properties-tempo">
      <SectionLabel>Tempo</SectionLabel>

      {running ? (
        <div className="mx-2 my-1 h-1.5 overflow-hidden rounded bg-[#2e2e34]">
          <div
            data-testid="tempo-progress"
            className="h-full bg-[#26c6da] transition-[width]"
            style={{ width: `${Math.round((getTempoProgress(doc.id) ?? 0) * 100)}%` }}
          />
        </div>
      ) : entry ? (
        <>
          <div className="flex items-baseline justify-between gap-3 px-2 py-1 text-xs">
            <span className="shrink-0 text-[#8b8b92]">Tempo</span>
            <span className="flex min-w-0 items-baseline justify-end gap-2">
              <span className="truncate text-right text-[#d4d4d8]">
                {formatTempoValue(entry, entry.analyzedEndSample / doc.sampleRate)}
              </span>
              {entry.bpm !== null && !entry.stale && (
                <span className="flex shrink-0 gap-1">
                  <button
                    type="button"
                    data-testid="tempo-halve-button"
                    title="Halve tempo (/2) — re-tracks the beat grid"
                    onClick={() => void correct(entry.periodFrames * 2)}
                    className="rounded border border-[#3a3a42] px-1 text-[#d4d4d8] hover:border-[#26c6da]"
                  >
                    /2
                  </button>
                  <button
                    type="button"
                    data-testid="tempo-double-button"
                    title="Double tempo (x2) — re-tracks the beat grid"
                    onClick={() => void correct(entry.periodFrames / 2)}
                    className="rounded border border-[#3a3a42] px-1 text-[#d4d4d8] hover:border-[#26c6da]"
                  >
                    x2
                  </button>
                </span>
              )}
            </span>
          </div>
          <Row
            label="Confidence"
            value={
              entry.confidence < CONFIDENCE_LOW
                ? `${Math.round(entry.confidence * 100)}% · low`
                : `${Math.round(entry.confidence * 100)}%`
            }
            muted={entry.confidence < CONFIDENCE_LOW}
          />
          <Row label="Beats" value={entry.beatSamples.length.toLocaleString()} />
          {correctionFailed && (
            <div data-testid="tempo-correction-failed" className="px-2 pb-1 text-xs text-[#e0a458]">
              Correction failed — grid unchanged.
            </div>
          )}
          {entry.stale && (
            <div className="px-2 py-1">
              <button
                type="button"
                data-testid="tempo-reanalyze-button"
                onClick={detectOrReanalyze}
                className="w-full rounded bg-[#26c6da] px-2 py-1 text-xs font-medium text-[#1a1a1e] hover:opacity-90"
              >
                Re-analyze
              </button>
            </div>
          )}
        </>
      ) : (
        <div className="px-2 py-1">
          <button
            type="button"
            data-testid="tempo-analyze-button"
            onClick={detectOrReanalyze}
            className="w-full rounded bg-[#26c6da] px-2 py-1 text-xs font-medium text-[#1a1a1e] hover:opacity-90"
          >
            Detect Tempo
          </button>
        </div>
      )}
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

      <TempoSection key={doc.id} doc={doc} />

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
