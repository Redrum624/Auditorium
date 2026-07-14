import { encodeFlac, __flacInternal } from './flacEncoder';
import { readFlacStreamInfo } from './sniffSampleRate';

// -----------------------------------------------------------------------------
// Independent primitives — reimplemented here from first principles so the tests
// validate the encoder rather than tautologically mirroring it.
// -----------------------------------------------------------------------------

/** Table-driven CRC-8 (poly 0x07, init 0), built independently of the encoder. */
function refCrc8(data: Uint8Array): number {
  const table = new Uint8Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 0x80 ? ((c << 1) ^ 0x07) & 0xff : (c << 1) & 0xff;
    table[n] = c;
  }
  let crc = 0;
  for (let i = 0; i < data.length; i++) crc = table[(crc ^ data[i]) & 0xff];
  return crc;
}

/** Table-driven CRC-16 (poly 0x8005, init 0), built independently. */
function refCrc16(data: Uint8Array): number {
  const table = new Uint16Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n << 8;
    for (let k = 0; k < 8; k++) c = c & 0x8000 ? ((c << 1) ^ 0x8005) & 0xffff : (c << 1) & 0xffff;
    table[n] = c;
  }
  let crc = 0;
  for (let i = 0; i < data.length; i++) crc = ((crc << 8) ^ table[((crc >> 8) ^ data[i]) & 0xff]) & 0xffff;
  return crc;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Big-endian, MSB-first bit reader over a byte range. */
class BitReader {
  private pos: number; // bit position
  constructor(private bytes: Uint8Array, startBit = 0) {
    this.pos = startBit;
  }
  read(bits: number): number {
    let v = 0;
    for (let i = 0; i < bits; i++) {
      const byte = this.bytes[this.pos >> 3];
      const bit = (byte >> (7 - (this.pos & 7))) & 1;
      v = (v << 1) | bit;
      this.pos++;
    }
    return v >>> 0;
  }
  /** Signed two's-complement read. */
  readSigned(bits: number): number {
    const raw = this.read(bits);
    return raw >= 1 << (bits - 1) ? raw - (1 << bits) : raw;
  }
  bitPos(): number {
    return this.pos;
  }
  bytePos(): number {
    return this.pos >> 3;
  }
  align(): void {
    if (this.pos & 7) this.pos = (this.pos + 7) & ~7;
  }
}

/** Full VERBATIM-only FLAC decoder for the test: parses STREAMINFO + every frame,
 * verifies CRC-8/CRC-16, and returns the decoded per-channel integer samples. */
function decodeVerbatimFlac(buf: ArrayBuffer): {
  sampleRate: number;
  bitDepth: number;
  channels: number[][];
  minBlock: number;
  maxBlock: number;
  totalSamples: number;
  md5: string;
} {
  const bytes = new Uint8Array(buf);
  expect(String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3])).toBe('fLaC');

  // Metadata block header at byte 4.
  const lastFlag = bytes[4] >> 7;
  const blockType = bytes[4] & 0x7f;
  const blockLen = (bytes[5] << 16) | (bytes[6] << 8) | bytes[7];
  expect(lastFlag).toBe(1);
  expect(blockType).toBe(0);
  expect(blockLen).toBe(34);

  const si = new BitReader(bytes, 8 * 8);
  const minBlock = si.read(16);
  const maxBlock = si.read(16);
  si.read(24); // min frame size
  si.read(24); // max frame size
  const sampleRate = si.read(20);
  const channels = si.read(3) + 1;
  const bitDepth = si.read(5) + 1;
  const totHi = si.read(4);
  const totLo = si.read(32);
  const totalSamples = totHi * 0x100000000 + totLo;
  const md5 = toHex(bytes.subarray(8 + 18, 8 + 34));

  const out: number[][] = Array.from({ length: channels }, () => []);
  let off = 8 + 34; // first frame byte
  let decoded = 0;
  while (decoded < totalSamples) {
    const frameStart = off;
    const br = new BitReader(bytes, off * 8);
    expect(br.read(14)).toBe(0b11111111111110); // sync
    expect(br.read(1)).toBe(0); // reserved
    expect(br.read(1)).toBe(0); // blocking strategy: fixed
    const blockCode = br.read(4);
    expect(blockCode).toBe(0b0111); // 16-bit blocksize-1 at end of header
    expect(br.read(4)).toBe(0b0000); // sample rate from STREAMINFO
    expect(br.read(4)).toBe(channels - 1); // independent channel assignment
    const sizeCode = br.read(3);
    expect(sizeCode).toBe(bitDepth === 24 ? 0b110 : 0b100);
    expect(br.read(1)).toBe(0); // reserved
    // Skip the UTF-8 frame number: count leading 1s of the first byte.
    const firstByte = bytes[br.bytePos()];
    let extra = 0;
    if (firstByte >= 0x80) {
      let m = firstByte;
      while (m & 0x80) {
        extra++;
        m = (m << 1) & 0xff;
      }
      extra -= 1; // continuation bytes follow the lead byte
    }
    br.read(8 * (1 + extra)); // consume the whole UTF-8 code
    const blockSize = br.read(16) + 1;
    // CRC-8 over the header bytes (sync..blocksize), which are byte-aligned.
    const headerEnd = br.bytePos();
    const headerCrc = br.read(8);
    expect(headerCrc).toBe(refCrc8(bytes.subarray(frameStart, headerEnd)));

    for (let ch = 0; ch < channels; ch++) {
      expect(br.read(8)).toBe(0b00000010); // VERBATIM subframe header
      for (let i = 0; i < blockSize; i++) out[ch].push(br.readSigned(bitDepth));
    }
    br.align();
    const frameEnd = br.bytePos();
    const frameCrc = br.read(16);
    expect(frameCrc).toBe(refCrc16(bytes.subarray(frameStart, frameEnd)));

    decoded += blockSize;
    off = br.bytePos();
  }

  return { sampleRate, bitDepth, channels: out, minBlock, maxBlock, totalSamples, md5 };
}

