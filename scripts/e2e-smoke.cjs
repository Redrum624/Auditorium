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
const BEAT = path.join(ROOT, 'test-assets', 'beat120.wav');
// Optional real-material fixture: a full commercial track the user placed
// locally. Copyrighted, so it is NEVER committed (test-assets/ is gitignored)
// and NEVER required — the real-song step skips cleanly when it is absent.
const REAL_SONG = path.join(
  ROOT,
  'test-assets',
  'DJ Tiësto - Adagio For Strings (Original Album Version).mp3'
);
const ABAB = path.join(ROOT, 'test-assets', 'abab120.wav');
const OUT_DIR = path.join(ROOT, 'test-output');
const OUT_MP3 = path.join(OUT_DIR, 'out.mp3');
const OUT_WAV = path.join(OUT_DIR, 'out.wav');
const OUT_FLAC = path.join(OUT_DIR, 'out.flac');
const OUT_MARKERS_WAV = path.join(OUT_DIR, 'markers.wav');
const OUT_OGG = path.join(OUT_DIR, 'out.ogg');
const OUT_MARKERS_MP3 = path.join(OUT_DIR, 'markers.mp3');
const OUT_MARKERS_FLAC = path.join(OUT_DIR, 'markers.flac');
const OUT_MARKERS_OGG = path.join(OUT_DIR, 'markers.ogg');
const OUT_SESSION = path.join(OUT_DIR, 'session.audm');
const OUT_FADES_SESSION = path.join(OUT_DIR, 'fades-session.audm');
const OUT_FADES_REFERENCE = path.join(OUT_DIR, 'fades-v18-reference.json');
const OUT_AUTOMATION_SESSION = path.join(OUT_DIR, 'automation-session.audm');
const OUT_SPATIAL_SESSION = path.join(OUT_DIR, 'spatial-session.audm');
const SHOT = path.join(OUT_DIR, 'smoke.png');

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
  console.log(`  ok: ${msg}`);
}

