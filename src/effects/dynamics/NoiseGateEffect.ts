import type { EffectDefinition } from '../types';
import { envelopeFollower, maxAcrossChannels, maybeReportProgress } from './envelope';

type GateState = 'open' | 'holding' | 'closing' | 'closed';

export const FADE_FLOOR_DB = -80;

/**
 * The `__effectExtra` payload of the Vocal Chain's AUTOMATIC gate (G2): the
 * regions to mute, region-relative, decided by `deriveGate` from where the
 * vocal activity is rather than from a level. This effect's job in that mode
 * is application only — each region becomes digital silence behind the same
 * linear-in-dB `releaseMs` fade the threshold machine closes with, the reopen
 * at a region's end is instant exactly as the machine's reopen is, and every
 * sample outside the regions comes back bit-identical. Silence in is silence
 * out: a zero inside a region stays zero whatever the gain.
 *
 * When the side channel is absent — the manual "Gate at a level I set
 * instead" path, and every direct use of this effect — nothing here runs and
 * the threshold state machine below is byte-for-byte what it was.
 */
export interface NoiseGateMuteRegionsExtra {
  muteRegions: { start: number; end: number }[];
}

function readMuteRegions(): { start: number; end: number }[] | null {
  const extra = (globalThis as { __effectExtra?: Partial<NoiseGateMuteRegionsExtra> }).__effectExtra;
  const regions = extra?.muteRegions;
  return Array.isArray(regions) ? regions : null;
}

/**
 * How long a run of DIGITAL SILENCE (every channel exactly 0) must be before
 * the gate treats it as silence somebody put there rather than as the zeros a
 * quantiser scatters through a real noise floor.
 *
 * Why the gate cares at all (N6). A gate can only remove what is there, and a
 * run of exact zeros is already gone: it costs the gate nothing, so the gate
 * spends the run OPEN and whatever emerges from the run gets the same
 * `holdMs` a phrase's tail gets. Without that, quiet material approaching a
 * phrase from inside digital silence — a strip-silenced pre-roll holding an
 * inhale, a soft pickup consonant — is muted whole: the hold looks forward
 * from the material before it, and there is no material before it, only
 * zeros. Measured on the shape that named the defect (a -60 dBFS island
 * bracketed by 300 ms of zeros, immediately before a loud burst, on a take
 * whose floor sets the threshold at -42 dBFS): 100.0 % of the island removed
 * at 8, 44.1 and 48 kHz, against 0.0 % for the mirror island AFTER the burst,
 * which the hold already covered.
 *
 * BELOW — a run bound of nothing at all would end the gate. An undithered
 * converter quantises the smallest samples of a quiet floor to EXACT zero, so
 * a real recording's floor is full of them, and a gate that read any zero as
 * an edit would never close again. Measured over 4 rates (8/22.05/44.1/48 kHz)
 * x 3 distributions (uniform, Gaussian, one-pole-tilted at 400 Hz) x 4 depths
 * (16/12/10/8-bit) x 14 floor levels x 3 seeds, the LONGEST run of consecutive
 * exact zeros, by how much of the floor quantised away:
 *
 *   - among floors the noise search will still accept as a measurement (at or
 *     under `NOISE_WINDOW_MAX_SILENT_FRACTION`) — the only floors a derived
 *     threshold is ever built on: 1.00 ms (8 samples, a Gaussian 10-bit
 *     -50 dBFS floor at 8 kHz, 23.6 % zeros);
 *   - up to half zeros: 2.50 ms;
 *   - up to three-quarters zeros: 5.38 ms (a uniform 8-bit -50 dBFS floor at
 *     8 kHz, 71.4 % zeros);
 *   - 75-99.9 % zeros — a "floor" that is already all but silence: 29.63 ms
 *     (237 samples, a tilted 12-bit -78 dBFS floor at 8 kHz, 94.8 % zeros).
 *
 * ABOVE — the silences an edit writes are an order of magnitude longer: the
 * strip-silenced stems this chain's own fixtures use leave 350 ms between
 * bursts, the island fixture is bracketed by 300 ms, and a trimmed lead-in
 * runs to seconds. So 50 ms is 50x the worst run among the floors this app
 * will still measure a threshold from, 9x the worst among floors that are
 * more sound than silence, and 6x under the shortest bracket that has to
 * trigger the rule. It clears the absolute worst by only 1.7x, and that is
 * deliberate: the two error directions are not symmetric. Missing a bracket
 * mutes a word; a spurious hold leaks one `holdMs` of the material that
 * triggered it, and every member whose run comes near the bound is
 * nine-tenths exact zeros at around -80 dBFS — a converter's floor
 * disappearing under its own LSB, not a floor anything is gated against.
 * Both bands are pinned by the kept `GATE_SILENT_RUN_MS` population.
 *
 * MILLISECONDS, not samples: the long runs come from a floor's own
 * correlation time (a tilted floor clusters its zeros), which is a duration.
 * The same tilted 10-bit -66 dBFS floor runs 182 samples at 8 kHz and 933 at
 * 44.1 kHz — 22.8 ms against 21.2 ms, flat in time and five times apart in
 * samples. A sample-count bound would be loose at one rate and tight at
 * another.
 *
 * THE COST, STATED: the gate cannot tell a whispered pickup from a stray
 * noise blip — both are quiet material bracketed by zeros — so a blip inside
 * digital silence now passes too, up to one hold of it. The direction is
 * deliberate: whoever edited the file put that material between zeros, and
 * passing a tick costs less than muting a word.
 */
