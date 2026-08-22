import { createDocument, nextId, type AudioDocument } from '../audio/AudioDocument';
import { useAppStore, makeInitialState, type Marker } from '../stores/appStore';
import { createClip, createTrack, type Session } from './session';
import {
  isProjectSaveInFlight,
  loadProjectFrom,
  openSessionViaDialog,
  parseSessionFile,
  parseSessionFileBytes,
  parseSessionFileV3,
  parseSessionFileV4,
  saveProject,
  serializeSession,
  serializeSessionV3,
  serializeSessionV4,
  writeProject,
} from './sessionFile';
import { useSessionStore } from './sessionStore';
import {
  SESSION_COALESCE_WINDOW_MS,
  _resetSessionUndo,
  canUndoSession,
  clearSessionHistory,
  isSessionDirty,
  undoSession,
} from './sessionUndo';
import * as undoHistory from '../services/undoHistory';
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
  return buildBinaryBuffer('AUDM3\n', meta, payload);
}

/** Lot A: the v4 twin of `buildV3Buffer` — same header, `AUDM4\n` magic. */
function buildV4Buffer(meta: object, payload: Uint8Array = new Uint8Array(0)): ArrayBuffer {
  return buildBinaryBuffer('AUDM4\n', meta, payload);
}

function buildBinaryBuffer(magic: string, meta: object, payload: Uint8Array): ArrayBuffer {
  const jsonBytes = new TextEncoder().encode(JSON.stringify(meta));
  const out = new Uint8Array(10 + jsonBytes.byteLength + payload.byteLength);
  out.set(new TextEncoder().encode(magic), 0);
  new DataView(out.buffer).setUint32(6, jsonBytes.byteLength, true);
  out.set(jsonBytes, 10);
  out.set(payload, 10 + jsonBytes.byteLength);
  return out.buffer;
}

/** Lot A: the JSON metadata block of a v3/v4 buffer, for shape assertions. */
function readBinaryJson(bytes: Uint8Array): Record<string, unknown> {
  const jsonLen = new DataView(bytes.buffer, bytes.byteOffset).getUint32(6, true);
  return JSON.parse(new TextDecoder().decode(bytes.subarray(10, 10 + jsonLen)));
}

beforeEach(() => {
  useAppStore.setState(makeInitialState());
  useSessionStore.getState().newSession(44100);
  // Lot A: the project's path and the session stack are module-global too.
  useSessionStore.getState().setProjectPath(null);
  _resetSessionUndo();
});

/** Lets a pending async flow advance past its dialog/serialize steps to its
 * `writeFile` await (a macrotask turn drains every microtask in between). */
const tick = () => new Promise((r) => setTimeout(r, 0));

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

  it('saveProject (v4) includes the current appStore markers for every open document, referenced or not (lot A)', async () => {
    const api = installApi({ showSaveDialog: jest.fn(async () => 'D:\\out\\session.audm') });
    const doc = createDocument({ name: 'a.wav', sampleRate: 44100, channels: [sine(10)] });
    useAppStore.getState().addDocument(doc);
    useAppStore.getState().addMarker(doc.id, { id: 'm-1', name: 'Peak', positionSample: 2 });
    const loose = createDocument({ name: 'b.wav', sampleRate: 44100, channels: [sine(10)] });
    useAppStore.getState().addDocument(loose);
    useAppStore.getState().addMarker(loose.id, { id: 'm-2', name: 'Loose', positionSample: 4 });
    const trackId = useSessionStore.getState().session.tracks[0].id;
    useSessionStore
      .getState()
      .addClip(trackId, createClip({ documentId: doc.id, startSample: 0, offsetSample: 0, lengthSample: 10 }));

    await saveProject({ as: true });

    const [, data] = api.writeFile.mock.calls[0];
    const { documents, markers } = parseSessionFileV4(data as ArrayBuffer);
    expect(documents.map((d) => d.name)).toEqual(['a.wav', 'b.wav']);
    expect(markers[documents[0].id]).toEqual([expect.objectContaining({ name: 'Peak', positionSample: 2 })]);
    expect(markers[documents[1].id]).toEqual([expect.objectContaining({ name: 'Loose', positionSample: 4 })]);
  });
});

