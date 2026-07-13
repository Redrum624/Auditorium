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
});

describe('transformInline', () => {
  test('converts links to "text (url)"', () => {
    expect(transformInline('see [here](http://x)')).toBe('see here (http://x)');
  });

  test('strips bold, italic and inline code markers', () => {
    expect(transformInline('**bold** and *em* and `code`')).toBe('bold and em and code');
  });
});
