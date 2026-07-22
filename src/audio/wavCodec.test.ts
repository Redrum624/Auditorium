import { encodeWav, decodeWav, WavBitDepth, WavMarker } from './wavCodec';

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

describe('encodeWav with no markers is byte-identical to the pre-marker encoder', () => {
  it('produces the same bytes whether markers is omitted, undefined, or an empty array', () => {
    const stereo = [sineWave(440, DURATION, SAMPLE_RATE), sineWave(220, DURATION, SAMPLE_RATE)];
    const noArg = encodeWav(stereo, SAMPLE_RATE, 24);
    const undefinedArg = encodeWav(stereo, SAMPLE_RATE, 24, undefined);
    const emptyArg = encodeWav(stereo, SAMPLE_RATE, 24, []);
    expect(new Uint8Array(undefinedArg)).toEqual(new Uint8Array(noArg));
    expect(new Uint8Array(emptyArg)).toEqual(new Uint8Array(noArg));
  });

  it('total length stays exactly 44 + dataSize (no cue/LIST chunks appended)', () => {
    const mono = [sineWave(440, DURATION, SAMPLE_RATE)];
    const buf = encodeWav(mono, SAMPLE_RATE, 16, []);
    expect(buf.byteLength).toBe(44 + mono[0].length * 2);
  });
});

describe('encodeWav / decodeWav markers round trip', () => {
  const markers: WavMarker[] = [
    { name: 'Intro', positionSample: 100 },
    { name: 'Verse 1', positionSample: 4410 },
    { name: 'Chorus', positionSample: 8820 },
  ];

  it('round-trips marker names and positions, sorted by position', () => {
    const mono = [sineWave(440, DURATION * 3, SAMPLE_RATE)];
    const buf = encodeWav(mono, SAMPLE_RATE, 16, markers);
    const decoded = decodeWav(buf);
    expect(decoded.markers).toEqual([
      { name: 'Intro', positionSample: 100 },
      { name: 'Verse 1', positionSample: 4410 },
      { name: 'Chorus', positionSample: 8820 },
    ]);
  });

  it('returns markers already sorted even when encoded out of position order', () => {
    const mono = [sineWave(440, DURATION * 3, SAMPLE_RATE)];
    const outOfOrder: WavMarker[] = [
      { name: 'Chorus', positionSample: 8820 },
      { name: 'Intro', positionSample: 100 },
      { name: 'Verse 1', positionSample: 4410 },
    ];
    const buf = encodeWav(mono, SAMPLE_RATE, 16, outOfOrder);
    const decoded = decodeWav(buf);
    expect(decoded.channels).toBeDefined(); // sanity: still a valid decode
    expect(decoded.markers.map((m) => m.positionSample)).toEqual([100, 4410, 8820]);
  });

  it('returns an empty markers array when the WAV has none', () => {
    const mono = [sineWave(440, DURATION, SAMPLE_RATE)];
    const buf = encodeWav(mono, SAMPLE_RATE, 16);
    const decoded = decodeWav(buf);
    expect(decoded.markers).toEqual([]);
  });

  it('RIFF size accounts for the appended cue + LIST/adtl chunks', () => {
    const mono = [sineWave(440, DURATION, SAMPLE_RATE)];
    const buf = encodeWav(mono, SAMPLE_RATE, 16, [{ name: 'M', positionSample: 5 }]);
    const view = new DataView(buf);
    expect(view.getUint32(4, true)).toBe(buf.byteLength - 8);
  });
});

