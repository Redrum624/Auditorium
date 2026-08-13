import fs from 'fs';
import path from 'path';

/**
 * MT1-4 — the native `<select>` popup must not be light-gray-on-white.
 *
 * The report ("color of the light gray text on white is not ideal", Cover
 * Chain's Reference picker) was filed against a missing `color-scheme`
 * declaration. It is not that: `src/index.css` has declared `color-scheme:
 * dark` on `:root` since G1, and the first test below pins that it still does.
 *
 * The actual cause is one line lower down the cascade. Chromium draws a
 * `<select>`'s dropdown listbox with the AUTHOR's background when the author
 * sets one, and three of the app's four selects set a translucent white —
 * `rgba(255,255,255,.04)` (GlassSelect), `.05` (Cover Chain Reference), `.06`
 * (Spatial track picker). On the glass surface those composite to a dark field,
 * which is why the CLOSED control always looked right. The popup is not drawn
 * on the glass surface: it is a separate widget over an opaque light base, so
 * 4% white composites to near-white, and the inherited `--glass-text-*` — a
 * light gray chosen to sit on near-black — lands on it unreadable.
 * `color-scheme: dark` cannot rescue that, because an author background beats
 * the UA's dark base; the declaration only ever governed the popups nobody had
 * styled.
 *
 * The natural experiment that settles it is already in the tree: the ONE select
 * with an OPAQUE background — `PropertiesPanel`'s fade-curve picker,
 * `bg-[#1a1a1e]` — is the one select in the app nobody reported. That colour is
 * also, to within a shade, what the translucent ones composite to when closed
 * (4% white over `--glass-bg` over the stage ≈ `#18181c`), so making them
 * opaque is a no-op on the closed control and the whole fix for the popup.
 *
 * Hence the law: **no `<select>` in this app carries a translucent background.**
 * It is enforced over the SOURCE rather than over a render because it has to
 * cover every select on every surface — including the ones behind a dialog or a
 * panel that a unit test would have to build a store to reach — and because the
 * property it constrains is a literal in the source either way. jsdom cannot
 * help here regardless: `index.css` is mapped to `identity-obj-proxy` under
 * jest, so no computed style in this suite has ever reflected the stylesheet.
 *
 * What this canNOT prove is the pixel. A native select popup is an OS-level
 * widget that Playwright cannot open or screenshot, so there is no rig
 * assertion available either; `scripts/e2e-navigate.cjs` asserts the reachable
 * half (the root's computed `color-scheme`, and each select's computed
 * background being opaque in real Chromium) and says so in its own comment.
 * Stated plainly: the popup's appearance is argued from the cascade rule and
 * from the PropertiesPanel control that already behaves, not observed.
 */

const SRC = path.join(__dirname, '../..');

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__mocks__') continue;
      sourceFiles(full, out);
    } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * The end of the JSX opening tag that starts at `open`, i.e. the index just
 * past its `>`. Walks rather than searching for the first `>`, because the
 * attributes contain plenty of them: `onChange={(e) => …}` in every select in
 * the tree, and `-->`-shaped prose in the comments inside `PropertiesPanel`'s.
 * Brace depth and quote state are enough — anything deeper (a `>` inside a
 * template literal inside an attribute) does not occur here and would fail
 * loudly via the file-list guard rather than silently.
 */
function openingTagEnd(text: string, open: number): number {
  let depth = 0;
  let quote = '';
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote && text[i - 1] !== '\\') quote = '';
      continue;
    }
    if (c === '"' || c === "'" || c === '`') quote = c;
    else if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (c === '>' && depth === 0) return i + 1;
  }
  return text.length;
}

/**
 * Every `<select …>` OPENING TAG in the tree, tagged with its file.
 *
 * The opening tag and nothing more, for two reasons. It is where the background
 * is set, on every select in the app — a nested `<option>` cannot give the
 * control its background. And `GlassSelect` is written SELF-CLOSING
 * (`<select … />`, its children arriving through `{...rest}`), so the first
 * draft of this scanner — slice from `<select` to `</select>` — found no closing
 * tag, ran to the end of `glass.tsx`, and reported an unrelated component's
 * `rgba(255,255,255,.09)` as a select offender. A false positive in a law like
 * this one is worse than no law: it sends the next reader to fix the wrong
 * element.
 */
