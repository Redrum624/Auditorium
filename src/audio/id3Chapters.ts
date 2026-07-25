/**
 * MP3 marker persistence via ID3v2.3 chapter frames (CTOC/CHAP, ID3v2 Chapter
 * Frame Addendum) plus a private `TXXX AUDITORIUM_MARKERS` frame carrying the
 * exact sample-accurate positions as compact JSON (see the v1.3 cross-task
 * contract). CHAP start/end ms are the interop-friendly (lossy-to-the-
 * millisecond) representation; TXXX is the sample-exact source of truth and is
 * always preferred on read.
 */

export interface Id3ChapterMarker {
  positionSample: number;
  name: string;
}

export interface ParsedId3Chapter {
  positionMs: number;
  name: string;
  /** Sample-exact position from the AUDITORIUM_MARKERS TXXX frame, when present. */
  exactSample?: number;
}

const TXXX_DESCRIPTION = 'AUDITORIUM_MARKERS';

/** CTOC/CHAP interop frames are capped at this many markers — CTOC's entry
 * count is a single byte, so anything beyond this would silently declare the
 * wrong count (Task M6 / F22). TXXX AUDITORIUM_MARKERS (the source of truth
 * on read) always carries the full list regardless of marker count. */
const CTOC_CHAP_CAP = 255;

// ---- byte helpers -----------------------------------------------------

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

/** Encode a 28-bit value as a 4-byte ID3v2 syncsafe integer (top bit of each
 * byte always 0, 7 data bits per byte, MSB first). */
function syncsafe32(n: number): Uint8Array {
  return new Uint8Array([(n >>> 21) & 0x7f, (n >>> 14) & 0x7f, (n >>> 7) & 0x7f, n & 0x7f]);
}

function readSyncsafe32(view: DataView, offset: number): number {
  return (
    ((view.getUint8(offset) & 0x7f) << 21) |
    ((view.getUint8(offset + 1) & 0x7f) << 14) |
    ((view.getUint8(offset + 2) & 0x7f) << 7) |
    (view.getUint8(offset + 3) & 0x7f)
  );
}

/** ASCII bytes of `s` followed by a single NUL terminator (element IDs are
 * always plain ASCII in this module's own output). */
function asciiNul(s: string): Uint8Array {
  const out = new Uint8Array(s.length + 1);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  out[s.length] = 0;
  return out;
}

/** UTF-16LE code units of `str` (no BOM, no terminator) — a JS string's code
 * units already ARE UTF-16, so this is a direct re-serialization (surrogate
 * pairs round-trip correctly since both halves are written/read as-is). */
function utf16leBytes(str: string): Uint8Array {
  const out = new Uint8Array(str.length * 2);
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    out[i * 2] = code & 0xff;
    out[i * 2 + 1] = (code >> 8) & 0xff;
  }
  return out;
}

function utf16leToString(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    s += String.fromCharCode(bytes[i] | (bytes[i + 1] << 8));
  }
  return s;
}

function utf16beToString(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    s += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
  }
  return s;
}

function latin1ToString(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

function decodeBytes(bytes: Uint8Array, encoding: number): string {
  if (encoding === 0x03) {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      return latin1ToString(bytes);
    }
  }
  return latin1ToString(bytes);
}

// ---- build --------------------------------------------------------------

/** Frame header (v2.3 layout): 4-char id, u32 BE PLAIN size (payload length,
 * excludes this 10-byte header), 2 flag bytes (always 0x00 0x00 here). */
function buildFrame(id: string, payload: Uint8Array): Uint8Array {
  const header = new Uint8Array(10);
  for (let i = 0; i < 4; i++) header[i] = id.charCodeAt(i);
  const view = new DataView(header.buffer);
  view.setUint32(4, payload.length, false);
  header[8] = 0x00;
  header[9] = 0x00;
  return concatBytes([header, payload]);
}

function buildCtocPayload(count: number): Uint8Array {
  const children: Uint8Array[] = [];
  for (let i = 0; i < count; i++) children.push(asciiNul(`chp${i}`));
  return concatBytes([asciiNul('toc'), new Uint8Array([0x03, count & 0xff]), ...children]);
}

function buildTit2Frame(name: string): Uint8Array {
  const payload = concatBytes([new Uint8Array([0x01, 0xff, 0xfe]), utf16leBytes(name)]);
  return buildFrame('TIT2', payload);
}

