/**
 * Best-effort container sniffing to recover an encoded file's native sample rate
 * WITHOUT decoding it. `decodeArrayBuffer` uses the result to build an
 * `OfflineAudioContext` at the source rate so Chromium's `decodeAudioData` lands
 * the samples at their native rate instead of resampling everything to 48000 Hz.
 *
 * Parsing is deliberately conservative: any bounds overrun, unexpected layout, or
 * ambiguity yields `null` (the caller then falls back to 48000). It NEVER throws.
 */
export function sniffSampleRate(buf: ArrayBuffer, _hintedName: string): number | null {
  try {
    const bytes = new Uint8Array(buf);
    if (bytes.length < 4) return null;
    const view = new DataView(buf);

    if (bytes.length >= 12 && matchAscii(bytes, 0, 'RIFF') && matchAscii(bytes, 8, 'WAVE')) {
      return sniffWav(bytes, view);
    }
    if (matchAscii(bytes, 0, 'fLaC')) {
      return sniffFlac(bytes);
    }
    if (matchAscii(bytes, 0, 'OggS')) {
      return sniffOgg(bytes, view);
    }
    if (bytes.length >= 8 && matchAscii(bytes, 4, 'ftyp')) {
      return sniffMp4(bytes, view);
    }
    // Fallback: raw MPEG audio (with or without an ID3v2 tag).
    return sniffMp3(bytes);
  } catch {
    return null;
  }
}

function matchAscii(bytes: Uint8Array, offset: number, str: string): boolean {
  if (offset + str.length > bytes.length) return false;
  for (let i = 0; i < str.length; i++) {
    if (bytes[offset + i] !== str.charCodeAt(i)) return false;
  }
  return true;
}

function readAscii(bytes: Uint8Array, offset: number, length: number): string {
  let s = '';
  for (let i = 0; i < length; i++) s += String.fromCharCode(bytes[offset + i]);
  return s;
}

// --- WAV ---------------------------------------------------------------------

function sniffWav(bytes: Uint8Array, view: DataView): number | null {
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const id = readAscii(bytes, offset, 4);
    const size = view.getUint32(offset + 4, true);
    const dataStart = offset + 8;
    if (id === 'fmt ') {
      if (dataStart + 8 > bytes.length) return null;
      const rate = view.getUint32(dataStart + 4, true); // fmt: format(2) channels(2) rate(4)
      return rate > 0 ? rate : null;
    }
    offset = dataStart + size + (size % 2);
  }
  return null;
}

// --- FLAC --------------------------------------------------------------------

// 'fLaC'(4) + METADATA_BLOCK_HEADER(4) + STREAMINFO. STREAMINFO is always the
// first block (type 0). Rate is a 20-bit field after min/max blocksize (2+2) and
// min/max framesize (3+3), i.e. at byte offset 4+4+10 = 18.
function sniffFlac(bytes: Uint8Array): number | null {
  const off = 18;
  if (off + 3 > bytes.length) return null;
  const rate = (bytes[off] << 12) | (bytes[off + 1] << 4) | (bytes[off + 2] >> 4);
  return rate > 0 ? rate : null;
}

// --- OGG ---------------------------------------------------------------------

function sniffOgg(bytes: Uint8Array, view: DataView): number | null {
  if (bytes.length < 27) return null;
  const segCount = bytes[26];
  const payload = 27 + segCount;
  if (payload >= bytes.length) return null;

  // Vorbis identification header: 0x01 'vorbis' then rate as LE u32 at offset 12.
  if (bytes[payload] === 0x01 && matchAscii(bytes, payload + 1, 'vorbis')) {
    const rateOff = payload + 12;
    if (rateOff + 4 > bytes.length) return null;
    const rate = view.getUint32(rateOff, true);
    return rate > 0 ? rate : null;
  }
  // Opus always decodes at 48 kHz regardless of the container's original rate.
  if (matchAscii(bytes, payload, 'OpusHead')) return 48000;
  return null;
}

// --- MP4 / M4A ---------------------------------------------------------------

interface Mp4Box {
  type: string;
  start: number; // start of the box (size field)
  contentStart: number; // first byte after the 8-byte size+type header
  end: number; // exclusive
}

