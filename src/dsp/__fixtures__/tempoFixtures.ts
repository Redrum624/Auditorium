/**
 * Shared tempo-fixture generators (R4). Moved VERBATIM from
 * `src/dsp/tempoCore.test.ts` (which now imports them from here) so the unit
 * tests and the `scripts/tempo-bench.cjs` A/B harness use ONE definition —
 * two copies would drift and silently make the harness measure something the
 * tests do not. Every generator is deterministic: the only randomness is a
 * fixed-seed LCG (`speechLike` seed 999, `noiseOnly` seed 12345, and the
 * jittered generators' explicit `seed` parameter). Never `Math.random()`.
 *
 * The R4-NEW generators at the bottom (`lcg`, `jitterClickTrain`,
 * `jitterDrumLoop`) are the P2-4 "jittery human-like timing" fixtures and
 * did not exist in the test file; everything above them is the verbatim move.
 */

export function sine(freq: number, seconds: number, sr = 44100, amp = 1): Float32Array {
  const n = Math.round(seconds * sr);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / sr);
  return out;
}

/** A unit-impulse click train at `bpm` beats/minute over `seconds`, first
 * click at sample `phase` (default 0). */
export function clickTrain(bpm: number, seconds: number, sr = 44100, phase = 0): Float32Array {
  const n = Math.round(seconds * sr);
  const out = new Float32Array(n);
  const interval = Math.round((60 / bpm) * sr);
  for (let i = phase; i < n; i += interval) out[i] = 1;
  return out;
}

/**
 * A synthetic "drum loop": a full-strength decaying kick on every beat plus
 * a decaying kick on every eighth-note off-beat (halfway through each beat
 * period) at `ghostAmp` amplitude (default 0.6 -- a REALISTIC "ghost note"
 * level, ~-4.4 dB relative to the main kick, restored to this value post-T2
 * review; see below). This arms the octave trap (T2 acceptance "FIXTURE
 * SANITY FIRST": real periodic energy exists at BOTH the true period P and
 * P/2, so a naive ACF argmax could plausibly lock onto the wrong half
 * period). Each kick decays with a ~120 ms time constant (matches the
 * brief's "kick's 120 ms decay smears its flux peak across ~2 frames"
 * tolerance justification), synthesised as a decaying 60 Hz tone rather than
 * a single-sample impulse.
 *
 * GHOST AMPLITUDE (post-T2-review C1 fix round, updated fix round 2): the
 * FIRST implementation of this fixture used 0.6 here, found the C1 octave-
 * misidentification bug (a 90 bpm drum loop reporting 180 bpm), then the
 * ORIGINAL FIX ATTEMPT lowered this constant to 0.15 to make the acceptance
 * tests pass -- which hid the bug behind a 6.5% amplitude margin rather than
 * fixing `chooseOctave` (T2 review, Critical C1). Restored to 0.6 so the
 * acceptance tests exercise the real fix rather than a weakened fixture.
 * `chooseOctave` was rewritten again in fix round 2 (see its doc comment --
 * the round-1 achieved-bpm-weighted-prior fix caused a net regression across
 * 60-200bpm); the CURRENT, periodMatch-based fix reaches further than round
 * 1 did on SOME cases and less far on others, all re-verified and
 * re-documented at their own call sites (OCTAVE tests 3/4/4b, TABLE-DRIVEN
 * test, task-T2-report.md "Fix round 2"). In short, at ghostAmp 0.6:
 * `drumLoop(120,20)` and `drumLoop(150,20)` resolve correctly; `drumLoop(90,
 * 20)` did NOT (a content-level finding -- fix round 2 reached
 * `drumLoop(90,20)` only at ghostAmp 0.15/0.3) until R4's jitter-tolerant
 * penalty (`JITTER_VARIANCE_WEIGHT` in tempoCore.ts): measured 91.05 bpm at
 * ghostAmp 0.45/0.6, so test 3 now pins the FULL 0.15-0.6 range.
 */
export function drumLoop(bpm: number, seconds: number, ghostAmp = 0.6, sr = 44100): Float32Array {
  const n = Math.round(seconds * sr);
  const out = new Float32Array(n);
  const period = Math.round((60 / bpm) * sr);
  const decayTau = 0.12 / 3; // ~120 ms decay time constant
  const kickLen = Math.min(n, Math.round(0.2 * sr));

  function addKick(start: number, amp: number): void {
    for (let i = 0; i < kickLen && start + i < n; i++) {
      const t = i / sr;
      const env = Math.exp(-t / decayTau);
      out[start + i] += amp * env * Math.sin(2 * Math.PI * 60 * t);
    }
  }

  for (let start = 0; start < n; start += period) {
    addKick(start, 1.0);
    const off = start + Math.round(period / 2);
    if (off < n) addKick(off, ghostAmp);
  }
  return out;
}

