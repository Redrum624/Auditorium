import type { AudioDocument } from '../audio/AudioDocument';
import { docLength } from '../audio/AudioDocument';
import { resampleChannel } from '../dsp/resample';
import type { Clip, Session, Track } from './session';

/**
 * Offline stereo mixdown of a multitrack session — pure (no store imports),
 * deterministic, and the ground-truth render (the realtime MultitrackPlayer is
 * an approximation of this). The result is always a stereo pair.
 *
 * PAN LAW (asserted exactly by mixdown.test.ts):
 *
 *  - Mono source: constant-power. With pan p ∈ [-1, 1], θ = ((p+1)/2)·(π/2);
 *    gL = cos(θ), gR = sin(θ). At center (p=0) each side gets cos(π/4) ≈ 0.707,
 *    so a hard-panned mono source is +3 dB relative to a centered one (the
 *    standard constant-power law). The single channel feeds BOTH master sides.
 *
 *  - Stereo source: balance. gL = p<=0 ? 1 : cos(p·π/2);
 *    gR = p>=0 ? 1 : cos(-p·π/2). Unity on both sides at center; panning toward
 *    one side attenuates the OPPOSITE channel (leaving the near side untouched)
 *    rather than folding the channels together.
 *
 * Gains: clip.gainDb and track.volumeDb are independent linear multipliers
 * (10^(dB/20)) applied before panning. Solo/mute: if ANY track is soloed, only
 * soloed tracks are audible; a muted track is always silent (mute wins even on
 * a soloed track). Length = the maximum clip end (startSample + lengthSample)
 * over AUDIBLE tracks; an empty or all-silent session yields two empty channels.
 *
 * A clip whose source document rate differs from the session rate has its slice
 * resampled to the session rate (round positions). The master bus is HARD
 * clamped to ±1 after summing (a hard limiter, not soft-knee — documented v1
 * behavior; overlapping full-scale material simply flat-tops).
 */
export interface MixdownResult {
  channels: [Float32Array, Float32Array];
  sampleRate: number;
}

function dbToLinear(db: number): number {
  return Math.pow(10, db / 20);
}

function monoPanGains(pan: number): { gL: number; gR: number } {
  const theta = ((pan + 1) / 2) * (Math.PI / 2);
  return { gL: Math.cos(theta), gR: Math.sin(theta) };
}

function stereoBalanceGains(pan: number): { gL: number; gR: number } {
  const gL = pan <= 0 ? 1 : Math.cos((pan * Math.PI) / 2);
  const gR = pan >= 0 ? 1 : Math.cos((-pan * Math.PI) / 2);
  return { gL, gR };
}

function isAudible(track: Track, anySolo: boolean): boolean {
  return !track.muted && (!anySolo || track.solo);
}

function clamp1(v: number): number {
  return v > 1 ? 1 : v < -1 ? -1 : v;
}

/**
 * Reads the clip's source region as per-channel Float32Arrays at the SESSION
 * sample rate. `offsetSample`/`lengthSample` are interpreted so the clip
 * occupies exactly `lengthSample` samples on the session timeline: the number
 * of source samples read is `round(lengthSample · docRate / sessionRate)`
 * (== lengthSample when rates match), and those source samples are resampled up
 * to the session rate. Out-of-range source reads are zero-filled.
 *
 * Exported so the realtime MultitrackPlayer builds its AudioBuffers from the
 * exact same slice/resample logic the offline mixdown uses.
 */
export function readClipSlice(doc: AudioDocument, clip: Clip, sessionRate: number): Float32Array[] {
  const docSliceLen =
    doc.sampleRate === sessionRate
      ? clip.lengthSample
      : Math.round((clip.lengthSample * doc.sampleRate) / sessionRate);
  if (docSliceLen <= 0 || doc.channels.length === 0) return [];

  const srcLen = docLength(doc);
  const slices = doc.channels.map((ch) => {
    const out = new Float32Array(docSliceLen);
    for (let i = 0; i < docSliceLen; i++) {
      const idx = clip.offsetSample + i;
      out[i] = idx >= 0 && idx < srcLen ? ch[idx] : 0;
    }
    return out;
  });

  if (doc.sampleRate === sessionRate) return slices;
  return slices.map((ch) => resampleChannel(ch, doc.sampleRate, sessionRate));
}

export function mixdownSession(
  session: Session,
  docs: Map<string, AudioDocument>,
  onProgress?: (fraction: number) => void
): MixdownResult {
  const sr = session.sampleRate;
  const anySolo = session.tracks.some((t) => t.solo);
  const audible = session.tracks.filter((t) => isAudible(t, anySolo));

  let length = 0;
  for (const t of audible) {
    for (const c of t.clips) {
      length = Math.max(length, c.startSample + c.lengthSample);
    }
  }

  if (length === 0) {
    onProgress?.(1);
    return { channels: [new Float32Array(0), new Float32Array(0)], sampleRate: sr };
  }

  const L = new Float32Array(length);
  const R = new Float32Array(length);

  const total = audible.length;
  let done = 0;
  for (const t of audible) {
    const trackGain = dbToLinear(t.volumeDb);
    for (const c of t.clips) {
      const doc = docs.get(c.documentId);
      if (!doc) continue;
      const slice = readClipSlice(doc, c, sr);
      if (slice.length === 0 || slice[0].length === 0) continue;

      const g = dbToLinear(c.gainDb) * trackGain;
      const mono = slice.length === 1;
      const { gL, gR } = mono ? monoPanGains(t.pan) : stereoBalanceGains(t.pan);
      const chL = slice[0];
      const chR = mono ? slice[0] : slice[1];

      const base = c.startSample;
      const n = Math.min(slice[0].length, length - base);
      for (let i = 0; i < n; i++) {
        L[base + i] += chL[i] * g * gL;
        R[base + i] += chR[i] * g * gR;
      }
    }
    done++;
    onProgress?.(done / total);
  }

  for (let i = 0; i < length; i++) {
    L[i] = clamp1(L[i]);
    R[i] = clamp1(R[i]);
  }

  onProgress?.(1);
  return { channels: [L, R], sampleRate: sr };
}
