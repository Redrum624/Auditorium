'use strict';

// Regenerates `src/dsp/__fixtures__/remixPlanGolden.ts` — the auto-remix PLAN
// golden that R4b's Ruling 4 calls the single most important test in the task.
//
//   node scripts/gen-remix-plan-golden.cjs                     # from the shipped planner
//   node scripts/gen-remix-plan-golden.cjs --from=5dfa19d      # from a PAST revision
//   node scripts/gen-remix-plan-golden.cjs --from=5dfa19d --check
//   node scripts/gen-remix-plan-golden.cjs --out=<path>
//
// WHY THIS IS A COMMITTED SCRIPT AND NOT A SCRATCH FILE (R4b fix round 1, I7).
// The golden's whole value is its PROVENANCE: its numbers were produced by the
// planner as it stood at `5dfa19d`, before `requiredJoins` existed, so "an
// empty requiredJoins changes nothing" is a comparison against code that had
// never heard of the option rather than an argument about multiplying by 1.
// A generator living in a gitignored directory makes that provenance
// unverifiable and the fixture unregenerable by anyone who was not in the
// session that produced it — which is exactly the weakness R4b's own headline
// measurement diagnosed in the uncommitted 156-case pin rig. Committing it is
// the difference between a claim and a check.
//
// `--from=<rev>` extracts that revision's `src/dsp/remixPlan.ts` with
// `git show`, rewrites its relative imports to absolute paths into the CURRENT
// working tree (`./remixCost` -> `<root>/src/dsp/remixCost`), and loads that.
// So the planner is historical while `remixCost`/`remixFeatures`/`tempoCore`
// are today's — which is the correct comparison: the golden exists to detect a
// change in the PLANNER, and a genuine change in its dependencies should move
// the numbers and be noticed.
//
// `--check` regenerates in memory and diffs against the file on disk, exiting
// non-zero on any difference. That is how the provenance claim in the fixture
// header can be re-verified from a clean clone.
//
// TS is loaded through a require-time transpile hook (the same pattern as
// `scripts/tempo-bench.cjs`), using the TypeScript package the build already
// depends on. No new dependency, no emitted artifacts under `src/`.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_OUT = path.join(ROOT, 'src', 'dsp', '__fixtures__', 'remixPlanGolden.ts');
/** The revision the shipped golden was produced from — v1.20.0, the last
 * commit before `requiredJoins` existed. */
const PROVENANCE_REV = '5dfa19d';

require.extensions['.ts'] = (module_, filename) => {
  const source = fs.readFileSync(filename, 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: filename,
  });
  module_._compile(outputText, filename);
};

function arg(name) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
}
const flag = (name) => process.argv.includes(`--${name}`);

/**
 * Loads `planRemix` from `rev`'s copy of the planner, or from the working tree
 * when `rev` is undefined. The extracted copy is written OUTSIDE `src/` (scope
 * rule: no scratch under `src/`, where jest would see it) and its relative
 * imports are rewritten to absolute working-tree paths so they still resolve.
 */
