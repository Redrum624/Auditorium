/**
 * Silence detection and gap-cut planning for the Remove Silence effect (F2).
 * Pure TS: no DOM, no Electron — runs in the DSP worker.
 *
 * Three stages, deliberately separable so each is testable on its own AND the
 * wiring between them is pinnable (the F1 lesson: pinning a pure function
 * given its inputs does not pin the wiring that supplies them):
 *
 *   1. `detectSilentRuns` — envelope-follow the per-sample channel max
 *      (the same detector signal and follower the noise gate uses) and
 *      collect runs where it sits at/below the threshold for at least the
 *      minimum duration.
 *   2. `planSilenceCuts` — decide, per qualifying run, which interior span to
 *      remove so that the kept silence honours the padding / target-length
 *      contract, and where the splice blend draws its material from.
 *   3. `spliceCuts` — assemble the output, joining every cut through the
 *      shared level-preserving crossfade law (`crossfadeGains`). No sample
 *      OUTSIDE a detected silent run is ever modified; the blend sources come
 *      from inside the gap itself.
 *
 * ## Why the detector threshold is NOT F1's `SILENCE_RMS`
 *
 * `pitchDetect.ts`'s `SILENCE_RMS` (2^-15, one 16-bit LSB) answers "is there
 * any signal at all" — a physics floor below which audio is indistinguishable
 * from digital silence in the most common source format. A pause in a real
 * recording is nowhere near that floor: room tone in home/podcast recordings
 * sits around -65..-45 dBFS, orders of magnitude above one LSB. A remover
 * gated at SILENCE_RMS would be inert on every real recording. So the
 * threshold here is a user-facing perceptual boundary ("quiet enough to be a
 * pause"), defaulting to the noise gate's own -50 dB — the app's existing
 * judgment of where signal ends and floor begins — while F1's constant keeps
 * answering the different question it was derived for.
 */
import { envelopeFollower, maxAcrossChannels } from './envelope';
import { crossfadeGains } from './fades';

/** Half-open sample interval `[start, end)`. */
export interface SampleSpan {
  start: number;
  end: number;
}

/**
 * Detector attack, ms. The noise gate's own attack default (1 ms): the
 * envelope reaches the 1-1/e point of a resuming speech onset within ~1 ms,
 * so a detected gap ends at most ~1 ms into the onset — far below the ~10 ms
 * where remixRender.ts documents a level change becoming audible, and dwarfed
 * by the padding kept in front of the onset anyway.
 */
export const DETECT_ATTACK_MS = 1;

/**
 * Detector release, ms. Must bridge the gaps BETWEEN glottal pulses inside
 * voiced speech, or the detector would see sub-threshold slivers mid-word:
 * the lowest common speaking f0 is ~75 Hz (deep male voice), i.e. ~13.3 ms
 * between pulses, and a decay of tau = 13.3/ln 2 ≈ 19.2 ms keeps the
 * inter-pulse droop under 6 dB — 20 ms is the round value just above that.
 * NOT the gate's 150 ms release: that constant shapes an audible gain fade,
 * while this one only classifies, and 150 ms would delay silence onset by
 * release·ln(level/threshold) ≈ 760 ms for speech 44 dB above threshold,
 * making most real pauses undetectable. The 20 ms cost, stated honestly:
 * silence is DETECTED ~release·ln(level/threshold) after true speech offset
 * (~100 ms for speech 44 dB above threshold), so the effective minimum
 * physical gap is minSilenceMs plus ~100 ms, and every gap keeps that much
 * extra material at its head — an error that only ever errs toward cutting
 * less, never toward clipping speech.
 */
export const DETECT_RELEASE_MS = 20;

