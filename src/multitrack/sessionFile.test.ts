import { createDocument, nextId, type AudioDocument } from '../audio/AudioDocument';
import { useAppStore, makeInitialState, type Marker } from '../stores/appStore';
import { createClip, createTrack, type Session } from './session';
import {
  openSessionViaDialog,
  parseSessionFile,
  parseSessionFileBytes,
  parseSessionFileV3,
  saveSessionViaDialog,
  serializeSession,
  serializeSessionV3,
} from './sessionFile';
import { useSessionStore } from './sessionStore';
import { defaultSessionZoom } from './sessionZoom';
import { FALLBACK_SESSION_LANE_WIDTH, _resetSessionLaneWidth } from './sessionViewport';

interface MockApi {
  readFile: jest.Mock;
  writeFile: jest.Mock;
  showOpenDialog: jest.Mock;
  showSaveDialog: jest.Mock;
  showMessageBox: jest.Mock;
  pathBasename: (p: string) => string;
  [k: string]: unknown;
}

function installApi(overrides: Partial<MockApi> = {}): MockApi {
  const api: MockApi = {
    readFile: jest.fn(async () => new ArrayBuffer(0)),
    writeFile: jest.fn(async () => ({ ok: true })),
    showOpenDialog: jest.fn(async () => null),
    showSaveDialog: jest.fn(async () => null),
    showMessageBox: jest.fn(async () => 0),
    pathBasename: (p: string) => p.split(/[\\/]/).pop() ?? p,
    ...overrides,
  };
  (window as unknown as { electronAPI: MockApi }).electronAPI = api;
  return api;
}

function sine(n: number, freq = 440, sr = 44100, amplitude = 0.5): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amplitude * Math.sin((2 * Math.PI * freq * i) / sr);
  return out;
}

function trackJson(id: string, clips: object[] = []) {
  return { id, name: 'T', volumeDb: 0, pan: 0, muted: false, solo: false, armed: false, clips };
}

/** Hand-builds a v3 buffer from arbitrary metadata + payload bytes, bypassing
 * `serializeSessionV3` entirely — used to exercise corrupt/truncated inputs
 * that a well-formed writer would never produce. */
function buildV3Buffer(meta: object, payload: Uint8Array = new Uint8Array(0)): ArrayBuffer {
  const jsonBytes = new TextEncoder().encode(JSON.stringify(meta));
  const out = new Uint8Array(10 + jsonBytes.byteLength + payload.byteLength);
  out.set(new TextEncoder().encode('AUDM3\n'), 0);
  new DataView(out.buffer).setUint32(6, jsonBytes.byteLength, true);
  out.set(jsonBytes, 10);
  out.set(payload, 10 + jsonBytes.byteLength);
  return out.buffer;
}

beforeEach(() => {
  useAppStore.setState(makeInitialState());
  useSessionStore.getState().newSession(44100);
});

describe('serializeSession', () => {
  it('embeds only documents actually referenced by a clip', () => {
    const referenced = createDocument({ name: 'a.wav', sampleRate: 44100, channels: [sine(100)] });
    const unreferenced = createDocument({ name: 'b.wav', sampleRate: 44100, channels: [sine(100)] });
    const track = createTrack('T');
    const clip = createClip({ documentId: referenced.id, startSample: 0, offsetSample: 0, lengthSample: 100 });
    track.clips = [clip];
    const session: Session = { name: 'S', sampleRate: 44100, tracks: [track] };

    const { json } = serializeSession(session, [referenced, unreferenced]);
    const parsed = JSON.parse(json);

    expect(parsed.formatVersion).toBe(2);
    expect(parsed.documents).toHaveLength(1);
    expect(parsed.documents[0].id).toBe(referenced.id);
    expect(parsed.documents[0].wavBase64).toEqual(expect.any(String));
  });

  it('embeds zero documents when no clip references any', () => {
    const doc = createDocument({ name: 'a.wav', sampleRate: 44100, channels: [sine(10)] });
    const session: Session = { name: 'S', sampleRate: 44100, tracks: [createTrack('T')] };

    const { json } = serializeSession(session, [doc]);

    expect(JSON.parse(json).documents).toHaveLength(0);
  });

  it('drops clips whose source document is not currently open and reports the count', () => {
    const openDoc = createDocument({ name: 'a.wav', sampleRate: 44100, channels: [sine(100)] });
    const closedDoc = createDocument({ name: 'b.wav', sampleRate: 44100, channels: [sine(100)] });
    const track = createTrack('T');
    const keptClip = createClip({ documentId: openDoc.id, startSample: 0, offsetSample: 0, lengthSample: 100 });
    const orphanClip = createClip({ documentId: closedDoc.id, startSample: 200, offsetSample: 0, lengthSample: 100 });
    track.clips = [keptClip, orphanClip];
    const session: Session = { name: 'S', sampleRate: 44100, tracks: [track] };

    // closedDoc is intentionally NOT passed in docs — simulates the clip's source
    // document having been closed since the clip was added to the session.
    const { json, droppedClipCount } = serializeSession(session, [openDoc]);
    const parsed = JSON.parse(json);

    expect(droppedClipCount).toBe(1);
    expect(parsed.session.tracks[0].clips).toHaveLength(1);
    expect(parsed.session.tracks[0].clips[0].id).toBe(keptClip.id);
    expect(parsed.documents).toHaveLength(1);
    expect(parsed.documents[0].id).toBe(openDoc.id);
  });
});

describe('serializeSession -> parseSessionFile round trip (.audm v1/v2 — legacy, unchanged by the v3 work)', () => {
  it('preserves track params, clip geometry, and 32-bit-float audio content exactly', () => {
    const doc = createDocument({
      name: 'song.wav',
      sampleRate: 48000,
      channels: [sine(2000, 440), sine(2000, 220)],
    });
    const track = { ...createTrack('Lead'), volumeDb: -6, pan: 0.3, muted: true, solo: false, armed: true };
    const clip = createClip({
      documentId: doc.id,
      startSample: 500,
      offsetSample: 100,
      lengthSample: 800,
      gainDb: -3,
    });
    track.clips = [clip];
    const session: Session = { name: 'My Session', sampleRate: 48000, tracks: [track] };

    const { json } = serializeSession(session, [doc]);
    const { session: restored, documents } = parseSessionFile(json);

    expect(restored.name).toBe('My Session');
    expect(restored.sampleRate).toBe(48000);

    const restoredTrack = restored.tracks[0];
    expect(restoredTrack.name).toBe('Lead');
    expect(restoredTrack.volumeDb).toBe(-6);
    expect(restoredTrack.pan).toBe(0.3);
    expect(restoredTrack.muted).toBe(true);
    expect(restoredTrack.solo).toBe(false);
    expect(restoredTrack.armed).toBe(true);

    const restoredClip = restoredTrack.clips[0];
    expect(restoredClip.startSample).toBe(500);
    expect(restoredClip.offsetSample).toBe(100);
    expect(restoredClip.lengthSample).toBe(800);
    expect(restoredClip.gainDb).toBe(-3);

    expect(documents).toHaveLength(1);
    const restoredDoc = documents.find((d) => d.id === restoredClip.documentId)!;
    expect(restoredDoc).toBeDefined();
    expect(restoredDoc.sampleRate).toBe(48000);
    expect(restoredDoc.channels).toHaveLength(2);
    // 32-bit float WAV is a lossless container for Float32 samples.
    expect(restoredDoc.channels[0]).toEqual(doc.channels[0]);
    expect(restoredDoc.channels[1]).toEqual(doc.channels[1]);
  });

  it('assigns fresh document ids and remaps every clip.documentId into the recreated doc set', () => {
    const docA = createDocument({ name: 'a.wav', sampleRate: 44100, channels: [sine(50)] });
    const docB = createDocument({ name: 'b.wav', sampleRate: 44100, channels: [sine(50)] });
    const trackA = createTrack('A');
    const trackB = createTrack('B');
    trackA.clips = [createClip({ documentId: docA.id, startSample: 0, offsetSample: 0, lengthSample: 50 })];
    trackB.clips = [createClip({ documentId: docB.id, startSample: 0, offsetSample: 0, lengthSample: 50 })];
    const session: Session = { name: 'S', sampleRate: 44100, tracks: [trackA, trackB] };

    const { json } = serializeSession(session, [docA, docB]);
    const { session: restored, documents } = parseSessionFile(json);

    const restoredIds = new Set(documents.map((d) => d.id));
    expect(restoredIds.size).toBe(2); // two distinct fresh ids
    for (const track of restored.tracks) {
      for (const clip of track.clips) {
        expect(restoredIds.has(clip.documentId)).toBe(true);
      }
    }
    // Fresh ids: createDocument always mints new sequential ids, never the source's.
    expect(documents.some((d) => d.id === docA.id)).toBe(false);
    expect(documents.some((d) => d.id === docB.id)).toBe(false);
  });

  it('round-trips audio content exactly across multiple 32KB base64 chunk boundaries', () => {
    // 3 channels of 200,000 samples * 4 bytes/sample = 2.4MB of WAV payload,
    // forcing the chunked btoa/atob path (32KB chunks) through many iterations
    // — this is what guards against the call-stack-overflow bug the chunking
    // exists to avoid, and against any off-by-one at a chunk boundary.
    const n = 200000;
    const doc = createDocument({
      name: 'big.wav',
      sampleRate: 44100,
      channels: [sine(n, 440), sine(n, 220), sine(n, 110)],
    });
    const track = createTrack('Big');
    track.clips = [createClip({ documentId: doc.id, startSample: 0, offsetSample: 0, lengthSample: n })];
    const session: Session = { name: 'Big Session', sampleRate: 44100, tracks: [track] };

    const { json } = serializeSession(session, [doc]);
    const { documents } = parseSessionFile(json);

    expect(documents[0].channels).toHaveLength(3);
    for (let ch = 0; ch < 3; ch++) {
      expect(documents[0].channels[ch]).toEqual(doc.channels[ch]);
    }
  });

  it('throws for an unsupported formatVersion', () => {
    const bad = JSON.stringify({
      formatVersion: 3,
      session: { name: 'x', sampleRate: 44100, tracks: [] },
      documents: [],
    });

    expect(() => parseSessionFile(bad)).toThrow(/formatVersion|version/i);
  });
});

