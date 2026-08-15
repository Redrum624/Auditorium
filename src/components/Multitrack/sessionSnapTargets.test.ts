import {
  buildSessionSnapTiers,
  mapClipSourceSample,
  sessionSnapTargets,
  sessionSnapTiers,
  SNAP_TIER_EDGE,
  SNAP_TIER_MARKER,
  SNAP_TIER_BEAT,
  type ClipSnapSource,
} from './sessionSnapTargets';
import * as beatGridService from '../../services/beatGrid';
import type { BeatGrid } from '../../services/beatGrid';
import { _resetSnapPreference, setSnapEnabled } from '../../services/snapPreference';
import { createDocument, type AudioDocument } from '../../audio/AudioDocument';
import { makeInitialState, useAppStore, type Marker } from '../../stores/appStore';
import { useSessionStore } from '../../multitrack/sessionStore';
import type { Clip } from '../../multitrack/session';

function makeGrid(beats: number[], patch: Partial<BeatGrid> = {}): BeatGrid {
  return {
    beatSamples: Int32Array.from(beats),
    sampleRate: 44_100,
    beatsPerBar: null,
    downbeatPhase: null,
    barCount: 0,
    confidence: 0.9,
    stale: false,
    analyzedEndSample: 10_000_000,
    truncated: false,
    origin: 'own',
    originDocId: 'doc-1',
    originOpen: true,
    ...patch,
  };
}

function source(patch: Partial<ClipSnapSource> = {}): ClipSnapSource {
  return {
    clipId: 'clip-1',
    clip: { startSample: 0, offsetSample: 0, lengthSample: 100_000 },
    docRate: 44_100,
    grid: makeGrid([0, 22_050, 44_100]),
    markers: [],
    ...patch,
  };
}

describe('mapClipSourceSample — plan ruling 1, reused for markers', () => {
  const clip = { startSample: 1_000, offsetSample: 500, lengthSample: 10_000 };

  it('is a plain translation on a rate-MATCHED clip', () => {
    expect(mapClipSourceSample(2_500, clip, 44_100, 44_100)).toBe(3_000);
  });

  it('applies the sessionRate/docRate conversion on a rate-MISMATCHED clip', () => {
    // A 48 kHz source in a 44.1 kHz session: 2000 source samples past the clip's
    // offset are heard round(2000 * 44100/48000) = 1838 session samples in.
    const c = { startSample: 1_000, offsetSample: 500, lengthSample: 10_000 };
    expect(mapClipSourceSample(2_500, c, 48_000, 44_100)).toBe(1_000 + 1_838);
  });

  it('rejects a position before the clip’s source window', () => {
    expect(mapClipSourceSample(400, clip, 44_100, 44_100)).toBeNull();
  });

  it('treats the source window as HALF-OPEN, exactly as readClipSlice reads it', () => {
    // offset 500 + span 10 000 -> [500, 10 500): 10 499 is in, 10 500 is not.
    expect(mapClipSourceSample(10_499, clip, 44_100, 44_100)).toBe(10_999);
    expect(mapClipSourceSample(10_500, clip, 44_100, 44_100)).toBeNull();
  });

  it('refuses to invent a rate', () => {
    expect(mapClipSourceSample(2_500, clip, 0, 44_100)).toBeNull();
    expect(mapClipSourceSample(2_500, clip, Number.NaN, 44_100)).toBeNull();
    expect(mapClipSourceSample(2_500, clip, 44_100, 0)).toBeNull();
  });
});