function buildChapPayload(index: number, startMs: number, tit2: Uint8Array): Uint8Array {
  const elementId = asciiNul(`chp${index}`);
  const nums = new Uint8Array(16);
  const view = new DataView(nums.buffer);
  view.setUint32(0, startMs >>> 0, false); // start time (ms)
  view.setUint32(4, startMs >>> 0, false); // end time (ms) — point marker, same as start
  view.setUint32(8, 0xffffffff, false); // start byte offset — unset
  view.setUint32(12, 0xffffffff, false); // end byte offset — unset
  return concatBytes([elementId, nums, tit2]);
}

function buildTxxxPayload(json: string): Uint8Array {
  const description = concatBytes([
    new Uint8Array([0xff, 0xfe]),
    utf16leBytes(TXXX_DESCRIPTION),
    new Uint8Array([0x00, 0x00]),
  ]);
  const value = concatBytes([new Uint8Array([0xff, 0xfe]), utf16leBytes(json)]);
  return concatBytes([new Uint8Array([0x01]), description, value]);
}

/**
 * Build an ID3v2.3 tag carrying `markers` as CTOC + one CHAP per marker
 * (interop chapter fields, millisecond-rounded) plus a private
 * `TXXX AUDITORIUM_MARKERS` frame (sample-exact JSON, the source of truth on
 * read). No unsynchronisation, no extended header, no padding.
 *
 * CTOC/CHAP are capped at the first `CTOC_CHAP_CAP` (255) markers BY POSITION
 * (Task M6 / F22) — CTOC's entry count is a single byte, so beyond that it
 * would declare a count that doesn't match the emitted child list. TXXX is
 * never capped or reordered: it always carries every marker, in input order.
 */
export function buildId3Chapters(markers: Id3ChapterMarker[], sampleRate: number): Uint8Array {
  const interopMarkers = [...markers]
    .sort((a, b) => a.positionSample - b.positionSample)
    .slice(0, CTOC_CHAP_CAP);
  const frames: Uint8Array[] = [buildFrame('CTOC', buildCtocPayload(interopMarkers.length))];

  interopMarkers.forEach((m, i) => {
    const startMs = Math.round((m.positionSample / sampleRate) * 1000);
    const tit2 = buildTit2Frame(m.name);
    frames.push(buildFrame('CHAP', buildChapPayload(i, startMs, tit2)));
  });

  const json = JSON.stringify(markers.map((m) => ({ s: Math.round(m.positionSample), n: m.name })));
  frames.push(buildFrame('TXXX', buildTxxxPayload(json)));

  const body = concatBytes(frames);
  const header = new Uint8Array(10);
  header[0] = 0x49; // 'I'
  header[1] = 0x44; // 'D'
  header[2] = 0x33; // '3'
  header[3] = 0x03; // major version 3
  header[4] = 0x00; // minor version 0
  header[5] = 0x00; // flags
  header.set(syncsafe32(body.length), 6);
  return concatBytes([header, body]);
}

// ---- parse ----------------------------------------------------------------

/** Reads a NUL-terminated string starting at `start`, bounded by `end`.
 * For UTF-16 encodings (0x01 BOM-prefixed, 0x02 BE no BOM) the terminator is
 * a 2-byte 00 00; for Latin-1/UTF-8 it is a single 0x00. Returns the decoded
 * text and the offset immediately after the terminator (or `end` if none was
 * found before the boundary — tolerated, not an error). */
function readTerminatedString(
  view: DataView,
  start: number,
  end: number,
  encoding: number
): { text: string; next: number } {
  if (encoding === 0x01 || encoding === 0x02) {
    let little = encoding !== 0x02;
    let textStart = start;
    if (encoding === 0x01 && start + 1 < end) {
      const b0 = view.getUint8(start);
      const b1 = view.getUint8(start + 1);
      if (b0 === 0xff && b1 === 0xfe) {
        little = true;
        textStart = start + 2;
      } else if (b0 === 0xfe && b1 === 0xff) {
        little = false;
        textStart = start + 2;
      }
    }
    let cursor = textStart;
    while (cursor + 1 < end && !(view.getUint8(cursor) === 0 && view.getUint8(cursor + 1) === 0)) {
      cursor += 2;
    }
    const found = cursor + 1 < end && view.getUint8(cursor) === 0 && view.getUint8(cursor + 1) === 0;
    const bytes = new Uint8Array(view.buffer, view.byteOffset + textStart, cursor - textStart);
    const text = little ? utf16leToString(bytes) : utf16beToString(bytes);
    return { text, next: found ? cursor + 2 : cursor };
  }

  let cursor = start;
  while (cursor < end && view.getUint8(cursor) !== 0) cursor++;
  const bytes = new Uint8Array(view.buffer, view.byteOffset + start, cursor - start);
  return { text: decodeBytes(bytes, encoding), next: cursor < end ? cursor + 1 : cursor };
}

