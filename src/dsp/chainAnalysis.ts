/**
 * Task F7 — the measurements the Vocal Chain derives its settings from.
 *
 * The chain sets nothing by taste. Every parameter it chooses is a function of
 * one of the quantities measured here, taken on the actual audio that will feed
 * the stage in question. This module is where those quantities are defined; the
 * chain itself (`services/vocalChain.ts`) only maps them onto effect params.
 *
 * Pure TS, no DOM, no Electron — it runs in the renderer between worker calls
 * and could equally run inside a worker.
 */

import { envelopeFollower, maxAcrossChannels } from './envelope';
import { DETECT_ATTACK_MS, DETECT_RELEASE_MS } from './silenceDetect';
import { SILENCE_RMS } from './pitchDetect';
import { stft } from './stft';

/** Floor for every dB conversion here (-240 dBFS). Digital silence has no dB
 * value; clamping keeps `-Infinity` out of arithmetic and out of the UI. */
const DB_FLOOR = 1e-12;

export function toDb(linear: number): number {
  return 20 * Math.log10(Math.max(Math.abs(linear), DB_FLOOR));
}

/**
 * Programme RMS in dBFS: the root-mean-square over EVERY sample of EVERY
 * channel (not the RMS of a downmix, and not the RMS of the max-across-channels
 * detector — both of those answer different questions). This is the quantity
 * F8 measured its de-esser threshold offset against, so the chain's Ruling 1
 * derivation has to use exactly this definition to inherit that measurement.
 */
export function programmeRmsDb(channels: Float32Array[]): number {
  let sum = 0;
  let n = 0;
  for (const c of channels) {
    for (let i = 0; i < c.length; i++) sum += c[i] * c[i];
    n += c.length;
  }
  return toDb(Math.sqrt(sum / Math.max(1, n)));
}

/** Absolute peak sample across all channels, in dBFS. */
export function peakDb(channels: Float32Array[]): number {
  let peak = 0;
  for (const c of channels) {
    for (let i = 0; i < c.length; i++) {
      const v = Math.abs(c[i]);
      if (v > peak) peak = v;
    }
  }
  return toDb(peak);
}

/** Mean sample value per channel — the DC bias Remove DC Offset subtracts. */
export function dcOffsets(channels: Float32Array[]): number[] {
  return channels.map((c) => {
    if (c.length === 0) return 0;
    let sum = 0;
    for (let i = 0; i < c.length; i++) sum += c[i];
    return sum / c.length;
  });
}

/** Channel mean. Returns the single channel itself for mono (no copy). */
export function monoMix(channels: Float32Array[]): Float32Array {
  if (channels.length === 1) return channels[0];
  const n = channels[0]?.length ?? 0;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (const c of channels) sum += c[i];
    out[i] = sum / channels.length;
  }
  return out;
}

