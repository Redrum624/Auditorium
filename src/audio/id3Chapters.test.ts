import { buildId3Chapters, parseId3Chapters } from './id3Chapters';

function readAscii(bytes: Uint8Array, offset: number, length: number): string {
  let s = '';
  for (let i = 0; i < length; i++) s += String.fromCharCode(bytes[offset + i]);
  return s;
}

function readSyncsafe(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] & 0x7f) << 21) |
    ((bytes[offset + 1] & 0x7f) << 14) |
    ((bytes[offset + 2] & 0x7f) << 7) |
    (bytes[offset + 3] & 0x7f)
  );
}

function readU32BE(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3];
}

/** Minimal frame walker used by the structural tests below — independent of
 * the module under test's own frame-walking logic. */
function walkFrames(bytes: Uint8Array, start: number, end: number): { id: string; start: number; end: number }[] {
  const out: { id: string; start: number; end: number }[] = [];
  let offset = start;
  while (offset + 10 <= end) {
    const id = readAscii(bytes, offset, 4);
    if (bytes[offset] === 0) break;
    const size = readU32BE(bytes, offset + 4) >>> 0;
    const dataStart = offset + 10;
    const dataEnd = dataStart + size;
    out.push({ id, start: dataStart, end: dataEnd });
    offset = dataEnd;
  }
  return out;
}

