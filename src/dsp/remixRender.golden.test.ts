/**
 * THE AUTO-REMIX GOLDEN PIN (v1.9 X1, ruling 9 / trap T1).
 *
 * ## Why this file exists
 *
 * `remixRender.test.ts` is thorough about PROPERTIES -- power preservation,
 * monotonic envelopes, slew bounds, length identities -- and pins no rendered
 * SAMPLE against a stored expectation. Its strongest array-equality assertion
 * compares two live renders taken in the same run to each other, which two
 * identically-wrong renders satisfy just as happily as two correct ones. So
 * "the refactor left auto-remix byte-identical" was, before this file, an
 * unfalsifiable claim.
 *
 * This file makes it falsifiable: four deterministic renders, every sample of
 * every channel digested bit-for-bit, plus exact stored values at probe
 * indices inside each fade and crossfade region. A one-ulp change anywhere in
 * the gain math fails the digest; the probes then say where.
 *
 * The four cases together drive every gain-shaping path the renderer has --
 * both crossfade shapes at the quarter-beat width cap (trap T48), the 1500 ms
 * quarter-cosine tail fade, the 5 ms exact-trim fade on sliced copies, and
 * the tail-overflow taper that ends at an arbitrary position. See
 * `__fixtures__/remixGoldenCases.ts` for what each one covers and why.
 *
 * ## For later tasks
 *
 * X3 (the clip envelope) and X5 (same-track overlap) edit DSP that auto-remix
 * shares. Neither of them should change auto-remix output. If a change here
 * goes red, that is the finding -- regenerating the fixture to make it green
 * discards the only regression net auto-remix has.
 *
 * ## Regenerating (deliberately awkward)
 *
 *     REMIX_GOLDEN_PRINT=1 npx jest src/dsp/remixRender.golden.test.ts
 *
 * prints two ready-to-paste blocks — `REMIX_GOLDEN` (rendered audio) and
 * `CROSSFADE_GAINS_GOLDEN` (the double-precision gain table) — and then
 * deliberately THROWS (the single registered test is named 'FAILS ON
 * PURPOSE'), so a print run can never exit green with every comparison
 * disarmed (X1 round 1: a stray `REMIX_GOLDEN_PRINT` in a shell or CI job
 * must read as a failure, not a pass). Paste the printed blocks into
 * `src/dsp/__fixtures__/remixGolden.ts`, unset the env var, re-run to verify
 * — only when rendered output was MEANT to move, and commit the regeneration
 * on its own with the reason.
 */
import { renderRemix, effectiveCrossfadeMs, crossfadeGains } from './remixRender';
import { goldenCases, crossfadeGainsGrid, GOLDEN_SR } from './__fixtures__/remixGoldenCases';
import type { GoldenCase } from './__fixtures__/remixGoldenCases';
import { REMIX_GOLDEN, CROSSFADE_GAINS_GOLDEN } from './__fixtures__/remixGolden';
import type { RemixGoldenCase, CrossfadeGainsGoldenRow } from './__fixtures__/remixGolden';
import { float32Digest, numberLiteral } from './__fixtures__/float32Digest';

const PRINT_MODE = process.env.REMIX_GOLDEN_PRINT === '1';

/** Probe indices for one render: 32 evenly spread across the whole output
 * (so a change anywhere shows up as a value, not only as a digest miss), the
 * last 8 samples (where every end-anchored fade lands), and a 16-sample
 * window centred on each join (where the crossfade lands). Derived from the
 * render's own reported join positions at GENERATION time and then STORED --
 * at assert time they are literals, never recomputed, so a renderer that
 * moved its joins fails rather than quietly re-aiming the probes. */
function probeIndicesFor(sampleCount: number, joinSamples: readonly number[]): number[] {
  const set = new Set<number>();
  for (let j = 0; j < 32; j++) set.add(Math.floor((sampleCount * j) / 32));
  for (let k = 8; k >= 1; k--) set.add(sampleCount - k);
  for (const centre of joinSamples) {
    for (let d = -8; d < 8; d++) {
      const i = centre + d;
      if (i >= 0 && i < sampleCount) set.add(i);
    }
  }
  return [...set].sort((a, b) => a - b);
}

function renderCase(c: GoldenCase): ReturnType<typeof renderRemix> {
  return renderRemix(c.source, c.analysis, c.plan, c.opts);
}

function generate(c: GoldenCase): RemixGoldenCase {
  const result = renderCase(c);
  const probeIndices = probeIndicesFor(result.channels[0].length, result.joinSamples);
  return {
    name: c.name,
    channelCount: result.channels.length,
    sampleCount: result.channels[0].length,
    digests: result.channels.map(float32Digest),
    joinSamples: result.joinSamples,
    nudgeSamples: result.nudgeSamples,
    shapes: result.shapes,
    probeIndices,
    probeValues: result.channels.map((ch) => probeIndices.map((i) => ch[i])),
  };
}

