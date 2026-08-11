import { useEffect, useMemo, useRef, useState } from 'react';
import { Mic, Play, Square, Text, Upload } from 'lucide-react';
import { docLength } from '../../audio/AudioDocument';
import { RecordingEngine } from '../../audio/RecordingEngine';
import { useAppStore } from '../../stores/appStore';
import {
  ALIGN_ACCURACY,
  ALIGN_ACCURACY_SENTENCE,
  MEASURED_ALIGN_REALTIME_FACTOR,
  alignDocumentLyrics,
  cancelAlignment,
  ensureAlignModels,
  getAlignModelState,
  getLyricsAlignment,
  isLyricsAlignmentStale,
  loadLyricsFile,
  previewWord,
  replaceWord,
  useAlignVersion,
  type AlignModelState,
  type AlignProgress,
  type LyricsAlignment,
  type PlacedWord,
} from '../../services/alignLyricsService';
import { GlassButton, SectionLabel } from '../UI/glass';
import DialogShell from './DialogShell';

/** `m:ss` — the grain every duration in this app's dialogs is expressed in
 *  (SeparateDialog.tsx's own formatter). */
function formatMmss(samples: number, sampleRate: number): string {
  const total = Number.isFinite(samples) ? Math.max(0, Math.round(samples / sampleRate)) : 0;
  const minutes = Math.floor(total / 60);
  return `${minutes}:${String(total - minutes * 60).padStart(2, '0')}`;
}

function formatSeconds(seconds: number): string {
  return formatMmss(Math.max(0, Math.round(seconds)), 1);
}

/** Decimal megabytes — the unit Hugging Face quotes file sizes in. */
function formatMb(bytes: number): string {
  return `${Math.round(bytes / 1e6)} MB`;
}

function formatMs(samples: number, sampleRate: number): string {
  return `${Math.round((samples / sampleRate) * 1000)} ms`;
}

/**
 * F6 — Align Lyrics.
 *
 * ## The name, and what the dialog is forbidden from doing
 *
 * The feature this grew out of was asked for as a "pronunciation coach". That
 * is NOT what ships. F6's spike evaluated Goodness-of-Pronunciation over this
 * same model's emission grid and measured **AUC 0.642 against a 0.500 chance
 * baseline, flagging 46 of 51 words** — a scorer that flags nine words in ten
 * is the confident-wrong machine this project's rules exist to prevent, and a
 * name implying assessment would be factually wrong.
 *
 * So: **nothing in this dialog ranks, scores, flags, colours or sorts a word by
 * how it was sung.** Every word is rendered identically. The per-word placement
 * score exists in the data and is deliberately never shown. The user's ear
 * decides which word to fix; the dialog's whole job is to make that word
 * instantly audible in isolation and cleanly replaceable.
 *
 * ## The lyrics-match warning is a WARNING, never a refusal
 *
 * CTC forced alignment structurally never says "could not align" — given the
 * wrong lyrics it returns a confident placement of the wrong words. The gate is
 * the MEDIAN PER-WORD score against `LYRICS_MATCH_THRESHOLD`, chosen on a
 * held-out bank (see `ctcAlign.ts`). That bank is not separable, so a gate that
 * REFUSED would eventually refuse correct work. It says what it measured and
 * shows the spans anyway.
 *
 * ## Replacements come from the microphone
 *
 * There is no file-import affordance for the replacement, deliberately — see
 * the module header of `alignLyricsService.ts`. Recording it is also the more
 * honest answer to "in her own voice": it IS her voice.
 *
 * Lifetime: `dismissable={!busy}` so neither Escape nor a backdrop click can
 * discard a running download, alignment or take, and the unmount cleanup
 * cancels an in-flight alignment AND stops a running recorder — an orphaned
 * `RecordingEngine` holds the microphone open for the rest of the session.
 *
 * `busy` counts the microphone ACQUISITION too, not just the recording. The
 * engine claims its recording slot synchronously and only takes the microphone
 * when `getUserMedia` resolves, so the permission prompt used to be a stretch
 * in which this dialog called itself idle: dismissable, and with a cleanup that
 * "stopped" an engine holding nothing and then let the resolving `start()` hand
 * a live stream to an engine nothing could reach. The window is closed by
 * `acquiring`, and the cleanup waits on the pending `start()` before stopping.
 */