/**
 * A "backbeat" pattern: kick on beats 1 & 3, snare on beats 2 & 4, plus a
 * hi-hat on every 8th note (including on-beat). An independent (non-
 * `drumLoop`-derived) real-rhythm fixture used by the T2 review to
 * cross-check the C1 fix on different spectral/rhythmic content.
 */
export function backbeat(bpm: number, seconds: number, sr = 44100): Float32Array {
  const n = Math.round(seconds * sr);
  const out = new Float32Array(n);
  const beatPeriod = Math.round((60 / bpm) * sr);

  function addDecay(start: number, amp: number, freq: number, tauSec: number, lenSec: number): void {
    const len = Math.min(n - start, Math.round(lenSec * sr));
    for (let i = 0; i < len && start + i < n; i++) {
      const t = i / sr;
      const env = Math.exp(-t / tauSec);
      out[start + i] += amp * env * Math.sin(2 * Math.PI * freq * t);
    }
  }

  let beatIdx = 0;
  for (let start = 0; start < n; start += beatPeriod, beatIdx++) {
    const barPos = beatIdx % 4; // 0=beat1(kick) 1=beat2(snare) 2=beat3(kick) 3=beat4(snare)
    if (barPos === 0 || barPos === 2) {
      addDecay(start, 1.0, 60, 0.12 / 3, 0.2);
    } else {
      addDecay(start, 0.85, 200, 0.15 / 3, 0.2);
    }
    const hatOff = start + Math.round(beatPeriod / 2);
    if (hatOff < n) addDecay(hatOff, 0.3, 8000, 0.04 / 3, 0.06);
    addDecay(start, 0.25, 8000, 0.04 / 3, 0.06);
  }
  return out;
}

/**
 * A sustained, slowly-drifting-amplitude 4-note pad chord with NO sharp
 * onsets -- a "no real tempo" content type used to extend the CONFIDENCE
 * test's low-confidence anchor beyond pure noise.
 */
export function pad(seconds: number, sr = 44100): Float32Array {
  const n = Math.round(seconds * sr);
  const out = new Float32Array(n);
  const freqs = [220, 277, 330, 440];
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    let v = 0;
    for (const f of freqs) v += Math.sin(2 * Math.PI * f * t);
    const env = 0.5 + 0.5 * Math.sin(2 * Math.PI * 0.07 * t);
    out[i] = (v / freqs.length) * env * 0.8;
  }
  return out;
}

/**
 * Irregular, non-metronomic syllable-like bursts (jittered 200-450 ms apart)
 * of formant-ish carrier + noise -- an amplitude-modulated APERIODIC
 * broadband content type, deliberately NOT periodic the way music is, used
 * to extend the CONFIDENCE test's low-confidence anchor.
 */
export function speechLike(seconds: number, sr = 44100): Float32Array {
  const n = Math.round(seconds * sr);
  const out = new Float32Array(n);
  let seed = 999;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff - 0.5;
  };
  let t = 0;
  while (t < seconds) {
    const dur = 0.08 + 0.06 * (rand() + 0.5);
    const startSample = Math.round(t * sr);
    const len = Math.round(dur * sr);
    const f1 = 100 + 60 * (rand() + 0.5);
    const f2 = 700 + 400 * (rand() + 0.5);
    for (let i = 0; i < len && startSample + i < n; i++) {
      const tt = i / sr;
      const env = Math.sin((Math.PI * i) / len);
      out[startSample + i] += env * (Math.sin(2 * Math.PI * f1 * tt) + 0.5 * Math.sin(2 * Math.PI * f2 * tt) + 0.4 * rand()) * 0.5;
    }
    t += dur + 0.12 + 0.2 * (rand() + 0.5);
  }
  return out;
}

/**
 * A click train whose "clicks" are 10 ms LINEAR RAMPS (0 -> 1) rather than
 * single-sample impulses -- a more realistic attack transient, used to
 * verify the I2 sample-domain tie-break fix doesn't just remove bias for
 * mathematically-perfect impulses (see `refineSampleDomain`'s doc comment).
 * "True attack" for this fixture is defined as the FIRST sample of the ramp
 * (where the transient starts), not its peak.
 */
export function riseAttackTrain(bpm: number, seconds: number, sr = 44100, phase = 0): Float32Array {
  const n = Math.round(seconds * sr);
  const out = new Float32Array(n);
  const interval = Math.round((60 / bpm) * sr);
  const riseLen = Math.round(0.01 * sr); // 10ms
  for (let start = phase; start < n; start += interval) {
    for (let i = 0; i < riseLen && start + i < n; i++) {
      out[start + i] = (i + 1) / riseLen;
    }
  }
  return out;
}

