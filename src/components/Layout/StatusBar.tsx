import { docLength, type AudioDocument } from '../../audio/AudioDocument';
import { useAppStore } from '../../stores/appStore';
import { formatTime } from '../../utils/timeFormat';
import { getTempo, useTempoVersion } from '../../services/tempoAnalysis';

/** '♩ 128.4' for a fresh result, '♩ 128.4*' when stale, '♩ —' with no
 * document, no cached entry, or a null bpm (too short / no rhythm detected —
 * this compact readout doesn't have room for the reason; PropertiesPanel's
 * Tempo section shows it). Decision #3: a CACHED READ ONLY — never calls
 * `runTempoAnalysis`, so opening a file costs nothing. */
function tempoReadout(doc: AudioDocument | null): string {
  const entry = doc ? getTempo(doc) : null;
  if (!entry || entry.bpm === null) return '♩ —';
  return `♩ ${entry.bpm.toFixed(1)}${entry.stale ? '*' : ''}`;
}

export default function StatusBar() {
  useTempoVersion();
  const documents = useAppStore((s) => s.documents);
  const activeDocumentId = useAppStore((s) => s.activeDocumentId);
  const cursorSample = useAppStore((s) => s.cursorSample);
  const selection = useAppStore((s) => s.selection);
  const zoom = useAppStore((s) => s.zoom);

  const doc = documents.find((d) => d.id === activeDocumentId) ?? null;

  return (
    <div className="flex h-6 items-center gap-4 border-t border-[#3a3a42] bg-[#232328] px-3 text-xs text-[#8b8b92]">
      <span>cursor {doc ? formatTime(cursorSample, doc.sampleRate) : '—'}</span>
      <span>
        {doc && selection
          ? `sel ${formatTime(selection.start, doc.sampleRate)}–${formatTime(
              selection.end,
              doc.sampleRate
            )} (${formatTime(selection.end - selection.start, doc.sampleRate)})`
          : 'sel —'}
      </span>
      <span>
        {doc
          ? `${doc.sampleRate} Hz · ${doc.channels.length}ch · ${docLength(doc)} smp`
          : 'no document'}
      </span>
      <span>{tempoReadout(doc)}</span>
      <span className="ml-auto">spp: {zoom.samplesPerPixel}</span>
    </div>
  );
}
