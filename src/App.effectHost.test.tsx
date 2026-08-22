import { act, fireEvent, render, screen, within } from '@testing-library/react';
import App from './App';
import DialogShell from './components/Dialogs/DialogShell';
import { DEFAULT_PANEL, MODULE_COLUMN_WIDTH } from './components/Layout/ModuleStrip';
import { createDocument } from './audio/AudioDocument';
import { getEffect, getVisibleEffects } from './effects/EffectRegistry';
import { _resetHostedToolRunning, hasOpenDialog } from './services/dialogBus';
import { runEffectOnSelection } from './services/effectRunner';
import { runCommand } from './services/menuActions';
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