/**
 * A click train whose instantaneous tempo ramps LINEARLY from `bpmStart` to
 * `bpmEnd` over `seconds` (the "whole reason for the DP" drift-tracking
 * fixture). Returns both the audio and the true click sample positions, so
 * tests can measure per-beat error directly rather than re-deriving truth.
 */
export function rampClickTrain(
  bpmStart: number,
  bpmEnd: number,
  seconds: number,
  sr = 44100
): { signal: Float32Array; trueClicks: number[] } {
  const n = Math.round(seconds * sr);
  const out = new Float32Array(n);
  const trueClicks: number[] = [];
  let t = 0;
  while (t < seconds) {
    const sample = Math.round(t * sr);
    if (sample < n) {
      out[sample] = 1;
      trueClicks.push(sample);
    }
    const currentBpm = bpmStart + (bpmEnd - bpmStart) * (t / seconds);
    t += 60 / currentBpm;
  }
  return { signal: out, trueClicks };
}

/** A click train whose instantaneous tempo is CONSTANT at `bpmStart` until
 * `switchSec`, then ABRUPTLY jumps to `bpmEnd` for the remainder -- unlike
 * `rampClickTrain`'s smooth drift, this creates a genuinely bimodal
 * inter-beat-interval distribution, used by the I1 self-consistency tests to
 * discriminate bpm (a global LSQ trend) from medianIBI (a local statistic)
 * on content too irregular for a smooth ramp to expose post the fix-round-2
 * periodMatch change (see the I1 tests' comments). */
export function stepClickTrain(bpmStart: number, bpmEnd: number, switchSec: number, totalSec: number, sr = 44100): Float32Array {
  const n = Math.round(totalSec * sr);
  const out = new Float32Array(n);
  let t = 0;
  while (t < totalSec) {
    const sample = Math.round(t * sr);
    if (sample < n) out[sample] = 1;
    const bpm = t < switchSec ? bpmStart : bpmEnd;
    t += 60 / bpm;
  }
  return out;
}

/** LCG noise, verbatim from fft.test.ts:102-106 -- never Math.random(). */
export function noiseOnly(seconds: number, sr = 44100): Float32Array {
  const n = Math.round(seconds * sr);
  const out = new Float32Array(n);
  let seed = 12345;
  for (let i = 0; i < n; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    out[i] = seed / 0x7fffffff - 0.5;
  }
  return out;
}

// ---------------------------------------------------------------------------
// R4-NEW generators — P2-4 "jittery human-like timing" fixtures.
// ---------------------------------------------------------------------------

/**
 * Seeded LCG in [-0.5, 0.5) — the SAME recurrence `speechLike`/`noiseOnly`
 * already use (glibc constants), exposed with an explicit seed so the
 * jittered generators are deterministic per (seed) and two fixtures with
 * different seeds get independent jitter sequences.
 */
export function lcg(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff - 0.5;
  };
}

/**
 * A HUMANLY-JITTERED click train: nominal grid at `bpm`, each click displaced
 * by an independent uniform offset in `[-jitterFrac*P/2, +jitterFrac*P/2)`
 * samples (`P` = the beat period). Zero-mean displacement of GRID positions
 * (not accumulated inter-onset error), so the long-run tempo is exactly
 * `bpm` and the least-squares regression truth stays the nominal label —
 * what a human playing to an internal pulse produces, as opposed to a
 * random-walk drift. `jitterFrac` 0.02–0.10 spans tight-professional to
 * sloppy-amateur timing (at 120 bpm, P = 500 ms, so 0.04 = ±10 ms).
 *
 * This is the P2-4 fixture: per-beat jitter raises `meanTightnessPenalty`
 * for the TRUE-tempo track, while a half-tempo track's gaps (sums of two
 * consecutive intervals) average the jitter down — so the current
 * `periodMatch` form structurally favours the machine-regular octave error
 * on exactly this content.
 */
export function jitterClickTrain(
  bpm: number,
  seconds: number,
  jitterFrac: number,
  seed: number,
  sr = 44100
): Float32Array {
  const n = Math.round(seconds * sr);
  const out = new Float32Array(n);
  const period = (60 / bpm) * sr;
  const rand = lcg(seed);
  for (let k = 0; ; k++) {
    const nominal = k * period;
    if (nominal >= n) break;
    const displaced = Math.round(nominal + rand() * jitterFrac * period);
    if (displaced >= 0 && displaced < n) out[displaced] = 1;
  }
  return out;
}

