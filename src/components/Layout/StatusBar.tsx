import { docLength, type AudioDocument } from '../../audio/AudioDocument';
import { useAppStore } from '../../stores/appStore';
import { formatTime } from '../../utils/timeFormat';
import { getTempo, useTempoVersion } from '../../services/tempoAnalysis';
import { CONFIDENCE_LOW } from '../../dsp/tempoCore';

const LOW_CONFIDENCE_TITLE =
  'Low confidence tempo estimate — may be wrong (e.g. an octave error) or the material may not be percussive.';

/** '♩ 128.4' for a fresh result, '♩ 128.4*' when stale, '♩ —' with no
 * document, no cached entry, or a null bpm (too short / no rhythm detected —
 * this compact readout doesn't have room for the reason; PropertiesPanel's
 * Tempo section shows it). Decision #3: a CACHED READ ONLY — never calls
 * `runTempoAnalysis`, so opening a file costs nothing.
 *
 * Below `CONFIDENCE_LOW` a bare number would contradict PropertiesPanel's own
 * 'low' label (Decision #4) — on non-percussive material (strings, pads,
 * spoken word) the estimator still returns a plausible-looking BPM, and this
 * glance-level surface is exactly where a bare number gets trusted without
 * inspection (Fix round 1, plan-owner ruling). A trailing '?' plus a `title`
 * marks it uncertain instead. */
function tempoReadout(doc: AudioDocument | null): { text: string; title?: string } {
  const entry = doc ? getTempo(doc) : null;
  if (!entry || entry.bpm === null) return { text: '♩ —' };
  const uncertain = entry.confidence < CONFIDENCE_LOW;
  const text = `♩ ${entry.bpm.toFixed(1)}${entry.stale ? '*' : ''}${uncertain ? '?' : ''}`;
  return { text, title: uncertain ? LOW_CONFIDENCE_TITLE : undefined };
}

export default function StatusBar() {
  useTempoVersion();
  const documents = useAppStore((s) => s.documents);
  const activeDocumentId = useAppStore((s) => s.activeDocumentId);
  const cursorSample = useAppStore((s) => s.cursorSample);
  const selection = useAppStore((s) => s.selection);
  const zoom = useAppStore((s) => s.zoom);

  const doc = documents.find((d) => d.id === activeDocumentId) ?? null;
  const tempo = tempoReadout(doc);

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
      <span title={tempo.title}>{tempo.text}</span>
      <span className="ml-auto">spp: {zoom.samplesPerPixel}</span>
    </div>
  );
}
