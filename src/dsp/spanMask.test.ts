/**
 * D4 — the span keeper behind the per-speaker landing.
 *
 * Every assertion here is written against the SHIPPED fade math (`fades.ts`'s
 * `fadeInGainAt`/`fadeOutGainAt` at `equal-gain` with `singletonGain 0`) rather
 * than against a curve re-typed into this file: the point of the module is that
 * a speaker track's edges are the app's own ramps, so a test carrying its own
 * copy of the ramp would keep passing if the two ever drifted apart.
 *
 * The fixture is a RAMP that never touches zero and never reaches one — a
 * signal whose every sample is distinct and non-identity, so "zeroed outside"
 * and "unchanged inside" are both real claims, and a `keepSpans` that returned
 * its input, or silence, fails immediately.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

import { fadeInGainAt, fadeOutGainAt } from './fades';
import { MIN_EDGE_RAMP_SAMPLES, SPEAKER_EDGE_FADE_MS, keepSpans } from './spanMask';

const RATE = 44100;
const SECOND = RATE;

/** Strictly positive, strictly increasing: 0.1 → 0.9, never 0, never 1. */
function rampUp(length: number): Float32Array {
  const ch = new Float32Array(length);
  for (let i = 0; i < length; i++) ch[i] = 0.1 + 0.8 * (i / (length - 1));
  return ch;
}

/** Strictly negative and falling in magnitude — a second channel that shares no
 * sample value with the first, so a mask applied to one channel and copied to
 * the other cannot pass. */
function rampDown(length: number): Float32Array {
  const ch = new Float32Array(length);
  for (let i = 0; i < length; i++) ch[i] = -(0.15 + 0.7 * (1 - i / (length - 1)));
  return ch;
}

function stereo(length: number): Float32Array[] {
  return [rampUp(length), rampDown(length)];
}

/** The per-sample gain `keepSpans` actually applied. Safe to divide: the
 * fixture has no zero samples. */
function gainEnvelope(out: Float32Array, src: Float32Array): Float64Array {
  const g = new Float64Array(out.length);
  for (let i = 0; i < out.length; i++) g[i] = out[i] / src[i];
  return g;
}

/** Distance from `from` to the first sample the mask left completely alone —
 * i.e. the length of the fade-in that starts there. */
function rampLengthFrom(out: Float32Array, src: Float32Array, from: number): number {
  let i = from;
  while (i < out.length && out[i] !== src[i]) i++;
  return i - from + 1;
}

describe('D4 SPEAKER_EDGE_FADE_MS — one constant, two rates', () => {
  it('is 10 ms', () => {
    expect(SPEAKER_EDGE_FADE_MS).toBe(10);
  });

  it('rounds to 441 samples at 44.1 kHz — the last ramp sample is the first unity one', () => {
    const src = stereo(SECOND);
    const out = keepSpans(src, [{ startSample: 10000, endSample: 30000 }], 44100);

    expect(rampLengthFrom(out[0], src[0], 10000)).toBe(441);
    // Pinned from both sides: 10440 is untouched (gain 1), 10439 is not.
    expect(out[0][10440]).toBe(src[0][10440]);
    expect(out[0][10439]).not.toBe(src[0][10439]);
    expect(441).toBe(Math.round((SPEAKER_EDGE_FADE_MS / 1000) * 44100));
  });

  it('rounds to 480 samples at 48 kHz — the same constant, a different rate', () => {
    const src = stereo(48000);
    const out = keepSpans(src, [{ startSample: 1000, endSample: 20000 }], 48000);

    expect(rampLengthFrom(out[0], src[0], 1000)).toBe(480);
    expect(out[0][1479]).toBe(src[0][1479]);
    expect(out[0][1478]).not.toBe(src[0][1478]);
    expect(480).toBe(Math.round((SPEAKER_EDGE_FADE_MS / 1000) * 48000));
  });
});

