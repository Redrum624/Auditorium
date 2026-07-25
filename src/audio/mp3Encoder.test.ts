/**
 * @jest-environment node
 */
// Uses the REAL @breezystack/lamejs encoder. The jsdom environment can choke on
// lamejs's module shape, so this file forces the node environment.
import { encodeMp3, getLameOutputRate, type Mp3Kbps } from './mp3Encoder';
import { buildId3Chapters, parseId3Chapters } from './id3Chapters';

// Compile-time guard (Fix round 1 / IMPORTANT 2): getLameOutputRate's tier
// table is only verified correct for kbps >= 128 (measured directly against
// the real encoder: kbps=64/96/112 all give DIFFERENT output rates than this
// table predicts — see getLameOutputRate's doc comment). If Mp3Kbps is ever
// widened to include one of these known-broken low bitrates, the following
// lines fail to TYPECHECK (not just fail a runtime assertion), which fails
// both `npm run typecheck` and this test file's ts-jest compile step — the
// only way to catch a type-level regression that no runtime test can see.
type RejectsKnownBrokenKbps<K extends number> = K extends Mp3Kbps
  ? ['Mp3Kbps must not include this bitrate — getLameOutputRate is documented wrong below 128 kbps', K]
  : true;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _kbpsFloorGuard64: RejectsKnownBrokenKbps<64> = true;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _kbpsFloorGuard96: RejectsKnownBrokenKbps<96> = true;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _kbpsFloorGuard112: RejectsKnownBrokenKbps<112> = true;

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

  describe('getLameOutputRate (F6 — pins the vendored lamejs output-rate mapping)', () => {
    it.each([
      [44100, 44100],
      [48000, 48000],
      [32000, 32000],
      [22050, 22050],
      [96000, 48000],
      // Real vendored behavior, NOT the brief's initial guess of 44100: 88200
      // exceeds the >=48000 tier so it clamps to the ceiling rather than
      // falling through — see the getLameOutputRate doc comment for the
      // exact vendored-source derivation.
      [88200, 48000],
    ])('%i -> %i', (inRate, expected) => {
      expect(getLameOutputRate(inRate)).toBe(expected);
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
