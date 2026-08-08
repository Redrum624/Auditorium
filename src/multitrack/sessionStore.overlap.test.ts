import { createDocument, type AudioDocument } from '../audio/AudioDocument';
import type { Clip, Session, Track } from './session';
import { createClip } from './session';
import { mixdownSession, resolveClipFadeSpecs } from './mixdown';
import { useSessionStore } from './sessionStore';

// ---------------------------------------------------------------------------
// X5: same-track overlap made intentional — the STORE half of X3's
// canonical-pair contract.
//
// The rule under test (maintainFacingFades):
//  - a gesture (moveClip / trimClip) that CREATES an overlap, or reshapes an
//    ALREADY-ARMED one, leaves both facing fades exactly spanning the overlap
//    (rule 3 of X3's canonical pair) so it renders as a crossfade;
//  - an overlap that existed un-armed is a raw layering choice and is never
//    overwritten; away-side fades are never shrunk (no undo exists for clip
//    mutations) — an arm they would block is vetoed instead;
//  - a pair that dissolves (moved apart, containment, veto) has both stale
//    facing fades cleared, away-side fades untouched;
//  - addClip and the v1.8 nudge (moveClip's opts.clearOverlap) never write
//    fade keys.
// ---------------------------------------------------------------------------

function findClip(clipId: string): Clip | undefined {
  for (const track of useSessionStore.getState().session.tracks) {
    const clip = track.clips.find((c) => c.id === clipId);
    if (clip) return clip;
  }
  return undefined;
}

function trackId(idx = 0): string {
  return useSessionStore.getState().session.tracks[idx].id;
}

function trackClips(idx = 0): Clip[] {
  return useSessionStore.getState().session.tracks[idx].clips;
}

/** addClip's a fresh clip; returns its id. */
function seed(
  opts: { startSample: number; lengthSample: number; offsetSample?: number },
  trackIdx = 0
): string {
  const store = useSessionStore.getState();
  const clip = createClip({
    documentId: 'doc-1',
    startSample: opts.startSample,
    offsetSample: opts.offsetSample ?? 0,
    lengthSample: opts.lengthSample,
  });
  store.addClip(store.session.tracks[trackIdx].id, clip);
  return clip.id;
}

beforeEach(() => {
  useSessionStore.getState().newSession(44100);
});

