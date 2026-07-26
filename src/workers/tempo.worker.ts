import { analyzeTempo, deriveGrid } from '../dsp/tempoCore';
import type { TempoAnalysis } from '../dsp/tempoCore';

// Protocol (Task T3, v15-architecture.md "Module map"): the renderer posts an
// `analyze` request with a transferred mono mixdown; the worker replies
// `done` with a transferred TempoAnalysis (or, at level 'remix' once T9
// lands, a RemixAnalysis), throttled `progress` messages along the way, or
// `error` with the failure message when analysis throws — never letting a
// throw escape uncaught (mirrors spectrogram.worker.ts's try/catch shape).
//
// `level:'regrid'` (Task T4 Plan Ruling 4, added post-T4-review): carries the
// RETAINED `odf` (from a prior 'tempo'/'remix' analysis) and a caller-chosen
// `periodFrames` instead of `minBpm`/`maxBpm` — runs ONLY `deriveGrid`
// (trackBeats + sample-domain refinement), skipping decimation/FFT/ACF/
// octave-search entirely (~50ms vs ~3s for a full analysis). This is what the
// x2/(divide)2 octave-correction control must call so it physically
// re-tracks the grid at the corrected period rather than relabelling the
// displayed BPM over an unchanged (wrong-density) `beatSamples`.
interface AnalyzeMessage {
  type: 'analyze';
  id: number;
  level: 'tempo' | 'remix' | 'regrid';
  mono: Float32Array;
  sampleRate: number;
  minBpm: number;
  maxBpm: number;
  beatsPerBar: number;
  downbeatShiftBeats: number;
  /** Only present/used when level === 'regrid'. */
  odf?: Float32Array;
  periodFrames?: number;
}

// Narrow cast so this compiles under the DOM lib without the conflicting
// `webworker` lib `self` declaration (mirrors spectrogram.worker.ts / dsp.worker.ts).
const ctx = self as unknown as {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent<AnalyzeMessage>) => void) | null;
};

// Same throttle interval and shape as dsp.worker.ts: the renderer must not be
// woken once per onset frame (up to ~12,920 times for a 5-minute track).
const PROGRESS_INTERVAL_MS = 50;

/**
 * T9 will replace this with a real call into `remixFeatures.ts` (chroma pass,
 * bar boundaries, per-boundary descriptors, clusters). Stubbed here so
 * `level:'remix'` is wired all the way through the protocol without this task
 * depending on T9 landing first — this task is independently mergeable.
 */
function deriveRemixFeatures(_tempo: TempoAnalysis, _msg: AnalyzeMessage): never {
  throw new Error('not implemented');
}

ctx.onmessage = (e) => {
  const msg = e.data;
  if (!msg || msg.type !== 'analyze') return;
  try {
    let lastProgress = 0;
    const onProgress = (fraction: number) => {
      const now = Date.now();
      if (now - lastProgress >= PROGRESS_INTERVAL_MS) {
        lastProgress = now;
        ctx.postMessage({ type: 'progress', id: msg.id, fraction });
      }
    };

    let analysis: TempoAnalysis;
    if (msg.level === 'regrid') {
      if (!msg.odf || msg.periodFrames === undefined) {
        throw new Error('regrid request missing odf/periodFrames');
      }
      analysis = deriveGrid(msg.mono, msg.sampleRate, msg.odf, msg.periodFrames);
    } else {
      const tempo = analyzeTempo(
        msg.mono,
        msg.sampleRate,
        { minBpm: msg.minBpm, maxBpm: msg.maxBpm },
        onProgress
      );
      analysis = msg.level === 'remix' ? deriveRemixFeatures(tempo, msg) : tempo;
    }

    ctx.postMessage(
      { type: 'done', id: msg.id, level: msg.level, analysis },
      [analysis.beatSamples.buffer as ArrayBuffer, analysis.odf.buffer as ArrayBuffer]
    );
  } catch (err) {
    ctx.postMessage({
      type: 'error',
      id: msg.id,
      message: err instanceof Error ? err.message : String(err),
    });
  }
};
