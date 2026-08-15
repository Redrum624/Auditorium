import { createElement, StrictMode } from 'react';
import { render } from '@testing-library/react';
import { nextDialogToken, popDialog, pushDialog } from './dialogBus';
import * as menuActionsModule from './menuActions';
import { comboFromEvent, installShortcuts, SHORTCUT_TABLE } from './shortcuts';
import DialogShell from '../components/Dialogs/DialogShell';

// This file is .ts (not .tsx), so StrictMode-wrapped element trees below are
// built with createElement rather than JSX syntax.

function keydown(init: KeyboardEventInit): KeyboardEvent {
  return new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
}

describe('comboFromEvent', () => {
  it('normalizes a plain key to lowercase', () => {
    expect(comboFromEvent(keydown({ key: 'M' }))).toBe('m');
  });

  it('normalizes ctrl+z', () => {
    expect(comboFromEvent(keydown({ key: 'z', ctrlKey: true }))).toBe('ctrl+z');
  });

  it('orders modifiers as ctrl+shift+alt regardless of physical press order', () => {
    expect(comboFromEvent(keydown({ key: 'Z', ctrlKey: true, shiftKey: true }))).toBe(
      'ctrl+shift+z'
    );
    expect(
      comboFromEvent(keydown({ key: 'z', altKey: true, ctrlKey: true, shiftKey: true }))
    ).toBe('ctrl+shift+alt+z');
  });

  it('maps the space key to "space"', () => {
    expect(comboFromEvent(keydown({ key: ' ' }))).toBe('space');
  });

  it('maps Delete/Home/End/Escape to their lowercase names', () => {
    expect(comboFromEvent(keydown({ key: 'Delete' }))).toBe('delete');
    expect(comboFromEvent(keydown({ key: 'Home' }))).toBe('home');
    expect(comboFromEvent(keydown({ key: 'End' }))).toBe('end');
    expect(comboFromEvent(keydown({ key: 'Escape' }))).toBe('escape');
  });

  it('ignores standalone modifier keydowns', () => {
    expect(comboFromEvent(keydown({ key: 'Control' }))).toBe('');
    expect(comboFromEvent(keydown({ key: 'Shift' }))).toBe('');
    expect(comboFromEvent(keydown({ key: 'Alt' }))).toBe('');
    expect(comboFromEvent(keydown({ key: 'Meta' }))).toBe('');
  });
});

