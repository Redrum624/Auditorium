/**
 * Minimal, correct FLAC encoder using VERBATIM subframes only — i.e. lossless
 * but uncompressed (each sample is stored raw, no prediction/Rice coding). The
 * point is a *format-faithful* Save/Export: a real `.flac` container that
 * Chromium's (FFmpeg) decoder — and libFLAC's `flac -t` — accept and decode back
 * to the exact quantized samples we wrote.
 *
 * Layout produced:
 *   'fLaC' magic
 *   STREAMINFO metadata block (last-block flag set, type 0, length 34)
 *   one or more fixed-blocksize FRAMEs (blocksize 4096; the final frame may be
 *   shorter), each a byte-aligned VERBATIM subframe per channel.
 *
 * The float→int quantization mirrors `wavCodec` (round then clamp) so a FLAC
 * saved from a document matches a 16/24-bit WAV of the same document sample for
 * sample. The STREAMINFO MD5 is computed over the same quantized, little-endian,
 * interleaved PCM the decoder reconstructs, so `flac -t` verifies clean.
 *
 * References: the FLAC format specification (frame header bit layout, CRC
 * polynomials, STREAMINFO field widths). See src/audio/sniffSampleRate.ts for
 * the reverse STREAMINFO bit math this file is the inverse of.
 *
 * When `markers` are passed (Task K4), a VORBIS_COMMENT metadata block (type
 * 4) carrying `chapterTags.ts`'s CHAPTERxxx/AUDITORIUM_MARKERS comments is
 * inserted between STREAMINFO and the first frame: STREAMINFO's is-last flag
 * is cleared (`0x80` -> `0x00`) and the new block is flagged is-last instead.
 * Omitting `markers` (or passing `[]`) reproduces the pre-K4 layout exactly
 * (STREAMINFO directly followed by frames, is-last set on STREAMINFO).
 */

import { buildChapterComments, buildVorbisCommentPayload, type ChapterMarker } from './chapterTags';

const BLOCK_SIZE = 4096;

/** Vendor string written into the VORBIS_COMMENT block (Task K4). */
const VORBIS_VENDOR = 'audition_app';

// --- MD5 ---------------------------------------------------------------------
// MD5 (RFC 1321), compact implementation adapted from blueimp/JavaScript-MD5
// (MIT license — NOT public domain, as an earlier version of this comment
// claimed), which itself derives from Joseph Myers' widely mirrored
// implementation. Attribution retained in THIRD_PARTY_NOTICES.md at the repo
// root. Operates on a Uint8Array and returns the 16 raw digest bytes
// (little-endian words), which is exactly the byte order FLAC stores. Verified
// in tests against RFC 1321 vectors.

/**
 * Write RFC 1321's 64-bit little-endian message-bit-length field into
 * `msg[paddedLen-8 .. paddedLen-1]`: the low-order 32-bit word first
 * (paddedLen-8..-5), then the high-order word (paddedLen-4..-1). A
 * >=512 MiB message (>= 2^32 bits) needs the high word — writing only the
 * low word silently wraps the length mod 2^32 and produces a wrong digest.
 * `byteLength` is the ORIGINAL (unpadded) message length in bytes; kept
 * separate from `msg` so the length-encoding math can be exercised against a
 * synthetic multi-gigabyte length without allocating a multi-gigabyte buffer.
 */
function writeMd5Length(msg: Uint8Array, paddedLen: number, byteLength: number): void {
  const bits = byteLength * 8;
  const lo = bits >>> 0; // ToUint32: exactly `bits mod 2^32`
  const hi = Math.floor(bits / 0x100000000);
  msg[paddedLen - 8] = lo & 0xff;
  msg[paddedLen - 7] = (lo >>> 8) & 0xff;
  msg[paddedLen - 6] = (lo >>> 16) & 0xff;
  msg[paddedLen - 5] = (lo >>> 24) & 0xff;
  msg[paddedLen - 4] = hi & 0xff;
  msg[paddedLen - 3] = (hi >>> 8) & 0xff;
  msg[paddedLen - 2] = (hi >>> 16) & 0xff;
  msg[paddedLen - 1] = (hi >>> 24) & 0xff;
}