/** Reads the LAST string field in a frame — consumes to `end`, tolerating
 * (and stripping) a trailing NUL terminator some writers still include. */
function readFieldToEnd(view: DataView, start: number, end: number, encoding: number): string {
  if (encoding === 0x01 || encoding === 0x02) {
    let little = encoding !== 0x02;
    let textStart = start;
    if (encoding === 0x01 && start + 1 < end) {
      const b0 = view.getUint8(start);
      const b1 = view.getUint8(start + 1);
      if (b0 === 0xff && b1 === 0xfe) {
        little = true;
        textStart = start + 2;
      } else if (b0 === 0xfe && b1 === 0xff) {
        little = false;
        textStart = start + 2;
      }
    }
    let textEnd = end;
    if (textEnd - 2 >= textStart && view.getUint8(textEnd - 2) === 0 && view.getUint8(textEnd - 1) === 0) {
      textEnd -= 2;
    }
    const bytes = new Uint8Array(view.buffer, view.byteOffset + textStart, Math.max(0, textEnd - textStart));
    return little ? utf16leToString(bytes) : utf16beToString(bytes);
  }

  let textEnd = end;
  if (textEnd - 1 >= start && view.getUint8(textEnd - 1) === 0) textEnd -= 1;
  const bytes = new Uint8Array(view.buffer, view.byteOffset + start, Math.max(0, textEnd - start));
  return decodeBytes(bytes, encoding);
}

function readFrameId(view: DataView, offset: number): string {
  return String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3)
  );
}

function readFrameSize(view: DataView, offset: number, major: number): number {
  return major === 4 ? readSyncsafe32(view, offset) : view.getUint32(offset, false);
}

function parseTxxxFrame(view: DataView, start: number, end: number): { description: string; value: string } | null {
  if (start >= end) return null;
  const encoding = view.getUint8(start);
  const { text: description, next } = readTerminatedString(view, start + 1, end, encoding);
  const value = readFieldToEnd(view, next, end, encoding);
  return { description, value };
}

/** Parses a CHAP frame's fixed fields plus its embedded TIT2 sub-frame (if
 * present). Sub-frames use the same version-dependent size encoding as the
 * outer tag. Returns null when the element id has no terminator before `end`
 * (frame too corrupt/truncated to trust). */
function parseChapFrame(
  view: DataView,
  start: number,
  end: number,
  major: number
): { positionMs: number; name?: string } | null {
  let i = start;
  while (i < end && view.getUint8(i) !== 0) i++;
  if (i >= end) return null;
  let pos = i + 1;
  if (pos + 16 > end) return null;
  const startMs = view.getUint32(pos, false);
  pos += 16;

  let name: string | undefined;
  let sub = pos;
  while (sub + 10 <= end) {
    if (view.getUint8(sub) === 0) break; // padding-style terminator inside the frame
    const id = readFrameId(view, sub);
    const subSize = readFrameSize(view, sub + 4, major);
    const subDataStart = sub + 10;
    const subDataEnd = subDataStart + subSize;
    if (subSize < 0 || subDataEnd > end || subDataEnd < subDataStart) break;
    if (id === 'TIT2' && subDataStart < subDataEnd) {
      const encoding = view.getUint8(subDataStart);
      name = readFieldToEnd(view, subDataStart + 1, subDataEnd, encoding);
    }
    sub = subDataEnd;
  }

  return { positionMs: startMs, name };
}

interface RawMarkerJson {
  s: number;
  n: string;
}

function isRawMarkerJson(v: unknown): v is RawMarkerJson {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as { s?: unknown }).s === 'number' &&
    Number.isFinite((v as { s: number }).s) &&
    typeof (v as { n?: unknown }).n === 'string'
  );
}

