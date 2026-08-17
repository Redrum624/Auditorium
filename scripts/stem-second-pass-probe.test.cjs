'use strict';

// V4 fix round 1 — the pin the probe's comment used to only PROMISE.
//
// `scripts/stem-second-pass-probe.cjs` measures a Vocals stem it identifies by
// position, and the position depends on two orderings it does not own: the
// app's label order (`stemService.ts`) and the host's output order
// (`electron/stemSegmentation.cjs`). The host's order it imports. The label
// list it must repeat — `stemService.ts` cannot be required from a plain-node
// script (it pulls in the whole renderer store graph) and the swap between the
// two orders is module-private there.
//
// Unpinned, that repetition is the repo's recurring claims-vs-code defect with
// a verdict attached: change the label order or the host order and a re-run
// would measure the Other stem as Vocals, find "no ghost to remove", and commit
// a confident wrong answer to `docs/bench/`. Nothing about the JSON would look
// off — which is exactly why it needs a test rather than a reader.
//
// Both files are read as SOURCE TEXT, the `electron/prodGate.test.cjs` idiom
// for a module a test cannot require. `stemSegmentation.cjs` is plain CJS with
// no dependencies, so that one is required for real.

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { STEM_NAMES } = require('../electron/stemSegmentation.cjs');

const ROOT = path.resolve(__dirname, '..');
const PROBE = path.join(ROOT, 'scripts', 'stem-second-pass-probe.cjs');
const SERVICE = path.join(ROOT, 'src', 'services', 'stemService.ts');

const probeSource = fs.readFileSync(PROBE, 'utf8');
const serviceSource = fs.readFileSync(SERVICE, 'utf8');

/**
 * The array literal a `const <name> = [ … ]` declaration holds, as raw
 * elements. Requires EXACTLY ONE such declaration: zero means the thing being
 * pinned was renamed or reshaped (which must fail here rather than pass
 * vacuously), and two means this helper is reading the wrong one.
 */
