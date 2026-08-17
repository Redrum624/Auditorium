'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * `electron/splash.html` is a static main-process asset — it is never imported,
 * never bundled, and never rendered by a test runner — so it is pinned the way
 * scripts/prod-csp.test.cjs pins the built CSP: by reading it and asserting the
 * contract it owes.
 *
 * Three of those obligations are cross-file, and those are the ones worth a
 * test. The page cannot import the app stylesheet, so its design tokens are
 * hand-copied and can silently drift from src/index.css. It cannot reference
 * assets/icon.ico, so its logo is hand-drawn and can silently stop being
 * Auditorium's logo. And it is the only page in the app that can quietly start
 * loading something off the network, because nothing else ever looks at it.
 */

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(__dirname, 'splash.html'), 'utf8');
const appCss = fs.readFileSync(path.join(ROOT, 'src', 'index.css'), 'utf8');
const iconSrc = fs.readFileSync(path.join(ROOT, 'scripts', 'gen-icon.cjs'), 'utf8');

/** The value of a custom property, from whichever file. Both declare each token
 * exactly once, so the first match is the value. */
function token(source, name) {
  const hit = source.match(new RegExp(`--${name}:\\s*([^;]+);`));
  return hit ? hit[1].replace(/\s+/g, ' ').trim() : null;
}

describe('the page loads nothing', () => {
  test('no external resource of any kind is referenced', () => {
    // The splash exists to paint the instant the window does. One remote font
    // or CDN stylesheet and it is a blank rectangle until the network answers —
    // and a blank rectangle is the state the whole feature exists to avoid.
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).not.toMatch(/<link\b/);
    expect(html).not.toMatch(/<script[^>]+src=/);
    expect(html).not.toMatch(/<img\b/);
    expect(html).not.toMatch(/url\(/);
  });

  test('and the policy denies it rather than trusting it', () => {
    const csp = html.match(/http-equiv="Content-Security-Policy"[\s\S]*?content="([^"]+)"/);
    expect(csp).not.toBeNull();
    expect(csp[1]).toContain("default-src 'none'");
    // The only two grants, and they are exactly the two inline blocks the file
    // has: no 'self', no https:, nothing that could fetch.
    expect(csp[1]).toContain("style-src 'unsafe-inline'");
    expect(csp[1]).toContain("script-src 'unsafe-inline'");
    expect(csp[1]).not.toMatch(/https?:/);
  });
});

describe("the tokens are Auditorium's, and still are", () => {
  // Mirrored by hand because a separate BrowserWindow cannot import the app
  // stylesheet. This is the test that notices when the app's palette moves and
  // the splash's does not.
  const mirrored = [
    'accent',
    'accent-ring',
    'glass-bg',
    'glass-border',
    'glass-shadow',
    'glass-text-title',
    'glass-text-label',
    'glass-text-secondary',
    'glass-text-muted',
    'radius-card',
  ];

  test.each(mirrored)('--%s matches src/index.css verbatim', (name) => {
    const appValue = token(appCss, name);
    expect(appValue).not.toBeNull();
    expect(token(html, name)).toBe(appValue);
  });

  test('the accent really is the cyan, not the blue kept for parity', () => {
    // src/index.css carries Vitrine's --primary-500 blue alongside Auditorium's
    // cyan. Copying the wrong one would still pass a "mirrors a token" check.
    expect(token(html, 'accent')).toBe('#26c6da');
    expect(html).not.toContain(token(appCss, 'primary-500'));
  });
});

describe('the logo is the real mark', () => {
  // Redrawn as inline SVG from scripts/gen-icon.cjs — the generator that
  // produces assets/icon.ico, i.e. the icon on the taskbar the user just
  // clicked. The geometry is recomputed from the generator's own constants
  // here, so a change to the app icon that is not carried into the splash
  // fails rather than leaving two different logos in one launch.
  const size = 256;
  const heights = JSON.parse(iconSrc.match(/const heights = (\[[^\]]+\]);/)[1]);
  const barW = Number(iconSrc.match(/const barW = (\d+);/)[1]);
  const gap = Number(iconSrc.match(/const gap = (\d+);/)[1]);
  const maxH = size * Number(iconSrc.match(/const maxH = size \* ([\d.]+);/)[1]);
  const accent = iconSrc.match(/const ACCENT = '([^']+)';/)[1];
  const bg = iconSrc.match(/const BG = '([^']+)';/)[1];
  const corner = Number(iconSrc.match(/roundRectPath\(ctx, 0, 0, size, size, (\d+)\)/)[1]);

  /** The bars inside the accent-filled group, as numbers. */
  function svgBars() {
    const group = html.match(/<g fill="[^"]+">([\s\S]*?)<\/g>/);
    if (!group) return [];
    return [...group[1].matchAll(/<rect ([^>]+)\/>/g)].map((m) => {
      const attrs = {};
      for (const [, k, v] of m[1].matchAll(/(\w+)="([^"]+)"/g)) attrs[k] = Number(v);
      return attrs;
    });
  }

  test('the background square is the icon\'s colour and corner radius', () => {
    expect(html).toContain(`fill="${bg}"`);
    expect(html).toMatch(new RegExp(`rx="${corner}"`));
  });

  test('the bars are drawn on the icon generator\'s own geometry', () => {
    const bars = svgBars();
    expect(bars).toHaveLength(heights.length);

    const totalW = heights.length * barW + (heights.length - 1) * gap;
    let x = (size - totalW) / 2;
    heights.forEach((h, i) => {
      const barH = Math.max(barW, h * maxH);
      expect(bars[i].x).toBeCloseTo(x, 3);
      expect(bars[i].width).toBe(barW);
      expect(bars[i].height).toBeCloseTo(barH, 3);
      // Centred on the zero axis, which is what makes the mark symmetric.
      expect(bars[i].y).toBeCloseTo(size / 2 - barH / 2, 3);
      x += barW + gap;
    });
  });

  test('the bars and the axis are the app accent', () => {
    expect(html).toContain(`<g fill="${accent}">`);
    expect(html).toMatch(new RegExp(`stroke="${accent}"`));
  });
});

