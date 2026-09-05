import { createClip, createTrack, type Session, type Track } from './session';
import {
  MT_EMPTY_TIMELINE_SEC,
  MT_MIN_SPP,
  MT_TIMELINE_TAIL_SEC,
  defaultSessionZoom,
  fitSessionSamplesPerPixel,
  resolveSessionZoom,
  sessionEndSample,
  sessionTimelineLength,
} from './sessionZoom';
import { FALLBACK_SESSION_LANE_WIDTH, _resetSessionLaneWidth } from './sessionViewport';

/**
 * MT1-1 — the session's twin of `appStore`'s F11-3/F11-9 zoom resolution, and
 * the first test this arithmetic has ever had. Before it, the multitrack's only
 * clamp was inline in the wheel handler (`useMultitrackZoom`), untested, and
 * three unrelated modules opened a session at a hardcoded 512 samples/px — the
 * reported symptom being a 2:58 session that opened showing 18 seconds of
 * itself.
 */
const SR = 44_100;

function sessionOf(...clipEnds: number[]): Session {
  const tracks: Track[] = clipEnds.map((end, i) => {
    const t = createTrack(`Track ${i + 1}`);
    t.clips = [
      createClip({ documentId: 'doc-1', startSample: 0, offsetSample: 0, lengthSample: end }),
    ];
    return t;
  });
  return { name: 'Fixture', sampleRate: SR, tracks };
}

function emptySession(): Session {
  return { name: 'Empty', sampleRate: SR, tracks: [createTrack('Track 1')] };
}

beforeEach(() => {
  _resetSessionLaneWidth();
});

describe('sessionEndSample — THE shared "how long is this session" helper', () => {
  it('is the furthest clip END across every track, muted and soloed alike', () => {
    // Deliberately NOT mixdown's audible-only length: a muted track's clips are
    // still on the timeline and still have to be reachable by scrolling. The
    // zoom answers "what is drawn", the mixdown answers "what is heard".
    const session = sessionOf(1000, 5000, 2000);
    session.tracks[1].muted = true;
    session.tracks[2].solo = true;
    expect(sessionEndSample(session)).toBe(5000);
  });

  it('counts a clip that starts late, not just a long one', () => {
    const session = sessionOf(1000);
    session.tracks[0].clips.push(
      createClip({ documentId: 'doc-1', startSample: 90_000, offsetSample: 0, lengthSample: 10 })
    );
    expect(sessionEndSample(session)).toBe(90_010);
  });

  it('is 0 for a session with no clips at all', () => {
    expect(sessionEndSample(emptySession())).toBe(0);
  });
});

describe('sessionTimelineLength — the empty-session convention', () => {
  it('is the last clip end when there is one', () => {
    expect(sessionTimelineLength(sessionOf(123_456))).toBe(123_456);
  });

  it('is 60 seconds of the session rate when there is not', () => {
    // Task 22's convention, kept: an empty session laid across its own zero
    // length would fit at MIN_SPP, i.e. fully zoomed IN on nothing.
    expect(sessionTimelineLength(emptySession())).toBe(MT_EMPTY_TIMELINE_SEC * SR);
  });
});

describe('fitSessionSamplesPerPixel', () => {
  it('lays the longest track across the measured lane exactly', () => {
    expect(fitSessionSamplesPerPixel(sessionOf(1000, 8000), 400)).toBe(20);
  });

  it('defaults to the module lane width when none is given', () => {
    const session = sessionOf(FALLBACK_SESSION_LANE_WIDTH * 7);
    expect(fitSessionSamplesPerPixel(session)).toBe(7);
  });

  it('is floored at MT_MIN_SPP for a session shorter than the zoom range allows', () => {
    expect(fitSessionSamplesPerPixel(sessionOf(10), 1600)).toBe(MT_MIN_SPP);
  });
});