function md5(bytes: Uint8Array): Uint8Array {
  const add32 = (a: number, b: number): number => (a + b) & 0xffffffff;
  const rol = (n: number, c: number): number => (n << c) | (n >>> (32 - c));

  function cmn(q: number, a: number, b: number, x: number, s: number, t: number): number {
    return add32(rol(add32(add32(a, q), add32(x, t)), s), b);
  }
  const ff = (a: number, b: number, c: number, d: number, x: number, s: number, t: number) =>
    cmn((b & c) | (~b & d), a, b, x, s, t);
  const gg = (a: number, b: number, c: number, d: number, x: number, s: number, t: number) =>
    cmn((b & d) | (c & ~d), a, b, x, s, t);
  const hh = (a: number, b: number, c: number, d: number, x: number, s: number, t: number) =>
    cmn(b ^ c ^ d, a, b, x, s, t);
  const ii = (a: number, b: number, c: number, d: number, x: number, s: number, t: number) =>
    cmn(c ^ (b | ~d), a, b, x, s, t);

  // Build the padded message as 32-bit little-endian words.
  const withOne = bytes.length + 1;
  const paddedLen = (((withOne + 8 + 63) >> 6) << 6); // multiple of 64
  const msg = new Uint8Array(paddedLen);
  msg.set(bytes);
  msg[bytes.length] = 0x80;
  writeMd5Length(msg, paddedLen, bytes.length);

  let a = 1732584193;
  let b = -271733879;
  let c = -1732584194;
  let d = 271733878;

  const x = new Int32Array(16);
  for (let i = 0; i < paddedLen; i += 64) {
    for (let j = 0; j < 16; j++) {
      const k = i + j * 4;
      x[j] = msg[k] | (msg[k + 1] << 8) | (msg[k + 2] << 16) | (msg[k + 3] << 24);
    }
    const oa = a;
    const ob = b;
    const oc = c;
    const od = d;

    a = ff(a, b, c, d, x[0], 7, -680876936);
    d = ff(d, a, b, c, x[1], 12, -389564586);
    c = ff(c, d, a, b, x[2], 17, 606105819);
    b = ff(b, c, d, a, x[3], 22, -1044525330);
    a = ff(a, b, c, d, x[4], 7, -176418897);
    d = ff(d, a, b, c, x[5], 12, 1200080426);
    c = ff(c, d, a, b, x[6], 17, -1473231341);
    b = ff(b, c, d, a, x[7], 22, -45705983);
    a = ff(a, b, c, d, x[8], 7, 1770035416);
    d = ff(d, a, b, c, x[9], 12, -1958414417);
    c = ff(c, d, a, b, x[10], 17, -42063);
    b = ff(b, c, d, a, x[11], 22, -1990404162);
    a = ff(a, b, c, d, x[12], 7, 1804603682);
    d = ff(d, a, b, c, x[13], 12, -40341101);
    c = ff(c, d, a, b, x[14], 17, -1502002290);
    b = ff(b, c, d, a, x[15], 22, 1236535329);

    a = gg(a, b, c, d, x[1], 5, -165796510);
    d = gg(d, a, b, c, x[6], 9, -1069501632);
    c = gg(c, d, a, b, x[11], 14, 643717713);
    b = gg(b, c, d, a, x[0], 20, -373897302);
    a = gg(a, b, c, d, x[5], 5, -701558691);
    d = gg(d, a, b, c, x[10], 9, 38016083);
    c = gg(c, d, a, b, x[15], 14, -660478335);
    b = gg(b, c, d, a, x[4], 20, -405537848);
    a = gg(a, b, c, d, x[9], 5, 568446438);
    d = gg(d, a, b, c, x[14], 9, -1019803690);
    c = gg(c, d, a, b, x[3], 14, -187363961);
    b = gg(b, c, d, a, x[8], 20, 1163531501);
    a = gg(a, b, c, d, x[13], 5, -1444681467);
    d = gg(d, a, b, c, x[2], 9, -51403784);
    c = gg(c, d, a, b, x[7], 14, 1735328473);
    b = gg(b, c, d, a, x[12], 20, -1926607734);

    a = hh(a, b, c, d, x[5], 4, -378558);
    d = hh(d, a, b, c, x[8], 11, -2022574463);
    c = hh(c, d, a, b, x[11], 16, 1839030562);
    b = hh(b, c, d, a, x[14], 23, -35309556);
    a = hh(a, b, c, d, x[1], 4, -1530992060);
    d = hh(d, a, b, c, x[4], 11, 1272893353);
    c = hh(c, d, a, b, x[7], 16, -155497632);
    b = hh(b, c, d, a, x[10], 23, -1094730640);
    a = hh(a, b, c, d, x[13], 4, 681279174);
    d = hh(d, a, b, c, x[0], 11, -358537222);
    c = hh(c, d, a, b, x[3], 16, -722521979);
    b = hh(b, c, d, a, x[6], 23, 76029189);
    a = hh(a, b, c, d, x[9], 4, -640364487);
    d = hh(d, a, b, c, x[12], 11, -421815835);
    c = hh(c, d, a, b, x[15], 16, 530742520);
    b = hh(b, c, d, a, x[2], 23, -995338651);

    a = ii(a, b, c, d, x[0], 6, -198630844);
    d = ii(d, a, b, c, x[7], 10, 1126891415);
    c = ii(c, d, a, b, x[14], 15, -1416354905);
    b = ii(b, c, d, a, x[5], 21, -57434055);
    a = ii(a, b, c, d, x[12], 6, 1700485571);
    d = ii(d, a, b, c, x[3], 10, -1894986606);
    c = ii(c, d, a, b, x[10], 15, -1051523);
    b = ii(b, c, d, a, x[1], 21, -2054922799);
    a = ii(a, b, c, d, x[8], 6, 1873313359);
    d = ii(d, a, b, c, x[15], 10, -30611744);
    c = ii(c, d, a, b, x[6], 15, -1560198380);
    b = ii(b, c, d, a, x[13], 21, 1309151649);
    a = ii(a, b, c, d, x[4], 6, -145523070);
    d = ii(d, a, b, c, x[11], 10, -1120210379);
    c = ii(c, d, a, b, x[2], 15, 718787259);
    b = ii(b, c, d, a, x[9], 21, -343485551);

    a = add32(a, oa);
    b = add32(b, ob);
    c = add32(c, oc);
    d = add32(d, od);
  }

  const out = new Uint8Array(16);
  const words = [a, b, c, d];
  for (let i = 0; i < 4; i++) {
    out[i * 4] = words[i] & 0xff;
    out[i * 4 + 1] = (words[i] >>> 8) & 0xff;
    out[i * 4 + 2] = (words[i] >>> 16) & 0xff;
    out[i * 4 + 3] = (words[i] >>> 24) & 0xff;
  }
  return out;
}

