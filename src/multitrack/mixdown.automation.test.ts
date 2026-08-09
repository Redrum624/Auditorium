import { createDocument, type AudioDocument } from '../audio/AudioDocument';
import { automationValueAt, type AutomationKey, type AutomationLane } from './automation';
import {
  autoPanGainsAt,
  autoSpatialGainsAt,
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
    expect(L[500]).toBe(Math.fround(0.5 * dbToLinear(automationValueAt(kA, 500, 'volumeDb')) * gC));
    expect(L[500]).toBeCloseTo(0.5 * dbToLinear(-60) * gC, 6);
    expect(L[501]).toBeCloseTo(0.5 * dbToLinear(2) * gC, 6);
  });
});

// ---------------------------------------------------------------------------
// F5, mixdown side: the spatial group rendered through the SAME automated
// loop. Every expected value is written out from the law's definition —
// sin/cos of the inline-interpolated position, the inverse distance ratio —
// never from the shared helpers, so an identically-wrong pair still fails.
// Static pan is NON-neutral in every fixture: ruling 4 (spatial supersedes
// pan lane AND static pan) is what the anchors discriminate.
// ---------------------------------------------------------------------------

function azLane(keys: AutomationKey[]): AutomationLane {
  return { param: 'azimuth', keys };
}
function elLane(keys: AutomationKey[]): AutomationLane {
  return { param: 'elevation', keys };
}
function distLane(keys: AutomationKey[]): AutomationLane {
  return { param: 'distance', keys };
}
/** The inline reference law: mono constant-power gains at pan position p. */
function monoLaw(p: number): { gL: number; gR: number } {
  const theta = ((p + 1) / 2) * (Math.PI / 2);
  return { gL: Math.cos(theta), gR: Math.sin(theta) };
}
const RAD = Math.PI / 180;

describe('F5 mixdown spatial — azimuth wrap region (THE mandatory ±180 fixture)', () => {
  // Mono clip on [200, 1200); azimuth 170° → −170° over [400, 800]: a 20°
  // pass BEHIND the listener. Static pan 0.6 must be superseded (ruling 4).
  const keys: AutomationKey[] = [
    { positionSample: 400, value: 170, curve: 'equal-gain' },
    { positionSample: 800, value: -170 },
  ];
  const t = track({
    pan: 0.6,
    clips: [clip({ documentId: 'm', startSample: 200, lengthSample: 1000 })],
    automation: [azLane(keys)],
  });
  const s = session([t]);
  const d = docs(monoDoc('m', 0.5));

  /** Inline short-arc azimuth at timeline sample sm (equal-gain ramp). */
  function azAt(sm: number): number {
    if (sm <= 400) return 170;
    if (sm >= 800) return -170;
    const raw = 170 + 20 * ((sm - 400) / 400);
    return raw > 180 ? raw - 360 : raw;
  }

  it('travels the SHORT arc: probes below / on / above the seam sample', () => {
    const [L, R] = mixdownSession(s, d).channels;
    // u=0.25 → az 175: the LONG arc would sit at 85° (pos ≈ 0.996, nearly
    // hard right) — the short arc reads sin(175°) ≈ 0.087, near centre.
    {
      const { gL, gR } = monoLaw(Math.sin(175 * RAD));
      expect(L[500]).toBeCloseTo(0.5 * gL, 6);
      expect(R[500]).toBeCloseTo(0.5 * gR, 6);
    }
    // The seam sample (az exactly 180, pos = sin(180°) ≈ 0): centre.
    {
      const { gL, gR } = monoLaw(Math.sin(180 * RAD));
      expect(L[600]).toBeCloseTo(0.5 * gL, 6);
      expect(R[600]).toBeCloseTo(0.5 * gR, 6);
      expect(L[600]).toBeCloseTo(0.5 * Math.cos(Math.PI / 4), 6); // = centre
    }
    // One sample below / above the seam: gains move CONTINUOUSLY across it
    // (the wrap is a numeric seam, not an audio one). Derived bound: the ramp
    // moves 0.05°/sample; near az 180 the gain slope is
    // 0.5·(π/4)·sin(θ)·(π/180)·|cos az| ≈ 2.4e-4 per sample, so two samples
    // step ≈ 4.8e-4 — while a long-arc fold would JUMP by ≈ 0.4.
    expect(Math.abs(L[599] - L[601])).toBeLessThan(1e-3);
    // u=0.75 → az −175 (wrapped): sin(−175°) ≈ −0.087 — mirrored to the left.
    {
      const { gL } = monoLaw(Math.sin(-175 * RAD));
      expect(L[700]).toBeCloseTo(0.5 * gL, 6);
    }
  });

  it('holds 170° before the first key and −170° after the last; static pan 0.6 is IGNORED', () => {
    const [L, R] = mixdownSession(s, d).channels;
    const before = monoLaw(Math.sin(170 * RAD));
    expect(L[300]).toBeCloseTo(0.5 * before.gL, 6);
    expect(R[300]).toBeCloseTo(0.5 * before.gR, 6);
    const after = monoLaw(Math.sin(-170 * RAD));
    expect(L[1000]).toBeCloseTo(0.5 * after.gL, 6);
    // The superseded static pan 0.6 would read monoLaw(0.6): gL ≈ 0.454 —
    // far from every azimuth anchor above (the discriminator for ruling 4).
    expect(L[300]).not.toBeCloseTo(0.5 * monoLaw(0.6).gL, 2);
  });

  it('the whole region is the exact float32 product of the shared helpers (wiring)', () => {
    const [L, R] = mixdownSession(s, d).channels;
    for (const sm of [200, 399, 400, 401, 599, 600, 601, 799, 800, 1199]) {
      const p = autoSpatialGainsAt({ azimuth: keys, elevation: null, distance: null }, sm, true);
      expect(L[sm]).toBe(Math.fround(0.5 * 1 * 1 * p.gL * 1));
      expect(R[sm]).toBe(Math.fround(0.5 * 1 * 1 * p.gR * 1));
    }
  });

  it('inline azAt agrees with the shared evaluator across the ramp (fixture self-check)', () => {
    for (const sm of [400, 500, 600, 700, 799, 800]) {
      expect(automationValueAt(keys, sm, 'azimuth')).toBeCloseTo(azAt(sm), 10);
    }
  });
});

