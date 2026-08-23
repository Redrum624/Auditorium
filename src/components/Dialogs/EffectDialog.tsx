import { useEffect, useMemo, useRef, useState } from 'react';
import { cloneRegion, createDocument, docLength } from '../../audio/AudioDocument';
import { playbackEngine, type PlaybackEngine } from '../../audio/PlaybackEngine';
import { getEffect } from '../../effects/EffectRegistry';
import type { EffectParamDef, EffectParamValue } from '../../effects/types';
import { runEffectOnSelection } from '../../services/effectRunner';
import { getNoiseProfile, useNoiseProfileVersion } from '../../services/noiseProfile';
import { resolveRegion } from '../../services/selectionRegion';
import { useAppStore } from '../../stores/appStore';
import { formatTime } from '../../utils/timeFormat';
import { Sparkles } from 'lucide-react';
import { FieldLabel, GlassButton, GlassField, GlassSelect, GlassSlider, SectionLabel } from '../UI/glass';
import DialogShell from './DialogShell';

/** Build the initial param map from each param's declared default. */
function initialParams(params: EffectParamDef[]): Record<string, EffectParamValue> {
  return Object.fromEntries(params.map((p) => [p.id, p.default]));
}

function activeDoc() {
  const s = useAppStore.getState();
  return s.documents.find((d) => d.id === s.activeDocumentId) ?? null;
}

/** Item 6, fix round 2: shown in the card after an Apply the runner cancelled
 * because the document moved under the worker (see `apply`). The runner is
 * silent by design; the card is where the user is looking. Worded like
 * TempoDialog's own `'cancelled'` arm ("Nothing was changed."). */
const STALE_TARGET_HINT =
  'The document changed while the effect was running, so nothing was applied. Apply again to run it on the document as it is now.';

/**
 * Parameter dialog for a single effect. Renders one control per param (number ->
 * slider + numeric input, select -> dropdown, boolean -> checkbox), an Apply
 * button that runs the effect through the DSP worker (with a progress bar), and a
 * best-effort Preview that auditions the effect on a throwaway document.
 * Apply commits only to the document as the user left it when they clicked
 * (fix round 2): one that moved under the worker is never written. A Preview
 * is given up the moment the document moves under it (final round): the
 * transport owns the engine again, and the card must stop saying otherwise.
 */