describe('saveProject / writeProject / loadProjectFrom (lot A — M4: Save = project, always)', () => {
  /** The live document, re-read from the store. */
  const live = (id: string) => useAppStore.getState().documents.find((d) => d.id === id)!;

  /** An open document, optionally placed on track 0 as a clip. */
  function seedProjectDoc(name = 'a.wav', withClip = true): AudioDocument {
    const doc = createDocument({ name, sampleRate: 44100, channels: [sine(10)] });
    useAppStore.getState().addDocument(doc);
    if (withClip) {
      const trackId = useSessionStore.getState().session.tracks[0].id;
      useSessionStore
        .getState()
        .addClip(trackId, createClip({ documentId: doc.id, startSample: 0, offsetSample: 0, lengthSample: 10 }));
    }
    return live(doc.id);
  }

  /** A `writeFile` mock that stays pending until `resolve` is called. */
  function pendingWrite() {
    let resolve!: (r: { ok: true } | { ok: false; error: string }) => void;
    const writeFile = jest.fn(
      (_path: string, _data: ArrayBuffer) =>
        new Promise<{ ok: true } | { ok: false; error: string }>((r) => {
          resolve = r;
        })
    );
    return { writeFile, resolve: (r: { ok: true } | { ok: false; error: string }) => resolve(r) };
  }

  it('after loadProjectFrom, plain Save writes to the remembered path — no dialog, no box — and the project is clean afterwards (acceptance 6)', async () => {
    const doc = createDocument({ name: 'a.wav', sampleRate: 44100, channels: [sine(10)] });
    const track = createTrack('T');
    track.clips = [createClip({ documentId: doc.id, startSample: 0, offsetSample: 0, lengthSample: 10 })];
    const { bytes } = serializeSessionV4({ name: 'Loaded', sampleRate: 44100, tracks: [track] }, [doc]);
    const api = installApi({ readFile: jest.fn(async () => bytes.buffer) });

    const summary = await loadProjectFrom('D:\\a.audm');

    expect(summary).toEqual({ droppedClipCount: 0, docCount: 1, trackCount: 1 });
    expect(api.readFile).toHaveBeenCalledWith('D:\\a.audm');
    expect(useSessionStore.getState().projectPath).toBe('D:\\a.audm');
    expect(isSessionDirty()).toBe(false);
    expect(useAppStore.getState().view).toBe('multitrack');

    const loadedTrack = useSessionStore.getState().session.tracks[0];
    useSessionStore.getState().moveClip(loadedTrack.clips[0].id, loadedTrack.id, 500);
    expect(isSessionDirty()).toBe(true);

    const ok = await saveProject({ as: false });

    expect(ok).toBe(true);
    expect(api.showSaveDialog).not.toHaveBeenCalled();
    expect(api.writeFile).toHaveBeenCalledTimes(1);
    expect(api.writeFile.mock.calls[0][0]).toBe('D:\\a.audm');
    expect(api.showMessageBox).not.toHaveBeenCalled();
    expect(isSessionDirty()).toBe(false);
    expect(useSessionStore.getState().projectPath).toBe('D:\\a.audm');
  });

  it('a fader nudge within a second of a plain Save dirties the project again — the save breaks the keyboard-repeat coalescing run (fix round 1)', async () => {
    // Reviewer finding 1: `setTrackParam` on volume/pan names a coalesceKey,
    // so two nudges within SESSION_COALESCE_WINDOW_MS merge into one entry.
    // Before the fix a Save between them did not reset that memory: the
    // post-save nudge merged into the PRE-save entry, the stack position
    // stayed at the save point, and the Save pill / chip / close guard all
    // read clean while the live volume differed from the file.
    const now = jest.spyOn(Date, 'now').mockReturnValue(100_000);
    try {
      const api = installApi();
      seedProjectDoc();
      useSessionStore.getState().setProjectPath('D:\\a.audm');
      const trackId = useSessionStore.getState().session.tracks[0].id;
      useSessionStore.getState().setTrackParam(trackId, { volumeDb: -1 });
      expect(isSessionDirty()).toBe(true);

      expect(await saveProject({ as: false })).toBe(true);
      expect(api.writeFile).toHaveBeenCalledTimes(1);
      expect(isSessionDirty()).toBe(false);

      now.mockReturnValue(100_000 + SESSION_COALESCE_WINDOW_MS - 1);
      useSessionStore.getState().setTrackParam(trackId, { volumeDb: -2 });

      expect(useSessionStore.getState().session.tracks[0].volumeDb).toBe(-2);
      expect(isSessionDirty()).toBe(true);
      undoSession();
      expect(useSessionStore.getState().session.tracks[0].volumeDb).toBe(-1); // what the file holds
      expect(isSessionDirty()).toBe(false);
    } finally {
      now.mockRestore();
    }
  });

  it('with no path, plain Save is a Save As: prompts with the project name, writes v4, remembers, renames (recorded), cleans every document, confirms (acceptance 7)', async () => {
    const api = installApi({ showSaveDialog: jest.fn(async () => 'D:\\out\\mix v2.audm') });
    const doc = seedProjectDoc('a.wav', false); // open, NOT clip-referenced — it goes in the file regardless
    expect(doc.neverSaved).toBe(true);
    const markSpy = jest.spyOn(undoHistory, 'markSavePoint');

    const ok = await saveProject({ as: false });

    expect(ok).toBe(true);
    expect(api.showSaveDialog).toHaveBeenCalledWith({
      defaultPath: 'Untitled Session.audm',
      filters: [{ name: 'Auditorium Project', extensions: ['audm'] }],
    });
    expect(api.writeFile).toHaveBeenCalledTimes(1);
    const [path, data] = api.writeFile.mock.calls[0];
    expect(path).toBe('D:\\out\\mix v2.audm');
    expect(new TextDecoder().decode(new Uint8Array(data as ArrayBuffer).subarray(0, 6))).toBe('AUDM4\n');
    expect(useSessionStore.getState().projectPath).toBe('D:\\out\\mix v2.audm');
    expect(useSessionStore.getState().session.name).toBe('mix v2');
    expect(live(doc.id).dirty).toBe(false);
    expect(live(doc.id).neverSaved).toBe(false);
    expect(markSpy).toHaveBeenCalledWith(doc.id);
    expect(api.showMessageBox).toHaveBeenCalledTimes(1);
    expect(api.showMessageBox).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'info', title: 'Save Project', message: 'Project saved.' })
    );
    expect(isSessionDirty()).toBe(false);

    // The rename is a recorded mutation: undoing it restores the old name and
    // leaves the project dirty relative to the file that carries the new one.
    expect(canUndoSession()).toBe(true);
    undoSession();
    expect(useSessionStore.getState().session.name).toBe('Untitled Session');
    expect(isSessionDirty()).toBe(true);
    markSpy.mockRestore();
  });

  it('appends .audm when the picked name has no extension, and strips a .audm suffix from the default name', async () => {
    const api = installApi({ showSaveDialog: jest.fn(async () => 'D:\\out\\noext') });
    seedProjectDoc();
    useSessionStore.getState().renameSession('Take.AUDM');

    await saveProject({ as: false });

    expect(api.showSaveDialog).toHaveBeenCalledWith(expect.objectContaining({ defaultPath: 'Take.audm' }));
    expect(api.writeFile.mock.calls[0][0]).toBe('D:\\out\\noext.audm');
    expect(useSessionStore.getState().projectPath).toBe('D:\\out\\noext.audm');
    expect(useSessionStore.getState().session.name).toBe('noext');
  });

  it('Save As always prompts, even with a remembered path; a cancel writes nothing and changes nothing (acceptance 8)', async () => {
    const api = installApi({ showSaveDialog: jest.fn(async () => null) });
    const doc = seedProjectDoc();
    useSessionStore.getState().setProjectPath('D:\\p.audm');
    expect(isSessionDirty()).toBe(true); // the addClip above

    const ok = await saveProject({ as: true });

    expect(ok).toBe(false);
    expect(api.showSaveDialog).toHaveBeenCalledTimes(1);
    expect(api.writeFile).not.toHaveBeenCalled();
    expect(api.showMessageBox).not.toHaveBeenCalled();
    expect(useSessionStore.getState().projectPath).toBe('D:\\p.audm');
    expect(isSessionDirty()).toBe(true);
    expect(live(doc.id).neverSaved).toBe(true);
  });

  it('a Save As that lands on the remembered path does not rename the project', async () => {
    const api = installApi({ showSaveDialog: jest.fn(async () => 'D:\\p.audm') });
    seedProjectDoc();
    useSessionStore.getState().setProjectPath('D:\\p.audm');

    await saveProject({ as: true });

    expect(api.writeFile.mock.calls[0][0]).toBe('D:\\p.audm');
    expect(useSessionStore.getState().session.name).toBe('Untitled Session');
    expect(isSessionDirty()).toBe(false);
  });

  it('hands writeFile the buffer straight from serialization with no defensive full-buffer copy (the v3 IMPORTANT-1 pin, kept for v4)', async () => {
    // See the former saveSessionViaDialog pin: `serializeSessionV4` assembles
    // its output with exactly one `Uint8Array#set` per part (magic, JSON, one
    // per channel chunk — 3 for this single-mono-channel project). A
    // `toArrayBuffer`-style copy before the write would add a fourth.
    installApi({ showSaveDialog: jest.fn(async () => 'D:\\out\\session.audm') });
    seedProjectDoc();
    const setSpy = jest.spyOn(Uint8Array.prototype, 'set');

    await saveProject({ as: false });

    expect(setSpy).toHaveBeenCalledTimes(3);
    setSpy.mockRestore();
  });

  it('a failed write shows "Save Project failed", leaves projectPath unchanged and the project dirty (acceptance 9)', async () => {
    const api = installApi({
      showSaveDialog: jest.fn(async () => 'D:\\out\\p.audm'),
      writeFile: jest.fn(async () => ({ ok: false, error: 'disk full' })),
    });
    const doc = seedProjectDoc();

    const ok = await saveProject({ as: false });

    expect(ok).toBe(false);
    expect(api.showMessageBox).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', title: 'Save Project failed', message: 'disk full' })
    );
    expect(useSessionStore.getState().projectPath).toBeNull();
    expect(isSessionDirty()).toBe(true);
    expect(live(doc.id).neverSaved).toBe(true);
  });

  it('a serialize throw shows the same box and never calls writeFile', async () => {
    const api = installApi({ showSaveDialog: jest.fn(async () => 'D:\\out\\p.audm') });
    const doc = seedProjectDoc();
    useAppStore.setState((s) => ({
      documents: s.documents.map((d) => (d.id === doc.id ? { ...d, channels: [null as unknown as Float32Array] } : d)),
    }));

    const ok = await saveProject({ as: false });

    expect(ok).toBe(false);
    expect(api.writeFile).not.toHaveBeenCalled();
    expect(api.showMessageBox).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', title: 'Save Project failed' })
    );
    expect(useSessionStore.getState().projectPath).toBeNull();
  });

  it('a second saveProject while one is awaiting its write shows "Save in progress" and writes nothing', async () => {
    const { writeFile, resolve } = pendingWrite();
    const api = installApi({ showSaveDialog: jest.fn(async () => 'D:\\out\\p.audm'), writeFile });
    seedProjectDoc();

    const first = saveProject({ as: false });
    await tick();
    expect(isProjectSaveInFlight()).toBe(true);

    const second = await saveProject({ as: false });

    expect(second).toBe(false);
    expect(api.showMessageBox).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'warning', title: 'Save in progress' })
    );
    expect(writeFile).toHaveBeenCalledTimes(1);

    resolve({ ok: true });
    await expect(first).resolves.toBe(true);
    expect(isProjectSaveInFlight()).toBe(false);
  });

  it('a clip edit during the write invalidates the session save point (dirty stays true) while the path is still remembered', async () => {
    const { writeFile, resolve } = pendingWrite();
    installApi({ showSaveDialog: jest.fn(async () => 'D:\\out\\p.audm'), writeFile });
    seedProjectDoc();

    const save = saveProject({ as: false });
    await tick();
    useSessionStore.getState().addTrack(); // a recorded session edit lands mid-write
    resolve({ ok: true });
    await expect(save).resolves.toBe(true);

    expect(isSessionDirty()).toBe(true);
    expect(useSessionStore.getState().projectPath).toBe('D:\\out\\p.audm');
    // The mark is permanently unreachable: undoing the mid-write edit does not
    // make the project read clean against bytes that predate it.
    undoSession();
    expect(isSessionDirty()).toBe(true);
  });

  it('a document edited during the write keeps its dirty flag and gets invalidateSavePoint; the untouched document is marked clean', async () => {
    const { writeFile, resolve } = pendingWrite();
    installApi({ showSaveDialog: jest.fn(async () => 'D:\\out\\p.audm'), writeFile });
    const a = seedProjectDoc('a.wav');
    const b = seedProjectDoc('b.wav', false);
    const invalidateSpy = jest.spyOn(undoHistory, 'invalidateSavePoint');

    const save = saveProject({ as: false });
    await tick();
    useAppStore.getState().updateDocument({ ...live(b.id), dirty: true }); // replaces the object mid-await
    resolve({ ok: true });
    await expect(save).resolves.toBe(true);

    expect(live(a.id).dirty).toBe(false);
    expect(live(a.id).neverSaved).toBe(false);
    expect(live(b.id).dirty).toBe(true);
    expect(invalidateSpy).toHaveBeenCalledWith(b.id);
    expect(invalidateSpy).not.toHaveBeenCalledWith(a.id);
    invalidateSpy.mockRestore();
  });

  it('a session holding a clip of a CLOSED document saves, reports the dropped clip in one box, and is clean afterwards', async () => {
    const api = installApi({ showSaveDialog: jest.fn(async () => 'D:\\out\\p.audm') });
    seedProjectDoc('a.wav');
    const closedDoc = createDocument({ name: 'b.wav', sampleRate: 44100, channels: [sine(10)] });
    useAppStore.getState().addDocument(closedDoc);
    useAppStore.getState().closeDocument(closedDoc.id);
    const trackId = useSessionStore.getState().session.tracks[0].id;
    useSessionStore
      .getState()
      .addClip(trackId, createClip({ documentId: closedDoc.id, startSample: 100, offsetSample: 0, lengthSample: 10 }));

    const ok = await saveProject({ as: false });

    expect(ok).toBe(true);
    expect(api.writeFile).toHaveBeenCalledTimes(1);
    const [, data] = api.writeFile.mock.calls[0];
    const { session } = parseSessionFileV4(data as ArrayBuffer);
    expect(session.tracks[0].clips).toHaveLength(1);
    expect(api.showMessageBox).toHaveBeenCalledTimes(1);
    expect(api.showMessageBox).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'info',
        title: 'Save Project',
        message: expect.stringMatching(/^Project saved\. 1 clip\(s\) referenced closed files/),
      })
    );
    expect(isSessionDirty()).toBe(false);
  });

  it('writeProject (the headless core) writes v4 silently, renames on request, and remembers the path', async () => {
    const api = installApi();
    seedProjectDoc();

    const ok = await writeProject('D:\\out\\take 3.audm', { rename: true });

    expect(ok).toBe(true);
    expect(api.showSaveDialog).not.toHaveBeenCalled();
    expect(api.showMessageBox).not.toHaveBeenCalled();
    expect(api.writeFile.mock.calls[0][0]).toBe('D:\\out\\take 3.audm');
    expect(useSessionStore.getState().projectPath).toBe('D:\\out\\take 3.audm');
    expect(useSessionStore.getState().session.name).toBe('take 3');
    expect(isSessionDirty()).toBe(false);
  });

  it('a load-shaped replacement during the write does not adopt the finished save target (fix round 1 — finding 1)', async () => {
    // `stemLanding.ts:311-331` (and `coverJourney.ts:1395-1410`) replace the
    // whole session, set `projectPath: null` — M4: a landed stem session is a
    // NEW, unsaved project — and clear the session history. Separation runs for
    // minutes in the background, so it can perfectly well resolve inside a
    // save's `writeFile` await. When it does, the finished save must not stamp
    // its target over the new project: the bytes on disk are the PREVIOUS
    // project, and re-binding would make the next plain Ctrl+S (the pill is lit
    // — the stem documents are `neverSaved`) overwrite that file with the stem
    // session, with no dialog in front of it.
    const { writeFile, resolve } = pendingWrite();
    installApi({ writeFile });
    seedProjectDoc();
    useSessionStore.getState().setProjectPath('D:\\old.audm');

    const save = saveProject({ as: false });
    await tick();
    expect(writeFile.mock.calls[0][0]).toBe('D:\\old.audm');

    const landed: Session = { name: 'Stems', sampleRate: 44100, tracks: [createTrack('Vocals')] };
    useSessionStore.setState({ session: landed, selectedClipId: null, projectPath: null });
    clearSessionHistory();

    resolve({ ok: true });
    await expect(save).resolves.toBe(true);

    expect(useSessionStore.getState().session).toBe(landed);
    expect(useSessionStore.getState().projectPath).toBeNull();
    expect(writeFile).toHaveBeenCalledTimes(1); // the old project got its bytes; the new one is unsaved
  });

  it('the same interleave on a NEVER-saved project does not adopt the Save As target either', async () => {
    // The null -> null case: comparing `projectPath` before and after the await
    // would miss it, because the landing writes the same `null` the save
    // started from. What separates them is the replacement itself.
    const { writeFile, resolve } = pendingWrite();
    installApi({ showSaveDialog: jest.fn(async () => 'D:\\out\\new.audm'), writeFile });
    seedProjectDoc();
    expect(useSessionStore.getState().projectPath).toBeNull();

    const save = saveProject({ as: false }); // no remembered path -> this IS a Save As
    await tick();

    const landed: Session = { name: 'Stems', sampleRate: 44100, tracks: [createTrack('Vocals')] };
    useSessionStore.setState({ session: landed, selectedClipId: null, projectPath: null });
    clearSessionHistory();

    resolve({ ok: true });
    await expect(save).resolves.toBe(true);

    expect(writeFile.mock.calls[0][0]).toBe('D:\\out\\new.audm');
    expect(useSessionStore.getState().projectPath).toBeNull();
  });

  it('an Open Project that lands mid-write keeps ITS path and stays clean', async () => {
    const { writeFile, resolve } = pendingWrite();
    const openedDoc = createDocument({ name: 'b.wav', sampleRate: 44100, channels: [sine(10)] });
    const openedTrack = createTrack('T');
    openedTrack.clips = [
      createClip({ documentId: openedDoc.id, startSample: 0, offsetSample: 0, lengthSample: 10 }),
    ];
    const { bytes } = serializeSessionV4(
      { name: 'B', sampleRate: 44100, tracks: [openedTrack] },
      [openedDoc]
    );
    installApi({ writeFile, readFile: jest.fn(async () => bytes.buffer) });
    seedProjectDoc();
    useSessionStore.getState().setProjectPath('D:\\a.audm');

    const save = saveProject({ as: false });
    await tick();
    await loadProjectFrom('D:\\b.audm'); // File -> Open Project, additive, clears the history

    resolve({ ok: true });
    await expect(save).resolves.toBe(true);

    expect(useSessionStore.getState().projectPath).toBe('D:\\b.audm');
    expect(useSessionStore.getState().session.name).toBe('B');
    expect(isSessionDirty()).toBe(false); // and the close guard sees a clean, correctly-bound project
  });

  it('loadProjectFrom throws on a corrupt buffer and applies nothing', async () => {
    installApi({ readFile: jest.fn(async () => buildV4Buffer({ formatVersion: 4, session: { name: 'x', sampleRate: 44100, tracks: [] }, audio: 'x' })) });
    useSessionStore.getState().setProjectPath('D:\\p.audm');
    const before = useSessionStore.getState().session;

    await expect(loadProjectFrom('D:\\in\\bad.audm')).rejects.toThrow(/Corrupt \.audm file/);

    expect(useSessionStore.getState().session).toBe(before);
    expect(useSessionStore.getState().projectPath).toBe('D:\\p.audm');
    expect(useAppStore.getState().documents).toEqual([]);
    expect(useAppStore.getState().view).not.toBe('multitrack');
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
  // re-fit arm is never taken. File → Open Project on the user's own file
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

  it('saving the PROJECT clears neverSaved on every open document — they are all in the file now (lot A, M4)', async () => {
    installApi({ showSaveDialog: jest.fn(async () => 'D:\\out\\session.audm') });
    // A computed document (a Mix Down / Remix / recording) dropped onto a track,
    // and another one that no clip references.
    const derived = createDocument({ name: 'Mixdown 1', sampleRate: 44100, channels: [sine(10)] });
    const loose = createDocument({ name: 'Remix 1', sampleRate: 44100, channels: [sine(10)] });
    useAppStore.getState().addDocument(derived);
    useAppStore.getState().addDocument(loose);
    const trackId = useSessionStore.getState().session.tracks[0].id;
    useSessionStore
      .getState()
      .addClip(trackId, createClip({ documentId: derived.id, startSample: 0, offsetSample: 0, lengthSample: 10 }));
    expect(useAppStore.getState().documents.map((d) => d.neverSaved)).toEqual([true, true]);

    await saveProject({ as: true });

    // The S4 reasoning that kept the flag ("a session save embeds only
    // clip-referenced documents") no longer applies: a v4 project save writes
    // EVERY open document, so each one's audio is now on disk inside the
    // project, and closing it discards nothing that reopening would not restore.
    expect(useAppStore.getState().documents.map((d) => d.neverSaved)).toEqual([false, false]);
  });
});