describe('encodeWav cue/LIST chunk structural layout (Audacity/Audition-compatible)', () => {
  it('writes a well-formed cue chunk: dwName 1-based index, dwSampleOffset=position, fccChunk=data, other fields 0', () => {
    const mono = [sineWave(440, DURATION, SAMPLE_RATE)];
    const markersIn: WavMarker[] = [
      { name: 'A', positionSample: 10 },
      { name: 'B', positionSample: 20 },
    ];
    const buf = encodeWav(mono, SAMPLE_RATE, 16, markersIn);
    const view = new DataView(buf);
    const dataSize = mono[0].length * 2;
    let offset = 44 + dataSize; // data chunk ends here (even, 16-bit mono -> no pad needed)

    expect(readAscii(view, offset, 4)).toBe('cue ');
    const cueChunkSize = view.getUint32(offset + 4, true);
    expect(cueChunkSize).toBe(4 + markersIn.length * 24);
    const numCuePoints = view.getUint32(offset + 8, true);
    expect(numCuePoints).toBe(2);

    const cueDataStart = offset + 12;
    for (let i = 0; i < markersIn.length; i++) {
      const base = cueDataStart + i * 24;
      expect(view.getUint32(base, true)).toBe(i + 1); // dwName, 1-based
      expect(view.getUint32(base + 4, true)).toBe(0); // dwPosition
      expect(readAscii(view, base + 8, 4)).toBe('data'); // fccChunk
      expect(view.getUint32(base + 12, true)).toBe(0); // dwChunkStart
      expect(view.getUint32(base + 16, true)).toBe(0); // dwBlockStart
      expect(view.getUint32(base + 20, true)).toBe(markersIn[i].positionSample); // dwSampleOffset
    }
  });

  it('writes a LIST/adtl chunk with one NUL-terminated, word-aligned labl per marker matching cue dwName', () => {
    const mono = [sineWave(440, DURATION, SAMPLE_RATE)];
    // 'AB' -> odd payload (4 + 2 + 1 = 7) forces a pad byte; 'CDE' -> even payload (4+3+1=8) needs none.
    const markersIn: WavMarker[] = [
      { name: 'AB', positionSample: 1 },
      { name: 'CDE', positionSample: 2 },
    ];
    const buf = encodeWav(mono, SAMPLE_RATE, 16, markersIn);
    const view = new DataView(buf);
    const dataSize = mono[0].length * 2;
    const cueChunkTotal = 8 + (4 + markersIn.length * 24);
    let offset = 44 + dataSize + cueChunkTotal;

    expect(readAscii(view, offset, 4)).toBe('LIST');
    const listSize = view.getUint32(offset + 4, true);
    expect(readAscii(view, offset + 8, 4)).toBe('adtl');

    let sub = offset + 12;
    const listEnd = offset + 8 + listSize;

    expect(readAscii(view, sub, 4)).toBe('labl');
    const size0 = view.getUint32(sub + 4, true);
    expect(size0).toBe(4 + 'AB'.length + 1); // dwName + text + NUL = 7 (odd)
    expect(view.getUint32(sub + 8, true)).toBe(1); // dwName matches cue point 1
    expect(readAscii(view, sub + 12, 2)).toBe('AB');
    expect(view.getUint8(sub + 12 + 2)).toBe(0); // NUL terminator
    expect(view.getUint8(sub + 12 + 2 + 1)).toBe(0); // pad byte (size0 is odd)
    sub += 8 + size0 + (size0 % 2);

    expect(readAscii(view, sub, 4)).toBe('labl');
    const size1 = view.getUint32(sub + 4, true);
    expect(size1).toBe(4 + 'CDE'.length + 1); // 8, even — no pad
    expect(view.getUint32(sub + 8, true)).toBe(2); // dwName matches cue point 2
    expect(readAscii(view, sub + 12, 3)).toBe('CDE');
    expect(view.getUint8(sub + 12 + 3)).toBe(0);
    sub += 8 + size1 + (size1 % 2);

    expect(sub).toBe(listEnd);
    expect(listEnd).toBe(buf.byteLength);
  });

  it('inserts a data-chunk pad byte before cue when dataSize is odd (24-bit mono, odd frame count)', () => {
    // 3 bytes/frame * odd frame count -> odd dataSize.
    const oddFrames = 7;
    const mono = [Float32Array.from({ length: oddFrames }, (_, i) => (i - 3) / 8)];
    const buf = encodeWav(mono, SAMPLE_RATE, 24, [{ name: 'X', positionSample: 0 }]);
    const view = new DataView(buf);
    const dataSize = oddFrames * 3;
    expect(dataSize % 2).toBe(1);
    // pad byte at 44+dataSize, then 'cue ' at 44+dataSize+1
    expect(readAscii(view, 44 + dataSize + 1, 4)).toBe('cue ');
  });
});

