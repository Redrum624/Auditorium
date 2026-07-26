import { renderHook, act } from '@testing-library/react';
import {
  getTempo,
  getRemixAnalysis,
  isTempoRunning,
  getTempoProgress,
  runTempoAnalysis,
  runRemixAnalysis,
  invalidateTempo,
  invalidateRemix,
  clearAllTempo,
  clearAllRemix,
  getTempoVersion,
  useTempoVersion,
  _promoteToRemixLevelForTest,
} from './tempoAnalysis';
import { createDocument, replaceRegion, type AudioDocument } from '../audio/AudioDocument';
import { useAppStore, makeInitialState } from '../stores/appStore';
import { applyEdit } from './editOps';
import {
  _setTempoWorkerError,
  _setTempoWorkerLoadFailure,
  _getLastTempoMessage,
  _getTempoWorkerTerminateCount,
  _resetTempoWorkerTestState,
} from '../__mocks__/createTempoWorkerMock';

const SR = 44100;

/** A unit-impulse click train at `bpm` beats/minute over `seconds` (mirrors
 * createTempoWorker.test.ts's local generator — this repo re-declares such
 * helpers per test file rather than sharing one). */
function clickTrain(bpm: number, seconds: number, sr = SR): Float32Array {
  const n = Math.round(seconds * sr);
  const out = new Float32Array(n);
  const interval = Math.round((60 / bpm) * sr);
  for (let i = 0; i < n; i += interval) out[i] = 1;
  return out;
}

function seedDoc(channels: Float32Array[], sampleRate = SR): AudioDocument {
  const doc = createDocument({ name: 'test.wav', sampleRate, channels });
  useAppStore.getState().addDocument(doc);
  return doc;
}

/** Re-reads a document by id from the live store (post-edit/rename). */
function liveDoc(docId: string): AudioDocument {
  const doc = useAppStore.getState().documents.find((d) => d.id === docId);
  if (!doc) throw new Error(`liveDoc: not found: ${docId}`);
  return doc;
}

function installShowMessageBox(): jest.Mock {
  const showMessageBox = jest.fn(async () => 0);
  (window as unknown as { electronAPI: { showMessageBox: typeof showMessageBox } }).electronAPI = {
    showMessageBox,
  };
  return showMessageBox;
}

beforeEach(() => {
  useAppStore.setState(makeInitialState());
  clearAllTempo();
  _resetTempoWorkerTestState();
});

afterEach(() => {
  delete (window as { electronAPI?: unknown }).electronAPI;
});

describe('runTempoAnalysis / getTempo — cache identity and staleness (acceptance a-e)', () => {
  it('(a) runs and caches a fresh entry with stale=false and a finite bpm', async () => {
    const doc = seedDoc([clickTrain(120, 8)]);

    const entry = await runTempoAnalysis(doc);

    expect(entry).not.toBeNull();
    expect(entry!.stale).toBe(false);
    expect(Number.isFinite(entry!.bpm)).toBe(true);
    expect(getTempo(doc)).toBe(entry);
  });

  it('(b) a metadata-only replacement (marker add) keeps stale=false and the IDENTICAL object', async () => {
    const doc = seedDoc([clickTrain(120, 8)]);
    const entry = await runTempoAnalysis(doc);

    // addMarker replaces the doc object (markDirty) but never touches channels.
    useAppStore.getState().addMarker(doc.id, { id: 'm-1', name: 'Verse', positionSample: 10 });
    const renamedAndDirty = { ...liveDoc(doc.id), name: 'renamed.wav' };
    useAppStore.getState().updateDocument(renamedAndDirty);

    const after = getTempo(liveDoc(doc.id));
    expect(after).toBe(entry); // proves the cache keys on channel identity, not doc identity
    expect(after!.stale).toBe(false);
  });

  it('(c) an edit that silences a region keeps the SAME entry but flips stale to true', async () => {
    const doc = seedDoc([clickTrain(120, 8)]);
    const entry = await runTempoAnalysis(doc);

    applyEdit('Silence', doc.id, (d) => replaceRegion(d, 100, 200, [new Float32Array(100)]));

    const after = getTempo(liveDoc(doc.id));
    expect(after).toBe(entry); // the readout does not blank on edit
    expect(after!.stale).toBe(true);
  });

  it('(d) after that same edit, getRemixAnalysis returns NULL (level!=="remix" arm of the hard rule)', async () => {
    const doc = seedDoc([clickTrain(120, 8)]);
    await runTempoAnalysis(doc);

    applyEdit('Silence', doc.id, (d) => replaceRegion(d, 100, 200, [new Float32Array(100)]));

    expect(getRemixAnalysis(liveDoc(doc.id))).toBeNull();
  });

  it('(d, extended) the hard rule also fires on the STALE arm for a level:"remix" entry — T9\'s deriveRemixFeatures still throws "not implemented" (T3 stub), so a genuine level:"remix" cache row cannot be produced end-to-end via runRemixAnalysis yet; _promoteToRemixLevelForTest relabels the already-cached, real analysis so both arms of the OR are exercised ahead of T9', async () => {
    const doc = seedDoc([clickTrain(120, 8)]);
    await runTempoAnalysis(doc);
    _promoteToRemixLevelForTest(doc.id);

    // Still fresh (no edit yet) and now level:'remix' -> non-null.
    expect(getRemixAnalysis(liveDoc(doc.id))).not.toBeNull();

    applyEdit('Silence', doc.id, (d) => replaceRegion(d, 100, 200, [new Float32Array(100)]));

    // Same level:'remix' row, but now stale -> null. This is the arm the
    // level!=='remix' test above cannot reach.
    expect(getRemixAnalysis(liveDoc(doc.id))).toBeNull();
  });

  it('(e) invalidateTempo(docId) clears the cache', async () => {
    const doc = seedDoc([clickTrain(120, 8)]);
    await runTempoAnalysis(doc);

    invalidateTempo(doc.id);

    expect(getTempo(doc)).toBeNull();
  });
});

