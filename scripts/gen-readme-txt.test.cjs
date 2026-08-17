'use strict';

const { markdownToText, transformInline } = require('./gen-readme-txt.cjs');

describe('markdownToText', () => {
  test('flattens headings, links, code fences and drops images', () => {
    const md = [
      '# Auditorium',
      '',
      '![Auditorium](docs/screenshot.png)',
      '',
      'A free **audio editor**. See the [User Guide](docs/USER_GUIDE.md).',
      '',
      '## Install',
      '',
      'Run the commands:',
      '',
      '```bash',
      'git clone https://example.com/repo.git',
      'npm install',
      '```',
      '',
      'Done with `npm run build:win`.',
    ].join('\n');

    const expected = [
      'AUDITORIUM',
      '==========',
      '',
      '',
      'A free audio editor. See the User Guide (docs/USER_GUIDE.md).',
      '',
      'INSTALL',
      '-------',
      '',
      'Run the commands:',
      '',
      '    git clone https://example.com/repo.git',
      '    npm install',
      '',
      'Done with npm run build:win.',
    ].join('\n');

    expect(markdownToText(md)).toBe(expected);
  });

  test('drops a standalone image line entirely (no blank residue kept for it)', () => {
    expect(markdownToText('![alt](x.png)')).toBe('');
  });

  test('strips HTML comments, including multi-line ones', () => {
    const md = ['Before.', '<!-- a note', 'spanning lines -->', 'After.'].join('\n');
    expect(markdownToText(md)).toBe(['Before.', '', 'After.'].join('\n'));
  });

  test('underline length matches the (upper-cased) heading text length', () => {
    const out = markdownToText('### Modules').split('\n');
    expect(out[0]).toBe('MODULES');
    expect(out[1]).toBe('-------');
    expect(out[1].length).toBe(out[0].length);
  });

  test('joins wrapped paragraph lines so a cross-line code span flattens cleanly', () => {
    // Mirrors README.md's Architecture paragraph, where `nodeIntegration:
    // false` wraps across a source line break.
    const md = [
      'The **Electron main process** owns all OS access and is hardened: every',
      '`BrowserWindow` runs with `contextIsolation`, `sandbox`, and `nodeIntegration:',
      'false`, and a preload whitelist exposes only a typed `window.electronAPI` over',
      'IPC.',
    ].join('\n');
    const out = markdownToText(md);
    expect(out).not.toContain('`');
    expect(out).toContain('nodeIntegration: false');
    for (const line of out.split('\n')) {
      expect(line.length).toBeLessThanOrEqual(80);
    }
  });

  test('keeps list items per-line (not joined into paragraphs)', () => {
    const md = ['- **First** item', '- Second item'].join('\n');
    expect(markdownToText(md)).toBe(['- First item', '- Second item'].join('\n'));
  });

  test('collapses runs of 3+ blank lines to a single blank line', () => {
    expect(markdownToText('A.\n\n\n\n\nB.')).toBe('A.\n\nB.');
    // Two blank lines are left alone.
    expect(markdownToText('A.\n\n\nB.')).toBe('A.\n\n\nB.');
  });

  // The screenshot-gallery tables (Task S2): the table exists FOR its images,
  // so the flattened text keeps only the caption cells, one per line.
  test('drops table chrome and image cells, keeps caption cells per-line', () => {
    const md = [
      '| | |',
      '|:--:|:--:|',
      '| ![A](docs/shots/a.png) | ![B](docs/shots/b.png) |',
      '| **Panel A** — what it does. | **Panel B** — what it shows. |',
    ].join('\n');
    expect(markdownToText(md)).toBe(
      ['Panel A — what it does.', 'Panel B — what it shows.'].join('\n')
    );
  });

  test('wraps a long caption cell at 80 columns', () => {
    const long =
      '| **Vocal Chain, after a run** — each stage reports the settings it derived, its measured delta, or the measurement that made it decline. |';
    for (const line of markdownToText(long).split('\n')) {
      expect(line.length).toBeLessThanOrEqual(80);
    }
  });
});

describe('transformInline', () => {
  test('converts links to "text (url)"', () => {
    expect(transformInline('see [here](http://x)')).toBe('see here (http://x)');
  });

  test('strips bold, italic and inline code markers', () => {
    expect(transformInline('**bold** and *em* and `code`')).toBe('bold and em and code');
  });

  test('emits a link once when its code-wrapped label equals its url', () => {
    expect(transformInline('see [`KEYBOARD_SHORTCUTS.md`](KEYBOARD_SHORTCUTS.md).')).toBe(
      'see KEYBOARD_SHORTCUTS.md.'
    );
  });

  test('strips code markers inside a link label that differs from its url', () => {
    expect(transformInline('[`npm run dev`](docs/dev.md)')).toBe('npm run dev (docs/dev.md)');
  });
});
