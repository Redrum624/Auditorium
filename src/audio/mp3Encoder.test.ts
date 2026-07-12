/**
 * @jest-environment node
 */
// Uses the REAL @breezystack/lamejs encoder. The jsdom environment can choke on
// lamejs's module shape, so this file forces the node environment.
import { encodeMp3 } from './mp3Encoder';

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
});