/**
 * The quietest passage in the material, and the two levels the chain reads off
 * it: the window's RMS (the noise floor) and the peak of the SAME detector
 * envelope Remove Silence uses (the level below which nothing in this recording
 * ever actually sits).
 *
 * WINDOW LENGTH = 500 ms, and it is not a new number: it is
 * `SilenceRemoverEffect`'s already-derived `minSilenceMs` default — this app's
 * existing definition of the shortest gap that is unambiguously a pause rather
 * than articulation. A noise estimate has to come from inside a real pause, so
 * the shortest real pause is exactly the right window.
 *
 * WINDOWS AT OR BELOW DIGITAL SILENCE ARE REJECTED (`SILENCE_RMS`, 2^-15, this
 * project's documented digital-silence floor). Measured need: the reference
 * take opens with a stretch of literal zeros, and a 500 ms search window lands
 * on it and returns -240 dBFS. An all-zero noise print makes Noise Reduction a
 * silent no-op — it would subtract nothing and report nothing — which is the
 * failure Ruling 3 forbids. Rejecting them makes the chain say "no usable quiet
 * passage" instead.
 *
 * MOSTLY-SILENT WINDOWS ARE REJECTED ONLY ON REQUEST
 * (`rejectMostlySilentWindows`, bound by `NOISE_WINDOW_MAX_SILENT_FRACTION`).
 * On a take carrying a stretch of exact zeros, the RMS reject above leaves the
 * BOUNDARY windows in the race — mostly zeros, a little real material at one
 * end — and zeros dilute an RMS, so a boundary window outbids every honest
 * window and wins the search while measuring nothing: its `rmsDb` under-reads
 * the floor by 10·log10(1 / (1 − zeroFraction)) dB, and its `envelopePeakDb` is the
 * adjacent MATERIAL's peak, because exact zeros contribute nothing to a peak.
 * Measured consequence in `deriveGate`: with 200 ms of digital silence trimmed
 * in next to a whispered verse, the boundary window's envelope peak was the
 * whisper's (-26.55 dBFS against the verse's -36.00 dBFS RMS), the derived
 * threshold landed 12.45 dB over the verse, and the gate muted 85-100 % of it.
 * When the flag is set, such windows are excluded and the search returns the
 * quietest MOSTLY-REAL window — the measurement the caller was asking for.
 * A frame counts as silent only when EVERY channel is exactly zero, so an
 * exactly polarity-cancelling stereo pair is not mistaken for silence by THIS
 * SEARCH — the gate's content checks, which mono-mix, carry their own guard
 * for that pair, because the mix of `L = -R` really is all zeros (see the
 * cancelling-mix decline in `deriveGate`).
 *
 * THE EVICTION KEEPS ACCOUNTS (`hiddenRealSamples`). Refusing mostly-silent
 * windows can hide real audio from the search entirely: when a quiet passage
 * is ITSELF mostly zeros — an 8-bit transfer whose whisper sits at its own
 * LSB, a verse strip-silenced into 150 ms fragments — every window over it is
 * refused, the search falls through to a LOUDER floor-like window, and a
 * threshold derived there sits above the hidden passage (measured before this
 * accounting existed: 100 % of such a verse muted). So, with the flag set, the
 * result also reports how many real frames live in evicted-quieter windows
 * that NO accepted candidate window covers. On the ordinary silence-beside-
 * floor shapes that number is zero — every real sample an evicted boundary
 * window contains also lies inside an accepted all-real window, which is
 * exactly why proceeding is safe there — and where it is not zero the caller
 * must not trust a threshold measured without that material (the gate
 * declines above one `TILT_FFT_SIZE` frame's worth; less than one frame of
 * the only classifier that could vouch for it is treated as debris). The
 * classify-instead-of-decline alternative was measured and rejected: a
 * spectral-tilt fit on runs this short has single-frame estimator variance —
 * an all-real FLOOR run of 1024 samples reads up to 3.9 dB, above the whisper
 * population's own minimum at 44.1 kHz (2.41 dB), so the two populations
 * INVERT at exactly the lengths that can stay hidden, and no constant exists
 * for the arm to use.
 *
 * KNOWN LIMITATION OF THE CENSUS (N6 — pre-existing: the round-4 code, and
 * the code before the eviction existed, remove the same material; parked by
 * controller ruling pending a design round). The census sees only what no
 * accepted window covers, and the acceptance bound constrains a window's
 * ZEROS, not its LEVELS — so a quiet island of up to ~375 ms (sixteen
 * `TILT_FFT_SIZE` frames: an accepted covering window needs only 75 % real
 * material, and a loud neighbour supplies it) sitting inside an accepted
 * MIXED window is invisible here. Measured at 44.1 kHz: a 200-300 ms whisper
 * island at -60 dBFS, bracketed by digital silence immediately BEFORE a loud
 * burst, reports hiddenRealSamples = 0, the gate runs at the floor's
 * threshold, and 100 % of the island is removed. The mirror island AFTER the
 * burst loses 0.0 %: `GATE_HOLD_MS` equals the window length and holds the
 * gate open across it, but the gate's short attack protects nothing
 * backwards. The exposure is therefore quiet material approaching a phrase
 * from inside digital silence — a strip-silenced pre-roll holding an inhale,
 * a soft pickup consonant.
 *
 * The flag is opt-in because `deriveCompressor`'s consumption of the OLD
 * semantics is measured and pinned: on a gated take its quietest window is a
 * fade tail reading tens of dB low, and its derived threshold still moves by
 * under 0.1 dB (the `what survives the gate` pair in vocalChain.test.ts). The
 * gate is the consumer for which a boundary window turns directly into muted
 * programme, so the gate asks for the honest search.
 *
 * Search step is 50 ms, and the window is a whole number of steps, so the scan
 * sums squares once per 50 ms CHUNK and then slides a 10-chunk sum: O(n) time
 * and O(n / chunk) extra memory. A prefix-sum array over the samples would be
 * equally fast but costs a Float64Array the length of the region — 109 MB for
 * the 142 s stereo reference take, which is more than any effect in this app
 * allocates.
 */
