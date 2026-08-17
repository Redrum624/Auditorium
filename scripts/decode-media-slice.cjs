'use strict';

// V4 — decodes an arbitrary slice of an arbitrary local media file into the
// planar-stereo Float32 form the stem drivers eat.
//
//   npx electron scripts/decode-media-slice.cjs --in=<media> --out=<f32> \
//     [--offset=<seconds>] [--seconds=<n>] [--rate=44100]
//
// It is `decode-stem-bench-slice.cjs` with its three constants turned into
// arguments, and it exists for the same reason that one does: the material the
// second-pass probe has to measure is REAL music, real music is copyrighted,
// and the copyrighted audio never enters a committed artifact — this script
// only ever references a PATH under `test-assets/` (gitignored), exactly like
// `scripts/e2e-smoke.cjs`. The sibling stays as it is: it names the one slice
// the S1 integration bench pins, and a bench fixture whose identity lives in
// its script rather than in a caller's arguments is the point of it.
//
// Decoding is Chromium's own `decodeAudioData` at the requested rate — the
// same decode stack the built app uses, and the reason this needs Electron at
// all: it resamples a 48 kHz master to the model's 44 100 Hz on the way out,
// through the browser's resampler rather than a second one written here.
// The hidden window runs with nodeIntegration because this is a local dev tool
// operating on local files, not app code; nothing here ships.

const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');

function arg(name) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
}

const IN = arg('in') ? path.resolve(arg('in')) : null;
const OUT = arg('out') ? path.resolve(arg('out')) : null;
const OFFSET_SECONDS = Number(arg('offset') ?? 0);
const SLICE_SECONDS = Number(arg('seconds') ?? 30);
const RATE = Number(arg('rate') ?? 44100);

// T3 — a review read these two exits as fall-through ("`app.exit(2)` does not
// stop the script; execution continues into the PAGE template with
// `JSON.stringify(null)` and registers `whenReady`"). MEASURED, on this repo's
// Electron 43.3.0, that is not what happens: a three-line probe
// (`console.error('BEFORE'); app.exit(2); console.error('AFTER')`) run under
// `npx electron` printed BEFORE and exited 2, with AFTER never reaching the
// terminal — `app.exit` does not return, so nothing below runs. Running this
// script with no arguments at all prints the usage line ALONE, never the
// "input not present at null" line eight lines down, which is the same fact
// from the shipped path.
//
// Left as it is rather than restructured on a premise that does not hold, and
// the measurement is written here so the next reader does not have to redo it.
// If Electron ever changes that, the second check is what fails first and
// loudly (`fs.existsSync(null)` is `false`, so it prints and exits 2 again).
if (!IN || !OUT || !Number.isFinite(OFFSET_SECONDS) || !(SLICE_SECONDS > 0) || !(RATE > 0)) {
  console.error('usage: --in=<media> --out=<f32> [--offset=<s>] [--seconds=<n>] [--rate=<hz>]');
  app.exit(2);
}
if (!fs.existsSync(IN)) {
  console.error('input not present at', IN);
  app.exit(2);
}

const PAGE = `<!doctype html><meta charset="utf-8"><script>
const fs = require('node:fs');
const { ipcRenderer } = require('electron');
(async () => {
  try {
    const bytes = fs.readFileSync(${JSON.stringify(IN)});
    const ctx = new AudioContext({ sampleRate: ${RATE} });
    const decoded = await ctx.decodeAudioData(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    await ctx.close();
    const from = Math.floor(${OFFSET_SECONDS} * decoded.sampleRate);
    const n = Math.floor(${SLICE_SECONDS} * decoded.sampleRate);
    if (from + n > decoded.length) throw new Error('slice window past end of track (' + decoded.length + ' samples)');
    const out = new Float32Array(2 * n);
    out.set(decoded.getChannelData(0).subarray(from, from + n), 0);
    out.set(decoded.getChannelData(decoded.numberOfChannels > 1 ? 1 : 0).subarray(from, from + n), n);
    fs.writeFileSync(${JSON.stringify(OUT)}, Buffer.from(out.buffer));
    fs.writeFileSync(${JSON.stringify(OUT)} + '.json', JSON.stringify({
      sampleRate: decoded.sampleRate, channels: 2, samples: n, offsetSeconds: ${OFFSET_SECONDS},
    }, null, 2));
    ipcRenderer.send('slice-done', { ok: true, samples: n, sampleRate: decoded.sampleRate });
  } catch (err) {
    ipcRenderer.send('slice-done', { ok: false, error: String(err && err.message || err) });
  }
})();
</script>`;

app.whenReady().then(() => {
  const win = new BrowserWindow({
    show: false,
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  ipcMain.on('slice-done', (_e, result) => {
    if (result.ok) {
      console.log(`wrote ${OUT} (${result.samples} samples @ ${result.sampleRate} Hz, offset ${OFFSET_SECONDS}s)`);
      app.exit(0);
    } else {
      console.error('decode failed:', result.error);
      app.exit(1);
    }
  });
  const tmpHtml = path.join(REPO, 'test-output', 'decode-media-slice.html');
  fs.mkdirSync(path.dirname(tmpHtml), { recursive: true });
  fs.writeFileSync(tmpHtml, PAGE);
  win.loadFile(tmpHtml);
  setTimeout(() => {
    console.error('decode timed out');
    app.exit(1);
  }, 120000);
});