/**
 * Source with block and line comments blanked out.
 *
 * This file's own subject matter is discussed in prose all over the tree — the
 * doc comment directly above `GlassSelect` says "mirrors GlassField on a
 * `<select>`" — and a scanner that reads comments finds those, mistakes them for
 * markup, and reports a count nobody can explain. Comments are replaced rather
 * than deleted so nothing else about the text shifts.
 */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

function selectRegions(): { file: string; text: string }[] {
  const regions: { file: string; text: string }[] = [];
  for (const file of sourceFiles(SRC)) {
    const text = stripComments(fs.readFileSync(file, 'utf8'));
    let from = 0;
    for (;;) {
      const open = text.indexOf('<select', from);
      if (open === -1) break;
      const end = openingTagEnd(text, open);
      regions.push({ file: path.relative(SRC, file), text: text.slice(open, end) });
      from = end;
    }
  }
  return regions;
}

/**
 * A translucent BACKGROUND specifically — `background`, `background-color` or
 * React's `backgroundColor` set to an `rgba()` with alpha < 1, or a Tailwind
 * `bg-…/NN` opacity modifier.
 *
 * Deliberately not "any translucent colour in the region": a translucent BORDER
 * (`--glass-border` is `rgba(255,255,255,.08)`, and `GlassSelect` writes
 * `1px solid rgba(255,255,255,.1)` inline) is correct and must stay. Only the
 * background reaches the popup, so only the background is constrained. The first
 * draft of this matcher was the loose one and reported the border as an
 * offender, which would have driven the fix into the wrong property.
 *
 * M4: `backgroundColor` was missing, which is the spelling every select in this
 * app would actually use — they are all styled through JSX `style` objects, and
 * the CoverChainDialog select that this law caught during the train was written
 * as `background:` only by chance. Between the property and its colour the
 * matcher now allows anything up to a property separator (`,` `;` or a newline),
 * so a ternary — how three of the app's four camelCase translucent backgrounds
 * are written — is covered, while a following `border:` on the same line still
 * cannot be mistaken for the background's own value.
 */
