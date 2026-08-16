'use strict';

/**
 * The NAVIGATION pass (task PW1) — `npm run navigate`.
 *
 * `e2e-smoke.cjs` is a SCENARIO: one long round trip through the flows that
 * carry the app's promises (open → edit → chain → export → reopen), measured in
 * samples and decibels. It is deep and narrow, and it drives almost everything
 * through `window.__test` because that is where the numbers are.
 *
 * This is the other axis. It is a WALK: every user-reachable surface is opened
 * through the surface the user would actually use, made to do one real thing,
 * and closed — and after every step the app is asked to prove it is still
 * alive. It is wide and shallow on purpose. The two together are the coverage
 * claim; neither is it alone.
 *
 * The walker's law: **every surface opens, does one real thing, and closes,
 * leaving the app healthy.**
 *
 * Three rules it holds itself to, because a walker that cannot fail is worse
 * than no walker:
 *
 *  1. **Registry-derived, never hardcoded.** The menu titles, the dialog roster,
 *     the module panels, the editor views and the effect list are all READ —
 *     from the app's own DOM, or from the source registry that produces it. A
 *     new dialog dropped into `src/components/Dialogs/` with no way to open it
 *     fails this script; a new menu section appears in the walk without anyone
 *     editing this file.
 *  2. **Differential, never tautological.** "The menu renders each item's real
 *     enabled state" is not checkable by asking the same code twice, so it is
 *     checked as a DIFFERENCE: the same menu is read with no document and with
 *     one, and the disabled set has to shrink in the places the predicates say
 *     it should and nowhere else.
 *  3. **Liveness after every step.** Two real animation frames must land, the
 *     store must answer, no dialog or menu may be left open, and a REAL pointer
 *     click must still drive a React round trip. A step that wedges the
 *     renderer fails at the step that wedged it, not five steps later.
 *
 * Native OS dialogs are STUBBED IN THE MAIN PROCESS (see `stubNativeDialogs`),
 * because a real `showSaveDialog` blocks the main process and no harness can
 * dismiss it. What that proves and what it does not is stated where it is used
 * and in the report: the renderer-side command path and its cancel handling,
 * not the OS widget.
 *
 * Run: npm run build && npm run navigate
 */

const path = require('node:path');
const fs = require('node:fs');

const {
  ROOT,
  SMOKE_WINDOW,
  SMOKE_WINDOW_TOLERANCE_PX,
  assert,
  assertionCount,
  canvasHash,
  closeApp,
  ensureFixtures,
  launchApp,
  openModuleCard,
  pinWindowGeometry,
  realClick,
  realDrag,
  waitNonUniform,
} = require('./e2e-lib.cjs');

const TONE = path.join(ROOT, 'test-assets', 'tone.wav');
const BEAT = path.join(ROOT, 'test-assets', 'beat120.wav');
const SWEEP = path.join(ROOT, 'test-assets', 'sweep.wav');
const ABAB = path.join(ROOT, 'test-assets', 'abab120.wav');
const OUT_DIR = path.join(ROOT, 'test-output');
const OUT_NOT_AUDIO = path.join(OUT_DIR, 'navigate-not-audio.txt');

// The source registries this walk is derived from. Read as TEXT rather than
// imported: this is a plain-Node harness and they are TypeScript modules, but
// the point is the same either way — the list comes from the file that DEFINES
// it, so it cannot silently disagree with the app.
const SRC = {
  menuActions: path.join(ROOT, 'src', 'services', 'menuActions.ts'),
  dialogBus: path.join(ROOT, 'src', 'services', 'dialogBus.ts'),
  moduleStrip: path.join(ROOT, 'src', 'components', 'Layout', 'ModuleStrip.tsx'),
  toolbar: path.join(ROOT, 'src', 'components', 'Layout', 'Toolbar.tsx'),
  dialogDir: path.join(ROOT, 'src', 'components', 'Dialogs'),
};

const read = (p) => fs.readFileSync(p, 'utf8');

// ---------------------------------------------------------------------------
// Registry derivation
// ---------------------------------------------------------------------------

/** The menu SECTION titles, in order, straight out of `menuActions.ts`'s LAYOUT
 * table. Compared below against the titles the bar actually renders — a section
 * in the table that the bar does not draw, or the reverse, is a finding. */
function layoutMenuTitles() {
  const src = read(SRC.menuActions);
  const from = src.indexOf('const LAYOUT:');
  if (from === -1) throw new Error('menuActions.ts: LAYOUT table not found — the walker cannot derive the menus');
  const to = src.indexOf('\n];', from);
  const table = src.slice(from, to);
  return [...table.matchAll(/title:\s*'([^']+)'/g)].map((m) => m[1]);
}

/** Every `.ts`/`.tsx` file under `src/`, tests excluded — the corpus the
 * dialog-reachability derivation searches. */
function sourceFiles(dir = path.join(ROOT, 'src'), out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, out);
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** The exported function whose body contains `index`, or null. Used to answer
 * "what is the name of the thing that opens this dialog", so the search can
 * take a second hop out to whoever calls THAT. */
function enclosingExport(text, index) {
  let found = null;
  for (const m of text.matchAll(/export (?:async )?function ([A-Za-z0-9_]+)\s*\(/g)) {
    if (m.index < index) found = m[1];
    else break;
  }
  return found;
}

/**
 * Every dialog COMPONENT, mapped to the way it is opened.
 *
 * The roster is the DIRECTORY LISTING — that is the registry here, and it is
 * why a new dialog cannot escape this walk. For each one the search asks how a
 * user could possibly get to it, in three widening steps:
 *
 *  1. `commands` — a menu command whose body calls the bus opener directly.
 *     Resolved by walking `menuActions.ts` and taking the nearest preceding
 *     `id: '…'`.
 *  2. `dynamic` — the nearest preceding id is a TEMPLATE (`effect.${e.id}`),
 *     i.e. one command per registry entry rather than one fixed id. Not a
 *     missing path, a different KIND of path; the walk opens it through the
 *     Effects menu instead.
 *  3. `relays` — the opener is called from a SERVICE, and a command calls that
 *     service function. `transport.record` is the live example: it runs
 *     `transportRecord()`, and that is what opens the Record dialog, because
 *     the command is view-routed (the multitrack view punches into armed
 *     tracks instead). One hop, resolved by name rather than assumed.
 *
 * A dialog none of the three reaches has NO open path, and the walk fails on
 * it — which is exactly the finding the brief asks for.
 */
function dialogOpenPaths() {
  const bus = read(SRC.dialogBus);
  const menu = read(SRC.menuActions);
  const files = fs
    .readdirSync(SRC.dialogDir)
    .filter((f) => f.endsWith('Dialog.tsx') && !f.endsWith('.test.tsx'))
    .sort();
  // Where every `id:` sits in menuActions.ts, so "the command this call belongs
  // to" is the last one declared before it.
  const idSites = [...menu.matchAll(/id:\s*(?:'([^']+)'|`([^`]+)`)/g)].map((m) => ({
    at: m.index,
    id: m[1] ?? m[2],
    templated: m[1] === undefined,
  }));
  const commandAt = (index) => {
    let owner = null;
    for (const site of idSites) {
      if (site.at < index) owner = site;
      else break;
    }
    return owner;
  };
  const corpus = sourceFiles()
    .filter((f) => f !== SRC.dialogBus)
    .map((f) => ({ file: f, text: read(f) }));

  return files.map((file) => {
    const component = file.replace(/\.tsx$/, '');
    const opener = `open${component}`;
    const hasBus = new RegExp(`export function ${opener}\\(`).test(bus);
    const callRe = new RegExp(`${opener}\\(`, 'g');
    const commands = [];
    let dynamic = false;
    for (const call of menu.matchAll(callRe)) {
      const owner = commandAt(call.index);
      if (!owner) continue;
      if (owner.templated) dynamic = true;
      else if (!commands.includes(owner.id)) commands.push(owner.id);
    }
    // Step 3: a service function that opens it, and the command that calls
    // that function.
    const relays = [];
    if (commands.length === 0 && !dynamic) {
      for (const { file: srcFile, text } of corpus) {
        if (srcFile === SRC.menuActions) continue;
        for (const call of text.matchAll(new RegExp(`${opener}\\(`, 'g'))) {
          const fn = enclosingExport(text, call.index);
          if (!fn) continue;
          for (const hop of menu.matchAll(new RegExp(`\\b${fn}\\(`, 'g'))) {
            const owner = commandAt(hop.index);
            if (owner && !owner.templated && !relays.some((r) => r.command === owner.id)) {
              relays.push({ command: owner.id, via: `${path.basename(srcFile)}:${fn}` });
            }
          }
        }
      }
    }
    return { component, opener, hasBus, commands, dynamic, relays };
  });
}

/**
 * The module CARD's panel registry and which of them the strip draws an icon
 * for, both read out of `ModuleStrip.tsx`.
 *
 * U2: each entry now carries a `slot`, and the strip's ORDER is that slot's
 * rank in `STRIP_SLOT_ORDER` rather than the array's order — which is what
 * makes "Files first" and "History last" survive a new module being appended.
 * So this reads both, and returns the panels in the order the strip will draw
 * them, with `hasStripIcon` = "has a slot other than 'none'". (Before U2 the
 * exclusions were an id list inside `PERMANENT_TABS`; that filter is gone.)
 */
function modulePanels() {
  const src = read(SRC.moduleStrip);
  const from = src.indexOf('export const MODULE_PANELS');
  const to = src.indexOf('];', from);
  const block = src.slice(from, to);
  const panels = [
    ...block.matchAll(/id:\s*'([a-z]+)',\s*label:\s*'([^']+)',[^}]*slot:\s*'([a-z]+)'/g),
  ].map((m) => ({
    id: m[1],
    label: m[2],
    slot: m[3],
    hasStripIcon: m[3] !== 'none',
    // Drawn in EVERY state. A contextual entry (Remix) has an icon but only
    // while its condition holds, so the two questions are not the same one.
    permanent: m[3] !== 'none' && m[3] !== 'contextual',
  }));
  if (panels.length === 0) throw new Error('ModuleStrip.tsx: no MODULE_PANELS entries with a slot');

  const orderMatch = src.match(/STRIP_SLOT_ORDER[^=]*=\s*\[([^\]]+)\]/);
  if (!orderMatch) throw new Error('ModuleStrip.tsx: STRIP_SLOT_ORDER was not found');
  const rank = [...orderMatch[1].matchAll(/'([a-z]+)'/g)].map((m) => m[1]);

  // Strip order: slot rank first, declaration order within a rank.
  return panels
    .map((p, i) => ({ ...p, at: i }))
    .sort((a, b) => {
      const ra = rank.indexOf(a.slot);
      const rb = rank.indexOf(b.slot);
      if (ra !== rb) return (ra < 0 ? rank.length : ra) - (rb < 0 ? rank.length : rb);
      return a.at - b.at;
    })
    .map(({ at: _at, ...p }) => p);
}

/**
 * U2: the dialog COMPONENTS the module column hosts, read out of
 * `PipelineToolHost.tsx`'s own import list — the registry that decides it.
 *
 * The walk below needs this because the two presentations answer to different
 * evidence: a modal raises `[data-testid="dialog-overlay"]` and cancels on
 * Escape, a hosted tool raises `[data-testid="tool-host"]`, raises NO overlay
 * at all, and closes from its own ✕. Deriving the split means a tenth tool
 * moved into the host is walked the new way without editing this file.
 */
function hostedDialogComponents() {
  const src = read(path.join(SRC.dialogDir, 'PipelineToolHost.tsx'));
  const names = new Set(
    [...src.matchAll(/import\s+(\w+Dialog)\s+from\s+'\.\/\w+';/g)].map((m) => m[1])
  );
  if (names.size === 0) {
    throw new Error('PipelineToolHost.tsx: no hosted dialog components were found');
  }
  return names;
}

/** The editor views the toolbar's segmented control offers, in its own order. */
function editorViews() {
  const src = read(SRC.toolbar);
  const m = src.match(/\(\[([^\]]+)\] as const\)\.map\(\(v\)/);
  if (!m) throw new Error('Toolbar.tsx: the view segment array was not found');
  return [...m[1].matchAll(/'([a-z]+)'/g)].map((x) => x[1]);
}

// ---------------------------------------------------------------------------
// Page-side primitives
// ---------------------------------------------------------------------------

/** The bar button rects, keyed by title, so a menu can be opened with a REAL
 * pointer click rather than `page.click` on a selector. */