// ---------------------------------------------------------------------------
// Lot A (M4) — .audm v4: the project is the session plus EVERY open document.
// ---------------------------------------------------------------------------
describe('serializeSessionV4 -> parseSessionFileV4 round trip (lot A — nothing dropped)', () => {
  it('writes AUDM4, splits audio / unreferenced, and the parse restores both documents with markers, origin and neverSaved=false', () => {
    const referenced = createDocument({
      name: 'a.wav',
      sampleRate: 44100,
      channels: [sine(100)],
      filePath: 'D:\\src\\a.wav',
    });
    const unreferenced = createDocument({
      name: 'b.wav',
      sampleRate: 48000,
      channels: [sine(50), sine(50, 880)],
    });
    const track = createTrack('T');
    track.clips = [createClip({ documentId: referenced.id, startSample: 0, offsetSample: 0, lengthSample: 100 })];
    const session: Session = { name: 'S', sampleRate: 44100, tracks: [track] };
    const markersByDoc: Record<string, Marker[]> = {
      [referenced.id]: [{ id: 'm-1', name: 'A1', positionSample: 10 }],
      [unreferenced.id]: [{ id: 'm-2', name: 'B1', positionSample: 20 }],
    };

    const { bytes, droppedClipCount } = serializeSessionV4(session, [referenced, unreferenced], markersByDoc);

    expect(droppedClipCount).toBe(0);
    expect(bytes.byteOffset).toBe(0);
    expect(bytes.byteLength).toBe(bytes.buffer.byteLength); // the fresh zero-offset guarantee v3 gives
    expect(new TextDecoder().decode(bytes.subarray(0, 6))).toBe('AUDM4\n');
    const json = readBinaryJson(bytes) as {
      formatVersion: number;
      audio: { docId: string; origin?: string }[];
      unreferenced: { docId: string; origin?: string }[];
      markers: Record<string, unknown>;
    };
    expect(json.formatVersion).toBe(4);
    expect(json.audio).toHaveLength(1);
    expect(json.audio[0].docId).toBe(referenced.id);
    expect(json.audio[0].origin).toBe('D:\\src\\a.wav');
    expect(json.unreferenced).toHaveLength(1);
    expect(json.unreferenced[0].docId).toBe(unreferenced.id);
    expect(json.unreferenced[0].origin).toBeUndefined();
    // EVERY embedded document with markers — referenced or not (v3 narrowed to referenced).
    expect(Object.keys(json.markers).sort()).toEqual([referenced.id, unreferenced.id].sort());

    const parsed = parseSessionFileV4(bytes.buffer);
    expect(parsed.documents).toHaveLength(2);
    const [a, b] = parsed.documents; // audio docs first, then unreferenced
    expect(a.name).toBe('a.wav');
    expect(b.name).toBe('b.wav');
    expect(a.channels[0]).toEqual(referenced.channels[0]);
    expect(b.channels).toHaveLength(2);
    expect(b.channels[0]).toEqual(unreferenced.channels[0]);
    expect(b.channels[1]).toEqual(unreferenced.channels[1]);
    expect(b.sampleRate).toBe(48000);
    expect(a.filePath).toBe('D:\\src\\a.wav');
    expect(b.filePath).toBeNull();
    expect(a.neverSaved).toBe(false);
    expect(b.neverSaved).toBe(false);
    expect(parsed.markers[a.id]).toEqual([expect.objectContaining({ name: 'A1', positionSample: 10 })]);
    expect(parsed.markers[b.id]).toEqual([expect.objectContaining({ name: 'B1', positionSample: 20 })]);
    expect(parsed.session.tracks[0].clips[0].documentId).toBe(a.id);
    expect(parsed.droppedClipCount).toBe(0);
  });

  it('drops a clip of a CLOSED document and reports it, while still embedding every OPEN document', () => {
    const openDoc = createDocument({ name: 'a.wav', sampleRate: 44100, channels: [sine(10)] });
    const otherOpen = createDocument({ name: 'c.wav', sampleRate: 44100, channels: [sine(10)] });
    const closedDoc = createDocument({ name: 'b.wav', sampleRate: 44100, channels: [sine(10)] });
    const track = createTrack('T');
    track.clips = [
      createClip({ documentId: openDoc.id, startSample: 0, offsetSample: 0, lengthSample: 10 }),
      createClip({ documentId: closedDoc.id, startSample: 100, offsetSample: 0, lengthSample: 10 }),
    ];
    const session: Session = { name: 'S', sampleRate: 44100, tracks: [track] };

    const { bytes, droppedClipCount } = serializeSessionV4(session, [openDoc, otherOpen]);

    expect(droppedClipCount).toBe(1);
    const parsed = parseSessionFileV4(bytes.buffer);
    expect(parsed.session.tracks[0].clips).toHaveLength(1);
    expect(parsed.documents.map((d) => d.name)).toEqual(['a.wav', 'c.wav']);
  });

  it('keeps the per-document equal-channel-length throw', () => {
    const doc = createDocument({ name: 'a.wav', sampleRate: 44100, channels: [sine(10), sine(9)] });
    const session: Session = { name: 'S', sampleRate: 44100, tracks: [createTrack('T')] };
    expect(() => serializeSessionV4(session, [doc])).toThrow(/differing length/);
  });
});

