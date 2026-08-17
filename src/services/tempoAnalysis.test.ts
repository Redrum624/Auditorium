import { renderHook, act } from '@testing-library/react';
import {
  getTempo,
  getRemixAnalysis,
  isTempoRunning,
  getTempoProgress,
  runTempoAnalysis,
  runRemixAnalysis,
  regridTempo,
  invalidateTempo,
  invalidateRemix,
  clearAllTempo,
  clearAllRemix,
  getTempoVersion,
  useTempoVersion,
  _promoteToRemixLevelForTest,
  _getCachedChannelRefsForTest,
} from './tempoAnalysis';
import { analyzeTempo, MAX_ANALYSIS_SECONDS } from '../dsp/tempoCore';
import { createDocument, replaceRegion, type AudioDocument } from '../audio/AudioDocument';
import { useAppStore, makeInitialState } from '../stores/appStore';
import { applyEdit } from './editOps';
import * as createTempoWorkerModule from '../workers/createTempoWorker';
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

  it('(i) a reply superseded by a second run for the same doc does not clobber the cache with STALE data', async () => {
    const doc = seedDoc([clickTrain(120, 8)]);
    const baseline = await runTempoAnalysis(doc); // E0 — the established baseline entry
    _resetTempoWorkerTestState(); // zero the terminate counter from the baseline run

    // Neither call is deduped against the (already-settled) baseline run: a
    // genuinely NEW worker starts for each. currentRunId is updated
    // SYNCHRONOUSLY when each run starts (before either's mock microtask
    // runs), so by the time run1's (tempo) belated 'done' arrives, run2
    // (remix) has already claimed currentRunId — making run1's reply stale
    // (dropped for cache purposes) even though run1's OWN promise still
    // settles reflecting whatever was live at ITS settle time. Run2 (remix,
    // genuinely implemented as of T9 fix round 1) is the CURRENT run when
    // ITS OWN done arrives, so its result legitimately replaces the cache
    // row — that is correct behaviour, not the "stale reply clobbers"
    // failure mode this test guards against.
    const p1 = runTempoAnalysis(doc); // run1 (tempo) — becomes stale before its own done arrives
    const p2 = runRemixAnalysis(doc); // run2 (remix) — the CURRENT run; its own done legitimately updates the cache

    const [r1, r2] = await Promise.all([p1, p2]);

    expect(r1).toBe(baseline); // run1 settles reflecting the still-valid baseline, not a stale write of its own
    expect(r2).not.toBeNull(); // run2 (remix) now genuinely succeeds (T9)
    expect(r2?.bpm).toBe(baseline?.bpm ?? null);

    const finalEntry = getTempo(doc);
    expect(finalEntry).not.toBe(baseline); // run2's OWN (current) done legitimately replaced the row — not a clobber
    expect(finalEntry?.stale).toBe(false);
    expect(_getTempoWorkerTerminateCount()).toBe(2); // two distinct workers ran
  });
});