describe('serializeSessionV3 -> parseSessionFileV3 round trip (.audm v3)', () => {
  it('round-trips track params, clip geometry, multi-doc audio, and markers, with byte-level offsets verified', () => {
    const docA = createDocument({ name: 'a.wav', sampleRate: 48000, channels: [sine(2000, 440), sine(2000, 220)] });
    const docB = createDocument({ name: 'b.wav', sampleRate: 44100, channels: [sine(500, 110)] });
    const trackA = { ...createTrack('Lead'), volumeDb: -6, pan: 0.3, muted: true, solo: false, armed: true };
    const trackB = createTrack('Rhythm');
    const clipA = createClip({
      documentId: docA.id,
      startSample: 500,
      offsetSample: 100,
      lengthSample: 800,
      gainDb: -3,
    });
    const clipB = createClip({ documentId: docB.id, startSample: 0, offsetSample: 0, lengthSample: 500 });
    trackA.clips = [clipA];
    trackB.clips = [clipB];
    const session: Session = { name: 'V3 Session', sampleRate: 48000, tracks: [trackA, trackB] };
    const markersByDoc: Record<string, Marker[]> = {
      [docA.id]: [{ id: 'm-1', name: 'Hook', positionSample: 50 }],
      [docB.id]: [{ id: 'm-2', name: 'Drop', positionSample: 10 }],
    };

    const { bytes, droppedClipCount } = serializeSessionV3(session, [docA, docB], markersByDoc);

    expect(droppedClipCount).toBe(0);

    // --- byte-level structure ---
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(new TextDecoder().decode(bytes.subarray(0, 6))).toBe('AUDM3\n');
    const view = new DataView(bytes.buffer);
    const jsonByteLength = view.getUint32(6, true);
    const jsonText = new TextDecoder().decode(bytes.subarray(10, 10 + jsonByteLength));
    const rawMeta = JSON.parse(jsonText) as {
      formatVersion: number;
      audio: { docId: string; channels: { offset: number; byteLength: number }[] }[];
    };
    expect(rawMeta.formatVersion).toBe(3);
    expect(rawMeta.audio).toHaveLength(2);
    const payloadStart = 10 + jsonByteLength;
    const totalPayloadBytes = rawMeta.audio.reduce(
      (sum, a) => sum + a.channels.reduce((s, c) => s + c.byteLength, 0),
      0
    );
    expect(bytes.byteLength).toBe(payloadStart + totalPayloadBytes);

    // Spot-check a recorded offset actually points at the matching float sample.
    const metaA = rawMeta.audio.find((a) => a.docId === docA.id)!;
    const ch0Offset = metaA.channels[0].offset;
    expect(view.getFloat32(payloadStart + ch0Offset, true)).toBeCloseTo(docA.channels[0][0], 5);
    const ch1Offset = metaA.channels[1].offset;
    expect(view.getFloat32(payloadStart + ch1Offset, true)).toBeCloseTo(docA.channels[1][0], 5);

    // --- functional round trip ---
    const { session: restored, documents, markers } = parseSessionFileV3(bytes.buffer);
    expect(restored.name).toBe('V3 Session');
    expect(restored.sampleRate).toBe(48000);

    const restoredTrackA = restored.tracks[0];
    expect(restoredTrackA.volumeDb).toBe(-6);
    expect(restoredTrackA.pan).toBe(0.3);
    expect(restoredTrackA.muted).toBe(true);
    expect(restoredTrackA.armed).toBe(true);
    const restoredClipA = restoredTrackA.clips[0];
    expect(restoredClipA.startSample).toBe(500);
    expect(restoredClipA.offsetSample).toBe(100);
    expect(restoredClipA.lengthSample).toBe(800);
    expect(restoredClipA.gainDb).toBe(-3);

    expect(documents).toHaveLength(2);
    const restoredDocA = documents.find((d) => d.id === restoredClipA.documentId)!;
    expect(restoredDocA.name).toBe('a.wav');
    expect(restoredDocA.sampleRate).toBe(48000);
    expect(restoredDocA.channels).toHaveLength(2);
    expect(restoredDocA.channels[0]).toEqual(docA.channels[0]);
    expect(restoredDocA.channels[1]).toEqual(docA.channels[1]);

    const restoredDocB = documents.find((d) => d.name === 'b.wav')!;
    expect(restoredDocB.channels[0]).toEqual(docB.channels[0]);

    // Fresh doc ids, never the source's.
    expect(documents.some((d) => d.id === docA.id)).toBe(false);
    expect(documents.some((d) => d.id === docB.id)).toBe(false);

    expect(markers[restoredDocA.id].map((m) => m.name)).toEqual(['Hook']);
    expect(markers[restoredDocB.id].map((m) => m.name)).toEqual(['Drop']);
  });

  it('drops clips whose source document is not currently open and reports the count', () => {
    const openDoc = createDocument({ name: 'a.wav', sampleRate: 44100, channels: [sine(100)] });
    const closedDoc = createDocument({ name: 'b.wav', sampleRate: 44100, channels: [sine(100)] });
    const track = createTrack('T');
    const keptClip = createClip({ documentId: openDoc.id, startSample: 0, offsetSample: 0, lengthSample: 100 });
    const orphanClip = createClip({ documentId: closedDoc.id, startSample: 200, offsetSample: 0, lengthSample: 100 });
    track.clips = [keptClip, orphanClip];
    const session: Session = { name: 'S', sampleRate: 44100, tracks: [track] };

    const { bytes, droppedClipCount } = serializeSessionV3(session, [openDoc]);
    const { session: restored, documents } = parseSessionFileV3(bytes.buffer);

    expect(droppedClipCount).toBe(1);
    expect(restored.tracks[0].clips).toHaveLength(1);
    expect(documents).toHaveLength(1);
    expect(documents[0].name).toBe('a.wav');
  });

  it('omits the markers key entirely when no referenced doc has any', () => {
    const doc = createDocument({ name: 'a.wav', sampleRate: 44100, channels: [sine(10)] });
    const track = createTrack('T');
    track.clips = [createClip({ documentId: doc.id, startSample: 0, offsetSample: 0, lengthSample: 10 })];
    const session: Session = { name: 'S', sampleRate: 44100, tracks: [track] };

    const { bytes } = serializeSessionV3(session, [doc], {});
    const view = new DataView(bytes.buffer);
    const jsonByteLength = view.getUint32(6, true);
    const parsed = JSON.parse(new TextDecoder().decode(bytes.subarray(10, 10 + jsonByteLength)));

    expect(parsed.markers).toBeUndefined();
  });

  it('throws a clear error at save time (rather than silently writing a file its own reader would reject) if the all-channels-same-length invariant is ever broken', () => {
    const doc = createDocument({ name: 'broken.wav', sampleRate: 44100, channels: [sine(100), sine(100)] });
    // AudioDocument guarantees all channels share one length; simulate that
    // invariant having been violated by some future bug rather than trying to
    // reach this state through the real mutators (which all preserve it).
    const corrupted: AudioDocument = { ...doc, channels: [doc.channels[0], doc.channels[1].slice(0, 50)] };
    const track = createTrack('T');
    track.clips = [createClip({ documentId: doc.id, startSample: 0, offsetSample: 0, lengthSample: 100 })];
    const session: Session = { name: 'S', sampleRate: 44100, tracks: [track] };

    expect(() => serializeSessionV3(session, [corrupted])).toThrow(/differing length/i);
  });
});

