import { useRef, useState } from 'react';
import { docLength, type AudioDocument } from '../../audio/AudioDocument';
import { useAppStore } from '../../stores/appStore';
import { useSessionStore } from '../../multitrack/sessionStore';
import { withSessionGesture } from '../../multitrack/sessionUndo';
import { clampFadePair, crossfadableOverlap, DEFAULT_FADE_CURVE, type Clip } from '../../multitrack/session';
import { resolveClipFadeSpecs } from '../../multitrack/mixdown';
import {
  FADE_CURVES,
  FADE_CURVE_DESCRIPTIONS,
  FADE_CURVE_LABELS,
  type FadeCurve,
} from '../../dsp/fades';
import { formatTime, parseTime } from '../../utils/timeFormat';
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

/** Shared full-width accent action button (Fix round 1 simplification — the
 * two tempo buttons were identical JSX differing only in testid/label; X4
 * generalised it with `disabled`/`title` for the crossfade Arm action). */
function PanelActionButton({
  testId,
  label,
  onClick,
  disabled,
  title,
}: {
  testId: string;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <div className="px-2 py-1">
      <button
        type="button"
        data-testid={testId}
        onClick={onClick}
        disabled={disabled}
        title={title}
        className="w-full rounded bg-[#26c6da] px-2 py-1 text-xs font-medium text-[#1a1a1e] hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {label}
      </button>
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
            <PanelActionButton testId="tempo-reanalyze-button" label="Re-analyze" onClick={detectOrReanalyze} />
          )}
        </>
      ) : (
        <PanelActionButton testId="tempo-analyze-button" label="Detect Tempo" onClick={detectOrReanalyze} />
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
      {/* v1.9.1: surfaced alongside — never-saved is distinct provenance (no
          file on disk at all), not the same as dirty (has unsaved edits); a
          computed doc is clean-but-never-saved from birth, which is why it can
          still prompt on close. */}
      <Row label="Never saved" value={doc.neverSaved ? 'Yes' : 'No'} />

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

/**
 * X4 — fade length editor: the GainInput local-draft pattern (T36 — a
 * store-bound value would fight the user mid-keystroke, because
 * `setClipFade`'s clamp can answer with a different number than was typed).
 * Displays `formatTime` (`m:ss.mmm`), parses via `parseTime` (which also
 * accepts plain seconds). `onCommit` performs the store write and returns
 * what the store actually kept, so the echoed value is the store's clamp,
 * never a UI re-implementation of it (C4). The parent additionally keys this
 * component by the committed value, so an edit arriving from elsewhere (a
 * handle drag with the panel open) resets the draft.
 */
function FadeLengthInput({
  valueSample,
  sampleRate,
  label,
  onCommit,
}: {
  valueSample: number;
  sampleRate: number;
  label: string;
  onCommit: (lengthSample: number) => number;
}) {
  const [draft, setDraft] = useState(formatTime(valueSample, sampleRate));
  const escapingRef = useRef(false);

  const commit = () => {
    if (escapingRef.current) return;
    const parsed = parseTime(draft, sampleRate);
    if (parsed !== null) {
      const stored = onCommit(parsed);
      setDraft(formatTime(stored, sampleRate)); // reflect the store's clamp
    } else {
      setDraft(formatTime(valueSample, sampleRate)); // revert garbage
    }
  };

  return (
    <input
      type="text"
      inputMode="decimal"
      value={draft}
      aria-label={label}
      title="Fade length — m:ss.mmm or plain seconds; 0 clears the fade"
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit();
        if (e.key === 'Escape') {
          setDraft(formatTime(valueSample, sampleRate));
          escapingRef.current = true;
          e.currentTarget.blur(); // dispatches blur synchronously
          escapingRef.current = false;
        }
      }}
      className="w-20 rounded border border-[#3a3a42] bg-[#1a1a1e] px-1 py-0.5 text-right text-[#d4d4d8] outline-none focus:border-[#26c6da]"
    />
  );
}