export default function AlignLyricsDialog({
  onClose,
  engine: injectedEngine,
}: {
  onClose: () => void;
  /** Injectable for tests, exactly as `RecordDialog` takes one — jsdom has no
   * `navigator.mediaDevices`, so the microphone half is otherwise unreachable
   * and its state machine would go unpinned. */
  engine?: RecordingEngine;
}) {
  const doc = useAppStore((s) => s.documents.find((d) => d.id === s.activeDocumentId) ?? null);
  const selection = useAppStore((s) => s.selection);
  const length = doc ? docLength(doc) : 0;
  const alignVersion = useAlignVersion();

  const [model, setModel] = useState<AlignModelState | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [received, setReceived] = useState(0);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<AlignProgress | null>(null);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [selectedWord, setSelectedWord] = useState<number | null>(null);
  const [recording, setRecording] = useState(false);
  /**
   * The microphone is being ACQUIRED — `getUserMedia` is outstanding.
   *
   * Separate from `recording` because it is not the same state to the user (no
   * Stop button yet, nothing being captured) but it is the same state to
   * `busy`: without it the whole permission prompt was a window in which the
   * dialog reported itself idle, so Escape, a backdrop click and the Close
   * button could all discard a dialog that was in the middle of taking the
   * microphone.
   */
  const [acquiring, setAcquiring] = useState(false);
  /**
   * The fresh take, and the word it was recorded FOR.
   *
   * `forWord` is not bookkeeping. Clicking a word is also how you LISTEN to
   * one, so a user with a take in hand can move the selection just by
   * auditioning the neighbours — and without this, the next Replace would drop
   * their recording of one word on top of a different one. Found by driving
   * every combination of (take recorded, selection moved, alignment stale)
   * rather than the three that were obvious.
   */
  const [take, setTake] = useState<{ channels: Float32Array[]; sampleRate: number; forWord: number } | null>(
    null
  );
  const [splicing, setSplicing] = useState(false);

  // Read on every render rather than memoised. Both are cheap — a Map lookup
  // and an array-identity compare — and memoising them was WRONG: staleness
  // changes when the DOCUMENT changes, not when the alignment version does, so
  // a memo keyed on `alignVersion` reported a stale alignment as fresh after an
  // edit. `alignVersion` is still subscribed above, because a change with no
  // store update (a finished run) must also re-render.
  void alignVersion;
  const alignment: LyricsAlignment | null = doc ? getLyricsAlignment(doc.id) : null;
  const stale = doc ? isLyricsAlignmentStale(doc.id) : false;

  const busy = downloading || running || acquiring || recording || splicing;

  // The unmount mirror (SeparateDialog.tsx:94's unmountedRef): a ref, because
  // the cleanup must read the CURRENT value, not the one captured when the
  // effect was installed.
  const unmountedRef = useRef(false);
  const runningRef = useRef(false);
  const engineRef = useRef<RecordingEngine | null>(injectedEngine ?? null);
  /** The in-flight `engine.start()`, or null. See {@link acquiring}. */
  const startRef = useRef<Promise<void> | null>(null);

  useEffect(() => {
    unmountedRef.current = false;
    return () => {
      unmountedRef.current = true;
      if (runningRef.current) {
        runningRef.current = false;
        void cancelAlignment();
      }
      const engine = engineRef.current;
      engineRef.current = null;
      const acquisition = startRef.current;
      startRef.current = null;
      // A recorder left running holds the microphone (and its AudioContext)
      // open for the rest of the session. `stop()` rejects when it is not
      // recording, which is the ordinary case on close.
      if (acquisition) {
        // …but a start() that has not resolved owns NOTHING yet, and
        // `isRecording` is already true because the slot is claimed
        // synchronously. Stopping now would release nothing and clear the flag,
        // and the resolving start() would then hand a live MediaStream to an
        // engine this ref no longer points at — an orphaned capture for the
        // rest of the session. Wait for the acquisition to land, then stop.
        void acquisition.then(() => engine?.stop()).catch(() => {});
      } else if (engine?.isRecording) {
        void engine.stop().catch(() => {});
      }
    };
  }, []);

  useEffect(() => {
    void (async () => {
      const state = await getAlignModelState();
      if (!unmountedRef.current) setModel(state);
    })();
  }, []);

  // A stored alignment restores the text it was made from, so re-opening the
  // dialog does not present an empty box next to the words it produced.
  useEffect(() => {
    if (alignment && text.length === 0) setText(alignment.text);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-way restore, not a sync
  }, [alignment]);

  function liveDoc() {
    const state = useAppStore.getState();
    return state.documents.find((d) => d.id === state.activeDocumentId) ?? null;
  }

  async function handleDownload(): Promise<void> {
    setDownloading(true);
    setError(null);
    setReceived(0);
    let result: Awaited<ReturnType<typeof ensureAlignModels>>;
    try {
      result = await ensureAlignModels((p) => {
        if (!unmountedRef.current) setReceived(p.received);
      });
    } finally {
      if (!unmountedRef.current) setDownloading(false);
    }
    if (unmountedRef.current) return;
    if (!result.ok) {
      setError(result.error);
      return;
    }
    const state = await getAlignModelState();
    if (!unmountedRef.current) setModel(state);
  }

  async function handleLoadFile(): Promise<void> {
    setError(null);
    const result = await loadLyricsFile();
    if (unmountedRef.current || result === null) return; // cancelled
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setText(result.text);
  }

  async function handleAlign(): Promise<void> {
    const live = liveDoc();
    if (!live) {
      setError('No document is open.');
      return;
    }
    setRunning(true);
    runningRef.current = true;
    setProgress(null);
    setError(null);
    setNote(null);
    setSelectedWord(null);
    setTake(null);
    let result: Awaited<ReturnType<typeof alignDocumentLyrics>>;
    try {
      result = await alignDocumentLyrics({
        docId: live.id,
        text,
        onProgress: (p) => {
          if (!unmountedRef.current) setProgress(p);
        },
      });
    } finally {
      runningRef.current = false;
      if (!unmountedRef.current) setRunning(false);
    }
    if (unmountedRef.current) return;
    if (!result.ok) {
      setError(result.message);
      // A refusal for the missing model is not an error to stare at — it is
      // the download state, so put the button back in front of the user.
      if (result.status === 'model-missing') {
        setModel({ downloaded: false, bytes: null, expectedBytes: model?.expectedBytes ?? 0 });
      }
    }
  }

  async function handleRecord(): Promise<void> {
    const target = liveDoc();
    if (!target) return;
    setError(null);
    if (!engineRef.current) engineRef.current = new RecordingEngine();
    const engine = engineRef.current;
    setAcquiring(true);
    try {
      // The document's own rate is REQUESTED, not assumed: the browser may hand
      // back a different one, and `stop()` reports what it actually got — which
      // is what the service resamples from.
      //
      // The promise is PUBLISHED on a ref before it is awaited, because the
      // unmount cleanup cannot deal with this engine correctly without it:
      // `start()` claims the recording slot synchronously but only acquires the
      // microphone when `getUserMedia` resolves, so a `stop()` fired inside that
      // window releases NOTHING and then the resolving `start()` hands a live
      // stream to an engine no one holds a reference to any more.
      startRef.current = engine.start({ channels: 1, sampleRate: target.sampleRate });
      await startRef.current;
    } catch (err) {
      if (!unmountedRef.current) {
        setAcquiring(false);
        setError(err instanceof Error ? err.message : String(err));
      }
      return;
    } finally {
      startRef.current = null;
    }
    if (!unmountedRef.current) {
      setAcquiring(false);
      setRecording(true);
    }
  }

  async function handleStopRecording(): Promise<void> {
    const engine = engineRef.current;
    if (!engine) return;
    let result: { channels: Float32Array[]; sampleRate: number };
    try {
      result = await engine.stop();
    } catch (err) {
      if (!unmountedRef.current) {
        setRecording(false);
        setError(err instanceof Error ? err.message : String(err));
      }
      return;
    }
    if (unmountedRef.current) return;
    setRecording(false);
    if (selectedWord === null) return; // the button is gated on one; belt and braces
    setTake({ ...result, forWord: selectedWord });
  }

  async function handleReplace(): Promise<void> {
    const live = liveDoc();
    if (!live || selectedWord === null || !take) return;
    setSplicing(true);
    setError(null);
    setNote(null);
    let result: Awaited<ReturnType<typeof replaceWord>>;
    try {
      result = await replaceWord({
        docId: live.id,
        wordIndex: selectedWord,
        replacement: take.channels,
        replacementSampleRate: take.sampleRate,
      });
    } finally {
      if (!unmountedRef.current) setSplicing(false);
    }
    if (unmountedRef.current) return;
    if (!result.ok) {
      setError(result.message);
      return;
    }
    const r = result.report;
    setTake(null); // consumed — one take splices once, not once per click

    setNote(
      `Replaced “${result.word.text}”. Level ${r.gainDb >= 0 ? '+' : ''}${r.gainDb.toFixed(1)} dB, ` +
        `pitch ${r.pitchShiftSemitones >= 0 ? '+' : ''}${r.pitchShiftSemitones.toFixed(2)} semitones, ` +
        `fitted by ${r.stretchRatio.toFixed(3)}×, seams ${formatMs(r.headSeamSamples, live.sampleRate)} / ` +
        `${formatMs(r.tailSeamSamples, live.sampleRate)}. Undo is one step.`
    );
  }

  const expectedBytes = model?.expectedBytes ?? 0;
  const modelMissing = model !== null && !model.downloaded;
  const hasText = text.trim().length > 0;
  const canAlign = !busy && doc !== null && length > 0 && hasText && model?.downloaded === true;
  const takeMatchesSelection = take !== null && selectedWord !== null && take.forWord === selectedWord;
  const canReplace = !busy && takeMatchesSelection && alignment !== null && !stale;
  const message = error ?? (doc === null ? 'No document is open.' : null);
  const regionSamples = selection && selection.end > selection.start ? selection.end - selection.start : length;
  const estimateSeconds = doc ? regionSamples / doc.sampleRate / MEASURED_ALIGN_REALTIME_FACTOR : 0;
  const remaining = progress?.estimatedRemainingMs ?? null;
  const word: PlacedWord | null =
    alignment && selectedWord !== null ? (alignment.words[selectedWord] ?? null) : null;

  // Words laid out on the lines they were written on.
  const lines = useMemo(() => {
    if (!alignment) return [];
    const out: PlacedWord[][] = [];
    for (const w of alignment.words) {
      while (out.length <= w.line) out.push([]);
      out[w.line].push(w);
    }
    return out.filter((l) => l.length > 0);
  }, [alignment]);

  return (
    <DialogShell
      title="Align Lyrics"
      subtitle={doc ? `${doc.name} · ${formatMmss(length, doc.sampleRate)}` : undefined}
      icon={<Text size={15} />}
      width={560}
      onClose={onClose}
      dismissable={!busy}
    >
      <div className="flex flex-col gap-3" data-testid="align-lyrics-dialog">
        <SectionLabel>What you get</SectionLabel>

        <p data-testid="align-lyrics-produces" className="text-xs" style={{ color: 'var(--glass-text-label)' }}>
          Paste the words you already know are in this recording and every one of them gets a position.
          Click a word to hear exactly that word; pick one and record a fresh take of just that word to
          replace it, seams and level and pitch matched to what was there. It places words — it never
          judges how they were sung, and nothing here marks any word as wrong.
        </p>

        <p data-testid="align-lyrics-accuracy" className="text-xs" style={{ color: 'var(--glass-text-secondary)' }}>
          {ALIGN_ACCURACY_SENTENCE}
        </p>

        <SectionLabel>Lyrics</SectionLabel>

        <textarea
          data-testid="align-lyrics-text"
          aria-label="Lyrics"
          value={text}
          disabled={busy}
          rows={5}
          onChange={(e) => setText(e.target.value)}
          placeholder={'One line per line of the song.\nPunctuation and capitals are fine.'}
          className="w-full resize-y rounded-lg p-2 font-mono text-xs outline-none"
          style={{
            background: 'rgba(255, 255, 255, 0.04)',
            border: '1px solid var(--glass-border)',
            color: 'var(--glass-text-title)',
          }}
        />

        <div className="flex items-center gap-2">
          <GlassButton data-testid="align-lyrics-load" disabled={busy} onClick={() => void handleLoadFile()}>
            <Upload size={13} />
            Load from file…
          </GlassButton>
          <span data-testid="align-lyrics-scope" className="text-xs" style={{ color: 'var(--glass-text-muted)' }}>
            {selection && selection.end > selection.start
              ? `Selection — ${formatMmss(regionSamples, doc?.sampleRate ?? 1)}`
              : 'Whole file'}
          </span>
        </div>

        {modelMissing && (
          <div data-testid="align-lyrics-model-missing" className="flex flex-col gap-2">
            <SectionLabel>Model</SectionLabel>
            <p className="text-xs" style={{ color: 'var(--glass-text-label)' }}>
              {`Placing words needs the wav2vec2 acoustic model — a ${formatMb(
                expectedBytes
              )} one-time download, kept with the app's settings and reused every time.`}
            </p>
            {downloading ? (
              <div>
                <p
                  data-testid="align-lyrics-download-status"
                  className="mb-1 text-xs"
                  style={{ color: 'var(--glass-text-muted)' }}
                >
                  {`Downloading… ${formatMb(received)} of ${formatMb(expectedBytes)}`}
                </p>
                <ProgressTrack
                  testId="align-lyrics-download-progress"
                  fraction={expectedBytes > 0 ? received / expectedBytes : 0}
                />
              </div>
            ) : (
              <div>
                <GlassButton variant="primary" onClick={() => void handleDownload()}>
                  Download Model
                </GlassButton>
              </div>
            )}
          </div>
        )}

        {!modelMissing && !running && (
          <p data-testid="align-lyrics-estimate" className="text-xs" style={{ color: 'var(--glass-text-muted)' }}>
            {`Runs on the CPU at about ${MEASURED_ALIGN_REALTIME_FACTOR.toFixed(
              1
            )}x realtime — roughly ${formatSeconds(estimateSeconds)} for this ${
              selection && selection.end > selection.start ? 'selection' : 'file'
            }.`}
          </p>
        )}

        {running && (
          <div>
            <p
              data-testid="align-lyrics-progress-label"
              className="mb-1 text-xs"
              style={{ color: 'var(--glass-text-muted)' }}
            >
              {runLabel(progress, remaining)}
            </p>
            <ProgressTrack testId="align-lyrics-progress" fraction={progress?.fraction ?? 0} />
          </div>
        )}

        {alignment && (
          <>
            <SectionLabel>Words</SectionLabel>

            {alignment.verdict === 'weak' && (
              <p data-testid="align-lyrics-weak" className="text-xs text-[#e0a458]">
                These lyrics don’t appear to match this audio. The words below were still placed — forced
                alignment always returns a position for every word, even the wrong ones — so check a few
                before trusting any of them.
              </p>
            )}

            {stale && (
              <p data-testid="align-lyrics-stale" className="text-xs text-[#e0a458]">
                The audio has changed since these words were placed, so the positions no longer line up.
                Align again before replacing a word.
              </p>
            )}

            {alignment.chunked && (
              <p data-testid="align-lyrics-chunked" className="text-xs" style={{ color: 'var(--glass-text-muted)' }}>
                {`Longer than ${ALIGN_ACCURACY.chunkSeconds} s, so it was placed in several passes: about one word start in six sits up to ${ALIGN_ACCURACY.chunkedOnsetMaxMs} ms from where a single pass would have put it.`}
              </p>
            )}

            {alignment.droppedWords.length > 0 && (
              <p data-testid="align-lyrics-dropped-words" className="text-xs" style={{ color: 'var(--glass-text-muted)' }}>
                {`Not placed, because this model's alphabet has no letters for them: ${alignment.droppedWords.join(', ')}.`}
              </p>
            )}
            {alignment.droppedCharacters.length > 0 && (
              <p data-testid="align-lyrics-dropped-chars" className="text-xs" style={{ color: 'var(--glass-text-muted)' }}>
                {`Characters dropped from the words they were in: ${alignment.droppedCharacters.join(' ')}.`}
              </p>
            )}

            <div data-testid="align-lyrics-words" className="flex flex-col gap-1">
              {lines.map((lineWords, i) => (
                <div key={i} className="flex flex-wrap gap-1">
                  {lineWords.map((w) => (
                    <button
                      key={w.index}
                      type="button"
                      data-testid={`align-lyrics-word-${w.index}`}
                      aria-pressed={selectedWord === w.index}
                      disabled={busy}
                      onClick={() => {
                        setSelectedWord(w.index);
                        setNote(null);
                        previewWord(alignment.docId, w.index);
                      }}
                      className="rounded px-1.5 py-0.5 text-xs"
                      style={{
                        // Selection is the ONLY thing that changes a word's
                        // appearance. No score, no rank, no colour scale.
                        background: selectedWord === w.index ? 'var(--accent-soft)' : 'transparent',
                        border: `1px solid ${selectedWord === w.index ? 'var(--accent-ring)' : 'transparent'}`,
                        color: selectedWord === w.index ? 'var(--accent)' : 'var(--glass-text-title)',
                        cursor: busy ? 'default' : 'pointer',
                      }}
                    >
                      {w.text}
                    </button>
                  ))}
                </div>
              ))}
            </div>

            <SectionLabel>Replace a word</SectionLabel>

            <p data-testid="align-lyrics-selected" className="text-xs" style={{ color: 'var(--glass-text-label)' }}>
              {word
                ? `“${word.text}” — ${formatMmss(word.startSample, alignment.sampleRate)}, ${formatMs(
                    word.endSample - word.startSample,
                    alignment.sampleRate
                  )} long.`
                : 'Click a word above to hear it. Pick the one you want to sing again.'}
            </p>

            <div className="flex items-center gap-2">
              <GlassButton
                data-testid="align-lyrics-preview"
                disabled={busy || word === null}
                onClick={() => {
                  if (selectedWord !== null) previewWord(alignment.docId, selectedWord);
                }}
              >
                <Play size={13} />
                Hear it
              </GlassButton>
              {recording ? (
                <GlassButton data-testid="align-lyrics-stop-record" onClick={() => void handleStopRecording()}>
                  <Square size={13} />
                  Stop
                </GlassButton>
              ) : (
                <GlassButton
                  data-testid="align-lyrics-record"
                  disabled={busy || word === null}
                  onClick={() => void handleRecord()}
                >
                  <Mic size={13} />
                  Record replacement
                </GlassButton>
              )}
              <GlassButton
                variant="primary"
                data-testid="align-lyrics-replace"
                disabled={!canReplace}
                onClick={() => void handleReplace()}
              >
                Replace word
              </GlassButton>
            </div>

            <p data-testid="align-lyrics-take" className="text-xs" style={{ color: 'var(--glass-text-muted)' }}>
              {recording
                ? 'Recording — sing just the one word, then Stop.'
                : take && !takeMatchesSelection
                  ? `That take was recorded for “${alignment.words[take.forWord]?.text ?? '?'}”. Select that word again to use it, or record a new one${word ? ` for “${word.text}”` : ''}.`
                  : take && word
                    ? `Take ready for “${word.text}”: ${formatMs(take.channels[0]?.length ?? 0, take.sampleRate)}. Silence around the word is trimmed off, the level and the median pitch are matched to what it replaces, and the crossfades sit OUTSIDE the word so none of the old one survives.`
                    : 'Replacements are recorded here, in your own voice, from your own microphone — there is no file to import.'}
            </p>
          </>
        )}

        {note && (
          <p data-testid="align-lyrics-note" className="text-xs" style={{ color: 'var(--glass-text-label)' }}>
            {note}
          </p>
        )}

        {message && (
          <p data-testid="align-lyrics-error" className="text-xs text-[#e0a458]">
            {message}
          </p>
        )}

        <div className="mt-2 flex justify-end gap-2">
          {running ? (
            <GlassButton onClick={() => void cancelAlignment()}>Cancel</GlassButton>
          ) : (
            <>
              <GlassButton onClick={onClose} disabled={busy}>
                Close
              </GlassButton>
              {!modelMissing && (
                <GlassButton
                  variant="primary"
                  data-testid="align-lyrics-run"
                  onClick={() => void handleAlign()}
                  disabled={!canAlign}
                >
                  {alignment ? 'Align again' : 'Align'}
                </GlassButton>
              )}
            </>
          )}
        </div>
      </div>
    </DialogShell>
  );
}