export interface NoiseWindow {
  startSample: number;
  lengthSamples: number;
  /** RMS of the window, dBFS — the noise floor. */
  rmsDb: number;
  /** Peak of the Remove-Silence detector envelope inside the window, dBFS. */
  envelopePeakDb: number;
  /** Only with `rejectMostlySilentWindows`: how many real (non-silent) frames
   * live inside evicted-quieter candidate windows that no accepted candidate
   * window covers — the audio the returned measurement never saw. 0 on takes
   * where the eviction hid nothing but silence. See the docblock. */
  hiddenRealSamples?: number;
}

export const NOISE_WINDOW_MS = 500;
const NOISE_SEARCH_STEP_MS = 50;

const CHUNKS_PER_WINDOW = NOISE_WINDOW_MS / NOISE_SEARCH_STEP_MS;

/**
 * The largest share of a candidate window that may be digitally-silent frames
 * (every channel exactly 0) before `rejectMostlySilentWindows` refuses it as a
 * noise-floor measurement. Both sides of 0.25 are measured populations:
 *
 * ABOVE — a zero-headed floor window swept at 8/22.05/44.1/48 kHz x 3 seeds
 * reads a spectral-tilt residual of 1.78 dB at 0.25 zeros, still inside the
 * 0.63…1.91 dB floor population `GATE_SHAPED_RESIDUAL_DB` is derived from; at
 * 0.30 it reads 1.93 dB, already outside that population, and by 0.60
 * (2.60 dB) a plain floor reads as a vocal tract. 0.25 is therefore the
 * largest swept fraction at which every window this search can still return
 * measures like a floor to the content checks downstream of it. The envelope
 * peak — the statistic the gate's threshold is built on — under-reads a
 * 25 %-zeros floor window by at most 0.30 dB against the full window
 * (44.1 kHz, worst of three seeds), small beside the 0.63 dB margin the 3 dB
 * gate headroom keeps over its worst measured graze.
 *
 * BELOW — an undithered 16-bit floor quantises its smallest samples to EXACT
 * zero, scattered through every window: measured per 500 ms window on
 * quantised Gaussian floors at 8 and 44.1 kHz, three seeds each, 1.0-1.3 % of
 * samples at -60 dBFS, 4.3-5.0 % at -72, 9.1-9.7 % at -78, 17.7-19.3 % at -84
 * and 21.6-22.7 % at -85.5 dBFS. Those windows are real recordings' noise
 * floors and must stay in the search, so the bound cannot drop to 0.20 without
 * evicting the two quietest members. Quieter still the class crosses the
 * bound (-87 dBFS reads 25.2-26.4 % on the same population, pinned by the
 * same kept test) and the caller declines fail-safe — a floor within 3 dB of
 * `SILENCE_RMS` is at the edge of measurability either way.
 */
export const NOISE_WINDOW_MAX_SILENT_FRACTION = 0.25;

export interface MeasureNoiseWindowOptions {
  /** Refuse candidate windows that are mostly digital silence (see
   * `NOISE_WINDOW_MAX_SILENT_FRACTION`), returning the quietest MOSTLY-REAL
   * window instead — or null when none exists. Opt-in; see the docblock. */
  rejectMostlySilentWindows?: boolean;
}

