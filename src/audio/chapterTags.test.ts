import {
  buildChapterComments,
  parseChapterComments,
  buildVorbisCommentPayload,
  parseVorbisCommentPayload,
} from './chapterTags';

// -----------------------------------------------------------------------------
// buildVorbisCommentPayload — byte-level layout, hand-decoded independently of
// the module under test (mirrors id3Chapters.test.ts's own-frame-walker style).
// -----------------------------------------------------------------------------

function readU32LE(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24);
}

/** Independent decoder for the vendor_length/vendor/comment_count/comments
 * layout, built from scratch (not delegating to parseVorbisCommentPayload). */
function decodePayload(bytes: Uint8Array): { vendor: string; comments: string[] } {
  const decoder = new TextDecoder('utf-8');
  let offset = 0;
  const vendorLen = readU32LE(bytes, offset);
  offset += 4;
  const vendor = decoder.decode(bytes.slice(offset, offset + vendorLen));
  offset += vendorLen;
  const count = readU32LE(bytes, offset);
  offset += 4;
  const comments: string[] = [];
  for (let i = 0; i < count; i++) {
    const len = readU32LE(bytes, offset);
    offset += 4;
    comments.push(decoder.decode(bytes.slice(offset, offset + len)));
    offset += len;
  }
  return { vendor, comments };
}

describe('buildVorbisCommentPayload — byte-level layout', () => {
  it('writes vendor_length (u32 LE) + vendor UTF-8 + comment_count (u32 LE) + per-comment (length u32 LE + UTF-8)', () => {
    const payload = buildVorbisCommentPayload('audition_app', ['CHAPTER001=00:00:01.000', 'CHAPTER001NAME=Intro']);
    expect(readU32LE(payload, 0)).toBe('audition_app'.length);
    const vendorBytes = payload.slice(4, 4 + 'audition_app'.length);
    expect(new TextDecoder('utf-8').decode(vendorBytes)).toBe('audition_app');
    let offset = 4 + 'audition_app'.length;
    expect(readU32LE(payload, offset)).toBe(2);
    offset += 4;
    const len0 = readU32LE(payload, offset);
    offset += 4;
    expect(new TextDecoder('utf-8').decode(payload.slice(offset, offset + len0))).toBe('CHAPTER001=00:00:01.000');
    offset += len0;
    const len1 = readU32LE(payload, offset);
    offset += 4;
    expect(new TextDecoder('utf-8').decode(payload.slice(offset, offset + len1))).toBe('CHAPTER001NAME=Intro');
    offset += len1;
    expect(payload.length).toBe(offset);
  });

  it('writes zero comments with comment_count 0 and no trailing bytes', () => {
    const payload = buildVorbisCommentPayload('audition_app', []);
    expect(payload.length).toBe(4 + 'audition_app'.length + 4);
    expect(readU32LE(payload, 4 + 'audition_app'.length)).toBe(0);
  });

  it('encodes Unicode comment text as UTF-8 byte length, not UTF-16 code-unit length', () => {
    const name = 'CHAPTER001NAME=Café ☕ 日本語 🎵';
    const payload = buildVorbisCommentPayload('v', [name]);
    const decoded = decodePayload(payload);
    expect(decoded.comments).toEqual([name]);
    // Sanity: the UTF-8 byte length differs from the UTF-16 string length for
    // this string (multi-byte code points present).
    expect(new TextEncoder().encode(name).length).not.toBe(name.length);
  });
});

describe('buildVorbisCommentPayload -> parseVorbisCommentPayload round-trip', () => {
  it('round-trips vendor and an arbitrary comment list exactly', () => {
    const comments = ['CHAPTER001=00:00:00.000', 'CHAPTER001NAME=Start', 'AUDITORIUM_MARKERS=[{"s":0,"n":"Start"}]'];
    const payload = buildVorbisCommentPayload('audition_app', comments);
    const parsed = parseVorbisCommentPayload(payload);
    expect(parsed).toEqual({ vendor: 'audition_app', comments });
  });

  it('round-trips Unicode vendor and comments', () => {
    const comments = ['CHAPTER001NAME=日本語 🎵', 'CHAPTER002NAME=Café ☕'];
    const payload = buildVorbisCommentPayload('vendor-日本', comments);
    const parsed = parseVorbisCommentPayload(payload);
    expect(parsed).toEqual({ vendor: 'vendor-日本', comments });
  });

  it('round-trips a comment value containing "=" characters (only the first "=" splits key/value)', () => {
    const comments = ['AUDITORIUM_MARKERS=[{"s":1,"n":"a=b"}]'];
    const payload = buildVorbisCommentPayload('v', comments);
    expect(parseVorbisCommentPayload(payload)).toEqual({ vendor: 'v', comments });
  });
});

