import { createDocument, docLength, nextId } from '../audio/AudioDocument';
import type { AppState, Marker } from '../stores/appStore';
import { applyEditorZoom, useAppStore } from '../stores/appStore';
import {
  applySessionZoom,
  closeGap, // D3
  removeClips,
  rippleDeleteClips,
  splitClipsAt,
  splitTargets,
  useSessionStore,
} from '../multitrack/sessionStore';
import { clipBoundaries, nextClipEdge } from '../multitrack/clipEdges'; // K1
import { sessionEndSample } from '../multitrack/sessionZoom'; // T5
import { sessionLaneWidth } from '../multitrack/sessionViewport'; // T5
import { clipSourceWindow } from '../multitrack/session'; // lot E
import { resolveRegion } from './selectionRegion'; // lot E
import { editorLaneWidth } from './editorViewport'; // lot E
import { placeDocumentsOnTrack } from '../multitrack/sessionInsert';
import { mixdownSession } from '../multitrack/mixdown';
import { bakeMergedClip, commitMergedClips, mergeTargets } from '../multitrack/mergeClips';
import { canRecord, transportPlayPause, transportRecord, transportStop } from './transportService';
import {
  cutSelection,
  copySelection,
  pasteAtCursor,
  deleteSelection,
  pushMarkerUndo,
  rippleDeleteSelection,
  silenceSelection,
  splitAtCursor,
  trimToSelection,
} from './editOps';
import { cursorSegment } from './segments';
import { canRedo, canUndo, redo, undo } from './undoHistory';
import { canRedoSession, canUndoSession, redoSession, undoSession } from '../multitrack/sessionUndo';
import { getClipboard } from './clipboard';
import { closeDocumentFlow, openFilesViaDialog, projectHasUnsavedWork } from './fileService';
import { openSessionViaDialog, saveProject } from '../multitrack/sessionFile';
import {
  openConvertDialog,
  openEffectDialog,
  openExportDialog,
  openNewFileDialog,
  openRemixDialog,
  openSeparateDialog,
  openTranscribeDialog,
  openVoiceChangerDialog,
  openTempoDialog,
  openAlignLyricsDialog,
  openAlignTimingDialog,
  openVocalChainDialog,
  openCoverChainDialog,
  openPodcastChainDialog,
  focusSpatialPanel,
  focusTranscriptPanel,
} from './dialogBus';
import { getTranscript } from './transcribeService';
import { getVisibleEffects } from '../effects/EffectRegistry';
import { captureNoiseProfile } from './noiseProfile';
import { toggleSpectralScale } from './spectralScale';
import { toggleBeatGrid } from './beatGridDisplay';
import { toggleSnap } from './snapPreference';
import { runTempoAnalysis } from './tempoAnalysis';

export interface MenuCommand {
  id: string;
  label: string;
  shortcut?: string;
  enabled(s: AppState): boolean;
  run(): void | Promise<void>;
}