describe('startRun — synchronous setup throws (I1, T4 review fix round 1)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('createTempoWorker() throwing synchronously resolves null, shows the failure dialog, and leaves no stuck progress/currentRunId', async () => {
    const showMessageBox = installShowMessageBox();
    jest.spyOn(createTempoWorkerModule, 'createTempoWorker').mockImplementationOnce(() => {
      throw new Error('worker construction boom');
    });
    const doc = seedDoc([clickTrain(120, 8)]);

    const result = await runTempoAnalysis(doc);

    expect(result).toBeNull();
    expect(showMessageBox).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        title: 'Tempo analysis failed',
        message: 'worker construction boom',
      })
    );
    expect(getTempo(doc)).toBeNull(); // nothing cached
    expect(isTempoRunning(doc.id)).toBe(false);
    expect(getTempoProgress(doc.id)).toBeNull(); // not stuck at 0 forever
  });

  it('worker.postMessage throwing synchronously resolves null (not a rejected promise), shows the failure dialog, terminates the worker, and leaves no stuck progress/currentRunId', async () => {
    const showMessageBox = installShowMessageBox();
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
    jest
      .spyOn(createTempoWorkerModule, 'createTempoWorker')
      .mockImplementationOnce(() => fakeWorker as unknown as Worker);
    const doc = seedDoc([clickTrain(120, 8)]);

    // Must resolve, never reject — a synchronous throw inside a `new
    // Promise` executor otherwise silently rejects the returned promise
    // instead of settling it per the "always resolves" contract.
    await expect(runTempoAnalysis(doc)).resolves.toBeNull();

    expect(showMessageBox).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', title: 'Tempo analysis failed', message: 'postMessage boom' })
    );
    expect(terminateCalls).toBe(1);
    expect(getTempo(doc)).toBeNull();
    expect(isTempoRunning(doc.id)).toBe(false);
    expect(getTempoProgress(doc.id)).toBeNull();
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

  it('runRemixAnalysis produces a genuine level:"remix" cache row end-to-end (T9 fix round 1 — was a documented stub limitation, now real)', async () => {
    const doc = seedDoc([clickTrain(120, 8)]);

    const result = await runRemixAnalysis(doc);

    expect(result).not.toBeNull();
    expect(result?.bpm).not.toBeNull();
    expect(result?.numBars).toBeGreaterThan(0);
    expect(getRemixAnalysis(doc)).toBe(result);
  });
});