function parseId3ChaptersInner(buf: ArrayBuffer): ParsedId3Chapter[] | null {
  if (buf.byteLength < 10) return null;
  const view = new DataView(buf);
  if (view.getUint8(0) !== 0x49 || view.getUint8(1) !== 0x44 || view.getUint8(2) !== 0x33) return null; // 'ID3'

  const major = view.getUint8(3);
  if (major !== 3 && major !== 4) return null;
  const flags = view.getUint8(5);
  const tagSize = readSyncsafe32(view, 6);
  const tagEnd = Math.min(10 + tagSize, view.byteLength);

  let offset = 10;
  if ((flags & 0x40) !== 0) {
    // Extended header. v2.3: size field EXCLUDES itself (typically 6 or 10);
    // v2.4: the syncsafe size INCLUDES the 4-byte size field itself.
    if (offset + 4 > tagEnd) return null;
    if (major === 4) {
      const extSize = readSyncsafe32(view, offset);
      if (extSize < 4) return null;
      offset += extSize;
    } else {
      const extSize = view.getUint32(offset, false);
      offset += 4 + extSize;
    }
  }

  const chapList: { positionMs: number; name?: string }[] = [];
  let txxxEntries: RawMarkerJson[] | null = null;

  while (offset + 10 <= tagEnd) {
    if (view.getUint8(offset) === 0) break; // padding
    const id = readFrameId(view, offset);
    const frameSize = readFrameSize(view, offset + 4, major);
    const frameDataStart = offset + 10;
    const frameDataEnd = frameDataStart + frameSize;
    if (frameSize < 0 || frameDataEnd > tagEnd || frameDataEnd < frameDataStart) break; // truncated/corrupt

    if (id === 'TXXX' && txxxEntries === null) {
      const parsed = parseTxxxFrame(view, frameDataStart, frameDataEnd);
      if (parsed && parsed.description === TXXX_DESCRIPTION) {
        try {
          const value: unknown = JSON.parse(parsed.value);
          if (Array.isArray(value)) {
            const entries = value.filter(isRawMarkerJson);
            if (entries.length > 0) txxxEntries = entries;
          }
        } catch {
          // Malformed JSON — fall through to the CHAP list below.
        }
      }
    } else if (id === 'CHAP') {
      const chap = parseChapFrame(view, frameDataStart, frameDataEnd, major);
      if (chap) chapList.push(chap);
    }

    offset = frameDataEnd;
  }

  if (txxxEntries) {
    // chapList is in CHAP-EMISSION order, which is the first CTOC_CHAP_CAP
    // TXXX entries sorted BY POSITION (buildId3Chapters), not TXXX's own
    // (input) order — those only coincide when the writer's input already
    // happened to be position-sorted. Re-rank txxxEntries by `s` to recover
    // the emission order before pairing positionMs by index (Task M6 fix
    // round 1): entries beyond CHAP's cap (or a v2.3/v2.4 CHAP-less TXXX
    // beyond the 255 that were ever written) correctly fall back to 0.
    const byPosition = [...txxxEntries].sort((a, b) => a.s - b.s);
    const positionMsByEntry = new Map<RawMarkerJson, number>(
      byPosition.map((e, i) => [e, chapList[i]?.positionMs ?? 0])
    );
    return txxxEntries.map((e) => ({
      positionMs: positionMsByEntry.get(e) ?? 0,
      name: e.n,
      exactSample: Math.round(e.s),
    }));
  }

  if (chapList.length > 0) {
    return chapList.map((c, i) => ({ positionMs: c.positionMs, name: c.name ?? `Marker ${i + 1}` }));
  }

  return null;
}

/**
 * Parse an ID3v2 tag (v2.3 plain frame sizes or v2.4 syncsafe frame sizes)
 * looking for chapter markers: prefers the sample-exact `TXXX
 * AUDITORIUM_MARKERS` JSON when present and parseable, else falls back to the
 * CHAP frame list (title from an embedded TIT2, else `Marker N`). Tolerates
 * an extended header, unknown frames, and padding (a frame id starting with a
 * 0x00 byte stops the walk). Never throws — any corrupt/absent/unsupported
 * tag or truncated frame yields `null`.
 */
export function parseId3Chapters(buf: ArrayBuffer): ParsedId3Chapter[] | null {
  try {
    return parseId3ChaptersInner(buf);
  } catch {
    return null;
  }
}