describe('the page keeps its side of the IPC contract', () => {
  test('it listens for progress on the exposed bridge, never on ipcRenderer', () => {
    expect(html).toMatch(/electronAPI/);
    expect(html).toMatch(/onSplashProgress\(/);
    // contextIsolation + sandbox mean there is no ipcRenderer here to reach for
    // in the first place; asserting it keeps a future edit from "fixing" that.
    expect(html).not.toMatch(/ipcRenderer/);
    expect(html).not.toMatch(/require\(/);
  });

  test('it handles all three fields of a progress payload', () => {
    expect(html).toMatch(/data\.progress/);
    expect(html).toMatch(/data\.message/);
    expect(html).toMatch(/data\.error/);
  });

  test('it asks for the REAL version and shows nothing if it cannot have it', () => {
    expect(html).toMatch(/getAppVersion\(\)/);
    // photo_app falls back to a literal 'v1.0.0'. A wrong version on screen is
    // worse than no version, and this page is where a wrong one would be least
    // likely to be noticed.
    expect(html).not.toMatch(/v1\.0\.0/);
  });

  test('the error line exists and starts hidden', () => {
    expect(html).toMatch(/id="error"/);
    expect(html).toMatch(/\.error\s*\{[^}]*display:\s*none/);
  });

  test('the filler stops at 30 and dies on the first real milestone', () => {
    // It is pre-first-signal filler, nothing more: it must never overtake a
    // real number, and the first real number must end it.
    expect(html).toMatch(/filler\s*>=\s*30/);
    expect(html).toMatch(/clearInterval\(fillerTimer\)/);
  });
});

/**
 * The brace-balanced body of the first block whose header matches.
 *
 * Fix round 2, M-9. This used to be one regex ending in `\n {6}\}` — the
 * closing brace identified by its exact six-space indentation. A reformat would
 * not have failed the test, it would have silently changed WHICH text was
 * asserted against: the `}` of an inner rule indents differently, so the match
 * would have stopped early and the assertions below would have run over a
 * fragment. Counting braces is what the assertion actually means.
 */
function blockBody(text, header) {
  const at = text.search(header);
  if (at < 0) return null;
  const open = text.indexOf('{', at);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(open + 1, i);
    }
  }
  return null;
}

test('a reduced-motion preference is honoured', () => {
  expect(html).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
  const block = blockBody(html, /@media \(prefers-reduced-motion: reduce\)/);
  expect(block).not.toBeNull();
  // The entrance, the shimmer and the width transition all stop. The bar's
  // transition is the one that matters most here: it is the only one the user
  // sees for the whole of the launch rather than once.
  expect(block).toMatch(/\.rise\s*\{\s*animation: none/);
  expect(block).toMatch(/\.bar::after\s*\{\s*animation: none/);
  expect(block).toMatch(/\.bar\s*\{\s*transition: none/);
  // …and the extraction really did stop at the end of the media query rather
  // than running on into the rest of the sheet, which is the failure the
  // indentation-matched version could not tell from success.
  expect(block).not.toMatch(/<\/style>/);
});

test('the block extractor stops at the matching brace, not at an indentation', () => {
  // Guards the guard. If `blockBody` ran to the end of the file every assertion
  // above would pass by being handed the whole sheet.
  const sheet = '@media x {\n  .a {\n    animation: none;\n  }\n}\n.b { color: red; }';
  expect(blockBody(sheet, /@media x/)).toBe('\n  .a {\n    animation: none;\n  }\n');
  expect(blockBody(sheet, /@media nope/)).toBeNull();
});