describe('parseSessionFileBytes dispatch (lot A — v4 joins v3 and the legacy JSON path)', () => {
  function fixture() {
    const doc = createDocument({ name: 'a.wav', sampleRate: 44100, channels: [sine(40)] });
    const track = createTrack('T');
    track.clips = [createClip({ documentId: doc.id, startSample: 0, offsetSample: 0, lengthSample: 40 })];
    const session: Session = { name: 'Compat', sampleRate: 44100, tracks: [track] };
    return { doc, session };
  }

  it('still loads a v3 buffer exactly as parseSessionFileV3 does', () => {
    const { doc, session } = fixture();
    const { bytes } = serializeSessionV3(session, [doc]);

    const viaDispatch = parseSessionFileBytes(bytes.buffer);

    expect(viaDispatch.session.name).toBe('Compat');
    expect(viaDispatch.documents).toHaveLength(1);
    expect(viaDispatch.documents[0].channels[0]).toEqual(doc.channels[0]);
    expect(viaDispatch.documents[0].filePath).toBeNull();
    expect(viaDispatch.session.tracks[0].clips[0].documentId).toBe(viaDispatch.documents[0].id);
  });

  it('still loads a legacy v2 JSON buffer exactly as parseSessionFile does', () => {
    const { doc, session } = fixture();
    const { json } = serializeSession(session, [doc]);

    const viaDispatch = parseSessionFileBytes(new TextEncoder().encode(json).buffer);

    expect(viaDispatch.session.name).toBe('Compat');
    expect(viaDispatch.documents).toHaveLength(1);
    expect(viaDispatch.documents[0].channels[0]).toEqual(doc.channels[0]);
  });

  it('routes a v4 buffer to the v4 parser', () => {
    const { doc, session } = fixture();
    const { bytes } = serializeSessionV4(session, [doc]);

    const viaDispatch = parseSessionFileBytes(bytes.buffer);

    expect(viaDispatch.documents[0].channels[0]).toEqual(doc.channels[0]);
  });

  it('a v4 buffer whose JSON claims formatVersion 3 is rejected with "expected 4"', () => {
    const buf = buildV4Buffer({
      formatVersion: 3,
      session: { name: 'x', sampleRate: 44100, tracks: [] },
      audio: [],
      unreferenced: [],
    });
    expect(() => parseSessionFileBytes(buf)).toThrow('Unsupported session file version: 3 (expected 4)');
  });

  it('a v4 buffer missing its unreferenced array loads it as [] rather than as corrupt', () => {
    const buf = buildV4Buffer({
      formatVersion: 4,
      session: { name: 'x', sampleRate: 44100, tracks: [trackJson('track-1')] },
      audio: [],
    });
    const parsed = parseSessionFileBytes(buf);
    expect(parsed.documents).toEqual([]);
    expect(parsed.session.name).toBe('x');
  });

  it('a v4 buffer with a non-array unreferenced section is corrupt', () => {
    const buf = buildV4Buffer({
      formatVersion: 4,
      session: { name: 'x', sampleRate: 44100, tracks: [] },
      audio: [],
      unreferenced: 'nope',
    });
    expect(() => parseSessionFileBytes(buf)).toThrow(/Corrupt \.audm file/);
  });

  it('applies the v3 corrupt-file guards to the unreferenced section too', () => {
    const buf = buildV4Buffer({
      formatVersion: 4,
      session: { name: 'x', sampleRate: 44100, tracks: [] },
      audio: [],
      unreferenced: [{ docId: 'doc-1', name: 'u', sampleRate: 44100, length: 4, channels: [{ offset: 0, byteLength: 16 }] }],
    }); // declares 16 payload bytes, provides none
    expect(() => parseSessionFileBytes(buf)).toThrow('Corrupt .audm file: audio payload offset/length out of range');
  });

  it('parseSessionFileV3 keeps its own (expected 3) rejection text', () => {
    const buf = buildV3Buffer({ formatVersion: 4, session: { name: 'x', sampleRate: 44100, tracks: [] }, audio: [] });
    expect(() => parseSessionFileV3(buf)).toThrow('Unsupported session file version: 4 (expected 3)');
  });
});

