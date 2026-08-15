/**
 * Replace one word with a fresh take of it, and make the joins hold (F6).
 *
 * Pure numeric DSP: no DOM, no Electron, no `AudioContext`. Everything here
 * operates on `Float32Array[]` and returns a REGION the caller writes back with
 * `replaceRegion`; nothing in this module touches a document, an undo entry or
 * a worker.
 *
 * ## The geometry, and why it is not the obvious one
 *
 * The obvious splice writes the replacement over `[start, end)` and crossfades
 * at those two boundaries. That is wrong, and F3 shipped exactly that mistake
 * once and found it only by measuring against an unchunked reference: both
 * sides of each crossfade then sit INSIDE the material being replaced, so the
 * first and last few milliseconds of the word the user wanted GONE are still
 * audible, mixed under the new one.
 *
 * This module crossfades OUTSIDE the word instead. The replacement is fitted to
 * `[start - seam, end + seam)`; the head seam blends the audio BEFORE the word
 * with the replacement's lead-in, the tail seam blends the replacement's
 * trail-out with the audio AFTER the word, and `[start, end)` — the whole of
 * the word — is 100 % replacement. Nothing of the original word survives
 * anywhere, which is a property a test can assert exactly rather than judge.
 *
 * ## What is matched, and where each rule comes from
 *
 * - **Seam length** — `SPLICE_XFADE_MS` (10 ms), the app's own splice blend,
 *   whose two anchors are already argued in `silenceDetect.ts`: 2 ms is the
 *   floor below which a fade stops killing the click, ~10 ms is where a
 *   fade-out becomes audible as a level change. Capped by the measured gap to
 *   the neighbouring words so the blend eats silence rather than a neighbour,
 *   and floored at `MIN_SEAM_MS` because a click is worse than 2 ms of overlap.
 * - **Correlation** — a deliberate `rho = 0`, following `silenceDetect.ts`'s
 *   `SPLICE_RHO`. The two sides are two different performances; a zero-lag
 *   correlation between them carries no information, and `fades.ts`'s contract
 *   is explicit that a caller without a real measurement passes 0 rather than
 *   inventing an estimate.
 * - **DC** — the replacement's own per-channel mean is removed, so the two
 *   sides meet at the same baseline whatever the two recordings' offsets were.
 * - **Level** — the fitted replacement is scaled so its RMS over the word span
 *   equals the RMS of the audio it replaces. That is what "matched to the
 *   neighbours" can mean without a loudness target nobody measured.
 * - **Pitch** — the median voiced f0 of both sides is measured with F1's YIN
 *   detector and the replacement is shifted by the difference, as a constant
 *   ratio. Not a contour match: a per-frame contour transplant would impose the
 *   original word's melody on a different performance's phonetics, and the
 *   thing being replaced is usually a word the singer got WRONG, whose contour
 *   is not the one to copy. Reported in semitones so the user can see it.
 * - **Length** — the replacement is time-fitted to the target span with WSOLA,
 *   so the splice changes no sample position outside the region and a backing
 *   track still lines up.
 */

import { crossfadeGains, type FadeCurve } from './fades';
import { detectPitch } from './pitchDetect';
import { envelopeFollower, maxAcrossChannels } from './envelope';
import { measureNoiseWindow } from './chainAnalysis';
import { SILENCE_RMS } from './pitchDetect';
import { DETECT_ATTACK_MS, DETECT_RELEASE_MS, SPLICE_XFADE_MS } from './silenceDetect';
import { resampleChannel } from './resample';
import { MAX_RATIO, MIN_RATIO, timeStretchLinked } from './wsola';

/**
 * Floor for the seam, in ms — `remixRender.ts`'s `MIN_TAIL_FADE_MS`, restated
 * here because it is used for the same reason: below about 2 ms a fade stops
 * removing the click it exists to remove. When the measured gap to a
 * neighbouring word is shorter than this, the seam takes the 2 ms anyway and
 * overlaps the neighbour by the difference. That is a deliberate trade: 2 ms of
 * overlap is under the ~10 ms where a level change becomes audible, and a click
 * is not.
 */
export const MIN_SEAM_MS = 2;

/** The correlation handed to `crossfadeGains` — see the module header. */
const SPLICE_RHO = 0;