describe('buildSessionSnapTiers (pure)', () => {
  it('maps one clip’s beats onto the session timeline, in the BEAT tier', () => {
    const s = source({ clip: { startSample: 10_000, offsetSample: 0, lengthSample: 100_000 } });
    const tiers = buildSessionSnapTiers([s], 44_100, []);
    expect(tiers[SNAP_TIER_BEAT]).toEqual([10_000, 32_050, 54_100]);
  });

  it('offers every other clip’s START and END as EDGE-tier targets (W2)', () => {
    const s = source({ clip: { startSample: 10_000, offsetSample: 0, lengthSample: 100_000 } });
    expect(buildSessionSnapTiers([s], 44_100, [])[SNAP_TIER_EDGE]).toEqual([10_000, 110_000]);
  });

  it('a butt-joined pair contributes ONE boundary at the shared sample, not two', () => {
    const a = source({ clipId: 'a', clip: { startSample: 0, offsetSample: 0, lengthSample: 50_000 }, grid: null });
    const b = source({ clipId: 'b', clip: { startSample: 50_000, offsetSample: 0, lengthSample: 50_000 }, grid: null });
    expect(buildSessionSnapTiers([a, b], 44_100, [])[SNAP_TIER_EDGE]).toEqual([0, 50_000, 100_000]);
  });

  it('still offers the edges of a clip whose source document has CLOSED', () => {
    // startSample/lengthSample are session-sample facts of the clip itself; only
    // the beats and markers conversions need a rate, so only they refuse.
    const s = source({ docRate: null, grid: makeGrid([0, 22_050]), markers: [1_000] });
    const tiers = buildSessionSnapTiers([s], 44_100, []);
    expect(tiers[SNAP_TIER_EDGE]).toEqual([0, 100_000]);
    expect(tiers[SNAP_TIER_MARKER]).toEqual([]);
    expect(tiers[SNAP_TIER_BEAT]).toEqual([]);
  });

  it('EXCLUDES the dragged clip entirely — grid, markers and edges (trap 27)', () => {
    // The clip carries its grid AND its edges with it: its own start IS the
    // position being dragged, so its own contribution would pin the drag in
    // place. Nothing of the excluded clip may appear in any tier.
    const dragged = source({
      clipId: 'dragged',
      clip: { startSample: 500_000, offsetSample: 0, lengthSample: 100_000 },
      markers: [10],
    });
    const other = source({
      clipId: 'other',
      clip: { startSample: 0, offsetSample: 0, lengthSample: 100_000 },
    });
    const tiers = buildSessionSnapTiers([dragged, other], 44_100, ['dragged']);
    expect(tiers[SNAP_TIER_BEAT]).toEqual([0, 22_050, 44_100]);
    expect(tiers[SNAP_TIER_EDGE]).toEqual([0, 100_000]);
    for (const tier of tiers) {
      expect(tier).not.toContain(500_000);
      expect(tier).not.toContain(600_000);
    }
  });

  it('EXCLUDES every co-moving member of a group drag, not just the grabbed clip (W2)', () => {
    // Targets are captured at pointerdown and the group moves rigidly: a
    // member's captured edges/beats describe where it is about to NOT be.
    const grabbed = source({
      clipId: 'grabbed',
      clip: { startSample: 500_000, offsetSample: 0, lengthSample: 100_000 },
    });
    const member = source({
      clipId: 'member',
      clip: { startSample: 200_000, offsetSample: 0, lengthSample: 100_000 },
      markers: [50],
    });
    const bystander = source({
      clipId: 'bystander',
      clip: { startSample: 0, offsetSample: 0, lengthSample: 100_000 },
      grid: null,
    });
    const tiers = buildSessionSnapTiers([grabbed, member, bystander], 44_100, ['grabbed', 'member']);
    expect(tiers[SNAP_TIER_EDGE]).toEqual([0, 100_000]);
    expect(tiers[SNAP_TIER_MARKER]).toEqual([]);
    expect(tiers[SNAP_TIER_BEAT]).toEqual([]);
  });

  it('unions the grids of SEVERAL other clips, ascending and duplicate-free', () => {
    const a = source({ clipId: 'a', clip: { startSample: 0, offsetSample: 0, lengthSample: 50_000 } });
    const b = source({
      clipId: 'b',
      clip: { startSample: 22_050, offsetSample: 0, lengthSample: 50_000 },
    });
    const tiers = buildSessionSnapTiers([a, b], 44_100, []);
    // a -> 0, 22 050, 44 100 ; b -> 22 050, 44 100 (b's own beat 0 lands on its
    // start). The shared positions appear once.
    expect(tiers[SNAP_TIER_BEAT]).toEqual([0, 22_050, 44_100, 66_150]);
  });

  it('places the extra targets (the multitrack cursor) in the EDGE tier', () => {
    // The cursor is hard geometry the user parked — it must never lose to a
    // beat line that merely happens to be a pixel closer (the H3 hazard).
    const tiers = buildSessionSnapTiers([source()], 44_100, [], [12_345]);
    expect(tiers[SNAP_TIER_EDGE]).toContain(12_345);
    expect(tiers[SNAP_TIER_BEAT]).not.toContain(12_345);
  });

  it('maps a clip’s source MARKERS through the same conversion, in the MARKER tier', () => {
    const s = source({
      clip: { startSample: 1_000, offsetSample: 500, lengthSample: 10_000 },
      grid: null,
      markers: [2_500, 400 /* before the window — dropped */],
    });
    expect(buildSessionSnapTiers([s], 44_100, [])[SNAP_TIER_MARKER]).toEqual([3_000]);
  });

  it('produces no beats or markers for a clip with no grid and no markers', () => {
    const tiers = buildSessionSnapTiers([source({ grid: null })], 44_100, []);
    expect(tiers[SNAP_TIER_MARKER]).toEqual([]);
    expect(tiers[SNAP_TIER_BEAT]).toEqual([]);
  });

  it('refuses a grid expressed in a rate other than the clip source’s', () => {
    const s = source({ docRate: 48_000, grid: makeGrid([0, 22_050], { sampleRate: 44_100 }) });
    expect(buildSessionSnapTiers([s], 44_100, [])[SNAP_TIER_BEAT]).toEqual([]);
  });

  it('never emits a beat target outside the clip that produced it', () => {
    const s = source({
      clip: { startSample: 10_000, offsetSample: 30_000, lengthSample: 20_000 },
      grid: makeGrid([0, 22_050, 44_100, 66_150]),
    });
    const beats = buildSessionSnapTiers([s], 44_100, [])[SNAP_TIER_BEAT];
    for (const t of beats) {
      expect(t).toBeGreaterThanOrEqual(10_000);
      expect(t).toBeLessThanOrEqual(30_000);
    }
    expect(beats).toEqual([24_100]); // only beat 44 100 falls in [30 000, 50 000)
  });

  it('does not mutate a grid’s shared beatSamples array', () => {
    const grid = makeGrid([0, 22_050, 44_100]);
    const before = Array.from(grid.beatSamples);
    buildSessionSnapTiers([source({ grid })], 44_100, []);
    expect(Array.from(grid.beatSamples)).toEqual(before);
  });
});

