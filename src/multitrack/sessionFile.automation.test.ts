import { createDocument } from '../audio/AudioDocument';
import type { AutomationLane } from './automation';
import { createClip, createTrack, type Session, type Track } from './session';
import {
  parseSessionFile,
  parseSessionFileBytes,
  parseSessionFileV3,
  serializeSession,
  serializeSessionV3,
} from './sessionFile';

// ---------------------------------------------------------------------------
// F0 persistence: automation lanes ride the existing track spread as ADDITIVE
// OPTIONAL keys at formatVersion 3 (the amended ruling 6 — the reader's
// version check is an EQUALITY, so a bump would strand every shipped build).
// The three compatibility directions:
//   1. old file → new build: absent key parses to an absent property;
//   2. new file → old build: the v1.9.2 parser spreads unknown TRACK keys
//      through untouched — pinned here at track level for the first time
//      (the clip-level pin exists; the design map flags the track-level gap);
//   3. hostile file → new build: lanes are sanitized at the SHARED finalize,
//      so the v3 AND legacy paths are both covered (traps T12/T13).
// ---------------------------------------------------------------------------

function sine(n: number, freq = 440, sr = 44100, amplitude = 0.5): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amplitude * Math.sin((2 * Math.PI * freq * i) / sr);
  return out;
}

function buildV3Buffer(meta: object, payload: Uint8Array = new Uint8Array(0)): ArrayBuffer {
  const jsonBytes = new TextEncoder().encode(JSON.stringify(meta));
  const out = new Uint8Array(10 + jsonBytes.byteLength + payload.byteLength);
  out.set(new TextEncoder().encode('AUDM3\n'), 0);
  new DataView(out.buffer).setUint32(6, jsonBytes.byteLength, true);
  out.set(jsonBytes, 10);
  out.set(payload, 10 + jsonBytes.byteLength);
  return out.buffer;
}

/** A v3 buffer whose single track carries `trackExtras` on top of the v1.8.0
 * track shape — the track-level counterpart of the suite's `v3WithClip`. */
function v3WithTrack(trackExtras: object): ArrayBuffer {
  const payload = new Uint8Array(16); // 4 float32 samples
  const meta = {
    formatVersion: 3,
    session: {
      name: 'S',
      sampleRate: 44100,
      tracks: [
        {
          id: 'track-1',
          name: 'T',
          volumeDb: 0,
          pan: 0,
          muted: false,
          solo: false,
          armed: false,
          clips: [
            { id: 'clip-1', documentId: 'doc-1', startSample: 0, offsetSample: 0, lengthSample: 4, gainDb: 0 },
          ],
          ...trackExtras,
        },
      ],
    },
    audio: [
      { docId: 'doc-1', name: 'a.wav', sampleRate: 44100, length: 4, channels: [{ offset: 0, byteLength: 16 }] },
    ],
  };
  return buildV3Buffer(meta, payload);
}

function sessionWithLanes(automation: AutomationLane[]): { session: Session; docs: ReturnType<typeof createDocument>[] } {
  const doc = createDocument({ name: 'a.wav', sampleRate: 44100, channels: [sine(100)] });
  const track = createTrack('T');
  const clip = createClip({ documentId: doc.id, startSample: 0, offsetSample: 0, lengthSample: 100 });
  track.clips = [clip];
  track.automation = automation;
  return { session: { name: 'S', sampleRate: 44100, tracks: [track] }, docs: [doc] };
}

const LANES: AutomationLane[] = [
  {
    param: 'volumeDb',
    keys: [
      { positionSample: 0, value: -6, curve: 'smooth' },
      { positionSample: 500, value: 3 },
    ],
  },
  {
    param: 'pan',
    keys: [
      { positionSample: 100, value: -0.5 },
      { positionSample: 900, value: 1, curve: 'exponential' },
    ],
  },
];

describe('.audm v3 round trip', () => {
  it('round-trips lanes exactly — params, positions, values, per-key curves, order — at formatVersion 3', () => {
    const { session, docs } = sessionWithLanes(LANES);
    const { bytes } = serializeSessionV3(session, docs);

    // Still version 3 on disk (T10: the reader's check is an equality).
    const json = JSON.parse(
      new TextDecoder().decode(bytes.subarray(10, 10 + new DataView(bytes.buffer).getUint32(6, true)))
    );
    expect(json.formatVersion).toBe(3);

    const result = parseSessionFileBytes(bytes.buffer);
    expect(result.session.tracks[0].automation).toEqual(LANES);
  });

  it('writes the automation key AFTER clips (the store-spread order the byte-identity pin reasons about)', () => {
    const { session, docs } = sessionWithLanes(LANES);
    const { bytes } = serializeSessionV3(session, docs);
    const json = JSON.parse(
      new TextDecoder().decode(bytes.subarray(10, 10 + new DataView(bytes.buffer).getUint32(6, true)))
    );
    expect(Object.keys(json.session.tracks[0])).toEqual([
      'id',
      'name',
      'volumeDb',
      'pan',
      'muted',
      'solo',
      'armed',
      'clips',
      'automation',
    ]);
  });

  it('a session WITHOUT automation writes no automation key at all (absent means none, T9)', () => {
    const doc = createDocument({ name: 'a.wav', sampleRate: 44100, channels: [sine(100)] });
    const track = createTrack('T');
    track.clips = [createClip({ documentId: doc.id, startSample: 0, offsetSample: 0, lengthSample: 100 })];
    const session: Session = { name: 'S', sampleRate: 44100, tracks: [track] };

    const { bytes } = serializeSessionV3(session, [doc]);
    const json = JSON.parse(
      new TextDecoder().decode(bytes.subarray(10, 10 + new DataView(bytes.buffer).getUint32(6, true)))
    );
    expect('automation' in json.session.tracks[0]).toBe(false);
  });
});