export interface WordSpliceRequest {
  /** The document's channels. Read only; never mutated. */
  target: readonly Float32Array[];
  /** The word's span in target samples, from the alignment. */
  startSample: number;
  endSample: number;
  /** The fresh recording. Mono is fanned out to the target's channel count. */
  replacement: readonly Float32Array[];
  sampleRate: number;
  /** Seam length in samples — see {@link deriveSeamSamples}. */
  seamSamples: number;
  /** Crossfade curve. Defaults to `equal-power`, the safe default for two
   * different pieces of material (`fades.ts`). */
  curve?: FadeCurve;
  /** Match the replacement's median f0 to the replaced word's. Default true. */
  matchPitch?: boolean;
}

export interface WordSpliceReport {
  /** Region the caller must write back, in target samples. */
  regionStart: number;
  regionEnd: number;
  /** Samples of the replacement kept after silence trimming. */
  trimmedSamples: number;
  /** True when no trim was attempted and the whole recording is used, because
   * the recording offered no threshold to trim against — see
   * {@link trimSilence}. */
  trimSkipped: boolean;
  /** Net WSOLA ratio applied to reach the target length, after any pitch
   * shift. 1 means the fitted length already matched. */
  stretchRatio: number;
  /** Median voiced f0 of the replaced word, or null when it was unvoiced. */
  originalF0Hz: number | null;
  /** Median voiced f0 of the trimmed replacement, or null. */
  replacementF0Hz: number | null;
  /** Semitones applied. 0 when either side is unvoiced or matching is off. */
  pitchShiftSemitones: number;
  /** Level correction applied to the replacement, in dB. */
  gainDb: number;
  /** Per-channel DC removed from the replacement. */
  dcRemoved: number[];
  /** Seam actually used at the head and the tail — they differ when the word
   * sits against the start or end of the document. */
  headSeamSamples: number;
  tailSeamSamples: number;
}

export type WordSpliceFailure =
  | { ok: false; reason: 'empty-span'; message: string }
  | { ok: false; reason: 'empty-replacement'; message: string }
  | { ok: false; reason: 'silent-replacement'; message: string }
  | { ok: false; reason: 'channel-mismatch'; message: string }
  | { ok: false; reason: 'unfittable'; message: string };

export type WordSpliceResult =
  | { ok: true; channels: Float32Array[]; report: WordSpliceReport }
  | WordSpliceFailure;

/**
 * Seam length for a word whose nearest neighbours leave `gapBefore` /
 * `gapAfter` samples of room. Both gaps are clamped at 0 by the caller when
 * the word touches another; the result is the app's 10 ms blend, shortened to
 * the smaller gap and never below {@link MIN_SEAM_MS}.
 */
export function deriveSeamSamples(sampleRate: number, gapBefore: number, gapAfter: number): number {
  const preferred = Math.round((SPLICE_XFADE_MS / 1000) * sampleRate);
  const floor = Math.max(1, Math.round((MIN_SEAM_MS / 1000) * sampleRate));
  const available = Math.min(gapBefore, gapAfter);
  return Math.max(floor, Math.min(preferred, available));
}

/** Median of the voiced frames of a YIN track, or null when none is voiced. */
function medianVoicedF0(signal: Float32Array, sampleRate: number): number | null {
  if (signal.length === 0) return null;
  const track = detectPitch(signal, sampleRate);
  const voiced = track.frames
    .map((f) => f.f0Hz)
    .filter((f): f is number => f !== null && f > 0)
    .sort((a, b) => a - b);
  if (voiced.length === 0) return null;
  return voiced.length % 2 === 1
    ? voiced[(voiced.length - 1) / 2]
    : (voiced[voiced.length / 2 - 1] + voiced[voiced.length / 2]) / 2;
}

function rms(channels: readonly Float32Array[], start: number, end: number): number {
  let sum = 0;
  let count = 0;
  for (const c of channels) {
    const lo = Math.max(0, start);
    const hi = Math.min(c.length, end);
    for (let i = lo; i < hi; i++) {
      sum += c[i] * c[i];
      count++;
    }
  }
  return count === 0 ? 0 : Math.sqrt(sum / count);
}

