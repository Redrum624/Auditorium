import { runEffectOnSelection } from './effectRunner';
import { registerEffect } from '../effects/EffectRegistry';
import { registerAllEffects } from '../effects/registerAll';
import { createDocument, docLength } from '../audio/AudioDocument';
import { useAppStore, makeInitialState } from '../stores/appStore';
import { canUndo, undo } from './undoHistory';

// App.tsx registers effects at startup; mirror that so the renderer-side lookup
// in runEffectOnSelection (used for the undo label + guard) finds the built-ins.
registerAllEffects();

/** Float32-rounded copy of a double array (Float32Array can't hold e.g. 0.1 exactly). */
function f32(values: number[]): number[] {
  return Array.from(Float32Array.from(values));
}

// createDspWorker is mapped to the synchronous mock (jest.config moduleNameMapper),
// which runs the registered effect on the main thread — so these exercise the full
// runEffectOnSelection -> worker -> applyEdit path without a real Worker.

function seedDoc(values: number[]): string {
  const doc = createDocument({
    name: 'test',
    sampleRate: 44100,
    channels: [Float32Array.from(values)],
  });
  useAppStore.getState().addDocument(doc);
  return doc.id;
}

function activeChannel(): Float32Array {
  const s = useAppStore.getState();
  const doc = s.documents.find((d) => d.id === s.activeDocumentId)!;
  return doc.channels[0];
}

beforeEach(() => {
  useAppStore.setState(makeInitialState());
});

describe('runEffectOnSelection', () => {
  it('applies the effect to the selection only, leaving the rest untouched', async () => {
    const values = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0];
    seedDoc(values);
    useAppStore.getState().setSelection({ start: 3, end: 7 });

    const factor = Math.pow(10, 6 / 20);
    await runEffectOnSelection('amplify', { gainDb: 6 });

    const out = activeChannel();
    out.forEach((v, i) => {
      const expected = i >= 3 && i < 7 ? values[i] * factor : values[i];
      expect(v).toBeCloseTo(expected, 4);
    });
  });

  it('undo restores the original samples', async () => {
    const values = [0.1, 0.2, 0.3, 0.4];
    const docId = seedDoc(values);
    await runEffectOnSelection('amplify', { gainDb: 12 });
    expect(activeChannel()[0]).not.toBeCloseTo(0.1, 4);

    expect(canUndo(docId)).toBe(true);
    undo(docId);
    expect(Array.from(activeChannel())).toEqual(f32(values));
  });

  it('handles a length-changing effect and updates the selection extent', async () => {
    registerEffect({
      id: 'test-halve',
      name: 'Halve',
      category: 'Utility',
      params: [],
      process: (channels) => ({
        channels: channels.map((c) => c.slice(0, Math.floor(c.length / 2))),
      }),
    });
    seedDoc([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);

    await runEffectOnSelection('test-halve', {});

    const s = useAppStore.getState();
    const doc = s.documents.find((d) => d.id === s.activeDocumentId)!;
    expect(docLength(doc)).toBe(5);
    expect(s.selection).toEqual({ start: 0, end: 5 });
  });

  it('passes extra through to the worker-side channel (__effectExtra) and cleans it up', async () => {
    let seen: unknown = 'unset';
    registerEffect({
      id: 'test-extra',
      name: 'Extra Reader',
      category: 'Utility',
      params: [],
      process: (channels) => {
        seen = (globalThis as { __effectExtra?: unknown }).__effectExtra;
        return { channels: channels.map((c) => c.slice()) };
      },
    });
    seedDoc([0.1, 0.2]);

    await runEffectOnSelection('test-extra', {}, undefined, { profile: [1, 2, 3] });

    expect(seen).toEqual({ profile: [1, 2, 3] });
    // The side channel must not leak past the run.
    expect((globalThis as { __effectExtra?: unknown }).__effectExtra).toBeUndefined();
  });

  it('settles (no hang) when applyEdit fails because the doc was closed mid-run', async () => {
    registerEffect({
      id: 'test-close-doc',
      name: 'Close Doc',
      category: 'Utility',
      params: [],
      process: (channels) => {
        // Simulate the user closing the document while the worker was busy.
        const s = useAppStore.getState();
        if (s.activeDocumentId) s.closeDocument(s.activeDocumentId);
        return { channels: channels.map((c) => c.slice()) };
      },
    });
    const docId = seedDoc([0.1, 0.2, 0.3]);

    // Must resolve (not hang, not reject) even though applyEdit throws
    // 'document not found' in the done branch.
    await expect(runEffectOnSelection('test-close-doc', {})).resolves.toBeUndefined();
    expect(canUndo(docId)).toBe(false);
  });

  it('applies no edit when the effect throws (error path)', async () => {
    registerEffect({
      id: 'test-throw',
      name: 'Throw',
      category: 'Utility',
      params: [],
      process: () => {
        throw new Error('boom');
      },
    });
    const values = [0.1, 0.2, 0.3];
    const docId = seedDoc(values);

    await runEffectOnSelection('test-throw', {});

    expect(Array.from(activeChannel())).toEqual(f32(values));
    expect(canUndo(docId)).toBe(false);
  });
});