/**
 * Read the sibling boxes in [start, end). Returns null on any parse doubt: a
 * 64-bit largesize (size===1), a malformed (size<8) or truncated box.
 */
function readBoxes(bytes: Uint8Array, view: DataView, start: number, end: number): Mp4Box[] | null {
  const boxes: Mp4Box[] = [];
  let offset = start;
  while (offset + 8 <= end) {
    const size = view.getUint32(offset, false); // MP4 boxes are big-endian
    const type = readAscii(bytes, offset + 4, 4);
    if (size === 1) return null; // 64-bit size unsupported for simplicity
    if (size === 0) {
      // Box extends to the end of the enclosing range.
      boxes.push({ type, start: offset, contentStart: offset + 8, end });
      break;
    }
    if (size < 8) return null;
    const boxEnd = offset + size;
    if (boxEnd > end) return null;
    boxes.push({ type, start: offset, contentStart: offset + 8, end: boxEnd });
    offset = boxEnd;
  }
  return boxes;
}

function sniffMp4(bytes: Uint8Array, view: DataView): number | null {
  const top = readBoxes(bytes, view, 0, bytes.length);
  if (!top) return null;
  const moov = top.find((b) => b.type === 'moov');
  if (!moov) return null;
  const moovBoxes = readBoxes(bytes, view, moov.contentStart, moov.end);
  if (!moovBoxes) return null;

  for (const trak of moovBoxes.filter((b) => b.type === 'trak')) {
    const trakBoxes = readBoxes(bytes, view, trak.contentStart, trak.end);
    if (!trakBoxes) continue;
    const mdia = trakBoxes.find((b) => b.type === 'mdia');
    if (!mdia) continue;
    const mdiaBoxes = readBoxes(bytes, view, mdia.contentStart, mdia.end);
    if (!mdiaBoxes) continue;
    const mdhd = mdiaBoxes.find((b) => b.type === 'mdhd');
    if (!mdhd) continue;

    // Full-box: version byte at box+8; timescale u32 at box+8 + (v0 ? 12 : 20).
    if (mdhd.start + 8 >= bytes.length) continue;
    const version = bytes[mdhd.start + 8];
    const tsOff = mdhd.start + 8 + (version === 0 ? 12 : 20);
    if (tsOff + 4 > bytes.length) continue;
    const ts = view.getUint32(tsOff, false);
    if (ts >= 8000 && ts <= 192000) return ts;
  }
  return null;
}

// --- MP3 ---------------------------------------------------------------------

// MPEG version bits -> sample-rate row (index 0..2 = srIndex). versionBits 01 is
// reserved and rejected before lookup.
const MP3_RATE_TABLE: Record<number, [number, number, number]> = {
  0b11: [44100, 48000, 32000], // MPEG 1
  0b10: [22050, 24000, 16000], // MPEG 2
  0b00: [11025, 12000, 8000], // MPEG 2.5
};

function sniffMp3(bytes: Uint8Array): number | null {
  let start = 0;
  // Skip an ID3v2 tag: 'ID3' + version(2) + flags(1) + syncsafe size(4 @ offset 6).
  if (bytes.length >= 10 && matchAscii(bytes, 0, 'ID3')) {
    const size =
      ((bytes[6] & 0x7f) << 21) |
      ((bytes[7] & 0x7f) << 14) |
      ((bytes[8] & 0x7f) << 7) |
      (bytes[9] & 0x7f);
    start = 10 + size;
  }

  const limit = Math.min(bytes.length - 1, start + 64 * 1024);
  for (let i = start; i < limit; i++) {
    if (bytes[i] !== 0xff) continue;
    const b1 = bytes[i + 1];
    if ((b1 & 0xe0) !== 0xe0) continue; // frame sync
    const versionBits = (b1 >> 3) & 0x03;
    if (versionBits === 0x01) continue; // reserved version
    const layerBits = (b1 >> 1) & 0x03;
    if (layerBits === 0x00) continue; // reserved layer
    if (i + 2 >= bytes.length) break;
    const srIndex = (bytes[i + 2] >> 2) & 0x03;
    if (srIndex === 0x03) continue; // reserved sample-rate index
    const row = MP3_RATE_TABLE[versionBits];
    if (row) return row[srIndex];
  }
  return null;
}