/**
 * Splice blend length, ms. remixRender.ts documents the two anchors: 2 ms
 * (`MIN_TAIL_FADE_MS`) is the floor below which a fade stops killing the
 * click, and ~10 ms is where a fade-out becomes audible as a level change.
 * 10 ms is therefore the LONGEST blend that stays below the audibility bound
 * while sitting 5x above the click floor — wanted here because the two sides
 * of a silence splice are different stretches of room tone whose floors may
 * differ, and the longer the blend the smaller the per-sample step between
 * them. The blend draws both sources from INSIDE the removed gap, so it
 * consumes detected silence, never speech.
 */
export const SPLICE_XFADE_MS = 10;

/**
 * Correlation handed to `crossfadeGains` for the splice. The two blend
 * sources are different time-stretches of the same room tone — noise
 * decorrelates over any lag, and there is no correlation measurement here —
 * so per fades.ts's contract this must be a deliberate 0 (power summation for
 * unrelated material), not an invented estimate. Mirrors `CROSSFADE_RHO = 0`
 * in multitrack/mixdown.ts, chosen for the same reason.
 */
const SPLICE_RHO = 0;

/**
 * Collects maximal runs of consecutive samples where `env[i] <= threshold`,
 * keeping only runs at least `minRunSamples` long (a run EXACTLY that long
 * qualifies — the parameter is the minimum that counts, so the comparison is
 * `>=`). The sample-level comparison mirrors the noise gate's convention
 * (open strictly ABOVE threshold): a sample exactly AT the threshold counts
 * as silent. Runs touching either edge of the buffer are reported like any
 * other — leading/trailing silence is still silence.
 */
export function findRunsBelow(env: Float32Array, threshold: number, minRunSamples: number): SampleSpan[] {
  const runs: SampleSpan[] = [];
  let runStart = -1;
  for (let i = 0; i < env.length; i++) {
    if (env[i] <= threshold) {
      if (runStart < 0) runStart = i;
    } else if (runStart >= 0) {
      if (i - runStart >= minRunSamples) runs.push({ start: runStart, end: i });
      runStart = -1;
    }
  }
  if (runStart >= 0 && env.length - runStart >= minRunSamples) {
    runs.push({ start: runStart, end: env.length });
  }
  return runs;
}

/**
 * Stage 1: detect silent runs. Detector signal = per-sample max across
 * channels (all channels must be quiet for a gap to count — the same
 * sidechain the gate/compressor/limiter share), followed by the shared
 * envelope follower at the detection constants above. `thresholdDb` is
 * converted as 10^(dB/20); the linear-domain comparison is equivalent to the
 * gate's dB-domain one for any threshold above its -80 dB floor.
 * `minSilenceMs` converts with Math.round, the same convention the gate uses
 * for holdMs.
 */
export function detectSilentRuns(
  channels: Float32Array[],
  sampleRate: number,
  thresholdDb: number,
  minSilenceMs: number
): SampleSpan[] {
  const length = channels[0]?.length ?? 0;
  if (length === 0) return [];
  const threshold = Math.pow(10, thresholdDb / 20);
  const minRunSamples = Math.max(1, Math.round((minSilenceMs / 1000) * sampleRate));
  const env = envelopeFollower(maxAcrossChannels(channels), sampleRate, DETECT_ATTACK_MS, DETECT_RELEASE_MS);
  return findRunsBelow(env, threshold, minRunSamples);
}

export type SilenceMode = 'shorten' | 'remove';

export interface SilenceCutOptions {
  mode: SilenceMode;
  /** Silence kept untouched at EACH end of every processed gap, samples. */
  padSamples: number;
  /** Shorten mode: the length every processed gap is reduced to, samples. */
  targetSamples: number;
  /** Splice blend length, samples (`SPLICE_XFADE_MS` at the caller's rate). */
  xfadeSamples: number;
}

/**
 * One planned gap cut. All positions are input-domain samples. The output
 * keeps `[run.start, fadeOutStart)` verbatim, then blends `xfade` samples of
 * `[fadeOutStart, fadeOutStart+xfade)` (gap head, fading out) against
 * `[fadeInStart, fadeInStart+xfade)` (gap tail, fading in), then resumes
 * verbatim at `removed.end` (=== fadeInStart + xfade). `removed` is the exact
 * span of input samples with NO output position — its length is the length
 * the document shrinks by at this cut.
 */
