import { createDocument, docLength, nextId } from '../audio/AudioDocument';
import type { AppState, Marker } from '../stores/appStore';
import { useAppStore } from '../stores/appStore';
import { useSessionStore } from '../multitrack/sessionStore';
import { createClip } from '../multitrack/session';
import { mixdownSession } from '../multitrack/mixdown';
import { canRecord, transportPlayPause, transportRecord, transportStop } from './transportService';
import {
  cutSelection,
  copySelection,
  pasteAtCursor,
  deleteSelection,
  pushMarkerUndo,
} from './editOps';
import { canRedo, canUndo, redo, undo } from './undoHistory';
import { getClipboard } from './clipboard';
import { closeDocumentFlow, openFilesViaDialog, saveDocument } from './fileService';
import { openSessionViaDialog, saveSessionViaDialog } from '../multitrack/sessionFile';
import {
  openConvertDialog,
  openEffectDialog,
  openExportDialog,
  openNewFileDialog,
} from './dialogBus';
import { getAllEffects } from '../effects/EffectRegistry';
import { captureNoiseProfile } from './noiseProfile';
import { toggleSpectralScale } from './spectralScale';

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
    itemIds: [
      'file.new',
      'file.open',
      'file.save',
      'file.saveAs',
      'file.export',
      'session.save',
      'session.open',
      'multitrack.mixdown',
      'separator',
      'file.close',
    ],
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
      'separator',
      'edit.convertSampleRate',
      'edit.convertChannels',
      'separator',
      'multitrack.insertDoc',
      'multitrack.addTrack',
      'separator',
      'marker.add',
      'marker.next',
      'marker.prev',
    ],
  },
  { title: 'Effects', itemIds: ['effects.none'] },
  {
    title: 'View',
    itemIds: ['view.waveform', 'view.spectral', 'view.spectralScale', 'view.multitrack'],
  },
  { title: 'Help', itemIds: ['help.about'] },
];

/** Placeholder for any id referenced by LAYOUT but not (yet) registered. */
function fallbackCommand(id: string): MenuCommand {
  return { id, label: id, enabled: () => false, run: async () => {} };
}

/** Builds the Effects section's item ids live from the registry: a disabled
 * category-label item for each `EffectCategory`, followed by that category's
 * effects (both category and effect commands are registered by
 * `registerEffectCommands`). Falls back to the `effects.none` stub until any
 * effect is registered. */
function effectsSectionItemIds(): (string | 'separator')[] {
  const effects = getAllEffects();
  if (effects.length === 0) return ['noise.capture', 'separator', 'effects.none'];
  // 'Capture Noise Print' sits at the very top of the Effects menu (it feeds the
  // Noise Reduction effect), above the category-grouped effect list.
  const ids: (string | 'separator')[] = ['noise.capture', 'separator'];
  let lastCategory: string | null = null;
  for (const e of effects) {
    if (e.category !== lastCategory) {
      ids.push(`effects.cat.${e.category}`);
      lastCategory = e.category;
    }
    ids.push(`effect.${e.id}`);
  }
  return ids;
}

export function getMenuSections(): MenuSection[] {
  return LAYOUT.map((section) => {
    const itemIds = section.title === 'Effects' ? effectsSectionItemIds() : section.itemIds;
    return {
      title: section.title,
      items: itemIds.map((id) =>
        id === 'separator' ? 'separator' : (registry.get(id) ?? fallbackCommand(id))
      ),
    };
  });
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
      // View-routed: the multitrack view plays via the MultitrackPlayer, the
      // waveform/spectral view via the single-document PlaybackEngine. The
      // dispatch lives in transportService so the command id stays stable.
      id: 'transport.playPause',
      label: 'Play/Pause',
      shortcut: 'Space',
      enabled: (s) => s.view === 'multitrack' || activeDoc(s) !== null,
      run: async () => transportPlayPause(),
    },
    {
      id: 'transport.stop',
      label: 'Stop',
      enabled: (s) => s.view === 'multitrack' || activeDoc(s) !== null,
      run: async () => transportStop(),
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
    {
      // View-routed: the multitrack view punches into armed tracks; the
      // waveform/spectral views open the Record dialog. Enablement AND the
      // toggle/dispatch live in transportService (canRecord/transportRecord)
      // so the menu and the TransportBar share one source of truth.
      id: 'transport.record',
      label: 'Record',
      enabled: () => canRecord(),
      run: async () => transportRecord(),
    },
    stub('marker.add', 'Add Marker', 'M'),
    stub('marker.next', 'Next Marker'),
    stub('marker.prev', 'Previous Marker'),
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
      // In the multitrack view, Delete removes the selected clip; elsewhere it
      // deletes the active document's selected region (Task 22 view routing).
      id: 'edit.delete',
      label: 'Delete',
      shortcut: 'Del',
      enabled: (s) =>
        s.view === 'multitrack'
          ? useSessionStore.getState().selectedClipId !== null
          : hasSelection(s),
      run: async () => {
        if (useAppStore.getState().view === 'multitrack') {
          const clipId = useSessionStore.getState().selectedClipId;
          if (clipId) useSessionStore.getState().removeClip(clipId);
          return;
        }
        deleteSelection();
      },
    },
  ]);
}

