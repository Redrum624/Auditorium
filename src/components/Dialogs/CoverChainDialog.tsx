import { useEffect, useRef, useState } from 'react';
import { Mic2 } from 'lucide-react';
import { docLength } from '../../audio/AudioDocument';
import type { StageDelta } from '../../dsp/chainAnalysis';
import { useAppStore } from '../../stores/appStore';
import {
  COVER_CHAIN_GOOD_TAKE_SENTENCE,
  COVER_CHAIN_RESIDUAL_SENTENCE,
  COVER_CHAIN_SHAPING_SENTENCE,
  COVER_CHAIN_SPREAD_SENTENCE,
  COVER_CHAIN_STAGES,
  COVER_CHAIN_UNDO_LABEL,
  defaultCoverStageSelection,
  runCoverChain,
  type CoverChainMetrics,
  type CoverChainReport,
  type CoverChainStageId,
  type CoverChainStageResult,
  type MatchEqDetail,
} from '../../services/coverChain';
import type { MatchBandStatus } from '../../dsp/coverMatch';
import type { StageStatus } from '../../services/vocalChain';
import { GlassButton, SectionLabel } from '../UI/glass';
import DialogShell from './DialogShell';

const dbfs = (v: number): string => (Number.isFinite(v) ? `${v.toFixed(1)} dBFS` : '—');
const db = (v: number): string => (Number.isFinite(v) ? `${v.toFixed(1)} dB` : '—');
const signedDb = (v: number): string =>
  Number.isFinite(v) ? `${v >= 0 ? '+' : ''}${v.toFixed(2)} dB` : '—';
const pct = (v: number): string => `${(v * 100).toFixed(1)}%`;
const secs = (samples: number, rate: number): string => `${(samples / rate).toFixed(2)} s`;

/** What each status SAYS, in the words a user can act on. `applied` claims only
 * that the stage ran — how well it ran is what the measured delta below it is
 * for. */
const STATUS_TEXT: Record<StageStatus, string> = {
  applied: 'Ran',
  declined: 'Did not run',
  off: 'Switched off',
  manual: 'Manual step',
};

const STATUS_COLOR: Record<StageStatus, string> = {
  applied: 'var(--accent)',
  // Amber, the colour every other dialog uses for "read this": a declined stage
  // is the one outcome that is easy to mistake for a successful one.
  declined: '#e0a458',
  off: 'var(--glass-text-muted)',
  manual: 'var(--glass-text-muted)',
};

const AMBER = '#e0a458';

/**
 * The before/after table's rows.
 *
 * `aimedAt` is load-bearing rather than decoration. The last column holds the
 * REFERENCE's own reading of each measure, and for three of the five rows that
 * reading is not a target and nothing in the chain moves towards it: the
 * limiter's peak target is its own −0.3 dBFS ceiling, the envelope spread is
 * explicitly never corrected (the dynamics match was measured and cut), and no
 * stage matches a noise floor. Heading that column "Target" told the user the
 * chain had under-delivered by the difference — on a successful run the Peak row
 * read "After −0.30 dBFS / Target −1.20 dBFS", which is a 0.9 dB miss against a
 * number nothing aimed at, and the spread row implied exactly the dynamics match
 * the measurements refused to ship.
 */
const METRIC_ROWS: {
  key: keyof CoverChainMetrics;
  label: string;
  unit: 'dbfs' | 'db';
  /** True when a stage actually moves this measure towards the reference's. */
  aimedAt: boolean;
}[] = [
  { key: 'gatedLevelDb', label: 'Loudness (sounding parts)', unit: 'dbfs', aimedAt: true },
  { key: 'peakDb', label: 'Peak', unit: 'dbfs', aimedAt: false },
  { key: 'spreadDb', label: 'Envelope spread', unit: 'db', aimedAt: false },
  { key: 'noiseFloorDb', label: 'Noise floor', unit: 'dbfs', aimedAt: false },
  { key: 'matchDistanceDb', label: 'Distance from the original vocal', unit: 'db', aimedAt: true },
];

/** `null` is a real answer here — nothing was sounding, or there was no
 * reference to measure a distance against — and it is rendered as one rather
 * than as a zero. */
function metricText(value: number | null, unit: 'dbfs' | 'db'): string {
  if (value === null) return 'n/a';
  return unit === 'dbfs' ? dbfs(value) : db(value);
}

