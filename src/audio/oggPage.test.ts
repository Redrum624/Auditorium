import {
  HEADER_TYPE,
  crc32,
  segmentsForPacket,
  buildOpusHead,
  buildOpusTags,
  buildPage,
  paginate,
  muxOpusStream,
  readOpusTags,
  type StreamPacket,
  type EncodedOpusPacket,
} from './oggPage';
import { buildVorbisCommentPayload } from './chapterTags';

// ---------------------------------------------------------------------------
// Independent reference CRC, computed bit-by-bit straight from the polynomial
// (no lookup table). Ogg's CRC-32: poly 0x04C11DB7, non-reflected (MSB-first),
// init 0, no final XOR. Cross-checking the module's table-driven crc32 against
// this proves the 256-entry table is correct.
// ---------------------------------------------------------------------------
function crc32Ref(data: Uint8Array): number {
  let crc = 0;
  for (const byte of data) {
    crc = (crc ^ (byte << 24)) >>> 0;
    for (let i = 0; i < 8; i++) {
      crc = crc & 0x80000000 ? ((crc << 1) ^ 0x04c11db7) >>> 0 : (crc << 1) >>> 0;
    }
  }
  return crc >>> 0;
}

const ascii = (s: string): Uint8Array => new Uint8Array([...s].map((c) => c.charCodeAt(0)));
const readAscii = (b: Uint8Array, off: number, len: number): string =>
  String.fromCharCode(...b.subarray(off, off + len));

/** Split a concatenated Ogg bitstream into parsed pages. */
interface ParsedPage {
  headerType: number;
  granule: bigint;
  serial: number;
  sequence: number;
  crc: number;
  segmentTable: number[];
  payload: Uint8Array;
  bytes: Uint8Array;
}
function parsePages(stream: Uint8Array): ParsedPage[] {
  const pages: ParsedPage[] = [];
  const dv = new DataView(stream.buffer, stream.byteOffset, stream.byteLength);
  let off = 0;
  while (off < stream.length) {
    expect(readAscii(stream, off, 4)).toBe('OggS');
    expect(stream[off + 4]).toBe(0); // version
    const headerType = stream[off + 5];
    const granule = dv.getBigUint64(off + 6, true);
    const serial = dv.getUint32(off + 14, true);
    const sequence = dv.getUint32(off + 18, true);
    const crc = dv.getUint32(off + 22, true);
    const segCount = stream[off + 26];
    const segmentTable: number[] = [];
    let payloadLen = 0;
    for (let i = 0; i < segCount; i++) {
      const v = stream[off + 27 + i];
      segmentTable.push(v);
      payloadLen += v;
    }
    const payloadStart = off + 27 + segCount;
    const payload = stream.subarray(payloadStart, payloadStart + payloadLen);
    const total = 27 + segCount + payloadLen;
    pages.push({
      headerType,
      granule,
      serial,
      sequence,
      crc,
      segmentTable,
      payload,
      bytes: stream.subarray(off, off + total),
    });
    off += total;
  }
  return pages;
}

/** Recompute a page's CRC with the checksum field (bytes 22..25) zeroed. */
function recomputePageCrc(page: Uint8Array): number {
  const copy = page.slice();
  copy[22] = copy[23] = copy[24] = copy[25] = 0;
  return crc32(copy);
}

describe('crc32 (Ogg CRC-32, non-reflected poly 0x04C11DB7)', () => {
  it('is 0 for empty input', () => {
    expect(crc32(new Uint8Array(0))).toBe(0);
  });

  it('matches an independent bit-serial reference for many inputs', () => {
    const cases: Uint8Array[] = [
      new Uint8Array(0),
      new Uint8Array([0]),
      new Uint8Array([0xff]),
      ascii('OggS'),
      ascii('123456789'),
      ascii('The quick brown fox'),
      new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07]),
    ];
    // Plus some pseudo-random buffers (deterministic LCG).
    let seed = 0x12345678;
    for (let n = 0; n < 20; n++) {
      const len = 1 + (n * 7) % 300;
      const buf = new Uint8Array(len);
      for (let i = 0; i < len; i++) {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        buf[i] = (seed >> 8) & 0xff;
      }
      cases.push(buf);
    }
    for (const c of cases) {
      expect(crc32(c) >>> 0).toBe(crc32Ref(c));
    }
  });

  it('returns an unsigned 32-bit value', () => {
    const crc = crc32(ascii('OpusHead'));
    expect(crc).toBeGreaterThanOrEqual(0);
    expect(crc).toBeLessThanOrEqual(0xffffffff);
    expect(Number.isInteger(crc)).toBe(true);
  });
});

