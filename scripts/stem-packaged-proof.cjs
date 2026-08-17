'use strict';

// The ruling-3 packaged-app proof for S1: launches the PACKAGED build
// (release/win-unpacked/Auditorium.exe) in stem-selftest mode, which makes
// the packaged main process sha256-verify the model, spawn the real stem
// utilityProcess (stemHost.cjs from inside app.asar), load onnxruntime-node
// out of app.asar.unpacked, run one full 7.8 s segment, and write a JSON
// verdict. This is the check that native-module packaging — the classic
// silent electron-builder breaker — actually works in the shipped artifact,
// not just the dev tree.
//
// Run AFTER `npm run build:win`:
//   node scripts/stem-packaged-proof.cjs
//
// Exit codes: 0 proof passed · 1 selftest failed · 2 prerequisites missing.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..');
const EXE = path.join(REPO, 'release', 'win-unpacked', 'Auditorium.exe');
const UNPACKED_ORT = path.join(
  REPO,
  'release',
  'win-unpacked',
  'resources',
  'app.asar.unpacked',
  'node_modules',
  'onnxruntime-node'
);
const MODEL = path.join(REPO, 'test-assets', 'models', 'htdemucs_fp16weights.onnx');
// Under the OS temp dir: the selftest validates its out path against
// temp/userData (MED-2) and refuses anything else — including repo dirs.
const OUT = path.join(os.tmpdir(), `auditorium-stem-selftest-${process.pid}.json`);

function fail(code, msg) {
  console.error(`stem-packaged-proof: ${msg}`);
  process.exit(code);
}

if (!fs.existsSync(EXE)) fail(2, `packaged app not found at ${EXE} — run npm run build:win first`);
if (!fs.existsSync(MODEL)) {
  fail(2, `model not found at ${MODEL} — run the integration test once (it downloads via the model manager)`);
}
if (!fs.existsSync(UNPACKED_ORT)) {
  fail(1, `asarUnpack did NOT produce ${UNPACKED_ORT} — onnxruntime-node would be loaded from inside the asar and its native binding would fail`);
}
const binding = path.join(UNPACKED_ORT, 'bin', 'napi-v6', 'win32', 'x64', 'onnxruntime_binding.node');
if (!fs.existsSync(binding)) fail(1, `native binding missing from the unpacked package: ${binding}`);

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.rmSync(OUT, { force: true });

console.log(`stem-packaged-proof: launching ${EXE} in selftest mode ...`);
const run = spawnSync(EXE, [`--stem-selftest-out=${OUT}`, `--stem-model=${MODEL}`], {
  timeout: 6 * 60 * 1000,
});
if (run.error) fail(1, `failed to launch packaged app: ${run.error.message}`);

if (!fs.existsSync(OUT)) {
  fail(1, `packaged app exited (status ${run.status}) without writing a verdict — selftest never ran`);
}
const verdict = JSON.parse(fs.readFileSync(OUT, 'utf8'));
console.log(`stem-packaged-proof verdict: ${JSON.stringify(verdict, null, 2)}`);
if (!verdict.ok) fail(1, `packaged selftest FAILED: ${verdict.error}`);
if (!verdict.packaged) fail(1, 'selftest ran against an UNPACKAGED build — this proves nothing');
console.log(
  `stem-packaged-proof: PASSED — packaged utility process loaded onnxruntime-node and separated ${verdict.stemSamplesCovered} samples in ${verdict.wallMs} ms (exe exit status ${run.status}).`
);