// --- CRCs --------------------------------------------------------------------
// FLAC frame header CRC-8 (poly x^8+x^2+x^1+x^0 = 0x07) and frame CRC-16
// (poly x^16+x^15+x^2+x^0 = 0x8005), both init 0, MSB-first, no final xor.

function crc8(data: Uint8Array): number {
  let crc = 0;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i];
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 0x80 ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff;
    }
  }
  return crc;
}

function crc16(data: Uint8Array): number {
  let crc = 0;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i] << 8;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x8005) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

// --- Bit writer --------------------------------------------------------------
// Packs bits MSB-first into a growable byte buffer. All FLAC integer fields are
// big-endian bit fields, so every write goes through here.

class BitWriter {
  private buf = new Uint8Array(1024);
  private len = 0; // completed bytes
  private cur = 0; // partial byte accumulator
  private nbits = 0; // bits currently in `cur`

  private ensure(extra: number): void {
    if (this.len + extra <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.len + extra) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }

  /** Write the low `bits` bits of `value` (treated as unsigned) MSB-first. */
  writeBits(value: number, bits: number): void {
    for (let i = bits - 1; i >= 0; i--) {
      this.cur = (this.cur << 1) | ((value >>> i) & 1);
      this.nbits++;
      if (this.nbits === 8) {
        this.ensure(1);
        this.buf[this.len++] = this.cur & 0xff;
        this.cur = 0;
        this.nbits = 0;
      }
    }
  }

