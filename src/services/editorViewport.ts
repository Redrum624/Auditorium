/**
 * F11-3 — the editor lane's measured width, published to whoever needs it.
 *
 * "Fit" has to mean "the whole track exactly fills the stage", and the store
 * cannot know how wide the stage is: the width is a layout fact, discovered by
 * the editor views' ResizeObserver (`WaveformView` / `SpectrogramView`, their
 * `size.width` state) long after the store has been created. Threading it back
 * up through props would put a layout measurement into every zoom call site;
 * this module is the one place it is recorded instead — written by those views'
 * resize effect, read by `appStore`'s zoom resolution.
 *
 * **The fallback.** Until something measures — the very first paint, jsdom, any
 * unit test that never mounts a view — the width reads
 * {@link FALLBACK_EDITOR_LANE_WIDTH}, which is the nominal 1600 px `defaultZoom`
 * used unconditionally before F11-3. Nothing therefore becomes undefined-shaped
 * or zero-shaped: a document opened before the lane has ever been measured gets
 * exactly the zoom it got in v1.23, and the moment the lane reports its real
 * width the store re-fits (see `publishEditorLaneWidth`). A measurement of 0 —
 * which is what jsdom and a display:none lane both report — is REJECTED rather
 * than recorded, because a zero width would make every derived
 * samples-per-pixel infinite.
 *
 * Deliberately store-free: `appStore` imports this, so this must not import
 * `appStore`.
 */

/** The nominal viewport `defaultZoom` assumed before F11-3, kept as the
 * "nothing has measured yet" answer. */
export const FALLBACK_EDITOR_LANE_WIDTH = 1600;

let measured = 0;

/** The lane width to lay a document across, in CSS px. Never 0. */
export function editorLaneWidth(): number {
  return measured > 0 ? measured : FALLBACK_EDITOR_LANE_WIDTH;
}

/**
 * Record a fresh measurement. Returns whether the EFFECTIVE width changed —
 * callers use that to decide whether anything needs re-fitting, so a resize
 * observer firing with the same number stays free.
 *
 * Non-finite and non-positive widths are ignored (see the fallback note).
 */
export function setEditorLaneWidth(width: number): boolean {
  if (!Number.isFinite(width) || width <= 0) return false;
  const before = editorLaneWidth();
  measured = width;
  return editorLaneWidth() !== before;
}

/** Test-only: forget the measurement so the fallback applies again. */
export function _resetEditorLaneWidth(): void {
  measured = 0;
}
