import { encodeWav, decodeWav, WavBitDepth } from './wavCodec';

function sineWave(freq: number, seconds: number, sampleRate: number): Float32Array {
  const length = Math.round(seconds * sampleRate);
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    out[i] = Math.sin((2 * Math.PI * freq * i) / sampleRate);
  }
  return out;
}

function readAscii(view: DataView, offset: number, length: number): string {
  let s = '';
  for (let i = 0; i < length; i++) {
    s += String.fromCharCode(view.getUint8(offset + i));
  }
  return s;
}

function writeAscii(view: DataView, offset: number, str: string): void {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}

function toleranceFor(bitDepth: WavBitDepth): number {
  if (bitDepth === 16) return (1 / 32768) * 1.01;
  if (bitDepth === 24) return (1 / 8388608) * 1.01;
  return 0; // 32-bit float: exact
}

function expectChannelsClose(actual: Float32Array[], expected: Float32Array[], tolerance: number): void {
  expect(actual).toHaveLength(expected.length);
  for (let ch = 0; ch < expected.length; ch++) {
    expect(actual[ch]).toHaveLength(expected[ch].length);
    for (let i = 0; i < expected[ch].length; i++) {
      if (tolerance === 0) {
        expect(actual[ch][i]).toBe(expected[ch][i]);
      } else {
        expect(Math.abs(actual[ch][i] - expected[ch][i])).toBeLessThanOrEqual(tolerance);
      }
    }
  }
}

const SAMPLE_RATE = 44100;
const DURATION = 0.01; // 441 frames

describe('encodeWav / decodeWav round trip', () => {
  const bitDepths: WavBitDepth[] = [16, 24, 32];

  for (const bitDepth of bitDepths) {
    it(`round-trips a mono ${bitDepth}-bit sine wave within tolerance`, () => {
      const mono = [sineWave(440, DURATION, SAMPLE_RATE)];
      const buf = encodeWav(mono, SAMPLE_RATE, bitDepth);
      const decoded = decodeWav(buf);
      expect(decoded.sampleRate).toBe(SAMPLE_RATE);
      expect(decoded.bitDepth).toBe(bitDepth);
      expectChannelsClose(decoded.channels, mono, toleranceFor(bitDepth));
    });

    it(`round-trips a stereo ${bitDepth}-bit sine wave within tolerance`, () => {
      const left = sineWave(440, DURATION, SAMPLE_RATE);
      const right = sineWave(220, DURATION, SAMPLE_RATE);
      const stereo = [left, right];
      const buf = encodeWav(stereo, SAMPLE_RATE, bitDepth);
      const decoded = decodeWav(buf);
      expect(decoded.sampleRate).toBe(SAMPLE_RATE);
      expect(decoded.bitDepth).toBe(bitDepth);
      expectChannelsClose(decoded.channels, stereo, toleranceFor(bitDepth));
    });
  }
});

describe('encodeWav header format', () => {
  it('writes RIFF/WAVE magic bytes', () => {
    const buf = encodeWav([sineWave(440, DURATION, SAMPLE_RATE)], SAMPLE_RATE, 16);
    const view = new DataView(buf);
    expect(readAscii(view, 0, 4)).toBe('RIFF');
    expect(readAscii(view, 8, 4)).toBe('WAVE');
  });

  it('writes audioFormat 1 (PCM) for 16-bit', () => {
    const buf = encodeWav([sineWave(440, DURATION, SAMPLE_RATE)], SAMPLE_RATE, 16);
    const view = new DataView(buf);
    expect(view.getUint16(20, true)).toBe(1);
  });

  it('writes audioFormat 1 (PCM) for 24-bit', () => {
    const buf = encodeWav([sineWave(440, DURATION, SAMPLE_RATE)], SAMPLE_RATE, 24);
    const view = new DataView(buf);
    expect(view.getUint16(20, true)).toBe(1);
  });

  it('writes audioFormat 3 (IEEE float) for 32-bit', () => {
    const buf = encodeWav([sineWave(440, DURATION, SAMPLE_RATE)], SAMPLE_RATE, 32);
    const view = new DataView(buf);
    expect(view.getUint16(20, true)).toBe(3);
  });

  it('writes a data chunk size of frames * channels * bytesPerSample', () => {
    const left = sineWave(440, DURATION, SAMPLE_RATE);
    const right = sineWave(220, DURATION, SAMPLE_RATE);
    const buf = encodeWav([left, right], SAMPLE_RATE, 24);
    const view = new DataView(buf);
    // chunk header 'data' is at offset 36 for a plain fmt(16)+data layout
    expect(readAscii(view, 36, 4)).toBe('data');
    const dataSize = view.getUint32(40, true);
    expect(dataSize).toBe(left.length * 2 * 3);
  });
});