describe('segmentsForPacket (lacing values)', () => {
  it('emits a single terminator for the empty packet', () => {
    expect(segmentsForPacket(0)).toEqual([0]);
  });

  it('emits one value below 255 for a short packet', () => {
    expect(segmentsForPacket(1)).toEqual([1]);
    expect(segmentsForPacket(200)).toEqual([200]);
    expect(segmentsForPacket(254)).toEqual([254]);
  });

  it('appends a zero terminator when the length is an exact multiple of 255', () => {
    expect(segmentsForPacket(255)).toEqual([255, 0]);
    expect(segmentsForPacket(510)).toEqual([255, 255, 0]);
  });

  it('splits a long packet into 255-runs plus a remainder terminator', () => {
    expect(segmentsForPacket(300)).toEqual([255, 45]);
    expect(segmentsForPacket(256)).toEqual([255, 1]);
  });

  it('sums exactly to the packet length', () => {
    for (const len of [0, 1, 254, 255, 256, 509, 510, 700, 65025]) {
      const segs = segmentsForPacket(len);
      expect(segs.reduce((a, b) => a + b, 0)).toBe(len);
      // Every value 0..255, and only the last may be < 255 (it always is).
      expect(segs[segs.length - 1]).toBeLessThan(255);
      for (let i = 0; i < segs.length - 1; i++) expect(segs[i]).toBe(255);
    }
  });
});

describe('buildOpusHead', () => {
  it('lays out the 19-byte OpusHead per RFC 7845', () => {
    const head = buildOpusHead({ channelCount: 2, preSkip: 312, inputSampleRate: 44100 });
    expect(head.length).toBe(19);
    const dv = new DataView(head.buffer, head.byteOffset, head.byteLength);
    expect(readAscii(head, 0, 8)).toBe('OpusHead');
    expect(head[8]).toBe(1); // version
    expect(head[9]).toBe(2); // channel count
    expect(dv.getUint16(10, true)).toBe(312); // pre-skip
    expect(dv.getUint32(12, true)).toBe(44100); // ORIGINAL input rate
    expect(dv.getInt16(16, true)).toBe(0); // output gain
    expect(head[18]).toBe(0); // mapping family 0
  });

  it('records the original sample rate, not 48000', () => {
    const head = buildOpusHead({ channelCount: 1, preSkip: 356, inputSampleRate: 22050 });
    const dv = new DataView(head.buffer, head.byteOffset, head.byteLength);
    expect(head[9]).toBe(1);
    expect(dv.getUint16(10, true)).toBe(356);
    expect(dv.getUint32(12, true)).toBe(22050);
  });
});

