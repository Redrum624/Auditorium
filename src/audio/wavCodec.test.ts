import { encodeWav, decodeWav, WavBitDepth, WavMarker } from './wavCodec';
import { buildExtensibleWav, buildPlainTagWav } from './__fixtures__/extensibleWav';

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

  // Before these two checks, a header claiming numChannels === 0 DECODED
  // SUCCESSFULLY as `channels: []`, and the failure surfaced much later and
  // much further away as `channels[0].length` on undefined
  // (menuActions.ts:623, remixRender.ts:480); sampleRate === 0 produced an
  // Infinity duration instead of an error.
  it('rejects numChannels === 0 at the header instead of decoding to an empty channel list', () => {
    const buf = buildFmtOnlyWav({ audioFormat: 1, numChannels: 0, sampleRate: SAMPLE_RATE, bitsPerSample: 16 });
    expect(() => decodeWav(buf)).toThrow('Invalid WAV channel count: 0');
  });

  it('rejects an absurd channel count', () => {
    const buf = buildFmtOnlyWav({ audioFormat: 1, numChannels: 33, sampleRate: SAMPLE_RATE, bitsPerSample: 16 });
    expect(() => decodeWav(buf)).toThrow('Invalid WAV channel count: 33');
  });

  it('accepts the boundary channel counts (1 and 32)', () => {
    for (const numChannels of [1, 32]) {
      const channels = Array.from({ length: numChannels }, () => Float32Array.from([0.5]));
      expect(decodeWav(encodeWav(channels, SAMPLE_RATE, 16)).channels.length).toBe(numChannels);
    }
  });

  it('rejects sampleRate === 0 (it makes every derived duration Infinity)', () => {
    const buf = buildFmtOnlyWav({ audioFormat: 1, numChannels: 1, sampleRate: 0, bitsPerSample: 16 });
    expect(() => decodeWav(buf)).toThrow('Invalid WAV sample rate: 0');
  });

  it('rejects a sample rate outside the sane window on both sides', () => {
    const low = buildFmtOnlyWav({ audioFormat: 1, numChannels: 1, sampleRate: 2999, bitsPerSample: 16 });
    expect(() => decodeWav(low)).toThrow('Invalid WAV sample rate: 2999');
    const high = buildFmtOnlyWav({ audioFormat: 1, numChannels: 1, sampleRate: 768001, bitsPerSample: 16 });
    expect(() => decodeWav(high)).toThrow('Invalid WAV sample rate: 768001');
  });

  it('accepts the boundary sample rates (3000 and 768000)', () => {
    for (const sampleRate of [3000, 768000]) {
      const buf = encodeWav([Float32Array.from([0.5])], sampleRate, 16);
      expect(decodeWav(buf).sampleRate).toBe(sampleRate);
    }
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

describe('encodeWav / decodeWav Unicode labl (K2)', () => {
  it('round-trips CJK and emoji marker names exactly', () => {
    const mono = [sineWave(440, DURATION * 2, SAMPLE_RATE)];
    const markersIn: WavMarker[] = [
      { name: '日本語', positionSample: 5 },
      { name: '🎵🎶', positionSample: 10 },
    ];
    const buf = encodeWav(mono, SAMPLE_RATE, 16, markersIn);
    const decoded = decodeWav(buf);
    expect(decoded.markers).toEqual([
      { name: '日本語', positionSample: 5 },
      { name: '🎵🎶', positionSample: 10 },
    ]);
  });

  it('mixed file: one ASCII name and one CJK name both round-trip', () => {
    const mono = [sineWave(440, DURATION * 2, SAMPLE_RATE)];
    const markersIn: WavMarker[] = [
      { name: 'Intro', positionSample: 1 },
      { name: 'サビ', positionSample: 2 },
    ];
    const buf = encodeWav(mono, SAMPLE_RATE, 16, markersIn);
    const decoded = decodeWav(buf);
    expect(decoded.markers).toEqual([
      { name: 'Intro', positionSample: 1 },
      { name: 'サビ', positionSample: 2 },
    ]);
  });

  it('keeps the cue/LIST tail byte-identical to the pinned v1.2.1 fixture when every marker name is Latin-1-representable', () => {
    // Pinned bytes captured from the pre-K2 encoder (charCodeAt/writeAscii path)
    // for markers [{name:'Café ß', positionSample:5}, {name:'Intro', positionSample:10}]
    // against a mono 16-bit, 441-frame (SAMPLE_RATE * DURATION) buffer. Regenerating
    // this fixture defeats the purpose of the pin — it must stay a literal byte array.
    const PINNED_TAIL: number[] = [
      99, 117, 101, 32, 52, 0, 0, 0, 2, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 100, 97, 116, 97, 0, 0, 0, 0, 0, 0, 0, 0, 5,
      0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 100, 97, 116, 97, 0, 0, 0, 0, 0, 0, 0, 0, 10, 0, 0, 0, 76, 73, 83, 84, 42, 0,
      0, 0, 97, 100, 116, 108, 108, 97, 98, 108, 11, 0, 0, 0, 1, 0, 0, 0, 67, 97, 102, 233, 32, 223, 0, 0, 108, 97,
      98, 108, 10, 0, 0, 0, 2, 0, 0, 0, 73, 110, 116, 114, 111, 0,
    ];
    const mono = [sineWave(440, DURATION, SAMPLE_RATE)];
    const markersIn: WavMarker[] = [
      { name: 'Café ß', positionSample: 5 }, // Latin-1-representable (é = U+00E9, ß = U+00DF)
      { name: 'Intro', positionSample: 10 },
    ];
    const buf = encodeWav(mono, SAMPLE_RATE, 16, markersIn);
    const dataSize = mono[0].length * 2;
    const tail = Array.from(new Uint8Array(buf)).slice(44 + dataSize);
    expect(tail).toEqual(PINNED_TAIL);
  });

  it('computes cue/LIST/labl chunk sizes from UTF-8 byte length, not UTF-16 code-unit length, for non-Latin-1 names', () => {
    // '日' is 1 UTF-16 code unit but 3 UTF-8 bytes — a size computed from
    // name.length instead of byte length would corrupt the chunk framing.
    const mono = [sineWave(440, DURATION, SAMPLE_RATE)];
    const buf = encodeWav(mono, SAMPLE_RATE, 16, [{ name: '日', positionSample: 1 }]);
    const view = new DataView(buf);
    const dataSize = mono[0].length * 2;
    let offset = 44 + dataSize;

    expect(readAscii(view, offset, 4)).toBe('cue ');
    const cueChunkSize = view.getUint32(offset + 4, true);
    expect(cueChunkSize).toBe(4 + 1 * 24);
    offset += 8 + cueChunkSize;

    expect(readAscii(view, offset, 4)).toBe('LIST');
    const listSize = view.getUint32(offset + 4, true);
    // labelPayloadSize = 4 (dwName) + 3 (UTF-8 bytes for '日') + 1 (NUL) = 8, even -> no pad.
    // listPayloadSize = 4 ('adtl') + 8 (labl header) + 8 (labl payload) = 20.
    expect(listSize).toBe(20);
    expect(readAscii(view, offset + 8, 4)).toBe('adtl');

    const sub = offset + 12;
    expect(readAscii(view, sub, 4)).toBe('labl');
    const lablSize = view.getUint32(sub + 4, true);
    expect(lablSize).toBe(8);
    expect(view.getUint32(sub + 8, true)).toBe(1); // dwName
    const textBytes = new Uint8Array(buf, sub + 12, 3);
    expect(new TextDecoder('utf-8', { fatal: true }).decode(textBytes)).toBe('日');

    // RIFF total size must also agree with what was actually written.
    expect(view.getUint32(4, true)).toBe(buf.byteLength - 8);
  });

  it('decodes a legacy Latin-1 high-byte labl fixture (invalid UTF-8) as the Latin-1 reading', () => {
    // Byte-for-byte what the pre-K2 (charCodeAt) encoder would have written for
    // the name 'café': 0x63,0x61,0x66,0xE9 — 0xE9 alone (followed by the NUL
    // terminator) is not a valid UTF-8 sequence, so the strict-UTF-8-first
    // decode must fail and fall back to the Latin-1 reading.
    const samples = sineWave(440, DURATION, SAMPLE_RATE);
    const buf = buildWavWithCueBeforeData(samples, SAMPLE_RATE, [{ name: 'café', positionSample: 7 }]);
    const decoded = decodeWav(buf);
    expect(decoded.markers).toEqual([{ name: 'café', positionSample: 7 }]);
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

/** Builds a mono 16-bit PCM WAV whose LIST/adtl chunk carries `labelCount`
 * 'labl' sub-chunks (dwName 1..labelCount, name `L<dwName>`) and a cue chunk
 * with one cue point per entry of `cueDwNames` (dwSampleOffset = dwName, as in
 * buildWavWithCueOnlyNoLabels). Used to prove the decoder caps the label map
 * rather than growing it unboundedly from a crafted adtl chunk (v1.5.2). */
function buildWavWithManyAdtlLabels(
  samples: Float32Array,
  sampleRate: number,
  labelCount: number,
  cueDwNames: number[]
): ArrayBuffer {
  const bytesPerSample = 2;
  const dataSize = samples.length * bytesPerSample;
  const cuePayloadSize = 4 + cueDwNames.length * 24;
  const labelNames: string[] = [];
  const labelSizes: number[] = [];
  let lablTotal = 0;
  for (let i = 1; i <= labelCount; i++) {
    const name = `L${i}`;
    const size = 4 + name.length + 1; // dwName + text + NUL
    labelNames.push(name);
    labelSizes.push(size);
    lablTotal += 8 + size + (size % 2);
  }
  const listPayloadSize = 4 + lablTotal;
  const totalSize = 12 + (8 + 16) + (8 + dataSize) + (8 + cuePayloadSize) + (8 + listPayloadSize);
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

  writeAscii(view, offset, 'data'); offset += 4;
  view.setUint32(offset, dataSize, true); offset += 4;
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767)));
    view.setInt16(offset, clamped, true);
    offset += 2;
  }

  writeAscii(view, offset, 'cue '); offset += 4;
  view.setUint32(offset, cuePayloadSize, true); offset += 4;
  view.setUint32(offset, cueDwNames.length, true); offset += 4;
  for (const n of cueDwNames) {
    view.setUint32(offset, n, true); offset += 4; // dwName
    view.setUint32(offset, 0, true); offset += 4;
    writeAscii(view, offset, 'data'); offset += 4;
    view.setUint32(offset, 0, true); offset += 4;
    view.setUint32(offset, 0, true); offset += 4;
    view.setUint32(offset, n, true); offset += 4; // dwSampleOffset
  }

  writeAscii(view, offset, 'LIST'); offset += 4;
  view.setUint32(offset, listPayloadSize, true); offset += 4;
  writeAscii(view, offset, 'adtl'); offset += 4;
  for (let i = 0; i < labelCount; i++) {
    const size = labelSizes[i];
    writeAscii(view, offset, 'labl'); offset += 4;
    view.setUint32(offset, size, true); offset += 4;
    view.setUint32(offset, i + 1, true); offset += 4; // dwName
    writeAscii(view, offset, labelNames[i]); offset += labelNames[i].length;
    view.setUint8(offset, 0); offset += 1;
    if (size % 2 !== 0) {
      view.setUint8(offset, 0);
      offset += 1;
    }
  }

  return buffer;
}

describe('decodeWav LIST/adtl label-map cap (v1.5.2)', () => {
  // Mirrors id3Chapters' CTOC_CHAP_CAP pattern: keep the first N by position,
  // never throw. A crafted 100 MB adtl chunk could otherwise grow the label
  // Map to ~8 M entries before a single cue point is ever consulted.
  const CAP = 10000;

  it('keeps the first 10 000 labl entries by position and never throws; later entries fall back to "Marker N"', () => {
    const samples = sineWave(440, DURATION, SAMPLE_RATE);
    const buf = buildWavWithManyAdtlLabels(samples, SAMPLE_RATE, CAP + 500, [1, CAP, CAP + 1]);

    const decoded = decodeWav(buf);

    expect(decoded.markers).toEqual([
      { name: 'L1', positionSample: 1 }, // first label: kept
      { name: `L${CAP}`, positionSample: CAP }, // exactly at the cap: kept
      { name: `Marker ${CAP + 1}`, positionSample: CAP + 1 }, // beyond the cap: unlabelled fallback
    ]);
  });

  it('a file at exactly the cap keeps every label (the cap is not off by one)', () => {
    const samples = sineWave(440, DURATION, SAMPLE_RATE);
    const buf = buildWavWithManyAdtlLabels(samples, SAMPLE_RATE, CAP, [CAP]);

    const decoded = decodeWav(buf);

    expect(decoded.markers).toEqual([{ name: `L${CAP}`, positionSample: CAP }]);
  });
});

// ---------------------------------------------------------------------------
// R6 Part 1 — WAVE_FORMAT_EXTENSIBLE (0xFFFE): the tag every spec-conforming
// writer uses for >2 channels. Before R6 `validateFmt` rejected it outright,
// so properly-written 5.1/7.1 WAVs did not open at all.
// ---------------------------------------------------------------------------

/** 6 distinct-valued channels, 4 frames each, in 5.1 mask-bit order. */
function sixDistinctChannels(): Float32Array[] {
  return Array.from({ length: 6 }, (_, c) =>
    Float32Array.from([0.1 * (c + 1), -0.05 * (c + 1), 0.02 * (c + 1), -0.5])
  );
}

const MASK_5_1 = 0x3f; // FL|FR|FC|LFE|BL|BR

describe('decodeWav WAVE_FORMAT_EXTENSIBLE support', () => {
  it('decodes an extensible PCM 16-bit 5.1 file byte-identically to its plain-tag twin, with rate/depth/count/mask', () => {
    const channels = sixDistinctChannels();
    const ext = decodeWav(buildExtensibleWav({ channels, mask: MASK_5_1, bitsPerSample: 16 }));
    const plain = decodeWav(buildPlainTagWav({ channels, bitsPerSample: 16 }));
    expect(ext.sampleRate).toBe(44100);
    expect(ext.bitDepth).toBe(16);
    expect(ext.channels).toHaveLength(6);
    expect(ext.channelMask).toBe(MASK_5_1);
    expect(ext.channels).toEqual(plain.channels);
  });

  it('decodes an extensible IEEE-float 32-bit 5.1 file exactly, with the mask carried', () => {
    const channels = sixDistinctChannels();
    const ext = decodeWav(buildExtensibleWav({ channels, mask: MASK_5_1, bitsPerSample: 32, float: true }));
    const plain = decodeWav(buildPlainTagWav({ channels, bitsPerSample: 32, float: true }));
    expect(ext.bitDepth).toBe(32);
    expect(ext.channelMask).toBe(MASK_5_1);
    expect(ext.channels).toEqual(plain.channels); // float path: bit-exact
    expect(ext.channels[2][0]).toBeCloseTo(0.3, 6); // and genuinely float-decoded
  });

  it('decodes an extensible 24-bit PCM file byte-identically to its plain-tag twin', () => {
    const channels = sixDistinctChannels();
    const ext = decodeWav(buildExtensibleWav({ channels, mask: MASK_5_1, bitsPerSample: 24 }));
    const plain = decodeWav(buildPlainTagWav({ channels, bitsPerSample: 24 }));
    expect(ext.bitDepth).toBe(24);
    expect(ext.channels).toEqual(plain.channels);
  });

  it('a mask of 0 is legal "unspecified": decode succeeds and the layout stays ABSENT, not invented', () => {
    const decoded = decodeWav(buildExtensibleWav({ channels: sixDistinctChannels(), mask: 0 }));
    expect(decoded.channels).toHaveLength(6);
    expect(decoded.channelMask).toBeUndefined();
  });

  // The popcount-vs-numChannels comparison, probed per operand role: below,
  // on, and above the channel count. Only exact agreement carries a layout —
  // a half-true mask keyed into a downmix matrix would misplace content
  // silently, which is worse than the layout-agnostic fallback.
  it('a mask with MORE bits than channels decodes but carries no layout (pinned: inconsistent metadata is dropped)', () => {
    const decoded = decodeWav(buildExtensibleWav({ channels: sixDistinctChannels(), mask: 0xff })); // 8 bits, 6 ch
    expect(decoded.channels).toHaveLength(6);
    expect(decoded.channelMask).toBeUndefined();
  });

  it('a mask with FEWER bits than channels decodes but carries no layout (pinned: partial layouts are not half-trusted)', () => {
    const decoded = decodeWav(buildExtensibleWav({ channels: sixDistinctChannels(), mask: 0x3 })); // 2 bits, 6 ch
    expect(decoded.channels).toHaveLength(6);
    expect(decoded.channelMask).toBeUndefined();
  });

  it('wValidBitsPerSample below the container (20-in-24) decodes at container scale, container depth reported', () => {
    // Spec-conforming 20-valid-bit samples are left-justified with zero low
    // bits, so container-scale decoding is numerically exact — the decode must
    // equal the plain 24-bit twin and must not throw.
    const channels = sixDistinctChannels();
    const decoded = decodeWav(
      buildExtensibleWav({ channels, mask: MASK_5_1, bitsPerSample: 24, validBits: 20 })
    );
    expect(decoded.bitDepth).toBe(24);
    expect(decoded.channels).toEqual(decodeWav(buildPlainTagWav({ channels, bitsPerSample: 24 })).channels);
  });

  it('validates bit depth against the RESOLVED subformat: extensible float@16 rejected, float@32 accepted', () => {
    const mono16 = [Float32Array.from([0.5])];
    expect(() =>
      decodeWav(buildExtensibleWav({ channels: mono16, bitsPerSample: 16, subTag: 3 }))
    ).toThrow('Unsupported IEEE float bit depth: 16');
    const ok = decodeWav(buildExtensibleWav({ channels: mono16, bitsPerSample: 32, float: true }));
    expect(ok.bitDepth).toBe(32);
  });

  it('validates PCM bit depth through the extensible path (12 rejected)', () => {
    // Zero frames: the 12-bit header must be rejected before any sample math.
    expect(() =>
      decodeWav(buildExtensibleWav({ channels: [new Float32Array(0)], bitsPerSample: 12 as never, subTag: 1 }))
    ).toThrow('Unsupported PCM bit depth: 12');
  });

  it('rejects an unknown subformat tag with the RESOLVED code, not 65534', () => {
    expect(() =>
      decodeWav(buildExtensibleWav({ channels: [Float32Array.from([0.5])], subTag: 2 }))
    ).toThrow('Unsupported WAV audio format code: 2');
  });

  it('a nested 0xFFFE subformat tag terminates with a clean rejection (no re-resolution loop)', () => {
    expect(() =>
      decodeWav(buildExtensibleWav({ channels: [Float32Array.from([0.5])], subTag: 0xfffe }))
    ).toThrow('Unsupported WAV audio format code: 65534');
  });

  it('rejects a non-KSDATAFORMAT subformat GUID (e.g. ambisonic B-format) instead of decoding it as PCM', () => {
    const suffix = [0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x72]; // last byte off
    expect(() =>
      decodeWav(buildExtensibleWav({ channels: [Float32Array.from([0.5])], guidSuffix: suffix }))
    ).toThrow('Unsupported WAV subformat GUID');
  });

  it('the channel-count bound applies through the extensible path (33 rejected, 32 accepted)', () => {
    const make = (n: number) => Array.from({ length: n }, () => Float32Array.from([0.25]));
    expect(() => decodeWav(buildExtensibleWav({ channels: make(33), mask: 0 }))).toThrow(
      'Invalid WAV channel count: 33'
    );
    expect(decodeWav(buildExtensibleWav({ channels: make(32), mask: 0 })).channels).toHaveLength(32);
  });

  // cbSize / physical-extension-size comparisons, below / on / above.
  it('rejects cbSize 21 (below the 22-byte minimum) with a clean, specific Error', () => {
    expect(() =>
      decodeWav(buildExtensibleWav({ channels: [Float32Array.from([0.5])], cbSize: 21, presentExtensionBytes: 22 }))
    ).toThrow('truncated WAVE_FORMAT_EXTENSIBLE fmt extension');
  });

  it('accepts cbSize exactly 22 (on the boundary) and cbSize 24 with the extra bytes present (above)', () => {
    expect(decodeWav(buildExtensibleWav({ channels: [Float32Array.from([0.5])], cbSize: 22 })).bitDepth).toBe(16);
    expect(decodeWav(buildExtensibleWav({ channels: [Float32Array.from([0.5])], cbSize: 24 })).bitDepth).toBe(16);
  });

  it('rejects an extension physically shorter than declared (cbSize 22, 21 bytes present) with a clean Error', () => {
    expect(() =>
      decodeWav(buildExtensibleWav({ channels: [Float32Array.from([0.5])], cbSize: 22, presentExtensionBytes: 21 }))
    ).toThrow('truncated WAVE_FORMAT_EXTENSIBLE fmt extension');
  });

  it('rejects a buffer truncated mid-GUID with a clean Error, never an out-of-bounds DataView RangeError', () => {
    const full = buildExtensibleWav({ channels: [Float32Array.from([0.5])], mask: 0x4 });
    // fmt data starts at byte 20; the GUID occupies fmt bytes 24..39. Cut inside it.
    const truncated = full.slice(0, 20 + 30);
    expect(() => decodeWav(truncated)).toThrow('truncated WAVE_FORMAT_EXTENSIBLE fmt extension');
  });

  it('a fmt chunk with audioFormat 0xFFFE but no extension at all (chunkSize 16) is rejected cleanly', () => {
    const buf = buildFmtOnlyWav({ audioFormat: 0xfffe, numChannels: 6, sampleRate: SAMPLE_RATE, bitsPerSample: 16 });
    expect(() => decodeWav(buf)).toThrow('truncated WAVE_FORMAT_EXTENSIBLE fmt extension');
  });

  it('plain-tag decodes carry NO channelMask (nothing invented for the pre-R6 form)', () => {
    const decoded = decodeWav(buildPlainTagWav({ channels: sixDistinctChannels() }));
    expect(decoded.channelMask).toBeUndefined();
  });
});