describe('F5 mixdown spatial — ruling 4 supersession is total', () => {
  it('a pan LANE and static pan are both ignored while an azimuth lane exists', () => {
    const az: AutomationKey[] = [{ positionSample: 0, value: 90 }]; // hard right
    const pan: AutomationKey[] = [{ positionSample: 0, value: -1 }]; // hard left!
    const base = {
      pan: -0.8,
      clips: [clip({ documentId: 'm', startSample: 0, lengthSample: 500 })],
    };
    const withBoth = track({ ...base, automation: [panLane(pan), azLane(az)] });
    const spatialOnly = track({ ...base, automation: [azLane(az)] });
    const d = docs(monoDoc('m', 0.5));

    const both = mixdownSession(session([withBoth]), d).channels;
    const solo = mixdownSession(session([spatialOnly]), d).channels;
    // Byte-identical: the pan lane contributes NOTHING while spatial governs.
    expect(both[0]).toEqual(solo[0]);
    expect(both[1]).toEqual(solo[1]);
    // And the governing law is the spatial one: az 90 → pos sin(90°)=1 →
    // mono law hard right (gL = cos(π/2) ≈ 0). The pan lane at −1 would put
    // the signal ENTIRELY on the left instead — maximally discriminating.
    expect(both[0][250]).toBeCloseTo(0.5 * Math.cos(Math.PI / 2), 6);
    expect(both[1][250]).toBeCloseTo(0.5 * Math.sin(Math.PI / 2), 6);
    expect(both[1][250]).toBeCloseTo(0.5, 6);
  });

  it('a DISTANCE-only lane activates the group: azimuth/elevation neutral, pan superseded', () => {
    // Ramp 0 → 2 over [300, 700] crosses the reference distance at s=500:
    // gain exactly 1 below AND on the reference, 1/d above it.
    const dist: AutomationKey[] = [
      { positionSample: 300, value: 0, curve: 'equal-gain' },
      { positionSample: 700, value: 2 },
    ];
    const t = track({
      pan: 0.6, // must be ignored: distance-only STILL means spatial placement
      clips: [clip({ documentId: 'm', startSample: 0, lengthSample: 1000 })],
      automation: [distLane(dist)],
    });
    const [L, R] = mixdownSession(session([t]), docs(monoDoc('m', 0.5))).channels;
    const centre = monoLaw(0); // neutral azimuth/elevation → dead centre
    // d(400)=0.5 (below ref → unity), d(500)=1 (ON ref → unity):
    expect(L[400]).toBeCloseTo(0.5 * centre.gL * 1, 6);
    expect(L[500]).toBeCloseTo(0.5 * centre.gL * 1, 6);
    // d(600)=1.5 → 1/1.5; d(700)=2 → 0.5; held past the last key:
    expect(L[600]).toBeCloseTo(0.5 * centre.gL * (1 / 1.5), 6);
    expect(L[700]).toBeCloseTo(0.5 * centre.gL * 0.5, 6);
    expect(R[999]).toBeCloseTo(0.5 * centre.gR * 0.5, 6);
    // Not the static pan image:
    expect(L[400]).not.toBeCloseTo(0.5 * monoLaw(0.6).gL, 2);
  });
});

