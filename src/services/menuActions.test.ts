import { registerCommands, runCommand, getMenuSections } from './menuActions';
import type { MenuCommand, MenuSection } from './menuActions';
import { useAppStore, makeInitialState } from '../stores/appStore';

beforeEach(() => {
  useAppStore.setState(makeInitialState());
});

function commandIds(items: MenuSection['items']): string[] {
  return items
    .filter((item): item is MenuCommand => item !== 'separator')
    .map((item) => item.id);
}

describe('registerCommands', () => {
  it('overwrites an existing command by id instead of duplicating it', async () => {
    const first = jest.fn();
    const second = jest.fn();
    registerCommands([{ id: 'test.overwrite', label: 'First', enabled: () => true, run: first }]);
    registerCommands([{ id: 'test.overwrite', label: 'Second', enabled: () => true, run: second }]);

    await runCommand('test.overwrite');

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});

describe('runCommand', () => {
  it('runs the command when enabled() returns true', async () => {
    const run = jest.fn();
    registerCommands([{ id: 'test.enabled', label: 'Enabled', enabled: () => true, run }]);

    await runCommand('test.enabled');

    expect(run).toHaveBeenCalledTimes(1);
  });

  it('skips the command when enabled() returns false', async () => {
    const run = jest.fn();
    registerCommands([{ id: 'test.disabled', label: 'Disabled', enabled: () => false, run }]);

    await runCommand('test.disabled');

    expect(run).not.toHaveBeenCalled();
  });

  it('does nothing for an unregistered id', async () => {
    await expect(runCommand('test.does-not-exist')).resolves.toBeUndefined();
  });

  it('passes the current AppState to enabled()', async () => {
    const enabled = jest.fn(() => true);
    registerCommands([{ id: 'test.state', label: 'State', enabled, run: jest.fn() }]);

    await runCommand('test.state');

    expect(enabled).toHaveBeenCalledWith(useAppStore.getState());
  });
});

describe('getMenuSections', () => {
  it('returns exactly 5 sections in the documented order', () => {
    const sections = getMenuSections();
    expect(sections.map((s) => s.title)).toEqual(['File', 'Edit', 'Effects', 'View', 'Help']);
  });

  it('File section contains the documented command ids in order', () => {
    const file = getMenuSections().find((s) => s.title === 'File')!;
    expect(commandIds(file.items)).toEqual([
      'file.new',
      'file.open',
      'file.save',
      'file.saveAs',
      'file.export',
      'session.save',
      'session.open',
      'file.close',
    ]);
  });

  it('session.save is only enabled in the multitrack view; session.open is always enabled', () => {
    const file = getMenuSections().find((s) => s.title === 'File')!;
    const findCmd = (id: string) =>
      file.items.find((item): item is MenuCommand => item !== 'separator' && item.id === id)!;

    expect(findCmd('session.save').enabled(useAppStore.getState())).toBe(false);
    expect(findCmd('session.open').enabled(useAppStore.getState())).toBe(true);

    useAppStore.setState({ view: 'multitrack' });
    expect(findCmd('session.save').enabled(useAppStore.getState())).toBe(true);
  });

  it('Edit section contains the documented command ids in order', () => {
    const edit = getMenuSections().find((s) => s.title === 'Edit')!;
    expect(commandIds(edit.items)).toEqual([
      'edit.undo',
      'edit.redo',
      'edit.cut',
      'edit.copy',
      'edit.paste',
      'edit.delete',
      'edit.selectAll',
      'edit.convertSampleRate',
      'edit.convertChannels',
    ]);
  });

  it('File commands needing an active document report disabled when none is open', () => {
    const file = getMenuSections().find((s) => s.title === 'File')!;
    const saveCmd = file.items.find(
      (item): item is MenuCommand => item !== 'separator' && item.id === 'file.save'
    )!;
    expect(saveCmd.enabled(useAppStore.getState())).toBe(false);
  });

  it('Help section exposes an enabled about command', () => {
    const help = getMenuSections().find((s) => s.title === 'Help')!;
    const about = help.items.find(
      (item): item is MenuCommand => item !== 'separator' && item.id === 'help.about'
    );
    expect(about).toBeDefined();
    expect(about!.enabled(useAppStore.getState())).toBe(true);
  });

  it('later registerCommands calls are reflected live in getMenuSections', async () => {
    const run = jest.fn();
    registerCommands([{ id: 'file.new', label: 'New', enabled: () => true, run }]);

    const file = getMenuSections().find((s) => s.title === 'File')!;
    const newCmd = file.items.find(
      (item): item is MenuCommand => item !== 'separator' && item.id === 'file.new'
    )!;
    expect(newCmd.enabled(useAppStore.getState())).toBe(true);

    await runCommand('file.new');
    expect(run).toHaveBeenCalledTimes(1);
  });
});