describe('buildId3Chapters — byte-level layout (ID3v2.3)', () => {
  it('writes the ID3 header (magic, version 2.3.0, flags 0x00, syncsafe size)', () => {
    const tag = buildId3Chapters([{ positionSample: 44100, name: 'Intro' }], 44100);
    expect(readAscii(tag, 0, 3)).toBe('ID3');
    expect(tag[3]).toBe(0x03); // major version
    expect(tag[4]).toBe(0x00); // minor version
    expect(tag[5]).toBe(0x00); // flags
    const declaredSize = readSyncsafe(tag, 6);
    expect(declaredSize).toBe(tag.length - 10);
    // syncsafe bytes never have the top bit set
    expect(tag[6] & 0x80).toBe(0);
    expect(tag[7] & 0x80).toBe(0);
    expect(tag[8] & 0x80).toBe(0);
    expect(tag[9] & 0x80).toBe(0);
  });

  it('writes one CTOC frame with element id "toc", flags 0x03, entry count, and NUL-terminated child ids', () => {
    const tag = buildId3Chapters(
      [
        { positionSample: 0, name: 'A' },
        { positionSample: 100, name: 'B' },
        { positionSample: 200, name: 'C' },
      ],
      44100
    );
    const frames = walkFrames(tag, 10, tag.length);
    const ctoc = frames.find((f) => f.id === 'CTOC');
    expect(ctoc).toBeDefined();
    const p = ctoc!.start;
    expect(readAscii(tag, p, 3)).toBe('toc');
    expect(tag[p + 3]).toBe(0x00); // NUL terminator
    expect(tag[p + 4]).toBe(0x03); // flags: top-level | ordered
    expect(tag[p + 5]).toBe(3); // entry count
    // child ids "chp0\0chp1\0chp2\0"
    expect(readAscii(tag, p + 6, 4)).toBe('chp0');
    expect(tag[p + 10]).toBe(0x00);
    expect(readAscii(tag, p + 11, 4)).toBe('chp1');
    expect(tag[p + 15]).toBe(0x00);
    expect(readAscii(tag, p + 16, 4)).toBe('chp2');
    expect(tag[p + 20]).toBe(0x00);
    expect(ctoc!.end - ctoc!.start).toBe(6 + 3 * 5);
  });

  it('writes one CHAP frame per marker with correct element id, start/end ms, 0xFFFFFFFF byte offsets, and embedded TIT2', () => {
    const sampleRate = 44100;
    const tag = buildId3Chapters(
      [
        { positionSample: 44100, name: 'Verse' }, // 1000ms
        { positionSample: 88200, name: 'Chorus' }, // 2000ms
      ],
      sampleRate
    );
    const frames = walkFrames(tag, 10, tag.length);
    const chaps = frames.filter((f) => f.id === 'CHAP');
    expect(chaps).toHaveLength(2);

    // First CHAP: "chp0"
    const c0 = chaps[0];
    expect(readAscii(tag, c0.start, 4)).toBe('chp0');
    expect(tag[c0.start + 4]).toBe(0x00); // NUL
    let p = c0.start + 5;
    expect(readU32BE(tag, p)).toBe(1000); // start ms
    expect(readU32BE(tag, p + 4)).toBe(1000); // end ms == start (point marker)
    expect(readU32BE(tag, p + 8) >>> 0).toBe(0xffffffff); // start byte offset
    expect(readU32BE(tag, p + 12) >>> 0).toBe(0xffffffff); // end byte offset
    p += 16;
    // Embedded TIT2 sub-frame
    expect(readAscii(tag, p, 4)).toBe('TIT2');
    const tit2Size = readU32BE(tag, p + 4);
    const tit2DataStart = p + 10;
    expect(tag[tit2DataStart]).toBe(0x01); // encoding: UTF-16 with BOM
    expect(tag[tit2DataStart + 1]).toBe(0xff); // BOM LE
    expect(tag[tit2DataStart + 2]).toBe(0xfe);
    // "Verse" as UTF-16LE code units follow the BOM
    const nameBytes = tag.slice(tit2DataStart + 3, tit2DataStart + tit2Size);
    let decoded = '';
    for (let i = 0; i + 1 < nameBytes.length; i += 2) {
      decoded += String.fromCharCode(nameBytes[i] | (nameBytes[i + 1] << 8));
    }
    expect(decoded).toBe('Verse');

    // Second CHAP: "chp1", 2000ms
    const c1 = chaps[1];
    expect(readAscii(tag, c1.start, 4)).toBe('chp1');
    expect(readU32BE(tag, c1.start + 5)).toBe(2000);
  });

  it('writes exactly one TXXX frame with description AUDITORIUM_MARKERS and compact-JSON value', () => {
    const tag = buildId3Chapters(
      [
        { positionSample: 10, name: 'Intro' },
        { positionSample: 500, name: 'Outro' },
      ],
      44100
    );
    const frames = walkFrames(tag, 10, tag.length);
    const txxxFrames = frames.filter((f) => f.id === 'TXXX');
    expect(txxxFrames).toHaveLength(1);
    const t = txxxFrames[0];
    expect(tag[t.start]).toBe(0x01); // encoding UTF-16 BOM
    expect(tag[t.start + 1]).toBe(0xff);
    expect(tag[t.start + 2]).toBe(0xfe);
    // Decode description up to the UTF-16 NUL terminator (00 00)
    let i = t.start + 3;
    let descBytes: number[] = [];
    while (tag[i] !== 0 || tag[i + 1] !== 0) {
      descBytes.push(tag[i], tag[i + 1]);
      i += 2;
    }
    let desc = '';
    for (let k = 0; k + 1 < descBytes.length; k += 2) {
      desc += String.fromCharCode(descBytes[k] | (descBytes[k + 1] << 8));
    }
    expect(desc).toBe('AUDITORIUM_MARKERS');
    // terminator
    expect(tag[i]).toBe(0x00);
    expect(tag[i + 1]).toBe(0x00);
    i += 2;
    // value: BOM + UTF-16LE JSON to end of frame
    expect(tag[i]).toBe(0xff);
    expect(tag[i + 1]).toBe(0xfe);
    const valueBytes = tag.slice(i + 2, t.end);
    let json = '';
    for (let k = 0; k + 1 < valueBytes.length; k += 2) {
      json += String.fromCharCode(valueBytes[k] | (valueBytes[k + 1] << 8));
    }
    expect(JSON.parse(json)).toEqual([
      { s: 10, n: 'Intro' },
      { s: 500, n: 'Outro' },
    ]);
  });

  it('writes exactly CTOC + N*CHAP + TXXX frames, in that order, with no extra frames', () => {
    const tag = buildId3Chapters(
      [
        { positionSample: 1, name: 'A' },
        { positionSample: 2, name: 'B' },
      ],
      44100
    );
    const frames = walkFrames(tag, 10, tag.length);
    expect(frames.map((f) => f.id)).toEqual(['CTOC', 'CHAP', 'CHAP', 'TXXX']);
  });
});

