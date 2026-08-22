import type { CSSProperties } from 'react';
import { docLength, type AudioDocument } from '../../audio/AudioDocument';
import { useAppStore } from '../../stores/appStore';
import { useSessionStore } from '../../multitrack/sessionStore';
import { projectHasUnsavedWork } from '../../services/fileService';
import { useHistoryVersion } from '../../services/undoHistory';
import { formatTime } from '../../utils/timeFormat';
import { getTempo, useTempoVersion } from '../../services/tempoAnalysis';
import { CONFIDENCE_LOW } from '../../dsp/tempoCore';
import { ChromePill } from '../UI/glass';
import LevelMeter from './LevelMeter';

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

/** U1: the retired file chip's channel wording, verbatim — 'mono' / 'stereo' /
 * 'Nch'. The mockup abbreviates it to 'St'; the app's own vocabulary is a word
 * the reader does not have to decode, and it costs four characters. */
function channelLabel(count: number): string {
  return count === 1 ? 'mono' : count === 2 ? 'stereo' : `${count}ch`;
}

/** G2: the status bar is now the mockup's floating bottom chrome pill —
 * file info · cursor/selection · ♩ BPM · doc stats. Same five readouts (and
 * exact text shapes — the tempo `*`/`?` markers are tested contracts) as the
 * previous full-width bar; only the container changed.
 *
 * G3 merged in the retired bottom TransportBar's two non-control surfaces
 * (plan: "merge, don't drop"): the PROMINENT transport time readout
 * (`transport-time`, view-routed exactly as before — cursor while stopped,
 * engine position while playing, multitrack cursor/playhead in that view) and
 * the level meter.
 *
 * G6: the band truly floats now — an absolute bottom-centre z-20 overlay on
 * the radial stage (mockup `.status`), pointer-transparent outside the pill.
 *
 * U1 (layout E2, element 3): the retired file chip's identity readout folds in
 * at the head of the pill, and the band itself moved OUT of this component —
 * App owns one bottom band carrying the edit pill above this one, both centred
 * on the waveform's axis. This component is the pill and nothing else now, so
 * the two can share a gap the flex column guarantees. */
/** F11: the samples-per-pixel readout. See its JSX for why it needs formatting
 * at all. Exported for the test that pins the rounding. */
export function formatSpp(samplesPerPixel: number): string {
  if (!Number.isFinite(samplesPerPixel)) return String(samplesPerPixel);
  if (samplesPerPixel >= 100) return String(Math.round(samplesPerPixel));
  return String(Number.parseFloat(samplesPerPixel.toFixed(2)));
}

export default function StatusBar() {
  useTempoVersion();
  const documents = useAppStore((s) => s.documents);
  const activeDocumentId = useAppStore((s) => s.activeDocumentId);
  const cursorSample = useAppStore((s) => s.cursorSample);
  const selection = useAppStore((s) => s.selection);
  const zoom = useAppStore((s) => s.zoom);
  const view = useAppStore((s) => s.view);
  const playback = useAppStore((s) => s.playback);

  const mtSampleRate = useSessionStore((s) => s.session.sampleRate);
  const mtCursorSample = useSessionStore((s) => s.mtCursorSample);
  const mtPlayState = useSessionStore((s) => s.mtPlayState);
  const mtPlayheadSample = useSessionStore((s) => s.mtPlayheadSample);

  // Lot A (N13): the project chip — `<project> *` in every view. Dirtiness is
  // derived from the documents (subscribed above), the session's history and
  // the project path, so the chip subscribes to the name, the path and the
  // history version; a clip move changes no appStore state.
  const sessionName = useSessionStore((s) => s.session.name);
  const projectPath = useSessionStore((s) => s.projectPath);
  useHistoryVersion();
  const projectDirty = projectHasUnsavedWork();

  const doc = documents.find((d) => d.id === activeDocumentId) ?? null;
  const tempo = tempoReadout(doc);

  // Transport time routing, verbatim from the retired TransportBar.
  const isMultitrack = view === 'multitrack';
  const isPlaying = isMultitrack ? mtPlayState === 'playing' : playback.state === 'playing';
  const readoutRate = isMultitrack ? mtSampleRate : (doc?.sampleRate ?? 44100);
  const readoutSample = isMultitrack
    ? mtPlayState === 'playing'
      ? mtPlayheadSample
      : mtCursorSample
    : isPlaying
      ? playback.positionSample
      : cursorSample;

  return (
    <ChromePill
      data-testid="status-pill"
      className="pointer-events-auto flex items-center text-xs"
      style={{
        gap: 18,
        padding: '7px 16px',
        color: 'var(--glass-text-secondary)',
        maxWidth: '100%',
        minWidth: 0,
      }}
    >
      {/* Lot A (N13): the project FIRST — its name, starred while anything in
            it is unsaved (a dirty document, a session edit, or a project that
            has content and no file yet). The title carries the `.audm` path so
            a hover answers "where does Save write?". */}
        <span
          data-testid="project-chip"
          title={projectPath ?? 'Project not saved yet'}
          style={{
            color: 'var(--glass-text-title)',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {sessionName}
          {projectDirty ? ' *' : ''}
        </span>
        <Divider />
      {/* U1: the file identity the top-left chip used to carry, folded in
            here — name first, then the compact `duration · rate · channels`
            the mockup abbreviates. It keeps the chip's `file-chip` testid:
            the surface moved, the contract did not. The old
            `44100 Hz · 2ch · N smp` segment is what it replaces — rate and
            channels were already in it, and a raw sample count is the one
            number the properties panel is for. */}
        <span
          data-testid="file-chip"
          className="flex min-w-0 items-center"
          style={{ gap: 8, whiteSpace: 'nowrap' }}
        >
          {doc ? (
            <>
              <span
                title={doc.name}
                style={{
                  color: 'var(--glass-text-title)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                {doc.name}
              </span>
              <Divider />
              <span>
                {formatTime(docLength(doc), doc.sampleRate)} ·{' '}
                {(doc.sampleRate / 1000).toFixed(1)}k · {channelLabel(doc.channels.length)}
              </span>
            </>
          ) : (
            <span style={{ color: 'var(--glass-text-muted)' }}>no document</span>
          )}
        </span>
        <Divider />
        <span
          data-testid="transport-time"
          style={{
            ...monoStyle,
            fontSize: 16,
            fontWeight: 600,
            color: 'var(--glass-text-title)',
          }}
        >
          {formatTime(readoutSample, readoutRate)}
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
        {/* F11: formatted. Samples-per-pixel used to be an integer on every
            path (`ceil(length / 1600)`); since fit-on-open it is
            `docLength / laneWidth`, which almost never divides evenly — the
            readout was printing `7812.222320637732` on a freshly opened file.
            Two decimals below 100, none above: the fractional part only means
            anything when zoomed in far enough for one pixel to be a handful of
            samples. `Number.parseFloat(toFixed())` drops a trailing `.00`, so a
            genuinely round value still reads as one. */}
        <span style={{ ...monoStyle, color: 'var(--glass-text-muted)' }}>
          spp: {formatSpp(zoom.samplesPerPixel)}
        </span>
        <Divider />
        <LevelMeter channels={doc?.channels.length ?? 2} />
    </ChromePill>
  );
}
