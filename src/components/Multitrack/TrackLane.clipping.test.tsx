/**
 * V1 — a clip never paints over the track header.
 *
 * The report: at 381 % zoom, scrolled right, a clip's waveform is drawn across
 * the left header column (name, M/S/R/X, Vol/Pan). The geometry behind it is
 * ordinary, and none of the three ingredients is a mistake on its own:
 *
 *  - a clip's `left` is `(startSample − scrollSample) / samplesPerPixel`, which
 *    is NEGATIVE for every clip whose start has been scrolled past. The clip
 *    element's box therefore extends left of the lane's origin — by thousands of
 *    px at a working zoom — and that is simply what "scrolled right" means;
 *  - the clip's own `overflow: hidden` clips its children to the CLIP, not to
 *    the lane, and the waveform/tic raster deliberately begins on a 256-px
 *    quantum boundary (`ticWindow` — the repaint-identity contract that stops a
 *    scroll re-rasterising within a quantum), so the canvas starts up to 255 px
 *    left of the lane origin. The header column is 224 px
 *    ({@link MT_HEADER_W}), i.e. NARROWER than that worst case;
 *  - the clip is absolutely POSITIONED and the header is a static flex sibling
 *    with a translucent background, so anything that overhangs paints OVER the
 *    header rather than behind it.
 *
 * The one element in the tree that can stop it is the lane itself: it is the
 * clip's containing block, so clipping there — and only there — bounds every
 * clip child (box, waveform, tics, fade overlay, handles) at the lane's left
 * edge, which is exactly where the header ends. The row above it
 * (`.glass-track-row { overflow: hidden }`) clips at the ROW box, header
 * included, so it is not a candidate; clamping the band would have to give up
 * the quantum.
 *
 * jsdom has neither layout nor a 2d backend, so nothing below is about pixels
 * that were painted. It is about the CSS boxes a browser would paint into, and
 * about the element that bounds them — which is where the defect lives.
 *
 * WHAT THIS STILL DOES NOT PROVE (V1 review, Minor 4). The two premise
 * assertions are real geometry and a revert of the className does fail — but
 * the clipping half would also pass if an ancestor set `overflow: visible` or
 * if the class stopped resolving to any CSS, because jsdom never cascades.
 * Only a live run can close that: the reported gesture is 381 % zoom, scrolled
 * right, with the header still legible and still clickable. It is owed by the
 * integration pass over the merged wave, not by this file, and it is recorded
 * here so it is not mistaken for something the suite already covers.
 */
import { render } from '@testing-library/react';
import { createDocument, type AudioDocument } from '../../audio/AudioDocument';
import type { Clip, Track } from '../../multitrack/session';
import { MT_HEADER_W } from '../../multitrack/sessionViewport';
import TrackLane from './TrackLane';

const SR = 44100;
const SPP = 100;

/**
 * Where the clip's left edge sits, in lane-local px, for these tests.
 *
 * Picked so the lane origin falls 255 px past a 256-px band boundary — the
 * WORST case of the quantisation, and so the one that pushes the raster
 * furthest into the header: `floor(5119 / 256) · 256 = 4864`, leaving the
 * canvas starting at lane-local `4864 − 5119 = −255`.
 */
const CLIP_LEFT_PX = -5119;
const BAND_START_PX = 4864;

function seedDoc(): AudioDocument {
  return createDocument({
    name: 'clip-src.wav',
    sampleRate: SR,
    channels: [new Float32Array(SR * 60)],
  });
}

function makeTrack(clips: Clip[]): Track {
  return {
    id: 'track-1',
    name: 'Track 1',
    volumeDb: 0,
    pan: 0,
    muted: false,
    solo: false,
    armed: false,
    clips,
  };
}

/** One 60-second clip starting at the session origin, with the view scrolled
 * right far enough that the clip's start is {@link CLIP_LEFT_PX} off the lane. */