describe('buildOpusTags', () => {
  it('lays out magic, vendor string, and zero user comments when comments is omitted', () => {
    const tags = buildOpusTags('audition_app');
    const dv = new DataView(tags.buffer, tags.byteOffset, tags.byteLength);
    expect(readAscii(tags, 0, 8)).toBe('OpusTags');
    const vendorLen = dv.getUint32(8, true);
    expect(vendorLen).toBe('audition_app'.length);
    expect(readAscii(tags, 12, vendorLen)).toBe('audition_app');
    expect(dv.getUint32(12 + vendorLen, true)).toBe(0); // user comment count
    expect(tags.length).toBe(16 + vendorLen);
  });

  it('encodes a multi-byte UTF-8 vendor string by byte length', () => {
    const tags = buildOpusTags('café'); // é is 2 UTF-8 bytes → 5 bytes total
    const dv = new DataView(tags.buffer, tags.byteOffset, tags.byteLength);
    expect(dv.getUint32(8, true)).toBe(5);
  });

  // -- Task K5: user comments --------------------------------------------

  it('is byte-identical to v1.2.1 (zero user comments) when comments is omitted, an empty array, or undefined explicitly', () => {
    const bare = buildOpusTags('audition_app');
    const explicitUndefined = buildOpusTags('audition_app', undefined);
    const emptyArray = buildOpusTags('audition_app', []);
    expect(explicitUndefined).toEqual(bare);
    expect(emptyArray).toEqual(bare);
  });

  it('delegates to buildVorbisCommentPayload for the vendor+comment-list layout after the magic', () => {
    const comments = ['CHAPTER001=00:00:00.000', 'CHAPTER001NAME=Intro', 'AUDITORIUM_MARKERS=[{"s":0,"n":"Intro"}]'];
    const tags = buildOpusTags('audition_app', comments);
    const expectedPayload = buildVorbisCommentPayload('audition_app', comments);
    expect(readAscii(tags, 0, 8)).toBe('OpusTags');
    expect(tags.subarray(8)).toEqual(expectedPayload);
  });

  it('lays out a non-empty comment count and per-comment length-prefixed UTF-8 bytes', () => {
    const tags = buildOpusTags('x', ['A=1', 'B=22']);
    const dv = new DataView(tags.buffer, tags.byteOffset, tags.byteLength);
    const vendorLen = dv.getUint32(8, true); // 1
    let off = 12 + vendorLen;
    expect(dv.getUint32(off, true)).toBe(2); // comment count
    off += 4;
    expect(dv.getUint32(off, true)).toBe(3); // 'A=1'.length
    off += 4;
    expect(readAscii(tags, off, 3)).toBe('A=1');
    off += 3;
    expect(dv.getUint32(off, true)).toBe(4); // 'B=22'.length
    off += 4;
    expect(readAscii(tags, off, 4)).toBe('B=22');
  });
});

describe('buildPage', () => {
  it('writes a well-formed page header with a correct CRC', () => {
    const payload = new Uint8Array([1, 2, 3, 4, 5]);
    const page = buildPage({
      headerType: HEADER_TYPE.BOS,
      granule: 0n,
      serial: 0xdeadbeef,
      sequence: 7,
      segmentTable: segmentsForPacket(payload.length),
      payload,
    });
    const dv = new DataView(page.buffer, page.byteOffset, page.byteLength);
    expect(readAscii(page, 0, 4)).toBe('OggS');
    expect(page[4]).toBe(0); // version
    expect(page[5]).toBe(HEADER_TYPE.BOS);
    expect(dv.getBigUint64(6, true)).toBe(0n);
    expect(dv.getUint32(14, true)).toBe(0xdeadbeef);
    expect(dv.getUint32(18, true)).toBe(7);
    expect(page[26]).toBe(1); // one segment ([5])
    expect(page[27]).toBe(5);
    expect(Array.from(page.subarray(28))).toEqual([1, 2, 3, 4, 5]);
    // CRC field is the LE value at offset 22 and matches a fresh recompute.
    expect(dv.getUint32(22, true)).toBe(recomputePageCrc(page));
  });

  it('writes a 64-bit granule larger than 2^32 in little-endian', () => {
    const granule = 5_000_000_000n; // > 2^32
    const page = buildPage({
      headerType: 0,
      granule,
      serial: 1,
      sequence: 0,
      segmentTable: [0],
      payload: new Uint8Array(0),
    });
    const dv = new DataView(page.buffer, page.byteOffset, page.byteLength);
    expect(dv.getBigUint64(6, true)).toBe(granule);
  });

  it('writes granule -1 as 0xFFFFFFFFFFFFFFFF', () => {
    const page = buildPage({
      headerType: 0,
      granule: -1n,
      serial: 1,
      sequence: 0,
      segmentTable: [0],
      payload: new Uint8Array(0),
    });
    const dv = new DataView(page.buffer, page.byteOffset, page.byteLength);
    expect(dv.getBigUint64(6, true)).toBe(0xffffffffffffffffn);
  });
});

