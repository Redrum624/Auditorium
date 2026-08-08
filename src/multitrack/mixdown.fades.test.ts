import { createDocument, type AudioDocument } from '../audio/AudioDocument';
import { crossfadeGains, fadeInShape, fadeOutShape } from '../dsp/fades';
import type { Clip, Session, Track } from './session';
import { mixdownSession, monoPanGains, readClipSlice, stereoBalanceGains } from './mixdown';

// ---------------------------------------------------------------------------
// X3: clip fades and same-track overlap crossfades in the OFFLINE mixdown.
//
// Conventions shared by every fixture here:
//  - `pan: -1` on mono material makes `gL = cos(0) = 1` EXACTLY, so the left
//    channel is the bare enveloped sample and expected values need no pan
//    factor. The right channel is 0.
//  - Solo-fade expectations are written as LITERAL formulas (`Math.sin(...)`,
//    `1 - j / (n - 1)`), independent of the code under test; crossfade
//    expectations call X1's `crossfadeGains` (the pinned law is the spec, the
//    WIRING is what these tests exercise).
//  - Several overlap fixtures use `equal-gain` facing curves deliberately: at
//    `rho = 0` the equal-power pair has `k = 1`, making the crossfade
//    numerically identical to the two raw solo fades -- correct, but blind to
//    whether the law engaged. `equal-gain`'s `k = sqrt((1-t)^2 + t^2) < 1`
//    makes "crossfade fired" vs "solo fades raw-summed" distinguishable.
// ---------------------------------------------------------------------------

let clipSeq = 0;
let trackSeq = 0;

function clip(partial: Partial<Clip> & { documentId: string }): Clip {
  return {
    id: `clip-${++clipSeq}`,
    startSample: 0,
    offsetSample: 0,
    lengthSample: 0,
    gainDb: 0,
    ...partial,
  };
}

function track(partial: Partial<Track> = {}): Track {
  return {
    id: `track-${++trackSeq}`,
    name: 'T',
    volumeDb: 0,
    pan: 0,
    muted: false,
    solo: false,
    armed: false,
    clips: [],
    ...partial,
  };
}

function session(tracks: Track[], sampleRate = 44100): Session {
  return { name: 'S', sampleRate, tracks };
}

function monoDoc(id: string, data: number[] | Float32Array, sampleRate = 44100): AudioDocument {
  const ch = data instanceof Float32Array ? data : Float32Array.from(data);
  const doc = createDocument({ name: id, sampleRate, channels: [ch] });
  return { ...doc, id };
}

function docsMap(...docs: AudioDocument[]): Map<string, AudioDocument> {
  return new Map(docs.map((d) => [d.id, d]));
}

function constDoc(id: string, value: number, length: number, sampleRate = 44100): AudioDocument {
  return monoDoc(id, new Float32Array(length).fill(value), sampleRate);
}

/**
 * v1.8.0's mixdown arithmetic, replicated literally for the ruling-10
 * byte-identity pin: per-clip combined gain, per-clip pan law, raw `+=`
 * accumulation, one full-buffer hard clamp -- and NO fade handling of any
 * kind. Assumes every track is audible (all fixtures here comply).
 */
function referenceRawMixdown(s: Session, docs: Map<string, AudioDocument>): [Float32Array, Float32Array] {
  let length = 0;
  for (const t of s.tracks) {
    for (const c of t.clips) length = Math.max(length, c.startSample + c.lengthSample);
  }
  const L = new Float32Array(length);
  const R = new Float32Array(length);
  for (const t of s.tracks) {
    const trackGain = Math.pow(10, t.volumeDb / 20);
    for (const c of t.clips) {
      const doc = docs.get(c.documentId);
      if (!doc) continue;
      const slice = readClipSlice(doc, c, s.sampleRate);
      if (slice.length === 0 || slice[0].length === 0) continue;
      const g = Math.pow(10, c.gainDb / 20) * trackGain;
      const mono = slice.length === 1;
      const { gL, gR } = mono ? monoPanGains(t.pan) : stereoBalanceGains(t.pan);
      const chL = slice[0];
      const chR = mono ? slice[0] : slice[1];
      const base = c.startSample;
      const n = Math.min(slice[0].length, length - base);
      for (let i = 0; i < n; i++) {
        L[base + i] += chL[i] * g * gL;
        R[base + i] += chR[i] * g * gR;
      }
    }
  }
  for (let i = 0; i < length; i++) {
    L[i] = L[i] > 1 ? 1 : L[i] < -1 ? -1 : L[i];
    R[i] = R[i] > 1 ? 1 : R[i] < -1 ? -1 : R[i];
  }
  return [L, R];
}

