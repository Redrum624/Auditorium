import { readFlacVorbisComment } from './flacMeta';
import { buildVorbisCommentPayload } from './chapterTags';

function concat(chunks: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

function metaBlock(type: number, isLast: boolean, payload: Uint8Array): Uint8Array<ArrayBuffer> {
  const header = new Uint8Array(4);
  header[0] = (isLast ? 0x80 : 0x00) | (type & 0x7f);
  header[1] = (payload.length >> 16) & 0xff;
  header[2] = (payload.length >> 8) & 0xff;
  header[3] = payload.length & 0xff;
  return concat([header, payload]);
}

function magic(): Uint8Array {
  return new Uint8Array([0x66, 0x4c, 0x61, 0x43]); // 'fLaC'
}

function fakeStreamInfo(): Uint8Array {
  return new Uint8Array(34); // contents irrelevant to this reader
}

describe('readFlacVorbisComment', () => {
  it('finds a VORBIS_COMMENT block (type 4) that is the only/last metadata block', () => {
    const payload = buildVorbisCommentPayload('audition_app', ['CHAPTER001=00:00:00.000', 'CHAPTER001NAME=Intro']);
    const buf = concat([magic(), metaBlock(0, false, fakeStreamInfo()), metaBlock(4, true, payload)]);
    const result = readFlacVorbisComment(buf.buffer);
    expect(result).toEqual({ vendor: 'audition_app', comments: ['CHAPTER001=00:00:00.000', 'CHAPTER001NAME=Intro'] });
  });

  it('finds a VORBIS_COMMENT block that is NOT the last block (more metadata follows)', () => {
    const payload = buildVorbisCommentPayload('audition_app', ['CHAPTER001=00:00:00.000']);
    const padding = new Uint8Array(10);
    const buf = concat([
      magic(),
      metaBlock(0, false, fakeStreamInfo()),
      metaBlock(4, false, payload), // VORBIS_COMMENT, not last
      metaBlock(1, true, padding), // trailing PADDING block, last
    ]);
    const result = readFlacVorbisComment(buf.buffer);
    expect(result).toEqual({ vendor: 'audition_app', comments: ['CHAPTER001=00:00:00.000'] });
  });

  it('returns null when the STREAMINFO block is the only (last) block — no VORBIS_COMMENT present', () => {
    const buf = concat([magic(), metaBlock(0, true, fakeStreamInfo())]);
    expect(readFlacVorbisComment(buf.buffer)).toBeNull();
  });

  it('returns null when the buffer has no fLaC magic', () => {
    const buf = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04, 0x05]);
    expect(readFlacVorbisComment(buf.buffer)).toBeNull();
  });

  it('returns null for a too-short buffer', () => {
    expect(readFlacVorbisComment(new ArrayBuffer(2))).toBeNull();
  });

  it('never throws and returns null when a block length overruns the buffer (truncated/corrupt)', () => {
    const bogus = new Uint8Array(4);
    bogus[0] = 0x00; // type 0, not last
    bogus[1] = 0xff;
    bogus[2] = 0xff;
    bogus[3] = 0xff; // huge declared length
    const buf = concat([magic(), bogus]);
    expect(() => readFlacVorbisComment(buf.buffer)).not.toThrow();
    expect(readFlacVorbisComment(buf.buffer)).toBeNull();
  });

  it('never throws for a randomly truncated valid file at every byte length', () => {
    const payload = buildVorbisCommentPayload('audition_app', ['CHAPTER001=00:00:00.000', 'CHAPTER001NAME=X']);
    const buf = concat([magic(), metaBlock(0, false, fakeStreamInfo()), metaBlock(4, true, payload)]);
    for (let len = 0; len <= buf.length; len++) {
      const truncated: Uint8Array<ArrayBuffer> = buf.slice(0, len);
      expect(() => readFlacVorbisComment(truncated.buffer)).not.toThrow();
    }
  });

  it('stops walking (returns null) rather than looping forever when no block is ever flagged last', () => {
    // Every block claims isLast=false and a plausible small length; the walk
    // must still terminate once it runs out of buffer instead of looping.
    const buf = concat([magic(), metaBlock(1, false, new Uint8Array(4)), metaBlock(1, false, new Uint8Array(4))]);
    expect(readFlacVorbisComment(buf.buffer)).toBeNull();
  });

  it('returns null when the VORBIS_COMMENT block payload itself is corrupt', () => {
    const corrupt = new Uint8Array([0xff, 0xff, 0xff, 0xff]); // bogus vendor_length
    const buf = concat([magic(), metaBlock(0, false, fakeStreamInfo()), metaBlock(4, true, corrupt)]);
    expect(readFlacVorbisComment(buf.buffer)).toBeNull();
  });
});