/** SeparateDialog's inset progress track. */
function ProgressTrack({ testId, fraction }: { testId: string; fraction: number }) {
  const percent = Math.round(Math.max(0, Math.min(1, fraction)) * 100);
  return (
    <div
      className="h-1.5 w-full overflow-hidden rounded-full"
      style={{ background: 'rgba(255, 255, 255, 0.09)', boxShadow: 'inset 0 1px 2px rgba(0, 0, 0, 0.6)' }}
    >
      <div
        data-testid={testId}
        className="h-full transition-[width]"
        style={{ width: `${percent}%`, background: 'var(--accent)', boxShadow: '0 0 8px var(--accent-ring)' }}
      />
    </div>
  );
}

/** Which phase, how far through it, and how long is left. */
export function runLabel(progress: AlignProgress | null, remainingMs: number | null): string {
  const eta = remainingMs === null ? null : `${formatSeconds(remainingMs / 1000)} left`;
  if (!progress || progress.phase === 'resampling') {
    return eta ? `Preparing the audio… ${eta}` : 'Preparing the audio…';
  }
  if (progress.phase === 'placing') return 'Placing the words…';
  const percent = progress.total > 0 ? ` — ${Math.round(progress.fraction * 100)}%` : '';
  const head = `Listening${percent}`;
  return eta ? `${head} · ${eta}` : head;
}
