/**
 * Task B3 — the clip mapping.
 *
 * The pure half (`mapBeatsToClip` / `buildClipTicOverlay`) is asserted directly
 * against hand-built grids, because the thing under test is arithmetic: ruling
 * 1's `sessionPos = clip.startSample + round((b - offsetSample) * sessionRate /
 * docRate)`. The hook half is driven through the REAL `getBeatGrid` (the
 * analysis worker mock runs `analyzeTempo` on the main thread), because the
 * property that matters there — a stem clip resolving through its PARENT's grid
 * — is exactly the thing a mocked selector would fake.
 */
import { act, renderHook } from '@testing-library/react';
import {
  buildClipTicOverlay,
  laneWidthBound,
  mapBeatsToClip,
  useClipBeatTics,
  ticWindow,
  CLIP_TIC_BAND_PX,
  TIC_WINDOW_QUANTUM_PX,
} from './clipBeatTics';
import type { BeatGrid } from '../../services/beatGrid';
import { clearBeatGridLinks, linkDerivedDocument } from '../../services/beatGrid';
import { setBeatGridVisible } from '../../services/beatGridDisplay';
import { clearAllTempo, runTempoAnalysis, runRemixAnalysis } from '../../services/tempoAnalysis';
import { CONFIDENCE_LOW } from '../../dsp/tempoCore';
import { createDocument, type AudioDocument } from '../../audio/AudioDocument';
import { useAppStore, makeInitialState } from '../../stores/appStore';
import { _resetTempoWorkerTestState } from '../../__mocks__/createTempoWorkerMock';
import type { Clip } from '../../multitrack/session';
import { MT_HEADER_W } from '../../multitrack/sessionViewport';

const SR = 44100;

function grid(over: Partial<BeatGrid> = {}): BeatGrid {
  return {
    beatSamples: Int32Array.from([0, 22050, 44100, 66150, 88200]),
    sampleRate: SR,
    beatsPerBar: null,
    downbeatPhase: null,
    barCount: 0,
    confidence: 0.9,
    stale: false,
    analyzedEndSample: 200000,
    truncated: false,
    origin: 'own',
    originDocId: 'doc-1',
    originOpen: true,
    ...over,
  };
}

/** 2.5 s long by default, so the five default beats all fit inside it. */
function clip(over: Partial<Clip> = {}): Clip {
  return {
    id: 'clip-1',
    documentId: 'doc-1',
    startSample: 0,
    offsetSample: 0,
    lengthSample: 110250,
    gainDb: 0,
    ...over,
  };
}

/** A 48 kHz grid: 24 000 source samples per beat = 0.5 s, the same musical grid
 * as the 44.1 kHz default, expressed in the other rate. */
function grid48(over: Partial<BeatGrid> = {}): BeatGrid {
  return grid({
    beatSamples: Int32Array.from([0, 24000, 48000, 72000, 96000]),
    sampleRate: 48000,
    analyzedEndSample: 480000,
    ...over,
  });
}

// ---------------------------------------------------------------------------
// 1. Ruling 1's conversion
// ---------------------------------------------------------------------------