describe('SHORTCUT_TABLE', () => {
  it('contains exactly the documented combo -> command mappings', () => {
    expect(SHORTCUT_TABLE).toEqual([
      { combo: 'space', commandId: 'transport.playPause' },
      { combo: 'ctrl+z', commandId: 'edit.undo' },
      { combo: 'ctrl+shift+z', commandId: 'edit.redo' },
      { combo: 'ctrl+y', commandId: 'edit.redo' },
      { combo: 'ctrl+x', commandId: 'edit.cut' },
      { combo: 'ctrl+c', commandId: 'edit.copy' },
      { combo: 'ctrl+v', commandId: 'edit.paste' },
      { combo: 'delete', commandId: 'edit.delete' },
      { combo: 'shift+delete', commandId: 'edit.rippleDelete' }, // K1
      { combo: 'ctrl+a', commandId: 'edit.selectAll' },
      { combo: 'ctrl+arrowleft', commandId: 'multitrack.prevClipEdge' }, // K1
      { combo: 'ctrl+arrowright', commandId: 'multitrack.nextClipEdge' }, // K1
      { combo: 'home', commandId: 'transport.goToStart' },
      { combo: 'end', commandId: 'transport.goToEnd' },
      { combo: 'ctrl+o', commandId: 'file.open' },
      { combo: 'ctrl+s', commandId: 'file.save' },
      { combo: 'ctrl+n', commandId: 'file.new' },
      { combo: 'ctrl+shift+s', commandId: 'file.saveAs' }, // T4
      { combo: 'ctrl+w', commandId: 'file.close' },
      { combo: 'm', commandId: 'marker.add' },
      { combo: 'ctrl+e', commandId: 'file.export' },
      { combo: 'escape', commandId: 'edit.deselect' },
    ]);
  });

  it('carries the Ctrl+W the File > Close menu row advertises', () => {
    // The menu row and the key that runs it are two separate tables, and they
    // drifted: `file.close` has advertised Ctrl+W since Task 11 with no entry
    // here, so the label named a key that did nothing.
    expect(SHORTCUT_TABLE).toContainEqual({ combo: 'ctrl+w', commandId: 'file.close' });
  });

  it('carries the Ctrl+Shift+S the File > Save As row advertises', () => {
    // The third of the same drift. `file.saveAs` has advertised Ctrl+Shift+S
    // with no entry here, so the row named a key that did nothing — the exact
    // shape of the Ctrl+W defect above, found by the same reading and left
    // recorded rather than fixed for three releases.
    expect(SHORTCUT_TABLE).toContainEqual({ combo: 'ctrl+shift+s', commandId: 'file.saveAs' });
  });

  /** A menu row's accelerator LABEL, spelled the way a user writes it, as the
   * combo `comboFromEvent` produces for the key that would be pressed. Only the
   * spellings the menu actually uses are handled; an unknown one throws rather
   * than quietly normalising to something that is in the table. */
  const labelToCombo = (label: string): string =>
    label
      .toLowerCase()
      .split('+')
      .map((part) => {
        const named: Record<string, string> = {
          esc: 'escape',
          del: 'delete',
          left: 'arrowleft',
          right: 'arrowright',
          up: 'arrowup',
          down: 'arrowdown',
        };
        if (part in named) return named[part];
        if (/^(ctrl|shift|alt|space|home|end|delete|escape|[a-z0-9])$/.test(part)) return part;
        throw new Error(`unhandled accelerator spelling: ${JSON.stringify(part)} in ${label}`);
      })
      .join('+');

  it('every accelerator the menus ADVERTISE is a key that actually runs', () => {
    // The general form of the two tests above, and the reason there should not
    // need to be a third. A `shortcut` string on a menu row is a promise to the
    // user; this repo has now paid for that promise being broken twice (Ctrl+W,
    // Ctrl+Shift+S), each time found by reading rather than by a test. The
    // promise is checkable, so it is checked: every advertised label must
    // normalise to a combo the table binds, and to the SAME command the row
    // runs.
    // The registry is populated at menuActions module scope, so importing it is
    // all the setup this needs.
    const bound = new Map(SHORTCUT_TABLE.map((s) => [s.combo, s.commandId]));
    const advertised: { id: string; label: string; combo: string }[] = [];
    for (const section of menuActionsModule.getMenuSections()) {
      for (const item of section.items) {
        if (item === 'separator' || !item.shortcut) continue;
        advertised.push({ id: item.id, label: item.shortcut, combo: labelToCombo(item.shortcut) });
      }
    }
    const dead = advertised.filter((a) => bound.get(a.combo) !== a.id);
    expect(dead).toEqual([]);
    // Not vacuous: the menus really do advertise accelerators, and the
    // normaliser really did convert the awkward spellings rather than passing
    // over labels it could not read. (`Esc` is NOT among them — `edit.deselect`
    // is registered with that label but sits in no LAYOUT section, so no row
    // advertises it and nothing here is owed about it.)
    expect(advertised.length).toBeGreaterThanOrEqual(15);
    const combos = advertised.map((a) => a.combo);
    expect(combos).toContain('ctrl+shift+s'); // 'Ctrl+Shift+S'
    expect(combos).toContain('ctrl+arrowleft'); // 'Ctrl+Left'
    expect(combos).toContain('shift+delete'); // 'Shift+Del'
  });

  it('…and the check would notice a label naming a key nothing binds', () => {
    // Guards the guard: `labelToCombo` must not map an unbound spelling onto a
    // bound one, which is the only way the sweep above could pass while a label
    // stayed dead.
    expect(labelToCombo('Ctrl+Shift+S')).toBe('ctrl+shift+s');
    expect(labelToCombo('Shift+Del')).toBe('shift+delete');
    expect(labelToCombo('Ctrl+Left')).toBe('ctrl+arrowleft');
    expect(labelToCombo('Esc')).toBe('escape');
    const bound = new Set(SHORTCUT_TABLE.map((s) => s.combo));
    expect(bound.has(labelToCombo('Ctrl+Shift+Q'))).toBe(false);
    expect(() => labelToCombo('Ctrl+F13')).toThrow(/unhandled accelerator/);
  });
});