describe('mixdownSession clip fades (solo envelopes)', () => {
  it('applies a fade-in with the default equal-power curve, exact ramp values', () => {
    // F1 lesson from X1: "values rise" passes on a broken ramp too -- only
    // exact per-sample values catch a wrong window or a wrong denominator.
    const doc = constDoc('d', 0.5, 100);
    const s = session([
      track({ pan: -1, clips: [clip({ documentId: 'd', lengthSample: 100, fadeInSample: 8 })] }),
    ]);
    const [L, R] = mixdownSession(s, docsMap(doc)).channels;

    expect(L[0]).toBe(0); // sin(0) = 0: the ramp starts in silence
    for (let i = 1; i < 8; i++) {
      expect(L[i]).toBeCloseTo(0.5 * Math.sin((i / 7) * (Math.PI / 2)), 6);
    }
    for (let i = 8; i < 100; i++) expect(L[i]).toBe(0.5); // untouched past the fade
    expect(R[50]).toBe(0); // pan -1
  });

  it('applies a fade-out with an explicit equal-gain curve, exact ramp values', () => {
    const doc = constDoc('d', 0.5, 100);
    const s = session([
      track({
        pan: -1,
        clips: [
          clip({ documentId: 'd', lengthSample: 100, fadeOutSample: 10, fadeOutCurve: 'equal-gain' }),
        ],
      }),
    ]);
    const [L] = mixdownSession(s, docsMap(doc)).channels;

    for (let i = 0; i < 90; i++) expect(L[i]).toBe(0.5);
    for (let j = 0; j < 10; j++) {
      expect(L[90 + j]).toBeCloseTo(0.5 * (1 - j / 9), 6);
    }
    expect(L[99]).toBe(0); // the last sample of an equal-gain fade-out is exactly 0
  });

  it('honours a non-default fade-in curve (exponential: t^2)', () => {
    const doc = constDoc('d', 0.5, 50);
    const s = session([
      track({
        pan: -1,
        clips: [
          clip({ documentId: 'd', lengthSample: 50, fadeInSample: 6, fadeInCurve: 'exponential' }),
        ],
      }),
    ]);
    const [L] = mixdownSession(s, docsMap(doc)).channels;
    for (let i = 0; i < 6; i++) {
      expect(L[i]).toBeCloseTo(0.5 * Math.pow(i / 5, 2), 6);
    }
    expect(L[6]).toBe(0.5);
  });

  it('renders MEETING fades (fadeIn + fadeOut === lengthSample) with both full ramps and no unity gap', () => {
    const doc = constDoc('d', 0.5, 10);
    const s = session([
      track({
        pan: -1,
        clips: [
          clip({
            documentId: 'd',
            lengthSample: 10,
            fadeInSample: 5,
            fadeInCurve: 'equal-gain',
            fadeOutSample: 5,
            fadeOutCurve: 'equal-gain',
          }),
        ],
      }),
    ]);
    const [L] = mixdownSession(s, docsMap(doc)).channels;
    // Envelope: in-ramp i/4 over [0,5), out-ramp 1-(i-5)/4 over [5,10). The
    // two ramps MEET at unity (samples 4 and 5 both 1) and cover every sample.
    const env = [0, 0.25, 0.5, 0.75, 1, 1, 0.75, 0.5, 0.25, 0];
    for (let i = 0; i < 10; i++) expect(L[i]).toBeCloseTo(0.5 * env[i], 6);
    expect(L[0]).toBe(0);
    expect(L[9]).toBe(0);
  });

  it('anchors the fade-out to clip.lengthSample, NOT to the resampled slice length (T21)', () => {
    // 22050 Hz doc in a 44100 session with lengthSample 999: the slice
    // resamples to round(round(999/2) * 2) = 1000 samples -- one LONGER than
    // the clip's timeline span. The envelope must be indexed by 999: the
    // equal-gain out-ramp occupies clip-local [899, 999) with gain 1 - j/99.
    // Anchoring to the slice tail ([900, 1000)) shifts every ramp gain by one
    // step (~0.005 at 0.5 amplitude), which the precision-3 assertions catch.
    const doc = constDoc('d', 0.5, 500, 22050);
    const silent = constDoc('z', 0, 1200);
    const s = session(
      [
        track({
          pan: -1,
          clips: [
            clip({
              documentId: 'd',
              lengthSample: 999,
              fadeOutSample: 100,
              fadeOutCurve: 'equal-gain',
            }),
          ],
        }),
        // A silent clip extends the timeline past the clip's 999-sample span,
        // so the resampled slice's 1000th sample (the overhang) is written.
        track({ clips: [clip({ documentId: 'z', lengthSample: 1200 })] }),
      ],
      44100
    );
    const [L] = mixdownSession(s, docsMap(doc, silent)).channels;
    expect(L.length).toBe(1200);
    expect(L[500]).toBeCloseTo(0.5, 3); // resampled constant, unfaded
    expect(L[899]).toBeCloseTo(0.5, 3); // first ramp sample: gain 1 - 0/99 = 1
    expect(L[949]).toBeCloseTo(0.5 * (1 - 50 / 99), 3);
    expect(L[998]).toBeCloseTo(0, 3); // last in-range ramp sample: gain 1 - 99/99 = 0
    // The slice's overhang sample sits PAST the clip's timeline span and takes
    // the fade's endpoint gain (0), not a wrapped or unfaded value.
    expect(L[999]).toBeCloseTo(0, 3);
  });
});