describe('decodeWav error handling', () => {
  it('rejects a non-RIFF buffer with "Not a WAV file"', () => {
    const buf = new ArrayBuffer(16);
    const view = new DataView(buf);
    writeAscii(view, 0, 'JUNK');
    expect(() => decodeWav(buf)).toThrow(new Error('Not a WAV file'));
  });

  it('rejects a RIFF buffer that is not WAVE with "Not a WAV file"', () => {
    const buf = new ArrayBuffer(16);
    const view = new DataView(buf);
    writeAscii(view, 0, 'RIFF');
    view.setUint32(4, 8, true);
    writeAscii(view, 8, 'AVI ');
    expect(() => decodeWav(buf)).toThrow(new Error('Not a WAV file'));
  });

  it('rejects an unsupported fmt audio format code', () => {
    const buf = buildFmtOnlyWav({ audioFormat: 2, numChannels: 1, sampleRate: SAMPLE_RATE, bitsPerSample: 16 });
    expect(() => decodeWav(buf)).toThrow('Unsupported WAV audio format code: 2');
  });

  it('rejects PCM (fmt=1) with an unsupported bit depth', () => {
    const buf = buildFmtOnlyWav({ audioFormat: 1, numChannels: 1, sampleRate: SAMPLE_RATE, bitsPerSample: 12 });
    expect(() => decodeWav(buf)).toThrow('Unsupported PCM bit depth: 12');
  });

  it('rejects IEEE float (fmt=3) with bits other than 32', () => {
    const buf = buildFmtOnlyWav({ audioFormat: 3, numChannels: 1, sampleRate: SAMPLE_RATE, bitsPerSample: 16 });
    expect(() => decodeWav(buf)).toThrow('Unsupported IEEE float bit depth: 16');
  });

  it('rejects a buffer cut off in the middle of the fmt chunk with a clean Error', () => {
    const full = buildFmtOnlyWav({ audioFormat: 1, numChannels: 1, sampleRate: SAMPLE_RATE, bitsPerSample: 16 });
    // Keep RIFF header (12) + fmt chunk header (8) but only 6 of the 16 declared fmt bytes.
    const truncated = full.slice(0, 12 + 8 + 6);
    expect(() => decodeWav(truncated)).toThrow('truncated fmt chunk');
  });

  it('rejects a fmt chunk whose declared size is smaller than 16 with a clean Error', () => {
    const buf = buildFmtOnlyWav({ audioFormat: 1, numChannels: 1, sampleRate: SAMPLE_RATE, bitsPerSample: 16 });
    const view = new DataView(buf);
    view.setUint32(16, 12, true); // lie: fmt chunkSize = 12 (< minimum 16)
    expect(() => decodeWav(buf)).toThrow('truncated fmt chunk');
  });
});

describe('encodeWav clipping', () => {
  it('clamps an out-of-range sample (1.5) to 32767 at 16-bit', () => {
    const buf = encodeWav([Float32Array.from([1.5])], SAMPLE_RATE, 16);
    const view = new DataView(buf);
    const sample = view.getInt16(44, true);
    expect(sample).toBe(32767);
  });

  it('clamps a negative out-of-range sample (-1.5) to -32768 at 16-bit', () => {
    const buf = encodeWav([Float32Array.from([-1.5])], SAMPLE_RATE, 16);
    const view = new DataView(buf);
    const sample = view.getInt16(44, true);
    expect(sample).toBe(-32768);
  });
});