describe('mapBeatsToClip — session-space positions (plan ruling 1)', () => {
  it('places every beat at startSample + (b - offset) on a rate-MATCHED clip', () => {
    const { beats } = mapBeatsToClip(grid(), clip({ startSample: 1000 }), SR, SR);
    expect(beats).toEqual([1000, 23050, 45100, 67150, 89200]);
  });

  it('scales by sessionRate/docRate on a rate-MISMATCHED clip (48k doc in a 44.1k session)', () => {
    // Half a second of source audio is half a second of session audio whatever
    // the rates: 24 000 source samples at 48k must land 22 050 session samples
    // in, exactly as readClipSlice's resample places them.
    const { beats } = mapBeatsToClip(grid48(), clip({ startSample: 500 }), 48000, SR);
    expect(beats).toEqual([500, 22550, 44600, 66650, 88700]);
  });

  it('rounds rather than truncates — a fractional sample lands on the nearer one', () => {
    // One source sample at 48k = 44100/48000 = 0.91875 session samples.
    const g = grid48({ beatSamples: Int32Array.from([0, 1, 2]) });
    const { beats } = mapBeatsToClip(g, clip(), 48000, SR);
    expect(beats).toEqual([0, 1, 2]); // 0, 0.919 -> 1, 1.838 -> 2
  });

  it('honours offsetSample > 0: earlier beats are dropped and the rest shift left', () => {
    const { beats } = mapBeatsToClip(
      grid(),
      clip({ startSample: 10000, offsetSample: 44100, lengthSample: 44100 }),
      SR,
      SR
    );
    // Source beats 0 and 22050 are before the clip's window; 44100 lands on the
    // clip's left edge and 66150 half a second in. 88200 is the clip's
    // exclusive source end and belongs to whatever follows it.
    expect(beats).toEqual([10000, 32050]);
  });

  it('reads offsetSample in SOURCE samples while startSample/lengthSample stay in session samples', () => {
    const { beats } = mapBeatsToClip(
      grid48(),
      clip({ startSample: 0, offsetSample: 24000, lengthSample: 88200 }),
      48000,
      SR
    );
    // offset 24 000 SOURCE samples = 0.5 s in; the clip's 88 200 SESSION
    // samples = 2 s = 96 000 source samples, so source beats 24000 .. 96000 are
    // inside its window and land half a session second apart.
    expect(beats).toEqual([0, 22050, 44100, 66150]);
  });

  it('never emits a position outside the clip extent', () => {
    const { beats } = mapBeatsToClip(
      grid({ beatSamples: Int32Array.from([0, 22050, 44100, 66150, 88200, 110250]) }),
      clip({ startSample: 7, offsetSample: 22050, lengthSample: 66150 }),
      SR,
      SR
    );
    for (const b of beats) {
      expect(b).toBeGreaterThanOrEqual(7);
      expect(b).toBeLessThanOrEqual(7 + 66150);
    }
    expect(beats).toEqual([7, 22057, 44107]);
  });

  it('treats the clip\'s source end as EXCLUSIVE, so a seam beat is drawn once, on the later clip', () => {
    // Two clips splitting one document at source sample 44100 — the readClipSlice
    // window is [offset, offset+span), so the beat AT the seam is the second
    // clip's first beat and not the first clip's last.
    const left = mapBeatsToClip(grid(), clip({ startSample: 0, offsetSample: 0, lengthSample: 44100 }), SR, SR);
    const right = mapBeatsToClip(
      grid(),
      clip({ startSample: 44100, offsetSample: 44100, lengthSample: 44100 }),
      SR,
      SR
    );
    expect(left.beats).toEqual([0, 22050]);
    expect(right.beats).toEqual([44100, 66150]);
    expect(left.beats.filter((b) => b === 44100)).toHaveLength(0);
  });

  it('stops at analyzedEndSample — the grid is never extrapolated past the analysed prefix', () => {
    const { beats } = mapBeatsToClip(
      grid({ analyzedEndSample: 50000 }),
      clip({ lengthSample: 200000 }),
      SR,
      SR
    );
    expect(beats).toEqual([0, 22050, 44100]);
  });

  it('reports the ORIGINAL beat index for each mapped position', () => {
    const { beats, beatIndex } = mapBeatsToClip(
      grid(),
      clip({ offsetSample: 44100, lengthSample: 44100 }),
      SR,
      SR
    );
    expect(beats.length).toBe(beatIndex.length);
    expect(beatIndex).toEqual([2, 3]);
  });

  it('never mutates or sorts the shared Int32Array', () => {
    const g = grid();
    const before = Array.from(g.beatSamples);
    mapBeatsToClip(g, clip({ startSample: 999, offsetSample: 100 }), SR, SR);
    expect(Array.from(g.beatSamples)).toEqual(before);
  });

  it('is O(log n + beats-in-clip): a narrow clip on a huge grid reads only its own window', () => {
    // Nothing about the RESULT distinguishes a binary search from a linear walk,
    // so the element reads are counted directly: 20 000 beats, a clip holding
    // two of them.
    let reads = 0;
    const raw = Int32Array.from({ length: 20000 }, (_, i) => i * 22050);
    const view = new Proxy(
      { length: raw.length },
      {
        get(_t, prop) {
          if (prop === 'length') return raw.length;
          const i = typeof prop === 'string' ? Number(prop) : NaN;
          if (Number.isInteger(i)) {
            reads++;
            return raw[i];
          }
          return undefined;
        },
      }
    ) as unknown as Int32Array;

    const g = grid({ beatSamples: view, analyzedEndSample: 20000 * 22050 });
    const { beats } = mapBeatsToClip(
      g,
      clip({ startSample: 0, offsetSample: 10000 * 22050, lengthSample: 44100 }),
      SR,
      SR
    );
    expect(beats).toHaveLength(2);
    expect(reads).toBeLessThan(60);
  });
});

