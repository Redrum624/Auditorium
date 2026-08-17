/**
 * The envelope follower and the shared multi-channel detector signal moved to
 * `src/dsp/envelope.ts` (F2) so DSP-layer modules (the silence detector) can
 * use them without importing from the effects layer. Re-exported here verbatim
 * so every existing consumer (compressor, limiter, noise gate, and their
 * tests) keeps its import path; the progress helper below is effect-plumbing,
 * not DSP, so it stays.
 */
export { envelopeFollower, maxAcrossChannels } from '../../dsp/envelope';

/** Emits onProgress roughly every 64k samples, plus a final call at i === length - 1. */
export const PROGRESS_CHUNK = 65536;

export function maybeReportProgress(
  onProgress: ((fraction: number) => void) | undefined,
  i: number,
  length: number
): void {
  if (!onProgress) return;
  if (i % PROGRESS_CHUNK === PROGRESS_CHUNK - 1 || i === length - 1) {
    onProgress((i + 1) / length);
  }
}
