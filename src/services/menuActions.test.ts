import {
  getMenuSections,
  isCommandEnabled,
  registerCommands,
  registerEffectCommands,
  runCommand,
} from './menuActions';
import { registerAllEffects } from '../effects/registerAll';
import type { MenuCommand, MenuSection } from './menuActions';
import { useAppStore, makeInitialState } from '../stores/appStore';
import { createDocument, docLength } from '../audio/AudioDocument';
import { getSpectralScale, toggleSpectralScale } from './spectralScale';
import { isBeatGridVisible, setBeatGridVisible } from './beatGridDisplay';
import { _resetSnapPreference, isSnapEnabled } from './snapPreference';
import * as sessionFileModule from '../multitrack/sessionFile';
import * as fileServiceModule from './fileService';
import { useSessionStore } from '../multitrack/sessionStore';
import { _resetSessionUndo } from '../multitrack/sessionUndo';
import { runTempoAnalysis } from './tempoAnalysis';
import { registerDialogSetters } from './dialogBus';
import { SHORTCUT_TABLE } from './shortcuts';
import { setClipboard } from './clipboard';
import { createClip } from '../multitrack/session';
import { _resetTranscriptsForTest, getTranscript } from './transcribeService';
import { getHistory } from './undoHistory';
import { installTranscribeBackend, seedTranscript, voiceVector } from '../__mocks__/transcribeBackend';

jest.mock('../multitrack/sessionFile');
jest.mock('./tempoAnalysis', () => ({
  runTempoAnalysis: jest.fn(async () => null),
}));

const mockRunTempoAnalysis = runTempoAnalysis as jest.MockedFunction<typeof runTempoAnalysis>;

beforeEach(() => {
  useAppStore.setState(makeInitialState());
  // Lot A: file.save / file.export read the project (session store + its
  // history + its path), which is module-global — start every test clean.
  useSessionStore.getState().newSession(44100);
  useSessionStore.getState().setProjectPath(null);
  _resetSessionUndo();
  mockRunTempoAnalysis.mockClear();
});

function installShowMessageBox(): jest.Mock {
  const showMessageBox = jest.fn(async () => 0);
  (window as unknown as { electronAPI: { showMessageBox: jest.Mock } }).electronAPI = { showMessageBox };
  return showMessageBox;
}

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

// U1: the E2 edit toolbar reads enablement through `isCommandEnabled` instead
// of restating five predicates the Edit menu already owns, and needs commands
// in front of `trimToSelection`/`silenceSelection`, which shipped in editOps
// with no caller but the test hooks.
describe('isCommandEnabled (U1)', () => {
  it('returns the command’s own predicate against the live store', () => {
    const enabled = jest.fn((s: { view: string }) => s.view === 'waveform');
    registerCommands([
      { id: 'test.live', label: 'Live', enabled: enabled as never, run: jest.fn() },
    ]);

    expect(isCommandEnabled('test.live')).toBe(true);
    useAppStore.getState().setView('multitrack');
    expect(isCommandEnabled('test.live')).toBe(false);
    expect(enabled).toHaveBeenLastCalledWith(useAppStore.getState());
  });

  it('reports an unregistered id disabled, matching runCommand’s no-op', () => {
    expect(isCommandEnabled('test.never-registered')).toBe(false);
  });
});

describe('edit.trim / edit.silence (U1)', () => {
  it('both require a selection, and run the existing editOps', async () => {
    const doc = openDoc();
    expect(isCommandEnabled('edit.trim')).toBe(false);
    expect(isCommandEnabled('edit.silence')).toBe(false);

    useAppStore.getState().setSelection({ start: 100, end: 400 });
    expect(isCommandEnabled('edit.trim')).toBe(true);
    expect(isCommandEnabled('edit.silence')).toBe(true);

    await runCommand('edit.silence');
    const silenced = useAppStore.getState().documents.find((d) => d.id === doc.id);
    expect(docLength(silenced!)).toBe(1000); // in place, length unchanged
    expect(silenced!.channels[0].slice(100, 400).every((v) => v === 0)).toBe(true);

    useAppStore.getState().setSelection({ start: 100, end: 400 });
    await runCommand('edit.trim');
    const trimmed = useAppStore.getState().documents.find((d) => d.id === doc.id);
    expect(docLength(trimmed!)).toBe(300);
  });

  // M1 (controller ruling, inverting U1's own test): U1 registered both
  // commands but deliberately left the Edit menu alone, so the floating
  // toolbar was their ONLY surface — a verb reachable by mouse and by nothing
  // else, invisible to anyone who looks for it where every other edit verb
  // lives. They now sit with the selection verbs they belong to.
  // K1 inserted Ripple Delete between Delete and Trim — the same verb as
  // Delete with the gap closed behind it, so it belongs to Delete's row rather
  // than after the region verbs. The claim this test carries is unchanged:
  // Trim and Silence sit in the Delete GROUP, in that order, not exiled to a
  // toolbar.
  it('appears in the Edit menu directly after Delete, with the other selection verbs', () => {
    const editIds = commandIds(getMenuSections().find((s) => s.title === 'Edit')!.items);
    expect(editIds).toContain('edit.trim');
    expect(editIds).toContain('edit.silence');
    // T5: the run grew by one — the range form of Ripple Delete is listed
    // between the clip form and Trim. The claim is unchanged: these verbs are
    // one uninterrupted group under Delete.
    expect(editIds.slice(editIds.indexOf('edit.delete'), editIds.indexOf('edit.delete') + 5)).toEqual(
      ['edit.delete', 'edit.rippleDelete', 'edit.rippleDeleteTime', 'edit.trim', 'edit.silence']
    );
  });

  // The repo has just paid for two labels naming keys that did nothing
  // (File > Close's Ctrl+W, and the Save pill's). Neither command has a combo
  // in SHORTCUT_TABLE, so neither row may advertise one.
  it('advertises no shortcut, because neither command has one bound', () => {
    const edit = getMenuSections().find((s) => s.title === 'Edit')!;
    const rows = edit.items.filter(
      (item): item is MenuCommand =>
        item !== 'separator' && (item.id === 'edit.trim' || item.id === 'edit.silence')
    );
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.label)).toEqual(['Trim to Selection', 'Silence Selection']);
    for (const row of rows) expect(row.shortcut).toBeUndefined();
    const bound = SHORTCUT_TABLE.map((s) => s.commandId);
    expect(bound).not.toContain('edit.trim');
    expect(bound).not.toContain('edit.silence');
  });

  it('greys both rows in the menu until there is a selection', () => {
    const edit = getMenuSections().find((s) => s.title === 'Edit')!;
    const row = (id: string) =>
      edit.items.find((item): item is MenuCommand => item !== 'separator' && item.id === id)!;

    openDoc();
    expect(row('edit.trim').enabled(useAppStore.getState())).toBe(false);
    expect(row('edit.silence').enabled(useAppStore.getState())).toBe(false);

    useAppStore.getState().setSelection({ start: 100, end: 400 });
    expect(row('edit.trim').enabled(useAppStore.getState())).toBe(true);
    expect(row('edit.silence').enabled(useAppStore.getState())).toBe(true);
  });
});

// F1 (M1 fix round): the five region verbs act on a REGION of the active
// document. `setView` never clears the selection, so in the multitrack view
// each of them addressed a document the user cannot see, with no feedback in
// the session view — and the Undo sitting next to them routes to the SESSION's
// history, which cannot undo a document edit. The toolbar greyed three of them
// and left Trim/Silence lit; the keyboard left all five live. The gate belongs
// on the COMMAND, so every surface inherits it at once.
describe('the region verbs are disabled in the Multitrack view (F1)', () => {
  const REGION_VERBS = ['edit.cut', 'edit.copy', 'edit.paste', 'edit.trim', 'edit.silence'];

  /** The exact trap: a live document selection AND a full clipboard, carried
   * into the multitrack view the way switching views really does.
   *
   * The samples are deliberately NON-ZERO. `openDoc`'s are all zero, which
   * would make "Silence did not run" unfalsifiable — a silenced region and an
   * untouched one are the same bytes. */
  function armedInMultitrack() {
    const doc = createDocument({
      name: 'hidden.wav',
      sampleRate: 44100,
      channels: [Float32Array.from({ length: 1000 }, (_, i) => 0.5 - (i % 7) / 10)],
    });
    useAppStore.getState().addDocument(doc);
    useAppStore.getState().setSelection({ start: 100, end: 400 });
    setClipboard({ channels: [new Float32Array(50)], sampleRate: 44100 });
    useAppStore.getState().setView('multitrack');
    return doc;
  }

  it('reports all five disabled in Multitrack even with a selection and a full clipboard', () => {
    armedInMultitrack();
    for (const id of REGION_VERBS) expect(isCommandEnabled(id)).toBe(false);
  });

  it('and all five live again in the waveform and spectral views', () => {
    armedInMultitrack();
    for (const view of ['waveform', 'spectral'] as const) {
      useAppStore.getState().setView(view);
      for (const id of REGION_VERBS) expect(isCommandEnabled(id)).toBe(true);
    }
  });

  it('greys all five rows in the Edit MENU there too — one predicate, every surface', () => {
    armedInMultitrack();
    const edit = getMenuSections().find((s) => s.title === 'Edit')!;
    for (const id of REGION_VERBS) {
      const row = edit.items.find((i): i is MenuCommand => i !== 'separator' && i.id === id)!;
      expect(row.enabled(useAppStore.getState())).toBe(false);
    }
  });

  // installShortcuts dispatches through runCommand, which re-checks `enabled`
  // before running — so this is the keyboard's behaviour too, and Ctrl+X in
  // Multitrack no longer edits the hidden document.
  // Each verb is dispatched ALONE, against a freshly armed document. Running
  // all five in sequence against one document hides the bug it is meant to
  // catch: pre-fix, `edit.cut` really did delete 300 samples (1000 -> 700) and
  // `edit.paste` then re-inserted the very samples cut had put on the
  // clipboard (700 -> 1000), so a length assertion after the loop saw 1000 and
  // passed while two destructive edits had landed on the hidden document.
  it.each(REGION_VERBS)('leaves the hidden document byte-identical when %s is dispatched anyway', async (id) => {
    const doc = armedInMultitrack();
    const before = useAppStore.getState().documents.find((d) => d.id === doc.id)!;
    const beforeLength = docLength(before);
    const beforeSamples = Array.from(before.channels[0]);
    // The premise: this region is non-zero, so "Silence did not run" is a real
    // claim rather than a comparison of zeros with zeros.
    expect(beforeSamples.slice(100, 400).some((v) => v !== 0)).toBe(true);

    await runCommand(id);

    const after = useAppStore.getState().documents.find((d) => d.id === doc.id)!;
    expect(docLength(after)).toBe(beforeLength);
    expect(Array.from(after.channels[0])).toEqual(beforeSamples);
    // And the selection survives, so returning to Waveform finds the edit
    // still armed rather than silently consumed by a refused command.
    expect(useAppStore.getState().selection).toEqual({ start: 100, end: 400 });
  });

  it('does NOT gate edit.delete, which is view-aware by design', () => {
    armedInMultitrack();
    // No clip selected yet, so it is disabled for the RIGHT reason...
    expect(isCommandEnabled('edit.delete')).toBe(false);

    useSessionStore.getState().addTrack();
    const trackId = useSessionStore.getState().session.tracks[0].id;
    const clip = createClip({
      documentId: 'x',
      startSample: 0,
      offsetSample: 0,
      lengthSample: 100,
    });
    useSessionStore.getState().addClip(trackId, clip);
    useSessionStore.getState().setSelectedClip(clip.id);

    // ...and live again once there is a CLIP to remove, which is its own rule.
    expect(isCommandEnabled('edit.delete')).toBe(true);
  });
});