describe('parseVorbisCommentPayload — corrupt/edge-case tolerance', () => {
  it('returns null for an empty/too-short buffer', () => {
    expect(parseVorbisCommentPayload(new Uint8Array(0))).toBeNull();
    expect(parseVorbisCommentPayload(new Uint8Array(4))).toBeNull();
  });

  it('never throws and returns null for a truncated valid payload at every byte length', () => {
    const payload = buildVorbisCommentPayload('audition_app', ['CHAPTER001=00:00:00.000', 'CHAPTER001NAME=X']);
    for (let len = 0; len <= payload.length; len++) {
      const truncated = payload.slice(0, len);
      expect(() => parseVorbisCommentPayload(truncated)).not.toThrow();
    }
    // A truncated payload (missing the last comment's bytes) must yield null.
    expect(parseVorbisCommentPayload(payload.slice(0, payload.length - 1))).toBeNull();
  });

  it('returns null when a declared length overruns the buffer', () => {
    const bytes = new Uint8Array(12);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, 100, true); // vendor_length claims 100 bytes but buffer is far shorter
    expect(parseVorbisCommentPayload(bytes)).toBeNull();
  });

  it('returns null when comment_count claims more entries than the buffer could hold', () => {
    const bytes = new Uint8Array(8);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, 0, true); // vendor_length 0
    view.setUint32(4, 0xffffffff, true); // comment_count absurdly large
    expect(parseVorbisCommentPayload(bytes)).toBeNull();
  });
});

// -----------------------------------------------------------------------------
// buildChapterComments — exact string layout per the cross-task contract.
// -----------------------------------------------------------------------------

describe('buildChapterComments', () => {
  it('writes CHAPTERxxx / CHAPTERxxxNAME pairs (1-based, 3-digit) followed by AUDITORIUM_MARKERS', () => {
    const markers = [
      { positionSample: 0, name: 'Intro' },
      { positionSample: 44100, name: 'Verse' },
    ];
    const comments = buildChapterComments(markers, 44100);
    expect(comments).toEqual([
      'CHAPTER001=00:00:00.000',
      'CHAPTER001NAME=Intro',
      'CHAPTER002=00:00:01.000',
      'CHAPTER002NAME=Verse',
      'AUDITORIUM_MARKERS=[{"s":0,"n":"Intro"},{"s":44100,"n":"Verse"}]',
    ]);
  });

  it('formats a position past one hour as HH:MM:SS.mmm with hours >= 1', () => {
    // 1h 2m 3.456s at 44100 Hz.
    const sampleRate = 44100;
    const seconds = 3600 + 2 * 60 + 3.456;
    const positionSample = Math.round(seconds * sampleRate);
    const comments = buildChapterComments([{ positionSample, name: 'Late' }], sampleRate);
    expect(comments[0]).toBe('CHAPTER001=01:02:03.456');
  });

  it('rounds fractional milliseconds to the nearest millisecond', () => {
    // 1/3 second at 44100 Hz does not land on an exact ms boundary.
    const sampleRate = 44100;
    const positionSample = Math.round(sampleRate / 3); // ~0.33333s -> 333ms after rounding
    const comments = buildChapterComments([{ positionSample, name: 'X' }], sampleRate);
    expect(comments[0]).toBe('CHAPTER001=00:00:00.333');
  });

  it('formats position 0 as 00:00:00.000', () => {
    const comments = buildChapterComments([{ positionSample: 0, name: 'Zero' }], 44100);
    expect(comments[0]).toBe('CHAPTER001=00:00:00.000');
  });

  it('writes only AUDITORIUM_MARKERS=[] when there are no markers', () => {
    expect(buildChapterComments([], 44100)).toEqual(['AUDITORIUM_MARKERS=[]']);
  });

  it('encodes full Unicode names verbatim in both CHAPTERxxxNAME and the JSON', () => {
    const markers = [{ positionSample: 0, name: 'Café ☕ 日本語 🎵' }];
    const comments = buildChapterComments(markers, 44100);
    expect(comments[1]).toBe('CHAPTER001NAME=Café ☕ 日本語 🎵');
    expect(comments[comments.length - 1]).toBe('AUDITORIUM_MARKERS=[{"s":0,"n":"Café ☕ 日本語 🎵"}]');
  });
});

