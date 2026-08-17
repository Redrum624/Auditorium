import { useEffect, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react';
import { FADE_CURVES, FADE_CURVE_LABELS } from '../../dsp/fades';
import type { FadeCurve } from '../../dsp/fades';
import {
  AUTOMATION_PARAM_LABELS,
  AUTOMATION_RANGES,
  DEFAULT_AUTOMATION_CURVE,
  automationValueAt,
  clampAutomationValue,
  type AutomationKey,
  type AutomationParam,
} from '../../multitrack/automation';
import { SPATIAL_NEUTRAL } from '../../dsp/spatial';
import type { Track } from '../../multitrack/session';
import { useSessionStore } from '../../multitrack/sessionStore';
import { snapSample } from '../../services/snap';
import { pixelToSample, sampleToPixel } from '../Editor/waveformRender';
import { sessionSnapTargets } from './sessionSnapTargets';

interface Zoom {
  samplesPerPixel: number;
  scrollSample: number;
}

interface EnvelopeLaneProps {
  track: Track;
  param: AutomationParam;
  zoom: Zoom;
  laneHeight: number;
}

/** Vertical padding so a key dot at the range limit stays fully visible. */
const PAD_Y = 6;
/** Pointer-to-key hit radius, CSS px (the fade handles' 10 px square ≈ 8 px
 * effective radius; a key dot is a 4 px circle, so 8 px keeps it grabbable). */
const KEY_HIT_PX = 8;
/** Same click-vs-drag threshold as ClipView's gestures (raw pointer travel). */
const DRAG_THRESHOLD = 4;

/** True while the snap-suspend modifier is held on THIS event (v1.8 rule:
 * Alt suspends, Ctrl and Shift are spoken for — T28). */
function snapSuspended(e: { altKey: boolean }): boolean {
  return e.altKey;
}

interface KeyDragState {
  /** 'new' = pointerdown on empty lane (the key exists only as a preview until
   * the pointerup commit); 'existing' = dragging a real key. */
  mode: 'new' | 'existing';
  /** For 'existing': the dragged key's stored position (the commit's
   * `replacePositionSample`). NaN for 'new'. */
  origPos: number;
  /** For 'existing': the dragged key's own curve, carried into the preview so
   * the drawn segments match what the store commit will keep. */
  origCurve?: FadeCurve;
  rectLeft: number;
  rectTop: number;
  startClientX: number;
  startClientY: number;
  /** Last pointer position, so an Alt press with the pointer STILL can
   * recompute the preview (T20's second half). */
  lastClientX: number;
  lastClientY: number;
  exceeded: boolean;
  /** Snap targets captured ONCE at pointerdown (T21). Keys are not part of the
   * session target set, so the dragged key cannot snap to itself. */
  targets: number[];
}

/**
 * F0 — the envelope editing surface for ONE track lane: an overlay child of
 * `TrackLane` (T23/T29 — never a clip child, so it ignores a clip drag's
 * translate, T27) covering the lane's VIEWPORT (the lane div is viewport-
 * sized; clips scroll by repositioning, so no million-pixel surface exists to
 * blow a raster limit — T26 does not arise for this SVG).
 *
 * Gestures (ruling D — preview on pointermove, ONE store commit on pointerup):
 *  - click on empty lane   → add a key at (sample, value under the pointer)
 *  - drag a key            → move it (preview locally, commit on release)
 *  - right-click a key     → delete it
 *  - double-click a key    → cycle the OUTGOING segment's curve
 * X snapping uses the session's own magnet (`snapSample` + the v1.8 target
 * set, tolerance in SCREEN px via the multitrack's own zoom prop — T17/T18);
 * Alt suspends it, with the window-listener half covering a modifier change
 * while the pointer is still (T20). Preview and commit share `dropFor`, so
 * they cannot disagree (T19); the ordering inside it is snap FIRST (intent,
 * screen space), round+clamp SECOND (validity — T22).
 *
 * Value mapping: top of the lane = the parameter's MAX (+12 dB / pan R), a
 * plain chart-axis convention shared by both lanes. With ZERO keys the lane
 * draws the STATIC field's value as a dashed line — the honest picture of
 * ruling B (the static field governs until the first key exists), and the
 * first click writes a key where the user aims.
 *
 * While an envelope is open it owns the lane's pointer events (standard DAW
 * automation-mode behaviour); clip gestures resume when it is closed. Every
 * pointerdown stops propagation so `TrackLane`'s empty-space click cannot
 * clear the clip selection underneath (T25).
 */
export default function EnvelopeLane({ track, param, zoom, laneHeight }: EnvelopeLaneProps) {
  const upsertAutomationKey = useSessionStore((s) => s.upsertAutomationKey);
  const removeAutomationKey = useSessionStore((s) => s.removeAutomationKey);
  const setAutomationKeyCurve = useSessionStore((s) => s.setAutomationKeyCurve);

  const rootRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<KeyDragState | null>(null);
  const [width, setWidth] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [previewKey, setPreviewKey] = useState<{ positionSample: number; value: number } | null>(
    null
  );
  const [curveFlash, setCurveFlash] = useState<{ x: number; label: string } | null>(null);

  const { min, max } = AUTOMATION_RANGES[param];
  const innerH = laneHeight - 2 * PAD_Y;
  const valueToY = (v: number): number => PAD_Y + (1 - (v - min) / (max - min)) * innerH;
  const yToValue = (y: number): number => min + (1 - (y - PAD_Y) / innerH) * (max - min);

  // The track's lane for this param (last-wins, matching resolveAutomation).
  let keys: readonly AutomationKey[] = [];
  for (const lane of track.automation ?? []) {
    if (lane.param === param) keys = lane.keys;
  }

  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    setWidth(el.clientWidth);
    if (typeof ResizeObserver === 'undefined') return; // jsdom
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (!curveFlash) return;
    const t = window.setTimeout(() => setCurveFlash(null), 1600);
    return () => window.clearTimeout(t);
  }, [curveFlash]);

  /** THE shared preview/commit transform (T19): pointer position → snapped,
   * rounded, clamped key. Snap first (intent), round + `>= 0` clamp second
   * (validity, T22); the value clamp is the same exported arithmetic the
   * store action applies, so the preview shows exactly what will commit. */
  const dropFor = (
    drag: KeyDragState,
    clientX: number,
    clientY: number,
    alt: boolean
  ): { positionSample: number; value: number } => {
    const raw = pixelToSample(clientX - drag.rectLeft, zoom.scrollSample, zoom.samplesPerPixel);
    const snapped =
      alt || drag.targets.length === 0
        ? raw
        : snapSample(raw, drag.targets, zoom.samplesPerPixel).sample;
    return {
      positionSample: Math.max(0, Math.round(snapped)),
      value: clampAutomationValue(param, yToValue(clientY - drag.rectTop)),
    };
  };

  /** Nearest stored key within KEY_HIT_PX of the pointer, in pixel space. */
  const keyAt = (localX: number, localY: number): AutomationKey | null => {
    let best: AutomationKey | null = null;
    let bestD2 = Infinity;
    for (const k of keys) {
      const dx = sampleToPixel(k.positionSample, zoom.scrollSample, zoom.samplesPerPixel) - localX;
      const dy = valueToY(k.value) - localY;
      const d2 = dx * dx + dy * dy;
      if (d2 < bestD2) {
        bestD2 = d2;
        best = k;
      }
    }
    return best !== null && bestD2 <= KEY_HIT_PX * KEY_HIT_PX ? best : null;
  };

  // T20, second half: a modifier change with the pointer still must recompute
  // the persistent preview; alive only while a drag is.
  useEffect(() => {
    if (!dragging) return;
    const onAltChange = (e: KeyboardEvent) => {
      if (e.key !== 'Alt') return;
      const drag = dragRef.current;
      if (!drag) return;
      if (drag.mode === 'existing' && !drag.exceeded) return;
      setPreviewKey(dropFor(drag, drag.lastClientX, drag.lastClientY, e.altKey));
    };
    window.addEventListener('keydown', onAltChange);
    window.addEventListener('keyup', onAltChange);
    return () => {
      window.removeEventListener('keydown', onAltChange);
      window.removeEventListener('keyup', onAltChange);
    };
    // dropFor is recreated per render; the deps are everything it reads, so
    // the listener is rebound exactly when its answer could change.
  }, [dragging, zoom.samplesPerPixel, zoom.scrollSample, param]);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    // T25: any button-0 pointerdown reaching TrackLane clears the clip
    // selection; the envelope owns its lane's gestures while open.
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    const hit = keyAt(e.clientX - rect.left, e.clientY - rect.top);

    if (e.button === 2) {
      if (hit) removeAutomationKey(track.id, param, hit.positionSample);
      return;
    }
    if (e.button !== 0) return;

    const drag: KeyDragState = {
      mode: hit ? 'existing' : 'new',
      origPos: hit ? hit.positionSample : NaN,
      origCurve: hit?.curve,
      rectLeft: rect.left,
      rectTop: rect.top,
      startClientX: e.clientX,
      startClientY: e.clientY,
      lastClientX: e.clientX,
      lastClientY: e.clientY,
      exceeded: false,
      targets: sessionSnapTargets(null),
    };
    dragRef.current = drag;
    setDragging(true);
    // A NEW key previews immediately (the click will add it right here); an
    // existing key stays put until the drag threshold is exceeded.
    if (drag.mode === 'new') setPreviewKey(dropFor(drag, e.clientX, e.clientY, snapSuspended(e)));
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    e.stopPropagation();
    drag.lastClientX = e.clientX;
    drag.lastClientY = e.clientY;
    if (!drag.exceeded) {
      const dx = e.clientX - drag.startClientX;
      const dy = e.clientY - drag.startClientY;
      if (Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) {
        if (drag.mode === 'new') setPreviewKey(dropFor(drag, e.clientX, e.clientY, snapSuspended(e)));
        return;
      }
      drag.exceeded = true;
    }
    setPreviewKey(dropFor(drag, e.clientX, e.clientY, snapSuspended(e)));
  };

  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    e.stopPropagation();
    dragRef.current = null;
    setDragging(false);
    setPreviewKey(null);
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    if (e.button !== 0) return;

    const drop = dropFor(drag, e.clientX, e.clientY, snapSuspended(e));
    if (drag.mode === 'new') {
      // Click adds; click-and-drag places. Either way ONE commit (ruling D).
      upsertAutomationKey(track.id, param, drop);
    } else if (drag.exceeded) {
      // A MOVE: one commit replacing the original position; the store carries
      // the key's curve (no explicit curve in the patch).
      upsertAutomationKey(track.id, param, drop, drag.origPos);
    }
    // 'existing' without movement: a plain click on a key — no write.
  };

  const onDoubleClick = (e: ReactMouseEvent<HTMLDivElement>) => {
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    const hit = keyAt(e.clientX - rect.left, e.clientY - rect.top);
    if (!hit) return;
    const current = hit.curve ?? DEFAULT_AUTOMATION_CURVE;
    const next = FADE_CURVES[(FADE_CURVES.indexOf(current) + 1) % FADE_CURVES.length];
    setAutomationKeyCurve(track.id, param, hit.positionSample, next);
    setCurveFlash({
      x: sampleToPixel(hit.positionSample, zoom.scrollSample, zoom.samplesPerPixel),
      label: FADE_CURVE_LABELS[next],
    });
  };

  // The drawn key set: the stored keys with the drag preview substituted in —
  // computed with the same replace/occupy rules the commit will apply.
  let displayKeys: AutomationKey[];
  const activeDrag = dragRef.current;
  if (previewKey && activeDrag) {
    const withoutDragged = keys.filter(
      (k) =>
        k.positionSample !== previewKey.positionSample &&
        (activeDrag.mode !== 'existing' || k.positionSample !== activeDrag.origPos)
    );
    const pk: AutomationKey = { positionSample: previewKey.positionSample, value: previewKey.value };
    if (activeDrag.origCurve !== undefined) pk.curve = activeDrag.origCurve;
    displayKeys = [...withoutDragged, pk].sort((a, b) => a.positionSample - b.positionSample);
  } else {
    displayKeys = [...keys];
  }

  // The envelope polyline over the VISIBLE range, drawn from the real
  // evaluator — WITH the param, so an azimuth lane draws its short-arc wrap
  // (the vertical jump at the ±180 seam is the honest picture of the wrap;
  // the audio is continuous there, the NUMBER is not). Zero keys: the flat
  // dashed line at the value that governs without keys — the static field
  // for volume/pan, the parameter's `SPATIAL_NEUTRAL` member for the F5
  // spatial params (which have NO static Track field: position is
  // automation-only, and this line shows where the source sits until the
  // first key exists).
  const staticValue =
    param === 'volumeDb'
      ? track.volumeDb
      : param === 'pan'
        ? track.pan
        : SPATIAL_NEUTRAL[param];
  const points: string[] = [];
  for (let x = 0; x <= width; x += 2) {
    const s = pixelToSample(x, zoom.scrollSample, zoom.samplesPerPixel);
    const v = displayKeys.length > 0 ? automationValueAt(displayKeys, s, param) : staticValue;
    points.push(`${x},${valueToY(v).toFixed(2)}`);
  }

  const dots = displayKeys
    .map((k) => ({
      k,
      x: sampleToPixel(k.positionSample, zoom.scrollSample, zoom.samplesPerPixel),
    }))
    .filter(({ x }) => x >= -KEY_HIT_PX && x <= width + KEY_HIT_PX);

  const fmtValue = (v: number): string => {
    switch (param) {
      case 'volumeDb':
        return `${v > 0 ? '+' : ''}${v.toFixed(1)} dB`;
      case 'azimuth':
      case 'elevation':
        return `${v.toFixed(0)}°`;
      case 'distance':
        return `${v.toFixed(2)}×`; // multiples of the reference distance
      case 'pan':
        return Math.round(Math.abs(v) * 100) === 0
          ? 'C'
          : `${v < 0 ? 'L' : 'R'}${Math.round(Math.abs(v) * 100)}`;
    }
  };

  return (
    <div
      ref={rootRef}
      data-testid="envelope-lane"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onDoubleClick={onDoubleClick}
      onContextMenu={(e) => {
        // Right-click is the delete gesture; no browser menu over the lane.
        e.preventDefault();
        e.stopPropagation();
      }}
      className="absolute inset-0 z-10"
      style={{ cursor: 'crosshair', backgroundColor: 'rgba(10, 10, 13, 0.35)' }}
    >
      <svg
        data-testid="envelope-svg"
        className="pointer-events-none absolute inset-0 h-full w-full"
        width={Math.max(1, width)}
        height={laneHeight}
      >
        {points.length > 1 && (
          <polyline
            points={points.join(' ')}
            fill="none"
            stroke="var(--accent)"
            strokeWidth={1.5}
            strokeDasharray={displayKeys.length === 0 ? '4 3' : undefined}
            opacity={0.9}
          />
        )}
        {dots.map(({ k, x }) => (
          <circle
            key={k.positionSample}
            data-testid="envelope-key"
            cx={x}
            cy={valueToY(k.value)}
            r={4}
            fill="var(--accent)"
            stroke="rgba(10, 10, 13, 0.9)"
            strokeWidth={1.5}
          />
        ))}
      </svg>

      {previewKey && (
        <div
          data-testid="envelope-readout"
          className="pointer-events-none absolute top-1 left-2 rounded px-1.5 py-0.5 text-[10px] tabular-nums"
          style={{
            background: 'var(--glass-bg)',
            border: '1px solid var(--glass-border)',
            color: 'var(--glass-text-label)',
          }}
        >
          {fmtValue(previewKey.value)}
        </div>
      )}
      {curveFlash && (
        <div
          data-testid="envelope-curve-flash"
          className="pointer-events-none absolute top-1 rounded px-1.5 py-0.5 text-[10px]"
          style={{
            left: Math.max(2, Math.min(width - 60, curveFlash.x)),
            background: 'var(--glass-bg)',
            border: '1px solid var(--accent-ring)',
            color: 'var(--glass-text-label)',
          }}
        >
          {curveFlash.label}
        </div>
      )}
      <div
        className="pointer-events-none absolute right-1.5 bottom-0.5 text-[9px]"
        style={{ color: 'var(--glass-text-muted)' }}
      >
        {AUTOMATION_PARAM_LABELS[param]} · click add · drag move · right-click delete ·
        double-click curve
      </div>
    </div>
  );
}