/**
 * Trims leading and trailing silence off the replacement.
 *
 * The threshold is Remove Silence's own derivation, not a new number: the
 * loudest the silence detector ever reads inside the recording's quietest
 * `NOISE_WINDOW_MS`, i.e. the level below which nothing in this recording
 * actually sits. A recording too short for that window is left alone and says
 * so, because a threshold guessed for it would decide what to cut with no
 * measurement behind it.
 *
 * ## Why a RUN above the threshold, and not the first sample above it
 *
 * That threshold is the peak of the quietest 500 ms, and a recording is longer
 * than 500 ms — so the same floor, measured over the whole file, exceeds it by
 * an extreme-value hair at a handful of isolated samples. Measured on this
 * module's own fixture: 1.5 s of stationary room tone puts **6 samples out of
 * 66 150** above the threshold, each of them a run exactly **1** sample long.
 * A scan for the first sample above the threshold therefore stops on the first
 * of those, and the trim removes 8 305 samples of a 26 460-sample lead-in
 * instead of all of it. Remove Silence never sees this because it only accepts
 * runs of at least `minSilenceMs`; a leading/trailing trim has to earn the same
 * robustness for itself.
 *
 * The bar is `DETECT_RELEASE_MS` worth of consecutive samples above the
 * threshold, and it is not a chosen number — it is the follower's own release
 * constant, restated. For the case the bar exists to reject — an INSTANTANEOUS
 * excursion, which is what an extreme-value blip in stationary noise is — the
 * run is pure release decay, `env[n] = env[0] * exp(-n / (release *
 * sampleRate))`, so a run of exactly `release * sampleRate` samples means the
 * excursion peaked exactly `e` times the threshold. One time constant IS one
 * neper IS 8.686 dB, so for a blip the bar reads "clear this recording's own
 * floor peak by 8.686 dB". Sound that LASTS clears the bar on duration alone
 * and needs no headroom at all, which is the right asymmetry: the rule costs a
 * real word nothing and costs a blip everything. Both readings come out of a
 * constant `silenceDetect.ts` already derives, and neither is chosen here.
 *
 * The same fixture measures 0.4 s of tone as a single run of **26 214** samples
 * against pure room tone's **1** — four orders of magnitude of separation, so
 * neither case sits anywhere near the bar.
 *
 * The kept span runs from the FIRST qualifying run's start to the LAST one's
 * end, so an internal stop consonant does not cut a word in half. The tail
 * therefore carries the detector's release overhang past the true offset —
 * exactly the cost `silenceDetect.ts` documents for the same follower, and it
 * errs toward keeping sound, never toward clipping it.
 *
 * ## Why the threshold is a LADDER, and not that one number
 *
 * The threshold above is the peak of the quietest 500 ms `measureNoiseWindow`
 * hands back — and that window is the recording's FLOOR only when the recording
 * HAS one above digital silence. Three recordings break that, and all three
 * were measured rather than imagined:
 *
 * - **The pauses are literal zeros.** `measureNoiseWindow` rejects every window
 *   at or below `SILENCE_RMS` — it must, because an all-zero noise print makes
 *   Noise Reduction a silent no-op — so it returns the quietest window it could
 *   find CONTAINING THE SOUND, and the derived threshold becomes the sound's
 *   own envelope peak. Measured on what the packaged smoke records, Chromium's
 *   fake capture device: 20 ms full-scale beeps 500 ms apart over literal
 *   zeros, threshold **0.973**, and the longest of the 8 runs above it **14
 *   samples** against a bar of 960. A take carrying two FULL-SCALE beeps was
 *   refused as silent.
 * - **There is no pause at all** — a word punched in tight, with no room tone
 *   either side. The quietest 500 ms is then as loud as everything else and
 *   nothing clears it: measured on 1.52 s of stationary tone, **0 samples of
 *   72 960** rose above the threshold.
 *
 * - **The zeros sit beside an UNEVEN floor**, which is a fresh mic take's
 *   ordinary shape: a preamp or an AGC settles over the first second, so the
 *   top of the take is a stretch of floor above the steady one. Candidate
 *   windows start on 50 ms boundaries and a trimmed head does not, so a
 *   candidate can be almost all zeros with a sliver of that louder stretch in
 *   it — diluted BELOW the take's own steady floor, therefore the winner, and
 *   its envelope peak is the louder stretch's. The rung comes out ~12 dB high.
 *   The word's loud core still clears it, so this one does not decline: it
 *   shaves. Measured on a take with a 1.43 s zero head, a -62 dBFS settling
 *   stretch and a -74 dBFS steady floor, the trim kept **19 449** samples of a
 *   26 019-sample word — the vowel and its release overhang, with the
 *   aspirated onset and release deleted. The FIX is upstream of the ladder:
 *   rung 1 asks `measureNoiseWindow` for the mostly-real search, the same one
 *   `deriveGate` and `deriveRemoveSilence` ask for and for the same reason —
 *   this threshold decides what is removed. Asking is a NO-OP when the bare
 *   search's winner is already mostly real: pinned head to head, both searches
 *   returning the same window and the same envelope peak on a take that still
 *   carries 1.45 s of device zeros, trimming to the same sample count as the
 *   same recording without them ("trims a take whose bare winner is ALREADY
 *   real…"). Zeros do not make this stage keep more; a diluted WINNER does.
 *
 * The first two are one mistake: a SELF-RELATIVE threshold cannot tell
 * "uniformly loud" from "uniformly silent", and it refuses the wrong one. So
 * the threshold is a two-rung ladder — the recording's own floor when it has
 * one, and digital silence itself when that finds nothing. A recording with no
 * mostly-real window at all offers no floor to read, so rung 1 is DROPPED
 * rather than derived from a sliver, and the ladder starts at rung 2 — which
 * keeps strictly more material, never less. `SILENCE_RMS` is not a new number
 * either: it is the same 2^-15 that `measureNoiseWindow` already rejects
 * windows at and that `pitchDetect` already gates frames on, restated — one LSB
 * of 16-bit PCM, the level below which the most common source format cannot
 * carry anything at all. On the fake-device take the second rung returns the
 * beeps and nothing else; on the tight punch-in it returns the whole recording,
 * which is the right answer for a recording with no silence in it.
 *
 * Nothing above EITHER rung means this recording offers no threshold to trim
 * against, so the trim declines and says so — the same answer, for the same
 * reason, as a recording too short to measure. Whether the recording is SILENT
 * is a different question, and {@link spliceWord} answers it against an
 * absolute floor rather than this one.
 */