describe('compatibility direction 1 — old file → new build', () => {
  it('a pre-v1.10 v3 file (no automation key) parses to a track WITHOUT the property', () => {
    const result = parseSessionFileV3(v3WithTrack({}));
    const track = result.session.tracks[0];
    expect('automation' in track).toBe(false);
  });
});

describe('compatibility direction 2 — new file → old build (track-level spread tolerance)', () => {
  it('an unknown TRACK key survives the real v3 parse path untouched — the mechanism by which a v1.10 automation file opens in v1.9.2', () => {
    // A v1.9.2 build's track handling is this same spread-through code minus
    // the automation sanitiser: to it, `automation` is exactly what
    // `futureUnknownKey` is to the current build. This is the track-level
    // counterpart of the suite's clip-level `futureUnknownKey: 'kept'` pin
    // (previously missing — design-map Q11).
    const result = parseSessionFileV3(v3WithTrack({ futureUnknownKey: 'kept' }));
    const track = result.session.tracks[0] as unknown as Record<string, unknown>;
    expect(track.futureUnknownKey).toBe('kept');
  });
});

describe('compatibility direction 3 — hostile / hand-edited file → new build (T12/T13)', () => {
  it('valid lanes arrive sanitized-but-intact through the v3 path', () => {
    const result = parseSessionFileV3(v3WithTrack({ automation: LANES }));
    expect(result.session.tracks[0].automation).toEqual(LANES);
  });

  it.each([
    ['a string', 'lanes'],
    ['a number', 42],
    ['an object', { param: 'volumeDb' }],
    ['an empty array', []],
    ['zero-key lanes only', [{ param: 'volumeDb', keys: [] }]],
    ['an unknown param', [{ param: 'gainDb', keys: [{ positionSample: 0, value: 1 }] }]],
    ['keys that is not an array', [{ param: 'volumeDb', keys: 'nope' }]],
    ['keys with no finite member', [{ param: 'pan', keys: [{ positionSample: null, value: 0 }, { positionSample: 0, value: 'x' }] }]],
  ])('automation being %s parses to NO property at all (garbage round-trips to no key)', (_label, automation) => {
    const result = parseSessionFileV3(v3WithTrack({ automation }));
    expect('automation' in result.session.tracks[0]).toBe(false);
  });

  it('malformed keys are dropped, fractional positions rounded, out-of-range values clamped, order re-established', () => {
    const result = parseSessionFileV3(
      v3WithTrack({
        automation: [
          {
            param: 'volumeDb',
            keys: [
              { positionSample: 700.4, value: 99 }, // clamps to +12
              { positionSample: -3, value: -900 }, // clamps to 0 / −60
              { positionSample: 200, value: null }, // dropped
              { positionSample: 200, value: 0, curve: 'bezier' }, // unknown curve dropped, key kept
              'garbage',
            ],
          },
        ],
      })
    );
    expect(result.session.tracks[0].automation).toEqual([
      {
        param: 'volumeDb',
        keys: [
          { positionSample: 0, value: -60 },
          { positionSample: 200, value: 0 },
          { positionSample: 700, value: 12 },
        ],
      },
    ]);
  });

  it('the sanitiser runs on the LEGACY v1/v2 JSON path too (shared finalize — trap T12)', () => {
    // Real round trip through the legacy writer so the fixture is a genuine
    // v2 file; then corrupt the lane by editing the JSON text, the exact
    // hand-edited-file scenario.
    const { session, docs } = sessionWithLanes(LANES);
    const { json } = serializeSession(session, docs);
    const legacy = parseSessionFile(json);
    expect(legacy.session.tracks[0].automation).toEqual(LANES);

    const corrupted = json.replace('"value":-6', '"value":"loud"');
    const result = parseSessionFile(corrupted);
    // The corrupted key is dropped; the rest of the lane survives sanitized.
    expect(result.session.tracks[0].automation).toEqual([
      { param: 'volumeDb', keys: [{ positionSample: 500, value: 3 }] },
      LANES[1],
    ]);
  });
});

