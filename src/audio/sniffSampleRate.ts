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
    if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
      return sniffWebm(bytes, view);
    }
    if (bytes.length >= 8 && matchAscii(bytes, 4, 'ftyp')) {
      return sniffMp4(bytes, view);
    }
    const adtsRate = sniffAdts(bytes);
    if (adtsRate !== null) return adtsRate;
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

/**
 * Parse a FLAC STREAMINFO block for the fields Save/Properties need: the native
 * sample rate and the source bit depth. The 20-bit rate, 3-bit (channels−1) and
 * 5-bit (bits−1) fields are packed contiguously starting at byte 18 (see the bit
 * offsets above). Returns null on any bounds/magic doubt — never throws — so the
 * caller falls back to leaving the bit depth unknown.
 *
 * Bit layout from byte 18: rate[0..19], channels−1[20..22], bits−1[23..27].
 *   bits−1 = ((byte20 & 1) << 4) | (byte21 >> 4)
 */
export function readFlacStreamInfo(
  buf: ArrayBuffer
): { sampleRate: number; bitDepth: number } | null {
  try {
    const bytes = new Uint8Array(buf);
    if (!matchAscii(bytes, 0, 'fLaC')) return null;
    if (bytes.length < 22) return null;
    const sampleRate = (bytes[18] << 12) | (bytes[19] << 4) | (bytes[20] >> 4);
    const bitDepth = (((bytes[20] & 1) << 4) | (bytes[21] >> 4)) + 1;
    if (sampleRate <= 0) return null;
    return { sampleRate, bitDepth };
  } catch {
    return null;
  }
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
  // Ogg FLAC (RFC 9639 §10.2): the first packet is 0x7F 'FLAC', a 2-byte
  // mapping version, a 2-byte big-endian header-packet count, then the native
  // 'fLaC' stream marker, a 4-byte metadata block header and STREAMINFO —
  // whose 20-bit rate field sits 10 bytes in (after min/max blocksize 2+2 and
  // min/max framesize 3+3), i.e. at packet offset 9+4+4+10 = 27. Both magics
  // are required so a stray 0x7F first byte cannot alias another codec.
  if (
    bytes[payload] === 0x7f &&
    matchAscii(bytes, payload + 1, 'FLAC') &&
    matchAscii(bytes, payload + 9, 'fLaC')
  ) {
    const rateOff = payload + 27;
    if (rateOff + 3 > bytes.length) return null;
    const rate = (bytes[rateOff] << 12) | (bytes[rateOff + 1] << 4) | (bytes[rateOff + 2] >> 4);
    return rate > 0 ? rate : null;
  }
  // Ogg Speex: the first packet is the SpeexHeader struct (libspeex
  // speex_header.h, all int32 fields little-endian) — 8-byte magic
  // 'Speex   ' (5 letters + 3 spaces), a 20-byte version string, then
  // speex_version_id(4) and header_size(4), so `rate` sits at packet offset
  // 8+20+4+4 = 36.
  if (matchAscii(bytes, payload, 'Speex   ')) {
    const rateOff = payload + 36;
    if (rateOff + 4 > bytes.length) return null;
    const rate = view.getUint32(rateOff, true);
    return rate > 0 ? rate : null;
  }
  return null;
}

// --- WebM / Matroska (EBML) ---------------------------------------------------

// EBML class IDs relevant to reaching Segment -> Tracks -> TrackEntry -> Audio
// -> SamplingFrequency, plus TrackEntry's CodecID (an Opus track always decodes
// at 48 kHz, so its stored SamplingFrequency, if present, is irrelevant).
const EBML_ID_SEGMENT = 0x18538067;
const EBML_ID_TRACKS = 0x1654ae6b;
const EBML_ID_TRACKENTRY = 0xae;
const EBML_ID_CODECID = 0x86;
const EBML_ID_AUDIO = 0xe1;
const EBML_ID_SAMPLINGFREQUENCY = 0xb5;