describe('buildId3Chapters — CTOC/CHAP interop cap at 255 markers (F22)', () => {
  it('caps CTOC entry count and emitted CHAP frames at 255 for 256 markers, while TXXX still carries all 256', () => {
    const markers = Array.from({ length: 256 }, (_, i) => ({ positionSample: i * 100, name: `M${i}` }));
    const tag = buildId3Chapters(markers, 44100);
    const frames = walkFrames(tag, 10, tag.length);

    const ctoc = frames.find((f) => f.id === 'CTOC')!;
    expect(tag[ctoc.start + 5]).toBe(255); // entry count byte now matches the emitted child count

    const chaps = frames.filter((f) => f.id === 'CHAP');
    expect(chaps).toHaveLength(255);
    expect(readAscii(tag, chaps[0].start, 4)).toBe('chp0');
    expect(readAscii(tag, chaps[254].start, 6)).toBe('chp254'); // 255th (last emitted) marker

    const txxxFrames = frames.filter((f) => f.id === 'TXXX');
    expect(txxxFrames).toHaveLength(1);

    const parsed = parseId3Chapters(new Uint8Array(tag).buffer);
    expect(parsed).not.toBeNull();
    expect(parsed).toHaveLength(256); // TXXX (source of truth) is never capped
    expect(parsed!.map((m) => m.exactSample)).toEqual(markers.map((m) => m.positionSample));
  });

  it('selects the interop CHAP subset by POSITION, not input array order', () => {
    // 257 markers at positions 0..256 (in samples), fed in a shuffled (not
    // position-sorted) order. The emitted CHAP set must still be exactly the
    // 255 LOWEST positions (0..254), not "whichever 255 came first in the array".
    const inOrder = Array.from({ length: 257 }, (_, i) => ({ positionSample: i, name: `M${i}` }));
    const shuffled = [...inOrder].sort((a, b) => (a.positionSample % 7) - (b.positionSample % 7));
    expect(shuffled).not.toEqual(inOrder); // sanity: the shuffle actually reordered it

    const tag = buildId3Chapters(shuffled, 44100);
    const frames = walkFrames(tag, 10, tag.length);
    const chaps = frames.filter((f) => f.id === 'CHAP');
    expect(chaps).toHaveLength(255);

    // Decode each CHAP's start ms and confirm the emitted set is exactly
    // positions 0..254 (the 255 lowest), regardless of input order. The
    // element id ("chp0".."chp254") is variable-length (NUL-terminated), so
    // find its terminator rather than assuming a fixed offset.
    const startMses = chaps.map((c) => {
      let i = c.start;
      while (tag[i] !== 0) i++;
      return readU32BE(tag, i + 1);
    });
    const expectedMs = Array.from({ length: 255 }, (_, i) => Math.round((i / 44100) * 1000));
    expect([...startMses].sort((a, b) => a - b)).toEqual(expectedMs);
  });
});

