'use strict';

/**
 * The README's gallery, captured by rig (Task S2).
 *
 * `docs/shots/*.png` are the per-panel screenshots the README's "A closer
 * look" tables embed — the Effects rack, two effect dialogs, the pipeline
 * tool cards, the Remix/Markers/Properties/Spatial panels and a dressed
 * multitrack session. Every one is captured from the BUILT app (dist/) under
 * Playwright's Electron driver, on GENERATED fixtures only, at a pinned
 * 1600x1000 window and a forced 1x device scale — so the set regenerates
 * byte-comparably on the SAME machine and profile state (two shots depend on
 * the environment: the Align Lyrics card renders its model line from whatever
 * %APPDATA% model state exists, and the Vocal Chain card prints real
 * wall-clock timings) with:
 *
 *   npm run build && node scripts/readme-shots.cjs
 *
 * Element-bounded crops wherever the subject is a panel or a card (the
 * Vitrine gallery discipline: tight crops, consistent width, no window
 * chrome around a 348px panel); the full window only where the subject IS
 * the layout (the multitrack session).
 *
 * What the rig will NOT do: download a model. The Align Lyrics card is
 * captured PRE-run (its model line reflects this machine's profile — a
 * model-present state here; a fresh machine would show the 378 MB
 * not-downloaded line instead), the Cover Chain card pre-run with its
 * caveats, and the Transcript panel is not captured at all — there is no
 * test hook that injects a transcript, and the real one costs a ~323 MB
 * model. The Vocal Chain IS run for real (pure DSP, no model), so its
 * eleven rows show measured settings rather than promises.
 */

const path = require('node:path');
const fs = require('node:fs');
const {
  ROOT,
  SMOKE_WINDOW,
  SMOKE_WINDOW_TOLERANCE_PX,
  closeApp,
  ensureFixtures,
  launchApp,
  openModuleCard,
  pinWindowGeometry,
  realClick,
  realDrag,
  waitNonUniform,
} = require('./e2e-lib.cjs');

const OUT_DIR = path.join(ROOT, 'docs', 'shots');

// Generated fixtures only — never the personal recordings. The cover take is
// the most voice-like waveform the generators produce (the Vocal Chain derives
// real settings from it); the ABAB fixture has the bar structure Auto-Remix
// needs; the beat train gives the multitrack a visibly different second lane.
const COVER_TAKE = path.join(ROOT, 'test-assets', 'cover-take.wav');
const COVER_SONG = path.join(ROOT, 'test-assets', 'cover-song-sync.wav');
const ABAB = path.join(ROOT, 'test-assets', 'abab120.wav');
const BEAT = path.join(ROOT, 'test-assets', 'beat120.wav');
const SWEEP = path.join(ROOT, 'test-assets', 'sweep.wav');

// Modal dialogs rise (`dc-rise`) and cards mount their content async; a capture
// mid-animation is a defect the reviewer sees before anyone else does.
const SETTLE_MS = 700;

const shots = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Width/height straight out of the PNG's IHDR, so the summary reports what
 * was actually written rather than what was asked for. */
