/**
 * @jest-environment node
 */
// Uses the REAL @breezystack/lamejs encoder. The jsdom environment can choke on
// lamejs's module shape, so this file forces the node environment.
import { encodeMp3 } from './mp3Encoder';
import { buildId3Chapters } from './id3Chapters';

function sine(freq: number, sampleRate: number, seconds: number): Float32Array {
  const length = Math.round(sampleRate * seconds);
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    out[i] = 0.5 * Math.sin((2 * Math.PI * freq * i) / sampleRate);
  }
  return out;
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
});