describe('D4 SPEAKER_EDGE_FADE_MS — the header claims only what remixRender documents', () => {
  // The constant is a boundary value borrowed from the bound another module
  // DOCUMENTS, so the thing that can rot is not the arithmetic (pinned
  // above) but the SENTENCE: a citation that drifts off the docblock it names,
  // or a paraphrase that turns "where a fade-out becomes audible" into "the
  // longest ramp that is not". Both are checked against `remixRender.ts` itself
  // rather than against a copy of its wording kept here.
  const source = readFileSync(join(__dirname, 'spanMask.ts'), 'utf8');
  const remixLines = readFileSync(join(__dirname, 'remixRender.ts'), 'utf8').split(/\r?\n/);
  const silenceLines = readFileSync(join(__dirname, 'silenceDetect.ts'), 'utf8').split(/\r?\n/);
  /** Comment text as prose: leading ` * ` gone, wrapping collapsed, so a
   * sentence broken across three comment lines reads as one. */
  const prose = (text: string): string => text.replace(/^[ \t]*\*[ \t]?/gm, '').replace(/\s+/g, ' ');

  it('cites the exact lines that hold the bound, and no unrelated constant', () => {
    const cites = [...source.matchAll(/remixRender\.ts:(\d+)-(\d+)/g)];
    expect(cites.length).toBeGreaterThan(0);
    for (const [, from, to] of cites) {
      const slice = remixLines.slice(Number(from) - 1, Number(to));
      // A citation that opens on the docblock and closes on the declaration it
      // documents is the whole bound and nothing else; one that starts a
      // few lines early sweeps in a neighbouring constant (`SHAPE_RHO_THRESHOLD`,
      // `TAIL_FADE_SECONDS`) and stops pointing at what it claims to point at.
      expect(slice[0].trim().startsWith('/**')).toBe(true);
      expect(slice[slice.length - 1].trim()).toBe('const MIN_TAIL_FADE_MS = 2;');
      expect(prose(slice.join('\n'))).toContain('a fade-out becomes audible as a level change');
    }
  });

  it('does not read the bound as a licence to call 10 ms inaudible', () => {
    // remixRender measured where a fade-out STARTS to read as a level change.
    // That makes ~10 ms the first audible length, not the last inaudible one,
    // so nothing here may place this module's own 10 ms ramp under the bound or
    // present it as the longest ramp that stays below it.
    const text = prose(source);
    expect(text).not.toMatch(/longest[^.]{0,100}(?:audib|inaudib)/i);
    expect(text).not.toMatch(/(?:under|below|beneath)[^.]{0,60}(?:audib|inaudib)/i);
  });

  it('borrows the bound in the repo’s own words instead of promoting it to a measurement', () => {
    // remixRender states ~10 ms flatly, with no source of its own; the one
    // figure it marks as measured inside the very lines cited here belongs to a
    // DIFFERENT claim (the 1-2 sample cliff, "measured at 27x the material's own
    // slew"). The repo's other borrower of the same number says so plainly —
    // `silenceDetect.ts:71` opens "remixRender.ts documents the two anchors" —
    // so this header may not upgrade a documented rule of thumb into the app's own
    // measurement of speech-edge audibility, nor claim it is the only one there
    // is (`silenceDetect.ts` answered a neighbouring question with it already).
    const text = prose(source);
    expect(text).not.toMatch(/\bonly\b[^.]{0,60}(?:measurement|measured)/i);
    expect(text).not.toMatch(/measurement[^.]{0,60}remixRender/i);
    expect(text).toMatch(/the bound `remixRender\.ts` documents/);

    const [, from, to] = [...source.matchAll(/remixRender\.ts:(\d+)-(\d+)/g)][0];
    const cited = remixLines.slice(Number(from) - 1, Number(to)).join(' ');
    expect(cited).toContain("measured at 27x the material's own slew");
    // …and nothing in those lines calls the 10 ms figure itself measured.
    expect(cited).not.toMatch(/measured[^.]{0,40}10 ms/);
  });

  it('names the shipped 10 ms sibling rather than standing alone', () => {
    // `SPLICE_XFADE_MS` is the nearest decision this app has already taken off
    // the same anchor — a 10 ms fade written at a splice in speech material. A
    // header that omits it reads as if this constant were the app's first
    // answer to the question; naming it says the number AGREES with shipped
    // code. Cross-file pinned so the citation cannot drift off the declaration
    // it points at, exactly as the remixRender one is.
    expect(prose(source)).toContain('SPLICE_XFADE_MS');
    const cites = [...source.matchAll(/silenceDetect\.ts:(\d+)-(\d+)/g)];
    expect(cites).toHaveLength(1);
    const [, from, to] = cites[0];
    const slice = silenceLines.slice(Number(from) - 1, Number(to));
    expect(slice[0].trim().startsWith('/**')).toBe(true);
    expect(slice[slice.length - 1].trim()).toBe('export const SPLICE_XFADE_MS = 10;');
    expect(prose(slice.join('\n'))).toContain('Splice blend length, ms');
  });
});
describe('D4 keepSpans — a 1 s ramp, two overlapping spans', () => {
  // [10000, 20000) and [15000, 30000) overlap, so they are ONE kept region
  // [10000, 30000) with a ramp only at its two outer edges. Handed over out of
  // order on purpose: the merge sorts, it does not assume.
  const SPANS = [
    { startSample: 15000, endSample: 30000 },
    { startSample: 10000, endSample: 20000 },
  ];
  const FADE = 441;

  it('zeroes every sample outside the merged span, and nothing inside it', () => {
    const src = stereo(SECOND);
    const out = keepSpans(src, SPANS, RATE);

    let outsideNonZero = 0;
    let insideZero = 0;
    for (let i = 0; i < SECOND; i++) {
      const inside = i >= 10000 && i < 30000;
      for (let c = 0; c < 2; c++) {
        if (!inside && out[c][i] !== 0) outsideNonZero++;
        // The two ramp endpoints ARE zero by design, so only the interior is
        // asserted non-zero here.
        if (inside && i > 10000 && i < 29999 && out[c][i] === 0) insideZero++;
      }
    }
    expect([outsideNonZero, insideZero]).toEqual([0, 0]);
    // Not vacuous: the material that was zeroed was real audio.
    expect(src[0][0]).not.toBe(0);
    expect(src[0][40000]).not.toBe(0);
  });

  it('leaves the interior bit-identical to the source, both channels', () => {
    const src = stereo(SECOND);
    const out = keepSpans(src, SPANS, RATE);

    let compared = 0;
    let differing = 0;
    for (let i = 10000 + FADE - 1; i < 30000 - FADE; i++) {
      for (let c = 0; c < 2; c++) {
        compared++;
        if (out[c][i] !== src[c][i]) differing++;
      }
    }
    expect([compared, differing]).toEqual([2 * (30000 - FADE - (10000 + FADE - 1)), 0]);
  });

  it('merges the seam rather than fading down and up inside it', () => {
    const src = stereo(SECOND);
    const out = keepSpans(src, SPANS, RATE);

    // 15000 and 20000 are the inner ends of the two given spans. Unmerged,
    // each would carry a fade-out to zero and a fade-in from zero right here.
    for (const i of [15000, 19999, 20000, 20001]) {
      expect(out[0][i]).toBe(src[0][i]);
      expect(out[1][i]).toBe(src[1][i]);
    }
  });

  it('shapes both edges with fades.ts equal-gain ramps that terminate in silence', () => {
    const src = stereo(SECOND);
    const out = keepSpans(src, SPANS, RATE);

    let inMismatch = 0;
    let outMismatch = 0;
    for (let i = 0; i < FADE; i++) {
      const gIn = fadeInGainAt(i, FADE, 'equal-gain', 0);
      const gOut = fadeOutGainAt(i, FADE, 'equal-gain', 0);
      for (let c = 0; c < 2; c++) {
        if (out[c][10000 + i] !== Math.fround(src[c][10000 + i] * gIn)) inMismatch++;
        if (out[c][30000 - FADE + i] !== Math.fround(src[c][30000 - FADE + i] * gOut)) outMismatch++;
      }
    }
    expect([inMismatch, outMismatch]).toEqual([0, 0]);
    // The two endpoints the `singletonGain 0` convention is chosen for.
    // `Math.abs` because a NEGATIVE sample times gain 0 is `-0`, which is zero
    // (`-0 === 0`, and it stores and plays as silence) but is not `Object.is`
    // zero, which is what a bare `toEqual`/`toBe` compares with.
    expect([out[0][10000], out[1][10000], out[0][29999], out[1][29999]].map(Math.abs)).toEqual([
      0, 0, 0, 0,
    ]);
    // …and a mid-ramp gain that is neither 0 nor 1, so the ramp is a ramp.
    const g = gainEnvelope(out[0], src[0]);
    expect(g[10000 + 220]).toBeCloseTo(220 / 440, 6);
  });

  it('returns fresh arrays and never touches the source', () => {
    const src = stereo(SECOND);
    const before = src.map((c) => Float32Array.from(c));
    const out = keepSpans(src, SPANS, RATE);

    expect(out).toHaveLength(2);
    expect(out[0]).not.toBe(src[0]);
    expect(out[1]).not.toBe(src[1]);
    expect(src[0]).toEqual(before[0]);
    expect(src[1]).toEqual(before[1]);
  });

  it('merges spans that only touch, so an abutting pair has no seam either', () => {
    const src = stereo(SECOND);
    const out = keepSpans(
      src,
      [
        { startSample: 1000, endSample: 2000 },
        { startSample: 2000, endSample: 3000 },
      ],
      RATE
    );

    // Interior of the merged [1000, 3000): unity across the touch point.
    for (const i of [1441, 1999, 2000, 2001, 2558]) expect(out[0][i]).toBe(src[0][i]);
    // …and the outer edges are still the only ramps.
    expect(out[0][1000]).toBe(0);
    expect(out[0][2999]).toBe(0);
    expect(out[0][999]).toBe(0);
    expect(out[0][3000]).toBe(0);
  });
});

