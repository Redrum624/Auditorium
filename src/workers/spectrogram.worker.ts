import { computeSpectrogramColumns } from './spectrogramCore';

// Protocol (Task 19): the renderer posts a `compute` request with a transferred
// mono channel; the worker replies `done` with a transferred column-major
// magnitude(dB) grid (`mags[col*height + row]`). See spectrogramCore.ts.
interface ComputeMessage {
  type: 'compute';
  id: number;
  channel: Float32Array;
  sampleRate: number;
  startSample: number;
  endSample: number;
  width: number;
  height: number;
  fftSize: number;
  scale?: 'log' | 'linear';
}

// Narrow cast so this compiles under the DOM lib without the conflicting
// `webworker` lib `self` declaration (mirrors dsp.worker.ts).
const ctx = self as unknown as {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent<ComputeMessage>) => void) | null;
};

ctx.onmessage = (e) => {
  const msg = e.data;
  if (!msg || msg.type !== 'compute') return;
  const mags = computeSpectrogramColumns({
    channel: msg.channel,
    startSample: msg.startSample,
    endSample: msg.endSample,
    width: msg.width,
    height: msg.height,
    fftSize: msg.fftSize,
    sampleRate: msg.sampleRate,
    scale: msg.scale,
  });
  ctx.postMessage(
    { type: 'done', id: msg.id, mags, width: msg.width, height: msg.height },
    [mags.buffer]
  );
};