// ---------------------------------------------------------------------------
// 2. Trimmed clips
// ---------------------------------------------------------------------------

describe('mapBeatsToClip — trimmed clips', () => {
  it('follows a start-trim exactly on a rate-matched clip', () => {
    // trimClip('start', 22050): startSample += 22050, offsetSample += 22050,
    // lengthSample -= 22050. Every beat keeps its session position.
    const trimmed = clip({ startSample: 22050, offsetSample: 22050, lengthSample: 88200 });
    expect(mapBeatsToClip(grid(), trimmed, SR, SR).beats).toEqual([22050, 44100, 66150, 88200]);
  });

  it('follows an end-trim: offsetSample is untouched, the source window just shortens', () => {
    expect(mapBeatsToClip(grid(), clip({ lengthSample: 66150 }), SR, SR).beats).toEqual([
      0, 22050, 44100,
    ]);
  });

  it('stays glued to the audio the clip actually plays after a start-trim on a rate-MISMATCHED clip', () => {
    // PRE-EXISTING INCONSISTENCY, deliberately NOT compensated for here:
    // trimClip('start') adds a SESSION-sample delta to offsetSample, which is a
    // SOURCE index (sessionStore.ts:229). On a 48k document in a 44.1k session a
    // 44 100-session-sample trim therefore advances the source read by 44 100
    // SOURCE samples instead of the 48 000 that one session second represents.
    // readClipSlice reads from that same offsetSample, so the AUDIO is displaced
    // by exactly the same amount — and because this mapping is expressed
    // relative to offsetSample too, the tics are displaced with it. The tics
    // stay aligned to the audio; what is off is the clip's source window, which
    // is not B3's bug to fix.
    const untrimmed = clip({ startSample: 0, offsetSample: 0, lengthSample: 88200 });
    const trimmed = clip({ startSample: 44100, offsetSample: 44100, lengthSample: 44100 });

    expect(mapBeatsToClip(grid48(), untrimmed, 48000, SR).beats).toEqual([0, 22050, 44100, 66150]);

    // The trimmed window starts at SOURCE sample 44 100 (not the 48 000 one
    // session second represents), so its first beat — source 48 000 — sits
    // round((48000 - 44100) * 44100/48000) = 3583 session samples past the new
    // left edge instead of on it. The audio carries the identical 3583-sample
    // displacement.
    const after = mapBeatsToClip(grid48(), trimmed, 48000, SR).beats;
    expect(after).toEqual([47683, 69733]);
    for (const b of after) {
      expect(b).toBeGreaterThanOrEqual(44100);
      expect(b).toBeLessThanOrEqual(88200);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. ticWindow — bounded cost on unculled clips
// ---------------------------------------------------------------------------

describe('ticWindow', () => {
  const VIEW = 1024;

  it('covers a whole clip that fits on screen', () => {
    expect(ticWindow(0, 300, VIEW)).toEqual({ start: 0, width: 300 });
  });

  it('caps a clip far wider than any screen at the viewport (plus at most two quanta)', () => {
    const w = ticWindow(0, 2_000_000, VIEW);
    expect(w.start).toBe(0);
    expect(w.width).toBeLessThanOrEqual(VIEW + 2 * TIC_WINDOW_QUANTUM_PX);
    expect(w.width).toBeGreaterThanOrEqual(VIEW);
  });

  it('is bounded for EVERY clip width and scroll position — the property that matters', () => {
    for (const origin of [-10_000, -1, 0, 1, 999, 250_000]) {
      for (const width of [2, 300, 5000, 2_000_000, 50_000_000]) {
        const w = ticWindow(origin, width, VIEW);
        expect(w.width).toBeLessThanOrEqual(VIEW + 2 * TIC_WINDOW_QUANTUM_PX);
        expect(w.width).toBeGreaterThanOrEqual(0);
        expect(w.start).toBeGreaterThanOrEqual(0);
        // A non-empty window never leaves the clip it belongs to.
        if (w.width > 0) expect(w.start + w.width).toBeLessThanOrEqual(width);
      }
    }
  });

  it('follows the scroll into the middle of a very wide clip', () => {
    const w = ticWindow(100_000, 2_000_000, VIEW);
    expect(w.start).toBeLessThanOrEqual(100_000);
    expect(w.start).toBeGreaterThan(100_000 - TIC_WINDOW_QUANTUM_PX);
    expect(w.start + w.width).toBeGreaterThanOrEqual(100_000 + VIEW);
  });

  it('is EMPTY for a clip entirely off the right of the lane', () => {
    expect(ticWindow(-100_000, 300, VIEW).width).toBe(0);
  });

  it('is EMPTY for a clip entirely off the left of the lane', () => {
    expect(ticWindow(100_000, 5000, VIEW).width).toBe(0);
  });

  it('changes only at quantum boundaries, so a drag does not resize the canvas every frame', () => {
    // Both edges are step functions of the same quantum, so a full quantum of
    // movement crosses at most one boundary on each edge: three distinct
    // windows at worst, against 256 for an unquantised one.
    const seen = new Set<string>();
    for (let dx = 0; dx < TIC_WINDOW_QUANTUM_PX; dx++) {
      const w = ticWindow(1000 + dx, 500_000, VIEW);
      seen.add(`${w.start}:${w.width}`);
    }
    expect(seen.size).toBeLessThanOrEqual(3);
  });

  it('is empty rather than wrong for a degenerate viewport or clip', () => {
    expect(ticWindow(0, 300, 0).width).toBe(0);
    expect(ticWindow(0, 0, VIEW).width).toBe(0);
    expect(ticWindow(Number.NaN, 300, VIEW).width).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 3b. laneWidthBound — V1, the bound ticWindow is actually handed
// ---------------------------------------------------------------------------

describe('laneWidthBound', () => {
  it('takes the header column off the window width, then rounds OUT to a quantum', () => {
    // Every track row is [TrackHeader | TrackLane], so no lane in any layout is
    // wider than `windowPx - MT_HEADER_W`. The rounding out is what keeps both
    // of `ticWindow`'s edges stepping together (see the lockstep suite below);
    // it is never wider than the raw window width the bound replaced, and on a
    // window that is not itself a whole number of quanta it is tighter.
    expect(laneWidthBound(1920)).toBe(1792); // 1696 rounded out — 128 px tighter
    expect(laneWidthBound(1440)).toBe(1280); // 1216 rounded out — 160 px tighter
    expect(laneWidthBound(1024)).toBe(1024); // 800 rounded out — equal, not tighter
    for (const windowPx of [1024, 1366, 1440, 1600, 1920, 2560, 3440, 3840]) {
      expect(laneWidthBound(windowPx)).toBeLessThanOrEqual(windowPx);
    }
  });

  it('is 0, never negative, for a window no wider than the header column', () => {
    // A negative bound would make `ticWindow`'s end edge run BACKWARDS past its
    // start; 0 makes the band empty, which is what a lane of no width means.
    expect(laneWidthBound(MT_HEADER_W)).toBe(0);
    expect(laneWidthBound(10)).toBe(0);
    expect(ticWindow(0, 5000, laneWidthBound(10)).width).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 3c. The band's edge LOCKSTEP — how OFTEN the canvases are reallocated
// ---------------------------------------------------------------------------

/**
 * `ticWindow` results seen while the lane origin travels `travelPx` clip-local
 * px, counted as TRANSITIONS — the number of times the answer CHANGES.
 *
 * This is deliberately a different measurement from the "at most 3 distinct
 * windows per quantum" pin above, and the difference is the whole point: a
 * distinct-value count cannot see how often the value moves. Every transition
 * costs both of a clip's canvases a backing-store reallocation and a full
 * re-rasterisation, so the transition RATE is the cost this module's whole
 * quantisation design exists to hold down, and it was the thing an earlier
 * V1 draft regressed (from 1.00 to 2.00 per quantum) with every existing
 * assertion still green.
 */
function bandTransitions(bound: number, travelPx: number, from = 1000.25): number {
  const CLIP_PX = 50_000_000; // far wider than any band, so `end` never clamps
  let previous: string | null = null;
  let transitions = 0;
  for (let origin = from; origin <= from + travelPx; origin += 0.5) {
    const w = ticWindow(origin, CLIP_PX, bound);
    const key = `${w.start}:${w.width}`;
    if (previous !== null && key !== previous) transitions++;
    previous = key;
  }
  return transitions;
}

describe('band edge lockstep', () => {
  const QUANTA = 4;
  const TRAVEL = QUANTA * TIC_WINDOW_QUANTUM_PX;

  it('changes ONCE per quantum of travel at every real window width', () => {
    // `start` snaps DOWN and `end` snaps UP to the same 256-px grid, so the two
    // edges only step at the same scroll positions when the bound between them
    // is a whole number of quanta. Then a clip re-rasterises once per 256 px of
    // scroll or drag — which is exactly what `TIC_WINDOW_QUANTUM_PX`'s docblock
    // promises the reader.
    for (const windowPx of [1024, 1280, 1366, 1440, 1600, 1920, 2560, 3440, 3840]) {
      expect(bandTransitions(laneWidthBound(windowPx), TRAVEL)).toBe(QUANTA);
    }
  });

  it('is a whole number of quanta, because an unaligned bound doubles the rate', () => {
    // The regression this guard exists for, stated as the arithmetic that
    // causes it: a bound of `innerWidth - 224` puts `end`'s steps at
    // `origin = 224 (mod 256)` while `start`'s stay at `0 (mod 256)`, so the
    // band changes twice as often for no extra coverage.
    expect(bandTransitions(1024 - MT_HEADER_W, TRAVEL)).toBe(2 * QUANTA);
    for (const windowPx of [1024, 1366, 1600, 1920, 2560, 3840]) {
      expect(laneWidthBound(windowPx) % TIC_WINDOW_QUANTUM_PX).toBe(0);
    }
  });

  it('costs ONE extra step at an origin landing exactly on a quantum, and that is all', () => {
    // Stated rather than sampled around, because it is real and it is not what
    // the guard above is about. `start` floors and `end` ceils, so an origin
    // landing EXACTLY on a multiple of the quantum is the one position where
    // the two disagree: `start` has already stepped, `end` has not, and the
    // band is one quantum narrower for that single position before widening
    // again. A scroll offset is a float derived from samples/pixel, so this is
    // a measure-zero state — and it behaves identically with an unaligned
    // bound, so it neither caused the regression nor is fixed by the rounding.
    const q = TIC_WINDOW_QUANTUM_PX;
    expect(ticWindow(1024, 50_000_000, laneWidthBound(1024))).toEqual({ start: 1024, width: 1024 });
    expect(ticWindow(1024.5, 50_000_000, laneWidthBound(1024))).toEqual({
      start: 1024,
      width: 1280,
    });
    // Sampling straight through those points doubles the count for aligned and
    // unaligned bounds alike — which is exactly why it is not the measurement.
    expect(bandTransitions(laneWidthBound(1024), 4 * q, 1000)).toBe(8);
    expect(bandTransitions(1024 - MT_HEADER_W, 4 * q, 1000)).toBe(8);
  });

  it('never buys that alignment with a hole at the right of a clip', () => {
    // Rounding the lane width OUT is what keeps the bound an upper bound.
    // Rounding it in (flooring) would put the band's right edge short of the
    // lane's, leaving an unrastered strip of every wide clip — a visible hole,
    // which is strictly worse than the columns an over-wide band costs.
    for (let windowPx = MT_HEADER_W; windowPx <= 4096; windowPx += 7) {
      const bound = laneWidthBound(windowPx);
      expect(bound).toBeGreaterThanOrEqual(windowPx - MT_HEADER_W);
      expect(bound - (windowPx - MT_HEADER_W)).toBeLessThan(TIC_WINDOW_QUANTUM_PX);
    }
  });

  it('can round out PAST the window width, by less than the header column', () => {
    // Recorded rather than papered over: on a window whose width sits just past
    // a quantum boundary the rounded bound exceeds the window itself (a 1000 px
    // window bounds at 1024). It is still an upper bound on the LANE, which is
    // all `ticWindow` needs, and the excess is bounded — so this is a few dozen
    // raster columns, never a wrong picture. Flooring instead would trade those
    // columns for the hole the previous test rules out.
    expect(laneWidthBound(1000)).toBe(1024);
    for (let windowPx = MT_HEADER_W; windowPx <= 4096; windowPx += 1) {
      expect(laneWidthBound(windowPx) - windowPx).toBeLessThan(MT_HEADER_W);
    }
  });
});

// ---------------------------------------------------------------------------
// 4. buildClipTicOverlay — the renderer-shaped result
// ---------------------------------------------------------------------------

describe('buildClipTicOverlay', () => {
  it('returns null for no grid at all', () => {
    expect(buildClipTicOverlay(null, clip(), SR, SR)).toBeNull();
  });

  it('returns null when the mapped set is EMPTY — a normal outcome, not an error', () => {
    // The clip sits entirely past the analysed prefix.
    expect(
      buildClipTicOverlay(
        grid({ analyzedEndSample: 10000 }),
        clip({ offsetSample: 50000, lengthSample: 10000 }),
        SR,
        SR
      )
    ).toBeNull();
  });

  it('refuses a grid expressed in a DIFFERENT rate from the clip source rather than guessing', () => {
    expect(buildClipTicOverlay(grid({ sampleRate: 48000 }), clip(), SR, SR)).toBeNull();
  });

  it('refuses a non-positive or non-finite rate rather than dividing by it', () => {
    expect(buildClipTicOverlay(grid(), clip(), 0, SR)).toBeNull();
    expect(buildClipTicOverlay(grid(), clip(), Number.NaN, SR)).toBeNull();
    expect(buildClipTicOverlay(grid(), clip(), SR, 0)).toBeNull();
  });

  it('clips the draw window to the clip extent with endSample as well as by mapping', () => {
    const built = buildClipTicOverlay(grid(), clip({ startSample: 100, lengthSample: 44100 }), SR, SR);
    expect(built!.endSample).toBe(44200);
  });

  it('supplies NO isDownbeat predicate when no metre was measured', () => {
    expect(buildClipTicOverlay(grid(), clip(), SR, SR)!.isDownbeat).toBeUndefined();
  });

  it('remaps isDownbeat onto the ORIGINAL beat index, not the mapped one', () => {
    // beatsPerBar 2 / phase 0 / 2 bars -> source beats 0, 2 and 4 are downbeats.
    // A clip starting at source beat 1 must report ITS beats 1 and 3 as down.
    const g = grid({ beatsPerBar: 2, downbeatPhase: 0, barCount: 2 });
    const built = buildClipTicOverlay(g, clip({ offsetSample: 22050, lengthSample: 88200 }), SR, SR)!;
    expect(built.beats).toHaveLength(4); // source beats 1..4
    expect(built.isDownbeat!(0)).toBe(false); // source index 1
    expect(built.isDownbeat!(1)).toBe(true); // source index 2
    expect(built.isDownbeat!(2)).toBe(false); // source index 3
    expect(built.isDownbeat!(3)).toBe(true); // source index 4
  });

  it('marks a stale or low-confidence grid provisional, exactly as the editor band does', () => {
    expect(buildClipTicOverlay(grid({ stale: true }), clip(), SR, SR)!.provisional).toBe(true);
    expect(
      buildClipTicOverlay(grid({ confidence: CONFIDENCE_LOW - 0.01 }), clip(), SR, SR)!.provisional
    ).toBe(true);
    expect(buildClipTicOverlay(grid(), clip(), SR, SR)!.provisional).toBe(false);
  });

  it('hands the renderer a fresh number[] — never the shared Int32Array', () => {
    const g = grid();
    const built = buildClipTicOverlay(g, clip(), SR, SR)!;
    expect(Array.isArray(built.beats)).toBe(true);
    expect(built.beats).not.toBe(g.beatSamples as unknown as number[]);
  });
});

// ---------------------------------------------------------------------------
// 4. useClipBeatTics — resolution, reactivity and the missing-document case
// ---------------------------------------------------------------------------

function clickTrain(bpm: number, seconds: number, sr = SR): Float32Array {
  const n = Math.round(seconds * sr);
  const out = new Float32Array(n);
  const interval = Math.round((60 / bpm) * sr);
  for (let i = 0; i < n; i += interval) out[i] = 1;
  return out;
}

function seedDoc(channels: Float32Array[], sampleRate = SR, name = 'test.wav'): AudioDocument {
  const doc = createDocument({ name, sampleRate, channels });
  useAppStore.getState().addDocument(doc);
  return doc;
}

describe('useClipBeatTics', () => {
  beforeEach(() => {
    useAppStore.setState(makeInitialState());
    clearAllTempo();
    clearBeatGridLinks();
    _resetTempoWorkerTestState();
    setBeatGridVisible(true);
  });

  it('returns null when the clip has OUTLIVED its source document — there is no rate to convert with', () => {
    const { result } = renderHook(() =>
      useClipBeatTics(clip({ documentId: 'gone' }), undefined, SR)
    );
    expect(result.current).toBeNull();
  });

  it('returns null when the source has no cached analysis — nothing drawn, nothing thrown', () => {
    const doc = seedDoc([clickTrain(120, 4)]);
    const { result } = renderHook(() =>
      useClipBeatTics(clip({ documentId: doc.id, lengthSample: doc.channels[0].length }), doc, SR)
    );
    expect(result.current).toBeNull();
  });

  it("draws the source document's own grid once it is analysed", async () => {
    const doc = seedDoc([clickTrain(120, 8)]);
    const analysis = await runTempoAnalysis(doc);
    expect(analysis!.beatSamples.length).toBeGreaterThan(4);

    const { result } = renderHook(() =>
      useClipBeatTics(clip({ documentId: doc.id, lengthSample: doc.channels[0].length }), doc, SR)
    );
    expect(result.current!.beats.length).toBe(analysis!.beatSamples.length);
    expect(result.current!.beats[0]).toBe(analysis!.beatSamples[0]);
  });

  it("a STEM clip resolves through its PARENT's grid — the workflow this feature exists for", async () => {
    // Five stems plus the source is six documents against a four-row analysis
    // cache, so a per-clip getTempo cannot work here; the clip has to go through
    // getBeatGrid, which implements the inheritance.
    const source = seedDoc([clickTrain(120, 8)], SR, 'Song.wav');
    const analysis = await runTempoAnalysis(source);
    const stem = seedDoc(
      source.channels.map((c) => Float32Array.from(c)),
      SR,
      'Song — Drums'
    );
    linkDerivedDocument(stem.id, source.id);

    const { result } = renderHook(() =>
      useClipBeatTics(clip({ documentId: stem.id, lengthSample: stem.channels[0].length }), stem, SR)
    );

    expect(result.current).not.toBeNull();
    // Stems are sample-identical to the parent, so the positions are identical.
    expect(result.current!.beats).toEqual(Array.from(analysis!.beatSamples));
  });

  it('a stem clip and its source clip agree beat for beat — one grid, not five', async () => {
    const source = seedDoc([clickTrain(120, 8)], SR, 'Song.wav');
    await runTempoAnalysis(source);
    const stem = seedDoc(
      source.channels.map((c) => Float32Array.from(c)),
      SR,
      'Song — Bass'
    );
    linkDerivedDocument(stem.id, source.id);

    const len = source.channels[0].length;
    const { result: a } = renderHook(() =>
      useClipBeatTics(clip({ documentId: source.id, lengthSample: len }), source, SR)
    );
    const { result: b } = renderHook(() =>
      useClipBeatTics(clip({ id: 'clip-2', documentId: stem.id, lengthSample: len }), stem, SR)
    );
    expect(b.current!.beats).toEqual(a.current!.beats);
  });

  it("inherits the parent's measured downbeats too", async () => {
    const source = seedDoc([clickTrain(120, 8)], SR, 'Song.wav');
    const remix = await runRemixAnalysis(source);
    expect(remix!.numBars).toBeGreaterThan(0);
    const stem = seedDoc(
      source.channels.map((c) => Float32Array.from(c)),
      SR,
      'Song — Drums'
    );
    linkDerivedDocument(stem.id, source.id);

    const { result } = renderHook(() =>
      useClipBeatTics(clip({ documentId: stem.id, lengthSample: stem.channels[0].length }), stem, SR)
    );
    const pred = result.current!.isDownbeat;
    expect(pred).toBeDefined();
    let down = 0;
    for (let i = 0; i < result.current!.beats.length; i++) if (pred!(i)) down++;
    expect(down).toBe(remix!.barBoundary.length);
  });

  it('appears when the analysis COMPLETES, with nothing else about the clip changing', async () => {
    // Nothing in ClipView's own inputs moves when an analysis lands, so without
    // `useBeatGridVersion()` in the memo the tics would wait for an unrelated
    // re-render before showing up (trap 19).
    const doc = seedDoc([clickTrain(120, 8)]);
    const c = clip({ documentId: doc.id, lengthSample: doc.channels[0].length });
    const { result } = renderHook(() => useClipBeatTics(c, doc, SR));
    expect(result.current).toBeNull();

    await act(async () => {
      await runTempoAnalysis(doc);
    });

    expect(result.current).not.toBeNull();
    expect(result.current!.beats.length).toBeGreaterThan(4);
  });

  it('returns null while the toggle is off', async () => {
    const doc = seedDoc([clickTrain(120, 8)]);
    await runTempoAnalysis(doc);
    setBeatGridVisible(false);
    const { result } = renderHook(() =>
      useClipBeatTics(clip({ documentId: doc.id, lengthSample: doc.channels[0].length }), doc, SR)
    );
    expect(result.current).toBeNull();
  });

  it('keeps a STABLE identity across re-renders so the clip does not repaint on every render', async () => {
    const doc = seedDoc([clickTrain(120, 8)]);
    await runTempoAnalysis(doc);
    const c = clip({ documentId: doc.id, lengthSample: doc.channels[0].length });
    const { result, rerender } = renderHook(() => useClipBeatTics(c, doc, SR));
    const first = result.current;
    rerender();
    rerender();
    expect(result.current).toBe(first);
  });

  it('exposes a tic band that fits inside a lane', () => {
    expect(CLIP_TIC_BAND_PX).toBeGreaterThan(0);
    expect(CLIP_TIC_BAND_PX).toBeLessThan(96 - 8);
  });
});