/**
 * Bounded scan: the EBML walk is size-driven — each sibling is stepped over in
 * one O(1) hop (`offset = el.contentEnd`) regardless of its size — so, exactly
 * as with `MP4_MAX_BOXES` below, the right bound is a COUNT of siblings per
 * level, not a byte range. The previous bound here was a 512 KB byte cap, and
 * it was the wrong shape twice over: a finalized (known-size) Segment larger
 * than 512 KB failed `readEbmlElement`'s `contentEnd > limit` check outright —
 * making essentially every real saved .webm/.mkv unsniffable, not just exotic
 * ones — and a `Tracks` element sitting past a large SeekHead/Void/Attachments
 * run (or past Clusters, which Matroska/RFC 9559 permits: Tracks SHOULD
 * precede Clusters, not MUST) was unreachable. Capping the per-level sibling
 * count bounds both the loop and the TrackEntry collection while leaving the
 * size-driven hops free to cross a multi-gigabyte Cluster in one step.
 *
 * 65536 (2^16): Segment-level siblings are dominated by Clusters, which
 * muxers emit every ~1-5 s of media, so this covers Tracks-after-Clusters
 * layouts for >= 18 hours of material even at one Cluster per second — far
 * beyond anything this app opens — while a hostile file that floods a level
 * with tiny elements costs at most 65536 constant-time header reads per level
 * (microseconds, no allocation) before falling back to the default rate.
 */
const EBML_MAX_CHILDREN = 65536;

interface EbmlElement {
  id: number;
  contentStart: number;
  contentEnd: number; // exclusive; clamped to the enclosing bounded range
}

/**
 * Read one EBML vint starting at `offset`. Its length is encoded by the
 * position of the leading 1 bit in the first byte (1..8 bytes). Returns null
 * on a truncated vint or a malformed one (first byte 0, i.e. length > 8,
 * which this parser does not support).
 */
function readEbmlVint(
  bytes: Uint8Array,
  offset: number,
  limit: number
): { length: number; marker: number; firstByte: number } | null {
  if (offset >= limit) return null;
  const first = bytes[offset];
  if (first === 0) return null;
  let length = 1;
  let marker = 0x80;
  while (!(first & marker)) {
    marker >>= 1;
    length++;
  }
  if (offset + length > limit) return null;
  return { length, marker, firstByte: first };
}

// Element IDs keep their marker bit (the raw bytes concatenated as one big
// integer); real Matroska/EBML class IDs are 1-4 bytes.
function readEbmlId(bytes: Uint8Array, offset: number, limit: number): { id: number; length: number } | null {
  const vint = readEbmlVint(bytes, offset, limit);
  if (!vint || vint.length > 4) return null;
  let id = vint.firstByte;
  for (let i = 1; i < vint.length; i++) id = id * 256 + bytes[offset + i];
  return { id, length: vint.length };
}

// Element sizes strip the marker bit. A size vint whose remaining data bits
// are ALL 1 denotes "unknown size" (common for a streamed/live-recorded Segment).
function readEbmlSize(
  bytes: Uint8Array,
  offset: number,
  limit: number
): { size: number; length: number; unknown: boolean } | null {
  const vint = readEbmlVint(bytes, offset, limit);
  if (!vint || vint.length > 8) return null;
  const dataMask = vint.marker - 1;
  let value = vint.firstByte & dataMask;
  let allOnes = value === dataMask;
  for (let i = 1; i < vint.length; i++) {
    const b = bytes[offset + i];
    value = value * 256 + b;
    if (b !== 0xff) allOnes = false;
  }
  return { size: value, length: vint.length, unknown: allOnes };
}

/**
 * Read one element (id + size) at `offset`, bounded to `limit`. An
 * unknown-size element is treated as extending to `limit` — we cannot know
 * its true end, so we defensively assume it is the last element in the
 * current bounded range rather than guessing further (and this keeps every
 * scan bounded, never unbounded).
 */
