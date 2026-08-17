'use strict';

// Flattens README.md to a plain-text README.txt shipped alongside the installer,
// so users who unzip the release folder get readable release notes without a
// Markdown viewer. Transform rules:
//   - HTML comments are dropped (they are invisible in rendered Markdown)
//   - image/badge lines (`![alt](url)`, or lines that become empty once images
//     are stripped) are dropped
//   - ATX headings become UPPERCASE with an underline: '=' for h1, '-' for h2+
//   - fenced code blocks lose their ``` fences and are indented 4 spaces verbatim
//   - paragraph lines (column-0 prose) are joined into logical paragraphs BEFORE
//     inline transforms — so code spans/emphasis that wrap across a source line
//     break flatten cleanly — then re-wrapped at 80 columns
//   - list items and indented continuation lines are kept per-line
//   - inline links `[text](url)` become `text (url)` (just `text` when the
//     label and url are identical); emphasis/inline-code markers are removed
//   - runs of 3+ blank lines collapse to a single blank line
//
// Run: node scripts/gen-readme-txt.cjs

const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const WRAP_WIDTH = 80;

/** Apply inline Markdown -> plain-text substitutions to a single (non-code) line. */
function transformInline(line) {
  return line
    // Links: [text](url) -> text (url). Runs before emphasis so labels keep
    // their text. Inline-code markers inside the label are stripped first, and
    // a label identical to its url is emitted only once.
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label, url) => {
      const text = label.replace(/`([^`]+)`/g, '$1').trim();
      return text === url.trim() ? text : `${text} (${url})`;
    })
    // Bold then italic.
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    // Inline code.
    .replace(/`([^`]+)`/g, '$1');
}

/** Greedy word-wrap of a single logical paragraph to `width` columns. */
function wrapText(text, width) {
  const words = text.split(/\s+/).filter(Boolean);
  const lines = [];
  let current = '';
  for (const word of words) {
    if (current === '') current = word;
    else if (current.length + 1 + word.length <= width) current += ' ' + word;
    else {
      lines.push(current);
      current = word;
    }
  }
  if (current !== '') lines.push(current);
  return lines;
}

/** Convert a Markdown document string to plain text per the rules above. */
function markdownToText(md) {
  const lines = md.replace(/<!--[\s\S]*?-->/g, '').split(/\r?\n/);
  const out = [];
  let inFence = false;
  let para = []; // accumulated column-0 prose lines forming one paragraph

  const flushPara = () => {
    if (para.length === 0) return;
    out.push(...wrapText(transformInline(para.join(' ')), WRAP_WIDTH));
    para = [];
  };

  for (const rawLine of lines) {
    if (/^\s*```/.test(rawLine)) {
      flushPara();
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
      flushPara();
      continue;
    }

    if (withoutImages.trim() === '') {
      flushPara();
      out.push('');
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(withoutImages);
    if (heading) {
      flushPara();
      const level = heading[1].length;
      const text = transformInline(heading[2].trim()).toUpperCase();
      out.push(text);
      out.push((level === 1 ? '=' : '-').repeat(Math.max(text.length, 1)));
      continue;
    }

    // List items and indented continuation lines: keep per-line (their inline
    // spans never wrap across source lines in this README).
    if (/^\s*([-*+]|\d+\.)\s/.test(withoutImages) || /^\s/.test(withoutImages)) {
      flushPara();
      out.push(transformInline(withoutImages));
      continue;
    }

    // Column-0 prose: part of a logical paragraph.
    para.push(withoutImages.trim());
  }
  flushPara();

  // Collapse runs of 3+ blank lines to a single blank line.
  return out.join('\n').replace(/\n{4,}/g, '\n\n');
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

module.exports = { markdownToText, transformInline, wrapText };
