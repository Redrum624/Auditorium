/**
 * Pure-TypeScript Ogg page muxer + Opus header builders.
 *
 * No WebCodecs, no DOM — everything here is byte manipulation so it can be
 * unit-tested under jsdom without a real Opus encoder. `oggOpusEncoder.ts`
 * feeds this module the encoded Opus packets it collects from WebCodecs.
 *
 * References: RFC 3533 (Ogg framing), RFC 7845 (Ogg Opus). The Ogg page CRC is
 * the unusual CRC-32 with polynomial 0x04C11DB7, NON-reflected (MSB-first),
 * init 0, no final XOR, and the 4-byte checksum field zeroed while computing.
 */

/** Ogg page header-type bit flags (byte 5 of every page header). */
export const HEADER_TYPE = {
  /** This page continues a packet begun on the previous page. */
  CONTINUED: 0x01,
  /** Beginning of stream — set only on the very first page. */
  BOS: 0x02,
  /** End of stream — set only on the very last page. */
  EOS: 0x04,
} as const;

const OGG_CRC_POLY = 0x04c11db7;

/** 256-entry lookup table for the Ogg CRC (built once at module load). */
const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let r = n << 24;
    for (let k = 0; k < 8; k++) {
      r = r & 0x80000000 ? (r << 1) ^ OGG_CRC_POLY : r << 1;
    }
    table[n] = r >>> 0;
  }
  return table;
})();

/**
 * Ogg CRC-32 over `data`: poly 0x04C11DB7, non-reflected, init 0, no final XOR.
 * Returns an unsigned 32-bit integer.
 */
export function crc32(data: Uint8Array): number {
  let crc = 0;
  for (let i = 0; i < data.length; i++) {
    crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ data[i]) & 0xff]) >>> 0;
  }
  return crc >>> 0;
}

/**
 * Ogg lacing values for a single packet of `length` bytes: a run of 255s
 * followed by one terminating value < 255. A length that is an exact multiple
 * of 255 (including 0) gets a trailing 0 so the packet is always terminated by
 * a value below 255.
 */
export function segmentsForPacket(length: number): number[] {
  const segments: number[] = [];
  let remaining = length;
  while (remaining >= 255) {
    segments.push(255);
    remaining -= 255;
  }
  segments.push(remaining); // the terminator (0..254)
  return segments;
}

/** Build the 19-byte OpusHead identification header (RFC 7845 §5.1). */
export function buildOpusHead(opts: {
  channelCount: number;
  preSkip: number;
  /** ORIGINAL sample rate of the source audio (informational; not 48000). */
  inputSampleRate: number;
  outputGain?: number;
}): Uint8Array {
  const head = new Uint8Array(19);
  const dv = new DataView(head.buffer);
  writeAscii(head, 0, 'OpusHead');
  head[8] = 1; // version
  head[9] = opts.channelCount;
  dv.setUint16(10, opts.preSkip, true);
  dv.setUint32(12, opts.inputSampleRate, true);
  dv.setInt16(16, opts.outputGain ?? 0, true);
  head[18] = 0; // channel mapping family 0 (mono/stereo, no mapping table)
  return head;
}

/** Build the OpusTags comment header (RFC 7845 §5.2) with zero user comments. */
export function buildOpusTags(vendor: string): Uint8Array {
  const vendorBytes = utf8(vendor);
  const tags = new Uint8Array(8 + 4 + vendorBytes.length + 4);
  const dv = new DataView(tags.buffer);
  writeAscii(tags, 0, 'OpusTags');
  dv.setUint32(8, vendorBytes.length, true);
  tags.set(vendorBytes, 12);
  dv.setUint32(12 + vendorBytes.length, 0, true); // user comment list length
  return tags;
}

export interface BuildPageInput {
  headerType: number;
  /** Granule position; pass -1n for a page that completes no packet. */
  granule: bigint;
  serial: number;
  sequence: number;
  /** Lacing values, 1..255 of them, each 0..255. */
  segmentTable: number[];
  /** Concatenated segment data; length must equal sum(segmentTable). */
  payload: Uint8Array;
}

