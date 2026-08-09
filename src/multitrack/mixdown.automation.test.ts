import { createDocument, type AudioDocument } from '../audio/AudioDocument';
import { automationValueAt, type AutomationKey, type AutomationLane } from './automation';
import {
  autoPanGainsAt,
  autoVolumeGainAt,
  mixdownSession,
  monoPanGains,
  stereoBalanceGains,
} from './mixdown';
import type { Clip, Session, Track } from './session';

// ---------------------------------------------------------------------------
// F0, mixdown side: the track envelope applied per sample inside the
// accumulate. The dangerous paths are trap T4's two halves — the hoisted
// static `trackGain`/pan pair double-applied under the envelope, and the
// fade-less fast path silently DROPPING the envelope — plus trap T6 (envelope
// indexed by clip-local instead of timeline sample). Fixtures therefore keep
// NON-NEUTRAL static fields (so a double-apply moves the output), clips that
// do NOT start at 0 (so a wrong index moves the output), and anchor the
// output to law-derived absolute values (so a vacuous parity cannot pass).
// ---------------------------------------------------------------------------

let idSeq = 0;
function clip(partial: Partial<Clip> & { documentId: string }): Clip {
  return {
    id: `clip-${++idSeq}`,
    startSample: 0,
    offsetSample: 0,
    lengthSample: 0,
    gainDb: 0,
    ...partial,
  };
}
function track(partial: Partial<Track> = {}): Track {
  return {
    id: `track-${++idSeq}`,
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
function session(tracks: Track[], sampleRate = 1000): Session {
  return { name: 'S', sampleRate, tracks };
}
function monoDoc(id: string, value: number, length = 2000): AudioDocument {
  const d = createDocument({ name: id, sampleRate: 1000, channels: [new Float32Array(length).fill(value)] });
  return { ...d, id };
}
function stereoDoc(id: string, l: number, r: number, length = 2000): AudioDocument {
  const d = createDocument({
    name: id,
    sampleRate: 1000,
    channels: [new Float32Array(length).fill(l), new Float32Array(length).fill(r)],
  });
  return { ...d, id };
}
function docs(...ds: AudioDocument[]): Map<string, AudioDocument> {
  return new Map(ds.map((d) => [d.id, d]));
}
function dbToLinear(db: number): number {
  return Math.pow(10, db / 20);
}
function volLane(keys: AutomationKey[]): AutomationLane {
  return { param: 'volumeDb', keys };
}
function panLane(keys: AutomationKey[]): AutomationLane {
  return { param: 'pan', keys };
}

describe('mixdown volume automation', () => {
  // Clip on [250, 1250), lane ramps −6 dB → 0 dB over [300, 700]. The static
  // volumeDb is +2 — NON-neutral — so ruling B (override, not offset) and
  // T4's double-apply are both pinned by the absolute anchors: an offset
  // implementation lands 2 dB high, a double-apply 2 dB high too, and a
  // dropped envelope lands at flat +2 dB.
  const keys: AutomationKey[] = [
    { positionSample: 300, value: -6, curve: 'equal-gain' },
    { positionSample: 700, value: 0 },
  ];
  const t = track({
    volumeDb: 2,
    clips: [clip({ documentId: 'm', startSample: 250, lengthSample: 1000 })],
    automation: [volLane(keys)],
  });
  const s = session([t]);
  const d = docs(monoDoc('m', 0.5));
  const gC = monoPanGains(0).gL; // centre mono law, both sides ≈ 0.7071

  it('applies the envelope per sample on a FADE-LESS clip (T4: the fast path must not swallow it)', () => {
    const [L, R] = mixdownSession(s, d).channels;
    // Law-derived anchors (independent of the shared helpers): equal-gain
    // ramp in dB, so at s=500 the value is −6 + 6·(200/400) = −3 dB.
    expect(L[500]).toBeCloseTo(0.5 * dbToLinear(-3) * gC, 6);
    expect(R[500]).toBeCloseTo(0.5 * dbToLinear(-3) * gC, 6);
    expect(L[400]).toBeCloseTo(0.5 * dbToLinear(-6 + 6 * (100 / 400)) * gC, 6);
    // Exact float32 store of the shared per-sample product, across the ramp.
    for (const sm of [300, 301, 450, 600, 699, 700]) {
      expect(L[sm]).toBe(Math.fround(0.5 * 1 * autoVolumeGainAt(keys, sm) * gC * 1));
    }
  });

  it('holds the first key value before the first key and the last after the last (timeline samples)', () => {
    const [L] = mixdownSession(s, d).channels;
    // Clip audio starts at 250; the lane's first key sits at 300.
    expect(L[250]).toBeCloseTo(0.5 * dbToLinear(-6) * gC, 6);
    expect(L[299]).toBeCloseTo(0.5 * dbToLinear(-6) * gC, 6);
    expect(L[299]).toBe(L[250]); // flat hold, not a ramp
    expect(L[701]).toBeCloseTo(0.5 * dbToLinear(0) * gC, 6);
    expect(L[1249]).toBe(L[701]); // flat to the clip end
  });

  it('indexes the envelope by TIMELINE sample, not clip-local (T6: startSample 250 shifts the ramp)', () => {
    // A clip-local implementation would put the −6 dB key at timeline 550
    // (= 250 + 300). Assert timeline 550 is already mid-ramp instead.
    const [L] = mixdownSession(s, d).channels;
    const midRamp = 0.5 * dbToLinear(-6 + 6 * (250 / 400)) * gC;
    expect(L[550]).toBeCloseTo(midRamp, 6);
    expect(L[550]).not.toBeCloseTo(0.5 * dbToLinear(-6) * gC, 3);
  });

  it('composes with a clip fade (envelope × fade, one multiply each)', () => {
    const t2 = track({
      volumeDb: 2,
      clips: [
        clip({
          documentId: 'm',
          startSample: 250,
          lengthSample: 1000,
          fadeInSample: 200,
          fadeInCurve: 'equal-gain',
        }),
      ],
      automation: [volLane(keys)],
    });
    const [L] = mixdownSession(session([t2]), d).channels;
    // s=350: fade-in i=100 of 200 (equal-gain: 100/199), vol ramp at −6+6·(50/400).
    const fade = 100 / 199;
    expect(L[350]).toBeCloseTo(0.5 * dbToLinear(-6 + 6 * (50 / 400)) * gC * fade, 6);
  });

  it('respects clip gain under automation (clipGain still applies; only the TRACK field is overridden)', () => {
    const t2 = track({
      volumeDb: 2,
      clips: [clip({ documentId: 'm', startSample: 250, lengthSample: 1000, gainDb: -6 })],
      automation: [volLane(keys)],
    });
    const [L] = mixdownSession(session([t2]), d).channels;
    expect(L[500]).toBeCloseTo(0.5 * dbToLinear(-6) * dbToLinear(-3) * gC, 6);
  });
});

describe('mixdown pan automation', () => {
  const keys: AutomationKey[] = [
    { positionSample: 400, value: -1, curve: 'equal-gain' },
    { positionSample: 1200, value: 1 },
  ];

  it('applies the MONO constant-power law per sample for a mono clip (static pan overridden)', () => {
    const t = track({
      pan: 0.7, // non-neutral static — must NOT appear anywhere
      clips: [clip({ documentId: 'm', startSample: 200, lengthSample: 1600 })],
      automation: [panLane(keys)],
    });
    const [L, R] = mixdownSession(session([t]), docs(monoDoc('m', 0.5))).channels;

    // Hold region (< 400): pan −1 → mono law gL = cos(0) = 1, gR = sin(0) = 0.
    expect(L[200]).toBeCloseTo(0.5, 6);
    expect(R[200]).toBeCloseTo(0, 6);
    // Mid-ramp s=800: pan = −1 + 2·(400/800) = 0 → both ≈ 0.7071·0.5.
    expect(L[800]).toBeCloseTo(0.5 * Math.cos(Math.PI / 4), 6);
    expect(R[800]).toBeCloseTo(0.5 * Math.sin(Math.PI / 4), 6);
    // Hold after the last key: pan 1 → gL = cos(π/2) ≈ 0, gR = 1.
    expect(L[1500]).toBeCloseTo(0, 6);
    expect(R[1500]).toBeCloseTo(0.5, 6);
    // Exact stores across the ramp, from the shared helper.
    for (const sm of [400, 700, 1199, 1200]) {
      const p = autoPanGainsAt(keys, sm, true);
      expect(L[sm]).toBe(Math.fround(0.5 * 1 * 1 * p.gL * 1));
      expect(R[sm]).toBe(Math.fround(0.5 * 1 * 1 * p.gR * 1));
    }
  });

  it('applies the STEREO balance law per sample for a stereo clip', () => {
    const t = track({
      pan: -0.4,
      clips: [clip({ documentId: 'st', startSample: 200, lengthSample: 1600 })],
      automation: [panLane(keys)],
    });
    const [L, R] = mixdownSession(session([t]), docs(stereoDoc('st', 0.5, -0.25))).channels;

    // s=800 → pan 0: balance law is UNITY both sides (the law difference from
    // mono is the fixture's teeth — a mono-law implementation reads 0.7071).
    expect(L[800]).toBeCloseTo(0.5, 6);
    expect(R[800]).toBeCloseTo(-0.25, 6);
    // Hold before first key: pan −1 → gL 1, gR cos(π/2) ≈ 0.
    expect(L[300]).toBeCloseTo(0.5, 6);
    expect(R[300]).toBeCloseTo(0, 6);
    for (const sm of [600, 1000]) {
      const p = autoPanGainsAt(keys, sm, false);
      expect(L[sm]).toBe(Math.fround(0.5 * 1 * 1 * p.gL * 1));
      expect(R[sm]).toBe(Math.fround(-0.25 * 1 * 1 * p.gR * 1));
    }
  });

  it('volume and pan lanes together multiply into the same accumulate', () => {
    const vKeys: AutomationKey[] = [
      { positionSample: 0, value: -6, curve: 'equal-gain' },
      { positionSample: 1000, value: 0 },
    ];
    const t = track({
      volumeDb: 5,
      pan: -0.9,
      clips: [clip({ documentId: 'm', startSample: 0, lengthSample: 1600 })],
      automation: [volLane(vKeys), panLane(keys)],
    });
    const [L] = mixdownSession(session([t]), docs(monoDoc('m', 0.5))).channels;
    const sm = 500;
    const expected =
      0.5 * autoVolumeGainAt(vKeys, sm) * autoPanGainsAt(keys, sm, true).gL;
    expect(L[sm]).toBeCloseTo(expected, 6);
    // And the law-derived anchor: vol −6+6·0.5 = −3 dB, pan −1+2·(100/800).
    const pan = -1 + 2 * (100 / 800);
    expect(L[sm]).toBeCloseTo(
      0.5 * dbToLinear(-3) * Math.cos(((pan + 1) / 2) * (Math.PI / 2)),
      6
    );
  });
});

describe('mixdown automation — neutrality and gating', () => {
  it('zero-key lanes and an absent field mix byte-identically (no existing session changes sound)', () => {
    const mk = (automation?: AutomationLane[]) => {
      const t = track({
        volumeDb: 2.5,
        pan: -0.3,
        clips: [
          clip({ documentId: 'm', startSample: 100, lengthSample: 800, fadeInSample: 50 }),
          clip({ documentId: 'st', startSample: 500, lengthSample: 900 }),
        ],
        ...(automation !== undefined ? { automation } : {}),
      });
      return mixdownSession(session([t]), docs(monoDoc('m', 0.4), stereoDoc('st', 0.3, -0.2))).channels;
    };
    const base = mk(undefined);
    const emptyLanes = mk([]);
    const zeroKeyLanes = mk([volLane([]), panLane([])]);
    for (const ch of [0, 1] as const) {
      expect(Array.from(emptyLanes[ch])).toEqual(Array.from(base[ch]));
      expect(Array.from(zeroKeyLanes[ch])).toEqual(Array.from(base[ch]));
    }
  });

  it('a muted automated track stays excluded (mute wins over automation)', () => {
    const t = track({
      muted: true,
      clips: [clip({ documentId: 'm', startSample: 0, lengthSample: 500 })],
      automation: [volLane([{ positionSample: 0, value: 6 }])],
    });
    const { channels } = mixdownSession(session([t]), docs(monoDoc('m', 0.5)));
    expect(channels[0].length).toBe(0); // no audible track: empty mixdown
  });

  it('a one-key lane holds its value over the whole clip (audio-path pin of the hold rule)', () => {
    const t = track({
      volumeDb: 2,
      clips: [clip({ documentId: 'm', startSample: 100, lengthSample: 800 })],
      automation: [volLane([{ positionSample: 400, value: -12 }])],
    });
    const [L] = mixdownSession(session([t]), docs(monoDoc('m', 0.5))).channels;
    const expected = Math.fround(0.5 * 1 * dbToLinear(-12) * monoPanGains(0).gL * 1);
    expect(L[100]).toBe(expected);
    expect(L[400]).toBe(expected);
    expect(L[899]).toBe(expected);
  });

  it('what mixdown passes the evaluator IS the timeline sample (wiring pin, F1 lesson)', () => {
    // One key per sample position probed: value differs at consecutive
    // timeline samples, so any off-by-one in the wiring flips the output.
    // Values keep |output| < 1: the master hard clamp is a pre-existing
    // divergence the automation fixtures must never trip (design-map list).
    const kA: AutomationKey[] = [
      { positionSample: 500, value: -60 },
      { positionSample: 501, value: 2 },
    ];
    const t = track({
      clips: [clip({ documentId: 'm', startSample: 490, lengthSample: 100 })],
      automation: [volLane(kA)],
    });
    const [L] = mixdownSession(session([t]), docs(monoDoc('m', 0.5))).channels;
    const gC = monoPanGains(0).gL;
    expect(L[500]).toBe(Math.fround(0.5 * dbToLinear(automationValueAt(kA, 500)) * gC));
    expect(L[500]).toBeCloseTo(0.5 * dbToLinear(-60) * gC, 6);
    expect(L[501]).toBeCloseTo(0.5 * dbToLinear(2) * gC, 6);
  });
});