describe('buildId3Chapters → parseId3Chapters round-trip', () => {
  it('round-trips Unicode names and exact sample positions via the TXXX (preferred) path', () => {
    const markers = [
      { positionSample: 44100, name: 'Café ☕ 日本語' }, // 1000ms
      { positionSample: 132300, name: '🎵 Emoji Marker' }, // 3000ms
      { positionSample: 0, name: 'Start' }, // 0ms
    ];
    const tag = buildId3Chapters(markers, 44100);
    const copy = new Uint8Array(tag); // standalone ArrayBuffer, independent of tag's own buffer
    const parsed = parseId3Chapters(copy.buffer);
    expect(parsed).not.toBeNull();
    expect(parsed).toHaveLength(3);
    expect(parsed!.map((m) => m.name)).toEqual(markers.map((m) => m.name));
    expect(parsed!.map((m) => m.exactSample)).toEqual(markers.map((m) => m.positionSample));
    // positionMs must line up with the SAME (input-order) entry, not with
    // whatever entry the position-sorted CHAP emission happened to put at
    // that index (Fix round 1 regression — see the two dedicated tests below).
    expect(parsed!.map((m) => m.positionMs)).toEqual([1000, 3000, 0]);
  });

  it('pairs each TXXX entry with the correct positionMs even when input is not position-sorted (Fix round 1)', () => {
    // buildId3Chapters's F22 cap sorts BY POSITION for CHAP emission (chp0 =
    // lowest position), while TXXX keeps input order. parseId3Chapters must
    // re-rank TXXX entries the same way before pairing positionMs by index —
    // pairing by raw TXXX (input) index against position-sorted CHAP silently
    // rotated every positionMs. This uses markers already sorted by position
    // deliberately shuffled to input order Café/Emoji/Start (44100/132300/0)
    // — CHAP emission order is Start(chp0)/Café(chp1)/Emoji(chp2).
    const markers = [
      { positionSample: 44100, name: 'Café ☕ 日本語' },
      { positionSample: 132300, name: '🎵 Emoji Marker' },
      { positionSample: 0, name: 'Start' },
    ];
    const tag = buildId3Chapters(markers, 44100);
    const parsed = parseId3Chapters(new Uint8Array(tag).buffer);
    expect(parsed).not.toBeNull();
    // Entries stay in TXXX (input) order: Café, Emoji, Start.
    expect(parsed!.map((m) => m.name)).toEqual(['Café ☕ 日本語', '🎵 Emoji Marker', 'Start']);
    expect(parsed!.map((m) => m.positionMs)).toEqual([1000, 3000, 0]);
  });

  it('falls back to positionMs 0 for TXXX entries beyond the 255-marker CHAP cap (F22 x Fix round 1)', () => {
    const markers = Array.from({ length: 300 }, (_, i) => ({ positionSample: i * 1000, name: `M${i}` }));
    const tag = buildId3Chapters(markers, 44100);
    const parsed = parseId3Chapters(new Uint8Array(tag).buffer);
    expect(parsed).not.toBeNull();
    expect(parsed).toHaveLength(300);
    // The 255 lowest positions (indices 0..254, already input-sorted here)
    // got a CHAP frame, so they carry a real (nonzero, except index 0) ms.
    for (let i = 0; i < 255; i++) {
      expect(parsed![i].positionMs).toBe(Math.round(((i * 1000) / 44100) * 1000));
    }
    // Everything past the cap has no CHAP counterpart, so it falls back to 0.
    for (let i = 255; i < 300; i++) {
      expect(parsed![i].positionMs).toBe(0);
    }
  });

  it('round-trips through a CHAP-only tag (TXXX stripped) using ms → name pairs, title from TIT2', () => {
    const markers = [
      { positionSample: 44100, name: 'One' },
      { positionSample: 88200, name: 'Two' },
    ];
    const tag = buildId3Chapters(markers, 44100);
    // Strip the TXXX frame: rebuild a tag containing only the CTOC+CHAP frames.
    const frames = walkFrames(tag, 10, tag.length);
    const txxx = frames.find((f) => f.id === 'TXXX')!;
    const withoutTxxx = new Uint8Array(tag.length - (txxx.end - (txxx.start - 10)));
    withoutTxxx.set(tag.slice(0, txxx.start - 10), 0);
    const view = new DataView(withoutTxxx.buffer);
    const newBodyLen = withoutTxxx.length - 10;
    view.setUint8(6, (newBodyLen >>> 21) & 0x7f);
    view.setUint8(7, (newBodyLen >>> 14) & 0x7f);
    view.setUint8(8, (newBodyLen >>> 7) & 0x7f);
    view.setUint8(9, newBodyLen & 0x7f);

    const parsed = parseId3Chapters(withoutTxxx.buffer);
    expect(parsed).not.toBeNull();
    expect(parsed).toHaveLength(2);
    expect(parsed!.map((m) => m.name)).toEqual(['One', 'Two']);
    expect(parsed!.map((m) => m.positionMs)).toEqual([1000, 2000]);
    expect(parsed!.every((m) => m.exactSample === undefined)).toBe(true);
  });
});