export interface MenuSection {
  /** F11-7: 'Pipeline' widens what had been a five-title closed union.
   *
   * Plan Ruling 5 said NOT to widen it "for a handful of analysis/transform
   * commands", and every command that wanted a home since has been argued into
   * Effects or Edit against that ruling. The user has overruled it: those
   * commands live in a top-level Pipeline menu now. The ruling is kept on
   * the record here rather than deleted — it was a real constraint, the
   * decisions it produced are all over this file's comments, and it stopped
   * applying by request rather than by being wrong. */
  title: 'File' | 'Edit' | 'Effects' | 'Pipeline' | 'View' | 'Help';
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

/**
 * Whether a registered command would run right now — the command's OWN
 * predicate, read against the live store, so no second surface has to restate
 * a rule the menu already owns. An unregistered id is disabled, matching
 * `fallbackCommand` (and `runCommand`, which silently no-ops on one).
 *
 * U1: added for the E2 edit toolbar's per-button greying. The Edit menu reads
 * `item.enabled(...)` directly off the section it was handed; a toolbar holds
 * ids, not commands, and this is the honest way to ask the same question.
 */
export function isCommandEnabled(id: string): boolean {
  const cmd = registry.get(id);
  return cmd !== undefined && cmd.enabled(useAppStore.getState());
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
      // T4: Record. This command was in NO section, which made the Record
      // dialog the one dialog in the app a menu-only user could not open —
      // its doors were the transport bar's button and nothing else. Filed
      // here, after Open, because New / Open / Record are the three ways audio
      // gets in front of you; File already carries a non-`file.*` id on the
      // same principle (`multitrack.mixdown` makes material too).
      //
      // The label stays 'Record' with no ellipsis. The row opens a dialog in
      // the waveform/spectral views but punches straight in on the armed
      // tracks in the multitrack view (transportService.transportRecord), so
      // an ellipsis would be a promise it breaks half the time.
      'transport.record',
      'file.save',
      'file.saveAs',
      'file.export',
      // lot A (M4): `session.save` is folded into Save As — no duplicate rows.
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
      // Item 8 (M1): Split at Cursor is the row before Cut — the verb that
      // makes the segments Ctrl+X then cuts.
      'edit.split',
      // D6: Split's inverse, the row directly after it — the verb that cuts a
      // clip in two and the verb that makes two clips one read together.
      'multitrack.mergeClips',
      'edit.cut',
      'edit.copy',
      'edit.paste',
      'edit.delete',
      // K1: the same verb with the gap closed behind it. Directly after
      // Delete, because that is the row a user comparing the two reads next.
      'edit.rippleDelete',
      // T5: and the range form of it, listed and permanently greyed — see the
      // command's own note for why it cannot be built yet.
      'edit.rippleDeleteTime',
      // M1: Trim and Silence act on the same `[start, end)` selection as the
      // four above and share Cut's predicate, so they belong in that group
      // rather than behind a separator of their own. Until now the floating
      // edit toolbar was their only surface — mouse-reachable and nowhere
      // else, so anyone who looked for them where every other edit verb lives
      // found nothing. Neither carries a shortcut label: neither has a combo
      // in SHORTCUT_TABLE, and this repo has just paid for two labels that
      // named keys doing nothing.
      'edit.trim',
      'edit.silence',
      'separator',
      'edit.selectAll',
      'separator',
      'edit.convertSampleRate',
      'edit.convertChannels',
      // F11-7: the long-inference group that sat here — Auto-Remix, Separate
      // into Stems, Transcribe, Voice Changer — moved to the Pipeline section
      // below, taking its separator with it so this list keeps one separator
      // between each surviving group.
      'separator',
      'multitrack.insertDoc',
      'multitrack.addTrack',
      // K1: cursor navigation over the session's edit points. Filed with the
      // multitrack group rather than with the markers below, because these two
      // exist only in that view and the marker pair exists only outside it.
      'multitrack.prevClipEdge',
      'multitrack.nextClipEdge',
      'separator',
      'marker.add',
      'marker.next',
      'marker.prev',
    ],
  },
  { title: 'Effects', itemIds: ['effects.none'] },
  {
    // F11-7. Ten advanced tools, MOVED here — six out of the Effects menu's
    // head (Detect Tempo, Match Tempo, Align Vocal Timing, Align Lyrics, Vocal
    // Chain, Cover Chain) and four out of the Edit menu's long-inference group
    // (Auto-Remix, Separate into Stems, Transcribe, Voice Changer). Nothing
    // about the commands themselves changed: same ids, same predicates, same
    // run bodies, same (absent) shortcuts. Only where the user finds them.
    // F11-8 then ADDED an eleventh that was moved from nowhere — the Spatial
    // Positioner — and T8 moved that one OUT again, to the Effects menu, on
    // the user's direction ("move the Spacial tool to the effects module").
    // Ten rows again; count the list below, not this sentence.
    //
    // The groups are by SUBJECT, which is a deliberate change of basis.
    // The Effects head listed Align Vocal Timing → Align Lyrics → Vocal Chain
    // in RUN order, and each of those stages' notes argued its own position;
    // grouping by subject puts Align Lyrics at the end of Voice instead, so the
    // menu no longer encodes sequence. The stage notes in `vocalChain.ts` and
    // `coverChain.ts` remain the surface that does, and each one names the
    // menu path to run it from — those strings moved with this section.
    title: 'Pipeline',
    itemIds: [
      // Tempo & Timing — everything that answers "this is not in time".
      'tempo.detect',
      'tempo.match',
      'timing.align',
      'edit.remix',
      'separator',
      // Voice — everything that reshapes a vocal take.
      // D7: Separate Voice OPENS the group. Isolating the voice precedes
      // reshaping it, so every row below operates on what it produced — the
      // one place this menu still says anything about order, and it says it
      // by subject ("first you get the voice on its own") rather than by run
      // sequence.
      'voice.separate',
      'edit.voiceChanger',
      'effects.vocalChain',
      'effects.coverChain',
      // D7: the Podcast Chain follows the Cover Chain, closing the run of
      // multi-stage passes before Align Lyrics.
      'effects.podcastChain',
      'lyrics.align',
      'separator',
      // Analysis — whole-file model runs that produce new material.
      'edit.transcribe',
      'edit.separateStems',
      // F11-8 closed this list with a fourth group, Mix, holding
      // `spatial.position`. T8 moved that command to the Effects section (see
      // `effectsSectionItemIds`), taking its separator with it — three groups.
    ],
  },
  {
    title: 'View',
    itemIds: [
      'view.waveform',
      'view.spectral',
      'view.spectralScale',
      'view.beatGrid',
      'view.snapToGrid',
      'view.multitrack',
    ],
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
  const effects = getVisibleEffects();
  if (effects.length === 0) {
    return ['noise.capture', 'separator', 'effects.none', 'separator', 'spatial.position'];
  }
  // F11-7: the six analysis/transform commands that used to head this list
  // (Detect Tempo, Match Tempo…, Align Vocal Timing…, Align Lyrics…, Vocal
  // Chain…, Cover Chain…) were here only because Plan Ruling 5 forbade a menu
  // of their own. They are in the Pipeline section now and the menu is plain
  // registry effects again.
  //
  // 'Capture Noise Print' is the one that stayed, and it is a ruling rather
  // than an oversight. It is not one of the ten the user moved; it is an
  // instant profile of the current selection rather than a multi-stage pass;
  // and its only consumer is the Noise Reduction EFFECT a few rows below it —
  // its own confirmation dialog sends the user straight there. Moving it would
  // file a one-step primer under a menu of long jobs and separate it from the
  // only thing it primes.
  const ids: (string | 'separator')[] = ['noise.capture', 'separator'];
  let lastCategory: string | null = null;
  for (const e of effects) {
    if (e.category !== lastCategory) {
      ids.push(`effects.cat.${e.category}`);
      lastCategory = e.category;
    }
    ids.push(`effect.${e.id}`);
  }
  // T8: the Spatial Positioner closes this menu as its own Mix group, moved
  // here from the Pipeline section's fourth group on the user's direction
  // ("move the Spacial tool to the effects module"). It is appended in BOTH
  // branches so its door does not depend on the effect registry having
  // populated. Not an `effect.<id>` row — it is a command that focuses the
  // persistent SpatialPanel, and converting it would change what it does.
  ids.push('separator');
  ids.push('spatial.position');
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
        // The stem-separation attribution lives here as well as in the README
        // (v1.7 ruling 9). It is appended to `message` rather than passed as
        // `detail` because the main process's message-box validator whitelists
        // type/title/message/buttons and drops everything else.
        await api.showMessageBox({
          type: 'info',
          title: 'About Auditorium',
          message:
            `Auditorium\nVersion ${version}\n\n` +
            'Stem separation uses HT-Demucs (Meta AI, MIT), via the StemSplitio ONNX export.',
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
      // T5 view routing (the `edit.delete` shape): Ctrl+A selects whatever the
      // visible surface has to select. In the multitrack view that is every
      // CLIP on every track — the document region behind it is not on screen,
      // which is the same argument `edit.deselect` below already makes, and
      // until now the key reached a command gated on an active document and so
      // did nothing in that view at all.
      id: 'edit.selectAll',
      label: 'Select All',
      shortcut: 'Ctrl+A',
      enabled: (s) => (s.view === 'multitrack' ? sessionHasClips() : activeDoc(s) !== null),
      run: async () => {
        if (useAppStore.getState().view === 'multitrack') {
          const { session, setSelectedClips } = useSessionStore.getState();
          setSelectedClips(session.tracks.flatMap((t) => t.clips.map((c) => c.id)));
          return;
        }
        const { documents, activeDocumentId, setSelection } = useAppStore.getState();
        const doc = documents.find((d) => d.id === activeDocumentId);
        if (!doc) return;
        setSelection({ start: 0, end: docLength(doc) });
      },
    },
    {
      // K1 view routing (the `edit.delete` shape): Escape clears whatever the
      // visible surface calls a selection. In the multitrack view that is the
      // clip selection — the document region behind it is not on screen, and
      // clearing it there was the same invisible edit F1 gated cut/copy/paste
      // out of that view for.
      id: 'edit.deselect',
      label: 'Deselect',
      shortcut: 'Esc',
      // D3: the multitrack's selection is now a clip selection OR a gap, so
      // Escape answers for both. It is not the only way out — since review
      // round 1 (I3) a plain press on empty lane space clears the band too,
      // except a press INSIDE the band's own span on its own lane, which is
      // the first half of the double-click that would re-select it. Escape is
      // the way out that works from anywhere, including from inside that span.
      enabled: (s) =>
        s.view === 'multitrack'
          ? useSessionStore.getState().selectedClipId !== null ||
            useSessionStore.getState().selectedGap !== null
          : s.selection !== null,
      run: async () => {
        if (useAppStore.getState().view === 'multitrack') {
          useSessionStore.getState().setSelectedClip(null);
          useSessionStore.getState().setSelectedGap(null);
          return;
        }
        useAppStore.getState().setSelection(null);
      },
    },
    {
      // T5 — view-routed like the pair below it. Both keys were gated on an
      // active DOCUMENT and wrote the editor's cursor, so in the multitrack
      // view Home and End did nothing (K1 noticed it while auditing the keymap
      // and left it out of scope). Enabled with NO clips as well: sample 0 is
      // where an empty session's cursor belongs just as much, and unlike the
      // clip-edge keys there is always somewhere to go.
      id: 'transport.goToStart',
      label: 'Go to Start',
      shortcut: 'Home',
      enabled: (s) => (s.view === 'multitrack' ? true : activeDoc(s) !== null),
      run: async () => {
        if (useAppStore.getState().view === 'multitrack') {
          const { mtZoom, setMtCursor } = useSessionStore.getState();
          setMtCursor(0);
          // Through `applySessionZoom`, the session's one clamped writer, for
          // the reason the editor arm below states: a second raw `setMtZoom`
          // caller is how a clamp stops being single-sourced.
          applySessionZoom({ samplesPerPixel: mtZoom.samplesPerPixel, scrollSample: 0 });
          return;
        }
        // F11 fix round (I2): through the one clamped writer. `scrollSample: 0`
        // is already legal at every zoom, so this is about routing rather than
        // about the value — a second `setZoom` caller is how the clamp stopped
        // being single-sourced the first time.
        useAppStore.getState().setCursor(0);
        applyEditorZoom({ samplesPerPixel: useAppStore.getState().zoom.samplesPerPixel, scrollSample: 0 });
      },
    },
    {
      // T5 — "the end" of a SESSION is the end of its last clip, across every
      // track (`sessionEndSample`, the same number the zoom's fit is stated
      // in). Gated on `sessionHasClips()` rather than on the view alone: with
      // no clips the end IS the start, and a key that lands where the cursor
      // already is should say so by being disabled, exactly as the clip-edge
      // pair does.
      id: 'transport.goToEnd',
      label: 'Go to End',
      shortcut: 'End',
      enabled: (s) => (s.view === 'multitrack' ? sessionHasClips() : activeDoc(s) !== null),
      run: async () => {
        if (useAppStore.getState().view === 'multitrack') {
          const { session, mtZoom, setMtCursor } = useSessionStore.getState();
          const end = sessionEndSample(session);
          setMtCursor(end);
          // THE END AT THE RIGHT EDGE, asked for as a function of the resolved
          // zoom rather than as `scrollSample: end`. The editor arm below can
          // ask for `len` because its own clamp is `maxScroll` and pins the
          // document's end to the right edge for it; the session's scrollable
          // extent runs MT_TIMELINE_TAIL_SEC past the last clip, so the same
          // request here would NOT clamp — it would park the end at the LEFT
          // edge with a minute of emptiness beside it, which is the off-screen
          // destination the editor's own End key was fixed for. The floor at 0
          // for a session narrower than the lane is `resolveSessionZoom`'s, not
          // a second clamp here.
          applySessionZoom({
            samplesPerPixel: mtZoom.samplesPerPixel,
            scrollSample: (spp) => end - sessionLaneWidth() * spp,
          });
          return;
        }
        const { documents, activeDocumentId, zoom, setCursor } = useAppStore.getState();
        const doc = documents.find((d) => d.id === activeDocumentId);
        if (!doc) return;
        const len = docLength(doc);
        setCursor(len);
        // F11 fix round (I2): asking for `len` and letting the store clamp it
        // to `maxScroll` puts the END of the document at the right edge, which
        // is what "Go to End" means. The previous version wrote the unclamped
        // `len` straight into the store and called the resulting over-scroll
        // "self-correcting", on the grounds that the next wheel gesture would
        // fix it — which left the tics and the ruler drawn past the end of the
        // audio until the user happened to scroll. It also cited an onWheel
        // clamp that no longer exists; `resolveZoom` owns both clamps now.
        applyEditorZoom({ samplesPerPixel: zoom.samplesPerPixel, scrollSample: len });
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
      // so the menu and the transport Toolbar share one source of truth.
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

  /**
   * F1: the five REGION verbs — cut, copy, paste, trim, silence — act on a
   * region of the ACTIVE DOCUMENT, which the multitrack view does not show.
   * `setView` does not clear the selection (deliberately: coming back to
   * Waveform should find your work where you left it), so in that view each of
   * them addressed a document the user cannot see, with no feedback anywhere in
   * the session, while the Undo beside them routes to the SESSION's history and
   * cannot undo a document edit.
   *
   * Gated here rather than per surface, so the toolbar, the Edit menu and the
   * keyboard inherit one rule — `runCommand` re-checks `enabled` before running,
   * which is what makes the accelerators inert too.
   *
   * This CHANGES pre-existing behaviour: Ctrl+X/C/V in the multitrack view used
   * to edit the hidden document silently. That was the same trap with no button
   * on it, not a feature worth preserving.
   *
   * `edit.delete` is deliberately NOT in this set — it already routes to clip
   * removal in the multitrack view, so it is view-aware by design.
   */
  const isDocumentEditView = (s: AppState) => s.view !== 'multitrack';
  const canEditRegion = (s: AppState) => isDocumentEditView(s) && hasSelection(s);
  registerCommands([
    {
      // R3 view routing (ruling 1), same shape as edit.delete below: in the
      // multitrack view Ctrl+Z addresses the SESSION's history; in the
      // waveform/spectral editors it addresses the active document's. The
      // two stacks never interleave — that is the per-document convention
      // multi-document editors already follow, extended to the session.
      id: 'edit.undo',
      label: 'Undo',
      shortcut: 'Ctrl+Z',
      enabled: (s) =>
        s.view === 'multitrack'
          ? canUndoSession()
          : s.activeDocumentId !== null && canUndo(s.activeDocumentId),
      run: async () => {
        if (useAppStore.getState().view === 'multitrack') {
          undoSession();
          return;
        }
        const id = useAppStore.getState().activeDocumentId;
        if (id) undo(id);
      },
    },
    {
      id: 'edit.redo',
      label: 'Redo',
      shortcut: 'Ctrl+Y',
      enabled: (s) =>
        s.view === 'multitrack'
          ? canRedoSession()
          : s.activeDocumentId !== null && canRedo(s.activeDocumentId),
      run: async () => {
        if (useAppStore.getState().view === 'multitrack') {
          redoSession();
          return;
        }
        const id = useAppStore.getState().activeDocumentId;
        if (id) redo(id);
      },
    },
    {
      id: 'edit.split',
      label: 'Split at Cursor',
      shortcut: 'Ctrl+K',
      // M1: one view-routed command - a marker at the cursor in the editors,
      // a clip split at the edit cursor in the multitrack (M2/N1-N5, see the
      // `canSplitAtMtCursor` region below).
      enabled: (s) => (s.view === 'multitrack' ? canSplitAtMtCursor() : activeDoc(s) !== null),
      run: async () => {
        if (useAppStore.getState().view === 'multitrack') {
          splitSelectedTracksAtMtCursor();
          return;
        }
        splitAtCursor();
      },
    },
    {
      id: 'edit.cut',
      label: 'Cut',
      shortcut: 'Ctrl+X',
      // Item 8 (M1/N9): with no selection, Ctrl+X cuts the segment the cursor
      // is in, so it is live whenever there is a selection OR an interior
      // marker to bound one. Still never in multitrack (M7).
      enabled: (s) =>
        isDocumentEditView(s) &&
        activeDoc(s) !== null &&
        (s.selection !== null || cursorSegment(s) !== null),
      run: async () => cutSelection(),
    },
    {
      id: 'edit.copy',
      label: 'Copy',
      shortcut: 'Ctrl+C',
      enabled: canEditRegion,
      run: async () => copySelection(),
    },
    {
      id: 'edit.paste',
      label: 'Paste',
      shortcut: 'Ctrl+V',
      enabled: (s) => isDocumentEditView(s) && activeDoc(s) !== null && getClipboard() !== null,
      run: async () => pasteAtCursor(),
    },
    {
      // In the multitrack view, Delete removes the selected clip; elsewhere it
      // silences the selected region in place at constant length (item 7;
      // Task 22 view routing).
      //
      // K1: "the selected clip" is now "the selection", which may hold several
      // clips across several tracks. The predicate is unchanged — the set is
      // empty exactly when the primary is null — and a single-clip delete is
      // byte-for-byte the act it always was (`removeClips` keeps the label and
      // takes the same path); what changed is that a Ctrl+Click set goes in one
      // undo entry rather than needing one Delete per clip.
      id: 'edit.delete',
      label: 'Delete',
      shortcut: 'Del',
      // D3: a GAP arms it too, and closes instead of removing. The store keeps
      // the two selections mutually exclusive, so this reads the gap first and
      // never has to arbitrate.
      enabled: (s) =>
        s.view === 'multitrack'
          ? useSessionStore.getState().selectedClipId !== null ||
            useSessionStore.getState().selectedGap !== null
          : hasSelection(s),
      run: async () => {
        if (useAppStore.getState().view === 'multitrack') {
          const gap = useSessionStore.getState().selectedGap;
          if (gap !== null) {
            closeGap(gap);
            return;
          }
          removeClips(useSessionStore.getState().selectedClipIds);
          return;
        }
        deleteSelection();
      },
    },
    {
      // K1 R3 — Audition's Ripple Delete: remove the selected clip(s) AND close
      // the gap, so everything later on each affected track moves up. Deleting
      // a bad take out of the middle of an arrangement is the reason it exists;
      // plain Delete leaves the hole.
      //
      // Item 7 (N8): view-routed like Delete. In the editor views it is the
      // pre-item-7 Delete — remove the selection and close the gap, the one
      // editor edit besides Trim that shortens the file — now that plain
      // Delete silences the span in place at constant length.
      id: 'edit.rippleDelete',
      label: 'Ripple Delete',
      shortcut: 'Shift+Del',
      // D3: same arming, same act. Closing a gap IS the ripple's second half
      // (remove nothing, close the hole), so the two verbs deliberately agree
      // rather than inventing a second meaning for a span that is empty
      // already — `menuActions.gaps.test.ts` pins that they land the same
      // session.
      enabled: (s) =>
        s.view === 'multitrack'
          ? useSessionStore.getState().selectedClipId !== null ||
            useSessionStore.getState().selectedGap !== null
          : hasSelection(s),
      run: async () => {
        if (useAppStore.getState().view === 'multitrack') {
          const gap = useSessionStore.getState().selectedGap;
          if (gap !== null) {
            closeGap(gap);
            return;
          }
          rippleDeleteClips(useSessionStore.getState().selectedClipIds);
          return;
        }
        rippleDeleteSelection();
      },
    },
    {
      /**
       * T5 — RIPPLE DELETE OF A TIME RANGE: listed, and disabled everywhere,
       * because there is nothing in this app that can name the range.
       *
       * The ask was "with a time selection active in the multitrack, remove
       * that span from ALL tracks and close the gap everywhere". The multitrack
       * view has no time selection to be active. Its state is a CURSOR and a
       * clip selection and nothing else (`SessionState`); the ruler it renders
       * is the editor's `TimelineRuler`, whose pointer drag SEEKS rather than
       * sweeping a range; `.audm` persists no range; the transport's only
       * loop plumbing belongs to the single-document engine; and
       * `appStore.selection` is the DOCUMENT's region, which `edit.deselect`
       * above already documents as not being on screen in this view.
       * `adoptSessionRate`'s invariant states the same fact from the other
       * side, having had to enumerate every session-sample value that exists:
       * "there is no multitrack selection or loop range to carry (only the
       * cursor exists)".
       *
       * Building the range-sweep gesture — anchor, rendering, snapping,
       * persistence, and what it means for the cursor — is a feature of its
       * own, not the tail of this one. What ships is the row, so the verb is
       * where a user goes looking for it, and this note, so the next editor
       * knows the blocker is upstream of the ripple arithmetic rather than in
       * it. `mergeSpans` and the shift loop in `rippleDeleteClips` are the
       * whole computation once a range exists.
       *
       * NO ACCELERATOR, deliberately: `installShortcuts` claims a matched combo
       * before it consults `enabled`, so a key bound here would be swallowed in
       * every view and hand nothing back.
       *
       * The reason is NOT surfaced as a tooltip. A `title` on a disabled button
       * is not reliably shown in Chromium, and this repo does not ship
       * affordances it has not seen work — the USER_GUIDE carries the sentence
       * instead.
       */
      id: 'edit.rippleDeleteTime',
      label: 'Ripple Delete Time Selection',
      enabled: () => false,
      run: async () => {},
    },
    // U1: `trimToSelection` and `silenceSelection` have existed in editOps
    // since Task 22 with no command in front of them — the Edit menu never
    // listed them, so the only way to reach either was the test hooks. The E2
    // edit toolbar puts a button on each, and the app's rule is that a button
    // calls a COMMAND: the registry is what re-checks enablement at run time,
    // so a surface can never outrun it. Neither op is touched. Same
    // `hasSelection` predicate as Cut/Copy, which is what both functions
    // already require and return early without.
    // M1: both are in the Edit menu's LAYOUT too now, next to Delete — U1 left
    // the menu alone as out of its scope, which left the toolbar their only
    // surface. Neither gets a `shortcut`, because neither has a real one.
    {
      id: 'edit.trim',
      label: 'Trim to Selection',
      enabled: canEditRegion,
      run: async () => trimToSelection(),
    },
    {
      id: 'edit.silence',
      label: 'Silence Selection',
      enabled: canEditRegion,
      run: async () => silenceSelection(),
    },
  ]);
}

// ---- lot C ----
// Items 7 and 8 (editor edit verbs). The segment model the `edit.cut`
// predicate and `cutSelection` share lives in `./segments` (`cursorSegment`);
// no helper of this lot lives in this file.
// ---- end lot C ----

/** Registers the real File > * commands (Task 11), overwriting the disabled
 * stubs. New/Open are always available. Lot A (M4): Save / Save As write the
 * `.audm` PROJECT in every view — Save is gated on the project's unsaved
 * work, Save As is always available; Export and Close require an active
 * document (Export in the multitrack view follows the session instead — M5).
 * New and Export open React dialogs via the dialog bus; the rest drive the
 * fileService / sessionFile flows. run() is async so awaits propagate. */
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
      // Lot A (M4): Save writes the PROJECT — the session plus every open
      // document — in every view. Gated on the SAME predicate the close guard
      // counts (`projectHasUnsavedWork`: any document dirty, the session
      // dirty, or a never-written project with content), so "the app would
      // warn me about losing this" and "Save does something" stay one
      // condition rather than two that can disagree (O1-2's rule, lifted from
      // the document to the project).
      enabled: () => projectHasUnsavedWork(),
      run: async () => {
        await runProjectSave(false);
      },
    },
    {
      id: 'file.saveAs',
      label: 'Save As…',
      shortcut: 'Ctrl+Shift+S',
      // An explicit "write this project to a file I am about to name"
      // gesture — meaningful with nothing open and nothing dirty, the same
      // reasoning the document Save As had.
      enabled: () => true,
      run: async () => {
        await runProjectSave(true);
      },
    },
    {
      id: 'file.export',
      label: 'Export…',
      shortcut: 'Ctrl+E',
      // Lot A (M5): in the multitrack view Export renders the session mixdown,
      // so it follows the session (clips exist) rather than the active
      // document. Known, accepted staleness: MenuBar does not subscribe to the
      // session store, so an OPEN File menu re-greys this on the next
      // appStore/history change — the same as `multitrack.mixdown` today.
      enabled: (s) => (s.view === 'multitrack' ? sessionHasClips() : hasDoc(s)),
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

// ---- lot A ----
/** File → Save / Save As… (M4): F3 defense-in-depth, moved here from the
 * former `session.save` row. `runCommand` has no try/catch of its own, and
 * `saveProject` already catches its own known failure points, but this keeps
 * ANY escaping error in front of the user instead of vanishing through
 * MenuBar's onClick. A hoisted declaration, so `registerFileCommands` above
 * reaches it the way it reaches `sessionHasClips` below. */
async function runProjectSave(as: boolean): Promise<void> {
  try {
    await saveProject({ as });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await window.electronAPI?.showMessageBox({ type: 'error', title: 'Save Project failed', message });
  }
}
// ---- end lot A ----

/** Registers the project command that is not a `file.*` row (Task 21, lot A):
 * `session.open` — File → Open Project… — is always available, restores every
 * embedded document into the Files panel and switches the view to
 * 'multitrack' on success. The former `session.save` row is folded into
 * File → Save As… (M4: Save is the project in every view).
 *
 * F3 defense-in-depth: `runCommand` has no try/catch of its own, and before
 * this a thrown/rejected open propagated straight out through MenuBar's
 * onClick with nothing visible to the user. `openSessionViaDialog` already
 * catches its own known failure points, but this wrapper ensures ANY
 * escaping error — known or not — still ends up in front of the user. */
function registerSessionCommands(): void {
  registerCommands([
    {
      id: 'session.open',
      label: 'Open Project…',
      enabled: () => true,
      run: async () => {
        try {
          await openSessionViaDialog();
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          await window.electronAPI?.showMessageBox({ type: 'error', title: 'Open Project failed', message });
        }
      },
    },
  ]);
}

/** Registers one command per registered effect (`effect.<id>`, opens the effect
 * dialog, enabled when a document is active) plus one disabled category-label
 * command per category (`effects.cat.<Category>`). HIDDEN effects (F9) get no
 * command at all: their input cannot come from the generic dialog, so a menu
 * entry for one would only lead to a refusal. Idempotent by id: re-running
 * after new effects register just overwrites/extends. Call after `registerAll`
 * has populated the effect registry (App.tsx does this at startup). */
export function registerEffectCommands(): void {
  const cmds: MenuCommand[] = [];
  for (const effect of getVisibleEffects()) {
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

// ---- lot E ----
/**
 * Item 4 (N14) — leaving the MULTITRACK view for an editor view with a clip
 * selected shows that clip: its source document becomes active, its source
 * window is selected, the cursor sits at the window's start and the zoom is
 * fitted to the window. Lives here and not in `appStore.setView` because (a)
 * appStore cannot import sessionStore (cycle through undoHistory.ts) and (b)
 * the other multitrack leavers — the panels' "go to" and the producers that
 * `addDocument` then `setView('waveform')` — need the active document left
 * alone. Only the PRIMARY `selectedClipId` counts (a set may span documents;
 * the Properties panel shows the primary too). An orphan clip (source closed)
 * falls through to a plain `setView`.
 */
export function showEditorView(v: 'waveform' | 'spectral'): void {
  const app = useAppStore.getState();
  if (app.view === 'multitrack') {
    const { session, selectedClipId } = useSessionStore.getState();
    const clip =
      selectedClipId === null
        ? null
        : (session.tracks.flatMap((t) => t.clips).find((c) => c.id === selectedClipId) ?? null);
    const doc = clip ? (app.documents.find((d) => d.id === clip.documentId) ?? null) : null;
    if (clip && doc) {
      // Activate FIRST: setActiveDocument applies activationReset (selection
      // null, cursor 0, defaultZoom, playback stopped). Skipped for the doc
      // that is already active — no reset, playback state untouched.
      if (app.activeDocumentId !== doc.id) app.setActiveDocument(doc.id);
      const { start, end } = resolveRegion(
        doc,
        clipSourceWindow(clip, doc.sampleRate, session.sampleRate)
      );
      const s = useAppStore.getState();
      // A window clamped to nothing (clip entirely past its source) selects
      // nothing — a zero-width selection would light Cut/Copy on no audio.
      s.setSelection(end > start ? { start, end } : null);
      s.setCursor(start);
      // Fit the window across the measured lane: resolveZoom clamps spp into
      // [MIN_SPP, fit] and the scroll into [0, length - laneWidth*spp], which
      // for a clamped window is exactly [start, end).
      applyEditorZoom({
        samplesPerPixel: Math.max(1, end - start) / editorLaneWidth(),
        scrollSample: start,
      });
    }
  }
  useAppStore.getState().setView(v);
}
// ---- end lot E ----

/** Registers the Task 19 restoration + view commands: `noise.capture` (top of
 * the Effects menu, enabled only when a selection exists — it profiles the
 * selected region), the real `view.waveform` / `view.spectral` toggles
 * (enabled when an active doc exists and that view isn't already current), and
 * `view.spectralScale` (Task F4 — flips the module-level spectral scale
 * setting; enabled only while the spectral view is active) and `view.beatGrid`
 * (Task B2 — flips the module-level beat-tic visibility; enabled in either
 * editor view). `view.multitrack` stays a disabled stub until Phase D. */
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
      run: async () => showEditorView('waveform'),
    },
    {
      id: 'view.spectral',
      label: 'Spectral',
      enabled: (s) => activeDoc(s) !== null && s.view !== 'spectral',
      run: async () => showEditorView('spectral'),
    },
    {
      id: 'view.spectralScale',
      label: 'Spectral: Toggle Log/Linear Scale',
      enabled: (s) => s.view === 'spectral',
      run: async () => toggleSpectralScale(),
    },
    {
      // Task B2. A pure display preference: enabled wherever the tics can be
      // drawn, NOT gated on a grid existing. Reading whether one exists would
      // mean a `getBeatGrid` call on every store change just to grey a menu
      // item out, and the user must be able to set the preference before
      // running Detect Tempo, not only after.
      id: 'view.beatGrid',
      label: 'Toggle Beat Grid',
      enabled: (s) => activeDoc(s) !== null && (s.view === 'waveform' || s.view === 'spectral'),
      run: async () => {
        toggleBeatGrid();
      },
    },
    {
      // Task B4. The same rule as `view.beatGrid` — a pure preference, not
      // gated on a grid or a marker existing — but ALWAYS enabled, because
      // snapping governs the multitrack's clip drag/trim as well as the two
      // single-document views, and the multitrack works with no open document.
      id: 'view.snapToGrid',
      label: 'Toggle Snap to Grid',
      enabled: () => true,
      run: async () => {
        toggleSnap();
      },
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
 * target track is the one holding the selected clip, else the first track. The
 * placement itself — the doc-rate/session-rate conversion, an empty session
 * adopting the document's rate (MT2), the undo entry and the selection — is
 * `sessionInsert.placeDocumentsOnTrack`, shared with the lane drop and the
 * `insertActiveDocAsClip` test hook. No-op without an active doc or any track. */
function insertActiveDocAsClip(): void {
  const doc = activeDoc(useAppStore.getState());
  if (!doc) return;
  const { session, selectedClipId, mtCursorSample } = useSessionStore.getState();
  if (session.tracks.length === 0) return;

  const owningTrack = selectedClipId
    ? session.tracks.find((t) => t.clips.some((c) => c.id === selectedClipId))
    : undefined;
  const targetTrack = owningTrack ?? session.tracks[0];

  placeDocumentsOnTrack([doc], targetTrack.id, mtCursorSample);
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

// ---- lot D ----
/** M2 - "the selected tracks": the owners of `selectedClipIds`. `SessionState`
 * has no track selection, and the clip set is exactly what Delete, Ripple
 * Delete and the group drag already act on, so a split reads the selection the
 * user can already see rather than inventing a second one. */
function selectedTrackIds(): string[] {
  const { session, selectedClipIds } = useSessionStore.getState();
  const member = new Set(selectedClipIds);
  return session.tracks.filter((t) => t.clips.some((c) => member.has(c.id))).map((t) => t.id);
}

/** `edit.split`'s multitrack predicate: some clip on a selected track would be
 * cut at `mtCursorSample` - the EDIT cursor, never `mtPlayheadSample` (N5).
 * Reads the session store directly, exactly as `edit.delete` does, and asks
 * `splitTargets` so the row greys for precisely the cases the store would
 * refuse (an edge, the 32-sample margin, a point in an overlap). */
export function canSplitAtMtCursor(): boolean {
  const { session, mtCursorSample } = useSessionStore.getState();
  return splitTargets(session, selectedTrackIds(), mtCursorSample).length > 0;
}

/** `edit.split`'s multitrack run: the cursor VERBATIM (N1 - it was snapped, or
 * deliberately not, when it was placed; `moveCursorToClipEdge` below records
 * the same ruling), plus the document rates from the app store so a
 * mixed-rate clip's right half reads the right source sample (N3). Returns the
 * right-half ids. */
export function splitSelectedTracksAtMtCursor(): string[] {
  const { mtCursorSample } = useSessionStore.getState();
  const rates = new Map(useAppStore.getState().documents.map((d) => [d.id, d.sampleRate]));
  return splitClipsAt(selectedTrackIds(), mtCursorSample, (id) => rates.get(id));
}
// ---- end lot D ----

// ---- merge clips ----
/** `multitrack.mergeClips`' predicate (D1): the clip selection holds TWO OR
 * MORE clips on at least one track. Asks `mergeTargets` — the same question the
 * verb itself answers — so the row greys for precisely the selections the merge
 * would refuse, and reads the session store directly, exactly as
 * `canSplitAtMtCursor` above does. */
export function canMergeSelectedClips(): boolean {
  const { session, selectedClipIds } = useSessionStore.getState();
  return mergeTargets(session, selectedClipIds).length > 0;
}

/**
 * D2/D7 — the merge: one baked document per merged track, then ONE session
 * gesture. Returns the merged clip ids (`[]` when nothing qualifies).
 *
 * The document half is `mixdownToNewFile`'s pattern verbatim — `createDocument`
 * + `addDocument`, so the audio is minted OUTSIDE the undo gesture (a document
 * is never an undo entry here) and the last one added becomes active, which is
 * what every computed document in this app does (D7). The bake is handed the
 * SESSION rate, not the members' document rate: the merged clip lives on the
 * timeline, and `readClipSlice` is what reconciles a mixed-rate member.
 *
 * `commitMergedClips` owns the session write and the selection afterwards; this
 * function never touches the session store's clip actions itself.
 */
export function mergeSelectedClips(): string[] {
  const { session, selectedClipIds } = useSessionStore.getState();
  const targets = mergeTargets(session, selectedClipIds);
  if (targets.length === 0) return [];

  const docs = new Map(useAppStore.getState().documents.map((d) => [d.id, d]));
  const entries = targets.map((target) => {
    // `mergeTargets` derived every `trackId` from this same session, so the
    // lookup cannot miss.
    const track = session.tracks.find((t) => t.id === target.trackId)!;
    const { channels, sampleRate } = bakeMergedClip(track, target, docs, session.sampleRate);
    // D2 — `Merge N`, numbered off its own counter like `Mixdown N`. No
    // `filePath`, so `createDocument` stamps `neverSaved` itself (S4's default);
    // passing the flag would restate a rule that already holds.
    const n = nextId('merge').split('-')[1];
    const doc = createDocument({ name: `Merge ${n}`, sampleRate, channels });
    useAppStore.getState().addDocument(doc);
    return { target, documentId: doc.id };
  });

  return commitMergedClips(entries);
}
// ---- end merge clips ----

/** Registers the Task 22 multitrack commands: the real `view.multitrack`
 * toggle (always available — the multitrack view works with no open document),
 * `multitrack.addTrack`, `multitrack.insertDoc`, `multitrack.mixdown` and
 * `multitrack.mergeClips`. The action commands are enabled only while the
 * multitrack view is active. */
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
    {
      // D6 — Split's inverse, and the second command here that mints a
      // document. No shortcut: nothing in `SHORTCUT_TABLE` claims a combo for
      // it, and this repo has already paid for menu labels naming keys that do
      // nothing. The predicate is the verb's own question (D1), so the row
      // greys for exactly the selections `mergeSelectedClips` would refuse.
      id: 'multitrack.mergeClips',
      label: 'Merge Clips',
      enabled: (s) => s.view === 'multitrack' && canMergeSelectedClips(),
      run: async () => {
        mergeSelectedClips();
      },
    },
    // K1 R1 — the two halves of clip-edge navigation. Both are the same
    // two-line adapter over `clipEdges`: read the session's boundaries, ask
    // which one lies in that direction, write the cursor if there is one.
    //
    // `setMtCursor` is the whole write. The multitrack cursor is where the NEXT
    // play starts (`transportService` reads it once, at `play()`), so moving it
    // during playback moves the next start and nothing else — the running
    // transport is driven by `mtPlayheadSample`, which these never touch. That
    // is what makes them safe while playing, and it is a property of the
    // existing cursor contract rather than anything K1 added.
    //
    // Enabled on `sessionHasClips()` — no clips, no edges, so the key would
    // have nowhere to go and the menu row should say so.
    {
      id: 'multitrack.prevClipEdge',
      label: 'Previous Clip Edge',
      shortcut: 'Ctrl+Left',
      enabled: (s) => s.view === 'multitrack' && sessionHasClips(),
      run: async () => moveCursorToClipEdge('prev'),
    },
    {
      id: 'multitrack.nextClipEdge',
      label: 'Next Clip Edge',
      shortcut: 'Ctrl+Right',
      enabled: (s) => s.view === 'multitrack' && sessionHasClips(),
      run: async () => moveCursorToClipEdge('next'),
    },
  ]);
}

/** K1 R1 — moves the multitrack cursor to the previous/next clip boundary, or
 * leaves it exactly where it is when there is none in that direction. */
function moveCursorToClipEdge(direction: 'prev' | 'next'): void {
  const { session, mtCursorSample, setMtCursor } = useSessionStore.getState();
  const target = nextClipEdge(clipBoundaries(session), mtCursorSample, direction);
  if (target === null) return;
  setMtCursor(target);
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
      // N10: editor views only — Multitrack shows no document for M to mark.
      enabled: (s) => s.view !== 'multitrack' && activeDoc(s) !== null,
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

/** Registers the Task T5/T8 tempo commands: `tempo.detect` and `tempo.match`
 * open the Pipeline menu's Tempo & Timing group (F11-7). They used to head the
 * Effects menu beside `noise.capture`, which Plan Ruling 5 required by
 * forbidding a sixth `MenuSection['title']`; the user overruled that ruling.
 * `tempo.detect` fires `runTempoAnalysis`, which itself never throws/rejects
 * and surfaces its own failure dialog — no try/catch needed here, matching
 * `effect.<id>`'s run() above. `tempo.match` just opens the dialog through
 * the bus (Task T8), matching `edit.convertSampleRate`/`edit.convertChannels`
 * above. */
function registerTempoCommands(): void {
  registerCommands([
    {
      id: 'tempo.detect',
      label: 'Detect Tempo',
      enabled: (s) => activeDoc(s) !== null,
      run: async () => {
        const d = activeDoc(useAppStore.getState());
        if (d) await runTempoAnalysis(d);
      },
    },
    {
      id: 'tempo.match',
      label: 'Match Tempo',
      enabled: (s) => activeDoc(s) !== null,
      run: async () => openTempoDialog(),
    },
    {
      // F9. Sits beside Match Tempo because it answers the same user question
      // ("this is not in time") with the one thing Match Tempo structurally
      // cannot do -- a per-syllable rate instead of one ratio for the whole
      // region. It is a command rather than an `effect.<id>` entry because its
      // input is a confirmed anchor list, not scalar params (see
      // `EffectDefinition.hidden`).
      id: 'timing.align',
      label: 'Align Vocal Timing',
      enabled: (s) => activeDoc(s) !== null,
      run: async () => openAlignTimingDialog(),
    },
  ]);
}

/** Registers the Task T14 Auto-Remix command. F11-7: it closes the PIPELINE
 * menu's Tempo & Timing group, beside the two tempo tools whose analysis it
 * shares. T14's original argument — not in Effects, which is built live from
 * `getAllEffects()` and only holds `EffectDefinition`s (a remix is a
 * multi-second analysis producing a NEW document, which
 * `EffectDefinition.process` — pure, synchronous, returning channels for the
 * SAME document — structurally cannot express) — still rules out Effects; it
 * only ever put the command in Edit for want of anywhere better. `enabled`
 * stays O(1) and pure: MenuBar re-evaluates every item on every store change.
 * No shortcut. */
function registerRemixCommands(): void {
  registerCommands([
    {
      id: 'edit.remix',
      label: 'Auto-Remix',
      enabled: (s) => {
        const d = activeDoc(s);
        return d !== null && docLength(d) > 0;
      },
      run: async () => openRemixDialog(),
    },
  ]);
}

/** Registers the Task S6 stem-separation command. F11-7: it closes the PIPELINE
 * menu's Analysis group, beside Transcribe — the other whole-file model run.
 * S6's plan ruling 8 had put it beside Auto-Remix instead, on the shared
 * property that both produce NEW documents (which the Effects menu's
 * `EffectDefinition.process` — pure, synchronous, returning channels for the
 * SAME document — structurally cannot express). That property still rules out
 * Effects; the Pipeline groups by subject, so the two are no longer neighbours.
 * Identical `enabled` rule (an active document with audio in it), and no
 * shortcut: this is a multi-minute job that should never be one keystroke
 * away. */
function registerStemCommands(): void {
  registerCommands([
    {
      id: 'edit.separateStems',
      label: 'Separate into Stems',
      enabled: (s) => {
        const d = activeDoc(s);
        return d !== null && docLength(d) > 0;
      },
      run: async () => openSeparateDialog('stems'),
    },
    // D4 — Separate Voice. The SAME separation run as the row above, landed as
    // two tracks (Voice + Backing) instead of five, so it is registered here
    // beside it rather than in a module of its own: one service, one dialog,
    // one model download, two landings. Hence also the identical predicate —
    // it is gated by what the RUN needs, not by which menu group it sits in —
    // and no shortcut, for the same reason (minutes of inference). D7 puts it
    // in the Pipeline menu's Voice group, at its head.
    {
      id: 'voice.separate',
      label: 'Separate Voice',
      enabled: (s) => {
        const d = activeDoc(s);
        return d !== null && docLength(d) > 0;
      },
      run: async () => openSeparateDialog('voice'),
    },
  ]);
}

/** F4b — Transcribe. F11-8: it is now the door to BOTH halves of the feature.
 * The user ruled that "Spatial and Transcript are single tools, they should not
 * be a module", so the module strip stopped carrying a Transcript icon and this
 * command absorbed what that icon did: with a transcript already in the store
 * for the active document it SHOWS that transcript, and only with none does it
 * open the run dialog.
 *
 * Which way round matters. Re-running is minutes of inference that would
 * produce the thing already sitting in the store, so making that the default
 * would charge the user for a look; whereas showing a transcript costs nothing
 * and the run is still one click away, on the panel's own 'Transcribe again…'
 * button (F11-8 added it — the stale banner has been telling users to
 * transcribe again since F4b with no control to do it with). The branch is on
 * EXISTENCE, not on staleness: a stale transcript is still the one the user
 * made, the panel says so in amber at the top, and that is a better answer to
 * "show me the transcript" than silently starting a second run.
 *
 * The `enabled` predicate is unchanged and deliberately still document-and-
 * audio gated: the reveal arm is the exception this command makes, not a new
 * always-available surface.
 *
 * F11-7: it OPENS the Pipeline menu's Analysis group, with
 * Separate into Stems after it. Both are long analyses over the whole document
 * that the Effects menu's pure, synchronous `EffectDefinition.process`
 * structurally cannot express — the reason neither is an `effect.<id>` — and
 * both read the file rather than reshaping a take, which is why they share a
 * group rather than sitting in Voice. Identical `enabled` rule (an active
 * document with audio in it), and no shortcut — a multi-minute job should never
 * be one keystroke away. */
function registerTranscribeCommands(): void {
  registerCommands([
    {
      id: 'edit.transcribe',
      label: 'Transcribe',
      enabled: (s) => {
        const d = activeDoc(s);
        return d !== null && docLength(d) > 0;
      },
      run: async () => {
        const id = useAppStore.getState().activeDocumentId;
        if (id !== null && getTranscript(id) !== null) {
          focusTranscriptPanel();
          return;
        }
        openTranscribeDialog();
      },
    },
  ]);
}

/** F3 — Voice Changer. F11-7 put it at the head of the Pipeline menu's Voice
 * group, ahead of the two chains — it is the one tool there that replaces the
 * voice rather than cleaning it, so everything after it operates on whatever it
 * produced. D4/D7 moved it one row down: `voice.separate` opens the group now,
 * because isolating the voice comes before replacing it. The rest of that
 * argument stands, and this is still the first row that RESHAPES a take.
 * It is not an `effect.<id>` for the structural reason F3 gave: a long
 * CPU-inference job producing a NEW document, which the Effects menu's pure,
 * synchronous `EffectDefinition.process` (same-document channels in, channels
 * out) cannot express. Identical `enabled` rule, and no shortcut — a
 * minutes-long job should never be one keystroke away. */
function registerVoiceCommands(): void {
  registerCommands([
    {
      id: 'edit.voiceChanger',
      label: 'Voice Changer',
      enabled: (s) => {
        const d = activeDoc(s);
        return d !== null && docLength(d) > 0;
      },
      run: async () => openVoiceChangerDialog(),
    },
  ]);
}

/** F7 — the Vocal Chain. F11-7: it sits in the PIPELINE menu's Voice group,
 * after Voice Changer and before Cover Chain. F7 had placed it in the Effects
 * menu after 'Align Vocal Timing…' because it is a same-document, in-place
 * transform of the selection (unlike Auto-Remix / Separate / Transcribe, which
 * produce NEW documents and so lived in Edit) — that distinction no longer
 * decides anything now that all of them are in one menu grouped by subject.
 * It is a command rather than an
 * `effect.<id>` entry because it is not one `EffectDefinition`: it composes
 * several of them, deriving each one's settings from the audio that reaches it,
 * which scalar params in an EffectDialog cannot express. Same `enabled` rule as
 * `timing.align` — an active document — and no shortcut: this is a multi-stage
 * pass that should never be one keystroke away. */
function registerVocalChainCommands(): void {
  registerCommands([
    {
      id: 'effects.vocalChain',
      label: 'Vocal Chain',
      enabled: (s) => activeDoc(s) !== null,
      run: async () => openVocalChainDialog(),
    },
  ]);
}

/** F10 — the Cover Chain. F11-7: it sits in the PIPELINE menu's Voice group,
 * still immediately AFTER 'Vocal Chain' — the one run-order adjacency the
 * regrouping preserved, and the cover chain's own `clean` stage note is why it
 * has to be: the match is a correction to a CLEAN take, so the vocal chain runs
 * first. Like the vocal chain it is a command
 * rather than an `effect.<id>` entry, because it is not one `EffectDefinition`:
 * it composes four of them and derives each one's settings from a SECOND
 * document — the separated original vocal — which scalar params in an
 * EffectDialog cannot express. Same `enabled` rule, and no shortcut: a pass this
 * long should never be one keystroke away. */
function registerCoverChainCommands(): void {
  registerCommands([
    {
      id: 'effects.coverChain',
      label: 'Cover Chain',
      enabled: (s) => activeDoc(s) !== null,
      run: async () => openCoverChainDialog(),
    },
  ]);
}

/** D6 — the Podcast Chain. It sits in the Pipeline menu's Voice group
 * immediately after 'Cover Chain', which is D7's placement and also the only
 * order this group could put it in: the three multi-stage passes run together,
 * and this one is the spoken-word member of the set. Like both chains before it
 * it is a command rather than an `effect.<id>` entry, because it is not one
 * `EffectDefinition`: it composes nine of them, derives each one's settings from
 * the audio that reaches it, and adds a stage that is no effect at all — the
 * BS.1770-4 loudness measurement and the one gain that lands the delivery
 * target. Same `enabled` rule as the other two, and no shortcut: a ten-stage
 * pass should never be one keystroke away. */
function registerPodcastChainCommands(): void {
  registerCommands([
    {
      id: 'effects.podcastChain',
      label: 'Podcast Chain',
      enabled: (s) => activeDoc(s) !== null,
      run: async () => openPodcastChainDialog(),
    },
  ]);
}

/** F6 — Align Lyrics. F11-7: it CLOSES the Pipeline menu's Voice group. F6 had
 * placed it in the Effects menu between 'Align Vocal Timing…' and 'Vocal
 * Chain…' because that is the order the three are RUN in — both manual steps
 * before the chain, and a word replaced before any length-changing stage moves
 * the spans it was measured against. The Pipeline groups by subject instead, so
 * the menu no longer says that anywhere; `vocalChain.ts`'s `lyrics` stage note
 * is now the only place it is stated, and that note names this menu path.
 * It is a command rather
 * than an `effect.<id>` entry for the same structural reason as the chain: it
 * is not one pure `EffectDefinition.process`, it is a model run plus a
 * per-word splice the user drives. Its `enabled` rule is `timing.align`'s PLUS
 * one condition: an active document AND `docLength > 0`. `timing.align` asks
 * only for the document — it opens a dialog that reports its own refusals —
 * whereas this one hands the region to a model, and an empty document has
 * nothing to align. No shortcut either: a 378 MB download and a multi-second
 * inference should never be one keystroke away. */
function registerAlignLyricsCommands(): void {
  registerCommands([
    {
      id: 'lyrics.align',
      label: 'Align Lyrics',
      enabled: (s) => {
        const d = activeDoc(s);
        return d !== null && docLength(d) > 0;
      },
      run: async () => openAlignLyricsDialog(),
    },
  ]);
}

/** F11-8 — the Spatial positioner. It closed the Pipeline menu as its own
 * 'Mix' group until T8, when the user moved it to the EFFECTS menu ("move the
 * Spacial tool to the effects module") — it closes that menu as its own Mix
 * group now, and the Effects card draws the matching Mix row.
 * The user ruled that "Spatial and Transcript are single tools, they
 * should not be a module", so the module strip no longer carries an icon for
 * the positioner and this command is the ONLY door it has: it opens no dialog
 * — it puts the existing panel, untouched, into the module card through the
 * bus, exactly as `focusRemixPanel`/`focusTranscriptPanel` do. (This label
 * originally had no ellipsis BECAUSE it opens no dialog, the convention
 * `tempo.detect` followed too. T8 superseded that convention: the user had the
 * dots removed from every Pipeline label, so a plain label no longer says
 * anything about dialogs — in this menu the dots-mean-a-dialog rule is dead.)
 *
 * ALWAYS enabled, and it is the only row in its menu that is (every Pipeline
 * row and every effect row acts on the active document; the noise print needs
 * a selection). The positioner writes automation onto a multitrack
 * TRACK, which exists with no document open at all — the multitrack view works
 * in an empty app. Gating it on `activeDoc(s) !== null` would grey it in the
 * one state the multitrack user is most likely to be in, and gating it on the
 * session having tracks would replace a panel that says "No tracks in the
 * session." with a grey row that says nothing. The strip icon it replaces was
 * clickable in every state; this keeps that true. */
function registerSpatialCommands(): void {
  registerCommands([
    {
      id: 'spatial.position',
      label: 'Spatial Positioner',
      enabled: () => true,
      run: async () => focusSpatialPanel(),
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
registerTempoCommands();
registerRemixCommands();
registerStemCommands();
registerTranscribeCommands();
registerVoiceCommands();
registerVocalChainCommands();
registerCoverChainCommands();
registerPodcastChainCommands();
registerAlignLyricsCommands();
registerSpatialCommands();