describe('serializeSessionV3 structural guarantee (F3): never builds a full-file string', () => {
  it('never calls btoa or String.fromCharCode, and keeps the JSON metadata tiny regardless of audio payload size', () => {
    const fromCharCodeSpy = jest.spyOn(String, 'fromCharCode');
    const btoaSpy = jest.spyOn(window, 'btoa');
    const n = 500_000; // 3 channels * 500,000 samples * 4 bytes = 6MB of payload
    const doc = createDocument({
      name: 'big.wav',
      sampleRate: 48000,
      channels: [sine(n, 440), sine(n, 220), sine(n, 110)],
    });
    const track = createTrack('Big');
    track.clips = [createClip({ documentId: doc.id, startSample: 0, offsetSample: 0, lengthSample: n })];
    const session: Session = { name: 'Big Session', sampleRate: 48000, tracks: [track] };

    const { bytes } = serializeSessionV3(session, [doc]);

    expect(fromCharCodeSpy).not.toHaveBeenCalled();
    expect(btoaSpy).not.toHaveBeenCalled();

    const view = new DataView(bytes.buffer);
    const jsonByteLength = view.getUint32(6, true);
    // The JSON slice holds only metadata (ids, sample rates, offsets, byte
    // lengths) — it must stay small no matter how large the embedded audio
    // is, proving the audio itself was never turned into a JSON/base64 string.
    expect(jsonByteLength).toBeLessThan(2000);
    expect(bytes.byteLength).toBeGreaterThan(n * 3 * 4);

    fromCharCodeSpy.mockRestore();
    btoaSpy.mockRestore();
  });
});

describe('parseSessionFileV3 corrupt/truncated handling', () => {
  it('throws for a buffer shorter than the v3 header', () => {
    const buf = new ArrayBuffer(4);
    expect(() => parseSessionFileV3(buf)).toThrow(/AUDM3|header/i);
  });

  it('throws when the buffer does not start with the AUDM3 magic', () => {
    const buf = new ArrayBuffer(20);
    expect(() => parseSessionFileV3(buf)).toThrow(/AUDM3|header/i);
  });

  it('throws when the declared JSON length runs past the end of the file (truncated JSON)', () => {
    const jsonBytes = new TextEncoder().encode(
      JSON.stringify({ formatVersion: 3, session: { name: 'x', sampleRate: 44100, tracks: [] }, audio: [] })
    );
    const out = new Uint8Array(10 + jsonBytes.byteLength);
    out.set(new TextEncoder().encode('AUDM3\n'), 0);
    new DataView(out.buffer).setUint32(6, jsonBytes.byteLength + 100, true); // claims more JSON than exists
    out.set(jsonBytes, 10);

    expect(() => parseSessionFileV3(out.buffer)).toThrow(/truncated/i);
  });

  it('throws for invalid JSON metadata', () => {
    const badJson = new TextEncoder().encode('{not valid json');
    const out = new Uint8Array(10 + badJson.byteLength);
    out.set(new TextEncoder().encode('AUDM3\n'), 0);
    new DataView(out.buffer).setUint32(6, badJson.byteLength, true);
    out.set(badJson, 10);

    expect(() => parseSessionFileV3(out.buffer)).toThrow(/invalid JSON/i);
  });

  it('throws for an unsupported formatVersion inside an otherwise-valid v3 header', () => {
    const buf = buildV3Buffer({ formatVersion: 4, session: { name: 'x', sampleRate: 44100, tracks: [] }, audio: [] });
    expect(() => parseSessionFileV3(buf)).toThrow(/version/i);
  });

  it('throws when the audio index is missing', () => {
    const buf = buildV3Buffer({ formatVersion: 3, session: { name: 'x', sampleRate: 44100, tracks: [] } });
    expect(() => parseSessionFileV3(buf)).toThrow(/audio index/i);
  });

  it('throws when a channel byteLength does not match its declared sample length', () => {
    const payload = new Uint8Array(16); // 4 float32 samples worth of bytes
    const meta = {
      formatVersion: 3,
      session: { name: 'x', sampleRate: 44100, tracks: [] },
      audio: [{ docId: 'doc-1', name: 'a', sampleRate: 44100, length: 10, channels: [{ offset: 0, byteLength: 16 }] }],
    };
    const buf = buildV3Buffer(meta, payload);

    expect(() => parseSessionFileV3(buf)).toThrow(/byte length/i);
  });

  it('throws when a channel offset/length runs past the end of the payload (truncated audio)', () => {
    const payload = new Uint8Array(16);
    const meta = {
      formatVersion: 3,
      session: { name: 'x', sampleRate: 44100, tracks: [] },
      audio: [{ docId: 'doc-1', name: 'a', sampleRate: 44100, length: 4, channels: [{ offset: 8, byteLength: 16 }] }],
    };
    const buf = buildV3Buffer(meta, payload);

    expect(() => parseSessionFileV3(buf)).toThrow(/out of range/i);
  });

  it.each([
    ['null', null],
    ['fractional (0.5)', 0.5],
    ['negative (-1)', -1],
    ['a string ("0")', '0'],
  ])('throws a descriptive error (not a silent misread) for a channel offset that is %s', (_label, offset) => {
    // A hand-corrupted `offset` must be rejected outright: `null < 0` is
    // `false` and `null + byteLength` silently coerces, so without an
    // explicit integer/non-negative guard this would misread payload bytes
    // from the wrong slice instead of throwing (final-review fix, matching
    // the guards already applied to `length`/`channels` above).
    const payload = new Uint8Array(16);
    const meta = {
      formatVersion: 3,
      session: { name: 'x', sampleRate: 44100, tracks: [] },
      audio: [{ docId: 'doc-1', name: 'a', sampleRate: 44100, length: 4, channels: [{ offset, byteLength: 16 }] }],
    };
    const buf = buildV3Buffer(meta, payload);

    expect(() => parseSessionFileV3(buf)).toThrow(/out of range/i);
  });

  it('throws a descriptive error (not a raw RangeError) for a non-integer declared sample length', () => {
    // length: 0.5 * 4 bytes/sample = 2, so a naive `byteLength !== length * 4`
    // check alone would accept this and crash later trying to build a
    // Float32Array from a 2-byte buffer.
    const payload = new Uint8Array(2);
    const meta = {
      formatVersion: 3,
      session: { name: 'x', sampleRate: 44100, tracks: [] },
      audio: [{ docId: 'doc-1', name: 'a', sampleRate: 44100, length: 0.5, channels: [{ offset: 0, byteLength: 2 }] }],
    };
    const buf = buildV3Buffer(meta, payload);

    expect(() => parseSessionFileV3(buf)).toThrow(/invalid sample length/i);
  });

  it('throws a descriptive error for a negative declared sample length', () => {
    const meta = {
      formatVersion: 3,
      session: { name: 'x', sampleRate: 44100, tracks: [] },
      audio: [{ docId: 'doc-1', name: 'a', sampleRate: 44100, length: -1, channels: [] }],
    };
    const buf = buildV3Buffer(meta);

    expect(() => parseSessionFileV3(buf)).toThrow(/invalid sample length/i);
  });

  it('throws a descriptive error (not a raw TypeError) when an audio index entry has no channel list', () => {
    const meta = {
      formatVersion: 3,
      session: { name: 'x', sampleRate: 44100, tracks: [] },
      audio: [{ docId: 'doc-1', name: 'a', sampleRate: 44100, length: 10 }], // channels omitted entirely
    };
    const buf = buildV3Buffer(meta);

    expect(() => parseSessionFileV3(buf)).toThrow(/channel list/i);
  });

  it('falls back to "Untitled" instead of `undefined` when an audio index entry has no name', () => {
    const meta = {
      formatVersion: 3,
      session: { name: 'x', sampleRate: 44100, tracks: [] },
      audio: [{ docId: 'doc-1', sampleRate: 44100, length: 0, channels: [] }], // name omitted entirely
    };
    const buf = buildV3Buffer(meta);

    const { documents } = parseSessionFileV3(buf);

    expect(documents[0].name).toBe('Untitled');
  });
});

describe('parseSessionFileBytes (sniff-and-dispatch)', () => {
  it('dispatches to the v3 binary parser when the AUDM3 magic is present', () => {
    const doc = createDocument({ name: 'a.wav', sampleRate: 44100, channels: [sine(50)] });
    const track = createTrack('T');
    track.clips = [createClip({ documentId: doc.id, startSample: 0, offsetSample: 0, lengthSample: 50 })];
    const session: Session = { name: 'S', sampleRate: 44100, tracks: [track] };
    const { bytes } = serializeSessionV3(session, [doc]);

    const result = parseSessionFileBytes(bytes.buffer);

    expect(result.documents[0].channels[0]).toEqual(doc.channels[0]);
  });

  it('falls back to the legacy JSON parser for a v1/v2 buffer with no AUDM3 magic', () => {
    const doc = createDocument({ name: 'a.wav', sampleRate: 44100, channels: [sine(50)] });
    const track = createTrack('T');
    track.clips = [createClip({ documentId: doc.id, startSample: 0, offsetSample: 0, lengthSample: 50 })];
    const session: Session = { name: 'S', sampleRate: 44100, tracks: [track] };
    const { json } = serializeSession(session, [doc]);
    const buf = new TextEncoder().encode(json).buffer;

    const result = parseSessionFileBytes(buf);

    expect(result.documents[0].channels[0]).toEqual(doc.channels[0]);
  });
});