/** Assemble one Ogg page (27-byte header + segment table + payload) with CRC. */
export function buildPage(input: BuildPageInput): Uint8Array {
  const { headerType, granule, serial, sequence, segmentTable, payload } = input;
  const segCount = segmentTable.length;
  const page = new Uint8Array(27 + segCount + payload.length);
  const dv = new DataView(page.buffer);

  writeAscii(page, 0, 'OggS');
  page[4] = 0; // stream structure version
  page[5] = headerType;
  dv.setBigUint64(6, BigInt.asUintN(64, granule), true);
  dv.setUint32(14, serial >>> 0, true);
  dv.setUint32(18, sequence >>> 0, true);
  // Bytes 22..25 (CRC) stay zero for the checksum computation.
  page[26] = segCount;
  for (let i = 0; i < segCount; i++) page[27 + i] = segmentTable[i];
  page.set(payload, 27 + segCount);

  dv.setUint32(22, crc32(page), true);
  return page;
}

export interface StreamPacket {
  data: Uint8Array;
  /** Granule position AFTER this packet decodes; -1n only for special cases. */
  granule: bigint;
}

export interface PaginateOptions {
  serial: number;
  firstSequence: number;
  /** Set EOS on the final page produced. */
  lastPageEos: boolean;
  /** Soft byte budget: flush a page once its payload reaches this (default 4096). */
  maxPageBytes?: number;
}

interface PageDescriptor {
  granule: bigint;
  segments: number[];
  payloadChunks: Uint8Array[];
  payloadBytes: number;
  /** This page begins in the middle of a packet started on the previous page. */
  continued: boolean;
}

/**
 * Pack an ordered list of packets into Ogg pages. Small packets are grouped up
 * to the byte budget or the 255-segment page limit; a packet too large to fit
 * the remaining segments is split across pages, and every page after the split
 * carries the CONTINUED flag. Each page's granule is the granule of the LAST
 * packet that COMPLETES on it (-1 / 0xFF..FF when none completes).
 */
export function paginate(packets: StreamPacket[], opts: PaginateOptions): Uint8Array[] {
  const maxPageBytes = opts.maxPageBytes ?? 4096;
  const descriptors: PageDescriptor[] = [];

  let current: PageDescriptor = newPage(false);
  // Whether the NEXT flushed page starts mid-packet (set when a page fills up
  // before the current packet finished).
  let nextContinued = false;

  const flush = (): void => {
    descriptors.push(current);
    current = newPage(nextContinued);
    nextContinued = false;
  };

  for (const packet of packets) {
    const segs = segmentsForPacket(packet.data.length);
    let segOffset = 0;
    let byteOffset = 0;

    while (segOffset < segs.length) {
      const space = 255 - current.segments.length;
      const take = Math.min(space, segs.length - segOffset);
      let byteLen = 0;
      for (let i = 0; i < take; i++) {
        const value = segs[segOffset + i];
        current.segments.push(value);
        byteLen += value;
      }
      current.payloadChunks.push(packet.data.subarray(byteOffset, byteOffset + byteLen));
      current.payloadBytes += byteLen;
      segOffset += take;
      byteOffset += byteLen;

      if (segOffset === segs.length) {
        // The packet finished on this page — its granule owns the page.
        current.granule = packet.granule;
      }
      if (current.segments.length === 255) {
        // Page is physically full. If the packet is not done, the next page
        // continues it.
        nextContinued = segOffset < segs.length;
        flush();
      }
    }

    // Packet fully placed. Apply the soft byte budget at this packet boundary.
    if (current.payloadBytes >= maxPageBytes && current.segments.length > 0) {
      flush();
    }
  }

  if (current.segments.length > 0) descriptors.push(current);

  return descriptors.map((desc, i) => {
    let headerType = desc.continued ? HEADER_TYPE.CONTINUED : 0;
    if (opts.lastPageEos && i === descriptors.length - 1) headerType |= HEADER_TYPE.EOS;
    return buildPage({
      headerType,
      granule: desc.granule,
      serial: opts.serial,
      sequence: opts.firstSequence + i,
      segmentTable: desc.segments,
      payload: concatChunks(desc.payloadChunks, desc.payloadBytes),
    });
  });
}

