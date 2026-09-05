/**
 * D4 — the span keeper behind the per-speaker landing (Separate Speakers).
 *
 * `landSpeakers` gives every speaker a document that is the FULL Vocals stem
 * with everything outside that speaker's turns taken to silence. That is this
 * module's whole job, and it is deliberately a DSP primitive rather than a
 * private helper of the landing: masking a signal down to a set of half-open
 * spans is audio arithmetic, it is where the click lives, and it is testable
 * without a store, a document or a session.
 *
 * ---------------------------------------------------------------------------
 * WHY A FADE AT ALL, AND WHY 10 ms
 * ---------------------------------------------------------------------------
 * A speaker's turn starts and ends in the MIDDLE of a waveform — the diarizer's
 * boundary is a speech boundary, not a zero crossing — so writing the samples
 * straight into silence puts a full-amplitude step at both ends of every turn,
 * which is a click, once per turn, on every speaker track.
 *
 * `remixRender.ts:207-219` states this app's measured bound for the other
 * direction: a fade-out becomes audible AS A LEVEL CHANGE at around 10 ms, and
 * its own tail taper is floored at 2 ms precisely to stay under it. 10 ms is
 * therefore the LONGEST ramp that does not start shortening the turn audibly,
 * and the longest is what a speech boundary wants: the step to remove is
 * full-scale, and a 2 ms ramp against speech that has been cut mid-syllable is
 * still a perceptible edge. It gets its own constant instead of borrowing
 * `MIN_TAIL_FADE_MS` or `EXACT_TRIM_FADE_MS` because it answers a different
 * question — those two taper material into ADJACENT material, this one takes
 * speech to silence — and one shared number would tie three unrelated
 * decisions together.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE OUTPUT IS NOT
 * ---------------------------------------------------------------------------
 * The speaker documents this feeds do NOT add back up to the Vocals stem sample
 * for sample: the ramps remove a little audio at every edge, and a region where
 * two speakers overlap is carried by BOTH of them. That is stated in D4 and in
 * the dialog's own copy; nothing here claims otherwise, and no exact-sum test
 * is written against it.
 */
import { applyFadeInStartingAt, applyFadeOutEndingAt } from './fades';

/**
 * A half-open `[startSample, endSample)` region in DOCUMENT samples — the shape
 * `segmentsToDocSamples` hands over, one array per speaker.
 */
export interface SampleSpan {
  startSample: number;
  endSample: number;
}

/**
 * D4 — the edge fade for a kept span, in milliseconds. See the module header
 * for the measurement it is set against (`remixRender.ts:207-219`); it is a
 * boundary value, not a taste setting.
 */
export const SPEAKER_EDGE_FADE_MS = 10;

/** {@link SPEAKER_EDGE_FADE_MS} in samples at `sampleRate`: 441 at 44.1 kHz,
 * 480 at 48 kHz. Rounded, not truncated — the ramp is a duration, and the
 * nearest whole sample is the honest reading of it. */
function edgeFadeSamples(sampleRate: number): number {
  return Math.round((SPEAKER_EDGE_FADE_MS / 1000) * sampleRate);
}

/**
 * The spans actually kept: clamped into `[0, length]`, empty and reversed ones
 * dropped, sorted, and OVERLAPPING OR TOUCHING ones merged into one.
 *
 * The merge is not tidying. A speaker's segments arrive from the assembler as
 * separate turns that can abut or overlap (`min_duration_off` merges gaps below
 * 0.5 s, but two segments that share a sample still arrive as two), and fading
 * each one on its own would put a dip to silence and back INSIDE continuous
 * speech — audible where the click this module removes is not. Merging first
 * means a ramp only ever appears where the kept audio genuinely meets silence.
 *
 * Ends are rounded rather than floored/ceiled: callers hand over whole samples
 * (`segmentsToDocSamples` rounds), and rounding keeps a stray fractional value
 * from throwing inside `TypedArray.set` while changing the span by at most half
 * a sample.
 */
function mergeSpans(spans: readonly SampleSpan[], length: number): SampleSpan[] {
  const clamp = (v: number): number => Math.max(0, Math.min(length, Math.round(v)));
  const kept = spans
    .map((s) => ({ startSample: clamp(s.startSample), endSample: clamp(s.endSample) }))
    .filter((s) => s.endSample > s.startSample)
    .sort((a, b) => a.startSample - b.startSample);

  const merged: SampleSpan[] = [];
  for (const span of kept) {
    const last = merged[merged.length - 1];
    // `<=`, not `<`: two spans that merely touch are one continuous region.
    if (last && span.startSample <= last.endSample) {
      if (span.endSample > last.endSample) last.endSample = span.endSample;
    } else {
      merged.push({ ...span });
    }
  }
  return merged;
}

/**
 * D4 — a fresh copy of `channels` holding only `spans`: every sample outside the
 * merged spans is zero, every sample inside is the source's own value, and each
 * kept region is faded in and out over {@link SPEAKER_EDGE_FADE_MS}.
 *
 * The ramps are `fades.ts`' `equal-gain` curve with `singletonGain 0` — the
 * "must meet adjacent silence" convention that module documents (`fades.ts:76-81`),
 * which is exactly this case: the sample before a kept span and the sample after
 * it are both zero, so the ramp has to terminate AT zero rather than trail off.
 * `equal-gain` because the two sides here are the same material meeting its own
 * silence, not two independent signals being crossfaded.
 *
 * A span shorter than two full ramps gets `floor(span / 2)` per side instead —
 * both ramps compressed, meeting at unity in the middle, with NO unity exception
 * for short spans: a short turn left at full gain would reintroduce the very
 * step the fades exist to remove. The one span that cannot carry that rule is a
 * single sample, where `floor(1 / 2)` is zero: it is taken to silence (a
 * one-sample ramp evaluates to `singletonGain`, i.e. 0) rather than left
 * standing at unity between two zeros, which would be the loudest click of all.
 *
 * Inputs are never touched — the caller's Vocals stem is landed as its own
 * document elsewhere and is read-only here.
 */
export function keepSpans(
  channels: readonly Float32Array[],
  spans: readonly SampleSpan[],
  sampleRate: number
): Float32Array[] {
  const length = channels[0]?.length ?? 0;
  const out = channels.map(() => new Float32Array(length));
  if (length === 0 || out.length === 0) return out;

  const fadeLen = edgeFadeSamples(sampleRate);
  for (const { startSample, endSample } of mergeSpans(spans, length)) {
    for (let c = 0; c < channels.length; c++) {
      out[c].set(channels[c].subarray(startSample, endSample), startSample);
    }
    const span = endSample - startSample;
    const ramp = span >= 2 * fadeLen ? fadeLen : Math.max(1, Math.floor(span / 2));
    applyFadeInStartingAt(out, startSample, ramp, 'equal-gain', 0);
    applyFadeOutEndingAt(out, endSample, ramp, 'equal-gain', 0);
  }
  return out;
}
