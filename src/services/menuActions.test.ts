import { registerCommands, runCommand, getMenuSections } from './menuActions';
import type { MenuCommand, MenuSection } from './menuActions';
import { useAppStore, makeInitialState } from '../stores/appStore';
import { createDocument } from '../audio/AudioDocument';
import { getSpectralScale, toggleSpectralScale } from './spectralScale';

beforeEach(() => {
  useAppStore.setState(makeInitialState());
});

function openDoc() {
  const doc = createDocument({ name: 'a', sampleRate: 44100, channels: [new Float32Array(1000)] });
  useAppStore.getState().addDocument(doc);
  return doc;
}

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
      'multitrack.mixdown',
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
      'multitrack.insertDoc',
      'multitrack.addTrack',
      'marker.add',
      'marker.next',
      'marker.prev',
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

describe('marker commands (Task 23)', () => {
  function findEditCmd(id: string): MenuCommand {
    const edit = getMenuSections().find((s) => s.title === 'Edit')!;
    return edit.items.find((item): item is MenuCommand => item !== 'separator' && item.id === id)!;
  }

  describe('marker.add', () => {
    it('is disabled with no active document', () => {
      expect(findEditCmd('marker.add').enabled(useAppStore.getState())).toBe(false);
    });

    it('adds a marker named "Marker N" at the cursor, N taken from the generated id', async () => {
      const doc = openDoc();
      useAppStore.getState().setCursor(777);

      expect(findEditCmd('marker.add').enabled(useAppStore.getState())).toBe(true);
      await runCommand('marker.add');

      const markers = useAppStore.getState().markers[doc.id];
      expect(markers).toHaveLength(1);
      expect(markers[0].positionSample).toBe(777);
      expect(markers[0].name).toBe(`Marker ${markers[0].id.split('-')[1]}`);
    });

    it('keeps adding markers sorted by position (store invariant, exercised through the command)', async () => {
      const doc = openDoc();
      useAppStore.getState().setCursor(500);
      await runCommand('marker.add');
      useAppStore.getState().setCursor(100);
      await runCommand('marker.add');

      const positions = useAppStore.getState().markers[doc.id].map((m) => m.positionSample);
      expect(positions).toEqual([100, 500]);
    });
  });

  describe('marker.next / marker.prev', () => {
    it('are disabled with no active document or when the active document has no markers', () => {
      expect(findEditCmd('marker.next').enabled(useAppStore.getState())).toBe(false);
      expect(findEditCmd('marker.prev').enabled(useAppStore.getState())).toBe(false);

      openDoc();
      expect(findEditCmd('marker.next').enabled(useAppStore.getState())).toBe(false);
      expect(findEditCmd('marker.prev').enabled(useAppStore.getState())).toBe(false);
    });

    it('are enabled once any marker exists, even from the wrong side (cheap existence check)', async () => {
      openDoc();
      useAppStore.getState().setCursor(1000);
      await runCommand('marker.add'); // single marker at 1000

      // Cursor is already past the only marker: marker.next has nothing ahead,
      // but enabled() is a cheap "any marker exists" check per the resolution.
      expect(findEditCmd('marker.next').enabled(useAppStore.getState())).toBe(true);
      expect(findEditCmd('marker.prev').enabled(useAppStore.getState())).toBe(true);
    });

    it('marker.next jumps the cursor to the nearest marker after the cursor, no wrap', async () => {
      openDoc();
      useAppStore.getState().setCursor(100);
      await runCommand('marker.add'); // marker at 100
      useAppStore.getState().setCursor(500);
      await runCommand('marker.add'); // marker at 500
      useAppStore.getState().setCursor(900);
      await runCommand('marker.add'); // marker at 900

      useAppStore.getState().setCursor(150);
      await runCommand('marker.next');
      expect(useAppStore.getState().cursorSample).toBe(500);

      await runCommand('marker.next');
      expect(useAppStore.getState().cursorSample).toBe(900);

      // No marker after 900: cursor stays put (no wrap).
      await runCommand('marker.next');
      expect(useAppStore.getState().cursorSample).toBe(900);
    });

    it('marker.prev jumps the cursor to the nearest marker before the cursor, no wrap', async () => {
      openDoc();
      useAppStore.getState().setCursor(100);
      await runCommand('marker.add'); // marker at 100
      useAppStore.getState().setCursor(500);
      await runCommand('marker.add'); // marker at 500
      useAppStore.getState().setCursor(900);
      await runCommand('marker.add'); // marker at 900

      useAppStore.getState().setCursor(850);
      await runCommand('marker.prev');
      expect(useAppStore.getState().cursorSample).toBe(500);

      await runCommand('marker.prev');
      expect(useAppStore.getState().cursorSample).toBe(100);

      // No marker before 100: cursor stays put (no wrap).
      await runCommand('marker.prev');
      expect(useAppStore.getState().cursorSample).toBe(100);
    });

    it('marker.next/prev at a position exactly on a marker jump to the next/previous DIFFERENT marker (strict inequality)', async () => {
      openDoc();
      useAppStore.getState().setCursor(100);
      await runCommand('marker.add');
      useAppStore.getState().setCursor(500);
      await runCommand('marker.add');

      useAppStore.getState().setCursor(100); // exactly on the first marker
      await runCommand('marker.next');
      expect(useAppStore.getState().cursorSample).toBe(500);

      useAppStore.getState().setCursor(500); // exactly on the second marker
      await runCommand('marker.prev');
      expect(useAppStore.getState().cursorSample).toBe(100);
    });
  });
});

describe('view.spectralScale (Task F4)', () => {
  afterEach(() => {
    // The scale store is module-level; restore the documented default.
    if (getSpectralScale() !== 'log') toggleSpectralScale();
  });

  function findViewCmd(id: string): MenuCommand {
    const view = getMenuSections().find((s) => s.title === 'View')!;
    return view.items.find((item): item is MenuCommand => item !== 'separator' && item.id === id)!;
  }

  it('is registered in the View section, after view.spectral', () => {
    const view = getMenuSections().find((s) => s.title === 'View')!;
    const ids = view.items
      .filter((item): item is MenuCommand => item !== 'separator')
      .map((item) => item.id);
    expect(ids).toContain('view.spectralScale');
    expect(ids.indexOf('view.spectralScale')).toBeGreaterThan(ids.indexOf('view.spectral'));
  });

  it('is enabled only while the spectral view is active', () => {
    useAppStore.setState({ view: 'waveform' });
    expect(findViewCmd('view.spectralScale').enabled(useAppStore.getState())).toBe(false);

    useAppStore.setState({ view: 'spectral' });
    expect(findViewCmd('view.spectralScale').enabled(useAppStore.getState())).toBe(true);
  });

  it('running it toggles the spectral scale store', async () => {
    expect(getSpectralScale()).toBe('log');
    useAppStore.setState({ view: 'spectral' });

    await runCommand('view.spectralScale');
    expect(getSpectralScale()).toBe('linear');

    await runCommand('view.spectralScale');
    expect(getSpectralScale()).toBe('log');
  });
});