function loadPlanner(rev) {
  if (!rev) return require(path.join(ROOT, 'src', 'dsp', 'remixPlan.ts')).planRemix;

  const source = execFileSync('git', ['show', `${rev}:src/dsp/remixPlan.ts`], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  const dspDir = path.join(ROOT, 'src', 'dsp').replace(/\\/g, '/');
  const rewritten = source.replace(/from '\.\/([A-Za-z0-9_.-]+)'/g, `from '${dspDir}/$1'`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remix-golden-'));
  const file = path.join(dir, 'remixPlanAtRev.ts');
  fs.writeFileSync(file, rewritten);
  try {
    return require(file).planRemix;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function renderCase(name, plan) {
  if (!plan.ok) throw new Error(`golden spec ${name} produced ok:false (${plan.reason}: ${plan.message})`);
  const segments = plan.segments.map((s) => `[${s.start},${s.end}]`).join(',');
  const joins = plan.joins.map((j) => `"${j.fromBar}>${j.toBar}"`).join(',');
  const joinCosts = plan.joins.map((j) => j.cost.total).join(',');
  return [
    '  {',
    `    name: ${JSON.stringify(name)},`,
    `    segments: [${segments}],`,
    `    joins: [${joins}],`,
    `    joinCosts: [${joinCosts}],`,
    `    outputSample: ${plan.outputSample},`,
    `    totalCost: ${plan.totalCost},`,
    `    minOutputSample: ${plan.minOutputSample},`,
    `    maxOutputSample: ${plan.maxOutputSample},`,
    `    maxBarUse: ${plan.maxBarUse},`,
    `    canReroll: ${plan.canReroll},`,
    '  },',
  ].join('\n');
}

function header(rev) {
  const from = rev
    ? `the planner **as it stood at commit \`${rev}\`**, i.e. before \`requiredJoins\` existed`
    : 'the planner in the CURRENT working tree';
  const cmd = rev
    ? `node scripts/gen-remix-plan-golden.cjs --from=${rev}`
    : 'node scripts/gen-remix-plan-golden.cjs';
  return `/**
 * GENERATED FILE -- do not hand-edit the numbers.
 *
 * The auto-remix PLAN golden (R4b, Ruling 4). Every value below was produced by
 * ${from}, run against the case matrix in
 * \`src/dsp/__fixtures__/remixPlanGoldenSpecs.ts\`, and is asserted field-for-field
 * on every run by \`src/dsp/remixPlan.test.ts\`.
 *
 * REGENERATE (or re-verify the provenance above) with:
 *
 *     ${cmd}
 *     ${cmd} --check     # diff against this file, non-zero on any difference
 *
 * The generator and the case matrix are both COMMITTED, so this file is
 * reproducible from a clean clone and survives \`git clean -fdx\`. That is
 * deliberate: R4b's own headline finding was that the previous pin measurement
 * (156/156) closed a backlog item for three releases on a rig that was never
 * committed and could not be re-run. A golden whose generator only exists in
 * someone's scratch directory repeats that mistake.
 *
 * WHAT THIS PROTECTS. \`remixGolden.ts\` pins the RENDERED AUDIO of four
 * hand-built plans; it cannot notice a planner that starts choosing a different
 * arrangement, because it never asks the planner for one. R4b adds a \`2^K\`
 * subset axis to the DP's index arithmetic, shared by the K = 0 path -- so "an
 * empty \`requiredJoins\` changes nothing" needed to stop being an argument about
 * \`* 1\` and \`+ 0\` and become a comparison against numbers produced by code
 * that had never heard of the option. These are those numbers.
 *
 * The eight cases span both fixture builders (uniform and genuinely varying bar
 * lengths), strict and loose mode, \`allowRepeats\` on and off, roll indices 0-3,
 * \`exactLength\`, and targets from 0.5x to 2.0x the source -- including one case
 * whose optimal plan traverses the SAME join key twice
 * (\`varying-64-loose-roll1-2.00\`, joins \`34>2, 34>2\`), which is also the
 * measured counter-example to implementing \`requiredJoins\` as a counter.
 *
 * Regenerating is an ADMISSION that auto-remix arrangements moved, and belongs
 * in its own commit with the reason.
 */

export interface RemixPlanGoldenCase {
  /** Matches the \`name\` in \`REMIX_PLAN_GOLDEN_SPECS\`. */
  readonly name: string;
  /** \`[start, end]\` per segment, exact samples. */
  readonly segments: readonly (readonly [number, number])[];
  /** \`\${fromBar}>\${toBar}\` per join, in path order. */
  readonly joins: readonly string[];
  /** \`joins[i].cost.total\` at double precision -- pins the UNPENALISED
   * per-join breakdown the panel shows, not just the arrangement. */
  readonly joinCosts: readonly number[];
  readonly outputSample: number;
  readonly totalCost: number;
  readonly minOutputSample: number;
  readonly maxOutputSample: number;
  readonly maxBarUse: number;
  readonly canReroll: boolean;
}

`;
}

function main() {
  const rev = arg('from') ?? (flag('working-tree') ? undefined : PROVENANCE_REV);
  const outPath = path.resolve(ROOT, arg('out') ?? DEFAULT_OUT);
  const planRemix = loadPlanner(rev);
  const { REMIX_PLAN_GOLDEN_SPECS } = require(
    path.join(ROOT, 'src', 'dsp', '__fixtures__', 'remixPlanGoldenSpecs.ts')
  );

  const rows = REMIX_PLAN_GOLDEN_SPECS.map((spec) => {
    const analysis = spec.analysis();
    return renderCase(spec.name, planRemix(analysis, spec.opts(analysis)));
  });
  const text = `${header(rev)}export const REMIX_PLAN_GOLDEN: readonly RemixPlanGoldenCase[] = [\n${rows.join('\n')}\n];\n`;

  if (flag('check')) {
    const onDisk = fs.readFileSync(outPath, 'utf8').replace(/\r\n/g, '\n');
    if (onDisk === text) {
      console.log(`OK: ${path.relative(ROOT, outPath)} matches the planner at ${rev ?? 'the working tree'}`);
      return;
    }
    console.error(`MISMATCH: ${path.relative(ROOT, outPath)} differs from the planner at ${rev ?? 'the working tree'}`);
    process.exitCode = 1;
    return;
  }

  fs.writeFileSync(outPath, text);
  console.log(
    `wrote ${path.relative(ROOT, outPath)} (${REMIX_PLAN_GOLDEN_SPECS.length} cases) from ${rev ?? 'the working tree'}`
  );
}

main();
