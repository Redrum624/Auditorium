import { act, fireEvent, render, screen, within } from '@testing-library/react';
import App from './App';
import DialogShell from './components/Dialogs/DialogShell';
import { TOOL_HOST_WIDTH, hostedToolIds } from './components/Dialogs/PipelineToolHost';
import { MODULE_COLUMN_WIDTH } from './components/Layout/ModuleStrip';
import { createDocument } from './audio/AudioDocument';
import { _resetHostedToolRunning, hasOpenDialog } from './services/dialogBus';
import { runCommand } from './services/menuActions';
import { makeInitialState, useAppStore } from './stores/appStore';

/**
 * U2-3 — pipelines open IN the module column, from every door, with the stage
 * left alive.
 *
 * `TempoDialog` is stubbed here, and only it: the mid-run half of this file
 * needs a hosted tool whose `dismissable` a test can drive, and `dismissable`
 * is a dialog's INTERNAL busy flag that no test may reach from outside. The
 * stub renders the real `DialogShell` — the seam under test — so what is faked
 * is the pass, not the mounting. The other eight are the real components.
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
        children: [
          React.createElement(
            'button',
            { key: 'toggle', type: 'button', onClick: () => setBusy((b) => !b) },
            busy ? 'finish pass' : 'start pass'
          ),
          // The hand-off shape RemixDialog and TranscribeDialog really have:
          // the pass ends and the panel is opened in the SAME synchronous
          // block, so React has not re-rendered and `busy` is still true at
          // the moment the panel is asked for. Reproduced exactly, because it
          // is the case a naive "refuse while running" guard breaks.
          React.createElement(
            'button',
            {
              key: 'handover',
              type: 'button',
              onClick: () => {
                setBusy(false);
                jest
                  .requireActual<typeof import('./services/dialogBus')>('./services/dialogBus')
                  .focusTranscriptPanel();
                onClose();
              },
            },
            'finish and hand over'
          ),
        ],
      });
    },
  };
});

interface MessageBoxOptions {
  type?: string;
  title?: string;
  message: string;
}
const showMessageBox = jest.fn(async (_opts: MessageBoxOptions) => ({ response: 0 }));

beforeEach(() => {
  useAppStore.setState(makeInitialState());
  // Module state outlives a render: a test that ends mid-pass would otherwise
  // hand the next one a `hasOpenDialog()` that is true with nothing open.
  _resetHostedToolRunning();
  showMessageBox.mockClear();
  // `showMessageBox` is the channel the mid-run refusal speaks through (the
  // same one every other refusal in the app uses). The two subscriptions are
  // what App and TitleBar reach for on mount: a preload object that exists but
  // lacks them throws, where no preload at all short-circuits.
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

describe('a pipeline tool opens in the module column, not over the stage', () => {
  /**
   * Derived over the host's own registry rather than a list typed here: a tool
   * added to the host must arrive already hosted, and a test that named nine
   * ids would go on passing while a tenth quietly opened a modal.
   *
   * The explicit timeout is the price of that derivation: this is a full `App`
   * render PER HOSTED ID, so its cost grows with the roster — D4's tenth id
   * (`voice.separate`) took it close enough to jest's 5 s default that a loaded
   * machine tipped it over in a full-suite run while passing in isolation. The
   * sweep is worth keeping and the roster will only grow, so the budget is
   * stated rather than inherited (the `dsp/remix*` suites' convention).
   */
  it('routes every hosted tool into the column, with no backdrop anywhere', async () => {
    for (const id of hostedToolIds()) {
      addDoc();
      const view = render(<App />);
      await openTool(id);
      expect(screen.getByTestId('tool-host')).toHaveAttribute('data-tool-id', id);
      expect(screen.queryByTestId('dialog-overlay')).toBeNull();
      // …and the module card it replaced is gone, not stacked behind it.
      expect(screen.queryByTestId('sidebar-panel')).toBeNull();
      view.unmount();
      useAppStore.setState(makeInitialState());
    }
  }, 30000);

  it('shows Pipeline as the active module while a tool is hosted', async () => {
    addDoc();
    render(<App />);
    await openTool('effects.coverChain');
    expect(stripButton('Pipeline')).toHaveAttribute('aria-pressed', 'true');
    expect(stripButton('Pipeline')).toHaveClass('is-active');
  });

  it('gives the stage the host’s clearance, and hands it back on close', async () => {
    addDoc();
    render(<App />);
    const stage = screen.getByTestId('editor-stage');
    // A plain module card: 14 + 348 + 14.
    expect(stage.style.getPropertyValue('--stage-inset-right')).toBe('376px');

    await openTool('tempo.match');
    // The host: 14 + 640 + 14.
    expect(stage.style.getPropertyValue('--stage-inset-right')).toBe('668px');

    fireEvent.click(screen.getByTestId('hosted-tool-close'));
    expect(stage.style.getPropertyValue('--stage-inset-right')).toBe('376px');
  });

  /**
   * W1: the user's rule — "the module bar and the extended modules must always
   * have the same width." The strip renders at the SAME constant the host
   * renders at, so the two cannot drift apart: 348 with a module card open,
   * 640 while a tool is hosted, and back the moment it closes.
   */
  it('keeps the strip exactly as wide as the surface below it — card or host', async () => {
    addDoc();
    render(<App />);
    expect(strip().style.width).toBe(`${MODULE_COLUMN_WIDTH}px`);

    await openTool('tempo.match');
    expect(strip().style.width).toBe(`${TOOL_HOST_WIDTH}px`);
    expect(screen.getByTestId('tool-host').style.width).toBe(`${TOOL_HOST_WIDTH}px`);

    fireEvent.click(screen.getByTestId('hosted-tool-close'));
    expect(strip().style.width).toBe(`${MODULE_COLUMN_WIDTH}px`);
  });

  it('returns to the Pipeline card when the tool closes', async () => {
    addDoc();
    render(<App />);
    await openTool('tempo.match');
    fireEvent.click(screen.getByTestId('hosted-tool-close'));
    expect(screen.queryByTestId('tool-host')).toBeNull();
    expect(screen.getByTestId('sidebar-panel')).toHaveAttribute('data-active-tab', 'pipeline');
    expect(screen.getByTestId('pipeline-panel')).toBeInTheDocument();
  });

  it('leaves the global shortcuts live while a tool is open but idle', async () => {
    addDoc();
    render(<App />);
    await openTool('tempo.match');
    // The stage is the point: a hosted tool must not take Space, Ctrl+O or the
    // arrows away from the editor the way an open modal does.
    expect(hasOpenDialog()).toBe(false);
  });
});

