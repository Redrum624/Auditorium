export type WavBitDepth = 16 | 24 | 32; // 32 = IEEE float

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

export function encodeWav(channels: Float32Array[], sampleRate: number, bitDepth: WavBitDepth): ArrayBuffer {
  const numChannels = channels.length;
  const numFrames = numChannels > 0 ? channels[0].length : 0;
  const bytesPerSample = bitDepth / 8;
  const audioFormat = bitDepth === 32 ? FMT_IEEE_FLOAT : FMT_PCM;
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = numFrames * blockAlign;
  const fmtSize = 16;

  const buffer = new ArrayBuffer(12 + (8 + fmtSize) + (8 + dataSize));
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

export function decodeWav(buf: ArrayBuffer): { channels: Float32Array[]; sampleRate: number; bitDepth: number } {
  const view = new DataView(buf);
  if (buf.byteLength < 12 || readAscii(view, 0, 4) !== 'RIFF' || readAscii(view, 8, 4) !== 'WAVE') {
    throw new Error('Not a WAV file');
  }

  let fmt: WavFmt | null = null;
  let dataOffset = -1;
  let dataSize = 0;

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

  return { channels, sampleRate: fmt.sampleRate, bitDepth: fmt.bitsPerSample };
}