describe('decodeWav marker tolerance', () => {
  it('reads cue points that appear BEFORE the data chunk', () => {
    const samples = sineWave(440, DURATION, SAMPLE_RATE);
    const buf = buildWavWithCueBeforeData(samples, SAMPLE_RATE, [{ name: 'Early', positionSample: 7 }]);
    const decoded = decodeWav(buf);
    expect(decoded.markers).toEqual([{ name: 'Early', positionSample: 7 }]);
  });

  it('defaults a cue point with no matching labl to "Marker N" (N = 1-based dwName)', () => {
    const samples = sineWave(440, DURATION, SAMPLE_RATE);
    const buf = buildWavWithCueOnlyNoLabels(samples, SAMPLE_RATE, [42, 99]);
    const decoded = decodeWav(buf);
    expect(decoded.markers).toEqual([
      { name: 'Marker 42', positionSample: 42 },
      { name: 'Marker 99', positionSample: 99 },
    ]);
  });

  it('tolerates an unknown sub-chunk inside LIST/adtl alongside labl', () => {
    const samples = sineWave(440, DURATION, SAMPLE_RATE);
    const buf = buildWavWithUnknownAdtlSubchunk(samples, SAMPLE_RATE);
    const decoded = decodeWav(buf);
    expect(decoded.markers).toEqual([{ name: 'Note', positionSample: 3 }]);
  });
});

describe('decodeWav cue chunk bounded by declared chunk size (H2 hardening)', () => {
  it('ignores decoy cue-point bytes beyond the declared chunk size even though numCuePoints lies about how many points follow', () => {
    const samples = sineWave(440, DURATION, SAMPLE_RATE);
    const buf = buildWavWithOversizedCueChunk(samples, SAMPLE_RATE);
    const decoded = decodeWav(buf);
    // Only the single cue point that physically fits inside the declared
    // chunkSize (28 bytes: 4B count + 1x24B point) may be decoded.
    expect(decoded.markers).toEqual([{ name: 'Marker 1', positionSample: 5 }]);
    // The decoy points sit right after the chunk's declared end (still within
    // view.byteLength) and must never be interpreted as cues.
    expect(decoded.markers.some((m) => m.positionSample === 999999)).toBe(false);
  });

  it('does not throw on a cue chunk truncated at the buffer end; decodes only the points that physically fit', () => {
    const samples = sineWave(440, DURATION, SAMPLE_RATE);
    const buf = buildWavWithTruncatedCueChunk(samples, SAMPLE_RATE);
    expect(() => decodeWav(buf)).not.toThrow();
    const decoded = decodeWav(buf);
    // The chunk header lies (declares room for 3 points, numCuePoints claims
    // 3) but the buffer physically ends after only 1 full 24-byte point.
    expect(decoded.markers).toEqual([{ name: 'Marker 1', positionSample: 9 }]);
  });
});

/** Builds a mono 16-bit PCM WAV with a 'cue ' chunk placed BEFORE 'data'. */
function buildWavWithCueBeforeData(
  samples: Float32Array,
  sampleRate: number,
  markers: { name: string; positionSample: number }[]
): ArrayBuffer {
  const bytesPerSample = 2;
  const dataSize = samples.length * bytesPerSample;
  const cuePayloadSize = 4 + markers.length * 24;
  const labelSizes = markers.map((m) => 4 + m.name.length + 1);
  const listPayloadSize = 4 + labelSizes.reduce((sum, size) => sum + 8 + size + (size % 2), 0);
  const totalSize =
    12 + (8 + 16) + (8 + cuePayloadSize) + (8 + listPayloadSize) + (8 + dataSize);
  const buffer = new ArrayBuffer(totalSize);
  const view = new DataView(buffer);
  let offset = 0;

  writeAscii(view, offset, 'RIFF'); offset += 4;
  view.setUint32(offset, totalSize - 8, true); offset += 4;
  writeAscii(view, offset, 'WAVE'); offset += 4;

  writeAscii(view, offset, 'fmt '); offset += 4;
  view.setUint32(offset, 16, true); offset += 4;
  view.setUint16(offset, 1, true); offset += 2; // PCM
  view.setUint16(offset, 1, true); offset += 2; // mono
  view.setUint32(offset, sampleRate, true); offset += 4;
  view.setUint32(offset, sampleRate * bytesPerSample, true); offset += 4;
  view.setUint16(offset, bytesPerSample, true); offset += 2;
  view.setUint16(offset, 16, true); offset += 2;

  writeAscii(view, offset, 'cue '); offset += 4;
  view.setUint32(offset, cuePayloadSize, true); offset += 4;
  view.setUint32(offset, markers.length, true); offset += 4;
  markers.forEach((m, i) => {
    view.setUint32(offset, i + 1, true); offset += 4; // dwName
    view.setUint32(offset, 0, true); offset += 4; // dwPosition
    writeAscii(view, offset, 'data'); offset += 4;
    view.setUint32(offset, 0, true); offset += 4;
    view.setUint32(offset, 0, true); offset += 4;
    view.setUint32(offset, m.positionSample, true); offset += 4;
  });

  writeAscii(view, offset, 'LIST'); offset += 4;
  view.setUint32(offset, listPayloadSize, true); offset += 4;
  writeAscii(view, offset, 'adtl'); offset += 4;
  markers.forEach((m, i) => {
    const size = labelSizes[i];
    writeAscii(view, offset, 'labl'); offset += 4;
    view.setUint32(offset, size, true); offset += 4;
    view.setUint32(offset, i + 1, true); offset += 4; // dwName matches cue point
    writeAscii(view, offset, m.name); offset += m.name.length;
    view.setUint8(offset, 0); offset += 1;
    if (size % 2 !== 0) {
      view.setUint8(offset, 0);
      offset += 1;
    }
  });

  writeAscii(view, offset, 'data'); offset += 4;
  view.setUint32(offset, dataSize, true); offset += 4;
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767)));
    view.setInt16(offset, clamped, true);
    offset += 2;
  }

  return buffer;
}