export const GATE_SILENT_RUN_MS = 50;

/**
 * Noise gate. Detector = envelope follower (attackMs/releaseMs) of
 * max(|L|,|R|). An explicit per-sample state machine drives the gate gain
 * (applied identically to every channel):
 * - `open`: envDb > threshold. Gain = 1 (0dB). Reopening from any other
 *   state is instant (attack-fast) — the very sample envDb crosses back
 *   above threshold snaps straight to `open`/gain=1.
 * - `holding`: envDb dropped below threshold; gain stays at 1 for `holdMs`.
 * - `closing`: after the hold expires, gain fades linear-in-dB from 0dB down
 *   to `FADE_FLOOR_DB` over `releaseMs`.
 * - `closed`: fade complete; gain is hard 0.
 *
 * One input decides the state without consulting the detector at all: a run of
 * DIGITAL SILENCE at least `GATE_SILENT_RUN_MS` long (every channel exactly 0)
 * leaves the gate `open`. Silence in is silence out whatever the gain, so the
 * run costs the gate nothing either way — and ending it open is what gives the
 * material on the far side the same `holdMs` the material before a pause gets.
 * Without it, quiet audio approaching a phrase from inside digital silence is
 * muted whole (N6). See `GATE_SILENT_RUN_MS` for both measured sides.
 */
