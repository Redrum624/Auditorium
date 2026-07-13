'use strict';

// Scripted headed smoke test for the file open/save/export flow (Task 11).
// Launches the BUILT app under Playwright's Electron driver with AUDITORIUM_TEST=1
// (which exposes window.__test and relaxes the file IPC gates), then drives a
// full round trip: open a WAV, verify the decoded state and a rendered waveform,
// export MP3, save-as WAV, screenshot. Exits 0 on success, 1 on any failure.
//
// Run: npm run build && npm run smoke

const path = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { _electron: electron } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const TONE = path.join(ROOT, 'test-assets', 'tone.wav');
const OUT_DIR = path.join(ROOT, 'test-output');
const OUT_MP3 = path.join(OUT_DIR, 'out.mp3');
const OUT_WAV = path.join(OUT_DIR, 'out.wav');
const SHOT = path.join(OUT_DIR, 'smoke.png');

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
  console.log(`  ok: ${msg}`);
}

async function main() {
  // Preconditions ----------------------------------------------------------
  if (!fs.existsSync(path.join(ROOT, 'dist', 'index.html'))) {
    throw new Error('dist/index.html missing — run `npm run build` before the smoke test');
  }
  if (!fs.existsSync(TONE)) {
    console.log('Generating test tone...');
    execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'make-test-tone.cjs')], {
      stdio: 'inherit',
    });
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const f of [OUT_MP3, OUT_WAV, SHOT]) {
    if (fs.existsSync(f)) fs.rmSync(f);
  }

  console.log('Launching built app under Playwright Electron...');
  const app = await electron.launch({
    // The two fake-media switches make Chromium synthesize a mic (a periodic
    // tone) and auto-accept the capture prompt, so the recording step below runs
    // headless-safe with no real hardware.
    args: [
      '.',
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
    ],
    cwd: ROOT,
    env: { ...process.env, AUDITORIUM_TEST: '1' },
  });

  try {
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');

    // Wait for the renderer to install its test hooks.
    await page.waitForFunction(() => Boolean(window.__test), null, { timeout: 20000 });
    console.log('window.__test is available.');

    // 1) Open the tone WAV --------------------------------------------------
    console.log(`Opening ${TONE} ...`);
    await page.evaluate((p) => window.__test.openPath(p), TONE);

    const summary = await page.evaluate(() => window.__test.getStateSummary());
    console.log('State summary:', JSON.stringify(summary));
    assert(summary.docCount === 1, 'exactly one document open');
    assert(summary.length === 88200, `document length is 88200 samples (got ${summary.length})`);
    assert(summary.sampleRate === 44100, `sample rate is 44100 (got ${summary.sampleRate})`);
    assert(summary.channels === 2, `document is stereo (got ${summary.channels})`);

    // 2) Waveform canvas renders non-uniform pixels -------------------------
    console.log('Checking the waveform canvas has drawn non-uniform pixels...');
    await page.waitForFunction(
      () => {
        const c = document.querySelector('[data-testid="waveform-canvas"]');
        if (!(c instanceof HTMLCanvasElement)) return false;
        const ctx = c.getContext('2d');
        if (!ctx || c.width === 0 || c.height === 0) return false;
        const data = ctx.getImageData(0, 0, c.width, c.height).data;
        let first = null;
        for (let i = 0; i < data.length; i += 4 * 97) {
          const px = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
          if (first === null) first = px;
          else if (px !== first) return true;
        }
        return false;
      },
      null,
      { timeout: 15000 }
    );
    assert(true, 'waveform canvas contains varied pixels (not a blank fill)');

    // 2b) Apply an effect (Amplify -6 dB) via the real DSP worker -----------
    console.log('Applying Amplify -6 dB through the DSP worker...');
    const peakBefore = await page.evaluate(() => window.__test.getPeak());
    const peakAfter = await page.evaluate(() =>
      window.__test.applyEffect('amplify', { gainDb: -6 })
    );
    console.log(`  peak before: ${peakBefore.toFixed(4)}, after: ${peakAfter.toFixed(4)}`);
    assert(peakBefore > 0, 'document had a non-zero peak before the effect');
    // -6 dB ~= x0.501; allow a small tolerance.
    const expected = peakBefore * Math.pow(10, -6 / 20);
    assert(
      Math.abs(peakAfter - expected) < 0.01,
      `peak after -6 dB (${peakAfter.toFixed(4)}) ~= half of before (${expected.toFixed(4)})`
    );
    // Restore the original samples so the subsequent export/save checks are
    // unaffected by the effect.
    await page.evaluate(() => window.__test.applyEffect('amplify', { gainDb: 6 }));

    // 3) Export MP3 ---------------------------------------------------------
    console.log(`Exporting MP3 to ${OUT_MP3} ...`);
    const mp3Ok = await page.evaluate(
      (out) => window.__test.exportActive({ format: 'mp3', wavBitDepth: 16, mp3Kbps: 192 }, out),
      OUT_MP3
    );
    assert(mp3Ok === true, 'exportActive(mp3) reported success');
    assert(fs.existsSync(OUT_MP3), 'out.mp3 exists on disk');
    const mp3Size = fs.statSync(OUT_MP3).size;
    console.log(`  out.mp3 size: ${mp3Size} bytes`);
    assert(mp3Size > 10 * 1024, `out.mp3 is larger than 10KB (got ${mp3Size})`);
    const mp3Head = fs.readFileSync(OUT_MP3).subarray(0, 2);
    assert(mp3Head[0] === 0xff && (mp3Head[1] & 0xe0) === 0xe0, 'out.mp3 begins with an MP3 frame sync');

    // 4) Save-as WAV --------------------------------------------------------
    console.log(`Saving WAV to ${OUT_WAV} ...`);
    const wavOk = await page.evaluate((out) => window.__test.saveActiveAs(out), OUT_WAV);
    assert(wavOk === true, 'saveActiveAs(wav) reported success');
    assert(fs.existsSync(OUT_WAV), 'out.wav exists on disk');
    const wavBuf = fs.readFileSync(OUT_WAV);
    console.log(`  out.wav size: ${wavBuf.length} bytes`);
    assert(wavBuf.toString('ascii', 0, 4) === 'RIFF', 'out.wav has RIFF magic');
    assert(wavBuf.toString('ascii', 8, 12) === 'WAVE', 'out.wav has WAVE magic');
    // 88200 frames * 2ch * 4 bytes (32f) + 44 header ≈ 705644 bytes.
    assert(wavBuf.length > 700000, `out.wav has a plausible size (got ${wavBuf.length})`);

    // 4b) Spectral (spectrogram) view renders non-uniform pixels ------------
    console.log('Switching to the Spectral view and checking the spectrogram...');
    await page.evaluate(() => window.__test.setView('spectral'));
    await page.waitForFunction(
      () => {
        const c = document.querySelector('[data-testid="spectrogram-canvas"]');
        if (!(c instanceof HTMLCanvasElement)) return false;
        const ctx = c.getContext('2d');
        if (!ctx || c.width === 0 || c.height === 0) return false;
        const data = ctx.getImageData(0, 0, c.width, c.height).data;
        let first = null;
        for (let i = 0; i < data.length; i += 4 * 101) {
          const px = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
          if (first === null) first = px;
          else if (px !== first) return true;
        }
        return false;
      },
      null,
      { timeout: 15000 }
    );
    assert(true, 'spectrogram canvas contains varied pixels (a spectral image)');

    // 4c) Capture a noise print, run Noise Reduction, assert RMS drops ------
    console.log('Capturing a noise print and applying Noise Reduction...');
    await page.evaluate(() => window.__test.setView('waveform'));
    await page.evaluate(() => window.__test.captureNoisePrint());
    const rmsBefore = await page.evaluate(() => window.__test.getRms());
    await page.evaluate(() => {
      const spectra = window.__test.getNoiseProfileSpectra();
      return window.__test.applyEffect(
        'noise-reduction',
        { reductionDb: 20, sensitivity: 2, smoothing: 0.5 },
        { spectra }
      );
    });
    const rmsAfter = await page.evaluate(() => window.__test.getRms());
    console.log(`  RMS before: ${rmsBefore.toFixed(4)}, after: ${rmsAfter.toFixed(4)}`);
    assert(rmsBefore > 0, 'document had a non-zero RMS before noise reduction');
    assert(
      rmsAfter < rmsBefore,
      `RMS dropped after noise reduction (${rmsAfter.toFixed(4)} < ${rmsBefore.toFixed(4)})`
    );
    // Persist so the (now noise-reduced) document isn't dirty at teardown —
    // otherwise app.close() triggers the unsaved-changes beforeunload prompt.
    await page.evaluate((out) => window.__test.saveActiveAs(out), OUT_WAV);

    // 5) Microphone recording via the fake device ---------------------------
    console.log('Recording 2s from the fake microphone (drives RecordingEngine)...');
    const rec = await page.evaluate(() => window.__test.recordSeconds(2));
    console.log(
      `  recorded length: ${rec.length} samples @ ${rec.sampleRate} Hz, rms: ${rec.rms.toFixed(4)}`
    );
    const expectedLen = 2 * rec.sampleRate;
    assert(
      Math.abs(rec.length - expectedLen) < expectedLen * 0.2,
      `recorded ~2 seconds (${rec.length} ≈ ${expectedLen} ±20%)`
    );
    assert(rec.rms > 0, `recording is non-silent (rms ${rec.rms.toFixed(4)} > 0)`);
    // Persist so the new (dirty) recording document doesn't trip the
    // unsaved-changes beforeunload prompt at teardown.
    await page.evaluate((out) => window.__test.saveActiveAs(out), OUT_WAV);

    // 6) Multitrack: new session, two clips, mixdown ------------------------
    console.log('Building a multitrack session and mixing down...');
    // Re-open the tone so it is the active document to insert.
    await page.evaluate((p) => window.__test.openPath(p), TONE);
    await page.evaluate(() => window.__test.newSession(44100));

    const c1 = await page.evaluate(() => window.__test.insertActiveDocAsClip(0, 0));
    const c2 = await page.evaluate((off) => window.__test.insertActiveDocAsClip(1, off), 22050);
    console.log(`  clip 1: ${JSON.stringify(c1)} | clip 2: ${JSON.stringify(c2)}`);
    assert(c1 && c1.lengthSample === 88200, `clip 1 spans the whole tone (88200; got ${c1 && c1.lengthSample})`);
    assert(c2 && c2.startSample === 22050, `clip 2 starts at sample 22050 (got ${c2 && c2.startSample})`);

    const mix = await page.evaluate(() => window.__test.mixdownSession());
    console.log(`  mixdown: ${JSON.stringify(mix)}`);
    const expectedMixLen = 22050 + 88200; // last clip end (session samples)
    assert(mix !== null, 'mixdown produced a document');
    assert(mix.length === expectedMixLen, `mixdown length is ${expectedMixLen} (got ${mix.length})`);
    assert(mix.sampleRate === 44100, `mixdown sample rate is 44100 (got ${mix.sampleRate})`);
    assert(mix.rms > 0, `mixdown is non-silent (rms ${mix.rms.toFixed(4)} > 0)`);
    assert(/^Mixdown /.test(mix.name), `mixdown doc named 'Mixdown N' (got ${mix.name})`);

    // The mixdown became the active document in the waveform view.
    const mixSummary = await page.evaluate(() => window.__test.getStateSummary());
    assert(mixSummary.length === expectedMixLen, `active doc is the mixdown (length ${mixSummary.length})`);
    assert(mixSummary.channels === 2, `mixdown is stereo (got ${mixSummary.channels})`);

    // 7) Screenshot ---------------------------------------------------------
    await page.screenshot({ path: SHOT });
    assert(fs.existsSync(SHOT), 'smoke.png screenshot written');

    console.log('\nSMOKE PASSED');
  } finally {
    await app.close();
  }
}

main().catch((err) => {
  console.error('\nSMOKE FAILED');
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