function readEbmlElement(bytes: Uint8Array, offset: number, limit: number): EbmlElement | null {
  const idInfo = readEbmlId(bytes, offset, limit);
  if (!idInfo) return null;
  const sizeInfo = readEbmlSize(bytes, offset + idInfo.length, limit);
  if (!sizeInfo) return null;
  const contentStart = offset + idInfo.length + sizeInfo.length;
  if (contentStart > limit) return null;
  if (sizeInfo.unknown) {
    return { id: idInfo.id, contentStart, contentEnd: limit };
  }
  const contentEnd = contentStart + sizeInfo.size;
  if (contentEnd > limit || contentEnd < contentStart) return null; // truncated or overflowed
  return { id: idInfo.id, contentStart, contentEnd };
}

/**
 * First direct child with `id` inside [start, end). Null if absent, on any
 * parse doubt, or not found within the first EBML_MAX_CHILDREN siblings.
 */
function findEbmlChild(bytes: Uint8Array, id: number, start: number, end: number): EbmlElement | null {
  let offset = start;
  for (let read = 0; offset < end; read++) {
    if (read >= EBML_MAX_CHILDREN) return null;
    const el = readEbmlElement(bytes, offset, end);
    if (!el) return null;
    if (el.id === id) return el;
    offset = el.contentEnd;
  }
  return null;
}

/**
 * All direct children with `id` inside [start, end); stops (without failing)
 * at the first parse doubt, or after EBML_MAX_CHILDREN siblings.
 */
function findAllEbmlChildren(bytes: Uint8Array, id: number, start: number, end: number): EbmlElement[] {
  const result: EbmlElement[] = [];
  let offset = start;
  for (let read = 0; offset < end; read++) {
    if (read >= EBML_MAX_CHILDREN) break;
    const el = readEbmlElement(bytes, offset, end);
    if (!el) break;
    if (el.id === id) result.push(el);
    offset = el.contentEnd;
  }
  return result;
}

function readEbmlFloat(bytes: Uint8Array, view: DataView, start: number, end: number): number | null {
  const length = end - start;
  if (length === 4) return view.getFloat32(start, false); // EBML numerics are stored big-endian
  if (length === 8) return view.getFloat64(start, false);
  return null;
}