describe('getMenuSections', () => {
  // F11-7: six, not five. Pipeline sits after Effects, carrying the advanced
  // tools that had been wedged into the Effects head and the Edit menu's
  // long-inference group.
  it('returns exactly 6 sections in the documented order', () => {
    const sections = getMenuSections();
    expect(sections.map((s) => s.title)).toEqual([
      'File',
      'Edit',
      'Effects',
      'Pipeline',
      'View',
      'Help',
    ]);
  });

  it('File section contains the documented command ids in order', () => {
    const file = getMenuSections().find((s) => s.title === 'File')!;
    expect(commandIds(file.items)).toEqual([
      'file.new',
      'file.open',
      'transport.record', // T4
      'file.save',
      'file.saveAs',
      'file.export',
      // lot A (M4): `session.save` is folded into Save As — no duplicate rows.
      'session.open',
      'multitrack.mixdown',
      'file.close',
    ]);
  });

  it('every dialog-opening command has a menu row, Record included', () => {
    // T4. `transport.record` was in NO section: its only doors were the
    // transport bar's Record button and — for a while — nothing else, which
    // made the Record dialog the one dialog a menu-only user could not reach.
    // Every other dialog in the app is openable from the menu bar, so this was
    // an inconsistency in the menu rather than a deliberate omission.
    //
    // Filed under File, after Open: New, Open and Record are the three ways
    // audio gets in front of you, and File already carries a non-`file.*` id
    // for the same reason (`multitrack.mixdown` makes material too).
    const ids = getMenuSections().flatMap((s) => commandIds(s.items));
    expect(ids).toContain('transport.record');
    const file = getMenuSections().find((s) => s.title === 'File')!;
    const record = file.items.find(
      (i): i is MenuCommand => i !== 'separator' && i.id === 'transport.record'
    )!;
    expect(record.label).toBe('Record');
    // No ellipsis, and that is not an oversight: the row opens a dialog in the
    // waveform/spectral views but PUNCHES IN directly in the multitrack view
    // (transportService.transportRecord), so "…" would be a promise it breaks
    // half the time. No accelerator either — nothing in SHORTCUT_TABLE binds
    // one, and this repo has paid twice for a label naming a key that does
    // nothing.
    expect(record.shortcut).toBeUndefined();
  });

  it('session.save is gone from the File section; session.open is always enabled and reads "Open Project…" (lot A, M4)', () => {
    const file = getMenuSections().find((s) => s.title === 'File')!;
    const findCmd = (id: string) =>
      file.items.find((item): item is MenuCommand => item !== 'separator' && item.id === id);

    expect(findCmd('session.save')).toBeUndefined();
    expect(isCommandEnabled('session.save')).toBe(false);
    const open = findCmd('session.open')!;
    expect(open.label).toBe('Open Project…');
    expect(open.enabled(useAppStore.getState())).toBe(true);
    useAppStore.setState({ view: 'multitrack' });
    expect(open.enabled(useAppStore.getState())).toBe(true);
  });

  // F11-7 rewrote this list. The M1 round pinned it with the four
  // long-inference commands in it (`edit.remix`, `edit.separateStems`,
  // `edit.transcribe`, `edit.voiceChanger`); those MOVED to the Pipeline
  // section, so the expectation legitimately changes rather than being wrong.
  // What it still pins is the same thing it always did: the whole Edit list,
  // exactly, in order — so an accidental re-add shows up here.
  it('Edit section contains the documented command ids in order', () => {
    const edit = getMenuSections().find((s) => s.title === 'Edit')!;
    expect(commandIds(edit.items)).toEqual([
      'edit.undo',
      'edit.redo',
      'edit.split', // item 8 (M1): the row before Cut
      'multitrack.mergeClips', // D6: Split's inverse, directly after it
      'edit.cut',
      'edit.copy',
      'edit.paste',
      'edit.delete',
      'edit.rippleDelete', // K1
      'edit.rippleDeleteTime', // T5 — listed and permanently disabled
      'edit.trim',
      'edit.silence',
      'edit.selectAll',
      'edit.convertSampleRate',
      'edit.convertChannels',
      'multitrack.insertDoc',
      'multitrack.addTrack',
      'multitrack.prevClipEdge', // K1
      'multitrack.nextClipEdge', // K1
      'marker.add',
      'marker.next',
      'marker.prev',
    ]);
  });

  // The separator run has to survive the removal too: dropping four items out
  // of the middle of a group leaves two adjacent separators if the group's own
  // separator is not dropped with them.
  it('Edit section has no doubled or leading/trailing separator after the move', () => {
    const items = getMenuSections().find((s) => s.title === 'Edit')!.items;
    expect(items[0]).not.toBe('separator');
    expect(items[items.length - 1]).not.toBe('separator');
    for (let i = 1; i < items.length; i++) {
      expect(items[i] === 'separator' && items[i - 1] === 'separator').toBe(false);
    }
  });

  it('File commands needing an active document report disabled when none is open', () => {
    const file = getMenuSections().find((s) => s.title === 'File')!;
    const saveCmd = file.items.find(
      (item): item is MenuCommand => item !== 'separator' && item.id === 'file.save'
    )!;
    expect(saveCmd.enabled(useAppStore.getState())).toBe(false);
  });

  describe('file.save is gated on unsaved work, not on having a document (O1-2)', () => {
    const fileCmd = (id: string) => {
      const file = getMenuSections().find((s) => s.title === 'File')!;
      return file.items.find(
        (item): item is MenuCommand => item !== 'separator' && item.id === id
      )!;
    };

    function openSavedDoc() {
      const doc = createDocument({
        name: 'song.wav',
        sampleRate: 44100,
        channels: [new Float32Array(1000)],
        filePath: 'D:\\audio\\song.wav',
        neverSaved: false,
      });
      useAppStore.getState().addDocument(doc);
      return doc;
    }

    it('is DISABLED for a saved project whose one document has nothing to save', () => {
      // Lot A (M4): Save writes the project. With a project path and nothing
      // behind it, a Save would rewrite the same bytes — greyed, exactly as
      // the in-place document Save was for a clean document (O1-2).
      openSavedDoc();
      useSessionStore.getState().setProjectPath('D:\\p.audm');
      expect(fileCmd('file.save').enabled(useAppStore.getState())).toBe(false);
    });

    it('is ENABLED once the document is dirty', () => {
      const doc = openSavedDoc();
      useSessionStore.getState().setProjectPath('D:\\p.audm');
      useAppStore.getState().updateDocument({ ...doc, dirty: true });
      expect(fileCmd('file.save').enabled(useAppStore.getState())).toBe(true);
    });

    it('is ENABLED for a clean document that was never written to disk', () => {
      // A computed document (Mix Down, Remix N, a recording, a stem) is clean
      // from birth and exists nowhere on disk. Same predicate the close guard
      // prompts on.
      openDoc();
      useSessionStore.getState().setProjectPath('D:\\p.audm');
      expect(fileCmd('file.save').enabled(useAppStore.getState())).toBe(true);
    });

    it('is ENABLED for a never-written project with a clean document (M4: content exists, the project has no file)', () => {
      openSavedDoc();
      expect(useSessionStore.getState().projectPath).toBeNull();
      expect(fileCmd('file.save').enabled(useAppStore.getState())).toBe(true);
    });

    it('leaves file.saveAs enabled for a document with nothing to save', () => {
      // Save As is an explicit "write this to a file I name" gesture; it is
      // meaningful with no edits behind it, and must not be gated with Save.
      openSavedDoc();
      expect(fileCmd('file.saveAs').enabled(useAppStore.getState())).toBe(true);
    });

    it('leaves file.export and file.close enabled for a document with nothing to save', () => {
      openSavedDoc();
      expect(fileCmd('file.export').enabled(useAppStore.getState())).toBe(true);
      expect(fileCmd('file.close').enabled(useAppStore.getState())).toBe(true);
    });
  });

  it('Help section exposes an enabled about command', () => {
    const help = getMenuSections().find((s) => s.title === 'Help')!;
    const about = help.items.find(
      (item): item is MenuCommand => item !== 'separator' && item.id === 'help.about'
    );
    expect(about).toBeDefined();
    expect(about!.enabled(useAppStore.getState())).toBe(true);
  });

  it('About credits the stem-separation model (v1.7 ruling 9)', async () => {
    const showMessageBox = jest.fn(async (_opts: { message: string }) => 0);
    (
      window as unknown as {
        electronAPI: { showMessageBox: jest.Mock; getAppVersion: jest.Mock };
      }
    ).electronAPI = { showMessageBox, getAppVersion: jest.fn(async () => '1.7.0') };

    await runCommand('help.about');

    const opts = showMessageBox.mock.calls[0][0];
    expect(opts.message).toContain('Version 1.7.0');
    expect(opts.message).toContain('HT-Demucs (Meta AI, MIT)');
    expect(opts.message).toContain('StemSplitio');
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
  // The marker commands did NOT move in F11-7 — they are per-document edits,
  // not pipeline passes — so this helper still reads the Edit section.
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

describe('edit.delete / edit.rippleDelete in the editor views (item 7)', () => {
  function nonZeroDoc() {
    const doc = createDocument({
      name: 'ramp.wav',
      sampleRate: 44100,
      channels: [Float32Array.from({ length: 1000 }, (_, i) => i + 1)],
    });
    useAppStore.getState().addDocument(doc);
    return doc;
  }

  it('edit.rippleDelete is enabled in the waveform view with a selection, disabled without, and shrinks the document 1000 -> 990 with History label Ripple Delete', async () => {
    const doc = nonZeroDoc();
    expect(isCommandEnabled('edit.rippleDelete')).toBe(false);

    useAppStore.getState().setSelection({ start: 0, end: 10 });
    expect(isCommandEnabled('edit.rippleDelete')).toBe(true);

    await runCommand('edit.rippleDelete');
    expect(docLength(useAppStore.getState().documents[0])).toBe(990);
    expect(getHistory(doc.id).done).toEqual(['Ripple Delete']);
  });

  it('edit.delete in the waveform view keeps the length at 1000 and zeroes [0,10)', async () => {
    const doc = nonZeroDoc();
    useAppStore.getState().setSelection({ start: 0, end: 10 });

    await runCommand('edit.delete');

    const after = useAppStore.getState().documents[0];
    expect(docLength(after)).toBe(1000);
    expect(Array.from(after.channels[0].subarray(0, 12))).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 11, 12]);
    expect(getHistory(doc.id).done).toEqual(['Delete']);
    expect(useAppStore.getState().selection).toBeNull();
    expect(useAppStore.getState().cursorSample).toBe(0);
  });
});

describe('edit.split / edit.cut / marker.add in the editor views (item 8)', () => {
  function findEditCmd(id: string): MenuCommand {
    const edit = getMenuSections().find((s) => s.title === 'Edit')!;
    return edit.items.find((item): item is MenuCommand => item !== 'separator' && item.id === id)!;
  }

  it('edit.split is registered as "Split at Cursor" on Ctrl+K', () => {
    const cmd = findEditCmd('edit.split');
    expect(cmd.label).toBe('Split at Cursor');
    expect(cmd.shortcut).toBe('Ctrl+K');
  });

  it('edit.split is enabled with an active document in waveform and spectral, disabled with none and in multitrack', () => {
    expect(isCommandEnabled('edit.split')).toBe(false);
    openDoc();
    for (const view of ['waveform', 'spectral'] as const) {
      useAppStore.getState().setView(view);
      expect(isCommandEnabled('edit.split')).toBe(true);
    }
    useAppStore.getState().setView('multitrack');
    expect(isCommandEnabled('edit.split')).toBe(false);
  });

  it('runCommand(edit.split) in the waveform view adds one marker at the cursor', async () => {
    const doc = openDoc();
    useAppStore.getState().setCursor(250);

    await runCommand('edit.split');

    const markers = useAppStore.getState().markers[doc.id];
    expect(markers).toHaveLength(1);
    expect(markers[0].positionSample).toBe(250);
    expect(markers[0].name).toMatch(/^Split \d+$/);
  });

  it('edit.cut is enabled with no selection when the cursor sits in a marker-bounded segment, disabled with no selection and no markers (N9)', async () => {
    const doc = openDoc();
    useAppStore.getState().setCursor(600);
    expect(isCommandEnabled('edit.cut')).toBe(false);

    useAppStore.getState().addMarker(doc.id, { id: 'marker-x', name: 'X', positionSample: 500 });
    expect(isCommandEnabled('edit.cut')).toBe(true);

    await runCommand('edit.cut');
    expect(useAppStore.getState().cursorSample).toBe(500);
    expect(docLength(useAppStore.getState().documents[0])).toBe(1000);
  });

  it('edit.cut stays disabled in multitrack even with a selection and a segment (M1/M7)', () => {
    const doc = openDoc();
    useAppStore.getState().addMarker(doc.id, { id: 'marker-y', name: 'Y', positionSample: 500 });
    useAppStore.getState().setSelection({ start: 100, end: 400 });
    useAppStore.getState().setView('multitrack');
    expect(isCommandEnabled('edit.cut')).toBe(false);
  });

  it('marker.add is disabled in multitrack with an active document, enabled in waveform (N10)', () => {
    openDoc();
    expect(isCommandEnabled('marker.add')).toBe(true);
    useAppStore.getState().setView('multitrack');
    expect(isCommandEnabled('marker.add')).toBe(false);
    useAppStore.getState().setView('spectral');
    expect(isCommandEnabled('marker.add')).toBe(true);
  });
});

describe('marker.add undo (Task M2 / F5)', () => {
  it('Ctrl+Z after marker.add removes the marker, not a prior audio edit', async () => {
    const doc = openDoc(); // length 1000
    useAppStore.getState().setSelection({ start: 0, end: 10 });
    await runCommand('edit.rippleDelete'); // audio edit: length 1000 -> 990 (item 7: plain Delete is equal-length)
    expect(docLength(useAppStore.getState().documents[0])).toBe(990);

    useAppStore.getState().setCursor(500);
    await runCommand('marker.add');
    expect(useAppStore.getState().markers[doc.id]).toHaveLength(1);

    await runCommand('edit.undo'); // undoes the marker add
    expect(useAppStore.getState().markers[doc.id] ?? []).toHaveLength(0);
    expect(docLength(useAppStore.getState().documents[0])).toBe(990); // audio edit untouched

    await runCommand('edit.undo'); // now undoes the audio edit
    expect(docLength(useAppStore.getState().documents[0])).toBe(1000);
  });

  it('marker.add dirties the doc; undo recomputes dirty back to clean (derived, not left stale)', async () => {
    const doc = openDoc();
    expect(useAppStore.getState().documents[0].dirty).toBe(false);

    useAppStore.getState().setCursor(300);
    await runCommand('marker.add');
    expect(useAppStore.getState().markers[doc.id]).toHaveLength(1);
    expect(useAppStore.getState().documents[0].dirty).toBe(true);

    await runCommand('edit.undo'); // setMarkersForDoc alone doesn't touch dirty
    expect(useAppStore.getState().documents[0].dirty).toBe(false); // derived override must recompute it
  });

  it('marker.add undo/redo round-trips through Ctrl+Z / Ctrl+Y', async () => {
    const doc = openDoc();
    useAppStore.getState().setCursor(200);
    await runCommand('marker.add');
    const markerId = useAppStore.getState().markers[doc.id][0].id;

    await runCommand('edit.undo');
    expect(useAppStore.getState().markers[doc.id] ?? []).toHaveLength(0);

    await runCommand('edit.redo');
    expect(useAppStore.getState().markers[doc.id]).toHaveLength(1);
    expect(useAppStore.getState().markers[doc.id][0].id).toBe(markerId);
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

describe('view.beatGrid (Task B2)', () => {
  afterEach(() => {
    // The visibility store is module-level; restore the documented default.
    setBeatGridVisible(true);
  });

  function findViewCmd(id: string): MenuCommand {
    const view = getMenuSections().find((s) => s.title === 'View')!;
    return view.items.find((item): item is MenuCommand => item !== 'separator' && item.id === id)!;
  }

  it('is registered in the View section, after view.spectralScale', () => {
    const view = getMenuSections().find((s) => s.title === 'View')!;
    const ids = view.items
      .filter((item): item is MenuCommand => item !== 'separator')
      .map((item) => item.id);
    expect(ids).toContain('view.beatGrid');
    expect(ids.indexOf('view.beatGrid')).toBeGreaterThan(ids.indexOf('view.spectralScale'));
  });

  it('is enabled in BOTH editor views with a document, and nowhere else', () => {
    useAppStore.setState({ view: 'waveform' });
    expect(findViewCmd('view.beatGrid').enabled(useAppStore.getState())).toBe(false); // no doc

    openDoc();
    useAppStore.setState({ view: 'waveform' });
    expect(findViewCmd('view.beatGrid').enabled(useAppStore.getState())).toBe(true);
    useAppStore.setState({ view: 'spectral' });
    expect(findViewCmd('view.beatGrid').enabled(useAppStore.getState())).toBe(true);
    useAppStore.setState({ view: 'multitrack' });
    expect(findViewCmd('view.beatGrid').enabled(useAppStore.getState())).toBe(false);
  });

  it('running it flips the beat-grid visibility', async () => {
    openDoc();
    useAppStore.setState({ view: 'waveform' });
    expect(isBeatGridVisible()).toBe(true);

    await runCommand('view.beatGrid');
    expect(isBeatGridVisible()).toBe(false);

    await runCommand('view.beatGrid');
    expect(isBeatGridVisible()).toBe(true);
  });
});

describe('view.snapToGrid (Task B4)', () => {
  afterEach(() => _resetSnapPreference());

  function findViewCmd(id: string): MenuCommand {
    const view = getMenuSections().find((s) => s.title === 'View')!;
    return view.items.find((item): item is MenuCommand => item !== 'separator' && item.id === id)!;
  }

  it('is registered in the View section, after view.beatGrid', () => {
    const view = getMenuSections().find((s) => s.title === 'View')!;
    const ids = view.items
      .filter((item): item is MenuCommand => item !== 'separator')
      .map((item) => item.id);
    expect(ids).toContain('view.snapToGrid');
    expect(ids.indexOf('view.snapToGrid')).toBeGreaterThan(ids.indexOf('view.beatGrid'));
  });

  it('is ALWAYS enabled — snapping governs the multitrack too, which needs no open document', () => {
    for (const view of ['waveform', 'spectral', 'multitrack'] as const) {
      useAppStore.setState({ view });
      expect(findViewCmd('view.snapToGrid').enabled(useAppStore.getState())).toBe(true);
    }
  });

  it('running it flips the snap preference', async () => {
    expect(isSnapEnabled()).toBe(true);
    await runCommand('view.snapToGrid');
    expect(isSnapEnabled()).toBe(false);
    await runCommand('view.snapToGrid');
    expect(isSnapEnabled()).toBe(true);
  });

  it('does not touch the beat-grid display preference', async () => {
    await runCommand('view.snapToGrid');
    expect(isBeatGridVisible()).toBe(true);
  });
});

describe('file.save / file.saveAs / session.open error surfacing (F3 defense-in-depth, lot A)', () => {
  const mockSaveProject = sessionFileModule.saveProject as jest.MockedFunction<typeof sessionFileModule.saveProject>;

  it('file.save shows an error message box when saveProject rejects, instead of an uncaught rejection', async () => {
    const showMessageBox = installShowMessageBox();
    mockSaveProject.mockRejectedValueOnce(new Error('serialize failed: payload too large'));
    openDoc(); // never-written project with content => Save enabled

    await expect(runCommand('file.save')).resolves.toBeUndefined();

    expect(showMessageBox).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        title: 'Save Project failed',
        message: 'serialize failed: payload too large',
      })
    );
  });

  it('file.saveAs shows the same box when saveProject rejects', async () => {
    const showMessageBox = installShowMessageBox();
    mockSaveProject.mockRejectedValueOnce(new Error('disk on fire'));

    await expect(runCommand('file.saveAs')).resolves.toBeUndefined();

    expect(showMessageBox).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', title: 'Save Project failed', message: 'disk on fire' })
    );
  });

  it('session.open shows an error message box when openSessionViaDialog rejects, instead of an uncaught rejection', async () => {
    const showMessageBox = installShowMessageBox();
    (sessionFileModule.openSessionViaDialog as jest.MockedFunction<typeof sessionFileModule.openSessionViaDialog>)
      .mockRejectedValueOnce(new Error('parse failed: corrupt file'));

    await expect(runCommand('session.open')).resolves.toBeUndefined();

    expect(showMessageBox).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', title: 'Open Project failed', message: 'parse failed: corrupt file' })
    );
  });
});

// ---------------------------------------------------------------------------
// Lot A (M4 / M5) — Save writes the project in every view; Export in the
// multitrack view renders the session.
// ---------------------------------------------------------------------------
describe('file.save / file.saveAs / file.export under M4 and M5 (lot A — acceptance 13)', () => {
  const mockSaveProject = sessionFileModule.saveProject as jest.MockedFunction<typeof sessionFileModule.saveProject>;

  function addClipToTrack0(docId: string) {
    const trackId = useSessionStore.getState().session.tracks[0].id;
    useSessionStore
      .getState()
      .addClip(trackId, createClip({ documentId: docId, startSample: 0, offsetSample: 0, lengthSample: 10 }));
  }

  beforeEach(() => {
    mockSaveProject.mockReset();
    mockSaveProject.mockResolvedValue(true);
  });

  it('(a) file.save is enabled iff projectHasUnsavedWork() — in the waveform view and in multitrack with no document', () => {
    // waveform, empty untitled project: clean
    expect(fileServiceModule.projectHasUnsavedWork()).toBe(false);
    expect(isCommandEnabled('file.save')).toBe(false);
    // waveform, a document in a never-written project: dirty
    openDoc();
    expect(fileServiceModule.projectHasUnsavedWork()).toBe(true);
    expect(isCommandEnabled('file.save')).toBe(true);

    // multitrack, no document at all: follows the session
    useAppStore.setState(makeInitialState());
    useAppStore.setState({ view: 'multitrack' });
    useSessionStore.getState().setProjectPath('D:\\p.audm');
    expect(fileServiceModule.projectHasUnsavedWork()).toBe(false);
    expect(isCommandEnabled('file.save')).toBe(false);
    useSessionStore.getState().addTrack();
    expect(fileServiceModule.projectHasUnsavedWork()).toBe(true);
    expect(isCommandEnabled('file.save')).toBe(true);
  });

  it('(b) runCommand(file.save) calls saveProject({ as: false }) and never saveDocument', async () => {
    const saveDocSpy = jest.spyOn(fileServiceModule, 'saveDocument');
    openDoc();

    await runCommand('file.save');

    expect(mockSaveProject).toHaveBeenCalledTimes(1);
    expect(mockSaveProject).toHaveBeenCalledWith({ as: false });
    expect(saveDocSpy).not.toHaveBeenCalled();
    saveDocSpy.mockRestore();
  });

  it('(c) file.saveAs is enabled with nothing open and calls saveProject({ as: true })', async () => {
    expect(useAppStore.getState().documents).toHaveLength(0);
    expect(isCommandEnabled('file.saveAs')).toBe(true);

    await runCommand('file.saveAs');

    expect(mockSaveProject).toHaveBeenCalledWith({ as: true });
  });

  it('(c) file.save and file.saveAs carry their accelerators and labels', () => {
    const file = getMenuSections().find((s) => s.title === 'File')!;
    const cmd = (id: string) => file.items.find((i): i is MenuCommand => i !== 'separator' && i.id === id)!;
    expect(cmd('file.save').label).toBe('Save');
    expect(cmd('file.save').shortcut).toBe('Ctrl+S');
    expect(cmd('file.saveAs').label).toBe('Save As…');
    expect(cmd('file.saveAs').shortcut).toBe('Ctrl+Shift+S');
  });

  it('(f) file.export in multitrack follows the session: enabled with clips and no active doc, disabled with an empty session and an active doc', () => {
    useAppStore.setState({ view: 'multitrack' });
    expect(isCommandEnabled('file.export')).toBe(false);

    addClipToTrack0('doc-elsewhere');
    expect(useAppStore.getState().activeDocumentId).toBeNull();
    expect(isCommandEnabled('file.export')).toBe(true);

    useSessionStore.getState().newSession(44100);
    openDoc();
    useAppStore.setState({ view: 'multitrack' });
    expect(useAppStore.getState().activeDocumentId).not.toBeNull();
    expect(isCommandEnabled('file.export')).toBe(false);
  });

  it('(f) file.export in the waveform view still needs an active document', () => {
    expect(isCommandEnabled('file.export')).toBe(false);
    openDoc();
    expect(isCommandEnabled('file.export')).toBe(true);
  });
});

// F11-7. Ten advanced tools had accreted in two places neither of them belongs:
// seven in the head of the Effects menu (above its category-grouped effect
// list) and four in an Edit-menu group of long-inference jobs. The user asked
// for one top-level Pipeline menu holding all ten. Plan Ruling 5, which said
// the closed `MenuSection['title']` union must not be widened "for a handful of
// analysis/transform commands", is overruled by that request — see the comment
// on the union itself, which records the reversal rather than hiding it.
describe('the Pipeline section (F11-7)', () => {
  // Three groups, separator-delimited, in the order the user specified. Note
  // that this is NOT run order: `lyrics.align` closes the Voice group even
  // though the vocal chain's own `lyrics` stage note says to run it BEFORE the
  // chain. The menu groups by subject; the stage notes remain the only surface
  // that states sequence, and `vocalChain.test.ts` still pins them.
  const PIPELINE_ITEMS: (string | 'separator')[] = [
    'tempo.detect',
    'tempo.match',
    'timing.align',
    'edit.remix',
    'separator',
    'edit.voiceChanger',
    'effects.vocalChain',
    'effects.coverChain',
    'lyrics.align',
    'separator',
    'edit.transcribe',
    'edit.separateStems',
    // F11-8 closed this list with a fourth group, Mix, holding
    // `spatial.position`; T8 moved that command to the Effects section on the
    // user's direction — its own describe below pins where it lives now.
  ];

  const MOVED = PIPELINE_ITEMS.filter((id): id is string => id !== 'separator');

  /** T8: with the positioner gone to the Effects menu, EVERY Pipeline row is
   * gated on the active document, so the document law below is stated over
   * all of them. */
  const DOC_GATED = MOVED;

  function itemKeys(title: string): (string | 'separator')[] {
    const section = getMenuSections().find((s) => s.title === title)!;
    return section.items.map((item) => (item === 'separator' ? 'separator' : item.id));
  }

  it('sits immediately after Effects in the bar', () => {
    const titles = getMenuSections().map((s) => s.title);
    expect(titles.indexOf('Pipeline')).toBe(titles.indexOf('Effects') + 1);
  });

  it('holds the ten tools in three separated groups, in order', () => {
    expect(itemKeys('Pipeline')).toEqual(PIPELINE_ITEMS);
  });

  it('keeps that layout once the effect registry has populated the menu', () => {
    registerAllEffects();
    registerEffectCommands();
    expect(itemKeys('Pipeline')).toEqual(PIPELINE_ITEMS);
  });

  // The whole point of the request was to MOVE them. A duplicate would leave
  // two rows running one command, and the old rows greying independently.
  it('MOVED them: each of the ten appears exactly once across the whole menu bar', () => {
    registerAllEffects();
    registerEffectCommands();
    const everywhere = getMenuSections().flatMap((s) => commandIds(s.items));
    for (const id of MOVED) {
      expect(everywhere.filter((seen) => seen === id)).toEqual([id]);
    }
  });

  it('every row resolves to a real registered command, not an id fallback', () => {
    const pipeline = getMenuSections().find((s) => s.title === 'Pipeline')!;
    for (const item of pipeline.items) {
      if (item === 'separator') continue;
      expect(item.label).not.toBe(item.id);
    }
  });

  it('leaves the Effects menu to Capture Noise Print, the registry effects, and the Mix tail', () => {
    registerAllEffects();
    registerEffectCommands();
    const ids = commandIds(getMenuSections().find((s) => s.title === 'Effects')!.items);
    for (const id of MOVED) expect(ids).not.toContain(id);
    // Everything between the noise print and the Mix tail is a category label
    // or an effect. (T8 appended `spatial.position` as the tail — its own
    // describe below pins that placement; this law is about everything else.)
    expect(ids[0]).toBe('noise.capture');
    expect(ids[ids.length - 1]).toBe('spatial.position');
    for (const id of ids.slice(1, -1)) {
      expect(id.startsWith('effects.cat.') || id.startsWith('effect.')).toBe(true);
    }
  });

  // Argued, not inherited: `noise.capture` is the one head item that did NOT
  // move. It is not one of the ten the user listed, it is an instant profile of
  // the selection rather than a multi-stage pass, and its only consumer is the
  // Noise Reduction EFFECT sitting a few rows below it — its own confirmation
  // dialog tells the user to go run exactly that. Moving it would put a
  // one-step primer in a menu of long jobs and separate it from the only thing
  // it primes.
  it('leaves Capture Noise Print at the top of Effects, with the effect it primes', () => {
    registerAllEffects();
    registerEffectCommands();
    const ids = commandIds(getMenuSections().find((s) => s.title === 'Effects')!.items);
    expect(ids[0]).toBe('noise.capture');
    expect(ids).toContain('effect.noise-reduction');
    expect(commandIds(getMenuSections().find((s) => s.title === 'Pipeline')!.items)).not.toContain(
      'noise.capture'
    );
  });

  it('carries no keyboard shortcut on any row — every one of the ten is a long pass', () => {
    const pipeline = getMenuSections().find((s) => s.title === 'Pipeline')!;
    for (const item of pipeline.items) {
      if (item === 'separator') continue;
      expect(item.shortcut).toBeUndefined();
    }
  });

  // T8: the user had the trailing dots removed from every Pipeline label
  // ("remove the '...' from the end of every pipeline"). This killed the
  // dots-mean-a-dialog convention for this menu — a Pipeline label is a plain
  // name now, whatever the row opens — and this pin is what keeps a relabelled
  // or newly-added row from quietly bringing the dots back.
  it('carries no ellipsis on any row label — Pipeline labels are plain names (T8)', () => {
    const pipeline = getMenuSections().find((s) => s.title === 'Pipeline')!;
    for (const item of pipeline.items) {
      if (item === 'separator') continue;
      expect([item.id, item.label.includes('…')]).toEqual([item.id, false]);
    }
  });

  // Placement moved; the commands did not. Enablement is the observable half of
  // that, and it is the half a careless "move" breaks by re-registering a stub.
  it('every document-gated row is disabled with no document and enabled with one', () => {
    const findRow = (id: string) => {
      const pipeline = getMenuSections().find((s) => s.title === 'Pipeline')!;
      return pipeline.items.find(
        (item): item is MenuCommand => item !== 'separator' && item.id === id
      )!;
    };
    for (const id of DOC_GATED) expect(findRow(id).enabled(useAppStore.getState())).toBe(false);

    openDoc();
    for (const id of DOC_GATED) expect(findRow(id).enabled(useAppStore.getState())).toBe(true);
  });
});

// F11-8. The user's ruling: "Spatial and Transcript are single tools, they
// should not be a module." Spatial's panel is untouched — it keeps its stage,
// its track selector and its lane buttons — but the module strip no longer
// carries an icon for it, so the command below is the door it is reached
// through. F11-8 put that door at the end of the Pipeline menu as a fourth
// group; T8 moved it to the EFFECTS menu on the user's direction ("move the
// Spacial tool to the effects module"), where it closes the list as its own
// Mix group. Same command, same id, same run body — only the menu changed.
describe('spatial.position — the Effects menu Mix group (F11-8, moved by T8)', () => {
  function effectsItems(): (string | 'separator')[] {
    const effects = getMenuSections().find((s) => s.title === 'Effects')!;
    return effects.items.map((item) => (item === 'separator' ? 'separator' : item.id));
  }

  function effectsCmd(id: string): MenuCommand | undefined {
    const effects = getMenuSections().find((s) => s.title === 'Effects')!;
    return effects.items.find((item): item is MenuCommand => item !== 'separator' && item.id === id);
  }

  it('closes the Effects menu as a group of its own, after the registry effects', () => {
    registerAllEffects();
    registerEffectCommands();
    const ids = effectsItems();
    expect(ids[ids.length - 1]).toBe('spatial.position');
    expect(ids[ids.length - 2]).toBe('separator');
    expect(ids[ids.length - 3]).toMatch(/^effect\./);
  });

  // The move must be a MOVE: a row in two menus would grey independently in
  // each, and the Pipeline card would quietly regrow the group the user asked
  // to empty.
  it('appears exactly once across the whole menu bar, and not under Pipeline', () => {
    registerAllEffects();
    registerEffectCommands();
    const everywhere = getMenuSections().flatMap((s) => commandIds(s.items));
    expect(everywhere.filter((id) => id === 'spatial.position')).toEqual(['spatial.position']);
    expect(
      commandIds(getMenuSections().find((s) => s.title === 'Pipeline')!.items)
    ).not.toContain('spatial.position');
  });

  it('resolves to a registered command named plainly for what it opens', () => {
    const cmd = effectsCmd('spatial.position')!;
    expect(cmd).toBeDefined();
    expect(cmd.label).toBe('Spatial Positioner');
    expect(cmd.label).not.toMatch(/…$/);
  });

  // The one row of its menu that is not document-gated, and deliberately so:
  // the positioner writes automation onto a multitrack TRACK, which exists
  // with no document open, and the panel states an empty session in its own
  // words rather than being replaced by a grey row that explains nothing. The
  // strip icon it replaces was clickable in every state too, so gating here
  // would remove a surface the user has today.
  it('is enabled with no document open, and stays enabled with one', () => {
    expect(effectsCmd('spatial.position')!.enabled(useAppStore.getState())).toBe(true);
    openDoc();
    expect(effectsCmd('spatial.position')!.enabled(useAppStore.getState())).toBe(true);
  });

  it('runCommand("spatial.position") shows the positioner through the bus, opening no dialog', async () => {
    const focusSpatial = jest.fn();
    const openEffect = jest.fn();
    registerDialogSetters({
      openExportDialog: () => {},
      openNewFileDialog: () => {},
      openEffectDialog: openEffect,
      openConvertDialog: () => {},
      openRecordDialog: () => {},
      openTempoDialog: () => {},
      openRemixDialog: () => {},
      openSeparateDialog: () => {},
      openTranscribeDialog: () => {},
      openVoiceChangerDialog: () => {},
      openAlignTimingDialog: () => {},
      openVocalChainDialog: () => {},
      openCoverChainDialog: () => {},
      openAlignLyricsDialog: () => {},
      focusRemixPanel: () => {},
      focusTranscriptPanel: () => {},
      focusSpatialPanel: focusSpatial,
    });

    await runCommand('spatial.position');

    expect(focusSpatial).toHaveBeenCalledTimes(1);
    expect(openEffect).not.toHaveBeenCalled();
  });
});

// This repo's signature defect class: a command moves menus and the prose that
// tells the user where to find it does not. F11-7 moved ten of them at once and
// left eight stale strings behind across dialogs, effect refusal messages and
// chain stage notes — which is exactly why this is a sweep of the whole tree
// rather than eight assertions someone has to remember to add a ninth to.
//
// It reads the menu it is testing: for every command the menu builds, no source
// file may name that command's label behind a DIFFERENT section's name. Nothing
// is hardcoded, so a command that moves again is covered the day it moves.
describe('no source file names a stale menu path (F11-7)', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require('fs') as typeof import('fs');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const path = require('path') as typeof import('path');

  const SRC = path.resolve(__dirname, '..');

  function sourceFiles(dir: string, out: string[] = []): string[] {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        sourceFiles(full, out);
      } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
        out.push(full);
      }
    }
    return out;
  }

  it('finds source files to sweep at all', () => {
    // A silent zero here would make every assertion below vacuously true.
    expect(sourceFiles(SRC).length).toBeGreaterThan(50);
  });

  it('names every command behind the section that actually holds it', () => {
    registerAllEffects();
    registerEffectCommands();
    const sections = getMenuSections();
    const titles = sections.map((s) => s.title);
    const files = sourceFiles(SRC).map((file) => ({ file, text: fs.readFileSync(file, 'utf8') }));

    const stale: string[] = [];
    for (const section of sections) {
      for (const item of section.items) {
        if (item === 'separator') continue;
        for (const wrongTitle of titles) {
          if (wrongTitle === section.title) continue;
          const needle = `${wrongTitle} → ${item.label}`;
          for (const { file, text } of files) {
            if (text.includes(needle)) {
              stale.push(`${path.relative(SRC, file)}: "${needle}" (it is in ${section.title})`);
            }
          }
        }
      }
    }

    expect(stale).toEqual([]);
  });
});

