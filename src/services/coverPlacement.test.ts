/**
 * CC3 — the refused guess, made actionable.
 *
 * What this file exists to prove, in the order the user meets it:
 *  - the refusal's remedy names the clip that CAN move (a clip cannot start
 *    before zero, so a negative guess is only reachable by moving the
 *    INSTRUMENTAL) and never names Align Vocal Timing, which cannot move a
 *    clip at all;
 *  - the measured guess is one call away from being realised, through the
 *    SAME both-track-shift arithmetic the confident arm uses, as ONE undo
 *    entry, with the journey's own edge fades and a cursor the user can press
 *    play at;
 *  - the CC2 outcome fields are read DEFENSIVELY: absent on today's shape,
 *    honoured when present, and never invented.
 */

import { createDocument, type AudioDocument } from '../audio/AudioDocument';
import { createClip, createTrack, DEFAULT_FADE_CURVE, type Session } from '../multitrack/session';
import { useSessionStore } from '../multitrack/sessionStore';
import { clearSessionHistory, undoSession } from '../multitrack/sessionUndo';
import { getHistory } from './undoHistory';
import { SESSION_UNDO_KEY } from '../multitrack/sessionUndo';
import { useAppStore, makeInitialState } from '../stores/appStore';
import { JOURNEY_FADE_MS } from './coverJourney';
import {
  APPLY_GUESS_LABEL,
  APPLY_GUESS_UNDO_LABEL,
  applyMeasuredOffset,
  autoPlaces,
  CANDIDATE_PLACEMENT_LABEL,
  guessCandidates,
  guessCharacterisation,
  guessKind,
  guessRemedy,
  offersOtherLags,
  placedRemedy,
  placementFor,
} from './coverPlacement';

const SR = 8000;
const TAKE_SAMPLES = SR * 6;
const SONG_SAMPLES = SR * 8;

let instrumental: AudioDocument;
let take: AudioDocument;
let instrumentalClipId = '';
let takeClipId = '';

function seedCoverSession(): void {
  useAppStore.setState(makeInitialState());
  instrumental = createDocument({
    name: 'song.wav — Instrumental',
    sampleRate: SR,
    channels: [new Float32Array(SONG_SAMPLES), new Float32Array(SONG_SAMPLES)],
  });
  take = createDocument({
    name: 'take.wav',
    sampleRate: SR,
    channels: [new Float32Array(TAKE_SAMPLES)],
  });
  useAppStore.getState().addDocument(instrumental);
  useAppStore.getState().addDocument(take);

  const instrumentalTrack = createTrack('Instrumental');
  const instrumentalClip = createClip({
    documentId: instrumental.id,
    startSample: 0,
    offsetSample: 0,
    lengthSample: SONG_SAMPLES,
  });
  instrumentalTrack.clips = [instrumentalClip];
  instrumentalClipId = instrumentalClip.id;

  const takeTrack = createTrack('Cover Vocal');
  const takeClip = createClip({
    documentId: take.id,
    startSample: 0,
    offsetSample: 0,
    lengthSample: TAKE_SAMPLES,
  });
  takeTrack.clips = [takeClip];
  takeClipId = takeClip.id;

  const session: Session = {
    name: 'song.wav — Cover',
    sampleRate: SR,
    tracks: [instrumentalTrack, takeTrack],
  };
  useSessionStore.setState({ session, selectedClipId: null, mtCursorSample: 0, mtPlayheadSample: 0 });
  clearSessionHistory();
}

function clipById(id: string) {
  for (const t of useSessionStore.getState().session.tracks) {
    const c = t.clips.find((x) => x.id === id);
    if (c) return c;
  }
  return null;
}

beforeEach(() => {
  seedCoverSession();
});

// ── The remedy sentence ─────────────────────────────────────────────────────