function printFixture(cases: RemixGoldenCase[]): void {
  const lines: string[] = ['export const REMIX_GOLDEN: readonly RemixGoldenCase[] = ['];
  for (const g of cases) {
    lines.push('  {');
    lines.push(`    name: ${JSON.stringify(g.name)},`);
    lines.push(`    channelCount: ${g.channelCount},`);
    lines.push(`    sampleCount: ${g.sampleCount},`);
    lines.push(`    digests: [${g.digests.map((d) => JSON.stringify(d)).join(', ')}],`);
    lines.push(`    joinSamples: [${g.joinSamples.join(', ')}],`);
    lines.push(`    nudgeSamples: [${g.nudgeSamples.join(', ')}],`);
    lines.push(`    shapes: [${g.shapes.map((s) => JSON.stringify(s)).join(', ')}],`);
    lines.push(`    probeIndices: [${g.probeIndices.join(', ')}],`);
    lines.push('    probeValues: [');
    for (const ch of g.probeValues) {
      lines.push(`      [${ch.map(numberLiteral).join(', ')}],`);
    }
    lines.push('    ],');
    lines.push('  },');
  }
  lines.push('];');
  // eslint-disable-next-line no-console
  console.log(`\n===== paste over REMIX_GOLDEN in src/dsp/__fixtures__/remixGolden.ts =====\n${lines.join('\n')}\n===== end =====\n`);
}

function generateGainRows(): CrossfadeGainsGoldenRow[] {
  return crossfadeGainsGrid().map(({ t, rho }) => {
    const { gOut, gIn } = crossfadeGains(t, rho);
    return [t, rho, gOut, gIn] as CrossfadeGainsGoldenRow;
  });
}

function printGainFixture(rows: readonly CrossfadeGainsGoldenRow[]): void {
  const body = rows.map((r) => `  [${r.map(numberLiteral).join(', ')}],`).join('\n');
  // eslint-disable-next-line no-console
  console.log(
    `\n===== paste over CROSSFADE_GAINS_GOLDEN in src/dsp/__fixtures__/remixGolden.ts =====\n` +
      `export const CROSSFADE_GAINS_GOLDEN: readonly CrossfadeGainsGoldenRow[] = [\n${body}\n];\n===== end =====\n`
  );
}