describe('tempo.detect (Task T5)', () => {
  it('Pipeline section opens with tempo.detect', () => {
    const pipeline = getMenuSections().find((s) => s.title === 'Pipeline')!;
    expect(commandIds(pipeline.items)[0]).toBe('tempo.detect');
  });

  function findPipelineCmd(id: string): MenuCommand {
    const pipeline = getMenuSections().find((s) => s.title === 'Pipeline')!;
    return pipeline.items.find((item): item is MenuCommand => item !== 'separator' && item.id === id)!;
  }

  it('is disabled with no active document and enabled with one', () => {
    expect(findPipelineCmd('tempo.detect').enabled(useAppStore.getState())).toBe(false);

    openDoc();
    expect(findPipelineCmd('tempo.detect').enabled(useAppStore.getState())).toBe(true);
  });

  it('runCommand("tempo.detect") with no document is a no-op: runTempoAnalysis is never called', async () => {
    await runCommand('tempo.detect');
    expect(mockRunTempoAnalysis).not.toHaveBeenCalled();
  });

  it('runCommand("tempo.detect") with an active document calls runTempoAnalysis with it', async () => {
    const doc = openDoc();
    await runCommand('tempo.detect');
    expect(mockRunTempoAnalysis).toHaveBeenCalledWith(doc);
  });
});