function sniffWebm(bytes: Uint8Array, view: DataView): number | null {
  const scanEnd = bytes.length;
  const header = readEbmlElement(bytes, 0, scanEnd); // the EBML header element itself
  if (!header) return null;
  const segment = findEbmlChild(bytes, EBML_ID_SEGMENT, header.contentEnd, scanEnd);
  if (!segment) return null;
  const tracks = findEbmlChild(bytes, EBML_ID_TRACKS, segment.contentStart, segment.contentEnd);
  if (!tracks) return null;

  for (const entry of findAllEbmlChildren(bytes, EBML_ID_TRACKENTRY, tracks.contentStart, tracks.contentEnd)) {
    const codec = findEbmlChild(bytes, EBML_ID_CODECID, entry.contentStart, entry.contentEnd);
    if (codec && readAscii(bytes, codec.contentStart, codec.contentEnd - codec.contentStart) === 'A_OPUS') {
      return 48000; // Opus always decodes at 48 kHz regardless of the stored value
    }
    const audio = findEbmlChild(bytes, EBML_ID_AUDIO, entry.contentStart, entry.contentEnd);
    if (!audio) continue;
    const freq = findEbmlChild(bytes, EBML_ID_SAMPLINGFREQUENCY, audio.contentStart, audio.contentEnd);
    if (!freq) continue;
    const rate = readEbmlFloat(bytes, view, freq.contentStart, freq.contentEnd);
    if (rate && rate > 0) return Math.round(rate);
  }
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
 * Bounded scan: at most this many SIBLING boxes are collected per level. Every
 * other sniffer here is bounded too, by its own shape: the EBML walk by
 * `EBML_MAX_CHILDREN` (a per-level sibling count, like this one — the 512 KB
 * byte cap it used to have was removed as the wrong shape), and the Ogg and
 * FLAC sniffers by having no loop at all, reading fixed offsets in the first
 * page / stream header. Without this one, a 200 MB `.m4a` padded with ~25 million empty 8-byte
 * `free` boxes made this loop run 25 million iterations on the MAIN THREAD and
 * build a 25-million-element array of box records before OOMing — reachable
 * from nothing more than opening a file.
 *
 * A byte-range cap — the shape the EBML walk used before `EBML_MAX_CHILDREN`
 * replaced it, for the same reason — would have been the WRONG bound here
 * and is deliberately not used: this walk is size-driven, so it steps over a
 * multi-hundred-megabyte `mdat` in ONE iteration, and `moov` legitimately sits
 * AFTER that `mdat` in every non-faststart file — capping the byte range would
 * break sniffing for exactly the large files it was meant to protect. Bounding
 * the box COUNT bounds both the loop and the allocation while leaving the
 * size-driven jumps intact.
 */
const MP4_MAX_BOXES = 4096;

/**
 * Read the sibling boxes in [start, end). Returns null on any parse doubt: a
 * malformed (size<8) or truncated box, or a 64-bit largesize that is
 * truncated, not safely representable as a Number, or overflows the range.
 *
 * Hitting `MP4_MAX_BOXES` is NOT parse doubt, so it returns the bounded PREFIX
 * collected so far rather than null: the layouts that legitimately run to many
 * top-level boxes are fragmented MP4s, whose `moov` sits at the very front, so
 * a prefix still finds it — while a `free`-box flood, which has no `moov` to
 * find, simply falls back to the default rate instead of freezing the app.
 */
function readBoxes(bytes: Uint8Array, view: DataView, start: number, end: number): Mp4Box[] | null {
  const boxes: Mp4Box[] = [];
  let offset = start;
  while (offset + 8 <= end) {
    if (boxes.length >= MP4_MAX_BOXES) return boxes;
    const size = view.getUint32(offset, false); // MP4 boxes are big-endian
    const type = readAscii(bytes, offset + 4, 4);
    if (size === 1) {
      // 64-bit largesize: an 8-byte big-endian size follows the 8-byte
      // size+type header, so the box header is 16 bytes instead of 8.
      if (offset + 16 > end) return null; // truncated largesize field
      const largesize = view.getBigUint64(offset + 8, false);
      if (largesize > BigInt(Number.MAX_SAFE_INTEGER)) return null; // not safely representable
      const largesizeNum = Number(largesize);
      if (largesizeNum < 16) return null; // must fit its own 16-byte header
      const boxEnd = offset + largesizeNum;
      if (boxEnd > end) return null; // exceeds the enclosing range
      boxes.push({ type, start: offset, contentStart: offset + 16, end: boxEnd });
      offset = boxEnd;
      continue;
    }
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

/**
 * Best-effort: returns the FIRST trak whose mdhd timescale looks like an audio
 * rate (8000..192000) WITHOUT checking the trak's handler type (`hdlr` ==
 * 'soun'). Fine for .m4a (audio-only); a video .mp4 whose video track uses an
 * audio-plausible timescale may yield the video timescale instead — decodeAudio's
 * construct-retry then absorbs any rate the context rejects.
 */
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

// --- ADTS / AAC ----------------------------------------------------------------

// ISO/IEC 13818-7 sampling_frequency_index -> Hz table. Indices 12-15 are
// reserved/escape (not covered by this table) and rejected.
const ADTS_RATE_TABLE = [
  96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000,
];

interface AdtsFrame {
  sampleRate: number;
  frameLength: number;
}

/**
 * Parse a 7-byte fixed ADTS header at `offset`. Returns null on any bounds
 * doubt, a non-zero layer (ADTS is always layer 00 — this is what tells it
 * apart from an MPEG audio frame sync, which never has layer 00), or an
 * invalid/reserved sampling_frequency_index.
 */
function readAdtsFrame(bytes: Uint8Array, offset: number): AdtsFrame | null {
  if (offset + 7 > bytes.length) return null;
  if (bytes[offset] !== 0xff) return null;
  const b1 = bytes[offset + 1];
  if ((b1 & 0xf0) !== 0xf0) return null; // 12-bit syncword
  const layer = (b1 >> 1) & 0x03;
  if (layer !== 0x00) return null; // ADTS is always layer 00

  const b2 = bytes[offset + 2];
  const freqIndex = (b2 >> 2) & 0x0f;
  if (freqIndex >= ADTS_RATE_TABLE.length) return null; // 12/13/14/15: reserved or escape

  const b3 = bytes[offset + 3];
  const b4 = bytes[offset + 4];
  const b5 = bytes[offset + 5];
  const frameLength = ((b3 & 0x03) << 11) | (b4 << 3) | (b5 >> 5);
  if (frameLength < 7) return null; // must be at least the fixed header itself

  return { sampleRate: ADTS_RATE_TABLE[freqIndex], frameLength };
}

/**
 * Scan for a syncword, then require a SECOND valid ADTS header reporting the
 * same rate exactly `frameLength` bytes later before trusting the sync — the
 * same defensive consecutive-frame check the MP3 fallback below relies on to
 * avoid a false positive on a stray 0xFF byte.
 */
function sniffAdts(bytes: Uint8Array): number | null {
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
    const frame = readAdtsFrame(bytes, i);
    if (!frame) continue;
    const next = readAdtsFrame(bytes, i + frame.frameLength);
    if (next && next.sampleRate === frame.sampleRate) return frame.sampleRate;
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
    const bitrateIndex = (bytes[i + 2] >> 4) & 0x0f;
    if (bitrateIndex === 0x0f) continue; // reserved — cuts false syncs
    const srIndex = (bytes[i + 2] >> 2) & 0x03;
    if (srIndex === 0x03) continue; // reserved sample-rate index
    const row = MP3_RATE_TABLE[versionBits];
    if (!row) continue;
    if (bitrateIndex !== 0x00) return row[srIndex];
    // Free format (bitrate_index 0000, ISO/IEC 11172-3 §2.4.2.3): the bitrate
    // is not in the table, so a lone header is indistinguishable from a stray
    // 0xFF in payload/tag bytes (which is why this index used to be skipped
    // outright). Accept it only when a second header confirms it — the same
    // consecutive-frame defence sniffAdts uses above.
    if (confirmFreeFormatMp3(bytes, i, b1, srIndex)) return row[srIndex];
  }
  return null;
}

/**
 * The longest frame a free-format header this sniffer accepts could legally
 * describe. ISO/IEC 11172-3 §2.4.2.3 (and its ISO/IEC 13818-3 LSF extension)
 * fixes the free-format bitrate for the whole stream and requires it to be
 * BELOW the layer's maximum tabled bitrate, so no free frame can exceed the
 * largest tabled frame. Maximising frame bytes over every version/layer/rate
 * combination the header can encode: Layer II at the LSF table maximum of
 * 160 kbps and the MPEG-2.5 minimum rate of 8000 Hz — 144·160000/8000 = 2880,
 * plus one padding slot = 2881 bytes. (For comparison: MPEG-1 Layer II at
 * 384 kbps / 32 kHz = 1729; Layer III tops out at 1441; Layer I, measured in
 * 4-byte slots, at (12·256000/8000 + 1)·4 = 1540.)
 */
const MP3_MAX_FREE_FRAME = 2881;

/**
 * A free-format header at `i` is confirmed only by a SECOND header that starts
 * after the first header's own 4 bytes and within the longest legal frame,
 * whose sync/version/layer bits match (b1 with the protection bit masked off),
 * whose bitrate_index is also free (the spec fixes the free bitrate for the
 * whole stream, so a mid-stream switch to a tabled index cannot be the same
 * stream), and whose sample-rate index matches.
 */
function confirmFreeFormatMp3(bytes: Uint8Array, i: number, b1: number, srIndex: number): boolean {
  const last = Math.min(i + MP3_MAX_FREE_FRAME, bytes.length - 3);
  for (let j = i + 4; j <= last; j++) {
    if (bytes[j] !== 0xff) continue;
    if ((bytes[j + 1] & 0xfe) !== (b1 & 0xfe)) continue; // sync + version + layer must match
    if (((bytes[j + 2] >> 4) & 0x0f) !== 0x00) continue; // must also be free format
    if (((bytes[j + 2] >> 2) & 0x03) !== srIndex) continue; // same sample-rate index
    return true;
  }
  return false;
}