async function menuButtonBox(page, title) {
  return page.evaluate((t) => {
    const btn = [...document.querySelectorAll('.chrome-menu-btn')].find(
      (b) => b.textContent.trim() === t
    );
    if (!btn) return null;
    const r = btn.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, title);
}

async function openMenu(page, title) {
  const box = await menuButtonBox(page, title);
  if (!box) return false;
  await realClick(page, box.x, box.y);
  await page.waitForSelector(`[data-testid="menu-dropdown"][data-menu-title="${title}"]`, {
    timeout: 5000,
  });
  return true;
}

async function closeMenu(page) {
  await page.keyboard.press('Escape');
  await page.waitForFunction(
    () => document.querySelector('[data-testid="menu-dropdown"]') === null,
    null,
    { timeout: 5000 }
  );
}

/** Every row of the open dropdown: its label, its shortcut and whether it is
 * disabled. Separators are excluded (they are not items). */
async function readOpenMenu(page) {
  return page.evaluate(() => {
    const d = document.querySelector('[data-testid="menu-dropdown"]');
    if (!d) return null;
    return {
      title: d.getAttribute('data-menu-title'),
      items: [...d.querySelectorAll('button')].map((b) => ({
        label: b.querySelector('span').textContent.trim(),
        disabled: b.disabled === true,
      })),
      separators: d.querySelectorAll('div.h-px').length,
    };
  });
}

/** Clicks a row of the OPEN dropdown by its label, with a real pointer. Returns
 * false when the row is absent or disabled — a disabled row must not be
 * clicked, and a caller that expected one is asserting about the wrong state. */
async function clickMenuItem(page, label) {
  const box = await page.evaluate((want) => {
    const d = document.querySelector('[data-testid="menu-dropdown"]');
    if (!d) return null;
    const btn = [...d.querySelectorAll('button')].find(
      (b) => b.querySelector('span').textContent.trim() === want
    );
    if (!btn || btn.disabled) return null;
    // A long menu scrolls; a row below the fold has to be brought into view
    // before its rect means anything.
    btn.scrollIntoView({ block: 'nearest' });
    const r = btn.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, label);
  if (!box) return false;
  await realClick(page, box.x, box.y);
  return true;
}

/**
 * The surface a command can actually be fired from, searched in the order a
 * user would find one: the menu bar first, then the toolbar pill, then the
 * Effects card's tool rows. Returns null when none of the three carries it —
 * which for a dialog-opening command is a real finding, not a harness gap.
 */
async function resolveOpener(page, commandId, label, menuLabelIndex) {
  if (label !== undefined && menuLabelIndex.has(label)) {
    const where = menuLabelIndex.get(label);
    return { kind: 'menu', title: where.title, disabled: where.disabled };
  }
  const toolbar = await page.evaluate((want) => {
    const b = document.querySelector(`[data-testid="toolbar-pill"] button[aria-label="${want}"]`);
    return b ? { disabled: b.disabled === true } : null;
  }, label);
  if (toolbar) return { kind: 'toolbar', title: null, disabled: toolbar.disabled };
  const card = await page.evaluate((id) => {
    const b = document.querySelector(`[data-testid="effects-tool-item"][data-command-id="${id}"] button`);
    return b ? { disabled: b.disabled === true } : null;
  }, commandId);
  if (card) return { kind: 'effects-card', title: null, disabled: card.disabled, commandId };
  return null;
}

/** Fires the gesture `resolveOpener` found, with a real pointer in every case. */
async function invokeOpener(page, opener, label) {
  if (opener.kind === 'menu') {
    if (!(await openMenu(page, opener.title))) return false;
    return clickMenuItem(page, label);
  }
  const selector =
    opener.kind === 'toolbar'
      ? `[data-testid="toolbar-pill"] button[aria-label="${label}"]`
      : `[data-testid="effects-tool-item"][data-command-id="${opener.commandId}"] button`;
  const box = await page.evaluate((sel) => {
    const b = document.querySelector(sel);
    if (!b || b.disabled) return null;
    const r = b.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, selector);
  if (!box) return false;
  await realClick(page, box.x, box.y);
  return true;
}

/**
 * Cancels the open dialog with Escape, and reports what it took.
 *
 * A single press is not enough for every dialog, and that is the dialogs being
 * RIGHT rather than the walker being flaky: `dismissable={!busy}` (M7/F12) makes
 * a dialog veto Escape while it has work in flight, so neither a stray key nor
 * a backdrop click can discard it. RemixDialog and TempoDialog both start a
 * tempo analysis the moment they mount, so both are briefly un-cancellable by
 * design. Pressing until it takes measures the real behaviour instead of
 * assuming an idle dialog; `presses > 1` is the observation that the veto was
 * exercised, and it is logged rather than swallowed.
 *
 * M4: it checks the dialog is THERE first. Without that the loop's very first
 * `waitForFunction` resolves against an overlay that never existed, so the
 * helper returned `{ presses: 1 }` after 14 ms having closed nothing — measured,
 * not reasoned. That is how the Transcript step came to "cancel" a hosted tool
 * that has no overlay at all and walk away leaving it open, and it is the same
 * defect `closeHostedTool` was hardened against one function below. A caller
 * that reaches here with nothing open has a bug wherever it thinks it opened
 * something, so this throws rather than passing quietly.
 */
async function cancelDialog(page, timeoutMs = 120000) {
  const present = await page.evaluate(
    () => document.querySelector('[data-testid="dialog-overlay"]') !== null
  );
  if (!present) {
    const hosted = await page.evaluate(
      () => document.querySelector('[data-testid="tool-host"]') !== null
    );
    throw new Error(
      'cancelDialog: no dialog-overlay is open, so Escape would report success having closed ' +
        `nothing${hosted ? ' — a hosted tool IS open; use dismissOpenTool, which closes both presentations' : ''}`
    );
  }
  const started = Date.now();
  let presses = 0;
  while (Date.now() - started < timeoutMs) {
    await page.keyboard.press('Escape');
    presses += 1;
    const closed = await page
      .waitForFunction(
        () => document.querySelector('[data-testid="dialog-overlay"]') === null,
        null,
        { timeout: 1500 }
      )
      .then(() => true)
      .catch(() => false);
    if (closed) return { presses, ms: Date.now() - started };
  }
  throw new Error(`the dialog refused Escape for ${timeoutMs} ms (${presses} presses)`);
}

/**
 * U2: the hosted equivalent — a pipeline tool closes from the ✕ in its own
 * header, not from Escape.
 *
 * That is deliberate rather than an omission: a hosted tool installs no
 * document-level Escape handler, because Escape belongs to the stage (it clears
 * the selection there) and a card that swallowed it would be a focus trap
 * wearing a different shape. The ✕ carries the SAME veto the modal backdrop
 * had — it is `disabled` while `dismissable` is false — so this loop clicks
 * until it takes, exactly as `cancelDialog` presses until it takes, and
 * `presses > 1` is the same observation that the veto was exercised.
 */
async function closeHostedTool(page, timeoutMs = 120000) {
  const started = Date.now();
  let presses = 0;
  while (Date.now() - started < timeoutMs) {
    const clicked = await page.evaluate(() => {
      const b = document.querySelector('[data-testid="hosted-tool-close"]');
      if (!b || b.disabled) return false;
      b.click();
      return true;
    });
    if (clicked) presses += 1;
    const closed = await page
      .waitForFunction(() => document.querySelector('[data-testid="tool-host"]') === null, null, {
        timeout: 1500,
      })
      .then(() => true)
      .catch(() => false);
    if (closed) return { presses, ms: Date.now() - started };
  }
  throw new Error(`the hosted tool refused its ✕ for ${timeoutMs} ms (${presses} clicks)`);
}

/** U2: closes whichever presentation is open — a modal or a hosted tool. */
async function dismissOpenTool(page, timeoutMs = 120000) {
  const hosted = await page.evaluate(
    () => document.querySelector('[data-testid="tool-host"]') !== null
  );
  return hosted ? closeHostedTool(page, timeoutMs) : cancelDialog(page, timeoutMs);
}

/** The open dialog's accessible identity, or null. `role="dialog"` plus its
 * `aria-label` is what a screen reader would announce, so it is what the walk
 * asserts on rather than a class name. */
async function openDialogInfo(page) {
  return page.evaluate(() => {
    const overlays = [...document.querySelectorAll('[data-testid="dialog-overlay"]')];
    if (overlays.length === 0) return null;
    const top = overlays[overlays.length - 1];
    const panel = top.querySelector('[role="dialog"]');
    return {
      count: overlays.length,
      label: panel ? panel.getAttribute('aria-label') : null,
      // The evidence that a body rendered is its CONTROLS, not its testids.
      // T4 gave New File and Export the testids they were missing, so the two
      // dialogs that used to have none or nearly none now have them — but the
      // rule stands for the roster as a whole: a testid COUNT is a claim about
      // how a dialog was written, and a dialog can render its body perfectly
      // without carrying one on every control.
      controls: panel ? panel.querySelectorAll('button, input, select, textarea').length : 0,
      testids: [...top.querySelectorAll('[data-testid]')]
        .map((e) => e.getAttribute('data-testid'))
        .filter((t) => t !== 'dialog-icon'),
    };
  });
}

/**
 * U2: the same identity for a HOSTED tool, plus the claim the change is about —
 * that no backdrop was raised over the stage.
 *
 * The accessible identity differs on purpose and the walk asserts the
 * difference: hosted, the shell is a `region` with the tool's name, not a
 * `dialog`, because it is not modal and announcing it as one would tell a
 * screen-reader user the rest of the app had gone away when it has not.
 */
async function openToolInfo(page) {
  return page.evaluate(() => {
    const hosts = [...document.querySelectorAll('[data-testid="tool-host"]')];
    if (hosts.length === 0) return null;
    const top = hosts[hosts.length - 1];
    const panel = top.querySelector('[data-testid="hosted-tool"]');
    return {
      count: hosts.length,
      commandId: top.getAttribute('data-tool-id'),
      label: panel ? panel.getAttribute('aria-label') : null,
      role: panel ? panel.tagName.toLowerCase() : null,
      controls: panel ? panel.querySelectorAll('button, input, select, textarea').length : 0,
      // The claim: the stage is not covered.
      overlays: document.querySelectorAll('[data-testid="dialog-overlay"]').length,
      modalRoles: top.querySelectorAll('[role="dialog"]').length,
      width: Math.round(top.getBoundingClientRect().width),
      testids: [...top.querySelectorAll('[data-testid]')]
        .map((e) => e.getAttribute('data-testid'))
        .filter((t) => t !== 'dialog-icon'),
    };
  });
}

/**
 * Waits until the editor viewport has stopped moving on its own.
 *
 * This is a measurement fix, not a softened assertion, and the distinction
 * matters. A FITTED document re-fits whenever the lane's width changes
 * (F11-3 — `publishEditorLaneWidth` feeds the real measured width back into
 * the zoom), and the width changes whenever the module card opens or closes —
 * which this walker's own liveness probe does after every step. That re-fit
 * lands a frame or two later, so a snapshot taken immediately after the probe
 * can straddle it and report a difference the step under test did not cause.
 *
 * Settling waits for the app to finish a change it had already started. It
 * cannot hide a change a dialog makes, because that change would still be
 * there once the viewport is stable.
 */
async function settleLayout(page, timeoutMs = 6000) {
  const started = Date.now();
  let last = null;
  let stable = 0;
  while (Date.now() - started < timeoutMs) {
    await page.evaluate(
      () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
    );
    const now = await page.evaluate(() => {
      const v = window.__test.getEditorViewState();
      return `${v.samplesPerPixel}|${v.scrollSample}`;
    });
    if (now === last) {
      stable += 1;
      if (stable >= 2) return true;
    } else {
      stable = 0;
      last = now;
    }
  }
  throw new Error(`settleLayout: the editor viewport was still moving after ${timeoutMs} ms`);
}

/**
 * The store snapshot a dialog CANCEL has to leave byte-identical.
 *
 * Three views of the app's state, stringified together: the document summary,
 * the editor viewport (cursor, selection, zoom, scroll) and the undo/redo
 * stacks. Cancel is a promise about all three — a dialog that quietly moved the
 * cursor or pushed a history entry on its way out has broken it.
 */
async function storeSnapshot(page) {
  await settleLayout(page);
  return page.evaluate(() =>
    JSON.stringify({
      state: window.__test.getStateSummary(),
      view: window.__test.getEditorViewState(),
      history: window.__test.getHistoryState(),
    })
  );
}

/** The anti-vacuous guard for every byte comparison of a snapshot: two EMPTY
 * states also compare equal, so a snapshot only counts as evidence once it is
 * carrying something a cancel could plausibly have damaged. */
function snapshotIsSubstantive(json) {
  const s = JSON.parse(json);
  return (
    s.state.docCount > 0 &&
    typeof s.state.activeName === 'string' &&
    s.state.length > 0 &&
    Number.isFinite(s.view.samplesPerPixel) &&
    s.view.samplesPerPixel > 0
  );
}

// ---------------------------------------------------------------------------
// Liveness
// ---------------------------------------------------------------------------

let stepIndex = 0;

/**
 * The probe run after EVERY step.
 *
 * Four questions, each of which a differently-broken app answers wrongly:
 *  1. Do two real animation frames land? A wedged renderer or a runaway
 *     synchronous loop never resolves this, and the timeout names the step.
 *  2. Does the store answer? A crashed React tree still has a live rAF loop.
 *  3. Is anything left open? A step that walked away from a dialog or a
 *     dropdown has not finished; the NEXT step would then run behind a modal
 *     overlay and pass for the wrong reason.
 *  4. Does a REAL pointer click still drive a React round trip? The module
 *     card's own close button removes the card and the strip entry puts it
 *     back — a full commit both ways, driven through the browser's input path,
 *     and it ends where it began so the walk's state is untouched.
 */
async function liveness(page, label) {
  await Promise.race([
    page.evaluate(
      () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))
    ),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`liveness: no animation frame within 8 s after "${label}"`)), 8000)
    ),
  ]);

  const summary = await page.evaluate(() => window.__test.getStateSummary());
  if (!summary || typeof summary.docCount !== 'number') {
    throw new Error(`liveness: the store did not answer after "${label}"`);
  }

  // U2: a hosted pipeline tool counts as left-open too. It raises no backdrop,
  // so the overlay count alone would miss it, and a step that walks away from
  // one has left the next step a card it did not expect.
  const stray = await page.evaluate(() => ({
    dialogs: document.querySelectorAll('[data-testid="dialog-overlay"]').length,
    menus: document.querySelectorAll('[data-testid="menu-dropdown"]').length,
    tools: document.querySelectorAll('[data-testid="tool-host"]').length,
    // T4: the crash surface. It is a full-screen overlay, so a step that raised
    // one would fail the NEXT step with a click that landed on nothing — a
    // symptom several removes from the cause. Read here so the run stops on the
    // step that crashed and prints the error text the card is showing.
    crash: document.querySelector('[data-testid="crash-detail"]')?.textContent ?? null,
  }));
  if (stray.crash !== null) {
    throw new Error(
      `liveness: "${label}" raised the crash card — an exception reached the app shell:\n${stray.crash}`
    );
  }
  if (stray.dialogs !== 0 || stray.menus !== 0 || stray.tools !== 0) {
    throw new Error(
      `liveness: "${label}" left ${stray.dialogs} dialog(s), ${stray.menus} menu(s) and ` +
        `${stray.tools} hosted tool(s) open`
    );
  }

  const tab = await page.evaluate(() =>
    document.querySelector('[data-testid="sidebar-panel"]')?.getAttribute('data-active-tab')
  );
  if (tab) {
    const closeBox = await page.evaluate(() => {
      const b = document.querySelector('[data-testid="sidebar-panel-close"]');
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    if (!closeBox) throw new Error(`liveness: the open ${tab} card has no close button after "${label}"`);
    await realClick(page, closeBox.x, closeBox.y);
    await page.waitForFunction(
      () => document.querySelector('[data-testid="sidebar-panel"]') === null,
      null,
      { timeout: 5000 }
    );
    // Put it back exactly as it was. Panels the strip draws no icon for
    // (Spatial, Transcript) have no entry to click, so the walk re-opens those
    // through their own command when it needs them; the repaint has already
    // been proved by the close.
    const hasIcon = await page.evaluate(
      (t) => Boolean(document.querySelector(`[data-testid="sidebar-tabs"] button[aria-label="${t}"]`)),
      tab.charAt(0).toUpperCase() + tab.slice(1)
    );
    if (hasIcon) {
      await page.click(
        `[data-testid="sidebar-tabs"] button[aria-label="${tab.charAt(0).toUpperCase() + tab.slice(1)}"]`
      );
      await page.waitForSelector(`[data-testid="sidebar-panel"][data-active-tab="${tab}"]`, {
        timeout: 5000,
      });
    }
  }
}

/** Runs one step and then the liveness probe. Every surface in the walk goes
 * through here, so the probe cannot be forgotten for one of them. */
async function step(page, name, fn) {
  stepIndex += 1;
  console.log(`\n[${String(stepIndex).padStart(2, '0')}] ${name}`);
  await fn();
  await liveness(page, name);
}

// ---------------------------------------------------------------------------
// Native dialog stubs (main process)
// ---------------------------------------------------------------------------

/**
 * Replaces the three native OS dialogs with recording stubs, IN THE MAIN
 * PROCESS.
 *
 * Why this is necessary: `dialog.showSaveDialog` and friends are modal on the
 * main process. A real one opened by this walk would block Electron with an OS
 * window no harness can reach, and the run would hang until its timeout. Every
 * command that ends in one — Open…, Save As…, Save Session…, Open Session…,
 * About, Capture Noise Print — would therefore be unwalkable.
 *
 * Why it is honest: `electron/ipc.cjs` destructures `dialog` from the electron
 * module at load, so it holds a reference to the very object patched here — the
 * stub is what the app's own IPC handler calls, not a shim beside it. What the
 * walk then proves is the RENDERER-side path: the command fires, the IPC round
 * trip completes, the cancel answer is handled, and the app is unchanged
 * afterwards. What it does NOT prove is the OS widget itself — the filters, the
 * default path, the picker's own behaviour. That half is not observable from
 * any harness and is stated as such in the report rather than implied by a
 * green line here.
 *
 * `__navMessageResponse` lets a step choose which button a message box
 * "returns" (the close prompt offers Save / Don't Save / Cancel), so the walk
 * can steer a flow instead of always taking button 0.
 */
async function stubNativeDialogs(app) {
  await app.evaluate(({ dialog }) => {
    globalThis.__navDialogCalls = [];
    globalThis.__navMessageResponse = 0;
    dialog.showOpenDialog = async (_win, opts) => {
      globalThis.__navDialogCalls.push({ kind: 'open', opts: JSON.parse(JSON.stringify(opts ?? {})) });
      return { canceled: true, filePaths: [] };
    };
    dialog.showSaveDialog = async (_win, opts) => {
      globalThis.__navDialogCalls.push({ kind: 'save', opts: JSON.parse(JSON.stringify(opts ?? {})) });
      return { canceled: true, filePath: undefined };
    };
    dialog.showMessageBox = async (_win, opts) => {
      globalThis.__navDialogCalls.push({
        kind: 'message',
        title: opts && opts.title,
        buttons: (opts && opts.buttons) || [],
      });
      return { response: globalThis.__navMessageResponse };
    };
  });
}

async function nativeCalls(app) {
  return app.evaluate(() => globalThis.__navDialogCalls);
}

async function resetNativeCalls(app) {
  await app.evaluate(() => {
    globalThis.__navDialogCalls = [];
  });
}

// ---------------------------------------------------------------------------
// The walk
// ---------------------------------------------------------------------------

const coverage = [];
/** M4: how many real selects the PANEL sweeps saw, kept module-wide because the
 * dialog walk's own counter is scoped to that step. Asserted non-zero once both
 * panels have been walked, so the panel half cannot go vacuous either. */
let panelSelectsSwept = 0;
/** T4: how many selects the Properties card mounted with a DOCUMENT showing.
 * The control for the clip arm below — the fade-curve pickers exist only in the
 * clip view, so this is the number that arm has to beat for its sweep to be
 * about anything. */
let propertiesDocumentSelects = -1;
/**
 * MT1 — every `<select>` currently on screen must have an OPAQUE background.
 *
 * Called with something MOUNTED, because a sweep run over an empty screen checks
 * nothing. That means three places, not one: the dialog walk (the Cover Chain
 * pickers — the reported repro), the Properties card (its fade-curve picker) and
 * the Spatial card (its track picker).
 *
 * M4 added the latter two. This docblock already NAMED them while the only call
 * site was inside the dialog walk, where neither panel is mounted — so the two
 * selects it claimed to cover were swept by nothing, and the claim read as
 * coverage that did not exist.
 *
 * Chromium paints a select's dropdown popup with the author's background but as
 * its own widget off the glass surface, so a translucent tint that reads dark on
 * the stage composites near-white in the popup, under text coloured for
 * near-black. Opacity is therefore the property under test — not the colour.
 *
 * Returns how many selects it saw, so the caller can prove the sweep was not
 * vacuous over the whole run.
 */
async function sweepSelects(page, where) {
  const found = await page.evaluate(() => {
    const opaque = (c) => !/rgba\([^)]*,\s*(?:0?\.\d+|0)\s*\)/.test(c) && c !== 'transparent';
    return [...document.querySelectorAll('select')].map((s) => ({
      id: s.dataset.testid || s.getAttribute('aria-label') || '(unlabelled)',
      bg: getComputedStyle(s).backgroundColor,
      opaque: opaque(getComputedStyle(s).backgroundColor),
    }));
  });
  const translucent = found.filter((s) => !s.opaque);
  assert(
    translucent.length === 0,
    `every select in ${where} is opaque — a translucent one is the reported bug ` +
      `(${JSON.stringify(translucent)})`
  );
  return found.length;
}

