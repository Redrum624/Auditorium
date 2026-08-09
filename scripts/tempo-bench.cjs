'use strict';

// R4 tempo A/B bench driver — the runnable form of the measurement rig P2-4
// needed and never had (the audit's "63/91" bank was never committed; this
// bank is a NEW DENOMINATOR — see src/dsp/__fixtures__/tempoBench.ts).
//
// Plain-node driver in stem-bench-driver.cjs's shape: runs the REAL
// `analyzeTempo` over the documented, deterministic 83-fixture bank and
// writes a machine-readable JSON report so two runs (before/after a detector
// change) can be diffed byte-for-byte. Deterministic by construction: every
// generator is seeded (LCG, never Math.random), the bank composition is
// code-defined, and the report carries no timestamps.
//
//   node scripts/tempo-bench.cjs [--out=<path>] [--families=a,b] [--limit-per-family=N]
//
//   --out=<path>            report destination (default test-output/tempo-bench.json)
//   --families=<csv>        run only these families (subset runs for quick A/Bs)
//   --limit-per-family=<n>  first N fixtures of each family (deterministic subset)
//
// The TS sources are loaded through a require-time transpile hook
// (typescript.transpileModule -> CommonJS) — the same TypeScript package the
// build already depends on; no new dependency, no emitted artifacts.

const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..');

// Require hook: transpile .ts on the fly. Registered before the first
// require of a TS module. Node resolves extensionless `import './fft'`
// through require.extensions, so tempoCore's internal imports work too.
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

const { buildBank, runBench, BANK_VERSION } = require(
  path.join(ROOT, 'src', 'dsp', '__fixtures__', 'tempoBench.ts')
);

function arg(name) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
}

function main() {
  const outPath = path.resolve(ROOT, arg('out') ?? path.join('test-output', 'tempo-bench.json'));
  const familiesArg = arg('families');
  const limitArg = arg('limit-per-family');

  let bank = buildBank();
  if (familiesArg) {
    const wanted = new Set(familiesArg.split(',').map((s) => s.trim()));
    const known = new Set(bank.map((f) => f.family));
    for (const w of wanted) {
      if (!known.has(w)) throw new Error(`unknown family '${w}' (known: ${[...known].join(', ')})`);
    }
    bank = bank.filter((f) => wanted.has(f.family));
  }
  if (limitArg !== undefined) {
    const limit = Number(limitArg);
    if (!Number.isInteger(limit) || limit <= 0) throw new Error('--limit-per-family must be a positive integer');
    const seen = new Map();
    bank = bank.filter((f) => {
      const n = (seen.get(f.family) ?? 0) + 1;
      seen.set(f.family, n);
      return n <= limit;
    });
  }
  if (bank.length === 0) throw new Error('fixture selection is empty');

  console.log(`tempo-bench ${BANK_VERSION}: ${bank.length} fixtures...`);
  const t0 = Date.now();
  const report = runBench(bank);
  const wallMs = Date.now() - t0;

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n');

  const line = (label, t) => {
    const total = t.correct + t.octave + t.other;
    console.log(
      `  ${label.padEnd(14)} ${String(t.correct).padStart(3)}/${String(total).padEnd(3)} correct, ` +
        `${t.octave} octave, ${t.other} other`
    );
  };
  for (const [family, tally] of Object.entries(report.perFamily)) line(family, tally);
  line('TOTAL', report.aggregate);
  const misses = report.rows.filter((r) => r.verdict !== 'correct');
  if (misses.length > 0) {
    console.log('  misses:');
    for (const r of misses) {
      console.log(
        `    ${r.id.padEnd(22)} true=${r.trueBpm ?? '-'} got=${r.reportedBpm ?? 'null'} ` +
          `conf=${r.confidence} ratio=${r.ratio ?? '-'} [${r.verdict}]`
      );
    }
  }
  console.log(`  wall: ${(wallMs / 1000).toFixed(1)}s; report: ${outPath}`);
}

try {
  main();
} catch (err) {
  console.error(`tempo-bench FAILED: ${err && err.message ? err.message : err}`);
  process.exit(1);
}