describe('D4 keepSpans — spans shorter than two fades', () => {
  it('compresses a 500-sample span into two 250-sample ramps that meet at unity', () => {
    const src = stereo(SECOND);
    const out = keepSpans(src, [{ startSample: 1000, endSample: 1500 }], RATE);
    const HALF = 250;

    let mismatch = 0;
    for (let i = 0; i < HALF; i++) {
      const gIn = fadeInGainAt(i, HALF, 'equal-gain', 0);
      const gOut = fadeOutGainAt(i, HALF, 'equal-gain', 0);
      for (let c = 0; c < 2; c++) {
        if (out[c][1000 + i] !== Math.fround(src[c][1000 + i] * gIn)) mismatch++;
        if (out[c][1250 + i] !== Math.fround(src[c][1250 + i] * gOut)) mismatch++;
      }
    }
    expect(mismatch).toBe(0);

    // The two ramps MEET at unity — no plateau exception, and no step.
    expect(out[0][1249]).toBe(src[0][1249]);
    expect(out[0][1250]).toBe(src[0][1250]);
    expect(out[0][1000]).toBe(0);
    expect(out[0][1499]).toBe(0);

    // No discontinuity anywhere across the span: the gain envelope never moves
    // by more than one ramp step (1/249), the two silent edges included.
    const g = gainEnvelope(out[0], src[0]);
    let worstStep = 0;
    for (let i = 999; i < 1500; i++) worstStep = Math.max(worstStep, Math.abs(g[i + 1] - g[i]));
    expect(worstStep).toBeLessThanOrEqual(1 / (HALF - 1) + 1e-6);
  });

  it('takes a two-sample span to silence rather than leaving a step', () => {
    const src = stereo(SECOND);
    const out = keepSpans(src, [{ startSample: 700, endSample: 702 }], RATE);
    expect([out[0][700], out[0][701]]).toEqual([0, 0]);
  });

  it('does not throw on a one-sample span, and leaves no lone unity sample', () => {
    const src = stereo(SECOND);
    const out = keepSpans(src, [{ startSample: 700, endSample: 701 }], RATE);
    expect(out[0][700]).toBe(0);
  });
});

