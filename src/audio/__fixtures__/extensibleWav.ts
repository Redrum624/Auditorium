/**
 * Test-only builders for WAVE_FORMAT_EXTENSIBLE WAV buffers — the fmt-40 form
 * every spec-conforming writer emits for multichannel files — plus their
 * plain-tag twins built from the SAME data-chunk bytes, so a test can assert
 * that the extensible decode is byte-identical to the plain decode without
 * trusting any shared scaling math. Every field can be deliberately malformed
 * (short cbSize, wrong GUID suffix, inconsistent mask) to pin the decoder's
 * behaviour on hostile input.
 */

function writeAscii(view: DataView, offset: number, str: string): void {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}

/** KSDATAFORMAT_SUBTYPE_* suffix: XXXXXXXX-0000-0010-8000-00AA00389B71. */
export const KS_SUFFIX = [0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71];

export interface ExtensibleWavOpts {
  channels: Float32Array[];
  sampleRate?: number; // default 44100
  bitsPerSample?: 16 | 24 | 32; // container depth; default 16
  float?: boolean; // SubFormat = IEEE float (pair with bitsPerSample 32); default false (PCM)
  mask?: number; // dwChannelMask; default 0 ("unspecified")
  validBits?: number; // wValidBitsPerSample; default = bitsPerSample
  cbSize?: number; // declared extension size; default 22
  subTag?: number; // override the GUID's leading format tag (default 1 or 3 per `float`)
  guidSuffix?: number[]; // override the 14-byte GUID suffix (default KS_SUFFIX)
  /** Extension bytes PHYSICALLY present in the fmt chunk (default: max(cbSize, 22)
   * when well-formed). Set below 22 to build "extension shorter than declared". */
  presentExtensionBytes?: number;
}

function writeSamples(
  view: DataView,
  offset: number,
  channels: Float32Array[],
  bitsPerSample: 16 | 24 | 32,
  float: boolean
): void {
  const numFrames = channels[0]?.length ?? 0;
  for (let frame = 0; frame < numFrames; frame++) {
    for (let ch = 0; ch < channels.length; ch++) {
      const sample = channels[ch][frame];
      if (float) {
        view.setFloat32(offset, sample, true);
        offset += 4;
      } else if (bitsPerSample === 16) {
        view.setInt16(offset, Math.max(-32768, Math.min(32767, Math.round(sample * 32767))), true);
        offset += 2;
      } else if (bitsPerSample === 24) {
        const clamped = Math.max(-8388608, Math.min(8388607, Math.round(sample * 8388607)));
        const unsigned = clamped < 0 ? clamped + 0x1000000 : clamped;
        view.setUint8(offset, unsigned & 0xff);
        view.setUint8(offset + 1, (unsigned >> 8) & 0xff);
        view.setUint8(offset + 2, (unsigned >> 16) & 0xff);
        offset += 3;
      } else {
        // 32-bit integer PCM
        view.setInt32(offset, Math.max(-2147483647, Math.min(2147483647, Math.round(sample * 2147483647))), true);
        offset += 4;
      }
    }
  }
}

/** A WAVE_FORMAT_EXTENSIBLE WAV: RIFF + fmt(18 + extension bytes) + data. */
export function buildExtensibleWav(opts: ExtensibleWavOpts): ArrayBuffer {
  const sampleRate = opts.sampleRate ?? 44100;
  const bitsPerSample = opts.bitsPerSample ?? 16;
  const float = opts.float ?? false;
  const cbSize = opts.cbSize ?? 22;
  const extBytes = opts.presentExtensionBytes ?? Math.max(cbSize, 22);
  const numChannels = opts.channels.length;
  const numFrames = opts.channels[0]?.length ?? 0;
  const bytesPerSample = bitsPerSample / 8;
  const blockAlign = numChannels * bytesPerSample;
  const dataSize = numFrames * blockAlign;
  const fmtSize = 18 + extBytes;

  const buffer = new ArrayBuffer(12 + 8 + fmtSize + (fmtSize % 2) + 8 + dataSize);
  const view = new DataView(buffer);
  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, buffer.byteLength - 8, true);
  writeAscii(view, 8, 'WAVE');

  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, fmtSize, true);
  const f = 20; // fmt data start
  view.setUint16(f, 0xfffe, true); // WAVE_FORMAT_EXTENSIBLE
  view.setUint16(f + 2, numChannels, true);
  view.setUint32(f + 4, sampleRate, true);
  view.setUint32(f + 8, sampleRate * blockAlign, true);
  view.setUint16(f + 12, blockAlign, true);
  view.setUint16(f + 14, bitsPerSample, true);
  view.setUint16(f + 16, cbSize, true);
  if (extBytes >= 2) view.setUint16(f + 18, opts.validBits ?? bitsPerSample, true);
  if (extBytes >= 6) view.setUint32(f + 20, opts.mask ?? 0, true);
  if (extBytes >= 22) {
    const subTag = opts.subTag ?? (float ? 3 : 1);
    view.setUint16(f + 24, subTag, true);
    const suffix = opts.guidSuffix ?? KS_SUFFIX;
    for (let i = 0; i < 14; i++) view.setUint8(f + 26 + i, suffix[i]);
  }

  const dataStart = 20 + fmtSize + (fmtSize % 2);
  writeAscii(view, dataStart, 'data');
  view.setUint32(dataStart + 4, dataSize, true);
  writeSamples(view, dataStart + 8, opts.channels, bitsPerSample, float);
  return buffer;
}

/** The plain-tag (fmt-16, audioFormat 1 or 3) twin of `buildExtensibleWav`,
 * carrying byte-identical sample data — the reference an extensible decode
 * must match exactly. */
export function buildPlainTagWav(
  opts: Pick<ExtensibleWavOpts, 'channels' | 'sampleRate' | 'bitsPerSample' | 'float'>
): ArrayBuffer {
  const sampleRate = opts.sampleRate ?? 44100;
  const bitsPerSample = opts.bitsPerSample ?? 16;
  const float = opts.float ?? false;
  const numChannels = opts.channels.length;
  const numFrames = opts.channels[0]?.length ?? 0;
  const bytesPerSample = bitsPerSample / 8;
  const blockAlign = numChannels * bytesPerSample;
  const dataSize = numFrames * blockAlign;

  const buffer = new ArrayBuffer(12 + 8 + 16 + 8 + dataSize);
  const view = new DataView(buffer);
  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, buffer.byteLength - 8, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, float ? 3 : 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataSize, true);
  writeSamples(view, 44, opts.channels, bitsPerSample, float);
  return buffer;
}