describe('tempo.match (Task T8)', () => {
  it('Pipeline section contains tempo.match immediately after tempo.detect', () => {
    const pipeline = getMenuSections().find((s) => s.title === 'Pipeline')!;
    const ids = commandIds(pipeline.items);
    expect(ids.indexOf('tempo.match')).toBe(ids.indexOf('tempo.detect') + 1);
  });

  function findPipelineCmd(id: string): MenuCommand {
    const pipeline = getMenuSections().find((s) => s.title === 'Pipeline')!;
    return pipeline.items.find((item): item is MenuCommand => item !== 'separator' && item.id === id)!;
  }

  it('is disabled with no active document and enabled with one', () => {
    expect(findPipelineCmd('tempo.match').enabled(useAppStore.getState())).toBe(false);

    openDoc();
    expect(findPipelineCmd('tempo.match').enabled(useAppStore.getState())).toBe(true);
  });

  it('runCommand("tempo.match") opens the dialog through the bus (registered spy setter)', async () => {
    openDoc();
    const openTempo = jest.fn();
    registerDialogSetters({
      openExportDialog: () => {},
      openNewFileDialog: () => {},
      openEffectDialog: () => {},
      openConvertDialog: () => {},
      openRecordDialog: () => {},
      openTempoDialog: openTempo,
      openRemixDialog: () => {},
      openSeparateDialog: () => {},
      openTranscribeDialog: () => {},
      openVoiceChangerDialog: () => {},
      openAlignTimingDialog: () => {},
      openVocalChainDialog: () => {},
      openCoverChainDialog: () => {},
      openAlignLyricsDialog: () => {},
      focusRemixPanel: () => {},
      focusTranscriptPanel: () => {},
      focusSpatialPanel: () => {},
    });

    await runCommand('tempo.match');

    expect(openTempo).toHaveBeenCalledTimes(1);
  });
});