// Waits until the given canvas has drawn at least two differing pixels (i.e. it
// is not a blank/uniform fill). Shared by the waveform and spectrogram checks.
async function waitNonUniform(page, testid, timeout = 15000) {
  await page.waitForFunction(
    (id) => {
      const c = document.querySelector(`[data-testid="${id}"]`);
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
    testid,
    { timeout }
  );
}

// FNV-1a hash of the spectrogram canvas raster, so a repaint after a scale
// toggle (Task F4) can be detected by a changed hash.
async function spectroHash(page) {
  return page.evaluate(() => {
    const c = document.querySelector('[data-testid="spectrogram-canvas"]');
    if (!(c instanceof HTMLCanvasElement)) return -1;
    const ctx = c.getContext('2d');
    if (!ctx || !c.width || !c.height) return -1;
    const data = ctx.getImageData(0, 0, c.width, c.height).data;
    let h = 2166136261 >>> 0;
    for (let i = 0; i < data.length; i += 4 * 53) {
      h = Math.imul(h ^ data[i], 16777619) >>> 0;
      h = Math.imul(h ^ data[i + 1], 16777619) >>> 0;
      h = Math.imul(h ^ data[i + 2], 16777619) >>> 0;
    }
    return h >>> 0;
  });
}

/**
 * Reads the AMBER beat tics out of a canvas (v1.8, Tasks B2/B3) and reports
 * them as pixel geometry: which device columns are lit inside the tic band,
 * grouped into contiguous runs, plus how many columns are lit ABOVE the band.
 *
 * The hue test is what makes this specific rather than a "something changed"
 * check. A beat tic is `rgba(255,213,79,·)` — yellow — so over the dark stage
 * it satisfies `g − b > r − g`. Everything else the editor lane draws fails
 * that: the cyan waveform/playhead and the accent-soft selection have `b > r`,
 * the cursor is neutral white, and the ORANGE markers (`#ff8a65`) have
 * `r − g` far larger than `g − b`. Half-covered antialiased columns keep the
 * same ratios at lower amplitude, so a tic at a fractional x is still found.
 *
 * `bandCssPx` is the band's height measured up from the canvas bottom, or
 * null for "the whole canvas" (the clip overlay IS the band).
 */
async function beatTicBand(page, testid, bandCssPx) {
  return page.evaluate(
    ({ id, bandCss }) => {
      const c = document.querySelector(`[data-testid="${id}"]`);
      if (!(c instanceof HTMLCanvasElement)) return null;
      const ctx = c.getContext('2d');
      const rect = c.getBoundingClientRect();
      if (!ctx || !c.width || !c.height || !rect.width) return null;
      // Measured, never assumed — the 1:1 backing-store claim is asserted
      // against it for the clip overlay.
      const dpr = c.width / rect.width;
      const isTic = (r, g, b) => r - b > 30 && g - b > 20 && g - b > r - g && r > g;
      const litColumns = (y0, rows) => {
        if (rows <= 0) return [];
        const data = ctx.getImageData(0, y0, c.width, rows).data;
        const out = [];
        for (let x = 0; x < c.width; x++) {
          for (let y = 0; y < rows; y++) {
            const i = (y * c.width + x) * 4;
            if (isTic(data[i], data[i + 1], data[i + 2])) {
              out.push(x);
              break;
            }
          }
        }
        return out;
      };

      const bandRows = bandCss === null ? c.height : Math.min(c.height, Math.ceil(bandCss * dpr));
      const bandTop = c.height - bandRows;
      const cols = litColumns(bandTop, bandRows);
      // 2 device px of slack so an antialiased tic top doesn't read as "above".
      const above = bandTop > 2 ? litColumns(0, bandTop - 2).length : 0;

      const groups = [];
      for (const x of cols) {
        const last = groups[groups.length - 1];
        if (last && x === last.end + 1) last.end = x;
        else groups.push({ start: x, end: x });
      }
      return {
        dpr,
        cssWidth: rect.width,
        cssHeight: rect.height,
        deviceWidth: c.width,
        deviceHeight: c.height,
        columnCount: cols.length,
        aboveBandColumns: above,
        groupCount: groups.length,
        widestGroupPx: groups.reduce((m, g) => Math.max(m, g.end - g.start + 1), 0),
        // Group centres in CSS px, for the "this tic is on that beat" check.
        centresCss: groups.map((g) => (g.start + g.end + 1) / 2 / dpr),
      };
    },
    { id: testid, bandCss: bandCssPx === undefined ? null : bandCssPx }
  );
}

/** One REAL pointer click at a viewport position — `page.mouse`, so it goes
 * through the browser's own input path and the renderer's gesture layer, not
 * through a test hook (plan trap 28: a hook-driven assertion can pass without
 * the magnet ever running). Clicks are separated in time by the caller so
 * Chromium never coalesces two of them into a double-click. */
async function realClick(page, clientX, clientY, { alt = false } = {}) {
  if (alt) await page.keyboard.down('Alt');
  try {
    await page.mouse.move(clientX, clientY);
    await page.mouse.down();
    await page.mouse.up();
  } finally {
    if (alt) await page.keyboard.up('Alt');
  }
}

async function main() {
  // Preconditions ----------------------------------------------------------
  if (!fs.existsSync(path.join(ROOT, 'dist', 'index.html'))) {
    throw new Error('dist/index.html missing — run `npm run build` before the smoke test');
  }
  // test-assets/ is gitignored, so every fixture is generated on demand from
  // its own plain-Node generator (deterministic PRNG => byte-identical output
  // on every machine).
  for (const [file, script, label] of [
    [TONE, 'make-test-tone.cjs', 'test tone'],
    [BEAT, 'make-test-beat.cjs', '120 BPM click train'],
    [ABAB, 'make-test-abab.cjs', 'ABAB structure fixture'],
  ]) {
    if (!fs.existsSync(file)) {
      console.log(`Generating ${label}...`);
      execFileSync(process.execPath, [path.join(ROOT, 'scripts', script)], { stdio: 'inherit' });
    }
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const f of [
    OUT_MP3,
    OUT_WAV,
    OUT_FLAC,
    OUT_MARKERS_WAV,
    OUT_OGG,
    OUT_MARKERS_MP3,
    OUT_MARKERS_FLAC,
    OUT_MARKERS_OGG,
    OUT_SESSION,
    OUT_FADES_SESSION,
    OUT_FADES_REFERENCE,
    SHOT,
  ]) {
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

    // 5b) FLAC format-faithful export → real Chromium FLAC decode round-trip --
    // This is the strongest validation of the encoder: the packaged Chromium
    // (FFmpeg) decoder must accept our container/frames/CRCs and reconstruct the
    // samples. Re-open the pristine tone first so the comparison is clean.
    console.log('Exporting FLAC and decoding it back through Chromium...');
    await page.evaluate((p) => window.__test.openPath(p), TONE);
    const flacBefore = await page.evaluate(() => window.__test.getStateSummary());
    const flacOrig = await page.evaluate(() => window.__test.getChannelSamples(0, 20000, 512));
    const flacOk = await page.evaluate(
      (out) => window.__test.exportActive({ format: 'flac', wavBitDepth: 16, mp3Kbps: 192 }, out),
      OUT_FLAC
    );
    assert(flacOk === true, 'exportActive(flac) reported success');
    assert(fs.existsSync(OUT_FLAC), 'out.flac exists on disk');
    const flacHead = fs.readFileSync(OUT_FLAC).subarray(0, 4).toString('ascii');
    assert(flacHead === 'fLaC', 'out.flac begins with the fLaC magic');
    // Chromium decodes OUR FLAC bytes here — if the stream were malformed,
    // decodeAudioData would throw and openPath would surface an error.
    await page.evaluate((p) => window.__test.openPath(p), OUT_FLAC);
    const flacRt = await page.evaluate(() => window.__test.getStateSummary());
    assert(flacRt.sampleRate === 44100, `decoded FLAC preserves 44100 Hz (got ${flacRt.sampleRate})`);
    assert(
      Math.abs(flacRt.length - flacBefore.length) <= 1,
      `decoded FLAC length ~= original (${flacRt.length} vs ${flacBefore.length})`
    );
    assert(flacRt.channels === 2, `decoded FLAC is stereo (got ${flacRt.channels})`);
    const flacBack = await page.evaluate(() => window.__test.getChannelSamples(0, 20000, 512));
    let flacMaxErr = 0;
    for (let i = 0; i < flacOrig.length; i++) {
      flacMaxErr = Math.max(flacMaxErr, Math.abs(flacOrig[i] - flacBack[i]));
    }
    console.log(`  max sample error after FLAC round trip: ${flacMaxErr.toExponential(3)}`);
    // Encoder scales by 32767, Chromium's 16-bit→float decode divides by 32768,
    // so a full-scale sample can differ by up to 1.5/32768; allow a hair more.
    const flacTol = 1.6 / 32768;
    assert(
      flacMaxErr <= flacTol,
      `FLAC round-trip samples within one 16-bit step (${flacMaxErr.toExponential(3)} <= ${flacTol.toExponential(3)})`
    );
    // Restore the pristine tone as the active document for the steps that follow.
    await page.evaluate((p) => window.__test.openPath(p), TONE);

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

    // 4b-2) Toggle the spectral scale (log <-> linear): the worker recomputes at
    // the new frequency mapping and the canvas repaints (Task F4). Assert the
    // default is log, the toggle flips to linear, the raster changes, and the
    // image stays non-uniform after the recompute.
    console.log('Toggling the spectral scale (log -> linear) and checking recompute...');
    const scaleBefore = await page.evaluate(() => window.__test.getSpectralScale());
    const hashBefore = await spectroHash(page);
    const scaleAfter = await page.evaluate(() => window.__test.toggleSpectralScale());
    console.log(`  spectral scale: ${scaleBefore} -> ${scaleAfter}`);
    assert(scaleBefore === 'log', `spectral scale defaults to log (got ${scaleBefore})`);
    assert(scaleAfter === 'linear', `toggle flips log -> linear (got ${scaleAfter})`);
    await page.waitForFunction(
      (prev) => {
        const c = document.querySelector('[data-testid="spectrogram-canvas"]');
        if (!(c instanceof HTMLCanvasElement)) return false;
        const ctx = c.getContext('2d');
        if (!ctx || !c.width || !c.height) return false;
        const data = ctx.getImageData(0, 0, c.width, c.height).data;
        let h = 2166136261 >>> 0;
        for (let i = 0; i < data.length; i += 4 * 53) {
          h = Math.imul(h ^ data[i], 16777619) >>> 0;
          h = Math.imul(h ^ data[i + 1], 16777619) >>> 0;
          h = Math.imul(h ^ data[i + 2], 16777619) >>> 0;
        }
        return (h >>> 0) !== prev;
      },
      hashBefore,
      { timeout: 15000 }
    );
    const hashAfter = await spectroHash(page);
    console.log(`  spectrogram raster hash: ${hashBefore} -> ${hashAfter}`);
    assert(hashAfter !== hashBefore, 'spectrogram raster changed after the scale toggle (repaint happened)');
    await waitNonUniform(page, 'spectrogram-canvas');
    assert(true, 'spectrogram still non-uniform after recompute on the linear scale');

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
    // Task S4: a take is COMPUTED audio that has never been on disk. It is
    // created with no undo entry, so `dirty` is false — `neverSaved` is what
    // makes closing it (or quitting) ask first instead of discarding it.
    const recSummary = await page.evaluate(() => window.__test.getStateSummary());
    assert(
      recSummary.neverSaved === true,
      `a fresh recording is flagged never-saved (neverSaved=${recSummary.neverSaved}, dirty=${recSummary.dirty})`
    );
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

    // 6b) Live multitrack parameters (Task F5): play the session, change a track
    // volume, retro-apply it to the running graph, confirm the playhead keeps
    // advancing (no rebuild, no stall).
    console.log('Playing the session and changing a track volume live...');
    await page.evaluate(() => window.__test.setView('multitrack'));
    // Let App.tsx's view-change stopAll() effect settle before we start playback.
    await new Promise((resolve) => setTimeout(resolve, 150));
    const live = await page.evaluate(() => window.__test.multitrackLiveParamCheck());
    console.log(`  live params: ${JSON.stringify(live)}`);
    assert(live.started === true, 'multitrack playback started');
    assert(live.stillPlaying === true, 'playback still playing after the live volume change');
    assert(live.advanced === true, `playhead advanced while playing (${live.pos1} -> ${live.pos2})`);
    assert(
      live.volumeGain !== null && live.volumeGain < 0.6,
      `track volume gain ramped down toward -12 dB (~0.25); got ${live.volumeGain}`
    );

    // 6c) Punch-in recording (Task F6): arm a track, set the cursor, record from
    // the fake mic, and confirm a 'Track Recording N' doc + a clip at the cursor.
    console.log('Punch-in recording onto an armed track (fake mic)...');
    const punch = await page.evaluate(() => window.__test.punchInRecord(1.5));
    console.log(`  punch-in: ${JSON.stringify(punch)}`);
    assert(punch.docCreated === true, 'a Track Recording document was created');
    assert(
      /^Track Recording \d+$/.test(punch.docName || ''),
      `recording doc named 'Track Recording N' (got ${punch.docName})`
    );
    assert(punch.clipStart === 22050, `clip landed at the punch-in cursor 22050 (got ${punch.clipStart})`);
    assert((punch.clipLength || 0) > 0, `recorded clip has a positive length (got ${punch.clipLength})`);

    // 6d) Paste with automatic sample-rate conversion (Task F1): copy a region
    // from a 22050 Hz document and paste it into the 44100 Hz tone; the pasted
    // length must be ~2x the copied length after the up-conversion.
    console.log('Paste with automatic sample-rate conversion (22050 -> 44100)...');
    await page.evaluate(() => window.__test.setView('waveform'));
    await page.evaluate((p) => window.__test.openPath(p), TONE);
    const paste = await page.evaluate(() => window.__test.pasteResampleFlow());
    console.log(`  paste-resample: ${JSON.stringify(paste)}`);
    assert(paste.destRate === 44100, `destination doc is 44100 Hz (got ${paste.destRate})`);
    assert(paste.clipRate === 22050, `clipboard captured at 22050 Hz (got ${paste.clipRate})`);
    assert(paste.copiedLen === 10000, `copied 10000 samples from the 22050 Hz doc (got ${paste.copiedLen})`);
    assert(
      Math.abs(paste.insertedLen - 2 * paste.copiedLen) <= 2,
      `pasted length ~= 2x copied (${paste.insertedLen} vs 2*${paste.copiedLen})`
    );

    // 7) Markers round-trip (Task G1 acceptance): add 2 markers, save-as WAV,
    // close, reopen, and confirm both markers survive with correct positions and
    // names — proving the cue/adtl chunks (not leftover store state) carried them.
    console.log('Markers round-trip: add, save-as WAV, close, reopen...');
    await page.evaluate((p) => window.__test.openPath(p), TONE);
    const m1 = await page.evaluate(() => window.__test.addMarkerToActive(5000, 'Verse'));
    const m2 = await page.evaluate(() => window.__test.addMarkerToActive(20000, 'Chorus'));
    assert(m1 !== null, 'marker 1 added to the active document');
    assert(m2 !== null, 'marker 2 added to the active document');

    const markersSaveOk = await page.evaluate(
      (out) => window.__test.saveActiveAs(out),
      OUT_MARKERS_WAV
    );
    assert(markersSaveOk === true, 'saveActiveAs(markers.wav) reported success');
    assert(fs.existsSync(OUT_MARKERS_WAV), 'markers.wav exists on disk');

    await page.evaluate(() => window.__test.closeActive());
    await page.evaluate((p) => window.__test.openPath(p), OUT_MARKERS_WAV);
    const markersAfter = await page.evaluate(() => window.__test.getActiveMarkers());
    console.log(`  markers after reopen: ${JSON.stringify(markersAfter)}`);
    assert(markersAfter.length === 2, `2 markers survive the WAV round trip (got ${markersAfter.length})`);
    assert(
      markersAfter[0] &&
        markersAfter[0].positionSample === 5000 &&
        markersAfter[0].name === 'Verse',
      `marker 1 round-tripped correctly (${JSON.stringify(markersAfter[0])})`
    );
    assert(
      markersAfter[1] &&
        markersAfter[1].positionSample === 20000 &&
        markersAfter[1].name === 'Chorus',
      `marker 2 round-tripped correctly (${JSON.stringify(markersAfter[1])})`
    );

    // 7b) OGG (Opus) round-trip (Task G2 acceptance): export via the real async
    // WebCodecs encoder + pure-TS Ogg muxer, decode it back through Chromium's
    // real Opus decoder, then verify in-place Save re-encodes at the same path.
    console.log('OGG (Opus) round trip: export, decode via Chromium, in-place save...');
    await page.evaluate((p) => window.__test.openPath(p), TONE);
    const oggExportOk = await page.evaluate(
      (out) => window.__test.exportActiveOgg(out, 128_000),
      OUT_OGG
    );
    assert(oggExportOk === true, 'exportActiveOgg reported success');
    assert(fs.existsSync(OUT_OGG), 'out.ogg exists on disk');
    const oggHead = fs.readFileSync(OUT_OGG).subarray(0, 4).toString('ascii');
    assert(oggHead === 'OggS', 'out.ogg begins with the OggS magic');

    // Reopen through the app: this is a REAL Chromium Opus decode of our bytes.
    await page.evaluate((p) => window.__test.openPath(p), OUT_OGG);
    const oggSummary = await page.evaluate(() => window.__test.getStateSummary());
    console.log(`  reopened ogg: ${JSON.stringify(oggSummary)}`);
    assert(oggSummary.sampleRate === 48000, `decoded ogg is 48000 Hz (got ${oggSummary.sampleRate})`);
    const oggDuration = oggSummary.length / oggSummary.sampleRate;
    assert(
      Math.abs(oggDuration - 2.0) <= 0.02,
      `decoded ogg duration ~= 2.0s within ±20ms (got ${oggDuration.toFixed(4)}s)`
    );
    const oggPeak = await page.evaluate(() => window.__test.getPeak());
    assert(oggPeak > 0.1, `decoded ogg is non-silent (peak ${oggPeak.toFixed(4)} > 0.1)`);
    assert(
      oggSummary.filePath === OUT_OGG,
      `reopened ogg document kept its filePath (got ${oggSummary.filePath})`
    );

    // In-place Save re-encodes Opus-in-Ogg to the same path via the real
    // production saveDocument() (no dialog needed — filePath is already set).
    const oggSizeBefore = fs.statSync(OUT_OGG).size;
    const saveResult = await page.evaluate(() => window.__test.saveActiveInPlace());
    console.log(`  in-place save result: ${JSON.stringify(saveResult)}`);
    assert(saveResult.ok === true, 'in-place ogg Save reported success');
    assert(saveResult.dirty === false, 'document is clean after in-place Save');
    assert(saveResult.filePath === OUT_OGG, 'in-place Save kept the same filePath');
    const oggHeadAfter = fs.readFileSync(OUT_OGG).subarray(0, 4).toString('ascii');
    assert(oggHeadAfter === 'OggS', 'out.ogg still begins with the OggS magic after re-save');
    const oggSizeAfter = fs.statSync(OUT_OGG).size;
    console.log(`  out.ogg size: ${oggSizeBefore} -> ${oggSizeAfter} bytes (re-encoded in place)`);

    // 7c) MP3 markers round-trip (Task K6 acceptance): add markers (one with a
    // non-ASCII name), export MP3 (sync exportActive), close, reopen, and
    // confirm both markers survive at their EXACT source-rate positions via the
    // sample-accurate `TXXX AUDITORIUM_MARKERS` frame (id3Chapters.ts) — MP3
    // does not resample, so no rate conversion applies here.
    console.log('MP3 markers round-trip: add, export, close, reopen...');
    await page.evaluate((p) => window.__test.openPath(p), TONE);
    const mp3M1 = await page.evaluate(() => window.__test.addMarkerToActive(8000, 'Intro'));
    const mp3M2 = await page.evaluate(() =>
      window.__test.addMarkerToActive(60000, 'Café ☕ 日本語 🎵')
    );
    assert(mp3M1 !== null, 'mp3 marker 1 added to the active document');
    assert(mp3M2 !== null, 'mp3 marker 2 added to the active document');

    const mp3MarkersOk = await page.evaluate(
      (out) => window.__test.exportActive({ format: 'mp3', wavBitDepth: 16, mp3Kbps: 192 }, out),
      OUT_MARKERS_MP3
    );
    assert(mp3MarkersOk === true, 'exportActive(mp3, with markers) reported success');
    assert(fs.existsSync(OUT_MARKERS_MP3), 'markers.mp3 exists on disk');

    await page.evaluate(() => window.__test.closeActive());
    await page.evaluate((p) => window.__test.openPath(p), OUT_MARKERS_MP3);
    const mp3MarkersAfter = await page.evaluate(() => window.__test.getActiveMarkers());
    console.log(`  mp3 markers after reopen: ${JSON.stringify(mp3MarkersAfter)}`);
    assert(mp3MarkersAfter.length === 2, `2 markers survive the MP3 round trip (got ${mp3MarkersAfter.length})`);
    assert(
      mp3MarkersAfter[0] &&
        mp3MarkersAfter[0].positionSample === 8000 &&
        mp3MarkersAfter[0].name === 'Intro',
      `mp3 marker 1 round-tripped correctly (${JSON.stringify(mp3MarkersAfter[0])})`
    );
    assert(
      mp3MarkersAfter[1] &&
        mp3MarkersAfter[1].positionSample === 60000 &&
        mp3MarkersAfter[1].name === 'Café ☕ 日本語 🎵',
      `mp3 marker 2 round-tripped correctly with a non-ASCII name (${JSON.stringify(mp3MarkersAfter[1])})`
    );

    // 7d) FLAC markers round-trip (Task K6 acceptance): add markers (one with a
    // non-ASCII name), export FLAC, close, reopen, and confirm both markers
    // survive at their EXACT positions via the VORBIS_COMMENT
    // AUDITORIUM_MARKERS block (flacMeta.ts / chapterTags.ts) — FLAC keeps the
    // document's own sample rate (no resample), so positions pass through
    // unscaled.
    console.log('FLAC markers round-trip: add, export, close, reopen...');
    await page.evaluate((p) => window.__test.openPath(p), TONE);
    const flacM1 = await page.evaluate(() => window.__test.addMarkerToActive(12000, 'Bridge'));
    const flacM2 = await page.evaluate(() =>
      window.__test.addMarkerToActive(70000, 'Résumé ☕ 日本語')
    );
    assert(flacM1 !== null, 'flac marker 1 added to the active document');
    assert(flacM2 !== null, 'flac marker 2 added to the active document');

    const flacMarkersOk = await page.evaluate(
      (out) => window.__test.exportActive({ format: 'flac', wavBitDepth: 16, mp3Kbps: 192 }, out),
      OUT_MARKERS_FLAC
    );
    assert(flacMarkersOk === true, 'exportActive(flac, with markers) reported success');
    assert(fs.existsSync(OUT_MARKERS_FLAC), 'markers.flac exists on disk');

    await page.evaluate(() => window.__test.closeActive());
    await page.evaluate((p) => window.__test.openPath(p), OUT_MARKERS_FLAC);
    const flacMarkersAfter = await page.evaluate(() => window.__test.getActiveMarkers());
    console.log(`  flac markers after reopen: ${JSON.stringify(flacMarkersAfter)}`);
    assert(
      flacMarkersAfter.length === 2,
      `2 markers survive the FLAC round trip (got ${flacMarkersAfter.length})`
    );
    assert(
      flacMarkersAfter[0] &&
        flacMarkersAfter[0].positionSample === 12000 &&
        flacMarkersAfter[0].name === 'Bridge',
      `flac marker 1 round-tripped correctly (${JSON.stringify(flacMarkersAfter[0])})`
    );
    assert(
      flacMarkersAfter[1] &&
        flacMarkersAfter[1].positionSample === 70000 &&
        flacMarkersAfter[1].name === 'Résumé ☕ 日本語',
      `flac marker 2 round-tripped correctly with a non-ASCII name (${JSON.stringify(flacMarkersAfter[1])})`
    );

    // 7e) OGG (Opus) markers round-trip (Task K6 acceptance): add markers (one
    // with a non-ASCII name) at the source (44100 Hz) rate, export via the
    // async exportActiveOgg hook (which now carries the doc's markers the same
    // way production exportDocument/encodeInPlace do), close, reopen through a
    // REAL Chromium Opus decode (48 kHz), and confirm both markers survive with
    // their positions converted EXACTLY to the file's 48 kHz rate
    // (markersToOpusRate / AUDITORIUM_MARKERS in the OpusTags block).
    console.log('OGG markers round-trip: add, export (async Opus), close, reopen at 48 kHz...');
    await page.evaluate((p) => window.__test.openPath(p), TONE);
    const oggMarkerPos1 = 8820; // 0.2s @ 44100 Hz -> 9600 @ 48000 Hz (exact)
    const oggMarkerPos2 = 39690; // 0.9s @ 44100 Hz -> 43200 @ 48000 Hz (exact)
    const oggM1 = await page.evaluate(
      (pos) => window.__test.addMarkerToActive(pos, 'Hook'),
      oggMarkerPos1
    );
    const oggM2 = await page.evaluate(
      (pos) => window.__test.addMarkerToActive(pos, '日本語 Café 🎵'),
      oggMarkerPos2
    );
    assert(oggM1 !== null, 'ogg marker 1 added to the active document');
    assert(oggM2 !== null, 'ogg marker 2 added to the active document');

    const oggMarkersOk = await page.evaluate(
      (out) => window.__test.exportActiveOgg(out, 128_000),
      OUT_MARKERS_OGG
    );
    assert(oggMarkersOk === true, 'exportActiveOgg(with markers) reported success');
    assert(fs.existsSync(OUT_MARKERS_OGG), 'markers.ogg exists on disk');

    await page.evaluate(() => window.__test.closeActive());
    await page.evaluate((p) => window.__test.openPath(p), OUT_MARKERS_OGG);
    const oggMarkersSummary = await page.evaluate(() => window.__test.getStateSummary());
    assert(
      oggMarkersSummary.sampleRate === 48000,
      `decoded ogg markers file is 48000 Hz (got ${oggMarkersSummary.sampleRate})`
    );
    const oggMarkersAfter = await page.evaluate(() => window.__test.getActiveMarkers());
    console.log(`  ogg markers after reopen: ${JSON.stringify(oggMarkersAfter)}`);
    assert(
      oggMarkersAfter.length === 2,
      `2 markers survive the OGG round trip (got ${oggMarkersAfter.length})`
    );
    const expectedOggPos1 = Math.round((oggMarkerPos1 * 48000) / 44100);
    const expectedOggPos2 = Math.round((oggMarkerPos2 * 48000) / 44100);
    assert(
      oggMarkersAfter[0] &&
        oggMarkersAfter[0].positionSample === expectedOggPos1 &&
        oggMarkersAfter[0].name === 'Hook',
      `ogg marker 1 round-tripped at the rate-converted position ` +
        `(expected ${expectedOggPos1}, got ${JSON.stringify(oggMarkersAfter[0])})`
    );
    assert(
      oggMarkersAfter[1] &&
        oggMarkersAfter[1].positionSample === expectedOggPos2 &&
        oggMarkersAfter[1].name === '日本語 Café 🎵',
      `ogg marker 2 round-tripped at the rate-converted position with a non-ASCII name ` +
        `(expected ${expectedOggPos2}, got ${JSON.stringify(oggMarkersAfter[1])})`
    );

    // 8) Session v3 round-trip (Task M5/F3 acceptance): build a multitrack
    // session containing one document with markers, Save Session to a .audm
    // path (via a headless-safe test hook that drives the real
    // serializeSessionV3 writer, bypassing the native save dialog), confirm
    // the file begins with the v3 binary magic (not the old base64 JSON), then
    // reopen it (via the real parseSessionFileBytes dispatcher) and confirm
    // the document AND its markers survive. This is the flow whose silent
    // failure past ~17 minutes of audio was the critical bug M5 fixed.
    console.log('Session v3 round-trip: build session, save, reopen...');
    await page.evaluate((p) => window.__test.openPath(p), TONE);
    const sessM1 = await page.evaluate(() =>
      window.__test.addMarkerToActive(15000, 'Session Verse')
    );
    const sessM2 = await page.evaluate(() =>
      window.__test.addMarkerToActive(50000, 'Session Chorus')
    );
    assert(sessM1 !== null, 'session marker 1 added to the active document');
    assert(sessM2 !== null, 'session marker 2 added to the active document');

    await page.evaluate(() => window.__test.newSession(44100));
    const sessClip = await page.evaluate(() => window.__test.insertActiveDocAsClip(0, 0));
    assert(sessClip !== null, 'session clip inserted onto track 0');

    const sessionSaveOk = await page.evaluate(
      (out) => window.__test.saveSessionAs(out),
      OUT_SESSION
    );
    assert(sessionSaveOk === true, 'saveSessionAs(.audm) reported success');
    assert(fs.existsSync(OUT_SESSION), 'session.audm exists on disk');
    const sessionHead = fs.readFileSync(OUT_SESSION).subarray(0, 6);
    assert(
      sessionHead.toString('latin1') === 'AUDM3\n',
      `session.audm begins with the v3 binary magic AUDM3\\n (got ${JSON.stringify(sessionHead.toString('latin1'))})`
    );

    const sessionOpen = await page.evaluate(
      (p) => window.__test.openSessionFrom(p),
      OUT_SESSION
    );
    console.log(`  reopened session: ${JSON.stringify(sessionOpen)}`);
    assert(sessionOpen.docCount === 1, `reopened session recreated 1 document (got ${sessionOpen.docCount})`);
    assert(sessionOpen.trackCount >= 1, `reopened session has at least 1 track (got ${sessionOpen.trackCount})`);
    assert(
      sessionOpen.droppedClipCount === 0,
      `reopened session dropped no clips (got ${sessionOpen.droppedClipCount})`
    );

    // The just-reopened document (addDocument'd inside openSessionFrom) is
    // the active one — confirm its audio AND its markers came back from disk.
    const sessionDocSummary = await page.evaluate(() => window.__test.getStateSummary());
    console.log(`  reopened document: ${JSON.stringify(sessionDocSummary)}`);
    assert(
      sessionDocSummary.length === 88200,
      `reopened session document has the tone's length (got ${sessionDocSummary.length})`
    );
    assert(
      sessionDocSummary.sampleRate === 44100,
      `reopened session document is 44100 Hz (got ${sessionDocSummary.sampleRate})`
    );
    const sessionMarkersAfter = await page.evaluate(() => window.__test.getActiveMarkers());
    console.log(`  session markers after reopen: ${JSON.stringify(sessionMarkersAfter)}`);
    assert(
      sessionMarkersAfter.length === 2,
      `2 markers survive the session round trip (got ${sessionMarkersAfter.length})`
    );
    assert(
      sessionMarkersAfter[0] &&
        sessionMarkersAfter[0].positionSample === 15000 &&
        sessionMarkersAfter[0].name === 'Session Verse',
      `session marker 1 round-tripped correctly (${JSON.stringify(sessionMarkersAfter[0])})`
    );
    assert(
      sessionMarkersAfter[1] &&
        sessionMarkersAfter[1].positionSample === 50000 &&
        sessionMarkersAfter[1].name === 'Session Chorus',
      `session marker 2 round-tripped correctly (${JSON.stringify(sessionMarkersAfter[1])})`
    );

    // 9) Marker-dirty close prompt (Task M1/F1 acceptance): a freshly opened
    // document is clean; adding a marker through the app's own store action
    // (the same addMarker path MarkersPanel/menuActions use) must dirty it —
    // that dirty flag is exactly what gates the "Unsaved changes" close
    // prompt (fileService.ts's closeDocumentFlow checks doc.dirty). Asserting
    // the real native confirm dialog itself isn't practical in this headless
    // harness (Electron's dialog.showMessageBox blocks on a real modal with
    // no scriptable driver here), so this asserts the dirty state that gates
    // it, which is what M1 actually changed.
    console.log('Marker-dirty flow: fresh doc + marker -> dirty (Task M1)...');
    await page.evaluate((p) => window.__test.openPath(p), TONE);
    const cleanSummary = await page.evaluate(() => window.__test.getStateSummary());
    assert(
      cleanSummary.dirty === false,
      `freshly opened document is clean before any edit (dirty=${cleanSummary.dirty})`
    );
    // Task S4: a document read off disk is NOT never-saved, so closing it
    // asks nothing. (The computed-document half is asserted at step 5.)
    assert(
      cleanSummary.neverSaved === false,
      `an opened file is not flagged never-saved (neverSaved=${cleanSummary.neverSaved})`
    );
    const dirtyMarkerId = await page.evaluate(() =>
      window.__test.addMarkerToActive(30000, 'Dirty Check')
    );
    assert(dirtyMarkerId !== null, 'marker added for the dirty-check flow');
    const dirtySummary = await page.evaluate(() => window.__test.getStateSummary());
    assert(
      dirtySummary.dirty === true,
      `adding a marker dirties the document, gating the unsaved-changes close prompt (dirty=${dirtySummary.dirty})`
    );
    // Persist so this now-dirty document doesn't trip the unsaved-changes
    // beforeunload prompt at teardown.
    await page.evaluate((out) => window.__test.saveActiveAs(out), OUT_WAV);

    // 10) v1.5 step A — tempo detection (Task T4/T5 acceptance): open a 120 BPM
    // click train and run the REAL shared analysis (worker + cache) over it via
    // the detectTempo hook, which bypasses the Effects > Detect Tempo menu
    // command. Detection is a pure read of the audio — it must NOT dirty the
    // document, which the dirty assertion below pins. The waveform canvas is
    // re-checked here because the click train is a completely different signal
    // from the tone (sparse transients over silence), and canvas painting is
    // unverifiable in Jest — setupTests.ts forces getContext to null — so the
    // smoke is the only place any canvas is proven to paint at all.
    console.log('Tempo detection on a 120 BPM click train...');
    // Step 8's openSessionFrom left the app in the MULTITRACK view, where no
    // waveform-canvas element exists at all — the canvas check below would
    // simply time out rather than fail on the pixels. Opening a file does not
    // change the view, so switch back explicitly.
    await page.evaluate(() => window.__test.setView('waveform'));
    await page.evaluate((p) => window.__test.openPath(p), BEAT);
    const beatSummary = await page.evaluate(() => window.__test.getStateSummary());
    console.log(`  beat120.wav: ${JSON.stringify(beatSummary)}`);
    const tempo = await page.evaluate(() => window.__test.detectTempo());
    console.log(`  detectTempo: ${JSON.stringify(tempo)}`);
    assert(
      tempo.bpm !== null && Math.abs(tempo.bpm - 120) < 1,
      `detected BPM is 120 ±1 (expected |bpm-120| < 1, actual bpm=${tempo.bpm})`
    );
    assert(
      Math.abs(tempo.beatCount - 16) <= 1,
      `tracked 16 beats in 8s at 120 BPM (expected |beatCount-16| <= 1, actual beatCount=${tempo.beatCount})`
    );
    assert(
      tempo.confidence > 0.5,
      `confidence clears the content gate (expected > 0.5, actual ${tempo.confidence})`
    );
    assert(
      tempo.stale === false,
      `analysis is fresh against the live audio (expected stale=false, actual stale=${tempo.stale})`
    );
    assert(
      tempo.firstBeatSample !== null && tempo.firstBeatSample >= 0,
      `first tracked beat has a real sample position (expected >= 0, actual ${tempo.firstBeatSample})`
    );
    await waitNonUniform(page, 'waveform-canvas');
    assert(true, 'waveform canvas painted the click train (non-uniform pixels)');
    const beatDirty = await page.evaluate(() => window.__test.getStateSummary());
    assert(
      beatDirty.dirty === false,
      `tempo detection did not dirty the document (expected dirty=false, actual dirty=${beatDirty.dirty})`
    );

    // 11) v1.5 step B — Match Tempo (Task T8 acceptance): retarget the same
    // click train from 120 to 90 BPM through the real applyTempoChange, which
    // runs the shared 'time-stretch' effect over the whole document (no
    // selection). Slowing down lengthens: ratio = 120/90 = 4/3, and WSOLA's
    // planStretch fixes the output at exactly round(N * ratio) — an integer
    // equality, not a tolerance.
    console.log('Match Tempo 120 -> 90 BPM (real time-stretch through the DSP worker)...');
    const beatLen = beatSummary.length;
    const expectedStretched = Math.round((beatLen * 4) / 3);
    const stretched = await page.evaluate(() => window.__test.changeTempo(120, 90));
    console.log(`  changeTempo: ${JSON.stringify(stretched)} (was ${beatLen} samples)`);
    assert(
      stretched.ok === true,
      `changeTempo(120, 90) applied (expected ok=true, actual ok=${stretched.ok})`
    );
    assert(
      stretched.length === expectedStretched,
      `stretched length is exactly round(${beatLen} * 4/3) (expected ${expectedStretched}, actual ${stretched.length})`
    );
    // Persist so the now-stretched (dirty) document doesn't trip the
    // unsaved-changes beforeunload prompt at teardown.
    await page.evaluate((out) => window.__test.saveActiveAs(out), OUT_WAV);

    // 12) v1.5 step C — Auto-Remix (Task T13 acceptance): open the 64 s ABAB
    // fixture and ask for a 32 s arrangement through the real
    // createRemixDocument (analyse -> plan -> render -> new document),
    // bypassing the Edit > Auto-Remix dialog. The duration is BAR-QUANTISED, so
    // the honest bound is half a phrase (Phi=8 bars at 120 BPM 4/4 is 16 s),
    // not a sample-exact match.
    //
    // TWO requests, because 32 s is genuinely unreachable in STRICT mode on
    // this fixture and that is worth pinning rather than stepping around: the
    // analysis derives 31 whole bars, strict phrase mode forces every run to at
    // least Phi = 8 bars, and 31 - 8k bars can only land on 31 or 23 whole runs
    // — the shortest arrangement carrying a join renders at 24 bars (48 s).
    // So the strict request must REFUSE with 'too-short' (Plan Ruling 6: an
    // unreachable target is reported with the reachable minimum, never silently
    // mis-served — the Auto-Remix dialog clamps its length control to that
    // window, which is why production never issues this request), and the
    // arrangement itself is then built in loose phrase mode, where 32 s is
    // reachable. Both halves are real behaviour; neither bound was relaxed.
    console.log('Auto-Remix the ABAB fixture to a 32 s target...');
    await page.evaluate((p) => window.__test.openPath(p), ABAB);
    const ababSummary = await page.evaluate(() => window.__test.getStateSummary());
    console.log(`  abab120.wav: ${JSON.stringify(ababSummary)}`);

    const strictRefusal = await page.evaluate(() => window.__test.remixToDuration(32));
    console.log(`  remixToDuration(32) [strict]: ${JSON.stringify(strictRefusal)}`);
    assert(
      strictRefusal.ok === false && strictRefusal.status === 'too-short',
      `a target below the strict-mode reachable minimum is refused, not mis-served ` +
        `(expected ok=false status='too-short', actual ok=${strictRefusal.ok} status='${strictRefusal.status}')`
    );

    const remix = await page.evaluate(() => window.__test.remixToDuration(32, { strict: false }));
    console.log(`  remixToDuration(32, {strict:false}): ${JSON.stringify(remix)}`);
    assert(
      remix.ok === true,
      `remixToDuration(32) produced an arrangement (expected ok=true, actual ok=${remix.ok} status=${remix.status})`
    );
    assert(
      Math.abs(remix.bpm - 120) <= 2,
      `remix analysed the source at 120 BPM (expected |bpm-120| <= 2, actual bpm=${remix.bpm})`
    );
    assert(
      Math.abs(remix.bars - 32) <= 1,
      `source derived 32 bars of 4/4 (expected |bars-32| <= 1, actual bars=${remix.bars})`
    );
    assert(
      remix.joins >= 1,
      `the arrangement actually splices (expected joins >= 1, actual joins=${remix.joins})`
    );
    assert(
      Math.abs(remix.achievedSeconds - 32) <= 16,
      `achieved length is within half a phrase of the 32 s target ` +
        `(expected |achieved-32| <= 16, actual achieved=${remix.achievedSeconds.toFixed(3)}s)`
    );
    assert(
      remix.name === 'Remix 1',
      `a new document named 'Remix 1' exists (expected 'Remix 1', actual ${JSON.stringify(remix.name)})`
    );
    const remixPeak = await page.evaluate(() => window.__test.getPeak());
    console.log(`  remix peak: ${remixPeak.toFixed(4)}`);
    assert(
      remixPeak <= 1.0,
      `the rendered remix does not clip (expected peak <= 1.0, actual ${remixPeak.toFixed(4)})`
    );
    await waitNonUniform(page, 'waveform-canvas');
    assert(true, 'waveform canvas painted the rendered remix (non-uniform pixels)');

    const joins = await page.evaluate(() => window.__test.getRemixJoins());
    console.log(`  remix joins (${joins && joins.length}): ${JSON.stringify(joins)}`);
    assert(
      joins !== null && joins.length === remix.joins,
      `getRemixJoins returns the plan's joins (expected ${remix.joins}, actual ${joins && joins.length})`
    );
    const badCost = joins.find((j) => !Number.isFinite(j.cost));
    assert(
      badCost === undefined,
      `every join cost is finite (expected none non-finite, actual ${JSON.stringify(badCost)})`
    );
    const badAt = joins.find((j) => !(j.atSample >= 0 && j.atSample <= remix.length));
    assert(
      badAt === undefined,
      `every join sits inside [0, ${remix.length}] (expected none outside, actual ${JSON.stringify(badAt)})`
    );

    // 12b) OPTIONAL real-song validation — runs only when the user's local
    // real-material fixture exists (it is copyrighted, gitignored, and never
    // required). Exercises the whole real-world chain the synthetic fixtures
    // cannot: MP3 frame-sync sniff -> Chromium decode -> tempo detection on
    // produced music -> full remix (analyse/plan/render) at real scale.
    // Assertions are STRUCTURAL (finite, in-range, no clipping) — real
    // material has no ground truth to hard-code, and the detector's known
    // octave ambiguity is user-correctable by design; the logged numbers are
    // the human-facing evidence.
    if (fs.existsSync(REAL_SONG)) {
      console.log('Real-song validation (optional fixture present)...');
      await page.evaluate((p) => window.__test.openPath(p), REAL_SONG);
      const songSummary = await page.evaluate(() => window.__test.getStateSummary());
      console.log(`  real song: ${JSON.stringify(songSummary)}`);

      const songTempo = await page.evaluate(() => window.__test.detectTempo());
      console.log(`  detectTempo: ${JSON.stringify(songTempo)}`);
      assert(
        songTempo.bpm !== null && songTempo.bpm >= 60 && songTempo.bpm <= 200,
        `real song yields an in-range tempo (expected 60..200 or documented octave thereof, actual ${songTempo.bpm})`
      );
      assert(
        songTempo.confidence > 0 && songTempo.confidence <= 1,
        `real song yields a reported confidence (expected (0,1], actual ${songTempo.confidence})`
      );

      const songRemix = await page.evaluate(() =>
        window.__test.remixToDuration(120, { strict: false })
      );
      console.log(`  remixToDuration(120, {strict:false}): ${JSON.stringify(songRemix)}`);
      assert(
        songRemix.ok === true,
        `real song remixes to a 2:00 target (expected ok=true, actual ok=${songRemix.ok} status=${songRemix.status})`
      );
      assert(
        songRemix.joins >= 1,
        `real-song arrangement actually splices (expected joins >= 1, actual ${songRemix.joins})`
      );
      assert(
        Math.abs(songRemix.achievedSeconds - 120) <= 16,
        `real-song achieved length is within half a phrase of 2:00 ` +
          `(expected |achieved-120| <= 16, actual ${songRemix.achievedSeconds.toFixed(3)}s)`
      );
      const songPeak = await page.evaluate(() => window.__test.getPeak());
      console.log(`  real-song remix peak: ${songPeak.toFixed(4)}`);
      assert(
        songPeak <= 1.0,
        `real-song remix does not clip (expected peak <= 1.0, actual ${songPeak.toFixed(4)})`
      );
      const songJoins = await page.evaluate(() => window.__test.getRemixJoins());
      console.log(`  real-song joins (${songJoins && songJoins.length}): ${JSON.stringify(songJoins)}`);
      const songBadCost = songJoins && songJoins.find((j) => !Number.isFinite(j.cost));
      assert(
        songJoins !== null && songBadCost === undefined,
        `every real-song join cost is finite (actual ${JSON.stringify(songBadCost)})`
      );
    } else {
      console.log('Real-song validation: SKIPPED (optional local fixture not present)');
    }

    // 13) G4 icon rail + glass panel cards (v1.6) ---------------------------
    // Drive the NEW right-edge rail through real DOM clicks: open the Files
    // card, re-activate the analysed abab120.wav source through its row, and
    // confirm the persistent TEMPO card (with its cluster structure strip,
    // since a remix-level analysis exists for that document) is on screen —
    // which also puts the full G4 layout into the screenshot below.
    console.log('G4 rail: Files card, row activation, TEMPO card...');
    const railCount = await page.evaluate(
      () => document.querySelectorAll('[data-testid="sidebar-tabs"]').length
    );
    assert(railCount === 1, `exactly one icon rail is mounted (actual ${railCount})`);
    await page.click('[data-testid="sidebar-tabs"] button[aria-label="Files"]');
    const activeTabG4 = await page.evaluate(() =>
      document.querySelector('[data-testid="sidebar-panel"]')?.getAttribute('data-active-tab')
    );
    assert(
      activeTabG4 === 'files',
      `the Files rail entry drives the panel card (expected 'files', actual '${activeTabG4}')`
    );
    const filesListCount = await page.evaluate(
      () => document.querySelectorAll('[data-testid="files-list"]').length
    );
    assert(
      filesListCount === 1,
      `the Files list renders exactly once — the old left column is gone (actual ${filesListCount})`
    );
    await page.click('[data-testid="files-list"] button:has-text("abab120.wav")');
    const g4Active = await page.evaluate(() => window.__test.getStateSummary());
    assert(
      g4Active.activeName === 'abab120.wav',
      `clicking a Files row activates that document (expected abab120.wav, actual ${g4Active.activeName})`
    );
    await page.waitForSelector('[data-testid="tempo-card"]', { timeout: 5000 });
    assert(true, 'the persistent TEMPO card is visible for the analysed document');
    const stripBlocks = await page.evaluate(
      () => document.querySelectorAll('[data-testid="tempo-card-block"]').length
    );
    assert(
      stripBlocks >= 1,
      `the TEMPO card shows the cluster structure strip (expected >= 1 block, actual ${stripBlocks})`
    );

    // 14) Screenshot ---------------------------------------------------------
    await page.screenshot({ path: SHOT });
    assert(fs.existsSync(SHOT), 'smoke.png screenshot written');

    // 15) v1.8 step A — the beat grid PAINTS (Tasks B2/B3) ------------------
    // Two surfaces, one grid: the editor's bottom band and the multitrack
    // clip's own overlay. Asserted on PIXELS (`beatTicBand`, the same
    // canvas-readback technique as the waveform/spectrogram checks) and cross-
    // checked against `getBeatGridState()`'s numbers, because a hook alone
    // says nothing about what is on screen and pixels alone say nothing about
    // whether they landed on the measured beats.
    console.log('Beat grid: tics on the waveform editor and on a multitrack clip...');
    await page.evaluate(() => window.__test.setView('waveform'));
    await page.evaluate((p) => window.__test.openPath(p), BEAT);
    const gridTempo = await page.evaluate(() => window.__test.detectTempo());
    console.log(`  detectTempo: ${JSON.stringify(gridTempo)}`);
    let gridState = await page.evaluate(() => window.__test.getBeatGridState());
    console.log(`  getBeatGridState: ${JSON.stringify(gridState)}`);

    if (!gridState.hasGrid) {
      console.log(
        `Beat grid: SKIPPED (REPORTED) — no analysis is cached for the click train ` +
          `(detectTempo returned bpm=${gridTempo.bpm}, beatCount=${gridTempo.beatCount}), so ` +
          `there is nothing the grid could legitimately draw. The grid is never derived from a ` +
          `BPM number, so this is a real precondition, not a tolerance.`
      );
    } else {
      assert(
        gridState.visible === true,
        `the beat grid display preference ships ON (actual visible=${gridState.visible})`
      );
      assert(
        gridState.beatCount === gridTempo.beatCount &&
          gridState.firstBeatSample === gridTempo.firstBeatSample,
        `the drawn grid is the analysis's own tracked beats (expected ${gridTempo.beatCount} beats ` +
          `from ${gridTempo.firstBeatSample}, actual ${gridState.beatCount} from ${gridState.firstBeatSample})`
      );
      assert(
        gridState.origin === 'own' && gridState.provisional === false,
        `the grid is this document's own, fresh analysis (actual origin=${gridState.origin}, provisional=${gridState.provisional})`
      );
      // AMENDED RULING 1, made executable: an ordinary Detect Tempo is a
      // `level:'tempo'` run and produces beats and NOTHING ELSE. Bar lines are
      // only drawn when a remix-level analysis genuinely measured a metre, so
      // here there must be no downbeats and no `beatsPerBar` — the alternative
      // would have been inventing a downbeat the DSP never produced.
      assert(
        gridState.beatsPerBar === null && gridState.downbeatCount === 0,
        `a plain Detect Tempo draws beats only — no invented bar lines ` +
          `(expected beatsPerBar=null downbeatCount=0, actual ${gridState.beatsPerBar}/${gridState.downbeatCount})`
      );

      const view = await page.evaluate(() => window.__test.getEditorViewState());
      const band = await beatTicBand(page, 'waveform-canvas', 9);
      assert(band !== null, 'the waveform canvas is readable for the tic-band check');
      console.log(
        `  editor tic band: ${band.groupCount} tic groups / ${band.columnCount} lit device ` +
          `columns, widest ${band.widestGroupPx}px, ${band.aboveBandColumns} lit above the band ` +
          `(canvas ${band.cssWidth.toFixed(0)}x${band.cssHeight.toFixed(0)} CSS, dpr ${band.dpr})`
      );
      assert(
        band.groupCount >= 8,
        `the editor draws a RULER of tics, not one stray mark (expected >= 8 groups, actual ${band.groupCount})`
      );
      assert(
        band.groupCount <= gridState.beatCount,
        `no tic is drawn that no beat accounts for (expected <= ${gridState.beatCount}, actual ${band.groupCount})`
      );
      assert(
        band.widestGroupPx <= Math.max(3, Math.ceil(2 * band.dpr)),
        `each tic is a hairline, not a block (expected <= ${Math.max(3, Math.ceil(2 * band.dpr))} device px, actual ${band.widestGroupPx})`
      );
      assert(
        band.aboveBandColumns === 0,
        `the tics are confined to the 9 px bottom band (expected 0 lit columns above it, actual ${band.aboveBandColumns})`
      );
      // The load-bearing one: a PAINTED tic sits where a MEASURED beat is.
      const expectedFirstX =
        (gridState.firstBeatSample - view.scrollSample) / view.samplesPerPixel;
      const nearestCentre = band.centresCss.reduce(
        (best, x) => (Math.abs(x - expectedFirstX) < Math.abs(best - expectedFirstX) ? x : best),
        Infinity
      );
      console.log(
        `  first tracked beat ${gridState.firstBeatSample} maps to x=${expectedFirstX.toFixed(2)} ` +
          `CSS px at ${view.samplesPerPixel} samples/px; nearest painted tic centre ${nearestCentre.toFixed(2)}`
      );
      assert(
        Math.abs(nearestCentre - expectedFirstX) <= 1.5,
        `a painted tic sits on the first TRACKED beat (expected within 1.5 CSS px of ` +
          `${expectedFirstX.toFixed(2)}, actual ${nearestCentre.toFixed(2)})`
      );

      // The toggle really governs the pixels (View > Toggle Beat Grid).
      const offVisible = await page.evaluate(() => window.__test.toggleBeatGrid());
      assert(offVisible === false, `toggleBeatGrid() reports the grid hidden (actual ${offVisible})`);
      const bandOff = await beatTicBand(page, 'waveform-canvas', 9);
      assert(
        bandOff.groupCount === 0,
        `toggling the grid off removes every tic from the canvas (actual ${bandOff.groupCount} groups)`
      );
      const onVisible = await page.evaluate(() => window.__test.toggleBeatGrid());
      const bandOn = await beatTicBand(page, 'waveform-canvas', 9);
      assert(
        onVisible === true && bandOn.groupCount === band.groupCount,
        `toggling it back on restores exactly the same ruler (expected ${band.groupCount} groups, actual ${bandOn.groupCount})`
      );

      // 15b) the SAME grid on a multitrack clip (B3). The analysis is run
      // above, BEFORE the insert, which is what makes the clip resolve a grid
      // at all — a clip reads its source document's cached analysis and never
      // triggers one.
      const clipSummary = await page.evaluate(() => window.__test.getStateSummary());
      await page.evaluate((rate) => window.__test.newSession(rate), clipSummary.sampleRate);
      const inserted = await page.evaluate(() => window.__test.insertActiveDocAsClip(0, 0));
      assert(inserted !== null, `the analysed document was inserted as a clip (${JSON.stringify(inserted)})`);
      await page.waitForSelector('[data-testid="clip-beat-tics"]', { timeout: 10000 });
      const clipOverlays = await page.evaluate(
        () => document.querySelectorAll('[data-testid="clip-beat-tics"]').length
      );
      assert(
        clipOverlays === 1,
        `the clip carries exactly one beat-tic overlay (actual ${clipOverlays})`
      );
      const clipBand = await beatTicBand(page, 'clip-beat-tics', null);
      assert(clipBand !== null, 'the clip tic overlay is readable');
      console.log(
        `  clip tic band: ${clipBand.groupCount} tic groups / ${clipBand.columnCount} lit device ` +
          `columns, widest ${clipBand.widestGroupPx}px (overlay ${clipBand.deviceWidth}x${clipBand.deviceHeight} ` +
          `device px for ${clipBand.cssWidth.toFixed(0)}x${clipBand.cssHeight.toFixed(0)} CSS, dpr ${clipBand.dpr})`
      );
      assert(
        clipBand.deviceWidth === Math.round(clipBand.cssWidth * clipBand.dpr),
        `the clip overlay's backing store is 1:1, never blit-stretched like the clip's own ` +
          `waveform raster (expected ${Math.round(clipBand.cssWidth * clipBand.dpr)} device px, actual ${clipBand.deviceWidth})`
      );
      assert(
        clipBand.groupCount >= 8,
        `the clip shows the same ruler as the editor (expected >= 8 tic groups, actual ${clipBand.groupCount})`
      );
      assert(
        clipBand.widestGroupPx <= Math.max(3, Math.ceil(2 * clipBand.dpr)),
        `each clip tic is a hairline (expected <= ${Math.max(3, Math.ceil(2 * clipBand.dpr))} device px, actual ${clipBand.widestGroupPx})`
      );
      await page.evaluate(() => window.__test.setView('waveform'));
    }

    // 16) v1.8 step B — the MAGNET actually snaps (Task B4) -----------------
    // Driven with REAL pointer events (`page.mouse`), never through a hook:
    // the test hooks bypass the gesture layer entirely, so a hook-driven
    // assertion would pass without the magnet ever running (plan trap 28).
    // `getEditorViewState()` is a read-only observer — it supplies the
    // pixel↔sample mapping to aim with and reads the cursor back
    // sample-exactly; it performs no snap of its own.
    console.log('Magnet: real pointer clicks near a tracked beat...');
    gridState = await page.evaluate(() => window.__test.getBeatGridState());
    const snapState = await page.evaluate(() => window.__test.getSnapState());
    console.log(`  getSnapState: ${JSON.stringify(snapState)}`);
    const canvasBox = await page.locator('[data-testid="waveform-canvas"]').boundingBox();
    const magnetView = await page.evaluate(() => window.__test.getEditorViewState());
    const targetBeat = gridState.hasGrid ? gridState.firstBeatSample : null;
    const beatX =
      targetBeat === null
        ? null
        : (targetBeat - magnetView.scrollSample) / magnetView.samplesPerPixel;
    // Preconditions, each a real one: a grid to snap to, the magnet on, the
    // beat actually on screen with room either side for both an inside-
    // tolerance and an outside-tolerance click, and the canvas genuinely
    // topmost at the aim point (an overlay would swallow the pointer).
    const clickY = canvasBox ? canvasBox.y + canvasBox.height / 2 : 0;
    const topmost =
      canvasBox && beatX !== null
        ? await page.evaluate(
            ({ x, y }) => {
              const el = document.elementFromPoint(x, y);
              return el ? el.getAttribute('data-testid') || el.tagName : null;
            },
            { x: canvasBox.x + beatX + 4, y: clickY }
          )
        : null;
    const magnetBlocked =
      !gridState.hasGrid
        ? 'no cached analysis, so there is nothing to snap to'
        : !snapState.enabled
          ? 'the magnet preference is off'
          : snapState.targetCount === 0
            ? 'the target set is empty'
            : !canvasBox
              ? 'the waveform canvas has no layout box'
              : beatX === null || beatX < 16 || beatX > canvasBox.width - 40
                ? `the first tracked beat is not on screen with room either side (x=${beatX})`
                : topmost !== 'waveform-canvas'
                  ? `an overlay covers the aim point (topmost element is ${topmost})`
                  : null;

    if (magnetBlocked) {
      console.log(`Magnet: SKIPPED (REPORTED) — ${magnetBlocked}.`);
    } else {
      const spp = magnetView.samplesPerPixel;
      assert(
        snapState.targetCount === gridState.beatCount,
        `every tracked beat is a snap target (expected ${gridState.beatCount}, actual ${snapState.targetCount})`
      );
      console.log(
        `  aiming at beat ${targetBeat} (x=${beatX.toFixed(2)} CSS px, ${spp} samples/px, ` +
          `tolerance ${snapState.tolerancePx} px)`
      );

      // Chromium coalesces clicks that are close in time AND position into a
      // double-click, which selects all; the cursor would still be set, but
      // separating them keeps every click an honest single click.
      const settle = () => page.waitForTimeout(700);

      // 1. A click 4 px PAST the beat — inside the 8 px tolerance — must land
      //    ON the beat, exactly.
      await realClick(page, canvasBox.x + beatX + 4, clickY);
      await settle();
      const snapped = await page.evaluate(() => window.__test.getEditorViewState());
      console.log(
        `  click at beat+4px -> cursorSample ${snapped.cursorSample} (raw would be ` +
          `${Math.round(targetBeat + 4 * spp)})`
      );
      assert(
        snapped.cursorSample === targetBeat,
        `a real click 4 px past the beat lands EXACTLY on it (expected ${targetBeat}, actual ${snapped.cursorSample})`
      );

      // 2. The same click with Alt held must NOT snap (the escape hatch).
      await realClick(page, canvasBox.x + beatX + 4, clickY, { alt: true });
      await settle();
      const withAlt = await page.evaluate(() => window.__test.getEditorViewState());
      console.log(`  click at beat+4px with Alt held -> cursorSample ${withAlt.cursorSample}`);
      assert(
        withAlt.cursorSample !== targetBeat &&
          Math.abs(withAlt.cursorSample - (targetBeat + 4 * spp)) <= spp,
        `holding Alt suspends the magnet (expected ~${Math.round(targetBeat + 4 * spp)} and NOT ` +
          `${targetBeat}, actual ${withAlt.cursorSample})`
      );

      // 3. A click well OUTSIDE the tolerance is left alone — the magnet pulls,
      //    it does not swallow the whole lane.
      await realClick(page, canvasBox.x + beatX + 30, clickY);
      await settle();
      const outside = await page.evaluate(() => window.__test.getEditorViewState());
      console.log(`  click at beat+30px -> cursorSample ${outside.cursorSample}`);
      assert(
        outside.cursorSample !== targetBeat &&
          Math.abs(outside.cursorSample - (targetBeat + 30 * spp)) <= spp,
        `a click 30 px past the beat is left where the pointer was (expected ` +
          `~${Math.round(targetBeat + 30 * spp)}, actual ${outside.cursorSample})`
      );

      // 4. The toggle governs it too, and restores.
      const magnetOff = await page.evaluate(() => window.__test.toggleSnap());
      assert(magnetOff === false, `toggleSnap() reports the magnet off (actual ${magnetOff})`);
      await realClick(page, canvasBox.x + beatX + 4, clickY);
      await settle();
      const offCursor = await page.evaluate(() => window.__test.getEditorViewState());
      console.log(`  click at beat+4px with the magnet OFF -> cursorSample ${offCursor.cursorSample}`);
      assert(
        offCursor.cursorSample !== targetBeat,
        `with the magnet off the same click does not snap (expected NOT ${targetBeat}, actual ${offCursor.cursorSample})`
      );
      const magnetOn = await page.evaluate(() => window.__test.toggleSnap());
      await realClick(page, canvasBox.x + beatX + 4, clickY);
      await settle();
      const backOn = await page.evaluate(() => window.__test.getEditorViewState());
      assert(
        magnetOn === true && backOn.cursorSample === targetBeat,
        `turning the magnet back on restores the snap (expected ${targetBeat}, actual ${backOn.cursorSample})`
      );
    }

    // 17) v1.7 stem separation (Task S7) — LAST, because it leaves the app in
    // the multitrack view with five new documents and must not perturb any
    // step above (including the screenshot).
    //
    // GATED ON THE MODEL, not on a fixture: the 166 MB htdemucs export is
    // downloaded on first use and is never committed, so a machine without it
    // REPORTS a skip with the reason — the same stance as the real-song step,
    // never a silent pass. When a repo-local copy exists (test-assets/models/,
    // gitignored) it is linked/copied into the app's own model directory first,
    // which is exactly where the app's downloader would have put it; the
    // manager re-verifies the sha256 pin from disk before every load, so a bad
    // copy fails loudly rather than separating with a wrong model.
    //
    // The fixture is the 8 s synthetic click train, NOT the copyrighted
    // real-song file: separation runs at ~1.5× realtime, and a smoke step has
    // to stay usable. Assertions are structural (names, counts, the identity),
    // because a model's separation QUALITY has no ground truth to assert.
    console.log('Stem separation (v1.7)...');
    const modelState0 = await page.evaluate(() => window.__test.getStemModelState());
    const expectedModelMb = (modelState0.expectedBytes / 1e6).toFixed(0);
    let modelState = modelState0;
    if (!modelState.downloaded) {
      const repoModel = path.join(ROOT, 'test-assets', 'models', 'htdemucs_fp16weights.onnx');
      const repoSize = fs.existsSync(repoModel) ? fs.statSync(repoModel).size : -1;
      if (repoSize === modelState.expectedBytes) {
        const userData = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));
        const dest = path.join(userData, 'models', 'htdemucs_fp16weights.onnx');
        console.log(`  provisioning the model from test-assets into ${dest}`);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        try {
          fs.linkSync(repoModel, dest);
        } catch {
          fs.copyFileSync(repoModel, dest);
        }
        modelState = await page.evaluate(() => window.__test.getStemModelState());
      }
    }
    if (!modelState.downloaded) {
      console.log(
        `Stem separation: SKIPPED (REPORTED) — the ${expectedModelMb} MB separation model ` +
          `is not on this machine and no valid repo-local copy exists at ` +
          `test-assets/models/htdemucs_fp16weights.onnx. Download it in-app ` +
          `(Edit → Separate into Stems… → Download Model) to make this step run.`
      );
    } else {
      await page.evaluate(() => window.__test.setView('waveform'));
      await page.evaluate((p) => window.__test.openPath(p), BEAT);
      const stemSource = await page.evaluate(() => window.__test.getStateSummary());
      const audioSeconds = stemSource.length / stemSource.sampleRate;
      console.log(
        `  source: ${stemSource.activeName}, ${audioSeconds.toFixed(2)}s, ` +
          `${stemSource.sampleRate} Hz, ${stemSource.channels} ch (docCount ${stemSource.docCount})`
      );
      const stems = await page.evaluate(() => window.__test.separateStems());
      const stemSeconds = stems.elapsedMs / 1000;
      console.log(`  separateStems: ${JSON.stringify(stems)}`);
      console.log(
        `  separation took ${stemSeconds.toFixed(1)}s for ${audioSeconds.toFixed(2)}s of audio ` +
          `(${(audioSeconds / stemSeconds).toFixed(2)}x realtime, model load included)`
      );
      assert(
        stems.ok === true,
        `separation succeeded (expected ok=true, actual ok=${stems.ok} status=${stems.status} message=${stems.message})`
      );

      const expectedNames = ['Drums', 'Bass', 'Vocals', 'Other', 'Residual'].map(
        (label) => `${stemSource.activeName} — ${label}`
      );
      assert(
        JSON.stringify(stems.documentNames) === JSON.stringify(expectedNames),
        `five stem documents with the ruling-6 names and order (expected ${JSON.stringify(
          expectedNames
        )}, actual ${JSON.stringify(stems.documentNames)})`
      );
      const afterSummary = await page.evaluate(() => window.__test.getStateSummary());
      assert(
        afterSummary.docCount === stemSource.docCount + 5,
        `exactly five NEW documents were added (expected ${stemSource.docCount + 5}, actual ${afterSummary.docCount})`
      );
      assert(
        stems.sessionName === `${stemSource.activeName} — Stems`,
        `the session is named after the source (expected '${stemSource.activeName} — Stems', actual '${stems.sessionName}')`
      );
      assert(
        stems.lengthSamples === stemSource.length && stems.sampleRate === stemSource.sampleRate,
        `stems are full-length at the DOCUMENT's own rate (expected ${stemSource.length}@${stemSource.sampleRate}, actual ${stems.lengthSamples}@${stems.sampleRate})`
      );

      const mtCounts = await page.evaluate(() => ({
        views: document.querySelectorAll('[data-testid="multitrack-view"]').length,
        tracks: document.querySelectorAll('[data-testid="track-header"]').length,
        clips: document.querySelectorAll('[data-testid="clip"]').length,
      }));
      assert(
        mtCounts.views === 1,
        `the app switched to the multitrack view (expected 1 multitrack-view, actual ${mtCounts.views})`
      );
      assert(
        mtCounts.tracks === 5 && mtCounts.clips === 5,
        `the landed session has five tracks with one clip each (actual ${mtCounts.tracks} tracks / ${mtCounts.clips} clips)`
      );

      // THE user's own requirement, made executable end-to-end through the
      // built app: mixing the untouched session down reproduces the source.
      // The bound is the float32 storage floor the guarantee is stated against
      // (2^-24 ≈ 5.96e-8 at full scale), not a tuned tolerance.
      const errDb =
        stems.mixdownWorstAbsError > 0
          ? (20 * Math.log10(stems.mixdownWorstAbsError)).toFixed(1)
          : '-inf';
      console.log(
        `  mixdown identity: worst |err| ${stems.mixdownWorstAbsError} (${errDb} dBFS), ` +
          `${(stems.mixdownExactFraction * 100).toFixed(4)}% bit-exact, ` +
          `peak ${stems.mixdownPeak} vs source peak ${stems.sourcePeak}`
      );
      assert(
        stems.exactSumHolds === true,
        `the exact-sum guarantee holds for this source (expected true, actual ${stems.exactSumHolds}, sourcePeak ${stems.sourcePeak})`
      );
      assert(
        stems.mixdownWorstAbsError !== null && stems.mixdownWorstAbsError <= 1e-7,
        `mixing the untouched session down reproduces the source (expected worst |err| <= 1e-7, actual ${stems.mixdownWorstAbsError})`
      );
      assert(
        stems.mixdownExactFraction !== null && stems.mixdownExactFraction >= 0.99,
        `at least 99% of samples are BIT-identical (expected >= 0.99, actual ${stems.mixdownExactFraction})`
      );
      assert(
        stems.mixdownPeak <= 1.0 && stems.mixdownPeak <= stems.sourcePeak + 1e-6,
        `the mixdown does not clip beyond the source's own peak (expected <= min(1, ${stems.sourcePeak} + 1e-6), actual ${stems.mixdownPeak})`
      );
      assert(
        Number.isFinite(stems.sanitisedEstimateSamples),
        `the non-finite-estimate count is reported (actual ${stems.sanitisedEstimateSamples})`
      );
    }

    // 18) v1.9 — clip fades and crossfades, end to end ---------------------
    // Discharges the three standing obligations the unit suites cannot:
    //   (a) a REAL pointer drag that overlaps two clips and arms a crossfade
    //       (X4/X5's gestures ran in jsdom only),
    //   (b) REAL Web Audio rendering of that crossfade compared against the
    //       offline mixdown (the ruling-4 unit parity test sums the player's
    //       graph in test arithmetic — Jest has no OfflineAudioContext),
    //   (c) a fade-carrying .audm written here for the v1.8.0 binary check,
    //       with the raw-sum reference numbers a fade-blind build must match.
    console.log('Crossfades (v1.9): drag-to-overlap, arm, real Web Audio render...');
    await page.evaluate(() => window.__test.setView('waveform'));
    await page.evaluate((p) => window.__test.openPath(p), TONE);
    const toneDoc = await page.evaluate(() => window.__test.getStateSummary());
    assert(
      toneDoc.length === 88200 && toneDoc.sampleRate === 44100,
      `the tone fixture is open and active (${toneDoc.length} samples @ ${toneDoc.sampleRate})`
    );
    await page.evaluate((rate) => window.__test.newSession(rate), 44100);
    const clipA = await page.evaluate(() => window.__test.insertActiveDocAsClip(0, 0));
    const clipB = await page.evaluate(() => window.__test.insertActiveDocAsClip(0, 132300));
    assert(
      clipA !== null && clipB !== null,
      `two tone clips inserted on track 1 at 0 and 132300 (${JSON.stringify([clipA, clipB])})`
    );
    await page.waitForFunction(
      () => document.querySelectorAll('[data-testid="clip"]').length === 2,
      null,
      { timeout: 10000 }
    );
    const fades0 = await page.evaluate(() => window.__test.getClipFadeState());
    assert(
      fades0.clips.every(
        (c) =>
          c.fadeInSample === 0 &&
          c.fadeOutSample === 0 &&
          c.crossInWidth === null &&
          c.crossOutWidth === null
      ),
      'programmatic insertion wrote no fade keys and armed nothing (X5 contract)'
    );

    // A REAL pointer drag: grab clip B mid-body and drop it so it overlaps
    // A's tail by about a second. All aiming is done in pixels from the two
    // clips' own DOM rects (no zoom hook), and the assertions below are on
    // the committed SAMPLE values read back from the store, so pixel
    // rounding cannot fail the step.
    const xfRects = await page.evaluate(() =>
      [...document.querySelectorAll('[data-testid="clip"]')].map((el) => {
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      })
    );
    xfRects.sort((a, b) => a.x - b.x);
    const [rectA, rectB] = xfRects;
    const grabX = rectB.x + rectB.width / 2;
    const grabY = rectB.y + rectB.height / 2;
    // Target: B.start at ~44100 == the middle of A, i.e. B's left edge lands
    // at A's horizontal midpoint.
    const dropX = grabX + (rectA.x + rectA.width / 2 - rectB.x);
    await page.mouse.move(grabX, grabY);
    await page.mouse.down();
    for (let step = 1; step <= 5; step++) {
      await page.mouse.move(grabX + ((dropX - grabX) * step) / 5, grabY, { steps: 4 });
    }
    // Mid-drag, still held: X4's overlap drop hint, and its live Ctrl flip
    // through a REAL keyboard listener.
    await page.waitForFunction(
      () =>
        document.querySelector('[data-testid="overlap-drag-hint"]')?.textContent ===
        'Drop crossfades — hold Ctrl to push clear',
      null,
      { timeout: 5000 }
    );
    assert(true, 'the overlap drop hint appears mid-drag with the crossfade wording');
    await page.keyboard.down('Control');
    await page.waitForFunction(
      () =>
        document.querySelector('[data-testid="overlap-drag-hint"]')?.textContent ===
        'Drop pushes clear of the overlap',
      null,
      { timeout: 5000 }
    );
    assert(true, 'holding Ctrl mid-drag flips the hint to the push-clear wording');
    await page.keyboard.up('Control');
    await page.waitForFunction(
      () =>
        document.querySelector('[data-testid="overlap-drag-hint"]')?.textContent ===
        'Drop crossfades — hold Ctrl to push clear',
      null,
      { timeout: 5000 }
    );
    await page.mouse.up(); // Ctrl NOT held: verbatim commit + arm (X5)

    const fades1 = await page.evaluate(() => window.__test.getClipFadeState());
    const xfA = fades1.clips.find((c) => c.startSample === 0);
    const xfB = fades1.clips.find((c) => c.startSample !== 0);
    assert(xfA && xfB, `both clips still exist after the drop (${JSON.stringify(fades1.clips)})`);
    assert(
      xfB.startSample > 0 && xfB.startSample < 88200,
      `the drop committed a genuine overlap, verbatim (B.start ${xfB.startSample} inside (0, 88200))`
    );
    const xfWidth = 88200 - xfB.startSample;
    assert(
      xfA.fadeOutSample === xfWidth && xfB.fadeInSample === xfWidth,
      `the drag ARMED the pair: both facing fades exactly span the ${xfWidth}-sample overlap`
    );
    assert(
      xfA.crossOutWidth === xfWidth && xfB.crossInWidth === xfWidth,
      'the renderer resolves the pair as a live crossfade (rule 3 confirmed by the resolver itself)'
    );
    assert(
      xfA.fadeInSample === 0 && xfB.fadeOutSample === 0,
      'the away-side edges were not touched by the arm'
    );
    const svgCounts = await page.evaluate(() => ({
      inLine: document.querySelectorAll('[data-testid="crossfade-in-line"]').length,
      outLine: document.querySelectorAll('[data-testid="crossfade-out-line"]').length,
      readout: document.querySelectorAll('[data-testid="crossfade-readout"]').length,
    }));
    assert(
      svgCounts.inLine === 1 && svgCounts.outLine === 1 && svgCounts.readout === 1,
      `the crossfade indicator is drawn: one incoming line, one outgoing line, one width readout (${JSON.stringify(svgCounts)})`
    );

    // Switch both facing curves to equal-gain so the pair law is
    // OBSERVABLE: with the default equal-power curves at rho = 0, k = 1 and
    // the crossfade is numerically identical to two solo fades (X1's
    // documented property) — every audio assertion below would pass without
    // the law ever engaging.
    const curveEchoA = await page.evaluate(
      (id) => window.__test.setClipFade(id, 'out', { curve: 'equal-gain' }),
      xfA.clipId
    );
    const curveEchoB = await page.evaluate(
      (id) => window.__test.setClipFade(id, 'in', { curve: 'equal-gain' }),
      xfB.clipId
    );
    assert(
      curveEchoA.fadeOutCurve === 'equal-gain' &&
        curveEchoB.fadeInCurve === 'equal-gain' &&
        curveEchoA.fadeOutSample === xfWidth &&
        curveEchoB.fadeInSample === xfWidth &&
        curveEchoA.crossOutWidth === xfWidth &&
        curveEchoB.crossInWidth === xfWidth,
      'both facing curves switched to equal-gain; lengths untouched, pair still armed'
    );

    // Save the ARMED, fade-carrying session — the file the v1.8.0 binary
    // compatibility check opens.
    const savedFades = await page.evaluate(
      (p) => window.__test.saveSessionAs(p),
      OUT_FADES_SESSION
    );
    assert(
      savedFades === true && fs.existsSync(OUT_FADES_SESSION),
      `the fade-carrying session was written to ${OUT_FADES_SESSION}`
    );

    // (b) REAL Web Audio rendering: the genuine player graph rendered by the
    // genuine engine, compared per sample against mixdownSession. Anchors are
    // computed HERE with independent arithmetic (never through dsp/fades.ts),
    // so two identically-wrong paths cannot agree their way past them.
    const bStart = xfB.startSample;
    const probeJs = [
      Math.floor(xfWidth / 4),
      Math.floor((xfWidth - 1) / 2),
      Math.floor((3 * xfWidth) / 4),
    ];
    const probeIdxs = probeJs.map((j) => bStart + j);
    const srcA = await page.evaluate(
      (idxs) => idxs.map((i) => window.__test.getChannelSamples(0, i, 1)[0]),
      probeIdxs
    );
    const srcB = await page.evaluate(
      (js) => js.map((j) => window.__test.getChannelSamples(0, j, 1)[0]),
      probeJs
    );
    const web = await page.evaluate(
      ({ overlap, probes }) => window.__test.renderSessionWebAudio(overlap, probes),
      { overlap: { start: bStart, end: 88200 }, probes: probeIdxs }
    );
    console.log(
      `  renderSessionWebAudio: ${JSON.stringify({ ...web, probes: undefined })} (${web.probes.length} probes)`
    );
    assert(web.ok === true, `the offline Web Audio render succeeded (${web.reason})`);
    assert(
      web.lengthSamples === bStart + 88200,
      `the render spans the session (expected ${bStart + 88200}, actual ${web.lengthSamples})`
    );
    assert(
      web.worstAbsErrorOutside === 0,
      `outside the overlap the real Web Audio render is BIT-IDENTICAL to the mixdown (worst |err| ${web.worstAbsErrorOutside})`
    );
    assert(
      web.worstAbsErrorInside <= 1e-6,
      `inside the crossfade the two paths agree to the float32 store-rounding class (worst |err| ${web.worstAbsErrorInside} <= 1e-6)`
    );
    assert(
      web.webPeak <= 1 && web.mixPeak <= 1,
      `the k-normalised crossfade does not clip (web peak ${web.webPeak}, mixdown peak ${web.mixPeak})`
    );
    // Law anchors: equal-gain pair at rho = 0 under the generalised
    // normaliser k = sqrt(g0^2 + g1^2), computed independently.
    const f32 = Math.fround;
    for (let p = 0; p < probeIdxs.length; p++) {
      const t = probeJs[p] / (xfWidth - 1);
      const k = Math.sqrt((1 - t) * (1 - t) + t * t);
      const expected = f32(srcA[p] * ((1 - t) / k)) + f32(srcB[p] * (t / k));
      const probe = web.probes[p];
      assert(
        Math.abs(probe.webL - expected) <= 5e-7 && Math.abs(probe.mixL - expected) <= 5e-7,
        `law anchor at overlap sample ${probeJs[p]}/${xfWidth}: web ${probe.webL} and mixdown ${probe.mixL} within 5e-7 of the independent equal-gain/k expectation ${expected}`
      );
      assert(
        probe.webR === probe.webL,
        `the dual-mono fixture renders identical channels (R ${probe.webR} == L ${probe.webL})`
      );
    }

    // (c) Reference numbers for the v1.8.0 binary check: what a fade-BLIND
    // build must produce from this same .audm — the raw sum. Measured by
    // RELEASING the crossfade here (ruling 10: the fade-less path is the
    // literally unchanged v1.8.0 loop), then re-arming through the hook.
    const armedMix = await page.evaluate(() => window.__test.mixdownSession());
    const armedPeak = await page.evaluate(() => window.__test.getPeak());
    const released = await page.evaluate(
      (id) => window.__test.releaseCrossfade(id, 'in'),
      xfB.clipId
    );
    assert(
      released.ok === true && released.outClipId === xfA.clipId && released.inClipId === xfB.clipId,
      `releaseCrossfade cleared the pair (${JSON.stringify(released)})`
    );
    const fadesReleased = await page.evaluate(() => window.__test.getClipFadeState());
    assert(
      fadesReleased.clips.every(
        (c) => c.fadeInSample === 0 && c.fadeOutSample === 0 && c.crossInWidth === null
      ),
      'after Release both facing fades are gone and nothing is armed'
    );
    const rawMix = await page.evaluate(() => window.__test.mixdownSession());
    const rawPeak = await page.evaluate(() => window.__test.getPeak());
    assert(
      rawMix.length === armedMix.length,
      `armed and raw mixdowns have the same length (${armedMix.length})`
    );
    assert(
      Math.abs(rawMix.rms - armedMix.rms) > 1e-3,
      `the crossfade AUDIBLY differs from the raw sum (rms armed ${armedMix.rms} vs raw ${rawMix.rms})`
    );
    fs.writeFileSync(
      OUT_FADES_REFERENCE,
      JSON.stringify(
        {
          audmPath: OUT_FADES_SESSION,
          trackCount: 4,
          clipCount: 2,
          aStartSample: 0,
          bStartSample: bStart,
          overlapWidth: xfWidth,
          armedMixdown: { length: armedMix.length, rms: armedMix.rms, peak: armedPeak },
          rawMixdown: { length: rawMix.length, rms: rawMix.rms, peak: rawPeak },
        },
        null,
        2
      )
    );
    console.log(`  reference written: ${OUT_FADES_REFERENCE}`);

    // Recovery: the hook's Arm (the panel's direct path) re-arms the released
    // pair at the exact width.
    const rearmed = await page.evaluate((id) => window.__test.armCrossfade(id, 'in'), xfB.clipId);
    assert(
      rearmed.ok === true && rearmed.width === xfWidth,
      `armCrossfade re-arms the released pair at the exact width (${JSON.stringify(rearmed)})`
    );

    // Round-trip: the fade-carrying .audm reopens in THIS build with the
    // armed pair and both equal-gain curves intact.
    const fadesReopened = await page.evaluate(
      (p) => window.__test.openSessionFrom(p),
      OUT_FADES_SESSION
    );
    assert(
      fadesReopened.trackCount === 4 && fadesReopened.droppedClipCount === 0,
      `the fade-carrying session reopened (${JSON.stringify(fadesReopened)})`
    );
    const fades2 = await page.evaluate(() => window.__test.getClipFadeState());
    const xfA2 = fades2.clips.find((c) => c.startSample === 0);
    const xfB2 = fades2.clips.find((c) => c.startSample === bStart);
    assert(
      xfA2 &&
        xfB2 &&
        xfA2.fadeOutSample === xfWidth &&
        xfB2.fadeInSample === xfWidth &&
        xfA2.fadeOutCurve === 'equal-gain' &&
        xfB2.fadeInCurve === 'equal-gain' &&
        xfA2.crossOutWidth === xfWidth &&
        xfB2.crossInWidth === xfWidth,
      'fade lengths, curves and the armed crossfade all survived the .audm round trip'
    );

    // The Ctrl opt-out, end to end: drag B further into A but hold Ctrl at
    // the drop — the v1.8 forward-only nudge fires, B lands EXACTLY at A's
    // end, and the store disarms the stale pair (both facing fades cleared).
    await page.waitForFunction(
      () => document.querySelectorAll('[data-testid="clip"]').length === 2,
      null,
      { timeout: 10000 }
    );
    const xfRects2 = await page.evaluate(() =>
      [...document.querySelectorAll('[data-testid="clip"]')].map((el) => {
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      })
    );
    xfRects2.sort((a, b) => a.x - b.x);
    const rB2 = xfRects2[1];
    const grab2X = rB2.x + rB2.width / 2;
    const grab2Y = rB2.y + rB2.height / 2;
    await page.mouse.move(grab2X, grab2Y);
    await page.mouse.down();
    await page.mouse.move(grab2X - 30, grab2Y, { steps: 8 });
    await page.keyboard.down('Control');
    await page.mouse.up();
    await page.keyboard.up('Control');
    const fades3 = await page.evaluate(() => window.__test.getClipFadeState());
    const xfA3 = fades3.clips.find((c) => c.startSample === 0);
    const xfB3 = fades3.clips.find((c) => c.startSample !== 0);
    assert(
      xfB3.startSample === 88200,
      `Ctrl at the drop restored the v1.8 nudge: B pushed forward EXACTLY clear of A (B.start ${xfB3.startSample})`
    );
    assert(
      xfA3.fadeOutSample === 0 && xfB3.fadeInSample === 0 && xfA3.crossOutWidth === null,
      'the no-longer-overlapping pair was disarmed — no stale facing fades survive'
    );

    // 19) F0 (v1.10) — automation keys, end to end --------------------------
    // Discharges the packaged-app obligations the 103 unit/parity tests
    // cannot:
    //   (a) REAL gestures on the built app: open the volume envelope from the
    //       track header, Alt-click keys onto the lane (Alt suspends the
    //       magnet so the aimed pixel IS the committed sample), drag one,
    //       right-click both away — asserting committed store state after
    //       each, ruling B's disabled fader in the real DOM, and trap T9's
    //       field-absence after the last key dies;
    //   (b) REAL Web Audio parity over MOVING vol+pan envelopes: exact lanes
    //       set through the store's write boundary, rendered through the
    //       genuine player graph in an OfflineAudioContext (baked buffers,
    //       neutralised nodes) and required BIT-IDENTICAL to mixdownSession,
    //       with law anchors computed here with independent arithmetic;
    //   (c) the automation-carrying .audm round-trips, lanes intact.
    // Entry state from step 18: track 1 holds A [0, 88200) and B
    // [88200, 176400), fade-free and disarmed; the tone doc is dual-mono
    // STEREO (identical channels), so the stereo balance law governs pan.
    console.log('Automation keys (F0): envelope gestures, baked render parity, round trip...');
    const auto0 = await page.evaluate(() => window.__test.getAutomationState());
    assert(
      auto0.tracks.length === 4 && auto0.tracks.every((t) => t.automation === null),
      'no track carries an automation field before the first key (absent means none)'
    );

    // (a) Open the volume envelope from the FIRST track header's real toggle.
    const volToggles = await page.$$('[aria-label="Volume envelope"]');
    assert(volToggles.length === 4, `each track header has a volume envelope toggle (${volToggles.length})`);
    await volToggles[0].click();
    await page.waitForFunction(
      () => document.querySelectorAll('[data-testid="envelope-lane"]').length === 1,
      null,
      { timeout: 5000 }
    );
    assert(true, 'the envelope lane overlay opened on track 1');

    // Pixel→sample conversion derived from clip A's own rect (A spans
    // [0, 88200), so its width in px measures the zoom — no zoom hook).
    const envRects = await page.evaluate(() => {
      const clips = [...document.querySelectorAll('[data-testid="clip"]')].map((el) => {
        const r = el.getBoundingClientRect();
        return { x: r.x, width: r.width };
      });
      const lane = document.querySelector('[data-testid="envelope-lane"]').getBoundingClientRect();
      return { clips: clips.sort((a, b) => a.x - b.x), lane: { x: lane.x, y: lane.y, height: lane.height } };
    });
    const envA = envRects.clips[0];
    const sppEst = 88200 / envA.width;
    const laneY = envRects.lane.y;
    const laneH = envRects.lane.height;
    // The lane's value mapping (EnvelopeLane constants: PAD_Y 6, range
    // −60..+12 dB): y → −60 + (1 − (yLocal − 6)/(laneH − 12))·72.
    const yFor = (dB) => laneY + 6 + (1 - (dB + 60) / 72) * (laneH - 12);

    // Two Alt-clicks: key 1 at ~25% of A (quiet), key 2 at ~75% (loud).
    await realClick(page, envA.x + envA.width * 0.25, laneY + laneH * 0.75, { alt: true });
    await realClick(page, envA.x + envA.width * 0.75, laneY + laneH * 0.25, { alt: true });
    const auto1 = await page.evaluate(() => window.__test.getAutomationState());
    const volLane1 = (auto1.tracks[0].automation ?? []).find((l) => l.param === 'volumeDb');
    assert(
      volLane1 && volLane1.keys.length === 2,
      `two Alt-clicks committed two volume keys (${JSON.stringify(auto1.tracks[0].automation)})`
    );
    const [k1, k2] = volLane1.keys;
    assert(
      Math.abs(k1.positionSample - 22050) <= 4 * sppEst &&
        Math.abs(k2.positionSample - 66150) <= 4 * sppEst &&
        k1.positionSample < k2.positionSample,
      `the keys landed where aimed, ascending (${k1.positionSample} ~22050, ${k2.positionSample} ~66150, ±${Math.round(4 * sppEst)})`
    );
    assert(
      k1.value > -50 && k1.value < -39 && k2.value > -9 && k2.value < 2 && k1.value < k2.value,
      `the key values follow the aimed heights (quiet ${k1.value} dB, loud ${k2.value} dB)`
    );
    // Ruling B in the real DOM: track 1's volume fader is governed/disabled,
    // track 2's is not, and the pan fader on track 1 stays live.
    const faderState = await page.evaluate(() => {
      const headers = [...document.querySelectorAll('[data-testid="track-header"]')];
      const vol = (i) => headers[i].querySelector('[aria-label="Volume (dB)"]').disabled;
      const pan = (i) => headers[i].querySelector('[aria-label="Pan"]').disabled;
      return { vol0: vol(0), vol1: vol(1), pan0: pan(0) };
    });
    assert(
      faderState.vol0 === true && faderState.vol1 === false && faderState.pan0 === false,
      `an active lane disables ONLY its own fader (${JSON.stringify(faderState)})`
    );

    // A REAL key drag: grab key 2 at its committed position (the value→y map
    // above), pull it right by ~10% of A with Alt held, release — ONE commit.
    const k2x = envA.x + k2.positionSample / sppEst;
    const k2y = yFor(k2.value);
    await page.keyboard.down('Alt');
    await page.mouse.move(k2x, k2y);
    await page.mouse.down();
    await page.mouse.move(k2x + envA.width * 0.1, k2y, { steps: 6 });
    await page.mouse.up();
    await page.keyboard.up('Alt');
    const auto2 = await page.evaluate(() => window.__test.getAutomationState());
    const volLane2 = (auto2.tracks[0].automation ?? []).find((l) => l.param === 'volumeDb');
    const k2moved = volLane2.keys[1];
    assert(
      volLane2.keys.length === 2 &&
        Math.abs(k2moved.positionSample - (k2.positionSample + 8820)) <= 4 * sppEst &&
        Math.abs(k2moved.value - k2.value) <= 1,
      `the drag moved key 2 by ~8820 samples at constant value, in one commit (${k2.positionSample}→${k2moved.positionSample}, ${k2.value}→${k2moved.value})`
    );

    // Right-click deletes: first the moved key, then the last one — after
    // which the FIELD itself must be gone (T9) and the fader live again.
    const rightClick = async (x, y) => {
      await page.mouse.move(x, y);
      await page.mouse.down({ button: 'right' });
      await page.mouse.up({ button: 'right' });
    };
    await rightClick(envA.x + k2moved.positionSample / sppEst, yFor(k2moved.value));
    const auto3 = await page.evaluate(() => window.__test.getAutomationState());
    assert(
      auto3.tracks[0].automation.find((l) => l.param === 'volumeDb').keys.length === 1,
      'right-click deleted the moved key (one remains)'
    );
    await rightClick(envA.x + k1.positionSample / sppEst, yFor(k1.value));
    const auto4 = await page.evaluate(() => window.__test.getAutomationState());
    assert(
      auto4.tracks[0].automation === null,
      'deleting the last key removed the automation FIELD entirely (absent means none, T9)'
    );
    const faderAfter = await page.evaluate(
      () =>
        [...document.querySelectorAll('[data-testid="track-header"]')][0].querySelector(
          '[aria-label="Volume (dB)"]'
        ).disabled
    );
    assert(faderAfter === false, 'the volume fader is live again once no lane governs it');
    await volToggles[0].click(); // close the envelope overlay
    await page.waitForFunction(
      () => document.querySelectorAll('[data-testid="envelope-lane"]').length === 0,
      null,
      { timeout: 5000 }
    );

    // (b) Exact MOVING lanes through the write boundary, then the genuine
    // engine. Both params automated => the player neutralises volume AND pan
    // nodes to unity, so the baked buffers pass through the graph untouched
    // and the render must be BIT-IDENTICAL to the mixdown — the strongest
    // form of the playback≡mixdown invariant, now over a moving envelope.
    await page.evaluate(() => {
      window.__test.upsertAutomationKey(0, 'volumeDb', { positionSample: 0, value: -6, curve: 'equal-gain' });
      window.__test.upsertAutomationKey(0, 'volumeDb', { positionSample: 88200, value: 0, curve: 'smooth' });
      window.__test.upsertAutomationKey(0, 'volumeDb', { positionSample: 132300, value: -3 });
      window.__test.upsertAutomationKey(0, 'pan', { positionSample: 22050, value: -0.8, curve: 'equal-gain' });
      window.__test.upsertAutomationKey(0, 'pan', { positionSample: 154350, value: 0.8 });
    });
    const autoSet = await page.evaluate(() => window.__test.getAutomationState());
    const setLanes = autoSet.tracks[0].automation;
    assert(
      setLanes &&
        setLanes.length === 2 &&
        setLanes[0].param === 'volumeDb' &&
        setLanes[0].keys.length === 3 &&
        setLanes[1].param === 'pan' &&
        setLanes[1].keys.length === 2,
      `the write boundary stored both exact lanes (${JSON.stringify(setLanes)})`
    );

    // Probe positions sit OFF the tone's zero crossings (multiples of 22050
    // are exact zeros of the 440 Hz fixture — an anchor at src 0 passes no
    // matter what the gains do); a non-vacuity guard below enforces it.
    const autoProbeIdxs = [44125, 88225, 110275, 132325, 160000];
    const autoWeb = await page.evaluate(
      (probes) => window.__test.renderSessionWebAudio(null, probes),
      autoProbeIdxs
    );
    console.log(
      `  renderSessionWebAudio (automation): ${JSON.stringify({ ...autoWeb, probes: undefined })}`
    );
    assert(autoWeb.ok === true, `the automated offline render succeeded (${autoWeb.reason})`);
    assert(
      autoWeb.lengthSamples === 176400,
      `the render spans both clips (expected 176400, actual ${autoWeb.lengthSamples})`
    );
    assert(
      autoWeb.worstAbsError === 0 && autoWeb.exactFraction === 1,
      `with both lanes baked and every live gain at unity, the REAL Web Audio render is BIT-IDENTICAL to the mixdown over the whole session (worst |err| ${autoWeb.worstAbsError}, exact ${autoWeb.exactFraction})`
    );
    assert(
      autoWeb.webPeak <= 1 && autoWeb.mixPeak <= 1,
      `the automated render does not clip (web peak ${autoWeb.webPeak}, mix peak ${autoWeb.mixPeak})`
    );

    // Law anchors with independent arithmetic (never through dsp/fades.ts or
    // multitrack/automation.ts): the lane values at each probe are computed
    // from the interpolation formulas inline, the pan gains from the STEREO
    // balance law (tone.wav is a dual-mono STEREO file, so the clip's channel
    // count selects the balance law — unity on the near side, cosine on the
    // far side; the first run of this step assumed the mono law and its
    // anchors failed by exactly the law difference, which is the anchors
    // doing their job), dB→linear from 10^(dB/20), and the per-sample product
    // in the engines' multiply order src·v·gPan (clip gain 1 and fade 1 drop
    // out exactly). Dual-mono: both channels share the same source sample.
    const autoVolAt = (s) =>
      s < 88200
        ? -6 + 6 * (s / 88200) // equal-gain segment −6 → 0
        : s < 132300
          ? 0 + -3 * ((1 - Math.cos(Math.PI * ((s - 88200) / 44100))) / 2) // smooth 0 → −3
          : -3; // hold after the last key
    const autoPanAt = (s) =>
      s < 22050 ? -0.8 : s < 154350 ? -0.8 + 1.6 * ((s - 22050) / 132300) : 0.8;
    const autoSrc = await page.evaluate(
      (idxs) => idxs.map((i) => window.__test.getChannelSamples(0, i % 88200, 1)[0]),
      autoProbeIdxs
    );
    for (let p = 0; p < autoProbeIdxs.length; p++) {
      const s = autoProbeIdxs[p];
      assert(
        Math.abs(autoSrc[p]) > 0.05,
        `anchor ${s} probes a non-zero source sample (${autoSrc[p]}) — a zero-crossing anchor is vacuous`
      );
      const v = Math.pow(10, autoVolAt(s) / 20);
      const pan = autoPanAt(s);
      const gL = pan <= 0 ? 1 : Math.cos((pan * Math.PI) / 2);
      const gR = pan >= 0 ? 1 : Math.cos((-pan * Math.PI) / 2);
      const expL = f32(autoSrc[p] * v * gL);
      const expR = f32(autoSrc[p] * v * gR);
      const probe = autoWeb.probes[p];
      assert(
        Math.abs(probe.webL - expL) <= 5e-7 && Math.abs(probe.mixL - expL) <= 5e-7,
        `law anchor L at ${s}: web ${probe.webL} and mixdown ${probe.mixL} within 5e-7 of the independent vol+balance-pan expectation ${expL}`
      );
      assert(
        Math.abs(probe.webR - expR) <= 5e-7 && Math.abs(probe.mixR - expR) <= 5e-7,
        `law anchor R at ${s}: web ${probe.webR} and mixdown ${probe.mixR} within 5e-7 of ${expR}`
      );
    }

    // (c) The automation-carrying .audm round-trips with lanes intact — and
    // the untouched tracks still have NO automation field.
    const savedAuto = await page.evaluate((p) => window.__test.saveSessionAs(p), OUT_AUTOMATION_SESSION);
    assert(
      savedAuto === true && fs.existsSync(OUT_AUTOMATION_SESSION),
      `the automation-carrying session was written to ${OUT_AUTOMATION_SESSION}`
    );
    const autoReopened = await page.evaluate((p) => window.__test.openSessionFrom(p), OUT_AUTOMATION_SESSION);
    assert(
      autoReopened.trackCount === 4 && autoReopened.droppedClipCount === 0,
      `the automation session reopened (${JSON.stringify(autoReopened)})`
    );
    const autoBack = await page.evaluate(() => window.__test.getAutomationState());
    assert(
      JSON.stringify(autoBack.tracks[0].automation) === JSON.stringify(setLanes),
      'both lanes — params, positions, values, per-key curves, order — survived the .audm round trip'
    );
    assert(
      autoBack.tracks.slice(1).every((t) => t.automation === null),
      'the automation-free tracks still carry NO automation field after the round trip'
    );

    // 20) F5 (v1.11) — spatial placement, end to end ------------------------
    // Discharges the packaged-app obligations the F5 unit/parity tests
    // cannot:
    //   (a) a REAL positioner gesture on the built app: open the Spatial
    //       sidebar tab, pick track 2, drag the stage — ONE commit writing
    //       azimuth AND distance keys together — and ruling 4 visible in the
    //       real DOM (the pan fader disables with the SPATIAL explanation);
    //   (b) REAL Web Audio render over MOVING spatial lanes that cross the
    //       ±180° azimuth seam and the reference-distance boundary, on a
    //       track that ALSO carries a pan lane (superseded — if the real
    //       engine let the pan lane through, the law anchors break), required
    //       BIT-IDENTICAL to mixdownSession, with anchors computed here from
    //       the laws with independent arithmetic. Step 19's lesson applies:
    //       the tone doc is dual-mono STEREO, so the BALANCE law governs, and
    //       every probe is guarded off the tone's zero crossings;
    //   (c) the spatial-carrying .audm round-trips at formatVersion 3, all
    //       lanes intact on both tracks.
    // Entry state from step 19(c): the reopened automation session — track 1
    // holds A [0, 88200) and B [88200, 176400) plus the volumeDb (3 keys) and
    // pan (2 keys) lanes; tracks 2-4 carry no automation field.
    console.log('Spatial placement (F5): positioner gesture, seam-crossing render parity, round trip...');

    // (a) Open the Spatial tab and aim the positioner at track 2 (lane-free,
    // so the gesture's effect is unambiguous).
    await page.click('[aria-label="Spatial"]');
    await page.waitForSelector('[data-testid="spatial-panel"]', { timeout: 5000 });
    const track2Id = await page.evaluate(
      () => document.querySelector('[data-testid="spatial-track-select"]').options[1].value
    );
    await page.selectOption('[data-testid="spatial-track-select"]', track2Id);

    // Stage geometry: viewBox 300×300, centre (150,150), radius 132 = 10×
    // distance. Aim at (216, 150): hard right (azimuth 90°) at distance 5.
    const stageRect = await page.evaluate(() => {
      const r = document.querySelector('[data-testid="spatial-stage"]').getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    });
    const stagePt = (vx, vy) => ({
      x: stageRect.x + (vx / 300) * stageRect.width,
      y: stageRect.y + (vy / 300) * stageRect.height,
    });
    const aim = stagePt(216, 150);
    await page.mouse.move(aim.x - 8, aim.y);
    await page.mouse.down();
    await page.mouse.move(aim.x, aim.y, { steps: 4 });
    await page.mouse.up();

    const spat1 = await page.evaluate(() => window.__test.getAutomationState());
    const t2Lanes = spat1.tracks[1].automation ?? [];
    const gAz = t2Lanes.find((l) => l.param === 'azimuth');
    const gDist = t2Lanes.find((l) => l.param === 'distance');
    assert(
      gAz && gDist && gAz.keys.length === 1 && gDist.keys.length === 1,
      `ONE stage drag committed one azimuth AND one distance key on track 2 (${JSON.stringify(t2Lanes)})`
    );
    assert(
      gAz.keys[0].positionSample === gDist.keys[0].positionSample,
      `both keys landed on the SAME sample — one batched commit (${gAz.keys[0].positionSample} vs ${gDist.keys[0].positionSample})`
    );
    assert(
      Math.abs(gAz.keys[0].value - 90) <= 2 && Math.abs(gDist.keys[0].value - 5) <= 0.25,
      `the keys carry the aimed position (azimuth ${gAz.keys[0].value} ~90°, distance ${gDist.keys[0].value} ~5×)`
    );
    // Ruling 4 in the real DOM: track 2's pan fader is now governed by the
    // spatial position — disabled, with the SPATIAL explanation (track 2 has
    // no pan lane, so only supersession can disable it).
    const spatFader = await page.evaluate(() => {
      const h = [...document.querySelectorAll('[data-testid="track-header"]')][1];
      const pan = h.querySelector('[aria-label="Pan"]');
      return { disabled: pan.disabled, title: pan.title };
    });
    assert(
      spatFader.disabled === true &&
        spatFader.title === 'Overridden by the spatial position (Spatial panel)',
      `spatial supersession disables the pan fader with its own explanation (${JSON.stringify(spatFader)})`
    );

    // (b) Exact MOVING spatial lanes on track 1 through the write boundary.
    // The azimuth ramp crosses the ±180 seam at s=88200; the distance ramp
    // crosses the reference distance (gain clamps to unity below it) at
    // s=25200; the elevation ramp narrows the image as it climbs. The pan
    // lane from step 19 STAYS on the track — superseded (ruling 4): the
    // anchors below model NO pan-lane factor, so if either real engine let
    // it through, they fail by the pan gains.
    await page.evaluate(() => {
      window.__test.upsertAutomationKey(0, 'azimuth', { positionSample: 22050, value: 170, curve: 'equal-gain' });
      window.__test.upsertAutomationKey(0, 'azimuth', { positionSample: 154350, value: -170 });
      window.__test.upsertAutomationKey(0, 'elevation', { positionSample: 44100, value: -45, curve: 'equal-gain' });
      window.__test.upsertAutomationKey(0, 'elevation', { positionSample: 132300, value: 60 });
      window.__test.upsertAutomationKey(0, 'distance', { positionSample: 0, value: 0.5, curve: 'equal-gain' });
      window.__test.upsertAutomationKey(0, 'distance', { positionSample: 176400, value: 4 });
    });
    const spatSet = await page.evaluate(() => window.__test.getAutomationState());
    const spatLanes = spatSet.tracks[0].automation;
    assert(
      spatLanes &&
        spatLanes.length === 5 &&
        ['volumeDb', 'pan', 'azimuth', 'elevation', 'distance'].every((p) =>
          spatLanes.some((l) => l.param === p)
        ),
      `track 1 carries all five lanes (${JSON.stringify(spatLanes.map((l) => l.param))})`
    );

    // Probes bracket the seam (88175 / 88275) and the reference-distance
    // boundary (20000 below it, everything else above); all sit off the
    // tone's zero crossings (multiples of 22050 are exact zeros) and the
    // non-vacuity guard below measures the actual source samples.
    const spatProbeIdxs = [20000, 44125, 88175, 88275, 132325, 160000];
    const spatWeb = await page.evaluate(
      (probes) => window.__test.renderSessionWebAudio(null, probes),
      spatProbeIdxs
    );
    console.log(
      `  renderSessionWebAudio (spatial): ${JSON.stringify({ ...spatWeb, probes: undefined })}`
    );
    assert(spatWeb.ok === true, `the spatial offline render succeeded (${spatWeb.reason})`);
    assert(
      spatWeb.worstAbsError === 0 && spatWeb.exactFraction === 1,
      `with volume + spatial baked and every live gain at unity, the REAL Web Audio render is BIT-IDENTICAL to the mixdown across the seam-crossing region (worst |err| ${spatWeb.worstAbsError}, exact ${spatWeb.exactFraction})`
    );

    // Law anchors with independent arithmetic (never through dsp/spatial.ts
    // or multitrack/automation.ts): short-arc azimuth, linear elevation and
    // distance ramps, the interaural projection sin(az)·cos(el), the STEREO
    // balance law (dual-mono stereo fixture — step 19's lesson), the inverse
    // distance law 1/max(1, d), and the volume lane from step 19 composing.
    const spAzAt = (s) => {
      if (s <= 22050) return 170;
      if (s >= 154350) return -170;
      const raw = 170 + 20 * ((s - 22050) / 132300);
      return raw > 180 ? raw - 360 : raw; // the SHORT arc across the seam
    };
    const spElAt = (s) => (s <= 44100 ? -45 : s >= 132300 ? 60 : -45 + 105 * ((s - 44100) / 88200));
    const spDistAt = (s) => 0.5 + 3.5 * (s / 176400);
    const spatSrc = await page.evaluate(
      (idxs) => idxs.map((i) => window.__test.getChannelSamples(0, i % 88200, 1)[0]),
      spatProbeIdxs
    );
    const DEG = Math.PI / 180;
    for (let p = 0; p < spatProbeIdxs.length; p++) {
      const s = spatProbeIdxs[p];
      assert(
        Math.abs(spatSrc[p]) > 0.05,
        `spatial anchor ${s} probes a non-zero source sample (${spatSrc[p]}) — a zero-crossing anchor is vacuous`
      );
      const v = Math.pow(10, autoVolAt(s) / 20); // the step-19 volume lane still governs
      const pos = Math.sin(spAzAt(s) * DEG) * Math.cos(spElAt(s) * DEG);
      const gL = pos <= 0 ? 1 : Math.cos((pos * Math.PI) / 2);
      const gR = pos >= 0 ? 1 : Math.cos((-pos * Math.PI) / 2);
      const dg = 1 / Math.max(1, spDistAt(s));
      const expL = f32(spatSrc[p] * v * gL * dg);
      const expR = f32(spatSrc[p] * v * gR * dg);
      const probe = spatWeb.probes[p];
      assert(
        Math.abs(probe.webL - expL) <= 5e-7 && Math.abs(probe.mixL - expL) <= 5e-7,
        `spatial law anchor L at ${s}: web ${probe.webL} and mixdown ${probe.mixL} within 5e-7 of the independent projection expectation ${expL}`
      );
      assert(
        Math.abs(probe.webR - expR) <= 5e-7 && Math.abs(probe.mixR - expR) <= 5e-7,
        `spatial law anchor R at ${s}: web ${probe.webR} and mixdown ${probe.mixR} within 5e-7 of ${expR}`
      );
    }
    // The seam is a numeric wrap, not an audio jump: the two probes 100
    // samples apart across it must be close (the long-arc fold would differ
    // by nearly the full stereo width).
    {
      const a = spatWeb.probes[2];
      const b = spatWeb.probes[3];
      const norm = (x, src) => x / src; // divide out the tone phase
      assert(
        Math.abs(norm(a.webL, spatSrc[2]) - norm(b.webL, spatSrc[3])) < 0.01,
        `the render is continuous across the ±180 seam (normalised L ${norm(a.webL, spatSrc[2])} vs ${norm(b.webL, spatSrc[3])})`
      );
    }

    // (c) The spatial-carrying .audm round-trips at formatVersion 3 — all
    // five lanes on track 1, the gesture's two lanes on track 2, and the
    // untouched tracks still lane-free.
    const savedSpat = await page.evaluate((p) => window.__test.saveSessionAs(p), OUT_SPATIAL_SESSION);
    assert(
      savedSpat === true && fs.existsSync(OUT_SPATIAL_SESSION),
      `the spatial-carrying session was written to ${OUT_SPATIAL_SESSION}`
    );
    const spatReopened = await page.evaluate((p) => window.__test.openSessionFrom(p), OUT_SPATIAL_SESSION);
    assert(
      spatReopened.trackCount === 4 && spatReopened.droppedClipCount === 0,
      `the spatial session reopened (${JSON.stringify(spatReopened)})`
    );
    const spatBack = await page.evaluate(() => window.__test.getAutomationState());
    assert(
      JSON.stringify(spatBack.tracks[0].automation) === JSON.stringify(spatLanes),
      'all five track-1 lanes — params, positions, values, curves, order — survived the round trip'
    );
    assert(
      JSON.stringify(spatBack.tracks[1].automation) === JSON.stringify(t2Lanes),
      "the positioner gesture's azimuth+distance lanes survived on track 2"
    );
    assert(
      spatBack.tracks.slice(2).every((t) => t.automation === null),
      'tracks 3-4 still carry NO automation field after the round trip'
    );

    console.log('\nSMOKE PASSED');
  } finally {
    // The run must NEVER leave an Electron window for a human to close by
    // hand. Graceful close first (the close guard auto-confirms in test
    // mode), but if anything still wedges it — a crashed renderer, a native
    // dialog from a path the guard doesn't own — force-kill after 10 s.
    // close() may itself reject once the process dies; that must not mask
    // the real error from the try block.
    const proc = app.process();
    await Promise.race([
      app.close().catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, 10000)),
    ]);
    if (proc && proc.exitCode === null && !proc.killed) {
      console.error('teardown: graceful close timed out after 10 s; force-killing Electron');
      proc.kill();
    }
  }
}

main().catch((err) => {
  console.error('\nSMOKE FAILED');
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
