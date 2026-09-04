import { createDocument, type AudioDocument } from '../audio/AudioDocument';
import type { AutomationLane } from './automation';
import { bakeMergedClip, commitMergedClips, mergeTargets } from './mergeClips';
import {
  clipFadeGainAt,
  dbToLinear,
  mixdownSession,
  monoPanGains,
  readClipSlice,
  resolveClipFadeSpecs,
  stereoBalanceGains,
} from './mixdown';
import { createClip, createTrack, type Clip, type Session, type Track } from './session';
import { applySessionZoom, useSessionStore } from './sessionStore';
import { fitSessionSamplesPerPixel } from './sessionZoom';
import {
  SESSION_UNDO_KEY,
  _resetSessionUndo,
  canUndoSession,
  redoSession,
  undoSession,
} from './sessionUndo';
import { getHistory } from '../services/undoHistory';

/**
 * Merge Clips, Task 1 — the pure core (`mergeTargets`, `bakeMergedClip`) and
 * the session write (`commitMergedClips`), against design rulings D1-D5.
 *
 * The load-bearing claims, each pinned below: only a track with TWO OR MORE
 * selected clips merges, and the span is `[min start, max end)` even under
 * containment (D1); the bake is the renderer's own per-clip math — slice ×
 * `dbToLinear(gainDb)` × `clipFadeGainAt` resolved over the WHOLE track, so an
 * armed crossfade between two members bakes AS the crossfade (D2); a mono
 * member landing in a stereo merge is scaled by `Math.SQRT1_2`, the ratio the
 * two pan laws differ by at centre (D3); the write is one
 * `withSessionGesture('Merge clips')` around the store's own `removeClip` /
 * `addClip`, so an outsider's facing fade is disarmed by the store's existing
 * maintenance rather than by anything here (D4); and the primary after the act
 * is the merge on the track that held the previous primary (D5).
 */

const SR = 44100;

const store = () => useSessionStore.getState();
const sessionRef = () => useSessionStore.getState().session;
const trackClips = (i = 0): Clip[] => sessionRef().tracks[i].clips;
const doneLabels = () => getHistory(SESSION_UNDO_KEY).done;

/** Builds a clip field by field — the geometry cases need offsets, gains and
 * fades the `createClip` signature does not carry. */
function makeClip(
  fields: Partial<Clip> & { documentId: string; startSample: number; lengthSample: number }
): Clip {
  const base = createClip({
    documentId: fields.documentId,
    startSample: fields.startSample,
    offsetSample: fields.offsetSample ?? 0,
    lengthSample: fields.lengthSample,
    gainDb: fields.gainDb,
  });
  return { ...base, ...fields, id: base.id };
}

function makeTrack(name: string, clips: Clip[]): Track {
  const t = createTrack(name);
  t.clips = clips;
  return t;
}

function makeSession(tracks: Track[], sampleRate = SR): Session {
  return { name: 'Merge Fixture', sampleRate, tracks };
}

/** Installs a session (raw setState — test setup is a load, not a mutation). */
function install(tracks: Track[], sampleRate = SR): void {
  useSessionStore.setState({
    session: makeSession(tracks, sampleRate),
    selectedClipId: null,
    selectedClipIds: [],
    mtCursorSample: 0,
    mtPlayState: 'stopped',
    mtPlayheadSample: 0,
    mtEnvelope: null,
  });
}

function ramp(n: number, f: (i: number) => number): Float32Array {
  const a = new Float32Array(n);
  for (let i = 0; i < n; i++) a[i] = f(i);
  return a;
}

function makeDoc(channels: Float32Array[], sampleRate = SR): AudioDocument {
  return createDocument({ name: 'Fixture', sampleRate, channels });
}

function docMap(...docs: AudioDocument[]): Map<string, AudioDocument> {
  return new Map(docs.map((d) => [d.id, d]));
}

/** The largest |a[i] - b[i]| over `n` samples — reported as a number so a
 * failure says HOW far off the render is, not merely that it is. */
function maxDiff(a: ArrayLike<number>, b: ArrayLike<number>, n: number, from = 0): number {
  let m = 0;
  for (let i = 0; i < n; i++) m = Math.max(m, Math.abs(a[from + i] - b[i]));
  return m;
}

const lane = (): AutomationLane[] => [
  { param: 'volumeDb', keys: [{ positionSample: 0, value: -3 }] },
];

beforeEach(() => {
  _resetSessionUndo();
});