describe('resolveSessionZoom — the ONE clamp', () => {
  const session = sessionOf(100_000);

  it('clamps samplesPerPixel to [MT_MIN_SPP, fit]', () => {
    const fit = fitSessionSamplesPerPixel(session, 1000); // 100
    expect(resolveSessionZoom(session, { samplesPerPixel: 1e9, scrollSample: 0 }, 1000)
      .samplesPerPixel).toBe(fit);
    expect(resolveSessionZoom(session, { samplesPerPixel: 0, scrollSample: 0 }, 1000)
      .samplesPerPixel).toBe(MT_MIN_SPP);
    expect(resolveSessionZoom(session, { samplesPerPixel: 25, scrollSample: 0 }, 1000)
      .samplesPerPixel).toBe(25);
  });

  it('pins MT_MIN_SPP to its literal, not to whatever the code says', () => {
    // A constant asserted only against itself moves for free. 1/32 is the
    // editor's MIN_SPP, and the two surfaces agreeing is a deliberate choice
    // (see the module docblock) rather than an import — so the number is
    // written down here, where a change has to be argued for.
    expect(MT_MIN_SPP).toBe(1 / 32);
  });

  it('resolves the scroll against the RESOLVED spp, never the requested one', () => {
    // The anchored gestures (since D1: Ctrl+wheel and the -/+ buttons, both on
    // the cursor) pass a scroll FUNCTION so the anchor stays under the same x. At a
    // limit the requested and resolved spp differ, and feeding the request to
    // that function is exactly how an anchor drifts at the edge of the range.
    // Requesting an absurd zoom-out resolves to `fit`, so the function must be
    // handed `fit` and not 1e9.
    const fit = fitSessionSamplesPerPixel(session, 1000);
    const seen: number[] = [];
    resolveSessionZoom(
      session,
      {
        samplesPerPixel: 1e9,
        scrollSample: (spp) => {
          seen.push(spp);
          return 0;
        },
      },
      1000
    );
    expect(seen).toEqual([fit]);
    expect(seen[0]).not.toBe(1e9);

    // ...and the same at the zoom-IN limit, where the clamp moves the other way.
    const seenIn: number[] = [];
    resolveSessionZoom(
      session,
      {
        samplesPerPixel: 0,
        scrollSample: (spp) => {
          seenIn.push(spp);
          return 0;
        },
      },
      1000
    );
    expect(seenIn).toEqual([MT_MIN_SPP]);
  });

  it('keeps the visible window inside the timeline PLUS its open-ended tail', () => {
    // The one place this deliberately diverges from the editor: a document has
    // a hard end, a session timeline does not — a clip has to be droppable
    // past the last one. So the scroll ceiling is the timeline plus
    // MT_TIMELINE_TAIL_SEC of runway, minus what the lane already shows.
    const spp = 50;
    const max = 100_000 + MT_TIMELINE_TAIL_SEC * SR - 1000 * spp;
    expect(resolveSessionZoom(session, { samplesPerPixel: spp, scrollSample: 1e12 }, 1000)
      .scrollSample).toBe(max);
    expect(resolveSessionZoom(session, { samplesPerPixel: spp, scrollSample: -5 }, 1000)
      .scrollSample).toBe(0);
  });

  it('never returns a negative scroll ceiling', () => {
    // Reachable only where the MT_MIN_SPP floor beats the fit: a 10-sample
    // session at 1 Hz has a 70-sample scrollable extent, and 10 000 px of lane
    // at maximum zoom-in already shows 312 of them. Without the max(0, …) the
    // window would be pushed left of sample 0.
    const tiny: Session = { name: 'Tiny', sampleRate: 1, tracks: sessionOf(10).tracks };
    const zoom = resolveSessionZoom(tiny, { samplesPerPixel: 1e9, scrollSample: 1e9 }, 10_000);
    expect(zoom.samplesPerPixel).toBe(MT_MIN_SPP);
    expect(zoom.scrollSample).toBe(0);
  });

  it('resolves a non-finite scroll request to the start rather than poisoning it', () => {
    expect(resolveSessionZoom(session, { samplesPerPixel: 10, scrollSample: NaN }, 1000)
      .scrollSample).toBe(0);
  });

  it('feeds the RESOLVED samplesPerPixel to a functional scroll request', () => {
    // The anchored paths (since D1: Ctrl+wheel and the −/+ buttons, both on the
    // cursor) need the CLAMPED spp to keep their anchor under the same x.
    const seen: number[] = [];
    resolveSessionZoom(
      session,
      {
        samplesPerPixel: 1e9,
        scrollSample: (spp) => {
          seen.push(spp);
          return 0;
        },
      },
      1000
    );
    expect(seen).toEqual([fitSessionSamplesPerPixel(session, 1000)]);
  });
});

describe('defaultSessionZoom — what "Fit" means for a session', () => {
  it('fits the LONGEST track across the lane, from sample 0', () => {
    // The reported bug, as an assertion: a 2:58 session must open showing all
    // of itself, not the 18 s a hardcoded 512 samples/px showed.
    const session = sessionOf(30 * SR, 178 * SR, 12 * SR);
    const zoom = defaultSessionZoom(session);
    expect(zoom.scrollSample).toBe(0);
    expect(zoom.samplesPerPixel).toBe((178 * SR) / FALLBACK_SESSION_LANE_WIDTH);
    // Restated as seconds-on-screen, which is what the report was about: the
    // whole 2:58, not the 16 s a hardcoded 512 samples/px would have shown.
    expect((FALLBACK_SESSION_LANE_WIDTH * zoom.samplesPerPixel) / SR).toBeCloseTo(178, 6);
    expect((FALLBACK_SESSION_LANE_WIDTH * 512) / SR).toBeCloseTo(15.98, 2);
  });

  it('cannot drift from fitSessionSamplesPerPixel — it asks for Infinity', () => {
    const session = sessionOf(7_777_777);
    expect(defaultSessionZoom(session).samplesPerPixel).toBe(
      fitSessionSamplesPerPixel(session)
    );
  });

  it('gives an empty session 60 seconds of visible timeline', () => {
    const zoom = defaultSessionZoom(emptySession());
    expect(zoom.samplesPerPixel).toBe((MT_EMPTY_TIMELINE_SEC * SR) / FALLBACK_SESSION_LANE_WIDTH);
  });
});