function newPage(continued: boolean): PageDescriptor {
  return { granule: -1n, segments: [], payloadChunks: [], payloadBytes: 0, continued };
}

export interface EncodedOpusPacket {
  data: Uint8Array;
  /** Number of 48 kHz samples this packet decodes to (typically 960 for 20 ms). */
  sampleCount: number;
}

export interface MuxOptions {
  serial: number;
  channelCount: number;
  preSkip: number;
  /** ORIGINAL source sample rate stored in OpusHead. */
  inputSampleRate: number;
  packets: EncodedOpusPacket[];
  /**
   * True output sample count (pre-preSkip). The final EOS page granule is
   * trimmed to preSkip + totalSamples so decoders drop the encoder's tail
   * padding. Defaults to the sum of packet sampleCounts (no trimming).
   */
  totalSamples?: number;
  vendor?: string;
  maxPageBytes?: number;
}

/**
 * Mux encoded Opus packets into a complete Ogg Opus bitstream: an OpusHead page
 * (BOS, granule 0), an OpusTags page (granule 0), then audio pages whose granule
 * counts cumulative 48 kHz samples through the last completed packet. The final
 * audio page is EOS with its granule trimmed to preSkip + totalSamples.
 */
export function muxOpusStream(opts: MuxOptions): Uint8Array {
  const vendor = opts.vendor ?? 'audition_app';
  const head = buildOpusHead({
    channelCount: opts.channelCount,
    preSkip: opts.preSkip,
    inputSampleRate: opts.inputSampleRate,
  });
  const tags = buildOpusTags(vendor);

  const headPage = buildPage({
    headerType: HEADER_TYPE.BOS,
    granule: 0n,
    serial: opts.serial,
    sequence: 0,
    segmentTable: segmentsForPacket(head.length),
    payload: head,
  });
  const noAudio = opts.packets.length === 0;
  const tagsPage = buildPage({
    headerType: noAudio ? HEADER_TYPE.EOS : 0,
    granule: 0n,
    serial: opts.serial,
    sequence: 1,
    segmentTable: segmentsForPacket(tags.length),
    payload: tags,
  });

  const parts: Uint8Array[] = [headPage, tagsPage];

  if (!noAudio) {
    // Assign each audio packet the granule position reached after it decodes.
    let cumulative = 0;
    const streamPackets: StreamPacket[] = opts.packets.map((p) => {
      cumulative += p.sampleCount;
      return { data: p.data, granule: BigInt(opts.preSkip + cumulative) };
    });
    // Trim the final packet's granule to the true content length so the EOS
    // page tells decoders to drop the encoder's tail padding.
    const totalSamples = opts.totalSamples ?? cumulative;
    streamPackets[streamPackets.length - 1].granule = BigInt(opts.preSkip + totalSamples);

    for (const page of paginate(streamPackets, {
      serial: opts.serial,
      firstSequence: 2,
      lastPageEos: true,
      maxPageBytes: opts.maxPageBytes,
    })) {
      parts.push(page);
    }
  }

  return concatChunks(parts, parts.reduce((n, p) => n + p.length, 0));
}

// --- byte helpers ----------------------------------------------------------

function writeAscii(out: Uint8Array, offset: number, str: string): void {
  for (let i = 0; i < str.length; i++) out[offset + i] = str.charCodeAt(i);
}

const textEncoder = new TextEncoder();
function utf8(str: string): Uint8Array {
  return textEncoder.encode(str);
}

function concatChunks(chunks: Uint8Array[], totalBytes: number): Uint8Array {
  const out = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