describe('decodeWav clamping', () => {
  it('clamps a foreign full-scale 16-bit sample (-32768) to exactly -1', () => {
    // Foreign encoders using a /32768 write scale can emit -32768; after our
    // symmetric /32767 normalization that would be ~-1.0000305 without clamping.
    const buf = buildRaw16BitWav([-32768, 32767, 0], SAMPLE_RATE);
    const decoded = decodeWav(buf);
    expect(decoded.channels[0][0]).toBe(-1);
    expect(decoded.channels[0][1]).toBe(1);
    expect(decoded.channels[0][2]).toBe(0);
  });
});

describe('decodeWav with extra chunks before data', () => {
  it('skips a LIST chunk (with odd-length payload requiring a pad byte) to find data', () => {
    const samples = sineWave(440, DURATION, SAMPLE_RATE);
    const buf = buildWavWithListChunk(samples, SAMPLE_RATE);
    const decoded = decodeWav(buf);
    expect(decoded.sampleRate).toBe(SAMPLE_RATE);
    expect(decoded.bitDepth).toBe(16);
    expectChannelsClose(decoded.channels, [samples], toleranceFor(16));
  });
});

/** Builds a minimal WAV buffer containing only RIFF/WAVE + a fmt chunk (no data), for testing fmt validation. */
function buildFmtOnlyWav(fmt: {
  audioFormat: number;
  numChannels: number;
  sampleRate: number;
  bitsPerSample: number;
}): ArrayBuffer {
  const blockAlign = fmt.numChannels * (fmt.bitsPerSample / 8);
  const byteRate = fmt.sampleRate * blockAlign;
  const buffer = new ArrayBuffer(12 + 8 + 16);
  const view = new DataView(buffer);
  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, buffer.byteLength - 8, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, fmt.audioFormat, true);
  view.setUint16(22, fmt.numChannels, true);
  view.setUint32(24, fmt.sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, fmt.bitsPerSample, true);
  return buffer;
}

/** Builds a mono 16-bit PCM WAV from raw int16 sample values (no float scaling), as a foreign encoder would. */
function buildRaw16BitWav(rawSamples: number[], sampleRate: number): ArrayBuffer {
  const dataSize = rawSamples.length * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, buffer.byteLength - 8, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataSize, true);
  for (let i = 0; i < rawSamples.length; i++) {
    view.setInt16(44 + i * 2, rawSamples[i], true);
  }
  return buffer;
}

/** Builds a mono 16-bit PCM WAV with a LIST chunk (odd-length payload) inserted between fmt and data. */
function buildWavWithListChunk(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const bytesPerSample = 2;
  const dataSize = samples.length * bytesPerSample;
  const listContent = 'INFOx'; // odd length (5 bytes) to exercise pad-byte handling
  const listSize = listContent.length;
  const listPadded = listSize + (listSize % 2);
  const totalSize = 12 + (8 + 16) + (8 + listPadded) + (8 + dataSize);
  const buffer = new ArrayBuffer(totalSize);
  const view = new DataView(buffer);
  let offset = 0;

  writeAscii(view, offset, 'RIFF');
  offset += 4;
  view.setUint32(offset, totalSize - 8, true);
  offset += 4;
  writeAscii(view, offset, 'WAVE');
  offset += 4;

  writeAscii(view, offset, 'fmt ');
  offset += 4;
  view.setUint32(offset, 16, true);
  offset += 4;
  view.setUint16(offset, 1, true); // PCM
  offset += 2;
  view.setUint16(offset, 1, true); // mono
  offset += 2;
  view.setUint32(offset, sampleRate, true);
  offset += 4;
  view.setUint32(offset, sampleRate * bytesPerSample, true); // byteRate
  offset += 4;
  view.setUint16(offset, bytesPerSample, true); // blockAlign
  offset += 2;
  view.setUint16(offset, 16, true); // bitsPerSample
  offset += 2;

  writeAscii(view, offset, 'LIST');
  offset += 4;
  view.setUint32(offset, listSize, true);
  offset += 4;
  writeAscii(view, offset, listContent);
  offset += listSize;
  if (listSize % 2 === 1) {
    view.setUint8(offset, 0);
    offset += 1;
  }

  writeAscii(view, offset, 'data');
  offset += 4;
  view.setUint32(offset, dataSize, true);
  offset += 4;
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767)));
    view.setInt16(offset, clamped, true);
    offset += 2;
  }

  return buffer;
}