/** Builds a mono 16-bit PCM WAV with a 'cue ' chunk (no LIST/adtl at all), each cue's dwName = its own value. */
function buildWavWithCueOnlyNoLabels(samples: Float32Array, sampleRate: number, dwNames: number[]): ArrayBuffer {
  const bytesPerSample = 2;
  const dataSize = samples.length * bytesPerSample;
  const cuePayloadSize = 4 + dwNames.length * 24;
  const totalSize = 12 + (8 + 16) + (8 + dataSize) + (8 + cuePayloadSize);
  const buffer = new ArrayBuffer(totalSize);
  const view = new DataView(buffer);
  let offset = 0;

  writeAscii(view, offset, 'RIFF'); offset += 4;
  view.setUint32(offset, totalSize - 8, true); offset += 4;
  writeAscii(view, offset, 'WAVE'); offset += 4;

  writeAscii(view, offset, 'fmt '); offset += 4;
  view.setUint32(offset, 16, true); offset += 4;
  view.setUint16(offset, 1, true); offset += 2;
  view.setUint16(offset, 1, true); offset += 2;
  view.setUint32(offset, sampleRate, true); offset += 4;
  view.setUint32(offset, sampleRate * bytesPerSample, true); offset += 4;
  view.setUint16(offset, bytesPerSample, true); offset += 2;
  view.setUint16(offset, 16, true); offset += 2;

  writeAscii(view, offset, 'data'); offset += 4;
  view.setUint32(offset, dataSize, true); offset += 4;
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767)));
    view.setInt16(offset, clamped, true);
    offset += 2;
  }

  writeAscii(view, offset, 'cue '); offset += 4;
  view.setUint32(offset, cuePayloadSize, true); offset += 4;
  view.setUint32(offset, dwNames.length, true); offset += 4;
  for (const n of dwNames) {
    view.setUint32(offset, n, true); offset += 4; // dwName = the cue point's own "position" value here
    view.setUint32(offset, 0, true); offset += 4;
    writeAscii(view, offset, 'data'); offset += 4;
    view.setUint32(offset, 0, true); offset += 4;
    view.setUint32(offset, 0, true); offset += 4;
    view.setUint32(offset, n, true); offset += 4; // dwSampleOffset
  }

  return buffer;
}