// ---------------------------------------------------------------------------
// D1 — which clips merge, and over what span
// ---------------------------------------------------------------------------
describe('mergeTargets — D1', () => {
  it('takes only the track with two or more selected clips, members ascending by start', () => {
    const a = makeClip({ documentId: 'doc-1', startSample: 2400, offsetSample: 90, lengthSample: 600 });
    const b = makeClip({ documentId: 'doc-1', startSample: 800, offsetSample: 40, lengthSample: 500 });
    const lonely = makeClip({ documentId: 'doc-2', startSample: 1700, offsetSample: 10, lengthSample: 300 });
    // The TRACK ARRAY is descending by start too — not a contrived state:
    // `trimClip('start')` writes in place without re-sorting, so clip order is
    // explicitly not an invariant (trap T40). Members come from a `filter` over
    // this array, so only the sort can put the span origin at 800.
    const session = makeSession([makeTrack('Track 1', [a, b]), makeTrack('Track 2', [lonely])]);

    // Selected in REVERSE order too: the target must sort by startSample, not
    // by the order the user clicked nor by the track's array order.
    const targets = mergeTargets(session, [lonely.id, a.id, b.id]);

    expect(targets).toHaveLength(1);
    expect(targets[0].trackId).toBe(session.tracks[0].id);
    expect(targets[0].members.map((c) => c.id)).toEqual([b.id, a.id]);
    expect(targets[0].startSample).toBe(800);
    expect(targets[0].lengthSample).toBe(3000 - 800);
  });

  it('yields one target per qualifying track, in session track order', () => {
    const t1 = makeTrack('Track 1', [
      makeClip({ documentId: 'doc-1', startSample: 1000, offsetSample: 25, lengthSample: 400 }),
      makeClip({ documentId: 'doc-1', startSample: 2000, offsetSample: 75, lengthSample: 700 }),
    ]);
    const t2 = makeTrack('Track 2', [
      makeClip({ documentId: 'doc-2', startSample: 300, offsetSample: 15, lengthSample: 250 }),
      makeClip({ documentId: 'doc-2', startSample: 900, offsetSample: 35, lengthSample: 450 }),
    ]);
    const session = makeSession([t1, t2]);

    const targets = mergeTargets(
      session,
      // Track 2's ids first — track order must come from the session, not the selection.
      [t2.clips[1].id, t2.clips[0].id, t1.clips[0].id, t1.clips[1].id]
    );

    expect(targets.map((t) => t.trackId)).toEqual([t1.id, t2.id]);
    expect(targets[0]).toMatchObject({ startSample: 1000, lengthSample: 1700 });
    expect(targets[1]).toMatchObject({ startSample: 300, lengthSample: 1050 });
  });

  it('skips ids the session does not carry, and leaves a track holding only one of them alone', () => {
    const t1 = makeTrack('Track 1', [
      makeClip({ documentId: 'doc-1', startSample: 1000, offsetSample: 25, lengthSample: 400 }),
      makeClip({ documentId: 'doc-1', startSample: 2000, offsetSample: 75, lengthSample: 700 }),
    ]);
    const session = makeSession([t1]);

    // Two ghosts plus ONE real id: without the ghosts being dropped this track
    // would look like a three-member merge.
    expect(mergeTargets(session, ['clip-ghost-a', t1.clips[0].id, 'clip-ghost-b'])).toEqual([]);
    expect(mergeTargets(session, [])).toEqual([]);
  });

  it('spans [min start, max end) when a later-starting member ends EARLIER (containment)', () => {
    const outer = makeClip({ documentId: 'doc-1', startSample: 1200, offsetSample: 60, lengthSample: 2000 });
    const inner = makeClip({ documentId: 'doc-1', startSample: 1500, offsetSample: 80, lengthSample: 300 });
    const session = makeSession([makeTrack('Track 1', [outer, inner])]);

    const [target] = mergeTargets(session, [inner.id, outer.id]);

    expect(target.startSample).toBe(1200);
    // 3200, the OUTER end — not the last member's end (1800).
    expect(target.lengthSample).toBe(2000);
  });
});

