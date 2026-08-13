import { Captions, Download, Users } from 'lucide-react';
import { useAppStore, centreEditorOn } from '../../stores/appStore';
import { formatTime } from '../../utils/timeFormat';
import { openTranscribeDialog } from '../../services/dialogBus';
import {
  DIARIZATION_LIMITS,
  exportTranscript,
  getTranscript,
  isTranscriptStale,
  setTranscriptSpeakerCount,
  useTranscribeVersion,
} from '../../services/transcribeService';
import { speakerColor } from '../Editor/transcriptLayout';
import { GlassButton, GlassSelect } from '../UI/glass';

/** The select's value for "detect it" (TranscribeDialog uses the same word). */
const AUTO = 'auto';

/** 0-based cluster index -> the label the exporter writes
 * (`subtitleFormat.defaultSpeakerName`). Duplicated deliberately: the panel and
 * the exported file MUST agree, and a test pins that they do. */
function speakerLabel(speaker: number | null): string {
  return speaker === null ? 'Unknown' : `Speaker ${speaker + 1}`;
}

/**
 * F4b — the transcript for the active document.
 *
 * The panel is the transcript's home rather than a dialog because a transcript
 * is READ ALONGSIDE the audio: rows are scrubbed against the waveform, one at a
 * time, over minutes. A modal would have to be dismissed to do the one thing
 * the feature is for. The timeline half of the same view lives in
 * `Editor/TranscriptRibbon.tsx`; that file's header explains why segments are
 * drawn as regions and never written into the app's marker list.
 *
 * Three obligations beyond listing text:
 *
 * 1. **The speaker count is editable here**, and changing it re-clusters the
 *    stored embeddings instantly — no second inference run. Auto-detection was
 *    measured at 100% on two speakers and 45% on three, so the control is
 *    mandatory and the note under it states that number rather than implying
 *    the detected count is authoritative.
 * 2. **Staleness is visible.** An edit after transcription moves the audio out
 *    from under the timestamps. The transcript is kept (it cost minutes) but
 *    the panel says so, in the app's amber advisory colour.
 * 3. **Unknown speakers stay unknown.** A segment the clusterer could not place
 *    (too short to embed, sitting between two different voices) is labelled
 *    "Unknown" in grey rather than being guessed into a neighbour's identity.
 *
 * Rows are plain containers holding sibling controls, never clickable rows —
 * the same reason `MarkersPanel.tsx:14-24` gives: a real browser fires
 * click, click, dblclick, so a row-level handler double-navigates.
 */