describe('D4 keepSpans — the ramp floor, where a compressed ramp stops being a ramp', () => {
  it('is three samples: shorter than that an equal-gain ramp has no interior value', () => {
    expect(MIN_EDGE_RAMP_SAMPLES).toBe(3);
    // WHY the floor is exactly here, read off the shipped curve rather than
    // asserted: a two-sample ramp is [0, 1] — its second sample is already at
    // FULL scale next to the silence — while a three-sample ramp has 0.5 in
    // between, so it is the shortest one that actually ramps.
    expect([0, 1].map((i) => fadeInGainAt(i, 2, 'equal-gain', 0))).toEqual([0, 1]);
    expect([0, 1, 2].map((i) => fadeInGainAt(i, MIN_EDGE_RAMP_SAMPLES, 'equal-gain', 0))).toEqual([
      0, 0.5, 1,
    ]);
  });

  it('silences every span below two whole ramps — the 3-, 4- and 5-sample cases', () => {
    const src = stereo(SECOND);
    for (const span of [3, 4, 5]) {
      const out = keepSpans(src, [{ startSample: 700, endSample: 700 + span }], RATE);
      // Not a plateau at unity between two zeros: the whole span is silence.
      expect(Array.from(out[0].subarray(699, 700 + span + 1)).map(Math.abs)).toEqual(
        new Array(span + 2).fill(0)
      );
      // Not vacuous — this is real, non-zero material being taken out.
      expect(src[0][701]).not.toBe(0);
    }
  });

  it('keeps a six-sample span — two whole ramps at the floor, meeting at unity', () => {
    const src = stereo(SECOND);
    const START = 700;
    const out = keepSpans(src, [{ startSample: START, endSample: START + 6 }], RATE);
    const N = MIN_EDGE_RAMP_SAMPLES;

    let mismatch = 0;
    for (let i = 0; i < N; i++) {
      const gIn = fadeInGainAt(i, N, 'equal-gain', 0);
      const gOut = fadeOutGainAt(i, N, 'equal-gain', 0);
      for (let c = 0; c < 2; c++) {
        if (out[c][START + i] !== Math.fround(src[c][START + i] * gIn)) mismatch++;
        if (out[c][START + N + i] !== Math.fround(src[c][START + N + i] * gOut)) mismatch++;
      }
    }
    expect(mismatch).toBe(0);
    // The ramps meet at unity in the middle and terminate in silence at both
    // edges — audio survives here, unlike the five-sample span above.
    expect(out[0][START + 2]).toBe(src[0][START + 2]);
    expect(out[0][START + 3]).toBe(src[0][START + 3]);
    expect([out[0][START], out[0][START + 5]].map(Math.abs)).toEqual([0, 0]);
  });

  it('never steps by more than one ramp step, at any span length around the floor', () => {
    const src = stereo(SECOND);
    const START = 700;
    // 1/(N-1) = 0.5 is the coarsest step the floor allows; a full-scale step of
    // 1 is the click this module exists to remove, and D4 forbids it outright.
    const WORST_ALLOWED = 1 / (MIN_EDGE_RAMP_SAMPLES - 1);
    const offenders: number[] = [];
    for (let span = 1; span <= 12; span++) {
      const out = keepSpans(src, [{ startSample: START, endSample: START + span }], RATE);
      const g = gainEnvelope(out[0], src[0]);
      let worst = 0;
      for (let i = START - 1; i <= START + span; i++) worst = Math.max(worst, Math.abs(g[i + 1] - g[i]));
      if (worst > WORST_ALLOWED + 1e-6) offenders.push(span);
    }
    expect(offenders).toEqual([]);
  });
});