// -----------------------------------------------------------------------------
// parseChapterComments — lenient per the contract, prefers AUDITORIUM_MARKERS.
// -----------------------------------------------------------------------------

describe('parseChapterComments', () => {
  it('round-trips exactly through buildChapterComments (AUDITORIUM_MARKERS preferred)', () => {
    const markers = [
      { positionSample: 10, name: 'Intro' },
      { positionSample: 500, name: 'Outro' },
    ];
    const comments = buildChapterComments(markers, 44100);
    expect(parseChapterComments(comments, 44100)).toEqual(markers);
  });

  it('falls back to CHAPTERxxx/CHAPTERxxxNAME when AUDITORIUM_MARKERS is absent', () => {
    const comments = ['CHAPTER001=00:00:01.000', 'CHAPTER001NAME=One', 'CHAPTER002=00:00:02.000', 'CHAPTER002NAME=Two'];
    const parsed = parseChapterComments(comments, 44100);
    expect(parsed).toEqual([
      { positionSample: 44100, name: 'One' },
      { positionSample: 88200, name: 'Two' },
    ]);
  });

  it('falls back to CHAPTERxxx when AUDITORIUM_MARKERS JSON is malformed', () => {
    const comments = ['AUDITORIUM_MARKERS=not-json', 'CHAPTER001=00:00:00.500', 'CHAPTER001NAME=Fallback'];
    const parsed = parseChapterComments(comments, 44100);
    expect(parsed).toEqual([{ positionSample: 22050, name: 'Fallback' }]);
  });

  it('falls back to CHAPTERxxx when AUDITORIUM_MARKERS array has zero valid entries', () => {
    const comments = [
      'AUDITORIUM_MARKERS=[{"bad":1},"garbage",null]',
      'CHAPTER001=00:00:00.500',
      'CHAPTER001NAME=Fallback',
    ];
    const parsed = parseChapterComments(comments, 44100);
    expect(parsed).toEqual([{ positionSample: 22050, name: 'Fallback' }]);
  });

  it('drops malformed entries from AUDITORIUM_MARKERS silently, keeping the valid ones', () => {
    const comments = [
      'AUDITORIUM_MARKERS=' +
        JSON.stringify([{ s: 5, n: 'Good' }, { s: 'nope', n: 'Bad' }, { n: 'No s' }, { s: 20, n: 'Also Good' }]),
    ];
    const parsed = parseChapterComments(comments, 44100);
    expect(parsed).toEqual([
      { positionSample: 5, name: 'Good' },
      { positionSample: 20, name: 'Also Good' },
    ]);
  });

  it('accepts 2-4 digit chapter numbering and matches xxxNAME by numeric value, not string width', () => {
    const comments = ['CHAPTER01=00:00:01.000', 'CHAPTER001NAME=Short', 'CHAPTER0002=00:00:02.000', 'CHAPTER02NAME=Long'];
    const parsed = parseChapterComments(comments, 44100);
    expect(parsed).toEqual([
      { positionSample: 44100, name: 'Short' },
      { positionSample: 88200, name: 'Long' },
    ]);
  });

  it('accepts 0-based chapter numbering', () => {
    const comments = ['CHAPTER000=00:00:00.000', 'CHAPTER000NAME=First', 'CHAPTER001=00:00:01.000', 'CHAPTER001NAME=Second'];
    const parsed = parseChapterComments(comments, 44100);
    expect(parsed).toEqual([
      { positionSample: 0, name: 'First' },
      { positionSample: 44100, name: 'Second' },
    ]);
  });

  it('matches keys case-insensitively', () => {
    const comments = ['chapter001=00:00:01.000', 'Chapter001Name=Mixed', 'auditorium_markers=not-json'];
    const parsed = parseChapterComments(comments, 44100);
    expect(parsed).toEqual([{ positionSample: 44100, name: 'Mixed' }]);
  });

  it('defaults an unmatched chapter name to "Marker N"', () => {
    const comments = ['CHAPTER001=00:00:00.000'];
    const parsed = parseChapterComments(comments, 44100);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].positionSample).toBe(0);
    expect(parsed[0].name).toMatch(/Marker/);
  });

  it('returns an empty array for a comment list with no chapter data', () => {
    expect(parseChapterComments(['ARTIST=Someone', 'TITLE=Song'], 44100)).toEqual([]);
  });

  it('never throws on garbage comment strings (no "=", empty string, binary-ish text)', () => {
    expect(() => parseChapterComments(['no-equals-sign', '', 'CHAPTER=weird', '='], 44100)).not.toThrow();
  });
});