describe('moveClip arming — the gesture half of the canonical-pair contract', () => {
  it('a move that CREATES a tail overlap arms it: facing fades == overlap width, and the renderer fires', () => {
    const a = seed({ startSample: 0, lengthSample: 1000 });
    const b = seed({ startSample: 5000, lengthSample: 1000 });
    // A pre-chosen curve on the facing edge must survive the arm (the arm
    // writes lengths, never curves).
    useSessionStore.getState().setClipFade(a, 'out', { curve: 'equal-gain' });

    useSessionStore.getState().moveClip(b, trackId(), 600); // [600,1600) over [0,1000): w=400

    expect(findClip(a)!.fadeOutSample).toBe(400);
    expect(findClip(b)!.fadeInSample).toBe(400);
    expect(findClip(a)!.fadeOutCurve).toBe('equal-gain');
    // Away-side edges untouched.
    expect(findClip(a)!.fadeInSample).toBeUndefined();
    expect(findClip(b)!.fadeOutSample).toBeUndefined();
    // The renderer's own gate (rule 3 included) sees a live crossfade — the
    // store did not merely write plausible numbers.
    const specs = resolveClipFadeSpecs(trackClips());
    expect(specs.get(a)?.crossOut?.lengthSample).toBe(400);
    expect(specs.get(b)?.crossIn?.lengthSample).toBe(400);
  });

  it('equal starts have no handover direction (rule 1): the overlap commits raw', () => {
    const a = seed({ startSample: 0, lengthSample: 1000 });
    const b = seed({ startSample: 5000, lengthSample: 1000 });

    useSessionStore.getState().moveClip(b, trackId(), 0);

    expect(findClip(b)!.startSample).toBe(0); // committed verbatim
    expect(findClip(a)!.fadeOutSample).toBeUndefined();
    expect(findClip(a)!.fadeInSample).toBeUndefined();
    expect(findClip(b)!.fadeInSample).toBeUndefined();
    expect(findClip(b)!.fadeOutSample).toBeUndefined();
  });

  it('containment (rule 2) commits raw: a clip dropped inside a longer one gets no fades', () => {
    const a = seed({ startSample: 0, lengthSample: 2000 });
    const b = seed({ startSample: 5000, lengthSample: 500 });

    useSessionStore.getState().moveClip(b, trackId(), 700); // [700,1200) inside [0,2000)

    expect(findClip(b)!.startSample).toBe(700);
    expect(findClip(a)!.fadeOutSample).toBeUndefined();
    expect(findClip(b)!.fadeInSample).toBeUndefined();
  });

  it('a third clip intersecting the overlap region (rule 4) blocks arming: a pile-up stays raw', () => {
    const a = seed({ startSample: 0, lengthSample: 1000 });
    const c = seed({ startSample: 800, lengthSample: 1000 }); // [800,1800), raw overlap with A
    const b = seed({ startSample: 5000, lengthSample: 600 });

    useSessionStore.getState().moveClip(b, trackId(), 500); // [500,1100): both pairs intruded

    expect(findClip(b)!.startSample).toBe(500);
    for (const id of [a, b, c]) {
      expect(findClip(id)!.fadeInSample).toBeUndefined();
      expect(findClip(id)!.fadeOutSample).toBeUndefined();
    }
  });

  it('an away-side fade on the OUTGOING clip vetoes the arm and is never shrunk', () => {
    const a = seed({ startSample: 0, lengthSample: 1000 });
    useSessionStore.getState().setClipFade(a, 'in', { lengthSample: 700 });
    const b = seed({ startSample: 5000, lengthSample: 1000 });

    useSessionStore.getState().moveClip(b, trackId(), 600); // w=400; 700 + 400 > 1000

    expect(findClip(a)!.fadeInSample).toBe(700); // standing fade untouched
    expect(findClip(a)!.fadeOutSample).toBeUndefined(); // arm vetoed
    expect(findClip(b)!.fadeInSample).toBeUndefined();
  });

  it('an away-side fade on the INCOMING clip vetoes the arm and is never shrunk', () => {
    const a = seed({ startSample: 0, lengthSample: 1000 });
    const b = seed({ startSample: 5000, lengthSample: 1000 });
    useSessionStore.getState().setClipFade(b, 'out', { lengthSample: 700 });

    useSessionStore.getState().moveClip(b, trackId(), 600); // w=400; 700 + 400 > 1000

    expect(findClip(b)!.fadeOutSample).toBe(700);
    expect(findClip(b)!.fadeInSample).toBeUndefined();
    expect(findClip(a)!.fadeOutSample).toBeUndefined();
  });

  it('a fractional overlap width (corrupt geometry) is never written as a fade', () => {
    // Only a hand-built file can carry fractional geometry; addClip performs
    // no validation, which is exactly how such a session would reach the
    // store. The renderer's `=== width` gate compares unrounded, so a rounded
    // write could never fire — the store must skip the arm entirely.
    const store = useSessionStore.getState();
    const a: Clip = {
      ...createClip({ documentId: 'doc-1', startSample: 0, offsetSample: 0, lengthSample: 1000 }),
      lengthSample: 1000.5,
    };
    store.addClip(trackId(), a);
    const b = seed({ startSample: 5000, lengthSample: 1000 });

    useSessionStore.getState().moveClip(b, trackId(), 600); // w = 400.5

    expect(findClip(a.id)!.fadeOutSample).toBeUndefined();
    expect(findClip(b)!.fadeInSample).toBeUndefined();
  });

  it('a cross-track move arms on the TARGET track', () => {
    const a = seed({ startSample: 0, lengthSample: 1000 }, 1);
    const b = seed({ startSample: 0, lengthSample: 1000 }, 0);

    useSessionStore.getState().moveClip(b, trackId(1), 600);

    expect(findClip(a)!.fadeOutSample).toBe(400);
    expect(findClip(b)!.fadeInSample).toBe(400);
  });

  it('moving a clip INTO an armed pair leaves the bystanders untouched (render gating is the resolver`s job)', () => {
    const a = seed({ startSample: 0, lengthSample: 1000 });
    const b = seed({ startSample: 5000, lengthSample: 1000 });
    useSessionStore.getState().moveClip(b, trackId(), 600); // armed at 400
    const c = seed({ startSample: 9000, lengthSample: 100 });

    useSessionStore.getState().moveClip(c, trackId(), 700); // [700,800) inside the overlap

    // The intruder gets no fades (both its pairs are containment)…
    expect(findClip(c)!.fadeInSample).toBeUndefined();
    // …and the pair's STORED fades survive — the renderer's rule 4 is what
    // silences the crossfade while the intruder sits there, so removing the
    // intruder revives it without any store write.
    expect(findClip(a)!.fadeOutSample).toBe(400);
    expect(findClip(b)!.fadeInSample).toBe(400);
  });
});