describe('timing.align (Task F9)', () => {
  function findPipelineCmd(id: string): MenuCommand | undefined {
    const pipeline = getMenuSections().find((s) => s.title === 'Pipeline')!;
    return pipeline.items.find((item): item is MenuCommand => item !== 'separator' && item.id === id);
  }

  it('Pipeline section contains timing.align immediately after tempo.match', () => {
    const pipeline = getMenuSections().find((s) => s.title === 'Pipeline')!;
    const ids = commandIds(pipeline.items);
    expect(ids.indexOf('timing.align')).toBe(ids.indexOf('tempo.match') + 1);
  });

  it('does NOT list the hidden align-timing effect among the per-effect commands', () => {
    registerAllEffects();
    registerEffectCommands();
    const effects = getMenuSections().find((s) => s.title === 'Effects')!;
    const ids = commandIds(effects.items);
    expect(ids).not.toContain('effect.align-timing');
    // The visible ones are still all there — this is a filter, not a truncation.
    expect(ids).toContain('effect.pitch-correct');
    expect(ids).toContain('effect.time-stretch');
    expect(ids).toContain('effect.amplify');
  });

  it('is disabled with no active document and enabled with one', () => {
    expect(findPipelineCmd('timing.align')!.enabled(useAppStore.getState())).toBe(false);
    openDoc();
    expect(findPipelineCmd('timing.align')!.enabled(useAppStore.getState())).toBe(true);
  });

  it('runCommand("timing.align") opens the dialog through the bus', async () => {
    openDoc();
    const openAlign = jest.fn();
    registerDialogSetters({
      openExportDialog: () => {},
      openNewFileDialog: () => {},
      openEffectDialog: () => {},
      openConvertDialog: () => {},
      openRecordDialog: () => {},
      openTempoDialog: () => {},
      openRemixDialog: () => {},
      openSeparateDialog: () => {},
      openTranscribeDialog: () => {},
      openVoiceChangerDialog: () => {},
      openAlignTimingDialog: openAlign,
      openVocalChainDialog: () => {},
      openCoverChainDialog: () => {},
      openAlignLyricsDialog: () => {},
      focusRemixPanel: () => {},
      focusTranscriptPanel: () => {},
      focusSpatialPanel: () => {},
    });

    await runCommand('timing.align');

    expect(openAlign).toHaveBeenCalledTimes(1);
  });
});