describe('F5 mixdown spatial — elevation narrows, stereo balance law, volume composes', () => {
  it('elevation sweeps the image to centre at the zenith (mono law, az 90 fixed)', () => {
    const az: AutomationKey[] = [{ positionSample: 0, value: 90 }];
    const el: AutomationKey[] = [
      { positionSample: 200, value: -90, curve: 'equal-gain' },
      { positionSample: 600, value: 90 },
    ];
    const t = track({
      clips: [clip({ documentId: 'm', startSample: 0, lengthSample: 800 })],
      automation: [azLane(az), elLane(el)],
    });
    const [L, R] = mixdownSession(session([t]), docs(monoDoc('m', 0.5))).channels;
    // el −90 (nadir): pos = sin(90°)·cos(−90°) = 0 → centre.
    expect(L[200]).toBeCloseTo(0.5 * Math.cos(Math.PI / 4), 6);
    // el 0 (ear level, s=400): pos = 1 → hard right.
    expect(L[400]).toBeCloseTo(0.5 * Math.cos(Math.PI / 2), 6);
    expect(R[400]).toBeCloseTo(0.5, 6);
    // el 45 (s=500): pos = cos(45°) ≈ 0.707 — between centre and hard right.
    const pos = Math.cos(45 * RAD);
    const theta = ((pos + 1) / 2) * (Math.PI / 2);
    expect(L[500]).toBeCloseTo(0.5 * Math.cos(theta), 6);
    expect(R[500]).toBeCloseTo(0.5 * Math.sin(theta), 6);
  });

  it('a STEREO clip takes the balance law from the projected position', () => {
    const az: AutomationKey[] = [{ positionSample: 0, value: -90 }]; // hard left
    const t = track({
      clips: [clip({ documentId: 'st', startSample: 0, lengthSample: 500 })],
      automation: [azLane(az)],
    });
    const [L, R] = mixdownSession(session([t]), docs(stereoDoc('st', 0.5, -0.25))).channels;
    // Balance at pos −1: near side (L) untouched, far side scaled by
    // cos(π/2) ≈ 0 — written from the balance law's definition.
    expect(L[250]).toBeCloseTo(0.5 * 1, 6);
    expect(R[250]).toBeCloseTo(-0.25 * Math.cos(Math.PI / 2), 6);
    // Also pin a position where the two laws DIFFER: balance centre is
    // unity (0.5 stays 0.5) where the mono law would read 0.5·0.707.
    const az2: AutomationKey[] = [{ positionSample: 0, value: 0 }];
    const t2 = track({
      clips: [clip({ documentId: 'st', startSample: 0, lengthSample: 500 })],
      automation: [azLane(az2)],
    });
    const [L2] = mixdownSession(session([t2]), docs(stereoDoc('st', 0.5, -0.25))).channels;
    expect(L2[250]).toBeCloseTo(0.5, 6);
  });

  it('a volume lane composes with the spatial gains (v · gPan per sample)', () => {
    const az: AutomationKey[] = [{ positionSample: 0, value: 30 }];
    const dist: AutomationKey[] = [{ positionSample: 0, value: 2 }];
    const vol: AutomationKey[] = [
      { positionSample: 100, value: -6, curve: 'equal-gain' },
      { positionSample: 500, value: 0 },
    ];
    const t = track({
      volumeDb: 3, // non-neutral static: must be overridden by the lane
      clips: [clip({ documentId: 'm', startSample: 0, lengthSample: 600 })],
      automation: [volLane(vol), azLane(az), distLane(dist)],
    });
    const [L, R] = mixdownSession(session([t]), docs(monoDoc('m', 0.5))).channels;
    // s=300: vol −6+6·0.5 = −3 dB; pos = sin(30°) = 0.5; distance 2 → 0.5.
    const { gL, gR } = monoLaw(Math.sin(30 * RAD));
    expect(L[300]).toBeCloseTo(0.5 * dbToLinear(-3) * gL * 0.5, 6);
    expect(R[300]).toBeCloseTo(0.5 * dbToLinear(-3) * gR * 0.5, 6);
  });
});
