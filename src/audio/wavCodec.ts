export type WavBitDepth = 16 | 24 | 32; // 32 = IEEE float

/** A marker as persisted in a WAV `cue `/`LIST`-`adtl` chunk pair. Structurally
 * compatible with appStore's `Marker` (extra `id` field is simply ignored by
 * the encoder — cue points are identified by a 1-based index, not the app's id). */
export interface WavMarker {
  name: string;
  positionSample: number;
}

const FMT_PCM = 1;
const FMT_IEEE_FLOAT = 3;

function writeAscii(view: DataView, offset: number, str: string): void {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}

function readAscii(view: DataView, offset: number, length: number): string {
  let s = '';
  for (let i = 0; i < length; i++) {
    s += String.fromCharCode(view.getUint8(offset + i));
  }
  return s;
}

export function encodeWav(
  channels: Float32Array[],
  sampleRate: number,
  bitDepth: WavBitDepth,
  markers?: WavMarker[]
): ArrayBuffer {
  const numChannels = channels.length;
  const numFrames = numChannels > 0 ? channels[0].length : 0;
  const bytesPerSample = bitDepth / 8;
  const audioFormat = bitDepth === 32 ? FMT_IEEE_FLOAT : FMT_PCM;
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = numFrames * blockAlign;
  const fmtSize = 16;

  const markerList = markers ?? [];
  const hasMarkers = markerList.length > 0;
  // A chunk's byte length must be even; the 'data' chunk itself is never padded
  // when it's the last chunk (matches the pre-marker encoder exactly), but when
  // 'cue '/'LIST' follow an odd-sized 'data' payload a single pad byte is needed
  // so the next chunk starts word-aligned.
  const dataPad = hasMarkers && dataSize % 2 !== 0 ? 1 : 0;
  const cuePayloadSize = hasMarkers ? 4 + markerList.length * 24 : 0; // dwCuePoints + 24B per cue point
  const cueChunkTotal = hasMarkers ? 8 + cuePayloadSize : 0;
  const labelPayloadSizes = markerList.map((m) => 4 + m.name.length + 1); // dwName + text + NUL
  const listPayloadSize = hasMarkers
    ? 4 + labelPayloadSizes.reduce((sum, size) => sum + 8 + size + (size % 2), 0) // 'adtl' + per-label subchunks
    : 0;
  const listChunkTotal = hasMarkers ? 8 + listPayloadSize : 0;

  const buffer = new ArrayBuffer(
    12 + (8 + fmtSize) + (8 + dataSize) + dataPad + cueChunkTotal + listChunkTotal
  );
  const view = new DataView(buffer);

  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, buffer.byteLength - 8, true);
  writeAscii(view, 8, 'WAVE');

  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, fmtSize, true);
  view.setUint16(20, audioFormat, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitDepth, true);

  writeAscii(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let frame = 0; frame < numFrames; frame++) {
    for (let ch = 0; ch < numChannels; ch++) {
      const sample = channels[ch][frame];
      if (bitDepth === 16) {
        const clamped = Math.max(-32768, Math.min(32767, Math.round(sample * 32767)));
        view.setInt16(offset, clamped, true);
        offset += 2;
      } else if (bitDepth === 24) {
        const clamped = Math.max(-8388608, Math.min(8388607, Math.round(sample * 8388607)));
        const unsigned = clamped < 0 ? clamped + 0x1000000 : clamped;
        view.setUint8(offset, unsigned & 0xff);
        view.setUint8(offset + 1, (unsigned >> 8) & 0xff);
        view.setUint8(offset + 2, (unsigned >> 16) & 0xff);
        offset += 3;
      } else {
        view.setFloat32(offset, sample, true);
        offset += 4;
      }
    }
  }

  if (hasMarkers) {
    if (dataPad) {
      view.setUint8(offset, 0);
      offset += 1;
    }

    writeAscii(view, offset, 'cue ');
    offset += 4;
    view.setUint32(offset, cuePayloadSize, true);
    offset += 4;
    view.setUint32(offset, markerList.length, true); // dwCuePoints
    offset += 4;
    markerList.forEach((m, i) => {
      view.setUint32(offset, i + 1, true); // dwName: 1-based index
      offset += 4;
      view.setUint32(offset, 0, true); // dwPosition
      offset += 4;
      writeAscii(view, offset, 'data'); // fccChunk
      offset += 4;
      view.setUint32(offset, 0, true); // dwChunkStart
      offset += 4;
      view.setUint32(offset, 0, true); // dwBlockStart
      offset += 4;
      view.setUint32(offset, m.positionSample, true); // dwSampleOffset
      offset += 4;
    });

    writeAscii(view, offset, 'LIST');
    offset += 4;
    view.setUint32(offset, listPayloadSize, true);
    offset += 4;
    writeAscii(view, offset, 'adtl');
    offset += 4;
    markerList.forEach((m, i) => {
      const payloadSize = labelPayloadSizes[i];
      writeAscii(view, offset, 'labl');
      offset += 4;
      view.setUint32(offset, payloadSize, true);
      offset += 4;
      view.setUint32(offset, i + 1, true); // dwName matching the cue point
      offset += 4;
      writeAscii(view, offset, m.name);
      offset += m.name.length;
      view.setUint8(offset, 0); // NUL terminator
      offset += 1;
      if (payloadSize % 2 !== 0) {
        view.setUint8(offset, 0); // pad byte, not counted in payloadSize
        offset += 1;
      }
    });
  }

  return buffer;
}

