import { MIN_SEAM_MS, deriveSeamSamples, spliceWord, type WordSpliceRequest } from './wordSplice';
import { DETECT_RELEASE_MS, SPLICE_XFADE_MS } from './silenceDetect';
import { MAX_RATIO, MIN_RATIO } from './wsola';
import { SILENCE_RMS, detectPitch } from './pitchDetect';
import { measureNoiseWindow } from './chainAnalysis';

const SR = 44100;

function tone(lengthSamples: number, freqHz: number, amplitude = 0.5, phase = 0): Float32Array {
  const out = new Float32Array(lengthSamples);
  for (let i = 0; i < lengthSamples; i++) out[i] = amplitude * Math.sin((2 * Math.PI * freqHz * i) / SR + phase);
  return out;
}

function concat(...parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function rmsOf(channel: Float32Array, start: number, end: number): number {
  let sum = 0;
  for (let i = start; i < end; i++) sum += channel[i] * channel[i];
  return Math.sqrt(sum / Math.max(1, end - start));
}

function medianVoiced(signal: Float32Array): number | null {
  const voiced = detectPitch(signal, SR)
    .frames.map((f) => f.f0Hz)
    .filter((f): f is number => f !== null)
    .sort((a, b) => a - b);
  return voiced.length === 0 ? null : voiced[Math.floor(voiced.length / 2)];
}

/** Quiet room tone, so a trim has a noise floor to find and `measureNoiseWindow`
 * has something above digital silence to measure. Deterministic. */
function roomTone(lengthSamples: number, amplitude = 1e-4): Float32Array {
  const out = new Float32Array(lengthSamples);
  let s = 12345;
  for (let i = 0; i < lengthSamples; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    out[i] = ((s / 0x7fffffff) * 2 - 1) * amplitude;
  }
  return out;
}

/**
 * A signal whose every sample has magnitude `amplitude`, so its RMS is
 * `amplitude` EXACTLY — `sqrt(N * a^2 / N)` with `a` a float32, which for
 * `a = SILENCE_RMS = 2^-15` is exact in float64 at every step. That is what
 * lets a fixture sit ON the digital-silence boundary rather than near it: a
 * noise generator can only be scaled until its RMS is close.
 *
 * The sign alternates so the signal carries no DC — a constant `+a` would be a
 * DC offset, which `spliceWord` removes, and the removal would change the RMS
 * the boundary is being probed with.
 */
function constant(lengthSamples: number, amplitude: number): Float32Array {
  const out = new Float32Array(lengthSamples);
  for (let i = 0; i < lengthSamples; i++) out[i] = i % 2 === 0 ? amplitude : -amplitude;
  return out;
}

/** Literal zeros — a muted microphone, or a gated DAW bounce. */
function silence(lengthSamples: number): Float32Array {
  return new Float32Array(lengthSamples);
}

/**
 * A document with a word between two neighbours, and the word's span.
 * Neighbour material is a different frequency from the word so a leak is
 * visible; the gaps are room tone so the seam has somewhere to live.
 *
 * `invertWord` negates the word's SAMPLES rather than adding pi to its phase.
 * The two are the same signal mathematically and not the same `double`:
 * `Math.sin(x + Math.PI)` differs from `-Math.sin(x)` by an ulp of the
 * argument, which at the ~830 rad this fixture reaches is enough to change the
 * odd float32. Negation is exact in IEEE, and the test that uses this option
 * makes a bit-level claim.
 *
 * `gapAmplitude` scales ONLY the room tone in the two gaps, so a second
 * document can differ from the first in exactly the material the seams blend
 * and nowhere else.
 */
function makeTarget({
  wordFreq = 330,
  wordSeconds = 0.4,
  gapSeconds = 0.2,
  neighbourSeconds = 0.3,
  invertWord = false,
  gapAmplitude = 1e-4,
  channels = 1,
} = {}) {
  const gap = Math.round(gapSeconds * SR);
  const neighbour = Math.round(neighbourSeconds * SR);
  const word = Math.round(wordSeconds * SR);
  const wordSamples = tone(word, wordFreq, 0.5);
  if (invertWord) for (let i = 0; i < wordSamples.length; i++) wordSamples[i] = -wordSamples[i];
  const mono = concat(
    tone(neighbour, 200),
    roomTone(gap, gapAmplitude),
    wordSamples,
    roomTone(gap, gapAmplitude),
    tone(neighbour, 200)
  );
  const startSample = neighbour + gap;
  return {
    target: Array.from({ length: channels }, () => Float32Array.from(mono)),
    startSample,
    endSample: startSample + word,
    gapSamples: gap,
  };
}

/**
 * A fresh recording of one word: room tone, the word, room tone.
 *
 * `amplitude` is the WORD's amplitude and does not touch the room tone — a
 * microphone does not lower its own noise floor when the singer sings more
 * quietly, and a fixture that scales both together describes a recording no
 * converter produces (at a quarter of 1e-4 the floor sits at -97 dBFS, below
 * the 16-bit LSB `measureNoiseWindow` refuses to measure, so the "noise
 * window" it returns is a window full of the word).
 */
function makeReplacement({
  freq = 220,
  amplitude = 0.5,
  soundSeconds = 0.4,
  leadSeconds = 0.6,
  tailSeconds = 0.6,
  dc = 0,
  channels = 1,
  /** What the pauses either side of the word are made of. Defaults to the room
   * tone a microphone actually records; the digital-silence probes below pass a
   * generator that puts the pause at or under the 16-bit LSB instead. */
  pad = roomTone as (n: number) => Float32Array,
} = {}) {
  const mono = concat(
    pad(Math.round(leadSeconds * SR)),
    tone(Math.round(soundSeconds * SR), freq, amplitude),
    pad(Math.round(tailSeconds * SR))
  );
  if (dc !== 0) for (let i = 0; i < mono.length; i++) mono[i] += dc;
  return Array.from({ length: channels }, () => Float32Array.from(mono));
}

function request(overrides: Partial<WordSpliceRequest> = {}): WordSpliceRequest {
  const t = makeTarget();
  return {
    target: t.target,
    startSample: t.startSample,
    endSample: t.endSample,
    replacement: makeReplacement(),
    sampleRate: SR,
    seamSamples: deriveSeamSamples(SR, t.gapSamples, t.gapSamples),
    ...overrides,
  };
}

describe('deriveSeamSamples', () => {
  const preferred = Math.round((SPLICE_XFADE_MS / 1000) * SR);
  const floor = Math.round((MIN_SEAM_MS / 1000) * SR);

  it('takes the app-wide 10 ms blend when both gaps are wider than it', () => {
    expect(deriveSeamSamples(SR, preferred + 1, preferred + 1)).toBe(preferred);
    expect(deriveSeamSamples(SR, preferred, preferred)).toBe(preferred);
  });

  it('shortens to the SMALLER gap, probed below / on / above the preferred blend', () => {
    expect(deriveSeamSamples(SR, preferred - 1, preferred + 1000)).toBe(preferred - 1);
    expect(deriveSeamSamples(SR, preferred + 1000, preferred - 1)).toBe(preferred - 1);
    expect(deriveSeamSamples(SR, preferred + 1000, preferred + 1000)).toBe(preferred);
  });

  it('never goes below the 2 ms click floor, probed below / on / above', () => {
    expect(deriveSeamSamples(SR, 0, 0)).toBe(floor);
    expect(deriveSeamSamples(SR, floor - 1, floor - 1)).toBe(floor);
    expect(deriveSeamSamples(SR, floor, floor)).toBe(floor);
    expect(deriveSeamSamples(SR, floor + 1, floor + 1)).toBe(floor + 1);
  });
});

describe('spliceWord geometry', () => {
  it('rewrites exactly the seam-extended region and changes no length', () => {
    const t = makeTarget();
    const seam = deriveSeamSamples(SR, t.gapSamples, t.gapSamples);
    const result = spliceWord(request());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.report.regionStart).toBe(t.startSample - seam);
    expect(result.report.regionEnd).toBe(t.endSample + seam);
    expect(result.channels[0].length).toBe(result.report.regionEnd - result.report.regionStart);
    expect(result.report.headSeamSamples).toBe(seam);
    expect(result.report.tailSeamSamples).toBe(seam);
  });

  it('clamps the seam at the document edges instead of reading past them', () => {
    const word = Math.round(0.4 * SR);
    const mono = tone(word, 330);
    const result = spliceWord(
      request({ target: [mono], startSample: 0, endSample: word, seamSamples: 500 })
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.report.regionStart).toBe(0);
    expect(result.report.headSeamSamples).toBe(0);
    expect(result.report.regionEnd).toBe(word);
    expect(result.report.tailSeamSamples).toBe(0);
  });
});

