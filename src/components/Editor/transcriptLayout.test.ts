import {
  layoutTranscriptRegions,
  speakerColor,
  MIN_REGION_PX,
  SPEAKER_COLORS,
} from './transcriptLayout';
import { MAX_SPEAKERS } from '../../dsp/speakerClustering';
import type { TranscriptEntry } from '../../services/transcribeService';

function seg(index: number, startSample: number, endSample: number, speaker: number | null = 0): TranscriptEntry {
  return {
    index,
    startSample,
    endSample,
    text: `segment ${index}`,
    speaker,
    avgLogprob: -0.3,
    noSpeechProb: 0.01,
    compressionRatio: 1.2,
  };
}

// The viewport used by nearly every case: 100 px at 10 samples/px starting at
// sample 1000, i.e. samples [1000, 2000). Every boundary below is expressed
// against those two numbers so an off-by-one is visible in the literal.
const VIEW = { scrollSample: 1000, samplesPerPixel: 10, width: 100 };

describe('layoutTranscriptRegions — geometry', () => {
  it('maps a fully visible segment to its exact pixel span', () => {
    const out = layoutTranscriptRegions([seg(0, 1200, 1500)], VIEW);
    expect(out).toHaveLength(1);
    // (1200 - 1000)/10 = 20 ; (1500 - 1000)/10 = 50 ; width 30
    expect(out[0].x).toBe(20);
    expect(out[0].width).toBe(30);
    expect(out[0].segmentIndex).toBe(0);
    expect(out[0].startSample).toBe(1200);
    expect(out[0].endSample).toBe(1500);
  });

  it('keeps a segment that starts before the viewport, with a negative x', () => {
    const out = layoutTranscriptRegions([seg(3, 500, 1300)], VIEW);
    expect(out).toHaveLength(1);
    expect(out[0].x).toBe(-50); // (500 - 1000)/10
    expect(out[0].width).toBe(80); // (1300 - 500)/10
  });

  it('preserves input order and the segment index as the key', () => {
    const out = layoutTranscriptRegions([seg(7, 1100, 1200), seg(8, 1300, 1400)], VIEW);
    expect(out.map((r) => r.segmentIndex)).toEqual([7, 8]);
  });

  it('carries text and speaker through unchanged', () => {
    const out = layoutTranscriptRegions([seg(2, 1100, 1200, 3)], VIEW);
    expect(out[0].text).toBe('segment 2');
    expect(out[0].speaker).toBe(3);
  });

  it('carries a null speaker through as null rather than coercing it', () => {
    const out = layoutTranscriptRegions([seg(2, 1100, 1200, null)], VIEW);
    expect(out[0].speaker).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The culling window. Each comparison is probed in BOTH operand roles
// (segment end vs viewStart, segment start vs viewEnd) at below / on / above,
// sized so one sample decides the outcome.
// ---------------------------------------------------------------------------

describe('layoutTranscriptRegions — left edge: endSample > viewStart', () => {
  it('drops a segment ending one sample BEFORE the viewport start', () => {
    expect(layoutTranscriptRegions([seg(0, 900, 999)], VIEW)).toHaveLength(0);
  });

  it('drops a segment ending EXACTLY at the viewport start (half-open: no visible pixel)', () => {
    expect(layoutTranscriptRegions([seg(0, 900, 1000)], VIEW)).toHaveLength(0);
  });

  it('keeps a segment ending one sample AFTER the viewport start', () => {
    const out = layoutTranscriptRegions([seg(0, 900, 1001)], VIEW);
    expect(out).toHaveLength(1);
    expect(out[0].endSample).toBe(1001);
  });
});

describe('layoutTranscriptRegions — right edge: startSample < viewEnd', () => {
  // viewEnd = 1000 + 100*10 = 2000.
  it('keeps a segment starting one sample BEFORE the viewport end', () => {
    const out = layoutTranscriptRegions([seg(0, 1999, 3000)], VIEW);
    expect(out).toHaveLength(1);
    expect(out[0].startSample).toBe(1999);
  });

  it('drops a segment starting EXACTLY at the viewport end (that sample belongs to the next screenful)', () => {
    expect(layoutTranscriptRegions([seg(0, 2000, 3000)], VIEW)).toHaveLength(0);
  });

  it('drops a segment starting one sample AFTER the viewport end', () => {
    expect(layoutTranscriptRegions([seg(0, 2001, 3000)], VIEW)).toHaveLength(0);
  });
});

describe('layoutTranscriptRegions — the two edges are independent', () => {
  it('keeps a segment that spans the whole viewport and more', () => {
    const out = layoutTranscriptRegions([seg(0, 0, 100000)], VIEW);
    expect(out).toHaveLength(1);
    expect(out[0].x).toBe(-100);
    expect(out[0].width).toBe(10000);
  });

  it('culls only the out-of-view members of a mixed list', () => {
    const out = layoutTranscriptRegions(
      [seg(0, 0, 900), seg(1, 1100, 1200), seg(2, 2500, 2600), seg(3, 1900, 2100)],
      VIEW
    );
    expect(out.map((r) => r.segmentIndex)).toEqual([1, 3]);
  });
});

describe('layoutTranscriptRegions — minimum width', () => {
  it('gives a sub-pixel segment exactly MIN_REGION_PX rather than 0', () => {
    // 1200 -> 1204 is 4 samples = 0.4 px at 10 samples/px.
    const out = layoutTranscriptRegions([seg(0, 1200, 1204)], VIEW);
    expect(out[0].width).toBe(MIN_REGION_PX);
  });

  it('does NOT widen a segment already wider than the floor', () => {
    // 1200 -> 1215 is 1.5 px.
    const out = layoutTranscriptRegions([seg(0, 1200, 1215)], VIEW);
    expect(out[0].width).toBeCloseTo(1.5, 10);
  });

  it('a segment exactly MIN_REGION_PX wide is left alone', () => {
    const out = layoutTranscriptRegions([seg(0, 1200, 1210)], VIEW);
    expect(out[0].width).toBe(MIN_REGION_PX);
  });
});

describe('layoutTranscriptRegions — degenerate viewport', () => {
  // A segment that STRADDLES scrollSample is the case the guard actually has
  // to catch: it passes BOTH culling comparisons for every degenerate
  // viewport below, so without the guard it would reach the pixel maths and
  // emit -Infinity / Infinity / NaN geometry into the DOM. A segment wholly
  // to the RIGHT of scrollSample is culled by the right-edge comparison
  // anyway, which is why these fixtures start before it.
  const STRADDLING = seg(0, 500, 1500);

  it('returns nothing for a zero width (the ResizeObserver reads 0 on the first frame)', () => {
    expect(layoutTranscriptRegions([STRADDLING], { ...VIEW, width: 0 })).toEqual([]);
  });

  it('returns nothing for a negative width', () => {
    expect(layoutTranscriptRegions([STRADDLING], { ...VIEW, width: -10 })).toEqual([]);
  });

  it('returns nothing for a zero samplesPerPixel rather than dividing by it', () => {
    expect(layoutTranscriptRegions([STRADDLING], { ...VIEW, samplesPerPixel: 0 })).toEqual([]);
  });

  it('returns nothing for an infinite samplesPerPixel', () => {
    expect(
      layoutTranscriptRegions([STRADDLING], { ...VIEW, samplesPerPixel: Number.POSITIVE_INFINITY })
    ).toEqual([]);
  });

  it('returns nothing for a non-finite samplesPerPixel', () => {
    const out = layoutTranscriptRegions([STRADDLING], { ...VIEW, samplesPerPixel: Number.NaN });
    expect(out).toEqual([]);
  });

  it('accepts the smallest positive width and samplesPerPixel (the guard is exclusive at 0 only)', () => {
    const out = layoutTranscriptRegions([STRADDLING], { scrollSample: 1000, samplesPerPixel: 1, width: 1 });
    expect(out).toHaveLength(1);
  });

  it('returns nothing for an empty segment list', () => {
    expect(layoutTranscriptRegions([], VIEW)).toEqual([]);
  });
});

describe('speakerColor', () => {
  it('has one colour per speaker the clusterer can return', () => {
    expect(SPEAKER_COLORS).toHaveLength(MAX_SPEAKERS);
  });

  it('gives every legal speaker index its own distinct colour', () => {
    const used = new Set<string>();
    for (let i = 0; i < MAX_SPEAKERS; i++) used.add(speakerColor(i));
    expect(used.size).toBe(MAX_SPEAKERS);
  });

  it('gives an unknown speaker the muted chrome grey, distinct from every speaker colour', () => {
    const unknown = speakerColor(null);
    expect(SPEAKER_COLORS).not.toContain(unknown);
  });

  it('wraps past the end of the palette instead of returning undefined', () => {
    expect(speakerColor(MAX_SPEAKERS)).toBe(SPEAKER_COLORS[0]);
  });

  it('treats a negative or non-integer speaker as unknown', () => {
    expect(speakerColor(-1)).toBe(speakerColor(null));
    expect(speakerColor(1.5)).toBe(speakerColor(null));
  });
});
