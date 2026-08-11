'use strict';

// R4b fix round 1 (I7): pins that the plan golden is actually REPRODUCIBLE
// from the repo, and that its stated provenance is true.
//
// `src/dsp/remixPlan.test.ts` asserts the shipped planner reproduces
// `remixPlanGolden.ts`. It cannot assert where those numbers CAME from — and
// the whole value of that golden is that they came from the planner at
// `5dfa19d`, before `requiredJoins` existed. This file closes that gap by
// running the committed generator out-of-process, exactly as a reader of the
// fixture header would.

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const GEN = path.join(ROOT, 'scripts', 'gen-remix-plan-golden.cjs');
const GOLDEN = path.join(ROOT, 'src', 'dsp', '__fixtures__', 'remixPlanGolden.ts');
/** The revision the fixture header claims the numbers came from. */
const PROVENANCE_REV = '5dfa19d';

function run(args) {
  return execFileSync(process.execPath, [GEN, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** Just the data rows — the header carries the revision it was generated
 * from, so comparing whole files across revisions would compare the label
 * rather than the numbers. */
function cases(text) {
  const start = text.indexOf('export const REMIX_PLAN_GOLDEN');
  if (start < 0) throw new Error('generated file has no REMIX_PLAN_GOLDEN export');
  return text.slice(start).replace(/\r\n/g, '\n');
}

describe('gen-remix-plan-golden.cjs', () => {
  let tmpDir;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'remix-golden-test-'));
  });
  afterAll(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('the committed golden really is what the planner at 5dfa19d produces', () => {
    // The provenance claim in the fixture header, as a check rather than a
    // sentence. If this fails, either the golden was hand-edited or the
    // fixture matrix moved — both of which invalidate the inertness argument
    // the golden exists to support.
    const out = run([`--from=${PROVENANCE_REV}`, '--check']);
    expect(out).toMatch(/^OK:/);
  }, 60000);

  it('the CURRENT planner produces the identical numbers — inertness, proved without jest', () => {
    // The same property `remixPlan.test.ts` asserts, reached by a completely
    // different route: generate from today's planner and compare the rows to
    // the ones generated from the pre-`requiredJoins` planner. A subset axis
    // that was not inert at K = 0 would show up here even if the jest golden
    // had been regenerated to hide it.
    const outPath = path.join(tmpDir, 'fromWorkingTree.ts');
    run(['--working-tree', `--out=${outPath}`]);
    expect(cases(fs.readFileSync(outPath, 'utf8'))).toBe(cases(fs.readFileSync(GOLDEN, 'utf8')));
  }, 60000);

  it('is byte-for-byte deterministic across two invocations', () => {
    const a = path.join(tmpDir, 'a.ts');
    const b = path.join(tmpDir, 'b.ts');
    run([`--from=${PROVENANCE_REV}`, `--out=${a}`]);
    run([`--from=${PROVENANCE_REV}`, `--out=${b}`]);
    expect(fs.readFileSync(a, 'utf8')).toBe(fs.readFileSync(b, 'utf8'));
  }, 60000);

  it('fails loudly on an unknown revision rather than writing an empty golden', () => {
    const outPath = path.join(tmpDir, 'never-written.ts');
    expect(() => run(['--from=0000000deadbeef', `--out=${outPath}`])).toThrow();
    expect(fs.existsSync(outPath)).toBe(false);
  }, 60000);

  it('writes nothing under src/ while extracting a past revision', () => {
    // Scope rule: scratch never lands in `src/`, where jest would collect it.
    // The extraction rewrites the historical planner's relative imports so it
    // can live in a temp dir instead of beside its dependencies.
    const before = fs.readdirSync(path.join(ROOT, 'src', 'dsp')).sort();
    run([`--from=${PROVENANCE_REV}`, `--out=${path.join(tmpDir, 'scoped.ts')}`]);
    expect(fs.readdirSync(path.join(ROOT, 'src', 'dsp')).sort()).toEqual(before);
  }, 60000);
});