// ---------------------------------------------------------------------------
// D2/D3 — the bake
// ---------------------------------------------------------------------------
describe('bakeMergedClip — D2/D3', () => {
  it('places each member at its own timeline offset and leaves the gap silent', () => {
    // gainDb 0 / no fades here ON PURPOSE: this case asserts EXACT float32
    // equality with the source, which only the identity envelope can give. The
    // geometry under test (starts 1000/2000, offsets 300/700) is off identity.
    const doc = makeDoc([ramp(2000, (i) => (i + 1) / 10000)]);
    const m1 = makeClip({ documentId: doc.id, startSample: 1000, offsetSample: 300, lengthSample: 500 });
    const m2 = makeClip({ documentId: doc.id, startSample: 2000, offsetSample: 700, lengthSample: 500 });
    // Out of start order on the track (trap T40 again): an unsorted target
    // would take 2000 as the span origin and drive `local` negative for m1,
    // whose writes would then vanish into out-of-range TypedArray indices.
    const track = makeTrack('Track 1', [m2, m1]);
    const [target] = mergeTargets(makeSession([track]), [m1.id, m2.id]);

    const baked = bakeMergedClip(track, target, docMap(doc), SR);

    expect(baked.sampleRate).toBe(SR);
    expect(baked.channels).toHaveLength(1);
    expect(baked.channels[0]).toHaveLength(1500);
    const ch = baked.channels[0];
    for (let i = 0; i < 500; i++) expect(ch[i]).toBe(doc.channels[0][300 + i]);
    for (let i = 500; i < 1000; i++) expect(ch[i]).toBe(0);
    for (let i = 0; i < 500; i++) expect(ch[1000 + i]).toBe(doc.channels[0][700 + i]);
  });

  it('scales every member by its OWN dbToLinear(gainDb)', () => {
    const doc = makeDoc([ramp(2000, (i) => 0.2 * ((i % 257) / 256))]);
    const quiet = makeClip({
      documentId: doc.id, startSample: 1000, offsetSample: 300, lengthSample: 500, gainDb: -6,
    });
    const loud = makeClip({
      documentId: doc.id, startSample: 2000, offsetSample: 700, lengthSample: 500, gainDb: 3,
    });
    const track = makeTrack('Track 1', [quiet, loud]);
    const [target] = mergeTargets(makeSession([track]), [quiet.id, loud.id]);

    const ch = bakeMergedClip(track, target, docMap(doc), SR).channels[0];

    const expectQuiet = ramp(500, (i) => doc.channels[0][300 + i] * dbToLinear(-6));
    const expectLoud = ramp(500, (i) => doc.channels[0][700 + i] * dbToLinear(3));
    expect(maxDiff(ch, expectQuiet, 500, 0)).toBeLessThanOrEqual(1e-7);
    expect(maxDiff(ch, expectLoud, 500, 1000)).toBeLessThanOrEqual(1e-7);
  });

  it('applies the clip envelope resolved over the whole track (solo fade in and out)', () => {
    const doc = makeDoc([ramp(2000, (i) => 0.25 * Math.sin(i / 37))]);
    const faded = makeClip({
      documentId: doc.id,
      startSample: 1400,
      offsetSample: 250,
      // 200 + 300 < 700, so the brief's eight probe indices are eight DISTINCT
      // samples and the un-faded plateau between the two ramps is measured too.
      lengthSample: 700,
      gainDb: -2,
      fadeInSample: 200,
      fadeInCurve: 'smooth',
      fadeOutSample: 300,
      fadeOutCurve: 'exponential',
    });
    const plain = makeClip({ documentId: doc.id, startSample: 2200, offsetSample: 900, lengthSample: 400, gainDb: 1 });
    const track = makeTrack('Track 1', [faded, plain]);
    const [target] = mergeTargets(makeSession([track]), [faded.id, plain.id]);

    const ch = bakeMergedClip(track, target, docMap(doc), SR).channels[0];

    const spec = resolveClipFadeSpecs(track.clips).get(faded.id)!;
    const slice = readClipSlice(doc, faded, SR)[0];
    const g = dbToLinear(-2);
    const len = faded.lengthSample;
    for (const i of [0, 1, 100, 199, 200, len - 301, len - 300, len - 1]) {
      expect(Math.abs(ch[i] - slice[i] * g * clipFadeGainAt(spec, i))).toBeLessThanOrEqual(1e-7);
    }
    // The envelope must actually bite, or the assertion above measures nothing.
    expect(clipFadeGainAt(spec, 0)).toBeLessThan(0.001);
    expect(clipFadeGainAt(spec, len - 1)).toBeLessThan(0.001);
    expect(clipFadeGainAt(spec, 199)).toBeGreaterThan(0.9);
  });

  it('resolves the envelope over the WHOLE track, so a member crossfaded with an outsider bakes as the crossfade', () => {
    const doc = makeDoc([ramp(3000, (i) => 0.24 * Math.sin(i / 43))]);
    // A faces the UNSELECTED outsider X with an armed crossfade; B is the other
    // member. Over the whole track A's solo fadeOut is superseded by the pair's
    // normalised crossfade curve — over the members alone it would survive as a
    // plain 'smooth' fade out, which is a different number.
    const a = makeClip({
      documentId: doc.id,
      startSample: 1000,
      offsetSample: 150,
      lengthSample: 800,
      gainDb: -3,
      fadeOutSample: 200,
      fadeOutCurve: 'smooth',
    });
    const x = makeClip({
      documentId: doc.id,
      startSample: 1600,
      offsetSample: 500,
      lengthSample: 400,
      fadeInSample: 200,
      fadeInCurve: 'exponential',
    });
    const b = makeClip({ documentId: doc.id, startSample: 2200, offsetSample: 900, lengthSample: 500, gainDb: 1 });
    const track = makeTrack('Track 1', [a, x, b]);
    const [target] = mergeTargets(makeSession([track]), [a.id, b.id]);

    const ch = bakeMergedClip(track, target, docMap(doc), SR).channels[0];

    const whole = resolveClipFadeSpecs(track.clips).get(a.id)!;
    const membersOnly = resolveClipFadeSpecs(target.members).get(a.id)!;
    expect(whole.crossOut?.lengthSample).toBe(200);
    expect(membersOnly.crossOut).toBeNull();
    const slice = readClipSlice(doc, a, SR)[0];
    const g = dbToLinear(-3);
    // The two views must actually disagree somewhere in the crossfade region,
    // or this case cannot tell them apart.
    const probes = [600, 650, 700, 799];
    expect(probes.some((i) => Math.abs(clipFadeGainAt(whole, i) - clipFadeGainAt(membersOnly, i)) > 1e-3)).toBe(true);
    for (const i of probes) {
      expect(Math.abs(ch[i] - slice[i] * g * clipFadeGainAt(whole, i))).toBeLessThanOrEqual(1e-7);
    }
  });

  it('equals the renderer over the span — stereo members with an armed crossfade', () => {
    const doc = makeDoc([
      ramp(3000, (i) => 0.3 * ((i % 601) / 600)),
      ramp(3000, (i) => -0.25 * (((i * 7) % 449) / 448)),
    ]);
    const { track, session } = crossfadePair(doc);
    const docs = docMap(doc);

    const [target] = mergeTargets(session, track.clips.map((c) => c.id));
    const baked = bakeMergedClip(track, target, docs, SR);
    const mix = mixdownSession(session, docs);

    expect(mix.peakBeforeClamp).toBeLessThan(1); // the ±1 clamp must never fire
    expect(baked.channels).toHaveLength(2);
    expect(stereoBalanceGains(0)).toEqual({ gL: 1, gR: 1 });
    expect(maxDiff(mix.channels[0], baked.channels[0], target.lengthSample, target.startSample)).toBeLessThanOrEqual(1e-6);
    expect(maxDiff(mix.channels[1], baked.channels[1], target.lengthSample, target.startSample)).toBeLessThanOrEqual(1e-6);
  });

  it('equals the renderer over the span — mono members with an armed crossfade', () => {
    const doc = makeDoc([ramp(3000, (i) => 0.3 * Math.sin(i / 53))]);
    const { track, session } = crossfadePair(doc);
    const docs = docMap(doc);

    const [target] = mergeTargets(session, track.clips.map((c) => c.id));
    const baked = bakeMergedClip(track, target, docs, SR);
    const mix = mixdownSession(session, docs);

    expect(mix.peakBeforeClamp).toBeLessThan(1);
    expect(baked.channels).toHaveLength(1);
    // A mono merge stays mono: the track's own mono pan law still applies to
    // the merged clip, so the renderer's L is the bake times cos(pi/4).
    const gL = monoPanGains(0).gL;
    const expected = ramp(target.lengthSample, (i) => baked.channels[0][i] * gL);
    expect(maxDiff(mix.channels[0], expected, target.lengthSample, target.startSample)).toBeLessThanOrEqual(1e-6);
    expect(maxDiff(mix.channels[1], expected, target.lengthSample, target.startSample)).toBeLessThanOrEqual(1e-6);
  });

  it('stays mono for all-mono members and goes stereo as soon as one member is not', () => {
    const mono = makeDoc([ramp(2000, (i) => 0.2 * Math.sin(i / 29))]);
    const stereo = makeDoc([
      ramp(2000, (i) => 0.15 * Math.cos(i / 31)),
      ramp(2000, (i) => -0.18 * Math.cos(i / 17)),
    ]);
    const monoClip = makeClip({
      documentId: mono.id, startSample: 1200, offsetSample: 100, lengthSample: 400, gainDb: -3,
    });
    const other = (documentId: string) =>
      makeClip({ documentId, startSample: 1900, offsetSample: 50, lengthSample: 400, gainDb: 2 });

    const allMonoTrack = makeTrack('Track 1', [monoClip, other(mono.id)]);
    const allMono = bakeMergedClip(
      allMonoTrack,
      mergeTargets(makeSession([allMonoTrack]), allMonoTrack.clips.map((c) => c.id))[0],
      docMap(mono),
      SR
    );
    expect(allMono.channels).toHaveLength(1);

    const mixedTrack = makeTrack('Track 1', [monoClip, other(stereo.id)]);
    const mixed = bakeMergedClip(
      mixedTrack,
      mergeTargets(makeSession([mixedTrack]), mixedTrack.clips.map((c) => c.id))[0],
      docMap(mono, stereo),
      SR
    );
    expect(mixed.channels).toHaveLength(2);

    // D3 — the mono member feeds BOTH sides at the ratio the two centre pan
    // laws differ by, so its level survives the promotion unchanged.
    expect(Math.SQRT1_2).toBeCloseTo(monoPanGains(0).gL / stereoBalanceGains(0).gL, 12);
    const g = dbToLinear(-3);
    const expected = ramp(400, (i) => mono.channels[0][100 + i] * g * Math.SQRT1_2);
    expect(maxDiff(mixed.channels[0], expected, 400, 0)).toBeLessThanOrEqual(1e-7);
    expect(maxDiff(mixed.channels[1], expected, 400, 0)).toBeLessThanOrEqual(1e-7);
  });

  it('reads only channels 0 and 1 of a member document that carries a third channel', () => {
    // D3 — "a document with more than two channels contributes channels 0 and
    // 1 only". Channel 2 gets its OWN distinct, non-zero ramp (a constant
    // 0.9) so a bake that leaked it in anywhere would be caught either by the
    // channel-1 equality below or by the forbidden-value scan.
    const N = 2000;
    const threeCh = makeDoc([
      ramp(N, (i) => (i + 1) / 10000),
      ramp(N, (i) => -(i + 1) / 8000 + 0.05),
      ramp(N, () => 0.9),
    ]);
    const stereo = makeDoc([
      ramp(N, (i) => 0.1 * Math.sin(i / 19)),
      ramp(N, (i) => -0.08 * Math.cos(i / 13)),
    ]);
    // Off-identity geometry and gain on both members, per the file's own
    // convention (identity fixtures hide indexing bugs).
    const threeChMember = makeClip({
      documentId: threeCh.id, startSample: 1000, offsetSample: 300, lengthSample: 500, gainDb: -4,
    });
    const stereoMember = makeClip({
      documentId: stereo.id, startSample: 2000, offsetSample: 700, lengthSample: 500, gainDb: 3,
    });
    const track = makeTrack('Track 1', [threeChMember, stereoMember]);
    const [target] = mergeTargets(makeSession([track]), [threeChMember.id, stereoMember.id]);

    const baked = bakeMergedClip(track, target, docMap(threeCh, stereo), SR);

    expect(baked.channels).toHaveLength(2);

    const g3 = dbToLinear(-4);
    const g2 = dbToLinear(3);
    const expected0a = ramp(500, (i) => threeCh.channels[0][300 + i] * g3);
    const expected1a = ramp(500, (i) => threeCh.channels[1][300 + i] * g3);
    expect(maxDiff(baked.channels[0], expected0a, 500, 0)).toBeLessThanOrEqual(1e-7);
    expect(maxDiff(baked.channels[1], expected1a, 500, 0)).toBeLessThanOrEqual(1e-7);

    const expected0b = ramp(500, (i) => stereo.channels[0][700 + i] * g2);
    const expected1b = ramp(500, (i) => stereo.channels[1][700 + i] * g2);
    expect(maxDiff(baked.channels[0], expected0b, 500, 1000)).toBeLessThanOrEqual(1e-7);
    expect(maxDiff(baked.channels[1], expected1b, 500, 1000)).toBeLessThanOrEqual(1e-7);

    // Channel 2's constant 0.9, scaled by the member's own gain, never shows
    // up anywhere in the bake — the third channel leaked nowhere.
    const forbidden = 0.9 * g3;
    for (const ch of baked.channels) {
      for (let i = 0; i < ch.length; i++) expect(Math.abs(ch[i] - forbidden)).toBeGreaterThan(0.01);
    }
  });

  it('resamples a member whose document runs at another rate, exactly as readClipSlice does', () => {
    const fast = makeDoc([ramp(3000, (i) => 0.22 * Math.sin(i / 41))], 48000);
    const local = makeDoc([ramp(3000, (i) => 0.19 * Math.cos(i / 23))], SR);
    const resampled = makeClip({ documentId: fast.id, startSample: 1500, offsetSample: 200, lengthSample: 600 });
    const native = makeClip({ documentId: local.id, startSample: 2600, offsetSample: 400, lengthSample: 500 });
    const track = makeTrack('Track 1', [resampled, native]);
    const [target] = mergeTargets(makeSession([track]), [resampled.id, native.id]);

    const ch = bakeMergedClip(track, target, docMap(fast, local), SR).channels[0];

    const slice = readClipSlice(fast, resampled, SR)[0];
    const n = Math.min(slice.length, target.lengthSample - (resampled.startSample - target.startSample));
    expect(n).toBeGreaterThan(0);
    for (let i = 0; i < n; i++) expect(ch[i]).toBe(slice[i]);
  });

  it('renders a member whose document is not open as silence, span unchanged', () => {
    const doc = makeDoc([ramp(2000, (i) => 0.2 * Math.sin(i / 19))]);
    const present = makeClip({ documentId: doc.id, startSample: 1000, offsetSample: 120, lengthSample: 400, gainDb: -2 });
    const absent = makeClip({ documentId: 'doc-not-open', startSample: 1800, offsetSample: 60, lengthSample: 500 });
    const track = makeTrack('Track 1', [present, absent]);
    const [target] = mergeTargets(makeSession([track]), [present.id, absent.id]);

    const baked = bakeMergedClip(track, target, docMap(doc), SR);

    expect(target.lengthSample).toBe(1300);
    expect(baked.channels[0]).toHaveLength(1300);
    for (let i = 800; i < 1300; i++) expect(baked.channels[0][i]).toBe(0);
    expect(baked.channels[0].some((v, i) => i < 400 && v !== 0)).toBe(true);
  });
});

