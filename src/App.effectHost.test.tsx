import { act, fireEvent, render, screen, within } from '@testing-library/react';
import App from './App';
import DialogShell from './components/Dialogs/DialogShell';
import { DEFAULT_PANEL, MODULE_COLUMN_WIDTH } from './components/Layout/ModuleStrip';
import { createDocument } from './audio/AudioDocument';
import { playbackEngine } from './audio/PlaybackEngine';
import { installTranscribeBackend, seedTranscript, voiceVector } from './__mocks__/transcribeBackend';
import { _resetTranscriptsForTest } from './services/transcribeService';
import { defaultParamsFor, getEffect, getVisibleEffects } from './effects/EffectRegistry';
import { _resetHostedToolRunning, focusTranscriptPanel, hasOpenDialog } from './services/dialogBus';
import { runEffectOnSelection } from './services/effectRunner';
import { runCommand } from './services/menuActions';
import { getHistory } from './services/undoHistory';
import { makeInitialState, useAppStore } from './stores/appStore';

/**
 * Item 6 (2026-08-18) / M6 / N16 — an effect opens on one click as a card in
 * the module column, between the module strip and the module card, instead of
 * as a modal over the stage.
 *
 * The harness is `App.pipelineHost.test`'s: `TempoDialog` is stubbed so a
 * hosted PIPELINE pass can be started and finished from outside (its
 * `dismissable` is internal state no test may reach otherwise), rendering the
 * real `DialogShell` — the seam both hosts share. The effect runner is mocked
 * so Apply's promise is the test's to resolve: a lock that exists "during
 * Apply only" can only be observed with Apply held open.
 */
jest.mock('./components/Dialogs/TempoDialog', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  const Shell = jest.requireActual<{ default: typeof DialogShell }>(
    './components/Dialogs/DialogShell'
  ).default;
  return {
    __esModule: true,
    default: function StubTempoDialog({ onClose }: { onClose: () => void }) {
      const [busy, setBusy] = React.useState(false);
      return React.createElement(Shell, {
        title: 'Match Tempo',
        dismissable: !busy,
        onClose,
        children: React.createElement(
          'button',
          { type: 'button', onClick: () => setBusy((b) => !b) },
          busy ? 'finish pass' : 'start pass'
        ),
      });
    },
  };
});

jest.mock('./services/effectRunner', () => {
  const actual = jest.requireActual('./services/effectRunner');
  return { ...actual, runEffectOnSelection: jest.fn(async () => 'committed') };
});
const mockRun = runEffectOnSelection as jest.MockedFunction<typeof runEffectOnSelection>;
const realRun = jest.requireActual<typeof import('./services/effectRunner')>(
  './services/effectRunner'
).runEffectOnSelection;

/** The strip's tooltip while an effect Apply runs — written out here rather
 * than imported, so the sentence the user reads is pinned, not echoed. */
const MODULE_SWITCH_LOCKED_EFFECT =
  'An effect is being applied — wait for it to finish. The waveform and transport stay usable.';

interface MessageBoxOptions {
  type?: string;
  title?: string;
  message: string;
}
const showMessageBox = jest.fn(async (_opts: MessageBoxOptions) => ({ response: 0 }));

beforeEach(() => {
  useAppStore.setState(makeInitialState());
  _resetHostedToolRunning();
  showMessageBox.mockClear();
  mockRun.mockReset();
  mockRun.mockImplementation(async () => 'committed');
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    showMessageBox,
    onWindowMaximized: () => () => {},
    onCloseRequested: () => () => {},
    respondCloseRequest: () => {},
  };
});

function addDoc() {
  const doc = createDocument({
    name: 'take.wav',
    sampleRate: 44100,
    channels: [new Float32Array(44100)],
  });
  act(() => {
    useAppStore.getState().addDocument(doc);
  });
  return doc;
}

function strip(): HTMLElement {
  return screen.getByTestId('sidebar-tabs');
}

function stripButton(label: string): HTMLButtonElement {
  return within(strip()).getByRole('button', { name: label }) as HTMLButtonElement;
}

async function openTool(id: string) {
  await act(async () => {
    await runCommand(id);
  });
}

function host(): HTMLElement {
  return screen.getByTestId('effect-host');
}

function inset(): string {
  return screen.getByTestId('editor-stage').style.getPropertyValue('--stage-inset-right');
}

function effectRowButton(index: number): HTMLButtonElement {
  return within(screen.getAllByTestId('effects-item')[index]).getByRole('button') as HTMLButtonElement;
}