describe('paginate', () => {
  const pkt = (len: number, granule: bigint, fill = 0xaa): StreamPacket => ({
    data: new Uint8Array(len).fill(fill),
    granule,
  });

  it('packs several small packets onto one page and marks EOS on the last', () => {
    const pages = parsePages(
      concat(
        paginate([pkt(10, 10n), pkt(20, 30n), pkt(5, 40n)], {
          serial: 42,
          firstSequence: 2,
          lastPageEos: true,
        })
      )
    );
    expect(pages).toHaveLength(1);
    expect(pages[0].sequence).toBe(2);
    expect(pages[0].serial).toBe(42);
    expect(pages[0].headerType & HEADER_TYPE.EOS).toBe(HEADER_TYPE.EOS);
    // Page granule is the LAST completed packet's granule.
    expect(pages[0].granule).toBe(40n);
    // Lacing: [10][20][5], each < 255 so each is its own terminator.
    expect(pages[0].segmentTable).toEqual([10, 20, 5]);
  });

  it('starts a fresh page when the byte budget is exceeded', () => {
    const pages = parsePages(
      concat(
        paginate([pkt(100, 10n), pkt(100, 20n), pkt(100, 30n)], {
          serial: 1,
          firstSequence: 2,
          lastPageEos: true,
          maxPageBytes: 150,
        })
      )
    );
    // First packet (100B) fits; adding it reaches 100 < 150, next packet pushes
    // to 200 >= 150 → flush after the 2nd packet completes, 3rd on a new page.
    expect(pages.length).toBeGreaterThanOrEqual(2);
    expect(pages[pages.length - 1].headerType & HEADER_TYPE.EOS).toBe(HEADER_TYPE.EOS);
    // Only the final page carries EOS.
    for (let i = 0; i < pages.length - 1; i++) {
      expect(pages[i].headerType & HEADER_TYPE.EOS).toBe(0);
    }
    // Sequence numbers are contiguous from firstSequence.
    pages.forEach((p, i) => expect(p.sequence).toBe(2 + i));
  });

  it('spans a single oversized packet across pages with the continued flag', () => {
    // 255*255 = 65025 bytes → 255 full 255-segments + a 0 terminator = 256
    // segments, one more than a page holds. The packet must split: page 1 takes
    // 255 segments and completes NO packet (granule -1); page 2 carries the lone
    // terminator with the 'continued' flag and completes the packet.
    const pages = parsePages(
      concat(
        paginate([pkt(65025, 65025n)], {
          serial: 9,
          firstSequence: 2,
          lastPageEos: true,
        })
      )
    );
    expect(pages).toHaveLength(2);

    expect(pages[0].headerType & HEADER_TYPE.CONTINUED).toBe(0);
    expect(pages[0].segmentTable).toHaveLength(255);
    expect(pages[0].segmentTable.every((v) => v === 255)).toBe(true);
    expect(pages[0].granule).toBe(0xffffffffffffffffn); // no packet completes
    expect(pages[0].headerType & HEADER_TYPE.EOS).toBe(0);

    expect(pages[1].headerType & HEADER_TYPE.CONTINUED).toBe(HEADER_TYPE.CONTINUED);
    expect(pages[1].segmentTable).toEqual([0]); // terminator only
    expect(pages[1].granule).toBe(65025n); // packet completes here
    expect(pages[1].headerType & HEADER_TYPE.EOS).toBe(HEADER_TYPE.EOS);

    // The reassembled payload equals the original packet bytes.
    expect(pages[0].payload.length + pages[1].payload.length).toBe(65025);
  });

  it('gives every page a valid CRC', () => {
    const pages = paginate([pkt(300, 10n), pkt(65025, 20n)], {
      serial: 3,
      firstSequence: 2,
      lastPageEos: true,
    });
    for (const page of pages) {
      const dv = new DataView(page.buffer, page.byteOffset, page.byteLength);
      expect(dv.getUint32(22, true)).toBe(recomputePageCrc(page));
    }
  });
});