describe('every door reaches the same host', () => {
  it('the Pipeline card’s row', async () => {
    addDoc();
    render(<App />);
    fireEvent.click(stripButton('Pipeline'));
    const row = screen
      .getAllByTestId('pipeline-item')
      .find((r) => r.getAttribute('data-command-id') === 'edit.voiceChanger')!;
    await act(async () => {
      fireEvent.click(within(row).getByRole('button'));
    });
    expect(screen.getByTestId('tool-host')).toHaveAttribute('data-tool-id', 'edit.voiceChanger');
  });

  // Item 5 (2026-08-18): the Effects card's Pipeline rows were a second door
  // (F11-6, kept at U2); the user rules one — a Pipeline tool lives in the
  // Pipeline module only. What the card keeps is the Effects MENU's own Mix
  // row (N15), which is not a Pipeline tool and has no strip icon of its own.
  it('the Effects card carries no Pipeline door — only the Mix row', async () => {
    addDoc();
    render(<App />);
    fireEvent.click(stripButton('Effects'));
    expect(
      screen.getAllByTestId('effects-tool-item').map((r) => r.getAttribute('data-command-id'))
    ).toEqual(['spatial.position']);
    expect(screen.queryByTestId('tool-host')).toBeNull();
  });

  // The menu's door is `runCommand(id)` — the same call MenuBar makes on a
  // click (MenuBar.test pins that it does), so this is that door end to end
  // from the command down.
  it('the Pipeline menu’s command', async () => {
    addDoc();
    render(<App />);
    await openTool('lyrics.align');
    expect(screen.getByTestId('tool-host')).toHaveAttribute('data-tool-id', 'lyrics.align');
  });
});

/**
 * The mid-run decision, and the evidence behind it.
 *
 * Every one of the nine keeps its pass in component state and cancels it on
 * unmount (`cancelledRef` / `unmountedRef`, each run body returning early after
 * its await). So switching module mid-pass would not background the run — it
 * would DISCARD it. Blocking is therefore the honest answer, and it is enforced
 * with the flag the dialogs already publish for exactly this purpose:
 * `dismissable={!busy}`, which has always refused Escape and a backdrop click.
 */
