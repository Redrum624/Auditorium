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
 * `remixRender.ts:210-219` carries the only measurement this app has anywhere
 * near this question: ~10 ms is where a fade-out becomes audible as a level
 * change. That is where audibility BEGINS — 10 ms is the first length that
 * reads as a level change, not the last one that does not — so this constant
 * sits exactly AT that bound rather than short of it, and that is a deliberate
 * trade worth naming rather than a number to hide behind. What it buys: the
 * step being removed here is full-scale, and speech cut mid-syllable is a
 * harder edge than the tail overflow `remixRender` tapers, so the 2 ms that
 * costs nothing musically there is still a perceptible edge here. What it
 * costs: a level taper as long as 10 ms at each end of every turn. The dialog's
 * own copy (D5) states that cost to the user — the speaker tracks "carry that
 * speaker's turns with short fades at each edge, so they do not add back sample
 * for sample" — and no claim is made anywhere that these edges cannot be heard.
 * Moving the number in either direction needs a new measurement, not an edit
 * here.
 *
 * It gets its own constant instead of borrowing `MIN_TAIL_FADE_MS` or
 * `EXACT_TRIM_FADE_MS` because it answers a different question — those two
 * taper material into ADJACENT material, this one takes speech to silence —
 * and one shared number would tie three unrelated decisions together.
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
 * for the measurement it is set against (`remixRender.ts:210-219`); it is a
 * boundary value, not a taste setting.
 */
export const SPEAKER_EDGE_FADE_MS = 10;

/**
 * D4 — the shortest compressed ramp that is still a RAMP, in samples.
 *
 * `fades.ts`' `equal-gain` ramp of `n` samples takes the gains `i / (n - 1)`,
 * so it reaches full scale at its LAST sample. `n = 1` is the `singletonGain`
 * alone (0 here), and `n = 2` is `[0, 1]` — an unattenuated sample sitting
 * directly against the silence, which is the full-scale step this module exists
 * to remove, not a fade. Three is the first length with a value in between
 * (`[0, 0.5, 1]`), so it is the shortest ramp whose worst per-sample step (0.5)
 * is below that.
 *
 * A kept span consequently needs `2 ×` this to carry two of them; D4's
 * `floor(span / 2)` rule holds from there up, and anything shorter is taken to
 * silence rather than left standing at unity between two zeros (see
 * {@link keepSpans}). That floor is 6 samples — 136 µs at 44.1 kHz, against the
 * 0.3 s `MIN_ON_S` D3 gives the assembler, so a real turn is ~2,200× too long
 * to reach it and only a segment clamped against the end of the document can.
 */
export const MIN_EDGE_RAMP_SAMPLES = 3;

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
 * step the fades exist to remove.
 *
 * That compression has a FLOOR, and below it the span is dropped to silence
 * entirely. `floor(span / 2)` under {@link MIN_EDGE_RAMP_SAMPLES} is not a
 * shorter fade, it is no fade: at 1 sample the ramp is `singletonGain` (0) and
 * at 2 it is `[0, 1]`, so a span of 3 to 5 samples would come out as unity
 * samples wedged between zeros — the loudest click of all, and precisely the
 * discontinuity D4 forbids. Spans of fewer than `2 × MIN_EDGE_RAMP_SAMPLES`
 * samples are therefore left as the zeros the output was allocated with, which
 * is what a 1- and a 2-sample span already amounted to. Nothing audible is lost:
 * the floor is 136 µs at 44.1 kHz (see the constant), far below any turn the
 * assembler can emit.
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
    const span = endSample - startSample;
    // Below two whole ramps there is no fade to compress, so the span stays
    // silent — the zeros `out` already holds. Copying it first and then trying
    // to shape it is what leaves the full-scale step (see the docblock).
    if (span < 2 * MIN_EDGE_RAMP_SAMPLES) continue;

    for (let c = 0; c < channels.length; c++) {
      out[c].set(channels[c].subarray(startSample, endSample), startSample);
    }
    // `floor` needs no `Math.max` guard: the floor above guarantees >= 3.
    const ramp = span >= 2 * fadeLen ? fadeLen : Math.floor(span / 2);
    applyFadeInStartingAt(out, startSample, ramp, 'equal-gain', 0);
    applyFadeOutEndingAt(out, endSample, ramp, 'equal-gain', 0);
  }
  return out;
}