export interface SilenceCut {
  fadeOutStart: number;
  fadeInStart: number;
  xfade: number;
  removed: SampleSpan;
}

/**
 * Stage 2: plan the cuts. Per qualifying run the kept silence is
 *
 *     keptLen = 2*padSamples + xfade              (remove mode)
 *     keptLen = max(targetSamples, 2*padSamples + xfade)   (shorten mode)
 *
 * so the padding is a hard floor in BOTH modes (`2*pad + xfade` keeps a full
 * untouched pad on each side of the blend), and shorten's target is the
 * requested total. Runs not strictly longer than `keptLen` are skipped —
 * there is nothing to remove, and a zero-length removal would re-blend
 * silence onto itself for no benefit. The kept, non-blend silence is split
 * head/tail as evenly as possible (head = floor, tail gets the odd sample):
 * head preserves the breath/decay tail after the last word, tail preserves
 * the run-up to the next onset, and neither claim outranks the other.
 */
export function planSilenceCuts(runs: SampleSpan[], opts: SilenceCutOptions): SilenceCut[] {
  const xfade = Math.max(1, opts.xfadeSamples);
  const padded = 2 * opts.padSamples + xfade;
  const keptLen = opts.mode === 'remove' ? padded : Math.max(opts.targetSamples, padded);
  const cuts: SilenceCut[] = [];
  for (const run of runs) {
    if (run.end - run.start <= keptLen) continue;
    const head = Math.floor((keptLen - xfade) / 2);
    const tail = keptLen - xfade - head;
    cuts.push({
      fadeOutStart: run.start + head,
      fadeInStart: run.end - tail - xfade,
      xfade,
      removed: { start: run.start + head + xfade, end: run.end - tail },
    });
  }
  return cuts;
}

/**
 * Stage 3: assemble the output. Every segment outside a blend is copied
 * verbatim (byte-identical — zero cuts returns exact copies of the input,
 * which is the ruling-4 no-op pass-through), and every cut is joined through
 * `crossfadeGains(t, 0, 'equal-power')` — the level-preserving law for
 * uncorrelated material. At t=0 the blend equals the gap-head sample exactly
 * (gains 1/0) and at t=1 it equals the gap-tail sample to within one
 * `cos(pi/2)` residue (~1e-16 of the head sample), so both blend boundaries
 * are sample-continuous with their neighbours. The singleton convention
 * (xfade === 1 blends at t = 0.5) mirrors mixdown.ts's `w > 1 ? i/(w-1) : 0.5`.
 *
 * `cuts` must be sorted ascending and non-overlapping with all positions
 * inside the buffer — which `planSilenceCuts` over `findRunsBelow` runs
 * guarantees by construction. Never mutates `channels`.
 */
export function spliceCuts(channels: Float32Array[], cuts: SilenceCut[]): Float32Array[] {
  const length = channels[0]?.length ?? 0;
  let removedTotal = 0;
  for (const cut of cuts) removedTotal += cut.removed.end - cut.removed.start;
  return channels.map((input) => {
    const out = new Float32Array(length - removedTotal);
    let readPos = 0;
    let writePos = 0;
    for (const cut of cuts) {
      out.set(input.subarray(readPos, cut.fadeOutStart), writePos);
      writePos += cut.fadeOutStart - readPos;
      for (let i = 0; i < cut.xfade; i++) {
        const t = cut.xfade > 1 ? i / (cut.xfade - 1) : 0.5;
        const { gOut, gIn } = crossfadeGains(t, SPLICE_RHO, 'equal-power');
        out[writePos + i] = gOut * input[cut.fadeOutStart + i] + gIn * input[cut.fadeInStart + i];
      }
      writePos += cut.xfade;
      readPos = cut.removed.end;
    }
    out.set(input.subarray(readPos), writePos);
    return out;
  });
}