/** Two overlapping clips whose facing fades exactly equal the overlap width —
 * the canonical armed crossfade, on a default track (pan 0, volume 0, no
 * automation) holding nothing else, so `mixdownSession` renders only them. */
function crossfadePair(doc: AudioDocument): { track: Track; session: Session } {
  const a = makeClip({
    documentId: doc.id,
    startSample: 1000,
    offsetSample: 250,
    lengthSample: 800,
    gainDb: -4,
    fadeOutSample: 200,
    fadeOutCurve: 'smooth',
  });
  const b = makeClip({
    documentId: doc.id,
    startSample: 1600,
    offsetSample: 900,
    lengthSample: 900,
    gainDb: 2,
    fadeInSample: 200,
    fadeInCurve: 'exponential',
  });
  const track = makeTrack('Track 1', [a, b]);
  // Guard the fixture itself: without a resolved crossfade this case would
  // silently degrade into "two solo-faded clips agree", which is a weaker claim.
  const spec = resolveClipFadeSpecs(track.clips).get(a.id);
  expect(spec?.crossOut?.lengthSample).toBe(200);
  return { track, session: makeSession([track]) };
}

// ---------------------------------------------------------------------------
// D4/D5 — the session write
// ---------------------------------------------------------------------------
describe('commitMergedClips — D4/D5', () => {
  it('replaces the members with one clip spanning them, in a single undo entry', () => {
    const a = makeClip({ documentId: 'doc-a', startSample: 1000, offsetSample: 120, lengthSample: 500, gainDb: -5 });
    const x = makeClip({ documentId: 'doc-a', startSample: 1600, offsetSample: 40, lengthSample: 200, gainDb: 2 });
    const b = makeClip({ documentId: 'doc-a', startSample: 2000, offsetSample: 900, lengthSample: 500, gainDb: 4 });
    install([makeTrack('Track 1', [a, x, b])]);
    const [target] = mergeTargets(sessionRef(), [a.id, b.id]);

    const ids = commitMergedClips([{ target, documentId: 'doc-merged' }]);

    expect(ids).toHaveLength(1);
    const clips = trackClips();
    expect(clips).toHaveLength(2);
    const merged = clips[0];
    expect(merged.id).toBe(ids[0]);
    expect(merged.id).toMatch(/^clip-\d+$/);
    expect(merged.id).not.toBe(a.id);
    expect(merged.id).not.toBe(b.id);
    expect(merged.startSample).toBe(1000);
    expect(merged.lengthSample).toBe(1500);
    expect(merged.offsetSample).toBe(0);
    expect(merged.gainDb).toBe(0);
    expect(merged.documentId).toBe('doc-merged');
    // D2 — gain and fades are inside the audio now; absent keys stay ABSENT.
    expect('fadeInSample' in merged).toBe(false);
    expect('fadeOutSample' in merged).toBe(false);
    expect('fadeInCurve' in merged).toBe(false);
    expect('fadeOutCurve' in merged).toBe(false);
    // D1 — the outsider inside the span is neither merged nor moved.
    expect(clips[1]).toBe(x);

    expect(doneLabels()).toEqual(['Merge clips']);

    undoSession();
    expect(trackClips()).toEqual([a, x, b]);

    redoSession();
    expect(trackClips().map((c) => c.id)).toEqual([merged.id, x.id]);
  });

  it('merges several tracks under ONE entry and leaves everything else identical', () => {
    const t1 = makeTrack('Track 1', [
      makeClip({ documentId: 'doc-a', startSample: 1000, offsetSample: 30, lengthSample: 500 }),
      makeClip({ documentId: 'doc-a', startSample: 1800, offsetSample: 60, lengthSample: 600 }),
    ]);
    const t2 = makeTrack('Track 2', [
      makeClip({ documentId: 'doc-b', startSample: 500, offsetSample: 90, lengthSample: 400 }),
      makeClip({ documentId: 'doc-b', startSample: 1500, offsetSample: 10, lengthSample: 700 }),
    ]);
    const t3 = makeTrack('Track 3', [
      makeClip({ documentId: 'doc-c', startSample: 300, offsetSample: 55, lengthSample: 900 }),
    ]);
    const lanes = [lane(), lane(), lane()];
    t1.automation = lanes[0];
    t2.automation = lanes[1];
    t3.automation = lanes[2];
    install([t1, t2, t3]);
    const targets = mergeTargets(sessionRef(), [
      ...t1.clips.map((c) => c.id),
      ...t2.clips.map((c) => c.id),
    ]);

    const ids = commitMergedClips(targets.map((target, i) => ({ target, documentId: `doc-merge-${i}` })));

    expect(ids).toHaveLength(2);
    expect(trackClips(0).map((c) => c.id)).toEqual([ids[0]]);
    expect(trackClips(1).map((c) => c.id)).toEqual([ids[1]]);
    expect(doneLabels()).toEqual(['Merge clips']);
    // An untouched track keeps its clip object, and no track's automation is
    // re-allocated by the write.
    expect(trackClips(2)[0]).toBe(t3.clips[0]);
    sessionRef().tracks.forEach((t, i) => expect(t.automation).toBe(lanes[i]));
  });

  it('lets removeClip disarm an outsider that was crossfaded against a member', () => {
    const a = makeClip({
      documentId: 'doc-a',
      startSample: 1000,
      offsetSample: 20,
      lengthSample: 800,
      fadeOutSample: 200,
      fadeOutCurve: 'smooth',
    });
    const x = makeClip({
      documentId: 'doc-a',
      startSample: 1600,
      offsetSample: 70,
      lengthSample: 400,
      fadeInSample: 200,
      fadeInCurve: 'exponential',
    });
    const b = makeClip({ documentId: 'doc-a', startSample: 2200, offsetSample: 300, lengthSample: 500 });
    install([makeTrack('Track 1', [a, x, b])]);
    // The pair really is armed before the merge, or the disarm below is vacuous.
    expect(resolveClipFadeSpecs(trackClips()).get(x.id)?.crossIn?.lengthSample).toBe(200);
    const [target] = mergeTargets(sessionRef(), [a.id, b.id]);

    const [mergedId] = commitMergedClips([{ target, documentId: 'doc-merged' }]);

    const outsider = trackClips().find((c) => c.id === x.id)!;
    expect(outsider.fadeInSample).toBeUndefined();
    const merged = trackClips().find((c) => c.id === mergedId)!;
    expect('fadeInSample' in merged).toBe(false);
    expect('fadeOutSample' in merged).toBe(false);
  });

  it('D5 — the primary lands on the merge that owns the previous primary', () => {
    const t1 = makeTrack('Track 1', [
      makeClip({ documentId: 'doc-a', startSample: 1000, offsetSample: 30, lengthSample: 500 }),
      makeClip({ documentId: 'doc-a', startSample: 1800, offsetSample: 60, lengthSample: 600 }),
    ]);
    const t2 = makeTrack('Track 2', [
      makeClip({ documentId: 'doc-b', startSample: 500, offsetSample: 90, lengthSample: 400 }),
      makeClip({ documentId: 'doc-b', startSample: 1500, offsetSample: 10, lengthSample: 700 }),
    ]);
    const selection = [...t1.clips.map((c) => c.id), ...t2.clips.map((c) => c.id)];

    // Primary on the SECOND merged track — track order already puts it last.
    install([t1, t2]);
    useSessionStore.setState({ selectedClipId: t2.clips[1].id, selectedClipIds: selection });
    const second = commitMergedClips(
      mergeTargets(sessionRef(), selection).map((target, i) => ({ target, documentId: `doc-m${i}` }))
    );
    expect(store().selectedClipIds.slice().sort()).toEqual(second.slice().sort());
    expect(store().selectedClipId).toBe(second[1]);

    // Primary on the FIRST merged track — that merge must be handed over LAST.
    _resetSessionUndo();
    const u1 = makeTrack('Track 1', t1.clips.map((c) => ({ ...c })));
    const u2 = makeTrack('Track 2', t2.clips.map((c) => ({ ...c })));
    const sel2 = [...u1.clips.map((c) => c.id), ...u2.clips.map((c) => c.id)];
    install([u1, u2]);
    useSessionStore.setState({ selectedClipId: u1.clips[0].id, selectedClipIds: sel2 });
    const first = commitMergedClips(
      mergeTargets(sessionRef(), sel2).map((target, i) => ({ target, documentId: `doc-n${i}` }))
    );
    expect(first).toHaveLength(2);
    expect(store().selectedClipIds).toHaveLength(2);
    expect(store().selectedClipId).toBe(first[0]);
  });

  it('D5 — a primary on an unmerged track leaves the LAST merge primary', () => {
    const t1 = makeTrack('Track 1', [
      makeClip({ documentId: 'doc-a', startSample: 1000, offsetSample: 30, lengthSample: 500 }),
      makeClip({ documentId: 'doc-a', startSample: 1800, offsetSample: 60, lengthSample: 600 }),
    ]);
    const t2 = makeTrack('Track 2', [
      makeClip({ documentId: 'doc-b', startSample: 500, offsetSample: 90, lengthSample: 400 }),
      makeClip({ documentId: 'doc-b', startSample: 1500, offsetSample: 10, lengthSample: 700 }),
    ]);
    const t3 = makeTrack('Track 3', [
      makeClip({ documentId: 'doc-c', startSample: 300, offsetSample: 55, lengthSample: 900 }),
    ]);
    const selection = [...t1.clips.map((c) => c.id), ...t2.clips.map((c) => c.id)];
    install([t1, t2, t3]);
    useSessionStore.setState({ selectedClipId: t3.clips[0].id, selectedClipIds: [t3.clips[0].id, ...selection] });

    const ids = commitMergedClips(
      mergeTargets(sessionRef(), selection).map((target, i) => ({ target, documentId: `doc-m${i}` }))
    );

    expect(ids).toHaveLength(2);
    expect(store().selectedClipId).toBe(ids[1]);
    expect(store().selectedClipIds).toEqual(ids);
  });

  it('leaves a chosen timeline zoom alone when the merge takes every clip in the session', () => {
    // The whole session's clips: a remove-then-add order would run `addClip`
    // against a transiently EMPTY session, whose `wasEmpty` arm re-fits the
    // view — the exact yank that arm exists to avoid.
    const a = makeClip({ documentId: 'doc-a', startSample: 44100, offsetSample: 1200, lengthSample: 441000 });
    const b = makeClip({ documentId: 'doc-a', startSample: 882000, offsetSample: 300, lengthSample: 441000 });
    install([makeTrack('Track 1', [a, b])]);
    // Zoomed strictly IN of the fit — a zoom the user CHOSE, which no edit may
    // throw away (`addClip`'s own rule: anything but empty-or-fitted is left alone).
    const fit = fitSessionSamplesPerPixel(sessionRef());
    applySessionZoom({ samplesPerPixel: fit / 4, scrollSample: 120000 });
    const zoom = store().mtZoom;
    expect(zoom.samplesPerPixel).toBeLessThan(fit);
    expect(zoom.scrollSample).toBeGreaterThan(0);
    const [target] = mergeTargets(sessionRef(), [a.id, b.id]);

    commitMergedClips([{ target, documentId: 'doc-merged' }]);

    expect(trackClips()).toHaveLength(1);
    expect(store().mtZoom).toBe(zoom);
  });

  it('does nothing at all — no gesture, no write — when the members are gone', () => {
    const a = makeClip({ documentId: 'doc-a', startSample: 1000, offsetSample: 30, lengthSample: 500 });
    const b = makeClip({ documentId: 'doc-a', startSample: 1800, offsetSample: 60, lengthSample: 600 });
    install([makeTrack('Track 1', [a, b])]);
    const [target] = mergeTargets(sessionRef(), [a.id, b.id]);

    install([makeTrack('Track 1', [])]); // the clips left between resolve and commit
    const before = sessionRef();

    expect(commitMergedClips([{ target, documentId: 'doc-merged' }])).toEqual([]);
    expect(canUndoSession()).toBe(false);
    expect(sessionRef()).toBe(before);
  });
});
