'use strict';

// Build-time tool: generates assets/icon.ico from a programmatically drawn
// canvas — a dark rounded square with a cyan waveform glyph, matching the app's
// accent (#26c6da) and background (#1a1a1e). Draws once at 256px, downsamples to
// the standard icon sizes, and packs them into a multi-resolution .ico.
//
// Idempotent: re-running overwrites assets/icon.ico with identical bytes.
// Not a unit — run it directly (`node scripts/gen-icon.cjs`); it is excluded
// from Jest because it depends on native canvas bindings.
//
// Run: node scripts/gen-icon.cjs

const fs = require('node:fs');
const path = require('node:path');
const { createCanvas } = require('@napi-rs/canvas');
const pngToIco = require('png-to-ico');

const REPO_ROOT = path.resolve(__dirname, '..');
const ASSETS_DIR = path.join(REPO_ROOT, 'assets');
const OUT_ICO = path.join(ASSETS_DIR, 'icon.ico');

const BG = '#1a1a1e';
const ACCENT = '#26c6da';

function roundRectPath(ctx, x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

/** Draw the 256x256 master icon and return the canvas. */
function drawMaster() {
  const size = 256;
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');

  // Dark rounded-square background.
  ctx.fillStyle = BG;
  roundRectPath(ctx, 0, 0, size, size, 48);
  ctx.fill();

  const cy = size / 2;

  // Thin center line (the waveform's zero axis).
  ctx.strokeStyle = ACCENT;
  ctx.globalAlpha = 0.45;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(size * 0.12, cy);
  ctx.lineTo(size * 0.88, cy);
  ctx.stroke();
  ctx.globalAlpha = 1;

  // Symmetric waveform bars centered on the axis.
  const heights = [0.2, 0.45, 0.7, 0.95, 0.6, 0.85, 0.5, 0.3, 0.15];
  const barW = 12;
  const gap = 8;
  const totalW = heights.length * barW + (heights.length - 1) * gap;
  const maxH = size * 0.62;
  let x = (size - totalW) / 2;

  ctx.fillStyle = ACCENT;
  for (const h of heights) {
    const barH = Math.max(barW, h * maxH);
    roundRectPath(ctx, x, cy - barH / 2, barW, barH, barW / 2);
    ctx.fill();
    x += barW + gap;
  }

  return canvas;
}

/** Downsample the master canvas to `size` and return a PNG buffer. */
function pngAt(master, size) {
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(master, 0, 0, size, size);
  return canvas.toBuffer('image/png');
}

async function main() {
  fs.mkdirSync(ASSETS_DIR, { recursive: true });
  const master = drawMaster();
  const sizes = [256, 128, 64, 48, 32, 16];
  const pngs = sizes.map((s) => pngAt(master, s));
  const ico = await pngToIco(pngs);
  fs.writeFileSync(OUT_ICO, ico);
  console.log(`Wrote ${path.relative(REPO_ROOT, OUT_ICO)} (${ico.length} bytes, sizes ${sizes.join('/')})`);
}

main().catch((err) => {
  console.error('Icon generation failed:', err && err.stack ? err.stack : err);
  process.exit(1);
});