/** Normalize signed zero: quantizing a tiny negative float yields -0, which is
 * bit-identical to +0 once packed as two's complement, so the decoder returns +0. */
const nz = (n: number): number => (n === 0 ? 0 : n);

function sine(freq: number, rate: number, length: number, amp = 0.5): Float32Array {
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / rate);
  return out;
}

// -----------------------------------------------------------------------------
// MD5
// -----------------------------------------------------------------------------

describe('md5 (vendored, verified against RFC 1321 vectors)', () => {
  const enc = (s: string) => new Uint8Array(Array.from(s, (c) => c.charCodeAt(0)));
  it.each([
    ['', 'd41d8cd98f00b204e9800998ecf8427e'],
    ['a', '0cc175b9c0f1b6a831c399e269772661'],
    ['abc', '900150983cd24fb0d6963f7d28e17f72'],
    ['message digest', 'f96b697d7cb7938d525a2f31aaf161d0'],
    ['The quick brown fox jumps over the lazy dog', '9e107d9d372bb6826bd81d3542a419d6'],
  ])('md5(%p)', (input, expected) => {
    expect(toHex(__flacInternal.md5(enc(input)))).toBe(expected);
  });

  it('hashes a 1000-byte block correctly (spans multiple 64-byte chunks)', () => {
    const data = new Uint8Array(1000);
    for (let i = 0; i < data.length; i++) data[i] = (i * 31) & 0xff;
    // Reference value computed with Node's crypto for this exact byte pattern.
    expect(toHex(__flacInternal.md5(data))).toBe('bf38fd44dfb382df1a50ee14ad83c46c');
  });
});

// -----------------------------------------------------------------------------
// CRCs
// -----------------------------------------------------------------------------

describe('crc8 / crc16 match independent table-driven references', () => {
  it('agrees on random byte strings', () => {
    for (let t = 0; t < 20; t++) {
      const len = 1 + ((t * 7) % 50);
      const data = new Uint8Array(len);
      for (let i = 0; i < len; i++) data[i] = (i * 13 + t * 97) & 0xff;
      expect(__flacInternal.crc8(data)).toBe(refCrc8(data));
      expect(__flacInternal.crc16(data)).toBe(refCrc16(data));
    }
  });
});

// -----------------------------------------------------------------------------
// STREAMINFO + magic
// -----------------------------------------------------------------------------