/** The four numbers every applied stage reports, in one line. */
function deltaText(delta: StageDelta): string {
  const parts = [
    `RMS ${dbfs(delta.rmsBeforeDb)} → ${dbfs(delta.rmsAfterDb)}`,
    `peak ${dbfs(delta.peakBeforeDb)} → ${dbfs(delta.peakAfterDb)}`,
  ];
  if (delta.identicalFraction !== null) parts.push(`${pct(delta.identicalFraction)} of samples unchanged`);
  if (delta.differenceRmsDb !== null) parts.push(`difference ${dbfs(delta.differenceRmsDb)}`);
  return parts.join(' · ');
}

/**
 * What a band's non-matched status means, in words — a band with no correction
 * says WHY it has none.
 *
 * Keyed by `Exclude<MatchBandStatus, 'matched'>` rather than by `string`, so the
 * comment's claim to be exhaustive is one the COMPILER makes: a fifth member of
 * the union is a compile error here rather than a dangling em-dash followed by
 * "undefined" in the table. The `matched` entry is excluded because it is never
 * read — the render guard below is `status !== 'matched'` — and an entry that
 * cannot be reached is one nobody can tell is wrong.
 */
const BAND_STATUS_TEXT: Record<Exclude<MatchBandStatus, 'matched'>, string> = {
  'below-range': 'below the measured range',
  'above-nyquist': 'above Nyquist',
  'no-signal': 'no signal',
};

/**
 * The match curve, per band, TARGET against REALISED (Ruling B).
 *
 * Both columns are shown because they are different numbers and the difference
 * is the point: the Graphic EQ is a cascade of overlapping peaking filters, so
 * the gain a band is given is not the response it produces. The realised column
 * is what the audio received.
 */