describe('installShortcuts', () => {
  let uninstall: (() => void) | null = null;

  afterEach(() => {
    uninstall?.();
    uninstall = null;
    jest.restoreAllMocks();
  });

  it('dispatches runCommand for a matching combo', () => {
    const runCommandSpy = jest.spyOn(menuActionsModule, 'runCommand').mockResolvedValue(undefined);
    uninstall = installShortcuts(window);

    window.dispatchEvent(keydown({ key: 'z', ctrlKey: true }));

    expect(runCommandSpy).toHaveBeenCalledWith('edit.undo');
  });

  it('dispatches runCommand("file.close") for ctrl+w', () => {
    const runCommandSpy = jest.spyOn(menuActionsModule, 'runCommand').mockResolvedValue(undefined);
    uninstall = installShortcuts(window);

    window.dispatchEvent(keydown({ key: 'w', ctrlKey: true }));

    // `file.close` is `closeDocumentFlow`, which prompts before discarding
    // unsaved work — the accelerator inherits that guard for free.
    expect(runCommandSpy).toHaveBeenCalledWith('file.close');
  });

  it('dispatches runCommand("transport.playPause") for the space key', () => {
    const runCommandSpy = jest.spyOn(menuActionsModule, 'runCommand').mockResolvedValue(undefined);
    uninstall = installShortcuts(window);

    window.dispatchEvent(keydown({ key: ' ' }));

    expect(runCommandSpy).toHaveBeenCalledWith('transport.playPause');
  });

  // K1 — the three new bindings, driven from a REAL keydown rather than from
  // the table. The table rows encode what `comboFromEvent` produces, and for
  // the arrows that is a claim about the DOM (`e.key` is 'ArrowLeft', not
  // 'Left'), which only a dispatched event can check. A typo in either half
  // would leave a menu row advertising a key that does nothing — the exact
  // defect this repo has already paid for twice.
  it.each([
    ['ArrowLeft', { ctrlKey: true }, 'multitrack.prevClipEdge'],
    ['ArrowRight', { ctrlKey: true }, 'multitrack.nextClipEdge'],
    ['Delete', { shiftKey: true }, 'edit.rippleDelete'],
  ])('dispatches %s to its multitrack command', (key, mods, commandId) => {
    const runCommandSpy = jest.spyOn(menuActionsModule, 'runCommand').mockResolvedValue(undefined);
    uninstall = installShortcuts(window);

    window.dispatchEvent(keydown({ key, ...mods }));

    expect(runCommandSpy).toHaveBeenCalledWith(commandId);
  });

  it('leaves an UNMODIFIED arrow key alone — only Ctrl+arrow is bound', () => {
    const runCommandSpy = jest.spyOn(menuActionsModule, 'runCommand').mockResolvedValue(undefined);
    uninstall = installShortcuts(window);

    window.dispatchEvent(keydown({ key: 'ArrowLeft' }));
    window.dispatchEvent(keydown({ key: 'ArrowRight' }));

    expect(runCommandSpy).not.toHaveBeenCalled();
  });

  it('keeps plain Delete on edit.delete — Shift is what makes it a ripple', () => {
    const runCommandSpy = jest.spyOn(menuActionsModule, 'runCommand').mockResolvedValue(undefined);
    uninstall = installShortcuts(window);

    window.dispatchEvent(keydown({ key: 'Delete' }));

    expect(runCommandSpy).toHaveBeenCalledWith('edit.delete');
  });

  it('calls preventDefault on a matched combo', () => {
    jest.spyOn(menuActionsModule, 'runCommand').mockResolvedValue(undefined);
    uninstall = installShortcuts(window);

    const event = keydown({ key: 'z', ctrlKey: true });
    const preventSpy = jest.spyOn(event, 'preventDefault');
    window.dispatchEvent(event);

    expect(preventSpy).toHaveBeenCalled();
  });

  it('does nothing for an unmapped combo', () => {
    const runCommandSpy = jest.spyOn(menuActionsModule, 'runCommand').mockResolvedValue(undefined);
    uninstall = installShortcuts(window);

    window.dispatchEvent(keydown({ key: 'q', ctrlKey: true }));

    expect(runCommandSpy).not.toHaveBeenCalled();
  });

  it('ignores keydown events targeting an <input> element', () => {
    const runCommandSpy = jest.spyOn(menuActionsModule, 'runCommand').mockResolvedValue(undefined);
    uninstall = installShortcuts(window);

    const input = document.createElement('input');
    document.body.appendChild(input);
    input.dispatchEvent(keydown({ key: 'z', ctrlKey: true }));
    document.body.removeChild(input);

    expect(runCommandSpy).not.toHaveBeenCalled();
  });

  it('ignores keydown events targeting a <textarea> element', () => {
    const runCommandSpy = jest.spyOn(menuActionsModule, 'runCommand').mockResolvedValue(undefined);
    uninstall = installShortcuts(window);

    const textarea = document.createElement('textarea');
    document.body.appendChild(textarea);
    textarea.dispatchEvent(keydown({ key: ' ' }));
    document.body.removeChild(textarea);

    expect(runCommandSpy).not.toHaveBeenCalled();
  });

  it('ignores keydown events targeting a <select> element', () => {
    const runCommandSpy = jest.spyOn(menuActionsModule, 'runCommand').mockResolvedValue(undefined);
    uninstall = installShortcuts(window);

    const select = document.createElement('select');
    document.body.appendChild(select);
    select.dispatchEvent(keydown({ key: 'z', ctrlKey: true }));
    document.body.removeChild(select);

    expect(runCommandSpy).not.toHaveBeenCalled();
  });

  it('ignores keydown events targeting a contentEditable element', () => {
    const runCommandSpy = jest.spyOn(menuActionsModule, 'runCommand').mockResolvedValue(undefined);
    uninstall = installShortcuts(window);

    const div = document.createElement('div');
    // jsdom does not implement isContentEditable (always undefined), so define
    // it explicitly to exercise the contentEditable ignore branch.
    Object.defineProperty(div, 'isContentEditable', { value: true });
    document.body.appendChild(div);
    div.dispatchEvent(keydown({ key: 'z', ctrlKey: true }));
    document.body.removeChild(div);

    expect(runCommandSpy).not.toHaveBeenCalled();
  });

  it('ignores keydown events while composing (IME)', () => {
    const runCommandSpy = jest.spyOn(menuActionsModule, 'runCommand').mockResolvedValue(undefined);
    uninstall = installShortcuts(window);

    window.dispatchEvent(keydown({ key: 'z', ctrlKey: true, isComposing: true }));

    expect(runCommandSpy).not.toHaveBeenCalled();
  });

  it('returns an uninstaller that removes the listener', () => {
    const runCommandSpy = jest.spyOn(menuActionsModule, 'runCommand').mockResolvedValue(undefined);
    const remove = installShortcuts(window);
    remove();

    window.dispatchEvent(keydown({ key: 'z', ctrlKey: true }));

    expect(runCommandSpy).not.toHaveBeenCalled();
  });

  describe('dialog-open gate (Task M7/F10)', () => {
    // Cleanup lives in afterEach (fix round 1), not at the end of each test
    // body: a failing expect() throws and skips a trailing popDialog() call,
    // leaking the token into dialogBus's module-level stack and cascading
    // false "dialog still open" failures into every later test in this file.
    let openToken: number | null = null;

    afterEach(() => {
      if (openToken !== null) {
        popDialog(openToken);
        openToken = null;
      }
    });

    it('does nothing for a shortcut while a dialog is open, even for a combo normally mapped', () => {
      const runCommandSpy = jest
        .spyOn(menuActionsModule, 'runCommand')
        .mockResolvedValue(undefined);
      uninstall = installShortcuts(window);
      openToken = nextDialogToken();
      pushDialog(openToken);

      window.dispatchEvent(keydown({ key: 'o', ctrlKey: true })); // ctrl+o -> file.open

      expect(runCommandSpy).not.toHaveBeenCalled();
    });

    it('does not call preventDefault while a dialog is open (so the key still does its native thing, e.g. nothing)', () => {
      jest.spyOn(menuActionsModule, 'runCommand').mockResolvedValue(undefined);
      uninstall = installShortcuts(window);
      openToken = nextDialogToken();
      pushDialog(openToken);

      const event = keydown({ key: 'z', ctrlKey: true });
      const preventSpy = jest.spyOn(event, 'preventDefault');
      window.dispatchEvent(event);

      expect(preventSpy).not.toHaveBeenCalled();
    });

    it('resumes dispatching once the dialog closes', () => {
      const runCommandSpy = jest
        .spyOn(menuActionsModule, 'runCommand')
        .mockResolvedValue(undefined);
      uninstall = installShortcuts(window);
      const token = nextDialogToken();
      pushDialog(token);
      popDialog(token); // closed within the test itself; afterEach has nothing to do

      window.dispatchEvent(keydown({ key: 'o', ctrlKey: true }));

      expect(runCommandSpy).toHaveBeenCalledWith('file.open');
    });

    it('is respected for a real StrictMode-rendered dialog, and lifts cleanly on unmount (fix round 1 regression)', () => {
      // Regression coverage for the StrictMode double-invoke bug (fix round
      // 1): a real DialogShell mount used to leak a token under <StrictMode>,
      // leaving hasOpenDialog() permanently true and every shortcut dead
      // after the dialog closed. Exercises the gate end-to-end through an
      // actual component instead of manual pushDialog/popDialog calls.
      const runCommandSpy = jest
        .spyOn(menuActionsModule, 'runCommand')
        .mockResolvedValue(undefined);
      uninstall = installShortcuts(window);

      const { unmount } = render(
        createElement(
          StrictMode,
          null,
          createElement(DialogShell, { title: 'Test', onClose: () => {}, children: 'content' })
        )
      );

      window.dispatchEvent(keydown({ key: 'o', ctrlKey: true }));
      expect(runCommandSpy).not.toHaveBeenCalled();

      unmount();

      window.dispatchEvent(keydown({ key: 'o', ctrlKey: true }));
      expect(runCommandSpy).toHaveBeenCalledWith('file.open');
    });
  });
});
