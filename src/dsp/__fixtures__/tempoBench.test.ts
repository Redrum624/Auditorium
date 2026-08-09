import {
  BANK_SAMPLE_RATE,
  buildBank,
  classifyAtempo,
  classifyBpm,
  runBench,
} from './tempoBench';
import type { DetectFn } from './tempoBench';
import { analyzeTempo, CONFIDENCE_LOW } from '../tempoCore';
import { jitterClickTrain, jitterDrumLoop } from './tempoFixtures';

// R4 harness self-tests. The same rule that binds every measurement in this
// project binds the harness itself: if a deliberately broken detector still
// scores well, the harness measures nothing. These tests prove (a) the
// classifier's boundaries sit exactly where the doc says, per operand role,
// (b) the bank is the documented, deterministic composition, and (c) a
// broken detector scores STRICTLY worse — the harness can see a regression.

describe('tempoBench classifyBpm — boundary probes per operand role', () => {
  // CORRECT band around truth=100 at ±4%: [96, 104], ON-edge inside.
  it('reported-bpm operand: below/on/above each edge of the correct band', () => {
    expect(classifyBpm(95.99, 100)).toBe('other'); // just below lower edge
    expect(classifyBpm(96, 100)).toBe('correct'); // on lower edge
    expect(classifyBpm(100, 100)).toBe('correct'); // centre
    expect(classifyBpm(104, 100)).toBe('correct'); // on upper edge
    expect(classifyBpm(104.01, 100)).toBe('other'); // just above upper edge
  });

  // OCTAVE ×2 band around 200: [192, 208].
  it('reported-bpm operand: below/on/above each edge of the x2 octave band', () => {
    expect(classifyBpm(191.99, 100)).toBe('other');
    expect(classifyBpm(192, 100)).toBe('octave');
    expect(classifyBpm(200, 100)).toBe('octave');
    expect(classifyBpm(208, 100)).toBe('octave');
    expect(classifyBpm(208.01, 100)).toBe('other');
  });

  // OCTAVE ÷2 band around 50: [48, 52].
  it('reported-bpm operand: below/on/above each edge of the /2 octave band', () => {
    expect(classifyBpm(47.99, 100)).toBe('other');
    expect(classifyBpm(48, 100)).toBe('octave');
    expect(classifyBpm(50, 100)).toBe('octave');
    expect(classifyBpm(52, 100)).toBe('octave');
    expect(classifyBpm(52.01, 100)).toBe('other');
  });

  it('trueBpm operand: the SAME reported value classifies differently as truth moves', () => {
    expect(classifyBpm(120, 120)).toBe('correct');
    expect(classifyBpm(120, 60)).toBe('octave'); // 120 = 60 x 2
    expect(classifyBpm(120, 240)).toBe('octave'); // 120 = 240 / 2
    expect(classifyBpm(120, 80)).toBe('other'); // 1.5x is NOT counted as octave
    expect(classifyBpm(120, 180)).toBe('other'); // 2/3 is NOT counted as octave
  });

  it('degenerate reports are other, never correct', () => {
    expect(classifyBpm(null, 100)).toBe('other');
    expect(classifyBpm(Number.NaN, 100)).toBe('other');
    expect(classifyBpm(Number.POSITIVE_INFINITY, 100)).toBe('other');
  });
});

describe('tempoBench classifyAtempo — boundary probes', () => {
  it('confidence operand: below/on/above CONFIDENCE_LOW (strictly-below contract)', () => {
    expect(classifyAtempo(120, CONFIDENCE_LOW - 0.001)).toBe('correct');
    expect(classifyAtempo(120, CONFIDENCE_LOW)).toBe('other'); // ON threshold = a claim
    expect(classifyAtempo(120, CONFIDENCE_LOW + 0.001)).toBe('other');
  });

  it('reported-bpm operand: a null report is correct regardless of confidence', () => {
    expect(classifyAtempo(null, 0)).toBe('correct');
    expect(classifyAtempo(null, 1)).toBe('correct');
  });
});