// v1.9 X2: clip fades persist as OPTIONAL keys inside the existing v3 JSON
// clip records, with `formatVersion` STAYING 3. Three compatibility
// directions are pinned here: a pre-fade file loads with fades absent; a
// no-fade session writes bytes identical to the v1.8.0 layout; and a
// fade-carrying file stays readable by a v1.8.0-era parser (whose clip
// handling is a validation-free spread — demonstrated on the real parse path
// via an unknown-key probe, since the old build itself cannot run here).
describe('.audm clip fades (v1.9 X2)', () => {
  /** One 4-sample doc, one track, one clip whose record carries `clipExtras`
   * verbatim — the hand-built shape a hand-edited/foreign/corrupt file would
   * present to the parser. */
  function v3WithClip(clipExtras: object, lengthSample = 1000): ArrayBuffer {
    const payload = new Uint8Array(16); // 4 float32 samples
    const meta = {
      formatVersion: 3,
      session: {
        name: 'S',
        sampleRate: 44100,
        tracks: [
          trackJson('track-1', [
            { id: 'clip-1', documentId: 'doc-1', startSample: 0, offsetSample: 0, lengthSample, gainDb: 0, ...clipExtras },
          ]),
        ],
      },
      audio: [{ docId: 'doc-1', name: 'a.wav', sampleRate: 44100, length: 4, channels: [{ offset: 0, byteLength: 16 }] }],
    };
    return buildV3Buffer(meta, payload);
  }

  it('round-trips fade lengths and curves through v3, inside the JSON clip records, still as formatVersion 3', () => {
    const doc = createDocument({ name: 'a.wav', sampleRate: 44100, channels: [sine(100)] });
    const track = createTrack('T');
    const clip = createClip({ documentId: doc.id, startSample: 0, offsetSample: 0, lengthSample: 100 });
    clip.fadeInSample = 25;
    clip.fadeOutSample = 40;
    clip.fadeInCurve = 'smooth';
    clip.fadeOutCurve = 'equal-gain';
    track.clips = [clip];
    const session: Session = { name: 'S', sampleRate: 44100, tracks: [track] };

    const { bytes } = serializeSessionV3(session, [doc]);

    // Container is unchanged: same magic, same version — a v1.8.0 build's
    // dispatcher and version check both still accept this file.
    expect(new TextDecoder().decode(bytes.subarray(0, 6))).toBe('AUDM3\n');
    const jsonByteLength = new DataView(bytes.buffer).getUint32(6, true);
    const rawMeta = JSON.parse(new TextDecoder().decode(bytes.subarray(10, 10 + jsonByteLength)));
    expect(rawMeta.formatVersion).toBe(3);
    // The fade keys live in the JSON clip record itself, not in any binary
    // structure (there is none for clips) — self-describing, order-free.
    expect(rawMeta.session.tracks[0].clips[0].fadeInSample).toBe(25);
    expect(rawMeta.session.tracks[0].clips[0].fadeOutCurve).toBe('equal-gain');

    const { session: restored } = parseSessionFileV3(bytes.buffer);
    const restoredClip = restored.tracks[0].clips[0];
    expect(restoredClip.fadeInSample).toBe(25);
    expect(restoredClip.fadeOutSample).toBe(40);
    expect(restoredClip.fadeInCurve).toBe('smooth');
    expect(restoredClip.fadeOutCurve).toBe('equal-gain');
  });

  it('a pre-fade (v1.8.0-written) .audm loads with all four fade keys absent and no error', () => {
    const result = parseSessionFileBytes(v3WithClip({}, 4));

    expect(result.droppedClipCount).toBe(0);
    const clip = result.session.tracks[0].clips[0];
    expect(clip.lengthSample).toBe(4);
    expect('fadeInSample' in clip).toBe(false);
    expect('fadeOutSample' in clip).toBe(false);
    expect('fadeInCurve' in clip).toBe(false);
    expect('fadeOutCurve' in clip).toBe(false);
  });

  it('a session with NO fades set serializes byte-identically to the v1.8.0 layout (hand-assembled expectation)', () => {
    // The expectation below is assembled independently of serializeSessionV3,
    // following the documented v3 byte layout and the exact key insertion
    // order the v1.8.0 factories produced (createTrack/createClip literal
    // order, fileShape order formatVersion/session/audio). If the model
    // change ever leaks a fade key (or reorders keys) into no-fade output,
    // this comparison goes red — that would break "a v1.9 save opens in
    // v1.8.0 byte-for-byte the same".
    const samples = new Float32Array([0.25, -0.5, 1, -1]);
    const doc = createDocument({ name: 'a.wav', sampleRate: 44100, channels: [samples] });
    const track = createTrack('T');
    const clip = createClip({ documentId: doc.id, startSample: 0, offsetSample: 0, lengthSample: 4 });
    track.clips = [clip];
    const session: Session = { name: 'S', sampleRate: 44100, tracks: [track] };

    const { bytes } = serializeSessionV3(session, [doc]);

    const expectedShape = {
      formatVersion: 3,
      session: {
        name: 'S',
        sampleRate: 44100,
        tracks: [
          {
            id: track.id,
            name: 'T',
            volumeDb: 0,
            pan: 0,
            muted: false,
            solo: false,
            armed: false,
            clips: [
              { id: clip.id, documentId: doc.id, startSample: 0, offsetSample: 0, lengthSample: 4, gainDb: 0 },
            ],
          },
        ],
      },
      audio: [{ docId: doc.id, name: 'a.wav', sampleRate: 44100, length: 4, channels: [{ offset: 0, byteLength: 16 }] }],
    };
    const expectedJson = new TextEncoder().encode(JSON.stringify(expectedShape));
    const expected = new Uint8Array(10 + expectedJson.byteLength + 16);
    expected.set(new TextEncoder().encode('AUDM3\n'), 0);
    new DataView(expected.buffer).setUint32(6, expectedJson.byteLength, true);
    expected.set(expectedJson, 10);
    expected.set(new Uint8Array(samples.buffer), 10 + expectedJson.byteLength);

    expect(Array.from(bytes)).toEqual(Array.from(expected));
  });

  it('a cleared fade (undefined in memory) writes no key — "no fade" round-trips to "no key on disk"', () => {
    const doc = createDocument({ name: 'a.wav', sampleRate: 44100, channels: [sine(100)] });
    const track = createTrack('T');
    const clip = createClip({ documentId: doc.id, startSample: 0, offsetSample: 0, lengthSample: 100 });
    clip.fadeInSample = undefined; // the exact in-memory state setClipFade leaves after clearing
    clip.fadeInCurve = 'smooth'; // a curve choice DOES persist
    track.clips = [clip];
    const session: Session = { name: 'S', sampleRate: 44100, tracks: [track] };

    const { bytes } = serializeSessionV3(session, [doc]);

    const jsonByteLength = new DataView(bytes.buffer).getUint32(6, true);
    const rawClip = JSON.parse(new TextDecoder().decode(bytes.subarray(10, 10 + jsonByteLength))).session
      .tracks[0].clips[0];
    expect('fadeInSample' in rawClip).toBe(false);
    expect(rawClip.fadeInCurve).toBe('smooth');
  });

  it('the v3 parse path never validates or rejects clip keys — the tolerance a v1.8.0 reader applies to OUR fade keys', () => {
    // A v1.8.0 build's clip handling is this same spread-through code minus
    // the fade sanitizer: to it, `fadeInSample` is exactly what
    // `futureUnknownKey` is to the current build. Proving (on the real parse
    // path) that an unknown clip key neither throws nor gets stripped is the
    // mechanism by which a fade-carrying v1.9 file opens in v1.8.0 — the old
    // reader simply carries the keys it does not know.
    const result = parseSessionFileV3(v3WithClip({ fadeInSample: 25, futureUnknownKey: 'kept' }, 1000));

    const clip = result.session.tracks[0].clips[0] as unknown as Record<string, unknown>;
    expect(clip.fadeInSample).toBe(25);
    expect(clip.futureUnknownKey).toBe('kept');
  });

  describe('parse-time sanitization of hand-edited/corrupt fade keys (trap T15)', () => {
    it.each([
      ['a negative length', { fadeInSample: -50 }],
      ['a string length', { fadeInSample: '100' }],
      ['a null length', { fadeInSample: null }],
      ['a boolean length', { fadeInSample: true }],
    ])('drops %s entirely (no fade, no key)', (_label, extras) => {
      const clip = parseSessionFileV3(v3WithClip(extras)).session.tracks[0].clips[0];
      expect('fadeInSample' in clip).toBe(false);
    });

    it('drops a non-finite numeric length (raw `1e999` parses as Infinity)', () => {
      // JSON.stringify cannot produce `1e999`, so assemble the JSON text by hand.
      const payload = new Uint8Array(16);
      const meta = {
        formatVersion: 3,
        session: {
          name: 'S',
          sampleRate: 44100,
          tracks: [
            trackJson('track-1', [
              { id: 'clip-1', documentId: 'doc-1', startSample: 0, offsetSample: 0, lengthSample: 1000, gainDb: 0, fadeInSample: '__INF__' },
            ]),
          ],
        },
        audio: [{ docId: 'doc-1', name: 'a.wav', sampleRate: 44100, length: 4, channels: [{ offset: 0, byteLength: 16 }] }],
      };
      const jsonBytes = new TextEncoder().encode(JSON.stringify(meta).replace('"__INF__"', '1e999'));
      const out = new Uint8Array(10 + jsonBytes.byteLength + payload.byteLength);
      out.set(new TextEncoder().encode('AUDM3\n'), 0);
      new DataView(out.buffer).setUint32(6, jsonBytes.byteLength, true);
      out.set(jsonBytes, 10);
      out.set(payload, 10 + jsonBytes.byteLength);

      const clip = parseSessionFileV3(out.buffer).session.tracks[0].clips[0];
      expect('fadeInSample' in clip).toBe(false);
    });

    it('rounds a fractional length', () => {
      const clip = parseSessionFileV3(v3WithClip({ fadeOutSample: 100.6 })).session.tracks[0].clips[0];
      expect(clip.fadeOutSample).toBe(101);
    });

    it('normalizes an explicit zero back to "no key"', () => {
      const clip = parseSessionFileV3(v3WithClip({ fadeInSample: 0 })).session.tracks[0].clips[0];
      expect('fadeInSample' in clip).toBe(false);
    });

    it('clamps a fade longer than its clip to the clip length', () => {
      const clip = parseSessionFileV3(v3WithClip({ fadeInSample: 5000 }, 1000)).session.tracks[0].clips[0];
      expect(clip.fadeInSample).toBe(1000);
    });

    it('clamps against the FLOOR of a fractional lengthSample — a stored fade is always an integer (X5, carried X2 finding)', () => {
      // Clip geometry is unvalidated (ruling 10 requires damaged pre-v1.9
      // files to load verbatim), so `lengthSample: 100.5` survives — but the
      // fade clamped against it must not: pre-fix this stored
      // `fadeInSample: 100.5`, violating the positive-integer invariant.
      // Floor, not round: round(100.5) = 101 would EXCEED the real length.
      const clip = parseSessionFileV3(v3WithClip({ fadeInSample: 5000, lengthSample: 100.5 })).session
        .tracks[0].clips[0];
      expect(clip.fadeInSample).toBe(100);
      expect(Number.isInteger(clip.fadeInSample)).toBe(true);
      expect(clip.lengthSample).toBe(100.5); // geometry itself deliberately untouched
    });

    it('resolves crossing fades with fade-in priority: in is kept, out gets the remainder', () => {
      const clip = parseSessionFileV3(v3WithClip({ fadeInSample: 800, fadeOutSample: 600 }, 1000)).session
        .tracks[0].clips[0];
      expect(clip.fadeInSample).toBe(800);
      expect(clip.fadeOutSample).toBe(200);
    });

    it.each([
      ['non-numeric garbage', 'garbage'],
      // A numeric STRING would clamp "successfully" through JS coercion in
      // Math.min/max — the typeof guard is what refuses to clamp against it.
      ['a numeric string', '1000'],
    ])(
      'drops fades entirely when lengthSample itself is %s (never clamps against a non-number)',
      (_label, lengthSample) => {
        const clip = parseSessionFileV3(v3WithClip({ fadeInSample: 100, lengthSample })).session.tracks[0]
          .clips[0];
        expect('fadeInSample' in clip).toBe(false);
      }
    );

    it('drops an unknown curve and keeps a valid one', () => {
      const clip = parseSessionFileV3(
        v3WithClip({ fadeInCurve: 'bogus', fadeOutCurve: 'smooth', fadeOutSample: 100 })
      ).session.tracks[0].clips[0];
      expect('fadeInCurve' in clip).toBe(false);
      expect(clip.fadeOutCurve).toBe('smooth');
      expect(clip.fadeOutSample).toBe(100);
    });
  });

  it('fades survive the legacy v2 JSON path too (shared finalize/sanitize)', () => {
    const doc = createDocument({ name: 'a.wav', sampleRate: 44100, channels: [sine(100)] });
    const track = createTrack('T');
    const clip = createClip({ documentId: doc.id, startSample: 0, offsetSample: 0, lengthSample: 100 });
    clip.fadeOutSample = 30;
    clip.fadeOutCurve = 'exponential';
    track.clips = [clip];
    const session: Session = { name: 'S', sampleRate: 44100, tracks: [track] };

    const { json } = serializeSession(session, [doc]);
    const restoredClip = parseSessionFile(json).session.tracks[0].clips[0];

    expect(restoredClip.fadeOutSample).toBe(30);
    expect(restoredClip.fadeOutCurve).toBe('exponential');
  });

  it('fade keys keep the JSON metadata slice tiny (T16 — a couple of numbers, never a fat payload)', () => {
    const doc = createDocument({ name: 'a.wav', sampleRate: 44100, channels: [sine(1000)] });
    const track = createTrack('T');
    const clip = createClip({ documentId: doc.id, startSample: 0, offsetSample: 0, lengthSample: 1000 });
    clip.fadeInSample = 400;
    clip.fadeOutSample = 400;
    clip.fadeInCurve = 'equal-power';
    clip.fadeOutCurve = 'exponential';
    track.clips = [clip];
    const session: Session = { name: 'S', sampleRate: 44100, tracks: [track] };

    const { bytes } = serializeSessionV3(session, [doc]);

    expect(new DataView(bytes.buffer).getUint32(6, true)).toBeLessThan(2000);
  });
});