export default function TranscriptPanel() {
  useTranscribeVersion();
  const activeDocumentId = useAppStore((s) => s.activeDocumentId);
  const doc = useAppStore((s) => s.documents.find((d) => d.id === s.activeDocumentId) ?? null);
  const zoom = useAppStore((s) => s.zoom);
  const view = useAppStore((s) => s.view);
  const setCursor = useAppStore((s) => s.setCursor);
  const setView = useAppStore((s) => s.setView);

  if (!doc || !activeDocumentId) {
    return <div className="p-2 text-sm text-[#8b8b92]">No document open.</div>;
  }

  const transcript = getTranscript(activeDocumentId);
  if (!transcript) {
    return (
      <div className="flex flex-col gap-2 p-2">
        <p className="text-sm text-[#8b8b92]">No transcript for this document.</p>
        <div>
          <GlassButton variant="primary" onClick={() => openTranscribeDialog()}>
            <Captions size={13} className="mr-1 inline-block align-[-2px]" aria-hidden="true" />
            Transcribe…
          </GlassButton>
        </div>
      </div>
    );
  }

  const stale = isTranscriptStale(activeDocumentId);

  const goTo = (positionSample: number) => {
    // F27's rule, copied from MarkersPanel/RemixPanel: the cursor and zoom are
    // editor-only state, invisible while the multitrack view is active, so
    // switch back first or "go to" is a silent no-op.
    if (view === 'multitrack') setView('waveform');
    setCursor(positionSample);
    // F11 fix round: one shared writer, which centres on the lane's MEASURED
    // width and clamps. The old inline version assumed a ~800px viewport and
    // wrote `setZoom` directly, so at fit — where every freshly opened document
    // now sits — it scrolled past an end the waveform could not follow.
    centreEditorOn(positionSample);
  };

  const speakerValue =
    transcript.requestedSpeakerCount === null ? AUTO : String(transcript.requestedSpeakerCount);

  return (
    <div className="flex min-h-0 flex-col" data-testid="transcript-panel">
      <div className="flex flex-col gap-2 border-b border-[#2e2e34] p-2">
        {stale && (
          <p data-testid="transcript-stale" className="text-xs text-[#e0a458]">
            The audio changed after this transcript was made, so its times no longer line up. Transcribe
            again to refresh it.
          </p>
        )}

        <label className="flex items-center gap-2 text-xs text-[#8b8b92]">
          <Users size={13} className="shrink-0" aria-hidden="true" />
          <span className="shrink-0">Speakers</span>
          <GlassSelect
            data-testid="transcript-speaker-count"
            aria-label="Number of speakers"
            value={speakerValue}
            style={{ width: 'auto', flex: 1 }}
            onChange={(e) =>
              setTranscriptSpeakerCount(
                activeDocumentId,
                e.target.value === AUTO ? null : Number(e.target.value)
              )
            }
          >
            <option value={AUTO}>{`Detected: ${transcript.speakerCount}`}</option>
            {/* Capped at what THIS transcript's evidence can separate: one
                cluster per embedded segment. Offering more would store a
                number the list below then contradicts. */}
            {Array.from({ length: transcript.maxUsableSpeakers }, (_, i) => i + 1).map((n) => (
              <option key={n} value={String(n)}>
                {n === 1 ? '1 speaker' : `${n} speakers`}
              </option>
            ))}
          </GlassSelect>
        </label>

        <p data-testid="transcript-confidence-note" className="text-xs text-[#8b8b92]">
          {`Measured reliable for 1–${DIARIZATION_LIMITS.reliableUpTo} speakers on clean, non-overlapping audio; only ${Math.round(
            DIARIZATION_LIMITS.threeSpeakerAccuracy * 100
          )}% of segments were placed correctly with three. Set the count yourself if the detected one looks wrong — it re-groups instantly.`}
        </p>

        {transcript.unlabelledSegments > 0 && (
          <p data-testid="transcript-unknown-note" className="text-xs text-[#8b8b92]">
            {`${transcript.unlabelledSegments} segment(s) could not be attributed to a speaker and are marked Unknown.`}
          </p>
        )}

        <div className="flex items-center gap-2">
          <GlassButton
            data-testid="transcript-export-srt"
            onClick={() => void exportTranscript(activeDocumentId, 'srt')}
            disabled={transcript.segments.length === 0}
          >
            <Download size={13} className="mr-1 inline-block align-[-2px]" aria-hidden="true" />
            SRT
          </GlassButton>
          <GlassButton
            data-testid="transcript-export-vtt"
            onClick={() => void exportTranscript(activeDocumentId, 'vtt')}
            disabled={transcript.segments.length === 0}
          >
            <Download size={13} className="mr-1 inline-block align-[-2px]" aria-hidden="true" />
            WebVTT
          </GlassButton>
          {/* F11-8: the way back to the run. Two things made this necessary at
              once — the stale banner above has been telling the user to
              "Transcribe again" since F4b with no control to do it with, and
              `edit.transcribe` now SHOWS this panel when a transcript exists
              rather than opening the dialog, so without a button here the
              dialog would be unreachable for an already-transcribed document.
              Ellipsis, because it opens one. */}
          <GlassButton
            data-testid="transcript-retranscribe"
            title="Run the transcription again — replaces this transcript."
            onClick={() => openTranscribeDialog()}
          >
            <Captions size={13} className="mr-1 inline-block align-[-2px]" aria-hidden="true" />
            Transcribe again…
          </GlassButton>
        </div>
      </div>

      {transcript.segments.length === 0 ? (
        <div className="p-2 text-sm text-[#8b8b92]">No speech was found in this document.</div>
      ) : (
        <ul data-testid="transcript-list" className="flex min-h-0 flex-col overflow-y-auto py-1 text-sm">
          {transcript.segments.map((seg) => (
            <li key={seg.index} data-testid="transcript-item">
              <div
                data-testid="transcript-row"
                className="flex items-start gap-2 px-2 py-1 hover:bg-[#2e2e34]"
              >
                <button
                  type="button"
                  data-testid="transcript-goto"
                  aria-label={`Go to ${formatTime(seg.startSample, transcript.sampleRate)}`}
                  title="Move the cursor here"
                  onClick={() => goTo(seg.startSample)}
                  className="shrink-0 rounded px-1 py-0.5 tabular-nums text-xs text-[#8b8b92] transition-colors hover:bg-[#3a3a42] hover:text-[#26c6da]"
                >
                  {formatTime(seg.startSample, transcript.sampleRate)}
                </button>

                <span
                  data-testid="transcript-speaker"
                  className="mt-0.5 shrink-0 rounded px-1 py-0.5 text-[10px] uppercase tracking-wide"
                  style={{ color: speakerColor(seg.speaker), border: `1px solid ${speakerColor(seg.speaker)}55` }}
                >
                  {speakerLabel(seg.speaker)}
                </span>

                <span className="min-w-0 flex-1 break-words text-[#d4d4d8]">{seg.text}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
