/**
 * D1 — THE zoom anchor: the edit bar, on every zoom path and both surfaces.
 *
 * The reported symptom was "when zooming in on a track, focus on where the line
 * was put". Four gestures zoom this app and they used to disagree about what
 * they were zooming toward: Ctrl+wheel anchored on the POINTER in the multitrack
 * (`useMultitrackZoom`) and in the waveform/spectral editor
 * (`useEditorGestures`), while the toolbar's −/+ buttons anchored on the edit
 * cursor (`zoomEditorBy`, `zoomSessionBy`) — the only anchor a control with no
 * viewport of its own could name. Same document, same zoom step, two different
 * destinations depending on which control the user reached for.
 *
 * D1 makes the bar the anchor everywhere, and this is the one function that
 * says so. The four callers state a REQUEST built here and hand it straight to
 * `applyEditorZoom` / `applySessionZoom`; none of them computes a scroll of its
 * own any more. That matters beyond tidiness — the rule has two halves (hold the
 * x, or centre) and a second copy is a second chance to implement only one.
 *
 * Deliberately store-free and surface-free: it is given a zoom, a lane width and
 * an anchor, so the editor's app-store zoom and the session's `mtZoom` share it
 * without either importing the other's store. The lane width is passed in for
 * the same reason `resolveZoom` takes one — `editorLaneWidth()` and
 * `sessionLaneWidth()` are two different measurements of two different surfaces.
 */

/** The part of a zoom this needs: the pair every viewport in the app is. */
export interface ZoomLike {
  samplesPerPixel: number;
  scrollSample: number;
}

export interface AnchoredZoomRequest {
  samplesPerPixel: number;
  /**
   * A FUNCTION of the resolved samples-per-pixel, never a number.
   *
   * `resolveZoom`/`resolveSessionZoom` clamp the requested spp against the fit
   * and `MIN_SPP`, so at either limit the spp the view commits is not the spp
   * that was asked for. An anchor computed from the REQUEST and then clamped
   * separately is exactly how the bar slides out from under itself on the last
   * wheel notch before the limit — the failure both request types' docblocks
   * already warn about, restated here because this is now the only place that
   * builds one.
   */
  scrollSample: (resolvedSamplesPerPixel: number) => number;
}

/**
 * Zoom `zoom` by `factor` while keeping `anchorSample` where the user can see
 * it: at its current on-screen x when it is on screen, at the CENTRE of the lane
 * when it is not.
 *
 * On screen means `0 <= x <= laneWidth`, inclusive at both edges — a bar the
 * user has just scrolled hard against an edge is on screen and must not
 * teleport to the middle.
 *
 * An unmeasured lane (`laneWidth <= 0`, or a non-finite one from a rect read
 * before layout) counts as off-screen-centre with the width treated as 0, i.e.
 * `scroll = anchor`: the bar lands at x = 0, which is the only position a
 * zero-wide lane has, and no NaN reaches the store.
 */
export function anchoredZoom(args: {
  zoom: ZoomLike;
  laneWidth: number;
  anchorSample: number;
  factor: number;
}): AnchoredZoomRequest {
  const { zoom, anchorSample, factor } = args;
  const laneWidth = Number.isFinite(args.laneWidth) && args.laneWidth > 0 ? args.laneWidth : 0;

  const x = (anchorSample - zoom.scrollSample) / zoom.samplesPerPixel;
  // `x >= 0 && x <= laneWidth` is false for NaN too (a zero or absent spp),
  // which falls through to the centre arm rather than poisoning the request.
  const onScreen = laneWidth > 0 && x >= 0 && x <= laneWidth;
  const holdAt = onScreen ? x : laneWidth / 2;

  return {
    samplesPerPixel: zoom.samplesPerPixel * factor,
    scrollSample: (spp) => anchorSample - holdAt * spp,
  };
}
