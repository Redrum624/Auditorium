/**
 * Shared chapter-tag helpers for the Vorbis-comment-based marker persistence
 * used by FLAC's VORBIS_COMMENT metadata block (Task K4) and OGG/Opus's
 * OpusTags packet (Task K5) — see the v1.3 cross-task contract in
 * `.superpowers/sdd/briefs/v13-contracts.md`.
 *
 * Layout (shared by both containers): `vendor_length` u32 LE + vendor UTF-8
 * bytes + `comment_count` u32 LE + per comment (`length` u32 LE + UTF-8
 * "KEY=value"). Keys are case-insensitive ASCII.
 *
 * Chapter positions are carried two ways in the comment list: de-facto-standard
 * `CHAPTERxxx` / `CHAPTERxxxNAME` pairs (interop, `HH:MM:SS.mmm`, millisecond-
 * rounded — readable by players/taggers that understand Vorbis chapter
 * comments) and a private `AUDITORIUM_MARKERS` comment (compact JSON,
 * sample-exact at the file's own rate — the source of truth on read).
 */

export interface ChapterMarker {
  positionSample: number;
  name: string;
}

const AUDITORIUM_KEY = 'AUDITORIUM_MARKERS';

// ---- time formatting ------------------------------------------------------

/** `HH:MM:SS.mmm`, millisecond-rounded; hours grow past 2 digits rather than
 * wrapping (`padStart` only ever adds digits, never truncates). */
function formatChapterTime(positionSample: number, sampleRate: number): string {
  const rawMs = (positionSample / sampleRate) * 1000;
  const totalMs = Number.isFinite(rawMs) ? Math.max(0, Math.round(rawMs)) : 0;
  const hours = Math.floor(totalMs / 3_600_000);
  const minutes = Math.floor((totalMs % 3_600_000) / 60_000);
  const seconds = Math.floor((totalMs % 60_000) / 1000);
  const millis = totalMs % 1000;
  return (
    `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:` +
    `${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`
  );
}

/** Lenient `H+:MM:SS[.mmm]` parser -> milliseconds. Null on unparsable text
 * (never throws; the caller simply skips that CHAPTERxxx entry). */
function parseChapterTimeMs(text: string): number | null {
  const match = /^(\d+):(\d{1,2}):(\d{1,2})(?:\.(\d{1,3}))?$/.exec(text.trim());
  if (!match) return null;
  const hours = parseInt(match[1], 10);
  const minutes = parseInt(match[2], 10);
  const seconds = parseInt(match[3], 10);
  const millis = match[4] === undefined ? 0 : parseInt(match[4].padEnd(3, '0'), 10);
  return ((hours * 60 + minutes) * 60 + seconds) * 1000 + millis;
}

// ---- CHAPTERxxx build/parse -----------------------------------------------

/**
 * Build the Vorbis-comment strings for `markers`: one `CHAPTERxxx` +
 * `CHAPTERxxxNAME` pair per marker (1-based, 3-digit index, in input order),
 * followed by a single `AUDITORIUM_MARKERS` comment carrying the exact
 * sample-accurate positions as compact JSON (`round`ed to the nearest
 * sample). Always includes the `AUDITORIUM_MARKERS` comment, even for an
 * empty `markers` array (`AUDITORIUM_MARKERS=[]`) — callers that only want to
 * write a tag when markers exist should check `markers.length` themselves
 * (see `flacEncoder.ts`).
 */