/**
 * A HUMANLY-JITTERED drum loop: `drumLoop`'s exact kick synthesis (decaying
 * 60 Hz tone, ~120 ms tau, ghost note at the half period) on a jittered grid
 * — main beats displaced like `jitterClickTrain`'s clicks, each ghost note
 * placed at the half period AFTER its own beat's displaced position with its
 * OWN independent jitter draw. Arms the ×2 octave trap AND the P2-4 jitter
 * penalty simultaneously: real half-period energy plus human timing.
 */
export function jitterDrumLoop(
  bpm: number,
  seconds: number,
  ghostAmp: number,
  jitterFrac: number,
  seed: number,
  sr = 44100
): Float32Array {
  const n = Math.round(seconds * sr);
  const out = new Float32Array(n);
  const period = (60 / bpm) * sr;
  const decayTau = 0.12 / 3; // ~120 ms decay time constant (verbatim drumLoop)
  const kickLen = Math.min(n, Math.round(0.2 * sr));
  const rand = lcg(seed);

  function addKick(start: number, amp: number): void {
    for (let i = 0; i < kickLen && start + i < n; i++) {
      const t = i / sr;
      const env = Math.exp(-t / decayTau);
      out[start + i] += amp * env * Math.sin(2 * Math.PI * 60 * t);
    }
  }

  for (let k = 0; ; k++) {
    const nominal = k * period;
    if (nominal >= n) break;
    const mainAt = Math.round(nominal + rand() * jitterFrac * period);
    if (mainAt >= 0 && mainAt < n) addKick(mainAt, 1.0);
    const ghostAt = Math.round(mainAt + period / 2 + rand() * jitterFrac * period);
    if (ghostAt >= 0 && ghostAt < n) addKick(ghostAt, ghostAmp);
  }
  return out;
}

// ---------------------------------------------------------------------------
// R7 generators — VARYING-tempo material with exact ground truth.
//
// The R4 bank above answers "what BPM is this?"; these answer "where is beat k,
// exactly?". They return BEAT POSITIONS rather than only audio, because the R7
// measurement is an ABSOLUTE beat-position error in milliseconds against a grid
// that is exact by construction — a correlation against a re-detected grid
// would measure the detector, which is the thing R7's Ruling 1 refuses to
// trust. Every one is deterministic and closed-form: no LCG, no Math.random.
//
// `test-assets/[music].mp3` is nearly steady and is therefore the CONTROL for
// this feature, not a test case; the varying cases have to be generated, and
// generated IN THE REPO, because an earlier uncommitted fixture bank made its
// own headline number permanently uninterpretable (see the R4 note above).
// ---------------------------------------------------------------------------

/**
 * Beat sample positions for a tempo that ramps LINEARLY IN TIME from `bpmStart`
 * to `bpmEnd` over `seconds` — an accelerando (or, with `bpmEnd < bpmStart`, a
 * ritardando). The instantaneous tempo at time t is
 * `bpmStart + (bpmEnd - bpmStart) * t / seconds`, so the SLOPE in BPM/s is
 * `(bpmEnd - bpmStart) / seconds` and every reported error can be quoted
 * against it.
 *
 * Same recurrence as {@link rampClickTrain} (which renders the audio for the
 * detector bank); this returns the positions alone so a caller can render its
 * own signal — R7 needs tone bursts, not impulses, because an impulse under
 * WSOLA is copied by up to two overlapping synthesis frames and its position
 * stops being well defined.
 */
export function accelerandoBeats(
  bpmStart: number,
  bpmEnd: number,
  seconds: number,
  sr = 44100
): number[] {
  const beats: number[] = [];
  let t = 0;
  while (t < seconds) {
    beats.push(Math.round(t * sr));
    t += 60 / (bpmStart + (bpmEnd - bpmStart) * (t / seconds));
  }
  return beats;
}

/**
 * Beat sample positions for a tempo that is CONSTANT at `bpmBefore` until
 * `switchSec` and then jumps ABRUPTLY to `bpmAfter` — the mid-song tempo change
 * the KNOWN_LIMITATIONS entry names, as opposed to
 * {@link accelerandoBeats}'s smooth drift. The interval containing the switch
 * is the one a single ratio cannot straddle at all.
 */
export function stepTempoBeats(
  bpmBefore: number,
  bpmAfter: number,
  switchSec: number,
  seconds: number,
  sr = 44100
): number[] {
  const beats: number[] = [];
  let t = 0;
  while (t < seconds) {
    beats.push(Math.round(t * sr));
    t += 60 / (t < switchSec ? bpmBefore : bpmAfter);
  }
  return beats;
}

