/**
 * @jest-environment node
 */
// Uses the REAL @breezystack/lamejs encoder. The jsdom environment can choke on
// lamejs's module shape, so this file forces the node environment.
import { encodeMp3, readEncodedFrameSampleRate, type Mp3Kbps } from './mp3Encoder';
import { buildId3Chapters, parseId3Chapters } from './id3Chapters';

function sine(freq: number, sampleRate: number, seconds: number): Float32Array {
  const length = Math.round(sampleRate * seconds);
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    out[i] = 0.5 * Math.sin((2 * Math.PI * freq * i) / sampleRate);
  }
  return out;
}

/** MPEG-1/2/2.5 sample-rate lookup by (version bits, rate bits), independent
 * of the encoder — used to verify the REAL output rate lamejs picked from the
 * raw frame header bytes, not just what we assume it did. */
const MPEG1_RATES = [44100, 48000, 32000, null];
const MPEG2_RATES = [22050, 24000, 16000, null];
const MPEG25_RATES = [11025, 12000, 8000, null];

/** Reads the sample rate encoded in the MPEG frame header at `offset` (byte0
 * must be 0xFF, the sync word's first 8 bits). */
function frameSampleRate(bytes: Uint8Array, offset: number): number {
  if (bytes[offset] !== 0xff || (bytes[offset + 1] & 0xe0) !== 0xe0) {
    throw new Error(`no frame sync at offset ${offset}`);
  }
  const versionBits = (bytes[offset + 1] >> 3) & 0x3; // 00=2.5, 10=2, 11=1
  const rateBits = (bytes[offset + 2] >> 2) & 0x3;
  const table = versionBits === 0b11 ? MPEG1_RATES : versionBits === 0b10 ? MPEG2_RATES : MPEG25_RATES;
  const rate = table[rateBits];
  if (rate == null) throw new Error('reserved sample-rate bits');
  return rate;
}

/** Recovers the byte length of an ID3v2 tag (header + syncsafe body size)
 * prepended by buildId3Chapters, so a test can find the first MP3 frame. */
function id3TagLength(bytes: Uint8Array): number {
  const size =
    ((bytes[6] & 0x7f) << 21) | ((bytes[7] & 0x7f) << 14) | ((bytes[8] & 0x7f) << 7) | (bytes[9] & 0x7f);
  return 10 + size;
}