function MatchEqTable({ eq }: { eq: MatchEqDetail }) {
  return (
    <table data-testid="cover-chain-eq-table" className="w-full text-xs" style={{ borderCollapse: 'collapse' }}>
      <thead>
        <tr style={{ color: 'var(--glass-text-muted)' }}>
          <th className="text-left font-normal" style={{ padding: '2px 0' }}>
            Band
          </th>
          <th className="text-right font-normal">Wanted</th>
          <th className="text-right font-normal">Realised</th>
          <th className="text-right font-normal">EQ gain</th>
        </tr>
      </thead>
      <tbody>
        {eq.bands.map((band) => (
          <tr key={band.centreHz} data-testid={`cover-chain-eq-row-${band.centreHz}`}>
            <td style={{ color: 'var(--glass-text-label)', padding: '2px 0' }}>
              {band.centreHz >= 1000 ? `${band.centreHz / 1000} kHz` : `${band.centreHz} Hz`}
              {band.status !== 'matched' && (
                <span style={{ color: 'var(--glass-text-muted)' }}> — {BAND_STATUS_TEXT[band.status]}</span>
              )}
              {band.bounded && <span style={{ color: AMBER }}> — bounded</span>}
            </td>
            <td className="text-right font-mono" style={{ color: 'var(--glass-text-secondary)' }}>
              {band.status === 'matched' ? signedDb(band.targetDb) : '—'}
            </td>
            <td className="text-right font-mono" style={{ color: 'var(--glass-text-title)' }}>
              {signedDb(band.realisedDb)}
            </td>
            <td className="text-right font-mono" style={{ color: 'var(--glass-text-secondary)' }}>
              {signedDb(band.bandGainDb)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** What one stage did, under that stage's own row. A declined stage renders its
 * reason INSTEAD, in amber; a stage that ran but needs a caveat renders the
 * caveat as well, in the same amber, because both are "read this". */
function StageResult({ result }: { result: CoverChainStageResult }) {
  if (result.status === 'declined') {
    return (
      <p data-testid={`cover-chain-reason-${result.id}`} className="mt-1 text-xs" style={{ color: STATUS_COLOR.declined }}>
        Did not run — {result.reason}
      </p>
    );
  }
  if (result.status !== 'applied') return null;
  return (
    <div className="mt-1 flex flex-col gap-0.5">
      {result.warning && (
        <p data-testid={`cover-chain-warning-${result.id}`} className="text-xs" style={{ color: AMBER }}>
          Warning — {result.warning}
        </p>
      )}
      {result.derived.map((d) => (
        <p
          key={d.label}
          data-testid={`cover-chain-derived-${result.id}`}
          className="text-xs"
          style={{ color: 'var(--glass-text-label)' }}
        >
          <span className="font-mono">
            {d.label}: {d.value}
          </span>
          <span style={{ color: 'var(--glass-text-muted)' }}> — from {d.from}</span>
        </p>
      ))}
      {result.eq && (
        <div className="mt-1">
          <MatchEqTable eq={result.eq} />
        </div>
      )}
      {result.detail && (
        <p data-testid={`cover-chain-detail-${result.id}`} className="text-xs" style={{ color: 'var(--glass-text-label)' }}>
          {result.detail}
        </p>
      )}
      {result.delta && (
        <p
          data-testid={`cover-chain-delta-${result.id}`}
          className="font-mono text-xs"
          style={{ color: 'var(--glass-text-secondary)' }}
        >
          {deltaText(result.delta)}
        </p>
      )}
    </div>
  );
}

/**
 * F10 — the Cover Chain.
 *
 * The engine (`services/coverChain.ts`) owns the order, the derivations and the
 * single undo entry. This dialog owns two jobs.
 *
 * The first is the vocal chain's: make the pass ACCOUNTABLE. Every stage listed
 * in the order it runs, with the note that says why it sits there, individually
 * switchable; afterwards, every stage saying what it did, with the settings it
 * derived and what it derived them from — and, for the match, the curve the EQ
 * MEASURABLY DELIVERED rather than the one it was asked for.
 *
 * The second is specific to this feature, and it is why the honesty block sits
 * ABOVE the Apply button rather than in a footnote. The instrumental a cover is
 * laid over still contains the original singer, measured; the match is a gentle
 * shaping and not a transformation; and a single take still has to be a good
 * take. A user who reads those three sentences after pressing Apply has been
 * told too late.
 */
export default function CoverChainDialog({ onClose }: { onClose: () => void }) {
  const doc = useAppStore((s) => s.documents.find((d) => d.id === s.activeDocumentId) ?? null);
  const documents = useAppStore((s) => s.documents);
  const selection = useAppStore((s) => s.selection);

  const [enabled, setEnabled] = useState<Record<CoverChainStageId, boolean>>(defaultCoverStageSelection);
  const [referenceDocId, setReferenceDocId] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [running, setRunning] = useState<string | null>(null);
  const [report, setReport] = useState<CoverChainReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  // RemixDialog's unmount-cancel idiom: the cleanup must read the CURRENT value,
  // so a ref rather than state. It is not a kill switch — the chain owns its own
  // worker leg and its own undo entry, and a run that has started must be
  // allowed to land or roll back as one.
  const cancelledRef = useRef(false);
  useEffect(() => {
    cancelledRef.current = false;
    return () => {
      cancelledRef.current = true;
    };
  }, []);

  if (!doc) return null;

  const rate = doc.sampleRate;
  const regionSamples = selection ? selection.end - selection.start : docLength(doc);
  const scopeText = selection
    ? `Selection — ${secs(regionSamples, rate)}`
    : `Whole file — ${secs(regionSamples, rate)}`;

  // Anything open except the take itself. The one you want is the "— Vocals"
  // document Separate Stems produced, but the list is not filtered by name: a
  // renamed or re-imported vocal is still a valid reference, and a filter that
  // hid it would be a rule the user cannot see.
  const candidates = documents.filter((d) => d.id !== doc.id);
  const resultById = new Map<CoverChainStageId, CoverChainStageResult>(
    (report?.stages ?? []).map((r) => [r.id, r] as const)
  );
  const anyEnabled = COVER_CHAIN_STAGES.some((s) => s.effectId !== null && enabled[s.id]);
  const done = report !== null && report.applied;
  const locked = busy || done;

  function toggle(id: CoverChainStageId, next: boolean): void {
    setEnabled((prev) => ({ ...prev, [id]: next }));
  }

  async function handleApply(): Promise<void> {
    if (busy || done || !anyEnabled) return;
    setBusy(true);
    setProgress(0);
    setRunning(null);
    setError(null);
    setReport(null);
    try {
      const result = await runCoverChain({
        enabled,
        referenceDocId: referenceDocId === '' ? null : referenceDocId,
        onProgress: (fraction) => {
          if (!cancelledRef.current) setProgress(fraction);
        },
        onStageStart: (stage) => {
          if (!cancelledRef.current) setRunning(stage.label);
        },
      });
      if (cancelledRef.current) return;
      if (!result) {
        // The engine reports its own failure through the shared error dialog and
        // leaves the document untouched; this line is what stays on screen here.
        setError('The chain did not run. Nothing in the document was changed.');
      } else {
        setReport(result);
      }
    } finally {
      if (!cancelledRef.current) {
        setBusy(false);
        setRunning(null);
      }
    }
  }

  return (
    <DialogShell
      title="Cover Chain"
      subtitle={doc.name}
      icon={<Mic2 size={15} />}
      width={640}
      onClose={onClose}
      dismissable={!busy}
    >
      <div className="flex flex-col gap-3" data-testid="cover-chain-dialog">
        <div data-testid="cover-chain-scope" className="text-xs" style={{ color: 'var(--glass-text-muted)' }}>
          {scopeText}
        </div>

        <SectionLabel>Before you run this</SectionLabel>

        <p data-testid="cover-chain-limitation" className="text-xs" style={{ color: AMBER }}>
          {COVER_CHAIN_RESIDUAL_SENTENCE}
        </p>
        <p data-testid="cover-chain-shaping" className="text-xs" style={{ color: 'var(--glass-text-label)' }}>
          {COVER_CHAIN_SHAPING_SENTENCE}
        </p>
        <p data-testid="cover-chain-good-take" className="text-xs" style={{ color: 'var(--glass-text-label)' }}>
          {COVER_CHAIN_GOOD_TAKE_SENTENCE}
        </p>

        <SectionLabel>The original vocal to match</SectionLabel>

        <label className="flex items-center gap-2 text-xs" style={{ color: 'var(--glass-text-label)' }}>
          <span className="shrink-0">Reference</span>
          <select
            data-testid="cover-chain-reference"
            className="min-w-0 flex-1 rounded-lg px-2 py-1 text-xs"
            style={{
              background: 'rgba(255, 255, 255, 0.05)',
              border: '1px solid var(--glass-border)',
              color: 'var(--glass-text-title)',
            }}
            value={referenceDocId}
            disabled={locked}
            onChange={(e) => setReferenceDocId(e.target.value)}
          >
            <option value="">— none chosen —</option>
            {candidates.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </label>

        {referenceDocId === '' && (
          <p data-testid="cover-chain-no-reference" className="text-xs" style={{ color: AMBER }}>
            Nothing to match against yet. Run Edit → Separate Stems… on the original song, then choose its “—
            Vocals” document here. Without it every matching stage below will decline.
          </p>
        )}

        <SectionLabel>Stages</SectionLabel>

        <p className="text-xs" style={{ color: 'var(--glass-text-muted)' }}>
          The stages run top to bottom over the region above, each on settings worked out from the audio that
          reaches it. The whole pass lands as a single undo entry.
        </p>

        <div className="flex flex-col gap-2">
          {COVER_CHAIN_STAGES.map((stage) => {
            const result = resultById.get(stage.id);
            const manual = stage.effectId === null;
            const status: StageStatus | null = result ? result.status : manual ? 'manual' : null;
            return (
              <div
                key={stage.id}
                data-testid={`cover-chain-stage-${stage.id}`}
                className="rounded-xl"
                style={{
                  border: '1px solid var(--glass-border)',
                  background: 'rgba(255, 255, 255, 0.02)',
                  padding: '8px 10px',
                }}
              >
                <div className="flex items-start gap-2">
                  {!manual && (
                    <input
                      type="checkbox"
                      id={`cover-chain-toggle-${stage.id}`}
                      data-testid={`cover-chain-toggle-${stage.id}`}
                      checked={enabled[stage.id]}
                      disabled={locked}
                      onChange={(e) => toggle(stage.id, e.target.checked)}
                      className="mt-0.5 accent-[#26c6da]"
                    />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline justify-between gap-2">
                      {manual ? (
                        <span className="text-xs font-semibold" style={{ color: 'var(--glass-text-title)' }}>
                          {stage.label}
                        </span>
                      ) : (
                        <label
                          htmlFor={`cover-chain-toggle-${stage.id}`}
                          className="text-xs font-semibold"
                          style={{ color: 'var(--glass-text-title)' }}
                        >
                          {stage.label}
                        </label>
                      )}
                      {status && (
                        <span
                          data-testid={`cover-chain-status-${stage.id}`}
                          className="shrink-0 text-xs"
                          style={{ color: STATUS_COLOR[status] }}
                        >
                          {STATUS_TEXT[status]}
                          {result?.elapsedMs !== undefined ? ` · ${(result.elapsedMs / 1000).toFixed(1)} s` : ''}
                        </span>
                      )}
                    </div>
                    <p
                      data-testid={`cover-chain-note-${stage.id}`}
                      className="mt-1 text-xs"
                      style={{ color: 'var(--glass-text-muted)' }}
                    >
                      {stage.note}
                    </p>
                    {result && <StageResult result={result} />}
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {report && (
          <>
            <SectionLabel>Before and after</SectionLabel>

            <table data-testid="cover-chain-summary" className="w-full text-xs" style={{ borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ color: 'var(--glass-text-muted)' }}>
                  <th className="text-left font-normal" style={{ padding: '2px 0' }}>
                    Measure
                  </th>
                  <th className="text-right font-normal">Before</th>
                  <th className="text-right font-normal">After</th>
                  <th className="text-right font-normal">
                    {report.referenceName ? `The original vocal — ${report.referenceName}` : 'The original vocal'}
                  </th>
                </tr>
              </thead>
              <tbody>
                {METRIC_ROWS.map((row) => (
                  <tr key={row.key} data-testid={`cover-chain-summary-${row.key}`}>
                    <td style={{ color: 'var(--glass-text-label)', padding: '2px 0' }}>
                      {row.label}
                      {row.aimedAt && (
                        <span style={{ color: 'var(--accent)' }}> — matched to it</span>
                      )}
                    </td>
                    <td className="text-right font-mono" style={{ color: 'var(--glass-text-secondary)' }}>
                      {metricText(report.before[row.key], row.unit)}
                    </td>
                    <td className="text-right font-mono" style={{ color: 'var(--glass-text-title)' }}>
                      {metricText(report.after[row.key], row.unit)}
                    </td>
                    <td className="text-right font-mono" style={{ color: 'var(--glass-text-secondary)' }}>
                      {report.reference ? metricText(report.reference[row.key], row.unit) : 'n/a'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <p data-testid="cover-chain-target-note" className="text-xs" style={{ color: 'var(--glass-text-muted)' }}>
              The last column is the original vocal&rsquo;s own reading of each measure. Only the two rows marked
              &ldquo;matched to it&rdquo; are targets: the Peak row&rsquo;s target is the Limiter&rsquo;s own
              &minus;0.3&nbsp;dBFS ceiling, and nothing here matches an envelope spread or a noise floor.
            </p>

            <p data-testid="cover-chain-spread-note" className="text-xs" style={{ color: 'var(--glass-text-muted)' }}>
              {COVER_CHAIN_SPREAD_SENTENCE}
            </p>

            <p data-testid="cover-chain-outcome" className="text-xs" style={{ color: 'var(--glass-text-label)' }}>
              {report.applied
                ? `Applied in ${(report.elapsedMs / 1000).toFixed(1)} s as one undo entry (“${COVER_CHAIN_UNDO_LABEL}”).${
                    report.outputSamples !== report.regionSamples
                      ? ` Region length ${secs(report.regionSamples, report.sampleRate)} → ${secs(
                          report.outputSamples,
                          report.sampleRate
                        )}.`
                      : ''
                  }`
                : 'No stage ran, so the document was not changed.'}
            </p>
          </>
        )}

        {error && (
          <p data-testid="cover-chain-error" className="text-xs text-[#ef5350]">
            {error}
          </p>
        )}

        {busy && (
          <div>
            <p data-testid="cover-chain-running" className="mb-1 text-xs" style={{ color: 'var(--glass-text-muted)' }}>
              {running ? `Running ${running}…` : 'Starting…'}
            </p>
            <div
              className="h-1.5 w-full overflow-hidden rounded-full"
              style={{
                background: 'rgba(255, 255, 255, 0.09)',
                boxShadow: 'inset 0 1px 2px rgba(0, 0, 0, 0.6)',
              }}
            >
              <div
                data-testid="cover-chain-progress"
                className="h-full transition-[width]"
                style={{
                  width: `${Math.round(progress * 100)}%`,
                  background: 'var(--accent)',
                  boxShadow: '0 0 8px var(--accent-ring)',
                }}
              />
            </div>
          </div>
        )}

        <div className="mt-2 flex justify-end gap-2">
          {done ? (
            <GlassButton variant="primary" data-testid="cover-chain-close" onClick={onClose}>
              Close
            </GlassButton>
          ) : (
            <>
              <GlassButton data-testid="cover-chain-cancel" onClick={onClose} disabled={busy}>
                Cancel
              </GlassButton>
              <GlassButton
                variant="primary"
                data-testid="cover-chain-apply"
                onClick={() => void handleApply()}
                disabled={busy || !anyEnabled}
              >
                Apply
              </GlassButton>
            </>
          )}
        </div>
      </div>
    </DialogShell>
  );
}