/** Registers the real File > * commands (Task 11), overwriting the disabled
 * stubs. New/Open are always available; Save/Save As/Export/Close require an
 * active document. New and Export open React dialogs via the dialog bus; the
 * rest drive the fileService flows. run() is async so awaits propagate. */
function registerFileCommands(): void {
  const hasDoc = (s: AppState) => activeDoc(s) !== null;
  const activeId = () => useAppStore.getState().activeDocumentId;
  registerCommands([
    {
      id: 'file.new',
      label: 'New',
      shortcut: 'Ctrl+N',
      enabled: () => true,
      run: async () => openNewFileDialog(),
    },
    {
      id: 'file.open',
      label: 'Open…',
      shortcut: 'Ctrl+O',
      enabled: () => true,
      run: async () => {
        await openFilesViaDialog();
      },
    },
    {
      id: 'file.save',
      label: 'Save',
      shortcut: 'Ctrl+S',
      enabled: hasDoc,
      run: async () => {
        const id = activeId();
        if (id) await saveDocument(id);
      },
    },
    {
      id: 'file.saveAs',
      label: 'Save As…',
      shortcut: 'Ctrl+Shift+S',
      enabled: hasDoc,
      run: async () => {
        const id = activeId();
        if (id) await saveDocument(id, true);
      },
    },
    {
      id: 'file.export',
      label: 'Export…',
      shortcut: 'Ctrl+E',
      enabled: hasDoc,
      run: async () => openExportDialog(),
    },
    {
      id: 'file.close',
      label: 'Close',
      shortcut: 'Ctrl+W',
      enabled: hasDoc,
      run: async () => {
        const id = activeId();
        if (id) await closeDocumentFlow(id);
      },
    },
  ]);
}

/** Registers the multitrack session commands (Task 21): `session.save` writes
 * the current session as .audm and is only enabled while the multitrack view
 * is active (there's nothing meaningful to save otherwise); `session.open` is
 * always available and switches the view to 'multitrack' on success.
 *
 * F3 defense-in-depth: `runCommand` has no try/catch of its own, and before
 * this a thrown/rejected save or open propagated straight out through
 * MenuBar's onClick with nothing visible to the user (no .audm written, no
 * error). `saveSessionViaDialog`/`openSessionViaDialog` already catch their
 * own known failure points, but this wrapper ensures ANY escaping error —
 * known or not — still ends up in front of the user instead of vanishing. */
function registerSessionCommands(): void {
  registerCommands([
    {
      id: 'session.save',
      label: 'Save Session…',
      enabled: (s) => s.view === 'multitrack',
      run: async () => {
        try {
          await saveSessionViaDialog();
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          await window.electronAPI?.showMessageBox({ type: 'error', title: 'Save Session failed', message });
        }
      },
    },
    {
      id: 'session.open',
      label: 'Open Session…',
      enabled: () => true,
      run: async () => {
        try {
          await openSessionViaDialog();
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          await window.electronAPI?.showMessageBox({ type: 'error', title: 'Open Session failed', message });
        }
      },
    },
  ]);
}

/** Registers one command per registered effect (`effect.<id>`, opens the effect
 * dialog, enabled when a document is active) plus one disabled category-label
 * command per category (`effects.cat.<Category>`). Idempotent by id: re-running
 * after new effects register just overwrites/extends. Call after `registerAll`
 * has populated the effect registry (App.tsx does this at startup). */