describe('moveClip disarming — a dissolved pair clears its facing fades', () => {
  it('moving the incoming clip away clears BOTH facing fades; away-side fades survive', () => {
    const a = seed({ startSample: 0, lengthSample: 1000 });
    const b = seed({ startSample: 5000, lengthSample: 1000 });
    useSessionStore.getState().setClipFade(a, 'in', { lengthSample: 50 });
    useSessionStore.getState().setClipFade(b, 'out', { lengthSample: 60 });
    useSessionStore.getState().moveClip(b, trackId(), 600); // armed: 50+400<=1000, 60+400<=1000
    expect(findClip(a)!.fadeOutSample).toBe(400);

    useSessionStore.getState().moveClip(b, trackId(), 5000); // apart again

    expect(findClip(a)!.fadeOutSample).toBeUndefined();
    expect(findClip(b)!.fadeInSample).toBeUndefined();
    expect(findClip(a)!.fadeInSample).toBe(50); // away fades untouched
    expect(findClip(b)!.fadeOutSample).toBe(60);
  });

  it('a cross-track move-away clears the partner left behind on the source track', () => {
    const a = seed({ startSample: 0, lengthSample: 1000 });
    const b = seed({ startSample: 5000, lengthSample: 1000 });
    useSessionStore.getState().moveClip(b, trackId(), 600); // armed

    useSessionStore.getState().moveClip(b, trackId(1), 5000);

    expect(findClip(a)!.fadeOutSample).toBeUndefined();
    expect(findClip(b)!.fadeInSample).toBeUndefined();
  });

  it('a clearOverlap (Ctrl) move dissolves the pair it pushes clear of', () => {
    const a = seed({ startSample: 0, lengthSample: 1000 });
    const b = seed({ startSample: 5000, lengthSample: 1000 });
    useSessionStore.getState().moveClip(b, trackId(), 600); // armed

    useSessionStore.getState().moveClip(b, trackId(), 500, { clearOverlap: true });

    expect(findClip(b)!.startSample).toBe(1000); // nudged to A's end
    expect(findClip(a)!.fadeOutSample).toBeUndefined();
    expect(findClip(b)!.fadeInSample).toBeUndefined();
  });

  it('repositioning an ARMED pair re-arms at the new width', () => {
    const a = seed({ startSample: 0, lengthSample: 1000 });
    const b = seed({ startSample: 5000, lengthSample: 1000 });
    useSessionStore.getState().moveClip(b, trackId(), 600); // armed at 400

    useSessionStore.getState().moveClip(b, trackId(), 800); // w becomes 200

    expect(findClip(a)!.fadeOutSample).toBe(200);
    expect(findClip(b)!.fadeInSample).toBe(200);
  });

  it('a HAND-BUILT canonical pair (setClipFade) is maintained exactly like a gesture-armed one', () => {
    const a = seed({ startSample: 0, lengthSample: 1000 });
    const b = seed({ startSample: 600, lengthSample: 1000 }); // raw overlap w=400
    useSessionStore.getState().setClipFade(a, 'out', { lengthSample: 400 });
    useSessionStore.getState().setClipFade(b, 'in', { lengthSample: 400 }); // now canonical

    useSessionStore.getState().moveClip(b, trackId(), 700); // w becomes 300

    expect(findClip(a)!.fadeOutSample).toBe(300);
    expect(findClip(b)!.fadeInSample).toBe(300);
  });
});

