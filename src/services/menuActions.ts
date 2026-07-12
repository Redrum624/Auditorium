import type { AppState } from '../stores/appStore';
import { useAppStore } from '../stores/appStore';

export interface MenuCommand {
  id: string;
  label: string;
  shortcut?: string;
  enabled(s: AppState): boolean;
  run(): void | Promise<void>;
}

export interface MenuSection {
  title: 'File' | 'Edit' | 'Effects' | 'View' | 'Help';
  items: (MenuCommand | 'separator')[];
}

/** Module-level command registry, keyed by id. `registerCommands` overwrites by id
 * so later tasks can replace a stub registered here without duplicating entries. */
const registry = new Map<string, MenuCommand>();

export function registerCommands(cmds: MenuCommand[]): void {
  for (const cmd of cmds) {
    registry.set(cmd.id, cmd);
  }
}

export async function runCommand(id: string): Promise<void> {
  const cmd = registry.get(id);
  if (!cmd) return;
  if (!cmd.enabled(useAppStore.getState())) return;
  await cmd.run();
}

/** Fixed section/item layout. Ids are resolved against the registry live at
 * `getMenuSections()` call time, so registering a command after this module
 * loads (e.g. a later task replacing a stub) is reflected immediately. */
const LAYOUT: { title: MenuSection['title']; itemIds: (string | 'separator')[] }[] = [
  {
    title: 'File',
    itemIds: ['file.new', 'file.open', 'file.save', 'file.saveAs', 'file.export', 'separator', 'file.close'],
  },
  {
    title: 'Edit',
    itemIds: [
      'edit.undo',
      'edit.redo',
      'separator',
      'edit.cut',
      'edit.copy',
      'edit.paste',
      'edit.delete',
      'separator',
      'edit.selectAll',
    ],
  },
  { title: 'Effects', itemIds: ['effects.none'] },
  { title: 'View', itemIds: ['view.waveform', 'view.spectral', 'view.multitrack'] },
  { title: 'Help', itemIds: ['help.about'] },
];

/** Placeholder for any id referenced by LAYOUT but not (yet) registered. */
function fallbackCommand(id: string): MenuCommand {
  return { id, label: id, enabled: () => false, run: async () => {} };
}

export function getMenuSections(): MenuSection[] {
  return LAYOUT.map((section) => ({
    title: section.title,
    items: section.itemIds.map((id) =>
      id === 'separator' ? 'separator' : (registry.get(id) ?? fallbackCommand(id))
    ),
  }));
}

function stub(id: string, label: string, shortcut?: string): MenuCommand {
  return { id, label, shortcut, enabled: () => false, run: async () => {} };
}

/** Registers the File/Edit/View/Effects stub commands plus the working Help >
 * About command. Idempotent: re-running just overwrites the same ids with the
 * same values (registerCommands overwrites by id). Later tasks call
 * registerCommands() again to replace individual stubs with real behavior. */
function registerDefaultCommands(): void {
  registerCommands([
    stub('file.new', 'New', 'Ctrl+N'),
    stub('file.open', 'Open…', 'Ctrl+O'),
    stub('file.save', 'Save', 'Ctrl+S'),
    stub('file.saveAs', 'Save As…', 'Ctrl+Shift+S'),
    stub('file.export', 'Export…'),
    stub('file.close', 'Close', 'Ctrl+W'),

    stub('edit.undo', 'Undo', 'Ctrl+Z'),
    stub('edit.redo', 'Redo', 'Ctrl+Y'),
    stub('edit.cut', 'Cut', 'Ctrl+X'),
    stub('edit.copy', 'Copy', 'Ctrl+C'),
    stub('edit.paste', 'Paste', 'Ctrl+V'),
    stub('edit.delete', 'Delete', 'Del'),
    stub('edit.selectAll', 'Select All', 'Ctrl+A'),

    stub('effects.none', 'No effects loaded'),

    stub('view.waveform', 'Waveform'),
    stub('view.spectral', 'Spectral'),
    stub('view.multitrack', 'Multitrack'),

    {
      id: 'help.about',
      label: 'About Auditorium',
      enabled: () => true,
      run: async () => {
        const api = window.electronAPI;
        if (!api) return;
        const version = await api.getAppVersion();
        await api.showMessageBox({
          type: 'info',
          title: 'About Auditorium',
          message: `Auditorium\nVersion ${version}`,
        });
      },
    },
  ]);
}

registerDefaultCommands();
