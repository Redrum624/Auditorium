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
// PW1: the launch/pin/assert/pointer plumbing this file grew now lives in
// scripts/e2e-lib.cjs, so the navigation walker (scripts/e2e-navigate.cjs)
// drives the app on the SAME rig instead of a copy of it. Nothing below
// changed behaviour — the helpers moved verbatim, `assert` still prints the
// same `ok:` line, and this script's own measurements (the beat-tic hue
// arithmetic, the 20 ms RMS envelope) stayed here because they are the smoke's
// analysis rather than anyone's rig.
const {
  ROOT,
  SMOKE_WINDOW,
  SMOKE_WINDOW_TOLERANCE_PX,
  assert,
  closeApp,
  ensureFixtures,
  launchApp,
  openModuleCard,
  pinWindowGeometry,
  readWav,
  realClick,
  realDrag,
  spectroHash,
  waitNonUniform,
} = require('./e2e-lib.cjs');
const TONE = path.join(ROOT, 'test-assets', 'tone.wav');
const BEAT = path.join(ROOT, 'test-assets', 'beat120.wav');
// F10 Cover Chain fixtures. Two files by design: the chain matches ONE document
// to ANOTHER, so a single fixture cannot exercise it at all. See
// scripts/make-test-cover.cjs for what each property is chosen to reach.
const COVER_REFERENCE = path.join(ROOT, 'test-assets', 'cover-reference.wav');
const COVER_TAKE = path.join(ROOT, 'test-assets', 'cover-take.wav');
// The reverberant reference. Match Reverb declines on the dry one — correctly,
// it is dry — so without this file no packaged run ever has the reverb stage
// engaged, and the chain's LAST stage is never the one that can lift the output
// back over the ceiling. That ordering shipped broken once.
const COVER_REFERENCE_ROOM = path.join(ROOT, 'test-assets', 'cover-reference-room.wav');
// M4: the shared-onset pair, for the alignment arm the three files above cannot
// reach. They are filtered noise with no syllables, so the journey's alignment
// correctly REFUSES on them and the believed arm has never run in the packaged
// app. These two render one syllable schedule twice, the take's laid down
// 0.75 s later.
const COVER_SONG_SYNC = path.join(ROOT, 'test-assets', 'cover-song-sync.wav');
const COVER_TAKE_SYNC = path.join(ROOT, 'test-assets', 'cover-take-sync.wav');
/** The song's stems, shipped pre-separated so stage 1 takes its REUSE path.
 * Extensionless by necessity: a document is named after the whole file
 * basename, and the reuse rule matches `<song doc name> — <label>` exactly. */
const COVER_SONG_SYNC_STEMS = ['Drums', 'Bass', 'Vocals', 'Other', 'Residual'].map((label) =>
  path.join(ROOT, 'test-assets', `cover-song-sync.wav — ${label}`)
);
/**
 * The ground truth, built into the fixtures rather than measured off them, and
 * read from the manifest the PLANTER reads — T3, closing the drift class the
 * v1.28 ledger recorded. It used to be a hand-typed `-0.75` beside
 * `make-test-cover.cjs`'s `+0.75`, so a change to the plant would have left
 * this step asserting the old truth and reporting it as an aligner fault.
 * The negation, and the convention behind it, are explained once in
 * `scripts/cover-fixture-manifest.cjs`.
 */
const { COVER_SYNC_OFFSET_SECONDS } = require('./cover-fixture-manifest.cjs');
/** The DSP's proven accuracy — the tolerance `coverAlign.test.ts` holds its own
 * ground-truth cases to. Measured on this pair through the raw files (the
 * harshest path, with separation contributing nothing): 7.94 ms. */
const COVER_SYNC_TOLERANCE_SECONDS = 0.01;
/**
 * `coverAlign`'s shipped floors, quoted so this step fails if a pass is
 * believed on numbers that do not actually clear them.
 *
 * CC2 re-derived both. The correlation floor ROSE (0.607 -> 0.731) because the
 * coarse envelopes are now low-passed before the Pearson pass, which lifts every
 * peak; the prominence floor FELL (0.186 -> 0.12) because it stopped being
 * derived against unrelated audio and is now derived against a song whose
 * section repeats — the regime where a rival lag is a genuine partial match.
 * Measured on THIS fixture pair through the raw files: peak 0.9977, prominence
 * 0.5184, offset -0.75007 s against a built-in -0.75.
 */
const ALIGN_MIN_CORRELATION = 0.731;
const ALIGN_MIN_PROMINENCE = 0.12;
// Optional real-material fixture: a full commercial track the user placed
// locally under this NEUTRAL filename (test-assets/ is gitignored — the
// track is copyrighted, so neither the audio nor its title is ever
// committed). NEVER required — the real-song step skips cleanly when the
// file is absent.
const REAL_SONG = path.join(ROOT, 'test-assets', 'real-song.mp3');
const ABAB = path.join(ROOT, 'test-assets', 'abab120.wav');
// L7's effect-sweep fixture: four segments (detuned tone / digital silence /
// noise / tone again) so that EVERY visible effect has material it can change.
// See scripts/make-test-sweep.cjs for why tone.wav cannot serve — on a pure,
// in-tune, DC-free, gap-free sine a third of the registry is an exact identity.
const SWEEP = path.join(ROOT, 'test-assets', 'sweep.wav');
// Segment boundaries, copied from the generator's own arithmetic (1.2 s / 2.1 s
// / 3.2 s at 44100). Asserted against the file's real length below.
const SWEEP_LENGTH = 220500;
const SWEEP_SILENCE_START = 52920;
const SWEEP_NOISE_START = 92610;
const SWEEP_NOISE_END = 141120;
// F4b transport fixture: 70 s, deliberately longer than one IPC audio slice
// (see scripts/make-test-long.cjs for the arithmetic).
const LONG70 = path.join(ROOT, 'test-assets', 'long70.wav');
// LONG70's stereo twin (same samples in both channels, same generator): the
// align+splice step's degraded path opens THIS one, because the fake-mic
// replacement take arrives stereo and the splice is designed to refuse a
// channel-count mismatch — see the step for the full why.
const LONG70_STEREO = path.join(ROOT, 'test-assets', 'long70-stereo.wav');
// Optional real-speech fixture the user may drop in. test-assets/ is
// gitignored and this is NEVER required — the transcript-surface half of the
// transcription step falls back to whatever the synthetic fixture produced,
// and reports when that is nothing.
// Same file the opt-in integration test uses (electron/transcribeIntegration.test.cjs),
// so a machine only has to provide one speech fixture.
const SPEECH = path.join(ROOT, 'test-assets', 'speech16k.wav');
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
const OUT_TRANSCRIPT_SRT = path.join(OUT_DIR, 'transcript.srt');
const OUT_VOICE_WAV = path.join(OUT_DIR, 'voice-converted.wav');
const OUT_ALIGN_BEFORE_WAV = path.join(OUT_DIR, 'align-before.wav');
const OUT_ALIGN_AFTER_WAV = path.join(OUT_DIR, 'align-after.wav');
// L7: the two files that must NOT open, and the take that must survive a chain
// and an MP3 round trip.
const OUT_NOT_AUDIO = path.join(OUT_DIR, 'not-audio.txt');
const OUT_TRUNCATED_MP3 = path.join(OUT_DIR, 'truncated.mp3');
const OUT_TAKE_MP3 = path.join(OUT_DIR, 'take.mp3');
const SHOT = path.join(OUT_DIR, 'smoke.png');