describe('muxOpusStream', () => {
  const opkt = (len: number, sampleCount: number): EncodedOpusPacket => ({
    data: new Uint8Array(len).fill(0x55),
    sampleCount,
  });

  it('emits OpusHead (BOS) alone on page 0 and OpusTags on page 1', () => {
    const stream = muxOpusStream({
      serial: 1,
      channelCount: 2,
      preSkip: 312,
      inputSampleRate: 44100,
      packets: [opkt(100, 960), opkt(100, 960)],
      vendor: 'audition_app',
    });
    const pages = parsePages(stream);

    // Page 0: OpusHead, BOS, granule 0.
    expect(pages[0].headerType & HEADER_TYPE.BOS).toBe(HEADER_TYPE.BOS);
    expect(pages[0].granule).toBe(0n);
    expect(pages[0].sequence).toBe(0);
    expect(readAscii(pages[0].payload, 0, 8)).toBe('OpusHead');

    // Page 1: OpusTags, granule 0, no BOS.
    expect(pages[1].headerType & HEADER_TYPE.BOS).toBe(0);
    expect(pages[1].granule).toBe(0n);
    expect(pages[1].sequence).toBe(1);
    expect(readAscii(pages[1].payload, 0, 8)).toBe('OpusTags');
  });

  it('accumulates 48k granules and trims the final EOS page to preSkip + totalSamples', () => {
    const preSkip = 312;
    // Three 20ms packets: encoder padded the tail so decoded samples (2880) is
    // more than the true content (2500). The final granule must be trimmed.
    const stream = muxOpusStream({
      serial: 7,
      channelCount: 1,
      preSkip,
      inputSampleRate: 48000,
      packets: [opkt(50, 960), opkt(50, 960), opkt(50, 960)],
      totalSamples: 2500,
      vendor: 'x',
    });
    const pages = parsePages(stream);
    const audioPages = pages.filter((p) => p.sequence >= 2);
    const last = audioPages[audioPages.length - 1];
    expect(last.headerType & HEADER_TYPE.EOS).toBe(HEADER_TYPE.EOS);
    // Trimmed: preSkip + true total, NOT preSkip + 2880.
    expect(last.granule).toBe(BigInt(preSkip + 2500));
  });

  it('gives INTERMEDIATE audio pages K*960 granules (no +preSkip) and stays non-decreasing', () => {
    const preSkip = 312;
    const totalSamples = 5000;
    // Six 20 ms packets, 200 bytes each; maxPageBytes=300 forces two packets per
    // page → three audio pages (seq 2,3,4). Per RFC 7845 §4 the granule already
    // includes the pre-skip samples, so an intermediate page's granule must be
    // exactly K*960 — NOT preSkip + K*960.
    const stream = muxOpusStream({
      serial: 11,
      channelCount: 1,
      preSkip,
      inputSampleRate: 48000,
      packets: Array.from({ length: 6 }, () => opkt(200, 960)),
      totalSamples,
      maxPageBytes: 300,
    });
    const pages = parsePages(stream);
    const audioPages = pages.filter((p) => p.sequence >= 2);
    expect(audioPages.length).toBeGreaterThanOrEqual(3);

    // First audio page completes packets 1–2 → cumulative 2*960, no +preSkip.
    expect(audioPages[0].granule).toBe(BigInt(2 * 960));
    // Second (intermediate) audio page completes packets 3–4 → 4*960.
    expect(audioPages[1].granule).toBe(BigInt(4 * 960));
    // Final EOS page is trimmed to preSkip + true total.
    const last = audioPages[audioPages.length - 1];
    expect(last.headerType & HEADER_TYPE.EOS).toBe(HEADER_TYPE.EOS);
    expect(last.granule).toBe(BigInt(preSkip + totalSamples));

    // Granules are non-decreasing across ALL pages (headers at 0 included).
    for (let i = 1; i < pages.length; i++) {
      expect(pages[i].granule >= pages[i - 1].granule).toBe(true);
    }
  });

  it('produces a valid CRC on every page and a contiguous sequence', () => {
    const stream = muxOpusStream({
      serial: 5,
      channelCount: 2,
      preSkip: 312,
      inputSampleRate: 48000,
      packets: Array.from({ length: 40 }, () => opkt(200, 960)),
      totalSamples: 40 * 960,
    });
    const pages = parsePages(stream);
    pages.forEach((p, i) => {
      expect(p.sequence).toBe(i);
      const dv = new DataView(p.bytes.buffer, p.bytes.byteOffset, p.bytes.byteLength);
      expect(dv.getUint32(22, true)).toBe(recomputePageCrc(p.bytes));
      expect(p.serial).toBe(5);
    });
    // Exactly one BOS (first) and one EOS (last).
    expect(pages.filter((p) => p.headerType & HEADER_TYPE.BOS)).toHaveLength(1);
    expect(pages.filter((p) => p.headerType & HEADER_TYPE.EOS)).toHaveLength(1);
    expect(pages[0].headerType & HEADER_TYPE.BOS).toBe(HEADER_TYPE.BOS);
    expect(pages[pages.length - 1].headerType & HEADER_TYPE.EOS).toBe(HEADER_TYPE.EOS);
  });

  // -- Task K5: OpusTags user comments (marker persistence) ----------------

  it('is byte-identical to v1.2.1 (marker-less encode) when comments is omitted, an empty array, or undefined explicitly', () => {
    const baseOpts = {
      serial: 1,
      channelCount: 2,
      preSkip: 312,
      inputSampleRate: 44100,
      packets: [opkt(100, 960), opkt(100, 960)],
      vendor: 'audition_app',
    };
    const bare = muxOpusStream(baseOpts);
    const explicitUndefined = muxOpusStream({ ...baseOpts, comments: undefined });
    const emptyArray = muxOpusStream({ ...baseOpts, comments: [] });
    expect(explicitUndefined).toEqual(bare);
    expect(emptyArray).toEqual(bare);
  });

  it('writes the given comments into the OpusTags page payload', () => {
    const comments = ['CHAPTER001=00:00:00.000', 'CHAPTER001NAME=Intro', 'AUDITORIUM_MARKERS=[{"s":0,"n":"Intro"}]'];
    const stream = muxOpusStream({
      serial: 1,
      channelCount: 1,
      preSkip: 312,
      inputSampleRate: 48000,
      packets: [opkt(50, 960)],
      vendor: 'audition_app',
      comments,
    });
    const pages = parsePages(stream);
    // Reassemble the OpusTags packet (page 1 here — small comments fit on one page).
    const tagsPage = pages[1];
    expect(readAscii(tagsPage.payload, 0, 8)).toBe('OpusTags');
    const dv = new DataView(tagsPage.payload.buffer, tagsPage.payload.byteOffset, tagsPage.payload.byteLength);
    const vendorLen = dv.getUint32(8, true);
    const countOff = 12 + vendorLen;
    expect(dv.getUint32(countOff, true)).toBe(comments.length);
  });

  it('spans a huge OpusTags packet across pages with the CONTINUED flag, and audio sequencing accounts for the extra page(s)', () => {
    // ~70 KB of comments — well past the 65025-byte single-page ceiling — forces
    // the tags packet to split exactly like the oversized-packet paginate test.
    const hugeComments = Array.from({ length: 700 }, (_, i) => `PADDING${i}=` + 'x'.repeat(90));
    const stream = muxOpusStream({
      serial: 3,
      channelCount: 1,
      preSkip: 312,
      inputSampleRate: 48000,
      packets: [opkt(50, 960), opkt(50, 960)],
      totalSamples: 1920,
      vendor: 'audition_app',
      comments: hugeComments,
    });
    const pages = parsePages(stream);

    // Page 0: OpusHead (BOS), sequence 0 — unaffected by the huge tags packet.
    expect(pages[0].sequence).toBe(0);
    expect(pages[0].headerType & HEADER_TYPE.BOS).toBe(HEADER_TYPE.BOS);

    // The tags packet spans at least 2 pages (sequences 1, 2, ...): the first
    // is NOT continued (it starts the packet) and completes no packet
    // (granule -1); a later one carries the CONTINUED flag.
    const continuedPages = pages.filter((p) => p.headerType & HEADER_TYPE.CONTINUED);
    expect(continuedPages.length).toBeGreaterThanOrEqual(1);

    // Reassemble the full OpusTags packet by concatenating payloads from page 1
    // up through (and including) the last CONTINUED page, then decode it.
    const tagsPacketPages = [pages[1]];
    let i = 2;
    while (i < pages.length && pages[i].headerType & HEADER_TYPE.CONTINUED) {
      tagsPacketPages.push(pages[i]);
      i++;
    }
    const tagsBytes = concat(tagsPacketPages.map((p) => p.payload));
    expect(readAscii(tagsBytes, 0, 8)).toBe('OpusTags');
    const dv = new DataView(tagsBytes.buffer, tagsBytes.byteOffset, tagsBytes.byteLength);
    const vendorLen = dv.getUint32(8, true);
    expect(dv.getUint32(12 + vendorLen, true)).toBe(hugeComments.length);

    // Every non-BOS, non-continued-tail page before the audio pages has
    // granule -1 (0xFF...F) — no packet (the tags packet) completes until the
    // final tags page.
    expect(pages[1].granule).toBe(0xffffffffffffffffn);

    // Audio pages start right after the tags packet finishes, with a
    // contiguous, correct sequence number (proves sequencing was NOT
    // hardcoded to assume a single-page OpusTags).
    const audioPageStart = i;
    expect(pages[audioPageStart].sequence).toBe(audioPageStart);
    const audioPages = pages.slice(audioPageStart);
    expect(audioPages[audioPages.length - 1].headerType & HEADER_TYPE.EOS).toBe(HEADER_TYPE.EOS);
    expect(audioPages[audioPages.length - 1].granule).toBe(BigInt(312 + 1920));

    // Sequence numbers are contiguous across the whole stream.
    pages.forEach((p, idx) => expect(p.sequence).toBe(idx));
  });

  it('EOS lands on the (possibly multi-page) OpusTags packet when there is no audio, even with a huge comment list', () => {
    const hugeComments = Array.from({ length: 700 }, (_, i) => `PADDING${i}=` + 'x'.repeat(90));
    const stream = muxOpusStream({
      serial: 4,
      channelCount: 1,
      preSkip: 312,
      inputSampleRate: 48000,
      packets: [],
      vendor: 'audition_app',
      comments: hugeComments,
    });
    const pages = parsePages(stream);
    expect(pages[pages.length - 1].headerType & HEADER_TYPE.EOS).toBe(HEADER_TYPE.EOS);
    // Only the last page is EOS.
    for (let idx = 0; idx < pages.length - 1; idx++) {
      expect(pages[idx].headerType & HEADER_TYPE.EOS).toBe(0);
    }
  });
});

