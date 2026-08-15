import { describeRemoval, getEffectFailureCount, runEffectOnSelection } from './effectRunner';
import { registerEffect } from '../effects/EffectRegistry';
import { registerAllEffects } from '../effects/registerAll';
import { createDocument, docLength } from '../audio/AudioDocument';
import { useAppStore, makeInitialState } from '../stores/appStore';
import { canUndo, undo, redo, getHistory } from './undoHistory';
import {
  _setDspWorkerLoadFailure,
  _getDspWorkerTerminateCount,
  _resetDspWorkerTestState,
} from '../__mocks__/createDspWorkerMock';
import * as createDspWorkerModule from '../workers/createDspWorker';

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
  _resetDspWorkerTestState();
});

afterEach(() => {
  _resetDspWorkerTestState();
  delete (window as { electronAPI?: unknown }).electronAPI;
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

  it('proportionally stretches markers through a length-changing effect (Time Stretch/Pitch Shift shape), and undo/redo restore them (Task M3 fix round 2)', async () => {
    registerEffect({
      id: 'test-third',
      name: 'Shrink To Third',
      category: 'Utility',
      params: [],
      // Simulates a length-changing effect (time-stretch/pitch-shift) applied to
      // the SELECTED region only: shrinks the region to 1/3 its length.
      process: (channels) => ({
        channels: channels.map((c) => c.slice(0, Math.ceil(c.length / 3))),
      }),
    });
    const docId = seedDoc([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    useAppStore.getState().setSelection({ start: 2, end: 8 }); // region length 6 -> resultLen 2
    useAppStore.getState().setMarkersForDoc(docId, [
      { id: 'm0', name: 'before', positionSample: 0 }, // < start: kept
      { id: 'm1', name: 'inside', positionSample: 5 }, // in [2,8): stretched proportionally
      { id: 'm2', name: 'atEnd', positionSample: 8 }, // === end: shifts
      { id: 'm3', name: 'after', positionSample: 9 }, // > end: shifts
    ]);
    const before = useAppStore.getState().markers[docId];

    await runEffectOnSelection('test-third', {});

    // resultLen=2 (ceil(6/3)); region is TRANSFORMED not replaced, so the
    // interior marker rides the stretch instead of dropping (fix round 2):
    // 5 -> start + round((5-2) * 2/6) = 2 + round(1) = 3.
    // 8 (===end) and 9 (>end) shift by resultLen-(end-start) = 2-6 = -4 -> 4, 5.
    const positions = useAppStore
      .getState()
      .markers[docId].map((m) => m.positionSample);
    expect(positions).toEqual([0, 3, 4, 5]); // 0 kept; 5->3 (proportional); 8->4; 9->5

    undo(docId);
    expect(useAppStore.getState().markers[docId]).toEqual(before);

    redo(docId);
    const redone = useAppStore.getState().markers[docId].map((m) => m.positionSample);
    expect(redone).toEqual([0, 3, 4, 5]);
  });

  it('stretches every marker proportionally on a whole-document length-changing effect — the scenario that motivated the ruling (Task M3 fix round 2)', async () => {
    registerEffect({
      id: 'test-double',
      name: 'Double',
      category: 'Utility',
      params: [],
      // Whole-document length-changing effect (no selection): doubles the length.
      process: (channels) => ({
        channels: channels.map((c) => {
          const out = new Float32Array(c.length * 2);
          out.set(c, 0);
          out.set(c, c.length);
          return out;
        }),
      }),
    });
    const docId = seedDoc([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]); // length 10, no selection -> region [0,10)
    useAppStore.getState().setMarkersForDoc(docId, [
      { id: 'm0', name: 'a', positionSample: 0 },
      { id: 'm1', name: 'b', positionSample: 3 },
      { id: 'm2', name: 'c', positionSample: 7 },
      { id: 'm3', name: 'd', positionSample: 9 },
    ]);
    const before = useAppStore.getState().markers[docId];

    await runEffectOnSelection('test-double', {});

    // Whole doc is the "region": every marker is interior and maps pos*2 —
    // NONE drop, unlike the old 'replace' semantics that would have lost all 4.
    const positions = useAppStore.getState().markers[docId].map((m) => m.positionSample);
    expect(positions).toEqual([0, 6, 14, 18]);

    undo(docId);
    expect(useAppStore.getState().markers[docId]).toEqual(before);
  });

  // --- One resolved region, every consumer (L9) ------------------------------
  // `setSelection` stores whatever it is handed — no UI gesture builds an
  // out-of-bounds selection, but the store API accepts one, and `cloneRegion`/
  // `replaceRegion` clamp it while the marker remap used to be built from the
  // RAW pair. Same defect family as R7 (plan.regionStart) and L1 (the constant
  // tempo path): two readings of "the region", only one of which the audio used.

  it('remaps markers against the CLAMPED region the audio actually used when the selection starts before sample 0 (L9)', async () => {
    registerEffect({
      id: 'test-third-oob-start',
      name: 'Shrink To Third (oob start)',
      category: 'Utility',
      params: [],
      process: (channels) => ({
        channels: channels.map((c) => c.slice(0, Math.ceil(c.length / 3))),
      }),
    });
    const docId = seedDoc(Array.from({ length: 20 }, (_, i) => i / 32));
    // Clamps to [0, 12): the worker sees 12 samples, not the raw span of 20.
    useAppStore.getState().setSelection({ start: -8, end: 12 });
    useAppStore.getState().setMarkersForDoc(docId, [
      { id: 'm0', name: 'inside', positionSample: 6 },
      { id: 'm1', name: 'insideLate', positionSample: 9 },
      { id: 'm2', name: 'atEnd', positionSample: 12 },
      { id: 'm3', name: 'after', positionSample: 18 },
    ]);

    await runEffectOnSelection('test-third-oob-start', {});

    // Region [0,12) -> resultLen ceil(12/3) = 4, so delta = -8 and the doc is 12
    // long. INSIDE rides the stretch against 12: 6 -> round(6*4/12) = 2,
    // 9 -> round(9*4/12) = 3. AT/AFTER shifts by the clamped delta: 12 -> 4,
    // 18 -> 10. Against the raw pair (span 20 starting at -8) all four map
    // negative or near-zero and clamp to [0, 0, 0, 2] — three cue points
    // collapsed onto sample 0, which is the data loss the remap exists to stop.
    expect(useAppStore.getState().markers[docId].map((m) => m.positionSample)).toEqual([2, 3, 4, 10]);
    // The post-edit selection/cursor read the same resolved pair; the raw one
    // left the document selected from -8 to -4 with the cursor at -8.
    expect(useAppStore.getState().selection).toEqual({ start: 0, end: 4 });
    expect(useAppStore.getState().cursorSample).toBe(0);
  });

  it('remaps markers against the CLAMPED region when a NON-ZERO start pairs with an end past the document (L9)', async () => {
    registerEffect({
      id: 'test-halve-oob-end',
      name: 'Halve (oob end)',
      category: 'Utility',
      params: [],
      process: (channels) => ({
        channels: channels.map((c) => c.slice(0, Math.floor(c.length / 2))),
      }),
    });
    const docId = seedDoc(Array.from({ length: 10 }, (_, i) => i / 16));
    // Clamps to [2, 10): region length 8, not the raw 16.
    useAppStore.getState().setSelection({ start: 2, end: 18 });
    useAppStore.getState().setMarkersForDoc(docId, [
      { id: 'm0', name: 'before', positionSample: 1 },
      { id: 'm1', name: 'inside', positionSample: 6 },
      { id: 'm2', name: 'atEnd', positionSample: 10 },
    ]);

    await runEffectOnSelection('test-halve-oob-end', {});

    // resultLen 4, delta -4, doc 6 long. 1 is before the region and keeps;
    // 6 rides the stretch against 8: 2 + round(4*4/8) = 4; 10 is the region END
    // (= docLength) and shifts by the clamped delta to 6. Against the raw pair
    // (end 18) the last two are treated as interior of a 16-long span and land
    // at 3 and 4 — inside re-timed audio, at positions nothing produced.
    expect(useAppStore.getState().markers[docId].map((m) => m.positionSample)).toEqual([1, 4, 6]);
    expect(useAppStore.getState().selection).toEqual({ start: 2, end: 6 });
  });

  it('makes removedSpans absolute against the CLAMPED region start too — the cuts path rides the same geometry (L9)', async () => {
    registerEffect({
      id: 'test-remove-spans-oob',
      name: 'Remove Spans OOB',
      category: 'Utility',
      params: [],
      // Deletes region-relative [2, 6) from the region it was handed.
      process: (channels) => ({
        channels: channels.map((c) => {
          const out = new Float32Array(c.length - 4);
          out.set(c.subarray(0, 2), 0);
          out.set(c.subarray(6), 2);
          return out;
        }),
        removedSpans: [{ start: 2, end: 6 }],
      }),
    });
    const docId = seedDoc(Array.from({ length: 20 }, (_, i) => i / 32));
    useAppStore.getState().setSelection({ start: -5, end: 12 }); // clamps to [0, 12)
    useAppStore.getState().setMarkersForDoc(docId, [
      { id: 'm0', name: 'inPause', positionSample: 3 },
      { id: 'm1', name: 'inPauseLate', positionSample: 5 },
      { id: 'm2', name: 'afterCut', positionSample: 10 },
      { id: 'm3', name: 'afterRegion', positionSample: 18 },
    ]);

    await runEffectOnSelection('test-remove-spans-oob', {});

    // The worker's spans are relative to the region it RECEIVED, which started
    // at the clamped 0 — so the absolute cut is [2, 6): 3 and 5 sit inside it
    // and snap to the join at 2; 10 and 18 shift left by the 4 removed.
    // Offset by the raw -5 the cut becomes [-3, 1), and the two in-pause cue
    // points land at 0 and 1 instead — before the audio they mark.
    expect(useAppStore.getState().markers[docId].map((m) => m.positionSample)).toEqual([2, 2, 6, 14]);
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

    await runEffectOnSelection('test-extra', {}, { extra: { profile: [1, 2, 3] } });

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
    await expect(runEffectOnSelection('test-close-doc', {})).resolves.toBe('refused');
    expect(canUndo(docId)).toBe(false);
  });

  it('settles (no hang) and surfaces an error when the worker fails to load (onerror), instead of hanging the Apply promise forever (Task M9 / F28)', async () => {
    const showMessageBox = jest.fn(async () => 0);
    (window as unknown as { electronAPI: { showMessageBox: typeof showMessageBox } }).electronAPI = {
      showMessageBox,
    };
    _setDspWorkerLoadFailure('DSP worker script failed to load');
    const values = [0.1, 0.2, 0.3];
    const docId = seedDoc(values);
    // The failure counter the packaged smoke reads: a crash and a clean refusal
    // are otherwise the SAME observation from outside (the promise settled, the
    // document did not change), which is what made its tiny-document step
    // unable to fail.
    const failuresBefore = getEffectFailureCount();

    await expect(runEffectOnSelection('amplify', { gainDb: 6 })).resolves.toBe('refused');

    expect(showMessageBox).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', title: 'Effect failed' })
    );
    expect(getEffectFailureCount()).toBe(failuresBefore + 1);
    expect(_getDspWorkerTerminateCount()).toBe(1); // the failed worker was discarded
    expect(canUndo(docId)).toBe(false); // no edit was applied
    expect(Array.from(activeChannel())).toEqual(f32(values));
  });

  it('does NOT move the failure counter on a run that succeeds', async () => {
    // The other arm, and the one that makes the assertion in the smoke step
    // meaningful: if every run bumped it, "the counter did not move" would be
    // unsatisfiable, and if no run ever did, it would be vacuous.
    const docId = seedDoc([0.1, 0.2, 0.3]);
    const failuresBefore = getEffectFailureCount();

    await runEffectOnSelection('amplify', { gainDb: 6 });

    expect(getEffectFailureCount()).toBe(failuresBefore);
    expect(canUndo(docId)).toBe(true); // the run really did apply
  });

  // Same shape as tempoAnalysis.test.ts's "worker.postMessage throwing
  // synchronously" case: a throw inside the `new Promise` executor is caught
  // by the Promise machinery, so without an explicit try/catch it REJECTED
  // this promise and neither terminate() branch was ever reached — one leaked
  // worker thread per Apply.
  it('settles (never rejects) and TERMINATES the worker when postMessage throws synchronously', async () => {
    const showMessageBox = jest.fn(async () => 0);
    (window as unknown as { electronAPI: { showMessageBox: typeof showMessageBox } }).electronAPI = {
      showMessageBox,
    };
    let terminateCalls = 0;
    const fakeWorker = {
      onmessage: null as ((e: MessageEvent) => void) | null,
      onerror: null as ((e: ErrorEvent) => void) | null,
      postMessage: () => {
        throw new Error('postMessage boom');
      },
      terminate: () => {
        terminateCalls++;
      },
      addEventListener: () => {},
      removeEventListener: () => {},
    };
    const spy = jest
      .spyOn(createDspWorkerModule, 'createDspWorker')
      .mockImplementationOnce(() => fakeWorker as unknown as Worker);
    const values = [0.1, 0.2, 0.3];
    const docId = seedDoc(values);

    await expect(runEffectOnSelection('amplify', { gainDb: 6 })).resolves.toBe('refused');

    expect(terminateCalls).toBe(1);
    expect(showMessageBox).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', title: 'Effect failed', message: 'postMessage boom' })
    );
    expect(canUndo(docId)).toBe(false);
    expect(Array.from(activeChannel())).toEqual(f32(values));
    spy.mockRestore();
  });

  it('labels the undo entry `Effect: <name>` by default — the v1.5 contract every existing effect relies on (R2-1 pin)', async () => {
    const docId = seedDoc([0.1, 0.2, 0.3]);

    await runEffectOnSelection('amplify', { gainDb: 6 });

    expect(getHistory(docId).done).toEqual(['Effect: Amplify']);
  });

  it('uses the caller-supplied label override verbatim when provided (R2-1: Match Tempo)', async () => {
    const docId = seedDoc([0.1, 0.2, 0.3]);

    await runEffectOnSelection('amplify', { gainDb: 6 }, { label: 'Match Tempo' });

    expect(getHistory(docId).done).toEqual(['Match Tempo']);
  });

  it('remaps markers with the exact per-cut rule when the effect reports removedSpans — NOT the proportional stretch (F2 / ruling 3)', async () => {
    registerEffect({
      id: 'test-remove-spans',
      name: 'Remove Spans',
      category: 'Utility',
      params: [],
      // Deletes region-relative [5, 45) from the selected region and reports
      // it — the Remove Silence shape.
      process: (channels) => ({
        channels: channels.map((c) => {
          const out = new Float32Array(c.length - 40);
          out.set(c.subarray(0, 5), 0);
          out.set(c.subarray(45), 5);
          return out;
        }),
        removedSpans: [{ start: 5, end: 45 }],
      }),
    });
    const docId = seedDoc(Array.from({ length: 100 }, (_, i) => i / 128));
    useAppStore.getState().setSelection({ start: 5, end: 95 }); // absolute cut = [10, 50)
    useAppStore.getState().setMarkersForDoc(docId, [
      { id: 'm0', name: 'before', positionSample: 3 }, // < region: kept
      { id: 'm1', name: 'inPause', positionSample: 30 }, // inside the cut: snaps to the join
      { id: 'm2', name: 'afterCut', positionSample: 70 }, // after the cut: exact shift
      { id: 'm3', name: 'afterRegion', positionSample: 97 },
    ]);
    const before = useAppStore.getState().markers[docId];

    await runEffectOnSelection('test-remove-spans', {});

    // Exact rule: 3 kept; 30 -> 10 (join); 70 -> 30 (minus the 40 removed);
    // 97 -> 57. The proportional stretch would have said 19 and 41 for the
    // middle two — markers landing INSIDE re-timed audio at wrong positions.
    const positions = useAppStore.getState().markers[docId].map((m) => m.positionSample);
    expect(positions).toEqual([3, 10, 30, 57]);
    // Ruling 5: the default label reports what was removed. 40 samples at
    // 44.1 kHz is 0.907 ms -> rounds to "1 ms".
    expect(getHistory(docId).done).toEqual(['Effect: Remove Spans (1 gap, 1 ms removed)']);
    // Selection spans the shortened region.
    expect(useAppStore.getState().selection).toEqual({ start: 5, end: 55 });

    undo(docId);
    expect(useAppStore.getState().markers[docId]).toEqual(before);

    redo(docId);
    expect(useAppStore.getState().markers[docId].map((m) => m.positionSample)).toEqual([3, 10, 30, 57]);
  });

  it('a removedSpans effect that removed nothing says so in the label and leaves markers untouched', async () => {
    registerEffect({
      id: 'test-remove-none',
      name: 'Remove None',
      category: 'Utility',
      params: [],
      process: (channels) => ({ channels: channels.map((c) => c.slice()), removedSpans: [] }),
    });
    const docId = seedDoc([0.1, 0.2, 0.3]);
    useAppStore.getState().setMarkersForDoc(docId, [{ id: 'm0', name: 'a', positionSample: 1 }]);
    const before = useAppStore.getState().markers[docId];

    await runEffectOnSelection('test-remove-none', {});

    expect(getHistory(docId).done).toEqual(['Effect: Remove None (nothing removed)']);
    expect(useAppStore.getState().markers[docId]).toEqual(before);
  });

  it('a caller-supplied label still overrides the removal report', async () => {
    registerEffect({
      id: 'test-remove-labelled',
      name: 'Remove Labelled',
      category: 'Utility',
      params: [],
      process: (channels) => ({
        channels: channels.map((c) => c.slice(1)),
        removedSpans: [{ start: 0, end: 1 }],
      }),
    });
    const docId = seedDoc([0.1, 0.2, 0.3]);

    await runEffectOnSelection('test-remove-labelled', {}, { label: 'Tighten It' });

    expect(getHistory(docId).done).toEqual(['Tighten It']);
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

describe('describeRemoval (ruling 5 formatting)', () => {
  it('says "nothing removed" for zero spans', () => {
    expect(describeRemoval([], 44100)).toBe('nothing removed');
  });

  it('uses singular/plural and ms below one second', () => {
    expect(describeRemoval([{ start: 100, end: 541 }], 44100)).toBe('1 gap, 10 ms removed');
    expect(describeRemoval(
      [
        { start: 0, end: 44100 },
        { start: 50000, end: 94100 },
      ],
      44100
    )).toBe('2 gaps, 2.00 s removed');
  });

  it('the ROUNDED ms picks the unit: below / on / just-under the 1 s boundary', () => {
    // 44056 samples = 999.00 ms -> "999 ms".
    expect(describeRemoval([{ start: 0, end: 44056 }], 44100)).toBe('1 gap, 999 ms removed');
    // Exactly one second.
    expect(describeRemoval([{ start: 0, end: 44100 }], 44100)).toBe('1 gap, 1.00 s removed');
    // 44078 samples = 999.5 ms: rounds to 1000, so it must read "1.00 s",
    // never "1000 ms".
    expect(describeRemoval([{ start: 0, end: 44078 }], 44100)).toBe('1 gap, 1.00 s removed');
  });
});

/**
 * T6-3 — cancellation observed between the worker and the commit.
 *
 * The Cover Chain's stages have polled a `shouldCancel` since CC; the single-run
 * path never had one, so the two tools built on a single run (Match Tempo,
 * Align Vocal Timing) had nowhere to put a cancel and were left ORPHANING a
 * finished pass into a document the user had walked away from — recorded in U2's
 * fix round as the follow-up its module lock was mitigating.
 *
 * The check has to live HERE rather than in either dialog: `applyEdit` is called
 * from inside this function, after the await, so no caller can get between the
 * two. And it has to be AFTER the await, or "cancelled" would only ever mean
 * "cancelled before it started" — which is the one moment nobody walks away in.
 */
describe('a cancelled run (T6-3)', () => {
  /** An effect that flips its own cancel flag WHILE the worker leg is running,
   * which is the window a walk-away actually lands in. One id per call: the
   * registry refuses a second registration of the same one. */
  function probeCancelledMidRun(id: string): { shouldCancel: () => boolean } {
    let cancelled = false;
    registerEffect({
      id,
      name: 'Cancel Probe',
      category: 'Utility',
      params: [],
      process: (channels) => {
        cancelled = true;
        return { channels: channels.map((c) => c.map(() => 1)) };
      },
    });
    return { shouldCancel: () => cancelled };
  }

  it('commits nothing — no document write, no undo entry — and reports it', async () => {
    const docId = seedDoc([0.1, 0.2, 0.3, 0.4]);
    const before = activeChannel();

    const outcome = await runEffectOnSelection('test-cancel-a', {}, probeCancelledMidRun('test-cancel-a'));

    expect(outcome).toBe('cancelled');
    // Identity, not equality: `replaceRegion` allocates fresh arrays, so a value
    // comparison would pass on a commit that really had happened.
    expect(activeChannel()).toBe(before);
    expect(canUndo(docId)).toBe(false);
  });

  it('leaves the selection and the cursor where the user left them', async () => {
    const docId = seedDoc([0.1, 0.2, 0.3, 0.4]);
    useAppStore.getState().setSelection({ start: 1, end: 3 });
    useAppStore.getState().setCursor(2);

    await runEffectOnSelection('test-cancel-b', {}, probeCancelledMidRun('test-cancel-b'));

    // `applyEdit` writes both of these GLOBALLY, whichever document it commits
    // to, so a half-cancelled run would move the user's caret for them.
    expect(useAppStore.getState().selection).toEqual({ start: 1, end: 3 });
    expect(useAppStore.getState().cursorSample).toBe(2);
  });

  it('commits as usual when nothing cancelled it', async () => {
    const docId = seedDoc([0.1, 0.2, 0.3, 0.4]);
    const before = activeChannel();
    probeCancelledMidRun('test-cancel-c');

    const outcome = await runEffectOnSelection('test-cancel-c', {}, {
      shouldCancel: () => false,
    });

    expect(outcome).toBe('committed');
    expect(activeChannel()).not.toBe(before);
    expect(canUndo(docId)).toBe(true);
  });

  it('commits as usual when no caller asked about cancellation at all', async () => {
    const docId = seedDoc([0.1, 0.2, 0.3, 0.4]);
    probeCancelledMidRun('test-cancel-d');

    const outcome = await runEffectOnSelection('test-cancel-d', {});

    expect(outcome).toBe('committed');
    expect(canUndo(docId)).toBe(true);
  });

  it('asks ONCE, after the worker leg, rather than polling before it starts', async () => {
    const docId = seedDoc([0.1, 0.2, 0.3, 0.4]);
    let workerRan = false;
    registerEffect({
      id: 'test-cancel-order',
      name: 'Cancel Order',
      category: 'Utility',
      params: [],
      process: (channels) => {
        workerRan = true;
        return { channels: channels.map((c) => c.slice()) };
      },
    });
    const asked: boolean[] = [];

    await runEffectOnSelection('test-cancel-order', {}, {
      shouldCancel: () => {
        asked.push(workerRan);
        return true;
      },
    });

    // A check placed before the await would have recorded `false` here.
    expect(asked).toEqual([true]);
  });

  it('reports a worker failure as refused, not as cancelled', async () => {
    const docId = seedDoc([0.1, 0.2, 0.3, 0.4]);
    _setDspWorkerLoadFailure('worker unavailable');
    (window as { electronAPI?: unknown }).electronAPI = { showMessageBox: () => Promise.resolve() };

    const outcome = await runEffectOnSelection('amplify', { gainDb: 6 }, {
      shouldCancel: () => false,
    });

    // The two are different events and the caller acts differently on them: a
    // failure has already shown its dialog, a cancellation must stay silent.
    expect(outcome).toBe('refused');
    expect(canUndo(docId)).toBe(false);
  });
});
