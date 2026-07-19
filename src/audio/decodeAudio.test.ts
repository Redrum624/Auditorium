import { decodeArrayBuffer, downmixToStereo } from './decodeAudio';
import { encodeWav } from './wavCodec';

class FakeAudioBuffer {
  constructor(
    private chans: Float32Array[],
    public sampleRate: number,
  ) {}
  get numberOfChannels(): number {
    return this.chans.length;
  }
  get length(): number {
    return this.chans[0].length;
  }
  getChannelData(i: number): Float32Array {
    return this.chans[i];
  }
}

let capturedRate = 0;

class MockOfflineAudioContext {
  constructor(_channels: number, _length: number, rate: number) {
    capturedRate = rate;
  }
  async decodeAudioData(_buf: ArrayBuffer): Promise<FakeAudioBuffer> {
    return new FakeAudioBuffer(
      [new Float32Array([0.1, 0.2]), new Float32Array([0.3, 0.4])],
      capturedRate,
    );
  }
}

const clamp = (v: number) => Math.max(-1, Math.min(1, v));

describe('decodeArrayBuffer sample rate', () => {
  const original = (globalThis as unknown as { OfflineAudioContext?: unknown }).OfflineAudioContext;
  beforeEach(() => {
    (globalThis as unknown as { OfflineAudioContext: unknown }).OfflineAudioContext = MockOfflineAudioContext;
    capturedRate = 0;
  });
  afterEach(() => {
    (globalThis as unknown as { OfflineAudioContext?: unknown }).OfflineAudioContext = original;
  });

  it('constructs the OfflineAudioContext at the sniffed native rate', async () => {
    // Valid MPEG1 Layer III 44100 frame header.
    const mp3 = new Uint8Array([0xff, 0xfb, 0x90, 0x00, ...new Array(20).fill(0)]).buffer;
    await decodeArrayBuffer(mp3, 'clip.mp3');
    expect(capturedRate).toBe(44100);
  });

  it('falls back to 48000 when the rate cannot be sniffed', async () => {
    const garbage = new Uint8Array(new Array(64).fill(0)).buffer;
    await decodeArrayBuffer(garbage, 'clip.mp3');
    expect(capturedRate).toBe(48000);
  });

  it('retries at 48000 when the context rejects the sniffed rate', async () => {
    // A corrupt FLAC whose STREAMINFO rate bits are all set sniffs as 1048575,
    // which a real OfflineAudioContext rejects with NotSupportedError.
    const attempted: number[] = [];
    class ThrowingCtx extends MockOfflineAudioContext {
      constructor(channels: number, length: number, rate: number) {
        super(channels, length, rate);
        attempted.push(rate);
        if (rate === 1048575) throw new Error('NotSupportedError: sample rate out of range');
      }
    }
    (globalThis as unknown as { OfflineAudioContext: unknown }).OfflineAudioContext = ThrowingCtx;

    const flac = new Uint8Array(42);
    flac.set([0x66, 0x4c, 0x61, 0x43], 0); // 'fLaC'
    flac[7] = 34; // STREAMINFO length
    flac[18] = 0xff;
    flac[19] = 0xff;
    flac[20] = 0xf0; // 20-bit rate = 1048575

    const result = await decodeArrayBuffer(flac.buffer, 'corrupt.flac');
    expect(attempted).toEqual([1048575, 48000]);
    expect(result.sampleRate).toBe(48000);
  });
});

describe('decodeArrayBuffer markers passthrough (WAV only)', () => {
  it('returns markers decoded from a WAV cue/adtl chunk', async () => {
    const mono = [new Float32Array(100)];
    const buf = encodeWav(mono, 44100, 16, [{ name: 'Hook', positionSample: 42 }]);
    const result = await decodeArrayBuffer(buf, 'song.wav');
    expect(result.markers).toEqual([{ name: 'Hook', positionSample: 42 }]);
  });

  it('returns an empty markers array for a WAV with none', async () => {
    const mono = [new Float32Array(100)];
    const buf = encodeWav(mono, 44100, 16);
    const result = await decodeArrayBuffer(buf, 'song.wav');
    expect(result.markers).toEqual([]);
  });
});

describe('downmixToStereo', () => {
  it('passes through mono and stereo unchanged', () => {
    const ch0 = new Float32Array([0.1, 0.2]);
    const ch1 = new Float32Array([0.3, 0.4]);
    expect(downmixToStereo([ch0])).toEqual([ch0]);
    expect(downmixToStereo([ch0, ch1])).toEqual([ch0, ch1]);
  });

  it('folds extra channels into both L and R at -3 dB with clamping', () => {
    const ch0 = new Float32Array([0.1, -0.2]);
    const ch1 = new Float32Array([0.3, 0.4]);
    const ch2 = new Float32Array([0.5, 0.5]);
    const ch3 = new Float32Array([0.1, -0.1]);
    const [L, R] = downmixToStereo([ch0, ch1, ch2, ch3]);

    const g = Math.SQRT1_2;
    const mix0 = g * ((0.5 + 0.1) / 2);
    const mix1 = g * ((0.5 - 0.1) / 2);
    expect(L[0]).toBeCloseTo(clamp(0.1 + mix0), 5);
    expect(R[0]).toBeCloseTo(clamp(0.3 + mix0), 5);
    expect(L[1]).toBeCloseTo(clamp(-0.2 + mix1), 5);
    expect(R[1]).toBeCloseTo(clamp(0.4 + mix1), 5);
  });

  it('clamps folded output to the ±1 range', () => {
    const [L, R] = downmixToStereo([
      new Float32Array([0.9]),
      new Float32Array([-0.9]),
      new Float32Array([1]),
      new Float32Array([1]),
    ]);
    // 0.9 + 0.7071*1 > 1 -> clamped to 1.
    expect(L[0]).toBe(1);
    expect(R[0]).toBeCloseTo(-0.9 + Math.SQRT1_2, 5);
  });
});
