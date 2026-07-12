import { useMemo, useState } from 'react';
import { cloneRegion, createDocument, docLength } from '../../audio/AudioDocument';
import { playbackEngine } from '../../audio/PlaybackEngine';
import { getEffect } from '../../effects/EffectRegistry';
import type { EffectParamDef, EffectParamValue } from '../../effects/types';
import { runEffectOnSelection } from '../../services/effectRunner';
import { useAppStore } from '../../stores/appStore';
import DialogShell from './DialogShell';

const FIELD =
  'w-full rounded border border-[#3a3a42] bg-[#2e2e34] px-2 py-1 text-sm text-[#d4d4d8] focus:border-[#26c6da] focus:outline-none';
const LABEL = 'mb-1 block text-xs text-[#8b8b92]';

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
}: {
  effectId: string;
  onClose: () => void;
}) {
  const def = getEffect(effectId);
  const activeDocumentId = useAppStore((s) => s.activeDocumentId);
  const [params, setParams] = useState<Record<string, EffectParamValue>>(() =>
    def ? initialParams(def.params) : {}
  );
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [previewing, setPreviewing] = useState(false);

  const canApply = useMemo(() => Boolean(def) && activeDocumentId !== null && !busy, [
    def,
    activeDocumentId,
    busy,
  ]);

  if (!def) return null;

  const setParam = (id: string, value: EffectParamValue) =>
    setParams((prev) => ({ ...prev, [id]: value }));

  const apply = async () => {
    if (!canApply) return;
    setBusy(true);
    setProgress(0);
    try {
      await runEffectOnSelection(def.id, params, setProgress);
      onClose();
    } finally {
      setBusy(false);
    }
  };

  const startPreview = () => {
    // No Web Audio (jsdom) -> preview is a no-op.
    if (typeof AudioContext === 'undefined') return;
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
    playbackEngine.load(temp);
    playbackEngine.play(0);
    setPreviewing(true);
  };

  const stopPreview = () => {
    playbackEngine.stop();
    const doc = activeDoc();
    if (doc) playbackEngine.load(doc);
    setPreviewing(false);
  };

  return (
    <DialogShell title={def.name} onClose={onClose}>
      <div className="flex flex-col gap-3" data-testid="effect-dialog">
        {def.params.map((p) => (
          <ParamControl key={p.id} param={p} value={params[p.id]} onChange={setParam} />
        ))}

        {def.params.length === 0 && (
          <p className="text-xs text-[#8b8b92]">This effect has no parameters.</p>
        )}

        {busy && (
          <div className="h-1.5 w-full overflow-hidden rounded bg-[#2e2e34]">
            <div
              data-testid="effect-progress"
              className="h-full bg-[#26c6da] transition-[width]"
              style={{ width: `${Math.round(progress * 100)}%` }}
            />
          </div>
        )}

        <div className="mt-2 flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={previewing ? stopPreview : startPreview}
            disabled={!def || activeDocumentId === null}
            className="rounded border border-[#3a3a42] bg-[#2e2e34] px-3 py-1 text-sm text-[#d4d4d8] hover:bg-[#3a3a42] disabled:opacity-50"
          >
            {previewing ? 'Stop Preview' : 'Preview'}
          </button>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded border border-[#3a3a42] bg-[#2e2e34] px-3 py-1 text-sm text-[#d4d4d8] hover:bg-[#3a3a42]"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={apply}
              disabled={!canApply}
              className="rounded bg-[#26c6da] px-3 py-1 text-sm font-medium text-[#101014] hover:brightness-110 disabled:opacity-50"
            >
              Apply
            </button>
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
}: {
  param: EffectParamDef;
  value: EffectParamValue;
  onChange: (id: string, value: EffectParamValue) => void;
}) {
  const controlId = `effect-param-${param.id}`;

  if (param.type === 'boolean') {
    return (
      <label className="flex items-center gap-2 text-sm text-[#d4d4d8]" htmlFor={controlId}>
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
        <label className={LABEL} htmlFor={controlId}>
          {param.label}
        </label>
        <select
          id={controlId}
          className={FIELD}
          value={String(value)}
          onChange={(e) => onChange(param.id, e.target.value)}
        >
          {(param.options ?? []).map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
    );
  }

  // number: synced slider + numeric input
  const num = Number(value);
  const min = param.min ?? 0;
  const max = param.max ?? 100;
  const step = param.step ?? 1;
  return (
    <div>
      <label className={LABEL} htmlFor={controlId}>
        {param.label}
        {param.unit ? ` (${param.unit})` : ''}
      </label>
      <div className="flex items-center gap-2">
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={num}
          onChange={(e) => onChange(param.id, Number(e.target.value))}
          className="flex-1 accent-[#26c6da]"
        />
        <input
          id={controlId}
          type="number"
          min={min}
          max={max}
          step={step}
          value={num}
          onChange={(e) => onChange(param.id, Number(e.target.value))}
          className={`${FIELD} w-20`}
        />
      </div>
    </div>
  );
}
