import { docLength } from '../audio/AudioDocument';
import { playbackEngine, type PlaybackPlayOptions } from '../audio/PlaybackEngine';
import type { AppState } from '../stores/appStore';
import { useAppStore } from '../stores/appStore';
import {
  cutSelection,
  copySelection,
  pasteAtCursor,
  deleteSelection,
} from './editOps';
import { canRedo, canUndo, redo, undo } from './undoHistory';
import { getClipboard } from './clipboard';

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

function activeDoc(s: AppState) {
  return s.documents.find((d) => d.id === s.activeDocumentId) ?? null;
}

/** Registers the selection/transport commands driven by keyboard shortcuts
 * (Task 8). `edit.selectAll`, `edit.deselect`, `transport.goToStart` and
 * `transport.goToEnd` are implemented against the store now; the rest of
 * transport and `marker.add` remain disabled stubs until their owning tasks
 * (9, 23) land. Overwrites the `edit.selectAll` stub registered above. */
function registerSelectionAndTransportCommands(): void {
  registerCommands([
    {
      id: 'edit.selectAll',
      label: 'Select All',
      shortcut: 'Ctrl+A',
      enabled: (s) => activeDoc(s) !== null,
      run: async () => {
        const { documents, activeDocumentId, setSelection } = useAppStore.getState();
        const doc = documents.find((d) => d.id === activeDocumentId);
        if (!doc) return;
        setSelection({ start: 0, end: docLength(doc) });
      },
    },
    {
      id: 'edit.deselect',
      label: 'Deselect',
      shortcut: 'Esc',
      enabled: (s) => s.selection !== null,
      run: async () => {
        useAppStore.getState().setSelection(null);
      },
    },
    {
      id: 'transport.goToStart',
      label: 'Go to Start',
      shortcut: 'Home',
      enabled: (s) => activeDoc(s) !== null,
      run: async () => {
        const { zoom, setCursor, setZoom } = useAppStore.getState();
        setCursor(0);
        setZoom({ samplesPerPixel: zoom.samplesPerPixel, scrollSample: 0 });
      },
    },
    {
      id: 'transport.goToEnd',
      label: 'Go to End',
      shortcut: 'End',
      enabled: (s) => activeDoc(s) !== null,
      run: async () => {
        const { documents, activeDocumentId, zoom, setCursor, setZoom } = useAppStore.getState();
        const doc = documents.find((d) => d.id === activeDocumentId);
        if (!doc) return;
        const len = docLength(doc);
        setCursor(len);
        // The service layer doesn't know the viewport width (only the
        // WaveformView component does), so it can't compute the exact
        // scrollSample that puts the cursor at the right edge. Simplify by
        // scrolling to the document length; any subsequent wheel zoom/scroll
        // in WaveformView clamps scrollSample back into its valid range
        // (see the onWheel handler's maxScroll), so this over-scroll is
        // self-correcting rather than a permanent stuck state.
        setZoom({ samplesPerPixel: zoom.samplesPerPixel, scrollSample: len });
      },
    },

    {
      id: 'transport.playPause',
      label: 'Play/Pause',
      shortcut: 'Space',
      enabled: (s) => activeDoc(s) !== null,
      run: async () => {
        const state = useAppStore.getState();
        if (!activeDoc(state)) return;
        const { selection, cursorSample, playback, setPlayback } = state;

        // Playing -> pause, keeping the current position.
        if (playbackEngine.state === 'playing') {
          playbackEngine.pause();
          setPlayback({ state: 'paused' });
          return;
        }

        // Resume from the paused sample, else start at the selection or cursor.
        const from =
          playbackEngine.state === 'paused'
            ? playbackEngine.getPositionSample()
            : selection
              ? selection.start
              : cursorSample;

        const opts: PlaybackPlayOptions = {};
        if (selection) {
          if (playback.loop) opts.loopRegion = selection;
          else opts.playRegion = selection;
        }
        playbackEngine.play(from, opts);
        setPlayback({ state: 'playing', positionSample: from });
      },
    },
    {
      id: 'transport.stop',
      label: 'Stop',
      enabled: (s) => activeDoc(s) !== null,
      run: async () => {
        playbackEngine.stop();
        useAppStore
          .getState()
          .setPlayback({ state: 'stopped', positionSample: playbackEngine.getPositionSample() });
      },
    },
    {
      id: 'transport.toggleLoop',
      label: 'Loop',
      enabled: (s) => activeDoc(s) !== null,
      run: async () => {
        const { playback, setPlayback } = useAppStore.getState();
        setPlayback({ loop: !playback.loop });
      },
    },
    stub('transport.record', 'Record'),
    stub('marker.add', 'Add Marker', 'M'),
  ]);
}

/** Registers the real destructive-edit and undo/redo commands (Task 10),
 * overwriting the disabled stubs. cut/copy/delete need an active doc + a
 * selection; paste needs an active doc + a non-empty clipboard; undo/redo are
 * gated on the active document's history stacks. */
function registerEditCommands(): void {
  const hasSelection = (s: AppState) => activeDoc(s) !== null && s.selection !== null;
  registerCommands([
    {
      id: 'edit.undo',
      label: 'Undo',
      shortcut: 'Ctrl+Z',
      enabled: (s) => s.activeDocumentId !== null && canUndo(s.activeDocumentId),
      run: async () => {
        const id = useAppStore.getState().activeDocumentId;
        if (id) undo(id);
      },
    },
    {
      id: 'edit.redo',
      label: 'Redo',
      shortcut: 'Ctrl+Y',
      enabled: (s) => s.activeDocumentId !== null && canRedo(s.activeDocumentId),
      run: async () => {
        const id = useAppStore.getState().activeDocumentId;
        if (id) redo(id);
      },
    },
    {
      id: 'edit.cut',
      label: 'Cut',
      shortcut: 'Ctrl+X',
      enabled: hasSelection,
      run: async () => cutSelection(),
    },
    {
      id: 'edit.copy',
      label: 'Copy',
      shortcut: 'Ctrl+C',
      enabled: hasSelection,
      run: async () => copySelection(),
    },
    {
      id: 'edit.paste',
      label: 'Paste',
      shortcut: 'Ctrl+V',
      enabled: (s) => activeDoc(s) !== null && getClipboard() !== null,
      run: async () => pasteAtCursor(),
    },
    {
      id: 'edit.delete',
      label: 'Delete',
      shortcut: 'Del',
      enabled: hasSelection,
      run: async () => deleteSelection(),
    },
  ]);
}

registerDefaultCommands();
registerSelectionAndTransportCommands();
registerEditCommands();
