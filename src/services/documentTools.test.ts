import { convertSampleRate, convertChannels } from './documentTools';
import { useAppStore, makeInitialState } from '../stores/appStore';
import { createDocument, docLength } from '../audio/AudioDocument';
import { undo } from './undoHistory';

function activeDoc() {
  const s = useAppStore.getState();
  return s.documents.find((d) => d.id === s.activeDocumentId)!;
}

function sine(freq: number, n: number, sr: number, amplitude = 0.5): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amplitude * Math.sin((2 * Math.PI * freq * i) / sr);
  return out;
}

function seedDoc(opts: { sampleRate: number; channels: Float32Array[] }) {
  const doc = createDocument({ name: 'clip.wav', sampleRate: opts.sampleRate, channels: opts.channels });
  useAppStore.getState().addDocument(doc);
  return doc;
}

beforeEach(() => {
  useAppStore.setState(makeInitialState());
});

describe('convertSampleRate', () => {
  it('44100 -> 22050 halves the length and sets doc.sampleRate to 22050', () => {
    const doc = seedDoc({ sampleRate: 44100, channels: [sine(440, 44100, 44100)] });
    convertSampleRate(doc.id, 22050);
    const after = activeDoc();
    expect(after.sampleRate).toBe(22050);
    expect(Math.abs(docLength(after) - 22050)).toBeLessThanOrEqual(1);
  });

  it('undo restores BOTH the old channels (length) and the old sampleRate', () => {
    const original = sine(440, 44100, 44100);
    const doc = seedDoc({ sampleRate: 44100, channels: [original] });
    const beforeLen = docLength(activeDoc());

    convertSampleRate(doc.id, 22050);
    expect(activeDoc().sampleRate).toBe(22050);

    undo(doc.id);
    const restored = activeDoc();
    expect(restored.sampleRate).toBe(44100);
    expect(docLength(restored)).toBe(beforeLen);
    expect(Array.from(restored.channels[0])).toEqual(Array.from(original));
  });

  it('is a no-op when the document is already at the target rate', () => {
    const doc = seedDoc({ sampleRate: 48000, channels: [new Float32Array(1000)] });
    const before = activeDoc();
    convertSampleRate(doc.id, 48000);
    expect(activeDoc()).toBe(before); // same object identity: no edit applied
  });

  it('converts every channel of a stereo document', () => {
    const doc = seedDoc({
      sampleRate: 44100,
      channels: [sine(440, 44100, 44100), sine(660, 44100, 44100)],
    });
    convertSampleRate(doc.id, 48000);
    const after = activeDoc();
    expect(after.sampleRate).toBe(48000);
    expect(after.channels).toHaveLength(2);
    expect(after.channels[0].length).toBe(after.channels[1].length);
    expect(after.channels[0].length).toBe(Math.round(44100 * (48000 / 44100)));
  });
});

describe('convertChannels', () => {
  it('stereo -> mono -> stereo round trip preserves the length', () => {
    const n = 500;
    const doc = seedDoc({
      sampleRate: 44100,
      channels: [sine(440, n, 44100), sine(660, n, 44100)],
    });

    convertChannels(doc.id, 1);
    let after = activeDoc();
    expect(after.channels).toHaveLength(1);
    expect(docLength(after)).toBe(n);

    convertChannels(doc.id, 2);
    after = activeDoc();
    expect(after.channels).toHaveLength(2);
    expect(docLength(after)).toBe(n);
  });

  it('stereo -> mono averages the two channels', () => {
    const l = Float32Array.from([0.2, 0.4, 0.6]);
    const r = Float32Array.from([0.0, 0.0, 0.2]);
    const doc = seedDoc({ sampleRate: 44100, channels: [l, r] });
    convertChannels(doc.id, 1);
    const after = activeDoc();
    const mono = Array.from(after.channels[0]);
    [0.1, 0.2, 0.4].forEach((expected, i) => expect(mono[i]).toBeCloseTo(expected, 6));
  });

  it('mono -> stereo duplicates the single channel', () => {
    const m = Float32Array.from([0.1, -0.2, 0.3]);
    const doc = seedDoc({ sampleRate: 44100, channels: [m] });
    convertChannels(doc.id, 2);
    const after = activeDoc();
    expect(after.channels).toHaveLength(2);
    expect(Array.from(after.channels[0])).toEqual(Array.from(m));
    expect(Array.from(after.channels[1])).toEqual(Array.from(m));
  });

  it('is a no-op when the channel count already matches', () => {
    const doc = seedDoc({ sampleRate: 44100, channels: [new Float32Array(10), new Float32Array(10)] });
    const before = activeDoc();
    convertChannels(doc.id, 2);
    expect(activeDoc()).toBe(before); // same object identity: no edit applied
  });

  it('undo restores the previous channel layout', () => {
    const l = Float32Array.from([0.2, 0.4]);
    const r = Float32Array.from([0.6, 0.8]);
    const doc = seedDoc({ sampleRate: 44100, channels: [l, r] });
    convertChannels(doc.id, 1);
    expect(activeDoc().channels).toHaveLength(1);
    undo(doc.id);
    const restored = activeDoc();
    expect(restored.channels).toHaveLength(2);
    expect(Array.from(restored.channels[0])).toEqual(Array.from(l));
    expect(Array.from(restored.channels[1])).toEqual(Array.from(r));
  });
});