export const noiseGateEffect: EffectDefinition = {
  id: 'noise-gate',
  name: 'Noise Gate',
  category: 'Dynamics',
  params: [
    { id: 'thresholdDb', label: 'Threshold', type: 'number', min: -80, max: 0, step: 0.1, unit: 'dB', default: -50 },
    { id: 'attackMs', label: 'Attack', type: 'number', min: 0.1, max: 50, step: 0.1, unit: 'ms', default: 1 },
    { id: 'releaseMs', label: 'Release', type: 'number', min: 10, max: 2000, step: 1, unit: 'ms', default: 150 },
    { id: 'holdMs', label: 'Hold', type: 'number', min: 0, max: 500, step: 1, unit: 'ms', default: 50 },
  ],
  process(channels, sampleRate, params, onProgress) {
    const thresholdDb = Number(params.thresholdDb ?? -50);
    const attackMs = Number(params.attackMs ?? 1);
    const releaseMs = Number(params.releaseMs ?? 150);
    const holdMs = Number(params.holdMs ?? 50);

    // Region mode (see `NoiseGateMuteRegionsExtra`): the WHERE was already
    // decided; apply it and touch nothing else. The threshold machine below is
    // never consulted in this mode — that is the mode's whole meaning.
    const muteRegions = readMuteRegions();
    if (muteRegions) {
      const length = channels[0]?.length ?? 0;
      const releaseSamples = Math.max(1, Math.round((releaseMs / 1000) * sampleRate));

      // Clamp into the buffer, drop what is empty after clamping, and merge
      // overlaps/adjacency: each merged region is faded ONCE from the source
      // samples — a second region re-faded from source inside an already-muted
      // stretch would write real samples back over the first one's zeros.
      const clamped = muteRegions
        .map((r) => ({ start: Math.max(0, Math.floor(r.start)), end: Math.min(length, Math.floor(r.end)) }))
        .filter((r) => r.end > r.start)
        .sort((a, b) => a.start - b.start);
      const merged: { start: number; end: number }[] = [];
      for (const r of clamped) {
        const last = merged[merged.length - 1];
        if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
        else merged.push({ ...r });
      }

      // Bit-identical copy outside the regions — `new Float32Array(c)` copies
      // sample bits, -0 included.
      const out = channels.map((c) => new Float32Array(c));
      for (const region of merged) {
        const fadeEnd = Math.min(region.end, region.start + releaseSamples);
        for (let i = region.start; i < fadeEnd; i++) {
          // The state machine's own fade arithmetic: linear-in-dB down to
          // FADE_FLOOR_DB across releaseSamples, applied identically to every
          // channel. A zero times any gain stays zero.
          const fadeDb = FADE_FLOOR_DB * ((i - region.start + 1) / releaseSamples);
          const gain = Math.pow(10, fadeDb / 20);
          for (let ch = 0; ch < channels.length; ch++) out[ch][i] = channels[ch][i] * gain;
        }
        for (let i = fadeEnd; i < region.end; i++) {
          // The machine's `closed` state: gain hard 0.
          for (let ch = 0; ch < channels.length; ch++) out[ch][i] = channels[ch][i] * 0;
        }
        maybeReportProgress(onProgress, region.end - 1, length);
      }
      onProgress?.(1);
      return { channels: out };
    }

    const holdSamples = Math.round((holdMs / 1000) * sampleRate);
    const releaseSamples = Math.max(1, Math.round((releaseMs / 1000) * sampleRate));
    const silentRunSamples = Math.max(1, Math.round((GATE_SILENT_RUN_MS / 1000) * sampleRate));

    const length = channels[0]?.length ?? 0;
    const detector = maxAcrossChannels(channels);
    const env = envelopeFollower(detector, sampleRate, attackMs, releaseMs);

    const out = channels.map((c) => new Float32Array(c.length));
    let state: GateState = 'closed';
    let holdRemaining = 0;
    let fadeElapsed = 0;
    let zeroRun = 0;

    for (let i = 0; i < length; i++) {
      const envDb = 20 * Math.log10(Math.max(env[i], 1e-6));
      const above = envDb > thresholdDb;

      // Digital silence, counted on the SAMPLES rather than on the detector:
      // the follower's own release keeps the envelope up for tens of ms after
      // the material stops, so it cannot see a zero run start. `-0 === 0`, so
      // a negative zero counts as silence, which it is.
      let allZero = true;
      for (let ch = 0; ch < channels.length; ch++) {
        if (channels[ch][i] !== 0) {
          allZero = false;
          break;
        }
      }
      zeroRun = allZero ? zeroRun + 1 : 0;

      // Deciding mid-run is not retroactive: every sample of the run is zero,
      // so the gain the earlier samples were given cannot have changed them.
      if (zeroRun >= silentRunSamples) {
        state = 'open';
      } else if (above) {
        state = 'open';
      } else if (state === 'open') {
        state = 'holding';
        holdRemaining = holdSamples;
      } else if (state === 'holding') {
        holdRemaining--;
        if (holdRemaining <= 0) {
          state = 'closing';
          fadeElapsed = 0;
        }
      } else if (state === 'closing') {
        fadeElapsed++;
        if (fadeElapsed >= releaseSamples) state = 'closed';
      }
      // 'closed' with envDb still below threshold: stays closed.

      let gain: number;
      if (state === 'open' || state === 'holding') {
        gain = 1;
      } else if (state === 'closing') {
        const fadeDb = FADE_FLOOR_DB * (fadeElapsed / releaseSamples);
        gain = Math.pow(10, fadeDb / 20);
      } else {
        gain = 0;
      }

      for (let ch = 0; ch < channels.length; ch++) {
        out[ch][i] = channels[ch][i] * gain;
      }
      maybeReportProgress(onProgress, i, length);
    }

    return { channels: out };
  },
};