export function registerEffectCommands(): void {
  const cmds: MenuCommand[] = [];
  for (const effect of getAllEffects()) {
    cmds.push({
      id: `effects.cat.${effect.category}`,
      label: effect.category,
      enabled: () => false,
      run: async () => {},
    });
    cmds.push({
      id: `effect.${effect.id}`,
      label: effect.name,
      enabled: (s) => activeDoc(s) !== null,
      run: async () => openEffectDialog(effect.id),
    });
  }
  registerCommands(cmds);
}

/** Registers the Task 19 restoration + view commands: `noise.capture` (top of
 * the Effects menu, enabled only when a selection exists — it profiles the
 * selected region), the real `view.waveform` / `view.spectral` toggles
 * (enabled when an active doc exists and that view isn't already current), and
 * `view.spectralScale` (Task F4 — flips the module-level spectral scale
 * setting; enabled only while the spectral view is active). `view.multitrack`
 * stays a disabled stub until Phase D. */
function registerNoiseAndViewCommands(): void {
  registerCommands([
    {
      id: 'noise.capture',
      label: 'Capture Noise Print',
      enabled: (s) => activeDoc(s) !== null && s.selection !== null,
      run: async () => {
        captureNoiseProfile();
        void window.electronAPI?.showMessageBox({
          type: 'info',
          title: 'Noise Print',
          message:
            'Noise print captured from the selection. Now run Effects → Noise Reduction.',
        });
      },
    },
    {
      id: 'view.waveform',
      label: 'Waveform',
      enabled: (s) => activeDoc(s) !== null && s.view !== 'waveform',
      run: async () => useAppStore.getState().setView('waveform'),
    },
    {
      id: 'view.spectral',
      label: 'Spectral',
      enabled: (s) => activeDoc(s) !== null && s.view !== 'spectral',
      run: async () => useAppStore.getState().setView('spectral'),
    },
    {
      id: 'view.spectralScale',
      label: 'Spectral: Toggle Log/Linear Scale',
      enabled: (s) => s.view === 'spectral',
      run: async () => toggleSpectralScale(),
    },
  ]);
}

/** Registers the whole-document conversion commands (Task 17) in the Edit menu.
 * Both open the ConvertDialog (via the dialog bus) in the matching mode and
 * require an active document. */
function registerDocumentToolCommands(): void {
  registerCommands([
    {
      id: 'edit.convertSampleRate',
      label: 'Convert Sample Rate…',
      enabled: (s) => activeDoc(s) !== null,
      run: async () => openConvertDialog('sampleRate'),
    },
    {
      id: 'edit.convertChannels',
      label: 'Convert Channels…',
      enabled: (s) => activeDoc(s) !== null,
      run: async () => openConvertDialog('channels'),
    },
  ]);
}

/** True when the current session has at least one clip on any track. */
function sessionHasClips(): boolean {
  return useSessionStore.getState().session.tracks.some((t) => t.clips.length > 0);
}

/** Inserts the entire active document as a clip at the multitrack cursor. The
 * target track is the one holding the selected clip, else the first track.
 * Clip length is expressed in session samples (converted when the document rate
 * differs from the session rate). No-op without an active doc or any track. */
function insertActiveDocAsClip(): void {
  const doc = activeDoc(useAppStore.getState());
  if (!doc) return;
  const store = useSessionStore.getState();
  const { session, selectedClipId, mtCursorSample } = store;
  if (session.tracks.length === 0) return;

  const owningTrack = selectedClipId
    ? session.tracks.find((t) => t.clips.some((c) => c.id === selectedClipId))
    : undefined;
  const targetTrack = owningTrack ?? session.tracks[0];

  const srcLen = docLength(doc);
  const lengthSample =
    doc.sampleRate === session.sampleRate
      ? srcLen
      : Math.round((srcLen * session.sampleRate) / doc.sampleRate);

  const clip = createClip({
    documentId: doc.id,
    startSample: mtCursorSample,
    offsetSample: 0,
    lengthSample,
  });
  store.addClip(targetTrack.id, clip);
  store.setSelectedClip(clip.id);
}

/** Renders the session offline to a stereo document, adds it to the Files
 * panel, and switches to the waveform view. Surfaces a message when there is
 * nothing audible to mix (empty / all-muted session). */