describe('parseId3Chapters — ID3v2.4 (syncsafe frame sizes)', () => {
  function syncsafeBytes(n: number): [number, number, number, number] {
    return [(n >>> 21) & 0x7f, (n >>> 14) & 0x7f, (n >>> 7) & 0x7f, n & 0x7f];
  }

  function buildV24TxxxTag(description: string, value: string): ArrayBuffer {
    const utf16le = (s: string): number[] => {
      const out: number[] = [];
      for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        out.push(c & 0xff, (c >> 8) & 0xff);
      }
      return out;
    };
    const payload = [
      0x01, // encoding: UTF-16 BOM
      0xff,
      0xfe,
      ...utf16le(description),
      0x00,
      0x00, // NUL terminator
      0xff,
      0xfe,
      ...utf16le(value),
    ];
    const frameSize = syncsafeBytes(payload.length);
    const frame = [
      0x54,
      0x58,
      0x58,
      0x58, // 'TXXX'
      ...frameSize,
      0x00,
      0x00, // frame flags
      ...payload,
    ];
    const tagSize = syncsafeBytes(frame.length);
    const header = [0x49, 0x44, 0x33, 0x04, 0x00, 0x00, ...tagSize];
    return new Uint8Array([...header, ...frame]).buffer;
  }

  it('parses a synthetic v2.4 tag (syncsafe frame sizes) via TXXX AUDITORIUM_MARKERS', () => {
    const json = JSON.stringify([
      { s: 12345, n: 'V4 Marker' },
      { s: 67890, n: 'Second' },
    ]);
    const buf = buildV24TxxxTag('AUDITORIUM_MARKERS', json);
    const parsed = parseId3Chapters(buf);
    expect(parsed).not.toBeNull();
    expect(parsed).toHaveLength(2);
    expect(parsed!.map((m) => m.exactSample)).toEqual([12345, 67890]);
    expect(parsed!.map((m) => m.name)).toEqual(['V4 Marker', 'Second']);
  });
});