describe('while a hosted pass is running', () => {
  async function startPass() {
    addDoc();
    render(<App />);
    await openTool('tempo.match');
    fireEvent.click(screen.getByRole('button', { name: 'start pass' }));
  }

  it('locks the module strip, with the reason in every tooltip', async () => {
    await startPass();
    for (const button of within(strip()).getAllByRole('button')) {
      expect(button).toBeDisabled();
      expect(button.title).toBe(
        'A pipeline pass is running — switching module would discard it. The waveform and transport stay usable.'
      );
    }
  });

  it('refuses the tool’s own ✕, saying why', async () => {
    await startPass();
    const close = screen.getByTestId('hosted-tool-close') as HTMLButtonElement;
    expect(close.disabled).toBe(true);
    expect(close.title).toBe('This pass is running — it cannot be closed yet');
    fireEvent.click(close);
    expect(screen.getByTestId('tool-host')).toBeInTheDocument();
  });

  it('refuses to swap in another tool, and says which pass is running', async () => {
    await startPass();
    await openTool('effects.coverChain');
    expect(screen.getByTestId('tool-host')).toHaveAttribute('data-tool-id', 'tempo.match');
    expect(showMessageBox).toHaveBeenCalledTimes(1);
    const [opts] = showMessageBox.mock.calls[0];
    expect(opts.message).toContain('Match Tempo');
    expect(opts.message).toContain('discard the pass');
  });

  // The F10 guard, kept exactly where it is still justified: these tools
  // resolve their target document from the LIVE activeDocumentId at confirm
  // time, so a Ctrl+O behind a running pass would land it on the wrong file.
  it('puts the global shortcuts back behind the guard, and only while it runs', async () => {
    await startPass();
    expect(hasOpenDialog()).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'finish pass' }));
    expect(hasOpenDialog()).toBe(false);
    expect(stripButton('Markers')).not.toBeDisabled();
  });

  it('unlocks everything once the pass finishes', async () => {
    await startPass();
    fireEvent.click(screen.getByRole('button', { name: 'finish pass' }));
    for (const button of within(strip()).getAllByRole('button')) {
      expect(button).not.toBeDisabled();
    }
    expect((screen.getByTestId('hosted-tool-close') as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(stripButton('Markers'));
    expect(screen.getByTestId('sidebar-panel')).toHaveAttribute('data-active-tab', 'markers');
  });

  /**
   * The hand-off, and why it is NOT refused.
   *
   * RemixDialog ends with `onClose(); focusRemixPanel();` and TranscribeDialog
   * with `focusTranscriptPanel(); onClose();` — in both, the pass finishes and
   * the panel is asked for in one synchronous block, so React has not
   * re-rendered and "a pass is running" still reads true at that instant. A
   * guard that refused every panel request while running would therefore fire
   * on the completion path of the two tools that have one, every single time,
   * and strand the user in a tool with nothing left to say.
   */
  it('lets a finishing tool hand over to its result panel', async () => {
    await startPass();
    fireEvent.click(screen.getByRole('button', { name: 'finish and hand over' }));

    expect(showMessageBox).not.toHaveBeenCalled();
    expect(screen.queryByTestId('tool-host')).toBeNull();
    expect(screen.getByTestId('sidebar-panel')).toHaveAttribute('data-active-tab', 'transcript');
    expect(hasOpenDialog()).toBe(false);
    for (const button of within(strip()).getAllByRole('button')) {
      expect(button).not.toBeDisabled();
    }
  });

  /**
   * The other side of that line: `focusSpatialPanel` is not a hand-off. Its
   * only caller is the `spatial.position` command — a menu row the user picks —
   * and taking it mid-pass would unmount the running tool and discard the pass
   * exactly as switching module would. So that one IS guarded.
   */
  it('still refuses the Spatial Positioner command, which is a user’s choice to leave', async () => {
    await startPass();
    await openTool('spatial.position');
    expect(screen.getByTestId('tool-host')).toHaveAttribute('data-tool-id', 'tempo.match');
    expect(showMessageBox).toHaveBeenCalledTimes(1);
  });

  // A stale `true` here would leave every global shortcut suppressed for the
  // rest of the session, with no open dialog anywhere to explain it. The shell
  // hands `dismissable` back as `true` on unmount precisely for this.
  it('never strands the shortcut guard when the app unmounts mid-pass', async () => {
    addDoc();
    const view = render(<App />);
    await openTool('tempo.match');
    fireEvent.click(screen.getByRole('button', { name: 'start pass' }));
    expect(hasOpenDialog()).toBe(true);

    view.unmount();
    expect(hasOpenDialog()).toBe(false);
  });
});
