/**
 * Shared test double for the speaker-diarization preload bridge (D2).
 *
 * It stands in for `electron/diarizeManager.cjs`'s renderer contract exactly
 * as that module's header states it: one run at a time, `diarize:*` events
 * while in flight, and a `diarize:run` invoke resolving
 * `{ok:true,windowCount} | {ok:false,cancelled:true} | {ok:false,error}` that
 * never rejects unless the IPC channel itself dies.
 *
 * WHY the payload shapes are re-declared here instead of imported from
 * `src/dsp/diarization.ts`: this fake is the WIRE, and the wire's sizes are
 * D2's, not the assembly's. A fake that read `SEG_FRAMES` from a module the
 * subject also reads would follow that module if it ever changed and would
 * stop pinning the contract the main process actually speaks.
 *
 * The one thing it does import is `unitVector` from `src/dsp/testVectors.ts`,
 * which exists for exactly this — that module's own header names this fake:
 * the diarization unit tests, this fake and the Task 6 landing hook must all
 * speak about the SAME synthetic voices, or a landing driven from the hook
 * would exercise different vectors than the unit tests pinned.
 *
 * Lives in `src/__mocks__/` next to `transcribeBackend.ts`, this repo's home
 * for shared test doubles. It is NOT a jest automock; callers install it.
 */

import { unitVector } from '../dsp/testVectors';

/** Frames per segmentation window on the wire — `diarize:window` carries
 * exactly this many BYTES, one powerset class per frame (D2). */
export const WIRE_WINDOW_FRAMES = 589;
/** Powerset classes the host may send: 0..6 (D2's "bytes 0..6 = argmax class"). */
export const WIRE_CLASS_COUNT = 7;
/** Embedding dimensions on the wire — `diarize:embedding` carries 1024 bytes
 * of float32 (D2: `vector: Float32Array(256)`). */
export const WIRE_EMBED_DIMS = 256;
/** Local speakers a window can carry, and therefore the range
 * `diarize:embedding`'s `localSpeaker` must lie in: D2's powerset is drawn
 * from slots 0..2, so 3 is the first value that is not a slot. Declared here
 * for the same reason as the sizes above — this is the WIRE's number, not the
 * assembly's `LOCAL_SPEAKERS`, and a fake that read the subject's constant
 * would follow it rather than pin the contract. */
export const WIRE_LOCAL_SPEAKERS = 3;
/** The pinned two-file set's total, from `diarizeManager.cjs` DIARIZE_FILES
 * (5,992,913 + 26,530,550). */
export const WIRE_MODEL_BYTES = 32523463;

export interface DiarizeRunRequest {
  sampleRate: number;
  samples: ArrayBuffer;
}

export type DiarizeRunResult =
  | { ok: true; windowCount: number }
  | { ok: false; cancelled: true }
  | { ok: false; error: string };

export interface DiarizeBackend {
  /** The last `diarize:run` payload, as the renderer handed it over. */
  lastRequest: DiarizeRunRequest | null;
  runCalls: number;
  cancelCalls: number;
  ensureCalls: number;
  modelStateCalls: number;
  /** Listener registrations minus unsubscribes — must be back to 0 after any
   * settled run: success, cancel and failure alike. */
  liveListeners: number;
  modelState: { downloaded: boolean; bytes: number | null; expectedBytes: number };
  ensureResult: { ok: true } | { ok: false; error: string };
  /** When set, the run invoke REJECTS with this message (a dead IPC channel). */
  invokeThrows: string | null;
  showMessageBox: jest.Mock;
  /** True while a run invoke is awaiting its settlement. */
  isPending(): boolean;
  /** Resolves the pending run invoke. */
  settle(result: DiarizeRunResult): void;
  emit: {
    modelProgress(p: { received: number; total: number }): void;
    progress(p: { stage: 'segment' | 'embed'; done: number; total: number }): void;
    /** `labels` may be a raw ArrayBuffer so a test can send a malformed one. */
    window(w: { index: number; labels: Uint8Array | ArrayBuffer }): void;
    embedding(e: {
      windowIndex: number;
      localSpeaker: number;
      activeFrames: number;
      vector: Float32Array | ArrayBuffer;
    }): void;
  };
}

function asArrayBuffer(view: Uint8Array | Float32Array | ArrayBuffer): ArrayBuffer {
  if (view instanceof ArrayBuffer) return view;
  return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer;
}

/**
 * A 589-byte window whose frames carry `runs`' classes and 0 (silence)
 * everywhere else. `to` is EXCLUSIVE, matching the half-open frame spans the
 * assembly works in.
 */