describe('parseId3Chapters — corrupt / edge-case tolerance', () => {
  it('returns null for a buffer with no ID3 magic', () => {
    const buf = new Uint8Array([0xff, 0xfb, 0x90, 0x00, 1, 2, 3, 4, 5, 6, 7, 8]).buffer;
    expect(parseId3Chapters(buf)).toBeNull();
  });

  it('returns null for a too-short buffer', () => {
    expect(parseId3Chapters(new ArrayBuffer(4))).toBeNull();
  });

  it('never throws and returns null for a truncated/corrupt tag (frame size overruns buffer)', () => {
    const header = [0x49, 0x44, 0x33, 0x03, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00]; // declares 128 bytes of frame data
    const bogusFrame = [0x43, 0x48, 0x41, 0x50, 0x7f, 0xff, 0xff, 0xff, 0x00, 0x00]; // 'CHAP' with a huge size
    const buf = new Uint8Array([...header, ...bogusFrame]).buffer;
    expect(() => parseId3Chapters(buf)).not.toThrow();
    expect(parseId3Chapters(buf)).toBeNull();
  });

  it('never throws for a randomly truncated valid tag at every byte length', () => {
    const tag = buildId3Chapters(
      [
        { positionSample: 1, name: 'A' },
        { positionSample: 2, name: 'B' },
      ],
      44100
    );
    for (let len = 0; len <= tag.length; len++) {
      const truncated = tag.slice(0, len).buffer;
      expect(() => parseId3Chapters(truncated)).not.toThrow();
    }
  });

  it('returns null when the tag has no usable CHAP/TXXX marker data', () => {
    // A minimal, valid ID3v2.3 tag with a single unrelated TIT2 (title) frame.
    const utf16le = (s: string): number[] => {
      const out: number[] = [];
      for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        out.push(c & 0xff, (c >> 8) & 0xff);
      }
      return out;
    };
    const payload = [0x00, ...'Some Song'.split('').map((c) => c.charCodeAt(0))]; // Latin-1
    const frame = [0x54, 0x49, 0x54, 0x32, 0x00, 0x00, 0x00, payload.length, 0x00, 0x00, ...payload];
    void utf16le;
    const bodyLen = frame.length;
    const tagSize = [(bodyLen >>> 21) & 0x7f, (bodyLen >>> 14) & 0x7f, (bodyLen >>> 7) & 0x7f, bodyLen & 0x7f];
    const header = [0x49, 0x44, 0x33, 0x03, 0x00, 0x00, ...tagSize];
    const buf = new Uint8Array([...header, ...frame]).buffer;
    expect(parseId3Chapters(buf)).toBeNull();
  });

  it('drops malformed entries from the TXXX JSON silently instead of throwing', () => {
    const json = JSON.stringify([
      { s: 5, n: 'Good' },
      { s: 'not-a-number', n: 'Bad s' },
      { n: 'Missing s' },
      { s: 10 }, // missing n
      { s: 20, n: 'Also Good' },
      null,
      'garbage',
    ]);
    const markers = [
      { positionSample: 5, name: 'placeholder0' },
      { positionSample: 20, name: 'placeholder1' },
    ];
    const tag = buildId3Chapters(markers, 44100);
    // Manually rebuild TXXX with the malformed JSON by re-encoding through buildId3Chapters's
    // own layout is awkward; instead construct a standalone tag containing only TXXX.
    const utf16le = (s: string): number[] => {
      const out: number[] = [];
      for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        out.push(c & 0xff, (c >> 8) & 0xff);
      }
      return out;
    };
    const payload = [
      0x01,
      0xff,
      0xfe,
      ...utf16le('AUDITORIUM_MARKERS'),
      0x00,
      0x00,
      0xff,
      0xfe,
      ...utf16le(json),
    ];
    const frame = [
      0x54,
      0x58,
      0x58,
      0x58,
      (payload.length >>> 24) & 0xff,
      (payload.length >>> 16) & 0xff,
      (payload.length >>> 8) & 0xff,
      payload.length & 0xff,
      0x00,
      0x00,
      ...payload,
    ];
    const bodyLen = frame.length;
    const tagSize = [(bodyLen >>> 21) & 0x7f, (bodyLen >>> 14) & 0x7f, (bodyLen >>> 7) & 0x7f, bodyLen & 0x7f];
    const header = [0x49, 0x44, 0x33, 0x03, 0x00, 0x00, ...tagSize];
    const buf = new Uint8Array([...header, ...frame]).buffer;

    const parsed = parseId3Chapters(buf);
    expect(parsed).not.toBeNull();
    expect(parsed!.map((m) => m.name)).toEqual(['Good', 'Also Good']);
    expect(parsed!.map((m) => m.exactSample)).toEqual([5, 20]);
  });

  it('skips a flagged extended header without corrupting subsequent frame parsing (v2.3)', () => {
    const utf16le = (s: string): number[] => {
      const out: number[] = [];
      for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        out.push(c & 0xff, (c >> 8) & 0xff);
      }
      return out;
    };
    const json = JSON.stringify([{ s: 7, n: 'After Ext Header' }]);
    const payload = [0x01, 0xff, 0xfe, ...utf16le('AUDITORIUM_MARKERS'), 0x00, 0x00, 0xff, 0xfe, ...utf16le(json)];
    const frame = [
      0x54,
      0x58,
      0x58,
      0x58,
      (payload.length >>> 24) & 0xff,
      (payload.length >>> 16) & 0xff,
      (payload.length >>> 8) & 0xff,
      payload.length & 0xff,
      0x00,
      0x00,
      ...payload,
    ];
    // v2.3 extended header: size field (6, excluding itself) + 2 flag bytes + 4 padding-size bytes
    const extHeader = [0x00, 0x00, 0x00, 0x06, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00];
    const bodyLen = extHeader.length + frame.length;
    const tagSize = [(bodyLen >>> 21) & 0x7f, (bodyLen >>> 14) & 0x7f, (bodyLen >>> 7) & 0x7f, bodyLen & 0x7f];
    const header = [0x49, 0x44, 0x33, 0x03, 0x00, 0x40, ...tagSize]; // flags: 0x40 = extended header
    const buf = new Uint8Array([...header, ...extHeader, ...frame]).buffer;

    const parsed = parseId3Chapters(buf);
    expect(parsed).not.toBeNull();
    expect(parsed).toEqual([{ positionMs: 0, name: 'After Ext Header', exactSample: 7 }]);
  });

  it('stops at padding (frame id starting 0x00) instead of misreading padding bytes as a frame', () => {
    const tag = buildId3Chapters([{ positionSample: 3, name: 'X' }], 44100);
    const padded = new Uint8Array(tag.length + 20); // 20 zero padding bytes appended to the frame data
    padded.set(tag, 0);
    const view = new DataView(padded.buffer);
    const newBodyLen = tag.length - 10 + 20;
    view.setUint8(6, (newBodyLen >>> 21) & 0x7f);
    view.setUint8(7, (newBodyLen >>> 14) & 0x7f);
    view.setUint8(8, (newBodyLen >>> 7) & 0x7f);
    view.setUint8(9, newBodyLen & 0x7f);

    const parsed = parseId3Chapters(padded.buffer);
    expect(parsed).not.toBeNull();
    expect(parsed).toHaveLength(1);
    expect(parsed![0].name).toBe('X');
  });
});
