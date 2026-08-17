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
/** WAVE_FORMAT_EXTENSIBLE (mmreg.h). The fmt tag every spec-conforming writer
 * uses for >2 channels, >16 valid bits, or any file carrying a speaker mask.
 * The REAL sample format lives in the extension's SubFormat GUID. */
const FMT_EXTENSIBLE = 0xfffe;

/** Bytes 2..15 of the KSDATAFORMAT_SUBTYPE_* media GUIDs (ksmedia.h):
 * `XXXXXXXX-0000-0010-8000-00AA00389B71` with the format tag in the first two
 * bytes (little-endian Data1). PCM and IEEE-float SubFormats differ ONLY in
 * that leading tag. A GUID with any other suffix (e.g. the ambisonic
 * SUBTYPE_AMBISONIC_B_FORMAT_PCM family) is a genuinely different sample
 * layout, not a tag variant, and must not be decoded as if it were plain
 * PCM/float. */
const KSDATAFORMAT_SUFFIX = [0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71];

/** Number of set bits in a uint32 (SWAR popcount). */
function popcount32(v: number): number {
  v = v - ((v >>> 1) & 0x55555555);
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  return (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

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

/** True when every UTF-16 code unit of `str` is <= U+00FF, i.e. the legacy
 * charCodeAt-per-byte writer round-trips it losslessly as Latin-1. Surrogate
 * halves (code units >= 0xD800) always fail this, so any astral character
 * (emoji, etc.) correctly forces the UTF-8 path. */
function isLatin1Representable(str: string): boolean {
  for (let i = 0; i < str.length; i++) {
    if (str.charCodeAt(i) > 0xff) return false;
  }
  return true;
}

function writeBytes(view: DataView, offset: number, bytes: Uint8Array): void {
  for (let i = 0; i < bytes.length; i++) {
    view.setUint8(offset + i, bytes[i]);
  }
}

function readBytes(view: DataView, offset: number, length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    bytes[i] = view.getUint8(offset + i);
  }
  return bytes;
}

/** Decodes a labl sub-chunk's text bytes: strict UTF-8 first, Latin-1 fallback
 * on decode failure. Pure ASCII is identical either way; lone Latin-1 high
 * bytes are invalid UTF-8 (fallback triggers); valid UTF-8 sequences decode
 * as intended. Matches the heuristic Audacity uses for the same chunk. */
function decodeLabelText(view: DataView, offset: number, length: number): string {
  const bytes = readBytes(view, offset, length);
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    text = readAscii(view, offset, length);
  }
  const nul = text.indexOf('\0');
  return nul >= 0 ? text.slice(0, nul) : text;
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

  // Per-file strategy: if EVERY marker name is Latin-1-representable, keep the
  // legacy single-byte encoding so files with only Latin-1 names stay byte-
  // identical to the pre-K2 encoder. Otherwise ALL labl texts in this file are
  // written as UTF-8 — sizes below must then be computed from UTF-8 byte
  // length, not `name.length` (UTF-16 code units), or the chunk framing and
  // RIFF total would disagree with what is actually written.
  const useUtf8Labels = hasMarkers && markerList.some((m) => !isLatin1Representable(m.name));
  const textEncoder = useUtf8Labels ? new TextEncoder() : null;
  const labelNameBytes: Uint8Array[] = useUtf8Labels ? markerList.map((m) => textEncoder!.encode(m.name)) : [];
  const labelByteLengths = markerList.map((m, i) => (useUtf8Labels ? labelNameBytes[i].length : m.name.length));
  const labelPayloadSizes = labelByteLengths.map((len) => 4 + len + 1); // dwName + text + NUL
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
      if (useUtf8Labels) {
        const bytes = labelNameBytes[i];
        writeBytes(view, offset, bytes);
        offset += bytes.length;
      } else {
        writeAscii(view, offset, m.name);
        offset += m.name.length;
      }
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

/** Widest channel count this decoder will accept. Anything above it is a
 * malformed/hostile header, not a real file — the app's own encoder writes 1-2
 * and `decodeAudio` never produces more than the source really has. */
const MAX_CHANNELS = 32;
/** Sample-rate sanity window. The lower bound keeps a `0` (or near-zero) rate
 * out — it makes every derived duration `Infinity` — and the upper bound is
 * one octave above the highest rate any consumer-grade format uses. */
const MIN_SAMPLE_RATE = 3000;
const MAX_SAMPLE_RATE = 768000;

function validateFmt(fmt: WavFmt): void {
  // Checked BEFORE the format/bit-depth arms (F: a header claiming
  // numChannels === 0 used to be a SUCCESSFUL decode returning `channels: []`,
  // which then threw `Cannot read properties of undefined (reading 'length')`
  // deep downstream at `menuActions.ts:623` / `remixRender.ts:480`, far from
  // the file that caused it; sampleRate === 0 made every duration Infinity).
  if (!Number.isInteger(fmt.numChannels) || fmt.numChannels < 1 || fmt.numChannels > MAX_CHANNELS) {
    throw new Error(`Invalid WAV channel count: ${fmt.numChannels}`);
  }
  if (
    !Number.isInteger(fmt.sampleRate) ||
    fmt.sampleRate < MIN_SAMPLE_RATE ||
    fmt.sampleRate > MAX_SAMPLE_RATE
  ) {
    throw new Error(`Invalid WAV sample rate: ${fmt.sampleRate}`);
  }
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

/** LIST/adtl 'labl' entries are capped at this many — the first N by position
 * in the chunk are kept, later ones are ignored, never thrown on (v1.5.2;
 * same pattern as id3Chapters' CTOC_CHAP_CAP). Uncapped, a crafted ~100 MB
 * adtl chunk could grow the label map to ~8 M entries before a single cue
 * point is ever consulted. Real files carry a handful; a cue point whose labl
 * fell past the cap degrades to the existing "Marker N" fallback name. */
const ADTL_LABEL_CAP = 10000;

export function decodeWav(buf: ArrayBuffer): {
  channels: Float32Array[];
  sampleRate: number;
  bitDepth: number;
  markers: WavMarker[];
  /** Raw `dwChannelMask` from a WAVE_FORMAT_EXTENSIBLE fmt chunk — the speaker
   * position of every channel, in mask-bit order (lowest set bit = channel 0).
   * Present ONLY when the mask fully describes the file: nonzero AND its
   * population count equals `numChannels`. A mask of 0 is legal ("channels have
   * no assigned positions") and stays absent; a mask whose bit count disagrees
   * with the channel count in EITHER direction is inconsistent metadata and is
   * likewise dropped rather than half-trusted — a downmix matrix keyed to a
   * wrong layout misplaces content silently, which is worse than falling back
   * to the layout-agnostic fold. */
  channelMask?: number;
} {
  const view = new DataView(buf);
  if (buf.byteLength < 12 || readAscii(view, 0, 4) !== 'RIFF' || readAscii(view, 8, 4) !== 'WAVE') {
    throw new Error('Not a WAV file');
  }

  let fmt: WavFmt | null = null;
  let channelMask: number | undefined;
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
      if (fmt.audioFormat === FMT_EXTENSIBLE) {
        // WAVE_FORMAT_EXTENSIBLE: the extension is cbSize (2 bytes at +16)
        // followed by wValidBitsPerSample (2), dwChannelMask (4) and the
        // 16-byte SubFormat GUID — 22 extension bytes minimum, 40 fmt bytes
        // total. Anything shorter cannot name the real sample format, and
        // decoding without it would mean GUESSING between int32 PCM and
        // float32 (identical byte widths, garbage if misread) — so a
        // truncated extension is a deliberate, bounded rejection, never an
        // out-of-bounds DataView read.
        const fmtBytesAvailable = Math.min(chunkSize, view.byteLength - chunkDataStart);
        const cbSize = fmtBytesAvailable >= 18 ? view.getUint16(chunkDataStart + 16, true) : 0;
        if (cbSize < 22 || fmtBytesAvailable < 40) {
          throw new Error('Invalid WAV: truncated WAVE_FORMAT_EXTENSIBLE fmt extension');
        }
        // wValidBitsPerSample (+18) is read as documentation only: valid bits
        // are left-justified in the container per the spec (low bits zero), so
        // decoding at CONTAINER scale is numerically exact for a conforming
        // file — e.g. 20 valid bits in a 24-bit container decode to the same
        // floats either way — and a nonconforming value cannot change the
        // sample bytes. The container depth governs layout, scaling and the
        // reported bitDepth; validBits is advisory metadata, deliberately not
        // enforced.
        const mask = view.getUint32(chunkDataStart + 20, true);
        const guid = readBytes(view, chunkDataStart + 24, 16);
        for (let i = 2; i < 16; i++) {
          if (guid[i] !== KSDATAFORMAT_SUFFIX[i - 2]) {
            throw new Error('Unsupported WAV subformat GUID');
          }
        }
        // The first two GUID bytes carry the underlying format tag (1 = PCM,
        // 3 = IEEE float). Resolve it and validate bit depth against the
        // RESOLVED format below — never against the 0xFFFE wrapper tag.
        fmt.audioFormat = guid[0] | (guid[1] << 8);
        // NOTE: `mask !== 0` is intent-documentation, not reachable behaviour —
        // popcount32(0) is 0 and can never equal a channel count that survives
        // validateFmt (>= 1). It stays because the spec rule it states ("a mask
        // of 0 means unspecified") is load-bearing for readers; do not "fix" it
        // into something reachable or delete it as dead code.
        if (mask !== 0 && popcount32(mask) === fmt.numChannels) {
          channelMask = mask;
        }
      }
      validateFmt(fmt);
    } else if (chunkId === 'data') {
      dataOffset = chunkDataStart;
      dataSize = Math.min(chunkSize, view.byteLength - chunkDataStart);
    } else if (chunkId === 'cue ' && chunkDataStart + 4 <= view.byteLength) {
      const cueEnd = Math.min(chunkDataStart + chunkSize, view.byteLength);
      const numCuePoints = view.getUint32(chunkDataStart, true);
      // Never read past what the declared chunk size can actually hold, even
      // if adjacent (unrelated) bytes happen to still be within view.byteLength.
      const maxCuePointsInChunk = Math.max(0, Math.floor((chunkSize - 4) / 24));
      const cuePointCount = Math.min(numCuePoints, maxCuePointsInChunk);
      for (let i = 0; i < cuePointCount; i++) {
        const base = chunkDataStart + 4 + i * 24;
        if (base + 24 > cueEnd) break; // truncated/corrupt — stop, keep what we have
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
            // Cap the map at ADTL_LABEL_CAP distinct ids (first-by-position
            // wins); a repeated id within the cap still overwrites as before.
            if (labels.size < ADTL_LABEL_CAP || labels.has(dwName)) {
              const textLen = Math.max(0, Math.min(subSize - 4, listEnd - (subDataStart + 4)));
              labels.set(dwName, decodeLabelText(view, subDataStart + 4, textLen));
            }
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

  return { channels, sampleRate: fmt.sampleRate, bitDepth: fmt.bitsPerSample, markers, channelMask };
}