describe('sessionSnapTiers / sessionSnapTargets (store-resolving)', () => {
  let gridSpy: jest.SpyInstance;
  let doc: AudioDocument;

  function clip(id: string, startSample: number): Clip {
    return { id, documentId: doc.id, startSample, offsetSample: 0, lengthSample: 100_000, gainDb: 0 };
  }

  beforeEach(() => {
    useAppStore.setState(makeInitialState());
    useSessionStore.getState().newSession(44_100);
    _resetSnapPreference();
    const channel = new Float32Array(200_000);
    doc = createDocument({ name: 'src.wav', sampleRate: 44_100, channels: [channel] });
    useAppStore.getState().addDocument(doc);
    gridSpy = jest.spyOn(beatGridService, 'getBeatGrid').mockReturnValue(makeGrid([0, 22_050, 44_100]));
  });

  afterEach(() => {
    gridSpy.mockRestore();
    _resetSnapPreference();
  });

  it('collects every track’s clips except the excluded ones, plus the multitrack cursor', () => {
    const s = useSessionStore.getState();
    const trackA = s.session.tracks[0].id;
    const trackB = s.session.tracks[1].id;
    s.addClip(trackA, clip('a', 0));
    s.addClip(trackB, clip('b', 1_000_000));
    useSessionStore.getState().setMtCursor(777);

    const tiers = sessionSnapTiers(['b']);
    expect(tiers[SNAP_TIER_BEAT]).toContain(0);
    expect(tiers[SNAP_TIER_BEAT]).toContain(22_050);
    expect(tiers[SNAP_TIER_EDGE]).toContain(777); // the session cursor
    expect(tiers[SNAP_TIER_EDGE]).toContain(0); // a's start
    expect(tiers[SNAP_TIER_EDGE]).toContain(100_000); // a's end
    for (const tier of tiers) expect(tier).not.toContain(1_000_000); // the excluded clip
  });

  it('offers clip edges ACROSS tracks and on the SAME track alike', () => {
    const s = useSessionStore.getState();
    s.addClip(s.session.tracks[0].id, clip('same-track', 300_000));
    s.addClip(s.session.tracks[1].id, clip('cross-track', 600_000));
    const edges = sessionSnapTiers(['dragged-elsewhere'])[SNAP_TIER_EDGE];
    expect(edges).toEqual(expect.arrayContaining([300_000, 400_000, 600_000, 700_000]));
  });

  it('is EMPTY when the magnet is switched off, and asks for no grid', () => {
    const s = useSessionStore.getState();
    s.addClip(s.session.tracks[0].id, clip('a', 0));
    setSnapEnabled(false);
    expect(sessionSnapTiers([])).toEqual([[], [], []]);
    expect(sessionSnapTargets(null)).toEqual([]);
    expect(gridSpy).not.toHaveBeenCalled();
  });

  it('asks getBeatGrid ONCE per distinct source document, not once per clip', () => {
    // Five stems of one source is the workflow this feature exists for, and the
    // analysis cache holds four rows — repeating the lookup per clip is exactly
    // the pressure B1's inheritance was built to avoid.
    const s = useSessionStore.getState();
    for (let i = 0; i < 4; i++) {
      s.addClip(s.session.tracks[i].id, clip(`c${i}`, i * 200_000));
    }
    gridSpy.mockClear();
    sessionSnapTiers([]);
    expect(gridSpy).toHaveBeenCalledTimes(1);
  });

  it('maps the source document’s markers into session positions', () => {
    const s = useSessionStore.getState();
    s.addClip(s.session.tracks[0].id, clip('a', 5_000));
    gridSpy.mockReturnValue(null);
    const m: Marker = { id: 'mk', name: 'x', positionSample: 1_234 };
    useAppStore.getState().setMarkersForDoc(doc.id, [m]);
    expect(sessionSnapTiers([])[SNAP_TIER_MARKER]).toContain(6_234);
  });

  it('sessionSnapTargets stays the FLAT union for the point surfaces (ruler, envelope)', () => {
    const s = useSessionStore.getState();
    s.addClip(s.session.tracks[0].id, clip('a', 5_000));
    useSessionStore.getState().setMtCursor(777);
    const flat = sessionSnapTargets(null);
    // Edges, cursor, and beats all present, one ascending duplicate-free array.
    expect(flat).toEqual(expect.arrayContaining([777, 5_000, 105_000, 27_050]));
    expect([...flat].sort((a, b) => a - b)).toEqual(flat);
  });

  it('is empty for an empty session', () => {
    useSessionStore.getState().setMtCursor(0);
    expect(sessionSnapTargets(null)).toEqual([0]); // the cursor, and nothing else
  });
});