/**
 * Beat sample positions for RUBATO: a sinusoidal tempo modulation of amplitude
 * `ampFrac` (a fraction of `bpmBase`, so 0.08 is ±8 %) and period `periodSec`
 * around `bpmBase`. Unlike an accelerando the mean tempo is right, which is
 * exactly why a single ratio looks correct on paper and still leaves every
 * interior beat displaced: the error oscillates rather than accumulating.
 */
export function rubatoBeats(
  bpmBase: number,
  ampFrac: number,
  periodSec: number,
  seconds: number,
  sr = 44100
): number[] {
  const beats: number[] = [];
  let t = 0;
  while (t < seconds) {
    beats.push(Math.round(t * sr));
    t += 60 / (bpmBase * (1 + ampFrac * Math.sin((2 * Math.PI * t) / periodSec)));
  }
  return beats;
}

/**
 * Beat and TRUE-DOWNBEAT positions for a track whose METER changes, at a
 * constant `bpm`. `sections` is a list of `[beatsPerBar, bars]` pairs, so
 * `[[4,16],[3,5],[4,16]]` is sixteen bars of 4/4, a five-bar 3/4 bridge, then
 * sixteen more bars of 4/4.
 *
 * This is the fixture for the SECOND half of the KNOWN_LIMITATIONS entry, which
 * has a different cause from the first: the beats are perfectly even here — the
 * tempo never varies — and what moves is how many of them make a bar. Bar
 * boundaries derived by a CONSTANT beat stride (`remixFeatures.ts`'s
 * `idx += beatsPerBar`) therefore walk off the real downbeats at the first
 * section whose beat count is not a multiple of the assumed meter, and stay off
 * for the rest of the track.
 */
export function meterChangeBeats(
  bpm: number,
  sections: readonly (readonly [number, number])[],
  sr = 44100
): { beats: number[]; downbeats: number[]; beatsPerBarOfBar: number[] } {
  const period = (60 / bpm) * sr;
  const beats: number[] = [];
  const downbeats: number[] = [];
  const beatsPerBarOfBar: number[] = [];
  let k = 0;
  for (const [beatsPerBar, bars] of sections) {
    for (let b = 0; b < bars; b++) {
      downbeats.push(Math.round(k * period));
      beatsPerBarOfBar.push(beatsPerBar);
      for (let j = 0; j < beatsPerBar; j++) beats.push(Math.round((k + j) * period));
      k += beatsPerBar;
    }
  }
  return { beats, downbeats, beatsPerBarOfBar };
}

/**
 * Renders `beats` as Hann-windowed tone bursts CENTRED on each beat sample.
 *
 * A symmetric window's ENERGY CENTROID is its centre, so "where is beat k in
 * this signal?" has an exact answer with no envelope-shape bias to cancel —
 * which is the whole reason not to use {@link clickTrain} here. F9 measured the
 * alternative the hard way: comparing an absolute centroid against a target
 * measured the FIXTURE's envelope shape (a constant ~14 ms) rather than the
 * warp's placement error. A centred symmetric burst removes that term
 * structurally instead of cancelling it arithmetically.
 *
 * `burstMs` must be shorter than the closest beat spacing or two bursts overlap
 * and neither centroid means anything; 40 ms is safe to 1500 BPM.
 */
export function burstTrain(
  beats: readonly number[],
  totalLen: number,
  sr = 44100,
  freq = 1000,
  burstMs = 40
): Float32Array {
  const out = new Float32Array(Math.max(0, Math.floor(totalLen)));
  const len = Math.round((burstMs / 1000) * sr);
  if (len < 2) return out;
  const half = Math.floor(len / 2);
  for (const b of beats) {
    for (let j = 0; j < len; j++) {
      const i = b - half + j;
      if (i < 0 || i >= out.length) continue;
      const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * j) / (len - 1));
      out[i] += w * Math.sin((2 * Math.PI * freq * j) / sr);
    }
  }
  return out;
}

/**
 * Energy centroid of `signal` over `[lo, hi)`, or `null` when that span holds no
 * energy. The measurement half of {@link burstTrain}: for an isolated centred
 * burst this returns the burst's centre exactly.
 */
export function energyCentroid(signal: Float32Array, lo: number, hi: number): number | null {
  let num = 0;
  let den = 0;
  const from = Math.max(0, Math.floor(lo));
  const to = Math.min(signal.length, Math.ceil(hi));
  for (let i = from; i < to; i++) {
    const e = signal[i] * signal[i];
    num += e * i;
    den += e;
  }
  return den > 0 ? num / den : null;
}
