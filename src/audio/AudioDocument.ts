export interface AudioDocument {
  id: string; // 'doc-1', 'doc-2', ... sequential
  name: string; // display name: file basename or 'Untitled 1'
  filePath: string | null; // absolute path when opened from / saved to disk
  sampleRate: number; // e.g. 44100, 48000
  // Usually 1 (mono) or 2 (stereo); a multichannel import keeps all N (<= 32,
  // the decoder bound). All channels are the same length.
  channels: Float32Array[];
  dirty: boolean;
  /**
   * Provenance (Task S4): this document's audio has NEVER been written to a
   * file — true for everything the app COMPUTES (a Mix Down output, `Remix N`,
   * a recording, File > New, a separated stem), false for anything read off
   * disk (an opened file, a `.audm`-embedded document).
   *
   * This is deliberately a SECOND flag rather than `dirty: true` at creation.
   * `dirty` is not a stored fact: `undoHistory` RE-DERIVES it from the undo
   * position relative to the save point on every undo/redo (the v1.4 fix for
   * "undo after Save reported the document as clean"), so a `dirty` stamped at
   * creation survives only until the first Ctrl+Z and then silently clears
   * itself. `neverSaved` is provenance, not edit state: nothing but a
   * successful save ever clears it, and undo/redo never touch it.
   *
   * Read alongside `dirty` by everything that asks "would closing this lose
   * work?" — `closeDocumentFlow` and the close guard's count (App.tsx).
   */
  neverSaved: boolean;
  // Source-file provenance (Task F7, additive-optional). Drives format-faithful
  // Save (re-encode in the original container) and the Properties bit-depth row.
  sourceBitDepth?: number; // original file's PCM depth (WAV/FLAC); undefined for lossy
  sourceFormat?: 'wav' | 'mp3' | 'flac' | 'ogg' | 'other';
  /** Speaker layout of a multichannel source: the raw `dwChannelMask` read from
   * a WAVE_FORMAT_EXTENSIBLE WAV, present only when it fully describes the
   * channels (see `decodeWav`). Consumed by the layout-aware downmix (ITU-R
   * BS.775 requires knowing which channel is centre/LFE/surround). Cleared by
   * any edit that changes the channel count — the mask describes the source
   * file's channels, not a converted set. */
  channelMask?: number;
}

const idCounters: Record<string, number> = {};

export function nextId(prefix: string): string {
  const next = (idCounters[prefix] ?? 0) + 1;
  idCounters[prefix] = next;
  return `${prefix}-${next}`;
}

/**
 * Ensures the next `nextId(prefix)` call returns at least `${prefix}-${minNext}`.
 * Never lowers a counter. Needed when loading records that carry persisted ids
 * (e.g. a saved .audm session keeps its track/clip ids verbatim): the module
 * counters reset every process start, so without seeding them past the loaded
 * ids, a later nextId() could mint a duplicate of an id already in the data.
 */
export function bumpIdCounter(prefix: string, minNext: number): void {
  const current = idCounters[prefix] ?? 0;
  if (minNext - 1 > current) {
    idCounters[prefix] = minNext - 1;
  }
}

export function createDocument(opts: {
  name: string;
  sampleRate: number;
  channels: Float32Array[];
  filePath?: string | null;
  sourceBitDepth?: number;
  sourceFormat?: AudioDocument['sourceFormat'];
  channelMask?: number;
  /**
   * Task S4 provenance. Defaults to "true when there is no `filePath`", so any
   * creation site that computes audio is protected without having to remember
   * this flag — the safe direction to be wrong in. Pass `false` explicitly for
   * path-less audio that nonetheless CAME from disk: an exotic source (m4a,
   * aac, webm — opened with `filePath: null` because it cannot be saved back
   * in place) or a document recreated from a `.audm` session.
   */
  neverSaved?: boolean;
}): AudioDocument {
  return {
    id: nextId('doc'),
    name: opts.name,
    filePath: opts.filePath ?? null,
    sampleRate: opts.sampleRate,
    channels: opts.channels,
    dirty: false,
    neverSaved: opts.neverSaved ?? opts.filePath == null,
    sourceBitDepth: opts.sourceBitDepth,
    sourceFormat: opts.sourceFormat,
    channelMask: opts.channelMask,
  };
}

export function docLength(doc: AudioDocument): number {
  return doc.channels.length === 0 ? 0 : doc.channels[0].length;
}

export function docDuration(doc: AudioDocument): number {
  return docLength(doc) / doc.sampleRate;
}

function clampRange(start: number, end: number, length: number): { start: number; end: number } {
  if (start > end) {
    throw new RangeError(`start (${start}) must not be greater than end (${end})`);
  }
  const clampedStart = Math.min(Math.max(start, 0), length);
  const clampedEnd = Math.min(Math.max(end, 0), length);
  return { start: clampedStart, end: clampedEnd };
}

export function cloneRegion(doc: AudioDocument, start: number, end: number): Float32Array[] {
  const { start: s, end: e } = clampRange(start, end, docLength(doc));
  return doc.channels.map((channel) => channel.slice(s, e));
}

export function coerceChannels(data: Float32Array[], targetCount: number): Float32Array[] {
  if (data.length === targetCount) {
    return data.map((channel) => channel.slice());
  }
  if (data.length === 0) {
    return Array.from({ length: targetCount }, () => new Float32Array(0));
  }
  if (targetCount === 2 && data.length === 1) {
    return [data[0].slice(), data[0].slice()];
  }
  if (targetCount === 1 && data.length === 2) {
    const [left, right] = data;
    const mixed = new Float32Array(left.length);
    for (let i = 0; i < left.length; i++) {
      mixed[i] = (left[i] + right[i]) / 2;
    }
    return [mixed];
  }
  // Fallback for any other combination: truncate or duplicate the last channel.
  const result: Float32Array[] = [];
  for (let i = 0; i < targetCount; i++) {
    result.push(data[Math.min(i, data.length - 1)].slice());
  }
  return result;
}

export function replaceRegion(
  doc: AudioDocument,
  start: number,
  end: number,
  data: Float32Array[]
): AudioDocument {
  const length = docLength(doc);
  const { start: s, end: e } = clampRange(start, end, length);
  const coerced = coerceChannels(data, doc.channels.length);
  const newLength = length - (e - s) + (coerced[0]?.length ?? 0);

  const newChannels = doc.channels.map((channel, i) => {
    const out = new Float32Array(newLength);
    out.set(channel.subarray(0, s), 0);
    out.set(coerced[i], s);
    out.set(channel.subarray(e), s + coerced[i].length);
    return out;
  });

  return { ...doc, channels: newChannels, dirty: true };
}

export function deleteRegion(doc: AudioDocument, start: number, end: number): AudioDocument {
  const emptyChannels = doc.channels.map(() => new Float32Array(0));
  return replaceRegion(doc, start, end, emptyChannels);
}

export function insertAt(doc: AudioDocument, pos: number, data: Float32Array[]): AudioDocument {
  return replaceRegion(doc, pos, pos, data);
}

export function mixDown(channels: Float32Array[]): Float32Array {
  if (channels.length <= 1) {
    return channels[0] ? channels[0].slice() : new Float32Array(0);
  }
  const [left, right] = channels;
  const mixed = new Float32Array(left.length);
  for (let i = 0; i < left.length; i++) {
    mixed[i] = (left[i] + right[i]) / 2;
  }
  return mixed;
}