describe('guessRemedy — the sentence a refused guess ends with', () => {
  it('sends a NEGATIVE guess to the instrumental, with the amount and the reason', () => {
    const remedy = guessRemedy(-8.258, false);
    expect(remedy).toContain('Instrumental');
    expect(remedy).toContain('8.258 s');
    expect(remedy).toContain('later');
    // The WHY, because the instruction is counter-intuitive: the take is the
    // clip the user thinks of moving, and it is the one that cannot.
    expect(remedy).toContain('cannot start before zero');
    // The take must not be offered as the thing to drag for this sign.
    expect(remedy).not.toMatch(/drag (your|the) take/i);
  });

  it('sends a POSITIVE guess to the take, with the amount', () => {
    const remedy = guessRemedy(8.258, false);
    expect(remedy).toContain('take');
    expect(remedy).toContain('8.258 s');
    expect(remedy).not.toContain('Instrumental');
  });

  it('never recommends Align Vocal Timing, which cannot move a clip at all', () => {
    for (const offset of [-8.258, 8.258, 0]) {
      expect(guessRemedy(offset, false)).not.toContain('Align Vocal Timing');
    }
  });

  it('names the one-click control by the label the button actually carries', () => {
    expect(guessRemedy(-8.258, false)).toContain(APPLY_GUESS_LABEL);
    expect(guessRemedy(8.258, false)).toContain(APPLY_GUESS_LABEL);
  });

  it('says there is nothing to move when the guess is already zero', () => {
    const remedy = guessRemedy(0, false);
    expect(remedy).toContain('already');
    expect(remedy).not.toContain(APPLY_GUESS_LABEL);
  });

  // Which one-click control exists is not a constant: a measurement carrying
  // candidate lags renders one row per candidate INSTEAD of the single button,
  // so the sentence has to name the rows there or it names nothing on screen.
  it('names the candidate rows, not the button they replace, when the rows are what render', () => {
    for (const offset of [-8.258, 8.258]) {
      const remedy = guessRemedy(offset, true);
      expect(remedy).toContain(CANDIDATE_PLACEMENT_LABEL);
      expect(remedy).not.toContain(APPLY_GUESS_LABEL);
      // The by-hand half is untouched by this: it is about the measured lag,
      // which is the first of the rows, and it is right on both arms.
      expect(remedy).toContain('8.258 s');
    }
  });

  it('points at the rows from the zero guess too, and at nothing when there are none', () => {
    const withRows = guessRemedy(0, true);
    expect(withRows).toContain('already');
    expect(withRows).toContain(CANDIDATE_PLACEMENT_LABEL);
    expect(guessRemedy(0, false)).not.toContain(CANDIDATE_PLACEMENT_LABEL);
  });
});

// ── The CC2 outcome contract, feature-detected ──────────────────────────────

describe('guessKind / guessCandidates — read defensively, never invented', () => {
  it('reports `unclassified` for a non-confident measurement with no outcome field', () => {
    expect(guessKind({ confident: false })).toBe('unclassified');
    expect(guessKind({ confident: true })).toBe('confident');
  });

  it('honours the outcome field when the measurement carries one', () => {
    expect(guessKind({ confident: false, outcome: 'ambiguous' })).toBe('ambiguous');
    expect(guessKind({ confident: false, outcome: 'weak' })).toBe('weak');
    expect(guessKind({ confident: false, outcome: 'unrelated' })).toBe('unrelated');
    expect(guessKind({ confident: true, outcome: 'confident' })).toBe('confident');
  });

  it('ignores an outcome value it does not recognise rather than trusting it', () => {
    expect(guessKind({ confident: false, outcome: 'sideways' })).toBe('unclassified');
  });

  it('returns no candidates when the field is absent, and the listed ones when it is', () => {
    expect(guessCandidates({ confident: false })).toEqual([]);
    expect(
      guessCandidates({
        confident: false,
        candidates: [
          { offsetSeconds: -8.258, correlation: 0.423, prominence: 0.079 },
          { offsetSeconds: 12.5, correlation: 0.41, prominence: 0.06 },
        ],
      })
    ).toEqual([
      { offsetSeconds: -8.258, correlation: 0.423, prominence: 0.079 },
      { offsetSeconds: 12.5, correlation: 0.41, prominence: 0.06 },
    ]);
  });

  it('drops a candidate whose numbers are not all finite rather than showing a hole', () => {
    expect(
      guessCandidates({
        confident: false,
        candidates: [
          { offsetSeconds: -8.258, correlation: 0.423, prominence: 0.079 },
          { offsetSeconds: Number.NaN, correlation: 0.4, prominence: 0.1 },
          { offsetSeconds: 3, correlation: 0.4 },
          'nonsense',
        ],
      })
    ).toEqual([{ offsetSeconds: -8.258, correlation: 0.423, prominence: 0.079 }]);
  });

  it('characterises each known outcome and stays silent about the unclassified one', () => {
    expect(guessCharacterisation('ambiguous')).toContain('several places');
    expect(guessCharacterisation('weak')).toContain('weak but plausible');
    expect(guessCharacterisation('unrelated')).toContain('probably wrong');
    expect(guessCharacterisation('unclassified')).toBeNull();
    expect(guessCharacterisation('confident')).toBeNull();
  });
});