describe('trimClip maintenance — a trim never silently disarms a crossfade', () => {
  /** A canonical pair: A [0,1000) fadeOut 400 / B [600, 600+len) fadeIn 400. */
  function armedPair(bLen = 1000, bOffset = 300): { a: string; b: string } {
    const a = seed({ startSample: 0, lengthSample: 1000 });
    const b = seed({ startSample: 600, lengthSample: bLen, offsetSample: bOffset });
    useSessionStore.getState().setClipFade(a, 'out', { lengthSample: 400 });
    useSessionStore.getState().setClipFade(b, 'in', { lengthSample: 400 });
    return { a, b };
  }

  it('widening the overlap (incoming start trimmed earlier) re-arms both sides at the new width', () => {
    const { a, b } = armedPair();

    useSessionStore.getState().trimClip(b, 'start', 400); // B [400,1600): w = 600

    expect(findClip(a)!.fadeOutSample).toBe(600);
    expect(findClip(b)!.fadeInSample).toBe(600);
  });

  it('narrowing the overlap re-arms both sides at the new width', () => {
    const { a, b } = armedPair();

    useSessionStore.getState().trimClip(b, 'start', 800); // B [800,1600): w = 200

    expect(findClip(a)!.fadeOutSample).toBe(200);
    expect(findClip(b)!.fadeInSample).toBe(200);
  });

  it('trimming to an exact butt joint dissolves the pair; away fades survive', () => {
    const { a, b } = armedPair();
    useSessionStore.getState().setClipFade(a, 'in', { lengthSample: 50 });

    useSessionStore.getState().trimClip(b, 'start', 1000); // B [1000,1600): abutting, no overlap

    expect(findClip(a)!.fadeOutSample).toBeUndefined();
    expect(findClip(b)!.fadeInSample).toBeUndefined();
    expect(findClip(a)!.fadeInSample).toBe(50);
  });

  it('a trim that turns the handover into containment dissolves the pair', () => {
    const { a, b } = armedPair();

    useSessionStore.getState().trimClip(b, 'end', 900); // B [600,900) now inside A [0,1000)

    expect(findClip(a)!.fadeOutSample).toBeUndefined();
    expect(findClip(b)!.fadeInSample).toBeUndefined();
  });

  it('a re-arm vetoed by an away-side fade dissolves the pair instead of leaving stale widths', () => {
    const a = seed({ startSample: 0, lengthSample: 1000 });
    const b = seed({ startSample: 600, lengthSample: 1000, offsetSample: 300 });
    useSessionStore.getState().setClipFade(a, 'in', { lengthSample: 500 });
    useSessionStore.getState().setClipFade(a, 'out', { lengthSample: 400 }); // meets: 500+400 <= 1000
    useSessionStore.getState().setClipFade(b, 'in', { lengthSample: 400 }); // canonical at w=400

    useSessionStore.getState().trimClip(b, 'start', 300); // w becomes 700; 500+700 > 1000 on A

    expect(findClip(a)!.fadeOutSample).toBeUndefined(); // dissolved, not stale-armed
    expect(findClip(b)!.fadeInSample).toBeUndefined();
    expect(findClip(a)!.fadeInSample).toBe(500); // the standing fade that vetoed survives
  });

  it('an existing UN-armed overlap is a raw layering choice — a trim elsewhere does not arm it', () => {
    const a = seed({ startSample: 0, lengthSample: 1000 });
    const b = seed({ startSample: 600, lengthSample: 1000 }); // raw overlap, no fades

    useSessionStore.getState().trimClip(b, 'end', 1700); // away edge; overlap width unchanged

    expect(findClip(a)!.fadeOutSample).toBeUndefined();
    expect(findClip(b)!.fadeInSample).toBeUndefined();
  });

  it('pairs by startSample, not array position: arming works on an unsorted track (T40)', () => {
    const e = seed({ startSample: 1000, lengthSample: 2000 }); // [1000,3000)
    const l = seed({ startSample: 3100, lengthSample: 100, offsetSample: 2900 });
    // Start-trim far left: L becomes [200,3200) but STAYS at array index 1 —
    // the array is now [E(1000), L(200)], locally unsorted.
    useSessionStore.getState().trimClip(l, 'start', 200);
    expect(trackClips().map((c) => c.id)).toEqual([e, l]);
    const m = seed({ startSample: 9000, lengthSample: 500 });

    useSessionStore.getState().moveClip(m, trackId(), 3000); // [3000,3500) over L's tail: w=200

    expect(findClip(l)!.fadeOutSample).toBe(200);
    expect(findClip(m)!.fadeInSample).toBe(200);
    expect(findClip(e)!.fadeOutSample).toBeUndefined(); // E abuts the overlap, no intrusion, untouched
    expect(findClip(e)!.fadeInSample).toBeUndefined();
  });
});

