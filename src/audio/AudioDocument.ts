export interface AudioDocument {
  id: string; // 'doc-1', 'doc-2', ... sequential
  name: string; // display name: file basename or 'Untitled 1'
  filePath: string | null; // absolute path when opened from / saved to disk
  sampleRate: number; // e.g. 44100, 48000
  channels: Float32Array[]; // length 1 (mono) or 2 (stereo); all same length
  dirty: boolean;
}

const idCounters: Record<string, number> = {};

export function nextId(prefix: string): string {
  const next = (idCounters[prefix] ?? 0) + 1;
  idCounters[prefix] = next;
  return `${prefix}-${next}`;
}

export function createDocument(opts: {
  name: string;
  sampleRate: number;
  channels: Float32Array[];
  filePath?: string | null;
}): AudioDocument {
  return {
    id: nextId('doc'),
    name: opts.name,
    filePath: opts.filePath ?? null,
    sampleRate: opts.sampleRate,
    channels: opts.channels,
    dirty: false,
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