describe('renderRemix -- golden pin (bit-exact, against a stored fixture)', () => {
  const cases = goldenCases();

  if (PRINT_MODE) {
    // DELIBERATELY FAILS. Print mode disarms every assertion in this file,
    // and this file is the only thing standing between a shared-DSP edit and
    // a silently changed auto-remix. If it could exit 0, an inherited or
    // stray `REMIX_GOLDEN_PRINT` in a shell, a CI job or an editor's test
    // runner would turn the pin off and the run would still read as a pass --
    // the exact shape of failure the pin exists to prevent. Regeneration is a
    // deliberate act with a red run attached; the fixture is printed first,
    // so the workflow still works.
    it('FAILS ON PURPOSE: print mode regenerated the fixture and verified nothing', () => {
      printFixture(cases.map(generate));
      printGainFixture(generateGainRows());
      throw new Error(
        'REMIX_GOLDEN_PRINT=1 was set, so the golden pin did NOT run -- the fixture above was ' +
          'regenerated and NOTHING was verified. This failure is intentional: a green run must ' +
          'never be possible with the pin disarmed. Paste the printed blocks into ' +
          'src/dsp/__fixtures__/remixGolden.ts, unset REMIX_GOLDEN_PRINT, and re-run to verify.'
      );
    }, 60000);
    return;
  }

  // The gain law at DOUBLE precision. The rendered-audio pins below cannot
  // see this: every crossfaded sample is stored into a `Float32Array`, which
  // discards 29 mantissa bits, so a reassociation of `k` or a hoisted `1/k`
  // changes thousands of gains and not one rendered sample (measured -- see
  // `crossfadeGainsGrid`). X3 and X5 consume the law directly, in double
  // precision, so it gets its own pin.
  describe('crossfadeGains -- double-precision golden table', () => {
    it('covers the whole stored grid', () => {
      expect(CROSSFADE_GAINS_GOLDEN.length).toBe(crossfadeGainsGrid().length);
      expect(CROSSFADE_GAINS_GOLDEN.length).toBeGreaterThan(100);
    });

    it('returns exactly the stored gain for every (t, rho) in the grid', () => {
      const mismatches: string[] = [];
      for (const [t, rho, gOut, gIn] of CROSSFADE_GAINS_GOLDEN) {
        const actual = crossfadeGains(t, rho);
        if (!Object.is(actual.gOut, gOut) || !Object.is(actual.gIn, gIn)) {
          mismatches.push(`t=${t} rho=${rho}: got (${actual.gOut}, ${actual.gIn}), golden (${gOut}, ${gIn})`);
        }
      }
      expect(mismatches).toEqual([]);
    });
  });

  it('pins every case the fixture stores, and stores every case the suite renders', () => {
    expect(REMIX_GOLDEN.map((g) => g.name).sort()).toEqual(cases.map((c) => c.name).sort());
  });

  for (const c of cases) {
    describe(c.name, () => {
      const golden = REMIX_GOLDEN.find((g) => g.name === c.name);
      const result = renderCase(c);

      // --- fixture sanity: the case still covers the path it was written for.
      // Without these a well-meaning edit to the geometry could leave the pin
      // green while it silently stopped exercising the cap, the taper, or the
      // branch it was built to protect.

      it('renders the crossfade shape the case was built to exercise', () => {
        expect(result.shapes).toEqual([...c.expect.shapes]);
      });

      if (c.expect.requestedMsAboveCap !== undefined) {
        const requested = c.expect.requestedMsAboveCap;
        it('genuinely exercises the quarter-beat width cap (T48), not just the ms slider', () => {
          const capMs = effectiveCrossfadeMs(requested, c.analysis.beatSamples, GOLDEN_SR);
          expect(capMs).toBeLessThan(requested);
          // ...and the cap is what the renderer applied: re-rendering AT the
          // cap must reproduce this render exactly.
          const atCap = renderRemix(c.source, c.analysis, c.plan, { ...c.opts, crossfadeMs: capMs });
          expect(atCap.channels[0]).toEqual(result.channels[0]);
        }, 30000);
      }

      const taper = c.expect.tailTaper;
      if (taper) {
        it('genuinely exercises the tail-overflow taper', () => {
          const { overflowSamples, fadeLen } = taper;
          const ch = result.channels[0];
          const n = ch.length;
          // Forward alignment really happened -- the overflow is the lag.
          expect(result.nudgeSamples[0]).toBe(overflowSamples);
          // The overflow itself read past the end of source, so it is silence
          // the renderer never has to fade.
          for (let i = n - overflowSamples; i < n; i++) expect(ch[i]).toBe(0);
          // The taper's whole point: the real audio meets that silence at
          // exactly zero (no step), having started from unattenuated content
          // (so it is a ramp across real audio, not a hard zeroing).
          // `Math.abs` because the final gain is exactly 0 and a negative
          // source sample times 0 is -0 -- a real value the golden probes
          // pin as -0, but not a level difference.
          expect(Math.abs(ch[n - overflowSamples - 1])).toBe(0);
          expect(Math.abs(ch[n - overflowSamples - fadeLen])).toBeGreaterThan(1e-3);
        });
      }

      if (c.expect.quarterCosineTailFade) {
        it('genuinely exercises the 1500 ms quarter-cosine tail fade, without it swallowing the whole buffer', () => {
          const fadeLen = Math.round(1.5 * GOLDEN_SR);
          expect(result.channels[0].length).toBeGreaterThan(fadeLen);
          const ch = result.channels[0];
          expect(Math.abs(ch[ch.length - 1])).toBeLessThan(1e-3);
        });
      }

      // --- the pin itself.

      it('matches the stored golden bit-for-bit', () => {
        expect(golden).toBeDefined();
        if (!golden) return;
        expect(result.channels.length).toBe(golden.channelCount);
        expect(result.channels[0].length).toBe(golden.sampleCount);
        expect(result.joinSamples).toEqual([...golden.joinSamples]);
        expect(result.nudgeSamples).toEqual([...golden.nudgeSamples]);
        expect(result.shapes).toEqual([...golden.shapes]);
        expect(result.channels.map(float32Digest)).toEqual([...golden.digests]);
      });

      it('matches the stored sample values exactly at every probe index', () => {
        expect(golden).toBeDefined();
        if (!golden) return;
        expect(golden.probeIndices.length).toBeGreaterThan(32);

        // `Object.is`, not `toBeCloseTo`: a one-ulp drift is exactly what
        // this has to fail on, and `Object.is` also separates -0 from +0
        // (a sign flip on a silent sample is still a changed render).
        // Mismatches are collected rather than thrown one at a time so a
        // failure reports the whole affected region, not just its first
        // sample.
        const mismatches: string[] = [];
        for (let ch = 0; ch < golden.probeValues.length; ch++) {
          const channel = result.channels[ch];
          const expectedValues = golden.probeValues[ch];
          for (let k = 0; k < golden.probeIndices.length; k++) {
            const index = golden.probeIndices[k];
            if (!Object.is(channel[index], expectedValues[k])) {
              mismatches.push(`ch${ch}[${index}]: got ${channel[index]}, golden ${expectedValues[k]}`);
            }
          }
        }
        expect(mismatches).toEqual([]);
      });
    });
  }
});