describe('clearOverlap nudge on an unsorted track (T39 + T40)', () => {
  it('nudges clear of EVERY clip even when the array is not ascending', () => {
    // T39's counterexample, built through real store actions: E sits at array
    // index 0 with the LATER start after L is start-trimmed leftwards past it.
    const e = seed({ startSample: 1000, lengthSample: 4000 }); // [1000,5000)
    const l = seed({ startSample: 1200, lengthSample: 800, offsetSample: 800 }); // [1200,2000)
    useSessionStore.getState().trimClip(l, 'start', 400); // L [400,2000), still at index 1
    expect(trackClips().map((c) => c.id)).toEqual([e, l]);
    const m = seed({ startSample: 9000, lengthSample: 100 });

    useSessionStore.getState().moveClip(m, trackId(), 500, { clearOverlap: true });

    // An array-order scan tests E first (misses), then L pushes the candidate
    // to 2000 — INSIDE E. The ascending scan lands clear of both.
    expect(findClip(m)!.startSample).toBe(5000);
  });
});

describe('a gesture-armed crossfade reaches the renderer end-to-end', () => {
  function constDoc(id: string, value: number, length: number): AudioDocument {
    const doc = createDocument({
      name: id,
      sampleRate: 44100,
      channels: [new Float32Array(length).fill(value)],
    });
    return { ...doc, id };
  }

  function manualTrack(clips: Clip[]): Track {
    return {
      id: 'track-manual',
      name: 'T',
      volumeDb: 0,
      pan: 0,
      muted: false,
      solo: false,
      armed: false,
      clips,
    };
  }

  it('the mixdown of a drag-armed overlap is byte-identical to the canonical hand-built crossfade — and is not the raw sum', () => {
    const docs = new Map([['doc-1', constDoc('doc-1', 0.5, 2000)]]);
    const a = seed({ startSample: 0, lengthSample: 1000 });
    const b = seed({ startSample: 5000, lengthSample: 1000 });
    // equal-gain facing curves: at rho = 0 the equal-power pair is numerically
    // identical to raw solo fades (X1's documented property), so law
    // engagement is only observable with a non-equal-power curve.
    useSessionStore.getState().setClipFade(a, 'out', { curve: 'equal-gain' });
    useSessionStore.getState().setClipFade(b, 'in', { curve: 'equal-gain' });

    useSessionStore.getState().moveClip(b, trackId(), 600); // armed at w=400

    const gestureMix = mixdownSession(useSessionStore.getState().session, docs);

    // The same geometry with the canonical fades written LITERALLY — what
    // X3's contract says the gesture must leave behind.
    const canonical: Session = {
      name: 'S',
      sampleRate: 44100,
      tracks: [
        manualTrack([
          {
            id: 'ca', documentId: 'doc-1', startSample: 0, offsetSample: 0, lengthSample: 1000,
            gainDb: 0, fadeOutSample: 400, fadeOutCurve: 'equal-gain',
          },
          {
            id: 'cb', documentId: 'doc-1', startSample: 600, offsetSample: 0, lengthSample: 1000,
            gainDb: 0, fadeInSample: 400, fadeInCurve: 'equal-gain',
          },
        ]),
      ],
    };
    const canonicalMix = mixdownSession(canonical, docs);
    expect(Array.from(gestureMix.channels[0])).toEqual(Array.from(canonicalMix.channels[0]));
    expect(Array.from(gestureMix.channels[1])).toEqual(Array.from(canonicalMix.channels[1]));

    // And the law actually engaged: the overlap is NOT the raw fade-less sum.
    const raw: Session = {
      name: 'S',
      sampleRate: 44100,
      tracks: [
        manualTrack([
          { id: 'ra', documentId: 'doc-1', startSample: 0, offsetSample: 0, lengthSample: 1000, gainDb: 0 },
          { id: 'rb', documentId: 'doc-1', startSample: 600, offsetSample: 0, lengthSample: 1000, gainDb: 0 },
        ]),
      ],
    };
    const rawMix = mixdownSession(raw, docs);
    const midOverlap = 800; // middle of [600, 1000)
    expect(
      Math.abs(gestureMix.channels[0][midOverlap] - rawMix.channels[0][midOverlap])
    ).toBeGreaterThan(1e-3);
  });
});