describe('spliceWord leaves nothing of the word it replaced', () => {
  /**
   * The F3 lesson as a PROPERTY rather than a listening test. Two documents
   * that are identical everywhere except INSIDE the word span, whose word
   * material has the same RMS and the same f0 (a sine and its inversion), are
   * spliced with the same replacement. If any of the original word survived
   * inside `[start, end)`, the two outputs would differ there.
   *
   * The second half of the assertion is what makes the first mean something:
   * the outputs MUST differ across the seams, or a splice that ignored the
   * original everywhere would pass.
   */
  it('is bit-identical inside the word span for two different originals, and differs across the seams', () => {
    const a = makeTarget();
    const b = makeTarget({ invertWord: true });
    // Same energy, same fundamental, opposite sign: the level and pitch
    // matching cannot tell them apart, so any difference in the output is a
    // leak and nothing else. Both derived quantities are bit-identical under a
    // sign flip and not merely close — `rms` sums squares, and YIN's
    // difference function sums squared differences, so every term is literally
    // the same double.
    expect(rmsOf(a.target[0], a.startSample, a.endSample)).toBe(
      rmsOf(b.target[0], b.startSample, b.endSample)
    );
    let identicalInside = true;
    for (let i = a.startSample; i < a.endSample; i++) {
      if (a.target[0][i] !== -b.target[0][i]) identicalInside = false;
    }
    expect(identicalInside).toBe(true);

    // A third document carrying the SAME word over DIFFERENT surroundings. It
    // is what makes the "differs across the seams" half observable: `a` and `b`
    // agree everywhere outside the word, so comparing THEM across the seams
    // could only ever report agreement, whatever the splice did.
    const c = makeTarget({ gapAmplitude: 0.05 });
    let sameWord = true;
    for (let i = a.startSample; i < a.endSample; i++) {
      if (a.target[0][i] !== c.target[0][i]) sameWord = false;
    }
    expect(sameWord).toBe(true);

    const replacement = makeReplacement();
    const seam = deriveSeamSamples(SR, a.gapSamples, a.gapSamples);
    const ra = spliceWord(request({ ...a, replacement, seamSamples: seam }));
    const rb = spliceWord(request({ ...b, replacement, seamSamples: seam }));
    const rc = spliceWord(request({ ...c, replacement, seamSamples: seam }));
    expect(ra.ok && rb.ok && rc.ok).toBe(true);
    if (!ra.ok || !rb.ok || !rc.ok) return;

    const head = ra.report.headSeamSamples;
    const tail = ra.report.tailSeamSamples;
    const regionLength = ra.report.regionEnd - ra.report.regionStart;
    const wordLength = a.endSample - a.startSample;
    expect(head).toBeGreaterThan(1);
    expect(tail).toBeGreaterThan(1);

    // 1. Nothing of the replaced word survives: the two opposite-signed words
    //    produce the same samples to the bit.
    const leaked: number[] = [];
    for (let i = head; i < head + wordLength; i++) {
      if (ra.channels[0][i] !== rb.channels[0][i]) leaked.push(i);
    }
    expect(leaked).toEqual([]);
    // …and so do the two different surroundings, which pins that the seams do
    // not bleed INTO the word span either.
    const leakedFromOutside: number[] = [];
    for (let i = head; i < head + wordLength; i++) {
      if (ra.channels[0][i] !== rc.channels[0][i]) leakedFromOutside.push(i);
    }
    expect(leakedFromOutside).toEqual([]);

    // 2. The seams DID blend the original. The head seam's first sample is the
    //    document's own sample, exactly: at t = 0 the equal-power law gives
    //    gOut = cos(0) = 1 and gIn = sin(0) = 0.
    expect(ra.channels[0][0]).toBe(a.target[0][ra.report.regionStart]);
    expect(rc.channels[0][0]).toBe(c.target[0][rc.report.regionStart]);

    // 3. …and every blended sample of both seams moves when the surroundings
    //    move. All but ONE per seam: the far end of each ramp is the pure
    //    replacement, because `Math.cos(Math.PI / 2)` is 6.123e-17 (fades.ts
    //    documents that residue) and 6.123e-17 of room tone lands far below the
    //    float32 ulp of the sum it is added to.
    let headDifferences = 0;
    for (let i = 0; i < head; i++) if (ra.channels[0][i] !== rc.channels[0][i]) headDifferences++;
    expect(headDifferences).toBe(head - 1);
    let tailDifferences = 0;
    for (let i = regionLength - tail; i < regionLength; i++) {
      if (ra.channels[0][i] !== rc.channels[0][i]) tailDifferences++;
    }
    expect(tailDifferences).toBe(tail - 1);
    // The mirror-image ends: the head seam's LAST sample and the tail seam's
    // FIRST sample are the ones that carry no original.
    expect(ra.channels[0][head - 1]).toBe(rc.channels[0][head - 1]);
    expect(ra.channels[0][regionLength - tail]).toBe(rc.channels[0][regionLength - tail]);
    // …and the outer ends are the document, which is what says each ramp
    // REACHES its endpoint rather than stopping one step short. The head's
    // first sample is the document exactly (gOut = cos 0 = 1, gIn = sin 0 = 0);
    // the tail's last is the document to the bit (gIn = 1, and the 6.123e-17 of
    // replacement that `Math.cos(Math.PI / 2)` leaves is 5 orders below the
    // float32 ulp of the sum).
    expect(ra.channels[0][regionLength - 1]).toBe(a.target[0][ra.report.regionEnd - 1]);
    expect(rc.channels[0][regionLength - 1]).toBe(c.target[0][rc.report.regionEnd - 1]);

    // 4. The word span is the whole of what changed, so compare against the
    //    untouched document: inside the span every sample must have moved.
    let unchanged = 0;
    for (let i = head; i < head + wordLength; i++) {
      if (ra.channels[0][i] === a.target[0][ra.report.regionStart + i]) unchanged++;
    }
    expect(unchanged).toBe(0);
  });
});

