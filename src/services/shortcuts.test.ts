import * as menuActionsModule from './menuActions';
import { comboFromEvent, installShortcuts, SHORTCUT_TABLE } from './shortcuts';

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
      { combo: 'ctrl+a', commandId: 'edit.selectAll' },
      { combo: 'home', commandId: 'transport.goToStart' },
      { combo: 'end', commandId: 'transport.goToEnd' },
      { combo: 'ctrl+o', commandId: 'file.open' },
      { combo: 'ctrl+s', commandId: 'file.save' },
      { combo: 'ctrl+n', commandId: 'file.new' },
      { combo: 'm', commandId: 'marker.add' },
      { combo: 'ctrl+e', commandId: 'file.export' },
      { combo: 'escape', commandId: 'edit.deselect' },
    ]);
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

  it('dispatches runCommand("transport.playPause") for the space key', () => {
    const runCommandSpy = jest.spyOn(menuActionsModule, 'runCommand').mockResolvedValue(undefined);
    uninstall = installShortcuts(window);

    window.dispatchEvent(keydown({ key: ' ' }));

    expect(runCommandSpy).toHaveBeenCalledWith('transport.playPause');
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
});
