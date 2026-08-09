/**
 * Shared tempo-fixture generators (R4). Moved VERBATIM from
 * `src/dsp/tempoCore.test.ts` (which now imports them from here) so the unit
 * tests and the `scripts/tempo-bench.cjs` A/B harness use ONE definition —
 * two copies would drift and silently make the harness measure something the
 * tests do not. Every generator is deterministic: the only randomness is a
 * fixed-seed LCG (`speechLike` seed 999, `noiseOnly` seed 12345). Never
 * `Math.random()`.
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
 * 20)` does NOT (a NEW, content-level finding -- the fix DOES reach
 * `drumLoop(90,20)` at ghostAmp 0.15/0.3, see test 3).
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