describe('mixdownSession same-track overlap (ruling 10: no implicit crossfade)', () => {
  it('renders an overlap with NO fade fields byte-identically to the v1.8.0 raw-sum-then-clamp', () => {
    // Amplitudes chosen so the overlap CLIPS (0.8 + 0.8 = 1.6): the pin
    // covers the clamp interaction too, not just the sum.
    const a = constDoc('a', 0.8, 1000);
    const b = constDoc('b', 0.8, 1000);
    const s = session([
      track({
        pan: -1,
        clips: [
          clip({ documentId: 'a', startSample: 0, lengthSample: 1000 }),
          clip({ documentId: 'b', startSample: 600, lengthSample: 1000 }),
        ],
      }),
    ]);
    const [L, R] = mixdownSession(s, docsMap(a, b)).channels;
    const [refL, refR] = referenceRawMixdown(s, docsMap(a, b));
    expect(L).toEqual(refL);
    expect(R).toEqual(refR);
    expect(L[700]).toBe(1); // sanity: the fixture really does flat-top today
  });

  it('renders a fade-less NON-overlapping session byte-identically too', () => {
    const a = constDoc('a', 0.8, 1000);
    const s = session([
      track({
        pan: 0.4,
        volumeDb: -2,
        clips: [
          clip({ documentId: 'a', startSample: 0, lengthSample: 500, gainDb: -3 }),
          clip({ documentId: 'a', startSample: 700, lengthSample: 800 }),
        ],
      }),
    ]);
    const [L, R] = mixdownSession(s, docsMap(a)).channels;
    const [refL, refR] = referenceRawMixdown(s, docsMap(a));
    expect(L).toEqual(refL);
    expect(R).toEqual(refR);
  });
});