export function measureNoiseWindow(
  channels: Float32Array[],
  sampleRate: number,
  options?: MeasureNoiseWindowOptions,
): NoiseWindow | null {
  const n = channels[0]?.length ?? 0;
  const nch = channels.length;
  const chunk = Math.max(1, Math.round((NOISE_SEARCH_STEP_MS / 1000) * sampleRate));
  const win = chunk * CHUNKS_PER_WINDOW;
  if (nch === 0 || n < win) return null;

  // Sum of squares per 50 ms chunk, over all channels. float64 because a
  // float32 accumulator loses the tail of a long region.
  const chunkCount = Math.floor(n / chunk);
  const chunkSum = new Float64Array(chunkCount);
  for (const c of channels) {
    for (let k = 0; k < chunkCount; k++) {
      const start = k * chunk;
      let sum = 0;
      for (let i = 0; i < chunk; i++) sum += c[start + i] * c[start + i];
      chunkSum[k] += sum;
    }
  }

  // Silent frames per chunk — counted only when the caller asked for the
  // mostly-silent reject, since the count is an extra O(n·channels) pass.
  let chunkSilent: Uint32Array | null = null;
  if (options?.rejectMostlySilentWindows) {
    chunkSilent = new Uint32Array(chunkCount);
    for (let k = 0; k < chunkCount; k++) {
      const start = k * chunk;
      let silent = 0;
      for (let i = 0; i < chunk; i++) {
        let allZero = true;
        for (const c of channels) {
          if (c[start + i] !== 0) {
            allZero = false;
            break;
          }
        }
        if (allZero) silent++;
      }
      chunkSilent[k] = silent;
    }
  }

  let bestRms = Infinity;
  let bestAt = -1;
  let running = 0;
  let silentRun = 0;
  for (let k = 0; k < chunkCount; k++) {
    running += chunkSum[k];
    if (chunkSilent) silentRun += chunkSilent[k];
    if (k < CHUNKS_PER_WINDOW - 1) continue;
    if (k >= CHUNKS_PER_WINDOW) {
      running -= chunkSum[k - CHUNKS_PER_WINDOW];
      if (chunkSilent) silentRun -= chunkSilent[k - CHUNKS_PER_WINDOW];
    }
    const rms = Math.sqrt(running / (win * nch));
    // Strictly above digital silence, and strictly quieter than the incumbent
    // (so the FIRST of several equally quiet windows wins — deterministic).
    // The silent-fraction comparison is strictly greater: a window at exactly
    // the bound is still a measurement (pinned in vocalChain.test.ts).
    if (
      rms > SILENCE_RMS &&
      rms < bestRms &&
      !(chunkSilent && silentRun / win > NOISE_WINDOW_MAX_SILENT_FRACTION)
    ) {
      bestRms = rms;
      bestAt = (k - (CHUNKS_PER_WINDOW - 1)) * chunk;
    }
  }
  if (bestAt < 0) return null;

  // The eviction's accounts (see the docblock): with the FINAL winner known,
  // classify every chunk by the candidates that contain it — covered by an
  // accepted (mostly-real, above-silence) window, or only inside evicted
  // quieter-than-the-winner ones — then count the real frames the accepted
  // search never saw. One more O(chunks) slide plus one walk over the
  // affected chunks, only on the opt-in path.
  let hiddenRealSamples: number | undefined;
  if (chunkSilent) {
    const covered = new Uint8Array(chunkCount);
    const evicted = new Uint8Array(chunkCount);
    let running2 = 0;
    let silentRun2 = 0;
    for (let k = 0; k < chunkCount; k++) {
      running2 += chunkSum[k];
      silentRun2 += chunkSilent[k];
      if (k < CHUNKS_PER_WINDOW - 1) continue;
      if (k >= CHUNKS_PER_WINDOW) {
        running2 -= chunkSum[k - CHUNKS_PER_WINDOW];
        silentRun2 -= chunkSilent[k - CHUNKS_PER_WINDOW];
      }
      const rms = Math.sqrt(running2 / (win * nch));
      if (rms <= SILENCE_RMS) continue;
      if (silentRun2 / win > NOISE_WINDOW_MAX_SILENT_FRACTION) {
        if (rms < bestRms) for (let c = k - (CHUNKS_PER_WINDOW - 1); c <= k; c++) evicted[c] = 1;
      } else {
        for (let c = k - (CHUNKS_PER_WINDOW - 1); c <= k; c++) covered[c] = 1;
      }
    }
    let hidden = 0;
    for (let c = 0; c < chunkCount; c++) {
      if (!evicted[c] || covered[c]) continue;
      const from = c * chunk;
      const to = from + chunk;
      for (let i = from; i < to; i++) {
        let allZero = true;
        for (const ch of channels) {
          if (ch[i] !== 0) {
            allZero = false;
            break;
          }
        }
        if (!allZero) hidden++;
      }
    }
    hiddenRealSamples = hidden;
  }

  const segment = channels.map((c) => c.subarray(bestAt, bestAt + win));
  const env = envelopeFollower(maxAcrossChannels(segment), sampleRate, DETECT_ATTACK_MS, DETECT_RELEASE_MS);
  let envPeak = 0;
  for (let i = 0; i < env.length; i++) if (env[i] > envPeak) envPeak = env[i];

  return {
    startSample: bestAt,
    lengthSamples: win,
    rmsDb: toDb(bestRms),
    envelopePeakDb: toDb(envPeak),
    ...(hiddenRealSamples === undefined ? {} : { hiddenRealSamples }),
  };
}