describe('effects.vocalChain (Task F7)', () => {
  function findPipelineCmd(id: string): MenuCommand | undefined {
    const pipeline = getMenuSections().find((s) => s.title === 'Pipeline')!;
    return pipeline.items.find((item): item is MenuCommand => item !== 'separator' && item.id === id);
  }

  // F11-7 rewrote this pair, and the rewrite gives something up. Until now the
  // Effects head listed timing.align → lyrics.align → effects.vocalChain back
  // to back BECAUSE that is the order the three are run in, and these two tests
  // pinned exactly that. The user's Pipeline grouping puts Align Vocal Timing in
  // the Tempo & Timing group and Align Lyrics at the END of the Voice group, so
  // the menu no longer encodes sequence at all — it groups by subject. That is
  // recorded here rather than quietly deleted: the only surface still stating
  // the order is each manual stage's own note, and `vocalChain.test.ts` pins
  // those. What is still worth pinning HERE is that all three landed in the one
  // menu, so neither manual step is stranded somewhere the chain's note cannot
  // point the user at.
  const MANUAL_AND_CHAIN = ['timing.align', 'lyrics.align', 'effects.vocalChain'];

  it('Pipeline holds both manual stages and the chain whose notes point at them', () => {
    for (const populate of [false, true]) {
      if (populate) {
        registerAllEffects();
        registerEffectCommands();
      }
      const ids = commandIds(getMenuSections().find((s) => s.title === 'Pipeline')!.items);
      for (const id of MANUAL_AND_CHAIN) expect(ids).toContain(id);
    }
  });

  it('registers Align Lyrics with a real label, gated on a document with audio in it', () => {
    expect(findPipelineCmd('lyrics.align')!.label).toBe('Align Lyrics');
    expect(findPipelineCmd('lyrics.align')!.enabled(useAppStore.getState())).toBe(false);
    openDoc();
    expect(findPipelineCmd('lyrics.align')!.enabled(useAppStore.getState())).toBe(true);
  });

  it('is registered with a real label rather than falling back to its id', () => {
    expect(findPipelineCmd('effects.vocalChain')!.label).toBe('Vocal Chain');
  });

  it('is disabled with no active document and enabled with one', () => {
    expect(findPipelineCmd('effects.vocalChain')!.enabled(useAppStore.getState())).toBe(false);
    openDoc();
    expect(findPipelineCmd('effects.vocalChain')!.enabled(useAppStore.getState())).toBe(true);
  });

  it('runCommand("effects.vocalChain") opens the dialog through the bus', async () => {
    openDoc();
    const openVocalChain = jest.fn();
    registerDialogSetters({
      openExportDialog: () => {},
      openNewFileDialog: () => {},
      openEffectDialog: () => {},
      openConvertDialog: () => {},
      openRecordDialog: () => {},
      openTempoDialog: () => {},
      openRemixDialog: () => {},
      openSeparateDialog: () => {},
      openTranscribeDialog: () => {},
      openVoiceChangerDialog: () => {},
      openAlignTimingDialog: () => {},
      openVocalChainDialog: openVocalChain,
      openCoverChainDialog: () => {},
      openAlignLyricsDialog: () => {},
      focusRemixPanel: () => {},
      focusTranscriptPanel: () => {},
      focusSpatialPanel: () => {},
    });

    await runCommand('effects.vocalChain');

    expect(openVocalChain).toHaveBeenCalledTimes(1);
  });
});

