import { convertSampleRate, convertChannels } from './documentTools';
import { useAppStore, makeInitialState } from '../stores/appStore';
import { createDocument, docLength } from '../audio/AudioDocument';
import { downmixToStereo } from '../audio/decodeAudio';
import { downmixBs775 } from '../dsp/downmix';
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

function seedDoc(opts: { sampleRate: number; channels: Float32Array[]; channelMask?: number }) {
  const doc = createDocument({
    name: 'clip.wav',
    sampleRate: opts.sampleRate,
    channels: opts.channels,
    channelMask: opts.channelMask,
  });
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

describe('convertSampleRate marker rescale (Task M3 / F4)', () => {
  it('rescales every marker position by round(pos * toRate/fromRate)', () => {
    const doc = seedDoc({ sampleRate: 44100, channels: [sine(440, 44100, 44100)] });
    useAppStore.getState().setMarkersForDoc(doc.id, [
      { id: 'm1', name: 'A', positionSample: 0 },
      { id: 'm2', name: 'B', positionSample: 22050 },
      { id: 'm3', name: 'C', positionSample: 44100 },
    ]);

    convertSampleRate(doc.id, 22050);

    const positions = useAppStore.getState().markers[doc.id].map((m) => m.positionSample);
    expect(positions).toEqual([0, 11025, 22050]);
  });

  it('undo restores the exact pre-resample marker list alongside the channels/sampleRate', () => {
    const doc = seedDoc({ sampleRate: 44100, channels: [sine(440, 44100, 44100)] });
    const before = [{ id: 'm1', name: 'A', positionSample: 22050 }];
    useAppStore.getState().setMarkersForDoc(doc.id, before);

    convertSampleRate(doc.id, 22050);
    expect(useAppStore.getState().markers[doc.id]).toEqual([{ id: 'm1', name: 'A', positionSample: 11025 }]);

    undo(doc.id);
    expect(useAppStore.getState().markers[doc.id]).toEqual(before);
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

describe('convertChannels — R6 multichannel downmix laws', () => {
  const MASK_5_1 = 0x3f; // FL FR FC LFE BL BR
  function seed51(channelMask?: number) {
    return seedDoc({
      sampleRate: 44100,
      channels: [
        Float32Array.from([0.1, -0.1]), // FL
        Float32Array.from([0.2, -0.2]), // FR
        Float32Array.from([0.3, 0.15]), // FC
        Float32Array.from([0.9, 0.9]), // LFE
        Float32Array.from([0.05, 0.1]), // BL
        Float32Array.from([-0.05, 0.2]), // BR
      ],
      channelMask,
    });
  }

  it('LEGACY PINNED: >2ch -> stereo WITHOUT a law still duplicates channel 0 (pre-R6 behaviour, byte-for-byte)', () => {
    const doc = seed51(MASK_5_1);
    convertChannels(doc.id, 2);
    const after = activeDoc();
    expect(after.channels).toHaveLength(2);
    expect(Array.from(after.channels[0])).toEqual([0.1, -0.1].map(Math.fround));
    expect(Array.from(after.channels[1])).toEqual([0.1, -0.1].map(Math.fround));
  });

  it("law 'fold' applies the app's original −3 dB fold (downmixToStereo) to a 5.1 document", () => {
    const doc = seed51(MASK_5_1);
    const expected = downmixToStereo(activeDoc().channels.map((c) => c.slice()));
    convertChannels(doc.id, 2, 'fold');
    const after = activeDoc();
    expect(after.channels).toHaveLength(2);
    expect(after.channels).toEqual(expected);
  });

  it("law 'bs775' with a covered layout applies the BS.775 matrix", () => {
    const doc = seed51(MASK_5_1);
    const expected = downmixBs775(
      activeDoc().channels.map((c) => c.slice()),
      MASK_5_1
    );
    convertChannels(doc.id, 2, 'bs775');
    expect(activeDoc().channels).toEqual(expected);
  });

  it("law 'bs775' WITHOUT a layout falls back to the fold — the honest degradation", () => {
    const doc = seed51(undefined);
    const expected = downmixToStereo(activeDoc().channels.map((c) => c.slice()));
    convertChannels(doc.id, 2, 'bs775');
    expect(activeDoc().channels).toEqual(expected);
  });

  it('any channel conversion clears channelMask (the mask describes the source channel set)', () => {
    const doc = seed51(MASK_5_1);
    convertChannels(doc.id, 2, 'bs775');
    expect(activeDoc().channelMask).toBeUndefined();
  });

  it('undo restores the six channels AND the channelMask', () => {
    const doc = seed51(MASK_5_1);
    const before = activeDoc().channels.map((c) => c.slice());
    convertChannels(doc.id, 2, 'bs775');
    expect(activeDoc().channels).toHaveLength(2);
    undo(doc.id);
    const restored = activeDoc();
    expect(restored.channels).toHaveLength(6);
    expect(restored.channels).toEqual(before);
    expect(restored.channelMask).toBe(MASK_5_1);
  });

  it("a plain stereo doc ignores the law argument (n <= 2 has nothing to fold): mono target still averages", () => {
    const doc = seedDoc({
      sampleRate: 44100,
      channels: [Float32Array.from([0.2, 0.4]), Float32Array.from([0.0, 0.2])],
    });
    convertChannels(doc.id, 1, 'bs775');
    const after = activeDoc();
    expect(after.channels).toHaveLength(1);
    expect(after.channels[0][0]).toBeCloseTo(0.1, 6);
  });
});