async function mixdownToNewFile(): Promise<void> {
  const session = useSessionStore.getState().session;
  const docs = new Map(useAppStore.getState().documents.map((d) => [d.id, d]));
  const { channels, sampleRate } = mixdownSession(session, docs);

  if (channels[0].length === 0) {
    await window.electronAPI?.showMessageBox({
      type: 'info',
      title: 'Mix Down',
      message: 'Nothing audible to mix down.',
    });
    return;
  }

  const n = nextId('mixdown').split('-')[1];
  const doc = createDocument({
    name: `Mixdown ${n}`,
    sampleRate,
    channels: [channels[0], channels[1]],
  });
  useAppStore.getState().addDocument(doc);
  useAppStore.getState().setView('waveform');
}

/** Registers the Task 22 multitrack commands: the real `view.multitrack`
 * toggle (always available — the multitrack view works with no open document),
 * `multitrack.addTrack`, `multitrack.insertDoc`, and `multitrack.mixdown`. The
 * three action commands are enabled only while the multitrack view is active. */
function registerMultitrackCommands(): void {
  registerCommands([
    {
      id: 'view.multitrack',
      label: 'Multitrack',
      enabled: (s) => s.view !== 'multitrack',
      run: async () => useAppStore.getState().setView('multitrack'),
    },
    {
      id: 'multitrack.addTrack',
      label: 'Add Track',
      enabled: (s) => s.view === 'multitrack',
      run: async () => useSessionStore.getState().addTrack(),
    },
    {
      id: 'multitrack.insertDoc',
      label: 'Insert Active File at Cursor',
      enabled: (s) => s.view === 'multitrack' && activeDoc(s) !== null,
      run: async () => insertActiveDocAsClip(),
    },
    {
      id: 'multitrack.mixdown',
      label: 'Mix Down to New File',
      enabled: (s) => s.view === 'multitrack' && sessionHasClips(),
      run: async () => mixdownToNewFile(),
    },
  ]);
}

/** Returns the active document's markers (sorted by position, per the store's
 * invariant), or `[]` when there is no active document. */
function activeDocMarkers(s: AppState): Marker[] {
  return s.activeDocumentId ? (s.markers[s.activeDocumentId] ?? []) : [];
}

/** Registers the real marker commands (Task 23), overwriting the disabled
 * `marker.add`/`marker.next`/`marker.prev` stubs. `marker.add` inserts a
 * sequentially-named marker (`Marker <n>`, n taken from the generated id's
 * suffix) at the cursor — the store keeps the array sorted by position.
 * `marker.next`/`marker.prev` jump the cursor to the nearest marker strictly
 * after/before it, with NO wraparound; both report enabled whenever the
 * active document has ANY marker at all (a cheap existence check, not a
 * directional one — see task resolution), and run() is a safe no-op when
 * there is nothing in that direction. */
function registerMarkerCommands(): void {
  registerCommands([
    {
      id: 'marker.add',
      label: 'Add Marker',
      shortcut: 'M',
      enabled: (s) => activeDoc(s) !== null,
      run: async () => {
        const { activeDocumentId, cursorSample, markers, addMarker } = useAppStore.getState();
        if (!activeDocumentId) return;
        const before = markers[activeDocumentId] ?? [];
        const id = nextId('marker');
        const n = id.split('-')[1];
        addMarker(activeDocumentId, { id, name: `Marker ${n}`, positionSample: cursorSample });
        const after = useAppStore.getState().markers[activeDocumentId] ?? [];
        pushMarkerUndo('Add Marker', activeDocumentId, before, after);
      },
    },
    {
      id: 'marker.next',
      label: 'Next Marker',
      enabled: (s) => activeDocMarkers(s).length > 0,
      run: async () => {
        const state = useAppStore.getState();
        const next = activeDocMarkers(state).find((m) => m.positionSample > state.cursorSample);
        if (next) state.setCursor(next.positionSample);
      },
    },
    {
      id: 'marker.prev',
      label: 'Previous Marker',
      enabled: (s) => activeDocMarkers(s).length > 0,
      run: async () => {
        const state = useAppStore.getState();
        let prev: Marker | undefined;
        for (const m of activeDocMarkers(state)) {
          if (m.positionSample < state.cursorSample) prev = m;
          else break;
        }
        if (prev) state.setCursor(prev.positionSample);
      },
    },
  ]);
}

registerDefaultCommands();
registerSelectionAndTransportCommands();
registerEditCommands();
registerFileCommands();
registerSessionCommands();
registerDocumentToolCommands();
registerNoiseAndViewCommands();
registerMultitrackCommands();
registerMarkerCommands();