describe('markers (.audm)', () => {
  it('serializeSession (legacy v2) embeds markers only for docs referenced by a clip', () => {
    const referenced = createDocument({ name: 'a.wav', sampleRate: 44100, channels: [sine(100)] });
    const unreferenced = createDocument({ name: 'b.wav', sampleRate: 44100, channels: [sine(100)] });
    const track = createTrack('T');
    track.clips = [createClip({ documentId: referenced.id, startSample: 0, offsetSample: 0, lengthSample: 100 })];
    const session: Session = { name: 'S', sampleRate: 44100, tracks: [track] };
    const markersByDoc: Record<string, Marker[]> = {
      [referenced.id]: [{ id: 'm-1', name: 'Hook', positionSample: 5 }],
      [unreferenced.id]: [{ id: 'm-2', name: 'Ignored', positionSample: 1 }],
    };

    const { json } = serializeSession(session, [referenced, unreferenced], markersByDoc);
    const parsed = JSON.parse(json);

    expect(parsed.formatVersion).toBe(2);
    expect(parsed.markers).toEqual({
      [referenced.id]: [{ id: 'm-1', name: 'Hook', positionSample: 5 }],
    });
  });

  it('round-trips marker names/positions through parseSessionFile, remapped to the fresh doc id, with fresh marker ids', () => {
    const doc = createDocument({ name: 'a.wav', sampleRate: 44100, channels: [sine(100)] });
    const track = createTrack('T');
    track.clips = [createClip({ documentId: doc.id, startSample: 0, offsetSample: 0, lengthSample: 100 })];
    const session: Session = { name: 'S', sampleRate: 44100, tracks: [track] };
    const markersByDoc: Record<string, Marker[]> = {
      [doc.id]: [
        { id: 'm-1', name: 'Verse', positionSample: 50 },
        { id: 'm-2', name: 'Intro', positionSample: 10 },
      ],
    };

    const { json } = serializeSession(session, [doc], markersByDoc);
    const { documents, markers } = parseSessionFile(json);

    const newDocId = documents[0].id;
    expect(newDocId).not.toBe(doc.id); // fresh doc id, per existing contract
    expect(markers[newDocId].map((m) => m.name)).toEqual(['Intro', 'Verse']); // sorted by position
    expect(markers[newDocId].map((m) => m.positionSample)).toEqual([10, 50]);
    const ids = markers[newDocId].map((m) => m.id);
    expect(new Set(ids).size).toBe(2); // fresh, distinct ids
    expect(ids.every((id) => /^marker-\d+$/.test(id))).toBe(true);
  });

  it('parseSessionFile accepts a v1 file (no markers key) and returns an empty markers map', () => {
    const doc = createDocument({ name: 'a.wav', sampleRate: 44100, channels: [sine(10)] });
    const track = createTrack('T');
    track.clips = [createClip({ documentId: doc.id, startSample: 0, offsetSample: 0, lengthSample: 10 })];
    const session: Session = { name: 'S', sampleRate: 44100, tracks: [track] };
    const v1File = {
      formatVersion: 1,
      session: JSON.parse(serializeSession(session, [doc]).json).session,
      documents: JSON.parse(serializeSession(session, [doc]).json).documents,
      // no `markers` key at all — a genuine v1 file
    };

    const { markers } = parseSessionFile(JSON.stringify(v1File));

    expect(markers).toEqual({});
  });

  it('openSessionViaDialog seeds the appStore markers for the recreated document (legacy v1/v2 fixture)', async () => {
    const doc = createDocument({ name: 'a.wav', sampleRate: 44100, channels: [sine(10)] });
    const track = createTrack('T');
    track.clips = [createClip({ documentId: doc.id, startSample: 0, offsetSample: 0, lengthSample: 10 })];
    const session: Session = { name: 'S', sampleRate: 44100, tracks: [track] };
    const markersByDoc: Record<string, Marker[]> = {
      [doc.id]: [{ id: 'm-1', name: 'Drop', positionSample: 3 }],
    };
    const { json } = serializeSession(session, [doc], markersByDoc);
    const bytes = new TextEncoder().encode(json);
    installApi({
      showOpenDialog: jest.fn(async () => ['D:\\in\\session.audm']),
      readFile: jest.fn(async () => bytes.buffer),
    });

    await openSessionViaDialog();

    const appState = useAppStore.getState();
    const newDocId = appState.documents[0].id;
    expect(appState.markers[newDocId]).toEqual([expect.objectContaining({ name: 'Drop', positionSample: 3 })]);
  });

  it('clamps a marker position that exceeds the recreated document length to the document length (legacy v1/v2 path)', () => {
    // Simulates a stale/hand-edited .audm: the marker was valid when the
    // session was saved but now sits past the (recreated) document's actual
    // length. The WAV/MP3/FLAC/OGG open paths already clamp seeded markers
    // to [0, docLength] (fileService's seeding chain); the session path must
    // match (final-review fix).
    const doc = createDocument({ name: 'a.wav', sampleRate: 44100, channels: [sine(10)] });
    const track = createTrack('T');
    track.clips = [createClip({ documentId: doc.id, startSample: 0, offsetSample: 0, lengthSample: 10 })];
    const session: Session = { name: 'S', sampleRate: 44100, tracks: [track] };
    const markersByDoc: Record<string, Marker[]> = {
      [doc.id]: [{ id: 'm-1', name: 'Stray', positionSample: 5 }],
    };

    const { json } = serializeSession(session, [doc], markersByDoc);
    const fileObj = JSON.parse(json);
    fileObj.markers[doc.id][0].positionSample = 9999; // hand-edited out-of-range marker
    const { documents, markers } = parseSessionFile(JSON.stringify(fileObj));

    const newDocId = documents[0].id;
    expect(markers[newDocId][0].positionSample).toBe(10); // clamped to the recreated doc's length
  });

  it('clamps a marker position that exceeds the recreated document length to the document length (v3 path)', () => {
    const payload = new Uint8Array(40); // 10 float32 samples
    const meta = {
      formatVersion: 3,
      session: { name: 'x', sampleRate: 44100, tracks: [] },
      audio: [{ docId: 'doc-1', name: 'a', sampleRate: 44100, length: 10, channels: [{ offset: 0, byteLength: 40 }] }],
      markers: { 'doc-1': [{ id: 'm-1', name: 'Stray', positionSample: 999 }] },
    };
    const buf = buildV3Buffer(meta, payload);

    const { documents, markers } = parseSessionFileV3(buf);

    const newDocId = documents[0].id;
    expect(markers[newDocId][0].positionSample).toBe(10); // clamped to the recreated doc's length
  });

  it('saveSessionViaDialog (v3) includes the current appStore markers for referenced docs', async () => {
    const api = installApi({ showSaveDialog: jest.fn(async () => 'D:\\out\\session.audm') });
    const doc = createDocument({ name: 'a.wav', sampleRate: 44100, channels: [sine(10)] });
    useAppStore.getState().addDocument(doc);
    useAppStore.getState().addMarker(doc.id, { id: 'm-1', name: 'Peak', positionSample: 2 });
    const trackId = useSessionStore.getState().session.tracks[0].id;
    useSessionStore
      .getState()
      .addClip(trackId, createClip({ documentId: doc.id, startSample: 0, offsetSample: 0, lengthSample: 10 }));

    await saveSessionViaDialog();

    const [, data] = api.writeFile.mock.calls[0];
    const { documents, markers } = parseSessionFileV3(data as ArrayBuffer);
    const newDocId = documents[0].id;
    expect(markers[newDocId]).toEqual([expect.objectContaining({ name: 'Peak', positionSample: 2 })]);
  });
});