function renderLane() {
  const doc = seedDoc();
  const clip: Clip = {
    id: 'clip-1',
    documentId: 'doc-1',
    startSample: 0,
    offsetSample: 0,
    lengthSample: SR * 60,
    gainDb: 0,
  };
  return render(
    <TrackLane
      track={makeTrack([clip])}
      docs={new Map([['doc-1', doc]])}
      zoom={{ samplesPerPixel: SPP, scrollSample: -CLIP_LEFT_PX * SPP }}
      sessionRate={SR}
      laneHeight={96}
      selectedClipId={null}
      isDragTarget={false}
      resolveTrackAt={() => null}
      onDragOverTrack={() => {}}
    />
  );
}

describe('TrackLane bounds its clips at the lane, not at the row (V1)', () => {
  it('a scrolled-right clip really does hang left of the lane, past the header column', () => {
    const { getByTestId } = renderLane();

    // The premise, not a defect: the box of a clip whose start has scrolled by
    // is genuinely left of the lane origin, and by far more than the header is
    // wide. Every clip in a scrolled session is in this state.
    const clipEl = getByTestId('clip');
    expect(parseFloat(clipEl.style.left)).toBe(CLIP_LEFT_PX);
    expect(parseFloat(clipEl.style.left)).toBeLessThan(-MT_HEADER_W);
  });

  it('the raster itself starts left of the lane, so the CLIP\'s own overflow cannot save the header', () => {
    const { getByTestId } = renderLane();
    const clipEl = getByTestId('clip');
    const canvas = getByTestId('clip-waveform');

    // The canvas is positioned inside the clip, so its lane-local left is the
    // sum. The band quantum puts it 255 px left of the lane origin — past the
    // 224 px header — which is why `overflow: hidden` on the CLIP (which is
    // already there) leaves the picture on the header untouched.
    expect(parseFloat(canvas.style.left)).toBe(BAND_START_PX);
    const rasterLeft = parseFloat(clipEl.style.left) + parseFloat(canvas.style.left);
    expect(rasterLeft).toBe(-255);
    expect(rasterLeft).toBeLessThanOrEqual(-MT_HEADER_W);
  });

  it('clips every clip child at the lane edge — the lane is where the header stops', () => {
    const { getByTestId } = renderLane();
    const lane = getByTestId('track-lane');

    expect(lane).toHaveClass('overflow-clip');
    // ...and the lane must stay the clip's CONTAINING BLOCK, because an
    // absolutely-positioned descendant is only clipped by an ancestor that is
    // one. Dropping `relative` here would silently hand every clip back to the
    // nearest positioned ancestor and un-clip the lot.
    expect(lane).toHaveClass('relative');
    expect(lane.contains(getByTestId('clip'))).toBe(true);
  });

  it('clips WITHOUT becoming a scroll container, which would corrupt every lane x', () => {
    const { getByTestId } = renderLane();
    const lane = getByTestId('track-lane');

    // `overflow: hidden` would clip identically but still make the lane a
    // scroll container — and a clip extends millions of px past the lane's
    // right edge, so there is real scrollable overflow to scroll. Every
    // pointer→sample mapping under this element reads the border-box left with
    // NO scrollLeft term (`laneRawStart` here, `pixelToSample(clientX -
    // rectLeft, …)` in EnvelopeLane), so a lane scrolled by one stray
    // `scrollIntoView`/focus would paint clips shifted by −scrollLeft while
    // drops, envelope keys and the drop ghost landed at the unshifted sample,
    // with nothing to notice or reset it. `overflow: clip` cannot be scrolled
    // at all, so the invariant is a property of the CSS rather than of nobody
    // having added a focusable control to a lane yet.
    // One class per assertion: `not.toHaveClass(a, b)` only says the element is
    // missing at least ONE of them, which would pass on a lane that is still
    // `overflow-hidden`.
    expect(lane).not.toHaveClass('overflow-hidden');
    expect(lane).not.toHaveClass('overflow-auto');
    expect(lane).not.toHaveClass('overflow-scroll');
    expect(lane).not.toHaveClass('overflow-x-hidden');
  });
});