describe('regridTempo — end-to-end (Task T4 Plan Ruling 4)', () => {
  it('a half-tempo detection regridded to double the period produces a beat grid with TWICE the beat count at the correct positions — not a relabel', async () => {
    const doc = seedDoc([clickTrain(120, 20)]);
    const original = await runTempoAnalysis(doc);
    expect(original).not.toBeNull();
    expect(original!.bpm).not.toBeNull();
    const originalBeatCount = original!.beatSamples.length;
    const originalBpm = original!.bpm!;

    // Simulate the x2 correction: the true content is twice as dense as
    // detected -- the corrected period is HALF the original.
    const regridded = await regridTempo(doc.id, original!.periodFrames / 2);

    expect(regridded).not.toBeNull();
    expect(regridded!.bpm).not.toBeNull();
    // Bpm close to double -- proves an actual re-track at the halved
    // period, not merely a relabelled number over the SAME sparse grid.
    expect(regridded!.bpm! / originalBpm).toBeGreaterThan(1.8);
    expect(regridded!.bpm! / originalBpm).toBeLessThan(2.2);
    // Beat COUNT close to double -- the whole point of the carry-forward.
    expect(regridded!.beatSamples.length).toBeGreaterThan(originalBeatCount * 1.7);
    expect(regridded!.beatSamples.length).toBeLessThan(originalBeatCount * 2.3);
    expect(Array.from(regridded!.beatSamples)).not.toEqual(Array.from(original!.beatSamples));

    // The corrected entry is now what getTempo/the cache serve.
    expect(getTempo(doc)).toBe(regridded);
    expect(regridded!.stale).toBe(false);

    // deriveGrid has no ACF/candidate data -- these 4 fields are carried
    // over from the entry being corrected, not fabricated/zeroed.
    expect(regridded!.confidence).toBe(original!.confidence);
    expect(regridded!.peakRatio).toBe(original!.peakRatio);
    expect(regridded!.truncated).toBe(original!.truncated);
    expect(regridded!.analyzedEndSample).toBe(original!.analyzedEndSample);
  }, 20000);

  it('re-tracking at DOUBLE the period produces roughly HALF the beat count (the ÷2 direction)', async () => {
    const doc = seedDoc([clickTrain(120, 20)]);
    const original = await runTempoAnalysis(doc);
    expect(original).not.toBeNull();

    const regridded = await regridTempo(doc.id, original!.periodFrames * 2);

    expect(regridded).not.toBeNull();
    expect(original!.bpm! / regridded!.bpm!).toBeGreaterThan(1.8);
    expect(original!.bpm! / regridded!.bpm!).toBeLessThan(2.2);
    expect(regridded!.beatSamples.length).toBeLessThan(original!.beatSamples.length * 0.65);
  }, 20000);

  it('refuses (resolves null) when there is no cached entry for the doc', async () => {
    const doc = seedDoc([clickTrain(120, 8)]);
    const result = await regridTempo(doc.id, 20);
    expect(result).toBeNull();
  });

  it('refuses (resolves null) when the cached entry is stale', async () => {
    const doc = seedDoc([clickTrain(120, 20)]);
    const original = await runTempoAnalysis(doc);
    expect(original).not.toBeNull();

    applyEdit('Silence', doc.id, (d) => replaceRegion(d, 100, 200, [new Float32Array(100)]));

    const result = await regridTempo(doc.id, original!.periodFrames / 2);
    expect(result).toBeNull();
  });

  it('refuses (resolves null) when the document has been closed', async () => {
    const doc = seedDoc([clickTrain(120, 20)]);
    const original = await runTempoAnalysis(doc);
    expect(original).not.toBeNull();

    useAppStore.getState().closeDocument(doc.id);

    const result = await regridTempo(doc.id, original!.periodFrames / 2);
    expect(result).toBeNull();
  }, 20000);

  it('preserves a level:"remix" row\'s level through a regrid (must not force it back to "tempo")', async () => {
    const doc = seedDoc([clickTrain(120, 20)]);
    const original = await runTempoAnalysis(doc);
    expect(original).not.toBeNull();
    _promoteToRemixLevelForTest(doc.id);
    expect(getRemixAnalysis(doc)).not.toBeNull(); // sanity: now level:'remix' and fresh

    const regridded = await regridTempo(doc.id, original!.periodFrames / 2);

    expect(regridded).not.toBeNull();
    expect(getRemixAnalysis(doc)).not.toBeNull(); // still level:'remix' after the regrid
  }, 20000);

  it('bumps the version and reports running via isTempoRunning while in flight', async () => {
    const doc = seedDoc([clickTrain(120, 20)]);
    const original = await runTempoAnalysis(doc);
    expect(original).not.toBeNull();
    const vBefore = getTempoVersion();

    const regridPromise = regridTempo(doc.id, original!.periodFrames);
    expect(isTempoRunning(doc.id)).toBe(true);

    await regridPromise;

    expect(getTempoVersion()).toBeGreaterThan(vBefore);
    expect(isTempoRunning(doc.id)).toBe(false);
  }, 20000);

  it('two concurrent regridTempo calls for the same doc share ONE promise', async () => {
    const doc = seedDoc([clickTrain(120, 20)]);
    const original = await runTempoAnalysis(doc);
    expect(original).not.toBeNull();

    const p1 = regridTempo(doc.id, original!.periodFrames / 2);
    const p2 = regridTempo(doc.id, original!.periodFrames / 2);

    expect(p1).toBe(p2);
    await Promise.all([p1, p2]);
  }, 20000);
});

