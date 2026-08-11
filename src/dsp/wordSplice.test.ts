import { MIN_SEAM_MS, deriveSeamSamples, spliceWord, type WordSpliceRequest } from './wordSplice';
import { SPLICE_XFADE_MS } from './silenceDetect';
import { MAX_RATIO, MIN_RATIO } from './wsola';
import { detectPitch } from './pitchDetect';

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
} = {}) {
  const mono = concat(
    roomTone(Math.round(leadSeconds * SR)),
    tone(Math.round(soundSeconds * SR), freq, amplitude),
    roomTone(Math.round(tailSeconds * SR))
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

  it('refuses a replacement with nothing above its own noise floor', () => {
    const t = makeTarget();
    const silent = [roomTone(Math.round(1.5 * SR))];
    const r = spliceWord(request({ ...t, replacement: silent, matchPitch: false }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('silent-replacement');
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