describe('spliceWord seams', () => {
  it('a 10 ms seam has a smaller step across the join than a one-sample cut', () => {
    const t = makeTarget();
    const replacement = makeReplacement({ freq: 220 });
    const measureJoin = (seamSamples: number) => {
      const r = spliceWord(request({ ...t, replacement, seamSamples }));
      if (!r.ok) throw new Error(r.message);
      const head = r.report.headSeamSamples;
      let worst = 0;
      // The step ACROSS the head join: the last untouched document sample
      // before the region, then the region's own first samples.
      let previous = t.target[0][r.report.regionStart - 1];
      for (let i = 0; i <= head; i++) {
        const value = r.channels[0][i];
        worst = Math.max(worst, Math.abs(value - previous));
        previous = value;
      }
      return worst;
    };
    const blended = measureJoin(deriveSeamSamples(SR, t.gapSamples, t.gapSamples));
    const hardCut = measureJoin(1);
    expect(hardCut).toBeGreaterThan(0);
    expect(blended).toBeLessThan(hardCut);
  });
});

describe('spliceWord matching', () => {
  it('matches the level of what it replaced', () => {
    const t = makeTarget();
    // A word sung at a quarter of the original amplitude over the SAME room
    // tone: the gain has to do real work, and the sign of the correction is
    // checkable.
    const quiet = makeReplacement({ amplitude: 0.125 });
    const r = spliceWord(request({ ...t, replacement: quiet }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.report.gainDb).toBeGreaterThan(0);
    const head = r.report.headSeamSamples;
    const wordLength = t.endSample - t.startSample;
    const got = rmsOf(r.channels[0], head, head + wordLength);
    const want = rmsOf(t.target[0], t.startSample, t.endSample);
    expect(got).toBeCloseTo(want, 6);
  });

  it('shifts the replacement to the replaced word\'s pitch, and reports the semitones', () => {
    const t = makeTarget({ wordFreq: 330 });
    const r = spliceWord(request({ ...t, replacement: makeReplacement({ freq: 220 }) }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.report.originalF0Hz).toBeCloseTo(330, -1);
    expect(r.report.replacementF0Hz).toBeCloseTo(220, -1);
    // 330/220 = 1.5, which is 12*log2(1.5) = 7.02 semitones.
    expect(r.report.pitchShiftSemitones).toBeCloseTo(12 * Math.log2(1.5), 1);
    const head = r.report.headSeamSamples;
    const wordLength = t.endSample - t.startSample;
    const heard = medianVoiced(r.channels[0].slice(head, head + wordLength));
    expect(heard).not.toBeNull();
    expect(heard as number).toBeGreaterThan(300);
    expect(heard as number).toBeLessThan(360);
  });

  it('leaves the pitch alone when matching is off, and says so with a zero', () => {
    const t = makeTarget({ wordFreq: 330 });
    const r = spliceWord(request({ ...t, replacement: makeReplacement({ freq: 220 }), matchPitch: false }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.report.pitchShiftSemitones).toBe(0);
    const head = r.report.headSeamSamples;
    const heard = medianVoiced(r.channels[0].slice(head, head + (t.endSample - t.startSample)));
    expect(heard as number).toBeGreaterThan(200);
    expect(heard as number).toBeLessThan(245);
  });

  it('removes the replacement recording\'s own DC offset', () => {
    const t = makeTarget();
    const r = spliceWord(request({ ...t, replacement: makeReplacement({ dc: 0.3 }), matchPitch: false }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.report.dcRemoved).toHaveLength(1);
    expect(r.report.dcRemoved[0]).toBeCloseTo(0.3, 2);
    const head = r.report.headSeamSamples;
    const wordLength = t.endSample - t.startSample;
    let mean = 0;
    for (let i = head; i < head + wordLength; i++) mean += r.channels[0][i];
    mean /= wordLength;
    expect(Math.abs(mean)).toBeLessThan(0.01);
  });

  it('fans a mono replacement out to every channel of a stereo document', () => {
    const t = makeTarget({ channels: 2 });
    const r = spliceWord(request({ ...t, replacement: makeReplacement({ channels: 1 }) }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.channels).toHaveLength(2);
    expect(Array.from(r.channels[0])).toEqual(Array.from(r.channels[1]));
  });
});

describe('spliceWord trimming', () => {
  it('trims the silence around the recorded word, and keeps the sound', () => {
    const soundSamples = Math.round(0.4 * SR);
    const t = makeTarget();
    const r = spliceWord(
      request({ ...t, replacement: makeReplacement({ soundSeconds: 0.4, leadSeconds: 0.6, tailSeconds: 0.6 }) })
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.report.trimSkipped).toBe(false);
    // The detector's 20 ms release keeps a little material past the offset, so
    // the trim is bounded rather than exact — but it must have removed most of
    // the 1.2 s of silence and kept the whole 0.4 s of sound.
    expect(r.report.trimmedSamples).toBeGreaterThanOrEqual(soundSamples);
    expect(r.report.trimmedSamples).toBeLessThan(soundSamples * 1.5);
  });

  it('keeps everything between the FIRST sound and the LAST, not just one of them', () => {
    // Two bursts with 0.30 s of room tone between them — a word with a stop
    // consonant in it. The kept span must reach from the first burst to the
    // end of the second; a trim that took only the first run, or only the
    // last, keeps about 0.32 s of that.
    //
    // The gap has to be longer than the follower's release OVERHANG or there
    // is only one run to span and the test cannot see the difference. At
    // 0.5 amplitude over this room tone the overhang is
    // 20 ms * ln(0.4658 / 8.553e-5) = 0.172 s, so 0.15 s of gap FUSES the two
    // bursts into a single run and 0.30 s does not.
    const burst = Math.round(0.15 * SR);
    const gap = Math.round(0.3 * SR);
    const t = makeTarget();
    const twoBursts = [
      concat(
        roomTone(Math.round(0.6 * SR)),
        tone(burst, 220),
        roomTone(gap),
        tone(burst, 220),
        roomTone(Math.round(0.6 * SR))
      ),
    ];
    const r = spliceWord(request({ ...t, replacement: twoBursts, matchPitch: false }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // First burst start to last burst end is 0.60 s; the follower's release
    // adds its documented overhang past the final offset and nothing else.
    // Either run taken alone reaches only burst + overhang = 0.32 s, which is
    // below this lower bound, so the bound is not one a half-span trim passes.
    const firstToLast = burst + gap + burst;
    expect(r.report.trimmedSamples).toBeGreaterThan(firstToLast);
    expect(r.report.trimmedSamples).toBeLessThan(firstToLast * 1.5);
  });

  it('needs a run of one release constant to call something sound, probed below / on / above', () => {
    // A burst at 2e-4 sits 7.4 dB over this room tone's own envelope peak, so
    // its release tail is SHORTER than one release constant and the burst's
    // own LENGTH is what decides whether the run reaches the bar. That makes
    // the bar reachable from both sides with a one-sample step.
    //
    // What the bar MOVES is the kept span, and by 60x: below it the recording's
    // own floor yields no run that lasts, the trim falls to the absolute floor —
    // which this room tone is above from end to end — and the whole 1.2 s is
    // kept; on it, the burst alone is kept. `word` differs between the two
    // probes for that reason and that reason only: the time fit has to be able
    // to express each answer (52 932 samples into a 2 200-sample word is far
    // outside MIN_RATIO, and 886 into a 20 000-sample word is far outside
    // MAX_RATIO). `trimmedSamples` is measured before the fit and does not
    // depend on the document at all.
    const at = (burstSamples: number, word: number) => {
      const doc = concat(tone(SR, 200), tone(word, 330), tone(SR, 200));
      return spliceWord({
        target: [doc],
        startSample: SR,
        endSample: SR + word,
        replacement: [
          concat(roomTone(Math.round(0.6 * SR)), tone(burstSamples, 220, 2e-4), roomTone(Math.round(0.6 * SR))),
        ],
        sampleRate: SR,
        seamSamples: 100,
        matchPitch: false,
      });
    };
    const minRun = Math.round((DETECT_RELEASE_MS / 1000) * SR);
    const wholeRecording = 2 * Math.round(0.6 * SR) + 53;

    const below = at(53, 20000);
    expect(below.ok).toBe(true);
    if (!below.ok) return;
    // Everything but the 41 samples the follower takes to climb over one LSB
    // from a standing start — i.e. nothing was trimmed, because at this bar
    // there is nothing in the recording that lasts.
    expect(below.report.trimmedSamples).toBe(wholeRecording - 41);

    // One sample more of burst carries the run over the bar. It lands at 886
    // rather than exactly 882 because each extra burst sample also lifts the
    // envelope's peak, which lengthens the release tail — the run steps by ~18
    // samples here, not by 1, so `>= minRun` and `> minRun` are the same rule
    // on any fixture this follower can produce.
    const on = at(54, 2200);
    expect(on.ok).toBe(true);
    if (!on.ok) return;
    expect(on.report.trimmedSamples).toBeGreaterThanOrEqual(minRun);
    expect(on.report.trimmedSamples).toBe(886);
    expect(on.report.trimmedSamples).toBeLessThan(below.report.trimmedSamples / 50);

    const above = at(120, 2200);
    expect(above.ok).toBe(true);
    if (!above.ok) return;
    expect(above.report.trimmedSamples).toBeGreaterThan(on.report.trimmedSamples);
  });

  it('trims a recording whose pauses are DIGITAL SILENCE down to the word', () => {
    // What Chromium's fake capture device records, and what a gated DAW bounce
    // exports: a real word with literal zeros either side. `measureNoiseWindow`
    // rejects every window at or below one LSB, so it hands back a window
    // CONTAINING the word and the recording's own floor comes out at the word's
    // own envelope peak — nothing clears that, and before the absolute-floor
    // rung existed this recording was refused as silent.
    const soundSamples = Math.round(0.4 * SR);
    const t = makeTarget();
    const replacement = makeReplacement({ pad: silence });
    const r = spliceWord(request({ ...t, replacement }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.report.trimSkipped).toBe(false);
    // The same bound the room-tone trim above is held to: the whole word, plus
    // the follower's release overhang and nothing else. The recording is 70 560
    // samples, so "kept everything" — the answer a trim that declined would
    // give — is nearly three times this upper bound and cannot pass it.
    expect(r.report.trimmedSamples).toBeGreaterThanOrEqual(soundSamples);
    expect(r.report.trimmedSamples).toBeLessThan(soundSamples * 1.5);
    expect(replacement[0].length).toBeGreaterThan(soundSamples * 2.5);
  });

  it('keeps a recording with no quiet part in it whole, instead of calling it silent', () => {
    // A word punched in tight, with no room tone either side — one second of
    // continuous tone. Its quietest 500 ms is exactly as loud as the rest, so
    // NOTHING in it rises above its own floor and the self-relative rule reads
    // it as silent. Against the absolute floor it is one unbroken run.
    const t = makeTarget();
    const continuous = [tone(Math.round(1.0 * SR), 220, 0.5)];
    const r = spliceWord(request({ ...t, replacement: continuous }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.report.trimSkipped).toBe(false);
    // Every sample but the first: `tone` starts at phase 0, so `x[0]` is 0 and
    // the follower's first output is `(1 - attackCoef) * 0` — the one sample of
    // this recording that is not above one LSB.
    expect(r.report.trimmedSamples).toBe(continuous[0].length - 1);
  });

  // The trim's first rung is the peak of the quietest 500 ms, and a candidate
  // window that is mostly EXACT ZEROS has its RMS diluted by them while taking
  // its envelope peak from the sliver of real material at its edge. A fresh
  // replacement take is exactly where device-written zeros live (a gated
  // interface, a DAW bounce, Chromium's fake capture device), and a mic's floor
  // is not stationary at the top of a take — a preamp or an AGC settles. Put
  // those two together and the boundary window wins the search on its dilution
  // and reports the SETTLING floor's peak, ~12 dB over the take's own steady
  // floor. The word's loud core still clears that, so the trim does not decline
  // — it just starts later and ends earlier, and the soft onset and tail of the
  // word are deleted before the splice.
  describe('a replacement take carrying device-written zeros', () => {
    /** Gaussian floor at a stated dBFS RMS. */
    function floorAt(n: number, rmsDb: number, seed: number): Float32Array {
      let s = seed >>> 0;
      const next = (): number => {
        s = (s * 1664525 + 1013904223) >>> 0;
        return (s / 0xffffffff) * 2 - 1;
      };
      const out = new Float32Array(n);
      const k = Math.pow(10, rmsDb / 20) / Math.sqrt(4 / 3);
      for (let i = 0; i < n; i++) out[i] = (next() + next() + next() + next()) * k;
      return out;
    }

    /** Noise at a stated dBFS RMS — an aspirated onset or release, which is
     * unvoiced and therefore noise, not a ramp: a ramp crosses any low
     * threshold within a millisecond and could never show a shave. */
    function breathAt(n: number, rmsDb: number, seed: number): Float32Array {
      return floorAt(n, rmsDb, seed);
    }

    const CHUNK = Math.round(0.05 * SR);
    const ASPIRATE = Math.round(0.12 * SR);
    const VOWEL = Math.round(0.35 * SR);
    const WORD = ASPIRATE + VOWEL + ASPIRATE;

    /** `[head][settling floor -62 dBFS][steady floor -74][aspirate][vowel]
     * [aspirate][steady floor]`.
     *
     * The head is 1.430 s rather than 1.4: candidate windows start on 50 ms
     * boundaries, so a head ending 20 ms BEFORE one leaves a candidate that is
     * 96 % zeros and 20 ms of the settling floor, which dilutes it to about
     * -76 dBFS — under the -74 steady floor, so it wins the bare search. A
     * trimmed head lands wherever the trim landed, not on a search step. */
    function take(head: (n: number) => Float32Array): Float32Array[] {
      const headLen = Math.round(1.4 * SR) + (CHUNK - Math.round(0.02 * SR));
      return [
        concat(
          head(headLen),
          floorAt(Math.round(1.0 * SR), -62, 23),
          floorAt(Math.round(0.7 * SR), -74, 7),
          breathAt(ASPIRATE, -68, 31),
          tone(VOWEL, 220, 0.1),
          breathAt(ASPIRATE, -68, 37),
          floorAt(Math.round(0.8 * SR), -74, 11)
        ),
      ];
    }

    /** A 1.0 s word, so both the shaved answer and the honest one land inside
     * WSOLA's ratio range and the report can be read in either case. */
    const wordTarget = () => {
      const word = Math.round(1.0 * SR);
      const doc = concat(tone(SR, 200), tone(word, 330, 0.5), tone(SR, 200));
      return { target: [doc], startSample: SR, endSample: SR + word };
    };

    const keptSamples = (replacement: Float32Array[]): number => {
      const r = spliceWord({
        ...wordTarget(),
        replacement,
        sampleRate: SR,
        seamSamples: 100,
        matchPitch: false,
      });
      expect(r.ok).toBe(true);
      if (!r.ok) throw new Error('expected a splice');
      expect(r.report.trimSkipped).toBe(false);
      return r.report.trimmedSamples;
    };

    it('keeps the word whole, and keeps the same span it would without the zeros', () => {
      const withZeros = keptSamples(take(silence));
      // The same take recorded by a device that writes its floor instead of
      // zeros — an ordinary mic take, nothing else changed.
      const withoutZeros = keptSamples(take((n) => floorAt(n, -74, 3)));

      // The requirement: the aspirated onset and release are still there.
      // Measured before the fix, the zeros version kept 19 449 samples against
      // the word's own 26 019 — the vowel and its release overhang, with both
      // breaths shaved off the ends.
      expect(withZeros).toBeGreaterThanOrEqual(WORD);

      // ...and the zeros changed nothing. The trim is a measurement of the
      // recording's floor, and a stretch of digital silence is not one.
      expect(Math.abs(withZeros - withoutZeros) / withoutZeros).toBeLessThan(0.05);
    });

    /** The same take with a LOUD settling stretch beside the zeros. 1.43 s of
     * zeros followed by -50 dBFS dilutes a boundary window only to about
     * -64 dBFS — well above the take's own -74 steady floor — so no boundary
     * window wins the search and the bare winner is already a legitimately
     * mostly-real one. The zeros are still there; they simply are not next to
     * anything quiet enough to launder.
     *
     * The head is a whole number of 50 ms chunks, unlike the RED take's, and for
     * a different reason: candidate windows start on chunk boundaries, so a head
     * of whole chunks means DROPPING it shifts the grid by whole chunks and the
     * twin's windows land on exactly the same material. That is what makes an
     * exact sample-for-sample comparison mean anything. It does not remove the
     * boundary windows — one straddling the end of the zeros is still half zeros
     * and still diluted — it only removes the 96 %-zeros extreme the RED take is
     * built around. Diluted-and-losing is the shape under test. */
    function undilutedTake(head: (n: number) => Float32Array): Float32Array[] {
      const headLen = 29 * CHUNK;
      return [
        concat(
          head(headLen),
          floorAt(Math.round(1.0 * SR), -50, 23),
          floorAt(Math.round(0.7 * SR), -74, 7),
          breathAt(ASPIRATE, -68, 31),
          tone(VOWEL, 220, 0.1),
          breathAt(ASPIRATE, -68, 37),
          floorAt(Math.round(0.8 * SR), -74, 11)
        ),
      ];
    }

    it('trims a take whose bare winner is ALREADY real exactly as its zeros-free twin does', () => {
      // The converse the fix owes, head to head. Rung 1 was moved from the bare
      // search to the mostly-real one; on the take above that changed the
      // threshold, which is the point. Here it must change NOTHING, and the
      // reason is asserted rather than assumed: the two searches are asked
      // separately and return the SAME window, so the fix is provably a no-op
      // on this shape rather than merely appearing to be one.
      const withZeros = undilutedTake(silence);

      // It really is the shape: exact zeros are present...
      let zeros = 0;
      for (let i = 0; i < withZeros[0].length; i++) if (withZeros[0][i] === 0) zeros++;
      expect(zeros).toBeGreaterThan(Math.round(1.4 * SR));

      // ...and the bare search's winner is itself mostly real, so both searches
      // land on the same window and the same envelope peak, to the bit.
      const bare = measureNoiseWindow(withZeros, SR)!;
      const real = measureNoiseWindow(withZeros, SR, { rejectMostlySilentWindows: true })!;
      expect(bare.startSample).toBe(real.startSample);
      expect(bare.envelopePeakDb).toBe(real.envelopePeakDb);
      // The winner sits past the zeros entirely — it is the take's own steady
      // floor, not a boundary window that got away with it.
      expect(bare.startSample).toBeGreaterThanOrEqual(Math.round(1.4 * SR));

      // The contrast that makes this a converse rather than a restatement: on
      // the RED shape, whose settling stretch is 12 dB quieter, the same two
      // calls disagree by more than a decibel.
      const diluting = take(silence);
      const dilutedBare = measureNoiseWindow(diluting, SR)!;
      const dilutedReal = measureNoiseWindow(diluting, SR, { rejectMostlySilentWindows: true })!;
      expect(Math.abs(dilutedBare.envelopePeakDb - dilutedReal.envelopePeakDb)).toBeGreaterThan(1);

      // And the behaviour: the same recording from a device that writes no
      // zeros at all keeps exactly the same number of samples. Not "within a
      // few percent" — the same integer, because the threshold is the same
      // number and the material either side of it is identical.
      const zerosFreeTwin = undilutedTake(() => new Float32Array(0));
      expect(keptSamples(withZeros)).toBe(keptSamples(zerosFreeTwin));
    });

    it('still trims: the settling floor is sound by the take own rule, the zeros are not', () => {
      // The converse, and the honest cost of a self-relative threshold on an
      // uneven floor: the -62 dBFS settling stretch IS above the -74 floor's
      // peak, so it is kept as sound — but the 1.43 s of digital silence in
      // front of it is not, and the trim removes all of it. A fix that simply
      // stopped trimming would keep the whole recording and fail this.
      const replacement = take(silence);
      const kept = keptSamples(replacement);
      expect(kept).toBeLessThan(replacement[0].length - Math.round(1.4 * SR));
    });
  });

  it('declines to trim a recording too short for the noise window it derives its threshold from', () => {
    const t = makeTarget();
    // 0.3 s total: under the 500 ms `measureNoiseWindow` needs.
    const short = [tone(Math.round(0.3 * SR), 220)];
    const r = spliceWord(request({ ...t, replacement: short }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.report.trimSkipped).toBe(true);
    expect(r.report.trimmedSamples).toBe(short[0].length);
  });
});

describe('spliceWord refusals', () => {
  it('refuses a span outside the document, probed on both edges', () => {
    const t = makeTarget();
    const docLength = t.target[0].length;
    expect(spliceWord(request({ ...t, startSample: 10, endSample: 10 })).ok).toBe(false);
    expect(spliceWord(request({ ...t, startSample: -1, endSample: 100 })).ok).toBe(false);
    expect(spliceWord(request({ ...t, startSample: 0, endSample: docLength + 1 })).ok).toBe(false);
    expect(spliceWord(request({ ...t, startSample: 0, endSample: docLength })).ok).toBe(true);
  });

  it('refuses an empty replacement and a channel count it cannot fan out', () => {
    const empty = spliceWord(request({ replacement: [new Float32Array(0)] }));
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.reason).toBe('empty-replacement');

    const t = makeTarget({ channels: 2 });
    const three = spliceWord(request({ ...t, replacement: makeReplacement({ channels: 3 }) }));
    expect(three.ok).toBe(false);
    if (!three.ok) expect(three.reason).toBe('channel-mismatch');
  });

  it('refuses a replacement at or below DIGITAL SILENCE, probed one float32 ulp either side', () => {
    // The boundary is `SILENCE_RMS`, one LSB of 16-bit PCM, and it is probed to
    // the ulp rather than approached: `constant` puts every sample at the same
    // magnitude, so the recording's RMS IS that magnitude, exactly, in float64.
    // The assertion below proves that rather than assuming it.
    const t = makeTarget();
    const length = Math.round(1.0 * SR);
    // 2^-15 is a power of two, so its float32 neighbours are 2^-15 + 2^-38
    // above and 2^-15 - 2^-39 below (the gap halves at the exponent step).
    const above = Math.fround(SILENCE_RMS + 2 ** -38);
    const below = Math.fround(SILENCE_RMS - 2 ** -39);
    expect(above).toBeGreaterThan(SILENCE_RMS);
    expect(below).toBeLessThan(SILENCE_RMS);
    expect(rmsOf(constant(length, SILENCE_RMS), 0, length)).toBe(SILENCE_RMS);

    const probe = (replacement: Float32Array) =>
      spliceWord(request({ ...t, replacement: [replacement], matchPitch: false }));

    // Literal zeros — a muted or unplugged microphone.
    const zeros = probe(silence(length));
    expect(zeros.ok).toBe(false);
    if (!zeros.ok) expect(zeros.reason).toBe('silent-replacement');
    // The message has to name the ABSOLUTE floor: `silent-replacement` is also
    // reachable from the pitch-shift stage further down, which reports the same
    // reason with a message that would tell this user to re-record something
    // longer — advice that has nothing to do with what went wrong.
    if (!zeros.ok) expect(zeros.message).toContain('digital silence');

    const under = probe(constant(length, below));
    expect(under.ok).toBe(false);
    if (!under.ok) expect(under.reason).toBe('silent-replacement');

    const on = probe(constant(length, SILENCE_RMS));
    expect(on.ok).toBe(false);
    if (!on.ok) expect(on.reason).toBe('silent-replacement');

    // One ulp more and the splice runs to completion — the recording is sized
    // (1.0 s against a 0.4 s word) so the time fit is well inside its range and
    // the boundary is the only thing deciding refused from spliced.
    const over = probe(constant(length, above));
    expect(over.ok).toBe(true);
    if (!over.ok) return;
    expect(over.report.stretchRatio).toBeGreaterThan(MIN_RATIO);
    expect(over.report.stretchRatio).toBeLessThan(MAX_RATIO);

    // …and the reading is over the WHOLE recording, not one end of it. Starting
    // the recorder early and singing late, or singing and then leaving it
    // running, are both ordinary — and two thirds of literal zeros on either
    // side of the word must not read as silence. Every other fixture here is
    // uniform end to end, so only these two can tell a whole-recording
    // measurement from a half of one, and it takes both to pin both halves.
    const lateWord = concat(silence(2 * length), tone(length, 220, 0.5));
    expect(rmsOf(lateWord, 0, Math.floor(lateWord.length / 2))).toBe(0);
    expect(probe(lateWord).ok).toBe(true);

    const earlyWord = concat(tone(length, 220, 0.5), silence(2 * length));
    expect(rmsOf(earlyWord, Math.floor(earlyWord.length / 2), earlyWord.length)).toBe(0);
    expect(probe(earlyWord).ok).toBe(true);
  });

  it('splices a recording that is nothing but room tone rather than refusing it', () => {
    // The trade the absolute floor makes, stated as a test so it is a decision
    // rather than a surprise. Room tone with no word in it is not digital
    // silence, and NOTHING distinguishes it from a word punched in tight
    // without inventing a level — so it is spliced, level-matched, and audibly
    // wrong, which one undo fixes. The self-relative rule refused this one
    // correctly and refused a good take with it; see `docs/KNOWN_LIMITATIONS.md`.
    const t = makeTarget();
    const r = spliceWord(request({ ...t, replacement: [roomTone(Math.round(1.5 * SR))], matchPitch: false }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.report.gainDb).toBeGreaterThan(0);
  });

  it('refuses a time fit outside WSOLA\'s ratio range, probed below / on / above', () => {
    // The fit ratio is regionLength / trimmedLength, so the word length decides
    // it. Build the word to demand exactly MIN_RATIO, then just under it.
    const soundSeconds = 0.4;
    const replacement = makeReplacement({ soundSeconds, leadSeconds: 0, tailSeconds: 0 });
    const trimmed = replacement[0].length;
    const probe = (ratio: number) => {
      const region = Math.round(trimmed * ratio);
      const seam = 100;
      const word = region - 2 * seam;
      const doc = concat(tone(SR, 200), tone(word, 330), tone(SR, 200));
      return spliceWord({
        target: [doc],
        startSample: SR,
        endSample: SR + word,
        replacement,
        sampleRate: SR,
        seamSamples: seam,
        matchPitch: false,
      });
    };
    const under = probe(MIN_RATIO * 0.9);
    expect(under.ok).toBe(false);
    if (!under.ok) expect(under.reason).toBe('unfittable');
    expect(probe(MIN_RATIO).ok).toBe(true);
    expect(probe(MAX_RATIO).ok).toBe(true);
    const over = probe(MAX_RATIO * 1.1);
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.reason).toBe('unfittable');
  });
});
