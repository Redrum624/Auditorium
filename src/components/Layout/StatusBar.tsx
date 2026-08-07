import type { CSSProperties } from 'react';
import { docLength, type AudioDocument } from '../../audio/AudioDocument';
import { useAppStore } from '../../stores/appStore';
import { formatTime } from '../../utils/timeFormat';
import { getTempo, useTempoVersion } from '../../services/tempoAnalysis';
import { CONFIDENCE_LOW } from '../../dsp/tempoCore';
import { ChromePill } from '../UI/glass';

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

/** Mockup `.mono`: tabular numerals for the numeric readouts so the pill
 * doesn't jitter as the cursor/selection values tick. */
const monoStyle: CSSProperties = {
  fontVariantNumeric: 'tabular-nums',
  fontFamily: 'Consolas, monospace',
};

function Divider() {
  return (
    <span aria-hidden="true" style={{ color: 'var(--glass-text-muted)' }}>
      |
    </span>
  );
}

/** G2: the status bar is now the mockup's floating bottom chrome pill —
 * file info · cursor/selection · ♩ BPM · doc stats. Same five readouts (and
 * exact text shapes — the tempo `*`/`?` markers are tested contracts) as the
 * previous full-width bar; only the container changed. */
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
    <div className="flex shrink-0 justify-center px-3 pb-2 pt-1.5">
      <ChromePill
        data-testid="status-pill"
        className="flex items-center text-xs"
        style={{ gap: 18, padding: '7px 16px', color: 'var(--glass-text-secondary)' }}
      >
        <span>
          {doc
            ? `${doc.sampleRate} Hz · ${doc.channels.length}ch · ${docLength(doc)} smp`
            : 'no document'}
        </span>
        <Divider />
        <span style={monoStyle}>cursor {doc ? formatTime(cursorSample, doc.sampleRate) : '—'}</span>
        <span style={monoStyle}>
          {doc && selection
            ? `sel ${formatTime(selection.start, doc.sampleRate)}–${formatTime(
                selection.end,
                doc.sampleRate
              )} (${formatTime(selection.end - selection.start, doc.sampleRate)})`
            : 'sel —'}
        </span>
        <Divider />
        <span title={tempo.title} style={{ ...monoStyle, color: 'var(--accent)' }}>
          {tempo.text}
        </span>
        <Divider />
        <span style={{ ...monoStyle, color: 'var(--glass-text-muted)' }}>
          spp: {zoom.samplesPerPixel}
        </span>
      </ChromePill>
    </div>
  );
}