// ── V3: what the pass does with a guess, rather than what it says about it ───

/**
 * V3. The user's directive was one sentence — "it should place the tracks by
 * itself!" — and this predicate is where it lives, so the journey that places
 * and the dialog that describes the placement cannot come to two different
 * opinions about which run was placed.
 */
describe('autoPlaces — which outcomes this pass places on the user\'s behalf', () => {
  it('places the two outcomes that carry a usable guess', () => {
    expect(autoPlaces('weak')).toBe(true);
    expect(autoPlaces('ambiguous')).toBe(true);
  });

  it('does NOT place noise, and does not place a measurement that said nothing', () => {
    // 'unrelated' means no arm distinguished the take from the measured
    // unrelated band. Placing that would be the app guessing where it has just
    // said it has no guess — which is not what "place it yourself" asked for.
    expect(autoPlaces('unrelated')).toBe(false);
    // …and a measurement with no outcome word asserted nothing about itself, so
    // nothing may be asserted on its behalf either.
    expect(autoPlaces('unclassified')).toBe(false);
  });

  it('is not the confident arm in disguise', () => {
    // 'confident' is placed by the believed arm, which existed before this
    // predicate and does not consult it.
    expect(autoPlaces('confident')).toBe(false);
  });
});

describe('placedRemedy — the sentence an AUTO-PLACED guess ends with', () => {
  /** The emitter's own shape: best first, and `candidates[0].offsetSeconds ===
   * offsetSeconds`. The rival's lag is a guard away and its numbers are lower,
   * exactly as `candidatesOf` walks them. */
  const rivals = (offsetSeconds: number) => [
    { offsetSeconds, correlation: 0.423, prominence: 0.079 },
    { offsetSeconds: offsetSeconds + 4.2, correlation: 0.41, prominence: 0.06 },
  ];
  /** T3 (MIN-1). The same emission with the rivals gone — one row, and it is
   * the lag the take was placed on. */
  const winnerOnly = (offsetSeconds: number) => rivals(offsetSeconds).slice(0, 1);
  const none: ReturnType<typeof rivals> = [];

  it('states where the take was put, in the amount and sign that were measured', () => {
    const placed = placedRemedy(-8.257, rivals(-8.257));
    expect(placed).toContain('8.257 s');
    // The negative arm is the reported case, and the thing worth saying about it
    // is that both clips moved rather than the take being clamped away.
    expect(placed).toContain('both');
    // It does NOT tell the user to drag anything: it already moved them.
    expect(placedRemedy(-8.257, rivals(-8.257))).not.toMatch(/drag the Instrumental/i);
    expect(placedRemedy(8.257, rivals(8.257))).not.toMatch(/drag your take/i);
  });

  it('offers the alternatives by the label the rows actually carry', () => {
    for (const offset of [-8.257, 8.257, 0]) {
      const placed = placedRemedy(offset, rivals(offset));
      expect(placed).toContain(CANDIDATE_PLACEMENT_LABEL);
      expect(placed).not.toContain(APPLY_GUESS_LABEL);
    }
  });

  // The same seam the refusal sentence has: the dialog swaps the rows for the
  // single button whenever the measurement lists no candidate, so this sentence
  // branches on exactly the fact the render branches on.
  it('names the single button when there are no rows to point at', () => {
    for (const offset of [-8.257, 8.257]) {
      const placed = placedRemedy(offset, none);
      expect(placed).toContain(APPLY_GUESS_LABEL);
      expect(placed).not.toContain(CANDIDATE_PLACEMENT_LABEL);
    }
  });

  // T3 (MIN-1). The middle state, which had no branch of its own and took the
  // rows branch: one candidate, and it is the lag the take is already on. The
  // sentence promised "these other lags matched too" over it while the dialog's
  // paragraph one line above told the user to drag a clip — two thresholds,
  // one screen, opposite advice.
  it('promises no OTHER lags when the only row is the lag it placed on', () => {
    for (const offset of [-8.257, 8.257, 0]) {
      const placed = placedRemedy(offset, winnerOnly(offset));
      expect(placed).not.toMatch(/other lags/i);
      // …and it still points at the control that IS rendered. A single
      // candidate renders a row, not the button, so naming the button here
      // would trade this defect for the seam defect the arm was built to close.
      expect(placed).toContain(CANDIDATE_PLACEMENT_LABEL);
      expect(placed).not.toContain(APPLY_GUESS_LABEL);
    }
  });

  it('says the take did not move when the measured lag was zero', () => {
    expect(placedRemedy(0, rivals(0))).toContain('already');
  });
});