export default function EffectDialog({
  effectId,
  onClose,
  engine = playbackEngine,
}: {
  effectId: string;
  onClose: () => void;
  /** Injectable for tests (like RecordDialog's `engine` prop); defaults to the
   * app's shared singleton, which is exactly what makes F11 a real hazard —
   * Preview auditions through the SAME engine the transport/waveform use. */
  engine?: PlaybackEngine;
}) {
  const def = getEffect(effectId);
  const activeDocumentId = useAppStore((s) => s.activeDocumentId);
  const activeDocName = useAppStore(
    (s) => s.documents.find((d) => d.id === s.activeDocumentId)?.name
  );
  // R2-2: param readouts derive from the region the effect will target, so the
  // dialog must react to the selection moving while it is open (without this
  // subscription a computed readout would go stale on re-select) and must
  // reproduce runEffectOnSelection's whole-document fallback (trap T11).
  const selection = useAppStore((s) => s.selection);
  const activeDocLength = useAppStore((s) => {
    const d = s.documents.find((dd) => dd.id === s.activeDocumentId);
    return d ? docLength(d) : null;
  });
  const activeSampleRate = useAppStore(
    (s) => s.documents.find((d) => d.id === s.activeDocumentId)?.sampleRate ?? null
  );
  // Final round (finding 2): the third leg of the transport's own engine-load
  // key (`Toolbar.tsx`, `[doc?.id, doc?.channels, doc?.sampleRate]`) — the
  // `channels` REFERENCE, which changes on an audio edit and on nothing else.
  // Subscribed so the preview-ownership effect below sees exactly the events
  // that hand the shared engine to somebody else.
  const activeDocChannels = useAppStore(
    (s) => s.documents.find((d) => d.id === s.activeDocumentId)?.channels ?? null
  );
  // Final round 3 (finding 1): the document itself, so the scope line below can
  // ask `resolveRegion` — the function `runEffectOnSelection` itself calls —
  // what Apply will write, rather than keeping a second copy of that arithmetic
  // here (the defect family T6-1 collapsed into one import). Same lookup as the
  // four selectors above; zustand hands back the same object reference until
  // the document changes, so this adds a read, not a render.
  const activeDocument = useAppStore(
    (s) => s.documents.find((d) => d.id === s.activeDocumentId) ?? null
  );
  const [params, setParams] = useState<Record<string, EffectParamValue>>(() =>
    def ? initialParams(def.params) : {}
  );
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [previewing, setPreviewing] = useState(false);
  // Fix round 2: the last Apply was cancelled because the document moved
  // under the worker; the card stays and says so until the next Apply.
  const [staleTarget, setStaleTarget] = useState(false);
  // Mirrors `previewing` for the unmount-cleanup effect below, which must read
  // the CURRENT value at cleanup time, not the value captured when the effect
  // was installed (mount, when previewing was still false).
  const previewingRef = useRef(false);
  // The id of the throwaway document Preview loaded. `previewing` claims
  // OWNERSHIP of the shared engine, and this is how that claim is checked:
  // the engine still holds our preview only while it reports this id.
  const previewDocIdRef = useRef<string | null>(null);

  // F11: Escape/backdrop/Cancel all unmount this dialog without going through
  // the explicit "Stop Preview" button (hosted, Escape reaches `onClose`
  // through `EffectHost`'s own listener — N18 — and lands here the same way).
  // If a preview was left running, restore
  // the engine to the real active document on unmount — exactly stopPreview's
  // logic — instead of leaving it holding the throwaway preview document
  // (silently playing, in Escape's case). Declared before the `if (!def)
  // return null;` below since hooks can't be called conditionally; `engine` is
  // a stable prop (module singleton by default) so this runs once in practice,
  // but depending on it directly (no ref indirection) keeps the effect honest
  // if it ever weren't.
  useEffect(() => {
    return () => {
      if (!previewingRef.current) return;
      engine.stop();
      const doc = activeDoc();
      if (doc) engine.load(doc);
    };
  }, [engine]);

  // Final round (finding 2): hosted, the card is not modal, so while a preview
  // plays the user can still switch document with the Files panel, ripple the
  // audio with the edit pill, or close the file. Any of those hands the SHARED
  // engine to the new document — the transport's own load effect
  // (`Toolbar.tsx`, keyed on `[doc?.id, doc?.channels, doc?.sampleRate]`)
  // answers them by calling `playbackEngine.load(doc)`, which stops and
  // replaces the preview. Nothing told the card, so `previewing` stayed true:
  // the button went on reading 'Stop Preview' with no preview running, and
  // pressing it — or Apply, which stops a preview first — fired an
  // `engine.stop()` that killed the playback the user had just started on the
  // document they moved to. Under the modal none of those clicks was
  // reachable; the card's lock holds the strip and the keys, never the mouse.
  //
  // Keyed exactly like the transport's load so the two see the same events.
  // The engine is only touched when it still holds OUR preview document —
  // unwrapped (modal, or a test with no transport above) nobody else answers,
  // so the card restores the real document itself, exactly as `stopPreview`
  // does; hosted, the transport got there first and a second stop would be
  // the very playback kill this fixes.
  useEffect(() => {
    if (!previewingRef.current) return;
    if (engine.loadedDocumentId === previewDocIdRef.current) {
      engine.stop();
      const doc = activeDoc();
      if (doc) engine.load(doc);
    }
    previewDocIdRef.current = null;
    previewingRef.current = false;
    setPreviewing(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the key IS the
    // subject: the transport's own load key, not this effect's closure.
  }, [activeDocumentId, activeDocChannels, activeSampleRate]);

  // Noise Reduction needs a captured noise print, delivered to the worker via the
  // `extra` side channel; without one, Apply is disabled and a hint is shown.
  // Subscribing to the profile version (Task F8) makes the gate REACTIVE: a
  // capture or clear while the dialog is open re-renders it immediately.
  useNoiseProfileVersion();
  const isNoiseReduction = def?.id === 'noise-reduction';
  const hasNoiseProfile = getNoiseProfile() !== null;
  const missingNoiseProfile = isNoiseReduction && !hasNoiseProfile;

  const canApply = useMemo(
    () => Boolean(def) && activeDocumentId !== null && !busy && !missingNoiseProfile,
    [def, activeDocumentId, busy, missingNoiseProfile]
  );

  if (!def) return null;

  const setParam = (id: string, value: EffectParamValue) =>
    setParams((prev) => ({ ...prev, [id]: value }));

  // Final round 3 (finding 1): what Apply will write, named on the card.
  //
  // Hosted, the card is not modal, so the region the runner resolves can change
  // while the card sits open and untouched: Edit > Deselect and a plain click
  // on the waveform clear the selection with the card still there (Escape no
  // longer does — under N18 it closes the card, claimed by `EffectHost` before
  // the global table can run `edit.deselect`). Because `runEffectOnSelection`
  // resolves the LIVE selection and `resolveRegion` reads null as the whole
  // document, an Apply after either of those widens from the span the user
  // auditioned with Preview to the entire file — one undo entry, and nothing
  // in the card had moved to say so.
  //
  // The lock is not the answer (the ruling: shortcuts stay live beside a card,
  // and Preview greys nothing). Visibility is: the sibling hosted card has
  // named its own scope since the Pipeline module (`TempoDialog`'s
  // `tempo-scope`), and this is that line for effects. Display only — it
  // reads the store the param readouts already subscribe to, and asks the
  // runner's own resolver so what it says cannot drift from what is written.
  const scope = activeDocument ? resolveRegion(activeDocument, selection) : null;
  const scopeText =
    scope === null || activeSampleRate === null
      ? null
      : selection
        ? `Selection — ${formatTime(scope.start, activeSampleRate)} → ${formatTime(scope.end, activeSampleRate)} (${((scope.end - scope.start) / activeSampleRate).toFixed(2)} s)`
        : `Whole file — ${formatTime(scope.end, activeSampleRate)}`;

  const apply = async () => {
    if (!canApply) return;
    // F11: never leave the engine holding the throwaway preview document
    // while the (possibly slow, worker-based) real edit runs.
    if (previewing) stopPreview();
    setBusy(true);
    setProgress(0);
    setStaleTarget(false);
    // Item 6, fix round 2: the card is not modal, so the mouse stays live
    // while the worker runs — the edit pill, the Edit menu, File › Close and
    // the Files panel can all change the document the runner resolved its
    // region against before the audio comes back. The runner asks this ONCE,
    // between the audio arriving and `applyEdit` writing it (T6-3's seam),
    // and a `true` commits nothing. The target is the document as the user
    // left it when they clicked Apply: same id; same audio — the `channels`
    // reference changes only on an audio edit, a rename or a dirty flag
    // keeps it (the key Toolbar's engine load uses); and still the active
    // one, because `applyEdit` sets the selection and the cursor GLOBALLY and
    // would move the caret in whatever document the user moved on to. The
    // modal's backdrop used to make all of this impossible; the card's lock
    // holds the strip and the keys, never the mouse.
    const target = activeDoc();
    const targetId = target?.id ?? null;
    const targetChannels = target?.channels ?? null;
    const shouldCancel = () => {
      const s = useAppStore.getState();
      const d = s.documents.find((x) => x.id === targetId);
      return !d || d.channels !== targetChannels || s.activeDocumentId !== targetId;
    };
    try {
      const extra = isNoiseReduction
        ? { spectra: (getNoiseProfile()?.spectra ?? []).map((s) => Array.from(s)) }
        : undefined;
      const outcome = await runEffectOnSelection(def.id, params, {
        onProgress: setProgress,
        extra,
        shouldCancel,
      });
      if (outcome === 'cancelled') {
        // Nothing was written; the card stays for a second Apply against the
        // document as it now stands. `'refused'` has shown its own dialog and
        // `'committed'` is done: both close the card as they always did.
        setStaleTarget(true);
        return;
      }
      onClose();
    } finally {
      setBusy(false);
    }
  };

  const startPreview = () => {
    const doc = activeDoc();
    if (!doc) return;
    const { selection } = useAppStore.getState();
    const start = selection ? selection.start : 0;
    const end = selection ? selection.end : docLength(doc);
    const region = cloneRegion(doc, start, end);
    const result = def.process(region, doc.sampleRate, params);
    const temp = createDocument({
      name: `${def.name} (preview)`,
      sampleRate: doc.sampleRate,
      channels: result.channels,
    });
    engine.load(temp);
    engine.play(0);
    previewingRef.current = true;
    previewDocIdRef.current = temp.id;
    setPreviewing(true);
  };

  const stopPreview = () => {
    engine.stop();
    const doc = activeDoc();
    if (doc) engine.load(doc);
    previewingRef.current = false;
    previewDocIdRef.current = null;
    setPreviewing(false);
  };

  return (
    // Item 6 / N16: hosted in the module column (see `EffectHost`), the
    // module LOCK is published during Apply only — `runEffectOnSelection`
    // commits to the live document after its await, and a strip switch or a
    // ✕ mid-apply would release the lock while it still does. Preview locks
    // nothing: it is one click to end. `width` is ignored while hosted; the
    // unwrapped (modal) presentation keeps it.
    <DialogShell
      title={def.name}
      subtitle={activeDocName}
      icon={<Sparkles size={15} />}
      width={460}
      onClose={onClose}
      dismissable={!busy}
      moduleLock={busy}
    >
      <div className="flex flex-col gap-3" data-testid="effect-dialog">
        {scopeText !== null && (
          <div
            data-testid="effect-scope"
            className="text-xs"
            style={{ color: 'var(--glass-text-muted)' }}
          >
            {scopeText}
          </div>
        )}

        {def.params.length > 0 && <SectionLabel>Parameters</SectionLabel>}

        {def.params.map((p) => (
          <ParamControl
            key={p.id}
            param={p}
            value={params[p.id]}
            onChange={setParam}
            // Display-only derived readout (R2-2). Region length reproduces the
            // runner's fallback: the selection, else the whole document.
            readout={
              p.readout && activeDocLength !== null && activeSampleRate !== null
                ? p.readout(params[p.id], {
                    regionSamples: selection ? selection.end - selection.start : activeDocLength,
                    sampleRate: activeSampleRate,
                  })
                : null
            }
          />
        ))}

        {def.params.length === 0 && (
          <p className="text-xs" style={{ color: 'var(--glass-text-muted)' }}>
            This effect has no parameters.
          </p>
        )}

        {missingNoiseProfile && (
          <p data-testid="noise-profile-hint" className="text-xs text-[#e0a458]">
            Capture a noise print first: select a quiet, noise-only region and choose
            Effects → Capture Noise Print.
          </p>
        )}

        {busy && (
          <div
            className="h-1.5 w-full overflow-hidden rounded-full"
            style={{
              background: 'rgba(255, 255, 255, 0.09)',
              boxShadow: 'inset 0 1px 2px rgba(0, 0, 0, 0.6)',
            }}
          >
            <div
              data-testid="effect-progress"
              className="h-full transition-[width]"
              style={{
                width: `${Math.round(progress * 100)}%`,
                background: 'var(--accent)',
                boxShadow: '0 0 8px var(--accent-ring)',
              }}
            />
          </div>
        )}

        {staleTarget && (
          <p data-testid="effect-stale-hint" className="text-xs text-[#e0a458]">
            {STALE_TARGET_HINT}
          </p>
        )}

        <div className="mt-2 flex items-center justify-between gap-2">
          <GlassButton
            onClick={previewing ? stopPreview : startPreview}
            disabled={!def || activeDocumentId === null}
          >
            {previewing ? 'Stop Preview' : 'Preview'}
          </GlassButton>
          <div className="flex gap-2">
            {/* Item 6: a Cancel that unmounted mid-apply would release the
                module lock while the runner still commits to the live document
                (the F10 hazard) — it refuses exactly as the ✕ does. */}
            <GlassButton onClick={onClose} disabled={busy}>
              Cancel
            </GlassButton>
            <GlassButton variant="primary" onClick={apply} disabled={!canApply}>
              Apply
            </GlassButton>
          </div>
        </div>
      </div>
    </DialogShell>
  );
}

function ParamControl({
  param,
  value,
  onChange,
  readout = null,
}: {
  param: EffectParamDef;
  value: EffectParamValue;
  onChange: (id: string, value: EffectParamValue) => void;
  /** Pre-computed display-only readout string (R2-2); null renders nothing —
   * a param without the capability produces byte-identical DOM to v1.9.1. */
  readout?: string | null;
}) {
  const controlId = `effect-param-${param.id}`;

  if (param.type === 'boolean') {
    return (
      <label
        className="flex items-center gap-2 text-sm"
        style={{ color: 'var(--glass-text-label)' }}
        htmlFor={controlId}
      >
        <input
          id={controlId}
          type="checkbox"
          checked={Boolean(value)}
          onChange={(e) => onChange(param.id, e.target.checked)}
          className="accent-[#26c6da]"
        />
        {param.label}
      </label>
    );
  }

  if (param.type === 'select') {
    return (
      <div>
        <FieldLabel htmlFor={controlId}>{param.label}</FieldLabel>
        <GlassSelect
          id={controlId}
          value={String(value)}
          onChange={(e) => onChange(param.id, e.target.value)}
        >
          {(param.options ?? []).map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </GlassSelect>
      </div>
    );
  }

  // number: synced slider + numeric input
  const num = Number(value);
  const min = param.min ?? 0;
  const max = param.max ?? 100;
  const step = param.step ?? 1;
  // `edited` mirrors Vitrine SliderRow: an accent glow marks a value moved off
  // its declared default.
  return (
    <div>
      <FieldLabel htmlFor={controlId}>
        {param.label}
        {param.unit ? ` (${param.unit})` : ''}
      </FieldLabel>
      <div className="flex items-center gap-2">
        <GlassSlider
          className="flex-1"
          min={min}
          max={max}
          step={step}
          value={num}
          edited={num !== Number(param.default)}
          onChange={(e) => onChange(param.id, Number(e.target.value))}
        />
        <GlassField
          id={controlId}
          type="number"
          min={min}
          max={max}
          step={step}
          value={num}
          onChange={(e) => onChange(param.id, Number(e.target.value))}
          className="w-20"
          style={{ width: 80 }}
        />
        {readout !== null && (
          <span
            data-testid={`effect-param-readout-${param.id}`}
            className="whitespace-nowrap text-xs tabular-nums"
            style={{ color: 'var(--glass-text-muted)' }}
          >
            {readout}
          </span>
        )}
      </div>
    </div>
  );
}
