import { useEffect, useMemo, useRef, useState } from 'react';
import { cloneRegion, createDocument, docLength } from '../../audio/AudioDocument';
import { playbackEngine, type PlaybackEngine } from '../../audio/PlaybackEngine';
import { getEffect } from '../../effects/EffectRegistry';
import type { EffectParamDef, EffectParamValue } from '../../effects/types';
import { runEffectOnSelection } from '../../services/effectRunner';
import { getNoiseProfile, useNoiseProfileVersion } from '../../services/noiseProfile';
import { useAppStore } from '../../stores/appStore';
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

/**
 * Parameter dialog for a single effect. Renders one control per param (number ->
 * slider + numeric input, select -> dropdown, boolean -> checkbox), an Apply
 * button that runs the effect through the DSP worker (with a progress bar), and a
 * best-effort Preview that auditions the effect on a throwaway document.
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
  const [params, setParams] = useState<Record<string, EffectParamValue>>(() =>
    def ? initialParams(def.params) : {}
  );
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [previewing, setPreviewing] = useState(false);
  // Mirrors `previewing` for the unmount-cleanup effect below, which must read
  // the CURRENT value at cleanup time, not the value captured when the effect
  // was installed (mount, when previewing was still false).
  const previewingRef = useRef(false);

  // F11: Escape/backdrop/Cancel all unmount this dialog without going through
  // the explicit "Stop Preview" button. If a preview was left running, restore
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

  const apply = async () => {
    if (!canApply) return;
    // F11: never leave the engine holding the throwaway preview document
    // while the (possibly slow, worker-based) real edit runs.
    if (previewing) stopPreview();
    setBusy(true);
    setProgress(0);
    try {
      const extra = isNoiseReduction
        ? { spectra: (getNoiseProfile()?.spectra ?? []).map((s) => Array.from(s)) }
        : undefined;
      await runEffectOnSelection(def.id, params, { onProgress: setProgress, extra });
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
    setPreviewing(true);
  };

  const stopPreview = () => {
    engine.stop();
    const doc = activeDoc();
    if (doc) engine.load(doc);
    previewingRef.current = false;
    setPreviewing(false);
  };

  return (
    <DialogShell
      title={def.name}
      subtitle={activeDocName}
      icon={<Sparkles size={15} />}
      width={460}
      onClose={onClose}
    >
      <div className="flex flex-col gap-3" data-testid="effect-dialog">
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

        <div className="mt-2 flex items-center justify-between gap-2">
          <GlassButton
            onClick={previewing ? stopPreview : startPreview}
            disabled={!def || activeDocumentId === null}
          >
            {previewing ? 'Stop Preview' : 'Preview'}
          </GlassButton>
          <div className="flex gap-2">
            <GlassButton onClick={onClose}>Cancel</GlassButton>
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
