import { getMenuSections, isCommandEnabled, runCommand, type MenuCommand } from './menuActions';
import { useAppStore, makeInitialState } from '../stores/appStore';
import { createDocument, type AudioDocument } from '../audio/AudioDocument';
import { createClip, createTrack, type Clip, type Session } from '../multitrack/session';
import { useSessionStore } from '../multitrack/sessionStore';
import { SESSION_UNDO_KEY, _resetSessionUndo } from '../multitrack/sessionUndo';
import { getHistory } from './undoHistory';

/**
 * D1/D2/D6/D7 — `multitrack.mergeClips`, the command layer only: what the
 * predicate answers, and what the run WIRES (the baked document's rate, name,
 * provenance, channel count and length, which document ends up active, and the
 * clip that points at it). The merge's own arithmetic is `mergeClips.ts`'s and
 * is pinned there.
 *
 * The session runs at 44100 while every fixture document runs at 48000 ON
 * PURPOSE: the bake is handed the SESSION rate (D2), and a wiring that passed
 * the document's rate instead would mint a 48000 Hz `Merge N` that every
 * identity-rate fixture would have accepted.
 */

const SESSION_RATE = 44100;
const DOC_RATE = 48000; // deliberately NOT the session's — see the note above

const store = () => useSessionStore.getState();
const documents = () => useAppStore.getState().documents;
const doneLabels = () => getHistory(SESSION_UNDO_KEY).done;
const clipsOn = (i: number): Clip[] => store().session.tracks[i].clips;

/** A non-constant signal, so "the merged document carries the members' audio"
 * is a falsifiable claim rather than a comparison of two silences. */
function ramp(length: number, channelCount: 1 | 2): Float32Array[] {
  return Array.from({ length: channelCount }, (_, c) =>
    Float32Array.from({ length }, (_, i) => ((i % 97) / 97) * (c === 0 ? 1 : -1) + 0.1)
  );
}

function addDoc(name: string, channelCount: 1 | 2): AudioDocument {
  const doc = createDocument({
    name,
    sampleRate: DOC_RATE,
    channels: ramp(DOC_RATE, channelCount),
  });
  useAppStore.getState().addDocument(doc);
  return doc;
}

/** Installs a session from a per-track list of `[start, length, offset, docId]`
 * clips. Nothing sits at an identity value: starts are non-zero, the members
 * differ in length, and there is a gap between them. */
function seed(tracks: [number, number, number, string][][]): { ids: string[][] } {
  const built = tracks.map((clips, i) => {
    const t = createTrack(`Track ${i + 1}`);
    t.clips = clips.map(([startSample, lengthSample, offsetSample, documentId]) =>
      createClip({ documentId, startSample, offsetSample, lengthSample })
    );
    return t;
  });
  const session: Session = { name: 'Merge Fixture', sampleRate: SESSION_RATE, tracks: built };
  useSessionStore.setState({
    session,
    selectedClipId: null,
    selectedClipIds: [],
    mtCursorSample: 0,
    mtPlayState: 'stopped',
    mtPlayheadSample: 0,
    mtEnvelope: null,
  });
  return { ids: built.map((t) => t.clips.map((c) => c.id)) };
}

beforeEach(() => {
  useAppStore.setState(makeInitialState());
  _resetSessionUndo();
  useAppStore.getState().setView('multitrack');
});

describe('multitrack.mergeClips — enablement (D1/D6)', () => {
  it('5a is refused in the waveform view with a selection that WOULD merge', () => {
    const doc = addDoc('take.wav', 1);
    const { ids } = seed([
      [
        [1000, 2000, 0, doc.id],
        [5000, 3000, 4000, doc.id],
      ],
    ]);
    store().setSelectedClips(ids[0]);
    expect(isCommandEnabled('multitrack.mergeClips')).toBe(true);

    useAppStore.getState().setView('waveform');
    expect(isCommandEnabled('multitrack.mergeClips')).toBe(false);
  });

  it('5b is refused with a SINGLE selected clip — there is nothing to merge it with', () => {
    const doc = addDoc('take.wav', 1);
    const { ids } = seed([
      [
        [1000, 2000, 0, doc.id],
        [5000, 3000, 4000, doc.id],
      ],
    ]);
    store().setSelectedClip(ids[0][0]);
    expect(isCommandEnabled('multitrack.mergeClips')).toBe(false);
  });

  it('5b is refused with two selected clips on DIFFERENT tracks', () => {
    const doc = addDoc('take.wav', 1);
    const { ids } = seed([[[1000, 2000, 0, doc.id]], [[5000, 3000, 4000, doc.id]]]);
    store().setSelectedClips([ids[0][0], ids[1][0]]);
    expect(isCommandEnabled('multitrack.mergeClips')).toBe(false);
  });

  it('5b lights as soon as two of them share one track', () => {
    const doc = addDoc('take.wav', 1);
    const { ids } = seed([
      [
        [1000, 2000, 0, doc.id],
        [5000, 3000, 4000, doc.id],
      ],
      [[9000, 1000, 0, doc.id]],
    ]);
    // The lone clip on track 2 is selected too: it must not disqualify the pair.
    store().setSelectedClips([ids[0][0], ids[0][1], ids[1][0]]);
    expect(isCommandEnabled('multitrack.mergeClips')).toBe(true);
  });
});