// ---------------------------------------------------------------------------
// Lot A (M4) — Open Project restores EVERYTHING the v4 file holds.
// ---------------------------------------------------------------------------
describe('openSessionViaDialog with a v4 project (lot A — acceptance 10)', () => {
  it('restores referenced and unreferenced documents with markers, remembers the path, clears the history, switches to multitrack', async () => {
    const a = createDocument({ name: 'a.wav', sampleRate: 44100, channels: [sine(10)] });
    const b = createDocument({ name: 'b.wav', sampleRate: 44100, channels: [sine(10)] });
    const track = createTrack('T');
    track.clips = [createClip({ documentId: a.id, startSample: 0, offsetSample: 0, lengthSample: 10 })];
    const markersByDoc: Record<string, Marker[]> = { [b.id]: [{ id: 'm-1', name: 'B1', positionSample: 3 }] };
    const { bytes } = serializeSessionV4({ name: 'Proj', sampleRate: 44100, tracks: [track] }, [a, b], markersByDoc);
    const api = installApi({
      showOpenDialog: jest.fn(async () => ['D:\\in\\proj.audm']),
      readFile: jest.fn(async () => bytes.buffer),
    });
    useSessionStore.getState().addTrack(); // a history entry the load must drop
    expect(canUndoSession()).toBe(true);

    await openSessionViaDialog();

    expect(api.showOpenDialog).toHaveBeenCalledWith(
      expect.objectContaining({ filters: [{ name: 'Auditorium Project', extensions: ['audm'] }] })
    );
    const docs = useAppStore.getState().documents;
    expect(docs.map((d) => d.name)).toEqual(['a.wav', 'b.wav']);
    expect(useAppStore.getState().markers[docs[1].id]).toEqual([
      expect.objectContaining({ name: 'B1', positionSample: 3 }),
    ]);
    expect(useAppStore.getState().view).toBe('multitrack');
    expect(useSessionStore.getState().projectPath).toBe('D:\\in\\proj.audm');
    expect(useSessionStore.getState().session.name).toBe('Proj');
    expect(useSessionStore.getState().session.tracks[0].clips[0].documentId).toBe(docs[0].id);
    expect(canUndoSession()).toBe(false);
    expect(isSessionDirty()).toBe(false);
    expect(api.showMessageBox).not.toHaveBeenCalled();
  });

  it('a corrupt buffer shows "Open Project failed" and changes nothing — not even the remembered path', async () => {
    const api = installApi({
      showOpenDialog: jest.fn(async () => ['D:\\in\\bad.audm']),
      readFile: jest.fn(async () =>
        buildV4Buffer({ formatVersion: 4, session: { name: 'x', sampleRate: 44100, tracks: [] }, audio: 'x' })
      ),
    });
    useSessionStore.getState().setProjectPath('D:\\p.audm');
    const before = useSessionStore.getState().session;
    const docsBefore = useAppStore.getState().documents;

    await openSessionViaDialog();

    expect(api.showMessageBox).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', title: 'Open Project failed' })
    );
    expect(useSessionStore.getState().session).toBe(before);
    expect(useSessionStore.getState().projectPath).toBe('D:\\p.audm');
    expect(useAppStore.getState().documents).toBe(docsBefore);
    expect(useAppStore.getState().view).not.toBe('multitrack');
  });

  it('reports dropped clips under the Open Project title', async () => {
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
    const api = installApi({
      showOpenDialog: jest.fn(async () => ['D:\\in\\stale.audm']),
      readFile: jest.fn(async () => new TextEncoder().encode(json).buffer),
    });

    await openSessionViaDialog();

    expect(api.showMessageBox).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'info', title: 'Open Project', message: '1 clip(s) referenced missing audio and were removed.' })
    );
  });
});