describe('saveSessionViaDialog', () => {
  it('writes a v3 binary .audm file (only referenced docs) to the picked path', async () => {
    const api = installApi({ showSaveDialog: jest.fn(async () => 'D:\\out\\session.audm') });
    const doc: AudioDocument = createDocument({ name: 'a.wav', sampleRate: 44100, channels: [sine(10)] });
    useAppStore.getState().addDocument(doc);
    const trackId = useSessionStore.getState().session.tracks[0].id;
    const clip = createClip({ documentId: doc.id, startSample: 0, offsetSample: 0, lengthSample: 10 });
    useSessionStore.getState().addClip(trackId, clip);

    await saveSessionViaDialog();

    expect(api.showSaveDialog).toHaveBeenCalledWith(
      expect.objectContaining({ filters: [{ name: 'Auditorium Session', extensions: ['audm'] }] })
    );
    expect(api.writeFile).toHaveBeenCalledTimes(1);
    const [path, data] = api.writeFile.mock.calls[0];
    expect(path).toBe('D:\\out\\session.audm');
    const bytes = new Uint8Array(data as ArrayBuffer);
    expect(new TextDecoder().decode(bytes.subarray(0, 6))).toBe('AUDM3\n');

    const { session, documents } = parseSessionFileV3(data as ArrayBuffer);
    expect(session.tracks[0].clips[0].lengthSample).toBe(10);
    expect(documents).toHaveLength(1);
    expect(documents[0].channels[0]).toEqual(doc.channels[0]);
  });

  it('hands writeFile the buffer straight from serialization with no defensive full-buffer copy (IMPORTANT 1: a reintroduced copy would double peak renderer memory)', async () => {
    // ipcRenderer.invoke (preload.cjs) structured-clones its argument rather
    // than detaching it, so an extra `new ArrayBuffer(n); .set(bytes)` copy
    // before writeFile would hold 3 live copies of the session's audio at
    // once instead of 2 — halving the largest session save() can handle
    // before OOM, i.e. reintroducing exactly the ceiling this task exists to
    // raise. There is no external handle on serializeSessionV3's internal
    // `bytes` to compare by reference, so this pins the property indirectly:
    // `serializeSessionV3` assembles its output with exactly one
    // `Uint8Array#set` call per part (magic header, JSON metadata, one call
    // per channel chunk — 3 total for this single-mono-channel session). A
    // `toArrayBuffer`-style defensive copy would add exactly one more,
    // full-buffer `.set()` call before the write.
    const api = installApi({ showSaveDialog: jest.fn(async () => 'D:\\out\\session.audm') });
    const doc = createDocument({ name: 'a.wav', sampleRate: 44100, channels: [sine(10)] });
    useAppStore.getState().addDocument(doc);
    const trackId = useSessionStore.getState().session.tracks[0].id;
    useSessionStore
      .getState()
      .addClip(trackId, createClip({ documentId: doc.id, startSample: 0, offsetSample: 0, lengthSample: 10 }));
    const setSpy = jest.spyOn(Uint8Array.prototype, 'set');

    await saveSessionViaDialog();

    expect(setSpy).toHaveBeenCalledTimes(3);
    setSpy.mockRestore();
  });

  it('is a no-op when the save dialog is cancelled', async () => {
    const api = installApi({ showSaveDialog: jest.fn(async () => null) });

    await saveSessionViaDialog();

    expect(api.writeFile).not.toHaveBeenCalled();
  });

  it('shows a success message box when the save succeeds and no clips were dropped (F3: success is never silent)', async () => {
    const api = installApi({ showSaveDialog: jest.fn(async () => 'D:\\out\\session.audm') });
    const doc = createDocument({ name: 'a.wav', sampleRate: 44100, channels: [sine(10)] });
    useAppStore.getState().addDocument(doc);
    const trackId = useSessionStore.getState().session.tracks[0].id;
    useSessionStore
      .getState()
      .addClip(trackId, createClip({ documentId: doc.id, startSample: 0, offsetSample: 0, lengthSample: 10 }));

    await saveSessionViaDialog();

    expect(api.showMessageBox).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'info', title: 'Save Session', message: 'Session saved.' })
    );
  });

  it('shows an error message box when the write fails', async () => {
    const api = installApi({
      showSaveDialog: jest.fn(async () => 'D:\\out\\session.audm'),
      writeFile: jest.fn(async () => ({ ok: false, error: 'disk full' })),
    });

    await saveSessionViaDialog();

    expect(api.showMessageBox).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', title: 'Save Session failed', message: 'disk full' })
    );
  });

  it('shows an error message box when serialization itself throws, and never calls writeFile (F3 defense-in-depth)', async () => {
    const api = installApi({ showSaveDialog: jest.fn(async () => 'D:\\out\\session.audm') });
    const doc = createDocument({ name: 'a.wav', sampleRate: 44100, channels: [sine(10)] });
    useAppStore.getState().addDocument(doc);
    const trackId = useSessionStore.getState().session.tracks[0].id;
    useSessionStore
      .getState()
      .addClip(trackId, createClip({ documentId: doc.id, startSample: 0, offsetSample: 0, lengthSample: 10 }));
    // Simulate any unexpected serialize-time failure (the old base64 path
    // could throw a RangeError here past ~402MB of embedded audio with
    // nothing on the call path catching it — this proves the new try/catch
    // surfaces ANY such failure instead of an uncaught rejection).
    useAppStore.setState((s) => ({
      documents: s.documents.map((d) => (d.id === doc.id ? { ...d, channels: [null as unknown as Float32Array] } : d)),
    }));

    await saveSessionViaDialog();

    expect(api.writeFile).not.toHaveBeenCalled();
    expect(api.showMessageBox).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', title: 'Save Session failed' })
    );
  });

  it('warns via an info message box (extended with the success confirmation) when saved clips referenced closed source files', async () => {
    const api = installApi({ showSaveDialog: jest.fn(async () => 'D:\\out\\session.audm') });
    const openDoc = createDocument({ name: 'a.wav', sampleRate: 44100, channels: [sine(10)] });
    const closedDoc = createDocument({ name: 'b.wav', sampleRate: 44100, channels: [sine(10)] });
    useAppStore.getState().addDocument(openDoc);
    useAppStore.getState().addDocument(closedDoc);
    useAppStore.getState().closeDocument(closedDoc.id);

    const trackId = useSessionStore.getState().session.tracks[0].id;
    useSessionStore
      .getState()
      .addClip(trackId, createClip({ documentId: openDoc.id, startSample: 0, offsetSample: 0, lengthSample: 10 }));
    useSessionStore
      .getState()
      .addClip(trackId, createClip({ documentId: closedDoc.id, startSample: 100, offsetSample: 0, lengthSample: 10 }));

    await saveSessionViaDialog();

    expect(api.writeFile).toHaveBeenCalledTimes(1);
    const [, data] = api.writeFile.mock.calls[0];
    const { session } = parseSessionFileV3(data as ArrayBuffer);
    expect(session.tracks[0].clips).toHaveLength(1);

    expect(api.showMessageBox).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'info',
        message: 'Session saved. 1 clip(s) referenced closed files and were not saved.',
      })
    );
  });
});