/**
 * How far a passage's spectrum departs from a straight line in log-frequency,
 * in dB — the measurement that tells a NOISE FLOOR from an UNVOICED VOICE.
 *
 * Periodicity answers "is this voice" for anything with a fundamental, and
 * `deriveGate` asks it first. It cannot answer for a whisper, a sustained
 * aspirate or a held sibilant: those are noise, so a pitch detector reads them
 * as unvoiced exactly as it reads room tone. What still separates them is where
 * the noise has been: a vocal tract imposes RESONANCES, and a room does not.
 * Room tone is a tilt — white hiss is flat, rumble and HVAC slope down, a
 * spectral-subtraction residual keeps the tilt of whatever it subtracted — and
 * a tilt is a straight line in log-frequency. Formants are bumps on it.
 *
 * So: average power spectrum over the passage, in dB, least-squares fit of
 * `a + b·log(bin)` across the band, and the RMS of what the line does not
 * explain. The fit absorbs the tilt, whatever its slope, which is why this
 * separates a formant-shaped whisper from a heavily rolled-off floor where
 * spectral flatness and centroid do not — measured, both of those put a −45 dBFS
 * one-pole-tilted floor and a whisper on the same side.
 *
 * Band: 120 Hz up to 0.84 of Nyquist, so the DC/rumble corner and the
 * anti-alias rolloff — neither of which is programme — stay out of the fit.
 * Returns 0 for a passage shorter than one analysis block, which is not a
 * verdict but an absence of one: the caller must not read it as "floor".
 */
/** One STFT analysis frame of the tilt fit — the shortest passage on which
 * ANY of the gate's classifiers can produce a verdict, and therefore the
 * gate's floor for "real audio worth accounting for" (see `deriveGate`'s
 * hidden-material decline). Verdicts on passages NEAR this floor are still
 * unreliable — a single-frame fit on an all-real floor run reads up to 3.9 dB
 * where the 500 ms population tops out at 1.91 — which is why the gate
 * declines on hidden material instead of classifying it. */
export const TILT_FFT_SIZE = 1024;