  /** Append whole bytes; only valid when byte-aligned. */
  writeBytes(bytes: Uint8Array): void {
    if (this.nbits !== 0) throw new Error('writeBytes on a non-byte-aligned BitWriter');
    this.ensure(bytes.length);
    this.buf.set(bytes, this.len);
    this.len += bytes.length;
  }

  /** Pad the current partial byte with zero bits to the next byte boundary. */
  padToByte(): void {
    if (this.nbits > 0) this.writeBits(0, 8 - this.nbits);
  }

  isByteAligned(): boolean {
    return this.nbits === 0;
  }

  /** Snapshot of completed bytes (must be byte-aligned). */
  toBytes(): Uint8Array {
    if (this.nbits !== 0) throw new Error('toBytes on a non-byte-aligned BitWriter');
    return this.buf.slice(0, this.len);
  }
}

// --- Frame-number UTF-8-style coding -----------------------------------------
// The frame number in a fixed-blocksize stream is encoded like UTF-8 (1..7
// bytes, values up to 36 bits). Called only when the writer is byte-aligned.

function writeUtf8(bw: BitWriter, value: number): void {
  if (value < 0x80) {
    bw.writeBits(value, 8);
    return;
  }
  // Determine byte count: 2 bytes ≤ 0x7FF, 3 ≤ 0xFFFF, ... up to 7 bytes.
  const ranges = [0x7ff, 0xffff, 0x1fffff, 0x3ffffff, 0x7fffffff];
  let nbytes = 2;
  for (let i = 0; i < ranges.length; i++) {
    if (value <= ranges[i]) {
      nbytes = i + 2;
      break;
    }
    nbytes = i + 3;
  }
  const leadOnes = nbytes; // leading-1 count in the first byte
  const firstDataBits = 7 - leadOnes; // data bits in the first byte
  // First byte: `leadOnes` 1s, a 0, then the top `firstDataBits` of value.
  let first = 0;
  for (let i = 0; i < leadOnes; i++) first = (first << 1) | 1;
  first = first << 1; // the separating 0
  const totalDataBits = firstDataBits + (nbytes - 1) * 6;
  first = (first << firstDataBits) | ((value >>> (totalDataBits - firstDataBits)) & ((1 << firstDataBits) - 1));
  bw.writeBits(first, 8);
  for (let i = nbytes - 2; i >= 0; i--) {
    const shift = i * 6;
    const sixBits = (value >>> shift) & 0x3f;
    bw.writeBits(0x80 | sixBits, 8);
  }
}

// --- Sample quantization -----------------------------------------------------

function quantize(sample: number, bitDepth: 16 | 24): number {
  if (bitDepth === 24) {
    return Math.max(-8388608, Math.min(8388607, Math.round(sample * 8388607)));
  }
  return Math.max(-32768, Math.min(32767, Math.round(sample * 32767)));
}

// --- Encoder -----------------------------------------------------------------

/**
 * Encode per-channel Float32 audio (nominally [-1, 1]) into a VERBATIM FLAC
 * stream. `bitDepth` selects the stored PCM resolution (16 or 24); the samples
 * are quantized exactly as `wavCodec` would at that depth.
 */