describe('effects.coverChain (Task F10)', () => {
  function findPipelineCmd(id: string): MenuCommand | undefined {
    const pipeline = getMenuSections().find((s) => s.title === 'Pipeline')!;
    return pipeline.items.find((item): item is MenuCommand => item !== 'separator' && item.id === id);
  }

  // The FOUR run in this order and the menu says so. The cover chain's own
  // `clean` stage note argues its position against the chain before it: the
  // match is a correction to a CLEAN take, so the vocal chain runs first.
  const IN_ORDER = ['timing.align', 'lyrics.align', 'effects.vocalChain', 'effects.coverChain'];

  it('sits immediately after Vocal Chain, both before and after the registry populates', () => {
    for (const populate of [false, true]) {
      if (populate) {
        registerAllEffects();
        registerEffectCommands();
      }
      // F11-7: the section is Pipeline now. This adjacency is the one the move
      // preserved — the Voice group keeps Vocal Chain → Cover Chain back to
      // back, which is the pairing the cover chain's own `clean` note argues.
      const pipeline = getMenuSections().find((s) => s.title === 'Pipeline')!;
      const ids = commandIds(pipeline.items);
      for (const id of IN_ORDER) expect(ids).toContain(id);
      expect(ids.indexOf('effects.coverChain')).toBe(ids.indexOf('effects.vocalChain') + 1);
    }
  });

  it('is registered with a real label rather than falling back to its id', () => {
    expect(findPipelineCmd('effects.coverChain')!.label).toBe('Cover Chain');
  });

  it('is disabled with no active document and enabled with one', () => {
    expect(findPipelineCmd('effects.coverChain')!.enabled(useAppStore.getState())).toBe(false);
    openDoc();
    expect(findPipelineCmd('effects.coverChain')!.enabled(useAppStore.getState())).toBe(true);
  });

  it('has no keyboard shortcut — a nine-stage pass is never one keystroke away', () => {
    expect(findPipelineCmd('effects.coverChain')!.shortcut).toBeUndefined();
  });

  it('runCommand("effects.coverChain") opens the dialog through the bus', async () => {
    openDoc();
    const openCoverChain = jest.fn();
    const openVocalChain = jest.fn();
    registerDialogSetters({
      openExportDialog: () => {},
      openNewFileDialog: () => {},
      openEffectDialog: () => {},
      openConvertDialog: () => {},
      openRecordDialog: () => {},
      openTempoDialog: () => {},
      openRemixDialog: () => {},
      openSeparateDialog: () => {},
      openTranscribeDialog: () => {},
      openVoiceChangerDialog: () => {},
      openAlignTimingDialog: () => {},
      openVocalChainDialog: openVocalChain,
      openCoverChainDialog: openCoverChain,
      openAlignLyricsDialog: () => {},
      focusRemixPanel: () => {},
      focusTranscriptPanel: () => {},
      focusSpatialPanel: () => {},
    });

    await runCommand('effects.coverChain');

    expect(openCoverChain).toHaveBeenCalledTimes(1);
    // ...and it is not the neighbouring command wired twice.
    expect(openVocalChain).not.toHaveBeenCalled();
  });
});

describe('edit.remix (Task T14)', () => {
  // F11-7: this command left the Edit menu for Pipeline. Only its PLACEMENT
  // moved — the id, the predicate, the label and the run body are untouched,
  // which is what the enablement/dispatch tests below still measure.
  function findEditCmd(id: string): MenuCommand {
    const pipeline = getMenuSections().find((s) => s.title === 'Pipeline')!;
    return pipeline.items.find(
      (item): item is MenuCommand => item !== 'separator' && item.id === id
    )!;
  }

  // F11-7 rewrote this. T14 argued Auto-Remix into the Edit menu because it
  // produces a NEW document and so cannot be an `EffectDefinition`. That
  // argument only ever ruled out the Effects menu; with a Pipeline menu it
  // closes the Tempo & Timing group instead, next to the two tempo tools whose
  // analysis it shares. It is out of Edit entirely, which the Edit-layout test
  // above pins from the other side.
  it('closes the Pipeline Tempo & Timing group, immediately after timing.align', () => {
    const pipeline = getMenuSections().find((s) => s.title === 'Pipeline')!;
    const alignIndex = pipeline.items.findIndex(
      (item) => item !== 'separator' && item.id === 'timing.align'
    );

    const remix = pipeline.items[alignIndex + 1];
    expect(remix !== 'separator' && remix.id).toBe('edit.remix');
    expect(remix !== 'separator' && remix.label).toBe('Auto-Remix');
    expect(remix !== 'separator' && remix.shortcut).toBeUndefined();
    expect(pipeline.items[alignIndex + 2]).toBe('separator');

    expect(commandIds(getMenuSections().find((s) => s.title === 'Edit')!.items)).not.toContain(
      'edit.remix'
    );
  });

  it('is disabled with no document, disabled for a zero-length document, enabled otherwise', () => {
    expect(findEditCmd('edit.remix').enabled(useAppStore.getState())).toBe(false);

    const empty = createDocument({ name: 'empty', sampleRate: 44100, channels: [new Float32Array(0)] });
    useAppStore.getState().addDocument(empty);
    expect(docLength(empty)).toBe(0);
    expect(findEditCmd('edit.remix').enabled(useAppStore.getState())).toBe(false);

    openDoc();
    expect(findEditCmd('edit.remix').enabled(useAppStore.getState())).toBe(true);
  });

  it('runCommand("edit.remix") opens the dialog through the bus (registered spy setter)', async () => {
    openDoc();
    const openRemix = jest.fn();
    registerDialogSetters({
      openExportDialog: () => {},
      openNewFileDialog: () => {},
      openEffectDialog: () => {},
      openConvertDialog: () => {},
      openRecordDialog: () => {},
      openTempoDialog: () => {},
      openRemixDialog: openRemix,
      openSeparateDialog: () => {},
      openTranscribeDialog: () => {},
      openVoiceChangerDialog: () => {},
      openAlignTimingDialog: () => {},
      openVocalChainDialog: () => {},
      openCoverChainDialog: () => {},
      openAlignLyricsDialog: () => {},
      focusRemixPanel: () => {},
      focusTranscriptPanel: () => {},
      focusSpatialPanel: () => {},
    });

    await runCommand('edit.remix');

    expect(openRemix).toHaveBeenCalledTimes(1);
  });

  it('runCommand("edit.remix") with no document never reaches the bus', async () => {
    const openRemix = jest.fn();
    registerDialogSetters({
      openExportDialog: () => {},
      openNewFileDialog: () => {},
      openEffectDialog: () => {},
      openConvertDialog: () => {},
      openRecordDialog: () => {},
      openTempoDialog: () => {},
      openRemixDialog: openRemix,
      openSeparateDialog: () => {},
      openTranscribeDialog: () => {},
      openVoiceChangerDialog: () => {},
      openAlignTimingDialog: () => {},
      openVocalChainDialog: () => {},
      openCoverChainDialog: () => {},
      openAlignLyricsDialog: () => {},
      focusRemixPanel: () => {},
      focusTranscriptPanel: () => {},
      focusSpatialPanel: () => {},
    });

    await runCommand('edit.remix');

    expect(openRemix).not.toHaveBeenCalled();
  });
});

describe('edit.separateStems (Task S6)', () => {
  // F11-7: this command left the Edit menu for Pipeline. Only its PLACEMENT
  // moved — the id, the predicate, the label and the run body are untouched,
  // which is what the enablement/dispatch tests below still measure.
  function findEditCmd(id: string): MenuCommand {
    const pipeline = getMenuSections().find((s) => s.title === 'Pipeline')!;
    return pipeline.items.find(
      (item): item is MenuCommand => item !== 'separator' && item.id === id
    )!;
  }

  function installSetters(openSeparate: jest.Mock) {
    registerDialogSetters({
      openExportDialog: () => {},
      openNewFileDialog: () => {},
      openEffectDialog: () => {},
      openConvertDialog: () => {},
      openRecordDialog: () => {},
      openTempoDialog: () => {},
      openRemixDialog: () => {},
      openSeparateDialog: openSeparate,
      openTranscribeDialog: () => {},
      openVoiceChangerDialog: () => {},
      openAlignTimingDialog: () => {},
      openVocalChainDialog: () => {},
      openCoverChainDialog: () => {},
      openAlignLyricsDialog: () => {},
      focusRemixPanel: () => {},
      focusTranscriptPanel: () => {},
      focusSpatialPanel: () => {},
    });
  }

  // F11-7 rewrote this. S6 put Separate into Stems beside Auto-Remix because
  // both produce new documents; the Pipeline grouping is by SUBJECT, not by
  // that structural property, so the two are no longer neighbours — separation
  // closes the Analysis group with Transcribe, the other whole-file model run.
  // The adjacency S6 pinned is genuinely gone, so this pins the new one and the
  // absence from Edit rather than pretending the old one survived.
  it('closes the Pipeline Analysis group, immediately after edit.transcribe', () => {
    const pipeline = getMenuSections().find((s) => s.title === 'Pipeline')!;
    const transcribeIndex = pipeline.items.findIndex(
      (item) => item !== 'separator' && item.id === 'edit.transcribe'
    );

    const separate = pipeline.items[transcribeIndex + 1];
    expect(separate !== 'separator' && separate.id).toBe('edit.separateStems');
    expect(separate !== 'separator' && separate.label).toBe('Separate into Stems');
    expect(separate !== 'separator' && separate.shortcut).toBeUndefined();
    // Closes the GROUP, which is what this test is named for: nothing follows
    // it — never another Analysis row, and since T8 moved the Mix group to the
    // Effects menu, no further group either. (F11-8 had made 'Mix' follow it
    // behind a separator; the closing property is the same, its expression is
    // "end of the list" again.)
    expect(pipeline.items.length).toBe(transcribeIndex + 2);

    expect(commandIds(getMenuSections().find((s) => s.title === 'Edit')!.items)).not.toContain(
      'edit.separateStems'
    );
  });

  it('is disabled with no document, disabled for a zero-length document, enabled otherwise', () => {
    expect(findEditCmd('edit.separateStems').enabled(useAppStore.getState())).toBe(false);

    const empty = createDocument({ name: 'empty', sampleRate: 44100, channels: [new Float32Array(0)] });
    useAppStore.getState().addDocument(empty);
    expect(docLength(empty)).toBe(0);
    expect(findEditCmd('edit.separateStems').enabled(useAppStore.getState())).toBe(false);

    openDoc();
    expect(findEditCmd('edit.separateStems').enabled(useAppStore.getState())).toBe(true);
  });

  it('runCommand("edit.separateStems") opens the dialog through the bus (registered spy setter)', async () => {
    openDoc();
    const openSeparate = jest.fn();
    installSetters(openSeparate);

    await runCommand('edit.separateStems');

    expect(openSeparate).toHaveBeenCalledTimes(1);
  });

  it('runCommand("edit.separateStems") with no document never reaches the bus', async () => {
    const openSeparate = jest.fn();
    installSetters(openSeparate);

    await runCommand('edit.separateStems');

    expect(openSeparate).not.toHaveBeenCalled();
  });
});