export function spectralTiltResidualDb(window: Float32Array, sampleRate: number): number {
  const fftSize = TILT_FFT_SIZE;
  if (window.length < fftSize) return 0;
  const { frames } = stft(window, fftSize, fftSize / 2);
  if (frames.length === 0) return 0;
  const bins = fftSize / 2 + 1;
  const power = new Float64Array(bins);
  for (const frame of frames) for (let k = 0; k < bins; k++) power[k] += frame[k] * frame[k];

  const binHz = sampleRate / fftSize;
  const lo = Math.max(1, Math.round(120 / binHz));
  const hi = Math.min(bins - 1, Math.round((0.42 * sampleRate) / binHz));
  if (hi - lo < 8) return 0;

  let sx = 0;
  let sy = 0;
  let n = 0;
  for (let k = lo; k <= hi; k++) {
    sx += Math.log(k);
    sy += 10 * Math.log10(power[k] / frames.length + 1e-20);
    n++;
  }
  const mx = sx / n;
  const my = sy / n;
  let sxy = 0;
  let sxx = 0;
  for (let k = lo; k <= hi; k++) {
    const dx = Math.log(k) - mx;
    sxy += dx * (10 * Math.log10(power[k] / frames.length + 1e-20) - my);
    sxx += dx * dx;
  }
  const slope = sxx > 0 ? sxy / sxx : 0;
  let ss = 0;
  for (let k = lo; k <= hi; k++) {
    const r = 10 * Math.log10(power[k] / frames.length + 1e-20) - (my + slope * (Math.log(k) - mx));
    ss += r * r;
  }
  return Math.sqrt(ss / n);
}

/**
 * Amplitude of a sinusoid at `freqHz` over a Hann-windowed block, via Goertzel.
 * Returned in the same units as the samples (peak amplitude, not RMS), the Hann
 * coherent gain of 0.5 divided back out.
 *
 * Goertzel rather than an FFT bin because mains hum sits at 50 or 60 Hz and the
 * chain must tell them apart: the STFT used elsewhere in this app is 2048 wide,
 * which at 48 kHz puts 50 Hz and 60 Hz in the SAME 23.4 Hz bin. Goertzel
 * evaluates the exact frequency asked for.
 */
export function goertzelAmplitude(
  x: Float32Array,
  start: number,
  length: number,
  freqHz: number,
  sampleRate: number
): number {
  if (length < 2) return 0;
  const w = (2 * Math.PI * freqHz) / sampleRate;
  const cosW = Math.cos(w);
  const coeff = 2 * cosW;
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < length; i++) {
    // Hann keeps a loud low-frequency neighbour's sidelobes out of the bin.
    const window = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (length - 1));
    const s0 = window * x[start + i] + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  const real = s1 - s2 * cosW;
  const imag = s2 * Math.sin(w);
  return (2 * Math.sqrt(real * real + imag * imag)) / (length * 0.5);
}

/** Block length for the hum probe: 1 s gives ~1 Hz resolution, so 50 and 60 Hz
 * are cleanly separated and the +-5 Hz reference probes fall outside the 4 Hz
 * Hann main lobe. Also wide enough that the +-0.1 Hz drift of real mains does
 * not walk out of the bin. */
const HUM_BLOCK_MS = 1000;
/** Reference offsets, in Hz, whose mean is the local spectral floor. */
const HUM_NEIGHBOUR_OFFSETS = [-7, -5, 5, 7];

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * How far a steady tone at `freqHz` stands above the surrounding spectrum, in
 * dB, as the median over 1 s blocks. The median is what makes it a HUM test
 * rather than a content test: hum is present in every block, whereas a note at
 * the same frequency is present in a few.
 *
 * Returns `null` when the signal is shorter than one block — a measurement that
 * cannot be taken must not be reported as "no hum".
 */
export function toneExcessDb(signal: Float32Array, sampleRate: number, freqHz: number): number | null {
  const block = Math.round((HUM_BLOCK_MS / 1000) * sampleRate);
  const blocks = Math.floor(signal.length / block);
  if (block < 2 || blocks < 1) return null;
  const atFreq: number[] = [];
  const atNeighbours: number[] = [];
  for (let b = 0; b < blocks; b++) {
    const start = b * block;
    atFreq.push(goertzelAmplitude(signal, start, block, freqHz, sampleRate));
    let sum = 0;
    for (const offset of HUM_NEIGHBOUR_OFFSETS) {
      sum += goertzelAmplitude(signal, start, block, freqHz + offset, sampleRate);
    }
    atNeighbours.push(sum / HUM_NEIGHBOUR_OFFSETS.length);
  }
  return toDb(median(atFreq)) - toDb(median(atNeighbours));
}

/** The two mains fundamentals DeHum offers. Nothing else is a mains frequency. */
export const MAINS_BASE_FREQUENCIES = [50, 60] as const;