describe('openSessionViaDialog', () => {
  // MT1 fix round (C1) — the reported bug, through the door the report came in.
  //
  // "The tracks should appear Fit on the longest one" was filed after opening a
  // 2:58 session. The first MT1-1 pass fixed `newSession` and the first-clip
  // insert and CLAIMED all four load paths, but this one still wrote
  // `{ samplesPerPixel: 512 }` by hand through `setState`, which bypasses
  // `applySessionZoom` entirely. Nothing downstream rescues it: the lane-width
  // republish only re-fits a session that is ALREADY at its fit, and 512 is far
  // zoomed IN of the fit for anything longer than about sixteen seconds, so the
  // re-fit arm is never taken. File → Open Session on the user's own file
  // reproduced the exact symptom the ticket describes.
  it('C1: opens a long session FITTED, not at the hardcoded 512 samples/px', async () => {
    _resetSessionLaneWidth();
    // 2:58 at 44.1 kHz — the reported session's length.
    const LEN = Math.round(178 * 44100);
    const doc = createDocument({ name: 'song.wav', sampleRate: 44100, channels: [sine(10)] });
    const track = createTrack('Long Track');
    track.clips = [createClip({ documentId: doc.id, startSample: 0, offsetSample: 0, lengthSample: LEN })];
    const session: Session = { name: 'Long Session', sampleRate: 44100, tracks: [track] };
    const { json } = serializeSession(session, [doc]);
    const bytes = new TextEncoder().encode(json);
    installApi({
      showOpenDialog: jest.fn(async () => ['D:\in\long.audm']),
      readFile: jest.fn(async () => bytes.buffer),
    });

    await openSessionViaDialog();

    const loaded = useSessionStore.getState();
    expect(loaded.mtZoom).toEqual(defaultSessionZoom(loaded.session));
    expect(loaded.mtZoom.samplesPerPixel).toBe(LEN / FALLBACK_SESSION_LANE_WIDTH);
    expect(loaded.mtZoom.scrollSample).toBe(0);
    // The whole session is on screen: what is visible covers its full length.
    expect(loaded.mtZoom.samplesPerPixel * FALLBACK_SESSION_LANE_WIDTH).toBeGreaterThanOrEqual(LEN);
  });

  it('recreates docs, remaps clip documentIds, replaces the session, and switches to multitrack view (legacy v1/v2 fixture)', async () => {
    const doc = createDocument({ name: 'a.wav', sampleRate: 44100, channels: [sine(10)] });
    const track = createTrack('Loaded Track');
    track.clips = [createClip({ documentId: doc.id, startSample: 0, offsetSample: 0, lengthSample: 10 })];
    const session: Session = { name: 'Loaded Session', sampleRate: 44100, tracks: [track] };
    const { json } = serializeSession(session, [doc]);
    const bytes = new TextEncoder().encode(json);

    const api = installApi({
      showOpenDialog: jest.fn(async () => ['D:\\in\\session.audm']),
      readFile: jest.fn(async () => bytes.buffer),
    });

    await openSessionViaDialog();

    expect(api.readFile).toHaveBeenCalledWith('D:\\in\\session.audm');
    const sessionState = useSessionStore.getState();
    expect(sessionState.session.name).toBe('Loaded Session');
    expect(sessionState.selectedClipId).toBeNull();

    const appState = useAppStore.getState();
    expect(appState.view).toBe('multitrack');
    const restoredClip = sessionState.session.tracks[0].clips[0];
    expect(appState.documents.some((d) => d.id === restoredClip.documentId)).toBe(true);
  });

  it('recreates docs, remaps clip documentIds, replaces the session, and switches to multitrack view (.audm v3 file)', async () => {
    const doc = createDocument({ name: 'a.wav', sampleRate: 44100, channels: [sine(10)] });
    const track = createTrack('Loaded Track');
    track.clips = [createClip({ documentId: doc.id, startSample: 0, offsetSample: 0, lengthSample: 10 })];
    const session: Session = { name: 'Loaded Session', sampleRate: 44100, tracks: [track] };
    const { bytes } = serializeSessionV3(session, [doc]);

    const api = installApi({
      showOpenDialog: jest.fn(async () => ['D:\\in\\session.audm']),
      readFile: jest.fn(async () => bytes.buffer),
    });

    await openSessionViaDialog();

    expect(api.readFile).toHaveBeenCalledWith('D:\\in\\session.audm');
    const sessionState = useSessionStore.getState();
    expect(sessionState.session.name).toBe('Loaded Session');

    const appState = useAppStore.getState();
    expect(appState.view).toBe('multitrack');
    const restoredClip = sessionState.session.tracks[0].clips[0];
    const restoredDoc = appState.documents.find((d) => d.id === restoredClip.documentId);
    expect(restoredDoc).toBeDefined();
    expect(restoredDoc!.channels[0]).toEqual(doc.channels[0]);
  });


  it('is a no-op when the open dialog is cancelled', async () => {
    const api = installApi({ showOpenDialog: jest.fn(async () => null) });
    const before = useSessionStore.getState().session;

    await openSessionViaDialog();

    expect(api.readFile).not.toHaveBeenCalled();
    expect(useSessionStore.getState().session).toBe(before);
  });

  it('shows an error message box and leaves the current session untouched on a bad formatVersion', async () => {
    const bad = JSON.stringify({
      formatVersion: 99,
      session: { name: 'x', sampleRate: 44100, tracks: [] },
      documents: [],
    });
    const bytes = new TextEncoder().encode(bad);
    const api = installApi({
      showOpenDialog: jest.fn(async () => ['D:\\in\\bad.audm']),
      readFile: jest.fn(async () => bytes.buffer),
    });
    const before = useSessionStore.getState().session;

    await openSessionViaDialog();

    expect(api.showMessageBox).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
    expect(useSessionStore.getState().session).toBe(before);
    expect(useAppStore.getState().view).not.toBe('multitrack');
  });

  it('shows an error message box and leaves the current session untouched when readFile fails', async () => {
    const api = installApi({
      showOpenDialog: jest.fn(async () => ['D:\\in\\denied.audm']),
      readFile: jest.fn(async () => {
        throw new Error('EACCES: permission denied');
      }),
    });
    const before = useSessionStore.getState().session;

    await openSessionViaDialog();

    expect(api.showMessageBox).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', message: expect.stringContaining('EACCES') })
    );
    expect(useSessionStore.getState().session).toBe(before);
    expect(useAppStore.getState().view).not.toBe('multitrack');
  });

  it('shows an error message box and leaves the current session untouched on a corrupt/truncated .audm v3 file', async () => {
    const doc = createDocument({ name: 'a.wav', sampleRate: 44100, channels: [sine(50)] });
    const track = createTrack('T');
    track.clips = [createClip({ documentId: doc.id, startSample: 0, offsetSample: 0, lengthSample: 50 })];
    const session: Session = { name: 'S', sampleRate: 44100, tracks: [track] };
    const { bytes } = serializeSessionV3(session, [doc]);
    const truncated = bytes.slice(0, bytes.byteLength - 20); // cut off the tail of the audio payload
    const api = installApi({
      showOpenDialog: jest.fn(async () => ['D:\\in\\truncated.audm']),
      readFile: jest.fn(async () => truncated.buffer),
    });
    const before = useSessionStore.getState().session;

    await openSessionViaDialog();

    expect(api.showMessageBox).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
    expect(useSessionStore.getState().session).toBe(before);
    expect(useAppStore.getState().view).not.toBe('multitrack');
  });

  it('shows a clean error (not a crash) when a legacy file is too large to decode as a single JS string (V8 string-cap safety)', async () => {
    const decodeSpy = jest.spyOn(TextDecoder.prototype, 'decode').mockImplementationOnce(() => {
      throw new RangeError('Invalid string length');
    });
    const api = installApi({
      showOpenDialog: jest.fn(async () => ['D:\\in\\huge.audm']),
      readFile: jest.fn(async () => new ArrayBuffer(16)), // content is irrelevant; decode() is mocked to throw
    });
    const before = useSessionStore.getState().session;

    await openSessionViaDialog();

    expect(api.showMessageBox).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', message: expect.stringContaining('Invalid string length') })
    );
    expect(useSessionStore.getState().session).toBe(before);
    expect(useAppStore.getState().view).not.toBe('multitrack');

    decodeSpy.mockRestore();
  });

  it('shows an info message box and drops clips when opened clips reference no embedded document', async () => {
    const json = JSON.stringify({
      formatVersion: 1,
      session: {
        name: 'Stale',
        sampleRate: 44100,
        tracks: [
          trackJson('track-1', [
            { id: 'clip-1', documentId: 'doc-77', startSample: 0, offsetSample: 0, lengthSample: 100, gainDb: 0 },
          ]),
        ],
      },
      documents: [],
    });
    const bytes = new TextEncoder().encode(json);
    const api = installApi({
      showOpenDialog: jest.fn(async () => ['D:\\in\\stale.audm']),
      readFile: jest.fn(async () => bytes.buffer),
    });

    await openSessionViaDialog();

    expect(useSessionStore.getState().session.tracks[0].clips).toHaveLength(0);
    expect(api.showMessageBox).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'info', message: '1 clip(s) referenced missing audio and were removed.' })
    );
  });
});