interface WavFmt {
  audioFormat: number;
  numChannels: number;
  sampleRate: number;
  bitsPerSample: number;
}

function validateFmt(fmt: WavFmt): void {
  if (fmt.audioFormat === FMT_PCM) {
    if (![8, 16, 24, 32].includes(fmt.bitsPerSample)) {
      throw new Error(`Unsupported PCM bit depth: ${fmt.bitsPerSample}`);
    }
  } else if (fmt.audioFormat === FMT_IEEE_FLOAT) {
    if (fmt.bitsPerSample !== 32) {
      throw new Error(`Unsupported IEEE float bit depth: ${fmt.bitsPerSample}`);
    }
  } else {
    throw new Error(`Unsupported WAV audio format code: ${fmt.audioFormat}`);
  }
}

export function decodeWav(buf: ArrayBuffer): {
  channels: Float32Array[];
  sampleRate: number;
  bitDepth: number;
  markers: WavMarker[];
} {
  const view = new DataView(buf);
  if (buf.byteLength < 12 || readAscii(view, 0, 4) !== 'RIFF' || readAscii(view, 8, 4) !== 'WAVE') {
    throw new Error('Not a WAV file');
  }

  let fmt: WavFmt | null = null;
  let dataOffset = -1;
  let dataSize = 0;
  const cuePoints: { name: number; sampleOffset: number }[] = [];
  const labels = new Map<number, string>();

  let offset = 12;
  while (offset + 8 <= view.byteLength) {
    const chunkId = readAscii(view, offset, 4);
    const chunkSize = view.getUint32(offset + 4, true);
    const chunkDataStart = offset + 8;

    if (chunkId === 'fmt ') {
      if (chunkSize < 16 || chunkDataStart + 16 > view.byteLength) {
        throw new Error('Invalid WAV: truncated fmt chunk');
      }
      fmt = {
        audioFormat: view.getUint16(chunkDataStart, true),
        numChannels: view.getUint16(chunkDataStart + 2, true),
        sampleRate: view.getUint32(chunkDataStart + 4, true),
        bitsPerSample: view.getUint16(chunkDataStart + 14, true),
      };
      validateFmt(fmt);
    } else if (chunkId === 'data') {
      dataOffset = chunkDataStart;
      dataSize = Math.min(chunkSize, view.byteLength - chunkDataStart);
    } else if (chunkId === 'cue ' && chunkDataStart + 4 <= view.byteLength) {
      const numCuePoints = view.getUint32(chunkDataStart, true);
      for (let i = 0; i < numCuePoints; i++) {
        const base = chunkDataStart + 4 + i * 24;
        if (base + 24 > view.byteLength) break; // truncated/corrupt — stop, keep what we have
        cuePoints.push({ name: view.getUint32(base, true), sampleOffset: view.getUint32(base + 20, true) });
      }
    } else if (chunkId === 'LIST' && chunkDataStart + 4 <= view.byteLength) {
      if (readAscii(view, chunkDataStart, 4) === 'adtl') {
        const listEnd = Math.min(chunkDataStart + chunkSize, view.byteLength);
        let subOffset = chunkDataStart + 4;
        while (subOffset + 8 <= listEnd) {
          const subId = readAscii(view, subOffset, 4);
          const subSize = view.getUint32(subOffset + 4, true);
          const subDataStart = subOffset + 8;
          if (subId === 'labl' && subDataStart + 4 <= listEnd) {
            const dwName = view.getUint32(subDataStart, true);
            const textLen = Math.max(0, Math.min(subSize - 4, listEnd - (subDataStart + 4)));
            let text = readAscii(view, subDataStart + 4, textLen);
            const nul = text.indexOf('\0');
            if (nul >= 0) text = text.slice(0, nul);
            labels.set(dwName, text);
          }
          // Unrecognized sub-chunks (e.g. 'note', 'ltxt') are skipped — only
          // their framing is needed to find the next sub-chunk.
          subOffset = subDataStart + subSize + (subSize % 2);
        }
      }
    }

    // Chunks are padded to an even byte count; tolerate a missing final pad byte.
    offset = chunkDataStart + chunkSize + (chunkSize % 2);
  }

  if (!fmt) {
    throw new Error('WAV file is missing a fmt chunk');
  }
  if (dataOffset < 0) {
    throw new Error('WAV file is missing a data chunk');
  }

  const markers: WavMarker[] = cuePoints
    .map((cp) => ({ name: labels.get(cp.name) ?? `Marker ${cp.name}`, positionSample: cp.sampleOffset }))
    .sort((a, b) => a.positionSample - b.positionSample);

  const numChannels = fmt.numChannels;
  const bytesPerSample = fmt.bitsPerSample / 8;
  const blockAlign = numChannels * bytesPerSample;
  const numFrames = blockAlign > 0 ? Math.floor(dataSize / blockAlign) : 0;

  const channels: Float32Array[] = Array.from({ length: numChannels }, () => new Float32Array(numFrames));

  let pos = dataOffset;
  for (let frame = 0; frame < numFrames; frame++) {
    for (let ch = 0; ch < numChannels; ch++) {
      let sample: number;
      if (fmt.audioFormat === FMT_IEEE_FLOAT) {
        sample = view.getFloat32(pos, true);
      } else if (fmt.bitsPerSample === 8) {
        sample = (view.getUint8(pos) - 128) / 128;
      } else if (fmt.bitsPerSample === 16) {
        // Divide by the same scale the encoder multiplies by (32767) so the
        // round trip error is bounded by the rounding step, not skewed by a
        // 2^n vs 2^n-1 scale mismatch.
        sample = view.getInt16(pos, true) / 32767;
      } else if (fmt.bitsPerSample === 24) {
        const b0 = view.getUint8(pos);
        const b1 = view.getUint8(pos + 1);
        const b2 = view.getUint8(pos + 2);
        let v = b0 | (b1 << 8) | (b2 << 16);
        if (v & 0x800000) v -= 0x1000000;
        sample = v / 8388607;
      } else {
        // 32-bit PCM integer
        sample = view.getInt32(pos, true) / 2147483647;
      }
      if (fmt.audioFormat !== FMT_IEEE_FLOAT) {
        // Foreign encoders using a 2^(n-1) write scale can emit full-scale
        // negative samples (e.g. -32768) that normalize slightly below -1;
        // clamp so the app-wide [-1, 1] contract holds.
        sample = Math.max(-1, Math.min(1, sample));
      }
      channels[ch][frame] = sample;
      pos += bytesPerSample;
    }
  }

  return { channels, sampleRate: fmt.sampleRate, bitDepth: fmt.bitsPerSample, markers };
}