/**
 * CC3 — clip start editor.
 *
 * Until this field, drag was the app's ONLY placement affordance: a stated
 * offset (the Cover Chain's refused guess above all) had to be realised by eye,
 * with no snap target at the position it named. The panel now takes the number.
 *
 * Structurally identical to `FadeLengthInput` (T36's local-draft pattern, C4's
 * echo-the-store rule) and deliberately so — two time fields in one panel that
 * behaved differently would be a defect. `parseTime` already refuses negatives,
 * which is the honest answer here rather than a silent clamp to zero: no clip
 * can start before zero, and committing a 0 the user did not type would look
 * like the field had accepted the position.
 */
function ClipStartInput({
  valueSample,
  sampleRate,
  onCommit,
}: {
  valueSample: number;
  sampleRate: number;
  onCommit: (startSample: number) => number;
}) {
  const committedText = formatTime(valueSample, sampleRate);
  const [draft, setDraft] = useState(committedText);
  const escapingRef = useRef(false);

  const commit = () => {
    if (escapingRef.current) return;
    // Fix round 1 (I1) — the field's half of the R3 no-op guard. `moveClip`
    // now carries the store-level one too (H1), and this stays: it is what
    // stops a no-op from reaching the store at all, and it owns the question
    // the store cannot answer — what the FIELD is showing. Two ways a commit
    // can be a no-op, and both must cost nothing:
    //  - the draft was never edited (a click into the field to READ it). This
    //    matters more here than for a fade length, because `formatTime`
    //    rounds to whole milliseconds and `parseTime` re-derives samples from
    //    that string: a clip off the millisecond grid — i.e. every dragged
    //    clip — would be silently nudged, with `maintainFacingFades` re-run on
    //    a move the user never made.
    //  - the draft is another spelling of where the clip already is ('1' for
    //    '0:01.000'). Different text, same position; nothing to write.
    if (draft === committedText) return;
    const parsed = parseTime(draft, sampleRate);
    // H1 (fix-round-1 re-review, m1): "same position" is decided on what the
    // user can SEE, not on the sample. Sample-equality left the off-grid case
    // open — a clip at 44101 reads `0:01.000`, and typing `1` parsed to 44100,
    // one sample away, so it committed a move and an undo entry while the field
    // read identically before and after. Formatting the parse and comparing
    // TEXT closes it, and it makes the two spellings of one request ('1' and
    // '0:01.000') behave the same way, which they did not before.
    if (parsed === null || formatTime(parsed, sampleRate) === committedText) {
      setDraft(committedText); // revert garbage, or normalise the spelling
      return;
    }
    const stored = onCommit(parsed);
    setDraft(formatTime(stored, sampleRate)); // reflect the store's clamp
  };

  return (
    <input
      type="text"
      inputMode="decimal"
      value={draft}
      aria-label="Clip start"
      title="Where this clip starts on the timeline — m:ss.mmm or plain seconds. A clip cannot start before zero."
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit();
        if (e.key === 'Escape') {
          setDraft(committedText);
          escapingRef.current = true;
          e.currentTarget.blur(); // dispatches blur synchronously
          escapingRef.current = false;
        }
      }}
      className="w-20 rounded border border-[#3a3a42] bg-[#1a1a1e] px-1 py-0.5 text-right text-[#d4d4d8] outline-none focus:border-[#26c6da]"
    />
  );
}

/** X4 — fade curve picker. Options come straight from FADE_CURVES in its
 * documented picker order; labels are the ruling-2 behaviour names and the
 * title carries the one-line description of the selected curve. Styled on the
 * panel's own raw-Tailwind field idiom (this file deliberately does not use
 * the Glass* primitives). */
