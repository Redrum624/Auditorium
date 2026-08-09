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

  it('an away fade that EXACTLY meets the new facing fade still arms (outgoing side, review round 1)', () => {
    // The veto boundary is `awayFade + width <= lengthSample`, and the
    // equality is legal by policy: setClipFade explicitly allows fades to
    // MEET (fadeIn + fadeOut === lengthSample) and X3 renders meeting fades.
    // 600 + 400 == 1000 must therefore arm — a `<` regression would silently
    // veto every exact-fit arm.
    const a = seed({ startSample: 0, lengthSample: 1000 });
    useSessionStore.getState().setClipFade(a, 'in', { lengthSample: 600 });
    const b = seed({ startSample: 5000, lengthSample: 1000 });

    useSessionStore.getState().moveClip(b, trackId(), 600); // w=400; 600 + 400 == 1000 exactly

    expect(findClip(a)!.fadeOutSample).toBe(400); // armed
    expect(findClip(b)!.fadeInSample).toBe(400);
    expect(findClip(a)!.fadeInSample).toBe(600); // the meeting away fade is untouched
  });

  it('an away fade that EXACTLY meets the new facing fade still arms (incoming side, review round 1)', () => {
    const a = seed({ startSample: 0, lengthSample: 1000 });
    const b = seed({ startSample: 5000, lengthSample: 1000 });
    useSessionStore.getState().setClipFade(b, 'out', { lengthSample: 600 });

    useSessionStore.getState().moveClip(b, trackId(), 600); // w=400; 600 + 400 == 1000 exactly

    expect(findClip(b)!.fadeInSample).toBe(400); // armed
    expect(findClip(a)!.fadeOutSample).toBe(400);
    expect(findClip(b)!.fadeOutSample).toBe(600); // the meeting away fade is untouched
  });

  it('an EQUAL-END pair is a handover, not containment — it arms and the renderer fires (review round 1)', () => {
    // Rule 2's boundary: containment is `aEnd > bEnd` STRICTLY — B starting
    // inside A with both ending on the same sample is crossfade-capable under
    // X3's ratified code, and is reachable by a plain drag. A `>=` regression
    // would silently drop every equal-end pair to a raw clamped sum; no other
    // fixture in the whole suite sits on this equality.
    const a = seed({ startSample: 0, lengthSample: 1000 });
    const b = seed({ startSample: 5000, lengthSample: 400 });

    useSessionStore.getState().moveClip(b, trackId(), 600); // B [600,1000): ends exactly with A

    expect(findClip(a)!.fadeOutSample).toBe(400);
    expect(findClip(b)!.fadeInSample).toBe(400);
    // Through the renderer's own gate too (the shared predicate feeds both).
    const specs = resolveClipFadeSpecs(trackClips());
    expect(specs.get(a)?.crossOut?.lengthSample).toBe(400);
    expect(specs.get(b)?.crossIn?.lengthSample).toBe(400);
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

describe('over-length facing fades — an un-armed layering a reposition must not overwrite', () => {
  // The armed-detect in preOverlapStates is EXACT on both members (rule 3):
  // a facing fade LONGER than the overlap is a legitimate un-armed state the
  // USER_GUIDE documents (dragging a handle past the overlap dissolves the
  // pair into honest solo fades). Reading it as armed would let a later
  // reposition re-arm the pair and SHRINK the user's standing fade — the
  // data-loss class maintainFacingFades forbids (clip mutations have no
  // undo). Below- and at-boundary siblings live in the describes around
  // this one; these two pin ABOVE the boundary, one per operand role.

  it('outgoing (a-side) fade longer than the overlap: a reposition leaves both fades untouched', () => {
    const a = seed({ startSample: 0, lengthSample: 1000 });
    const b = seed({ startSample: 5000, lengthSample: 1000 });
    useSessionStore.getState().moveClip(b, trackId(), 600); // armed at w=400
    // The USER_GUIDE dissolve gesture: A's fade-out handle dragged past the
    // overlap — 500 > w, the pair is no longer canonical.
    useSessionStore.getState().setClipFade(a, 'out', { lengthSample: 500 });

    useSessionStore.getState().moveClip(b, trackId(), 700); // reposition: w would be 300

    expect(findClip(a)!.fadeOutSample).toBe(500); // standing fade NOT shrunk
    expect(findClip(b)!.fadeInSample).toBe(400); // partner untouched, not re-armed at 300
  });

  it('incoming (b-side) fade longer than the overlap: a reposition leaves both fades untouched', () => {
    const a = seed({ startSample: 0, lengthSample: 1000 });
    const b = seed({ startSample: 5000, lengthSample: 1000 });
    useSessionStore.getState().moveClip(b, trackId(), 600); // armed at w=400
    useSessionStore.getState().setClipFade(b, 'in', { lengthSample: 500 }); // 500 > w: dissolved

    useSessionStore.getState().moveClip(b, trackId(), 700); // reposition: w would be 300

    expect(findClip(a)!.fadeOutSample).toBe(400); // partner untouched, not re-armed at 300
    expect(findClip(b)!.fadeInSample).toBe(500); // standing fade NOT shrunk
  });
});

describe('over-length stale fades — the disarm pass latent-pair guard is EXACT on both members', () => {
  // The disarm pass keeps an armed-but-intruded pair's fades ONLY while the
  // pair is still canonical by its own pair-only geometry (the latent-pair
  // guard in maintainFacingFades): removing the intruder must revive the
  // crossfade with no store write. That guard is exact PER MEMBER, like the
  // armed-detect and the renderer's rule 3 — a stale facing fade LONGER than
  // the current overlap is not latent, it is a dissolved pair, and BOTH
  // facing fades must clear so no mismatched pair lingers as surprise solo
  // fades. The corridor that puts one fade ABOVE the width with the partner
  // exact: an intruder blocks the re-arm (rule 4) while a trim of the pivot
  // clamps the pivot's facing fade to exactly the new width (its away-side
  // fade sits at the X2 meet boundary, fadeIn + fadeOut == length), leaving
  // the mate's fade above it. One fixture per operand role; the guard's
  // at-boundary (latent, kept) siblings are pinned in the intruder describes.

  it('stale outgoing (a-side) fade longer than the shrunk overlap: the disarm still clears both', () => {
    const a = seed({ startSample: 0, lengthSample: 1000 });
    const b = seed({ startSample: 5000, lengthSample: 1000 });
    useSessionStore.getState().moveClip(b, trackId(), 600); // armed at w=400
    // Away-side fade at the X2 meet boundary: 400 + 600 == B.length.
    useSessionStore.getState().setClipFade(b, 'out', { lengthSample: 600 });
    seed({ startSample: 900, lengthSample: 200 }); // intruder in [600,1000): rule 4 blocks re-arm

    // Trim B's start 600 -> 700: the fade re-clamp squeezes B.fadeIn to
    // 900 - 600 = 300 == the new pair-only width, while A.fadeOut stays 400
    // ABOVE it — the a-side comparison alone must reject the guard.
    useSessionStore.getState().trimClip(b, 'start', 700);

    expect(findClip(a)!.fadeOutSample).toBeUndefined(); // stale 400 cleared, not kept as latent
    expect(findClip(b)!.fadeInSample).toBeUndefined();
    expect(findClip(b)!.fadeOutSample).toBe(600); // away side untouched
  });

  it('stale incoming (b-side) fade longer than the shrunk overlap: the disarm still clears both', () => {
    const a = seed({ startSample: 0, lengthSample: 1000 });
    const b = seed({ startSample: 5000, lengthSample: 1000 });
    useSessionStore.getState().moveClip(b, trackId(), 600); // armed at w=400
    // Away-side fade at the X2 meet boundary: 600 + 400 == A.length.
    useSessionStore.getState().setClipFade(a, 'in', { lengthSample: 600 });
    seed({ startSample: 800, lengthSample: 200 }); // intruder in [600,1000): rule 4 blocks re-arm

    // Trim A's end 1000 -> 900: the fade re-clamp squeezes A.fadeOut to
    // 900 - 600 = 300 == the new pair-only width, while B.fadeIn stays 400
    // ABOVE it — the b-side comparison alone must reject the guard.
    useSessionStore.getState().trimClip(a, 'end', 900);

    expect(findClip(a)!.fadeOutSample).toBeUndefined();
    expect(findClip(b)!.fadeInSample).toBeUndefined(); // stale 400 cleared, not kept as latent
    expect(findClip(a)!.fadeInSample).toBe(600); // away side untouched
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

describe('removeClip disarming — deleting a member never strands the survivor`s facing fade (v1.9.1 item 4)', () => {
  it('deleting the INCOMING clip of an armed pair clears the outgoing survivor`s facing fade; away fades survive', () => {
    const a = seed({ startSample: 0, lengthSample: 1000 });
    const b = seed({ startSample: 5000, lengthSample: 1000 });
    useSessionStore.getState().setClipFade(a, 'in', { lengthSample: 50 }); // away-side on A
    useSessionStore.getState().setClipFade(b, 'out', { lengthSample: 60 }); // away-side on B
    useSessionStore.getState().moveClip(b, trackId(), 600); // arms: 50+400<=1000, 60+400<=1000
    expect(findClip(a)!.fadeOutSample).toBe(400);
    expect(findClip(b)!.fadeInSample).toBe(400);

    useSessionStore.getState().removeClip(b);

    // The survivor keeps NO stranded facing fade-out (the bug: it kept 400).
    expect(findClip(a)!.fadeOutSample).toBeUndefined();
    // The away-side fade on A is untouched.
    expect(findClip(a)!.fadeInSample).toBe(50);
    expect(findClip(b)).toBeUndefined();
  });

  it('deleting the OUTGOING clip of an armed pair clears the incoming survivor`s facing fade', () => {
    const a = seed({ startSample: 0, lengthSample: 1000 });
    const b = seed({ startSample: 5000, lengthSample: 1000 });
    useSessionStore.getState().moveClip(b, trackId(), 600); // armed at 400
    expect(findClip(a)!.fadeOutSample).toBe(400);
    expect(findClip(b)!.fadeInSample).toBe(400);

    useSessionStore.getState().removeClip(a);

    expect(findClip(b)!.fadeInSample).toBeUndefined();
    expect(findClip(a)).toBeUndefined();
  });

  it('deleting an UNRELATED clip leaves an armed crossfade untouched (no false disarm)', () => {
    const a = seed({ startSample: 0, lengthSample: 1000 });
    const b = seed({ startSample: 5000, lengthSample: 1000 });
    useSessionStore.getState().moveClip(b, trackId(), 600); // armed at 400
    const d = seed({ startSample: 20000, lengthSample: 1000 }); // no overlap with a/b

    useSessionStore.getState().removeClip(d);

    expect(findClip(a)!.fadeOutSample).toBe(400);
    expect(findClip(b)!.fadeInSample).toBe(400);
    // The renderer still sees a live crossfade.
    const specs = resolveClipFadeSpecs(trackClips());
    expect(specs.get(a)?.crossOut?.lengthSample).toBe(400);
    expect(specs.get(b)?.crossIn?.lengthSample).toBe(400);
  });
});

describe('X4 — carried X5 findings: intruded armed pairs, and the fade-UI recovery path', () => {
  /** Arms A[0,1000) / B[600,1600) at width 400 through the real gesture, then
   * lands an intruder C inside the overlap region via addClip (the punch-in /
   * Insert Active File path — the only way an armed pair gets intruded
   * without the gesture maintenance seeing it happen). */
  function armThenIntrude(): { a: string; b: string; c: string } {
    const a = seed({ startSample: 0, lengthSample: 1000 });
    const b = seed({ startSample: 5000, lengthSample: 1000 });
    useSessionStore.getState().moveClip(b, trackId(), 600); // arms at w=400
    expect(findClip(a)!.fadeOutSample).toBe(400);
    const c = seed({ startSample: 700, lengthSample: 60 }); // [700,760) inside [600,1000)
    // addClip writes no fades and the renderer silences the pair (rule 4).
    expect(findClip(a)!.fadeOutSample).toBe(400);
    expect(resolveClipFadeSpecs(trackClips()).get(a)?.crossOut ?? null).toBeNull();
    return { a, b, c };
  }

  it('moving a member of an INTRUDED armed pair away disarms both facing fades (X5 finding 2)', () => {
    const { a, b } = armThenIntrude();

    useSessionStore.getState().moveClip(a, trackId(), 5000); // far clear of B and C

    // Before the fix the pre-gesture snapshot read the intruded pair as
    // not-armed (rule 4 in the armed test), skipped the disarm, and B kept a
    // 400-sample fade-in as a surprise solo fade.
    expect(findClip(a)!.fadeOutSample).toBeUndefined();
    expect(findClip(b)!.fadeInSample).toBeUndefined();
  });

  it('a start-trim that leaves an intruded pair still exactly spanning preserves it (latent crossfade)', () => {
    const { a, b, c } = armThenIntrude();

    // Trim A's start: A's END does not move, so the overlap [600,1000) and
    // its width 400 are unchanged; the arm pass cannot re-arm (rule 4), and
    // the disarm must NOT treat the still-exact pair as stale.
    useSessionStore.getState().trimClip(a, 'start', 100);

    expect(findClip(a)!.fadeOutSample).toBe(400);
    expect(findClip(b)!.fadeInSample).toBe(400);
    // Removing the intruder revives the crossfade with no store write — the
    // pinned X5 behaviour this guard exists to protect.
    useSessionStore.getState().removeClip(c);
    const specs = resolveClipFadeSpecs(trackClips());
    expect(specs.get(a)?.crossOut?.lengthSample).toBe(400);
    expect(specs.get(b)?.crossIn?.lengthSample).toBe(400);
  });

  it('an edit that CHANGES an intruded pair`s overlap width clears the now-stale fades', () => {
    const { a, b } = armThenIntrude();

    // Trim A's end from 1000 to 900: overlap narrows to [600,900), w=300 —
    // the stored 400s no longer span it, the arm pass cannot re-arm (C still
    // intrudes [700,760)), so both facing fades are stale and must clear.
    useSessionStore.getState().trimClip(a, 'end', 900);

    expect(findClip(a)!.fadeOutSample).toBeUndefined();
    expect(findClip(b)!.fadeInSample).toBeUndefined();
  });

  it('a flipped-orientation re-arm at the SAME width still clears the stale opposite edges', () => {
    // No intruder here: this pins the latent guard's ORIENTATION term. A
    // [0,1000) armed with B [600,1600) at w=400; moving A to 1200 flips the
    // pair (B outgoing, A incoming) at the SAME width 400 — the stale
    // A.fadeOut/B.fadeIn match that width numerically and would survive a
    // guard that ignored orientation.
    const a = seed({ startSample: 0, lengthSample: 1000 });
    const b = seed({ startSample: 5000, lengthSample: 1000 });
    useSessionStore.getState().moveClip(b, trackId(), 600);
    expect(findClip(a)!.fadeOutSample).toBe(400);
    expect(findClip(b)!.fadeInSample).toBe(400);

    useSessionStore.getState().moveClip(a, trackId(), 1200); // A [1200,2200) over B's tail [600,1600): flipped pair, width 400 again

    expect(findClip(b)!.fadeOutSample).toBe(400); // new outgoing edge, armed
    expect(findClip(a)!.fadeInSample).toBe(400); // new incoming edge, armed
    expect(findClip(a)!.fadeOutSample).toBeUndefined(); // stale edge cleared
    expect(findClip(b)!.fadeInSample).toBeUndefined(); // stale edge cleared
  });

  it('the fade-UI arm path makes a raw addClip overlap drag-maintainable (X5 finding 1)', () => {
    // A raw overlap born from addClip (punch-in semantics): eligibility
    // requires pre-width 0 or already-armed, so no drag can EVER arm it —
    // the recovery is the fade UI writing both facing fades to the exact
    // width through setClipFade (what the panel's Arm button does).
    const a = seed({ startSample: 0, lengthSample: 1000 });
    const b = seed({ startSample: 600, lengthSample: 1000 }); // raw overlap, w=400
    useSessionStore.getState().moveClip(b, trackId(), 600); // same-position move: still not armable
    expect(findClip(b)!.fadeInSample).toBeUndefined(); // eligibility refuses (raw pair)

    useSessionStore.getState().setClipFade(a, 'out', { lengthSample: 400 });
    useSessionStore.getState().setClipFade(b, 'in', { lengthSample: 400 });

    // The renderer now crossfades it…
    const specs = resolveClipFadeSpecs(trackClips());
    expect(specs.get(a)?.crossOut?.lengthSample).toBe(400);
    expect(specs.get(b)?.crossIn?.lengthSample).toBe(400);

    // …and the pair is armed for the maintenance from now on: a drag that
    // reshapes the overlap re-arms at the new width instead of refusing.
    useSessionStore.getState().moveClip(b, trackId(), 700); // w becomes 300
    expect(findClip(a)!.fadeOutSample).toBe(300);
    expect(findClip(b)!.fadeInSample).toBe(300);
  });
});