/**
 * Decision threshold for "this recording has mains hum", in dB of excess over
 * the local spectral floor at the FUNDAMENTAL.
 *
 * Measured on `test-assets/P1177605.wav` (a clean take with no hum): the
 * fundamental excess is +0.52 dB at 50 Hz and -0.21 dB at 60 Hz. Injecting a
 * 50 Hz tone at -70 dBFS — quieter than any hum worth removing, and 33 dB below
 * that take's own noise floor — lifts the 50 Hz excess to +25.24 dB while
 * leaving 60 Hz at -0.21 dB. So the two classes are separated by an empty
 * 24.7 dB gap and 12 dB sits in the middle of it: 11.5 dB above anything clean
 * material produced, 13.2 dB below the quietest injected hum. Pinned below / on
 * / above in the tests.
 *
 * Only the FUNDAMENTAL is tested, deliberately. On the same clean take the
 * 120 Hz probe reads +8.27 dB — musical content, not hum, since 60 Hz itself
 * reads -0.21 dB. Requiring the fundamental rejects that; requiring harmonics
 * as well would reject fundamental-only hum, which is common.
 */
export const HUM_EXCESS_THRESHOLD_DB = 12;

export interface MainsHum {
  baseHz: number;
  excessDb: number;
}

/**
 * Mains hum, or `null` when there is none (or when the region is too short to
 * tell — the two are distinguished by `humMeasurable`).
 */
export function detectMainsHum(channels: Float32Array[], sampleRate: number): MainsHum | null {
  const mono = monoMix(channels);
  let best: MainsHum | null = null;
  for (const baseHz of MAINS_BASE_FREQUENCIES) {
    const excessDb = toneExcessDb(mono, sampleRate, baseHz);
    if (excessDb === null) return null;
    if (best === null || excessDb > best.excessDb) best = { baseHz, excessDb };
  }
  if (best === null || best.excessDb < HUM_EXCESS_THRESHOLD_DB) return null;
  return best;
}

/** Whether `detectMainsHum` had enough material to reach a verdict at all. */
export function humMeasurable(sampleCount: number, sampleRate: number): boolean {
  return sampleCount >= Math.round((HUM_BLOCK_MS / 1000) * sampleRate);
}

/**
 * What one stage did to the audio, measured from outside it — the same six
 * numbers for every stage, so a regression in any one of them is attributable.
 *
 * `identicalFraction` and `differenceRmsDb` are `null` when the stage changed
 * the length (Remove Silence, Reverb): there is no sample-to-sample
 * correspondence to compare, and reporting 0 % identical would read as damage
 * when it is just a shift.
 */
export interface StageDelta {
  rmsBeforeDb: number;
  rmsAfterDb: number;
  peakBeforeDb: number;
  peakAfterDb: number;
  identicalFraction: number | null;
  differenceRmsDb: number | null;
}

export function measureStageDelta(before: Float32Array[], after: Float32Array[]): StageDelta {
  const delta: StageDelta = {
    rmsBeforeDb: programmeRmsDb(before),
    rmsAfterDb: programmeRmsDb(after),
    peakBeforeDb: peakDb(before),
    peakAfterDb: peakDb(after),
    identicalFraction: null,
    differenceRmsDb: null,
  };

  const sameShape =
    before.length === after.length && before.every((c, i) => c.length === after[i].length);
  if (!sameShape) return delta;

  let identical = 0;
  let total = 0;
  let sumSq = 0;
  for (let ch = 0; ch < before.length; ch++) {
    const a = before[ch];
    const b = after[ch];
    for (let i = 0; i < a.length; i++) {
      // Object.is, not ===, so a sign flip on a zero counts as a change: the
      // de-esser's bit-exactness claim is specifically about surviving -0.
      if (Object.is(a[i], b[i])) identical++;
      const d = b[i] - a[i];
      sumSq += d * d;
    }
    total += a.length;
  }
  delta.identicalFraction = total === 0 ? 1 : identical / total;
  delta.differenceRmsDb = total === 0 ? toDb(0) : toDb(Math.sqrt(sumSq / total));
  return delta;
}