export function buildChapterComments(markers: ChapterMarker[], fileSampleRate: number): string[] {
  const comments: string[] = [];
  markers.forEach((m, i) => {
    const idx = String(i + 1).padStart(3, '0');
    comments.push(`CHAPTER${idx}=${formatChapterTime(m.positionSample, fileSampleRate)}`);
    comments.push(`CHAPTER${idx}NAME=${m.name}`);
  });
  const json = JSON.stringify(markers.map((m) => ({ s: Math.round(m.positionSample), n: m.name })));
  comments.push(`${AUDITORIUM_KEY}=${json}`);
  return comments;
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

/** Splits `"KEY=value"` on the FIRST `=` only (values, e.g. JSON, may
 * legitimately contain `=`). Returns null when there is no `=` at all. */
function splitComment(comment: string): { key: string; value: string } | null {
  const eq = comment.indexOf('=');
  if (eq < 0) return null;
  return { key: comment.slice(0, eq), value: comment.slice(eq + 1) };
}

const CHAPTER_NAME_RE = /^CHAPTER(\d{2,4})NAME$/i;
const CHAPTER_TIME_RE = /^CHAPTER(\d{2,4})$/i;

/**
 * Parse chapter markers out of a Vorbis comment list. Prefers the first
 * `AUDITORIUM_MARKERS` comment whose value parses as JSON and yields at
 * least one structurally-valid entry (`{ s: number, n: string }`);
 * structurally-invalid entries in that array are dropped silently, matching
 * the cross-task contract. Falls back to `CHAPTERxxx` / `CHAPTERxxxNAME`
 * pairs — lenient per the contract: 2-4 digit indices, 0- or 1-based
 * numbering (indices are matched by numeric value, not string width or
 * base), case-insensitive keys, sorted by index. An unmatched `CHAPTERxxx`
 * (no corresponding `NAME`) falls back to `Marker <index>`. Never throws;
 * returns `[]` when nothing usable is found.
 */
export function parseChapterComments(
  comments: string[],
  fileSampleRate: number
): { positionSample: number; name: string }[] {
  for (const comment of comments) {
    const split = splitComment(comment);
    if (!split || split.key.toUpperCase() !== AUDITORIUM_KEY) continue;
    try {
      const parsed: unknown = JSON.parse(split.value);
      if (Array.isArray(parsed)) {
        const entries = parsed.filter(isRawMarkerJson);
        if (entries.length > 0) {
          return entries.map((e) => ({ positionSample: Math.round(e.s), name: e.n }));
        }
      }
    } catch {
      // Malformed JSON — fall through to (or keep scanning for) CHAPTERxxx.
    }
  }

  const timeByIndex = new Map<number, number>(); // numeric index -> ms
  const nameByIndex = new Map<number, string>();
  for (const comment of comments) {
    const split = splitComment(comment);
    if (!split) continue;
    const nameMatch = CHAPTER_NAME_RE.exec(split.key);
    if (nameMatch) {
      nameByIndex.set(parseInt(nameMatch[1], 10), split.value);
      continue;
    }
    const timeMatch = CHAPTER_TIME_RE.exec(split.key);
    if (timeMatch) {
      const ms = parseChapterTimeMs(split.value);
      if (ms !== null) timeByIndex.set(parseInt(timeMatch[1], 10), ms);
    }
  }

  const indices = Array.from(timeByIndex.keys()).sort((a, b) => a - b);
  return indices.map((idx) => {
    const ms = timeByIndex.get(idx) as number;
    const positionSample = Math.round((ms / 1000) * fileSampleRate);
    return { positionSample, name: nameByIndex.get(idx) ?? `Marker ${idx}` };
  });
}

// ---- vorbis-comment binary payload -----------------------------------------

/**
 * Build a raw Vorbis-comment payload: `vendor_length` (u32 LE) + vendor
 * (UTF-8) + `comment_count` (u32 LE) + per comment (`length` u32 LE + UTF-8
 * bytes). This is the payload carried by a FLAC type-4 metadata block AND by
 * an Ogg `OpusTags` packet (after its own 8-byte `"OpusTags"` magic) — the
 * caller wraps this in whichever container framing applies.
 */
export function buildVorbisCommentPayload(vendor: string, comments: string[]): Uint8Array {
  const encoder = new TextEncoder();
  const vendorBytes = encoder.encode(vendor);
  const commentBytes = comments.map((c) => encoder.encode(c));

  let size = 4 + vendorBytes.length + 4;
  for (const cb of commentBytes) size += 4 + cb.length;

  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  let offset = 0;
  view.setUint32(offset, vendorBytes.length, true);
  offset += 4;
  out.set(vendorBytes, offset);
  offset += vendorBytes.length;
  view.setUint32(offset, commentBytes.length, true);
  offset += 4;
  for (const cb of commentBytes) {
    view.setUint32(offset, cb.length, true);
    offset += 4;
    out.set(cb, offset);
    offset += cb.length;
  }
  return out;
}

/**
 * Parse a raw Vorbis-comment payload (the inverse of `buildVorbisCommentPayload`).
 * Bounded and tolerant: any declared length that would run past the end of
 * `bytes`, or a comment count too large to possibly fit, yields `null`. Never
 * throws.
 */
export function parseVorbisCommentPayload(bytes: Uint8Array): { vendor: string; comments: string[] } | null {
  try {
    if (bytes.length < 8) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const decoder = new TextDecoder('utf-8', { fatal: false });

    let offset = 0;
    const vendorLen = view.getUint32(offset, true);
    offset += 4;
    if (offset + vendorLen > bytes.length) return null;
    const vendor = decoder.decode(bytes.subarray(offset, offset + vendorLen));
    offset += vendorLen;

    if (offset + 4 > bytes.length) return null;
    const count = view.getUint32(offset, true);
    offset += 4;
    // Every comment consumes at least 4 bytes (its length field), so a count
    // exceeding the remaining buffer size can never be honest — bail out
    // instead of looping toward a bogus 4-billion-iteration count.
    if (count > bytes.length) return null;

    const comments: string[] = [];
    for (let i = 0; i < count; i++) {
      if (offset + 4 > bytes.length) return null;
      const len = view.getUint32(offset, true);
      offset += 4;
      if (offset + len > bytes.length) return null;
      comments.push(decoder.decode(bytes.subarray(offset, offset + len)));
      offset += len;
    }
    return { vendor, comments };
  } catch {
    return null;
  }
}