// T3 (MIN-1). The predicate both sides of the seam now ask, pinned on the three
// list lengths a real emission produces — and on WHY the middle one is false:
// `candidates[0]` is the lag the take is on, so one row is no alternative.
describe('offersOtherLags — whether a placed take has anywhere else to go', () => {
  const at = (offsetSeconds: number) => ({ offsetSeconds, correlation: 0.4, prominence: 0.05 });

  it('is false for no candidates and for the winner alone, true once a rival survives', () => {
    expect(offersOtherLags([])).toBe(false);
    expect(offersOtherLags([at(-8.258)])).toBe(false);
    expect(offersOtherLags([at(-8.258), at(-4.058)])).toBe(true);
  });
});

// ── The shift arithmetic, in ONE place ──────────────────────────────────────

/**
 * Fix round 1 (I2). Both the believed arm's session build and the apply-the-
 * guess arm have to turn a signed offset into two clip starts, and until this
 * function they each did it themselves with a comment pointing at the other.
 * Nothing bound them, and the Place stage is a concurrent task's surface — so
 * a change there would have left the offered guess landing somewhere a
 * believed alignment would not have put it.
 */
describe('placementFor — the one place a signed offset becomes two clip starts', () => {
  it('moves only the take for a positive offset', () => {
    expect(placementFor(1.25, SR)).toEqual({
      rawTakeStartSample: Math.round(1.25 * SR),
      shiftedSamples: 0,
      takeStartSample: Math.round(1.25 * SR),
      instrumentalStartSample: 0,
    });
  });

  it('pushes BOTH clips later for a negative offset rather than clamping the take', () => {
    const shift = Math.round(8.258 * SR);
    expect(placementFor(-8.258, SR)).toEqual({
      rawTakeStartSample: -shift,
      shiftedSamples: shift,
      takeStartSample: 0,
      instrumentalStartSample: shift,
    });
  });

  it('keeps the measured interval whatever the sign, which is what the shift is for', () => {
    for (const offset of [-8.258, -0.75, 0, 0.5, 12.5]) {
      const p = placementFor(offset, SR);
      expect(p.takeStartSample - p.instrumentalStartSample).toBe(Math.round(offset * SR));
      expect(p.takeStartSample).toBeGreaterThanOrEqual(0);
      expect(p.instrumentalStartSample).toBeGreaterThanOrEqual(0);
    }
  });

  it('rounds to the SESSION rate it was handed, not the take\'s', () => {
    expect(placementFor(0.5, 16000).takeStartSample).toBe(8000);
    expect(placementFor(0.5, SR).takeStartSample).toBe(4000);
  });
});

// ── Applying the guess ──────────────────────────────────────────────────────

