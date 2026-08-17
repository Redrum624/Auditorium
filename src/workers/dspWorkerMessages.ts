import type { EffectParamValue, EffectReport } from '../effects/types';

/**
 * The DSP worker's message contract — the ONE definition imported by all
 * three parties: `dsp.worker.ts` (produces replies), `effectRunner.ts`
 * (consumes them), and `__mocks__/createDspWorkerMock.ts` (mirrors the
 * worker for tests).
 *
 * Why this module exists (F2 review, Important 1): `postMessage` takes
 * `unknown`, so nothing type-checked the wire format — the worker and the
 * runner each declared their own copy of these shapes, and a field renamed
 * on one side (e.g. `removedSpans`, which selects the exact marker remap)
 * would keep every test green via the mock while the SHIPPED worker silently
 * stopped delivering it — degrading markers to the proportional stretch
 * remap, the ruling-3 data-loss class. With one shared type and each sender
 * building its message as a typed value, that drift is a compile error.
 */
export interface DspWorkerRunMessage {
  type: 'run';
  id: number;
  effectId: string;
  channels: Float32Array[];
  sampleRate: number;
  params: Record<string, EffectParamValue>;
  extra?: unknown;
}

export interface DspWorkerDoneMessage {
  type: 'done';
  id: number;
  channels: Float32Array[];
  /** Present only for span-deleting effects (Remove Silence): the exact
   * input-relative deleted spans, mirrored from `EffectResult.removedSpans`
   * — effectRunner turns them into the exact 'cuts' marker remap. */
  removedSpans?: { start: number; end: number }[];
  /** Present only for effects that report something a caller cannot measure
   * from the buffers (F7), mirrored from `EffectResult.report`. Plain
   * numbers/strings, so no transfer-list entry — and display-only, so an
   * effect that omits it is indistinguishable in the audio path. */
  report?: EffectReport;
}

export type DspWorkerReply =
  | { type: 'progress'; id: number; fraction: number }
  | DspWorkerDoneMessage
  | { type: 'error'; id: number; message: string };