function record(surface, stepName, verdict) {
  coverage.push({ surface, step: stepName, verdict });
}

async function main() {
  ensureFixtures([
    [TONE, 'make-test-tone.cjs', 'test tone'],
    [BEAT, 'make-test-beat.cjs', '120 BPM click train'],
    [SWEEP, 'make-test-sweep.cjs', 'effect-sweep fixture'],
    [ABAB, 'make-test-abab.cjs', 'ABAB structure fixture'],
  ]);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_NOT_AUDIO, 'this is not audio, and opening it must fail cleanly\n');

  const derivedMenus = layoutMenuTitles();
  const derivedDialogs = dialogOpenPaths();
  const derivedPanels = modulePanels();
  const derivedViews = editorViews();
  // U2: which dialog components open HOSTED in the module column rather than as
  // a modal, read out of PipelineToolHost's import list.
  const hostedComponents = hostedDialogComponents();
  console.log('Derived from the registries:');
  console.log(`  menu sections : ${derivedMenus.join(', ')}`);
  console.log(
    `  dialogs       : ${derivedDialogs
      .map((d) => `${d.component}${hostedComponents.has(d.component) ? '^' : ''}`)
      .join(', ')} (^ = hosted in the module column, not a modal)`
  );
  console.log(`  module panels : ${derivedPanels.map((p) => `${p.label}${p.hasStripIcon ? '' : '*'}`).join(', ')} (* = no strip icon)`);
  console.log(`  editor views  : ${derivedViews.join(', ')}`);

  console.log('\nLaunching built app under Playwright Electron...');
  const { app, page } = await launchApp();

  try {
    const geom = await pinWindowGeometry(app, SMOKE_WINDOW);
    assert(
      geom !== null &&
        Math.abs(geom.contentWidth - SMOKE_WINDOW.width) <= SMOKE_WINDOW_TOLERANCE_PX &&
        Math.abs(geom.contentHeight - SMOKE_WINDOW.height) <= SMOKE_WINDOW_TOLERANCE_PX,
      `the window pinned to ${SMOKE_WINDOW.width}x${SMOKE_WINDOW.height} ` +
        `(actual ${geom && geom.contentWidth}x${geom && geom.contentHeight})`
    );
    await stubNativeDialogs(app);

    // MT1: native `<select>` popups, asserted as far as a rig honestly can.
    //
    // The report was "light gray text on white" on Cover Chain's Reference
    // picker. The cause was three selects carrying a translucent white
    // background (`rgba(255,255,255,.04/.05/.06)`): Chromium paints the dropdown
    // listbox with the author's background but NOT on the glass surface, so a
    // tint that composites dark on the stage composites near-white in the popup,
    // under text coloured for near-black. The root's `color-scheme: dark` — the
    // thing the report was originally filed against — was already present and
    // never governed a select that styles its own background.
    //
    // WHAT THIS CANNOT DO, stated plainly: the popup is an OS-level widget with
    // no DOM, so Playwright cannot open it, query it or screenshot it. There is
    // no assertion available anywhere in this repo that observes the reported
    // pixel. What IS observable is the input to the rule — real Chromium's
    // computed styles for the root, for every select on screen, and for a probe
    // select that exercises the stylesheet's element rule — and that is what
    // runs below. jsdom cannot even do that much: `index.css` is mapped to
    // `identity-obj-proxy` under jest, so the unit-side law
    // (`src/components/UI/nativeSelect.test.tsx`) is a source scan instead.
    await step(page, 'MT1 — selects declare a dark scheme and an opaque background', async () => {
      const probe = await page.evaluate(() => {
        const opaque = (c) => !/rgba\([^)]*,\s*(?:0?\.\d+|0)\s*\)/.test(c) && c !== 'transparent';
        // A bare select, styled only by the stylesheet: this is what a select
        // added later — one that never styles itself — will look like.
        const el = document.createElement('select');
        const opt = document.createElement('option');
        opt.textContent = 'probe';
        el.appendChild(opt);
        document.body.appendChild(el);
        const probeStyle = getComputedStyle(el);
        const optStyle = getComputedStyle(opt);
        const result = {
          rootScheme: getComputedStyle(document.documentElement).colorScheme,
          probeScheme: probeStyle.colorScheme,
          probeBg: probeStyle.backgroundColor,
          probeBgOpaque: opaque(probeStyle.backgroundColor),
          optionBg: optStyle.backgroundColor,
          optionBgOpaque: opaque(optStyle.backgroundColor),
          // The probe's single option is also its SELECTED one, so this reads
          // the `option:checked` rule — which is the row the user looks at when
          // the popup opens, and the one that was still translucent after the
          // first pass (`var(--accent-soft)`).
          checkedOption: opt.selected,
          checkedOptionBg: optStyle.backgroundColor,
          checkedOptionBgOpaque: opaque(optStyle.backgroundColor),
        };
        el.remove();
        return result;
      });
      assert(probe.rootScheme === 'dark', `the root declares color-scheme: dark (${probe.rootScheme})`);
      assert(
        probe.probeScheme === 'dark',
        `an unstyled select inherits the dark scheme (${probe.probeScheme})`
      );
      assert(
        probe.probeBgOpaque,
        `an unstyled select gets an OPAQUE background from the stylesheet (${probe.probeBg})`
      );
      assert(probe.optionBgOpaque, `its option row gets an opaque background too (${probe.optionBg})`);
      assert(probe.checkedOption, 'the probe option is the SELECTED one, so the next line reads option:checked');
      assert(
        probe.checkedOptionBgOpaque,
        `the CHECKED option row is opaque (${probe.checkedOptionBg}) — the row the user is ` +
          `looking at when the popup opens, and the last translucent one left after the first pass`
      );
      // The sweep over REAL selects is deliberately NOT here. Nothing has opened
      // a dialog or a panel yet at this point in the walk, so
      // `querySelectorAll('select')` returns NOTHING and an "every select on
      // screen is opaque" claim would pass by having no select to check — which
      // is what the first version of this step did. It runs per-dialog instead
      // (`sweepSelects`), where selects actually exist, and the cumulative count
      // is asserted non-zero once the dialog walk is done.
    });

    // =====================================================================
    // PRIORITY ZERO — the three observation debts, walked first
    // =====================================================================

    // U2: the app's FIRST PAINT, asserted before anything opens a card or a
    // document — the only moment "the app opens with Files" is observable, and
    // the reason this sits above the priority-zero block rather than beside the
    // module-strip step far below (by then a dozen steps have opened and closed
    // cards, and the liveness guard has closed whatever was left).
    await step(page, 'U2 — the app opens with the Files card, before anything else runs', async () => {
      const first = await page.evaluate(() => ({
        tab: document.querySelector('[data-testid="sidebar-panel"]')?.getAttribute('data-active-tab') ?? null,
        icons: [...document.querySelectorAll('[data-testid="sidebar-tabs"] button')].map((b) =>
          b.getAttribute('aria-label')
        ),
      }));
      const lead = derivedPanels.find((p) => p.slot === 'lead');
      assert(
        lead !== undefined && first.tab === lead.id,
        `the module card opens on the strip registry's LEAD entry ` +
          `(expected ${lead && lead.id}, actual ${first.tab})`
      );
      assert(first.tab === 'files', `and that entry is Files, as the user asked (${first.tab})`);
      assert(
        first.icons[0] === 'Files' && first.icons[first.icons.length - 1] === 'History',
        `the strip opens Files-first and History-last (${JSON.stringify(first.icons)})`
      );
      record('U2 first paint', `card '${first.tab}', strip ${first.icons.join(' > ')}`, 'PASS');
    });

    // The empty-app menu snapshot has to be taken before any document exists,
    // and it is the "before" half of the differential the menu step asserts on.
    const emptyMenus = {};
    for (const title of derivedMenus) {
      if (!(await openMenu(page, title))) continue;
      emptyMenus[title] = await readOpenMenu(page);
      await closeMenu(page);
    }

    await page.evaluate((p) => window.__test.openPath(p), BEAT);
    await page.waitForSelector('[data-testid="waveform-canvas"]', { timeout: 15000 });
    await waitNonUniform(page, 'waveform-canvas');

    await step(page, 'P0-1 — the Measuring paint, through the REAL dialog path', async () => {
      // What this is for. P1 made every chain stage announce `measuring` and
      // then YIELD, so the row is painted before the measurement blocks the
      // thread. Nothing has ever observed it: jsdom has no paint, and both
      // `testHooks.runVocalChain` and the smoke drive the chain with NO
      // progress callbacks at all — and `announceMeasuring` is gated on the
      // callback being present, so in those runs the yield does not even
      // execute. The dialog is the only caller that passes `onStageProgress`,
      // so this is the first and only place the mechanism can be seen.
      //
      // The recorder is a MutationObserver installed BEFORE Apply. Polling
      // would be the wrong instrument: the measuring paint is one frame, and a
      // poll that missed it would report a false negative that looks exactly
      // like a real regression. The observer sees every commit, and a
      // continuously-incrementing frame counter is captured with each one, so
      // the walk can say not just "both words appeared in order" but "a frame
      // was rendered between them" — which is the actual claim P1 makes.
      await page.evaluate(() => {
        const rec = { events: [], frames: 0, last: new Map() };
        globalThis.__navChain = rec;
        const tick = () => {
          rec.frames += 1;
          rec.raf = requestAnimationFrame(tick);
        };
        rec.raf = requestAnimationFrame(tick);
        const scan = () => {
          for (const el of document.querySelectorAll('[data-testid^="vocal-chain-activity-"]')) {
            const id = el.getAttribute('data-testid').replace('vocal-chain-activity-', '');
            const text = el.textContent.trim();
            if (rec.last.get(id) === text) continue;
            rec.last.set(id, text);
            rec.events.push({ id, text, frame: rec.frames, t: performance.now() });
          }
        };
        rec.observer = new MutationObserver(scan);
        rec.observer.observe(document.body, {
          childList: true,
          subtree: true,
          characterData: true,
        });
        scan();
      });

      assert(await openMenu(page, 'Pipeline'), 'the Pipeline menu opens on a real click');
      assert(
        await clickMenuItem(page, 'Vocal Chain'),
        'Vocal Chain is enabled in the Pipeline menu and takes a real click'
      );
      await page.waitForSelector('[data-testid="vocal-chain-dialog"]', { timeout: 5000 });
      record('Pipeline > Vocal Chain', 'opened from the real menu', 'PASS');

      // Pitch Correct is 55 % of the pass and has nothing to correct on a click
      // train — switched off for runtime, exactly as the smoke's own chain step
      // does. Every other stage still measures, which is all this assertion
      // needs.
      await page.click('[data-testid="vocal-chain-toggle-pitch"]');
      await page.click('[data-testid="vocal-chain-apply"]');
      await page.waitForSelector('[data-testid="vocal-chain-outcome"]', { timeout: 240000 });

      const rec = await page.evaluate(() => {
        const r = globalThis.__navChain;
        r.observer.disconnect();
        cancelAnimationFrame(r.raf);
        return { events: r.events, frames: r.frames };
      });
      console.log(`  recorded ${rec.events.length} activity-row transitions over ${rec.frames} frames`);
      for (const e of rec.events) {
        console.log(`    f${String(e.frame).padStart(5)} ${e.id}: ${e.text}`);
      }

      const outcome = await page.evaluate(
        () => document.querySelector('[data-testid="vocal-chain-outcome"]').textContent
      );
      assert(
        /Applied in /.test(outcome),
        `the chain ran and committed through the dialog (outcome ${JSON.stringify(outcome)})`
      );

      // The assertion the brief exists for. Per stage, the FIRST 'Measuring'
      // and the FIRST 'Rendering'; a stage counts only if it had both.
      const perStage = new Map();
      for (const e of rec.events) {
        const phase = e.text.startsWith('Measuring') ? 'measuring' : e.text.startsWith('Rendering') ? 'rendering' : null;
        if (!phase) continue;
        const s = perStage.get(e.id) ?? {};
        if (s[phase] === undefined) s[phase] = e;
        perStage.set(e.id, s);
      }
      const measuredOnly = [...perStage.entries()].filter(([, s]) => s.measuring && !s.rendering);
      const both = [...perStage.entries()].filter(([, s]) => s.measuring && s.rendering);
      console.log(
        `  stages that painted Measuring then Rendering: ${both.map(([id]) => id).join(', ') || '(none)'}` +
          `; Measuring only (declined): ${measuredOnly.map(([id]) => id).join(', ') || '(none)'}`
      );

      assert(
        perStage.size > 0,
        `at least one stage row painted an activity line at all (rows seen: ${perStage.size})`
      );
      assert(
        both.length > 0,
        `a stage row read "Measuring" and LATER read "Rendering" — the phase the dialog shows before ` +
          `the measurement blocks (stages with both: ${both.map(([id]) => id).join(', ') || 'none'})`
      );
      for (const [id, s] of both) {
        assert(
          s.measuring.t < s.rendering.t,
          `${id}: Measuring was painted BEFORE Rendering (${s.measuring.t.toFixed(1)} ms < ${s.rendering.t.toFixed(1)} ms)`
        );
      }
      // The yield itself. Without `await yieldToPaint()` React would batch the
      // measuring state into the same commit as the rendering state and the row
      // would go straight to "Rendering" — so a frame boundary between the two
      // is the fix, not a side effect of it. At least one stage has to show it;
      // requiring it of EVERY stage would make the assertion hostage to a stage
      // whose measurement is faster than one frame.
      const yielded = both.filter(([, s]) => s.rendering.frame > s.measuring.frame);
      assert(
        yielded.length > 0,
        `at least one stage rendered a FRAME between its Measuring paint and its Rendering paint — ` +
          `the yield P1 added, not just the two strings in order ` +
          `(${yielded.map(([id, s]) => `${id} f${s.measuring.frame}→f${s.rendering.frame}`).join(', ') || 'none'})`
      );
      record('Vocal Chain stepper (P1)', 'Measuring painted, a frame passed, then Rendering', 'PASS');

      // Every enabled stage announces measuring, including the ones about to
      // decline — a decline is the verdict of a measurement that had to happen
      // first. So the union of both sets is every stage that was switched on.
      const enabledCount = await page.evaluate(
        () =>
          document.querySelectorAll('[data-testid^="vocal-chain-toggle-"]:checked').length
      );
      assert(
        perStage.size === enabledCount,
        `every switched-on stage announced itself, declines included ` +
          `(announced ${perStage.size}, switched on ${enabledCount})`
      );

      await page.click('[data-testid="vocal-chain-close"]');
      await page.waitForFunction(
        () => document.querySelector('[data-testid="vocal-chain-dialog"]') === null,
        null,
        { timeout: 5000 }
      );
      // The chain landed a real edit; the walk continues on a clean document.
      await page.evaluate(() => window.__test.undoActive());
    });

    await step(page, 'P0-2 — the file-drop bridge, as far as this harness can honestly go', async () => {
      // The honest statement, up front. F11's C1 fix is the APPROVAL gate on an
      // OS drop: a file dropped from Explorer is read only after main approves
      // its path. This harness runs with AUDITORIUM_TEST=1 and unpackaged,
      // which is exactly the configuration in which that gate is OPEN by
      // design (electron/prodGate.cjs). So the walker CANNOT prove the gate-ON
      // half, and does not try to. What it drives here is the other half that
      // has never been walked: a real `DataTransfer` carrying a real `File`
      // through the lane's own drop handler, ending in a document that landed.
      await page.evaluate(() => window.__test.newSession(44100));
      await page.evaluate(() => window.__test.setView('multitrack'));
      await page.waitForSelector('[data-testid="track-lane"]', { timeout: 5000 });

      // A FORGED File first — the one this bridge is built to refuse. The
      // preload's comment states the rule ("getPathForFile returns "" for any
      // File web content built itself, so a non-empty return is proof of a
      // genuine user drop"), and nothing had ever checked it from outside.
      const forged = await page.evaluate(async () => {
        const file = new File([new Uint8Array(64)], 'forged.wav', { type: 'audio/wav' });
        return window.electronAPI.pathForFile(file);
      });
      assert(
        forged === null,
        `a File the renderer built itself gets NO path from the bridge (actual ${JSON.stringify(forged)}) — ` +
          'the property the drop approval rests on'
      );

      // Now a REAL one. `setInputFiles` makes Chromium mint a File backed by an
      // actual filesystem entry, which is the only kind `webUtils.getPathForFile`
      // will resolve. This is as close to an OS drag as any harness gets.
      await page.evaluate(() => {
        const input = document.createElement('input');
        input.type = 'file';
        input.id = 'nav-file-input';
        input.style.position = 'fixed';
        input.style.left = '-9999px';
        document.body.appendChild(input);
      });
      await page.setInputFiles('#nav-file-input', SWEEP);
      const bridged = await page.evaluate(async () => {
        const file = document.querySelector('#nav-file-input').files[0];
        return { name: file.name, size: file.size, path: await window.electronAPI.pathForFile(file) };
      });
      console.log(`  bridge: ${bridged.name} (${bridged.size} bytes) → ${JSON.stringify(bridged.path)}`);
      assert(
        typeof bridged.path === 'string' && bridged.path.endsWith('sweep.wav'),
        `a disk-backed File resolves to its real path through the preload bridge (${JSON.stringify(bridged.path)})`
      );
      // What that non-null return PROVES about the approval IPC: `pathForFile`
      // awaits `ipcRenderer.invoke('file:approveDropped', p)` and returns null
      // if that invoke rejects. So a path came back only because main accepted
      // and registered the approval — the C1 fix's own round trip, observed.
      assert(
        forged === null && bridged.path !== null,
        'the bridge separates a genuine file from a forged one, and only the genuine one ' +
          'completed the file:approveDropped round trip in main'
      );

      const before = await page.evaluate(() => window.__test.getStateSummary().docCount);
      // The drag is dispatched in three calls rather than one, because the
      // ghost is a REACT commit: reading it in the same tick as the `dragover`
      // that causes it reads the DOM before React has rendered, and would
      // report zero for a ghost that works. The DataTransfer is parked on
      // `globalThis` so the same one survives across the three calls, exactly
      // as a real drag's does.
      const over = await page.evaluate(() => {
        const lane = document.querySelector('[data-testid="track-lane"]');
        const r = lane.getBoundingClientRect();
        const file = document.querySelector('#nav-file-input').files[0];
        const dt = new DataTransfer();
        dt.items.add(file);
        globalThis.__navDrag = {
          dt,
          at: {
            clientX: r.x + 40,
            clientY: r.y + r.height / 2,
            bubbles: true,
            cancelable: true,
          },
        };
        const at = globalThis.__navDrag.at;
        const carriesFiles = dt.types.includes('Files');
        lane.dispatchEvent(new DragEvent('dragenter', { ...at, dataTransfer: dt }));
        const ev = new DragEvent('dragover', { ...at, dataTransfer: dt });
        lane.dispatchEvent(ev);
        return { carriesFiles, accepted: ev.defaultPrevented };
      });
      await page.evaluate(
        () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
      );
      const ghosts = await page.evaluate(
        () => document.querySelectorAll('[data-testid="clip-drop-ghost"]').length
      );
      const dropped = await page.evaluate(() => {
        const lane = document.querySelector('[data-testid="track-lane"]');
        const { dt, at } = globalThis.__navDrag;
        lane.dispatchEvent(new DragEvent('drop', { ...at, dataTransfer: dt }));
        delete globalThis.__navDrag;
        return { ...at };
      });
      void dropped;
      assert(
        over.carriesFiles === true,
        "the DataTransfer carries the file (types include 'Files')"
      );
      assert(
        over.accepted === true,
        'the track lane ACCEPTS an external file drag (dragover was preventDefault-ed, so a drop can follow)'
      );
      assert(
        ghosts === 1,
        `the lane drew exactly one drop ghost while the drag was over it (${ghosts})`
      );
      await page.waitForFunction((n) => window.__test.getStateSummary().docCount > n, before, {
        timeout: 30000,
      });
      const after = await page.evaluate(() => window.__test.getStateSummary().docCount);
      assert(
        after === before + 1,
        `the dropped file decoded and landed as exactly one new document (${before} → ${after})`
      );
      const clips = await page.evaluate(
        () => document.querySelectorAll('[data-testid="clip"]').length
      );
      assert(clips >= 1, `the drop placed a clip on the lane (clips ${clips})`);
      await page.evaluate(() => document.querySelector('#nav-file-input').remove());
      record(
        'Track lane — external file drop',
        'forged File refused; disk-backed File bridged, approved and landed',
        'PASS (approval GATE itself off by design here — see report)'
      );
      console.log(
        '  NOTE: the read GATE is open in this harness by design (unpackaged + AUDITORIUM_TEST=1),\n' +
          '        so this proves the bridge and the approval round trip, NOT that a refusal would\n' +
          '        have happened without them. That half rests on electron/ipc.dropApproval.test.cjs\n' +
          '        plus one manual drag from Explorer.'
      );
      await page.evaluate(() => window.__test.setView('waveform'));
    });

    console.log(
      '\n[--] P0-3 — the dev-profiler shim (F11-0) is dev-only and never loads in a built app.\n' +
        '     OUT OF WALKER SCOPE by construction; its evidence is the unit suite and a dev session.'
    );
    record('Dev-profiler shim (F11-0)', 'not reachable from a built app', 'OUT OF SCOPE');

    // =====================================================================
    // 1. Every menu
    // =====================================================================

    await step(page, 'Every menu opens, renders its real enabled state, and displaces nothing', async () => {
      const barTitles = await page.evaluate(() =>
        [...document.querySelectorAll('.chrome-menu-btn')].map((b) => b.textContent.trim())
      );
      assert(
        JSON.stringify(barTitles) === JSON.stringify(derivedMenus),
        `the bar draws exactly the sections the LAYOUT table declares, in order ` +
          `(source ${JSON.stringify(derivedMenus)}, bar ${JSON.stringify(barTitles)})`
      );

      const scrollBefore = await page.evaluate(() => ({
        doc: document.documentElement.scrollHeight - document.documentElement.clientHeight,
        body: document.body.scrollHeight - document.body.clientHeight,
      }));
      const rootBefore = await page.evaluate(() => {
        const r = document.querySelector('[data-testid="app-root"]').getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height };
      });

      let totalItems = 0;
      let flippedTotal = 0;
      for (const title of barTitles) {
        assert(await openMenu(page, title), `the ${title} menu opens on a real click`);
        const open = await readOpenMenu(page);
        const geometry = await page.evaluate(() => {
          const d = document.querySelector('[data-testid="menu-dropdown"]');
          const r = d.getBoundingClientRect();
          const cs = getComputedStyle(d);
          const root = document.querySelector('[data-testid="app-root"]').getBoundingClientRect();
          return {
            position: cs.position,
            overflowY: cs.overflowY,
            bottom: r.bottom,
            viewportH: window.innerHeight,
            scrolls: d.scrollHeight > d.clientHeight + 1,
            scroll: {
              doc: document.documentElement.scrollHeight - document.documentElement.clientHeight,
              body: document.body.scrollHeight - document.body.clientHeight,
            },
            root: { x: root.x, y: root.y, w: root.width, h: root.height },
          };
        });
        totalItems += open.items.length;
        console.log(
          `  ${title}: ${open.items.length} items (${open.items.filter((i) => i.disabled).length} disabled), ` +
            `${open.separators} separators, ${geometry.scrolls ? 'scrolls' : 'fits'}, bottom ` +
            `${geometry.bottom.toFixed(0)}/${geometry.viewportH}`
        );
        assert(open.items.length > 0, `the ${title} menu is not empty (${open.items.length} items)`);
        assert(
          geometry.position === 'fixed' && geometry.overflowY === 'auto',
          `the ${title} dropdown is a fixed, self-scrolling overlay (actual ${geometry.position}/${geometry.overflowY})`
        );
        assert(
          geometry.bottom <= geometry.viewportH + 1,
          `the ${title} dropdown is clamped inside the window (bottom ${geometry.bottom.toFixed(0)} <= ${geometry.viewportH})`
        );
        assert(
          geometry.scroll.doc <= scrollBefore.doc && geometry.scroll.body <= scrollBefore.body,
          `opening ${title} adds NO scrollable space to the app (document ${scrollBefore.doc}→${geometry.scroll.doc}, ` +
            `body ${scrollBefore.body}→${geometry.scroll.body})`
        );
        assert(
          geometry.root.x === rootBefore.x &&
            geometry.root.y === rootBefore.y &&
            geometry.root.w === rootBefore.w &&
            geometry.root.h === rootBefore.h,
          `opening ${title} does not displace the app layout by a single pixel ` +
            `(${JSON.stringify(rootBefore)} vs ${JSON.stringify(geometry.root)})`
        );

        // The enabled-state differential. Comparing the menu against itself
        // would be a tautology; comparing the EMPTY app against the app with a
        // document open is a claim the predicates have to satisfy.
        const empty = emptyMenus[title];
        assert(
          empty !== undefined &&
            JSON.stringify(empty.items.map((i) => i.label)) ===
              JSON.stringify(open.items.map((i) => i.label)),
          `${title}'s ROSTER does not depend on whether a document is open ` +
            `(${empty ? empty.items.length : 'n/a'} vs ${open.items.length} items)`
        );
        const wasDisabled = new Set(empty.items.filter((i) => i.disabled).map((i) => i.label));
        const nowDisabled = new Set(open.items.filter((i) => i.disabled).map((i) => i.label));
        const regressed = [...nowDisabled].filter((l) => !wasDisabled.has(l));
        assert(
          regressed.length === 0,
          `no ${title} item became DISABLED by opening a document (${JSON.stringify(regressed)})`
        );
        const flipped = [...wasDisabled].filter((l) => !nowDisabled.has(l));
        flippedTotal += flipped.length;
        record(`Menu: ${title}`, `${open.items.length} items, ${flipped.length} enabled by a document`, 'PASS');
        await closeMenu(page);
      }
      assert(
        totalItems > 40,
        `the walk read every item of every menu (${totalItems} items across ${barTitles.length} sections)`
      );
      assert(
        flippedTotal > 0,
        `opening a document ENABLED menu items that were greyed in the empty app (${flippedTotal}) — ` +
          'so the rendered disabled flags track the live predicates rather than being painted on'
      );
    });

    // =====================================================================
    // 2. Every dialog: open from its real command, cancel, store byte-stable
    // =====================================================================

    await step(page, 'Every dialog in src/components/Dialogs has a reachable open path', async () => {
      for (const d of derivedDialogs) {
        assert(
          d.hasBus,
          `${d.component} is opened through dialogBus (${d.opener}) rather than by a component reaching into App state`
        );
        const how = d.dynamic
          ? 'effect.<id> (registry-built)'
          : d.commands.length > 0
            ? d.commands.join(', ')
            : d.relays.map((r) => `${r.command} → ${r.via}`).join(', ');
        assert(
          d.commands.length > 0 || d.dynamic || d.relays.length > 0,
          `${d.component} has at least one command that opens it (${how || 'NONE — unreachable'})`
        );
        console.log(`  ${d.component.padEnd(20)} ← ${how}`);
      }
      assert(
        derivedDialogs.length >= 14,
        `the dialog roster was read from the directory, not a list in this file (${derivedDialogs.length} dialogs)`
      );
    });

    // The dialogs whose command id is fixed are walked through the MENU. The
    // command's label is read out of the open dropdown, so the walk clicks the
    // very row a user would; a command that is in no menu is walked through the
    // Effects card's tool rows instead, and one that is in neither is a finding.
    const menuLabelIndex = await (async () => {
      const index = new Map();
      for (const title of derivedMenus) {
        if (!(await openMenu(page, title))) continue;
        const open = await readOpenMenu(page);
        for (const item of open.items) index.set(item.label, { title, disabled: item.disabled });
        await closeMenu(page);
      }
      return index;
    })();
    const commandLabels = (() => {
      // id → label, straight out of the registry source, so the walk can find a
      // command's menu row without restating either string.
      const src = read(SRC.menuActions);
      const map = new Map();
      for (const m of src.matchAll(/id:\s*'([^']+)',\s*\n?\s*label:\s*'([^']+)'/g)) {
        if (!map.has(m[1])) map.set(m[1], m[2]);
      }
      return map;
    })();

    // Every dialog that a FIXED command opens — directly, or through a service
    // relay. The effect dialog is the one exception and gets its own step.
    // MT1: how many real, mounted selects the per-dialog sweep actually saw. A
    // sweep that never finds one proves nothing, and the first version of this
    // check ran where there were none — so the total is asserted below.
    let selectsSwept = 0;
    for (const d of derivedDialogs.filter((x) => x.commands.length > 0 || x.relays.length > 0)) {
      const commandId = d.commands[0] ?? d.relays[0].command;
      const label = commandLabels.get(commandId);
      await step(page, `Dialog: ${d.component} — open from “${label}”, cancel, store unchanged`, async () => {
        // Which real surface opens this command. A menu row is the usual door,
        // and since T4 every dialog-opening command has one — `transport.record`
        // was the last that did not, which made the Record dialog the one
        // dialog a menu-only user could not reach. The toolbar and Effects-card
        // fallbacks stay: the effect dialogs are opened from the card, and a
        // command none of the three reaches would fail here as a genuine
        // finding rather than as a harness gap.
        const opener = await resolveOpener(page, commandId, label, menuLabelIndex);
        assert(
          opener !== null,
          `${commandId} (“${label}”) has a surface the user can reach it from ` +
            '(menu row, toolbar button, or Effects-card tool row)'
        );
        assert(
          opener.disabled === false,
          `“${label}” is enabled on its ${opener.kind} with a document open, so the dialog is reachable`
        );
        console.log(`  door: ${opener.kind}${opener.title ? ` (${opener.title})` : ''}`);

        const before = await storeSnapshot(page);
        assert(
          snapshotIsSubstantive(before),
          `the state this cancel must not disturb is a real one, not an empty app ` +
            `(${JSON.parse(before).state.activeName}, ${JSON.parse(before).state.length} samples)`
        );

        assert(await invokeOpener(page, opener, label), `“${label}” takes a real click on its ${opener.kind}`);

        // U2: the two presentations. A pipeline tool opens as a CARD in the
        // module column with the stage left live; everything else is still the
        // centred modal it was. Which one applies is read off
        // PipelineToolHost's registry, not decided here.
        if (hostedComponents.has(d.component)) {
          await page.waitForSelector('[data-testid="tool-host"]', { timeout: 10000 });
          const info = await openToolInfo(page);
          console.log(
            `  “${info.label}” hosted at ${info.width}px — ${info.controls} controls, ` +
              `${info.testids.length} testid-bearing elements`
          );
          assert(
            info !== null && info.count === 1,
            `exactly one tool is hosted, not a stack (${info && info.count})`
          );
          assert(
            info.overlays === 0 && info.modalRoles === 0,
            `“${label}” raised NO backdrop and no role=dialog — the stage stays live ` +
              `(overlays ${info.overlays}, modal roles ${info.modalRoles})`
          );
          assert(
            info.role === 'section' && typeof info.label === 'string' && info.label.length > 0,
            `the hosted tool announces itself as a region with a name ` +
              `(<${info.role}> ${JSON.stringify(info.label)})`
          );
          assert(
            info.controls > 0,
            `${d.component} rendered its own body, not an empty shell (${info.controls} controls)`
          );
          // The strip says where you are: Pipeline is the active module.
          const pressed = await page.evaluate(() =>
            [...document.querySelectorAll('[data-testid="sidebar-tabs"] button')]
              .filter((b) => b.getAttribute('aria-pressed') === 'true')
              .map((b) => b.getAttribute('aria-label'))
          );
          assert(
            JSON.stringify(pressed) === JSON.stringify(['Pipeline']),
            `the strip shows Pipeline as the active module while a tool is hosted ` +
              `(pressed: ${JSON.stringify(pressed)})`
          );
          record(
            `Tool: ${d.component}`,
            `hosted in the module column via ${opener.kind}${opener.title ? ` (${opener.title})` : ''} > ${label}`,
            'PASS'
          );
          const closed = await closeHostedTool(page);
          console.log(
            `  closed after ${closed.presses} ✕ click(s) in ${closed.ms} ms` +
              (closed.presses > 1 ? ' — the tool vetoed the ✕ while busy (M7/F12)' : '')
          );
          const afterHosted = await storeSnapshot(page);
          assert(
            afterHosted === before,
            `closing ${d.component} left the store byte-identical\n    before ${before}\n    after  ${afterHosted}`
          );
          return;
        }

        await page.waitForSelector('[data-testid="dialog-overlay"]', { timeout: 10000 });
        const info = await openDialogInfo(page);
        console.log(
          `  “${info.label}” — ${info.controls} controls, ${info.testids.length} testid-bearing elements`
        );
        assert(
          info !== null && info.count === 1,
          `exactly one dialog is open, not a stack (${info && info.count})`
        );
        assert(
          typeof info.label === 'string' && info.label.length > 0,
          `the dialog announces itself with role=dialog + aria-label (${JSON.stringify(info.label)})`
        );
        assert(
          info.controls > 0,
          `${d.component} rendered its own body, not an empty shell (${info.controls} controls)`
        );
        // MT1: with this dialog OPEN, its selects are mounted and their computed
        // styles are real. CoverChainDialog's Reference picker — the reported
        // repro — is checked here on the pass that opens it.
        selectsSwept += await sweepSelects(page, `the open ${d.component}`);
        record(
          `Dialog: ${d.component}`,
          `opened via ${opener.kind}${opener.title ? ` (${opener.title})` : ''} > ${label}`,
          'PASS'
        );

        // Escape is the cancel this walk uses for every MODAL dialog: it is
        // DialogShell's own path, it is the one every modal shares, and it
        // exercises the F25 top-of-stack rule rather than a per-dialog button.
        const cancel = await cancelDialog(page);
        console.log(
          `  cancelled after ${cancel.presses} Escape press(es) in ${cancel.ms} ms` +
            (cancel.presses > 1 ? ' — the dialog vetoed Escape while busy (M7/F12)' : '')
        );
        const after = await storeSnapshot(page);
        assert(
          after === before,
          `cancelling ${d.component} left the store byte-identical\n    before ${before}\n    after  ${after}`
        );
      });
    }

    await step(page, 'MT1 — the select sweep actually had selects to sweep', async () => {
      // Guards the guard. Every per-dialog sweep above passes trivially if no
      // dialog mounts a select, which is exactly how the first version of this
      // check managed to assert nothing at all. At least the Cover Chain
      // Reference picker — the surface the bug was reported against — is
      // mounted during the walk above.
      console.log(`  selects swept across the dialog walk: ${selectsSwept}`);
      assert(
        selectsSwept > 0,
        `the per-dialog select sweep saw at least one real select (${selectsSwept}) — a sweep ` +
          `with nothing to check is not evidence`
      );
      record('Native selects', 'dark scheme + opaque backgrounds, swept per dialog', 'PASS');
    });

    // The one dialog with no fixed command: EffectDialog is built per registry
    // entry, so it is walked through an EFFECT row of the Effects menu.
    await step(page, 'Dialog: EffectDialog — opened per-effect from the Effects menu', async () => {
      const effects = await page.evaluate(() => window.__test.listEffects());
      assert(effects.length > 0, `the effect registry is populated (${effects.length} visible effects)`);
      const before = await storeSnapshot(page);
      assert(snapshotIsSubstantive(before), 'the pre-dialog state is substantive');
      assert(await openMenu(page, 'Effects'), 'the Effects menu opens');
      const first = effects[0];
      assert(
        await clickMenuItem(page, first.name),
        `the “${first.name}” effect row takes a real click (id ${first.id})`
      );
      await page.waitForSelector('[data-testid="effect-dialog"]', { timeout: 10000 });
      const info = await openDialogInfo(page);
      assert(
        info.label === first.name,
        `the dialog announces the effect it is for (aria-label ${JSON.stringify(info.label)} vs ${JSON.stringify(first.name)})`
      );
      record('Dialog: EffectDialog', `opened via Effects > ${first.name}`, 'PASS');
      await cancelDialog(page);
      const after = await storeSnapshot(page);
      assert(after === before, 'cancelling the effect dialog left the store byte-identical');
    });

    // =====================================================================
    // 3. Every module
    // =====================================================================

    await step(page, 'The module strip draws exactly the panels the registry says it should', async () => {
      const drawn = await page.evaluate(() =>
        [...document.querySelectorAll('[data-testid="sidebar-tabs"] button')].map((b) =>
          b.getAttribute('aria-label')
        )
      );
      // U2: "permanent" is now a SLOT rather than an id exclusion list, and the
      // registry order is the slot rank — see `modulePanels()`.
      const expected = derivedPanels.filter((p) => p.permanent).map((p) => p.label);
      assert(
        JSON.stringify(drawn) === JSON.stringify(expected),
        `the strip draws the permanent entries in registry order (expected ${JSON.stringify(expected)}, ` +
          `actual ${JSON.stringify(drawn)})`
      );
      // The contextual Remix icon: absent without a remix document. The
      // positive half is asserted in the Remix step below, after one exists.
      assert(
        !drawn.includes('Remix'),
        `the contextual Remix entry is ABSENT with no remix document (strip: ${JSON.stringify(drawn)})`
      );
      // U2: the user's two rules, asserted on the LIVE strip rather than only
      // on the source the expectation was derived from.
      assert(
        drawn[0] === 'Files' && drawn[drawn.length - 1] === 'History',
        `Files leads the strip and History closes it (${JSON.stringify(drawn)})`
      );
      assert(
        drawn.includes('Pipeline'),
        `the Pipeline module has an entry (${JSON.stringify(drawn)})`
      );
      record(
        'Module strip',
        'roster matches MODULE_PANELS; Files first, History last, Remix contextual and absent',
        'PASS'
      );
    });

    await step(page, 'Module: Files — switch the active document', async () => {
      // At least two documents, so "switch" is a real switch. The count is read
      // rather than assumed: earlier steps legitimately leave documents open
      // (the drop in P0-2 landed one), and a hardcoded expectation here would
      // make this step depend on how many surfaces ran before it.
      const opened = await page.evaluate(() => window.__test.getStateSummary().docCount);
      if (opened < 2) {
        await page.evaluate((p) => window.__test.openPath(p), TONE);
        await page.waitForFunction((n) => window.__test.getStateSummary().docCount > n, opened, {
          timeout: 15000,
        });
      }
      await openModuleCard(page, 'Files');
      await page.waitForSelector('[data-testid="files-list"]', { timeout: 5000 });
      const names = await page.evaluate(() =>
        [...document.querySelectorAll('[data-testid="files-item"] button')].map((b) =>
          b.textContent.trim()
        )
      );
      const activeBefore = await page.evaluate(() => window.__test.getStateSummary().activeName);
      console.log(`  files: ${names.length} rows, active "${activeBefore}"`);
      assert(names.length >= 2, `the Files card lists both open documents (${names.length} rows)`);
      // Click the row that is NOT active — position matters, so the index is
      // resolved by comparing each row's own name against the active one rather
      // than by matching a substring.
      const targetIndex = await page.evaluate((active) => {
        const rows = [...document.querySelectorAll('[data-testid="files-item"]')];
        return rows.findIndex((li) => {
          const label = li.querySelector('button').textContent.trim();
          return !label.startsWith(active);
        });
      }, activeBefore);
      assert(targetIndex >= 0, `a non-active row exists to switch to (index ${targetIndex})`);
      await page.click(
        `[data-testid="files-list"] [data-testid="files-item"]:nth-of-type(${targetIndex + 1}) button`
      );
      await page.waitForFunction(
        (was) => window.__test.getStateSummary().activeName !== was,
        activeBefore,
        { timeout: 5000 }
      );
      const activeAfter = await page.evaluate(() => window.__test.getStateSummary().activeName);
      assert(
        activeAfter !== activeBefore,
        `clicking a Files row switched the active document ("${activeBefore}" → "${activeAfter}")`
      );
      record('Module: Files', 'switched the active document by clicking a row', 'PASS');
      // Back to the click train — the rest of the walk is written against it.
      await page.evaluate(
        (want) => {
          const rows = [...document.querySelectorAll('[data-testid="files-item"] button')];
          const hit = rows.find((b) => b.textContent.trim().startsWith(want));
          if (hit) hit.click();
        },
        activeBefore
      );
      await page.waitForFunction(
        (want) => window.__test.getStateSummary().activeName === want,
        activeBefore,
        { timeout: 5000 }
      );
    });

    await step(page, 'Module: Markers — add, rename, delete', async () => {
      await openModuleCard(page, 'Markers');
      await page.waitForSelector('[data-testid="sidebar-panel"][data-active-tab="markers"]', {
        timeout: 5000,
      });
      const before = await page.evaluate(
        () => document.querySelectorAll('[data-testid="markers-item"]').length
      );
      // ADD through the Edit menu's own row — the panel has no add control, and
      // the walk is about the surface a user reaches for.
      assert(await openMenu(page, 'Edit'), 'the Edit menu opens for Add Marker');
      assert(await clickMenuItem(page, 'Add Marker'), 'Add Marker takes a real click');
      await page.waitForFunction(
        (n) => document.querySelectorAll('[data-testid="markers-item"]').length === n + 1,
        before,
        { timeout: 5000 }
      );
      const added = await page.evaluate(() => window.__test.getActiveMarkers());
      assert(
        added.length === before + 1,
        `Add Marker put exactly one marker in the store (${before} → ${added.length})`
      );
      const originalName = added[added.length - 1].name;

      // RENAME: double-click the name, type, Enter.
      await page.evaluate(() => {
        const rows = [...document.querySelectorAll('[data-testid="markers-item"]')];
        const span = rows[rows.length - 1].querySelector('span[title="Double-click to rename"]');
        span.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      });
      await page.waitForSelector('[data-testid="markers-item"] input', { timeout: 5000 });
      await page.evaluate(() => {
        const input = [...document.querySelectorAll('[data-testid="markers-item"] input')].pop();
        input.focus();
        input.select();
      });
      await page.keyboard.type('Walked marker');
      await page.keyboard.press('Enter');
      await page.waitForFunction(
        () => window.__test.getActiveMarkers().some((m) => m.name === 'Walked marker'),
        null,
        { timeout: 5000 }
      );
      const renamed = await page.evaluate(() => window.__test.getActiveMarkers());
      assert(
        renamed.some((m) => m.name === 'Walked marker') && !renamed.some((m) => m.name === originalName),
        `the rename replaced the name rather than adding one ("${originalName}" → "Walked marker")`
      );
      assert(
        renamed.length === added.length,
        `the rename did not change the marker COUNT (${added.length} → ${renamed.length})`
      );

      // DELETE: the row's own X.
      await page.click('[data-testid="markers-item"] button[aria-label="Delete Walked marker"]');
      await page.waitForFunction(
        (n) => window.__test.getActiveMarkers().length === n,
        before,
        { timeout: 5000 }
      );
      const deleted = await page.evaluate(() => window.__test.getActiveMarkers());
      assert(
        deleted.length === before && !deleted.some((m) => m.name === 'Walked marker'),
        `the delete removed the marker it named (${renamed.length} → ${deleted.length})`
      );
      record('Module: Markers', 'add → rename → delete, all through the panel/menu', 'PASS');
    });

    await step(page, 'Module: History — click an entry and watch the document move', async () => {
      // Two edits, so there is a history worth clicking.
      await page.evaluate(() => {
        window.__test.setSelection(0, 20000);
        window.__test.editOp('silence');
        window.__test.clearSelection();
      });
      await page.evaluate(() => window.__test.applyEffect('amplify', { gainDb: -3 }));
      await openModuleCard(page, 'History');
      await page.waitForSelector('[data-testid="history-list"]', { timeout: 5000 });
      const rows = await page.evaluate(() =>
        [...document.querySelectorAll('[data-testid="history-item"] button')].map((b) => ({
          label: b.textContent.trim(),
          current: b.getAttribute('aria-current') === 'true',
        }))
      );
      console.log(`  history: ${JSON.stringify(rows.map((r) => r.label))}`);
      const histBefore = await page.evaluate(() => window.__test.getHistoryState());
      assert(
        rows.length === histBefore.done.length + histBefore.undone.length,
        `the panel lists every history entry (panel ${rows.length}, store ` +
          `${histBefore.done.length} done + ${histBefore.undone.length} undone)`
      );
      assert(
        histBefore.done.length >= 2,
        `there are at least two applied edits to navigate between (${JSON.stringify(histBefore.done)})`
      );
      assert(
        rows[histBefore.done.length - 1].current === true,
        'the last APPLIED row is the one marked aria-current, not merely the last row'
      );
      // Click the FIRST applied entry: that is "undo back to here".
      await page.click('[data-testid="history-list"] [data-testid="history-item"]:nth-of-type(1) button');
      await page.waitForFunction(
        () => window.__test.getHistoryState().undone.length > 0,
        null,
        { timeout: 5000 }
      );
      const histAfter = await page.evaluate(() => window.__test.getHistoryState());
      console.log(`  after clicking entry 1: done ${JSON.stringify(histAfter.done)} undone ${JSON.stringify(histAfter.undone)}`);
      assert(
        histAfter.done.length === 1 && histAfter.undone.length === histBefore.done.length - 1,
        `clicking the first entry undid everything after it, exactly ` +
          `(done ${histBefore.done.length}→${histAfter.done.length}, undone ` +
          `${histBefore.undone.length}→${histAfter.undone.length})`
      );
      assert(
        histAfter.done[0] === histBefore.done[0],
        `the entry that stayed applied is the one that was clicked ` +
          `(${JSON.stringify(histAfter.done[0])} vs ${JSON.stringify(histBefore.done[0])})`
      );
      // Back to the tip, so later steps run on the edited document.
      await page.click(
        `[data-testid="history-list"] [data-testid="history-item"]:nth-of-type(${histBefore.done.length}) button`
      );
      await page.waitForFunction(
        (n) => window.__test.getHistoryState().done.length === n,
        histBefore.done.length,
        { timeout: 5000 }
      );
      record('Module: History', 'clicked an entry; the stacks moved exactly as far as it names', 'PASS');
    });

    await step(page, 'Module: Properties — every fact matches the store', async () => {
      await openModuleCard(page, 'Properties');
      await page.waitForSelector('[data-testid="properties-document"]', { timeout: 5000 });
      // M4: with the card MOUNTED, its own selects are real. The dialog walk
      // never opens this panel, so until now nothing swept it.
      //
      // MEASURED, and it is ZERO here on purpose: this step opens the card on a
      // DOCUMENT (`properties-document`), and the panel's only selects are the
      // `FadeCurveSelect` pickers, which render in the CLIP view. That zero is
      // now the CONTROL for the step below — T4 added the clip-selection step
      // this sweep was waiting for, so the arm that used to be honestly marked
      // vacuous is a real sweep over real selects, and the difference between
      // the two counts is what proves it.
      const propsSelects = await sweepSelects(page, 'the Properties card');
      propertiesDocumentSelects = propsSelects;
      panelSelectsSwept += propsSelects;
      console.log(`  selects mounted in the Properties card: ${propsSelects}`);
      const facts = await page.evaluate(() => {
        const root = document.querySelector('[data-testid="properties-document"]');
        const out = {};
        for (const row of root.querySelectorAll('div')) {
          const spans = row.querySelectorAll(':scope > span');
          if (spans.length === 2) out[spans[0].textContent.trim()] = spans[1].textContent.trim();
        }
        return out;
      });
      const truth = await page.evaluate(() => window.__test.getStateSummary());
      console.log(`  properties: ${JSON.stringify(facts)}`);
      assert(
        facts.Name === truth.activeName,
        `Name matches the store (panel ${JSON.stringify(facts.Name)}, store ${JSON.stringify(truth.activeName)})`
      );
      assert(
        facts['Sample Rate'] === `${truth.sampleRate} Hz`,
        `Sample Rate matches the store (panel ${JSON.stringify(facts['Sample Rate'])}, store ${truth.sampleRate})`
      );
      assert(
        facts.Channels === (truth.channels === 1 ? 'Mono' : 'Stereo'),
        `Channels matches the store (panel ${JSON.stringify(facts.Channels)}, store ${truth.channels})`
      );
      assert(
        facts.Samples === truth.length.toLocaleString(),
        `Samples matches the store (panel ${JSON.stringify(facts.Samples)}, store ${truth.length})`
      );
      assert(
        facts.Dirty === (truth.dirty ? 'Yes' : 'No'),
        `Dirty matches the store (panel ${JSON.stringify(facts.Dirty)}, store ${truth.dirty})`
      );
      assert(
        facts.Dirty === 'Yes',
        'the document really is dirty here, so the Dirty comparison is not passing on a shared default'
      );
      record('Module: Properties', 'five facts compared against the live store', 'PASS');
    });

    await step(page, 'Module: Properties — a selected clip mounts the pickers the sweep was waiting for', async () => {
      // T4 — the vacuous arm, closed. The sweep above was honestly annotated as
      // finding ZERO selects: the Properties card only mounts its
      // `FadeCurveSelect` pickers in the CLIP view, and the walk had no step
      // that selected a clip. K1's real clip selection makes one possible, so
      // the annotation is replaced by the thing it was waiting for.
      //
      // The selection is a REAL pointer click on the clip, not a store write:
      // the sweep is about what Chromium paints for a mounted `<select>`, and a
      // select mounted by a hook the user cannot press is a select nobody has
      // proven the app can show.
      await page.evaluate(() => window.__test.setView('multitrack'));
      await page.waitForSelector('[data-testid="clip"]', { timeout: 5000 });
      await openModuleCard(page, 'Properties');

      const wasSelected = await page.evaluate(
        () => window.__test.getClipFadeState().selectedClipId
      );
      console.log(`  clip selected before the click: ${JSON.stringify(wasSelected)}`);

      // A quarter of the way in, not the middle: the module column is a FIXED
      // overlay down the right-hand side (App.tsx anchors it, the stage does not
      // reflow around it), so a clip fitted to the lane width has its centre
      // nearer that column than it needs to be.
      const clip = await page.evaluate(() => {
        const r = document.querySelector('[data-testid="clip"]').getBoundingClientRect();
        return { x: r.x + r.width * 0.25, y: r.y + r.height / 2, w: r.width, h: r.height };
      });
      assert(clip.w > 0 && clip.h > 0, `the clip has a real box to click (${clip.w}x${clip.h})`);
      // Hit-tested before the pointer moves. Without this, a point covered by
      // the module card fails as a five-second wait for a selection that never
      // happens, which says nothing about why.
      const onClip = await page.evaluate(
        (p) => {
          const el = document.elementFromPoint(p.x, p.y);
          return {
            hit: el !== null && el.closest('[data-testid="clip"]') !== null,
            top: el ? el.getAttribute('data-testid') || el.tagName.toLowerCase() : null,
          };
        },
        { x: clip.x, y: clip.y }
      );
      assert(
        onClip.hit,
        `the clip is the topmost element at the point about to be clicked (found ` +
          `${JSON.stringify(onClip.top)}) — nothing is covering it`
      );
      await realClick(page, clip.x, clip.y);

      // ClipView commits a plain click's selection on pointerUP for the
      // deferred case, so the store is the thing to wait on rather than the
      // next frame.
      await page.waitForFunction(
        () => window.__test.getClipFadeState().selectedClipId !== null,
        null,
        { timeout: 5000 }
      );
      const selected = await page.evaluate(
        () => window.__test.getClipFadeState().selectedClipId
      );
      assert(
        selected !== null,
        `a real click on the clip selected it (selectedClipId ${JSON.stringify(selected)})`
      );

      await page.waitForSelector('[data-testid="properties-clip"]', { timeout: 5000 });
      const clipSelects = await sweepSelects(page, 'the Properties card with a clip selected');
      panelSelectsSwept += clipSelects;
      console.log(
        `  selects mounted in the Properties card: ${propertiesDocumentSelects} with a document, ` +
          `${clipSelects} with a clip`
      );
      assert(
        propertiesDocumentSelects >= 0,
        `the document-view control was actually measured (${propertiesDocumentSelects}) — without ` +
          `it the differential below compares against a sentinel and passes on anything`
      );
      assert(
        clipSelects > propertiesDocumentSelects,
        `selecting a clip MOUNTED selects the document view has none of ` +
          `(${propertiesDocumentSelects} → ${clipSelects}) — the differential is what makes this ` +
          `sweep a sweep rather than a pass over an empty panel`
      );
      const labels = await page.evaluate(() =>
        [...document.querySelectorAll('[data-testid="properties-clip"] select')].map(
          (s) => s.dataset.testid || s.getAttribute('aria-label') || '(unlabelled)'
        )
      );
      console.log(`  pickers: ${JSON.stringify(labels)}`);
      assert(
        labels.length > 0,
        `the selects swept are INSIDE the clip properties panel (${JSON.stringify(labels)}), not ` +
          `elsewhere on the screen`
      );

      // Back to where the rest of the walk expects to be. The clip stays
      // selected, which is exactly what a user who clicked one would leave
      // behind.
      await page.evaluate(() => window.__test.setView('waveform'));
      record(
        'Module: Properties — clip',
        'real click selects a clip; its fade-curve pickers mount and are swept',
        'PASS'
      );
    });

    // U2: the user's headline ask — "add a module 'Pipeline' to choose
    // pipelines from […] open the module in the extended modules instead of a
    // modal" — walked through the door it is actually about. The menu and the
    // Effects card already had legs below; without this one the Pipeline CARD
    // itself, the whole point of the request, was never opened by the walk.
    await step(page, 'Module: Pipeline — the card the user asked for, and a tool opened from it', async () => {
      await openModuleCard(page, 'Pipeline');
      await page.waitForSelector('[data-testid="pipeline-panel"]', { timeout: 5000 });

      const card = await page.evaluate(() => ({
        sections: [...document.querySelectorAll('[data-testid="pipeline-section"]')].map((s) => ({
          title: s.getAttribute('data-section'),
          rows: [...s.querySelectorAll('[data-testid="pipeline-item"]')].map((r) => ({
            id: r.getAttribute('data-command-id'),
            label: r.querySelector('button').textContent.trim(),
            disabled: r.querySelector('button').disabled === true,
            title: r.querySelector('button').getAttribute('title'),
          })),
        })),
        effects: document.querySelectorAll('[data-testid="effects-item"]').length,
      }));
      console.log(
        `  pipeline card: ${card.sections.map((s) => `${s.title}:${s.rows.length}`).join(', ')}`
      );

      // The groups are the Pipeline MENU's own, derived rather than restated —
      // so this compares the card against the live menu rather than against a
      // list typed here, which is the property the card actually has to hold.
      assert(await openMenu(page, 'Pipeline'), 'the Pipeline menu opens for the comparison');
      const menuRows = (await readOpenMenu(page)).items;
      await closeMenu(page);
      await openModuleCard(page, 'Pipeline');
      await page.waitForSelector('[data-testid="pipeline-panel"]', { timeout: 5000 });
      const cardRows = card.sections.flatMap((s) => s.rows);
      assert(
        cardRows.length === menuRows.length,
        `the card lists exactly the Pipeline menu's rows (card ${cardRows.length}, menu ${menuRows.length})`
      );
      assert(
        JSON.stringify(cardRows.map((r) => r.label)) === JSON.stringify(menuRows.map((r) => r.label)),
        `…in the menu's order, with the menu's labels\n    card ${JSON.stringify(cardRows.map((r) => r.label))}\n    menu ${JSON.stringify(menuRows.map((r) => r.label))}`
      );
      // Real enablement, not decoration: the card's greying is the command's
      // own predicate, so it must agree with the menu row for row.
      assert(
        JSON.stringify(cardRows.map((r) => r.disabled)) ===
          JSON.stringify(menuRows.map((r) => r.disabled)),
        `…and greys exactly what the menu greys\n    card ${JSON.stringify(cardRows.map((r) => `${r.label}${r.disabled ? ' [off]' : ''}`))}\n    menu ${JSON.stringify(menuRows.map((r) => `${r.label}${r.disabled ? ' [off]' : ''}`))}`
      );
      assert(
        cardRows.every((r) => typeof r.title === 'string' && r.title.length > 0),
        'every row carries a tooltip, greyed rows included (an honest reason, not a blank)'
      );
      assert(
        card.effects === 0,
        `the Pipeline card is the tools ALONE — no effect list to scroll past (${card.effects} effect rows)`
      );

      // …and a tool really opens from it, hosted, replacing this very card.
      // Picked by id, not by label: T8 removed the trailing dots from every
      // Pipeline label, so "ends in …" no longer distinguishes the rows that
      // open a hosted tool from the two that do not (`tempo.detect` runs an
      // analysis in place; `spatial.position` swaps the module card).
      const row = cardRows.find(
        (r) => !r.disabled && r.id !== 'tempo.detect' && r.id !== 'spatial.position'
      );
      assert(row !== undefined, `at least one tool is runnable from the card with a document open`);
      await page.click(`[data-testid="pipeline-item"][data-command-id="${row.id}"] button`);
      await page.waitForSelector('[data-testid="tool-host"]', { timeout: 10000 });
      const hosted = await openToolInfo(page);
      assert(
        hosted.commandId === row.id,
        `“${row.label}” opened ITS tool in the column (${hosted.commandId} vs ${row.id})`
      );
      assert(
        hosted.overlays === 0,
        `…with no backdrop over the stage (${hosted.overlays} overlays)`
      );
      const cardGone = await page.evaluate(
        () => document.querySelector('[data-testid="pipeline-panel"]') === null
      );
      assert(cardGone, 'the tool REPLACED the Pipeline card rather than stacking over it');

      await closeHostedTool(page);
      // Closing returns to the list it was launched from.
      await page.waitForSelector('[data-testid="pipeline-panel"]', { timeout: 5000 });
      record(
        'Module: Pipeline',
        `${cardRows.length} rows in ${card.sections.length} groups matching the menu; ` +
          `“${row.label}” hosted from the card and closed back to it`,
        'PASS'
      );
    });

    await step(page, 'Module: Effects — run one real effect, and open one tool from every group', async () => {
      await openModuleCard(page, 'Effects');
      await page.waitForSelector('[data-testid="effects-list"]', { timeout: 5000 });
      const groups = await page.evaluate(() => ({
        categories: [...document.querySelectorAll('[data-testid="effects-list"] > div')].length,
        effects: document.querySelectorAll('[data-testid="effects-item"]').length,
        sections: [...document.querySelectorAll('[data-testid="effects-tool-section"]')].map((s) => ({
          title: s.getAttribute('data-section'),
          rows: [...s.querySelectorAll('[data-testid="effects-tool-item"]')].map((r) => ({
            id: r.getAttribute('data-command-id'),
            label: r.querySelector('button').textContent.trim(),
            disabled: r.querySelector('button').disabled === true,
          })),
        })),
      }));
      const registry = await page.evaluate(() => window.__test.listEffects());
      console.log(
        `  effects card: ${groups.effects} effect rows in ${groups.categories} categories, ` +
          `${groups.sections.length} tool sections (${groups.sections.map((s) => `${s.title}:${s.rows.length}`).join(', ')})`
      );
      assert(
        groups.effects === registry.length,
        `the card lists every visible registry effect (card ${groups.effects}, registry ${registry.length})`
      );
      assert(
        groups.sections.length >= 4,
        `the card carries the tool groups (${groups.sections.map((s) => s.title).join(', ')})`
      );

      // Run one CHEAP effect for real, through the card's own double-click.
      const rmsBefore = await page.evaluate(() => window.__test.getRms());
      // Resolved out of the registry rather than typed here: the effect whose
      // id is `amplify` is the one that applies a constant dB gain, and its
      // on-screen NAME is the registry's to decide. A hardcoded label would be
      // asserting about this file's memory instead of about the app.
      const gain = registry.find((e) => e.id === 'amplify');
      assert(
        gain !== undefined && 'gainDb' in gain.params,
        `the registry carries the constant-gain effect with its gainDb param ` +
          `(${registry.length} effects; params ${gain ? JSON.stringify(Object.keys(gain.params)) : 'n/a'})`
      );
      const gainIndex = await page.evaluate(
        (name) =>
          [...document.querySelectorAll('[data-testid="effects-item"] button')].findIndex(
            (b) => b.textContent.trim() === name
          ),
        gain.name
      );
      assert(gainIndex >= 0, `“${gain.name}” (id ${gain.id}) has a row in the card (index ${gainIndex})`);
      await page.evaluate((i) => {
        const b = [...document.querySelectorAll('[data-testid="effects-item"] button')][i];
        b.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      }, gainIndex);
      await page.waitForSelector('[data-testid="effect-dialog"]', { timeout: 5000 });
      assert(
        (await openDialogInfo(page)).label === gain.name,
        `double-clicking the “${gain.name}” row opened that effect's dialog`
      );
      await cancelDialog(page);
      // …and the effect itself, applied for real so the card's list is proved
      // to name things that actually run.
      await page.evaluate(() => window.__test.applyEffect('amplify', { gainDb: -6 }));
      const rmsAfter = await page.evaluate(() => window.__test.getRms());
      const deltaDb = 20 * Math.log10(rmsAfter / rmsBefore);
      assert(
        Math.abs(deltaDb + 6) < 0.05,
        `running “${gain.name}” at −6 dB moved the RMS by exactly −6 dB (actual ${deltaDb.toFixed(3)} dB)`
      );
      await page.evaluate(() => window.__test.undoActive());

      // One tool from EVERY group, opened and cancelled.
      for (const section of groups.sections) {
        const row = section.rows.find((r) => !r.disabled);
        assert(
          row !== undefined,
          `the ${section.title} group has at least one runnable tool with a document open ` +
            `(${JSON.stringify(section.rows.map((r) => `${r.label}${r.disabled ? ' [off]' : ''}`))})`
        );
        // "Did something visible" is asked GENERICALLY rather than as a list of
        // per-command outcomes, because the outcomes genuinely differ: Auto-Remix
        // opens a tool, Spatial Positioner moves the module card, and Detect
        // Tempo does neither — it runs an analysis and rewrites the tempo card.
        // A composite signature of the app's chrome covers all three, and a
        // command that fired and changed nothing at all fails here.
        //
        // U2: `tool` joined the signature. Nine of these rows now open in the
        // module column instead of over the stage, and `dialogs` alone would
        // have read them as "no dialog, no tab change" — a silent pass for a
        // row that in fact did the whole thing.
        const chromeSignature = () =>
          page.evaluate(() =>
            JSON.stringify({
              dialogs: document.querySelectorAll('[data-testid="dialog-overlay"]').length,
              tool:
                document.querySelector('[data-testid="tool-host"]')?.getAttribute('data-tool-id') ??
                null,
              tab:
                document.querySelector('[data-testid="sidebar-panel"]')?.getAttribute('data-active-tab') ??
                null,
              tempo: document.querySelector('[data-testid="tempo-card"]')?.textContent ?? null,
              status: document.querySelector('[data-testid="status-pill"]')?.textContent ?? null,
            })
          );
        const sigBefore = await chromeSignature();
        await page.click(`[data-testid="effects-tool-item"][data-command-id="${row.id}"] button`);
        const changed = await page
          .waitForFunction(
            (was) =>
              JSON.stringify({
                dialogs: document.querySelectorAll('[data-testid="dialog-overlay"]').length,
                tool:
                  document
                    .querySelector('[data-testid="tool-host"]')
                    ?.getAttribute('data-tool-id') ?? null,
                tab:
                  document
                    .querySelector('[data-testid="sidebar-panel"]')
                    ?.getAttribute('data-active-tab') ?? null,
                tempo: document.querySelector('[data-testid="tempo-card"]')?.textContent ?? null,
                status: document.querySelector('[data-testid="status-pill"]')?.textContent ?? null,
              }) !== was,
            sigBefore,
            { timeout: 20000 }
          )
          .then(() => true)
          .catch(() => false);
        const sigAfter = await chromeSignature();
        const open = await page.evaluate(() => ({
          dialog: document.querySelector('[data-testid="dialog-overlay"]') !== null,
          tool: document.querySelector('[data-testid="tool-host"]') !== null,
        }));
        const outcome = open.tool
          ? 'hosted tool'
          : open.dialog
            ? 'dialog'
            : JSON.parse(sigAfter).tab !== JSON.parse(sigBefore).tab
              ? 'panel'
              : 'chrome update';
        assert(
          changed,
          `the ${section.title} group's “${row.label}” row changed something visible ` +
            `(signature was ${sigBefore})`
        );
        // U2: the Effects card is one of the three doors the user asked to open
        // hosted, so a tool row that raised a MODAL from here is a failure and
        // not merely a different outcome.
        assert(
          !open.dialog,
          `the ${section.title} group's “${row.label}” row raised no backdrop — the Effects card ` +
            `is a Pipeline door and its tools open in the column`
        );
        console.log(`    ${section.title} → ${row.label}: ${outcome}`);
        if (open.tool || open.dialog) {
          await dismissOpenTool(page);
        }
        await openModuleCard(page, 'Effects');
        await page.waitForSelector('[data-testid="effects-list"]', { timeout: 5000 });
        record(`Effects card — ${section.title}`, `“${row.label}” opened a ${outcome}`, 'PASS');
      }
    });

    await step(page, 'Module: Spatial — the tool the strip draws no icon for', async () => {
      const beforeIcons = await page.evaluate(() =>
        [...document.querySelectorAll('[data-testid="sidebar-tabs"] button')].map((b) =>
          b.getAttribute('aria-label')
        )
      );
      assert(
        !beforeIcons.includes('Spatial'),
        `the strip draws NO Spatial entry — it is a tool, not a module (${JSON.stringify(beforeIcons)})`
      );
      // T8: the row moved to the Effects menu ("move the Spacial tool to the
      // effects module"), where it closes the list as its own Mix group.
      assert(await openMenu(page, 'Effects'), 'the Effects menu opens for the Spatial Positioner');
      assert(await clickMenuItem(page, 'Spatial Positioner'), 'Spatial Positioner takes a real click');
      await page.waitForSelector('[data-testid="sidebar-panel"][data-active-tab="spatial"]', {
        timeout: 5000,
      });
      const hasStage = await page.evaluate(
        () => document.querySelector('[data-testid="spatial-stage"]') !== null
      );
      assert(
        hasStage,
        'the positioner shows its stage (the session seeded in P0-2 still has tracks)'
      );
      // M4: the Spatial track picker — the second select the sweep's own
      // docblock claimed to cover while nothing swept this card.
      const spatialSelects = await sweepSelects(page, 'the Spatial card');
      panelSelectsSwept += spatialSelects;
      console.log(`  selects mounted in the Spatial card: ${spatialSelects}`);
      console.log(`  selects swept across the two panel cards: ${panelSelectsSwept}`);
      assert(
        panelSelectsSwept > 0,
        `the panel sweeps saw at least one real select (${panelSelectsSwept}) — a sweep over a ` +
          `card with no select mounted would pass by having nothing to check, which is the ` +
          `failure mode this half was added to close`
      );
      const dotBefore = await page.evaluate(() => {
        const c = document.querySelector('[data-testid="spatial-source"]');
        return { cx: Number(c.getAttribute('cx')), cy: Number(c.getAttribute('cy')) };
      });
      const stageBox = await page.evaluate(() => {
        const r = document.querySelector('[data-testid="spatial-stage"]').getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height };
      });
      await realDrag(
        page,
        { x: stageBox.x + stageBox.w / 2, y: stageBox.y + stageBox.h / 2 },
        { x: stageBox.x + stageBox.w * 0.75, y: stageBox.y + stageBox.h * 0.35 }
      );
      const dotAfter = await page.evaluate(() => {
        const c = document.querySelector('[data-testid="spatial-source"]');
        return { cx: Number(c.getAttribute('cx')), cy: Number(c.getAttribute('cy')) };
      });
      console.log(`  source dot: (${dotBefore.cx}, ${dotBefore.cy}) → (${dotAfter.cx}, ${dotAfter.cy})`);
      assert(
        dotAfter.cx !== dotBefore.cx || dotAfter.cy !== dotBefore.cy,
        `a real drag across the stage MOVED the source (${dotBefore.cx},${dotBefore.cy} → ${dotAfter.cx},${dotAfter.cy})`
      );
      assert(
        dotAfter.cx > dotBefore.cx && dotAfter.cy < dotBefore.cy,
        `it moved in the direction dragged — right and forward (Δx ${(dotAfter.cx - dotBefore.cx).toFixed(1)}, ` +
          `Δy ${(dotAfter.cy - dotBefore.cy).toFixed(1)})`
      );
      // Closed from the card's own header — the only affordance a panel with no
      // strip icon has.
      await page.click('[data-testid="sidebar-panel-close"]');
      await page.waitForFunction(
        () => document.querySelector('[data-testid="sidebar-panel"]') === null,
        null,
        { timeout: 5000 }
      );
      record('Module: Spatial', 'opened from Effects, source dragged, closed from the card header', 'PASS');
      await openModuleCard(page, 'History');
      await page.waitForSelector('[data-testid="sidebar-panel"]', { timeout: 5000 });
    });

    await step(page, 'Module: Remix — the contextual strip icon appears with a remix document', async () => {
      // The ABAB fixture, not the sweep: Auto-Remix rearranges SECTIONS, and a
      // five-second tone/silence/noise sweep has none — it refuses with
      // 'too-short', correctly. The structure fixture is what the feature is
      // for, and `strict: false` is the smoke's own setting for it.
      await page.evaluate((p) => window.__test.openPath(p), ABAB);
      await page.waitForSelector('[data-testid="waveform-canvas"]', { timeout: 20000 });
      const remix = await page.evaluate(() =>
        window.__test.remixToDuration(32, { strict: false })
      );
      console.log(`  remixToDuration: status=${remix.status} name=${remix.name} joins=${remix.joins}`);
      assert(remix.ok === true, `a remix document was created (status ${remix.status})`);
      await page.waitForFunction(
        () =>
          [...document.querySelectorAll('[data-testid="sidebar-tabs"] button')].some(
            (b) => b.getAttribute('aria-label') === 'Remix'
          ),
        null,
        { timeout: 10000 }
      );
      const icons = await page.evaluate(() =>
        [...document.querySelectorAll('[data-testid="sidebar-tabs"] button')].map((b) =>
          b.getAttribute('aria-label')
        )
      );
      // U2: Remix's slot is unmoved — still contextual, still appended after
      // the permanent body entries — but it is no longer LAST, because the
      // user's "'History' always last" rule outranks it. So the assertion is
      // the adjacency, and History closing the strip in both remix states.
      assert(
        icons.includes('Remix') && icons[icons.length - 1] === 'History',
        `the Remix entry appeared and History still closes the strip (${JSON.stringify(icons)})`
      );
      assert(
        icons[icons.indexOf('Remix') + 1] === 'History',
        `Remix sits immediately before History — its contextual slot is unmoved ` +
          `(${JSON.stringify(icons)})`
      );
      await openModuleCard(page, 'Remix');
      await page.waitForSelector('[data-testid="remix-panel"]', { timeout: 5000 });
      const rows = await page.evaluate(
        () => document.querySelectorAll('[data-testid="remix-item"]').length
      );
      console.log(`  remix panel: ${rows} splice rows`);
      assert(
        rows === remix.joins,
        `the panel lists one row per join the plan reported (panel ${rows}, plan ${remix.joins})`
      );
      record('Module: Remix', 'contextual icon appeared; panel row count matches the plan', 'PASS');
    });

    await step(page, 'Module: Transcript — the panel with no icon and no transcript', async () => {
      // `edit.transcribe` reveals an EXISTING transcript and opens the dialog
      // otherwise. There is no transcript here, so the dialog is the correct
      // outcome — and that branch is the one this step pins.
      const hadTranscript = await page.evaluate(
        () => document.querySelector('[data-testid="transcript-panel"]') !== null
      );
      assert(hadTranscript === false, 'no transcript exists yet, so Transcribe must offer the dialog');
      assert(await openMenu(page, 'Pipeline'), 'the Pipeline menu opens for Transcribe');
      assert(await clickMenuItem(page, 'Transcribe'), 'Transcribe takes a real click');
      await page.waitForSelector('[data-testid="transcribe-dialog"]', { timeout: 10000 });
      record('Module: Transcript', 'Transcribe offered the dialog (no transcript to reveal)', 'PASS');
      // M4: `dismissOpenTool`, not `cancelDialog`. Transcribe is one of the nine
      // that now open HOSTED in the module column, and a hosted tool installs no
      // Escape handler and draws no backdrop — so `cancelDialog` pressed Escape
      // once, found no `dialog-overlay` (there never is one), and reported
      // success having closed nothing. The tool stayed open and the step's own
      // liveness guard caught it. This is the case U2's report predicted:
      // "anything else that assumed Escape will need the same."
      await dismissOpenTool(page);
    });

    // =====================================================================
    // 4. Every view
    // =====================================================================

    await step(page, 'Every editor view: switch, repaint, edit bar, transport', async () => {
      const roots = { waveform: 'waveform-view', spectral: 'spectrogram-view', multitrack: 'multitrack-view' };
      for (const view of derivedViews) {
        await page.click(`[data-testid="view-toggle"] button[aria-label="${view} view"]`);
        await page.waitForSelector(`[data-testid="${roots[view]}"]`, { timeout: 20000 });
        const state = await page.evaluate(
          (map) => ({
            pressed: [...document.querySelectorAll('[data-testid="view-toggle"] button')]
              .filter((b) => b.getAttribute('aria-pressed') === 'true')
              .map((b) => b.getAttribute('aria-label')),
            present: Object.fromEntries(
              Object.entries(map).map(([k, id]) => [k, document.querySelector(`[data-testid="${id}"]`) !== null])
            ),
            editPill: document.querySelector('[data-testid="edit-pill"]') !== null,
            editButtons: [...document.querySelectorAll('[data-testid="edit-pill"] button')].map((b) => ({
              label: b.getAttribute('aria-label'),
              disabled: b.disabled === true,
            })),
          }),
          roots
        );
        console.log(
          `  ${view}: pressed ${JSON.stringify(state.pressed)}, roots ${JSON.stringify(state.present)}, ` +
            `edit pill ${state.editButtons.filter((b) => !b.disabled).length}/${state.editButtons.length} enabled`
        );
        assert(
          JSON.stringify(state.pressed) === JSON.stringify([`${view} view`]),
          `exactly the ${view} segment reads pressed (${JSON.stringify(state.pressed)})`
        );
        const others = Object.entries(state.present).filter(([k]) => k !== view);
        assert(
          state.present[view] === true && others.every(([, v]) => v === false),
          `only the ${view} root is mounted (${JSON.stringify(state.present)})`
        );
        assert(
          state.editPill === true,
          `the edit bar is present in the ${view} view — "hidden only in the empty app"`
        );
        assert(
          state.editButtons.length > 0,
          `the edit bar rendered its verbs in the ${view} view (${state.editButtons.length})`
        );
        // The per-view greying rule: the region verbs are the multitrack view's
        // greyed set, because they act on a waveform selection that view has no
        // notion of.
        const cut = state.editButtons.find((b) => b.label === 'Cut');
        if (view === 'multitrack') {
          assert(
            cut !== undefined && cut.disabled === true,
            'Cut is greyed in the multitrack view — it acts on a selection this view does not have'
          );
        } else {
          assert(
            cut !== undefined,
            `Cut is present in the ${view} view (its enablement follows the selection)`
          );
        }

        if (view !== 'multitrack') {
          const canvasId = view === 'spectral' ? 'spectrogram-canvas' : 'waveform-canvas';
          await waitNonUniform(page, canvasId);
          const hash = await canvasHash(page, canvasId);
          assert(
            hash !== -1 && hash !== 0,
            `the ${view} canvas painted real content (raster hash ${hash})`
          );
        }
        record(`View: ${view}`, 'switched, root mounted alone, edit bar correct', 'PASS');
      }

      // Transport, in the waveform view, driven from the toolbar's real buttons.
      await page.click('[data-testid="view-toggle"] button[aria-label="waveform view"]');
      await page.waitForSelector('[data-testid="waveform-view"]', { timeout: 10000 });
      const timeBefore = await page.evaluate(
        () => document.querySelector('[data-testid="transport-time"]').textContent.trim()
      );
      await page.click('[data-testid="toolbar-pill"] button[aria-label="Play"]');
      const moved = await page
        .waitForFunction(
          (was) => document.querySelector('[data-testid="transport-time"]').textContent.trim() !== was,
          timeBefore,
          { timeout: 8000 }
        )
        .then(() => true)
        .catch(() => false);
      const timeDuring = await page.evaluate(
        () => document.querySelector('[data-testid="transport-time"]').textContent.trim()
      );
      await page.click('[data-testid="toolbar-pill"] button[aria-label="Stop"]');
      console.log(`  transport: "${timeBefore}" → "${timeDuring}" while playing`);
      assert(
        moved && timeDuring !== timeBefore,
        `Play advanced the transport readout ("${timeBefore}" → "${timeDuring}")`
      );
      const playLabel = await page.evaluate(
        () =>
          document.querySelector('[data-testid="toolbar-pill"] button[aria-label="Play"]') !== null
      );
      assert(playLabel === true, 'Stop returned the transport button to Play');
      record('Transport', 'played, the readout advanced, stopped', 'PASS');
    });

    // =====================================================================
    // 5. The new F11 / P1 surfaces
    // =====================================================================

    await step(page, 'F11-3 — a document opens FITTED, and Fit is the zoom-out floor', async () => {
      await page.evaluate(() => window.__test.closeActive());
      await page.evaluate(() => {
        while (window.__test.getStateSummary().docCount > 0) window.__test.closeActive();
      });
      await page.evaluate((p) => window.__test.openPath(p), SWEEP);
      await page.waitForSelector('[data-testid="waveform-canvas"]', { timeout: 15000 });
      await waitNonUniform(page, 'waveform-canvas');
      const readout = () =>
        page.evaluate(() => document.querySelector('[data-testid="zoom-readout"]').textContent.trim());
      const fresh = await readout();
      console.log(`  zoom readout on a freshly opened document: ${fresh}`);
      assert(fresh === '100%', `a freshly opened document is FITTED, reading 100% (actual ${fresh})`);
      await page.click('[data-testid="toolbar-pill"] button[aria-label="Zoom In"]');
      const zoomed = await readout();
      assert(
        zoomed !== fresh && Number.parseInt(zoomed, 10) > 100,
        `Zoom In moved the readout past the fit (${fresh} → ${zoomed})`
      );
      await page.click('[data-testid="toolbar-pill"] button[aria-label="Fit"]');
      const refit = await readout();
      assert(refit === fresh, `Fit returned exactly to the opening zoom (${zoomed} → ${refit})`);
      await page.click('[data-testid="toolbar-pill"] button[aria-label="Zoom Out"]');
      const floored = await readout();
      assert(
        floored === fresh,
        `Zoom Out below the fit is refused — Fit IS the floor (F11-9) (actual ${floored})`
      );
      record('F11-3 fit-on-import', 'opens at 100%; Fit and the zoom-out floor converge', 'PASS');
    });

    await step(page, 'F11 — the ruler seeks, and the playhead handle drags', async () => {
      const readRuler = () =>
        page.evaluate(() => {
          const r = document
            .querySelector('[data-testid="timeline-ruler"]')
            .getBoundingClientRect();
          return { x: r.x, y: r.y, w: r.width, h: r.height };
        });
      const firstRead = await readRuler();

      // T4 — the flake this closes. The v1.29.0 ceremony's combined-tree
      // navigate missed this click ONCE, immediately after a 411 s 14-worker
      // gate, and landed exactly on rerun and on the release build. That is the
      // signature of a rect read before a late layout shift rather than of a
      // seek that is wrong: the pointer went where the ruler HAD been.
      //
      // So the rect is re-read immediately before the pointer moves, in the
      // same evaluate as the view state — one snapshot of one layout, from
      // which BOTH the click coordinate and the expected sample are derived, so
      // the two cannot disagree about where the ruler is. The arithmetic below
      // is unchanged; only which rect it is about is.
      const { ruler, before } = await page.evaluate(() => {
        const r = document.querySelector('[data-testid="timeline-ruler"]').getBoundingClientRect();
        return {
          ruler: { x: r.x, y: r.y, w: r.width, h: r.height },
          before: window.__test.getEditorViewState(),
        };
      });
      if (ruler.x !== firstRead.x || ruler.w !== firstRead.w) {
        // Reported rather than asserted: a shift here is the condition being
        // defended against, not a failure. Seeing it in a log is how the next
        // person learns the defence earned its keep.
        console.log(
          `  ruler moved between reads: x ${firstRead.x} → ${ruler.x}, w ${firstRead.w} → ${ruler.w}`
        );
      }

      // Alt suspends the magnet, so the expected sample is arithmetic rather
      // than "whatever the nearest snap target happened to be".
      const seekX = ruler.x + ruler.w * 0.4;
      await realClick(page, seekX, ruler.y + ruler.h / 2, { alt: true });
      const seeked = await page.evaluate(() => window.__test.getEditorViewState());
      const expected = Math.round(before.scrollSample + (seekX - ruler.x) * before.samplesPerPixel);
      console.log(
        `  ruler seek: cursor ${before.cursorSample} → ${seeked.cursorSample} (expected ~${expected})`
      );
      assert(
        seeked.cursorSample !== before.cursorSample,
        `a click on the ruler moved the cursor (${before.cursorSample} → ${seeked.cursorSample})`
      );
      assert(
        Math.abs(seeked.cursorSample - expected) <= Math.ceil(before.samplesPerPixel) + 1,
        `it moved to the sample under the pointer, within one pixel of audio ` +
          `(actual ${seeked.cursorSample}, expected ${expected}, 1 px = ${before.samplesPerPixel.toFixed(1)} samples)`
      );
      assert(
        seeked.selectionStart === before.selectionStart && seeked.selectionEnd === before.selectionEnd,
        'a ruler seek does not disturb the selection'
      );

      // The playhead HANDLE: a 15 px band at the top of the canvas, within
      // 12 px of the cursor line. Dragging it moves the cursor and must NOT
      // start a selection — that is the whole reason it exists.
      const canvas = await page.evaluate(() => {
        const r = document.querySelector('[data-testid="waveform-canvas"]').getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height };
      });
      const state = await page.evaluate(() => window.__test.getEditorViewState());
      const cursorX =
        canvas.x + (state.cursorSample - state.scrollSample) / state.samplesPerPixel;
      const target = cursorX + canvas.w * 0.15;
      await realDrag(
        page,
        { x: cursorX, y: canvas.y + 6 },
        { x: target, y: canvas.y + 6 },
        { alt: true, steps: 6 }
      );
      const dragged = await page.evaluate(() => window.__test.getEditorViewState());
      const wantSample = Math.round(state.scrollSample + (target - canvas.x) * state.samplesPerPixel);
      console.log(
        `  playhead drag: cursor ${state.cursorSample} → ${dragged.cursorSample} (expected ~${wantSample})`
      );
      assert(
        dragged.cursorSample !== state.cursorSample,
        `dragging the playhead handle moved the cursor (${state.cursorSample} → ${dragged.cursorSample})`
      );
      assert(
        Math.abs(dragged.cursorSample - wantSample) <= Math.ceil(state.samplesPerPixel) + 1,
        `it followed the pointer to where it was released ` +
          `(actual ${dragged.cursorSample}, expected ${wantSample})`
      );
      assert(
        dragged.selectionStart === state.selectionStart && dragged.selectionEnd === state.selectionEnd,
        'a playhead drag starts no selection — the reason the handle is a separate gesture from the lane'
      );

      // A cursor is a sample INDEX, and the two surfaces that write it have to
      // agree about that. `TimelineRuler` rounds its seek (`Math.round(snapped)`);
      // the gesture layer's `snapped()` returns the raw pixel-derived value
      // untouched whenever the magnet is suspended or the document has no snap
      // targets — so an Alt drag left the cursor at a fraction of a sample. It
      // is not a display nit: `marker.add` writes `positionSample: cursorSample`
      // verbatim, so the fraction lands in marker data and from there in the cue
      // chunk of every export.
      console.log(`  cursor after an Alt drag: ${dragged.cursorSample}`);
      assert(
        Number.isInteger(dragged.cursorSample),
        `the cursor is a whole sample after an Alt playhead drag (actual ${dragged.cursorSample}) — ` +
          'the ruler already rounds, and both surfaces write the same field'
      );
      const markersBefore = await page.evaluate(() => window.__test.getActiveMarkers().length);
      assert(await openMenu(page, 'Edit'), 'the Edit menu opens to drop a marker at that cursor');
      assert(await clickMenuItem(page, 'Add Marker'), 'Add Marker takes a real click');
      await page.waitForFunction(
        (n) => window.__test.getActiveMarkers().length === n + 1,
        markersBefore,
        { timeout: 5000 }
      );
      const placed = await page.evaluate(() => window.__test.getActiveMarkers());
      const at = placed[placed.length - 1].positionSample;
      console.log(`  marker dropped at the dragged cursor: ${at}`);
      assert(
        Number.isInteger(at),
        `a marker added at that cursor sits on a whole sample (actual ${at}) — ` +
          'a marker between two samples is not a position any writer can represent'
      );
      record('F11 playhead + ruler', 'ruler seek and handle drag, both within a pixel of audio', 'PASS');
      record('Cursor integrality', 'Alt drag then Add Marker, both whole samples', 'PASS');
    });

    // =====================================================================
    // 6. Recovery paths
    // =====================================================================

    await step(page, 'Recovery — an undecodable file is refused and the app survives', async () => {
      const before = await page.evaluate(() => window.__test.getStateSummary());
      await resetNativeCalls(app);
      const failed = await page.evaluate(async (p) => {
        try {
          await window.__test.openPath(p);
          return null;
        } catch (err) {
          return String(err && err.message ? err.message : err);
        }
      }, OUT_NOT_AUDIO);
      const after = await page.evaluate(() => window.__test.getStateSummary());
      const calls = await nativeCalls(app);
      console.log(`  refusal: ${JSON.stringify(failed)}; native calls ${JSON.stringify(calls.map((c) => c.kind))}`);
      assert(
        after.docCount === before.docCount,
        `the undecodable file opened NO document (${before.docCount} → ${after.docCount})`
      );
      assert(
        after.activeName === before.activeName,
        `and did not disturb the one that was open (${JSON.stringify(after.activeName)})`
      );
      assert(
        failed !== null || calls.some((c) => c.kind === 'message'),
        `the refusal was reported rather than swallowed (threw ${JSON.stringify(failed)}, ` +
          `message boxes ${calls.filter((c) => c.kind === 'message').length})`
      );
      record('Recovery: undecodable file', 'refused, reported, no document created', 'PASS');
    });

    await step(page, 'Recovery — Save on a clean document is not offered (O1)', async () => {
      // A freshly opened, unedited document has nothing to save. O1's rule is
      // that Save is a destructive no-op there, so the command is DISABLED
      // rather than silently re-encoding the file.
      await page.evaluate(() => {
        while (window.__test.getStateSummary().docCount > 0) window.__test.closeActive();
      });
      await page.evaluate((p) => window.__test.openPath(p), TONE);
      await page.waitForSelector('[data-testid="waveform-canvas"]', { timeout: 15000 });
      const clean = await page.evaluate(() => window.__test.getStateSummary());
      assert(
        clean.dirty === false && clean.neverSaved === false,
        `the document is clean and has a file on disk (dirty ${clean.dirty}, neverSaved ${clean.neverSaved})`
      );
      assert(await openMenu(page, 'File'), 'the File menu opens');
      const fileMenu = await readOpenMenu(page);
      const save = fileMenu.items.find((i) => i.label === 'Save');
      const saveAs = fileMenu.items.find((i) => i.label === 'Save As…');
      console.log(`  File menu: Save disabled=${save && save.disabled}, Save As… disabled=${saveAs && saveAs.disabled}`);
      assert(
        save !== undefined && save.disabled === true,
        'Save is GREYED on a clean document — a destructive no-op the user cannot fire by accident'
      );
      assert(
        saveAs !== undefined && saveAs.disabled === false,
        'Save As… stays available on the same document, so the greying is Save’s own rule and not "no document"'
      );

      // …and the Save As path itself, to its cancel. The native picker is a
      // main-process stub (see stubNativeDialogs): what is proved here is that
      // the command reaches the picker and handles a cancel without touching
      // the document.
      await resetNativeCalls(app);
      const before = await storeSnapshot(page);
      assert(snapshotIsSubstantive(before), 'the document Save As must not disturb is a real one');
      assert(await clickMenuItem(page, 'Save As…'), 'Save As… takes a real click');
      await page.waitForTimeout(500);
      const calls = await nativeCalls(app);
      console.log(`  Save As… native calls: ${JSON.stringify(calls.map((c) => c.kind))}`);
      assert(
        calls.some((c) => c.kind === 'save'),
        `Save As… reached the save picker (calls ${JSON.stringify(calls.map((c) => c.kind))})`
      );
      const after = await storeSnapshot(page);
      assert(
        after === before,
        `cancelling the picker left the document byte-identical\n    before ${before}\n    after  ${after}`
      );
      const stillClean = await page.evaluate(() => window.__test.getStateSummary());
      assert(
        stillClean.filePath === clean.filePath,
        `and did not repoint the document at a new path (${JSON.stringify(stillClean.filePath)})`
      );
      record('Recovery: Save / Save As', 'Save greyed per O1; Save As reached the picker and cancelled cleanly', 'PASS');
    });

    await step(page, 'Recovery — Open… reaches the OS picker and survives a cancel', async () => {
      await resetNativeCalls(app);
      const before = await storeSnapshot(page);
      assert(await openMenu(page, 'File'), 'the File menu opens for Open…');
      assert(await clickMenuItem(page, 'Open…'), 'Open… takes a real click');
      await page.waitForTimeout(500);
      const calls = await nativeCalls(app);
      assert(
        calls.some((c) => c.kind === 'open'),
        `Open… reached the open picker (calls ${JSON.stringify(calls.map((c) => c.kind))})`
      );
      const after = await storeSnapshot(page);
      assert(after === before, 'cancelling the open picker changed nothing');
      record('Recovery: Open… cancel', 'reached the picker, cancelled, state untouched', 'PASS');
    });

    // =====================================================================
    // Done
    // =====================================================================

    console.log('\nCoverage:');
    const width = Math.max(...coverage.map((c) => c.surface.length));
    for (const c of coverage) {
      console.log(`  ${c.surface.padEnd(width)} | ${c.step} | ${c.verdict}`);
    }
    console.log(`\n${coverage.length} surfaces walked, ${assertionCount()} assertions passed.`);
    console.log('\nNAVIGATE PASSED');
  } finally {
    await closeApp(app);
  }
}

main().catch((err) => {
  console.error('\nNAVIGATE FAILED');
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