/** Builds a mono 16-bit PCM WAV whose LIST/adtl chunk has an unrecognized sub-chunk ('note') before its single 'labl'. */
function buildWavWithUnknownAdtlSubchunk(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const bytesPerSample = 2;
  const dataSize = samples.length * bytesPerSample;
  const cuePayloadSize = 4 + 1 * 24;
  const notePayload = 'hi'; // 2 bytes, even -> no pad
  const noteChunkTotal = 8 + notePayload.length;
  const lablName = 'Note';
  const lablPayloadSize = 4 + lablName.length + 1; // 4+4+1=9, odd -> 1 pad byte
  const lablChunkTotal = 8 + lablPayloadSize + (lablPayloadSize % 2);
  const listPayloadSize = 4 + noteChunkTotal + lablChunkTotal;
  const totalSize = 12 + (8 + 16) + (8 + dataSize) + (8 + cuePayloadSize) + (8 + listPayloadSize);
  const buffer = new ArrayBuffer(totalSize);
  const view = new DataView(buffer);
  let offset = 0;

  writeAscii(view, offset, 'RIFF'); offset += 4;
  view.setUint32(offset, totalSize - 8, true); offset += 4;
  writeAscii(view, offset, 'WAVE'); offset += 4;

  writeAscii(view, offset, 'fmt '); offset += 4;
  view.setUint32(offset, 16, true); offset += 4;
  view.setUint16(offset, 1, true); offset += 2;
  view.setUint16(offset, 1, true); offset += 2;
  view.setUint32(offset, sampleRate, true); offset += 4;
  view.setUint32(offset, sampleRate * bytesPerSample, true); offset += 4;
  view.setUint16(offset, bytesPerSample, true); offset += 2;
  view.setUint16(offset, 16, true); offset += 2;

  writeAscii(view, offset, 'data'); offset += 4;
  view.setUint32(offset, dataSize, true); offset += 4;
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767)));
    view.setInt16(offset, clamped, true);
    offset += 2;
  }

  writeAscii(view, offset, 'cue '); offset += 4;
  view.setUint32(offset, cuePayloadSize, true); offset += 4;
  view.setUint32(offset, 1, true); offset += 4;
  view.setUint32(offset, 1, true); offset += 4; // dwName
  view.setUint32(offset, 0, true); offset += 4;
  writeAscii(view, offset, 'data'); offset += 4;
  view.setUint32(offset, 0, true); offset += 4;
  view.setUint32(offset, 0, true); offset += 4;
  view.setUint32(offset, 3, true); offset += 4; // dwSampleOffset = 3

  writeAscii(view, offset, 'LIST'); offset += 4;
  view.setUint32(offset, listPayloadSize, true); offset += 4;
  writeAscii(view, offset, 'adtl'); offset += 4;

  writeAscii(view, offset, 'note'); offset += 4;
  view.setUint32(offset, notePayload.length, true); offset += 4;
  writeAscii(view, offset, notePayload); offset += notePayload.length;

  writeAscii(view, offset, 'labl'); offset += 4;
  view.setUint32(offset, lablPayloadSize, true); offset += 4;
  view.setUint32(offset, 1, true); offset += 4; // dwName matches the cue point
  writeAscii(view, offset, lablName); offset += lablName.length;
  view.setUint8(offset, 0); offset += 1;
  if (lablPayloadSize % 2 === 1) {
    view.setUint8(offset, 0);
    offset += 1;
  }

  return buffer;
}

/** Builds a mono 16-bit PCM WAV whose 'cue ' chunk header declares a chunkSize
 *  that only holds 1 cue point (28 bytes: 4B count + 1x24B point), but whose
 *  numCuePoints field lies and claims 5. Immediately after the chunk's
 *  DECLARED end (still within view.byteLength) sit 4 decoy 24-byte records
 *  with a recognizable dwSampleOffset (999999) that must never be decoded as
 *  markers — only bytes within chunkDataStart + chunkSize are eligible. */