describe('mixdownSession same-track overlap crossfade (the canonical pair)', () => {
  // Shared canonical geometry: A [0, 1000) with fade-out 400, B [600, 1600)
  // with fade-in 400 -- both facing fades span EXACTLY the overlap
  // [600, 1000), width w = 400. Distinct amplitudes (0.6 / 0.4) make a
  // swapped gOut/gIn unmissable.
  const W = 400;

  function canonicalSession(
    curveOut?: Clip['fadeOutCurve'],
    curveIn?: Clip['fadeInCurve']
  ): { s: Session; docs: Map<string, AudioDocument> } {
    const a = constDoc('a', 0.6, 1000);
    const b = constDoc('b', 0.4, 1000);
    const s = session([
      track({
        pan: -1,
        clips: [
          clip({
            documentId: 'a',
            startSample: 0,
            lengthSample: 1000,
            fadeOutSample: W,
            ...(curveOut ? { fadeOutCurve: curveOut } : {}),
          }),
          clip({
            documentId: 'b',
            startSample: 600,
            lengthSample: 1000,
            fadeInSample: W,
            ...(curveIn ? { fadeInCurve: curveIn } : {}),
          }),
        ],
      }),
    ]);
    return { s, docs: docsMap(a, b) };
  }

  it('renders the overlap with X1\'s law at rho 0 under the default curves, continuous at both edges', () => {
    const { s, docs } = canonicalSession();
    const [L] = mixdownSession(s, docs).channels;

    // Continuity: the first overlap sample is exactly {gOut: 1, gIn: 0} -- A
    // still at full level, B entering from silence -- and just before the
    // overlap A is untouched (its solo fade-out is superseded, not applied).
    expect(L[599]).toBe(Math.fround(0.6));
    expect(L[600]).toBe(Math.fround(0.6));
    // Inside: outgoing gets gOut, incoming gets gIn, of the SAME law call.
    for (const j of [1, 100, 199, 200, 300, 398]) {
      const { gOut, gIn } = crossfadeGains(j / (W - 1), 0);
      expect(L[600 + j]).toBeCloseTo(0.6 * gOut + 0.4 * gIn, 6);
    }
    // Last overlap sample: gIn exactly 1, gOut the equal-power residue (~0).
    expect(L[999]).toBeCloseTo(0.4, 6);
    // Past the overlap B is untouched (its solo fade-in is superseded).
    expect(L[1000]).toBe(Math.fround(0.4));
    expect(L[1599]).toBe(Math.fround(0.4));
  });

  it('engages the k-normalisation for equal-gain facing curves (crossfade, NOT raw solo fades)', () => {
    const { s, docs } = canonicalSession('equal-gain', 'equal-gain');
    const [L] = mixdownSession(s, docs).channels;

    for (const j of [50, 150, 200, 250, 350]) {
      const t = j / (W - 1);
      const { gOut, gIn } = crossfadeGains(t, 0, 'equal-gain');
      expect(L[600 + j]).toBeCloseTo(0.6 * gOut + 0.4 * gIn, 6);
      // And the law is NOT the raw solo pair here: k = sqrt((1-t)^2 + t^2)
      // < 1 away from the endpoints, so the normalised sum sits ABOVE it.
      const rawSolo = 0.6 * (1 - t) + 0.4 * t;
      expect(Math.abs(L[600 + j] - rawSolo)).toBeGreaterThan(1e-3);
    }
    expect(L[599]).toBe(Math.fround(0.6));
    expect(L[1000]).toBe(Math.fround(0.4));
  });

  it('takes each side\'s curve from ITS facing fade (mixed exponential-out / smooth-in pair)', () => {
    const { s, docs } = canonicalSession('exponential', 'smooth');
    const [L] = mixdownSession(s, docs).channels;

    for (const j of [50, 150, 250, 350]) {
      const { gOut, gIn } = crossfadeGains(j / (W - 1), 0, 'exponential', 'smooth');
      expect(L[600 + j]).toBeCloseTo(0.6 * gOut + 0.4 * gIn, 6);
    }
    // Guard against the curves being collapsed to one side: the same-curve
    // laws differ from the mixed pair by far more than the tolerance above.
    const jMid = 100;
    const mixed = crossfadeGains(jMid / (W - 1), 0, 'exponential', 'smooth');
    const allOut = crossfadeGains(jMid / (W - 1), 0, 'exponential', 'exponential');
    const allIn = crossfadeGains(jMid / (W - 1), 0, 'smooth', 'smooth');
    expect(Math.abs(0.6 * mixed.gOut + 0.4 * mixed.gIn - (0.6 * allOut.gOut + 0.4 * allOut.gIn))).toBeGreaterThan(1e-3);
    expect(Math.abs(0.6 * mixed.gOut + 0.4 * mixed.gIn - (0.6 * allIn.gOut + 0.4 * allIn.gIn))).toBeGreaterThan(1e-3);
  });

  it('does not clip where the raw sum would, and needs no help from the clamp', () => {
    // Two 0.7 clips: the raw overlap sum is 1.4 and v1.8.0 flat-tops it at
    // 1.0 for the whole region. The crossfaded render peaks at
    // 0.7 * sqrt(2) = 0.98995 (equal-power pair maximum of gOut + gIn) --
    // UNDER the clamp, so the output equals the unclamped expectation
    // everywhere: the clipping is gone, not relocated.
    const a = constDoc('a', 0.7, 1000);
    const b = constDoc('b', 0.7, 1000);
    const s = session([
      track({
        pan: -1,
        clips: [
          clip({ documentId: 'a', startSample: 0, lengthSample: 1000, fadeOutSample: W }),
          clip({ documentId: 'b', startSample: 600, lengthSample: 1000, fadeInSample: W }),
        ],
      }),
    ]);
    const [L] = mixdownSession(s, docsMap(a, b)).channels;

    let peak = 0;
    for (let j = 0; j < W; j++) {
      const { gOut, gIn } = crossfadeGains(j / (W - 1), 0);
      const expected = 0.7 * gOut + 0.7 * gIn;
      expect(expected).toBeLessThan(1); // the raw sum (1.4) would clip; this must not
      expect(L[600 + j]).toBeCloseTo(expected, 6); // clamp was a no-op here
      peak = Math.max(peak, L[600 + j]);
    }
    expect(peak).toBeCloseTo(0.7 * Math.SQRT2, 3);
    for (let i = 0; i < L.length; i++) {
      expect(L[i]).toBeLessThan(1); // no sample anywhere flat-tops
    }
  });

  it('still hard-clamps material the crossfade does not cover (the clamp pass is untouched)', () => {
    // Cross-TRACK simultaneity is not a crossfade; two full-scale clips on
    // two tracks must still flat-top exactly as before.
    const a = constDoc('a', 1.0, 100);
    const s = session([
      track({ pan: -1, clips: [clip({ documentId: 'a', lengthSample: 100 })] }),
      track({ pan: -1, clips: [clip({ documentId: 'a', lengthSample: 100 })] }),
    ]);
    const [L] = mixdownSession(s, docsMap(a)).channels;
    expect(L[50]).toBe(1);
  });

  it('renders a ONE-sample overlap at the law midpoint t = 0.5 (no 0/0 ramp, both members shaped)', () => {
    // w = 1: a one-sample ramp has no `i / (w - 1)` to evaluate -- that
    // expression is 0/0 = NaN, and the master clamp passes NaN straight
    // through into a rendered file. The implementation must take the
    // midpoint t = 0.5 instead: both sides sounding at equal, k-normalised
    // level for the single shared sample.
    const a = constDoc('a', 0.6, 500);
    const b = constDoc('b', 0.4, 500);
    const s = session([
      track({
        pan: -1,
        clips: [
          clip({ documentId: 'a', startSample: 0, lengthSample: 500, fadeOutSample: 1 }),
          clip({ documentId: 'b', startSample: 499, lengthSample: 500, fadeInSample: 1 }),
        ],
      }),
    ]);
    const [L] = mixdownSession(s, docsMap(a, b)).channels;
    expect(Number.isNaN(L[499])).toBe(false);
    const { gOut, gIn } = crossfadeGains(0.5, 0);
    expect(L[499]).toBeCloseTo(0.6 * gOut + 0.4 * gIn, 6);
    expect(L[498]).toBe(Math.fround(0.6)); // A untouched right up to the overlap
    expect(L[500]).toBe(Math.fround(0.4)); // B untouched right after it
  });

  it('keeps the pair armed when neighbours BUTT-JOIN the overlap exactly (intrusion boundary strictness)', () => {
    // One clip ends exactly at the overlap start and another starts exactly
    // at the overlap end -- the NORMAL butt-joined multitrack layout, not an
    // exotic one. Neither is inside the region, so the canonical pair must
    // still crossfade; an off-by-one in the intrusion comparison would
    // silently disarm the feature for the most common arrangement (the
    // degradation is the solo-fade fallback -- wrong level, no corruption --
    // which is exactly why only a value pin can notice it).
    const a = constDoc('a', 0.6, 1000);
    const b = constDoc('b', 0.4, 1000);
    const c = constDoc('c', 0.2, 400);
    const s = session([
      track({
        pan: -1,
        clips: [
          clip({
            documentId: 'a',
            startSample: 0,
            lengthSample: 1000,
            fadeOutSample: 400,
            fadeOutCurve: 'equal-gain',
          }),
          clip({
            documentId: 'b',
            startSample: 600,
            lengthSample: 1000,
            fadeInSample: 400,
            fadeInCurve: 'equal-gain',
          }),
          clip({ documentId: 'c', startSample: 200, lengthSample: 400 }), // ends at 600 == overlap start
          clip({ documentId: 'c', startSample: 1000, lengthSample: 400 }), // starts at 1000 == overlap end
        ],
      }),
    ]);
    const [L] = mixdownSession(s, docsMap(a, b, c)).channels;
    // The overlap itself contains neither neighbour, so its samples are the
    // pure pair law -- k-normalised equal-gain, distinguishable from the
    // solo-fade fallback by > 1e-3 at these positions.
    for (const j of [50, 200, 350]) {
      const { gOut, gIn } = crossfadeGains(j / 399, 0, 'equal-gain');
      expect(L[600 + j]).toBeCloseTo(0.6 * gOut + 0.4 * gIn, 6);
    }
  });

  it('DISARMS the pair when a neighbour intrudes one sample past the overlap END edge', () => {
    // The opposite direction of the butt-joined pin: shifting the end-edge
    // neighbour inward by ONE sample (start 999, inside [600, 1000)) makes
    // it an intruder, and the pair must fall back to solo fades over a raw
    // sum. Without this fixture, `c.startSample < aEnd` relaxed to
    // `< aEnd - 1` survives: a 1-sample intruder would leave the pair armed
    // and raw-sum a third signal over the k-normalised law -- a level error.
    const a = constDoc('a', 0.6, 1000);
    const b = constDoc('b', 0.4, 1000);
    const c = constDoc('c', 0.2, 400);
    const s = session([
      track({
        pan: -1,
        clips: [
          clip({
            documentId: 'a',
            startSample: 0,
            lengthSample: 1000,
            fadeOutSample: 400,
            fadeOutCurve: 'equal-gain',
          }),
          clip({
            documentId: 'b',
            startSample: 600,
            lengthSample: 1000,
            fadeInSample: 400,
            fadeInCurve: 'equal-gain',
          }),
          clip({ documentId: 'c', startSample: 999, lengthSample: 400 }), // 1 sample inside the overlap
        ],
      }),
    ]);
    const [L] = mixdownSession(s, docsMap(a, b, c)).channels;
    // Solo-fade fallback at samples the intruder does not cover -- and
    // distinguishably NOT the armed law.
    for (const j of [50, 200, 350]) {
      const solo = 0.6 * (1 - j / 399) + 0.4 * (j / 399);
      expect(L[600 + j]).toBeCloseTo(solo, 6);
      const { gOut, gIn } = crossfadeGains(j / 399, 0, 'equal-gain');
      expect(Math.abs(L[600 + j] - (0.6 * gOut + 0.4 * gIn))).toBeGreaterThan(1e-3);
    }
  });

  it('DISARMS the pair when a neighbour intrudes one sample past the overlap START edge', () => {
    // Mirror of the fixture above: the start-edge neighbour shifted inward
    // by one sample (ends at 601 > overlap start 600). Kills the surviving
    // relaxation of `c.end > b.startSample` to `> b.startSample + 1`.
    const a = constDoc('a', 0.6, 1000);
    const b = constDoc('b', 0.4, 1000);
    const c = constDoc('c', 0.2, 400);
    const s = session([
      track({
        pan: -1,
        clips: [
          clip({
            documentId: 'a',
            startSample: 0,
            lengthSample: 1000,
            fadeOutSample: 400,
            fadeOutCurve: 'equal-gain',
          }),
          clip({
            documentId: 'b',
            startSample: 600,
            lengthSample: 1000,
            fadeInSample: 400,
            fadeInCurve: 'equal-gain',
          }),
          clip({ documentId: 'c', startSample: 201, lengthSample: 400 }), // ends 601: 1 sample inside
        ],
      }),
    ]);
    const [L] = mixdownSession(s, docsMap(a, b, c)).channels;
    for (const j of [50, 200, 350]) {
      const solo = 0.6 * (1 - j / 399) + 0.4 * (j / 399);
      expect(L[600 + j]).toBeCloseTo(solo, 6);
      const { gOut, gIn } = crossfadeGains(j / 399, 0, 'equal-gain');
      expect(Math.abs(L[600 + j] - (0.6 * gOut + 0.4 * gIn))).toBeGreaterThan(1e-3);
    }
  });

  it('supports a chain A-B-C: one clip can be incoming on one edge and outgoing on the other', () => {
    // A [0,1000) out-fade 200; B [800,1800) in-fade 200 AND out-fade 300;
    // C [1500,2500) in-fade 300. Both pairs are canonical and their regions
    // ([800,1000) and [1500,1800)) are disjoint; B is unshaped in between.
    // A also carries a SOLO fade-in, which must coexist with its crossfade.
    const a = constDoc('a', 0.6, 1000);
    const b = constDoc('b', 0.4, 1000);
    const c = constDoc('c', 0.5, 1000);
    const s = session([
      track({
        pan: -1,
        clips: [
          clip({
            documentId: 'a',
            startSample: 0,
            lengthSample: 1000,
            fadeInSample: 100,
            fadeInCurve: 'equal-gain',
            fadeOutSample: 200,
            fadeOutCurve: 'equal-gain',
          }),
          clip({
            documentId: 'b',
            startSample: 800,
            lengthSample: 1000,
            fadeInSample: 200,
            fadeInCurve: 'equal-gain',
            fadeOutSample: 300,
            fadeOutCurve: 'equal-gain',
          }),
          clip({
            documentId: 'c',
            startSample: 1500,
            lengthSample: 1000,
            fadeInSample: 300,
            fadeInCurve: 'equal-gain',
          }),
        ],
      }),
    ]);
    const [L] = mixdownSession(s, docsMap(a, b, c)).channels;

    // A's solo fade-in still applies (literal equal-gain ramp).
    expect(L[0]).toBe(0);
    expect(L[50]).toBeCloseTo(0.6 * (50 / 99), 6);
    // First crossfade region [800, 1000).
    for (const j of [50, 100, 150]) {
      const { gOut, gIn } = crossfadeGains(j / 199, 0, 'equal-gain');
      expect(L[800 + j]).toBeCloseTo(0.6 * gOut + 0.4 * gIn, 6);
    }
    // B alone and unshaped between the two regions.
    expect(L[1200]).toBe(Math.fround(0.4));
    // Second crossfade region [1500, 1800).
    for (const j of [75, 150, 225]) {
      const { gOut, gIn } = crossfadeGains(j / 299, 0, 'equal-gain');
      expect(L[1500 + j]).toBeCloseTo(0.4 * gOut + 0.5 * gIn, 6);
    }
    // C alone afterwards.
    expect(L[2000]).toBe(Math.fround(0.5));
  });
});