describe('runTempoAnalysis — concurrency and worker choreography (acceptance f-i)', () => {
  it('(f) two concurrent calls for the same doc share ONE worker and resolve to the same object', async () => {
    const doc = seedDoc([clickTrain(120, 8)]);

    const p1 = runTempoAnalysis(doc);
    const p2 = runTempoAnalysis(doc);
    expect(p1).toBe(p2); // deduped to the SAME promise, not just an equal result

    const [r1, r2] = await Promise.all([p1, p2]);

    expect(r1).toBe(r2);
    expect(r1).not.toBeNull();
    expect(_getLastTempoMessage()).not.toBeNull();
    expect(_getTempoWorkerTerminateCount()).toBe(1); // one worker created and terminated, not two
  });

  it('(g) an in-band worker error resolves null, shows one error dialog, and terminates the worker', async () => {
    const showMessageBox = installShowMessageBox();
    _setTempoWorkerError('boom');
    const doc = seedDoc([clickTrain(120, 8)]);

    const result = await runTempoAnalysis(doc);

    expect(result).toBeNull();
    expect(showMessageBox).toHaveBeenCalledTimes(1);
    expect(showMessageBox).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', title: 'Tempo analysis failed', message: 'boom' })
    );
    expect(_getTempoWorkerTerminateCount()).toBe(1);
    expect(getTempo(doc)).toBeNull(); // no cache entry from a failed run
  });

  it('(h) a worker load failure (onerror) resolves null, shows one error dialog, and terminates the worker', async () => {
    const showMessageBox = installShowMessageBox();
    _setTempoWorkerLoadFailure('nope');
    const doc = seedDoc([clickTrain(120, 8)]);

    const result = await runTempoAnalysis(doc);

    expect(result).toBeNull();
    expect(showMessageBox).toHaveBeenCalledTimes(1);
    expect(showMessageBox).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', title: 'Tempo analysis failed', message: 'nope' })
    );
    expect(_getTempoWorkerTerminateCount()).toBe(1);
  });

  it('(i) a reply superseded by a second run for the same doc does not clobber the cache', async () => {
    const doc = seedDoc([clickTrain(120, 8)]);
    const baseline = await runTempoAnalysis(doc); // E0 — the established baseline entry
    _resetTempoWorkerTestState(); // zero the terminate counter from the baseline run

    // Neither call is deduped against the (already-settled) baseline run: a
    // genuinely NEW worker starts for each. currentRunId is updated
    // SYNCHRONOUSLY when each run starts (before either's mock microtask
    // runs), so by the time run1's (tempo) belated 'done' arrives, run2
    // (remix) has already claimed currentRunId — making run1's reply stale.
    const p1 = runTempoAnalysis(doc); // run1 (tempo) — will succeed, but arrives stale
    const p2 = runRemixAnalysis(doc); // run2 (remix) — claims currentRunId; fails via the T9 stub

    const [r1, r2] = await Promise.all([p1, p2]);

    expect(getTempo(doc)).toBe(baseline); // untouched — run1's stale 'done' did not overwrite it
    expect(r1).toBe(baseline); // run1's own promise still settles, reflecting the still-valid baseline
    expect(r2).toBeNull(); // run2 fails (T9 stub)
    expect(_getTempoWorkerTerminateCount()).toBe(2); // two distinct workers ran (baseline's is reset away below)
  });
});