describe('encodeFlac STREAMINFO', () => {
  it('starts with the fLaC magic and a last-block STREAMINFO of length 34', () => {
    const buf = encodeFlac([sine(440, 44100, 1000)], 44100, 16);
    const bytes = new Uint8Array(buf);
    expect(String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3])).toBe('fLaC');
    expect(bytes[4]).toBe(0x80); // last-block flag set, block type 0
    expect((bytes[5] << 16) | (bytes[6] << 8) | bytes[7]).toBe(34);
  });

  it('records rate, channel count, bit depth and total samples bit-exact', () => {
    const len = 5000;
    const buf = encodeFlac([sine(440, 48000, len), sine(660, 48000, len)], 48000, 16);
    const d = decodeVerbatimFlac(buf);
    expect(d.sampleRate).toBe(48000);
    expect(d.channels.length).toBe(2);
    expect(d.bitDepth).toBe(16);
    expect(d.totalSamples).toBe(len);
    // The sniffer's own STREAMINFO reader must agree.
    expect(readFlacStreamInfo(buf)).toEqual({ sampleRate: 48000, bitDepth: 16 });
  });

  it('honours 24-bit depth', () => {
    const buf = encodeFlac([sine(440, 44100, 300)], 44100, 24);
    expect(readFlacStreamInfo(buf)).toEqual({ sampleRate: 44100, bitDepth: 24 });
    expect(decodeVerbatimFlac(buf).bitDepth).toBe(24);
  });

  it('sets min/max block size to the true per-frame min and max (short last frame)', () => {
    // 4096*2 + 100 => three frames of 4096, 4096, 100.
    const len = 4096 * 2 + 100;
    const buf = encodeFlac([sine(440, 44100, len)], 44100, 16);
    const d = decodeVerbatimFlac(buf);
    expect(d.maxBlock).toBe(4096);
    expect(d.minBlock).toBe(100);
  });

  it('uses min==max block size when the length is an exact multiple of 4096', () => {
    const len = 4096 * 2;
    const buf = encodeFlac([sine(440, 44100, len)], 44100, 16);
    const d = decodeVerbatimFlac(buf);
    expect(d.minBlock).toBe(4096);
    expect(d.maxBlock).toBe(4096);
  });

  it("STREAMINFO MD5 equals the MD5 of the interleaved little-endian PCM", () => {
    const len = 2000;
    const chL = sine(440, 44100, len);
    const chR = sine(660, 44100, len, 0.3);
    const buf = encodeFlac([chL, chR], 44100, 16);
    // Rebuild the exact interleaved 16-bit LE PCM the decoder reconstructs.
    const pcm = new Uint8Array(len * 2 * 2);
    let p = 0;
    for (let i = 0; i < len; i++) {
      for (const ch of [chL, chR]) {
        const v = __flacInternal.quantize(ch[i], 16);
        pcm[p++] = v & 0xff;
        pcm[p++] = (v >> 8) & 0xff;
      }
    }
    expect(decodeVerbatimFlac(buf).md5).toBe(toHex(__flacInternal.md5(pcm)));
  });
});

// -----------------------------------------------------------------------------
// Full round-trip (structural decode) — the strongest jest-level guarantee.
// -----------------------------------------------------------------------------

describe('encodeFlac round-trip (verbatim decode)', () => {
  it('decodes stereo samples back exactly to the quantized input', () => {
    const len = 4096 + 512; // two frames
    const chL = sine(440, 44100, len, 0.8);
    const chR = sine(660, 44100, len, 0.5);
    const buf = encodeFlac([chL, chR], 44100, 16);
    const d = decodeVerbatimFlac(buf);
    expect(d.channels[0].length).toBe(len);
    for (let i = 0; i < len; i++) {
      expect(d.channels[0][i]).toBe(nz(__flacInternal.quantize(chL[i], 16)));
      expect(d.channels[1][i]).toBe(nz(__flacInternal.quantize(chR[i], 16)));
      // And the reconstructed float is within one 16-bit step of the original.
      expect(Math.abs(d.channels[0][i] / 32767 - chL[i])).toBeLessThanOrEqual(1 / 32767 + 1e-7);
    }
  });

  it('decodes a mono 24-bit stream exactly', () => {
    const len = 1500;
    const ch = sine(220, 48000, len, 0.9);
    const buf = encodeFlac([ch], 48000, 24);
    const d = decodeVerbatimFlac(buf);
    expect(d.channels.length).toBe(1);
    for (let i = 0; i < len; i++) {
      expect(d.channels[0][i]).toBe(nz(__flacInternal.quantize(ch[i], 24)));
    }
  });

  it('clamps out-of-range input instead of wrapping', () => {
    const ch = new Float32Array([2, -2, 1, -1, 0]);
    const buf = encodeFlac([ch], 44100, 16);
    const d = decodeVerbatimFlac(buf);
    expect(d.channels[0]).toEqual([32767, -32768, 32767, -32767, 0]);
  });
});
