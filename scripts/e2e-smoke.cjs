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
const OUT_FLAC = path.join(OUT_DIR, 'out.flac');
const OUT_MARKERS_WAV = path.join(OUT_DIR, 'markers.wav');
const OUT_OGG = path.join(OUT_DIR, 'out.ogg');
const OUT_MARKERS_MP3 = path.join(OUT_DIR, 'markers.mp3');
const OUT_MARKERS_FLAC = path.join(OUT_DIR, 'markers.flac');
const OUT_MARKERS_OGG = path.join(OUT_DIR, 'markers.ogg');
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
  for (const f of [
    OUT_MP3,
    OUT_WAV,
    OUT_FLAC,
    OUT_MARKERS_WAV,
    OUT_OGG,
    OUT_MARKERS_MP3,
    OUT_MARKERS_FLAC,
    OUT_MARKERS_OGG,
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

    // 8) Screenshot ---------------------------------------------------------
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