describe('multitrack.mergeClips — the act (D2/D7)', () => {
  it('5c mints one Merge document at the SESSION rate, spanning the members, and points the clip at it', async () => {
    const doc = addDoc('take.wav', 1);
    const { ids } = seed([
      [
        [1000, 2000, 0, doc.id], // 1000..3000
        [5000, 3000, 4000, doc.id], // 5000..8000 — a 2000-sample gap before it
      ],
    ]);
    store().setSelectedClips(ids[0]);
    const before = documents().length;

    await runCommand('multitrack.mergeClips');

    expect(documents()).toHaveLength(before + 1);
    const merged = documents()[documents().length - 1];
    expect(merged.name).toMatch(/^Merge \d+$/);
    expect(merged.sampleRate).toBe(SESSION_RATE);
    expect(merged.sampleRate).not.toBe(DOC_RATE);
    expect(merged.neverSaved).toBe(true);
    expect(merged.filePath).toBeNull();
    expect(merged.channels).toHaveLength(1); // every member is mono (D3)
    expect(merged.channels[0]).toHaveLength(7000); // [1000, 8000)
    // D7: `addDocument` activates it, and nothing here undoes that.
    expect(useAppStore.getState().activeDocumentId).toBe(merged.id);
    // The view is NOT switched — unlike Mix Down, this is a multitrack verb.
    expect(useAppStore.getState().view).toBe('multitrack');

    expect(clipsOn(0)).toHaveLength(1);
    const clip = clipsOn(0)[0];
    expect(clip.documentId).toBe(merged.id);
    expect(clip.startSample).toBe(1000);
    expect(clip.lengthSample).toBe(7000);
    expect(doneLabels()).toEqual(['Merge clips']);

    // The members' audio is in it and the gap between them is not: a wiring
    // that baked the wrong span or the wrong track would fail here.
    const ch = merged.channels[0];
    expect(ch.slice(0, 2000).some((v) => v !== 0)).toBe(true); // member A
    expect(Array.from(ch.slice(2100, 3900)).every((v) => v === 0)).toBe(true); // the gap
    expect(ch.slice(4000, 7000).some((v) => v !== 0)).toBe(true); // member B
  });

  it('5d mints ONE document per merged track, in track order, and leaves the last one active', async () => {
    const doc = addDoc('take.wav', 1);
    const { ids } = seed([
      [
        [1000, 2000, 0, doc.id],
        [5000, 3000, 4000, doc.id],
      ],
      [
        [200, 1500, 100, doc.id],
        [4000, 500, 0, doc.id], // 4000..4500
      ],
      [[9000, 1000, 0, doc.id]], // one clip, selected — never merged (D1)
    ]);
    store().setSelectedClips([...ids[0], ...ids[1], ...ids[2]]);
    const before = documents().length;

    await runCommand('multitrack.mergeClips');

    expect(documents()).toHaveLength(before + 2);
    const [first, second] = documents().slice(-2);
    expect(first.name).toMatch(/^Merge \d+$/);
    expect(second.name).toMatch(/^Merge \d+$/);
    expect(second.name).not.toBe(first.name);
    expect(first.channels[0]).toHaveLength(7000); // track 1: [1000, 8000)
    expect(second.channels[0]).toHaveLength(4300); // track 2: [200, 4500)
    expect(useAppStore.getState().activeDocumentId).toBe(second.id);

    expect(clipsOn(0)).toHaveLength(1);
    expect(clipsOn(0)[0].documentId).toBe(first.id);
    expect(clipsOn(1)).toHaveLength(1);
    expect(clipsOn(1)[0].documentId).toBe(second.id);
    expect(clipsOn(2).map((c) => c.id)).toEqual(ids[2]); // untouched
    // Two tracks merged, still ONE undo entry (D4).
    expect(doneLabels()).toEqual(['Merge clips']);
  });

  it('5e bakes stereo as soon as ONE member is stereo (D3)', async () => {
    const mono = addDoc('mono.wav', 1);
    const stereo = addDoc('stereo.wav', 2);
    const { ids } = seed([
      [
        [1000, 2000, 0, mono.id],
        [5000, 3000, 4000, stereo.id],
      ],
    ]);
    store().setSelectedClips(ids[0]);

    await runCommand('multitrack.mergeClips');

    const merged = documents()[documents().length - 1];
    expect(merged.channels).toHaveLength(2);
    expect(merged.channels[1]).toHaveLength(7000);
  });

  it('5f is a no-op in the waveform view: no document, no undo entry, no clip touched', async () => {
    const doc = addDoc('take.wav', 1);
    const { ids } = seed([
      [
        [1000, 2000, 0, doc.id],
        [5000, 3000, 4000, doc.id],
      ],
    ]);
    store().setSelectedClips(ids[0]);
    useAppStore.getState().setView('waveform');
    const before = documents().length;

    await runCommand('multitrack.mergeClips');

    expect(documents()).toHaveLength(before);
    expect(doneLabels()).toEqual([]);
    expect(clipsOn(0).map((c) => c.id)).toEqual(ids[0]);
  });
});

describe('multitrack.mergeClips — the menu row (D6)', () => {
  it('5g is labelled "Merge Clips", carries no shortcut, and sits directly after Split', () => {
    const edit = getMenuSections().find((s) => s.title === 'Edit')!;
    // Separators are KEPT in this list, so "directly after" also refuses a
    // divider slipped between the inverse pair.
    const positions = edit.items.map((i) => (i === 'separator' ? 'separator' : i.id));
    expect(positions.indexOf('multitrack.mergeClips')).toBe(positions.indexOf('edit.split') + 1);

    const row = edit.items
      .filter((i): i is MenuCommand => i !== 'separator')
      .find((i) => i.id === 'multitrack.mergeClips');
    expect(row?.label).toBe('Merge Clips');
    expect(row?.shortcut).toBeUndefined();
  });
});
