'use strict';

// Flattens README.md to a plain-text README.txt shipped alongside the installer,
// so users who unzip the release folder get readable release notes without a
// Markdown viewer. Transform rules:
//   - image/badge lines (`![alt](url)`, or lines that become empty once images
//     are stripped) are dropped
//   - ATX headings become UPPERCASE with an underline: '=' for h1, '-' for h2+
//   - fenced code blocks lose their ``` fences and are indented 4 spaces verbatim
//   - inline links `[text](url)` become `text (url)`; emphasis/inline-code markers
//     are removed
//
// Run: node scripts/gen-readme-txt.cjs

const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');

/** Apply inline Markdown -> plain-text substitutions to a single (non-code) line. */
function transformInline(line) {
  return line
    // Links: [text](url) -> text (url). Runs before emphasis so labels keep their text.
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
    // Bold then italic.
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    // Inline code.
    .replace(/`([^`]+)`/g, '$1');
}

/** Convert a Markdown document string to plain text per the rules above. */
function markdownToText(md) {
  // HTML comments are invisible in rendered Markdown; drop them (incl. multi-line).
  const lines = md.replace(/<!--[\s\S]*?-->/g, '').split(/\r?\n/);
  const out = [];
  let inFence = false;

  for (const rawLine of lines) {
    if (/^\s*```/.test(rawLine)) {
      inFence = !inFence;
      continue; // drop the fence marker itself
    }
    if (inFence) {
      out.push('    ' + rawLine);
      continue;
    }

    // Drop image lines / badge lines: strip image syntax, and if nothing
    // meaningful remains, skip the line entirely.
    const withoutImages = rawLine.replace(/!\[[^\]]*\]\([^)]*\)/g, '');
    if (rawLine !== withoutImages && withoutImages.trim() === '') {
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(withoutImages);
    if (heading) {
      const level = heading[1].length;
      const text = transformInline(heading[2].trim()).toUpperCase();
      out.push(text);
      out.push((level === 1 ? '=' : '-').repeat(Math.max(text.length, 1)));
      continue;
    }

    out.push(transformInline(withoutImages));
  }

  return out.join('\n');
}

function main() {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  const md = fs.readFileSync(path.join(REPO_ROOT, 'README.md'), 'utf8');
  const txt = markdownToText(md);

  const releaseDir = path.join(REPO_ROOT, 'release');
  fs.mkdirSync(releaseDir, { recursive: true });
  const outPath = path.join(releaseDir, `Auditorium ${pkg.version} README.txt`);
  fs.writeFileSync(outPath, txt, 'utf8');
  console.log(`Wrote ${path.relative(REPO_ROOT, outPath)} (${txt.length} chars)`);
}

if (require.main === module) {
  main();
}

module.exports = { markdownToText, transformInline };