describe('applyMeasuredOffset — the user\'s own −8.258 s case', () => {
  it('shifts BOTH tracks for a negative guess rather than clamping the take to zero', () => {
    const result = applyMeasuredOffset({
      offsetSeconds: -8.258,
      instrumentalDocId: instrumental.id,
      takeDocId: take.id,
    });
    expect(result.applied).toBe(true);
    if (!result.applied) return;

    const shift = Math.round(8.258 * SR);
    expect(result.shiftedSamples).toBe(shift);
    expect(result.takeStartSample).toBe(0);
    expect(result.instrumentalStartSample).toBe(shift);

    // The store agrees with the report — this is the placement, not a summary.
    expect(clipById(takeClipId)!.startSample).toBe(0);
    expect(clipById(instrumentalClipId)!.startSample).toBe(shift);
    // …and the INTERVAL between the two is exactly what was measured.
    expect(clipById(takeClipId)!.startSample - clipById(instrumentalClipId)!.startSample).toBe(
      -shift
    );
  });

  it('leaves the instrumental at zero and moves only the take for a positive guess', () => {
    const result = applyMeasuredOffset({
      offsetSeconds: 1.25,
      instrumentalDocId: instrumental.id,
      takeDocId: take.id,
    });
    expect(result.applied).toBe(true);
    if (!result.applied) return;
    expect(result.shiftedSamples).toBe(0);
    expect(result.takeStartSample).toBe(Math.round(1.25 * SR));
    expect(clipById(instrumentalClipId)!.startSample).toBe(0);
    expect(clipById(takeClipId)!.startSample).toBe(Math.round(1.25 * SR));
  });

  it('fades the take\'s edges with the journey\'s own fade, on the negative case', () => {
    const result = applyMeasuredOffset({
      offsetSeconds: -8.258,
      instrumentalDocId: instrumental.id,
      takeDocId: take.id,
    });
    expect(result.applied).toBe(true);
    if (!result.applied) return;
    const nominal = Math.round((JOURNEY_FADE_MS / 1000) * SR);
    expect(result.fadeInSample).toBe(nominal);
    expect(result.fadeOutSample).toBe(nominal);
    const clip = clipById(takeClipId)!;
    expect(clip.fadeInSample).toBe(nominal);
    expect(clip.fadeOutSample).toBe(nominal);
    expect(clip.fadeInCurve).toBe(DEFAULT_FADE_CURVE);
    expect(clip.fadeOutCurve).toBe(DEFAULT_FADE_CURVE);
  });

  it('parks the cursor and playhead where the take now enters, on the negative case', () => {
    applyMeasuredOffset({
      offsetSeconds: -8.258,
      instrumentalDocId: instrumental.id,
      takeDocId: take.id,
    });
    const s = useSessionStore.getState();
    // The take starts at 0 for a negative guess, and that IS where it enters.
    expect(s.mtCursorSample).toBe(0);
    expect(s.mtPlayheadSample).toBe(0);
  });

  it('parks the cursor at the take\'s entry for a positive guess too', () => {
    applyMeasuredOffset({
      offsetSeconds: 1.25,
      instrumentalDocId: instrumental.id,
      takeDocId: take.id,
    });
    const s = useSessionStore.getState();
    expect(s.mtCursorSample).toBe(Math.round(1.25 * SR));
    expect(s.mtPlayheadSample).toBe(Math.round(1.25 * SR));
  });

  it('leaves ONE undo entry for the whole gesture, and undoing it restores both clips', () => {
    applyMeasuredOffset({
      offsetSeconds: -8.258,
      instrumentalDocId: instrumental.id,
      takeDocId: take.id,
    });
    expect(getHistory(SESSION_UNDO_KEY).done).toEqual([APPLY_GUESS_UNDO_LABEL]);

    undoSession();
    expect(clipById(instrumentalClipId)!.startSample).toBe(0);
    expect(clipById(takeClipId)!.startSample).toBe(0);
    expect(clipById(takeClipId)!.fadeInSample).toBeUndefined();
  });

  it('refuses, with a reason, when one of the two clips is no longer in the session', () => {
    useSessionStore.setState((prev) => ({
      session: { ...prev.session, tracks: [prev.session.tracks[0]] },
    }));
    const result = applyMeasuredOffset({
      offsetSeconds: -8.258,
      instrumentalDocId: instrumental.id,
      takeDocId: take.id,
    });
    expect(result.applied).toBe(false);
    if (result.applied) return;
    expect(result.reason).toContain('take');
    // Nothing moved.
    expect(clipById(instrumentalClipId)!.startSample).toBe(0);
    expect(getHistory(SESSION_UNDO_KEY).done).toEqual([]);
  });

  it('refuses a guess that is not a finite number rather than placing at NaN', () => {
    const result = applyMeasuredOffset({
      offsetSeconds: Number.NaN,
      instrumentalDocId: instrumental.id,
      takeDocId: take.id,
    });
    expect(result.applied).toBe(false);
    expect(clipById(takeClipId)!.startSample).toBe(0);
  });
});