describe('the automation-free byte pin stays untouched', () => {
  it('adding then clearing lanes in memory leaves a track that serializes without the key', () => {
    // The exact in-memory state removeAutomationKey leaves after the last key
    // goes: no property at all. Serialize and confirm nothing leaked.
    const doc = createDocument({ name: 'a.wav', sampleRate: 44100, channels: [sine(100)] });
    const track = createTrack('T');
    track.clips = [createClip({ documentId: doc.id, startSample: 0, offsetSample: 0, lengthSample: 100 })];
    track.automation = LANES;
    const stripped: Track = { ...track };
    delete stripped.automation;
    const session: Session = { name: 'S', sampleRate: 44100, tracks: [stripped] };

    const { bytes } = serializeSessionV3(session, [doc]);
    const text = new TextDecoder().decode(bytes.subarray(10, 10 + new DataView(bytes.buffer).getUint32(6, true)));
    expect(text.includes('"automation"')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// F5 persistence: the three spatial lanes ride the SAME additive-optional
// `automation` key at formatVersion 3 — no format change at all (the reader's
// version check is an equality; the sanitiser's allow-list simply widened).
// ---------------------------------------------------------------------------

const SPATIAL_LANES: AutomationLane[] = [
  {
    param: 'azimuth',
    keys: [
      { positionSample: 0, value: 170, curve: 'equal-gain' },
      { positionSample: 800, value: -170 },
      { positionSample: 1500, value: 180 }, // the seam value itself round-trips
    ],
  },
  {
    param: 'elevation',
    keys: [
      { positionSample: 200, value: -45, curve: 'smooth' },
      { positionSample: 900, value: 90 },
    ],
  },
  {
    param: 'distance',
    keys: [
      { positionSample: 0, value: 0.5 },
      { positionSample: 1000, value: 10, curve: 'exponential' },
    ],
  },
];

describe('F5 .audm round trip — spatial lanes', () => {
  it('round-trips all three spatial lanes exactly at formatVersion 3 (v3 binary path)', () => {
    const { session, docs } = sessionWithLanes(SPATIAL_LANES);
    const { bytes } = serializeSessionV3(session, docs);
    const json = JSON.parse(
      new TextDecoder().decode(bytes.subarray(10, 10 + new DataView(bytes.buffer).getUint32(6, true)))
    );
    expect(json.formatVersion).toBe(3); // stays 3 — additive optional keys only
    const result = parseSessionFileBytes(bytes.buffer);
    expect(result.session.tracks[0].automation).toEqual(SPATIAL_LANES);
  });

  it('spatial lanes coexist with volume/pan lanes in one automation array', () => {
    const all = [...LANES, ...SPATIAL_LANES];
    const { session, docs } = sessionWithLanes(all);
    const { bytes } = serializeSessionV3(session, docs);
    const result = parseSessionFileBytes(bytes.buffer);
    expect(result.session.tracks[0].automation).toEqual(all);
  });

  it('round-trips through the LEGACY v1/v2 JSON path too (shared finalize)', () => {
    const { session, docs } = sessionWithLanes(SPATIAL_LANES);
    const { json } = serializeSession(session, docs);
    const result = parseSessionFile(json);
    expect(result.session.tracks[0].automation).toEqual(SPATIAL_LANES);
  });

  it('hostile spatial values are clamped/dropped at the parse boundary (v3 path)', () => {
    const result = parseSessionFileV3(
      v3WithTrack({
        automation: [
          {
            param: 'azimuth',
            keys: [
              { positionSample: 100, value: 720 }, // clamps to +180 (clamp, not wrap)
              { positionSample: 0, value: -999 }, // clamps to −180
              { positionSample: 50, value: NaN }, // dropped
            ],
          },
          {
            param: 'elevation',
            keys: [{ positionSample: 10.6, value: -100 }], // rounds, clamps to −90
          },
          {
            param: 'distance',
            keys: [
              { positionSample: 0, value: -5 }, // clamps to 0
              { positionSample: 20, value: 1e9 }, // clamps to 10
            ],
          },
          { param: 'azimuthDeg', keys: [{ positionSample: 0, value: 1 }] }, // unknown param dropped
        ],
      })
    );
    expect(result.session.tracks[0].automation).toEqual([
      {
        param: 'azimuth',
        keys: [
          { positionSample: 0, value: -180 },
          { positionSample: 100, value: 180 },
        ],
      },
      { param: 'elevation', keys: [{ positionSample: 11, value: -90 }] },
      {
        param: 'distance',
        keys: [
          { positionSample: 0, value: 0 },
          { positionSample: 20, value: 10 },
        ],
      },
    ]);
  });
});
