import {
  buildSessionSnapTargets,
  mapClipSourceSample,
  sessionSnapTargets,
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

describe('buildSessionSnapTargets (pure)', () => {
  it('maps one clip’s beats onto the session timeline', () => {
    const s = source({ clip: { startSample: 10_000, offsetSample: 0, lengthSample: 100_000 } });
    expect(buildSessionSnapTargets([s], 44_100, null)).toEqual([10_000, 32_050, 54_100]);
  });

  it('EXCLUDES the dragged clip — snapping a clip to its own grid is a no-op by construction', () => {
    // Trap 27: the clip carries its grid with it, so every one of its own tics
    // sits at the same offset from its start no matter where it is dragged.
    const dragged = source({
      clipId: 'dragged',
      clip: { startSample: 500_000, offsetSample: 0, lengthSample: 100_000 },
    });
    const other = source({
      clipId: 'other',
      clip: { startSample: 0, offsetSample: 0, lengthSample: 100_000 },
    });
    const out = buildSessionSnapTargets([dragged, other], 44_100, 'dragged');
    expect(out).toEqual([0, 22_050, 44_100]);
    expect(out).not.toContain(500_000);
  });

  it('unions the grids of SEVERAL other clips, ascending and duplicate-free', () => {
    const a = source({ clipId: 'a', clip: { startSample: 0, offsetSample: 0, lengthSample: 50_000 } });
    const b = source({
      clipId: 'b',
      clip: { startSample: 22_050, offsetSample: 0, lengthSample: 50_000 },
    });
    const out = buildSessionSnapTargets([a, b], 44_100, null);
    // a -> 0, 22 050, 44 100 ; b -> 22 050, 44 100 (b's own beat 0 lands on its
    // start). The shared positions appear once.
    expect(out).toEqual([0, 22_050, 44_100, 66_150]);
  });

  it('includes the extra targets (the multitrack cursor)', () => {
    const out = buildSessionSnapTargets([source()], 44_100, null, [12_345]);
    expect(out).toContain(12_345);
  });

  it('maps a clip’s source MARKERS through the same conversion', () => {
    const s = source({
      clip: { startSample: 1_000, offsetSample: 500, lengthSample: 10_000 },
      grid: null,
      markers: [2_500, 400 /* before the window — dropped */],
    });
    expect(buildSessionSnapTargets([s], 44_100, null)).toEqual([3_000]);
  });

  it('produces nothing for a clip whose source document has closed', () => {
    const s = source({ docRate: null, grid: makeGrid([0, 22_050]), markers: [1_000] });
    expect(buildSessionSnapTargets([s], 44_100, null)).toEqual([]);
  });

  it('produces nothing for a clip with no grid and no markers', () => {
    expect(buildSessionSnapTargets([source({ grid: null })], 44_100, null)).toEqual([]);
  });

  it('refuses a grid expressed in a rate other than the clip source’s', () => {
    const s = source({ docRate: 48_000, grid: makeGrid([0, 22_050], { sampleRate: 44_100 }) });
    expect(buildSessionSnapTargets([s], 44_100, null)).toEqual([]);
  });

  it('never emits a target outside the clip that produced it', () => {
    const s = source({
      clip: { startSample: 10_000, offsetSample: 30_000, lengthSample: 20_000 },
      grid: makeGrid([0, 22_050, 44_100, 66_150]),
    });
    const out = buildSessionSnapTargets([s], 44_100, null);
    for (const t of out) {
      expect(t).toBeGreaterThanOrEqual(10_000);
      expect(t).toBeLessThanOrEqual(30_000);
    }
    expect(out).toEqual([24_100]); // only beat 44 100 falls in [30 000, 50 000)
  });

  it('does not mutate a grid’s shared beatSamples array', () => {
    const grid = makeGrid([0, 22_050, 44_100]);
    const before = Array.from(grid.beatSamples);
    buildSessionSnapTargets([source({ grid })], 44_100, null);
    expect(Array.from(grid.beatSamples)).toEqual(before);
  });
});

describe('sessionSnapTargets (store-resolving)', () => {
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

  it('collects every track’s clips except the excluded one, plus the multitrack cursor', () => {
    const s = useSessionStore.getState();
    const trackA = s.session.tracks[0].id;
    const trackB = s.session.tracks[1].id;
    s.addClip(trackA, clip('a', 0));
    s.addClip(trackB, clip('b', 1_000_000));
    useSessionStore.getState().setMtCursor(777);

    const out = sessionSnapTargets('b');
    expect(out).toContain(0);
    expect(out).toContain(22_050);
    expect(out).toContain(777); // the session cursor
    expect(out).not.toContain(1_000_000); // the excluded clip's own start beat
  });

  it('is EMPTY when the magnet is switched off, and asks for no grid', () => {
    const s = useSessionStore.getState();
    s.addClip(s.session.tracks[0].id, clip('a', 0));
    setSnapEnabled(false);
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
    sessionSnapTargets(null);
    expect(gridSpy).toHaveBeenCalledTimes(1);
  });

  it('maps the source document’s markers into session positions', () => {
    const s = useSessionStore.getState();
    s.addClip(s.session.tracks[0].id, clip('a', 5_000));
    gridSpy.mockReturnValue(null);
    const m: Marker = { id: 'mk', name: 'x', positionSample: 1_234 };
    useAppStore.getState().setMarkersForDoc(doc.id, [m]);
    expect(sessionSnapTargets(null)).toContain(6_234);
  });

  it('is empty for an empty session', () => {
    useSessionStore.getState().setMtCursor(0);
    expect(sessionSnapTargets(null)).toEqual([0]); // the cursor, and nothing else
  });
});
