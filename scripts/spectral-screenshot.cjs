'use strict';

// Captures docs/screenshot-spectral.png for the README (Task F9): launches the
// BUILT app under Playwright's Electron driver (same as scripts/e2e-smoke.cjs),
// opens the test tone, switches to the Spectral view (log scale is the default),
// waits for the spectrogram to render, and screenshots the window at 1600x1000.
//
// Run: npm run build && node scripts/spectral-screenshot.cjs

const path = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { _electron: electron } = require('playwright');
// S1: the launch splash is a second BrowserWindow, so the editor's window is
// found by URL through the shared helper rather than by arrival order —
// screenshotting the splash would be a very quiet way to break the README.
const { acquireMainWindow } = require('./e2e-lib.cjs');

const ROOT = path.resolve(__dirname, '..');
const TONE = path.join(ROOT, 'test-assets', 'tone.wav');
const OUT = path.join(ROOT, 'docs', 'screenshot-spectral.png');

async function main() {
  if (!fs.existsSync(path.join(ROOT, 'dist', 'index.html'))) {
    throw new Error('dist/index.html missing — run `npm run build` before capturing the screenshot');
  }
  if (!fs.existsSync(TONE)) {
    execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'make-test-tone.cjs')], {
      stdio: 'inherit',
    });
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });

  console.log('Launching built app under Playwright Electron...');
  const app = await electron.launch({
    args: ['.'],
    cwd: ROOT,
    env: { ...process.env, AUDITORIUM_TEST: '1' },
  });

  try {
    const page = await acquireMainWindow(app); // S1: the editor, not the splash
    await page.waitForLoadState('domcontentloaded');
    await page.waitForFunction(() => Boolean(window.__test), null, { timeout: 20000 });

    // Force the window to exactly 1600x1000 content pixels.
    const win = await app.browserWindow(page);
    await win.evaluate((w) => w.setContentSize(1600, 1000));

    console.log(`Opening ${TONE} and switching to the Spectral view (log scale)...`);
    await page.evaluate((p) => window.__test.openPath(p), TONE);
    await page.evaluate(() => window.__test.setView('spectral'));

    // Wait for the spectrogram to render (non-uniform raster), then a beat for
    // the overlays and any final layout to settle.
    await page.waitForFunction(
      () => {
        const c = document.querySelector('[data-testid="spectrogram-canvas"]');
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
      { timeout: 20000 }
    );
    await new Promise((resolve) => setTimeout(resolve, 500));

    await page.screenshot({ path: OUT });
    const size = fs.statSync(OUT).size;
    console.log(`Wrote ${OUT} (${size} bytes)`);
    if (size < 30 * 1024) {
      throw new Error(`screenshot is only ${size} bytes (< 30KB) — render may have failed`);
    }
    console.log('SPECTRAL SCREENSHOT OK');
  } finally {
    await app.close();
  }
}

main().catch((err) => {
  console.error('SPECTRAL SCREENSHOT FAILED');
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