function arrayLiteral(source, name, where) {
  const all = [...source.matchAll(new RegExp(`const ${name}\\s*(?::[^=]*)?=\\s*\\[([^\\]]*)\\]`, 'g'))];
  expect(`${where}: ${all.length} declaration(s) of ${name}`).toBe(
    `${where}: 1 declaration(s) of ${name}`
  );
  return all[0][1]
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

const stringsOf = (elements) => elements.map((s) => s.replace(/^['"]|['"]$/g, ''));
const numbersOf = (elements) => elements.map(Number);

describe('stem-second-pass-probe.cjs — the stem order it repeats is the app\'s', () => {
  const probeLabels = stringsOf(arrayLiteral(probeSource, 'STEM_LABELS', 'probe'));
  const serviceLabels = stringsOf(arrayLiteral(serviceSource, 'STEM_LABELS', 'stemService'));

  it('repeats stemService\'s label list exactly, order included', () => {
    // Order is the whole point — a set comparison would pass on the very swap
    // that breaks the measurement.
    expect(probeLabels).toEqual(serviceLabels);
    expect(serviceLabels).toEqual(['Drums', 'Bass', 'Vocals', 'Other']);
  });

  it('derives the host swap rather than repeating it, and derives stemService\'s', () => {
    // The probe computes this from the two orderings; the service holds it as a
    // literal. They must agree, or the probe hands `partitionStems` the model's
    // estimates under the wrong names.
    const derived = probeLabels.map((label) => STEM_NAMES.indexOf(label.toLowerCase()));
    const serviceSwap = numbersOf(arrayLiteral(serviceSource, 'HOST_INDEX_FOR_LABEL', 'stemService'));
    expect(derived).toEqual(serviceSwap);
    expect(derived).toEqual([0, 1, 3, 2]);

    // …and it really is derived: a literal swap in the probe would pass the
    // assertion above while going stale the moment the host's order changed.
    expect(probeSource).toContain('STEM_NAMES.indexOf(label.toLowerCase())');
    expect(probeSource).not.toMatch(/HOST_INDEX_FOR_LABEL\s*=\s*\[/);
  });

  it('finds the Vocals stem at a position the host actually emits', () => {
    expect(probeLabels.indexOf('Vocals')).toBe(2);
    for (const label of probeLabels) {
      expect(STEM_NAMES).toContain(label.toLowerCase());
    }
    expect(STEM_NAMES).toHaveLength(probeLabels.length);
  });
});

describe('stem-second-pass-probe.cjs — the rig checks its own foundation', () => {
  it('ENFORCES the exact-sum law and the identity rather than only recording them', () => {
    // The committed verdict shows 0 ULP / 100 % bit-exact / <= -153.83 dB, so
    // these bounds carry real headroom; what they buy is that a BROKEN rig
    // cannot print a go/no-go at all.
    expect(probeSource).toMatch(/const EXACT_SUM_MAX_ULPS = 2;/);
    expect(probeSource).toMatch(/const EXACT_SUM_MIN_EXACT_FRACTION = 0\.99;/);
    expect(probeSource).toMatch(/const IDENTITY_MAX_RMS_DB = -120;/);
    expect(probeSource).toMatch(/throw new Error\(\s*`exact-sum law broken/);
    expect(probeSource).toMatch(/throw new Error\(\s*`identity broken/);
  });

  it('states its decision gate as constants, so the gate cannot be a story', () => {
    // The gate has to be readable next to the verdict it produced: these are
    // the three numbers `docs/bench/stem-second-pass-rejected.json` echoes back
    // under `gate`, and a reader comparing them is the only check there is that
    // the thresholds were not chosen after the fact.
    const verdict = JSON.parse(
      fs.readFileSync(path.join(ROOT, 'docs', 'bench', 'stem-second-pass-rejected.json'), 'utf8')
    );
    expect(verdict.gate.improvementRequiredDb).toBe(3);
    expect(verdict.gate.bedLevelToleranceDb).toBe(1);
    expect(verdict.gate.damageBelowBedRequiredDb).toBe(20);
    expect(probeSource).toMatch(/const IMPROVEMENT_REQUIRED_DB = 3\.0;/);
    expect(probeSource).toMatch(/const BED_LEVEL_TOLERANCE_DB = 1\.0;/);
    expect(probeSource).toMatch(/const DAMAGE_BELOW_BED_REQUIRED_DB = 20\.0;/);

    // And the verdict it committed is the NO-GO one, decided by that gate.
    expect(verdict.ok).toBe(true);
    expect(verdict.go).toBe(false);
    expect(verdict.gate.improved).toBe(false);
    expect(verdict.gate.harmless).toBe(true);
  });

  it('writes NO verdict file and exits nonzero when it cannot measure', () => {
    // The half of the enforcement contract that can be executed without the
    // model: whatever the probe refuses on, it refuses by failing — it never
    // leaves a verdict file behind for a run that did not complete. (The
    // bound checks themselves sit behind four real inference passes, so they
    // are guarded above by source rather than by execution.)
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'second-pass-probe-'));
    const out = path.join(tmp, 'must-not-exist.json');
    let status = 0;
    let stdout = '';
    try {
      stdout = execFileSync(
        process.execPath,
        [
          PROBE,
          `--model=${path.join(tmp, 'no-such-model.onnx')}`,
          `--bed=${path.join(tmp, 'no-such-bed.f32')}`,
          `--mix=${path.join(tmp, 'no-such-mix.f32')}`,
          '--samples=1000',
          `--out=${out}`,
        ],
        { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
      );
    } catch (err) {
      status = err.status;
      stdout = String(err.stdout);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
    }
    expect(status).not.toBe(0);
    expect(JSON.parse(stdout.trim().split('\n').pop()).ok).toBe(false);
    expect(fs.existsSync(out)).toBe(false);
  });

  it('committed a verdict that would PASS the bounds the probe now enforces', () => {
    const verdict = JSON.parse(
      fs.readFileSync(path.join(ROOT, 'docs', 'bench', 'stem-second-pass-rejected.json'), 'utf8')
    );
    for (const e of Object.values(verdict.exactSum)) {
      expect(e.worstUlps).toBeLessThanOrEqual(2);
      expect(e.exactFraction).toBeGreaterThanOrEqual(0.99);
    }
    for (const rms of Object.values(verdict.checks)) {
      expect(rms).toBeLessThanOrEqual(-120);
    }
  });
});

describe('the shipped figures and the committed verdict are the same numbers', () => {
  it('renders the verdict\'s improvement into coverChain\'s two constants', () => {
    // The user-facing sentence is built from `RESIDUAL_SECOND_PASS_DB` and
    // `RESIDUAL_SECOND_PASS_WORST_OCTAVE_DB`. `coverChain.test.ts` pins those
    // against literals and against the sentence; nothing pinned them against
    // the MEASUREMENT they claim to come from, which is the gap that lets a
    // re-measurement land in docs/bench and never reach the copy.
    const verdict = JSON.parse(
      fs.readFileSync(path.join(ROOT, 'docs', 'bench', 'stem-second-pass-rejected.json'), 'utf8')
    );
    const chain = fs.readFileSync(path.join(ROOT, 'src', 'services', 'coverChain.ts'), 'utf8');
    const constant = (name) => {
      const m = new RegExp(`export const ${name} = (-?[0-9.]+);`).exec(chain);
      expect(m).not.toBeNull();
      return Number(m[1]);
    };
    expect(constant('RESIDUAL_SECOND_PASS_DB')).toBe(verdict.gate.improvementDb);
    const worstOctave = Math.max(
      ...verdict.ghost.improvementPerOctaveDb.map((v) => Math.abs(v))
    );
    expect(constant('RESIDUAL_SECOND_PASS_WORST_OCTAVE_DB')).toBe(Number(worstOctave.toFixed(2)));
  });
});