describe('regridTempo — degenerate periodFrames (N1, T4 review fix round 2)', () => {
  it('an out-of-range (but positive, finite) period resolves null and leaves the prior good entry COMPLETELY unchanged', async () => {
    const doc = seedDoc([clickTrain(120, 20)]);
    const original = await runTempoAnalysis(doc);
    expect(original).not.toBeNull();
    expect(original!.bpm).not.toBeNull();

    // Wildly out of range for a 20 s fixture's odf length -- trackBeats
    // finds fewer than 2 beats at this period.
    const result = await regridTempo(doc.id, original!.odf.length * 100);

    expect(result).toBeNull(); // never the stale-looking "old entry returned as if it succeeded"
    // The cache row itself must be BYTE-IDENTICAL to before -- same object
    // reference, not just equal values -- proving writeCache never ran.
    expect(getTempo(doc)).toBe(original);
    expect(getTempo(doc)!.bpm).toBe(original!.bpm);
    expect(getTempo(doc)!.confidence).toBe(original!.confidence);
    expect(getTempo(doc)!.beatSamples.length).toBe(original!.beatSamples.length);
  }, 20000);

  it.each([0, -1, -100, NaN, Infinity, -Infinity])(
    'periodFrames=%p is rejected up front (resolves null, no worker round-trip, prior entry untouched)',
    async (badPeriod) => {
      const doc = seedDoc([clickTrain(120, 20)]);
      const original = await runTempoAnalysis(doc);
      expect(original).not.toBeNull();
      _resetTempoWorkerTestState(); // isolate the terminate-count assertion below

      const result = await regridTempo(doc.id, badPeriod);

      expect(result).toBeNull();
      expect(getTempo(doc)).toBe(original); // untouched
      expect(_getTempoWorkerTerminateCount()).toBe(0); // rejected before any worker was even created
    },
    20000
  );
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

  it('(C1, tightened) isTempoRunning is already false by the time the LAST version bump lands — a render gated purely on useTempoVersion() must never see a permanently-stuck "running" state', async () => {
    const doc = seedDoc([clickTrain(120, 8)]);
    // Reads BOTH the version and isTempoRunning INSIDE the same render, so
    // each captured value reflects exactly what a consumer gated purely on
    // useTempoVersion() would see at that render -- not a fresh out-of-band
    // call made later by the test.
    const { result } = renderHook(() => ({
      version: useTempoVersion(),
      running: isTempoRunning(doc.id),
    }));

    let runPromise!: Promise<unknown>;
    act(() => {
      runPromise = runTempoAnalysis(doc);
    });
    expect(result.current.running).toBe(true);

    await act(async () => {
      await runPromise;
    });

    // Before the C1 fix: settle()'s bump (still inside startRun, before
    // .finally() deletes the dedupe entry) was the LAST bump for this run,
    // so this render would be permanently stuck reporting running:true even
    // though isTempoRunning(doc.id) called fresh (below) already says false.
    expect(result.current.running).toBe(false);
    expect(isTempoRunning(doc.id)).toBe(false); // sanity: matches out-of-band
  });
});

// ---------------------------------------------------------------------------
// v1.5.0 hardening — mono snapshot budget + stale-row retention
// ---------------------------------------------------------------------------