describe('tempoBench bank — documented composition', () => {
  it('is exactly the documented 83-fixture composition with unique ids', () => {
    const bank = buildBank();
    expect(bank.length).toBe(83);
    const perFamily = new Map<string, number>();
    for (const f of bank) perFamily.set(f.family, (perFamily.get(f.family) ?? 0) + 1);
    expect(Object.fromEntries(perFamily)).toEqual({
      click: 10,
      rise: 4,
      drum: 20,
      backbeat: 6,
      ramp: 3,
      'jitter-click': 28,
      'jitter-drum': 9,
      atempo: 3,
    });
    expect(new Set(bank.map((f) => f.id)).size).toBe(bank.length);
    // Every rhythm truth sits inside the detector's 60-200 search range, so
    // "correct" is reachable for every fixture; atempo fixtures carry null.
    for (const f of bank) {
      if (f.family === 'atempo') expect(f.trueBpm).toBeNull();
      else {
        expect(f.trueBpm).not.toBeNull();
        expect(f.trueBpm as number).toBeGreaterThanOrEqual(60);
        expect(f.trueBpm as number).toBeLessThanOrEqual(200);
      }
    }
  });

  it('jittered generators are seed-deterministic (same args => identical samples)', () => {
    const a = jitterClickTrain(120, 5, 0.07, 7013, BANK_SAMPLE_RATE);
    const b = jitterClickTrain(120, 5, 0.07, 7013, BANK_SAMPLE_RATE);
    expect(Array.from(a)).toEqual(Array.from(b));
    // A different seed must actually change the jitter (the parameter is live).
    const c = jitterClickTrain(120, 5, 0.07, 7026, BANK_SAMPLE_RATE);
    expect(Array.from(c)).not.toEqual(Array.from(a));
    const d1 = jitterDrumLoop(90, 5, 0.3, 0.06, 7091, BANK_SAMPLE_RATE);
    const d2 = jitterDrumLoop(90, 5, 0.3, 0.06, 7091, BANK_SAMPLE_RATE);
    expect(Array.from(d1)).toEqual(Array.from(d2));
  });
});

describe('tempoBench runBench — measures something (anti-vacuity)', () => {
  // A small always-correct subset: click-100/click-120 are pinned correct by
  // the ACCURACY acceptance tests, so the real detector MUST score 2/2 here.
  const subset = () => buildBank().filter((f) => f.id === 'click-100' || f.id === 'click-120');
  const atempoSubset = () => buildBank().filter((f) => f.family === 'atempo');

  it('two runs of the same subset produce deep-equal reports (determinism)', () => {
    const r1 = runBench(subset());
    const r2 = runBench(subset());
    expect(r2).toEqual(r1);
  });

  it('a deliberately octave-doubling detector scores STRICTLY worse', () => {
    const real = runBench(subset());
    expect(real.aggregate.correct).toBe(2);

    const doubling: DetectFn = (mono, sampleRate) => {
      const a = analyzeTempo(mono, sampleRate);
      return { ...a, bpm: a.bpm === null ? null : a.bpm * 2 };
    };
    const broken = runBench(subset(), doubling);
    expect(broken.aggregate.correct).toBeLessThan(real.aggregate.correct);
    expect(broken.aggregate.octave).toBeGreaterThan(real.aggregate.octave);
    expect(broken.aggregate.correct + broken.aggregate.octave + broken.aggregate.other).toBe(2);
  });

  it('an overconfident fixed-bpm detector loses the atempo fixtures', () => {
    const real = runBench(atempoSubset());
    expect(real.aggregate.correct).toBe(3); // pinned by the CONFIDENCE tests

    const overconfident: DetectFn = (mono, sampleRate) => {
      const a = analyzeTempo(mono, sampleRate);
      return { ...a, bpm: 120, confidence: 1 };
    };
    const broken = runBench(atempoSubset(), overconfident);
    expect(broken.aggregate.correct).toBe(0);
    expect(broken.aggregate.other).toBe(3);
  });
});