describe('runTempoAnalysis — LRU and buffer-transfer safety (acceptance j-k)', () => {
  it('(j) LRU: analysing 5 documents keeps only the newest 4, oldest evicted', async () => {
    const docs = Array.from({ length: 5 }, () => seedDoc([new Float32Array(50)]));

    for (const d of docs) {
      await runTempoAnalysis(d);
    }

    expect(getTempo(docs[0])).toBeNull(); // oldest evicted
    for (let i = 1; i < docs.length; i++) {
      expect(getTempo(docs[i])).not.toBeNull();
    }
  });

  it('(k) leaves the source document\'s channels readable after a run (no doc.channels transfer regression)', async () => {
    const doc = seedDoc([clickTrain(120, 8)]);

    await runTempoAnalysis(doc);

    const live = liveDoc(doc.id);
    expect(Number.isFinite(live.channels[0][0])).toBe(true);
    expect(live.channels[0].byteLength).toBeGreaterThan(0);
  });
});

describe('closeDocumentFlow leak guard (doc closed mid-run)', () => {
  it('does not resurrect a cache entry when the document closes before the run settles', async () => {
    const doc = seedDoc([clickTrain(120, 8)]);

    const runPromise = runTempoAnalysis(doc);
    // Simulate the document closing before the (microtask-queued) mock
    // worker's 'done' reply is delivered.
    useAppStore.getState().closeDocument(doc.id);

    const result = await runPromise;

    expect(result).toBeNull();
    expect(getTempo(doc)).toBeNull(); // never written — the closed doc's channels are not pinned
  });
});

describe('invalidateRemix', () => {
  it('clears only a level:"remix" entry, leaving a level:"tempo" entry untouched', async () => {
    const doc = seedDoc([clickTrain(120, 8)]);
    const entry = await runTempoAnalysis(doc);

    invalidateRemix(doc.id); // entry is level 'tempo' -- no-op
    expect(getTempo(doc)).toBe(entry);

    _promoteToRemixLevelForTest(doc.id);
    invalidateRemix(doc.id); // now level 'remix' -- clears
    expect(getTempo(doc)).toBeNull();
  });
});

describe('clearAllRemix', () => {
  it('clears only level:"remix" rows across the whole cache, leaving level:"tempo" rows untouched', async () => {
    const tempoDoc = seedDoc([clickTrain(120, 8)]);
    const remixDoc = seedDoc([clickTrain(100, 8)]);
    const tempoEntry = await runTempoAnalysis(tempoDoc);
    await runTempoAnalysis(remixDoc);
    _promoteToRemixLevelForTest(remixDoc.id);

    clearAllRemix();

    expect(getTempo(tempoDoc)).toBe(tempoEntry); // untouched
    expect(getTempo(remixDoc)).toBeNull(); // remix-level row cleared
  });
});

describe('level policy', () => {
  it('runTempoAnalysis is a no-op (no new worker) when a fresh level:"remix" entry already exists', async () => {
    const doc = seedDoc([clickTrain(120, 8)]);
    await runTempoAnalysis(doc);
    _promoteToRemixLevelForTest(doc.id);
    _resetTempoWorkerTestState(); // zero the terminate counter from the baseline run

    const result = await runTempoAnalysis(doc);

    expect(result).not.toBeNull();
    expect(_getTempoWorkerTerminateCount()).toBe(0); // no new worker started
  });

  it('runRemixAnalysis currently resolves null via the T9 deriveRemixFeatures stub (documented limitation, not a T4 defect)', async () => {
    const showMessageBox = installShowMessageBox();
    const doc = seedDoc([clickTrain(120, 8)]);

    const result = await runRemixAnalysis(doc);

    expect(result).toBeNull();
    expect(showMessageBox).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', title: 'Tempo analysis failed', message: 'not implemented' })
    );
    expect(getRemixAnalysis(doc)).toBeNull();
  });
});

describe('isTempoRunning / getTempoProgress', () => {
  it('reflect an in-flight run and clear once it settles', async () => {
    const doc = seedDoc([clickTrain(120, 8)]);
    expect(isTempoRunning(doc.id)).toBe(false);
    expect(getTempoProgress(doc.id)).toBeNull();

    const runPromise = runTempoAnalysis(doc);
    expect(isTempoRunning(doc.id)).toBe(true);
    expect(getTempoProgress(doc.id)).toBe(0); // run-start progress

    await runPromise;

    expect(isTempoRunning(doc.id)).toBe(false);
    expect(getTempoProgress(doc.id)).toBeNull();
  });
});

describe('useTempoVersion (acceptance m)', () => {
  it('bumps on run start, on progress/completion, and on invalidate', async () => {
    const doc = seedDoc([clickTrain(120, 8)]);
    const { result } = renderHook(() => useTempoVersion());
    const v0 = result.current;
    expect(v0).toBe(getTempoVersion());

    let runPromise!: Promise<unknown>;
    act(() => {
      runPromise = runTempoAnalysis(doc); // synchronous run-start bump
    });
    const vStart = result.current;
    expect(vStart).toBeGreaterThan(v0);

    await act(async () => {
      await runPromise; // drains throttled progress + completion bumps
    });
    const vDone = result.current;
    expect(vDone).toBeGreaterThan(vStart);

    act(() => invalidateTempo(doc.id));
    expect(result.current).toBeGreaterThan(vDone);
  });
});
