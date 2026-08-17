import { analyzeTempo, deriveGrid, decimateMono } from '../dsp/tempoCore';
import type { TempoAnalysis } from '../dsp/tempoCore';
import { chromaEnvelope, deriveRemixFeatures } from '../dsp/remixFeatures';
import type { RemixAnalysis } from '../dsp/remixFeatures';

// Protocol (Task T3, v15-architecture.md "Module map"): the renderer posts an
// `analyze` request with a transferred mono mixdown; the worker replies
// `done` with a transferred TempoAnalysis (or, at level 'remix', a
// RemixAnalysis), throttled `progress` messages along the way, or `error`
// with the failure message when analysis throws — never letting a throw
// escape uncaught (mirrors spectrogram.worker.ts's try/catch shape).
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

    let analysis: TempoAnalysis | RemixAnalysis;
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
      if (msg.level === 'remix') {
        // Second streaming pass (T9): re-decimates the SAME analyzed range
        // analyzeTempo just used (same D, same rate, same signal length) so
        // the chroma-frame and onset-frame timelines share one consistent
        // decimated-signal basis, then adds chroma + downbeat/boundaries/
        // descriptors/clusters. See remixFeatures.ts's `analyzeRemix` doc
        // comment — this inlines that same two-step shape rather than
        // calling it directly so progress can be composed across both
        // passes (0->0.7 onset, 0.7->1.0 chroma) instead of resetting.
        const analyzed = msg.mono.subarray(0, tempo.analyzedEndSample);
        const { signal, rate } = decimateMono(analyzed, msg.sampleRate);
        const chroma = chromaEnvelope(signal, rate, (f) => onProgress(0.7 + f * 0.3));
        analysis = deriveRemixFeatures(tempo, chroma, {
          beatsPerBar: msg.beatsPerBar,
          downbeatShiftBeats: msg.downbeatShiftBeats,
        });
      } else {
        analysis = tempo;
      }
    }

    // Every typed array on `analysis` is TRANSFERRED, never structure-cloned
    // -- `bands`/`odfLow` are now part of the base TempoAnalysis shape (this
    // task's tempoCore.ts widening) so they are always included; the
    // remix-only arrays are added only when present.
    const transfer: ArrayBuffer[] = [
      analysis.beatSamples.buffer as ArrayBuffer,
      analysis.odf.buffer as ArrayBuffer,
      analysis.bands.buffer as ArrayBuffer,
      analysis.odfLow.buffer as ArrayBuffer,
    ];
    if (msg.level === 'remix') {
      const remix = analysis as RemixAnalysis;
      transfer.push(
        remix.chroma.buffer as ArrayBuffer,
        remix.barBoundary.buffer as ArrayBuffer,
        remix.T.buffer as ArrayBuffer,
        remix.C.buffer as ArrayBuffer,
        remix.L.buffer as ArrayBuffer,
        remix.R.buffer as ArrayBuffer,
        remix.S.buffer as ArrayBuffer,
        remix.cluster.buffer as ArrayBuffer
      );
    }

    ctx.postMessage({ type: 'done', id: msg.id, level: msg.level, analysis }, transfer);
  } catch (err) {
    ctx.postMessage({
      type: 'error',
      id: msg.id,
      message: err instanceof Error ? err.message : String(err),
    });
  }
};