/** `Uint8Array.prototype.buffer` types as `ArrayBufferLike` (ArrayBuffer |
 * SharedArrayBuffer) since TS 5.7; every Uint8Array here is always backed by a
 * plain ArrayBuffer, so this narrows the same way `dsp.worker.ts` /
 * `effectRunner.ts` do at their transfer boundaries. */
function toBuf(u: Uint8Array): ArrayBuffer {
  return u.buffer as ArrayBuffer;
}

describe('readOpusTags', () => {
  const opkt = (len: number, sampleCount: number): EncodedOpusPacket => ({
    data: new Uint8Array(len).fill(0x55),
    sampleCount,
  });

  it('round-trips vendor + comments through a full muxOpusStream build', () => {
    const comments = ['CHAPTER001=00:00:00.000', 'CHAPTER001NAME=Intro', 'AUDITORIUM_MARKERS=[{"s":0,"n":"Intro"}]'];
    const stream = muxOpusStream({
      serial: 1,
      channelCount: 1,
      preSkip: 312,
      inputSampleRate: 48000,
      packets: [opkt(50, 960)],
      vendor: 'audition_app',
      comments,
    });
    const result = readOpusTags(toBuf(stream));
    expect(result).toEqual({ vendor: 'audition_app', comments });
  });

  it('round-trips a huge, multi-page OpusTags packet', () => {
    const hugeComments = Array.from({ length: 700 }, (_, i) => `PADDING${i}=` + 'x'.repeat(90));
    const stream = muxOpusStream({
      serial: 3,
      channelCount: 1,
      preSkip: 312,
      inputSampleRate: 48000,
      packets: [opkt(50, 960), opkt(50, 960)],
      totalSamples: 1920,
      vendor: 'audition_app',
      comments: hugeComments,
    });
    const result = readOpusTags(toBuf(stream));
    expect(result?.vendor).toBe('audition_app');
    expect(result?.comments).toEqual(hugeComments);
  });

  it('returns vendor + zero comments for a marker-less (v1.2.1-shaped) stream', () => {
    const stream = muxOpusStream({
      serial: 1,
      channelCount: 2,
      preSkip: 312,
      inputSampleRate: 44100,
      packets: [opkt(100, 960)],
      vendor: 'audition_app',
    });
    const result = readOpusTags(toBuf(stream));
    expect(result).toEqual({ vendor: 'audition_app', comments: [] });
  });

  it('returns null when the buffer has no OggS page at all', () => {
    expect(readOpusTags(toBuf(new Uint8Array([1, 2, 3, 4])))).toBeNull();
  });

  it('returns null when only one packet (OpusHead) is present — no second packet to read', () => {
    const head = buildOpusHead({ channelCount: 1, preSkip: 312, inputSampleRate: 48000 });
    const page = buildPage({
      headerType: HEADER_TYPE.BOS | HEADER_TYPE.EOS,
      granule: 0n,
      serial: 1,
      sequence: 0,
      segmentTable: segmentsForPacket(head.length),
      payload: head,
    });
    expect(readOpusTags(toBuf(page))).toBeNull();
  });

  it('returns null when the second packet is not OpusTags-magic', () => {
    const head = buildOpusHead({ channelCount: 1, preSkip: 312, inputSampleRate: 48000 });
    const headPage = buildPage({
      headerType: HEADER_TYPE.BOS,
      granule: 0n,
      serial: 1,
      sequence: 0,
      segmentTable: segmentsForPacket(head.length),
      payload: head,
    });
    const bogus = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const bogusPage = buildPage({
      headerType: HEADER_TYPE.EOS,
      granule: 0n,
      serial: 1,
      sequence: 1,
      segmentTable: segmentsForPacket(bogus.length),
      payload: bogus,
    });
    expect(readOpusTags(toBuf(concat([headPage, bogusPage])))).toBeNull();
  });

  it('never throws and returns null for a randomly truncated valid stream at every byte length', () => {
    const stream = muxOpusStream({
      serial: 1,
      channelCount: 1,
      preSkip: 312,
      inputSampleRate: 48000,
      packets: [opkt(50, 960)],
      vendor: 'audition_app',
      comments: ['A=1'],
    });
    for (let len = 0; len <= stream.length; len += 7) {
      const truncated = stream.slice(0, len);
      expect(() => readOpusTags(toBuf(truncated))).not.toThrow();
    }
  });

  it('returns null for a page whose declared segment table runs past the buffer', () => {
    const bogus = new Uint8Array(30);
    writeOggHeader(bogus, 0, { segCount: 5 }); // claims 5 segments but buffer ends at 30 (27 + 5 needed = 32)
    expect(readOpusTags(toBuf(bogus))).toBeNull();
  });
});

/** Minimal raw OggS page header writer for corrupt-input tests (no CRC, no
 * payload) — just enough structure for `readOpusTags`'s bounds checks. */
function writeOggHeader(out: Uint8Array, offset: number, opts: { segCount: number }): void {
  out.set([0x4f, 0x67, 0x67, 0x53], offset); // 'OggS'
  out[offset + 4] = 0; // version
  out[offset + 5] = 0; // header type
  out[offset + 26] = opts.segCount;
}

/** Concatenate an array of pages (helper mirrors the muxer's own concat). */
function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}