describe('an effect opens in the module column, not over the stage', () => {
  it('opens in the column, not over the stage', async () => {
    addDoc();
    render(<App />);
    await openTool('effect.amplify');

    expect(host()).toHaveAttribute('data-effect-id', 'amplify');
    expect(screen.queryByTestId('dialog-overlay')).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(within(host()).getByTestId('hosted-tool')).toHaveAttribute(
      'aria-label',
      getEffect('amplify')!.name
    );
    expect(within(host()).getByTestId('effect-dialog')).toBeInTheDocument();
    // Idle, the card suspends nothing: Space, Ctrl+Z and the arrows stay live.
    expect(hasOpenDialog()).toBe(false);
  });

  it('sits between the strip and the module card, and forces Effects (M6/N16)', async () => {
    addDoc();
    render(<App />);
    expect(screen.getByTestId('sidebar-panel')).toHaveAttribute('data-active-tab', DEFAULT_PANEL);

    await openTool('effect.amplify');

    const panel = screen.getByTestId('sidebar-panel');
    expect(panel).toHaveAttribute('data-active-tab', 'effects');
    expect(screen.getByTestId('effects-list')).toBeInTheDocument();
    // Inside the column, ABOVE the module card: same parent, earlier sibling.
    expect(host().parentElement).toBe(panel.parentElement);
    expect(host().compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // …and below the strip. The strip is an absolutely positioned pill that
    // mounts AFTER the column in DOM order, so the vertical order is read off
    // the two anchors rather than the document order: the column (which holds
    // the host) starts below the strip's top.
    const column = host().parentElement as HTMLElement;
    expect(parseInt(column.style.top, 10)).toBeGreaterThan(parseInt(strip().style.top, 10));
    const tempo = screen.queryByTestId('tempo-card');
    if (tempo) expect(host().parentElement).toBe(tempo.parentElement);
  });

  it('W1 and the stage inset: the strip, the card and the module card share one width', async () => {
    addDoc();
    render(<App />);
    expect(strip().style.width).toBe(`${MODULE_COLUMN_WIDTH}px`);

    await openTool('effect.amplify');
    expect(strip().style.width).toBe(`${MODULE_COLUMN_WIDTH}px`);
    expect(host().style.width).toBe(`${MODULE_COLUMN_WIDTH}px`);
    expect(host().style.marginLeft).toBe('');
    // The module card declares no width of its own — the column's 348 is its.
    expect(screen.getByTestId('sidebar-panel').style.width).toBe('');
    // 14 + 348 + 14: the same clearance a module card asks for.
    expect(inset()).toBe('376px');

    // M6's new switch case: the module card closes, the effect card stays, and
    // the stage keeps its clearance for the card still in the column.
    fireEvent.click(screen.getByTestId('sidebar-panel-close'));
    expect(screen.queryByTestId('sidebar-panel')).toBeNull();
    expect(host()).toBeInTheDocument();
    expect(inset()).toBe('376px');

    fireEvent.click(within(host()).getByTestId('hosted-tool-close'));
    expect(screen.queryByTestId('effect-host')).toBeNull();
    expect(inset()).toBe('14px');
    expect(strip().style.width).toBe(`${MODULE_COLUMN_WIDTH}px`);
  });

  // Open question 1's default, pinned: the effect card is independent of the
  // module card beneath it. Only `openTool`, ✕ / Cancel / Apply and the orphan
  // rule close it — a strip click swaps the card below and leaves the effect.
  it('survives a strip click: the module card changes, the effect card stays', async () => {
    addDoc();
    render(<App />);
    await openTool('effect.amplify');
    expect(screen.getByTestId('sidebar-panel')).toHaveAttribute('data-active-tab', 'effects');

    fireEvent.click(stripButton('Files'));
    expect(screen.getByTestId('sidebar-panel')).toHaveAttribute('data-active-tab', 'files');
    expect(host()).toHaveAttribute('data-effect-id', 'amplify');
  });
});

describe('every door reaches the same card', () => {
  it('the Effects card’s effect row, one click', async () => {
    addDoc();
    render(<App />);
    fireEvent.click(stripButton('Effects'));
    const first = getVisibleEffects()[0];
    await act(async () => {
      fireEvent.click(effectRowButton(0));
    });
    expect(host()).toHaveAttribute('data-effect-id', first.id);
  });

  it('a second row swaps the card — one effect at a time', async () => {
    addDoc();
    render(<App />);
    fireEvent.click(stripButton('Effects'));
    const [first, second] = getVisibleEffects();
    await act(async () => {
      fireEvent.click(effectRowButton(0));
    });
    expect(host()).toHaveAttribute('data-effect-id', first.id);

    await act(async () => {
      fireEvent.click(effectRowButton(1));
    });
    expect(screen.getAllByTestId('effect-host')).toHaveLength(1);
    expect(host()).toHaveAttribute('data-effect-id', second.id);
  });

  // The menu's door is `runCommand(id)` — the same call MenuBar makes.
  it('the Effects menu’s command', async () => {
    addDoc();
    render(<App />);
    await openTool('effect.reverb');
    expect(host()).toHaveAttribute('data-effect-id', 'reverb');
  });
});

describe('close paths', () => {
  it('the header ✕ unmounts the card and leaves the Effects module card in place', async () => {
    addDoc();
    render(<App />);
    await openTool('effect.amplify');

    fireEvent.click(within(host()).getByTestId('hosted-tool-close'));
    expect(screen.queryByTestId('effect-host')).toBeNull();
    expect(screen.getByTestId('sidebar-panel')).toHaveAttribute('data-active-tab', 'effects');
  });

  it('the body’s Cancel unmounts the card and leaves the Effects module card in place', async () => {
    addDoc();
    render(<App />);
    await openTool('effect.amplify');

    fireEvent.click(within(host()).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByTestId('effect-host')).toBeNull();
    expect(screen.getByTestId('sidebar-panel')).toHaveAttribute('data-active-tab', 'effects');
  });

  it('Apply runs the effect, then unmounts the card with nothing left locked', async () => {
    addDoc();
    render(<App />);
    await openTool('effect.amplify');

    await act(async () => {
      fireEvent.click(within(host()).getByRole('button', { name: 'Apply' }));
    });
    expect(mockRun).toHaveBeenCalledTimes(1);
    expect(mockRun.mock.calls[0][0]).toBe('amplify');
    expect(screen.queryByTestId('effect-host')).toBeNull();
    expect(hasOpenDialog()).toBe(false);
  });
});

describe('interplay with the pipeline tools', () => {
  it('an effect replaces an idle hosted tool: the 640 host and the 348 card never coexist', async () => {
    addDoc();
    render(<App />);
    await openTool('tempo.match');
    expect(screen.getByTestId('tool-host')).toBeInTheDocument();

    await openTool('effect.amplify');
    expect(screen.queryByTestId('tool-host')).toBeNull();
    expect(host()).toHaveAttribute('data-effect-id', 'amplify');
    expect(strip().style.width).toBe(`${MODULE_COLUMN_WIDTH}px`);
    expect(screen.getByTestId('sidebar-panel')).toHaveAttribute('data-active-tab', 'effects');
  });

  it('a pipeline tool replaces an open effect card', async () => {
    addDoc();
    render(<App />);
    await openTool('effect.amplify');

    await openTool('lyrics.align');
    expect(screen.queryByTestId('effect-host')).toBeNull();
    expect(screen.getByTestId('tool-host')).toHaveAttribute('data-tool-id', 'lyrics.align');
  });

  it('refuses to open an effect while a pipeline pass runs, naming the pass', async () => {
    addDoc();
    render(<App />);
    await openTool('tempo.match');
    fireEvent.click(screen.getByRole('button', { name: 'start pass' }));

    await openTool('effect.amplify');
    expect(showMessageBox).toHaveBeenCalledTimes(1);
    expect(showMessageBox.mock.calls[0][0].message).toContain('Match Tempo');
    expect(screen.getByTestId('tool-host')).toHaveAttribute('data-tool-id', 'tempo.match');
    expect(screen.queryByTestId('effect-host')).toBeNull();
  });
});

describe('the module lock, during Apply only (N16)', () => {
  it('locks the strip, the ✕ and Cancel while Apply runs, and refuses another effect', async () => {
    addDoc();
    render(<App />);
    await openTool('effect.amplify');
    // Idle: nothing is held.
    expect(hasOpenDialog()).toBe(false);
    for (const button of within(strip()).getAllByRole('button')) expect(button).not.toBeDisabled();

    let finish!: (v: 'committed') => void;
    mockRun.mockReturnValueOnce(new Promise<'committed'>((resolve) => (finish = resolve)));
    await act(async () => {
      fireEvent.click(within(host()).getByRole('button', { name: 'Apply' }));
    });

    expect(hasOpenDialog()).toBe(true);
    for (const button of within(strip()).getAllByRole('button')) {
      expect(button).toBeDisabled();
      expect(button.title).toBe(MODULE_SWITCH_LOCKED_EFFECT);
    }
    expect(within(host()).getByTestId('hosted-tool-close')).toBeDisabled();
    expect(within(host()).getByRole('button', { name: 'Cancel' })).toBeDisabled();

    await openTool('effect.reverb');
    expect(showMessageBox).toHaveBeenCalledTimes(1);
    expect(showMessageBox.mock.calls[0][0].message).toContain(getEffect('amplify')!.name);
    expect(host()).toHaveAttribute('data-effect-id', 'amplify');

    await act(async () => {
      finish('committed');
    });
    expect(screen.queryByTestId('effect-host')).toBeNull();
    expect(hasOpenDialog()).toBe(false);
    for (const button of within(strip()).getAllByRole('button')) expect(button).not.toBeDisabled();
  });
});

describe('the orphan rule (N16)', () => {
  it('closes the card when the last document closes', async () => {
    const doc = addDoc();
    render(<App />);
    await openTool('effect.amplify');
    expect(host()).toBeInTheDocument();

    act(() => {
      useAppStore.getState().closeDocument(doc.id);
    });
    expect(screen.queryByTestId('effect-host')).toBeNull();
  });
});

/**
 * Fix round 1 (finding 1): the user's scenario — edit Amplify's gain, then
 * click Reverb in the Effects card beneath. The card that now names Reverb
 * must show Reverb's own defaults and Apply must send exactly those, never
 * the `{ gainDb: 7 }` the previous card held (which would have run Reverb on
 * fallbacks the user never saw). The row swap at 'a second row swaps the
 * card' above only pins `data-effect-id`; this pins the state behind it.
 */
describe('swapping the hosted effect starts the new one from its own defaults', () => {
  function paramInput(id: string): HTMLInputElement {
    const el = document.getElementById(`effect-param-${id}`);
    if (!(el instanceof HTMLInputElement)) throw new Error(`no parameter input for ${id}`);
    return el;
  }

  it('Reverb, opened over an edited Amplify card, shows and applies its own defaults', async () => {
    addDoc();
    render(<App />);
    await openTool('effect.amplify');
    fireEvent.change(paramInput('gainDb'), { target: { value: '7' } });
    expect(paramInput('gainDb').value).toBe('7');

    const reverb = getEffect('reverb')!;
    await act(async () => {
      fireEvent.click(
        within(screen.getByTestId('effects-list')).getByRole('button', { name: reverb.name })
      );
    });
    expect(screen.getAllByTestId('effect-host')).toHaveLength(1);
    expect(host()).toHaveAttribute('data-effect-id', 'reverb');
    expect(document.getElementById('effect-param-gainDb')).toBeNull();
    for (const p of reverb.params) {
      if (p.type === 'boolean') expect(paramInput(p.id).checked).toBe(Boolean(p.default));
      else expect(paramInput(p.id).value).toBe(String(p.default));
    }

    await act(async () => {
      fireEvent.click(within(host()).getByRole('button', { name: 'Apply' }));
    });
    expect(mockRun).toHaveBeenCalledTimes(1);
    expect(mockRun.mock.calls[0][0]).toBe('reverb');
    expect(mockRun.mock.calls[0][1]).toEqual(defaultParamsFor('reverb'));
  });
});

/**
 * Fix round 2 (round-1 finding 2): the lock during Apply holds the strip, the
 * ✕, Cancel and the global keys — never the mouse ("Mouse interaction is
 * never suspended"). The modal's backdrop used to make every click below
 * impossible; as a card, the edit pill, the Files panel and the File menu
 * stay live while the worker runs, and the runner commits its result to the
 * region it resolved BEFORE the worker started. The dialog now hands the
 * runner `shouldCancel` (T6-3's seam, asked once between the audio arriving
 * and `applyEdit`): a document that moved — edited, swapped, closed — is
 * never written, the card stays and says so.
 *
 * These run the REAL runner over the synchronous worker mock, which answers
 * behind one microtask: Apply, then the mouse door, then the flush — the
 * exact window the hazard lands in.
 */
describe('the mouse stays live during Apply: a document that moved is never written (fix round 2)', () => {
  const STALE_HINT =
    'The document changed while the effect was running, so nothing was applied. Apply again to run it on the document as it is now.';

  function docById(id: string) {
    return useAppStore.getState().documents.find((d) => d.id === id) ?? null;
  }

  /** A document File > Close can close without a Save prompt (clean, on disk). */
  function addSavedDoc(name: string) {
    const doc = createDocument({
      name,
      sampleRate: 44100,
      channels: [new Float32Array(44100)],
      filePath: `C:/takes/${name}`,
      neverSaved: false,
    });
    act(() => {
      useAppStore.getState().addDocument(doc);
    });
    return doc;
  }

  /** Selects the first half of the active document and clicks Apply on the
   * open Amplify card with the real runner: the worker is now pending behind
   * a microtask and the lock is up. */
  function applyOnFirstHalf() {
    act(() => {
      useAppStore.getState().setSelection({ start: 0, end: 22050 });
    });
    mockRun.mockImplementation(realRun);
    fireEvent.click(within(host()).getByRole('button', { name: 'Apply' }));
    expect(hasOpenDialog()).toBe(true);
  }

  /** Lets the worker answer and the runner settle. */
  function flush() {
    return act(async () => {});
  }

  it('a Delete on the edit pill zero-fills the document; the returning worker writes nothing over it', async () => {
    const doc = addDoc();
    render(<App />);
    await openTool('effect.amplify');
    applyOnFirstHalf();

    // The lock holds the strip, not the pill: this is the door.
    const del = within(screen.getByTestId('edit-pill')).getByRole('button', { name: 'Delete' });
    expect(del).toBeEnabled();
    fireEvent.click(del);
    // Since lot C, Delete keeps the length (the span is zero-filled, N6): the
    // document's `channels` identity still changes, which is the signal the
    // Apply-time guard keys on — the length no longer does.
    const edited = docById(doc.id)!.channels;
    expect(edited[0]).toHaveLength(44100);
    expect(Array.from(edited[0].subarray(0, 22050)).every((v) => v === 0)).toBe(true);
    expect(getHistory(doc.id).done).toEqual(['Delete']);

    await flush();
    // Identity, not equality: a commit allocates fresh arrays.
    expect(docById(doc.id)!.channels).toBe(edited);
    expect(getHistory(doc.id).done).toEqual(['Delete']);
    expect(host()).toHaveAttribute('data-effect-id', 'amplify');
    expect(within(host()).getByTestId('effect-stale-hint')).toHaveTextContent(STALE_HINT);
    expect(hasOpenDialog()).toBe(false);
    for (const button of within(strip()).getAllByRole('button')) expect(button).not.toBeDisabled();
    expect(showMessageBox).not.toHaveBeenCalled();
  });

  it('a row click in the Files panel switches documents; the effect lands in neither and the caret stays put', async () => {
    const a = addSavedDoc('take.wav');
    const b = addSavedDoc('other.wav');
    act(() => {
      useAppStore.getState().setActiveDocument(a.id);
    });
    render(<App />);
    await openTool('effect.amplify');
    // Idle, the strip is free and the card survives the switch (B5); the
    // Files panel is now the module card beneath the effect.
    fireEvent.click(stripButton('Files'));
    applyOnFirstHalf();
    const aChannels = docById(a.id)!.channels;
    const bChannels = docById(b.id)!.channels;

    fireEvent.click(within(screen.getByTestId('files-list')).getByText('other.wav').closest('button')!);
    expect(useAppStore.getState().activeDocumentId).toBe(b.id);

    await flush();
    expect(docById(a.id)!.channels).toBe(aChannels);
    expect(docById(b.id)!.channels).toBe(bChannels);
    expect(getHistory(a.id).done).toEqual([]);
    expect(getHistory(b.id).done).toEqual([]);
    // `applyEdit` writes the selection and the cursor GLOBALLY: a commit here
    // would have put [0, 22050] back on the document the user moved on to.
    expect(useAppStore.getState().selection).toBeNull();
    expect(host()).toBeInTheDocument();
    expect(within(host()).getByTestId('effect-stale-hint')).toHaveTextContent(STALE_HINT);
    expect(hasOpenDialog()).toBe(false);
    expect(showMessageBox).not.toHaveBeenCalled();
  });

  it('File > Close on the document raises no "document not found" failure; the card stays for the document now active', async () => {
    const a = addSavedDoc('take.wav');
    const b = addSavedDoc('other.wav');
    act(() => {
      useAppStore.getState().setActiveDocument(a.id);
    });
    render(<App />);
    await openTool('effect.amplify');
    applyOnFirstHalf();
    const bChannels = docById(b.id)!.channels;

    // The menu's own command; a clean document closes without a prompt.
    let closing!: Promise<void>;
    act(() => {
      closing = runCommand('file.close');
    });
    expect(docById(a.id)).toBeNull();
    expect(useAppStore.getState().activeDocumentId).toBe(b.id);

    await flush();
    await act(async () => {
      await closing;
    });
    expect(showMessageBox).not.toHaveBeenCalled();
    expect(docById(b.id)!.channels).toBe(bChannels);
    expect(getHistory(b.id).done).toEqual([]);
    expect(host()).toBeInTheDocument();
    expect(within(host()).getByTestId('effect-stale-hint')).toHaveTextContent(STALE_HINT);
    expect(hasOpenDialog()).toBe(false);
  });

  it('closing the LAST document mid-Apply: the orphan rule drops the card and the returning worker raises no failure dialog', async () => {
    addSavedDoc('take.wav');
    render(<App />);
    await openTool('effect.amplify');
    applyOnFirstHalf();

    let closing!: Promise<void>;
    act(() => {
      closing = runCommand('file.close');
    });
    expect(useAppStore.getState().documents).toHaveLength(0);
    expect(screen.queryByTestId('effect-host')).toBeNull();

    await flush();
    await act(async () => {
      await closing;
    });
    expect(showMessageBox).not.toHaveBeenCalled();
    expect(hasOpenDialog()).toBe(false);
  });
});

/**
 * Final round (finding 1): `showPanel`'s hand-off arm force-clears the module
 * lock. It was written for a hosted TOOL handing over its own finished result
 * (`RemixDialog` / `TranscribeDialog` calling the bus from inside the handler
 * that just completed), and that caller always owned the lock it cleared. The
 * effect card publishes the SAME lock through the same seam while its Apply
 * runs, and it is never that caller — a hosted effect and a hosted tool never
 * coexist (W1). What reaches the arm mid-Apply is a mouse-driven command
 * instead, whose reveal path calls the bus; clearing the lock for it un-greys
 * the strip, resumes every global shortcut and lets `openTool` / `openEffect`
 * unmount the card while its worker still runs.
 */
describe('a hand-off command mid-Apply never releases the effect card (final round)', () => {
  /** A real transcript for `docId`, through the real service — that is what
   * makes `Pipeline > Transcribe` take its REVEAL arm (`menuActions.ts`,
   * `getTranscript(id) !== null` -> `focusTranscriptPanel()`) instead of
   * opening the tool. The backend replaces `window.electronAPI` wholesale, so
   * the harness's own surface is put back before the app renders. */
  async function seedTranscriptFor(docId: string) {
    const harnessApi = (window as unknown as { electronAPI: unknown }).electronAPI;
    const backend = installTranscribeBackend();
    await seedTranscript(backend, docId, [
      { index: 0, startSample: 0, endSample: 8000, text: 'hello', vector: voiceVector(8, 0, 1) },
    ]);
    (window as unknown as { electronAPI: unknown }).electronAPI = harnessApi;
  }

  afterEach(() => {
    _resetTranscriptsForTest();
  });

  it('Pipeline > Transcribe, revealing an existing transcript, is refused while an effect applies', async () => {
    const doc = addDoc();
    await seedTranscriptFor(doc.id);
    render(<App />);
    await openTool('effect.amplify');

    let finish!: (v: 'committed') => void;
    mockRun.mockReturnValueOnce(new Promise<'committed'>((resolve) => (finish = resolve)));
    await act(async () => {
      fireEvent.click(within(host()).getByRole('button', { name: 'Apply' }));
    });
    expect(hasOpenDialog()).toBe(true);

    // The command's own predicate is satisfied (a document with audio), so
    // `runCommand` runs it and it takes the reveal arm.
    await openTool('edit.transcribe');

    expect(showMessageBox).toHaveBeenCalledTimes(1);
    expect(showMessageBox.mock.calls[0][0].message).toContain(getEffect('amplify')!.name);
    // Nothing was released: the keys, the strip, the ✕ and the card itself.
    expect(hasOpenDialog()).toBe(true);
    for (const button of within(strip()).getAllByRole('button')) {
      expect(button).toBeDisabled();
      expect(button.title).toBe(MODULE_SWITCH_LOCKED_EFFECT);
    }
    expect(host()).toHaveAttribute('data-effect-id', 'amplify');
    expect(within(host()).getByTestId('hosted-tool-close')).toBeDisabled();
    // And the doors that were re-opened by the release stay shut.
    await openTool('effect.reverb');
    expect(showMessageBox).toHaveBeenCalledTimes(2);
    expect(host()).toHaveAttribute('data-effect-id', 'amplify');
    await openTool('tempo.match');
    expect(showMessageBox).toHaveBeenCalledTimes(3);
    expect(screen.queryByTestId('tool-host')).toBeNull();
    expect(host()).toHaveAttribute('data-effect-id', 'amplify');

    await act(async () => {
      finish('committed');
    });
    expect(screen.queryByTestId('effect-host')).toBeNull();
    expect(hasOpenDialog()).toBe(false);
  });

  it('the hand-off itself is untouched: a hosted TOOL still hands over while it holds the lock', async () => {
    addDoc();
    render(<App />);
    await openTool('tempo.match');
    fireEvent.click(screen.getByRole('button', { name: 'start pass' }));
    expect(hasOpenDialog()).toBe(true);

    // What TranscribeDialog does from inside its own completion handler.
    await act(async () => {
      focusTranscriptPanel();
    });

    expect(showMessageBox).not.toHaveBeenCalled();
    expect(screen.queryByTestId('tool-host')).toBeNull();
    expect(hasOpenDialog()).toBe(false);
    for (const button of within(strip()).getAllByRole('button')) expect(button).not.toBeDisabled();
  });
});

/**
 * Final round (finding 2): the card is not modal, so a Preview can be taken
 * off the shared engine by a plain mouse click. The transport's own load
 * effect answers a document switch by loading the new document, which stops
 * and replaces the preview — after which the card must stop offering 'Stop
 * Preview', or the button the user presses stops the transport they just
 * started instead.
 */
describe('a Preview the mouse took away (final round)', () => {
  function addSaved(name: string) {
    const doc = createDocument({
      name,
      sampleRate: 44100,
      channels: [new Float32Array(44100)],
      filePath: `C:/takes/${name}`,
      neverSaved: false,
    });
    act(() => {
      useAppStore.getState().addDocument(doc);
    });
    return doc;
  }

  function previewButton(): HTMLButtonElement {
    const stop = within(host()).queryByRole('button', { name: 'Stop Preview' });
    return (stop ?? within(host()).getByRole('button', { name: 'Preview' })) as HTMLButtonElement;
  }

  it('a Files-panel switch ends the preview; the button says Preview and starts a new one', async () => {
    const a = addSaved('take.wav');
    const b = addSaved('other.wav');
    act(() => {
      useAppStore.getState().setActiveDocument(a.id);
    });
    render(<App />);
    await openTool('effect.amplify');
    fireEvent.click(stripButton('Files'));

    act(() => {
      fireEvent.click(within(host()).getByRole('button', { name: 'Preview' }));
    });
    expect(previewButton().textContent).toBe('Stop Preview');
    // The throwaway preview document, not the take.
    expect(playbackEngine.loadedDocumentId).not.toBe(a.id);

    act(() => {
      fireEvent.click(
        within(screen.getByTestId('files-list')).getByText('other.wav').closest('button')!
      );
    });
    expect(useAppStore.getState().activeDocumentId).toBe(b.id);

    // The transport owns the engine now, and the card says so.
    expect(playbackEngine.loadedDocumentId).toBe(b.id);
    expect(previewButton().textContent).toBe('Preview');

    // Pressing it starts a preview of the document the user moved to — the
    // stale label would have stopped that document's playback instead.
    act(() => {
      fireEvent.click(previewButton());
    });
    expect(previewButton().textContent).toBe('Stop Preview');
    expect(playbackEngine.loadedDocumentId).not.toBe(b.id);
  });
});

/**
 * Final round 3 (finding 1) — `Escape`, with the card open and idle.
 *
 * Until item 6 the effect dialog was modal and `Escape` closed it. Hosted, the
 * card joins no dialog stack (`hasOpenDialog()` is false), installs no Escape
 * handler of its own by design, and the global table stays live — so the key
 * the user presses to dismiss the card reaches `edit.deselect` instead. The
 * runner resolves the LIVE selection and falls back to the whole document, so
 * the next Apply writes a different edit from the one Preview auditioned.
 *
 * The keystroke is dispatched from a button INSIDE the card — where focus sits
 * after a Preview click — so it travels the real path: not an editable target,
 * bubbles to the window listener `App` installs, no dialog on the stack.
 *
 * The behaviour is the accepted design (lot-level ruling: shortcuts stay live
 * beside a card). What these pin is that it is not SILENT: the card names the
 * span it will write, and the widening is on screen before Apply is pressed.
 */
describe('Escape with an effect card open (N18)', () => {
  function scope(): HTMLElement {
    return within(host()).getByTestId('effect-scope');
  }

  /** A real keydown, bubbling from `target` up through the document to the
   * window — the path `installShortcuts`' listener sits on. */
  async function pressEscapeOn(target: Element | Document) {
    await act(async () => {
      target.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
      );
    });
  }

  /** Apply through the REAL runner, then let the worker answer. */
  async function applyForReal() {
    mockRun.mockImplementation(realRun);
    fireEvent.click(within(host()).getByRole('button', { name: 'Apply' }));
    await act(async () => {});
  }

  it('closes an idle card — what Escape did when the effect was a modal — and the selection survives', async () => {
    addDoc();
    render(<App />);
    act(() => {
      useAppStore.getState().setSelection({ start: 0, end: 22050 });
    });
    await openTool('effect.amplify');
    expect(scope()).toHaveTextContent('Selection — 0:00.000 → 0:00.500 (0.50 s)');

    // From a plain BUTTON inside the card: the target `shortcuts.ts` would
    // otherwise have matched to `edit.deselect`.
    await pressEscapeOn(within(host()).getByRole('button', { name: 'Preview' }));

    expect(screen.queryByTestId('effect-host')).toBeNull();
    // The key never reached `edit.deselect`: the span Apply would have written
    // is still the user's.
    expect(useAppStore.getState().selection).toEqual({ start: 0, end: 22050 });
    expect(hasOpenDialog()).toBe(false);
    // The ✕'s own aftermath: the module card beneath stays on Effects.
    expect(screen.getByTestId('sidebar-panel')).toHaveAttribute('data-active-tab', 'effects');
  });

  it('closes the card from the stage too: Escape pressed on the body with the card open', async () => {
    addDoc();
    render(<App />);
    act(() => {
      useAppStore.getState().setSelection({ start: 0, end: 22050 });
    });
    await openTool('effect.amplify');

    await pressEscapeOn(document.body);

    expect(screen.queryByTestId('effect-host')).toBeNull();
    expect(useAppStore.getState().selection).toEqual({ start: 0, end: 22050 });
  });

  it('restores the real document to the engine when a Preview was running — the ✕ path, not a new one', async () => {
    const doc = addDoc();
    render(<App />);
    await openTool('effect.amplify');
    const stop = jest.spyOn(playbackEngine, 'stop');
    const load = jest.spyOn(playbackEngine, 'load');
    try {
      fireEvent.click(within(host()).getByRole('button', { name: 'Preview' }));
      expect(within(host()).getByRole('button', { name: 'Stop Preview' })).toBeInTheDocument();
      stop.mockClear();
      load.mockClear();

      await pressEscapeOn(document.body);

      expect(screen.queryByTestId('effect-host')).toBeNull();
      expect(stop).toHaveBeenCalled();
      expect(load).toHaveBeenCalledWith(expect.objectContaining({ id: doc.id }));
      expect(playbackEngine.loadedDocumentId).toBe(doc.id);
    } finally {
      stop.mockRestore();
      load.mockRestore();
    }
  });

  it('does nothing while Apply runs: the card, its lock and the selection all stay', async () => {
    addDoc();
    render(<App />);
    act(() => {
      useAppStore.getState().setSelection({ start: 0, end: 22050 });
    });
    await openTool('effect.amplify');

    let finish!: (v: 'committed') => void;
    mockRun.mockReturnValueOnce(new Promise<'committed'>((resolve) => (finish = resolve)));
    await act(async () => {
      fireEvent.click(within(host()).getByRole('button', { name: 'Apply' }));
    });
    expect(hasOpenDialog()).toBe(true);

    await pressEscapeOn(within(host()).getByRole('button', { name: 'Preview' }));
    await pressEscapeOn(document.body);

    expect(host()).toHaveAttribute('data-effect-id', 'amplify');
    expect(hasOpenDialog()).toBe(true);
    expect(within(host()).getByTestId('hosted-tool-close')).toBeDisabled();
    for (const button of within(strip()).getAllByRole('button')) expect(button).toBeDisabled();
    expect(useAppStore.getState().selection).toEqual({ start: 0, end: 22050 });

    // The pass finishes as before: the card unmounts with nothing left locked.
    await act(async () => {
      finish('committed');
    });
    expect(screen.queryByTestId('effect-host')).toBeNull();
    expect(hasOpenDialog()).toBe(false);
  });

  it('with no card open, Escape keeps its meaning: Deselect', async () => {
    addDoc();
    render(<App />);
    act(() => {
      useAppStore.getState().setSelection({ start: 0, end: 22050 });
    });
    expect(screen.queryByTestId('effect-host')).toBeNull();

    await pressEscapeOn(document.body);

    expect(useAppStore.getState().selection).toBeNull();
  });

  it('after the card is closed by Escape, the next Escape deselects as before', async () => {
    addDoc();
    render(<App />);
    act(() => {
      useAppStore.getState().setSelection({ start: 0, end: 22050 });
    });
    await openTool('effect.amplify');

    await pressEscapeOn(document.body);
    expect(screen.queryByTestId('effect-host')).toBeNull();
    expect(useAppStore.getState().selection).toEqual({ start: 0, end: 22050 });

    await pressEscapeOn(document.body);
    expect(useAppStore.getState().selection).toBeNull();
  });

  it('control: with the selection left alone, Apply writes only the selection', async () => {
    const doc = addDoc();
    render(<App />);
    act(() => {
      useAppStore.getState().setSelection({ start: 0, end: 22050 });
    });
    await openTool('effect.amplify');

    await applyForReal();

    expect(useAppStore.getState().selection).toEqual({ start: 0, end: 22050 });
    expect(getHistory(doc.id).done).toEqual([`Effect: ${getEffect('amplify')!.name}`]);
  });
});