export function encodeFlac(
  channels: Float32Array[],
  sampleRate: number,
  bitDepth: 16 | 24 = 16,
  markers?: ChapterMarker[]
): ArrayBuffer {
  const hasMarkers = !!markers && markers.length > 0;
  const numChannels = channels.length > 0 ? channels.length : 1;
  const totalSamples = channels.length > 0 ? channels[0].length : 0;
  const bytesPerSample = bitDepth / 8;

  // Quantize once; reuse for both the subframe payload and the MD5 so they agree.
  const quantized: Int32Array[] = channels.map((ch) => {
    const out = new Int32Array(ch.length);
    for (let i = 0; i < ch.length; i++) out[i] = quantize(ch[i], bitDepth);
    return out;
  });

  // MD5 over the little-endian, interleaved, signed PCM the decoder reconstructs.
  const pcm = new Uint8Array(totalSamples * numChannels * bytesPerSample);
  let p = 0;
  for (let i = 0; i < totalSamples; i++) {
    for (let ch = 0; ch < numChannels; ch++) {
      const v = quantized[ch][i];
      pcm[p++] = v & 0xff;
      pcm[p++] = (v >> 8) & 0xff;
      if (bitDepth === 24) pcm[p++] = (v >> 16) & 0xff;
    }
  }
  const md5sig = md5(pcm);

  // STREAMINFO min/max blocksize (Task M6 / F18), per RFC 9639 / libFLAC.
  // Every frame below uses the FIXED blocking strategy at a constant
  // BLOCK_SIZE, except possibly a shorter final frame — that trailing partial
  // frame is a formality, not a second genuine blocksize, so an honest
  // STREAMINFO EXCLUDES it from min/max: whenever at least one full
  // BLOCK_SIZE frame exists (totalSamples >= BLOCK_SIZE), min=max=BLOCK_SIZE.
  // (The old code included the tail frame, so min != max on almost every
  // real file.) When the whole stream fits in a single frame shorter than
  // BLOCK_SIZE, min=max=that frame's actual size, floored at 16 — FLAC's
  // minimum legal block size; anything below it is spec-invalid and
  // ffmpeg/Chromium reject it outright (a very short saved document couldn't
  // even reopen its own file before this fix).
  //
  // Computed as a direct O(1) comparison rather than Math.min/max(...spread)
  // over a per-block array: every block except possibly the last is exactly
  // BLOCK_SIZE by construction, so "does a full block exist" reduces to a
  // single threshold check. The old per-block array could exceed 65,536
  // entries (~268M samples at BLOCK_SIZE) and blow the JS engine's
  // argument-spread limit with a RangeError.
  //
  // A 0-sample (empty) stream falls out of the same "single short frame"
  // branch (`Math.max(0, 16)`), so it now also reports 16/16 instead of the
  // old code's 0/0 — an incidental improvement (min_blocksize 0 is spec-
  // invalid too) rather than something separately special-cased.
  const minBlock = totalSamples >= BLOCK_SIZE ? BLOCK_SIZE : Math.max(totalSamples, 16);
  const maxBlock = totalSamples >= BLOCK_SIZE ? BLOCK_SIZE : minBlock;

  // --- STREAMINFO ---
  // is-last is cleared (0x00) when a VORBIS_COMMENT block follows; set (0x80)
  // when STREAMINFO is the only metadata block, exactly as before K4.
  const siHeader = new Uint8Array([hasMarkers ? 0x00 : 0x80, 0x00, 0x00, 0x22]); // type 0, len 34
  const si = new BitWriter();
  si.writeBits(minBlock, 16);
  si.writeBits(maxBlock, 16);
  si.writeBits(0, 24); // min frame size unknown
  si.writeBits(0, 24); // max frame size unknown
  si.writeBits(sampleRate, 20);
  si.writeBits(numChannels - 1, 3);
  si.writeBits(bitDepth - 1, 5);
  // 36-bit total samples: top 4 bits then low 32.
  si.writeBits(Math.floor(totalSamples / 0x100000000) & 0xf, 4);
  si.writeBits(totalSamples >>> 0, 32);
  si.writeBytes(md5sig);
  const streaminfo = si.toBytes(); // 34 bytes

  // Sample-size code for the frame header.
  const sampleSizeCode = bitDepth === 24 ? 0b110 : 0b100;
  const channelAssignment = numChannels - 1; // independent channels

  const frames: Uint8Array[] = [];
  let frameNumber = 0;
  for (let start = 0; start < totalSamples; start += BLOCK_SIZE) {
    const blockSize = Math.min(BLOCK_SIZE, totalSamples - start);

    // Frame header (byte-aligned by construction).
    const fw = new BitWriter();
    fw.writeBits(0b11111111111110, 14); // sync
    fw.writeBits(0, 1); // reserved
    fw.writeBits(0, 1); // blocking strategy: fixed
    fw.writeBits(0b0111, 4); // block size: 16-bit (blocksize-1) at end of header
    fw.writeBits(0b0000, 4); // sample rate: from STREAMINFO
    fw.writeBits(channelAssignment, 4);
    fw.writeBits(sampleSizeCode, 3);
    fw.writeBits(0, 1); // reserved
    writeUtf8(fw, frameNumber); // fixed strategy => frame number
    fw.writeBits(blockSize - 1, 16); // the promised 16-bit block size
    const headerBytes = fw.toBytes();
    fw.writeBits(crc8(headerBytes), 8);

    // Subframes: one VERBATIM subframe per channel.
    for (let ch = 0; ch < numChannels; ch++) {
      fw.writeBits(0b00000010, 8); // subframe header: VERBATIM, no wasted bits
      const data = quantized[ch];
      for (let i = 0; i < blockSize; i++) {
        // Two's-complement low `bitDepth` bits.
        fw.writeBits(data[start + i] & (bitDepth === 24 ? 0xffffff : 0xffff), bitDepth);
      }
    }

    fw.padToByte();
    const body = fw.toBytes();
    const c16 = crc16(body);
    fw.writeBits(c16, 16);
    frames.push(fw.toBytes());
    frameNumber++;
  }

  // --- VORBIS_COMMENT (optional, Task K4) ---
  let vorbisBlock: Uint8Array | null = null;
  if (hasMarkers) {
    const comments = buildChapterComments(markers!, sampleRate);
    const payload = buildVorbisCommentPayload(VORBIS_VENDOR, comments);
    const header = new Uint8Array([0x84, (payload.length >> 16) & 0xff, (payload.length >> 8) & 0xff, payload.length & 0xff]); // last-block, type 4
    vorbisBlock = new Uint8Array(header.length + payload.length);
    vorbisBlock.set(header, 0);
    vorbisBlock.set(payload, header.length);
  }

  // --- Assemble the stream ---
  const magic = new Uint8Array([0x66, 0x4c, 0x61, 0x43]); // 'fLaC'
  let size = magic.length + siHeader.length + streaminfo.length + (vorbisBlock ? vorbisBlock.length : 0);
  for (const f of frames) size += f.length;
  const out = new Uint8Array(size);
  let off = 0;
  out.set(magic, off);
  off += magic.length;
  out.set(siHeader, off);
  off += siHeader.length;
  out.set(streaminfo, off);
  off += streaminfo.length;
  if (vorbisBlock) {
    out.set(vorbisBlock, off);
    off += vorbisBlock.length;
  }
  for (const f of frames) {
    out.set(f, off);
    off += f.length;
  }
  return out.buffer;
}

/** Test-only exports so the structural tests can validate the primitives
 * against independent reimplementations. Not part of the public encoder API. */
export const __flacInternal = { md5, crc8, crc16, quantize, writeMd5Length };
