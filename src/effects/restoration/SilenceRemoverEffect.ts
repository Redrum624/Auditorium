import type { EffectDefinition } from '../types';
import { SPLICE_XFADE_MS, detectSilentRuns, planSilenceCuts, spliceCuts } from '../../dsp/silenceDetect';

/**
 * Remove Silence — detects pauses and shortens or removes them so speech
 * flows ("a silence remover, like for podcasts"). Length-changing and
 * destructive; every cut is spliced through the shared crossfade law with
 * material drawn from inside the gap, so speech samples are never modified.
 * Returns `removedSpans` so effectRunner can remap markers EXACTLY (the
 * per-cut piecewise shift) instead of via the proportional 'stretch'
 * heuristic, which mis-places every marker after a removed gap.
 *
 * Parameter defaults, each derived from speech, not taste:
 *
 * - `thresholdDb` -50: the noise gate's own threshold default — this app's
 *   existing judgment of where signal ends and noise floor begins; audio the
 *   gate would mute is audio the remover may shorten. (NOT F1's SILENCE_RMS
 *   ≈ -90 dB: that is a digital-silence physics floor, far below any real
 *   room tone — see silenceDetect.ts.) Range capped at -20 dB because speech
 *   peaks in any usable recording sit above -20 dBFS: a higher threshold
 *   would classify the speech itself as silence and collapse the take.
 *   Step 1 dB: the threshold only classifies (no audible gain hinges on
 *   sub-dB moves, unlike the gate's 0.1 dB step on an audible gain fade).
 * - `minSilenceMs` 500: the silences INSIDE articulation (stop-consonant
 *   closures — the gap inside "p"/"t"/"k" — and inter-word gaps) run up to
 *   ~150 ms and must never qualify, and gaps only start reading as
 *   hesitation pauses around ~250 ms (the conventional cutoff in speech
 *   pause research). 500 ms sits >3x above the longest closure and 2x above
 *   the pause-perception boundary, so only unambiguous pauses qualify.
 *   Floor 100 ms (below that nothing is perceptually a pause — removal can
 *   only damage speech), ceiling 5000 ms (beyond that only dead air).
 * - `padMs` 100: gaps under ~100 ms read as articulation, not pause, so
 *   keeping 100 ms of untouched silence against each speech edge preserves
 *   breath tails and plosive run-ups. In Remove mode the gap collapses to
 *   2x100 ms + the 10 ms blend ≈ 210 ms — just under the ~250 ms
 *   pause-perception boundary: the pause stops registering without the
 *   join sounding truncated.
 * - `mode` 'shorten' default: "make the conversation flow" means tightening
 *   pauses, not deleting them — removing every gap outright makes speech
 *   sound breathless. Remove stays available for hard trims.
 * - `targetMs` 400 (shorten): above the ~250 ms boundary so a shortened
 *   pause still reads as a deliberate pause (sentence rhythm survives), and
 *   below the 500 ms minimum so every gap that qualifies actually shrinks.
 *   Ceiling 2000 ms — a "pause" longer than 2 s is dead air, and shortening
 *   TO more than that would make the effect a no-op on real material.
 *
 * A configuration where nothing qualifies (threshold below the floor, or
 * minimum longer than every gap) returns byte-identical copies — pinned.
 */
export const silenceRemoverEffect: EffectDefinition = {
  id: 'remove-silence',
  name: 'Remove Silence',
  category: 'Restoration',
  params: [
    { id: 'thresholdDb', label: 'Threshold', type: 'number', min: -80, max: -20, step: 1, unit: 'dB', default: -50 },
    { id: 'minSilenceMs', label: 'Min silence', type: 'number', min: 100, max: 5000, step: 10, unit: 'ms', default: 500 },
    { id: 'padMs', label: 'Padding', type: 'number', min: 0, max: 500, step: 5, unit: 'ms', default: 100 },
    {
      id: 'mode',
      label: 'Mode',
      type: 'select',
      options: [
        { value: 'shorten', label: 'Shorten pauses' },
        { value: 'remove', label: 'Remove (keep padding)' },
      ],
      default: 'shorten',
    },
    { id: 'targetMs', label: 'Shorten to', type: 'number', min: 100, max: 2000, step: 10, unit: 'ms', default: 400 },
  ],
  process(channels, sampleRate, params, onProgress) {
    const thresholdDb = Number(params.thresholdDb ?? -50);
    const minSilenceMs = Number(params.minSilenceMs ?? 500);
    const padMs = Number(params.padMs ?? 100);
    const mode = params.mode === 'remove' ? 'remove' : 'shorten';
    const targetMs = Number(params.targetMs ?? 400);

    const runs = detectSilentRuns(channels, sampleRate, thresholdDb, minSilenceMs);
    // Three linear passes total (detector, envelope, splice) — even an hour
    // of stereo audio is sub-second work, so stage-boundary progress is
    // enough granularity for the dialog (the worker throttles to 50 ms).
    onProgress?.(0.6);
    const cuts = planSilenceCuts(runs, {
      mode,
      padSamples: Math.round((padMs / 1000) * sampleRate),
      targetSamples: Math.round((targetMs / 1000) * sampleRate),
      xfadeSamples: Math.round((SPLICE_XFADE_MS / 1000) * sampleRate),
    });
    const out = spliceCuts(channels, cuts);
    onProgress?.(1);
    return { channels: out, removedSpans: cuts.map((cut) => ({ ...cut.removed })) };
  },
};