function trimSilence(
  channels: readonly Float32Array[],
  sampleRate: number
): { start: number; end: number; skipped: boolean } {
  const length = channels[0]?.length ?? 0;
  // The bare search is consulted for ONE thing only — whether this recording is
  // long enough to have a 500 ms window at all, which is the condition the trim
  // declines on and the only reason this call still exists.
  const measurable = measureNoiseWindow(channels as Float32Array[], sampleRate);
  if (measurable) {
    // Rung 1 asks for the MOSTLY-REAL search. A candidate window that is mostly
    // exact zeros has its RMS diluted by them while taking its envelope peak
    // from the sliver of real material at its edge, so on a take carrying
    // device-written zeros the bare search can win with a window that measures
    // the wrong passage — and here that is the destructive direction, because
    // this threshold decides what is DELETED before the splice.
    const real = measureNoiseWindow(channels as Float32Array[], sampleRate, { rejectMostlySilentWindows: true });
    const env = envelopeFollower(maxAcrossChannels(channels as Float32Array[]), sampleRate, DETECT_ATTACK_MS, DETECT_RELEASE_MS);
    const minRun = Math.max(1, Math.round((DETECT_RELEASE_MS / 1000) * sampleRate));
    // No mostly-real window means the recording has no floor to offer, so the
    // rung is DROPPED rather than guessed at and the ladder falls through to
    // digital silence — which keeps strictly more, never less.
    const thresholds = real ? [Math.pow(10, real.envelopePeakDb / 20), SILENCE_RMS] : [SILENCE_RMS];
    for (const threshold of thresholds) {
      const span = firstToLastRun(env, threshold, minRun);
      if (span) return { start: span.start, end: span.end, skipped: false };
    }
  }
  return { start: 0, end: length, skipped: true };
}

/**
 * Start of the first run of more than `minRun` consecutive samples above
 * `threshold` to the end of the last, or null when no run is that long.
 *
 * `> threshold` is sound and `<= threshold` is floor, the convention
 * `findRunsBelow` uses; the `i === env.length` pass closes a run that reaches
 * the end of the buffer.
 */
function firstToLastRun(
  env: Float32Array,
  threshold: number,
  minRun: number
): { start: number; end: number } | null {
  let start = -1;
  let end = -1;
  let runStart = -1;
  for (let i = 0; i <= env.length; i++) {
    if (i < env.length && env[i] > threshold) {
      if (runStart < 0) runStart = i;
      continue;
    }
    if (runStart >= 0) {
      if (i - runStart >= minRun) {
        if (start < 0) start = runStart;
        end = i;
      }
      runStart = -1;
    }
  }
  return start < 0 ? null : { start, end };
}

