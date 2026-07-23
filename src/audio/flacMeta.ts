/**
 * FLAC metadata-block walker for marker persistence (Task K4). Locates the
 * VORBIS_COMMENT block (type 4) among a FLAC file's leading metadata blocks
 * and parses it via `chapterTags.ts`'s shared vorbis-comment layout.
 *
 * `src/audio/sniffSampleRate.ts`'s `readFlacStreamInfo` reads STREAMINFO at a
 * FIXED byte offset (it is always the first block); this module instead walks
 * the metadata-block CHAIN (1-byte `is-last<<7 | type`, 3-byte BE length),
 * since VORBIS_COMMENT can be any block after STREAMINFO and its offset is
 * not fixed. Parsing is deliberately conservative: any bounds overrun,
 * missing magic, or corrupt payload yields `null`. It never throws.
 */

import { parseVorbisCommentPayload } from './chapterTags';

const BLOCK_TYPE_VORBIS_COMMENT = 4;

// Defensive cap on the number of metadata blocks walked, so a corrupt file
// that never sets the is-last flag cannot loop indefinitely (each iteration
// also always advances `offset` by at least 4 bytes, so this is a belt-and-
// braces bound on top of the byte-length bound below).
const MAX_BLOCKS = 1024;

function matchAscii(bytes: Uint8Array, offset: number, str: string): boolean {
  if (offset + str.length > bytes.length) return false;
  for (let i = 0; i < str.length; i++) {
    if (bytes[offset + i] !== str.charCodeAt(i)) return false;
  }
  return true;
}

/**
 * Walk a FLAC file's metadata-block chain (starting right after the `'fLaC'`
 * magic) looking for the VORBIS_COMMENT block (type 4), and parse its
 * payload. Returns `null` when the magic is missing, no VORBIS_COMMENT block
 * is present, or any bounds/parse doubt arises while walking.
 */
export function readFlacVorbisComment(buf: ArrayBuffer): { vendor: string; comments: string[] } | null {
  try {
    const bytes = new Uint8Array(buf);
    if (!matchAscii(bytes, 0, 'fLaC')) return null;

    let offset = 4;
    for (let i = 0; i < MAX_BLOCKS; i++) {
      if (offset + 4 > bytes.length) return null; // truncated block header
      const headerByte = bytes[offset];
      const isLast = (headerByte & 0x80) !== 0;
      const blockType = headerByte & 0x7f;
      const length = (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3];
      const dataStart = offset + 4;
      const dataEnd = dataStart + length;
      if (dataEnd > bytes.length || dataEnd < dataStart) return null; // truncated/corrupt

      if (blockType === BLOCK_TYPE_VORBIS_COMMENT) {
        return parseVorbisCommentPayload(bytes.subarray(dataStart, dataEnd));
      }
      if (isLast) return null; // walked every block, none was VORBIS_COMMENT
      offset = dataEnd;
    }
    return null; // exceeded MAX_BLOCKS without finding a last-flagged block
  } catch {
    return null;
  }
}