describe('edit.transcribe (Task F4b)', () => {
  // F11-7: this command left the Edit menu for Pipeline. Only its PLACEMENT
  // moved — the id, the predicate, the label and the run body are untouched,
  // which is what the enablement/dispatch tests below still measure.
  function findEditCmd(id: string): MenuCommand {
    const pipeline = getMenuSections().find((s) => s.title === 'Pipeline')!;
    return pipeline.items.find(
      (item): item is MenuCommand => item !== 'separator' && item.id === id
    )!;
  }

  function installSetters(openTranscribe: jest.Mock, focusTranscript: jest.Mock = jest.fn()) {
    registerDialogSetters({
      openExportDialog: () => {},
      openNewFileDialog: () => {},
      openEffectDialog: () => {},
      openConvertDialog: () => {},
      openRecordDialog: () => {},
      openTempoDialog: () => {},
      openRemixDialog: () => {},
      openSeparateDialog: () => {},
      openTranscribeDialog: openTranscribe,
      openVoiceChangerDialog: () => {},
      openAlignTimingDialog: () => {},
      openVocalChainDialog: () => {},
      openCoverChainDialog: () => {},
      openAlignLyricsDialog: () => {},
      focusRemixPanel: () => {},
      focusTranscriptPanel: focusTranscript,
      focusSpatialPanel: () => {},
    });
  }

  /** A real transcript for `docId`, through the real service and the shared
   * component-test backend — never a hand-written stand-in, so what the command
   * reads below is the shape the service actually stores. */
  async function seedRealTranscript(docId: string): Promise<void> {
    const backend = installTranscribeBackend();
    await seedTranscript(backend, docId, [
      { index: 0, startSample: 0, endSample: 8000, text: 'hello', vector: voiceVector(8, 0, 1) },
    ]);
  }

  afterEach(() => {
    _resetTranscriptsForTest();
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  });

  // F11-7 rewrote this. F4b and F3 shared one Edit group of long-inference
  // jobs; the Pipeline grouping splits that group by subject — Transcribe opens
  // Analysis, Voice Changer opens Voice — so the three-in-a-row this used to
  // pin no longer exists. Both labels, both missing shortcuts and both group
  // positions are still pinned, from the new places.
  it('opens the Pipeline Analysis group, with Voice Changer opening the Voice group', () => {
    const pipeline = getMenuSections().find((s) => s.title === 'Pipeline')!;
    const items = pipeline.items;

    const transcribeIndex = items.findIndex(
      (item) => item !== 'separator' && item.id === 'edit.transcribe'
    );
    expect(items[transcribeIndex - 1]).toBe('separator');
    const transcribe = items[transcribeIndex];
    expect(transcribe !== 'separator' && transcribe.label).toBe('Transcribe');
    // No shortcut: a multi-minute job must never be one keystroke away.
    expect(transcribe !== 'separator' && transcribe.shortcut).toBeUndefined();

    const voiceIndex = items.findIndex(
      (item) => item !== 'separator' && item.id === 'edit.voiceChanger'
    );
    expect(items[voiceIndex - 1]).toBe('separator');
    const voice = items[voiceIndex];
    expect(voice !== 'separator' && voice.label).toBe('Voice Changer');
    expect(voice !== 'separator' && voice.shortcut).toBeUndefined();

    const editIds = commandIds(getMenuSections().find((s) => s.title === 'Edit')!.items);
    expect(editIds).not.toContain('edit.transcribe');
    expect(editIds).not.toContain('edit.voiceChanger');
  });

  it('is disabled with no document, disabled for a zero-length document, enabled otherwise', () => {
    expect(findEditCmd('edit.transcribe').enabled(useAppStore.getState())).toBe(false);

    const empty = createDocument({ name: 'empty', sampleRate: 44100, channels: [new Float32Array(0)] });
    useAppStore.getState().addDocument(empty);
    expect(docLength(empty)).toBe(0);
    expect(findEditCmd('edit.transcribe').enabled(useAppStore.getState())).toBe(false);

    openDoc();
    expect(findEditCmd('edit.transcribe').enabled(useAppStore.getState())).toBe(true);
  });

  it('runCommand("edit.transcribe") opens the dialog through the bus when there is no transcript yet', async () => {
    openDoc();
    const openTranscribe = jest.fn();
    const focusTranscript = jest.fn();
    installSetters(openTranscribe, focusTranscript);

    await runCommand('edit.transcribe');

    expect(openTranscribe).toHaveBeenCalledTimes(1);
    expect(focusTranscript).not.toHaveBeenCalled();
  });

  it('runCommand("edit.transcribe") with no document never reaches the bus', async () => {
    const openTranscribe = jest.fn();
    installSetters(openTranscribe);

    await runCommand('edit.transcribe');

    expect(openTranscribe).not.toHaveBeenCalled();
  });

  // F11-8. The Transcript panel was a module-strip entry until the user ruled
  // it a single tool rather than a module, so Transcribe is now the door to
  // BOTH halves of the feature: the run that makes a transcript, and the
  // surface that shows one. With a transcript already made, running the tool
  // shows THAT rather than re-running minutes of inference to produce the
  // thing already sitting in the store — and the panel's own 'Transcribe
  // again…' button is the way back to the dialog, which is what keeps the
  // branch from being a trap.
  it('runCommand("edit.transcribe") shows the transcript instead of the dialog once one exists', async () => {
    const doc = createDocument({
      name: 'talk.wav',
      sampleRate: 44100,
      channels: [new Float32Array(44100)],
    });
    useAppStore.getState().addDocument(doc);
    await seedRealTranscript(doc.id);
    expect(getTranscript(doc.id)).not.toBeNull();

    const openTranscribe = jest.fn();
    const focusTranscript = jest.fn();
    installSetters(openTranscribe, focusTranscript);

    await runCommand('edit.transcribe');

    expect(focusTranscript).toHaveBeenCalledTimes(1);
    expect(openTranscribe).not.toHaveBeenCalled();
  });

  // The transcript belongs to ONE document. Switching to a document that has
  // never been transcribed must put the dialog back in front of the user, or
  // the second file in a session could never be transcribed at all.
  it('goes back to the dialog for a different document that has no transcript', async () => {
    const transcribed = createDocument({
      name: 'talk.wav',
      sampleRate: 44100,
      channels: [new Float32Array(44100)],
    });
    useAppStore.getState().addDocument(transcribed);
    await seedRealTranscript(transcribed.id);

    const fresh = openDoc(); // addDocument activates it
    expect(useAppStore.getState().activeDocumentId).toBe(fresh.id);

    const openTranscribe = jest.fn();
    const focusTranscript = jest.fn();
    installSetters(openTranscribe, focusTranscript);

    await runCommand('edit.transcribe');

    expect(openTranscribe).toHaveBeenCalledTimes(1);
    expect(focusTranscript).not.toHaveBeenCalled();
  });
});

describe('multitrack.mixdown — Mix Down output provenance (Task S4)', () => {
  afterEach(() => {
    useSessionStore.getState().newSession(44100);
  });

  it('produces a never-saved document: computed audio that has never been on disk', async () => {
    installShowMessageBox();
    const source = openDoc(); // 1000 mono samples
    useAppStore.getState().setView('multitrack');
    useSessionStore.getState().addTrack();
    const trackId = useSessionStore.getState().session.tracks[0].id;
    useSessionStore.getState().addClip(trackId, {
      id: 'clip-mixdown-1',
      documentId: source.id,
      startSample: 0,
      offsetSample: 0,
      lengthSample: docLength(source),
      gainDb: 0,
    });

    await runCommand('multitrack.mixdown');

    const mix = useAppStore.getState().documents.find((d) => d.name.startsWith('Mixdown'));
    expect(mix).toBeDefined();
    // Created with no undo entry, so `dirty` is false — the exact state that
    // used to let it close silently. `neverSaved` is what now guards it.
    expect(mix!.dirty).toBe(false);
    expect(mix!.neverSaved).toBe(true);
  });
});