export function classWindow(runs: { from: number; to: number; class: number }[]): Uint8Array {
  const out = new Uint8Array(WIRE_WINDOW_FRAMES);
  for (const run of runs) {
    for (let f = run.from; f < run.to; f++) out[f] = run.class;
  }
  return out;
}

/** A 256-d unit "voice" on `axis`, wobbled by `seed` — the shared recipe, so a
 * fixture here is the same vector the diarization unit tests cluster. */
export function speakerVector(axis: number, seed: number): Float32Array {
  return unitVector(WIRE_EMBED_DIMS, axis, seed);
}

/** Installs the fake `window.electronAPI` diarization surface. */
export function installDiarizeBackend(): DiarizeBackend {
  type Listener<T> = (payload: T) => void;
  const modelProgress = new Set<Listener<{ received: number; total: number }>>();
  const progress = new Set<Listener<{ stage: 'segment' | 'embed'; done: number; total: number }>>();
  const windows = new Set<Listener<{ index: number; labels: ArrayBuffer }>>();
  const embeddings = new Set<
    Listener<{ windowIndex: number; localSpeaker: number; activeFrames: number; vector: ArrayBuffer }>
  >();
  let pending: ((r: DiarizeRunResult) => void) | null = null;

  const backend: DiarizeBackend = {
    lastRequest: null,
    runCalls: 0,
    cancelCalls: 0,
    ensureCalls: 0,
    modelStateCalls: 0,
    liveListeners: 0,
    modelState: { downloaded: true, bytes: WIRE_MODEL_BYTES, expectedBytes: WIRE_MODEL_BYTES },
    ensureResult: { ok: true },
    invokeThrows: null,
    showMessageBox: jest.fn().mockResolvedValue(0),
    isPending: () => pending !== null,
    settle(result) {
      const resolve = pending;
      pending = null;
      resolve?.(result);
    },
    emit: {
      modelProgress(p) {
        for (const cb of [...modelProgress]) cb(p);
      },
      progress(p) {
        for (const cb of [...progress]) cb(p);
      },
      window(w) {
        const labels = asArrayBuffer(w.labels);
        for (const cb of [...windows]) cb({ index: w.index, labels });
      },
      embedding(e) {
        const vector = asArrayBuffer(e.vector);
        for (const cb of [...embeddings]) {
          cb({
            windowIndex: e.windowIndex,
            localSpeaker: e.localSpeaker,
            activeFrames: e.activeFrames,
            vector,
          });
        }
      },
    },
  };

  const listen = <T,>(set: Set<T>, cb: T): (() => void) => {
    set.add(cb);
    backend.liveListeners++;
    return () => {
      if (set.delete(cb)) backend.liveListeners--;
    };
  };

  (window as unknown as { electronAPI: unknown }).electronAPI = {
    showMessageBox: backend.showMessageBox,
    diarizeModelState: async () => {
      backend.modelStateCalls++;
      return backend.modelState;
    },
    diarizeEnsureModels: async () => {
      backend.ensureCalls++;
      return backend.ensureResult;
    },
    onDiarizeModelProgress: (cb: Listener<{ received: number; total: number }>) => listen(modelProgress, cb),
    diarizeRun: (req: DiarizeRunRequest) => {
      backend.runCalls++;
      backend.lastRequest = req;
      if (backend.invokeThrows) return Promise.reject(new Error(backend.invokeThrows));
      return new Promise<DiarizeRunResult>((resolve) => {
        pending = resolve;
      });
    },
    diarizeCancel: async () => {
      backend.cancelCalls++;
      // The manager kills the child, so the in-flight invoke resolves
      // cancelled and the renderer's run settles through its normal path.
      if (pending) {
        backend.settle({ ok: false, cancelled: true });
        return { cancelled: true };
      }
      return { cancelled: false };
    },
    onDiarizeProgress: (cb: Listener<{ stage: 'segment' | 'embed'; done: number; total: number }>) =>
      listen(progress, cb),
    onDiarizeWindow: (cb: Listener<{ index: number; labels: ArrayBuffer }>) => listen(windows, cb),
    onDiarizeEmbedding: (
      cb: Listener<{ windowIndex: number; localSpeaker: number; activeFrames: number; vector: ArrayBuffer }>
    ) => listen(embeddings, cb),
  };

  return backend;
}

/** Removes the fake bridge — the "no preload" case every service must survive. */
export function uninstallDiarizeBackend(): void {
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
}
