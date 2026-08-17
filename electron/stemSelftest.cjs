'use strict';

/**
 * Stem-host self-test (S1's packaged-app proof, runnable in ANY build).
 *
 * Launched via `Auditorium.exe --stem-selftest-out=<json path>
 * [--stem-model=<model path>]` (see main.cjs): instead of opening a window,
 * main verifies the model against the ruling-3 sha256 pin, spawns the REAL
 * stem utility process (stemHost.cjs → onnxruntime-node, CPU EP), runs one
 * full segment of synthetic audio through the real message protocol, writes
 * a JSON verdict to the given path, and exits 0 (ok) / 1 (failed).
 *
 * This exists because native-module packaging silently breaking is the
 * classic electron-builder failure: unit tests and the dev tree prove
 * nothing about whether the PACKAGED app can resolve onnxruntime-node's
 * .node/.dll binaries out of app.asar.unpacked. The proof driver
 * (scripts/stem-packaged-proof.cjs) runs this against release/win-unpacked
 * and asserts the verdict — that is the ruling-3 gate.
 *
 * Security stance: this is a self-contained diagnostic, not a test hook. It
 * exposes nothing to the renderer (no window is created), reads only the
 * model file (still sha256-pinned before load), and runs fixed synthetic
 * audio. The verdict path arrives on argv of a signed binary, so it is
 * treated as UNTRUSTED (fix round 1, MED-2): it must resolve under the OS
 * temp dir or the app's userData — UNC forms (outbound SMB coercion) and
 * anything outside those bases are refused before a byte is written — and
 * the verdict itself is a fixed whitelist of fields with attacker-influenced
 * strings (the --stem-model value) scrubbed, so the diagnostic cannot be
 * used to write chosen content to a chosen path. It does not weaken the F23
 * packaged-build gates, which are about renderer test hooks.
 */

const fs = require('node:fs');
const path = require('node:path');
const { createStemManager, getModelPath } = require('./stemManager.cjs');
const { STRIDE_SAMPLES, MODEL_SAMPLE_RATE, STEM_COUNT, MODEL_CHANNELS } = require('./stemSegmentation.cjs');

const SELFTEST_TIMEOUT_MS = 300000;

/**
 * Validates the caller-supplied verdict path (fix round 1, MED-2): must be a
 * non-empty string that RESOLVES to a location under the OS temp dir or the
 * app's userData dir. UNC paths are rejected outright — a signed binary must
 * not be coercible into an outbound SMB write — and the containment check
 * runs on the resolved form, so `..` escapes and prefix-sibling confusion
 * (`C:\Temp-evil` vs `C:\Temp`) are rejected too. Returns the resolved path
 * or throws.
 */
function validateSelftestOutPath(rawPath, { tempDir, userDataDir }) {
  if (typeof rawPath !== 'string' || rawPath.length === 0) {
    throw new Error('selftest out path must be a non-empty string');
  }
  if (/^[\\/]{2}/.test(rawPath)) {
    throw new Error('selftest out path must not be a UNC path — not permitted');
  }
  const resolved = path.resolve(rawPath);
  if (/^[\\/]{2}/.test(resolved)) {
    throw new Error('selftest out path must not resolve to a UNC path — not permitted');
  }
  // Case-insensitive containment, matching ipc.cjs's approval-set
  // normalisation — Windows paths compare case-insensitively.
  const lowered = resolved.toLowerCase();
  const under = (base) => {
    const b = path.resolve(base).toLowerCase();
    return lowered === b || lowered.startsWith(b + path.sep);
  };
  if (!under(tempDir) && !under(userDataDir)) {
    throw new Error(
      'selftest out path not permitted: it must be inside the OS temp directory or the app userData directory'
    );
  }
  return resolved;
}

/** One segment's worth of deterministic two-tone stereo. */
function syntheticAudio() {
  const total = STRIDE_SAMPLES; // exactly one 7.8 s segment after planning
  const left = new Float32Array(total);
  const right = new Float32Array(total);
  for (let t = 0; t < total; t++) {
    left[t] = Math.sin((2 * Math.PI * 220 * t) / MODEL_SAMPLE_RATE) * 0.4;
    right[t] = Math.sin((2 * Math.PI * 330 * t) / MODEL_SAMPLE_RATE) * 0.3;
  }
  return [left, right];
}