describe('id-counter seeding after parse', () => {
  it('parseSessionFile seeds track/clip counters past the max suffix in the loaded session', () => {
    const json = JSON.stringify({
      formatVersion: 1,
      session: {
        name: 'S',
        sampleRate: 44100,
        tracks: [
          trackJson('track-9000', [
            { id: 'clip-90000', documentId: 'doc-1', startSample: 0, offsetSample: 0, lengthSample: 100, gainDb: 0 },
          ]),
          trackJson('track-8999'),
        ],
      },
      documents: [],
    });

    parseSessionFile(json);

    const track = createTrack('after-load');
    const clip = createClip({ documentId: 'doc-1', startSample: 0, offsetSample: 0, lengthSample: 32 });
    expect(Number(track.id.split('-')[1])).toBeGreaterThan(9000);
    expect(Number(clip.id.split('-')[1])).toBeGreaterThan(90000);
  });

  it('after opening a session, addTrack()/addClip() never mint ids colliding with loaded ones', async () => {
    const json = JSON.stringify({
      formatVersion: 1,
      session: {
        name: 'Loaded',
        sampleRate: 44100,
        tracks: [
          trackJson('track-9500', [
            { id: 'clip-95000', documentId: 'doc-1', startSample: 0, offsetSample: 0, lengthSample: 100, gainDb: 0 },
          ]),
        ],
      },
      documents: [],
    });
    const bytes = new TextEncoder().encode(json);
    installApi({
      showOpenDialog: jest.fn(async () => ['D:\\in\\old.audm']),
      readFile: jest.fn(async () => bytes.buffer),
    });

    await openSessionViaDialog();
    useSessionStore.getState().addTrack();

    const tracks = useSessionStore.getState().session.tracks;
    const trackIds = tracks.map((t) => t.id);
    expect(new Set(trackIds).size).toBe(trackIds.length); // no duplicates
    const newTrack = tracks[tracks.length - 1];
    expect(Number(newTrack.id.split('-')[1])).toBeGreaterThan(9500);

    const newClip = createClip({ documentId: 'doc-1', startSample: 200, offsetSample: 0, lengthSample: 32 });
    expect(Number(newClip.id.split('-')[1])).toBeGreaterThan(95000);
  });

  it('seeds the doc counter past a stale documentId retained in the file, even with no embedded documents', () => {
    // Hand-built file: a clip references 'doc-77' but no document with that id
    // is embedded (e.g. the source was closed before save, pre-fix, or the
    // file was hand-edited). Loading must drop the orphaned clip AND seed the
    // 'doc' counter past 77 so a freshly minted document can never collide
    // with the stale retained id.
    const json = JSON.stringify({
      formatVersion: 1,
      session: {
        name: 'S',
        sampleRate: 44100,
        tracks: [
          trackJson('track-1', [
            { id: 'clip-1', documentId: 'doc-77', startSample: 0, offsetSample: 0, lengthSample: 100, gainDb: 0 },
          ]),
        ],
      },
      documents: [],
    });

    const { session, documents, droppedClipCount } = parseSessionFile(json);

    expect(documents).toHaveLength(0);
    expect(session.tracks[0].clips).toHaveLength(0);
    expect(droppedClipCount).toBe(1);

    const freshId = nextId('doc');
    expect(Number(freshId.split('-')[1])).toBeGreaterThan(77);
  });
});

describe('neverSaved provenance and sessions (Task S4)', () => {
  it('a document recreated from a .audm is NOT never-saved — its audio is on disk inside the session file', () => {
    const doc = createDocument({ name: 'a.wav', sampleRate: 44100, channels: [sine(10)] });
    const track = createTrack('T');
    track.clips = [createClip({ documentId: doc.id, startSample: 0, offsetSample: 0, lengthSample: 10 })];
    const session: Session = { name: 'S', sampleRate: 44100, tracks: [track] };

    const v3 = parseSessionFileV3(serializeSessionV3(session, [doc]).bytes.buffer);
    expect(v3.documents[0].neverSaved).toBe(false);
    expect(v3.documents[0].filePath).toBeNull(); // path-less, but recoverable from the .audm

    const legacy = parseSessionFile(serializeSession(session, [doc]).json);
    expect(legacy.documents[0].neverSaved).toBe(false);
  });

  it('saving a SESSION does not clear neverSaved on the documents it embeds', async () => {
    installApi({ showSaveDialog: jest.fn(async () => 'D:\\out\\session.audm') });
    // A computed document (a Mix Down / Remix / recording) dropped onto a track.
    const derived = createDocument({ name: 'Mixdown 1', sampleRate: 44100, channels: [sine(10)] });
    useAppStore.getState().addDocument(derived);
    const trackId = useSessionStore.getState().session.tracks[0].id;
    useSessionStore
      .getState()
      .addClip(trackId, createClip({ documentId: derived.id, startSample: 0, offsetSample: 0, lengthSample: 10 }));
    expect(useAppStore.getState().documents[0].neverSaved).toBe(true);

    await saveSessionViaDialog();

    // The .audm holds a COPY under a foreign id; the document itself still has
    // no file of its own, later edits are not in that copy, and a session save
    // embeds only CLIP-REFERENCED documents — so clearing the flag here would
    // silently un-guard every open document the session never contained.
    expect(useAppStore.getState().documents[0].neverSaved).toBe(true);
  });
});