describe('encodeMp3', () => {
  it('produces a non-empty MP3 stream that begins with a frame sync word', () => {
    const sr = 44100;
    const buf = encodeMp3([sine(440, sr, 1), sine(440, sr, 1)], sr, 128);
    const bytes = new Uint8Array(buf);

    expect(bytes.length).toBeGreaterThan(0);
    // MP3 frame sync: first byte 0xFF, top 3 bits of the second byte all set.
    expect(bytes[0]).toBe(0xff);
    expect(bytes[1] & 0xe0).toBe(0xe0);
  });

  it('produces a plausibly-sized stream for 1s stereo @44100/128kbps', () => {
    const sr = 44100;
    const buf = encodeMp3([sine(440, sr, 1), sine(440, sr, 1)], sr, 128);
    const bytes = new Uint8Array(buf);
    // ~16KB expected for 128kbps * 1s; assert wide bounds.
    expect(bytes.length).toBeGreaterThan(4000);
    expect(bytes.length).toBeLessThan(64000);
  });

  it('encodes mono input using a single encoder channel', () => {
    const sr = 44100;
    const buf = encodeMp3([sine(220, sr, 0.5)], sr, 192);
    const bytes = new Uint8Array(buf);
    expect(bytes.length).toBeGreaterThan(0);
    expect(bytes[0]).toBe(0xff);
    expect(bytes[1] & 0xe0).toBe(0xe0);
  });

  it('clamps out-of-range samples without throwing', () => {
    const loud = new Float32Array([2, -2, 1.5, -1.5, 0, 0.5, -0.5, 1, -1]);
    expect(() => encodeMp3([loud], 44100, 128)).not.toThrow();
  });

  describe('markers (K3 — ID3v2.3 chapter tag)', () => {
    it('is byte-identical to the marker-less encode when markers is omitted, an empty array, or undefined explicitly', () => {
      const sr = 44100;
      const channels = [sine(440, sr, 0.2), sine(440, sr, 0.2)];
      const bare = new Uint8Array(encodeMp3(channels, sr, 128));
      const explicitUndefined = new Uint8Array(encodeMp3(channels, sr, 128, undefined));
      const emptyArray = new Uint8Array(encodeMp3(channels, sr, 128, []));

      expect(explicitUndefined).toEqual(bare);
      expect(emptyArray).toEqual(bare);
      // Never mistakenly prepends an ID3 tag when there's nothing to write.
      expect(bare[0]).toBe(0xff);
    });

    it('prepends a valid ID3v2.3 tag (buildId3Chapters output) as the first bytes when markers are present', () => {
      const sr = 44100;
      const channels = [sine(440, sr, 0.2), sine(440, sr, 0.2)];
      const markers = [
        { positionSample: 4410, name: 'Intro' },
        { positionSample: 8820, name: 'Verse' },
      ];
      const withMarkers = new Uint8Array(encodeMp3(channels, sr, 128, markers));
      const bare = new Uint8Array(encodeMp3(channels, sr, 128));
      const tag = buildId3Chapters(markers, sr);

      expect(withMarkers.length).toBe(tag.length + bare.length);
      expect(withMarkers.slice(0, tag.length)).toEqual(tag);
      // The audio frames that follow the tag are untouched — same bytes as the
      // marker-less encode, byte for byte.
      expect(withMarkers.slice(tag.length)).toEqual(bare);
    });
  });

  describe('readEncodedFrameSampleRate (unit)', () => {
    it('returns null for bytes that are not a valid frame sync', () => {
      expect(readEncodedFrameSampleRate(new Uint8Array([0, 0, 0]))).toBeNull();
      expect(readEncodedFrameSampleRate(new Uint8Array([0xff, 0x00, 0x00]))).toBeNull(); // sync byte 2 not 111xxxxx
      expect(readEncodedFrameSampleRate(new Uint8Array([0xff, 0xe0]))).toBeNull(); // too short (< 3 bytes)
    });

    it('reads MPEG1/2/2.5 sample rates from synthetic frame headers', () => {
      // byte1 bits (MSB..LSB): 111 VV LL P (V=version, LL=layer=01/LayerIII, P=protection=1/no-CRC).
      const MPEG1_BYTE1 = 0xfb; // version=11
      const MPEG2_BYTE1 = 0xf3; // version=10
      const MPEG25_BYTE1 = 0xe3; // version=00
      // byte2 bits: BBBB RR P X (B=bitrate index, RR=sample-rate index at bits 3-2).
      const rateByte = (r: number) => (r << 2) & 0xff;

      expect(readEncodedFrameSampleRate(new Uint8Array([0xff, MPEG1_BYTE1, rateByte(0)]))).toBe(44100);
      expect(readEncodedFrameSampleRate(new Uint8Array([0xff, MPEG1_BYTE1, rateByte(1)]))).toBe(48000);
      expect(readEncodedFrameSampleRate(new Uint8Array([0xff, MPEG1_BYTE1, rateByte(2)]))).toBe(32000);
      expect(readEncodedFrameSampleRate(new Uint8Array([0xff, MPEG1_BYTE1, rateByte(3)]))).toBeNull(); // reserved

      expect(readEncodedFrameSampleRate(new Uint8Array([0xff, MPEG2_BYTE1, rateByte(0)]))).toBe(22050);
      expect(readEncodedFrameSampleRate(new Uint8Array([0xff, MPEG2_BYTE1, rateByte(1)]))).toBe(24000);
      expect(readEncodedFrameSampleRate(new Uint8Array([0xff, MPEG2_BYTE1, rateByte(2)]))).toBe(16000);

      expect(readEncodedFrameSampleRate(new Uint8Array([0xff, MPEG25_BYTE1, rateByte(0)]))).toBe(11025);
      expect(readEncodedFrameSampleRate(new Uint8Array([0xff, MPEG25_BYTE1, rateByte(1)]))).toBe(12000);
      expect(readEncodedFrameSampleRate(new Uint8Array([0xff, MPEG25_BYTE1, rateByte(2)]))).toBe(8000);
    });
  });

  describe('marker rate rescale is MEASURED from the real encoded frame, not predicted from a table (Fix round 2 / IMPORTANT A)', () => {
    // Every value below was measured against the REAL lamejs encoder (see the
    // task report for the verification script), not assumed. The first four
    // are exactly the non-standard/native import rates decodeAudio.ts
    // deliberately preserves (it never forces a document onto a "standard"
    // rate) where the previous table-mirroring approach (getLameOutputRate,
    // now removed) was measurably wrong by 8-27%. The remaining four are the
    // original F6 standard-rate cases. Each is checked at TWO bitrates,
    // including 96 kbps — below the old table's documented "valid only at
    // kbps >= 128" floor — to prove the new approach is correct regardless of
    // bitrate (it doesn't consult kbps at all; it reads the real output).
    const CASES: Array<[inRate: number, expectedOutRate: number]> = [
      [22254, 24000], // classic Mac
      [18900, 22050], // CD-ROM XA
      [8012, 11025], // telephony
      [11127, 12000],
      [96000, 48000],
      [88200, 48000],
      [44100, 44100],
      [48000, 48000],
    ];

    it.each(CASES.flatMap(([inRate, outRate]) => [
      [inRate, outRate, 192] as const,
      [inRate, outRate, 96] as const, // below Mp3Kbps's UI floor — cast below
    ]))('in=%i -> real encoded rate %i, marker rescaled correctly, at %ikbps', (inRate, expectedOutRate, kbps) => {
      const channels = [sine(440, inRate, 0.05)];
      const posSample = Math.round(inRate * 0.02); // an arbitrary marker position at the doc's rate
      const markers = [{ positionSample: posSample, name: 'M' }];
      // 96 kbps isn't one of this app's UI-offered Mp3Kbps values, but nothing
      // stops a caller from passing it (lamejs itself accepts any bitrate) —
      // cast is deliberate, to exercise the encoder outside its normal type,
      // not a production code path.
      const buf = encodeMp3(channels, inRate, kbps as Mp3Kbps, markers);
      const bytes = new Uint8Array(buf);

      const tagEnd = id3TagLength(bytes);
      expect(frameSampleRate(bytes, tagEnd)).toBe(expectedOutRate);

      const parsed = parseId3Chapters(buf);
      expect(parsed).not.toBeNull();
      expect(parsed![0].exactSample).toBe(Math.round((posSample * expectedOutRate) / inRate));
    });
  });

  describe('marker rate rescale (F6 — TXXX/CHAP land at the true encoded rate)', () => {
    it('rescales marker positions from a 96kHz document to the real 48kHz lamejs output and round-trips via parseId3Chapters', () => {
      const sr = 96000;
      const channels = [sine(440, sr, 0.05)];
      const markers = [
        { positionSample: 48000, name: 'Halfway' }, // 0.5s at the doc's 96kHz rate
      ];
      const buf = encodeMp3(channels, sr, 128, markers);
      const bytes = new Uint8Array(buf);

      const tagEnd = id3TagLength(bytes);
      expect(frameSampleRate(bytes, tagEnd)).toBe(48000); // lamejs really wrote a 48kHz stream

      const parsed = parseId3Chapters(buf);
      expect(parsed).not.toBeNull();
      // 48000 samples at 96kHz = 0.5s = 24000 samples at the true 48kHz file rate.
      expect(parsed![0].exactSample).toBe(24000);
      expect(parsed![0].name).toBe('Halfway');
    });

    it('rescales marker positions from an 88.2kHz document to the real 48kHz lamejs output (not 44.1kHz)', () => {
      const sr = 88200;
      const channels = [sine(440, sr, 0.05)];
      const markers = [{ positionSample: 44100, name: 'Quarter' }]; // 0.5s at 88.2kHz
      const buf = encodeMp3(channels, sr, 128, markers);
      const bytes = new Uint8Array(buf);

      const tagEnd = id3TagLength(bytes);
      expect(frameSampleRate(bytes, tagEnd)).toBe(48000);

      const parsed = parseId3Chapters(buf);
      expect(parsed).not.toBeNull();
      // 44100 samples at 88200Hz = 0.5s = 24000 samples at the true 48kHz file rate.
      expect(parsed![0].exactSample).toBe(24000);
    });

    it('is a no-op (byte-identical TXXX) when the document rate already equals the lamejs output rate (44.1kHz)', () => {
      const sr = 44100;
      const channels = [sine(440, sr, 0.05)];
      const markers = [{ positionSample: 4410, name: 'Tenth' }];
      const withMarkers = new Uint8Array(encodeMp3(channels, sr, 128, markers));
      const tag = buildId3Chapters(markers, sr);
      expect(withMarkers.slice(0, tag.length)).toEqual(tag);
    });
  });
});
