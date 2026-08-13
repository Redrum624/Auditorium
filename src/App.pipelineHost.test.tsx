import { act, fireEvent, render, screen, within } from '@testing-library/react';
import App from './App';
import DialogShell from './components/Dialogs/DialogShell';
import { hostedToolIds } from './components/Dialogs/PipelineToolHost';
import { createDocument } from './audio/AudioDocument';
import { hasOpenDialog } from './services/dialogBus';
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
        children: React.createElement(
          'button',
          { type: 'button', onClick: () => setBusy((b) => !b) },
          busy ? 'finish pass' : 'start pass'
        ),
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
  });

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

  it('the Effects card’s tool row', async () => {
    addDoc();
    render(<App />);
    fireEvent.click(stripButton('Effects'));
    const row = screen
      .getAllByTestId('effects-tool-item')
      .find((r) => r.getAttribute('data-command-id') === 'effects.vocalChain')!;
    await act(async () => {
      fireEvent.click(within(row).getByRole('button'));
    });
    expect(screen.getByTestId('tool-host')).toHaveAttribute('data-tool-id', 'effects.vocalChain');
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
    expect(opts.message).toContain('Match Tempo…');
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