async function runStemSelftest({ app, outPath, modelPath, managerFactory = createStemManager, timeoutMs = SELFTEST_TIMEOUT_MS }) {
  const startedAt = Date.now();

  // MED-2: refuse a hostile out path BEFORE anything is written anywhere.
  let safeOutPath;
  try {
    safeOutPath = validateSelftestOutPath(outPath, {
      tempDir: app.getPath('temp'),
      userDataDir: app.getPath('userData'),
    });
  } catch (err) {
    console.error(`stem selftest: ${err.message}`);
    return 1;
  }

  // MED-2: the verdict is a FIXED WHITELIST of fields — nothing echoed from
  // argv (no modelPath field), and error strings are scrubbed of the
  // caller-supplied model path below before they can reach the file.
  const verdict = {
    ok: false,
    packaged: Boolean(app && app.isPackaged),
    electron: process.versions.electron || null,
    totalSegments: null,
    progressEvents: 0,
    stemSamplesCovered: 0,
    allFinite: null,
    wallMs: null,
    error: null,
  };

  let resolvedModelPath = null;
  const scrub = (text) => {
    if (typeof text !== 'string') return text;
    let out = text;
    for (const needle of [modelPath, resolvedModelPath]) {
      if (typeof needle === 'string' && needle.length > 0) out = out.split(needle).join('<model>');
    }
    return out;
  };

  async function writeVerdict() {
    verdict.wallMs = Date.now() - startedAt;
    verdict.error = scrub(verdict.error);
    await fs.promises.writeFile(safeOutPath, JSON.stringify(verdict, null, 2));
  }

  try {
    resolvedModelPath = modelPath ? path.resolve(modelPath) : getModelPath(app.getPath('userData'));
    const manager = managerFactory({ userDataDir: app.getPath('userData') });

    const channels = syntheticAudio();
    const total = channels[0].length;
    let covered = 0;
    let allFinite = true;

    const run = manager.startSeparation({
      modelPath: resolvedModelPath,
      sampleRate: MODEL_SAMPLE_RATE,
      channels,
      onProgress: () => {
        verdict.progressEvents += 1;
      },
      onStems: (chunk) => {
        if (chunk.offset !== covered) allFinite = false; // must tile contiguously
        covered = chunk.offset + chunk.samples;
        if (chunk.data.length !== STEM_COUNT * MODEL_CHANNELS * chunk.samples) allFinite = false;
        for (let i = 0; i < chunk.data.length; i++) {
          if (!Number.isFinite(chunk.data[i])) {
            allFinite = false;
            break;
          }
        }
      },
    });
    let timeoutHandle;
    const timeout = new Promise((resolve) => {
      timeoutHandle = setTimeout(
        () => resolve({ ok: false, error: `selftest timed out after ${timeoutMs} ms` }),
        timeoutMs
      );
    });
    const result = await Promise.race([run, timeout]);
    clearTimeout(timeoutHandle); // a live timer would pin the process (and Jest) open
    manager.dispose(); // if the race was lost, no orphan child survives

    verdict.stemSamplesCovered = covered;
    verdict.allFinite = allFinite;
    if (!result.ok) {
      verdict.error = result.error || (result.cancelled ? 'cancelled' : 'unknown failure');
    } else if (covered !== total) {
      verdict.error = `stem chunks covered ${covered} of ${total} samples`;
    } else if (!allFinite) {
      verdict.error = 'stem output contained non-finite values or malformed chunks';
    } else if (verdict.progressEvents < 1) {
      verdict.error = 'no progress events received';
    } else {
      verdict.ok = true;
      verdict.totalSegments = result.totalSegments;
    }
  } catch (err) {
    verdict.error = err instanceof Error ? err.message : String(err);
  }

  await writeVerdict();
  return verdict.ok ? 0 : 1;
}

/** Parses the selftest CLI switches out of a process.argv array; null when
 * not in selftest mode. */
function parseStemSelftestArgs(argv) {
  const out = argv.find((a) => typeof a === 'string' && a.startsWith('--stem-selftest-out='));
  if (!out) return null;
  const model = argv.find((a) => typeof a === 'string' && a.startsWith('--stem-model='));
  return {
    outPath: out.slice('--stem-selftest-out='.length),
    modelPath: model ? model.slice('--stem-model='.length) : undefined,
  };
}

module.exports = { runStemSelftest, parseStemSelftestArgs, validateSelftestOutPath, SELFTEST_TIMEOUT_MS };