function FadeCurveSelect({
  value,
  label,
  onChange,
}: {
  value: FadeCurve;
  label: string;
  onChange: (curve: FadeCurve) => void;
}) {
  return (
    <select
      value={value}
      aria-label={label}
      title={FADE_CURVE_DESCRIPTIONS[value]}
      // The cast is sound: every option value below comes from FADE_CURVES,
      // and setClipFade re-validates against FADE_CURVES at runtime anyway.
      onChange={(e) => onChange(e.target.value as FadeCurve)}
      className="rounded border border-[#3a3a42] bg-[#1a1a1e] px-1 py-0.5 text-[#d4d4d8] outline-none focus:border-[#26c6da]"
    >
      {FADE_CURVES.map((c) => (
        <option key={c} value={c}>
          {FADE_CURVE_LABELS[c]}
        </option>
      ))}
    </select>
  );
}

/** Selected clip facts + editable gain and fades (multitrack view). The fade
 * controls are X4's Properties-panel half of ruling 7: per-edge length +
 * curve, with the crossfade state of each edge surfaced next to it (armed →
 * width readout + Release; capable overlap → Arm; other overlap → an honest
 * "raw sum" note). */
function ClipProperties() {
  const documents = useAppStore((s) => s.documents);
  const session = useSessionStore((s) => s.session);
  const selectedClipId = useSessionStore((s) => s.selectedClipId);
  const selectedClipIds = useSessionStore((s) => s.selectedClipIds); // K1
  const setClipGain = useSessionStore((s) => s.setClipGain);
  const setClipFade = useSessionStore((s) => s.setClipFade);
  const moveClip = useSessionStore((s) => s.moveClip); // CC3

  let clip: Clip | null = null;
  let trackName = '';
  let trackClips: Clip[] = [];
  for (const track of session.tracks) {
    const found = track.clips.find((c) => c.id === selectedClipId);
    if (found) {
      clip = found;
      trackName = track.name;
      trackClips = track.clips;
      break;
    }
  }

  if (!clip) {
    return <div className="p-2 text-sm text-[#8b8b92]">No clip selected.</div>;
  }

  const srcDoc = documents.find((d) => d.id === clip!.documentId);

  // The renderer's own resolver decides what each edge IS right now (solo
  // fade, live crossfade, or superseded) — the panel never re-derives rule 3.
  const spec = resolveClipFadeSpecs(trackClips).get(clip.id);

  /** Commits one edge's fade length through the store — THE clamp boundary
   * (C4) — and returns what the store actually kept (read synchronously from
   * the store, zustand's set is synchronous), so the input can echo the clamp
   * without re-implementing it. */
  /** CC3 — commits a typed clip start through the store's own `moveClip`, and
   * returns the position the store actually kept. `moveClip` owns the >= 0
   * clamp, the facing-fade maintenance and the single 'Move clip' undo entry;
   * this panel re-implements none of the three. The clip stays on its own
   * track — this field places, it does not re-route. */
  const commitClipStart = (startSample: number): number => {
    let trackId = '';
    for (const t of session.tracks) {
      if (t.clips.some((c) => c.id === clip!.id)) {
        trackId = t.id;
        break;
      }
    }
    if (!trackId) return clip!.startSample;
    moveClip(clip!.id, trackId, startSample);
    for (const t of useSessionStore.getState().session.tracks) {
      const c = t.clips.find((x) => x.id === clip!.id);
      if (c) return c.startSample;
    }
    return clip!.startSample;
  };

  const commitFadeLength = (edge: 'in' | 'out', lengthSample: number): number => {
    setClipFade(clip!.id, edge, { lengthSample });
    for (const t of useSessionStore.getState().session.tracks) {
      const c = t.clips.find((x) => x.id === clip!.id);
      if (c) return (edge === 'in' ? c.fadeInSample : c.fadeOutSample) ?? 0;
    }
    return 0;
  };

  /** The crossfade-capable pair on one edge of this clip, if any. Full-track
   * geometry (rule 4 included), so an intruded or piled-up overlap is
   * honestly "not capable" here. Rule 4 also guarantees at most ONE capable
   * pair per edge. */
  const pairOnEdge = (edge: 'in' | 'out') => {
    for (const m of trackClips) {
      if (m.id === clip!.id) continue;
      const geo = crossfadableOverlap(trackClips, clip!, m);
      if (!geo) continue;
      if (edge === 'in' ? geo.b.id === clip!.id : geo.a.id === clip!.id) return geo;
    }
    return null;
  };
  const pairIn = pairOnEdge('in');
  const pairOut = pairOnEdge('out');

  type PairGeo = NonNullable<typeof pairIn>;

  /** True when arming would grant BOTH members the full overlap width —
   * evaluated with the store's own exported `clampFadePair` on exactly the
   * arguments `setClipFade` would use, so this predicate cannot drift from
   * the store (it IS the store's clamp, not a second one). It refuses
   * partial arms: a shortened facing fade would not satisfy rule 3 and the
   * "armed" pair would silently render as solo fades. */
  const armGrantsFullWidth = (geo: PairGeo): boolean =>
    clampFadePair(geo.a.fadeInSample ?? 0, geo.width, geo.a.lengthSample, 'in').fadeOut ===
      geo.width &&
    clampFadePair(geo.width, geo.b.fadeOutSample ?? 0, geo.b.lengthSample, 'out').fadeIn ===
      geo.width;

  /** X4's direct recovery path for a raw/dissolved overlap (carried X5
   * finding: such a pair is not drag-armable — eligibility needs pre-width 0
   * or already-armed). Writing both facing fades to the exact width through
   * setClipFade makes the pair canonical: the renderer crossfades it and the
   * store's maintenance treats it as armed from then on. */
  const armCrossfade = (geo: PairGeo): void => {
    // R3: one user act, two store writes — one undo entry (ruling 2).
    withSessionGesture('Arm crossfade', () => {
      setClipFade(geo.a.id, 'out', { lengthSample: geo.width });
      setClipFade(geo.b.id, 'in', { lengthSample: geo.width });
    });
  };

  /** Clears BOTH facing fades (0 normalises to "no fade") — the symmetric
   * un-arm X5 left to the fade UI. Clearing only one side would strand the
   * partner's fade as a surprise solo fade. */
  const releaseCrossfade = (geo: PairGeo): void => {
    // R3: one user act, two store writes — one undo entry (ruling 2).
    withSessionGesture('Release crossfade', () => {
      setClipFade(geo.a.id, 'out', { lengthSample: 0 });
      setClipFade(geo.b.id, 'in', { lengthSample: 0 });
    });
  };

  const hasAnyOverlap = trackClips.some(
    (m) =>
      m.id !== clip!.id &&
      Math.min(m.startSample + m.lengthSample, clip!.startSample + clip!.lengthSample) -
        Math.max(m.startSample, clip!.startSample) >
        0
  );

  return (
    <div className="flex flex-col py-1" data-testid="properties-clip">
      {/* K1 — the group header. Everything below it edits the PRIMARY clip and
          says so by showing the primary's own values; this row exists so that a
          Delete or a Ripple Delete over a Ctrl+Click set is never a surprise
          about how much it will take. Absent for a single clip, where the panel
          is exactly what it always was. */}
      {selectedClipIds.length > 1 && (
        <div
          data-testid="clip-selection-count"
          className="px-2 py-1 text-xs font-semibold"
          style={{ color: 'var(--accent)' }}
          title="Delete, Ripple Delete and a drag act on all of them; the fields below edit the last-clicked clip"
        >
          {selectedClipIds.length} clips selected
        </div>
      )}
      <Row label="Source" value={srcDoc?.name ?? '—'} />
      <Row label="Track" value={trackName} />
      {/* CC3: the one clip fact that was a readout and had to be a field —
          every other placement affordance in the app is a drag. */}
      <label className="flex items-center justify-between gap-2 px-2 py-1 text-xs">
        <span className="shrink-0 text-[#8b8b92]">Start</span>
        <ClipStartInput
          // Re-key on the committed position too, so a drag with the panel
          // open resets a stale draft (the FadeLengthInput ruling).
          key={`${clip.id}:${clip.startSample}`}
          valueSample={clip.startSample}
          sampleRate={session.sampleRate}
          onCommit={commitClipStart}
        />
      </label>
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

      <SectionLabel>Fades</SectionLabel>
      {(['in', 'out'] as const).map((edge) => {
        const isIn = edge === 'in';
        const armed = (isIn ? spec?.crossIn : spec?.crossOut) ?? null;
        const stored = (isIn ? clip!.fadeInSample : clip!.fadeOutSample) ?? 0;
        const curve = (isIn ? clip!.fadeInCurve : clip!.fadeOutCurve) ?? DEFAULT_FADE_CURVE;
        const geo = isIn ? pairIn : pairOut;
        return (
          <div key={edge} className="flex flex-col">
            <div className="flex items-center justify-between gap-2 px-2 py-1 text-xs">
              <span className="shrink-0 text-[#8b8b92]">{isIn ? 'Fade In' : 'Fade Out'}</span>
              <span className="flex min-w-0 items-center gap-1">
                {armed !== null ? (
                  // A live crossfade's facing fade IS the overlap width (rule
                  // 3, sample-exact) — a ms-precision text field cannot
                  // express it, and a hand edit would silently dissolve the
                  // pair. Readout instead; the curve stays editable (each
                  // side's curve is free).
                  <span
                    data-testid={`fade-${edge}-cross-readout`}
                    className="text-[#d4d4d8]"
                    title="This edge is a live crossfade — its length is the overlap width. Move or trim a clip to change it, or release the crossfade."
                  >
                    {formatTime(armed.lengthSample, session.sampleRate)}
                  </span>
                ) : (
                  <FadeLengthInput
                    // Re-key on the committed value too, so an edit arriving
                    // from the clip handles resets a stale draft.
                    key={`${clip!.id}:${edge}:${stored}`}
                    valueSample={stored}
                    sampleRate={session.sampleRate}
                    label={isIn ? 'Fade in length' : 'Fade out length'}
                    onCommit={(n) => commitFadeLength(edge, n)}
                  />
                )}
                <FadeCurveSelect
                  value={curve}
                  label={isIn ? 'Fade in curve' : 'Fade out curve'}
                  onChange={(c) => setClipFade(clip!.id, edge, { curve: c })}
                />
              </span>
            </div>
            {armed !== null && geo !== null && (
              <div className="flex items-center justify-between gap-2 px-2 pb-1 text-xs">
                <span className="text-[#8b8b92]">{isIn ? 'Crossfade in' : 'Crossfade out'}</span>
                <button
                  type="button"
                  data-testid={`crossfade-release-${edge}`}
                  title="Clear both facing fades — the overlap becomes a raw sum"
                  onClick={() => releaseCrossfade(geo)}
                  className="rounded border border-[#3a3a42] px-1 text-[#d4d4d8] hover:border-[#26c6da]"
                >
                  Release
                </button>
              </div>
            )}
            {armed === null && geo !== null && (
              <PanelActionButton
                testId={`crossfade-arm-${edge}`}
                label={`Arm crossfade (${formatTime(geo.width, session.sampleRate)})`}
                disabled={!armGrantsFullWidth(geo)}
                title={
                  armGrantsFullWidth(geo)
                    ? 'Set both facing fades to span the overlap exactly'
                    : 'Blocked — an away-side fade leaves no room at this width'
                }
                onClick={() => armCrossfade(geo)}
              />
            )}
          </div>
        );
      })}
      {hasAnyOverlap && pairIn === null && pairOut === null && spec?.crossIn == null && spec?.crossOut == null && (
        // Overlapping, but no edge can crossfade (equal starts, containment,
        // pile-up, or an intruder) — say so instead of showing nothing.
        <Row label="Overlap" value="raw sum — not crossfade-capable" muted />
      )}
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