/**
 * Fits a fresh recording of one word into the span the aligner found for it.
 *
 * Returns the REGION `[regionStart, regionEnd)` rewritten — the same length it
 * was, so nothing downstream moves — or a refusal naming what it could not do.
 */
export function spliceWord(request: WordSpliceRequest): WordSpliceResult {
  const {
    target,
    startSample,
    endSample,
    replacement,
    sampleRate,
    seamSamples,
    curve = 'equal-power',
    matchPitch = true,
  } = request;

  const docLength = target[0]?.length ?? 0;
  if (endSample <= startSample || startSample < 0 || endSample > docLength) {
    return {
      ok: false,
      reason: 'empty-span',
      message: `The word span [${startSample}, ${endSample}) is not inside the ${docLength}-sample document.`,
    };
  }
  if ((replacement[0]?.length ?? 0) === 0) {
    return { ok: false, reason: 'empty-replacement', message: 'The replacement recording is empty.' };
  }
  if (replacement.length !== target.length && replacement.length !== 1) {
    return {
      ok: false,
      reason: 'channel-mismatch',
      message: `The replacement has ${replacement.length} channels and the document has ${target.length}.`,
    };
  }
  // "Silent" judged against an ABSOLUTE floor, not the recording's own. The
  // recording's own floor says nothing about whether anything was recorded —
  // it is by construction the level the recording sits at — so a threshold
  // derived from it calls a uniformly LOUD take silent (see `trimSilence`).
  // `SILENCE_RMS` is the same 2^-15 `measureNoiseWindow` accepts a window
  // strictly above and `pitchDetect` gates a frame strictly below: one LSB of
  // 16-bit PCM. At or under it there is nothing here a 16-bit file could have
  // carried, which is what a muted or unplugged microphone produces.
  if (rms(replacement, 0, replacement[0].length) <= SILENCE_RMS) {
    return {
      ok: false,
      reason: 'silent-replacement',
      message: 'Nothing in the replacement recording rises above digital silence.',
    };
  }

  // ── geometry ────────────────────────────────────────────────────────────
  const seam = Math.max(0, Math.round(seamSamples));
  const regionStart = Math.max(0, startSample - seam);
  const regionEnd = Math.min(docLength, endSample + seam);
  const headSeam = startSample - regionStart;
  const tailSeam = regionEnd - endSample;
  const regionLength = regionEnd - regionStart;

  // ── trim ────────────────────────────────────────────────────────────────
  // Always a non-empty span: a qualifying run is at least `minRun` long, and
  // the declining path returns the whole recording, which the empty-replacement
  // check above has already established is not empty.
  const trim = trimSilence(replacement, sampleRate);
  const trimmedLength = trim.end - trim.start;
  // Fan mono out to the target's channel count, and remove the recording's own
  // DC while copying — one pass, and the copy is needed anyway because
  // everything after this mutates.
  const trimmed: Float32Array[] = [];
  const dcRemoved: number[] = [];
  for (let c = 0; c < target.length; c++) {
    const source = replacement[replacement.length === 1 ? 0 : c];
    let mean = 0;
    for (let i = trim.start; i < trim.end; i++) mean += source[i];
    mean /= trimmedLength;
    const out = new Float32Array(trimmedLength);
    for (let i = 0; i < trimmedLength; i++) out[i] = source[trim.start + i] - mean;
    trimmed.push(out);
    dcRemoved.push(mean);
  }

  // ── pitch ───────────────────────────────────────────────────────────────
  const originalMono = mixToMono(target, startSample, endSample);
  const replacementMono = mixToMono(trimmed, 0, trimmedLength);
  const originalF0Hz = medianVoicedF0(originalMono, sampleRate);
  const replacementF0Hz = medianVoicedF0(replacementMono, sampleRate);
  let pitchRatio = 1;
  if (matchPitch && originalF0Hz !== null && replacementF0Hz !== null && replacementF0Hz > 0) {
    pitchRatio = originalF0Hz / replacementF0Hz;
  }
  const pitchShiftSemitones = 12 * Math.log2(pitchRatio);

  // A constant pitch shift is a resample followed by a time-fit: resampling to
  // `sampleRate / ratio` multiplies the pitch by `ratio` and divides the length
  // by it, and the WSOLA fit below puts the length back. Doing the two in this
  // order means ONE stretch rather than two.
  let shifted = trimmed;
  if (pitchRatio !== 1) {
    shifted = trimmed.map((c) => resampleChannel(c, sampleRate, sampleRate / pitchRatio));
  }
  const shiftedLength = shifted[0].length;
  if (shiftedLength === 0) {
    return {
      ok: false,
      reason: 'silent-replacement',
      message: 'The replacement recording vanished when its pitch was matched — it is too short to shift.',
    };
  }

  // ── time fit ────────────────────────────────────────────────────────────
  const stretchRatio = regionLength / shiftedLength;
  if (stretchRatio < MIN_RATIO || stretchRatio > MAX_RATIO) {
    const kept = (trimmedLength / sampleRate).toFixed(2);
    const wanted = (regionLength / sampleRate).toFixed(2);
    return {
      ok: false,
      reason: 'unfittable',
      message: `The replacement is ${kept} s of sound and the word is ${wanted} s long — outside the ${MIN_RATIO}x to ${MAX_RATIO}x the time-fit can cover without audible artefacts. Re-record it closer to the original length.`,
    };
  }
  const fitted = timeStretchLinked(shifted, sampleRate, stretchRatio);
  // WSOLA returns `round(N * ratio)`, which is the region length by
  // construction — but the region is written sample for sample below, so a
  // one-sample rounding difference would silently truncate or leave a hole.
  const body = fitted.map((c) => {
    if (c.length === regionLength) return c;
    const exact = new Float32Array(regionLength);
    exact.set(c.subarray(0, Math.min(c.length, regionLength)));
    return exact;
  });

  // ── level ───────────────────────────────────────────────────────────────
  const targetRms = rms(target, startSample, endSample);
  const bodyRms = rms(body, headSeam, headSeam + (endSample - startSample));
  const gain = bodyRms > 0 && targetRms > 0 ? targetRms / bodyRms : 1;
  if (gain !== 1) {
    for (const c of body) {
      for (let i = 0; i < c.length; i++) c[i] *= gain;
    }
  }

  // ── seams ───────────────────────────────────────────────────────────────
  const channels = body.map((c) => Float32Array.from(c));
  for (let i = 0; i < headSeam; i++) {
    // t runs 0 -> 1 across the seam: the ORIGINAL is the outgoing side and the
    // replacement is the incoming one. `headSeam - 1` in the denominator so the
    // ramp reaches its endpoints; a one-sample seam takes t = 0, where the
    // original is still whole — the word itself starts at `headSeam`.
    const t = headSeam > 1 ? i / (headSeam - 1) : 0;
    const { gOut, gIn } = crossfadeGains(t, SPLICE_RHO, curve);
    for (let c = 0; c < channels.length; c++) {
      channels[c][i] = target[c][regionStart + i] * gOut + channels[c][i] * gIn;
    }
  }
  for (let i = 0; i < tailSeam; i++) {
    // Mirror image: the replacement is now the outgoing side.
    const t = tailSeam > 1 ? i / (tailSeam - 1) : 1;
    const { gOut, gIn } = crossfadeGains(t, SPLICE_RHO, curve);
    const at = regionLength - tailSeam + i;
    for (let c = 0; c < channels.length; c++) {
      channels[c][at] = channels[c][at] * gOut + target[c][regionStart + at] * gIn;
    }
  }

  return {
    ok: true,
    channels,
    report: {
      regionStart,
      regionEnd,
      trimmedSamples: trimmedLength,
      trimSkipped: trim.skipped,
      stretchRatio,
      originalF0Hz,
      replacementF0Hz,
      pitchShiftSemitones,
      gainDb: 20 * Math.log10(gain),
      dcRemoved,
      headSeamSamples: headSeam,
      tailSeamSamples: tailSeam,
    },
  };
}

function mixToMono(channels: readonly Float32Array[], start: number, end: number): Float32Array {
  const length = Math.max(0, end - start);
  const out = new Float32Array(length);
  if (channels.length === 0) return out;
  for (const c of channels) {
    for (let i = 0; i < length; i++) out[i] += c[start + i];
  }
  if (channels.length > 1) {
    for (let i = 0; i < length; i++) out[i] /= channels.length;
  }
  return out;
}