const TRANSLUCENT_BG =
  /background(?:-color|Color)?:[^;,\n]*rgba\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*,\s*(?:0?\.\d+|0)\s*\)|\bbg-[^\s"'`]*\/\d{1,3}\b/;

describe('MT1-4 — native select popups', () => {
  const css = fs.readFileSync(path.join(SRC, 'index.css'), 'utf8');

  it('still declares color-scheme: dark at the root', () => {
    // Already true before MT1-4 (G1 put it there). Pinned, not fixed: the
    // report blamed its absence, so its presence is the thing a future reader
    // needs to see asserted before believing the diagnosis above.
    expect(css).toMatch(/:root\s*\{[^}]*color-scheme:\s*dark/);
  });

  it('gives select and option an explicit opaque field background', () => {
    expect(css).toContain('--glass-field-bg: #1a1a1e');
    // The element rules are what cover any select added later that forgets to
    // style itself — the law below only catches ones that style themselves
    // WRONGLY, not ones that leave it to the UA.
    expect(css).toMatch(/(^|\n)select\s*\{[^}]*background-color:\s*var\(--glass-field-bg\)/);
    expect(css).toMatch(/option\s*\{[^}]*background-color:\s*var\(--glass-field-bg\)/);
  });

  it('gives the CHECKED option row an opaque background too', () => {
    // The last translucent one. `option:checked` was written as
    // `var(--accent-soft)` = rgba(38,198,218,.14), which is the very defect this
    // block exists to fix, on the row the user is actually looking at when the
    // popup opens. It is the accent composited over --glass-field-bg once:
    // .14*(38,198,218) + .86*(26,26,30) = (28,50,56) = #1c3238.
    const checked = /select option:checked\s*\{([^}]*)\}/.exec(css);
    expect(checked).not.toBeNull();
    // Comments stripped first: the rule's own docblock necessarily NAMES the
    // translucent value it replaced, and a matcher that reads it reports the
    // explanation as the defect.
    const body = stripComments(checked![1]);
    expect(body).toContain('background-color: #1c3238');
    expect(body).not.toMatch(/rgba\(|--accent-soft/);
  });

  it('finds every select in the app (guards the scanner itself)', () => {
    const regions = selectRegions();
    const files = [...new Set(regions.map((r) => r.file))].sort();
    // If this list shrinks, the scanner broke; if it grows, a new select
    // arrived and the law below is already covering it.
    expect(files).toEqual([
      path.join('components', 'Dialogs', 'CoverChainDialog.tsx'),
      path.join('components', 'Panels', 'PropertiesPanel.tsx'),
      path.join('components', 'Panels', 'SpatialPanel.tsx'),
      path.join('components', 'UI', 'glass.tsx'),
    ]);
    expect(regions.length).toBeGreaterThanOrEqual(files.length);
  });

  it('has a matcher that still catches what it is for (and not what it is not)', () => {
    // Without this, the law below passes just as happily when the scanner slices
    // too short or the regex stops matching — the two ways a source-scan law
    // quietly becomes a no-op. These are the exact strings that were in the tree
    // when MT1-4 was filed, plus the border form that must NOT trip it.
    expect(TRANSLUCENT_BG.test("background: 'rgba(255, 255, 255, 0.05)'")).toBe(true);
    expect(TRANSLUCENT_BG.test("background: 'rgba(255,255,255,.04)'")).toBe(true);
    expect(TRANSLUCENT_BG.test('className="bg-white/5"')).toBe(true);
    expect(TRANSLUCENT_BG.test("border: '1px solid rgba(255,255,255,.1)'")).toBe(false);
    expect(TRANSLUCENT_BG.test("background: 'var(--glass-field-bg)'")).toBe(false);
    expect(TRANSLUCENT_BG.test('className="bg-[#1a1a1e]"')).toBe(false);

    // React's OWN spelling, which this matcher missed entirely until M4's fix
    // round. Every select in this app is styled through a JSX `style` object, so
    // `backgroundColor` is the form a new one is most likely to arrive in — and
    // the app already writes exactly this shape in four places
    // (`SpatialPanel`, `TrackHeader` twice, `VoiceChangerDialog`). The law read
    // only the CSS spellings, so a camelCase translucent background on a select
    // would have been invisible to it, and this self-test never exercised the
    // case so the hole could not be seen from here either.
    expect(TRANSLUCENT_BG.test("backgroundColor: 'rgba(255, 255, 255, 0.05)'")).toBe(true);
    expect(TRANSLUCENT_BG.test("backgroundColor: 'rgba(255,255,255,.04)'")).toBe(true);
    // …including behind a ternary, which is how three of those four are written.
    expect(
      TRANSLUCENT_BG.test("backgroundColor: open ? 'var(--accent)' : 'rgba(255,255,255,0.05)'")
    ).toBe(true);
    expect(TRANSLUCENT_BG.test("backgroundColor: 'var(--glass-field-bg)'")).toBe(false);
    // The border must STILL not trip it, including when it follows an opaque
    // background on the same line — the match stops at the property separator
    // rather than running on into the next property's value.
    expect(
      TRANSLUCENT_BG.test("background: 'var(--glass-field-bg)', border: '1px solid rgba(255,255,255,.1)'")
    ).toBe(false);
    expect(
      TRANSLUCENT_BG.test("backgroundColor: '#1a1a1e', border: '1px solid rgba(255,255,255,.1)'")
    ).toBe(false);
  });

  it('slices each select down to its own opening tag', () => {
    // The self-closing GlassSelect is the one that broke the first scanner, so
    // it is the one pinned: its region must end at its own `/>`, not run on.
    const glass = selectRegions().filter((r) => r.file.endsWith('glass.tsx'));
    expect(glass).toHaveLength(1);
    expect(glass[0].text).toContain('--glass-field-bg');
    expect(glass[0].text.endsWith('/>')).toBe(true);
    expect(glass[0].text).not.toContain('GlassSlider');
  });

  it('carries no translucent background on any select', () => {
    const offenders = selectRegions()
      .filter((r) => TRANSLUCENT_BG.test(r.text))
      .map((r) => `${r.file}: ${TRANSLUCENT_BG.exec(r.text)?.[0] ?? ''}`);
    expect(offenders).toEqual([]);
  });
});