function buildWavWithOversizedCueChunk(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const bytesPerSample = 2;
  const dataSize = samples.length * bytesPerSample;
  const realCueChunkSize = 4 + 1 * 24; // declares room for exactly 1 cue point
  const decoyPointCount = 4; // decoy bytes for the 4 extra points numCuePoints (5) lies about
  const decoyBytes = decoyPointCount * 24;
  const totalSize = 12 + (8 + 16) + (8 + dataSize) + (8 + realCueChunkSize) + decoyBytes;
  const buffer = new ArrayBuffer(totalSize);
  const view = new DataView(buffer);
  let offset = 0;

  writeAscii(view, offset, 'RIFF'); offset += 4;
  view.setUint32(offset, totalSize - 8, true); offset += 4;
  writeAscii(view, offset, 'WAVE'); offset += 4;

  writeAscii(view, offset, 'fmt '); offset += 4;
  view.setUint32(offset, 16, true); offset += 4;
  view.setUint16(offset, 1, true); offset += 2;
  view.setUint16(offset, 1, true); offset += 2;
  view.setUint32(offset, sampleRate, true); offset += 4;
  view.setUint32(offset, sampleRate * bytesPerSample, true); offset += 4;
  view.setUint16(offset, bytesPerSample, true); offset += 2;
  view.setUint16(offset, 16, true); offset += 2;

  writeAscii(view, offset, 'data'); offset += 4;
  view.setUint32(offset, dataSize, true); offset += 4;
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767)));
    view.setInt16(offset, clamped, true);
    offset += 2;
  }

  writeAscii(view, offset, 'cue '); offset += 4;
  view.setUint32(offset, realCueChunkSize, true); offset += 4; // declares room for only 1 point
  view.setUint32(offset, 5, true); offset += 4; // numCuePoints LIES: claims 5
  // the one cue point that actually fits within the declared chunk size
  view.setUint32(offset, 1, true); offset += 4; // dwName
  view.setUint32(offset, 0, true); offset += 4; // dwPosition
  writeAscii(view, offset, 'data'); offset += 4; // fccChunk
  view.setUint32(offset, 0, true); offset += 4; // dwChunkStart
  view.setUint32(offset, 0, true); offset += 4; // dwBlockStart
  view.setUint32(offset, 5, true); offset += 4; // dwSampleOffset = 5 (the real marker)

  // Decoy bytes, immediately after the DECLARED end of the cue chunk but
  // still inside view.byteLength.
  for (let i = 0; i < decoyPointCount; i++) {
    view.setUint32(offset, 77, true); offset += 4; // decoy dwName
    view.setUint32(offset, 0, true); offset += 4;
    writeAscii(view, offset, 'JUNK'); offset += 4;
    view.setUint32(offset, 0, true); offset += 4;
    view.setUint32(offset, 0, true); offset += 4;
    view.setUint32(offset, 999999, true); offset += 4; // decoy dwSampleOffset — must never surface
  }

  return buffer;
}

/** Builds a mono 16-bit PCM WAV whose 'cue ' chunk header lies: it declares a
 *  chunkSize and numCuePoints that together claim 3 cue points, but the
 *  buffer physically ends right after the first (and only) full 24-byte
 *  point. Exercises truncation-at-buffer-end tolerance. */
function buildWavWithTruncatedCueChunk(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const bytesPerSample = 2;
  const dataSize = samples.length * bytesPerSample;
  const declaredCueChunkSize = 4 + 3 * 24; // header LIES: claims room for 3 points
  const physicalCuePayload = 4 + 1 * 24; // only 1 point is physically present
  const totalSize = 12 + (8 + 16) + (8 + dataSize) + (8 + physicalCuePayload);
  const buffer = new ArrayBuffer(totalSize);
  const view = new DataView(buffer);
  let offset = 0;

  writeAscii(view, offset, 'RIFF'); offset += 4;
  view.setUint32(offset, totalSize - 8, true); offset += 4;
  writeAscii(view, offset, 'WAVE'); offset += 4;

  writeAscii(view, offset, 'fmt '); offset += 4;
  view.setUint32(offset, 16, true); offset += 4;
  view.setUint16(offset, 1, true); offset += 2;
  view.setUint16(offset, 1, true); offset += 2;
  view.setUint32(offset, sampleRate, true); offset += 4;
  view.setUint32(offset, sampleRate * bytesPerSample, true); offset += 4;
  view.setUint16(offset, bytesPerSample, true); offset += 2;
  view.setUint16(offset, 16, true); offset += 2;

  writeAscii(view, offset, 'data'); offset += 4;
  view.setUint32(offset, dataSize, true); offset += 4;
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767)));
    view.setInt16(offset, clamped, true);
    offset += 2;
  }

  writeAscii(view, offset, 'cue '); offset += 4;
  view.setUint32(offset, declaredCueChunkSize, true); offset += 4; // lies: says 3 points fit
  view.setUint32(offset, 3, true); offset += 4; // numCuePoints also claims 3
  // only 1 real cue point is physically present; the buffer ends right after it
  view.setUint32(offset, 1, true); offset += 4; // dwName
  view.setUint32(offset, 0, true); offset += 4; // dwPosition
  writeAscii(view, offset, 'data'); offset += 4; // fccChunk
  view.setUint32(offset, 0, true); offset += 4; // dwChunkStart
  view.setUint32(offset, 0, true); offset += 4; // dwBlockStart
  view.setUint32(offset, 9, true); offset += 4; // dwSampleOffset

  return buffer; // physically ends here — declaredCueChunkSize claims more
}

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