describe('mixdownSession same-track overlap WITHOUT a canonical pair (solo fades over a raw sum)', () => {
  it('one-sided facing fade: the fade is honest solo shaping, the sum stays raw', () => {
    // A has a matching fade-out but B sets NO fade-in -- there is no pair to
    // normalise, so A fades out solo (equal-gain, observable against the
    // law's k) and B enters at full level.
    const a = constDoc('a', 0.6, 1000);
    const b = constDoc('b', 0.4, 1000);
    const s = session([
      track({
        pan: -1,
        clips: [
          clip({
            documentId: 'a',
            startSample: 0,
            lengthSample: 1000,
            fadeOutSample: 400,
            fadeOutCurve: 'equal-gain',
          }),
          clip({ documentId: 'b', startSample: 600, lengthSample: 1000 }),
        ],
      }),
    ]);
    const [L] = mixdownSession(s, docsMap(a, b)).channels;

    for (const j of [0, 100, 200, 300, 399]) {
      const expected = 0.6 * (1 - j / 399) + 0.4;
      expect(L[600 + j]).toBeCloseTo(expected, 6);
    }
    expect(L[1000]).toBe(Math.fround(0.4));
  });

  it('facing fades that do not span the overlap exactly stay solo fades at their OWN lengths', () => {
    // A's fade-out matches the 400-sample overlap but B's fade-in is only
    // 200: not canonical. Each fade applies solo over its own window; no
    // normalisation anywhere.
    const a = constDoc('a', 0.6, 1000);
    const b = constDoc('b', 0.4, 1000);
    const s = session([
      track({
        pan: -1,
        clips: [
          clip({
            documentId: 'a',
            startSample: 0,
            lengthSample: 1000,
            fadeOutSample: 400,
            fadeOutCurve: 'equal-gain',
          }),
          clip({
            documentId: 'b',
            startSample: 600,
            lengthSample: 1000,
            fadeInSample: 200,
            fadeInCurve: 'equal-gain',
          }),
        ],
      }),
    ]);
    const [L] = mixdownSession(s, docsMap(a, b)).channels;

    for (const j of [0, 50, 100, 199]) {
      // Inside B's 200-sample solo fade-in.
      const expected = 0.6 * (1 - j / 399) + 0.4 * (j / 199);
      expect(L[600 + j]).toBeCloseTo(expected, 6);
    }
    for (const j of [200, 300, 399]) {
      // Past B's fade-in: B at full level while A still fades out solo.
      const expected = 0.6 * (1 - j / 399) + 0.4;
      expect(L[600 + j]).toBeCloseTo(expected, 6);
    }
  });

  it('an outgoing facing fade LONGER than the overlap stays solo (rule 3 a-side, above the boundary)', () => {
    // A's fade-out is 500 over the 400-sample overlap [600, 1000) -- rule 3
    // is EXACT on the a-side, so no crossfade: A fades solo over its OWN
    // window [500, 1000), which starts BEFORE the overlap, and B's exact
    // fade-in stays a solo ramp. The USER_GUIDE documents this state: drag
    // the outgoing handle past the overlap and the pair dissolves. Sibling
    // fixtures pin below (200 < w, above) and on (canonical describe) the
    // boundary; this one pins ABOVE it, where `!== w` and `< w` disagree.
    const a = constDoc('a', 0.6, 1000);
    const b = constDoc('b', 0.4, 1000);
    const s = session([
      track({
        pan: -1,
        clips: [
          clip({
            documentId: 'a',
            startSample: 0,
            lengthSample: 1000,
            fadeOutSample: 500,
            fadeOutCurve: 'equal-gain',
          }),
          clip({
            documentId: 'b',
            startSample: 600,
            lengthSample: 1000,
            fadeInSample: 400,
            fadeInCurve: 'equal-gain',
          }),
        ],
      }),
    ]);
    const [L] = mixdownSession(s, docsMap(a, b)).channels;

    // Before the overlap A is ALREADY fading solo -- a crossfade at w = 400
    // would supersede the fade-out and hold A at full level here.
    for (const j of [50, 99]) {
      expect(L[500 + j]).toBeCloseTo(0.6 * (1 - j / 499), 6);
    }
    // Inside the overlap: each fade at its OWN length, raw-summed, no k.
    for (const j of [0, 100, 200, 300, 399]) {
      const expected = 0.6 * (1 - (100 + j) / 499) + 0.4 * (j / 399);
      expect(L[600 + j]).toBeCloseTo(expected, 6);
    }
    expect(L[1000]).toBe(Math.fround(0.4)); // B alone, fade-in complete
  });

  it('an incoming facing fade LONGER than the overlap stays solo (rule 3 b-side, above the boundary)', () => {
    // The mirror fixture: A's fade-out is exact (400 == w) but B's fade-in is
    // 500, its window [600, 1100) extending PAST the overlap -- so B is still
    // rising after A has ended. Rule 3 is exact PER MEMBER: the b-side
    // comparison must reject this on its own, with the a-side satisfied.
    const a = constDoc('a', 0.6, 1000);
    const b = constDoc('b', 0.4, 1000);
    const s = session([
      track({
        pan: -1,
        clips: [
          clip({
            documentId: 'a',
            startSample: 0,
            lengthSample: 1000,
            fadeOutSample: 400,
            fadeOutCurve: 'equal-gain',
          }),
          clip({
            documentId: 'b',
            startSample: 600,
            lengthSample: 1000,
            fadeInSample: 500,
            fadeInCurve: 'equal-gain',
          }),
        ],
      }),
    ]);
    const [L] = mixdownSession(s, docsMap(a, b)).channels;

    // Inside the overlap: solo fades at their own lengths, raw-summed.
    for (const j of [0, 100, 200, 300, 399]) {
      const expected = 0.6 * (1 - j / 399) + 0.4 * (j / 499);
      expect(L[600 + j]).toBeCloseTo(expected, 6);
    }
    // Past the overlap B is STILL fading in -- a crossfade at w = 400 would
    // have superseded the solo fade and put B at full level from 1000 on.
    for (const k of [0, 50, 99]) {
      expect(L[1000 + k]).toBeCloseTo(0.4 * ((400 + k) / 499), 6);
    }
    expect(L[1100]).toBe(Math.fround(0.4)); // fade-in complete
  });

  it('containment (B entirely inside A) never crossfades: A must not duck to zero and jump back', () => {
    // A [0, 2000) contains B [600, 1600). Both carry fades sized like a
    // canonical pair would be -- they still apply SOLO, because a handover
    // that ends with the outgoing clip still sounding is a click by
    // construction.
    const a = constDoc('a', 0.6, 2000);
    const b = constDoc('b', 0.3, 1000);
    const s = session([
      track({
        pan: -1,
        clips: [
          clip({
            documentId: 'a',
            startSample: 0,
            lengthSample: 2000,
            fadeOutSample: 1000,
            fadeOutCurve: 'equal-gain',
          }),
          clip({
            documentId: 'b',
            startSample: 600,
            lengthSample: 1000,
            fadeInSample: 1000,
            fadeInCurve: 'equal-gain',
          }),
        ],
      }),
    ]);
    const [L] = mixdownSession(s, docsMap(a, b)).channels;

    // A's solo fade-out window is [1000, 2000); B's solo fade-in [600, 1600).
    expect(L[800]).toBeCloseTo(0.6 + 0.3 * (200 / 999), 6); // A unfaded yet
    expect(L[1300]).toBeCloseTo(0.6 * (1 - 300 / 999) + 0.3 * (700 / 999), 6);
    // Right after B ends, A is STILL SOUNDING at its solo level -- the
    // outcome a mis-fired "crossfade to zero" could not produce.
    expect(L[1700]).toBeCloseTo(0.6 * (1 - 700 / 999), 6);
  });

  it('equal starts have no outgoing side and never crossfade', () => {
    const a = constDoc('a', 0.6, 500);
    const b = constDoc('b', 0.3, 500);
    const s = session([
      track({
        pan: -1,
        clips: [
          clip({
            documentId: 'a',
            startSample: 1000,
            lengthSample: 500,
            fadeInSample: 500,
            fadeInCurve: 'equal-gain',
          }),
          clip({
            documentId: 'b',
            startSample: 1000,
            lengthSample: 500,
            fadeOutSample: 500,
            fadeOutCurve: 'equal-gain',
          }),
        ],
      }),
    ]);
    const [L] = mixdownSession(s, docsMap(a, b)).channels;
    for (const j of [0, 125, 250, 375, 499]) {
      const expected = 0.6 * (j / 499) + 0.3 * (1 - j / 499);
      expect(L[1000 + j]).toBeCloseTo(expected, 6);
    }
  });

  it('a third clip inside the overlap region disarms the pair (T38: pile-ups stay raw sums)', () => {
    // A/B are canonical on their own, but C sits inside their overlap. The
    // pair law has no meaning for three simultaneous signals, so NOTHING
    // crossfades: A and B fall back to solo fades, C is raw.
    const a = constDoc('a', 0.6, 1000);
    const b = constDoc('b', 0.4, 1000);
    const c = constDoc('c', 0.2, 200);
    const s = session([
      track({
        pan: -1,
        clips: [
          clip({
            documentId: 'a',
            startSample: 0,
            lengthSample: 1000,
            fadeOutSample: 400,
            fadeOutCurve: 'equal-gain',
          }),
          clip({
            documentId: 'b',
            startSample: 600,
            lengthSample: 1000,
            fadeInSample: 400,
            fadeInCurve: 'equal-gain',
          }),
          clip({ documentId: 'c', startSample: 700, lengthSample: 200 }),
        ],
      }),
    ]);
    const [L] = mixdownSession(s, docsMap(a, b, c)).channels;

    const solo = (j: number) => 0.6 * (1 - j / 399) + 0.4 * (j / 399);
    expect(L[650]).toBeCloseTo(solo(50), 6); // before C: solo fades, raw sum
    expect(L[800]).toBeCloseTo(solo(200) + 0.2, 6); // under C
    expect(L[950]).toBeCloseTo(solo(350), 6); // after C
  });

  it('clips on DIFFERENT tracks never crossfade, even with matching facing fades', () => {
    const a = constDoc('a', 0.6, 1000);
    const b = constDoc('b', 0.4, 1000);
    const s = session([
      track({
        pan: -1,
        clips: [
          clip({
            documentId: 'a',
            startSample: 0,
            lengthSample: 1000,
            fadeOutSample: 400,
            fadeOutCurve: 'equal-gain',
          }),
        ],
      }),
      track({
        pan: -1,
        clips: [
          clip({
            documentId: 'b',
            startSample: 600,
            lengthSample: 1000,
            fadeInSample: 400,
            fadeInCurve: 'equal-gain',
          }),
        ],
      }),
    ]);
    const [L] = mixdownSession(s, docsMap(a, b)).channels;
    // Solo fades on each track, raw cross-track sum -- NOT the k-normalised
    // law (which would sit measurably above this for equal-gain).
    for (const j of [100, 200, 300]) {
      const expected = 0.6 * (1 - j / 399) + 0.4 * (j / 399);
      expect(L[600 + j]).toBeCloseTo(expected, 6);
      const { gOut, gIn } = crossfadeGains(j / 399, 0, 'equal-gain');
      expect(Math.abs(L[600 + j] - (0.6 * gOut + 0.4 * gIn))).toBeGreaterThan(1e-3);
    }
  });

  it('an unsorted clips array (trimClip can produce one) still finds the canonical pair', () => {
    // Same canonical fixture as above but with the ARRAY ORDER reversed --
    // pair detection must compare startSample, not array position (T40).
    const a = constDoc('a', 0.6, 1000);
    const b = constDoc('b', 0.4, 1000);
    const s = session([
      track({
        pan: -1,
        clips: [
          clip({ documentId: 'b', startSample: 600, lengthSample: 1000, fadeInSample: 400 }),
          clip({ documentId: 'a', startSample: 0, lengthSample: 1000, fadeOutSample: 400 }),
        ],
      }),
    ]);
    const [L] = mixdownSession(s, docsMap(a, b)).channels;
    const { gOut, gIn } = crossfadeGains(200 / 399, 0);
    expect(L[800]).toBeCloseTo(0.6 * gOut + 0.4 * gIn, 6);
    expect(L[599]).toBe(Math.fround(0.6));
    expect(L[1000]).toBe(Math.fround(0.4));
  });
});

// The raw shapes are imported so a reviewer can see they are NOT what the
// canonical tests assert (the law divides by k); referencing them here keeps
// the import from being flagged, and the equality below documents the one
// case where law and raw shapes coincide: equal-power at rho 0.
it('equal-power at rho 0 is the one curve where the law equals the raw solo pair (k = 1)', () => {
  for (const t of [0.1, 0.3, 0.5, 0.7, 0.9]) {
    const { gOut, gIn } = crossfadeGains(t, 0, 'equal-power');
    expect(gOut).toBeCloseTo(fadeOutShape(t, 'equal-power'), 12);
    expect(gIn).toBeCloseTo(fadeInShape(t, 'equal-power'), 12);
  }
});