/** 20 ms RMS frames of a mono buffer — the smoke's own envelope arithmetic. */
function rmsFrames20ms(x, sampleRate) {
  const size = Math.round(0.02 * sampleRate);
  const n = Math.floor(x.length / size);
  const out = new Float64Array(n);
  for (let f = 0; f < n; f++) {
    let s = 0;
    for (let i = f * size; i < (f + 1) * size; i++) s += x[i] * x[i];
    out[f] = Math.sqrt(s / size);
  }
  return { frames: out, size };
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

async function main() {
  // Preconditions ----------------------------------------------------------
  // test-assets/ is gitignored, so every fixture is generated on demand from
  // its own plain-Node generator (deterministic PRNG => byte-identical output
  // on every machine).
  ensureFixtures([
    [TONE, 'make-test-tone.cjs', 'test tone'],
    [BEAT, 'make-test-beat.cjs', '120 BPM click train'],
    [ABAB, 'make-test-abab.cjs', 'ABAB structure fixture'],
    [SWEEP, 'make-test-sweep.cjs', 'effect-sweep fixture'],
    [LONG70, 'make-test-long.cjs', '70 s multi-slice transcription fixture'],
    [LONG70_STEREO, 'make-test-long.cjs', '70 s stereo align/splice fixture'],
    [COVER_REFERENCE, 'make-test-cover.cjs', 'Cover Chain reference/take pair'],
    [COVER_TAKE, 'make-test-cover.cjs', 'Cover Chain reference/take pair'],
    [COVER_REFERENCE_ROOM, 'make-test-cover.cjs', 'Cover Chain reverberant reference'],
    [COVER_SONG_SYNC, 'make-test-cover.cjs', 'shared-onset cover pair'],
    [COVER_TAKE_SYNC, 'make-test-cover.cjs', 'shared-onset cover pair'],
    ...COVER_SONG_SYNC_STEMS.map((f) => [f, 'make-test-cover.cjs', 'shared-onset song stems']),
  ]);
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
    OUT_TRANSCRIPT_SRT,
    OUT_ALIGN_BEFORE_WAV,
    OUT_ALIGN_AFTER_WAV,
    OUT_NOT_AUDIO,
    OUT_TRUNCATED_MP3,
    OUT_TAKE_MP3,
    SHOT,
  ]) {
    if (fs.existsSync(f)) fs.rmSync(f);
  }

  console.log('Launching built app under Playwright Electron...');
  // `launchApp` checks dist/index.html exists, passes the two fake-media
  // switches (so the recording step below runs headless-safe with no real
  // hardware), sets AUDITORIUM_TEST=1 and waits for window.__test.
  const { app, page } = await launchApp();

  try {
    console.log('window.__test is available.');

    // 0) Pin the window geometry -------------------------------------------
    // Done BEFORE the first document is opened, so every canvas in the run is
    // laid out at the same size on every machine and every display. See
    // SMOKE_WINDOW for the flake this closes.
    const geom = await pinWindowGeometry(app, SMOKE_WINDOW);
    console.log(
      `Window geometry: content ${geom && geom.contentWidth}x${geom && geom.contentHeight} CSS px ` +
        `on the roomiest of ${geom && geom.displayCount} display(s) ` +
        `(work area ${geom && geom.workArea.width}x${geom && geom.workArea.height} @ scale ${geom && geom.scaleFactor})`
    );
    assert(
      geom !== null &&
        Math.abs(geom.contentWidth - SMOKE_WINDOW.width) <= SMOKE_WINDOW_TOLERANCE_PX &&
        Math.abs(geom.contentHeight - SMOKE_WINDOW.height) <= SMOKE_WINDOW_TOLERANCE_PX,
      `the window is pinned to ${SMOKE_WINDOW.width}x${SMOKE_WINDOW.height} CSS px so every ` +
        `canvas readback is deterministic (actual ${geom === null ? 'no window' : `${geom.contentWidth}x${geom.contentHeight}`})`
    );
    // The renderer resizes its canvases from a ResizeObserver, so wait for the
    // new size to reach the document rather than for a fixed delay.
    await page.waitForFunction(
      (want) =>
        Math.abs(window.innerWidth - want.width) <= want.tol &&
        Math.abs(window.innerHeight - want.height) <= want.tol,
      { ...SMOKE_WINDOW, tol: SMOKE_WINDOW_TOLERANCE_PX },
      { timeout: 10000 }
    );
    // The viewport the whole run's CSS measurements come from, re-measured and
    // asserted with its real numbers rather than waved through.
    //
    // It is checked against the REQUEST, not against the main process's
    // `getContentSize()`: at a fractional display scale the two legitimately
    // disagree by a few pixels — measured here at scale 1.75, main reported
    // 1599x1000 while the renderer's viewport was 1602x1002, because each
    // rounds the same physical box to whole units in its own space. Both land
    // within tolerance of what was asked for, which is the property the pixel
    // assertions actually need; asserting the two APIs against each other
    // asserts a rounding rule neither of them promises.
    const laidOut = await page.evaluate(() => ({
      width: window.innerWidth,
      height: window.innerHeight,
      dpr: window.devicePixelRatio,
    }));
    assert(
      Math.abs(laidOut.width - SMOKE_WINDOW.width) <= SMOKE_WINDOW_TOLERANCE_PX &&
        Math.abs(laidOut.height - SMOKE_WINDOW.height) <= SMOKE_WINDOW_TOLERANCE_PX,
      `the renderer laid out at the pinned size (expected ${SMOKE_WINDOW.width}x${SMOKE_WINDOW.height} ` +
        `+/-${SMOKE_WINDOW_TOLERANCE_PX} CSS px, actual ${laidOut.width}x${laidOut.height} at dpr ` +
        `${laidOut.dpr}; main reports content ${geom.contentWidth}x${geom.contentHeight})`
    );

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
    // `>= 1` could not fail: `newSession()` seeds FOUR tracks (sessionStore.ts),
    // so the old bound passed just as happily on a round trip that restored one
    // track, or on none at all with the default session still standing. Step 19
    // already pins `=== 4` for the automation session; this is the same file
    // format and the same writer, so it gets the same exactness (L7).
    assert(
      sessionOpen.trackCount === 4,
      `reopened session restored all 4 tracks, not just the one carrying a clip (got ${sessionOpen.trackCount})`
    );
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
    // the detectTempo hook, which bypasses the Pipeline > Detect Tempo menu
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
    // `>= 0` could not fail: a sample INDEX is non-negative by construction, so
    // any number the tracker returned satisfied it — including a grid a whole
    // beat out of phase. make-test-beat.cjs places its clicks at exact multiples
    // of 22050 from sample 0, so the falsifiable statement is that the first
    // tracked beat lands ON that grid, and on one of its first two clicks (the
    // tracker legitimately misses the click at sample 0 — there is no onset
    // context before it — and reports 15 beats, which this suite's beatCount
    // assertion already tolerates). Measured: 22051, one sample late of the
    // second click; the 64-sample window is 345x tighter than the beat spacing
    // it has to distinguish (L7).
    const BEAT_CLICK_SPACING = 22050;
    const beatPhase = tempo.firstBeatSample === null ? null : tempo.firstBeatSample % BEAT_CLICK_SPACING;
    const beatGridError = beatPhase === null ? null : Math.min(beatPhase, BEAT_CLICK_SPACING - beatPhase);
    assert(
      tempo.firstBeatSample !== null &&
        tempo.firstBeatSample < 2 * BEAT_CLICK_SPACING &&
        beatGridError <= 64,
      `the first tracked beat sits ON the click grid, at one of the first two clicks ` +
        `(expected < ${2 * BEAT_CLICK_SPACING} and within 64 samples of a multiple of ${BEAT_CLICK_SPACING}, ` +
        `actual ${tempo.firstBeatSample}, off-grid by ${beatGridError})`
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

    // 11a) R7 — the OPT-IN variable-rate Match Tempo, in the PACKAGED app.
    // Re-opens the clean 120 BPM fixture, detects its grid, then matches to 90
    // BPM through the variable branch: the tempo map, the __effectExtra side
    // channel and the real DSP worker.
    //
    // Four things are pinned here that the unit suite cannot see through a real
    // window: (a) the branch is reachable at all once packaged — a hidden effect
    // that failed to register would throw inside the worker and report ok=false;
    // (b) the length the dialog PREVIEWED is the length the run produced, which
    // is what makes that readout trustworthy rather than decorative; (c) on a
    // steady fixture the variable path agrees with the one-ratio path's exact
    // round(N * 4/3), so the new branch does not disturb the old contract; and
    // (d) the post-match beat grid is laid from the map's own placed positions.
    console.log('Match Tempo 120 -> 90 BPM, FOLLOWING the tracked beats (R7)...');
    await page.evaluate((f) => window.__test.openPath(f), BEAT);
    const varSummary = await page.evaluate(() => window.__test.getStateSummary());
    const varGrid = await page.evaluate(() => window.__test.detectTempo());
    console.log(`  detectTempo: ${JSON.stringify(varGrid)}`);
    assert(
      varGrid.beatCount >= 2,
      `the fixture yields a grid the variable path can use (expected >= 2 beats, actual ${varGrid.beatCount})`
    );
    // L7 (P1-7): a pre-existing user marker, an audio window and the history
    // depth, all captured BEFORE the run — this is the code that just shipped
    // and nothing had ever exercised its undo path.
    const VAR_MARKER_AT = 30000;
    const varMarkerId = await page.evaluate(
      (at) => window.__test.addMarkerToActive(at, 'Vamp'),
      VAR_MARKER_AT
    );
    assert(varMarkerId !== null, 'a user marker sits on the take before the variable match');
    const varLengthBefore = varSummary.length;
    // A window that straddles the click at 44100 — beat120.wav is a click TRAIN,
    // so most of it is digital silence and a window between two clicks warps to
    // silence-shaped silence. (The anti-vacuous guard below caught exactly that
    // when this window was first placed at 40000: 0 of 4096 samples "moved",
    // because there was nothing there to move.)
    const VAR_WINDOW_AT = 43000;
    const VAR_WINDOW_LEN = 10000;
    const varWindowBefore = await page.evaluate(
      ([at, n]) => window.__test.getChannelSamples(0, at, n),
      [VAR_WINDOW_AT, VAR_WINDOW_LEN]
    );
    const varWindowSignal = varWindowBefore.filter((v) => v !== 0).length;
    assert(
      varWindowSignal > 1000,
      `the window under test holds a real transient, not silence between clicks ` +
        `(${varWindowSignal} of ${VAR_WINDOW_LEN} samples are non-zero)`
    );
    const varHistoryBefore = await page.evaluate(() => window.__test.getHistoryState());
    const varTempo = await page.evaluate(() => window.__test.changeTempoVariable(90, true));
    console.log(`  changeTempoVariable: ${JSON.stringify({ ...varTempo, beatMarkers: varTempo.beatMarkers.length })}`);
    assert(
      varTempo.ok === true,
      `changeTempoVariable(90) applied (expected ok=true, actual ok=${varTempo.ok}, reason=${varTempo.reason})`
    );
    assert(
      varTempo.beatCount === varGrid.beatCount,
      `every tracked beat became a knot (expected ${varGrid.beatCount}, actual ${varTempo.beatCount})`
    );
    assert(
      varTempo.clampedCount === 0,
      `a 120 -> 90 match needs no clamping (expected 0, actual ${varTempo.clampedCount})`
    );
    assert(
      varTempo.lengthAfter === varTempo.plannedLength,
      `the previewed length is the length produced (expected ${varTempo.plannedLength}, actual ${varTempo.lengthAfter})`
    );
    // Deliberately NOT asserted here: "every local ratio is exactly 4/3". The
    // map gives each MEASURED interval one target spacing, so a tracker that
    // returns 15 beats where 16 exist — which this suite's own grid assertion
    // explicitly tolerates — legitimately yields ratios spanning 0.667..1.333
    // and an output one spacing shorter. That would fail R7 for a tracker
    // wobble. What IS R7's, and holds for any grid the tracker returns:
    assert(
      varTempo.minLocalRatio >= 0.25 && varTempo.maxLocalRatio <= 4,
      `every local ratio stays inside the engine band (actual ${varTempo.minLocalRatio.toFixed(4)}..${varTempo.maxLocalRatio.toFixed(4)})`
    );
    assert(
      varTempo.lengthAfter > varTempo.lengthBefore,
      `slowing 120 -> 90 lengthens the document (before ${varTempo.lengthBefore}, after ${varTempo.lengthAfter})`
    );
    assert(
      varTempo.beatMarkers.length === varTempo.beatCount,
      `the post-match grid has one marker per placed beat (expected ${varTempo.beatCount}, actual ${varTempo.beatMarkers.length})`
    );
    // Laid from the map's placed positions: at 90 BPM the markers must be
    // 60/90 s apart, and the LAST gap matters as much as the first — a grid
    // right at beat 0 and wrong after is the expected failure mode.
    if (varTempo.beatMarkers.length >= 3) {
      const rate = varSummary.sampleRate;
      const want = (60 / 90) * rate;
      const first = varTempo.beatMarkers[1] - varTempo.beatMarkers[0];
      const last =
        varTempo.beatMarkers[varTempo.beatMarkers.length - 1] -
        varTempo.beatMarkers[varTempo.beatMarkers.length - 2];
      assert(
        Math.abs(first - want) < want * 0.05,
        `the FIRST post-match beat gap is 60/90 s (expected ~${Math.round(want)}, actual ${first})`
      );
      assert(
        Math.abs(last - want) < want * 0.05,
        `the LAST post-match beat gap is too (expected ~${Math.round(want)}, actual ${last})`
      );
    }

    // L7 (P1-7) — AND BACK AGAIN. The variable path had shipped with no packaged
    // coverage of the way out of it, which is the half a user reaches for when a
    // match sounds wrong. Its documented cost (tempoService.ts) is up to THREE
    // history entries per Apply — `Match Tempo`, `Match Tempo Markers`,
    // `Add Beat Markers` — so the assertion is on the depth the run declares and
    // on what unwinding exactly that many entries restores. Nothing here is a
    // proxy: the length is `===`, the audio is compared sample by sample, and the
    // user's own marker has to come back to the sample it was placed on, not to
    // the proportionally-displaced position the stretch's own remap left it at.
    const varHistoryAfter = await page.evaluate(() => window.__test.getHistoryState());
    const varEntries = varHistoryAfter.done.length - varHistoryBefore.done.length;
    console.log(`  history after the match: ${JSON.stringify(varHistoryAfter.done)}`);
    assert(
      varEntries === 3 &&
        varHistoryAfter.done.slice(-3).join(' | ') ===
          'Match Tempo | Match Tempo Markers | Add Beat Markers',
      `one Apply left exactly the three history entries it documents ` +
        `(got ${varEntries}: ${JSON.stringify(varHistoryAfter.done.slice(-3))})`
    );
    const varMarkersAfter = await page.evaluate(() => window.__test.getActiveMarkers());
    const varVampAfter = varMarkersAfter.filter((m) => m.name === 'Vamp')[0];
    assert(
      varVampAfter !== undefined && varVampAfter.positionSample !== VAR_MARKER_AT,
      `the user marker MOVED with the warp — without this the restore below would ` +
        `pass on a match that never touched it (was ${VAR_MARKER_AT}, now ${varVampAfter && varVampAfter.positionSample})`
    );
    const varWindowAfter = await page.evaluate(
      ([at, n]) => window.__test.getChannelSamples(0, at, n),
      [VAR_WINDOW_AT, VAR_WINDOW_LEN]
    );
    let varWindowMoved = 0;
    for (let i = 0; i < varWindowBefore.length; i++) {
      if (varWindowAfter[i] !== varWindowBefore[i]) varWindowMoved++;
    }
    // The threshold is derived from the window's OWN content rather than picked:
    // the warp carries this click away from where it was, so at minimum every
    // sample that used to be non-zero has to have changed.
    assert(
      varWindowMoved >= varWindowSignal,
      `and the AUDIO moved too, so a restore has something to restore ` +
        `(${varWindowMoved} of ${VAR_WINDOW_LEN} samples differ, and ${varWindowSignal} carried the transient)`
    );
    for (let i = 0; i < varEntries; i++) {
      await page.evaluate(() => window.__test.undoActive());
    }
    const varRestored = await page.evaluate(() => window.__test.getStateSummary());
    const varWindowRestored = await page.evaluate(
      ([at, n]) => window.__test.getChannelSamples(0, at, n),
      [VAR_WINDOW_AT, VAR_WINDOW_LEN]
    );
    let varWindowMismatch = 0;
    for (let i = 0; i < varWindowBefore.length; i++) {
      if (varWindowRestored[i] !== varWindowBefore[i]) varWindowMismatch++;
    }
    assert(
      varRestored.length === varLengthBefore,
      `${varEntries} undos restore the take's exact length (expected ${varLengthBefore}, actual ${varRestored.length})`
    );
    assert(
      varWindowMismatch === 0,
      `and its exact SAMPLES — not a dB proxy, a bit-for-bit window ` +
        `(${varWindowMismatch} of ${varWindowBefore.length} still differ)`
    );
    const varMarkersRestored = await page.evaluate(() => window.__test.getActiveMarkers());
    assert(
      varMarkersRestored.length === 1 &&
        varMarkersRestored[0].name === 'Vamp' &&
        varMarkersRestored[0].positionSample === VAR_MARKER_AT,
      `the beat grid is gone and the user's marker is back on its own sample ` +
        `(expected one 'Vamp' at ${VAR_MARKER_AT}, actual ${JSON.stringify(varMarkersRestored)})`
    );
    await page.evaluate((out) => window.__test.saveActiveAs(out), OUT_WAV);

    // 11b) F9 — Align Vocal Timing, end to end in the PACKAGED app: detect the
    // grid, place markers deliberately OFF the beat, then align them onto it.
    // The three things worth pinning here are the three the unit suite cannot
    // see through a real window: the region length is preserved exactly (this
    // warp must never slide what follows it), the markers RIDE the warp (the
    // effect runner's proportional rule is the identity at equal length, so a
    // missing remap would leave them where they were), and each anchor ends up
    // on its beat.
    console.log('Align Vocal Timing (F9): markers off the beat -> on it...');
    await page.evaluate((p) => window.__test.openPath(p), BEAT);
    const alignGrid = await page.evaluate(() => window.__test.detectTempo());
    console.log(`  detectTempo: ${JSON.stringify(alignGrid)}`);
    assert(
      alignGrid.beatCount > 8,
      `the fixture yields a usable grid (expected > 8 beats, actual ${alignGrid.beatCount})`
    );

    // Beats are 0.5 s apart at 120 BPM; drop each marker 30 ms LATE of one, far
    // enough to be a real correction and small enough that the 0.88-1.14x bound
    // never bites across a half-second span.
    const alignOffset = Math.round(0.03 * 44100);
    const alignPlaced = await page.evaluate(
      (args) => {
        const grid = window.__test.getBeatGridState();
        const first = grid.firstBeatSample ?? 0;
        const spacing = Math.round(0.5 * 44100);
        const positions = [3, 5, 7, 9].map((k) => first + k * spacing + args.offset);
        positions.forEach((pos, i) => window.__test.addMarkerToActive(pos, `Syllable ${i + 1}`));
        return positions;
      },
      { offset: alignOffset }
    );
    console.log(`  markers placed ${alignOffset} samples late of beats: ${alignPlaced.join(', ')}`);

    const aligned = await page.evaluate(() => window.__test.alignVocalTiming(1, 1));
    console.log(`  alignVocalTiming: ${JSON.stringify({ ...aligned, markerPositions: undefined })}`);
    assert(aligned.ok === true, `alignVocalTiming applied (expected ok=true, actual reason=${aligned.reason})`);
    assert(
      aligned.anchorCount === alignPlaced.length,
      `every marker became an anchor (expected ${alignPlaced.length}, actual ${aligned.anchorCount})`
    );
    assert(
      aligned.clampedCount === 0,
      `a 30 ms move across a half-second span needs no clamping (actual ${aligned.clampedCount})`
    );
    assert(
      aligned.lengthAfter === aligned.lengthBefore,
      `the region length is preserved EXACTLY (before ${aligned.lengthBefore}, after ${aligned.lengthAfter})`
    );
    assert(
      aligned.markersMoved === alignPlaced.length,
      `every marker rode the warp (expected ${alignPlaced.length} moved, actual ${aligned.markersMoved}) ` +
        '— the effect runner proportional remap is the identity at equal length, so 0 here would mean ' +
        'the markers were left behind by the audio they mark'
    );
    // Each anchor should now sit within one WSOLA synthesis hop (20 ms) of the
    // beat it was snapped to. Measured against the ORIGINAL positions minus the
    // deliberate offset, which is exactly where the beats were.
    const alignBeats = alignPlaced.map((pos) => pos - alignOffset);
    const alignAfter = aligned.markerPositions;
    const alignTol = Math.round(0.02 * 44100);
    for (let i = 0; i < alignBeats.length; i++) {
      const err = Math.abs(alignAfter[i] - alignBeats[i]);
      assert(
        err <= alignTol,
        `syllable ${i + 1} landed on its beat (want ${alignBeats[i]}, got ${alignAfter[i]}, ` +
          `off by ${err} <= ${alignTol} samples)`
      );
      assert(
        alignAfter[i] !== alignPlaced[i],
        `syllable ${i + 1} actually moved (still at ${alignPlaced[i]} would mean nothing happened)`
      );
    }
    console.log(
      `  ok: ${alignBeats.length} syllables pulled from ${alignOffset} samples late onto the beat, ` +
        `length unchanged at ${aligned.lengthAfter}`
    );

    // The suggester runs the real detector in the packaged app.
    const suggested = await page.evaluate(() => window.__test.suggestSyllables(0.5));
    console.log(`  suggestSyllables: ${JSON.stringify(suggested)}`);
    assert(
      suggested !== null && suggested.added > 0,
      `the onset suggester produced markers in the packaged build (actual ${JSON.stringify(suggested)})`
    );

    await page.evaluate((out) => window.__test.saveActiveAs(out), OUT_WAV);

    // 11c) F7 — the Vocal Chain, end to end in the PACKAGED app. The unit suite
    // drives the chain against the synchronous worker MOCK, so the one thing it
    // structurally cannot see is the chain running ten separate real Workers
    // back to back through the packaged bundle — module resolution, the CSP,
    // and the `extra` side channel carrying a noise print across a real
    // postMessage boundary. The other two things pinned here are the promises
    // the chain makes: exactly ONE undo entry for the whole pass, and a stage
    // that declines saying WHY instead of quietly doing nothing.
    //
    // Pitch Correct is switched off for this pass: it is 55 % of the chain's
    // runtime and it has nothing to correct on a drum loop. That is deliberate
    // and load-bearing here — with no pitch measurement the EQ stage must
    // DECLINE, which is exactly the path being pinned.
    console.log('Vocal Chain (F7): the whole pass, one undo entry, in the packaged app...');
    await page.evaluate((p) => window.__test.openPath(p), BEAT);
    const chainBefore = await page.evaluate(() => window.__test.getStateSummary());
    const chain = await page.evaluate(() => window.__test.runVocalChain({ pitch: false }));
    console.log(
      `  runVocalChain: ok=${chain.ok} applied=${chain.applied} undoDepth=${chain.undoDepth} ` +
        `label=${JSON.stringify(chain.undoLabel)} length ${chain.lengthBefore} -> ${chain.lengthAfter}`
    );
    for (const stage of chain.stages) {
      const derived = stage.derived.map((d) => `${d.label}=${d.value}`).join(', ');
      console.log(
        `    ${stage.id}: ${stage.status}` +
          (derived ? ` [${derived}]` : '') +
          (stage.detail ? ` — ${stage.detail}` : '') +
          (stage.reason ? ` — ${stage.reason}` : '')
      );
    }

    assert(chain.ok === true, 'the Vocal Chain ran in the packaged app (a real DSP worker per stage)');
    assert(chain.applied === true, 'the Vocal Chain committed an edit');
    assert(
      chain.undoDepth === 1,
      `the WHOLE chain is one undo entry, not one per stage (expected 1, actual ${chain.undoDepth}) ` +
        '— the single most load-bearing promise the feature makes'
    );
    assert(
      chain.undoLabel === 'Vocal Chain',
      `the undo entry is named for what the user asked for (actual ${JSON.stringify(chain.undoLabel)})`
    );
    assert(
      chain.lengthAfter === chain.lengthBefore,
      `no default stage changes the length (before ${chain.lengthBefore}, after ${chain.lengthAfter})`
    );
    assert(
      chain.lengthBefore === chainBefore.length,
      `the chain processed the whole document (doc ${chainBefore.length}, chain ${chain.lengthBefore})`
    );
    // Compared against the app's OWN registry, not a hardcoded count. A count
    // rots the moment a stage is added — F6's `lyrics` stage broke `=== 11`
    // here, and the manual assertion below it would have broken next. A list
    // comparison also pins ORDER and MEMBERSHIP, which a count cannot.
    const chainReported = chain.stages.map((st) => st.id);
    assert(
      JSON.stringify(chainReported) === JSON.stringify(chain.registryStageIds),
      `every stage is reported, run or not, in registry order (registry ${JSON.stringify(chain.registryStageIds)}, reported ${JSON.stringify(chainReported)})`
    );

    // The manual stages are exactly the ones the registry declares manual (the
    // ones with no effect to run), and none of them ran.
    const chainManual = chain.stages.filter((st) => st.status === 'manual').map((m) => m.id);
    assert(
      JSON.stringify(chainManual) === JSON.stringify(chain.registryManualIds),
      `the stages with no automatic effect are listed but never run (registry ${JSON.stringify(chain.registryManualIds)}, manual ${JSON.stringify(chainManual)})`
    );
    assert(
      chain.registryManualIds.includes('timing') && chain.registryManualIds.includes('lyrics'),
      `Align Vocal Timing and Align Lyrics are both manual by design (actual ${JSON.stringify(chain.registryManualIds)})`
    );
    const chainApplied = chain.stages.filter((st) => st.status === 'applied');
    assert(
      chainApplied.length >= 2,
      `at least two stages actually ran (actual ${chainApplied.length}: ${chainApplied.map((st) => st.id).join(', ')})`
    );
    for (const stage of chain.stages) {
      assert(
        ['applied', 'declined', 'off', 'manual'].indexOf(stage.status) !== -1,
        `stage ${stage.id} reports a known status (actual ${JSON.stringify(stage.status)})`
      );
      if (stage.status === 'declined') {
        assert(
          typeof stage.reason === 'string' && stage.reason.length > 0,
          `stage ${stage.id} declined WITH a reason — a silent skip is the failure mode this rules out`
        );
      }
    }
    // Ruling 3, the specific case: with Pitch Correct off there is no measured
    // sung range, so the high-pass corner cannot be derived and the EQ stage
    // must say so rather than picking a corner out of the air.
    const chainEq = chain.stages.filter((st) => st.id === 'eq')[0];
    assert(
      chainEq.status === 'declined' && /Pitch Correct/.test(chainEq.reason || ''),
      `the EQ stage declines and names the missing measurement (status ${chainEq.status}, reason ${JSON.stringify(chainEq.reason)})`
    );
    for (const stage of chainApplied) {
      assert(
        Number.isFinite(stage.identicalFraction) || stage.identicalFraction === null,
        `stage ${stage.id} reported a measured change (actual ${stage.identicalFraction})`
      );
      // Ruling 3's other half: a stage that ran but changed NOTHING has to say
      // so, or it reports a blank where its work should be. The limiter is the
      // stage this fires on — this fixture never approaches its ceiling.
      if (stage.identicalFraction === 1) {
        assert(
          stage.detail === 'nothing to do — every sample came back unchanged',
          `stage ${stage.id} left every sample alone and SAID so (actual ${JSON.stringify(stage.detail)})`
        );
      }
    }
    const chainLimiter = chain.stages.filter((st) => st.id === 'limiter')[0];
    assert(
      chainLimiter.status === 'applied' && chainLimiter.identicalFraction === 1,
      `the limiter ran and had nothing to catch on this fixture (status ${chainLimiter.status}, ` +
        `identical ${chainLimiter.identicalFraction}) — the precondition for the clause just asserted`
    );
    assert(
      Number.isFinite(chain.before.rmsDb) && Number.isFinite(chain.after.rmsDb),
      `the before/after summary carries real numbers (before ${chain.before.rmsDb}, after ${chain.after.rmsDb})`
    );
    console.log(
      `  ok: ${chainApplied.length} stage(s) applied, ${chain.stages.filter((st) => st.status === 'declined').length} declined ` +
        `with a stated reason, RMS ${chain.before.rmsDb.toFixed(2)} -> ${chain.after.rmsDb.toFixed(2)} dBFS, one undo entry`
    );

    // One Ctrl+Z has to put the WHOLE pass back, which is only meaningful
    // because undoDepth was asserted to be 1 above.
    const chainUndone = await page.evaluate(() => window.__test.undoActive());
    assert(
      chainUndone.length === chainBefore.length,
      `one undo restores the document (expected ${chainBefore.length}, actual ${chainUndone.length})`
    );

    await page.evaluate((out) => window.__test.saveActiveAs(out), OUT_WAV);

    // 11d) F10 — the Cover Chain, end to end in the PACKAGED app. Two documents
    // are open at once here and that is the point: the chain matches ONE
    // recording to ANOTHER, so everything below is a claim the vocal chain's
    // step structurally cannot make.
    //
    // Four things are pinned that the unit suite cannot see. Three real DSP
    // workers run back to back through the packaged bundle. The REFERENCE
    // document has to come back untouched — `runEffectOnChannels` TRANSFERS the
    // buffers it is handed, and only the real worker does that, so a chain that
    // handed the reference to a worker would pass every unit test and destroy
    // the user's separated vocal here. The realised match curve is compared
    // against the target on audio the real Graphic EQ produced. And the fixture
    // is built so the loudness match lands the peak OVER full scale, which is
    // the case Ruling C exists for.
    console.log('Cover Chain (F10): match one recording to another, in the packaged app...');
    await page.evaluate((p) => window.__test.openPath(p), COVER_REFERENCE);
    await page.evaluate((p) => window.__test.openPath(p), COVER_TAKE);
    const coverBefore = await page.evaluate(() => window.__test.getStateSummary());
    assert(
      coverBefore.activeName === 'cover-take.wav',
      `the take is the active document and the reference is the other one (active ${JSON.stringify(coverBefore.activeName)})`
    );

    const cover = await page.evaluate(() =>
      window.__test.runCoverChain('cover-reference.wav', { matchReverb: true })
    );
    console.log(
      `  runCoverChain: ok=${cover.ok} applied=${cover.applied} undoDepth=${cover.undoDepth} ` +
        `label=${JSON.stringify(cover.undoLabel)} reference=${JSON.stringify(cover.referenceName)}`
    );
    for (const stage of cover.stages) {
      const derived = stage.derived.map((d) => `${d.label}=${d.value}`).join(', ');
      console.log(
        `    ${stage.id}: ${stage.status}` +
          (derived ? ` [${derived}]` : '') +
          (stage.detail ? ` — ${stage.detail}` : '') +
          (stage.warning ? ` — WARNING ${stage.warning}` : '') +
          (stage.reason ? ` — ${stage.reason}` : '')
      );
    }

    assert(cover.ok === true, 'the Cover Chain ran in the packaged app (a real DSP worker per stage)');
    assert(cover.applied === true, 'the Cover Chain committed an edit');
    assert(
      cover.undoDepth === 1,
      `the WHOLE chain is one undo entry, not one per stage (expected 1, actual ${cover.undoDepth}) ` +
        '— the single most load-bearing promise the feature makes'
    );
    assert(
      cover.undoLabel === 'Cover Chain',
      `the undo entry is named for what the user asked for (actual ${JSON.stringify(cover.undoLabel)})`
    );
    assert(
      cover.referenceName === 'cover-reference.wav',
      `the chain matched against the document it was given (actual ${JSON.stringify(cover.referenceName)})`
    );
    // THE one the unit suite cannot reach: the real worker detaches what it is
    // handed, so this is the only place a chain that posted the reference to a
    // worker would be caught — and it would have destroyed a user's separated
    // vocal in the process.
    assert(
      cover.referenceIntact === true,
      `the reference document is bit-identical after the run — the chain READS it (actual ${cover.referenceIntact})`
    );

    // Compared against the app's OWN registry, never a hardcoded count: a count
    // rots the moment a stage is added, and it has twice in this repo.
    const coverReported = cover.stages.map((st) => st.id);
    assert(
      JSON.stringify(coverReported) === JSON.stringify(cover.registryStageIds),
      `every stage is reported, run or not, in registry order (registry ${JSON.stringify(cover.registryStageIds)}, reported ${JSON.stringify(coverReported)})`
    );
    const coverManual = cover.stages.filter((st) => st.status === 'manual').map((m) => m.id);
    assert(
      JSON.stringify(coverManual) === JSON.stringify(cover.registryManualIds),
      `the stages with no automatic effect are listed but never run (registry ${JSON.stringify(cover.registryManualIds)}, manual ${JSON.stringify(coverManual)})`
    );
    for (const stage of cover.stages) {
      assert(
        ['applied', 'declined', 'off', 'manual'].indexOf(stage.status) !== -1,
        `stage ${stage.id} reports a known status (actual ${JSON.stringify(stage.status)})`
      );
      if (stage.status === 'declined') {
        assert(
          typeof stage.reason === 'string' && stage.reason.length > 0,
          `stage ${stage.id} declined WITH a reason — a silent skip is the failure mode this rules out`
        );
      }
    }

    // Ruling B, on audio the real Graphic EQ produced: the curve the chain
    // REPORTS is the one the octave energies actually moved by.
    const coverEq = cover.stages.filter((st) => st.id === 'matchEq')[0];
    assert(coverEq.status === 'applied', `the match EQ ran (status ${coverEq.status})`);
    const coverMatchedBands = coverEq.eqBands.filter((b) => b.status === 'matched');
    assert(
      coverMatchedBands.length >= 5,
      `the fixture pair leaves the match real work to do (matched bands ${coverMatchedBands.length})`
    );
    // Every matched band is classified TOTALLY and EXCLUSIVELY into one of two
    // kinds: delivered, or short-and-said-so. A band that is neither (short and
    // silent) or both is a failure — and "short and silent" is precisely the
    // Ruling B defect, so a one-sided "realised == target" assertion would have
    // to be relaxed into meaninglessness the first time a band could not be
    // delivered. This fixture reaches BOTH kinds in one run.
    //
    // The threshold is the ENGINE's own, not a rounder number chosen here: the
    // chain names every band whose realised energy misses its target by more
    // than SOLVE_TOLERANCE_DB, so any other threshold makes this classification
    // overlap or gap by construction rather than by defect.
    const COVER_TOLERANCE_DB = 0.01;
    let coverDelivered = 0;
    let coverShort = 0;
    for (const band of coverMatchedBands) {
      const error = Math.abs(band.realisedDb - band.targetDb);
      const delivered = error <= COVER_TOLERANCE_DB;
      const saidShort =
        error > COVER_TOLERANCE_DB &&
        typeof coverEq.warning === 'string' &&
        coverEq.warning.indexOf(`${band.centreHz} Hz`) !== -1 &&
        coverEq.warning.indexOf('could not fully deliver') !== -1;
      assert(
        (delivered ? 1 : 0) + (saidShort ? 1 : 0) === 1,
        `${band.centreHz} Hz: the realised band energy is either the target or reported short — never short and silent ` +
          `(wanted ${band.targetDb.toFixed(3)}, realised ${band.realisedDb.toFixed(3)} dB, warning ${JSON.stringify(coverEq.warning)})`
      );
      if (delivered) coverDelivered++;
      else coverShort++;
      assert(
        Math.abs(band.bandGainDb) <= 12.0001,
        `${band.centreHz} Hz: the gain stays inside the Graphic EQ's own range (actual ${band.bandGainDb.toFixed(3)} dB)`
      );
    }
    assert(
      coverDelivered >= 5,
      `most of the curve was delivered exactly (${coverDelivered} of ${coverMatchedBands.length} bands)`
    );
    // The fixture's top octave asks for ~9.7 dB of band ENERGY, which needs more
    // than the Graphic EQ's own +-12 dB once its roll-off across the octave is
    // compensated. That is the case that must be REPORTED rather than rounded
    // away, and it is why the classification above is two-sided.
    assert(
      coverShort === 1 && Math.abs(coverEq.eqWorstErrorDb) > 0.05,
      `the one band the EQ could not deliver is named with its shortfall (short ${coverShort}, worst ${coverEq.eqWorstErrorDb})`
    );
    // And it is short because the EFFECT ran out of range, not because the solve
    // ran out of passes — the distinction the whole two-sided classification
    // rests on. The band that fell short is the one sitting on the +-12 dB rail.
    const coverRailed = coverMatchedBands.filter((b) => Math.abs(b.bandGainDb) >= 11.999);
    assert(
      coverRailed.length === 1 &&
        Math.abs(coverRailed[0].realisedDb - coverRailed[0].targetDb) > COVER_TOLERANCE_DB,
      `the short band is the one pinned at the Graphic EQ's own limit (railed ${JSON.stringify(coverRailed.map((b) => b.centreHz))})`
    );
    const coverOutOfRange = coverEq.eqBands.filter((b) => b.status !== 'matched');
    assert(
      coverOutOfRange.length >= 1 && coverOutOfRange.every((b) => b.bandGainDb === 0),
      `no band outside the measured range receives a deliberate gain (${coverOutOfRange.map((b) => `${b.centreHz}=${b.bandGainDb}`).join(', ')})`
    );
    assert(
      coverOutOfRange.some((b) => Math.abs(b.realisedDb) > 0.05),
      `the cascade's leak into those bands is REPORTED rather than shown as zero (${coverOutOfRange.map((b) => `${b.centreHz}=${b.realisedDb.toFixed(2)}`).join(', ')})`
    );

    // The measurement the EQ exists to move, taken on the real output.
    assert(
      cover.after.matchDistanceDb < cover.before.matchDistanceDb * 0.6,
      `the spectral distance to the reference closed (before ${cover.before.matchDistanceDb.toFixed(2)}, after ${cover.after.matchDistanceDb.toFixed(2)} dB)`
    );
    // The loudness claim, end to end.
    assert(
      Math.abs(cover.after.gatedLevelDb - cover.reference.gatedLevelDb) < 0.6,
      `the take now sits at the reference's sounding level (after ${cover.after.gatedLevelDb.toFixed(2)}, target ${cover.reference.gatedLevelDb.toFixed(2)} dBFS)`
    );

    // Ruling C, in the packaged app: this fixture's peak WOULD pass full scale
    // after the match, and the limiter is what stops it.
    const coverLimiter = cover.stages.filter((st) => st.id === 'headroom')[0];
    assert(
      coverLimiter.status === 'applied' && /caught \d+\.\d\d dB of peak/.test(coverLimiter.detail || ''),
      `the limiter had something to catch and said how much (status ${coverLimiter.status}, detail ${JSON.stringify(coverLimiter.detail)})`
    );
    assert(
      cover.after.peakDb <= -0.3 + 0.01,
      `the output respects the -0.3 dBFS ceiling (actual ${cover.after.peakDb.toFixed(2)} dBFS)`
    );
    // The claim this step's comment makes at the top: the loudness match lands
    // the peak OVER full scale, and the limiter is what brings it back. The
    // chain's own before/after cannot see that — every stage between them has
    // already run — so it is read off the LIMITER's own input peak. The first
    // version of this assertion compared `before.peakDb` against
    // `after.peakDb - 12`, which the -0.29 ceiling assertion above had already
    // reduced to `before.peakDb > -12.3`: it observed nothing.
    assert(
      coverLimiter.peakBeforeDb > 0,
      `the fixture really needed the catch — the peak handed to the limiter passed full scale ` +
        `(pre-limiter ${coverLimiter.peakBeforeDb.toFixed(2)} dBFS, post ${coverLimiter.peakAfterDb.toFixed(2)}, ` +
        `take ${cover.before.peakDb.toFixed(2)} dBFS matched by ${(cover.after.gatedLevelDb - cover.before.gatedLevelDb).toFixed(2)} dB)`
    );
    assert(
      coverLimiter.peakBeforeDb - coverLimiter.peakAfterDb > 1,
      `and it caught a real amount of it (${(coverLimiter.peakBeforeDb - coverLimiter.peakAfterDb).toFixed(2)} dB)`
    );

    // The reverb stage was switched ON and still refused, deriving the refusal.
    // Classified TOTALLY and EXCLUSIVELY: a reason matching neither known kind,
    // or both, fails — a substring sweep would pass on a sentence that said
    // nothing useful.
    const coverReverb = cover.stages.filter((st) => st.id === 'matchReverb')[0];
    assert(coverReverb.status === 'declined', `the reverb stage declined (status ${coverReverb.status})`);
    const reverbKinds = [
      ['no-measurable-decay', /decays cleanly enough to measure/],
      ['below-the-effects-floor', /the shortest this reverb can produce is \d+\.\d\d s/],
    ].filter(([, re]) => re.test(coverReverb.reason || ''));
    assert(
      reverbKinds.length === 1,
      `the refusal is exactly one known DERIVED kind, not zero and not two (matched ${JSON.stringify(reverbKinds.map((k) => k[0]))}, reason ${JSON.stringify(coverReverb.reason)})`
    );

    console.log(
      `  ok: loudness ${cover.before.gatedLevelDb.toFixed(2)} -> ${cover.after.gatedLevelDb.toFixed(2)} dBFS ` +
        `(target ${cover.reference.gatedLevelDb.toFixed(2)}), spectral distance ${cover.before.matchDistanceDb.toFixed(2)} -> ` +
        `${cover.after.matchDistanceDb.toFixed(2)} dB, peak ${cover.before.peakDb.toFixed(2)} -> ${cover.after.peakDb.toFixed(2)} dBFS, ` +
        `spread ${cover.before.spreadDb.toFixed(2)} -> ${cover.after.spreadDb.toFixed(2)} dB (reported, never corrected)`
    );

    // One Ctrl+Z puts the WHOLE pass back, which is only meaningful because
    // undoDepth was asserted to be 1 above.
    //
    // Length alone cannot observe it: every stage that ran here is
    // length-preserving, so `lengthBefore === lengthAfter` and a history entry
    // that captured the POST-edit buffer as its "before" would restore nothing
    // and still pass. The audio itself is the assertion — the peak moved from
    // -5.88 to -0.30 dBFS across the run, so a real undo has to move it back,
    // and a sample window pins it exactly rather than statistically.
    // `getPeak()` is a LINEAR peak (0..1), not dBFS — the chain's own report is
    // in dBFS, so one of the two has to be converted and this is the side that
    // owns the conversion.
    const coverPeakDb = (linear) => (linear > 0 ? 20 * Math.log10(linear) : -Infinity);
    const coverPeakAfter = coverPeakDb(await page.evaluate(() => window.__test.getPeak()));
    const coverSamplesAfter = await page.evaluate(() =>
      window.__test.getChannelSamples(0, 0, 2048)
    );
    const coverUndone = await page.evaluate(() => window.__test.undoActive());
    const coverPeakUndone = coverPeakDb(await page.evaluate(() => window.__test.getPeak()));
    const coverSamplesUndone = await page.evaluate(() =>
      window.__test.getChannelSamples(0, 0, 2048)
    );
    assert(
      coverUndone.length === cover.lengthBefore,
      `one undo restores the take's length (expected ${cover.lengthBefore}, actual ${coverUndone.length})`
    );
    assert(
      Math.abs(coverPeakUndone - cover.before.peakDb) < 0.05,
      `one undo restores the take's AUDIO, not just its length — the peak is the take's again ` +
        `(before ${cover.before.peakDb.toFixed(2)}, after the chain ${coverPeakAfter.toFixed(2)}, after undo ${coverPeakUndone.toFixed(2)} dBFS)`
    );
    assert(
      Math.abs(coverPeakAfter - coverPeakUndone) > 1,
      `and that is a real restoration rather than a run that changed nothing ` +
        `(chain output ${coverPeakAfter.toFixed(2)} dBFS vs restored ${coverPeakUndone.toFixed(2)} dBFS)`
    );
    let coverSamplesChanged = 0;
    for (let i = 0; i < coverSamplesUndone.length; i++) {
      if (coverSamplesAfter[i] !== coverSamplesUndone[i]) coverSamplesChanged++;
    }
    assert(
      coverSamplesChanged > coverSamplesUndone.length / 2,
      `the samples themselves came back, not only the summary statistics ` +
        `(${coverSamplesChanged} of ${coverSamplesUndone.length} differ from the processed buffer)`
    );

    // And with no reference chosen, every matching stage declines saying so
    // rather than the chain refusing to start or quietly doing nothing.
    const coverNoRef = await page.evaluate(() => window.__test.runCoverChain(null, { matchReverb: true }));
    assert(coverNoRef.ok === true, `with no reference the chain still runs (ok ${coverNoRef.ok})`);
    for (const id of ['matchEq', 'matchLoudness', 'matchReverb']) {
      const stage = coverNoRef.stages.filter((st) => st.id === id)[0];
      assert(
        stage.status === 'declined' && /no original vocal chosen/.test(stage.reason || ''),
        `${id} declines and says what to do about it (status ${stage.status}, reason ${JSON.stringify(stage.reason)})`
      );
    }
    // The limiter is NOT a matching stage and does not pretend to be: it needs
    // no reference, it was ticked, so it runs. The first version of this step
    // asserted the whole chain changed nothing here and was wrong about its own
    // feature — which is the sort of thing a packaged run is for.
    const coverNoRefApplied = coverNoRef.stages.filter((st) => st.status === 'applied').map((st) => st.id);
    assert(
      JSON.stringify(coverNoRefApplied) === JSON.stringify(['headroom']),
      `only the stage that needs no reference ran (applied ${JSON.stringify(coverNoRefApplied)})`
    );
    assert(
      coverNoRef.referenceName === null && coverNoRef.reference === null,
      `no reference is reported anywhere in the summary (name ${JSON.stringify(coverNoRef.referenceName)})`
    );
    assert(
      coverNoRef.before.matchDistanceDb === null && coverNoRef.after.matchDistanceDb === null,
      'the distance from the original vocal reads n/a rather than 0 when there is no original vocal'
    );
    // Leave the document as this step found it.
    await page.evaluate(() => window.__test.undoActive());

    // 11e) The same chain against a REVERBERANT reference, so Match Reverb
    // ENGAGES instead of declining. This is the configuration in which the
    // chain's last stage is one that RAISES peaks, and it shipped wrong: the
    // registry had matchReverb after the limiter, whose own note told the user
    // that nothing downstream could lift the output back over the ceiling.
    // Measured through the real stages on this exact fixture, that order ends
    // at +2.42 dBFS — over full scale, and `encodeWav` hard-clips it.
    //
    // The unit suite pins the order structurally and pins the ceiling against
    // the synchronous worker mock. This is the same claim in the packaged app,
    // with four real DSP workers back to back and a region that grows under
    // them, which is the part the mock cannot reach.
    console.log('Cover Chain (F10): the same chain with Match Reverb ENGAGED...');
    // The room reference first, then a FRESH copy of the take on top of it, so
    // the take this pass runs on is the file rather than the document the pass
    // above processed and undid. `openPath` makes what it opens active, which is
    // why the order is this way round.
    await page.evaluate((p) => window.__test.openPath(p), COVER_REFERENCE_ROOM);
    await page.evaluate((p) => window.__test.openPath(p), COVER_TAKE);
    const coverRoomBefore = await page.evaluate(() => window.__test.getStateSummary());
    assert(
      coverRoomBefore.activeName === 'cover-take.wav',
      `the take is active for the second pass (active ${JSON.stringify(coverRoomBefore.activeName)})`
    );

    const coverRoom = await page.evaluate(() =>
      window.__test.runCoverChain('cover-reference-room.wav', { matchReverb: true })
    );
    for (const stage of coverRoom.stages) {
      if (stage.status === 'off' || stage.status === 'manual') continue;
      console.log(
        `    ${stage.id}: ${stage.status}` +
          (stage.peakBeforeDb === null
            ? ''
            : ` [peak ${stage.peakBeforeDb.toFixed(2)} -> ${stage.peakAfterDb.toFixed(2)} dBFS]`) +
          (stage.detail ? ` — ${stage.detail}` : '') +
          (stage.reason ? ` — ${stage.reason}` : '')
      );
    }
    assert(coverRoom.ok === true && coverRoom.applied === true, 'the reverberant pass ran and committed');
    const coverRoomReverb = coverRoom.stages.filter((st) => st.id === 'matchReverb')[0];
    assert(
      coverRoomReverb.status === 'applied',
      `Match Reverb ENGAGED on a reference that has a room — the whole point of this pass ` +
        `(status ${coverRoomReverb.status}, reason ${JSON.stringify(coverRoomReverb.reason)})`
    );
    assert(
      coverRoom.lengthAfter > coverRoom.lengthBefore,
      `and it lengthened the region by its tail (${coverRoom.lengthBefore} -> ${coverRoom.lengthAfter} samples)`
    );
    // THE assertion. In the order that shipped this reads +2.42 dBFS.
    assert(
      coverRoom.after.peakDb <= -0.3 + 0.01,
      `the ceiling holds with the reverb ON — nothing downstream of the limiter (actual ${coverRoom.after.peakDb.toFixed(2)} dBFS)`
    );
    // Two-sided: the reverb is only a threat to the ceiling if the limiter was
    // working, and it is only the LAST stage if nothing ran after it.
    const coverRoomLimiter = coverRoom.stages.filter((st) => st.id === 'headroom')[0];
    assert(
      coverRoomLimiter.peakBeforeDb > 0,
      `the limiter was handed a signal over full scale, so the ceiling above is an outcome ` +
        `(pre-limiter ${coverRoomLimiter.peakBeforeDb.toFixed(2)} dBFS)`
    );
    const coverRoomRan = coverRoom.stages.filter((st) => st.status === 'applied').map((st) => st.id);
    assert(
      coverRoomRan[coverRoomRan.length - 1] === 'headroom',
      `the limiter is the last stage that touched the audio (ran ${JSON.stringify(coverRoomRan)})`
    );
    assert(
      coverRoom.undoDepth === 1,
      `the reverberant pass is still ONE undo entry (actual ${coverRoom.undoDepth})`
    );
    console.log(
      `  ok: reverb engaged, ${coverRoom.lengthBefore} -> ${coverRoom.lengthAfter} samples, ` +
        `pre-limiter ${coverRoomLimiter.peakBeforeDb.toFixed(2)} -> output ${coverRoom.after.peakDb.toFixed(2)} dBFS`
    );
    await page.evaluate(() => window.__test.undoActive());

    // 12) v1.5 step C — Auto-Remix (Task T13 acceptance): open the 64 s ABAB
    // fixture and ask for a 32 s arrangement through the real
    // createRemixDocument (analyse -> plan -> render -> new document),
    // bypassing the Pipeline > Auto-Remix dialog. The duration is BAR-QUANTISED, so
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

    // 12a) R4b — a PIN is a guarantee, driven through the Remix panel's own
    // buttons rather than through a test hook. The hook only READS state
    // afterwards: the click path (Pin -> Re-roll) is the thing under test,
    // because a `requiredJoins` that is accepted, threaded through three
    // layers and never actually constrains anything would pass every unit
    // test in the suite.
    console.log('Pin a remix edit and re-roll, through the panel...');
    // Re-roll is disabled — correctly — when EVERY edit is pinned, so the pin
    // step needs an arrangement with at least two. Re-activate the source and
    // remix it to a longer target, which splices more.
    await openModuleCard(page, 'Files'); // U1: the strip's active entry toggles its card closed
    await page.waitForSelector('[data-testid="files-list"]', { timeout: 5000 });
    await page.click('[data-testid="files-list"] button:has-text("abab120.wav")');
    let multi = null;
    for (const seconds of [150, 180, 120, 200]) {
      // eslint-disable-next-line no-await-in-loop
      const attempt = await page.evaluate(
        (s) => window.__test.remixToDuration(s, { strict: false }),
        seconds
      );
      console.log(`  remixToDuration(${seconds}, {strict:false}): joins=${attempt.joins} ok=${attempt.ok}`);
      if (attempt.ok && attempt.joins >= 2) {
        multi = attempt;
        break;
      }
      // eslint-disable-next-line no-await-in-loop
      await page.click('[data-testid="files-list"] button:has-text("abab120.wav")');
    }
    assert(
      multi !== null,
      'a remix with at least two edits exists to pin one of (expected joins >= 2 at one of the tried targets)'
    );

    await openModuleCard(page, 'Remix'); // U1: the strip's active entry toggles its card closed
    await page.waitForSelector('[data-testid="remix-panel"]', { timeout: 5000 });
    const multiJoins = await page.evaluate(() => window.__test.getRemixJoins());
    const rowCount = await page.evaluate(
      () => document.querySelectorAll('[data-testid="remix-item"]').length
    );
    assert(
      rowCount === multiJoins.length,
      `the Remix panel lists one row per join (expected ${multiJoins.length}, actual ${rowCount})`
    );

    const pinnedKey = `${multiJoins[0].fromBar}>${multiJoins[0].toBar}`;
    const pinTitle = await page.getAttribute('button[aria-label="Pin edit 1"]', 'title');
    console.log(`  pin tooltip: ${JSON.stringify(pinTitle)}`);
    assert(
      /guaranteed/i.test(pinTitle || '') && !/not a guarantee/i.test(pinTitle || ''),
      `the pin control promises the guarantee (actual ${JSON.stringify(pinTitle)})`
    );

    await page.click('button[aria-label="Pin edit 1"]');
    const pinnedState = await page.evaluate(() => window.__test.getRemixPinState());
    console.log(`  after pin: ${JSON.stringify(pinnedState)}`);
    assert(
      pinnedState !== null && pinnedState.lockedJoins.includes(pinnedKey),
      `clicking Pin recorded ${pinnedKey} (actual ${JSON.stringify(pinnedState && pinnedState.lockedJoins)})`
    );

    const rollBefore = pinnedState.rollIndex;
    await page.click('[data-testid="remix-header"] button:has-text("Re-roll")');
    // The re-plan is asynchronous (and would be in a worker on a longer
    // track), so wait on the state it produces, never on a fixed delay.
    await page.waitForFunction(
      (before) => {
        const s = window.__test.getRemixPinState();
        return s !== null && s.rollIndex > before;
      },
      rollBefore,
      { timeout: 20000 }
    );

    const afterRoll = await page.evaluate(() => window.__test.getRemixPinState());
    const joinsAfter = await page.evaluate(() => window.__test.getRemixJoins());
    const keysAfter = (joinsAfter || []).map((j) => `${j.fromBar}>${j.toBar}`);
    console.log(`  after re-roll: rollIndex=${afterRoll.rollIndex} joins=${JSON.stringify(keysAfter)}`);
    console.log(`  pin report: ${JSON.stringify(afterRoll)}`);
    assert(
      keysAfter.includes(pinnedKey),
      `the pinned edit ${pinnedKey} survived the re-roll (actual ${JSON.stringify(keysAfter)})`
    );
    assert(
      afterRoll.pinMode === 'enforced',
      `the guarantee was in force (expected 'enforced', actual ${JSON.stringify(afterRoll.pinMode)})`
    );
    assert(
      afterRoll.pinSatisfied.includes(pinnedKey) && afterRoll.pinDropped.length === 0,
      `the planner reports the pin satisfied and nothing dropped (actual satisfied=${JSON.stringify(afterRoll.pinSatisfied)} dropped=${JSON.stringify(afterRoll.pinDropped)})`
    );
    const pinNotices = await page.evaluate(() => ({
      dropped: document.querySelectorAll('[data-testid="remix-dropped-pins"]').length,
      notGuaranteed: document.querySelectorAll('[data-testid="remix-pins-not-guaranteed"]').length,
    }));
    assert(
      pinNotices.dropped === 0 && pinNotices.notGuaranteed === 0,
      `the panel shows no dropped-pin or not-guaranteed notice (actual ${JSON.stringify(pinNotices)})`
    );
    // The remix document was rewritten by the re-roll; leave the rail where
    // the following steps expect it.
    await openModuleCard(page, 'Files'); // U1: the strip's active entry toggles its card closed

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
    // F3: step 12 leaves Files open, so asking for it again used to be a no-op
    // and the assertion below measured inherited state. Switch away first, so
    // the Files entry is genuinely clicked and genuinely drives the card.
    await openModuleCard(page, 'History');
    const clickedFiles = await openModuleCard(page, 'Files');
    assert(
      clickedFiles === true,
      'the Files strip entry was really clicked, not found already open (F3)'
    );
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

    // 13b) U1 — the E2 layout, measured -------------------------------------
    // The layout claims are geometric, so they are checked as geometry against
    // the pinned window rather than as "the element exists". Every number below
    // is READ, and the expectations are derived from the same constants the
    // renderer publishes (`--stage-inset-*`), never hardcoded twice.
    console.log('U1 layout E2: strip, waveform width, bottom band...');
    // Stated, not assumed: every measurement below is of the single-document
    // editor, so the view is pinned rather than inherited from step 12.
    await page.evaluate(() => window.__test.setView('waveform'));
    const e2 = await page.evaluate(() => {
      const box = (sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom };
      };
      const stage = document.querySelector('[data-testid="editor-stage"]');
      const cs = stage ? getComputedStyle(stage) : null;
      return {
        strip: box('[data-testid="sidebar-tabs"]'),
        panel: box('[data-testid="sidebar-panel"]'),
        canvas: box('[data-testid="waveform-canvas"]'),
        status: box('[data-testid="status-pill"]'),
        edit: box('[data-testid="edit-pill"]'),
        toolbar: box('[data-testid="toolbar-pill"]'),
        stage: box('[data-testid="editor-stage"]'),
        insetRight: cs ? cs.getPropertyValue('--stage-inset-right').trim() : null,
        insetLeft: cs ? cs.getPropertyValue('--stage-inset-left').trim() : null,
        fileChipText: document.querySelector('[data-testid="file-chip"]')?.textContent ?? null,
        fileChipInStatus:
          document
            .querySelector('[data-testid="status-pill"]')
            ?.contains(document.querySelector('[data-testid="file-chip"]')) ?? false,
      };
    });
    console.log(
      `  strip ${e2.strip && Math.round(e2.strip.width)}x${e2.strip && Math.round(e2.strip.height)} ` +
        `at x=${e2.strip && Math.round(e2.strip.x)}; panel width ${e2.panel && Math.round(e2.panel.width)}; ` +
        `canvas ${e2.canvas && Math.round(e2.canvas.width)} CSS px; insets ${e2.insetLeft}/${e2.insetRight}`
    );
    // The rail rotated: the strip is WIDER than it is tall, and exactly as wide
    // as the card beneath it, which is what makes the two read as one column.
    assert(
      e2.strip !== null && e2.strip.width > e2.strip.height,
      `the module strip is horizontal (${e2.strip && Math.round(e2.strip.width)}x${e2.strip && Math.round(e2.strip.height)})`
    );
    assert(
      e2.panel !== null && Math.abs(e2.strip.width - e2.panel.width) <= 1,
      `the strip is the panel card's width (strip ${e2.strip.width}, card ${e2.panel && e2.panel.width})`
    );
    assert(
      e2.strip.y + e2.strip.height <= e2.panel.y,
      `the strip sits ON TOP of the column, not beside it (strip ends ${Math.round(e2.strip.y + e2.strip.height)}, card starts ${Math.round(e2.panel.y)})`
    );
    // The waveform took the liberated pixels: the lane spans the stage less its
    // published insets, which is a tighter margin than the retired rail allowed.
    const wantCanvas =
      e2.stage.width - parseFloat(e2.insetLeft) - parseFloat(e2.insetRight);
    assert(
      e2.canvas !== null && Math.abs(e2.canvas.width - wantCanvas) <= 2,
      `the waveform fills the stage less its published insets (expected ${Math.round(wantCanvas)} ` +
        `+/-2, actual ${Math.round(e2.canvas.width)} CSS px)`
    );
    assert(
      e2.canvas.width > e2.stage.width * 0.7,
      `the lane is wide, not picture-framed (${Math.round(e2.canvas.width)} of ${Math.round(e2.stage.width)} CSS px)`
    );
    // Element 1: the top-left chip is gone and its identity readout is IN the
    // bottom bar (name · duration · rate · channels).
    assert(
      e2.fileChipInStatus === true,
      `the file identity lives in the status pill now, not in a top-left chip (${e2.fileChipText})`
    );
    assert(
      /abab120\.wav/.test(e2.fileChipText ?? '') && /44\.1k/.test(e2.fileChipText ?? ''),
      `the bottom bar carries name · duration · rate · channels (actual "${e2.fileChipText}")`
    );
    // Element 5: the edit pill floats ABOVE the bottom bar with clear air, on
    // the same axis, and both are centred on the WAVEFORM rather than the window.
    const air = e2.status.y - e2.edit.bottom;
    console.log(
      `  edit pill ${Math.round(e2.edit.width)}x${Math.round(e2.edit.height)}, ${Math.round(air)} px of air above the status pill`
    );
    assert(
      e2.edit !== null && air >= 12 && air <= 20,
      `the edit pill floats above the bottom bar with ~16px of clear air (actual ${Math.round(air)})`
    );
    // F4: the canvas width is checked against the PUBLISHED insets above, which
    // a wrong inset would satisfy by moving both sides of the comparison. Tie
    // the right inset to the module column it is supposed to clear, so the
    // token has to agree with the thing it describes and not merely with the
    // canvas it produced. `14 + 348 + 14` is App.tsx's
    // COLUMN_MARGIN + MODULE_COLUMN_WIDTH + COLUMN_MARGIN.
    assert(
      Math.abs(parseFloat(e2.insetRight) - (e2.strip.width + 28)) <= 1,
      `the right inset is the module column's own width plus its margins ` +
        `(strip ${Math.round(e2.strip.width)} + 28 = ${Math.round(e2.strip.width + 28)}, inset ${e2.insetRight})`
    );
    // F2: the toolbar pill joins the two it was documented to share an axis
    // with. It was collected here from the start and never asserted, which is
    // how it stayed 174 px off that axis with the card closed.
    const waveAxis = e2.canvas.x + e2.canvas.width / 2;
    console.log(
      `  toolbar pill ${Math.round(e2.toolbar.width)} wide, centre ${Math.round(e2.toolbar.x + e2.toolbar.width / 2)}; wave axis ${Math.round(waveAxis)}`
    );
    for (const [name, b] of [
      ['status pill', e2.status],
      ['edit pill', e2.edit],
      ['toolbar pill', e2.toolbar],
    ]) {
      const centre = b.x + b.width / 2;
      assert(
        Math.abs(centre - waveAxis) <= 2,
        `the ${name} is centred on the WAVEFORM's axis (expected ${Math.round(waveAxis)} +/-2, actual ${Math.round(centre)})`
      );
    }
    const editButtons = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[data-testid="edit-pill"] button')).map((b) => ({
        label: b.getAttribute('aria-label'),
        disabled: b.disabled,
      }))
    );
    console.log(`  edit pill buttons: ${JSON.stringify(editButtons)}`);
    assert(
      editButtons.map((b) => b.label).join(',') === 'Cut,Copy,Paste,Delete,Trim,Silence,Undo,Redo',
      `the edit pill carries the eight commands in the mockup's order (actual ${editButtons.map((b) => b.label).join(',')})`
    );
    assert(
      editButtons.filter((b) => ['Cut', 'Copy', 'Delete', 'Trim', 'Silence'].includes(b.label))
        .every((b) => b.disabled),
      `with no selection the region verbs are greyed, not hidden (actual ${JSON.stringify(editButtons)})`
    );
    // Closing the card really hands its width to the waveform — the claim the
    // whole strip rearrangement exists for.
    await page.click('[data-testid="sidebar-tabs"] button[aria-label="Files"]');
    const collapsed = await page.evaluate(() => {
      const box = (sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.x, width: r.width, right: r.right };
      };
      const c = document.querySelector('[data-testid="waveform-canvas"]').getBoundingClientRect();
      return {
        width: c.width,
        x: c.x,
        panel: document.querySelectorAll('[data-testid="sidebar-panel"]').length,
        strip: document.querySelectorAll('[data-testid="sidebar-tabs"]').length,
        toolbar: box('[data-testid="toolbar-pill"]'),
        status: box('[data-testid="status-pill"]'),
        edit: box('[data-testid="edit-pill"]'),
        stripBox: box('[data-testid="sidebar-tabs"]'),
      };
    });
    console.log(
      `  card closed: canvas ${Math.round(collapsed.width)} CSS px (was ${Math.round(e2.canvas.width)}), ` +
        `panels ${collapsed.panel}, strips ${collapsed.strip}`
    );
    assert(
      collapsed.panel === 0 && collapsed.strip === 1,
      `clicking the active strip entry closes the card and leaves the strip (panels ${collapsed.panel}, strips ${collapsed.strip})`
    );
    assert(
      collapsed.width > e2.canvas.width + 300,
      `the closed card's width goes to the waveform (expected > ${Math.round(e2.canvas.width + 300)}, actual ${Math.round(collapsed.width)})`
    );
    // F2: the card-CLOSED state is the one the retired clamp existed for, and
    // the one nothing measured — the toolbar pill sat 174 px off the axis here
    // while the guide, the README and the changelog all said otherwise. The
    // axis MOVED when the card closed (the lane grew), so this is a genuinely
    // different assertion from the one above, not a repeat.
    const closedAxis = collapsed.x + collapsed.width / 2;
    console.log(
      `  card closed: wave axis ${Math.round(closedAxis)}; toolbar centre ${Math.round(collapsed.toolbar.x + collapsed.toolbar.width / 2)}, ` +
        `status ${Math.round(collapsed.status.x + collapsed.status.width / 2)}, edit ${Math.round(collapsed.edit.x + collapsed.edit.width / 2)}`
    );
    for (const [name, b] of [
      ['status pill', collapsed.status],
      ['edit pill', collapsed.edit],
      ['toolbar pill', collapsed.toolbar],
    ]) {
      const centre = b.x + b.width / 2;
      assert(
        Math.abs(centre - closedAxis) <= 2,
        `with the card CLOSED the ${name} is still on the WAVEFORM's axis ` +
          `(expected ${Math.round(closedAxis)} +/-2, actual ${Math.round(centre)})`
      );
    }
    // The invariant that let the clamp go: an axis-centred toolbar pill clears
    // the module strip. Thin (7.4 px measured) and content-dependent — the zoom
    // readout is the only part of the pill that changes width — so it is pinned
    // rather than assumed, at the default zoom AND at the deepest zoom this
    // fixture allows, which is where the readout is widest.
    assert(
      collapsed.toolbar.right < collapsed.stripBox.x,
      `the axis-centred toolbar pill clears the module strip with the card closed ` +
        `(pill ends ${Math.round(collapsed.toolbar.right)}, strip starts ${Math.round(collapsed.stripBox.x)})`
    );
    const deepZoom = await page.evaluate(async () => {
      const btn = document.querySelector('[data-testid="toolbar-pill"] button[aria-label="Zoom In"]');
      for (let i = 0; i < 30; i++) btn.click();
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const pill = document.querySelector('[data-testid="toolbar-pill"]').getBoundingClientRect();
      const strip = document.querySelector('[data-testid="sidebar-tabs"]').getBoundingClientRect();
      return {
        readout: document.querySelector('[data-testid="zoom-readout"]')?.textContent ?? null,
        width: pill.width,
        right: pill.right,
        stripX: strip.x,
      };
    });
    console.log(
      `  deepest zoom: readout ${deepZoom.readout}, pill ${Math.round(deepZoom.width)} wide, ` +
        `ends ${Math.round(deepZoom.right)}, strip starts ${Math.round(deepZoom.stripX)}`
    );
    assert(
      deepZoom.right < deepZoom.stripX,
      `and still clears it at the widest the zoom readout gets (${deepZoom.readout}: pill ends ` +
        `${Math.round(deepZoom.right)}, strip starts ${Math.round(deepZoom.stripX)})`
    );
    await page.evaluate(() => {
      document.querySelector('[data-testid="toolbar-pill"] button[aria-label="Fit"]').click();
    });
    await openModuleCard(page, 'Files'); // restore the state step 14's screenshot expects

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
      // How many tics the canvas can hold is arithmetic, not a guess. A beat's
      // x is `(beat - scrollSample) / samplesPerPixel`, so the visible ones are
      // those landing in [0, cssWidth). The beats are taken as evenly spaced
      // across the tracked grid — true of this fixture by construction (an
      // exact 120 BPM click train, detected at confidence ~0.9999) and the only
      // option available, since the hooks pass scalars and never the beat array
      // itself. Deriving the count from the geometry the run actually has is
      // the belt to the pinned window's braces: the `>= 8` floor stays as the
      // "this is a ruler" statement, and the derived equality below is the
      // stronger claim that EVERY beat the canvas can hold is drawn, and no
      // stray tic besides.
      const beatSpacing =
        gridState.beatCount > 1
          ? (gridState.lastBeatSample - gridState.firstBeatSample) / (gridState.beatCount - 1)
          : 0;
      let expectedTics = 0;
      for (let i = 0; i < gridState.beatCount; i++) {
        const x =
          (gridState.firstBeatSample + i * beatSpacing - view.scrollSample) / view.samplesPerPixel;
        if (x >= 0 && x < band.cssWidth) expectedTics++;
      }
      console.log(
        `  editor tic band: ${band.groupCount} tic groups / ${band.columnCount} lit device ` +
          `columns, widest ${band.widestGroupPx}px, ${band.aboveBandColumns} lit above the band ` +
          `(canvas ${band.cssWidth.toFixed(0)}x${band.cssHeight.toFixed(0)} CSS, dpr ${band.dpr}, ` +
          `${expectedTics} of ${gridState.beatCount} beats fit at ${view.samplesPerPixel} samples/px)`
      );
      assert(
        band.groupCount >= 8,
        `the editor draws a RULER of tics, not one stray mark (expected >= 8 groups, actual ${band.groupCount})`
      );
      assert(
        Math.abs(band.groupCount - expectedTics) <= 1,
        `every tracked beat the pinned canvas can hold is drawn, and no tic besides (expected ` +
          `${expectedTics} groups +/-1 for a beat landing on the right edge, actual ${band.groupCount} ` +
          `over ${band.cssWidth.toFixed(0)} CSS px)`
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

    // F11: 16b) the playhead grab handle and the ruler seek/scrub -----------
    // Both are POINTER gestures, so both are driven with `page.mouse` for the
    // same reason step 16 is: the test hooks write the cursor directly and
    // would prove nothing about the handlers. Every expectation is DERIVED
    // from the live view state (`samplesPerPixel`, `scrollSample`) rather than
    // hardcoded, so it survives F11-3's fit-on-open changing the realised zoom.
    //
    // Alt is held throughout: it suspends the magnet, which makes the aimed
    // pixel the committed sample exactly. The magnet's own behaviour is step
    // 16's subject, not this one's — mixing them would make a failure here
    // ambiguous between "the drag is broken" and "the snap moved it".
    console.log('Playhead handle drag and ruler seek/scrub (F11)...');
    const f11Canvas = await page.locator('[data-testid="waveform-canvas"]').boundingBox();
    const f11Ruler = await page.locator('[data-testid="timeline-ruler"]').boundingBox();
    assert(
      f11Canvas !== null && f11Ruler !== null,
      'the waveform canvas and the timeline ruler are both on screen'
    );

    // Park the position line at a known x with a real click in the lane BODY
    // (well below the handle's 15px grab strip, so this is an ordinary cursor
    // placement and not already a grab).
    const parkX = Math.round(f11Canvas.width * 0.25);
    await realClick(page, f11Canvas.x + parkX, f11Canvas.y + f11Canvas.height / 2, { alt: true });
    const f11Parked = await page.evaluate(() => window.__test.getEditorViewState());
    const f11Spp = f11Parked.samplesPerPixel;
    console.log(
      `  parked at x=${parkX} -> cursorSample ${f11Parked.cursorSample} ` +
        `(${f11Spp} samples/px, scroll ${f11Parked.scrollSample})`
    );
    assert(
      Math.abs(f11Parked.cursorSample - (f11Parked.scrollSample + parkX * f11Spp)) <= f11Spp,
      `a body click placed the line where it was aimed (expected ~${Math.round(
        f11Parked.scrollSample + parkX * f11Spp
      )}, actual ${f11Parked.cursorSample})`
    );

    // 1. GRABBING the handle does not move it. The press is 8px to the RIGHT
    //    of the line and 4px down — inside the handle, outside the line. A
    //    body click there would have moved the cursor by 8px worth of samples,
    //    so this cannot pass vacuously.
    await page.keyboard.down('Alt');
    await page.mouse.move(f11Canvas.x + parkX + 8, f11Canvas.y + 4);
    await page.mouse.down();
    const f11Grabbed = await page.evaluate(() => window.__test.getEditorViewState());
    assert(
      f11Grabbed.cursorSample === f11Parked.cursorSample,
      `grabbing the handle does not itself move the line (expected ${f11Parked.cursorSample}, ` +
        `actual ${f11Grabbed.cursorSample}; a body click there would have moved it by ${Math.round(8 * f11Spp)})`
    );
    await page.mouse.up();
    await page.keyboard.up('Alt');

    // 2. DRAGGING it moves the line live, and releases cleanly. `hold` keeps
    //    the button down so the MID-drag read below is a genuine mid-drag.
    const dragToX = Math.round(f11Canvas.width * 0.6);
    await realDrag(
      page,
      { x: f11Canvas.x + parkX + 8, y: f11Canvas.y + 4 },
      { x: f11Canvas.x + dragToX, y: f11Canvas.y + 4 },
      { alt: true, hold: true }
    );
    const f11MidDrag = await page.evaluate(() => window.__test.getEditorViewState());
    await page.mouse.up();
    await page.keyboard.up('Alt');
    const f11Dragged = await page.evaluate(() => window.__test.getEditorViewState());
    const f11DragExpect = f11Parked.scrollSample + dragToX * f11Spp;
    console.log(
      `  handle dragged to x=${dragToX} -> cursorSample ${f11Dragged.cursorSample} ` +
        `(expected ~${Math.round(f11DragExpect)})`
    );
    assert(
      f11MidDrag.cursorSample === f11Dragged.cursorSample,
      `the line follows the handle DURING the drag, not only on release ` +
        `(mid ${f11MidDrag.cursorSample}, released ${f11Dragged.cursorSample})`
    );
    assert(
      Math.abs(f11Dragged.cursorSample - f11DragExpect) <= 2 * f11Spp,
      `dragging the handle put the line where the pointer left it (expected ~${Math.round(
        f11DragExpect
      )} +/-${Math.round(2 * f11Spp)}, actual ${f11Dragged.cursorSample})`
    );

    // 3. The RULER seeks on the PRESS — asserted before any release, which is
    //    the whole difference from the `click` handler this replaced.
    const rulerPressX = Math.round(f11Ruler.width * 0.35);
    await page.keyboard.down('Alt');
    await page.mouse.move(f11Ruler.x + rulerPressX, f11Ruler.y + f11Ruler.height / 2);
    await page.mouse.down();
    const f11RulerPressed = await page.evaluate(() => window.__test.getEditorViewState());
    const f11PressExpect = f11Parked.scrollSample + rulerPressX * f11Spp;
    assert(
      Math.abs(f11RulerPressed.cursorSample - f11PressExpect) <= 2 * f11Spp,
      `the ruler seeks on the PRESS, before any release (expected ~${Math.round(
        f11PressExpect
      )}, actual ${f11RulerPressed.cursorSample})`
    );

    // 4. ...and SCRUBS while held.
    const rulerScrubX = Math.round(f11Ruler.width * 0.75);
    for (let i = 1; i <= 4; i++) {
      await page.mouse.move(
        f11Ruler.x + rulerPressX + ((rulerScrubX - rulerPressX) * i) / 4,
        f11Ruler.y + f11Ruler.height / 2
      );
    }
    const f11Scrubbed = await page.evaluate(() => window.__test.getEditorViewState());
    await page.mouse.up();
    const f11ScrubExpect = f11Parked.scrollSample + rulerScrubX * f11Spp;
    console.log(
      `  ruler pressed at x=${rulerPressX} -> ${f11RulerPressed.cursorSample}, ` +
        `scrubbed to x=${rulerScrubX} -> ${f11Scrubbed.cursorSample}`
    );
    assert(
      Math.abs(f11Scrubbed.cursorSample - f11ScrubExpect) <= 2 * f11Spp,
      `holding the button and moving scrubs the line along the ruler (expected ~${Math.round(
        f11ScrubExpect
      )} +/-${Math.round(2 * f11Spp)}, actual ${f11Scrubbed.cursorSample})`
    );

    // 5. The scrub STOPS on release: a bare hover over the ruler is not a seek.
    await page.mouse.move(f11Ruler.x + f11Ruler.width * 0.15, f11Ruler.y + f11Ruler.height / 2);
    await page.keyboard.up('Alt');
    const f11AfterRelease = await page.evaluate(() => window.__test.getEditorViewState());
    assert(
      f11AfterRelease.cursorSample === f11Scrubbed.cursorSample,
      `moving over the ruler with the button UP does not seek (expected ${f11Scrubbed.cursorSample}, ` +
        `actual ${f11AfterRelease.cursorSample})`
    );

    // F11: 16c) the menu bar — the FIRST time the packaged app has ever had a
    // menu opened by this smoke. Until now every command was driven through
    // `window.__test`, so the bar itself, its dropdowns and their overflow
    // behaviour had no packaged coverage at all: the "Effects menu adds empty
    // space at the bottom of the app" bug could not have been caught here.
    console.log('Menu bar: six sections, a Pipeline menu, and a long menu that scrolls (F11)...');

    // A REAL click on a bar button — the same discipline as step 16.
    const openMenu = async (title) => {
      const box = await page.evaluate((t) => {
        const btn = [...document.querySelectorAll('.chrome-menu-btn')].find(
          (b) => b.textContent.trim() === t
        );
        if (!btn) return null;
        const r = btn.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      }, title);
      if (!box) return false;
      await realClick(page, box.x, box.y);
      await page.waitForSelector(`[data-testid="menu-dropdown"][data-menu-title="${title}"]`, {
        timeout: 5000,
      });
      return true;
    };

    const barTitles = await page.evaluate(() =>
      [...document.querySelectorAll('.chrome-menu-btn')].map((b) => b.textContent.trim())
    );
    assert(
      JSON.stringify(barTitles) ===
        JSON.stringify(['File', 'Edit', 'Effects', 'Pipeline', 'View', 'Help']),
      `the bar carries six sections in order (actual ${JSON.stringify(barTitles)})`
    );

    // The scroll region BEFORE any menu is open, so the comparison below is a
    // difference rather than an absolute — the bug was a document that became
    // scrollable, not a document of a particular height.
    const scrollBefore = await page.evaluate(() => ({
      doc: document.documentElement.scrollHeight - document.documentElement.clientHeight,
      body: document.body.scrollHeight - document.body.clientHeight,
    }));

    // Effects is the longest menu — ~33 rows, the one that reproduced the bug.
    assert(await openMenu('Effects'), 'the Effects menu opens on a real click');
    const menuOpen = await page.evaluate(() => {
      const d = document.querySelector('[data-testid="menu-dropdown"]');
      const r = d.getBoundingClientRect();
      const cs = getComputedStyle(d);
      return {
        scroll: {
          doc: document.documentElement.scrollHeight - document.documentElement.clientHeight,
          body: document.body.scrollHeight - document.body.clientHeight,
        },
        position: cs.position,
        overflowY: cs.overflowY,
        bottom: r.bottom,
        viewportH: window.innerHeight,
        overflows: d.scrollHeight > d.clientHeight + 1,
        rows: d.querySelectorAll('button').length,
      };
    });
    console.log(
      `  Effects dropdown: ${menuOpen.rows} rows, ${menuOpen.position}/${menuOpen.overflowY}, ` +
        `bottom ${menuOpen.bottom.toFixed(0)} of ${menuOpen.viewportH}, ` +
        `scrollable=${menuOpen.overflows}; document overflow ` +
        `${scrollBefore.doc}->${menuOpen.scroll.doc}, body ${scrollBefore.body}->${menuOpen.scroll.body}`
    );
    assert(
      menuOpen.scroll.doc <= scrollBefore.doc && menuOpen.scroll.body <= scrollBefore.body,
      `opening the longest menu adds NO scrollable space to the app (document ` +
        `${scrollBefore.doc}->${menuOpen.scroll.doc}, body ${scrollBefore.body}->${menuOpen.scroll.body})`
    );
    assert(
      menuOpen.position === 'fixed' && menuOpen.overflowY === 'auto',
      `the dropdown is a fixed, self-scrolling overlay (actual ${menuOpen.position}/${menuOpen.overflowY})`
    );
    assert(
      menuOpen.bottom <= menuOpen.viewportH + 1,
      `the dropdown is clamped to the window (bottom ${menuOpen.bottom.toFixed(0)} <= ${menuOpen.viewportH})`
    );

    // The Pipeline menu: the ten tools, in three separator-delimited groups.
    // (T8 moved the Spatial Positioner to the Effects menu, taking the fourth
    // group with it — asserted on the Effects side below.)
    await page.keyboard.press('Escape');
    assert(await openMenu('Pipeline'), 'the Pipeline menu opens on a real click');
    const pipeline = await page.evaluate(() => {
      const d = document.querySelector('[data-testid="menu-dropdown"]');
      return {
        labels: [...d.querySelectorAll('button')].map((b) =>
          b.querySelector('span').textContent.trim()
        ),
        separators: d.querySelectorAll('div.h-px').length,
      };
    });
    console.log(`  Pipeline: ${JSON.stringify(pipeline.labels)} (${pipeline.separators} separators)`);
    assert(
      JSON.stringify(pipeline.labels) ===
        JSON.stringify([
          'Detect Tempo',
          'Match Tempo',
          'Align Vocal Timing',
          'Auto-Remix',
          'Voice Changer',
          'Vocal Chain',
          'Cover Chain',
          'Align Lyrics',
          'Transcribe',
          'Separate into Stems',
        ]),
      `the Pipeline menu holds the ten tools in subject order (actual ${JSON.stringify(pipeline.labels)})`
    );
    assert(
      pipeline.separators === 2,
      `three groups means two separators (actual ${pipeline.separators})`
    );

    // T8: the Spatial Positioner MOVED to the Effects menu, closing it as its
    // own Mix group — last row, behind its own separator.
    await page.keyboard.press('Escape');
    assert(await openMenu('Effects'), 'the Effects menu opens on a real click');
    const effectsMenu = await page.evaluate(() => {
      const d = document.querySelector('[data-testid="menu-dropdown"]');
      return {
        labels: [...d.querySelectorAll('button')].map((b) =>
          b.querySelector('span').textContent.trim()
        ),
      };
    });
    assert(
      effectsMenu.labels[effectsMenu.labels.length - 1] === 'Spatial Positioner',
      `the Spatial Positioner closes the Effects menu (last row is "${effectsMenu.labels[effectsMenu.labels.length - 1]}")`
    );
    assert(
      !pipeline.labels.includes('Spatial Positioner'),
      'MOVED, not copied: the Pipeline menu no longer carries the Spatial Positioner'
    );

    // MOVED, not copied: none of the moved tools may still be reachable from Edit.
    await page.keyboard.press('Escape');
    assert(await openMenu('Edit'), 'the Edit menu opens on a real click');
    const editLabels = await page.evaluate(() =>
      [...document.querySelectorAll('[data-testid="menu-dropdown"] button')].map((b) =>
        b.querySelector('span').textContent.trim()
      )
    );
    const strays = editLabels.filter((l) =>
      ['Auto-Remix', 'Separate into Stems', 'Transcribe', 'Voice Changer'].includes(l)
    );
    assert(
      strays.length === 0,
      `the four tools that left Edit are gone from it, not duplicated (strays ${JSON.stringify(strays)})`
    );
    await page.keyboard.press('Escape');
    await page.waitForFunction(
      () => document.querySelector('[data-testid="menu-dropdown"]') === null,
      null,
      { timeout: 5000 }
    );

    // F11: 16c-bis) the Effects module card carries the same tools ----------
    // The card is the surface this user works from, and the smoke had never
    // opened it — no `effects-list`, no `effects-item`, nothing. The tools
    // shipped menu-only for ten releases partly because nothing here would
    // have noticed.
    console.log('Effects card: the ten Pipeline tools plus the Mix positioner, and no layout growth (F11)...');
    await openModuleCard(page, 'Effects');
    await page.waitForSelector('[data-testid="effects-tool-section"]', { timeout: 5000 });
    const cardBefore = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="sidebar-panel"]');
      const r = el.getBoundingClientRect();
      return { width: r.width, bodyOverflow: document.body.scrollWidth - document.body.clientWidth };
    });
    const tools = await page.evaluate(() => ({
      sections: [...document.querySelectorAll('[data-testid="effects-tool-section"]')].map(
        (n) => n.dataset.section
      ),
      ids: [...document.querySelectorAll('[data-testid="effects-tool-item"]')].map(
        (n) => n.dataset.commandId
      ),
      greyed: [...document.querySelectorAll('[data-testid="effects-tool-item"] button')].filter(
        (b) => b.disabled
      ).length,
      effects: document.querySelectorAll('[data-testid="effects-item"]').length,
    }));
    console.log(
      `  Effects card: sections ${JSON.stringify(tools.sections)}, ${tools.ids.length} tool rows ` +
        `(${tools.greyed} greyed), ${tools.effects} effect rows; card ${cardBefore.width.toFixed(0)}px`
    );
    assert(
      JSON.stringify(tools.sections) ===
        JSON.stringify(['Tempo & Timing', 'Voice', 'Analysis', 'Mix']),
      `the card groups the Pipeline menu's tools, then the Effects menu's own Mix tail (actual ${JSON.stringify(tools.sections)})`
    );
    assert(
      tools.ids.length === 11,
      `every Pipeline tool plus the Mix positioner has a row in the card ` +
        `(expected 11, actual ${tools.ids.length})`
    );
    assert(
      tools.effects > 0,
      `the effect list is still there, above the tools (actual ${tools.effects} rows)`
    );
    assert(
      cardBefore.bodyOverflow <= 0,
      `the tool sections widen nothing (body overflow ${cardBefore.bodyOverflow}px)`
    );
    assert(
      Math.abs(cardBefore.width - 348) <= 2,
      `the card is still the module column's width (expected 348 +/-2, actual ${cardBefore.width.toFixed(1)})`
    );

    // F11: 16d) drag a document from the Files panel onto a track lane -------
    // The user's report was "we can't drag a file on a track in multitrack,
    // it's a real issue". HTML5 drag-and-drop did not exist anywhere in this
    // app before F11-4, so this is the first packaged coverage of it.
    //
    // The four events MUST share ONE `DataTransfer` — that object is the whole
    // channel between the source and the target, and a fresh one per event
    // makes the drop arrive carrying nothing. It is parked on `window` between
    // evaluates rather than dispatched in a single blocking one, so React
    // flushes its state between `dragover` and the mid-drag read below;
    // reading in the same synchronous run would race the render.
    console.log('Multitrack: dragging a Files-panel document onto a lane (F11)...');
    await page.evaluate(() => window.__test.setView('multitrack'));
    await openModuleCard(page, 'Files');
    await page.waitForSelector('[data-testid="files-item"]', { timeout: 5000 });
    await page.waitForSelector('[data-testid="track-lane"]', { timeout: 5000 });

    const laneBox = await page.evaluate(() => {
      const lane = document.querySelector('[data-testid="track-lane"]');
      const r = lane.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    });
    const f11DropX = Math.round(laneBox.x + laneBox.width * 0.45);
    const f11DropY = Math.round(laneBox.y + laneBox.height / 2);
    const clipsBefore = await page.evaluate(
      () => document.querySelectorAll('[data-testid="track-lane"]')[0].querySelectorAll('[data-testid="clip"]').length
    );

    await page.evaluate(() => {
      const row = document.querySelector('[data-testid="files-item"]');
      const dt = new DataTransfer();
      window.__f11dt = dt;
      row.dispatchEvent(
        new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt })
      );
    });
    await page.evaluate(
      ({ x, y }) => {
        const lane = document.querySelectorAll('[data-testid="track-lane"]')[0];
        for (const type of ['dragenter', 'dragover']) {
          lane.dispatchEvent(
            new DragEvent(type, {
              bubbles: true,
              cancelable: true,
              clientX: x,
              clientY: y,
              dataTransfer: window.__f11dt,
            })
          );
        }
      },
      { x: f11DropX, y: f11DropY }
    );

    // DURING the drag: the lane must say it is the target, and the ghost must
    // show where the clip would land. "No highlight = no action" is the rule
    // the user has to be able to read off the screen.
    const midDrag = await page.evaluate(() => {
      const lane = document.querySelectorAll('[data-testid="track-lane"]')[0];
      return {
        background: lane.style.backgroundColor,
        ghost: document.querySelectorAll('[data-testid="clip-drop-ghost"]').length,
        payload: [...window.__f11dt.types],
      };
    });
    console.log(
      `  mid-drag: lane background "${midDrag.background}", ${midDrag.ghost} ghost, ` +
        `payload ${JSON.stringify(midDrag.payload)}`
    );
    assert(
      midDrag.background !== '' && midDrag.background !== 'transparent',
      `the lane under the pointer highlights itself (actual "${midDrag.background}")`
    );
    assert(midDrag.ghost === 1, `a ghost line shows the snapped drop point (actual ${midDrag.ghost})`);
    assert(
      midDrag.payload.includes('application/x-auditorium-document-id'),
      `the Files row published a document id to drag (actual ${JSON.stringify(midDrag.payload)})`
    );

    await page.evaluate(
      ({ x, y }) => {
        const lane = document.querySelectorAll('[data-testid="track-lane"]')[0];
        lane.dispatchEvent(
          new DragEvent('drop', {
            bubbles: true,
            cancelable: true,
            clientX: x,
            clientY: y,
            dataTransfer: window.__f11dt,
          })
        );
        delete window.__f11dt;
      },
      { x: f11DropX, y: f11DropY }
    );
    await page.waitForFunction(
      (before) =>
        document.querySelectorAll('[data-testid="track-lane"]')[0].querySelectorAll(
          '[data-testid="clip"]'
        ).length > before,
      clipsBefore,
      { timeout: 5000 }
    );
    const afterDrop = await page.evaluate(() => ({
      clips: document.querySelectorAll('[data-testid="track-lane"]')[0].querySelectorAll(
        '[data-testid="clip"]'
      ).length,
      ghost: document.querySelectorAll('[data-testid="clip-drop-ghost"]').length,
      background: document.querySelectorAll('[data-testid="track-lane"]')[0].style.backgroundColor,
    }));
    assert(
      afterDrop.clips === clipsBefore + 1,
      `the drop placed exactly one clip on that lane (${clipsBefore} -> ${afterDrop.clips})`
    );
    assert(
      afterDrop.ghost === 0 &&
        (afterDrop.background === '' || afterDrop.background === 'transparent'),
      `the highlight and the ghost are cleaned up after the drop (ghost ${afterDrop.ghost}, ` +
        `background "${afterDrop.background}")`
    );

    // The drop is ONE labelled undo step. Read off the History card rather
    // than a hook: there is no session-history test hook, and the panel IS the
    // surface the user reads, so asserting on it also proves the drop reached
    // the session history the multitrack Undo routes to.
    await openModuleCard(page, 'History');
    await page.waitForSelector('[data-testid="history-item"]', { timeout: 5000 });
    const dropHistory = await page.evaluate(() =>
      [...document.querySelectorAll('[data-testid="history-item"]')].map((li) =>
        li.textContent.trim()
      )
    );
    const dropTop = dropHistory[dropHistory.length - 1];
    console.log(`  session history: ${JSON.stringify(dropHistory)}`);
    assert(
      typeof dropTop === 'string' && /Add clips?/.test(dropTop),
      `the drop landed in the SESSION history under a clip-add label (actual ` +
        `${JSON.stringify(dropTop)}) — that it FOLDS into a single entry is pinned by ` +
        `the unit tests, which can count the entries a gesture adds; this step can only ` +
        `see the label on top`
    );

    await page.evaluate(() => window.__test.setView('waveform'));

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
          `(Pipeline → Separate into Stems → Download Model) to make this step run.`
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

      // CP1: the WHOLE cover journey, in the packaged app -------------------
      // The unit suite spies on the six sub-services, so it proves they are
      // called in order and cannot prove they COMPOSE. This is the only place
      // a real separation, two real chains over real DSP workers, a real
      // cross-correlation over real audio and a real session build meet each
      // other. It lives inside the model guard because stage 1 is a model run.
      //
      // The fixtures are the Cover Chain's own: `cover-reference.wav` stands in
      // for the original song and `cover-take.wav` for the new take. They are
      // 6 s each, so the separation here is seconds rather than minutes.
      //
      // WHICH ALIGNMENT ARM THIS MATERIAL TAKES, and why it is not a defect.
      // `make-test-cover.cjs` builds both files from filtered NOISE — the same
      // noise through two first-order FIRs, plus transients in the take — because
      // they were made to give Match EQ a monotone tilt and Match Loudness an
      // unambiguous move. Continuous noise has no syllables, so the two share no
      // ONSET structure whatever, and the alignment correctly refuses. Measured
      // here BEFORE CC2 rebuilt the evidence: correlation 0.210 against the then
      // floor of 0.607, prominence 0.031 against 0.186. CC2 low-passes both
      // envelopes, which lifts every peak — the floors are now 0.731 and 0.12
      // (see the constants at the top of this file) and the numbers this
      // material produces will have moved with them. The REFUSAL is what this
      // pass asserts and it is not in doubt: the unit sweep's room-tone members
      // are the same shape as this fixture and top out at 0.6538, well under the
      // floor. The two figures above are the last measured pair and want
      // refreshing from this run's own log line, printed just below.
      //
      // So THIS pass exercises the REFUSED arm end to end and the believed arm
      // not at all. M4 closed that gap rather than relaxing an assertion here:
      // `make-test-cover.cjs` now also emits a pair sharing one onset schedule at
      // a built-in offset, and the sibling pass at the end of this block drives
      // the believed arm through the same six stages.
      console.log('Cover journey (CP1): song + take → session, in the packaged app...');
      await page.evaluate(() => window.__test.setView('waveform'));
      await page.evaluate((p) => window.__test.openPath(p), COVER_REFERENCE);
      // The SONG's own rate, read while it is the active document — the session
      // runs at this one, and reading it from the take (opened next) would only
      // work while both fixtures happen to share a rate.
      const journeySong = await page.evaluate(() => window.__test.getStateSummary());
      await page.evaluate((p) => window.__test.openPath(p), COVER_TAKE);
      const journeyBefore = await page.evaluate(() => window.__test.getStateSummary());
      const journey = await page.evaluate(() =>
        window.__test.runCoverJourney('cover-reference.wav', 'cover-take.wav')
      );
      console.log(
        `  runCoverJourney: ok=${journey.ok} completed=${journey.completed} ` +
          `cancelledAt=${JSON.stringify(journey.cancelledAt)} reused=${journey.separationReused}`
      );
      for (const stage of journey.stages) {
        const derived = stage.derived.map((d) => `${d.label}=${d.value}`).join(', ');
        console.log(
          `    ${stage.id}: ${stage.status}` +
            (derived ? ` [${derived}]` : '') +
            (stage.nestedStageCount !== null ? ` (${stage.nestedStageCount} nested stages)` : '') +
            (stage.warning ? ` — WARNING ${stage.warning}` : '') +
            (stage.reason ? ` — ${stage.reason}` : '')
        );
      }
      console.log(
        `  alignment: offset=${journey.alignmentOffsetSeconds}s confident=${journey.alignmentConfident} ` +
          `peak=${journey.alignmentPeakCorrelation} prominence=${journey.alignmentProminence}`
      );
      console.log(
        `  placement: take@${journey.takeStartSample} instrumental@${journey.instrumentalStartSample} ` +
          `shifted=${journey.shiftedSamples} fades=${journey.fadeInSample}/${journey.fadeOutSample} ` +
          `summedPeak=${journey.summedPeakDb} dBFS overCeiling=${journey.overCeiling}`
      );

      assert(journey.ok === true, 'the journey started with two open documents');
      assert(
        journey.completed === true,
        `all six stages completed (cancelledAt ${JSON.stringify(journey.cancelledAt)})`
      );
      // Against the app's OWN registry, never a hardcoded count.
      const journeyReported = journey.stages.map((st) => st.id);
      assert(
        JSON.stringify(journeyReported) === JSON.stringify(journey.registryStageIds),
        `every stage is reported, in registry order (registry ${JSON.stringify(journey.registryStageIds)}, reported ${JSON.stringify(journeyReported)})`
      );
      for (const stage of journey.stages) {
        assert(
          ['done', 'declined', 'reused', 'cancelled', 'failed', 'pending'].indexOf(stage.status) !== -1,
          `stage ${stage.id} reports a known status (actual ${JSON.stringify(stage.status)})`
        );
        // The honesty rule, executable: a stage that did not do its job says why.
        if (stage.status === 'declined' || stage.status === 'failed') {
          assert(
            typeof stage.reason === 'string' && stage.reason.length > 0,
            `stage ${stage.id} did not run and SAID why — a silent skip is the failure mode this rules out`
          );
        }
      }
      // The nesting is structural, not cosmetic: both chain stages carry their
      // own chains' whole stage lists rather than one opaque line.
      const journeyClean = journey.stages.filter((st) => st.id === 'clean')[0];
      const journeyMatch = journey.stages.filter((st) => st.id === 'match')[0];
      assert(
        journeyClean.nestedStageCount !== null && journeyClean.nestedStageCount > 1,
        `the Vocal Chain's own stages are nested, not flattened (actual ${journeyClean.nestedStageCount})`
      );
      assert(
        journeyMatch.nestedStageCount !== null && journeyMatch.nestedStageCount > 1,
        `the Cover Chain's own stages are nested, not flattened (actual ${journeyMatch.nestedStageCount})`
      );
      // Separation ran for real here — the reference had never been separated.
      assert(
        journey.separationReused === false,
        `the first pass separated rather than reusing (actual ${journey.separationReused})`
      );
      // The five stems plus the instrumental this pass sums for itself.
      const journeyAfter = await page.evaluate(() => window.__test.getStateSummary());
      assert(
        journeyAfter.docCount === journeyBefore.docCount + 6,
        `five stems and one instrumental were added (expected ${journeyBefore.docCount + 6}, actual ${journeyAfter.docCount})`
      );
      // Undo stays per-sub-pass, and the report says exactly which entries.
      assert(
        JSON.stringify(journey.undoEntries) === JSON.stringify(['Vocal Chain', 'Cover Chain']),
        `each pass kept its own undo entry (actual ${JSON.stringify(journey.undoEntries)})`
      );
      // The session that is the whole point: two tracks, both clips placed.
      assert(
        journey.sessionName === 'cover-reference.wav — Cover',
        `the session is named after the song (actual ${JSON.stringify(journey.sessionName)})`
      );
      assert(
        journey.sessionTrackCount === 2,
        `the session has the instrumental and the take on it (actual ${journey.sessionTrackCount})`
      );
      const journeyMt = await page.evaluate(() => ({
        views: document.querySelectorAll('[data-testid="multitrack-view"]').length,
        tracks: document.querySelectorAll('[data-testid="track-header"]').length,
        clips: document.querySelectorAll('[data-testid="clip"]').length,
      }));
      assert(
        journeyMt.views === 1 && journeyMt.tracks === 2 && journeyMt.clips === 2,
        `the cover session is on screen (${journeyMt.views} views / ${journeyMt.tracks} tracks / ${journeyMt.clips} clips)`
      );
      // CP1: the placement arithmetic, at the SESSION's own rate.
      //
      // Two corrections from the review, both of which made this block unable to
      // pass. It hard-coded 44100 while these fixtures are 48 kHz and the session
      // runs at the INSTRUMENTAL's rate — so the expected sample count was out by
      // 8.8 % on every run. And it added `shiftedSamples` to a start that had
      // already been floored at zero, which is the negative-offset case counted
      // twice: the engine's rule is `take = raw + shift` with
      // `shift = max(0, -raw)`, i.e. exactly `max(0, raw)` and
      // `instrumental = max(0, -raw)`, and that is what is asserted here.
      //
      // ONLY ONE ARM RUNS PER PASS — this material either clears the confidence
      // floors or it does not. The earlier claim that "both arms are asserted"
      // was false; what is asserted is that whichever arm ran, its own
      // arithmetic holds and the other arm's outcome is impossible.
      assert(
        journey.sessionRate === journeySong.sampleRate,
        `the session runs at the SONG's rate (session ${journey.sessionRate}, song ${journeySong.sampleRate}, take ${journeyBefore.sampleRate})`
      );
      assert(
        journey.takeStartSample !== null && journey.takeStartSample >= 0,
        `the take was placed at a real, non-negative session sample (actual ${journey.takeStartSample})`
      );
      if (journey.alignmentRefused) {
        assert(
          journey.takeStartSample === 0 && journey.shiftedSamples === 0,
          `a refused alignment places at zero rather than guessing (take ${journey.takeStartSample}, shift ${journey.shiftedSamples})`
        );
        console.log(
          '  alignment arm: REFUSED — placed at zero and the numbers were stated (the placed arms did not run this pass)'
        );
      } else {
        // V3: THREE arms reach a placement now, not one. The believed arm places
        // because both floors cleared; the auto-placed arm ('weak'/'ambiguous')
        // places because the guess is the best evidence there is and the user
        // asked for the tracks to be placed rather than offered. Both land the
        // clips through the same `placementFor`, which is what the arithmetic
        // below checks — so the two share this branch and only the claim about
        // CONFIDENCE differs.
        assert(
          journey.alignmentOffsetSeconds !== null &&
            (journey.alignmentConfident === true || journey.alignmentAutoPlaced === true),
          `a non-refused alignment reports an offset it placed at (offset ${journey.alignmentOffsetSeconds}, confident ${journey.alignmentConfident}, auto-placed ${journey.alignmentAutoPlaced})`
        );
        assert(
          journey.alignmentConfident !== journey.alignmentAutoPlaced,
          `exactly one of the two placed arms ran (confident ${journey.alignmentConfident}, auto-placed ${journey.alignmentAutoPlaced})`
        );
        const raw = Math.round(journey.alignmentOffsetSeconds * journey.sessionRate);
        const expectedTake = Math.max(0, raw);
        const expectedShift = Math.max(0, -raw);
        assert(
          Math.abs(journey.takeStartSample - expectedTake) <= 1,
          `the clip landed at the measured offset (offset ${journey.alignmentOffsetSeconds}s at ${journey.sessionRate} Hz, expected ${expectedTake}, actual ${journey.takeStartSample})`
        );
        assert(
          Math.abs(journey.shiftedSamples - expectedShift) <= 1 &&
            Math.abs(journey.instrumentalStartSample - expectedShift) <= 1,
          `a negative offset shifts BOTH tracks rather than clamping the take (expected shift ${expectedShift}, actual shift ${journey.shiftedSamples}, instrumental at ${journey.instrumentalStartSample})`
        );
        // Whatever the signs, the INTERVAL between the two clips is exactly the
        // offset that was measured — that is the property the shift exists for.
        assert(
          Math.abs(journey.takeStartSample - journey.instrumentalStartSample - raw) <= 1,
          `the measured interval survives the shift (raw ${raw}, actual ${journey.takeStartSample - journey.instrumentalStartSample})`
        );
        console.log(
          `  alignment arm: ${journey.alignmentConfident ? 'BELIEVED' : 'AUTO-PLACED'} — raw ${raw}, take@${journey.takeStartSample}, instrumental@${journey.instrumentalStartSample} (the place-at-zero arm did not run this pass)`
        );
      }
      // Smoothing: both edges faded, and the summed peak measured rather than
      // assumed. `summedPeakDb` comes from BEFORE the master bus's clamp — the
      // clamped render peaks at 0 dBFS by construction and could not show this.
      assert(
        journey.fadeInSample !== null && journey.fadeInSample > 0 && journey.fadeOutSample > 0,
        `both edges of the placed take were faded (actual ${journey.fadeInSample}/${journey.fadeOutSample})`
      );
      assert(
        Number.isFinite(journey.summedPeakDb),
        `the summed peak was measured (actual ${journey.summedPeakDb})`
      );
      assert(
        journey.overCeiling === journey.summedPeakDb > 0,
        `the over-ceiling verdict follows the measured peak (peak ${journey.summedPeakDb}, verdict ${journey.overCeiling})`
      );
      const journeySmooth = journey.stages.filter((st) => st.id === 'smooth')[0];
      assert(
        journey.overCeiling
          ? typeof journeySmooth.warning === 'string' && journeySmooth.warning.length > 0
          : journeySmooth.warning === null,
        `a summed peak over full scale is WARNED about and one under it is not (peak ${journey.summedPeakDb}, warning ${JSON.stringify(journeySmooth.warning)})`
      );

      // CP1: and the REUSE arm, which is the difference between a four-minute
      // second pass and a four-second one. Running the journey again on the
      // same song must find the stems it just made rather than re-running the
      // model — and must SAY that it did.
      const journeyAgain = await page.evaluate(() =>
        window.__test.runCoverJourney('cover-reference.wav', 'cover-take.wav')
      );
      console.log(
        `  second pass: ok=${journeyAgain.ok} completed=${journeyAgain.completed} reused=${journeyAgain.separationReused}`
      );
      assert(
        journeyAgain.separationReused === true,
        `a second pass REUSED the separation instead of re-running the model (actual ${journeyAgain.separationReused})`
      );
      assert(
        journeyAgain.stages.filter((st) => st.id === 'separate')[0].status === 'reused',
        'the reuse is reported as its own status, not disguised as a fresh run'
      );

      // M4: the BELIEVED arm, which until now ran nowhere in the packaged app.
      //
      // The pass above takes the refusal arm, correctly — its fixtures are
      // filtered noise and share no onset structure. So every packaged run to
      // date proved that a bad alignment is refused, and none proved that a good
      // one is BELIEVED and lands where it says. That is the more dangerous half:
      // a take placed at a confidently wrong offset is harder to notice than one
      // left at zero. This pass drives the shared-onset pair, whose offset is
      // built in rather than measured, through the same six real stages.
      console.log('Cover journey (M4): the shared-onset pair → the BELIEVED arm...');
      // The song's stems are opened first, so stage 1 finds them and REUSES
      // them. That is not a shortcut around separation — it is the only way this
      // arm is reachable, and the reason is measured: driving the real model with
      // this synthetic mix routes it almost entirely to Other (source RMS -17.99
      // dBFS; Vocals came back -59.28, i.e. 41 dB down and empty), so the
      // alignment is handed a silent reference and correctly refuses. A model
      // that recognised it would need a real vocal recording, which this repo
      // cannot carry. The fresh-model path stays covered by the pass above.
      for (const stem of COVER_SONG_SYNC_STEMS) {
        await page.evaluate((p) => window.__test.openPath(p), stem);
      }
      await page.evaluate((p) => window.__test.openPath(p), COVER_SONG_SYNC);
      const syncSong = await page.evaluate(() => window.__test.getStateSummary());
      await page.evaluate((p) => window.__test.openPath(p), COVER_TAKE_SYNC);
      const sync = await page.evaluate(() =>
        window.__test.runCoverJourney('cover-song-sync.wav', 'cover-take-sync.wav')
      );
      console.log(
        `  runCoverJourney(sync): ok=${sync.ok} completed=${sync.completed} reused=${sync.separationReused}`
      );
      console.log(
        `  alignment: offset=${sync.alignmentOffsetSeconds}s confident=${sync.alignmentConfident} ` +
          `peak=${sync.alignmentPeakCorrelation} prominence=${sync.alignmentProminence}`
      );
      console.log(
        `  placement: take@${sync.takeStartSample} instrumental@${sync.instrumentalStartSample} ` +
          `shifted=${sync.shiftedSamples}`
      );
      assert(sync.ok === true && sync.completed === true, 'the shared-onset journey completed');
      // The point of the whole fixture pair: this arm, in the packaged app.
      assert(
        sync.alignmentRefused === false && sync.alignmentConfident === true,
        `the alignment BELIEVED the shared-onset pair (refused ${sync.alignmentRefused}, confident ${sync.alignmentConfident}) — ` +
          `if this refuses, the pair has stopped sharing onset structure, NOT the floors being too high`
      );
      // Believed on numbers that genuinely clear the shipped floors, not on a
      // `confident` flag that drifted away from them.
      assert(
        sync.alignmentPeakCorrelation >= ALIGN_MIN_CORRELATION &&
          sync.alignmentProminence >= ALIGN_MIN_PROMINENCE,
        `both confidence numbers clear their floors (correlation ${sync.alignmentPeakCorrelation} >= ${ALIGN_MIN_CORRELATION}, ` +
          `prominence ${sync.alignmentProminence} >= ${ALIGN_MIN_PROMINENCE})`
      );
      // And it landed where the fixture was BUILT to put it.
      const syncError = Math.abs(sync.alignmentOffsetSeconds - COVER_SYNC_OFFSET_SECONDS);
      assert(
        syncError <= COVER_SYNC_TOLERANCE_SECONDS,
        `the recovered offset matches the built-in one within the DSP's proven ±10 ms ` +
          `(built ${COVER_SYNC_OFFSET_SECONDS}s, recovered ${sync.alignmentOffsetSeconds}s, error ${(syncError * 1000).toFixed(2)} ms)`
      );
      console.log(
        `  ground truth: built ${COVER_SYNC_OFFSET_SECONDS}s, recovered ${sync.alignmentOffsetSeconds}s ` +
          `(error ${(syncError * 1000).toFixed(2)} ms)`
      );
      // The offset is negative, so this is also the first packaged exercise of
      // the shift-BOTH-tracks arm: the take cannot start before zero, so the
      // instrumental moves later by the same amount and the interval survives.
      const syncRaw = Math.round(sync.alignmentOffsetSeconds * sync.sessionRate);
      assert(
        sync.sessionRate === syncSong.sampleRate,
        `the session runs at the SONG's rate (session ${sync.sessionRate}, song ${syncSong.sampleRate})`
      );
      assert(syncRaw < 0, `the built-in offset is negative, as the fixture intends (raw ${syncRaw})`);
      assert(
        sync.takeStartSample === 0 &&
          Math.abs(sync.shiftedSamples - -syncRaw) <= 1 &&
          Math.abs(sync.instrumentalStartSample - -syncRaw) <= 1,
        `a negative believed offset shifts BOTH tracks rather than clamping the take ` +
          `(take ${sync.takeStartSample}, shift ${sync.shiftedSamples}, instrumental ${sync.instrumentalStartSample}, expected shift ${-syncRaw})`
      );
      assert(
        Math.abs(sync.takeStartSample - sync.instrumentalStartSample - syncRaw) <= 1,
        `the measured interval survives the shift (raw ${syncRaw}, actual ${sync.takeStartSample - sync.instrumentalStartSample})`
      );
      // Stage 1 must have found THIS song's stems. If it ever runs the model
      // here instead, the reference becomes the empty Vocals stem the model
      // produces from synthetic audio and the assertions above stop meaning what
      // they say — so the reuse is pinned rather than assumed.
      assert(
        sync.separationReused === true,
        `stage 1 reused the stems shipped beside the song (actual ${sync.separationReused})`
      );
      assert(
        sync.stages.filter((st) => st.id === 'separate')[0].status === 'reused',
        'the reuse is reported as its own status, not disguised as a fresh run'
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
    //   (a) a REAL positioner gesture on the built app: open the positioner
    //       from its Effects-card tool row (F11-8 retired the Spatial strip
    //       tab), pick track 2, drag the stage — ONE commit writing
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

    // (a) Open the positioner and aim it at track 2 (lane-free, so the
    // gesture's effect is unambiguous).
    // F11-8: Spatial is a TOOL now, not a module — there is no strip icon to
    // click. Reached through its own command row in the Effects card, which is
    // the surface the user reaches it from; the Effects menu's "Spatial
    // Positioner" row is the identical command (T8 moved it there from the
    // Pipeline menu). The row is never greyed, so
    // this works from the multitrack view this step runs in.
    await openModuleCard(page, 'Effects');
    await page.click(
      '[data-testid="effects-tool-item"][data-command-id="spatial.position"] button'
    );
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

    // 21) R3 (v1.12) — session undo, end to end -----------------------------
    //
    // Nobody had pressed Ctrl+Z in the running app until this step. It
    // drives REAL gestures through the packaged renderer and asserts the
    // three load-bearing properties against anchors recorded independently
    // BEFORE each gesture (never re-derived through the code under test):
    //   (a) Ctrl+Z in the multitrack view reverts a committed clip move
    //       exactly, and Ctrl+Y re-applies the exact committed position;
    //   (b) a trim drag — which writes the store on EVERY pointermove — is
    //       ONE undo step (ruling 2): the step proves the drag really wrote
    //       intermediate states mid-drag (the anti-vacuous guard: without
    //       that read, per-write entries restoring only the last slice
    //       could masquerade as coalescing on a one-write drag), then
    //       asserts a SINGLE Ctrl+Z restores the pre-drag length exactly;
    //   (c) the stacks are ordered: the next Ctrl+Z after the trim undo
    //       reverts the earlier move, not anything else.
    console.log('Session undo (v1.12): move, Ctrl+Z, Ctrl+Y, one-step trim undo...');
    await page.evaluate(() => window.__test.setView('waveform'));
    await page.evaluate((p) => window.__test.openPath(p), TONE);
    await page.evaluate((rate) => window.__test.newSession(rate), 44100);
    const undoClip = await page.evaluate(() => window.__test.insertActiveDocAsClip(0, 0));
    assert(
      undoClip !== null && undoClip.startSample === 0 && undoClip.lengthSample === 88200,
      `one tone clip inserted at 0, length 88200 (${JSON.stringify(undoClip)})`
    );
    await page.waitForFunction(
      () => document.querySelectorAll('[data-testid="clip"]').length === 1,
      null,
      { timeout: 10000 }
    );

    // (a) A real move drag, then Ctrl+Z / Ctrl+Y. Anchors: start 0 recorded
    // above from the insert echo; the moved position read back once and then
    // required EXACTLY after redo.
    const undoRect0 = await page.evaluate(() => {
      const r = document.querySelector('[data-testid="clip"]').getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    });
    const uGrabX = undoRect0.x + undoRect0.width / 2;
    const uGrabY = undoRect0.y + undoRect0.height / 2;
    await page.mouse.move(uGrabX, uGrabY);
    await page.mouse.down();
    for (let s = 1; s <= 4; s++) {
      await page.mouse.move(uGrabX + (150 * s) / 4, uGrabY, { steps: 4 });
    }
    await page.mouse.up();
    const undoMoved = await page.evaluate(() => window.__test.getClipFadeState());
    assert(
      undoMoved.clips.length === 1 && undoMoved.clips[0].startSample > 0,
      `the drag committed a move (start ${undoMoved.clips[0].startSample} > 0)`
    );
    const movedStart = undoMoved.clips[0].startSample;

    await page.keyboard.press('Control+z');
    const undoAfterZ = await page.evaluate(() => window.__test.getClipFadeState());
    assert(
      undoAfterZ.clips.length === 1 && undoAfterZ.clips[0].startSample === 0,
      `Ctrl+Z in the multitrack view reverted the move exactly (start ${undoAfterZ.clips[0].startSample} === 0)`
    );
    await page.keyboard.press('Control+y');
    const undoAfterY = await page.evaluate(() => window.__test.getClipFadeState());
    assert(
      undoAfterY.clips[0].startSample === movedStart,
      `Ctrl+Y re-applied the exact committed position (${undoAfterY.clips[0].startSample} === ${movedStart})`
    );

    // M4: Fit before grabbing the right edge, because the edge is no longer on
    // screen without it. A session now opens FITTED (MT1), so this clip fills
    // the lane exactly — 88200 samples across 985 px — and the +150 px move
    // above therefore pushes its right edge 150 px PAST the visible lane. The
    // layout rect still reports it, so `x + width - 2` looks like a valid
    // coordinate while `elementFromPoint` there returns the multitrack view
    // rather than the clip's resize handle, and the drag silently trims
    // nothing. That is not a regression in the app — a session that grew does
    // not re-fit itself, deliberately (only shrinking re-resolves) — it is this
    // step's own assumption, written when a session opened at 512 samples/px
    // and a 2 s clip was 172 px wide with room to spare. Fit is the control the
    // user has for exactly this, and clicking it here also gives the
    // multitrack's Fit button its first packaged exercise.
    await page.evaluate(() => {
      const fit = document.querySelector('[data-testid="toolbar-pill"] button[aria-label="Fit"]');
      if (!fit) throw new Error('the toolbar has no Fit button');
      fit.click();
    });
    await page.waitForFunction(
      () => {
        const c = document.querySelector('[data-testid="clip"]');
        if (!c) return false;
        const r = c.getBoundingClientRect();
        const el = document.elementFromPoint(r.x + r.width - 2, r.y + r.height / 2);
        return Boolean(el && c.contains(el));
      },
      null,
      { timeout: 10000 }
    );

    // (b) A real trim drag: grab the clip's right edge (the outer 6 CSS px),
    // drag left in several separated moves so the store is written multiple
    // times, and PROVE it mid-drag with a state read taken while the button
    // is still down — the guard that makes the one-Ctrl+Z assertion below
    // non-vacuous.
    const undoRect1 = await page.evaluate(() => {
      const r = document.querySelector('[data-testid="clip"]').getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    });
    const tGrabX = undoRect1.x + undoRect1.width - 2;
    const tGrabY = undoRect1.y + undoRect1.height / 2;
    await page.mouse.move(tGrabX, tGrabY);
    await page.mouse.down();
    await page.mouse.move(tGrabX - 30, tGrabY, { steps: 4 });
    const undoMidTrim = await page.evaluate(() => window.__test.getClipFadeState());
    await page.mouse.move(tGrabX - 60, tGrabY, { steps: 4 });
    await page.mouse.move(tGrabX - 90, tGrabY, { steps: 4 });
    await page.mouse.up();
    const undoTrimmed = await page.evaluate(() => window.__test.getClipFadeState());
    assert(
      undoMidTrim.clips[0].lengthSample < 88200 &&
        undoMidTrim.clips[0].lengthSample > undoTrimmed.clips[0].lengthSample,
      `the trim wrote the store MID-drag (${undoMidTrim.clips[0].lengthSample} strictly between the final ${undoTrimmed.clips[0].lengthSample} and 88200) — multiple live writes, so one undo restoring 88200 exactly proves the gesture coalesced`
    );
    assert(
      undoTrimmed.clips[0].lengthSample < 88200 - 1000,
      `the trim shortened the clip by a meaningful amount (${undoTrimmed.clips[0].lengthSample} < 87200)`
    );

    await page.keyboard.press('Control+z');
    const undoAfterTrimZ = await page.evaluate(() => window.__test.getClipFadeState());
    assert(
      undoAfterTrimZ.clips[0].lengthSample === 88200 &&
        undoAfterTrimZ.clips[0].startSample === movedStart,
      `ONE Ctrl+Z restored the whole trim gesture (length ${undoAfterTrimZ.clips[0].lengthSample} === 88200) without touching the earlier move (start still ${movedStart})`
    );

    // (c) Stack order: the next Ctrl+Z reverts the MOVE.
    await page.keyboard.press('Control+z');
    const undoAfterZ2 = await page.evaluate(() => window.__test.getClipFadeState());
    assert(
      undoAfterZ2.clips[0].startSample === 0 && undoAfterZ2.clips[0].lengthSample === 88200,
      'the next Ctrl+Z reverted the earlier move (start back to 0, length untouched)'
    );

    // 22) F4b (v1.16) — transcription with speaker separation, end to end ---
    //
    // Nothing in this feature had ever run through a real `utilityProcess`
    // before this step: the host's spawn, its sliced-audio transport and its
    // Cancel were covered only by unit tests with a FAKE child, which is
    // precisely the class of bug v1.7 met at packaging time. This step
    // discharges what those tests structurally cannot:
    //   (a) a REAL spawn and a REAL multi-slice transport. The manager cuts
    //       the 16 kHz mono buffer into 1<<20-sample messages and the host
    //       REFUSES to run unless the delivered slices cover [0, totalSamples)
    //       exactly, so a successful `done` on a fixture longer than one slice
    //       is itself the transport proof. The slice count is computed HERE
    //       from the fixture's own duration, never read back from the app;
    //   (b) Cancel against a LIVE child: a run is killed mid-flight and the
    //       NEXT run is then required to succeed — the anti-vacuous guard,
    //       because a cancel that left the child alive or the manager's slot
    //       reserved would show up as a busy refusal or a hang, not as a
    //       failed cancel;
    //   (c) the renderer surface in the packaged app: the transcript reached
    //       through Pipeline > Transcribe (F11-8 retired the Transcript strip
    //       tab), a row per segment, the region ribbon over the waveform, a click
    //       moving the real playhead, the speaker-count control re-grouping
    //       with no second inference run, and an SRT written to disk whose
    //       timestamps are re-derived here with independent arithmetic.
    //
    // GATED ON THE MODELS, not on a fixture: the ~323 MB six-file set is
    // downloaded on first use and is never committed, so a machine without it
    // REPORTS a skip with the reason — never a silent pass.
    //
    // Entry state from step 21: the tone document is open in the waveform view
    // inside a one-clip session. This step opens its own documents and does
    // not depend on any of that.
    console.log('Transcription (F4b): real utilityProcess, cancel, panel, ribbon, SRT...');
    const transcribeModel0 = await page.evaluate(() => window.__test.getTranscribeModelState());
    const transcribeMb = (transcribeModel0.expectedBytes / 1e6).toFixed(0);
    let transcribeModel = transcribeModel0;
    if (!transcribeModel.downloaded) {
      // Same provisioning stance as step 17: when a repo-local copy exists
      // (test-assets/models/transcription/, gitignored) it is linked/copied
      // into the app's own model directory first, which is exactly where the
      // app's downloader would have put it. The manager re-verifies every
      // sha256 pin from disk before every load, so a bad copy fails loudly
      // rather than transcribing with a wrong model.
      const repoDir = path.join(ROOT, 'test-assets', 'models', 'transcription');
      if (fs.existsSync(repoDir)) {
        const userData = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));
        const destDir = path.join(userData, 'models', 'transcription');
        console.log(`  provisioning the transcription models from test-assets into ${destDir}`);
        fs.mkdirSync(destDir, { recursive: true });
        for (const name of fs.readdirSync(repoDir)) {
          const dest = path.join(destDir, name);
          if (fs.existsSync(dest)) continue;
          try {
            fs.linkSync(path.join(repoDir, name), dest);
          } catch {
            fs.copyFileSync(path.join(repoDir, name), dest);
          }
        }
        transcribeModel = await page.evaluate(() => window.__test.getTranscribeModelState());
      }
    }
    if (!transcribeModel.downloaded) {
      console.log(
        `Transcription: SKIPPED (REPORTED) — the ${transcribeMb} MB transcription model set ` +
          `is not on this machine and no valid repo-local copy exists at ` +
          `test-assets/models/transcription/. Download it in-app ` +
          `(Pipeline → Transcribe → Download Models) to make this step run.`
      );
    } else {
      // --- (a) real spawn + multi-slice transport -------------------------
      //
      // Anchors computed from the fixture, independently of the app: 70 s at
      // 44100 Hz resamples to round(70*44100 * 16000/44100) = 1,120,000 model
      // samples, and the manager's AUDIO_SLICE_SAMPLES is 1<<20 = 1,048,576.
      const SLICE_SAMPLES = 1 << 20;
      const WHISPER_RATE = 16000;
      await page.evaluate(() => window.__test.setView('waveform'));
      await page.evaluate((p) => window.__test.openPath(p), LONG70);
      const longState = await page.evaluate(() => window.__test.getStateSummary());
      const expectedModelSamples = Math.round(
        (longState.length * WHISPER_RATE) / longState.sampleRate
      );
      const expectedSlices = Math.ceil(expectedModelSamples / SLICE_SAMPLES);
      assert(
        expectedSlices >= 2,
        `the transport fixture spans ${expectedSlices} IPC audio slices (${expectedModelSamples} model samples / ${SLICE_SAMPLES} per slice) — more than one, so the slicing is actually exercised`
      );
      console.log(
        `  source: ${longState.activeName}, ${(longState.length / longState.sampleRate).toFixed(
          1
        )}s, ${longState.sampleRate} Hz, ${longState.channels} ch → ${expectedModelSamples} model samples in ${expectedSlices} slices`
      );

      const run = await page.evaluate(() => window.__test.transcribeActive(null));
      const runSeconds = run.elapsedMs / 1000;
      const audioSeconds = longState.length / longState.sampleRate;
      console.log(
        `  transcribeActive: status=${run.status} segments=${run.segmentCount} ` +
          `speakers=${run.speakerCount} language=${run.language} ` +
          `(${runSeconds.toFixed(1)}s for ${audioSeconds.toFixed(1)}s of audio, ` +
          `${(audioSeconds / runSeconds).toFixed(2)}x realtime, model load included)`
      );
      assert(
        run.ok === true,
        `the real utility process spawned, received all ${expectedSlices} audio slices and finished (status ${run.status}${
          run.message ? `: ${run.message}` : ''
        }) — the host refuses to run on incomplete coverage, so this IS the transport proof`
      );
      assert(
        run.progressEvents > 0,
        `the host streamed progress rather than only reporting done (${run.progressEvents} event(s))`
      );
      assert(
        run.transcribeTotal === expectedModelSamples,
        `the host was told the sample count this script computed independently (${run.transcribeTotal} === ${expectedModelSamples})`
      );
      assert(
        run.maxTranscribeDone === expectedModelSamples,
        `the decode walked the WHOLE buffer, including the short final slice (${run.maxTranscribeDone} === ${expectedModelSamples})`
      );
      assert(
        run.sampleRate === longState.sampleRate,
        `segment positions came back in DOCUMENT samples, not model samples (${run.sampleRate} === ${longState.sampleRate})`
      );
      for (const seg of run.segments) {
        assert(
          seg.startSample >= 0 && seg.endSample <= longState.length && seg.endSample > seg.startSample,
          `segment ${seg.index} lies inside the document [0, ${longState.length}) and is non-empty (${seg.startSample}..${seg.endSample})`
        );
      }

      // --- (b) Cancel against a LIVE child --------------------------------
      //
      // 2000 ms is comfortably inside a run that takes seconds just to
      // sha256-verify 323 MB and build three ORT sessions, so the cancel lands
      // while a child is alive. If it ever landed late the status would be
      // 'ok' and the assertion below would say so rather than passing.
      const cancelled = await page.evaluate(() => window.__test.transcribeActiveThenCancel(2000));
      console.log(
        `  transcribeActiveThenCancel: status=${cancelled.status} after ${(
          cancelled.elapsedMs / 1000
        ).toFixed(1)}s`
      );
      assert(
        cancelled.status === 'cancelled',
        `Cancel settled the run as cancelled against a real child (status ${cancelled.status})`
      );
      assert(
        cancelled.elapsedMs < run.elapsedMs,
        `the cancelled run stopped EARLY rather than running to completion (${cancelled.elapsedMs}ms < ${run.elapsedMs}ms)`
      );

      // The anti-vacuous guard: a cancel that left the child alive, or left
      // the manager's one-run slot reserved, breaks the NEXT run — as a busy
      // refusal or a hang, never as a failed cancel.
      const afterCancel = await page.evaluate(() => window.__test.transcribeActive(null));
      assert(
        afterCancel.ok === true,
        `a fresh run succeeds after the cancel, so the killed child released its slot and its ORT arena (status ${afterCancel.status})`
      );

      // --- (c) the renderer surface ---------------------------------------
      //
      // Driven off a REAL speech file when the machine has one, because the
      // synthetic sweep is not speech and Whisper may legitimately find
      // nothing in it. With no speech file and no segments, this half REPORTS
      // rather than passing on an empty list.
      let surface = afterCancel;
      let surfaceName = longState.activeName;
      if (fs.existsSync(SPEECH)) {
        await page.evaluate((p) => window.__test.openPath(p), SPEECH);
        const speechState = await page.evaluate(() => window.__test.getStateSummary());
        surfaceName = speechState.activeName;
        console.log(
          `  real speech fixture present: ${surfaceName}, ${(
            speechState.length / speechState.sampleRate
          ).toFixed(1)}s`
        );
        surface = await page.evaluate(() => window.__test.transcribeActive(null));
        assert(surface.ok === true, `the speech fixture transcribed (status ${surface.status})`);
        console.log(
          `  speech transcript: ${surface.segmentCount} segment(s), ${surface.speakerCount} speaker(s), ` +
            `first line ${JSON.stringify((surface.segments[0] || {}).text || '')}`
        );
      }

      if (surface.segmentCount === 0) {
        console.log(
          '  Transcript surface: SKIPPED (REPORTED) — the synthetic sweep produced no speech ' +
            'segments, so there is no transcript to render. The panel, ribbon and export are ' +
            'covered by the jsdom component tests; drop a speech WAV at test-assets/speech16k.wav ' +
            'to exercise them against the packaged app too.'
        );
      } else {
        // F11-8: Transcript is no longer a strip icon — it is not a module,
        // it is what the Transcribe TOOL produces. So the transcript surface is
        // now reached the way a user reaches it: run Transcribe on a document
        // that already has one, and it reveals the panel instead of re-running
        // the model. This drives the real Pipeline menu row, which also proves
        // the reveal-vs-rerun branch in `edit.transcribe`.
        const stripHasTranscript = await page.$(
          '[data-testid="sidebar-tabs"] [aria-label="Transcript"]'
        );
        assert(
          stripHasTranscript === null,
          'Transcript is not a module-strip entry any more — it is a tool result'
        );
        assert(await openMenu('Pipeline'), 'the Pipeline menu opens for Transcribe');
        await page.evaluate(() => {
          const row = [
            ...document.querySelectorAll('[data-testid="menu-dropdown"] button'),
          ].find((b) => b.querySelector('span').textContent.trim() === 'Transcribe');
          row.click();
        });
        await page.waitForFunction(
          () =>
            document.querySelector('[data-testid="sidebar-panel"]')?.getAttribute(
              'data-active-tab'
            ) === 'transcript',
          null,
          { timeout: 5000 }
        );
        await page.waitForFunction(
          () => document.querySelector('[data-testid="transcript-panel"]') !== null,
          null,
          { timeout: 5000 }
        );
        const rowCount = await page.evaluate(
          () => document.querySelectorAll('[data-testid="transcript-item"]').length
        );
        assert(
          rowCount === surface.segmentCount,
          `the panel shows one row per segment (${rowCount} === ${surface.segmentCount})`
        );

        // The ribbon draws a region per VISIBLE segment. At the default zoom
        // only part of the file is on screen, so require at least one and no
        // more than the segment count.
        const regionCount = await page.evaluate(
          () => document.querySelectorAll('[data-testid="transcript-region"]').length
        );
        assert(
          regionCount >= 1 && regionCount <= surface.segmentCount,
          `the timeline ribbon drew ${regionCount} region(s), between 1 and the ${surface.segmentCount} segment(s)`
        );

        // No markers were created: the transcript must never be written into
        // the user's marker list (it would be saved into their exported audio).
        const markerCount = await page.evaluate(() => window.__test.getActiveMarkers().length);
        assert(
          markerCount === 0,
          `the transcript added NO markers to the document (${markerCount} === 0) — it is never persisted into the user's cue chunks`
        );

        // A real click on a row's time button moves the real playhead. The
        // target is the LAST row whose start is non-zero and the cursor is
        // parked somewhere else first — clicking the first row of a transcript
        // that starts at sample 0 would assert 0 === 0 and pass without the
        // handler running at all.
        const gotoButtons = await page.$$('[data-testid="transcript-goto"]');
        assert(gotoButtons.length === rowCount, `every row has a Go-to button (${gotoButtons.length})`);
        const gotoIndex = surface.segments.map((s) => s.startSample).lastIndexOf(
          Math.max(...surface.segments.map((s) => s.startSample))
        );
        const gotoTarget = surface.segments[gotoIndex].startSample;
        // Park the cursor somewhere else FIRST, with a real gesture — clicking
        // the time ruler seeks. Without this the assertion below is vacuous
        // whenever the target segment starts at sample 0, which is exactly
        // what a one-segment transcript of a short clip looks like.
        const rulerBox = await page.evaluate(() => {
          const r = document.querySelector('[data-testid="timeline-ruler"]').getBoundingClientRect();
          return { x: r.x, y: r.y, width: r.width, height: r.height };
        });
        await realClick(page, rulerBox.x + rulerBox.width * 0.6, rulerBox.y + rulerBox.height / 2);
        const beforeGoto = await page.evaluate(() => window.__test.getEditorViewState());
        assert(
          beforeGoto.cursorSample !== gotoTarget,
          `a ruler click parked the cursor away from the target first (${beforeGoto.cursorSample} !== ${gotoTarget}) — so the Go-to assertion cannot pass vacuously`
        );
        await gotoButtons[gotoIndex].click();
        const afterGoto = await page.evaluate(() => window.__test.getEditorViewState());
        assert(
          afterGoto.cursorSample === gotoTarget,
          `clicking row ${gotoIndex + 1} moved the cursor from ${beforeGoto.cursorSample} to that segment's start (${afterGoto.cursorSample} === ${gotoTarget})`
        );

        // The speaker-count control re-groups WITHOUT another inference run:
        // forcing 1 must collapse every label to speaker 0, instantly.
        const regrouped = await page.evaluate(() => window.__test.setTranscriptSpeakers(1));
        assert(
          regrouped !== null && regrouped.speakerCount === 1,
          `forcing one speaker re-grouped the stored embeddings (${JSON.stringify(regrouped)})`
        );
        assert(
          regrouped.speakers.every((s) => s === 0),
          'every segment carries the single speaker after the re-group'
        );
        await page.evaluate(() => window.__test.setTranscriptSpeakers(null));

        // The SRT on disk, re-parsed and re-derived here.
        const wrote = await page.evaluate(
          (p) => window.__test.exportTranscriptTo('srt', p),
          OUT_TRANSCRIPT_SRT
        );
        assert(wrote === true, `the transcript wrote to ${OUT_TRANSCRIPT_SRT}`);
        assert(fs.existsSync(OUT_TRANSCRIPT_SRT), 'the .srt exists on disk');
        const srt = fs.readFileSync(OUT_TRANSCRIPT_SRT, 'utf8');
        const blocks = srt.trim().split(/\n\s*\n/);
        assert(
          blocks.length === surface.segmentCount,
          `the .srt holds one cue per segment (${blocks.length} === ${surface.segmentCount})`
        );

        // Independent timestamp arithmetic — NOT the app's formatter.
        const stamp = (samples, rate) => {
          const totalMs = Math.round((samples / rate) * 1000);
          const ms = totalMs % 1000;
          const totalS = (totalMs - ms) / 1000;
          const s = totalS % 60;
          const totalM = (totalS - s) / 60;
          const m = totalM % 60;
          const h = (totalM - m) / 60;
          const p2 = (n) => String(n).padStart(2, '0');
          return `${p2(h)}:${p2(m)}:${p2(s)},${String(ms).padStart(3, '0')}`;
        };
        const firstLines = blocks[0].split('\n');
        assert(firstLines[0].trim() === '1', `the first cue is numbered 1 (${firstLines[0].trim()})`);
        const expectedFirst = `${stamp(surface.segments[0].startSample, surface.sampleRate)} --> ${stamp(
          surface.segments[0].endSample,
          surface.sampleRate
        )}`;
        assert(
          firstLines[1].trim() === expectedFirst,
          `the first cue's times match this script's own arithmetic (${firstLines[1].trim()} === ${expectedFirst})`
        );
        const lastNumber = Number(blocks[blocks.length - 1].split('\n')[0].trim());
        assert(
          lastNumber === surface.segmentCount,
          `cue numbering runs contiguously to the last segment (${lastNumber} === ${surface.segmentCount})`
        );
        console.log(`  wrote ${blocks.length} SRT cue(s) from ${surfaceName}`);
      }
    }

    // 23) F3 (v1.17) — Voice Changer, end to end in the packaged app --------
    //
    // Same reason step 22 exists: this feature's utility process, its chunked
    // splice and its consent gate had only ever run against fakes or against
    // `node`, never inside the packaged Electron bundle. What this step
    // discharges that unit tests structurally cannot:
    //   (a) the CONSENT GATE survives bundling. The brief's ruling makes
    //       affirmation blocking, so both entry points are driven with
    //       consent WITHHELD first and must refuse, and only then with it
    //       given. A gate that had been optimised away, or that the packaged
    //       preload silently bypassed, fails here and nowhere else;
    //   (b) a REAL spawn, a REAL multi-slice transport (the manager cuts the
    //       22050 Hz buffer into 1<<20-sample messages and the host refuses
    //       to run unless the slices cover [0, totalSamples) exactly) and a
    //       REAL multi-chunk splice. The chunk count is computed HERE from
    //       the fixture's own duration and the plan law restated below with
    //       literal constants — never read back from the app;
    //   (c) the converted audio is re-measured from the WAV the app WROTE,
    //       decoded by this script's own RIFF reader, so the length, rate,
    //       channel count, level and — the one that matters — the absence of
    //       a level discontinuity at each seam are this script's arithmetic
    //       and not the app's self-report;
    //   (d) Cancel against a LIVE child, with the anti-vacuous follow-up: a
    //       later run must still succeed, because a cancel that left the
    //       child alive or the manager's slot reserved shows up as a busy
    //       refusal, not as a failed cancel.
    //
    // GATED ON THE MODELS: the 161 MB two-file set is downloaded on first use
    // and is never committed, so a machine without it REPORTS a skip.
    console.log('Voice Changer (F3): consent gate, real utilityProcess, chunked splice, cancel...');
    const voiceModel0 = await page.evaluate(() => window.__test.getVoiceModelState());
    const voiceMb = (voiceModel0.expectedBytes / 1e6).toFixed(0);
    let voiceModel = voiceModel0;
    if (!voiceModel.downloaded) {
      const repoDir = path.join(ROOT, 'test-assets', 'models', 'voice');
      if (fs.existsSync(repoDir)) {
        const userData = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));
        const destDir = path.join(userData, 'models', 'voice');
        console.log(`  provisioning the voice models from test-assets into ${destDir}`);
        fs.mkdirSync(destDir, { recursive: true });
        for (const name of fs.readdirSync(repoDir)) {
          const dest = path.join(destDir, name);
          if (fs.existsSync(dest)) continue;
          try {
            fs.linkSync(path.join(repoDir, name), dest);
          } catch {
            fs.copyFileSync(path.join(repoDir, name), dest);
          }
        }
        voiceModel = await page.evaluate(() => window.__test.getVoiceModelState());
      }
    }
    if (!voiceModel.downloaded) {
      console.log(
        `Voice Changer: SKIPPED (REPORTED) — the ${voiceMb} MB voice model set is not on this ` +
          `machine and no valid repo-local copy exists at test-assets/models/voice/. Download it ` +
          `in-app (Pipeline → Voice Changer → Download Models) to make this step run.`
      );
    } else {
      // The model's fixed rate and the chunk-plan law, restated here with
      // literal constants so the expected chunk count is this script's
      // arithmetic. (voiceChunking.cjs derives them; a smoke step that
      // imported them would be asking the app to mark its own homework.)
      const VC_RATE = 22050;
      const VC_SEGMENT = 661504; // ~30 s, rounded up to a HOP multiple
      const VC_OVERLAP = 33536; // 2 x 16,384 discard + 551 crossfade, HOP-aligned
      const VC_STRIDE = VC_SEGMENT - VC_OVERLAP; // 627,968
      const planChunks = (total) => {
        const n = Math.max(1, Math.ceil(total / VC_STRIDE));
        const lastStart = (n - 1) * VC_STRIDE;
        const lastLen = Math.min(lastStart + VC_SEGMENT, total) - lastStart;
        return n > 1 && lastLen < VC_OVERLAP ? n - 1 : n;
      };

      await page.evaluate(() => window.__test.setView('waveform'));
      await page.evaluate((p) => window.__test.openPath(p), LONG70);
      const voiceSrc = await page.evaluate(() => window.__test.getStateSummary());
      const expectedModelSamples = Math.round((voiceSrc.length * VC_RATE) / voiceSrc.sampleRate);
      const expectedChunks = planChunks(expectedModelSamples);
      assert(
        expectedChunks >= 2,
        `the fixture forces a MULTI-CHUNK conversion: ${expectedModelSamples} model samples over a ${VC_STRIDE}-sample stride is ${expectedChunks} chunks, so the splice is actually exercised`
      );
      console.log(
        `  source: ${voiceSrc.activeName}, ${(voiceSrc.length / voiceSrc.sampleRate).toFixed(1)}s, ` +
          `${voiceSrc.sampleRate} Hz, ${voiceSrc.channels} ch → ${expectedModelSamples} model samples in ${expectedChunks} chunks`
      );

      // --- (a) the consent gate, in the packaged build --------------------
      const refusedProfile = await page.evaluate(
        (n) => window.__test.createVoiceProfileFrom('Smoke target', 0, n, false),
        8 * voiceSrc.sampleRate
      );
      assert(
        refusedProfile.ok === false && refusedProfile.status === 'consent-required',
        `saving a voice profile WITHOUT the consent affirmation is refused (status ${refusedProfile.status})`
      );
      assert(
        refusedProfile.profileId === null,
        'the refused profile was not created — the gate is before the work, not after it'
      );

      const profile = await page.evaluate(
        (n) => window.__test.createVoiceProfileFrom('Smoke target', 0, n, true),
        8 * voiceSrc.sampleRate
      );
      assert(
        profile.ok === true,
        `with the affirmation, the profile saves (status ${profile.status}${profile.message ? `: ${profile.message}` : ''})`
      );
      assert(
        profile.embeddingLength === 256 && profile.embeddingNorm > 0,
        `the real tone extractor ran: a 256-value embedding with a non-zero norm (${profile.embeddingLength} values, norm ${profile.embeddingNorm.toFixed(4)})`
      );

      const refusedConvert = await page.evaluate(
        (id) => window.__test.convertActiveVoice(id, false),
        profile.profileId
      );
      assert(
        refusedConvert.ok === false && refusedConvert.status === 'consent-required',
        `converting WITHOUT the consent affirmation is refused (status ${refusedConvert.status})`
      );
      assert(
        refusedConvert.docCountDelta === 0,
        'the refused conversion produced no document — nothing ran'
      );

      // --- (b) the real run -----------------------------------------------
      const beforeConvert = await page.evaluate(() => window.__test.getStateSummary());
      const conv = await page.evaluate(
        (id) => window.__test.convertActiveVoice(id, true),
        profile.profileId
      );
      const convSeconds = conv.elapsedMs / 1000;
      const audioSeconds = voiceSrc.length / voiceSrc.sampleRate;
      console.log(
        `  convertActiveVoice: status=${conv.status} doc="${conv.docName}" ` +
          `(${convSeconds.toFixed(1)}s for ${audioSeconds.toFixed(1)}s of audio, ` +
          `${(audioSeconds / convSeconds).toFixed(2)}x realtime, model load included)`
      );
      assert(
        conv.ok === true,
        `the real utility process spawned, received every audio slice and finished (status ${conv.status}${conv.message ? `: ${conv.message}` : ''})`
      );
      assert(conv.docCountDelta === 1, `the conversion landed exactly ONE new document (${conv.docCountDelta})`);
      assert(
        conv.landedSampleRate === VC_RATE,
        `the landed document is at the model's fixed rate (${conv.landedSampleRate} Hz)`
      );
      assert(conv.landedChannelCount === 1, `the landed document is mono (${conv.landedChannelCount} ch)`);
      assert(
        conv.landedLengthSamples === expectedModelSamples,
        `the landed length is this script's own arithmetic, sample for sample (${conv.landedLengthSamples} === ${expectedModelSamples})`
      );
      assert(
        conv.progressEvents > 0 && conv.phasesSeen.includes('converting'),
        `the host STREAMED progress rather than only finishing (${conv.progressEvents} events, phases ${conv.phasesSeen.join('/')})`
      );
      assert(
        conv.sanitisedSamples === 0,
        `the model produced no non-finite samples needing sanitising (${conv.sanitisedSamples})`
      );

      // --- (c) re-measure what the app WROTE ------------------------------
      const wrote = await page.evaluate((p) => window.__test.saveActiveAs(p), OUT_VOICE_WAV);
      assert(wrote === true, 'the converted document saved to disk');
      const wav = readWav(OUT_VOICE_WAV);
      assert(
        wav.sampleRate === VC_RATE && wav.channelCount === 1,
        `the WAV on disk is mono at ${VC_RATE} Hz (${wav.channelCount} ch, ${wav.sampleRate} Hz, ${wav.bits}-bit)`
      );
      assert(
        wav.frames === expectedModelSamples,
        `the WAV on disk holds exactly the expected sample count (${wav.frames} === ${expectedModelSamples})`
      );

      const converted = wav.channels[0];
      let peak = 0;
      let sumSquares = 0;
      let nonFinite = 0;
      for (let i = 0; i < converted.length; i++) {
        const v = converted[i];
        if (!Number.isFinite(v)) nonFinite++;
        else {
          const a = Math.abs(v);
          if (a > peak) peak = a;
          sumSquares += v * v;
        }
      }
      const convRmsDb = 20 * Math.log10(Math.max(Math.sqrt(sumSquares / converted.length), 1e-12));
      console.log(`  converted WAV: peak ${peak.toFixed(4)}, RMS ${convRmsDb.toFixed(2)} dBFS`);
      assert(nonFinite === 0, `every sample on disk is finite (${nonFinite} non-finite)`);
      assert(peak > 0.001 && convRmsDb > -60, `the converted audio is real, not silence (RMS ${convRmsDb.toFixed(2)} dBFS)`);
      assert(peak <= 1.0, `the converted audio does not clip (peak ${peak.toFixed(4)})`);

      // THE SEAM CHECK — the one measurement that is worth doing here rather
      // than in a unit test, because a splice bug survives every fake. Seam
      // positions come from the plan law restated above; each is compared
      // against the LOCAL level either side of it, so a dip or a boost
      // introduced by the join shows up regardless of what the material does.
      // LOCAL deliberately: comparing against an unchunked run instead spreads
      // +/-14.26 dB away from any seam, purely from the decoder's
      // rendition-to-rendition decorrelation, and cannot see a seam at all.
      // The bound catches a join that drops the signal or double-adds it. It
      // does NOT discriminate constant power from equal gain at this crossfade
      // length -- equal gain measures -0.87 dB here, which is not a defect --
      // so no such claim is made for it. Measured 1.80 dB on this fixture.
      const { frames: env, size: frameSize } = rmsFrames20ms(converted, VC_RATE);
      const CROSSFADE_OFFSET = 16492; // discard margin + centring slack
      let worstSeamDb = 0;
      let worstSeamAt = -1;
      for (let i = 1; i < expectedChunks; i++) {
        const seam = i * VC_STRIDE + CROSSFADE_OFFSET;
        const seamFrame = Math.round(seam / frameSize);
        // Local reference: the median frame level over +/- 1 s around the
        // seam, EXCLUDING the 5 frames the seam itself spans.
        const near = [];
        for (let f = seamFrame - 50; f <= seamFrame + 50; f++) {
          if (f < 0 || f >= env.length) continue;
          if (Math.abs(f - seamFrame) <= 2) continue;
          near.push(env[f]);
        }
        near.sort((a, b) => a - b);
        const local = near[Math.floor(near.length / 2)];
        if (!(local > 1e-4)) continue;
        for (let f = seamFrame - 2; f <= seamFrame + 2; f++) {
          if (f < 0 || f >= env.length) continue;
          const db = 20 * Math.log10(Math.max(env[f], 1e-12) / local);
          if (Math.abs(db) > Math.abs(worstSeamDb)) {
            worstSeamDb = db;
            worstSeamAt = seam;
          }
        }
      }
      console.log(
        `  seam continuity: worst level change ${worstSeamDb.toFixed(2)} dB across ${expectedChunks - 1} seam(s)` +
          (worstSeamAt >= 0 ? ` (at sample ${worstSeamAt}, ${(worstSeamAt / VC_RATE).toFixed(1)}s)` : '')
      );
      assert(
        Math.abs(worstSeamDb) < 3.5,
        `no chunk seam leaves a level discontinuity (worst ${worstSeamDb.toFixed(2)} dB against a 3.5 dB bound)`
      );

      // --- (d) Cancel against a live child, with the anti-vacuous guard ----
      await page.evaluate(() => window.__test.setView('waveform'));
      await page.evaluate((p) => window.__test.openPath(p), LONG70);
      const cancelled = await page.evaluate(
        (id) => window.__test.convertActiveVoiceThenCancel(id, 2500),
        profile.profileId
      );
      console.log(
        `  convertActiveVoiceThenCancel: status=${cancelled.status} after ${cancelled.elapsedMs} ms`
      );
      assert(
        cancelled.ok === false && cancelled.status === 'cancelled',
        `Cancel stopped a LIVE conversion (status ${cancelled.status})`
      );
      assert(
        cancelled.elapsedMs < conv.elapsedMs,
        `the cancelled run really was cut short (${cancelled.elapsedMs} ms < ${conv.elapsedMs} ms)`
      );
      assert(
        cancelled.docCountDelta === 0,
        `a cancelled conversion lands nothing (${cancelled.docCountDelta} new documents)`
      );

      // Anti-vacuous: the NEXT conversion must succeed. A cancel that left the
      // child alive or the manager's slot reserved shows up here as a busy
      // refusal or a hang, not as a failed cancel. Uses the short fixture so
      // the guard costs seconds rather than another 70 s run.
      await page.evaluate((p) => window.__test.openPath(p), TONE);
      const after = await page.evaluate(
        (id) => window.__test.convertActiveVoice(id, true),
        profile.profileId
      );
      assert(
        after.ok === true,
        `a conversion started AFTER the cancel still succeeds — the child died and the slot was released (status ${after.status}${after.message ? `: ${after.message}` : ''})`
      );
      assert(
        after.landedSampleRate === VC_RATE && after.landedChannelCount === 1,
        `the post-cancel conversion landed a mono ${VC_RATE} Hz document too`
      );
      assert(
        beforeConvert.docCount < (await page.evaluate(() => window.__test.getStateSummary())).docCount,
        'the session gained documents across the whole step, as expected'
      );
    }

    // 24) F6 (v1.21) - Align Lyrics, and replacing a word, in the packaged app
    //
    // What this discharges that unit tests structurally cannot:
    //   (a) the acoustic host SPAWNS inside the packaged bundle, receives every
    //       audio slice and returns a real emission grid. Every alignment test
    //       in the suite feeds the Viterbi a grid built by construction, so the
    //       378 MB graph has never once run under asar;
    //   (b) the word spans it produces are STRUCTURALLY sound - strictly
    //       ascending, non-overlapping, inside the region - checked by this
    //       script's arithmetic over the spans the app reports, not by the app;
    //   (c) a REAL microphone take (Chromium's fake device) is spliced over one
    //       word and the result re-measured FROM THE WAV THE APP WROTE, decoded
    //       by this script's own RIFF reader: the file length is unchanged, no
    //       sample outside the seam-widened region moved by even one bit, every
    //       sample inside the word did, and the step across each seam is no
    //       worse than the step a hard cut at the same point would have left.
    //
    // GATED ON THE MODEL: the 378 MB two-file set is downloaded on first use
    // and is never committed, so a machine without it REPORTS a skip.
    console.log('Align Lyrics (F6): real acoustic host, word spans, replace-a-word seam...');
    const alignModel0 = await page.evaluate(() => window.__test.getAlignModelState());
    const alignMb = (alignModel0.expectedBytes / 1e6).toFixed(0);
    let alignModel = alignModel0;
    if (!alignModel.downloaded) {
      const repoDir = path.join(ROOT, 'test-assets', 'models', 'align');
      if (fs.existsSync(repoDir)) {
        const userData = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));
        const destDir = path.join(userData, 'models', 'align');
        console.log(`  provisioning the align model from test-assets into ${destDir}`);
        fs.mkdirSync(destDir, { recursive: true });
        for (const name of fs.readdirSync(repoDir)) {
          const dest = path.join(destDir, name);
          if (fs.existsSync(dest)) continue;
          try {
            fs.linkSync(path.join(repoDir, name), dest);
          } catch {
            fs.copyFileSync(path.join(repoDir, name), dest);
          }
        }
        alignModel = await page.evaluate(() => window.__test.getAlignModelState());
      }
    }
    if (!alignModel.downloaded) {
      console.log(
        `Align Lyrics: SKIPPED (REPORTED) - the ${alignMb} MB alignment model is not on this ` +
          `machine and no valid repo-local copy exists at test-assets/models/align/. Download it ` +
          `in-app (Pipeline -> Align Lyrics -> Download Model) to make this step run.`
      );
    } else {
      // The real sung take and its verbatim lyrics when the machine has them;
      // otherwise the generated fixture with a short text. The lyrics are
      // personal material, so they live in a gitignored sidecar next to the
      // recording they describe (test-assets/align-bench-lyrics.txt, one
      // lyric line per text line — the same sidecar the F6 benches read)
      // rather than in this script. The material decides ONLY whether the
      // lyrics-match verdict is asserted - every structural and every seam
      // assertion below runs either way, because they are about the wiring
      // and the splice, not about the accuracy the spike measured.
      const realTake = path.join(ROOT, 'test-assets', 'long-real-take.wav');
      const lyricsSidecar = path.join(ROOT, 'test-assets', 'align-bench-lyrics.txt');
      // SMOKE_FORCE_DEGRADED=1 pretends the gitignored real material is
      // absent: the clean-clone gate runs the degraded path, so it must be
      // testable on machines that HAVE the assets.
      const haveReal =
        !process.env.SMOKE_FORCE_DEGRADED &&
        fs.existsSync(realTake) &&
        fs.existsSync(lyricsSidecar);
      // The degraded document must be STEREO like the real take is, because
      // `recordReplacementSeconds` below delivers a stereo take regardless of
      // what it asks for (Chromium's fake device treats `channelCount` as
      // ideal, not exact — RecordingEngine's channel count follows the
      // DEVICE), and `replaceAlignedWord` is DESIGNED to refuse a
      // channel-count mismatch. LONG70's stereo twin keeps the splice on the
      // same 2-channel path the with-assets run exercises; its mono downmix is
      // the identical signal, so the aligner places the words the same way.
      const alignSource = haveReal ? realTake : LONG70_STEREO;
      const alignText = haveReal
        ? fs
            .readFileSync(lyricsSidecar, 'utf8')
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean)
            .join('\n')
        : 'one two three four five six';
      console.log(
        haveReal
          ? '  material: the real 142 s solo vocal with its verbatim lyrics (read from the local sidecar)'
          : '  material: the generated fixture (the real take or its lyrics sidecar is absent) - the lyrics-match verdict is REPORTED, not asserted'
      );

      await page.evaluate(() => window.__test.setView('waveform'));
      await page.evaluate((p) => window.__test.openPath(p), alignSource);
      const alignSrc = await page.evaluate(() => window.__test.getStateSummary());

      // --- (a) the real host ----------------------------------------------
      const aligned = await page.evaluate((t) => window.__test.alignActiveLyrics(t), alignText);
      const alignSeconds = aligned.elapsedMs / 1000;
      const alignAudioSeconds = alignSrc.length / alignSrc.sampleRate;
      console.log(
        `  alignActiveLyrics: status=${aligned.status} ${aligned.wordCount} words ` +
          `(${alignSeconds.toFixed(1)}s for ${alignAudioSeconds.toFixed(1)}s of audio, ` +
          `${(alignAudioSeconds / alignSeconds).toFixed(2)}x realtime, model load included), ` +
          `verdict=${aligned.verdict} median word score ${aligned.medianWordScore.toFixed(4)}`
      );
      assert(
        aligned.ok === true,
        `the real utility process spawned, received every audio slice and returned an emission grid (status ${aligned.status}${aligned.message ? `: ${aligned.message}` : ''})`
      );
      const expectedWords = alignText.split(/\s+/).filter(Boolean).length - aligned.droppedWords.length;
      assert(
        aligned.wordCount === expectedWords,
        `every word the alphabet can represent got a position (${aligned.wordCount} === ${expectedWords}, ${aligned.droppedWords.length} dropped)`
      );
      assert(
        aligned.regionStart === 0 && aligned.regionEnd === alignSrc.length,
        `with no selection the whole file was placed (${aligned.regionStart}..${aligned.regionEnd} of ${alignSrc.length})`
      );

      // --- (b) the spans, checked by this script ---------------------------
      let ascending = true;
      let inside = true;
      let nonEmpty = true;
      let prevEnd = aligned.regionStart;
      for (const w of aligned.words) {
        if (w.startSample < prevEnd) ascending = false;
        if (w.endSample <= w.startSample) nonEmpty = false;
        if (w.startSample < aligned.regionStart || w.endSample > aligned.regionEnd) inside = false;
        prevEnd = w.endSample;
      }
      assert(ascending, 'the word spans are strictly ascending and never overlap - the LAST one included');
      assert(nonEmpty, 'every word span has a non-zero length');
      assert(inside, 'every word span lies inside the region that was aligned');
      const lastWord = aligned.words[aligned.words.length - 1];
      assert(
        lastWord.endSample > aligned.words[0].endSample,
        `the last word lands after the first ("${lastWord.text}" ends at ${lastWord.endSample}, "${aligned.words[0].text}" at ${aligned.words[0].endSample}) - an aligner correct at word 1 and drifting after would still have to get here`
      );
      if (haveReal) {
        assert(
          aligned.verdict === 'match',
          `the singer's OWN lyrics over her OWN take read as a match (median word score ${aligned.medianWordScore.toFixed(4)})`
        );
      } else {
        console.log(`  (verdict on the synthetic fixture: ${aligned.verdict} - reported, not asserted)`);
      }

      // --- (c) replace a word, and measure the seams -----------------------
      const wroteBefore = await page.evaluate((p) => window.__test.saveActiveAs(p), OUT_ALIGN_BEFORE_WAV);
      assert(wroteBefore === true, 'the aligned document saved to disk, as the before-picture');

      const takeInfo = await page.evaluate(() => window.__test.recordReplacementSeconds(1.5));
      console.log(
        `  recordReplacementSeconds: ${takeInfo.length} samples at ${takeInfo.sampleRate} Hz, RMS ${takeInfo.rms.toFixed(4)}`
      );
      assert(takeInfo.rms > 0, 'the fake microphone produced a non-silent take');

      // A word in the middle, so both seams have a real neighbour on the far
      // side of them rather than the start or the end of the file.
      //
      // On the synthetic fixture the splice runs with the request's own
      // `matchPitch` option OFF (the dialog's default is on, and the real
      // material leaves it that way): median-F0 arithmetic between the
      // fixture's sweep tone and the fake device's beep demands a stretch far
      // outside the 0.25x-4x window the time-fit is DESIGNED to refuse —
      // measured at every interior word, at 1.5 s and 3 s takes alike. What
      // this path asserts is the wiring, the commit and the seams, and those
      // run identically either way.
      const spliceOpts = haveReal ? null : { matchPitch: false };
      const targetIndex = Math.floor(aligned.words.length / 2);
      const spliced = await page.evaluate(
        ([i, o]) => window.__test.replaceAlignedWord(i, o),
        [targetIndex, spliceOpts]
      );
      console.log(
        `  replaceAlignedWord(${targetIndex}): status=${spliced.status} word="${spliced.wordText}" ` +
          `region ${spliced.regionStart}..${spliced.regionEnd}, seams ${spliced.headSeamSamples}/${spliced.tailSeamSamples}, ` +
          `gain ${spliced.gainDb.toFixed(2)} dB, pitch ${spliced.pitchShiftSemitones.toFixed(2)} st, fit ${spliced.stretchRatio.toFixed(3)}x`
      );
      assert(
        spliced.ok === true,
        `the splice ran and committed (status ${spliced.status}${spliced.message ? `: ${spliced.message}` : ''})`
      );
      assert(
        spliced.lengthDelta === 0,
        `the document is EXACTLY the length it was - nothing after the splice moved (delta ${spliced.lengthDelta})`
      );
      assert(
        spliced.regionStart === spliced.wordStart - spliced.headSeamSamples &&
          spliced.regionEnd === spliced.wordEnd + spliced.tailSeamSamples,
        'the rewritten region is the word widened by its two seams - the crossfades sit OUTSIDE the word'
      );

      const wroteAfter = await page.evaluate((p) => window.__test.saveActiveAs(p), OUT_ALIGN_AFTER_WAV);
      assert(wroteAfter === true, 'the spliced document saved to disk');

      const wavBefore = readWav(OUT_ALIGN_BEFORE_WAV);
      const wavAfter = readWav(OUT_ALIGN_AFTER_WAV);
      assert(
        wavAfter.frames === wavBefore.frames && wavAfter.sampleRate === wavBefore.sampleRate,
        `the WAV on disk is the same length at the same rate (${wavAfter.frames} frames, ${wavAfter.sampleRate} Hz)`
      );

      const a0 = wavBefore.channels[0];
      const a1 = wavAfter.channels[0];
      let movedOutside = 0;
      let unchangedInWord = 0;
      let nonFiniteAfter = 0;
      for (let i = 0; i < a1.length; i++) {
        if (!Number.isFinite(a1[i])) nonFiniteAfter++;
        if (i < spliced.regionStart || i >= spliced.regionEnd) {
          if (a1[i] !== a0[i]) movedOutside++;
        } else if (i >= spliced.wordStart && i < spliced.wordEnd && a1[i] === a0[i]) {
          unchangedInWord++;
        }
      }
      assert(nonFiniteAfter === 0, `every sample on disk is finite (${nonFiniteAfter} non-finite)`);
      assert(
        movedOutside === 0,
        `not one sample outside the rewritten region changed by a single bit (${movedOutside} moved)`
      );
      // A handful of coincidental equalities is possible between two unrelated
      // 32-bit float signals, so the bar is a share rather than zero - but the
      // old word cannot survive.
      const wordSamples = spliced.wordEnd - spliced.wordStart;
      assert(
        unchangedInWord / wordSamples < 0.01,
        `the old word is gone: ${wordSamples - unchangedInWord} of ${wordSamples} samples inside it were rewritten`
      );

      // The seam claim, measured rather than listened to: the step across each
      // join must be no worse than the step a HARD CUT at the same point would
      // have left. The cut's step is computed here from the two WAVs - the head
      // one joins the ORIGINAL sample before the word to the SPLICED sample at
      // its start, which is exactly what a cut with no blend would produce.
      const headSeamStep = Math.abs(a1[spliced.wordStart] - a1[spliced.wordStart - 1]);
      const headCutStep = Math.abs(a1[spliced.wordStart] - a0[spliced.wordStart - 1]);
      const tailSeamStep = Math.abs(a1[spliced.wordEnd] - a1[spliced.wordEnd - 1]);
      const tailCutStep = Math.abs(a0[spliced.wordEnd] - a1[spliced.wordEnd - 1]);
      console.log(
        `  seam steps: head ${headSeamStep.toExponential(2)} vs a hard cut ${headCutStep.toExponential(2)}, ` +
          `tail ${tailSeamStep.toExponential(2)} vs ${tailCutStep.toExponential(2)}`
      );
      assert(
        headSeamStep <= headCutStep,
        `the head seam's step is no worse than a hard cut at the word's start (${headSeamStep.toExponential(2)} <= ${headCutStep.toExponential(2)})`
      );
      assert(
        tailSeamStep <= tailCutStep,
        `the tail seam's step is no worse than a hard cut at the word's end (${tailSeamStep.toExponential(2)} <= ${tailCutStep.toExponential(2)})`
      );

      // The alignment survives its own edit: the splice moved no position, so a
      // SECOND word replaces without re-running a 378 MB model in between.
      await page.evaluate(() => window.__test.recordReplacementSeconds(1.2));
      const second = await page.evaluate(
        ([i, o]) => window.__test.replaceAlignedWord(i, o),
        [targetIndex + 1, spliceOpts]
      );
      assert(
        second.ok === true,
        `a second word replaces without re-aligning - the spans still describe the audio (status ${second.status}${second.message ? `: ${second.message}` : ''})`
      );
      assert(second.lengthDelta === 0, `the second splice is length-preserving too (delta ${second.lengthDelta})`);

      // Persist, so teardown does not meet a dirty document.
      await page.evaluate((p) => window.__test.saveActiveAs(p), OUT_ALIGN_AFTER_WAV);
    }

    // ======================================================================
    // L7 — the edits a user makes every minute, driven the way a user makes
    // them. Everything above this line runs whole-document, because until L7
    // no hook could WRITE a selection; these steps are the ones that can see
    // the region-boundary defect class at all.
    // ======================================================================
    await page.evaluate(() => window.__test.setView('waveform'));

    /** Bit-for-bit difference count between two sample windows. */
    const diffCount = (a, b) => {
      let n = 0;
      for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++;
      return n;
    };
    const samplesOf = (channel, start, count) =>
      page.evaluate(
        ([c, s, n]) => window.__test.getChannelSamples(c, s, n),
        [channel, start, count]
      );
    const stateOf = () => page.evaluate(() => window.__test.getStateSummary());
    const historyOf = () => page.evaluate(() => window.__test.getHistoryState());
    /**
     * Runs an effect with a hard in-page deadline, and resolves 'ok',
     * 'TIMED OUT' or 'THREW: …'.
     *
     * The timer catches ONE failure mode: a wedged worker, which would
     * otherwise hang `page.evaluate` forever with no diagnosis at all. It does
     * NOT catch a failing effect, and an earlier version of this comment
     * claimed it did. `runEffectOnSelection` converts every worker rejection
     * into a fire-and-forget `reportEffectFailure` dialog and then returns
     * normally, so a crashed effect resolves 'ok' here and is indistinguishable
     * from a clean refusal by outcome alone. Callers that need to tell the two
     * apart read `window.__test.effectFailureCount()` either side of the run
     * (see L7-9); 'THREW' only ever reports a throw on the hook path itself.
     */
    const applyEffectGuarded = (effectId, params, extra, timeoutMs = 120000) =>
      page.evaluate(
        async ({ id, p, x, ms }) => {
          let timer = null;
          const deadline = new Promise((resolve) => {
            timer = setTimeout(() => resolve('TIMED OUT'), ms);
          });
          const run = window.__test.applyEffect(id, p, x).then(
            () => 'ok',
            (err) => `THREW: ${(err && err.message) || String(err)}`
          );
          const outcome = await Promise.race([run, deadline]);
          if (timer !== null) clearTimeout(timer);
          return outcome;
        },
        { id: effectId, p: params, x: extra, ms: timeoutMs }
      );

    // L7-1) A REGION effect leaves the rest of the file alone -----------------
    // The single highest-value thing this file did not do. `runEffectOnSelection`
    // clones [s,e), runs the worker on that clone and splices it back; every
    // packaged run so far had s=0 and e=length, so the splice was the whole file
    // and neither edge was ever observed. What is asserted here is exactly what
    // the user believes when they drag a selection: outside it, nothing moved —
    // not "moved a little", `=== 0` worst error — and the two samples either side
    // of the closing edge fall on opposite sides of the change.
    console.log('Selection + region effect: Amplify -12 dB over [20000, 50000)...');
    await page.evaluate((p) => window.__test.openPath(p), TONE);
    const REGION_S = 20000;
    const REGION_E = 50000;
    const regionBefore = await stateOf();
    const regionInsideBefore = await samplesOf(0, REGION_S, REGION_E - REGION_S);
    const regionHeadBefore = await samplesOf(0, 0, REGION_S);
    const regionTailBefore = await samplesOf(0, REGION_E, 4096);
    const regionEdgeBefore = await samplesOf(0, REGION_E - 1, 2); // samples e-1 and e
    const regionSel = await page.evaluate(
      ([s, e]) => window.__test.setSelection(s, e),
      [REGION_S, REGION_E]
    );
    const regionView = await page.evaluate(() => window.__test.getEditorViewState());
    assert(
      regionSel !== null &&
        regionView.selectionStart === REGION_S &&
        regionView.selectionEnd === REGION_E,
      `the store holds the selection the gesture would have committed (${regionView.selectionStart}..${regionView.selectionEnd})`
    );
    const regionOutcome = await applyEffectGuarded('amplify', { gainDb: -12 });
    assert(regionOutcome === 'ok', `the region effect ran (${regionOutcome})`);
    const regionInsideAfter = await samplesOf(0, REGION_S, REGION_E - REGION_S);
    const regionHeadAfter = await samplesOf(0, 0, REGION_S);
    const regionTailAfter = await samplesOf(0, REGION_E, 4096);
    const regionEdgeAfter = await samplesOf(0, REGION_E - 1, 2);
    const regionAfter = await stateOf();

    const REGION_GAIN = Math.pow(10, -12 / 20);
    let regionWorstInside = 0;
    for (let i = 0; i < regionInsideBefore.length; i++) {
      const err = Math.abs(regionInsideAfter[i] - regionInsideBefore[i] * REGION_GAIN);
      if (err > regionWorstInside) regionWorstInside = err;
    }
    let regionWorstOutside = 0;
    for (let i = 0; i < regionHeadBefore.length; i++) {
      const err = Math.abs(regionHeadAfter[i] - regionHeadBefore[i]);
      if (err > regionWorstOutside) regionWorstOutside = err;
    }
    for (let i = 0; i < regionTailBefore.length; i++) {
      const err = Math.abs(regionTailAfter[i] - regionTailBefore[i]);
      if (err > regionWorstOutside) regionWorstOutside = err;
    }
    console.log(
      `  worst error inside ${regionWorstInside.toExponential(3)}, outside ${regionWorstOutside}, ` +
        `edge ${regionEdgeBefore[0].toFixed(6)}->${regionEdgeAfter[0].toFixed(6)} | ` +
        `${regionEdgeBefore[1].toFixed(6)}->${regionEdgeAfter[1].toFixed(6)}`
    );
    assert(
      regionAfter.length === regionBefore.length,
      `an equal-length effect over a region leaves the document length alone (${regionAfter.length})`
    );
    assert(
      regionWorstOutside === 0,
      `not one sample OUTSIDE the selection moved by a single bit (worst absolute error ${regionWorstOutside})`
    );
    assert(
      regionWorstInside < 1e-6,
      `every sample inside is the source scaled by 10^(-12/20) (worst error ${regionWorstInside.toExponential(3)})`
    );
    assert(
      regionEdgeAfter[0] !== regionEdgeBefore[0],
      `the LAST selected sample (e-1 = ${REGION_E - 1}) changed — the region is half-open at the right, not one short`
    );
    assert(
      regionEdgeAfter[1] === regionEdgeBefore[1],
      `and the FIRST unselected one (e = ${REGION_E}) did not — not one long either`
    );
    const regionViewAfter = await page.evaluate(() => window.__test.getEditorViewState());
    assert(
      regionViewAfter.selectionStart === REGION_S && regionViewAfter.selectionEnd === REGION_E,
      `the selection still spans the region that was processed, so Apply can be repeated ` +
        `(${regionViewAfter.selectionStart}..${regionViewAfter.selectionEnd})`
    );

    // L7-2) Undo, redo, undo — the two keys pressed most often ---------------
    // The cover chain's undo block is the strongest in this file; this is that
    // block's rigor on Ctrl+Z / Ctrl+Y, which had NO packaged coverage of redo
    // at all (no hook existed) and only ever checked undo through a length or a
    // peak. The window is compared with `===`, and the anti-vacuous guard is the
    // load-bearing part: without "pre differs from post" the whole round trip
    // passes on an effect that did nothing.
    console.log('Undo -> Redo -> Undo, byte-for-byte...');
    const undoWindowPre = regionInsideBefore.slice(0, 4096);
    const undoWindowPost = regionInsideAfter.slice(0, 4096);
    assert(
      diffCount(undoWindowPre, undoWindowPost) > undoWindowPre.length / 2,
      `the effect actually changed the window under test — without this guard every ` +
        `assertion below passes on a no-op (${diffCount(undoWindowPre, undoWindowPost)} of ${undoWindowPre.length} differ)`
    );
    const historyAfterEffect = await historyOf();
    assert(
      historyAfterEffect.done.slice(-1)[0] === 'Effect: Amplify' &&
        historyAfterEffect.undone.length === 0,
      `History shows the entry the user would click (${JSON.stringify(historyAfterEffect)})`
    );
    const undone = await page.evaluate(() => window.__test.undoActive());
    const undoneWindow = await samplesOf(0, REGION_S, 4096);
    assert(
      undone.length === regionBefore.length && diffCount(undoneWindow, undoWindowPre) === 0,
      `Ctrl+Z restores the pre-effect samples EXACTLY (${diffCount(undoneWindow, undoWindowPre)} of ${undoWindowPre.length} still differ)`
    );
    const historyAfterUndo = await historyOf();
    assert(
      historyAfterUndo.done.length === historyAfterEffect.done.length - 1 &&
        historyAfterUndo.undone.slice(-1)[0] === 'Effect: Amplify',
      `and the entry moved to the redo side of History (${JSON.stringify(historyAfterUndo)})`
    );
    const redone = await page.evaluate(() => window.__test.redoActive());
    const redoneWindow = await samplesOf(0, REGION_S, 4096);
    assert(
      redone.length === regionAfter.length && diffCount(redoneWindow, undoWindowPost) === 0,
      `Ctrl+Y puts the processed samples back EXACTLY (${diffCount(redoneWindow, undoWindowPost)} of ${undoWindowPost.length} differ)`
    );
    const undoneAgain = await page.evaluate(() => window.__test.undoActive());
    const undoneAgainWindow = await samplesOf(0, REGION_S, 4096);
    assert(
      undoneAgain.length === regionBefore.length && diffCount(undoneAgainWindow, undoWindowPre) === 0,
      `and a second Ctrl+Z after the redo lands on the original again, not somewhere new ` +
        `(${diffCount(undoneAgainWindow, undoWindowPre)} differ)`
    );
    await page.evaluate(() => window.__test.closeActive());

    // L7-3) The four edit operations, each over a real region -----------------
    console.log('Cut / Delete / Trim / Silence over [20000, 50000)...');
    const EDIT_LEN = REGION_E - REGION_S;

    // Cut: the join is the assertion. After removing [s,e) the sample sitting at
    // index s must be the one that used to sit at index e — a seam that dropped
    // or duplicated a sample still has the right LENGTH.
    await page.evaluate((p) => window.__test.openPath(p), TONE);
    const cutBefore = await stateOf();
    const cutAtStart = await samplesOf(0, REGION_S, 32);
    const cutAtEnd = await samplesOf(0, REGION_E, 32);
    await page.evaluate(([s, e]) => window.__test.setSelection(s, e), [REGION_S, REGION_E]);
    await page.evaluate(() => window.__test.editOp('cut'));
    const cutAfter = await stateOf();
    const cutJoin = await samplesOf(0, REGION_S, 32);
    const cutClip = await page.evaluate(() => window.__test.getClipboardInfo());
    console.log(`  cut: ${cutBefore.length} -> ${cutAfter.length}, clipboard ${JSON.stringify(cutClip)}`);
    assert(
      cutAfter.length === cutBefore.length - EDIT_LEN,
      `Cut removed exactly the selection (expected ${cutBefore.length - EDIT_LEN}, actual ${cutAfter.length})`
    );
    assert(
      diffCount(cutJoin, cutAtEnd) === 0,
      `the join is seamless: what now sits at ${REGION_S} is what used to sit at ${REGION_E} ` +
        `(${diffCount(cutJoin, cutAtEnd)} of 32 differ)`
    );
    assert(
      cutClip !== null &&
        cutClip.length === EDIT_LEN &&
        cutClip.sampleRate === cutBefore.sampleRate &&
        cutClip.channels === cutBefore.channels,
      `and the removed audio is on the clipboard, whole (${JSON.stringify(cutClip)})`
    );
    const cutUndone = await page.evaluate(() => window.__test.undoActive());
    const cutRestored = await samplesOf(0, REGION_S, 32);
    assert(
      cutUndone.length === cutBefore.length && diffCount(cutRestored, cutAtStart) === 0,
      `one undo restores the length AND the bytes (${cutUndone.length} samples, ${diffCount(cutRestored, cutAtStart)} of 32 differ)`
    );
    await page.evaluate(() => window.__test.closeActive());

    // Delete: same removal, and the clipboard is NOT touched. A distinctive
    // 1000-sample copy is put on the clipboard first, so "unchanged" is a real
    // observation rather than the absence of one.
    await page.evaluate((p) => window.__test.openPath(p), TONE);
    const delBefore = await stateOf();
    const delAtEnd = await samplesOf(0, REGION_E, 32);
    await page.evaluate(() => window.__test.setSelection(0, 1000));
    await page.evaluate(() => window.__test.editOp('copy'));
    await page.evaluate(([s, e]) => window.__test.setSelection(s, e), [REGION_S, REGION_E]);
    await page.evaluate(() => window.__test.editOp('delete'));
    const delAfter = await stateOf();
    const delJoin = await samplesOf(0, REGION_S, 32);
    const delClip = await page.evaluate(() => window.__test.getClipboardInfo());
    assert(
      delAfter.length === delBefore.length - EDIT_LEN && diffCount(delJoin, delAtEnd) === 0,
      `Delete removes the selection and joins it seamlessly (${delAfter.length} samples, ${diffCount(delJoin, delAtEnd)} of 32 differ at the join)`
    );
    assert(
      delClip !== null && delClip.length === 1000,
      `and leaves the clipboard exactly as it was — Delete is not a Cut (clipboard holds ${delClip && delClip.length} samples)`
    );
    await page.evaluate(() => window.__test.closeActive());

    // Trim to selection: everything but the selection goes, and what survives
    // starts with the sample that used to be at s.
    await page.evaluate((p) => window.__test.openPath(p), TONE);
    const trimAtStart = await samplesOf(0, REGION_S, 32);
    const trimBefore = await stateOf();
    await page.evaluate(([s, e]) => window.__test.setSelection(s, e), [REGION_S, REGION_E]);
    await page.evaluate(() => window.__test.editOp('trim'));
    const trimAfter = await stateOf();
    const trimHead = await samplesOf(0, 0, 32);
    assert(
      trimAfter.length === EDIT_LEN,
      `Trim keeps exactly the selection (expected ${EDIT_LEN}, actual ${trimAfter.length})`
    );
    assert(
      diffCount(trimHead, trimAtStart) === 0,
      `and what it kept starts at the selection's own first sample (${diffCount(trimHead, trimAtStart)} of 32 differ)`
    );
    const trimUndone = await page.evaluate(() => window.__test.undoActive());
    const trimRestored = await samplesOf(0, REGION_S, 32);
    assert(
      trimUndone.length === trimBefore.length && diffCount(trimRestored, trimAtStart) === 0,
      `one undo brings the whole file back, bytes included (${trimUndone.length} samples, ${diffCount(trimRestored, trimAtStart)} differ)`
    );
    await page.evaluate(() => window.__test.closeActive());

    // Silence: length unchanged, the region is EXACTLY zero, and — the part a
    // length check cannot see — the samples on both sides are untouched.
    await page.evaluate((p) => window.__test.openPath(p), TONE);
    const silBefore = await stateOf();
    const silHeadBefore = await samplesOf(0, REGION_S - 32, 32);
    const silTailBefore = await samplesOf(0, REGION_E, 32);
    await page.evaluate(([s, e]) => window.__test.setSelection(s, e), [REGION_S, REGION_E]);
    await page.evaluate(() => window.__test.editOp('silence'));
    const silAfter = await stateOf();
    const silInside = await samplesOf(0, REGION_S, 4096);
    const silHeadAfter = await samplesOf(0, REGION_S - 32, 32);
    const silTailAfter = await samplesOf(0, REGION_E, 32);
    const silNonZero = silInside.filter((v) => v !== 0).length;
    assert(
      silAfter.length === silBefore.length && silNonZero === 0,
      `Silence zero-fills the region in place (${silAfter.length} samples, ${silNonZero} non-zero inside)`
    );
    assert(
      diffCount(silHeadAfter, silHeadBefore) === 0 && diffCount(silTailAfter, silTailBefore) === 0,
      `and stops at both edges (${diffCount(silHeadAfter, silHeadBefore)} before, ${diffCount(silTailAfter, silTailBefore)} after)`
    );
    const silUndone = await page.evaluate(() => window.__test.undoActive());
    const silRestored = await samplesOf(0, REGION_S, 4096);
    assert(
      silUndone.length === silBefore.length && silRestored.filter((v) => v !== 0).length > 4000,
      `and one undo brings the audio back into the hole (${silRestored.filter((v) => v !== 0).length} of 4096 non-zero again)`
    );
    await page.evaluate(() => window.__test.closeActive());

    // L7-4) An edit moves the markers -----------------------------------------
    // Markers had only ever round-tripped through FILE FORMATS in this file,
    // never through an EDIT. Deleting [s,e): a marker before it stays put, one
    // inside it is dropped (editOps' 'delete' rule), and one after it lands at
    // exactly P - (e - s) — an exact integer, so no tolerance is warranted.
    console.log('An edit moves the markers: delete a region under three of them...');
    await page.evaluate((p) => window.__test.openPath(p), TONE);
    const MARK_BEFORE = 10000;
    const MARK_INSIDE = 30000;
    const MARK_AFTER = 60000;
    for (const [at, name] of [
      [MARK_BEFORE, 'Intro'],
      [MARK_INSIDE, 'Doomed'],
      [MARK_AFTER, 'Chorus'],
    ]) {
      const id = await page.evaluate(
        ([p, n]) => window.__test.addMarkerToActive(p, n),
        [at, name]
      );
      assert(id !== null, `marker '${name}' placed at ${at}`);
    }
    await page.evaluate(([s, e]) => window.__test.setSelection(s, e), [REGION_S, REGION_E]);
    await page.evaluate(() => window.__test.editOp('delete'));
    const markersAfterEdit = await page.evaluate(() => window.__test.getActiveMarkers());
    console.log(`  markers after deleting [${REGION_S}, ${REGION_E}): ${JSON.stringify(markersAfterEdit)}`);
    const markIntro = markersAfterEdit.filter((m) => m.name === 'Intro')[0];
    const markChorus = markersAfterEdit.filter((m) => m.name === 'Chorus')[0];
    assert(
      markIntro !== undefined && markIntro.positionSample === MARK_BEFORE,
      `the marker BEFORE the cut did not move (expected ${MARK_BEFORE}, actual ${markIntro && markIntro.positionSample})`
    );
    assert(
      markChorus !== undefined && markChorus.positionSample === MARK_AFTER - EDIT_LEN,
      `the marker AFTER it moved left by exactly the removed length ` +
        `(expected ${MARK_AFTER - EDIT_LEN}, actual ${markChorus && markChorus.positionSample})`
    );
    assert(
      markersAfterEdit.filter((m) => m.name === 'Doomed').length === 0,
      `and the one INSIDE the deleted region went with the audio it marked (${markersAfterEdit.length} markers left)`
    );
    await page.evaluate(() => window.__test.undoActive());
    const markersAfterUndo = await page.evaluate(() => window.__test.getActiveMarkers());
    assert(
      markersAfterUndo.length === 3 &&
        markersAfterUndo[0].positionSample === MARK_BEFORE &&
        markersAfterUndo[1].positionSample === MARK_INSIDE &&
        markersAfterUndo[2].positionSample === MARK_AFTER,
      `one undo brings all three back to their own samples — the marker remap rides ` +
        `inside the SAME history entry as the audio (${JSON.stringify(markersAfterUndo)})`
    );
    await page.evaluate(() => window.__test.closeActive());

    // L7-5) Every effect in the menu applies ----------------------------------
    // Twelve of the twenty-five had never executed in the packaged app at all.
    // The roster comes from the registry's OWN visible list (a hardcoded one is
    // how a stale count broke a release here), and each id is run at settings
    // that give it something to do on sweep.wav — its declared defaults, with an
    // override ONLY where the default is the identity (0 dB of gain, a ceiling
    // above the peak, ...). There is no no-op allowlist: sweep.wav exists
    // precisely so every visible effect has material it must change.
    console.log('Every effect in the menu, applied for real in the packaged app...');
    const sweepProbeAt = 150000; // inside the fixture's second tone segment
    const sweepNoiseProbeAt = 100000; // inside its noise segment
    const SWEEP_PROBE_LEN = 4096;
    const sweepOpen = await page.evaluate(async (p) => {
      await window.__test.openPath(p);
      return window.__test.getStateSummary();
    }, SWEEP);
    assert(
      sweepOpen.length === SWEEP_LENGTH && sweepOpen.channels === 2 && sweepOpen.sampleRate === 44100,
      `sweep.wav is the fixture this step's segment offsets describe (${JSON.stringify(sweepOpen)})`
    );
    const sweepSilence = await page.evaluate(
      ([s, n]) => window.__test.getChannelSamples(0, s, n),
      [SWEEP_SILENCE_START + 1000, 1024]
    );
    assert(
      sweepSilence.filter((v) => v !== 0).length === 0,
      `its silent segment really is digital zero, so Remove Silence has a gap to find ` +
        `(${sweepSilence.filter((v) => v !== 0).length} non-zero samples)`
    );
    await page.evaluate(() => window.__test.closeActive());

    // The only settings that differ from the effect's own declared defaults, and
    // why each one has to.
    const SWEEP_OVERRIDES = {
      amplify: { gainDb: -3 }, // default 0 dB is unity
      limiter: { ceilingDb: -12 }, // the fixture peaks at -4.7 dBFS, under the -0.3 default
      'noise-gate': { thresholdDb: -20 }, // the -50 default never closes on this material
      'graphic-eq': { g1k: 6 }, // every band defaults to 0 dB (skipped as identity)
      'parametric-eq': { band2Gain: 6 }, // band 2 is on by default at 400 Hz, at 0 dB
      'channel-mixer': { lrGain: 30 }, // the default matrix is the identity
      pan: { pan: 40 }, // 0 is centre, i.e. unchanged
      'time-stretch': { stretchPercent: 120 }, // 100% is unity
      'pitch-shift': { semitones: 2 }, // 0 semitones is a documented byte-identical pass-through
    };
    const sweepEffects = await page.evaluate(() => window.__test.listEffects());
    console.log(`  the Effects menu offers ${sweepEffects.length} effects; running every one`);
    assert(
      sweepEffects.length >= 25,
      `the registry's own visible roster is what is being swept (${sweepEffects.length} effects)`
    );
    for (const effect of sweepEffects) {
      await page.evaluate((p) => window.__test.openPath(p), SWEEP);
      await page.evaluate(() => window.__test.clearSelection());
      const lengthBefore = (await stateOf()).length;
      const toneBefore = await samplesOf(0, sweepProbeAt, SWEEP_PROBE_LEN);
      const noiseBefore = await samplesOf(0, sweepNoiseProbeAt, SWEEP_PROBE_LEN);

      // Noise Reduction is the one effect the app itself feeds a side channel:
      // EffectDialog hands it the captured print. Capture it the way a user
      // would — select the noise, Capture Noise Print, drop the selection —
      // rather than inventing a spectrum here.
      let extra;
      if (effect.id === 'noise-reduction') {
        await page.evaluate(
          ([s, e]) => window.__test.setSelection(s, e),
          [SWEEP_NOISE_START, SWEEP_NOISE_END]
        );
        await page.evaluate(() => window.__test.captureNoisePrint());
        const spectra = await page.evaluate(() => window.__test.getNoiseProfileSpectra());
        await page.evaluate(() => window.__test.clearSelection());
        assert(
          spectra !== null && spectra.length === 2,
          `a noise print was captured from the fixture's noise segment (${spectra && spectra.length} channels)`
        );
        extra = { spectra };
      }

      const params = { ...effect.params, ...(SWEEP_OVERRIDES[effect.id] || {}) };
      const historyBefore = await historyOf();
      const outcome = await applyEffectGuarded(effect.id, params, extra);
      const historyAfter = await historyOf();
      const lengthAfter = (await stateOf()).length;
      const toneAfter = await samplesOf(0, sweepProbeAt, SWEEP_PROBE_LEN);
      const noiseAfter = await samplesOf(0, sweepNoiseProbeAt, SWEEP_PROBE_LEN);
      const label = historyAfter.done.slice(-1)[0] || null;
      const changed = diffCount(toneBefore, toneAfter) + diffCount(noiseBefore, noiseAfter);
      const nonFinite =
        toneAfter.filter((v) => !Number.isFinite(v)).length +
        noiseAfter.filter((v) => !Number.isFinite(v)).length;
      console.log(
        `  ${effect.id}: ${outcome}, ${lengthBefore} -> ${lengthAfter} samples, ` +
          `${changed} of ${2 * SWEEP_PROBE_LEN} probe samples changed, history "${label}"`
      );
      assert(
        outcome === 'ok' &&
          historyAfter.done.length === historyBefore.done.length + 1 &&
          String(label).indexOf(`Effect: ${effect.name}`) === 0,
        `${effect.id} ran in the packaged worker and committed ONE undoable edit ` +
          `(${outcome}, +${historyAfter.done.length - historyBefore.done.length} entries, label ${JSON.stringify(label)})`
      );
      assert(
        changed > 0,
        `${effect.id} actually changed the audio — no allowlist, the fixture gives it something to do ` +
          `(${changed} of ${2 * SWEEP_PROBE_LEN} probe samples)`
      );
      assert(
        nonFinite === 0,
        `${effect.id} produced no NaN or Infinity (${nonFinite} non-finite samples)`
      );
      const restored = await page.evaluate(() => window.__test.undoActive());
      const toneRestored = await samplesOf(0, sweepProbeAt, SWEEP_PROBE_LEN);
      const noiseRestored = await samplesOf(0, sweepNoiseProbeAt, SWEEP_PROBE_LEN);
      assert(
        restored.length === lengthBefore &&
          diffCount(toneRestored, toneBefore) === 0 &&
          diffCount(noiseRestored, noiseBefore) === 0,
        `and one undo restores ${effect.id} byte-for-byte in both probed regions ` +
          `(${restored.length} samples, ${diffCount(toneRestored, toneBefore) + diffCount(noiseRestored, noiseBefore)} differ)`
      );
      await page.evaluate(() => window.__test.closeActive());
    }

    // Two free, genuinely falsifiable identities: an effect that is its own
    // inverse must return the file to itself EXACTLY, and a floating-point
    // pipeline that quietly resampled or requantised would not.
    for (const id of ['invert', 'reverse']) {
      await page.evaluate((p) => window.__test.openPath(p), SWEEP);
      await page.evaluate(() => window.__test.clearSelection());
      const identityBefore = await samplesOf(0, sweepProbeAt, SWEEP_PROBE_LEN);
      const once = await applyEffectGuarded(id, {});
      const identityOnce = await samplesOf(0, sweepProbeAt, SWEEP_PROBE_LEN);
      const twice = await applyEffectGuarded(id, {});
      const identityTwice = await samplesOf(0, sweepProbeAt, SWEEP_PROBE_LEN);
      assert(
        once === 'ok' && twice === 'ok' && diffCount(identityBefore, identityOnce) > 0,
        `${id} applied twice, and the first pass really moved the samples ` +
          `(${diffCount(identityBefore, identityOnce)} of ${SWEEP_PROBE_LEN} differ after one)`
      );
      assert(
        diffCount(identityBefore, identityTwice) === 0,
        `${id} twice is the exact identity — bit for bit, not nearly ` +
          `(${diffCount(identityBefore, identityTwice)} of ${SWEEP_PROBE_LEN} differ)`
      );
      await page.evaluate(() => window.__test.closeActive());
    }

    // L7-6) A file that will not decode ---------------------------------------
    // The failure has to be survivable, not just reported: no half-added
    // document, and the next open still works. `openFilesViaDialog` catches per
    // file and carries on, which is exactly what is reproduced here.
    console.log('Files that will not decode: a .txt and a truncated .mp3...');
    fs.writeFileSync(OUT_NOT_AUDIO, 'This is a sentence, not a waveform.\n');
    fs.writeFileSync(OUT_TRUNCATED_MP3, fs.readFileSync(OUT_MP3).subarray(0, 400));
    const docsBeforeBadOpen = (await stateOf()).docCount;
    for (const [bad, what] of [
      [OUT_NOT_AUDIO, 'a text file'],
      [OUT_TRUNCATED_MP3, 'a truncated MP3'],
    ]) {
      const failure = await page.evaluate(async (p) => {
        try {
          await window.__test.openPath(p);
          return null;
        } catch (err) {
          return (err && err.message) || String(err);
        }
      }, bad);
      const docsNow = (await stateOf()).docCount;
      console.log(`  ${what}: ${JSON.stringify(failure)}, docCount ${docsNow}`);
      assert(
        failure !== null,
        `opening ${what} reports a failure instead of pretending to succeed (${JSON.stringify(failure)})`
      );
      assert(
        docsNow === docsBeforeBadOpen,
        `and adds no document, not even a half-built one (${docsNow} open, was ${docsBeforeBadOpen})`
      );
    }
    await page.evaluate((p) => window.__test.openPath(p), TONE);
    const afterBadOpens = await stateOf();
    assert(
      afterBadOpens.docCount === docsBeforeBadOpen + 1 && afterBadOpens.length === 88200,
      `and the app is still usable afterwards — the next open works normally (${JSON.stringify(afterBadOpens)})`
    );
    await page.evaluate(() => window.__test.closeActive());

    // L7-7) Stereo -> mono -> stereo -------------------------------------------
    // Edit > Convert Channels had ZERO packaged coverage. The downmix law is
    // documented as (L+R)/2 (AudioDocument.mixDown), so it is asserted as
    // arithmetic rather than as "the level looks about right".
    console.log('Convert Channels: stereo -> mono -> stereo...');
    await page.evaluate((p) => window.__test.openPath(p), SWEEP);
    const convBefore = await stateOf();
    const convL = await samplesOf(0, 1000, 1024);
    const convR = await samplesOf(1, 1000, 1024);
    await page.evaluate(() => window.__test.convertChannels(1));
    const convMonoState = await stateOf();
    const convMono = await samplesOf(0, 1000, 1024);
    let convWorst = 0;
    for (let i = 0; i < convMono.length; i++) {
      const err = Math.abs(convMono[i] - (convL[i] + convR[i]) / 2);
      if (err > convWorst) convWorst = err;
    }
    assert(
      convMonoState.channels === 1 && convMonoState.length === convBefore.length,
      `the document reads as mono, at its original length (${convMonoState.channels} ch, ${convMonoState.length} samples)`
    );
    assert(
      diffCount(convL, convR) > convL.length / 2,
      `the source's two channels really were different, so the downmix below is not ` +
        `a comparison of a signal with itself (${diffCount(convL, convR)} of ${convL.length} differ)`
    );
    assert(
      convWorst < 1e-6,
      `and the mono channel is exactly the documented (L+R)/2 (worst error ${convWorst.toExponential(3)})`
    );
    await page.evaluate(() => window.__test.convertChannels(2));
    const convStereoState = await stateOf();
    const convBackL = await samplesOf(0, 1000, 1024);
    const convBackR = await samplesOf(1, 1000, 1024);
    assert(
      convStereoState.channels === 2 && diffCount(convBackL, convBackR) === 0,
      `re-expanding gives two channels carrying the same mono signal — the stereo image ` +
        `is gone for good, as documented (${convStereoState.channels} ch, ${diffCount(convBackL, convBackR)} samples differ between them)`
    );
    await page.evaluate(() => window.__test.undoActive());
    await page.evaluate(() => window.__test.undoActive());
    const convRestored = await stateOf();
    const convRestoredL = await samplesOf(0, 1000, 1024);
    const convRestoredR = await samplesOf(1, 1000, 1024);
    assert(
      convRestored.channels === 2 &&
        diffCount(convRestoredL, convL) === 0 &&
        diffCount(convRestoredR, convR) === 0,
      `and two undos bring the ORIGINAL stereo back, both channels bit-exact ` +
        `(${diffCount(convRestoredL, convL)} + ${diffCount(convRestoredR, convR)} differ)`
    );
    await page.evaluate(() => window.__test.closeActive());

    // L7-8) Boundary selections -------------------------------------------------
    console.log('Boundary selections: one sample, the last sample, and up to the end...');
    await page.evaluate((p) => window.__test.openPath(p), TONE);
    const edgeState = await stateOf();
    const edgeLength = edgeState.length;
    const oneBefore = await samplesOf(0, 0, 16);
    await page.evaluate(() => window.__test.setSelection(4, 5));
    const oneOutcome = await applyEffectGuarded('amplify', { gainDb: -20 });
    const oneAfter = await samplesOf(0, 0, 16);
    const oneState = await stateOf();
    assert(
      oneOutcome === 'ok' && oneState.length === edgeLength,
      `a one-sample selection is a legal region (${oneOutcome}, ${oneState.length} samples)`
    );
    assert(
      diffCount(oneBefore, oneAfter) === 1 && oneAfter[4] !== oneBefore[4],
      `and EXACTLY one sample changed, the selected one ` +
        `(${diffCount(oneBefore, oneAfter)} of 16 changed; index 4 ${oneBefore[4]} -> ${oneAfter[4]})`
    );
    await page.evaluate(() => window.__test.undoActive());

    const lastBefore = await samplesOf(0, edgeLength - 2, 2);
    await page.evaluate((l) => window.__test.setSelection(l - 1, l), edgeLength);
    const lastOutcome = await applyEffectGuarded('amplify', { gainDb: -20 });
    const lastAfter = await samplesOf(0, edgeLength - 2, 2);
    const lastState = await stateOf();
    assert(
      lastOutcome === 'ok' && lastState.length === edgeLength,
      `selecting the very last sample is legal and changes no length (${lastOutcome}, ${lastState.length} samples)`
    );
    assert(
      lastAfter[1] !== lastBefore[1] &&
        Math.abs(lastAfter[1] - lastBefore[1] * 0.1) < 1e-6 &&
        lastAfter[0] === lastBefore[0],
      `the file's final sample was processed and its neighbour was not ` +
        `(${lastBefore[1]} -> ${lastAfter[1]}, neighbour ${lastBefore[0]} -> ${lastAfter[0]})`
    );
    await page.evaluate(() => window.__test.undoActive());

    // A 1024-sample window whose last 1000 samples ARE the selection, so index
    // 23 of it is the sample immediately before the selection's start.
    const clampedWindowStart = edgeLength - 1024;
    const clampedLastOutside = edgeLength - 1000 - 1 - clampedWindowStart; // = 23
    const clampedBefore = await samplesOf(0, clampedWindowStart, 1024);
    await page.evaluate((l) => window.__test.setSelection(l - 1000, l), edgeLength);
    const clampedOutcome = await applyEffectGuarded('reverse', {});
    const clampedState = await stateOf();
    const clampedAfter = await samplesOf(0, clampedWindowStart, 1024);
    assert(
      clampedOutcome === 'ok' && clampedState.length === edgeLength,
      `a selection ending exactly AT the document length neither throws nor extends it ` +
        `(${clampedOutcome}, ${clampedState.length} samples, was ${edgeLength})`
    );
    assert(
      diffCount(clampedBefore, clampedAfter) > 0 &&
        clampedAfter[clampedLastOutside] === clampedBefore[clampedLastOutside],
      `it reversed the last 1000 samples and left the sample before them alone ` +
        `(${diffCount(clampedBefore, clampedAfter)} of 1024 changed)`
    );
    await page.evaluate(() => window.__test.undoActive());
    await page.evaluate(() => window.__test.closeActive());

    // L7-9) File > New, then an effect ------------------------------------------
    // A brand-new document is silent, and a zero-second one has no samples at
    // all. Both are one Ctrl+N away, and the effects most likely to divide by
    // something that is zero there are the ones run.
    //
    // What this step CAN and CANNOT see, stated because the earlier version of
    // it could not fail at all. `applyEffectGuarded` resolving 'ok' means only
    // that `applyEffect` settled: `runEffectOnSelection` catches every worker
    // rejection, hands it to `reportEffectFailure` — a fire-and-forget error
    // dialog — and returns normally, so a CRASHED effect resolves 'ok' with the
    // document untouched, which is exactly what a clean refusal looks like. The
    // timer race catches a WEDGED worker and nothing else. Two assertions make
    // the difference observable: the failure-dialog counter must not move, and
    // the length must be the one the effect's own contract predicts. The old
    // `newAfter.length >= 0` was true of every possible result — a length is
    // non-negative by construction — so an effect that truncated the 44-sample
    // document to nothing stayed green.
    console.log('File > New (0 s and 1 ms), then the effects most likely to divide by zero...');
    // `timeStretchLinked`'s contract is `outLen = round(N*ratio)` exactly
    // (wsola.ts), and 120 % is the ratio asked for below; every other effect
    // here is length-preserving. Derived from the before-length rather than
    // hardcoded, so the 0-sample and 44-sample rows share one rule.
    const expectedNewLength = (id, before) =>
      id === 'time-stretch' ? Math.round(before * 1.2) : before;
    for (const [seconds, label] of [
      [0, 'a zero-length'],
      [0.001, 'a 44-sample'],
    ]) {
      for (const [id, params] of [
        ['normalize', { targetDb: -0.3, mode: 'peak' }],
        ['fade', { direction: 'in', curve: 'linear', lengthPercent: 100 }],
        ['time-stretch', { stretchPercent: 120 }],
        ['pitch-correct', { key: 'C', scale: 'chromatic', strength: 100, retuneMs: 50 }],
      ]) {
        await page.evaluate(
          ([rate, channels, secs]) => window.__test.newDocument(rate, channels, secs),
          [44100, 2, seconds]
        );
        const newBefore = await stateOf();
        // The PREMISE of every assertion below, asserted rather than assumed.
        // `expectedNewLength` derives its expectation from this observation, so
        // if `newDocument` ever stopped honouring `durationSeconds` both arms
        // would collapse to a zero-length buffer, the expectation would follow
        // them down, and all sixteen assertions would still pass while the
        // tiny-buffer case they exist for went unexercised. The rule is
        // fileService's own: `round(sampleRate * durationSeconds)` (:510).
        const expectedStartLength = Math.round(44100 * seconds);
        assert(
          newBefore.length === expectedStartLength,
          `File > New really produced ${label} document to run ${id} on ` +
            `(expected ${expectedStartLength} samples for ${seconds} s, actual ${newBefore.length})`
        );
        const failuresBefore = await page.evaluate(() => window.__test.effectFailureCount());
        const newOutcome = await applyEffectGuarded(id, params, undefined, 30000);
        const newAfter = await stateOf();
        const failuresAfter = await page.evaluate(() => window.__test.effectFailureCount());
        const newProbe = await samplesOf(0, 0, Math.max(1, Math.min(64, newAfter.length)));
        const newNonFinite = newProbe.filter((v) => !Number.isFinite(v)).length;
        const expectedLength = expectedNewLength(id, newBefore.length);
        assert(
          newOutcome === 'ok' && failuresAfter === failuresBefore,
          `${id} on ${label} document neither threw nor raised an "Effect failed" dialog ` +
            `(${newOutcome}, ${failuresAfter - failuresBefore} new failure dialogs)`
        );
        assert(
          newAfter.length === expectedLength && newNonFinite === 0,
          `and it came back at exactly the length its contract predicts, with no NaN ` +
            `(${newBefore.length} -> ${newAfter.length} samples, expected ${expectedLength}; ` +
            `${newNonFinite} non-finite of ${newProbe.length} probed)`
        );
        await page.evaluate(() => window.__test.closeActive());
      }
    }

    // L7-10) Record -> Vocal Chain -> export MP3 -> reopen ------------------------
    // Every step here is covered on its own; the SEQUENCE never was — the
    // recorded document was only ever saved, never processed, and nothing had
    // ever carried a processed take out through an encoder and back in.
    console.log('Record -> Vocal Chain -> export MP3 -> reopen...');
    const take = await page.evaluate(() => window.__test.recordSeconds(3));
    console.log(`  recorded ${take.length} samples at ${take.sampleRate} Hz, RMS ${take.rms.toFixed(4)}`);
    assert(take.rms > 0 && take.length > 0, `the fake microphone produced a non-silent take (RMS ${take.rms.toFixed(4)})`);
    const takeState = await stateOf();
    const takeChain = await page.evaluate(() => window.__test.runVocalChain());
    console.log(
      `  vocal chain: applied=${takeChain.applied}, ${takeChain.stages.filter((s) => s.status === 'applied').length} stages applied, ` +
        `RMS ${takeChain.before.rmsDb.toFixed(2)} -> ${takeChain.after.rmsDb.toFixed(2)} dBFS`
    );
    assert(
      takeChain.ok === true && takeChain.applied === true && takeChain.undoDepth === 1,
      `the chain ran on the RECORDING (not on a file off disk) and left one undo entry ` +
        `(ok=${takeChain.ok}, applied=${takeChain.applied}, depth=${takeChain.undoDepth})`
    );
    assert(
      takeChain.stages.filter((s) => s.status === 'applied').length >= 3,
      `and at least three stages actually engaged on it (${takeChain.stages.map((s) => `${s.id}:${s.status}`).join(' ')})`
    );
    const processed = await stateOf();
    const processedRms = await page.evaluate(() => window.__test.getRms());
    const takeMp3Ok = await page.evaluate(
      (out) => window.__test.exportActive({ format: 'mp3', wavBitDepth: 16, mp3Kbps: 192 }, out),
      OUT_TAKE_MP3
    );
    assert(takeMp3Ok === true && fs.existsSync(OUT_TAKE_MP3), 'the processed take exported to MP3');
    await page.evaluate(() => window.__test.closeActive());
    await page.evaluate((p) => window.__test.openPath(p), OUT_TAKE_MP3);
    const reopened = await stateOf();
    const reopenedRms = await page.evaluate(() => window.__test.getRms());
    const toDb = (x) => (x > 0 ? 20 * Math.log10(x) : -Infinity);
    const rmsDelta = toDb(reopenedRms) - toDb(processedRms);
    const lengthDelta = reopened.length - processed.length;
    console.log(
      `  reopened: ${reopened.length} samples (source ${processed.length}, +${lengthDelta}), ` +
        `RMS ${toDb(reopenedRms).toFixed(2)} vs ${toDb(processedRms).toFixed(2)} dBFS (${rmsDelta.toFixed(3)} dB)`
    );
    assert(
      takeState.length === processed.length && processed.length === take.length,
      `the chain is length-preserving on a recording (${take.length} -> ${processed.length})`
    );
    // MP3 is frame-based: the encoder pads the tail up to a whole 1152-sample
    // frame and the decoder hands back one frame of encoder delay, so the file
    // that comes home is up to TWO frames longer and never shorter. (Measured
    // here: exactly ceil(N/1152)*1152 + 1152.)
    assert(
      lengthDelta >= 0 && lengthDelta <= 2 * 1152,
      `it came back within two MP3 frames of the length it left at (delta ${lengthDelta} samples)`
    );
    assert(
      Math.abs(rmsDelta) < 1,
      `and at the same level, so the encode/decode round trip is transparent to the chain's work ` +
        `(${rmsDelta.toFixed(3)} dB)`
    );
    await page.evaluate(() => window.__test.closeActive());

    console.log('\nSMOKE PASSED');
  } finally {
    // The run must NEVER leave an Electron window for a human to close by
    // hand — see `closeApp` for the graceful-then-force sequence.
    await closeApp(app);
  }
}

main().catch((err) => {
  console.error('\nSMOKE FAILED');
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
