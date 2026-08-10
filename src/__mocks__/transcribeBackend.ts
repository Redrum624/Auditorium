/**
 * Shared test double for the transcription preload bridge (F4b).
 *
 * `transcribeService.test.ts` keeps its own, finer-grained backend because it
 * drives every settlement path by hand. This one exists for the COMPONENT
 * tests, whose subject is the UI: they need a real transcript in the real
 * store — produced through the real service, so the panel and the ribbon are
 * pinned against the shape the service actually stores rather than a
 * hand-written stand-in that could drift from it.
 *
 * Lives in `src/__mocks__/` next to `createSpectrogramWorkerMock.ts`, this
 * repo's existing home for shared test doubles. It is NOT a jest automock;
 * callers import and install it explicitly.
 */

import { transcribeDocument, type Transcript } from '../services/transcribeService';

export interface FakeSegment {
  index: number;
  /** MODEL-rate (16 kHz) samples, exactly as the host reports them. */
  startSample: number;
  endSample: number;
  text: string;
  /** Omit for a segment the host could not embed (< 0.5 s). */
  vector?: Float32Array;
}

export interface TranscribeBackend {
  showMessageBox: jest.Mock;
  showSaveDialog: jest.Mock;
  writeFile: jest.Mock;
  cancelCalls: number;
  runCalls: number;
  modelDownloaded: boolean;
  /** Resolves the pending run invoke. */
  settle(result: { ok: true; segmentCount: number } | { ok: false; cancelled: true } | { ok: false; error: string }): void;
  emit: {
    language(p: { language: string; probability: number }): void;
    progress(p: { stage: 'transcribe' | 'embed'; done: number; total: number }): void;
    segment(s: Omit<FakeSegment, 'vector'> & { avgLogprob: number; noSpeechProb: number; compressionRatio: number }): void;
    embedding(e: { segmentIndex: number; vector: ArrayBuffer }): void;
  };
}

/** Installs the fake `window.electronAPI` transcription surface. */
export function installTranscribeBackend(): TranscribeBackend {
  type Listener<T> = (payload: T) => void;
  const language = new Set<Listener<{ language: string; probability: number }>>();
  const progress = new Set<Listener<{ stage: 'transcribe' | 'embed'; done: number; total: number }>>();
  const segment = new Set<Listener<never>>();
  const embedding = new Set<Listener<{ segmentIndex: number; vector: ArrayBuffer }>>();
  let pending: ((r: never) => void) | null = null;

  const backend: TranscribeBackend = {
    showMessageBox: jest.fn().mockResolvedValue(0),
    showSaveDialog: jest.fn().mockResolvedValue('D:\\out\\transcript.srt'),
    writeFile: jest.fn().mockResolvedValue({ ok: true }),
    cancelCalls: 0,
    runCalls: 0,
    modelDownloaded: true,
    settle(result) {
      const resolve = pending as ((r: unknown) => void) | null;
      pending = null;
      resolve?.(result);
    },
    emit: {
      language: (p) => {
        for (const cb of [...language]) cb(p);
      },
      progress: (p) => {
        for (const cb of [...progress]) cb(p);
      },
      segment: (s) => {
        for (const cb of [...segment]) (cb as unknown as (x: unknown) => void)(s);
      },
      embedding: (e) => {
        for (const cb of [...embedding]) cb(e);
      },
    },
  };

  const sub = <T,>(set: Set<T>, cb: T): (() => void) => {
    set.add(cb);
    return () => {
      set.delete(cb);
    };
  };

  (window as unknown as { electronAPI: unknown }).electronAPI = {
    showMessageBox: backend.showMessageBox,
    showSaveDialog: backend.showSaveDialog,
    writeFile: backend.writeFile,
    transcribeModelState: async () => ({
      downloaded: backend.modelDownloaded,
      bytes: backend.modelDownloaded ? 322768831 : null,
      expectedBytes: 322768831,
    }),
    transcribeEnsureModels: async () => ({ ok: true }),
    onTranscribeModelProgress: () => () => {},
    transcribeRun: () => {
      backend.runCalls++;
      return new Promise((resolve) => {
        pending = resolve as unknown as (r: never) => void;
      });
    },
    transcribeCancel: async () => {
      backend.cancelCalls++;
      if (pending) {
        backend.settle({ ok: false, cancelled: true });
        return { cancelled: true };
      }
      return { cancelled: false };
    },
    onTranscribeLanguage: (cb: Listener<{ language: string; probability: number }>) => sub(language, cb),
    onTranscribeProgress: (cb: Listener<{ stage: 'transcribe' | 'embed'; done: number; total: number }>) =>
      sub(progress, cb),
    onTranscribeSegment: (cb: Listener<never>) => sub(segment, cb),
    onTranscribeEmbedding: (cb: Listener<{ segmentIndex: number; vector: ArrayBuffer }>) => sub(embedding, cb),
  };

  return backend;
}

/**
 * Runs a whole transcription through the REAL service against `backend`, so
 * the store ends up holding exactly what production would put there.
 * `docId` must already be an open document.
 */
export async function seedTranscript(
  backend: TranscribeBackend,
  docId: string,
  segments: FakeSegment[],
  options: { language?: string; speakerCount?: number } = {}
): Promise<Transcript> {
  const promise = transcribeDocument({ docId, speakerCount: options.speakerCount });
  // Let the model-state probe and the resample settle so the listeners exist.
  for (let i = 0; i < 6; i++) await Promise.resolve();
  backend.emit.language({ language: options.language ?? 'en', probability: 0.98 });
  for (const s of segments) {
    backend.emit.segment({
      index: s.index,
      startSample: s.startSample,
      endSample: s.endSample,
      text: s.text,
      avgLogprob: -0.3,
      noSpeechProb: 0.02,
      compressionRatio: 1.4,
    });
  }
  for (const s of segments) {
    if (!s.vector) continue;
    const v = s.vector;
    backend.emit.embedding({
      segmentIndex: s.index,
      vector: v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) as ArrayBuffer,
    });
  }
  backend.settle({ ok: true, segmentCount: segments.length });
  const result = await promise;
  if (!result.ok) throw new Error(`seedTranscript failed: ${result.status} — ${result.message}`);
  return result.transcript;
}

/** A deterministic unit vector pointing mostly along `axis`, with a small
 * wobble so two members of a group are close but not identical. */
export function voiceVector(dim: number, axis: number, seed: number): Float32Array {
  let s = seed;
  const rand = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff - 0.5;
  };
  const v = new Float32Array(dim);
  for (let i = 0; i < dim; i++) v[i] = 0.02 * rand();
  v[axis] += 1;
  let norm = 0;
  for (let i = 0; i < dim; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm);
  for (let i = 0; i < dim; i++) v[i] /= norm;
  return v;
}