function pngSize(file) {
  const b = fs.readFileSync(file);
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

/**
 * Where to cut a card whose content scrolls: at the bottom of the last
 * FULLY-visible row, not at the card's own edge. The card's edge lands
 * mid-row for any list longer than the column, and a half-row in a gallery
 * reads as a broken capture rather than as a scrollbar. `rowSelectors` name
 * the units the cut must respect (effect rows, stage cards); the clip keeps
 * everything above the deepest one that fits, plus a breath of padding.
 * Returns null when nothing overflows — the caller then crops the element
 * whole, rounded bottom corner and all.
 */
async function scrollCutClip(page, containerSel, rowSelectors, pad = 8) {
  return page.evaluate(
    ({ containerSel, rowSelectors, pad }) => {
      const box = document.querySelector(containerSel)?.getBoundingClientRect();
      if (!box) return null;
      const rows = rowSelectors.flatMap((s) => [...document.querySelectorAll(s)]);
      let cut = null;
      for (const r of rows) {
        const rb = r.getBoundingClientRect();
        if (rb.top >= box.top && rb.bottom <= box.bottom - 2) {
          cut = cut === null ? rb.bottom : Math.max(cut, rb.bottom);
        }
      }
      if (cut === null || cut + pad >= box.bottom - 2) return null;
      return { x: box.x, y: box.y, width: box.width, height: cut + pad - box.y };
    },
    { containerSel, rowSelectors, pad }
  );
}

/**
 * One capture: an element-bounded crop when `selector` is given, the full
 * window otherwise. The floor is a blank-panel guard, not a quality bar —
 * a 348px panel card of real rows compresses to well over 8 KB, an empty
 * card to under it.
 */
async function shoot(page, name, selector, { minBytes = 8 * 1024, rowSelectors = null } = {}) {
  const file = path.join(OUT_DIR, name);
  if (selector) {
    const el = page.locator(selector).first();
    await el.waitFor({ state: 'visible', timeout: 10000 });
    const clip = rowSelectors ? await scrollCutClip(page, selector, rowSelectors) : null;
    if (clip) await page.screenshot({ path: file, clip });
    else await el.screenshot({ path: file });
  } else {
    await page.screenshot({ path: file });
  }
  const bytes = fs.statSync(file).size;
  const { width, height } = pngSize(file);
  if (bytes < minBytes) {
    throw new Error(`${name} is only ${bytes} bytes (< ${minBytes}) — the subject did not render`);
  }
  shots.push({ name, width, height, bytes });
  console.log(`  shot: ${name} ${width}x${height} (${bytes} bytes)`);
}

/** Closes whichever module card is open, so a full-window shot shows the
 * stage rather than the last panel the rig happened to visit. */
async function closeModuleCard(page) {
  const active = await page.evaluate(() =>
    document.querySelector('[data-testid="sidebar-panel"]')?.getAttribute('data-active-tab')
  );
  if (!active) return;
  const label = active.charAt(0).toUpperCase() + active.slice(1);
  await page.click(`[data-testid="sidebar-tabs"] button[aria-label="${label}"]`);
  await page.waitForFunction(
    () => document.querySelector('[data-testid="sidebar-panel"]') === null,
    null,
    { timeout: 5000 }
  );
}

/** Opens one Pipeline tool from the Pipeline card and waits for its hosted
 * card. The Pipeline card's rows are the menu's own commands, so the click is
 * the same `runCommand` the menu fires. */
async function openPipelineTool(page, commandId) {
  await openModuleCard(page, 'Pipeline');
  await page.waitForSelector('[data-testid="pipeline-panel"]', { timeout: 5000 });
  await page.click(`[data-testid="pipeline-item"][data-command-id="${commandId}"] button`);
  await page.waitForSelector(`[data-testid="tool-host"][data-tool-id="${commandId}"]`, {
    timeout: 10000,
  });
  await sleep(SETTLE_MS);
}

/** Closes the hosted tool card through its own header control. */
async function closeHostedTool(page) {
  await page.click('[data-testid="hosted-tool-close"]');
  await page.waitForFunction(
    () => document.querySelector('[data-testid="tool-host"]') === null,
    null,
    { timeout: 5000 }
  );
}

/** Opens a top-level menu and clicks one of its rows — `e2e-navigate.cjs`'s
 * own two helpers, inlined: the menu bar has no testids on its buttons, and
 * the dropdown rows scroll. */
async function clickMenuRow(page, menuTitle, rowLabel) {
  const btn = await page.evaluate((t) => {
    const b = [...document.querySelectorAll('.chrome-menu-btn')].find(
      (x) => x.textContent.trim() === t
    );
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, menuTitle);
  if (!btn) throw new Error(`menu button "${menuTitle}" not found`);
  await realClick(page, btn.x, btn.y);
  await page.waitForSelector(`[data-testid="menu-dropdown"][data-menu-title="${menuTitle}"]`, {
    timeout: 5000,
  });
  const row = await page.evaluate((want) => {
    const d = document.querySelector('[data-testid="menu-dropdown"]');
    if (!d) return null;
    const b = [...d.querySelectorAll('button')].find(
      (x) => x.querySelector('span')?.textContent.trim() === want
    );
    if (!b || b.disabled) return null;
    b.scrollIntoView({ block: 'nearest' });
    const r = b.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, rowLabel);
  if (!row) throw new Error(`menu row "${rowLabel}" not found or disabled in ${menuTitle}`);
  await realClick(page, row.x, row.y);
}

async function main() {
  ensureFixtures([
    [COVER_TAKE, 'make-test-cover.cjs', 'Cover Chain reference/take pair'],
    [COVER_SONG, 'make-test-cover.cjs', 'Cover Chain reference/take pair'],
    [ABAB, 'make-test-abab.cjs', 'ABAB structure fixture'],
    [BEAT, 'make-test-beat.cjs', '120 BPM click train'],
    [SWEEP, 'make-test-sweep.cjs', 'effect-sweep fixture'],
  ]);
  fs.mkdirSync(OUT_DIR, { recursive: true });

  console.log('Launching built app under Playwright Electron...');
  // 1x device scale, whatever the desktop's own scaling says — the README's
  // crops must not grow 25% on a 125% display.
  const { app, page } = await launchApp({ extraArgs: ['--force-device-scale-factor=1'] });

  try {
    const geo = await pinWindowGeometry(app, SMOKE_WINDOW);
    if (!geo) throw new Error('could not pin the editor window');
    if (
      Math.abs(geo.contentWidth - SMOKE_WINDOW.width) > SMOKE_WINDOW_TOLERANCE_PX ||
      Math.abs(geo.contentHeight - SMOKE_WINDOW.height) > SMOKE_WINDOW_TOLERANCE_PX
    ) {
      throw new Error(`window pinned at ${geo.contentWidth}x${geo.contentHeight}, wanted 1600x1000`);
    }

    // Element crops never show the window, so the PANEL scenes run with the
    // tallest window this display affords — a taller column shows more of a
    // long card (the effects registry, the chain's stage rows, a modal EQ)
    // before the scroll cut. Only `multitrack.png` is a full-window frame,
    // and the rig re-pins to the hero's own 1600x1000 for exactly that shot.
    const tallHeight = Math.min(geo.workArea.height - 24, 1400);
    const tall = await pinWindowGeometry(app, { width: SMOKE_WINDOW.width, height: tallHeight });
    console.log(`panel scenes at 1600x${tall.contentHeight} (work area ${geo.workArea.height})`);

    // ---- Scene A: a vocal-like document open in the waveform editor --------
    await page.evaluate((p) => window.__test.openPath(p), COVER_TAKE);
    await waitNonUniform(page, 'waveform-canvas');

    // The Effects rack: the module card with the categorised registry and the
    // Mix row below it.
    console.log('Effects rack...');
    await openModuleCard(page, 'Effects');
    await page.waitForSelector('[data-testid="effects-panel"]', { timeout: 5000 });
    await sleep(SETTLE_MS);
    await shoot(page, 'effects-rack.png', '[data-testid="sidebar-panel"]', {
      rowSelectors: ['[data-testid="effects-panel"] li'],
    });

    // Two representative effect cards, opened with one click as a user does
    // (item 6: an effect is a card in the module column, between the strip and
    // the module card, not a modal).
    //
    // The column's bounded height (`top 68` / `bottom 58`) is SHARED: the
    // effect card and the module card beneath it are both `flex: 0 1 auto`
    // with `min-h-0`, so two overflowing cards shrink PROPORTIONALLY to their
    // natural heights. `openEffect` forces the module card to Effects (N16),
    // and that card is the effects registry — over 1200px of rows. The
    // Parametric EQ's own controls are 1616px (the height this scene's modal
    // capture used to be, and 348 wide is no shorter than 460 was: no readout
    // spans, no label wraps), so sharing hands the card barely two thirds of
    // what it needs and Apply scrolls out of the shell's `overflow-y-auto`
    // body. The module card is not in this crop — the clip is `effect-host`
    // alone — and the effect card outlives it by design, so it is closed
    // before each capture and the card gets the whole column.
    //
    // The cards then borrow the display's whole height, and the fits-check
    // below keeps this honest: a card whose Apply row still fell below the
    // fold is a failed capture, not a crop. It reports the heights it MEASURED
    // rather than guessing a cap — the card deliberately has no `max-height`,
    // so a display too short for the whole card is the only thing left to say.
    await pinWindowGeometry(app, {
      width: SMOKE_WINDOW.width,
      height: geo.workArea.height - 24,
    });
    await sleep(300);
    for (const [label, file] of [
      ['Parametric EQ', 'effect-parametric-eq.png'],
      ['Reverb', 'effect-reverb.png'],
    ]) {
      console.log(`Effect card: ${label}...`);
      // The rows live in the Effects card, so it has to be open to click one —
      // and `openEffect` re-forces it open anyway. Closing it is the step
      // after the card mounts, never before.
      await openModuleCard(page, 'Effects');
      await page.waitForSelector('[data-testid="effects-list"]', { timeout: 5000 });
      await page.click(`[data-testid="effects-list"] button:text-is("${label}")`);
      await page.waitForSelector('[data-testid="effect-host"]', { timeout: 5000 });
      await closeModuleCard(page);
      await sleep(SETTLE_MS); // dc-rise
      // The card's whole point in the gallery is its Preview/Apply row — a
      // capture that scrolled it below the fold is a defect, not a crop.
      const fit = await page.evaluate(() => {
        const d = document.querySelector('[data-testid="effect-host"]');
        const apply = [...d.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Apply');
        if (!apply) return null;
        // The hosted shell is a fixed header plus a scrolled body
        // (`DialogShell`), and the body is where a squeezed card hides Apply.
        const body = document.querySelector(
          '[data-testid="effect-host"] [data-testid="hosted-tool"]'
        )?.children[1];
        const db = d.getBoundingClientRect();
        const ab = apply.getBoundingClientRect();
        return {
          fits: ab.bottom <= db.bottom + 1,
          below: Math.round(ab.bottom - db.bottom),
          card: Math.round(db.height),
          bodyVisible: body ? body.clientHeight : -1,
          bodyContent: body ? body.scrollHeight : -1,
          viewport: window.innerHeight,
        };
      });
      if (fit === null) throw new Error(`${label}: the card renders no Apply button`);
      if (!fit.fits) {
        throw new Error(
          `${label}: the Apply row is ${fit.below}px below the card's fold — card ${fit.card}px ` +
            `in a ${fit.viewport}px viewport, its body showing ${fit.bodyVisible}px of ` +
            `${fit.bodyContent}px. The column (top 68 / bottom 58) is the only cap the card ` +
            `has; this scene needs a display tall enough to hold the whole card.`
        );
      }
      await shoot(page, file, '[data-testid="effect-host"]');
      await page.click('[data-testid="effect-host"] [data-testid="hosted-tool-close"]');
      await page.waitForFunction(
        () => document.querySelector('[data-testid="effect-host"]') === null,
        null,
        { timeout: 5000 }
      );
    }

    // Back to the panel scenes' height.
    await pinWindowGeometry(app, { width: SMOKE_WINDOW.width, height: tallHeight });
    await sleep(300);

    // The Vocal Chain, AFTER a real run — pure DSP, no model, so the rig can
    // afford the pass and the rows show what was measured, not what is
    // promised. The apply is the dialog's own button; the wait is for the
    // done-state Close control the dialog only renders once the report is in.
    console.log('Vocal Chain (running the real pass — takes a minute)...');
    await openPipelineTool(page, 'effects.vocalChain');
    await page.click('[data-testid="vocal-chain-apply"]');
    await page.waitForSelector('[data-testid="vocal-chain-close"]', { timeout: 300000 });
    // The synthetic take is CLEAN, so the chain's honest first half is a run
    // of declines (no noise print worth learning, no hum measured). The rows
    // that carry the story — Pitch Correct, Compressor, De-esser with their
    // derived thresholds, and the measured before/after table under them —
    // sit from `pitch` down, so the card is scrolled to open on that stage.
    await page.evaluate(() => {
      const content = document.querySelector('[data-testid="hosted-tool"]').children[1];
      const row = document.querySelector('[data-testid="vocal-chain-stage-pitch"]');
      content.scrollTop += row.getBoundingClientRect().top - content.getBoundingClientRect().top - 8;
      // The results from `pitch` down fill slightly less than one viewport,
      // so the scroll CLAMPS ~50px short and the tail of the previous stage's
      // note bleeds in across the top of the frame. That partial paragraph is
      // a crop boundary, not content — so paint it as one: the cut row keeps
      // its layout but loses its ink, and the band reads as the card's own
      // padding. Nothing that IS in the shot is altered.
      const prev = document.querySelector('[data-testid="vocal-chain-stage-timing"]');
      if (prev && prev.getBoundingClientRect().top < content.getBoundingClientRect().top) {
        prev.style.visibility = 'hidden';
      }
    });
    await sleep(SETTLE_MS);
    await shoot(page, 'vocal-chain.png', '[data-testid="tool-host"]', {
      rowSelectors: [
        '[data-testid^="vocal-chain-stage-"]',
        '[data-testid="vocal-chain-summary"]',
        '[data-testid="vocal-chain-outcome"]',
      ],
    });
    await closeHostedTool(page);
    // The pass edited the document in place (one undo entry — its own claim).
    // Undo it, so every later scene sees the fixture as generated.
    await page.evaluate(() => window.__test.undoActive());

    // The Cover Chain card, pre-run — the honest state: its caveats are
    // stated ABOVE the Run button, which is the point the README makes.
    console.log('Cover Chain (pre-run card)...');
    await page.evaluate((p) => window.__test.openPath(p), COVER_SONG);
    await page.evaluate((p) => window.__test.openPath(p), COVER_TAKE);
    await openPipelineTool(page, 'effects.coverChain');
    // Choose the song, as a user about to run would have — the take select
    // already defaults to the active document. What the shot then shows is a
    // card one click from running, its caveats still stated above the button.
    await page.selectOption('[data-testid="cover-journey-song"]', { label: 'cover-song-sync.wav' });
    await sleep(300);
    await shoot(page, 'cover-chain.png', '[data-testid="tool-host"]', {
      rowSelectors: [
        '[data-testid^="cover-journey-stage-"]',
        '[data-testid="cover-journey-scope"]',
        '[data-testid="cover-journey-take"]',
      ],
    });
    await closeHostedTool(page);

    // Align Lyrics, pre-run — opening the card reads the model STATE and
    // downloads nothing; the 378 MB stays on its shelf.
    console.log('Align Lyrics (pre-run card)...');
    await openPipelineTool(page, 'lyrics.align');
    await shoot(page, 'align-lyrics.png', '[data-testid="tool-host"]');
    await closeHostedTool(page);

    // ---- Scene B: a remix and its panel ------------------------------------
    // Auto-Remix needs the fixture's own beat grid; tempo detection on the
    // 120 BPM ABAB fixture is seconds, not a model.
    console.log('Auto-Remix (tempo + re-plan on the ABAB fixture)...');
    await page.evaluate((p) => window.__test.openPath(p), ABAB);
    await waitNonUniform(page, 'waveform-canvas');
    const tempo = await page.evaluate(() => window.__test.detectTempo());
    if (tempo.bpm === null) throw new Error('tempo detection found no grid on the ABAB fixture');
    // Non-strict, and a target the planner can serve with several joins — the
    // panel's whole subject is the splice list, so a one-join plan under-sells
    // it. The candidate ladder is the smoke's own (its multi-join step).
    // Each success creates a document, and the panel shows the ACTIVE one —
    // so the loop stops on the first plan worth showing and the last success
    // is always the one on screen.
    let remix = null;
    for (const seconds of [150, 180, 120, 32]) {
      // eslint-disable-next-line no-await-in-loop
      const attempt = await page.evaluate(
        (s) => window.__test.remixToDuration(s, { strict: false }),
        seconds
      );
      if (attempt.ok) remix = attempt;
      if (remix && remix.joins >= 2) break;
    }
    if (!remix) throw new Error('remixToDuration refused every candidate target');
    console.log(`  remix: ${remix.name} — ${remix.joins} joins at ${remix.bpm} BPM`);
    await openModuleCard(page, 'Remix');
    await page.waitForSelector('[data-testid="sidebar-panel"][data-active-tab="remix"]', {
      timeout: 5000,
    });
    await sleep(SETTLE_MS);
    await shoot(page, 'remix-panel.png', '[data-testid="sidebar-panel"]', {
      rowSelectors: ['[data-testid="remix-item"]'],
    });

    // Markers on the ABAB document — named the way a session would name them.
    console.log('Markers...');
    await page.evaluate(() => {
      const sr = window.__test.getStateSummary().sampleRate;
      window.__test.setView('waveform');
      window.__test.addMarkerToActive(0, 'Intro');
      window.__test.addMarkerToActive(Math.round(8 * sr), 'Verse');
      window.__test.addMarkerToActive(Math.round(16 * sr), 'Chorus');
      window.__test.addMarkerToActive(Math.round(24 * sr), 'Verse 2');
    });
    await openModuleCard(page, 'Markers');
    await page.waitForSelector('[data-testid="sidebar-panel"][data-active-tab="markers"]', {
      timeout: 5000,
    });
    await sleep(SETTLE_MS);
    await shoot(page, 'markers.png', '[data-testid="sidebar-panel"]');

    // ---- Scene C: the multitrack session -----------------------------------
    // Built through the same hooks the smoke builds sessions with: clips on
    // three of the four tracks, an overlapping pair for the fades, automation
    // keys on track 1 and its volume lane OPEN — the one state that shows
    // clips, fades and an envelope in a single frame.
    console.log('Multitrack session...');
    await page.evaluate(() => window.__test.newSession(44100));
    // Three more rows, so the frame reads as a working session rather than
    // the four-track default with its bottom half empty.
    for (let i = 0; i < 3; i++) {
      // eslint-disable-next-line no-await-in-loop
      await page.click('button:has-text("Add Track")');
    }
    // Each insert re-activates its document first — the hook places the
    // ACTIVE one, and by this point in the run that would be the remix.
    const put = async (file, trackIndex, atSeconds) => {
      await page.evaluate((p) => window.__test.openPath(p), file);
      return page.evaluate(
        (a) => window.__test.insertActiveDocAsClip(a.trackIndex, Math.round(a.at * 44100)),
        { trackIndex, at: atSeconds }
      );
    };
    // The 64 s ABAB lane on top sets the fitted span; everything under it
    // stays wide enough to read at that zoom (8 s of beat ≈ 170 px).
    const abab = await put(ABAB, 0, 0);
    const beatA = await put(BEAT, 1, 8);
    const beatB = await put(BEAT, 1, 14); // 2 s over beatA — the crossfade pair
    const take = await put(COVER_TAKE, 2, 16);
    const song = await put(COVER_SONG, 3, 24);
    await put(SWEEP, 4, 32);
    const dressed = await page.evaluate((ids) => {
      const t = window.__test;
      const sr = 44100;
      const cross = t.armCrossfade(ids.beatB, 'in');
      t.setClipFade(ids.abab, 'in', { lengthSample: 2 * sr });
      t.setClipFade(ids.abab, 'out', { lengthSample: 3 * sr });
      t.setClipFade(ids.take, 'in', { lengthSample: Math.round(0.8 * sr) });
      t.setClipFade(ids.song, 'out', { lengthSample: Math.round(1.5 * sr) });
      // Volume automation across the WHOLE top lane — a shape, not a flat line.
      t.upsertAutomationKey(0, 'volumeDb', { positionSample: 0, value: -12 });
      t.upsertAutomationKey(0, 'volumeDb', { positionSample: 16 * sr, value: 0 });
      t.upsertAutomationKey(0, 'volumeDb', { positionSample: 40 * sr, value: -4 });
      t.upsertAutomationKey(0, 'volumeDb', { positionSample: 58 * sr, value: -16 });
      return { crossfade: cross.ok };
    }, { abab: abab.clipId, beatB: beatB.clipId, take: take.clipId, song: song.clipId });
    console.log(`  session built: 6 clips on 5 of 7 tracks, crossfade armed: ${dressed.crossfade}`);
    if (!beatA) throw new Error('beat clip A failed to place');

    // Open track 1's volume lane through its own header toggle.
    await page.click('[data-testid="track-header"] button[title^="Volume envelope"]');
    await page.waitForSelector('[data-testid="envelope-lane"]', { timeout: 5000 });

    // Back to the hero's own frame for the one full-window shot.
    const mtGeo = await pinWindowGeometry(app, SMOKE_WINDOW);
    if (
      Math.abs(mtGeo.contentWidth - SMOKE_WINDOW.width) > SMOKE_WINDOW_TOLERANCE_PX ||
      Math.abs(mtGeo.contentHeight - SMOKE_WINDOW.height) > SMOKE_WINDOW_TOLERANCE_PX
    ) {
      throw new Error(`multitrack frame pinned at ${mtGeo.contentWidth}x${mtGeo.contentHeight}, wanted 1600x1000`);
    }

    // The module card down, so the timeline holds the frame; wait for every
    // clip's waveform to actually paint before trusting the frame.
    await closeModuleCard(page);
    await page.waitForFunction(
      () => {
        const canvases = [...document.querySelectorAll('[data-testid="clip-waveform"]')];
        if (canvases.length < 6) return false;
        return canvases.every((c) => c.width > 0 && c.height > 0);
      },
      null,
      { timeout: 15000 }
    );
    await sleep(SETTLE_MS);
    await shoot(page, 'multitrack.png', null, { minBytes: 60 * 1024 });

    // Properties, with the crossfaded clip selected — the card shows the
    // clip's geometry and both fade editors.
    console.log('Properties...');
    // The crossfaded-in beat clip on track 2 — not track 1's clip, whose lane
    // is under the open envelope overlay and takes the click as a key edit.
    await page.locator('[data-testid="clip"]').nth(2).click();
    await openModuleCard(page, 'Properties');
    await page.waitForSelector('[data-testid="sidebar-panel"][data-active-tab="properties"]', {
      timeout: 5000,
    });
    await sleep(SETTLE_MS);
    await shoot(page, 'properties.png', '[data-testid="sidebar-panel"]');

    // The Spatial positioner, from the Effects menu (it has no strip icon —
    // that is F11's ruling, and the README says so). The source dot is dragged
    // off-centre so the stage shows a placement, not a default.
    console.log('Spatial...');
    await clickMenuRow(page, 'Effects', 'Spatial Positioner');
    await page.waitForSelector('[data-testid="sidebar-panel"][data-active-tab="spatial"]', {
      timeout: 5000,
    });
    await page.waitForSelector('[data-testid="spatial-stage"]', { timeout: 5000 });
    const dot = await page.evaluate(() => {
      const c = document.querySelector('[data-testid="spatial-source"]');
      if (!c) return null;
      const r = c.getBoundingClientRect();
      const stage = document.querySelector('[data-testid="spatial-stage"]').getBoundingClientRect();
      return {
        from: { x: r.x + r.width / 2, y: r.y + r.height / 2 },
        to: { x: stage.x + stage.width * 0.68, y: stage.y + stage.height * 0.35 },
      };
    });
    if (dot) await realDrag(page, dot.from, dot.to, { steps: 6 });
    await sleep(SETTLE_MS);
    await shoot(page, 'spatial-panel.png', '[data-testid="sidebar-panel"]');

    // ---- Summary ------------------------------------------------------------
    const total = shots.reduce((s, x) => s + x.bytes, 0);
    console.log('\nShots written to docs/shots/:');
    for (const s of shots) {
      console.log(`  ${s.name.padEnd(28)} ${String(s.width).padStart(4)}x${String(s.height).padEnd(4)} ${s.bytes} bytes`);
    }
    console.log(`  total: ${shots.length} shots, ${(total / 1024 / 1024).toFixed(2)} MB`);
    console.log('\nNot captured, by design:');
    console.log('  transcript-panel.png — no injection hook; the real transcript needs a ~323 MB model.');
    console.log('README SHOTS OK');
  } finally {
    await closeApp(app);
  }
}

main().catch((err) => {
  console.error('README SHOTS FAILED');
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