describe('D4 keepSpans — degenerate input', () => {
  it('returns all-zero channels when no span is kept', () => {
    const src = stereo(1000);
    const out = keepSpans(src, [], RATE);
    expect(out[0]).toEqual(new Float32Array(1000));
    expect(out[1]).toEqual(new Float32Array(1000));
  });

  it('drops empty and reversed spans instead of throwing', () => {
    const src = stereo(1000);
    const out = keepSpans(
      src,
      [
        { startSample: 400, endSample: 400 },
        { startSample: 600, endSample: 500 },
      ],
      RATE
    );
    expect(out[0]).toEqual(new Float32Array(1000));
  });

  it('clamps a span that runs past the buffer instead of writing past its end', () => {
    const src = stereo(1000);
    const out = keepSpans(src, [{ startSample: -500, endSample: 5000 }], RATE);

    expect(out[0]).toHaveLength(1000);
    // The clamped span is [0, 1000): 1000 samples, longer than 2 × 441, so it
    // keeps two full 441-sample ramps and a unity interior between them.
    expect(out[0][0]).toBe(0);
    expect(out[0][999]).toBe(0);
    expect(out[0][440]).toBe(src[0][440]);
    expect(out[0][558]).toBe(src[0][558]);
    expect(out[0][560]).not.toBe(src[0][560]);
  });

  it('returns no channels for no channels', () => {
    expect(keepSpans([], [{ startSample: 0, endSample: 10 }], RATE)).toEqual([]);
  });
});
