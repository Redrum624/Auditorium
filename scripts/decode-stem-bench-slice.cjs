'use strict';

// Decodes the 30 s stem-separation bench slice out of the user's local real
// track (test-assets/, gitignored — plan ruling 9: the copyrighted audio
// never enters a committed artifact; this script only references its PATH,
// exactly like scripts/e2e-smoke.cjs does) into:
//
//   test-assets/stem-bench-slice.json  {sampleRate, channels, samples, offsetSeconds}
//   test-assets/stem-bench-slice.f32   planar Float32 (L block then R block)
//
// stemIntegration.test.cjs uses this slice when present and falls back to
// the abab fixture otherwise, mirroring the e2e smoke's real-song gating.
//
// Decoding uses Chromium's own decodeAudioData at 44 100 Hz (the model
// rate) — the same decode stack the built app uses (P0 decoded its bench
// material "through the built app" the same way). The hidden window runs
// with nodeIntegration because this is a local dev tool operating on local
// files, not app code; nothing here ships.
//
// Run: npx electron scripts/decode-stem-bench-slice.cjs [--in=<path to a real track>]

const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
// The source track: any full real local track works; --in=<path> overrides
// the neutral default. Copyrighted material stays user-local (test-assets/
// is gitignored), so only a neutral path ever appears in this script.
const IN_ARG = process.argv.find((a) => a.startsWith('--in='));
const SONG = IN_ARG
  ? path.resolve(REPO, IN_ARG.slice('--in='.length))
  : path.join(REPO, 'test-assets', 'real-song.mp3');
const OUT_JSON = path.join(REPO, 'test-assets', 'stem-bench-slice.json');
const OUT_F32 = path.join(REPO, 'test-assets', 'stem-bench-slice.f32');

// 30 s starting at 150 s: a dense beat section (kick/bass/strings/lead all
// present) — the bleed stress-test the spec notes call for.
const OFFSET_SECONDS = 150;
const SLICE_SECONDS = 30;
const RATE = 44100;

if (!fs.existsSync(SONG)) {
  console.error('real song not present at', SONG, '- nothing to do (the integration test will use the abab fixture)');
  process.exit(2);
}

const PAGE = `<!doctype html><meta charset="utf-8"><script>
const fs = require('node:fs');
const { ipcRenderer } = require('electron');
(async () => {
  try {
    const bytes = fs.readFileSync(${JSON.stringify(SONG)});
    const ctx = new AudioContext({ sampleRate: ${RATE} });
    const decoded = await ctx.decodeAudioData(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    await ctx.close();
    const from = Math.floor(${OFFSET_SECONDS} * decoded.sampleRate);
    const n = Math.floor(${SLICE_SECONDS} * decoded.sampleRate);
    if (from + n > decoded.length) throw new Error('slice window past end of track (' + decoded.length + ' samples)');
    const out = new Float32Array(2 * n);
    out.set(decoded.getChannelData(0).subarray(from, from + n), 0);
    out.set(decoded.getChannelData(decoded.numberOfChannels > 1 ? 1 : 0).subarray(from, from + n), n);
    fs.writeFileSync(${JSON.stringify(OUT_F32)}, Buffer.from(out.buffer));
    fs.writeFileSync(${JSON.stringify(OUT_JSON)}, JSON.stringify({
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
      console.log(`wrote ${OUT_F32} (${result.samples} samples @ ${result.sampleRate} Hz, offset ${OFFSET_SECONDS}s)`);
      app.exit(0);
    } else {
      console.error('decode failed:', result.error);
      app.exit(1);
    }
  });
  const tmpHtml = path.join(REPO, 'test-output', 'decode-slice.html');
  fs.mkdirSync(path.dirname(tmpHtml), { recursive: true });
  fs.writeFileSync(tmpHtml, PAGE);
  win.loadFile(tmpHtml);
  setTimeout(() => {
    console.error('decode timed out');
    app.exit(1);
  }, 120000);
});