describe('monoSnapshot budget (hardening item 1)', () => {
  // 8000 Hz keeps decimateMono at factor 1 (round(8000/11025) === 1) while
  // still giving the ODF a usable 31.25 fps, so this exercises the real
  // analysis path rather than a degenerate one -- at 1/5th the samples a
  // 44.1 kHz fixture of the same duration would cost.
  const SLOW_SR = 8000;
  const MAX_SAMPLES = Math.round(MAX_ANALYSIS_SECONDS * SLOW_SR);

  it('posts at most MAX_ANALYSIS_SECONDS+1-sample worth of mono to the worker for an over-long document', async () => {
    const overLong = clickTrain(120, MAX_ANALYSIS_SECONDS + 30, SLOW_SR);
    expect(overLong.length).toBeGreaterThan(MAX_SAMPLES);
    const doc = seedDoc([overLong], SLOW_SR);

    const entry = await runTempoAnalysis(doc);

    // The clamp: everything past the worker's own truncation bound was
    // allocated, averaged, transferred and then never read.
    expect(_getLastTempoMessage()!.mono.length).toBe(MAX_SAMPLES + 1);
    // ...and the one extra sample is what keeps `truncated` observable.
    expect(entry!.truncated).toBe(true);
    expect(entry!.analyzedEndSample).toBe(MAX_SAMPLES);
  }, 60000);

  it('the clamp cannot change the analysis: a clamped input is byte-identical to the full one', () => {
    const full = clickTrain(120, MAX_ANALYSIS_SECONDS + 30, SLOW_SR);
    const clamped = full.slice(0, MAX_SAMPLES + 1);

    const fromFull = analyzeTempo(full, SLOW_SR);
    const fromClamped = analyzeTempo(clamped, SLOW_SR);

    expect(fromClamped.bpm).toBe(fromFull.bpm);
    expect(fromClamped.truncated).toBe(fromFull.truncated);
    expect(fromClamped.truncated).toBe(true);
    expect(fromClamped.analyzedEndSample).toBe(fromFull.analyzedEndSample);
    expect(fromClamped.confidence).toBe(fromFull.confidence);
    expect(fromClamped.peakRatio).toBe(fromFull.peakRatio);
    expect(fromClamped.periodFrames).toBe(fromFull.periodFrames);
    expect(fromClamped.decimationFactor).toBe(fromFull.decimationFactor);
    expect(Array.from(fromClamped.beatSamples)).toEqual(Array.from(fromFull.beatSamples));
    expect(Array.from(fromClamped.odf)).toEqual(Array.from(fromFull.odf));
  }, 60000);

  it('a document SHORTER than the bound is still snapshotted in full', async () => {
    const doc = seedDoc([clickTrain(120, 8)]);

    await runTempoAnalysis(doc);

    expect(_getLastTempoMessage()!.mono.length).toBe(8 * SR);
  });
});

describe('stale cache rows release their pre-edit channel arrays (hardening item 3)', () => {
  it('an observed-stale row no longer references the PRE-EDIT Float32Arrays', async () => {
    const preEdit = clickTrain(120, 8);
    const doc = seedDoc([preEdit]);
    await runTempoAnalysis(doc);

    applyEdit('Silence', doc.id, (d) => replaceRegion(d, 100, 200, [new Float32Array(100)]));
    const after = getTempo(liveDoc(doc.id));
    expect(after!.stale).toBe(true);

    // Nothing reachable from the cache may still point at the pre-edit array —
    // that is the ~105 MB (per analysed-then-edited 5-min stereo doc) this
    // fix exists to release, and exactly the arrays undoHistory's
    // MAX_UNDO_BYTES eviction assumes it frees when it shifts an entry out.
    expect(_getCachedChannelRefsForTest(doc.id)).toBeNull();
  });

  it('staleness is STICKY: restoring the original channel arrays does not silently un-stale the row', async () => {
    const preEdit = clickTrain(120, 8);
    const doc = seedDoc([preEdit]);
    await runTempoAnalysis(doc);

    applyEdit('Silence', doc.id, (d) => replaceRegion(d, 100, 200, [new Float32Array(100)]));
    expect(getTempo(liveDoc(doc.id))!.stale).toBe(true);

    // An undo restores the very same array objects the row used to hold.
    useAppStore.getState().updateDocument({ ...liveDoc(doc.id), channels: [preEdit] });

    // The row kept nothing to compare against, so it cannot claim freshness.
    expect(getTempo(liveDoc(doc.id))!.stale).toBe(true);
    expect(getRemixAnalysis(liveDoc(doc.id))).toBeNull();
  });

  it('a fresh run rearms the row: stale goes back to false and channelRefs are repopulated', async () => {
    const doc = seedDoc([clickTrain(120, 8)]);
    await runTempoAnalysis(doc);
    applyEdit('Silence', doc.id, (d) => replaceRegion(d, 100, 200, [new Float32Array(100)]));
    expect(getTempo(liveDoc(doc.id))!.stale).toBe(true);

    const reanalysed = await runTempoAnalysis(liveDoc(doc.id));

    expect(reanalysed!.stale).toBe(false);
    expect(_getCachedChannelRefsForTest(doc.id)).not.toBeNull();
  });
});
