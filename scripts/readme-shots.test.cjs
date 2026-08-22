'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * Item 6, final fix round 2 — the effect-card scene of `readme-shots.cjs`.
 *
 * The scene captures the Parametric EQ and Reverb cards for the README
 * gallery, and its own fits-check refuses a capture whose Preview/Apply row
 * scrolled below the card's fold. Item 6 moved those two subjects from a
 * modal — alone on the screen, capped at `max-h-[86vh]` — into the module
 * column, where the card SHARES a bounded height with the module card beneath
 * it: both are `flex: 0 1 auto` with `min-h-0`, so two overflowing cards
 * shrink proportionally to their natural heights.
 *
 * The numbers are measured, not guessed. `docs/shots/effect-parametric-eq.png`
 * is 460x1616 — the modal's realised height at this scene's own tall pin, with
 * `--force-device-scale-factor=1`, so 1 CSS px is 1 device px — and
 * `docs/shots/effects-rack.png` is 348x1223, the Effects module card cut at
 * the last whole row of a 1274px column. `openEffect` forces that same module
 * card open (N16), so the shared column has to hold 1616 + 14 + >=1223 px and
 * hands the effect card barely two thirds of the 1616 it needs. Apply lands
 * several hundred px inside the shell's `overflow-y-auto` body and the check
 * throws before `shoot()` ever runs — a hard failure of lot F's shot run.
 *
 * The fix is in the scene, not in the card: the app's sharing rule is the
 * ruled behaviour (no invented `max-height`), and the module card is not even
 * in this crop, which clips to `effect-host` alone. So the scene closes the
 * module card after the effect card mounts and before it measures anything.
 *
 * This is a source contract rather than a rendered one: the layout lives in
 * Chromium under Playwright Electron, which jest does not run (the packaged
 * walk is lot F's). What it pins is the ORDER the scene must keep and the
 * measurements its failure must report, both of which regress silently — a
 * capture taken with the module card still open is a cropped card, not a
 * crash, and a bare "it did not fit" leaves the next reader with nothing to
 * act on.
 */

const SOURCE = fs.readFileSync(path.join(__dirname, 'readme-shots.cjs'), 'utf8');

/** The effect-card scene: the two-subject table down to the re-pin after it. */
function scene() {
  const start = SOURCE.indexOf("['Parametric EQ', 'effect-parametric-eq.png']");
  const end = SOURCE.indexOf('// Back to the panel scenes', start);
  if (start < 0 || end <= start) {
    throw new Error('the effect-card scene was not found in readme-shots.cjs');
  }
  return SOURCE.slice(start, end);
}

describe('readme-shots: the effect-card scene', () => {
  test('the slice really is the scene (guards every assertion below)', () => {
    const s = scene();
    // A slice that had drifted onto some other part of the file would make the
    // ordering tests pass by having nothing to order.
    expect(s).toContain("['Reverb', 'effect-reverb.png']");
    expect(s).toContain('[data-testid="effect-host"]');
    expect(s).toContain('shoot(page, file');
  });

  test('the module card is closed before the card is measured or captured', () => {
    const s = scene();
    const hostMounted = s.indexOf('waitForSelector(\'[data-testid="effect-host"]\'');
    const moduleClosed = s.indexOf('closeModuleCard(page)');
    const measured = s.indexOf('page.evaluate(');
    const captured = s.indexOf('shoot(page, file');

    // Each step present…
    expect({
      hostMounted: hostMounted >= 0,
      moduleClosed: moduleClosed >= 0,
      measured: measured >= 0,
      captured: captured >= 0,
    }).toEqual({ hostMounted: true, moduleClosed: true, measured: true, captured: true });

    // …and in the only order that gives the card the whole column: the rows
    // live in the module card, so it is open when the row is clicked and
    // `openEffect` re-forces it open anyway. It can only be closed after the
    // card mounts — and it must be closed before anything is measured.
    expect(hostMounted).toBeLessThan(moduleClosed);
    expect(moduleClosed).toBeLessThan(measured);
    expect(measured).toBeLessThan(captured);
  });

  test('the fits-check failure reports the heights it measured', () => {
    const s = scene();
    const throwAt = s.indexOf('the Apply row is');
    expect(throwAt).toBeGreaterThan(-1);
    const message = s.slice(throwAt, s.indexOf(');', throwAt));
    // Open question 4's standing instruction: if Apply falls below the fold,
    // report the measured heights rather than guessing a cap. Four numbers —
    // how far below, the card, what its body shows, what its body wants.
    for (const field of ['fit.below', 'fit.card', 'fit.bodyVisible', 'fit.bodyContent']) {
      expect([field, message.includes('${' + field + '}')]).toEqual([field, true]);
    }
  });

  test('the measurement reads the shell body, not just the card box', () => {
    const s = scene();
    // `scrollHeight` on the scrolled body is the only place the squeeze is
    // visible: a shrunk card and a card that happens to be short have the same
    // bounding box.
    expect(s).toContain('scrollHeight');
    expect(s).toContain('[data-testid="hosted-tool"]');
  });

  test('the crop is the effect card alone', () => {
    // The module card being closed changes nothing in the frame — which is
    // what makes closing it a framing decision rather than a different shot.
    expect(scene()).toContain('shoot(page, file, \'[data-testid="effect-host"]\')');
  });
});
