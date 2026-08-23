import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import EffectHost from './EffectHost';
import DialogShell from './DialogShell';
import { MODULE_COLUMN_WIDTH } from '../Layout/ModuleStrip';
import { getEffect } from '../../effects/EffectRegistry';
import { registerAllEffects } from '../../effects/registerAll';
import { createDocument } from '../../audio/AudioDocument';
import { playbackEngine } from '../../audio/PlaybackEngine';
import { hasOpenDialog } from '../../services/dialogBus';
import { runEffectOnSelection } from '../../services/effectRunner';
import { makeInitialState, useAppStore } from '../../stores/appStore';

/** N18: Apply's promise is the test's to resolve, so "busy" can be observed. */
jest.mock('../../services/effectRunner', () => {
  const actual = jest.requireActual('../../services/effectRunner');
  return { ...actual, runEffectOnSelection: jest.fn(async () => 'committed') };
});
const mockRun = runEffectOnSelection as jest.MockedFunction<typeof runEffectOnSelection>;

/**
 * Item 6 (2026-08-18) / M6 — the card that hosts ONE effect in the module
 * column, between the module strip and the module card.
 *
 * The mirror of `PipelineToolHost`, with one deliberate difference: no
 * negative margin and no width of its own beyond the column's 348, because an
 * effect's body fits the column and the strip must stay exactly as wide as
 * every surface below it (W1). What is pinned here is the card's own contract
 * — width, no backdrop, no dialog stack entry, the lock released on unmount —
 * and `App.effectHost.test` pins how App places and drives it.
 */
registerAllEffects();

beforeEach(() => {
  mockRun.mockReset();
  mockRun.mockImplementation(async () => 'committed');
  useAppStore.setState(makeInitialState());
  useAppStore.getState().addDocument(
    createDocument({ name: 'take.wav', sampleRate: 44100, channels: [new Float32Array(4410)] })
  );
});

describe('EffectHost — a 348-wide card in the module column', () => {
  it('renders the effect-host at the column width, with no margin pulling it wider', () => {
    render(<EffectHost effectId="amplify" onClose={() => {}} onModuleLockChange={() => {}} />);
    const host = screen.getByTestId('effect-host');
    expect(host).toHaveAttribute('data-effect-id', 'amplify');
    expect(host.style.width).toBe(`${MODULE_COLUMN_WIDTH}px`);
    expect(host.style.marginLeft).toBe('');
  });

  it('hosts the effect as a region named after it, with the dialog body inside', () => {
    render(<EffectHost effectId="amplify" onClose={() => {}} onModuleLockChange={() => {}} />);
    const host = screen.getByTestId('effect-host');
    const region = within(host).getByTestId('hosted-tool');
    expect(region).toHaveAttribute('aria-label', getEffect('amplify')!.name);
    expect(within(host).getByTestId('effect-dialog')).toBeInTheDocument();
  });

  it('raises no backdrop, is no modal dialog, and joins no dialog stack', () => {
    render(<EffectHost effectId="amplify" onClose={() => {}} onModuleLockChange={() => {}} />);
    expect(screen.queryByTestId('dialog-overlay')).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
    // The stage stays live: an idle effect card suspends no global shortcut.
    expect(hasOpenDialog()).toBe(false);
  });

  it('renders nothing for an id the registry does not know', () => {
    const { container } = render(
      <EffectHost effectId="no-such-effect" onClose={() => {}} onModuleLockChange={() => {}} />
    );
    expect(container.firstChild).toBeNull();
  });

  it('releases the module lock on unmount, so a host can never be stranded locked', () => {
    const onModuleLockChange = jest.fn();
    const { unmount } = render(
      <EffectHost effectId="amplify" onClose={() => {}} onModuleLockChange={onModuleLockChange} />
    );
    // Idle at mount: the shell publishes `moduleLock` (false while not busy).
    expect(onModuleLockChange).toHaveBeenCalled();
    expect(onModuleLockChange).not.toHaveBeenCalledWith(true);
    onModuleLockChange.mockClear();

    unmount();
    expect(onModuleLockChange).toHaveBeenCalledWith(false);
    expect(onModuleLockChange).toHaveBeenLastCalledWith(false);
  });
});

/**
 * Fix round 1 (finding 1): the host renders the SAME component type for every
 * effect id, so without a key React would keep the mounted `EffectDialog`
 * across a swap — its `params`, `previewing` and `busy` state are initialised
 * once, and the second effect would render the first one's parameter map (an
 * empty, NaN-valued control for every parameter it never declared; Apply
 * sending values the card never showed; a preview of the first effect still
 * playing under the second's name). The contract: one effect id, one dialog
 * instance — a swap unmounts the old dialog (so its unmount-restore runs) and
 * mounts the new one from its own defaults.
 */
describe('EffectHost — swapping the effect id mounts a fresh dialog', () => {
  function paramInput(id: string): HTMLInputElement {
    const el = document.getElementById(`effect-param-${id}`);
    if (!(el instanceof HTMLInputElement)) throw new Error(`no parameter input for ${id}`);
    return el;
  }

  it('the previous effect’s edited parameters never leak into the next card', () => {
    // React reports a leaked map as 'Received NaN for the `value` attribute' —
    // the warning behind the four empty inputs the user saw.
    const errors = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { rerender } = render(
        <EffectHost effectId="amplify" onClose={() => {}} onModuleLockChange={() => {}} />
      );
      fireEvent.change(paramInput('gainDb'), { target: { value: '7' } });
      expect(paramInput('gainDb').value).toBe('7');

      rerender(<EffectHost effectId="reverb" onClose={() => {}} onModuleLockChange={() => {}} />);

      expect(screen.getByTestId('effect-host')).toHaveAttribute('data-effect-id', 'reverb');
      expect(document.getElementById('effect-param-gainDb')).toBeNull();
      const reverb = getEffect('reverb')!;
      expect(reverb.params.length).toBeGreaterThan(0);
      for (const p of reverb.params) {
        if (p.type === 'boolean') expect(paramInput(p.id).checked).toBe(Boolean(p.default));
        else expect(paramInput(p.id).value).toBe(String(p.default));
      }
      expect(errors.mock.calls.filter((c) => String(c[0]).includes('NaN'))).toEqual([]);
    } finally {
      errors.mockRestore();
    }
  });

  it('ends the previous effect’s preview: the engine holds the real document again before the next card shows', () => {
    const doc = useAppStore.getState().documents[0];
    const load = jest.spyOn(playbackEngine, 'load').mockImplementation(() => {});
    const play = jest.spyOn(playbackEngine, 'play').mockImplementation(() => {});
    const stop = jest.spyOn(playbackEngine, 'stop').mockImplementation(() => {});
    try {
      const { rerender } = render(
        <EffectHost effectId="amplify" onClose={() => {}} onModuleLockChange={() => {}} />
      );
      fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
      expect(play).toHaveBeenCalledWith(0);
      expect(screen.getByRole('button', { name: 'Stop Preview' })).toBeInTheDocument();
      load.mockClear();
      stop.mockClear();

      rerender(<EffectHost effectId="reverb" onClose={() => {}} onModuleLockChange={() => {}} />);

      // The old dialog's unmount-restore ran: stopped, real document reloaded.
      expect(stop).toHaveBeenCalled();
      expect(load).toHaveBeenCalledWith(expect.objectContaining({ id: doc.id }));
      // …and the new card is idle: it never previewed anything.
      expect(screen.getByRole('button', { name: 'Preview' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Stop Preview' })).toBeNull();
    } finally {
      load.mockRestore();
      play.mockRestore();
      stop.mockRestore();
    }
  });
});

/**
 * N18 (2026-08-23) — `Escape` with an effect card open CLOSES THE CARD, exactly
 * what the key did when the effect was a modal: the same path as the ✕ and
 * Cancel (so a running Preview is restored by the dialog's unmount), and the
 * key is claimed before the global table can run `edit.deselect` — the
 * selection survives. While Apply runs the key does nothing (the ✕ refuses
 * then, and so does this). With a modal dialog stacked over the card, the key
 * is the modal's. The rule is the card's own, so it holds for every consumer
 * of `EffectHost`, not only App's mount.
 */
describe('EffectHost — Escape closes the card (N18)', () => {
  function pressEscapeOn(target: Element | Document) {
    const handledByWindow = jest.fn();
    window.addEventListener('keydown', handledByWindow);
    try {
      act(() => {
        target.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
        );
      });
    } finally {
      window.removeEventListener('keydown', handledByWindow);
    }
    return { reachedWindow: handledByWindow.mock.calls.length > 0 };
  }

  /** The card behind a toggle, so `onClose` really unmounts it — the only way
   * the dialog's unmount-restore (the ✕'s own engine restore) can be seen. */
  function Toggle({ effectId }: { effectId: string }) {
    const [open, setOpen] = useState(true);
    return open ? (
      <EffectHost effectId={effectId} onClose={() => setOpen(false)} onModuleLockChange={() => {}} />
    ) : (
      <span data-testid="card-gone" />
    );
  }

  it('an idle card: Escape on the body closes it, and the key never reaches the window (no Deselect)', () => {
    const onClose = jest.fn();
    render(<EffectHost effectId="amplify" onClose={onClose} onModuleLockChange={() => {}} />);

    const { reachedWindow } = pressEscapeOn(document.body);

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(reachedWindow).toBe(false);
  });

  it('Escape from a control INSIDE the card closes it too — a parameter field included, as in the modal', () => {
    const onClose = jest.fn();
    render(<EffectHost effectId="amplify" onClose={onClose} onModuleLockChange={() => {}} />);
    const input = document.getElementById('effect-param-gainDb');
    if (!(input instanceof HTMLInputElement)) throw new Error('no gain input');

    pressEscapeOn(input);
    expect(onClose).toHaveBeenCalledTimes(1);

    pressEscapeOn(screen.getByRole('button', { name: 'Preview' }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('Escape typed in a field OUTSIDE the card is that field’s key: the card stays', () => {
    const onClose = jest.fn();
    render(
      <>
        <input data-testid="marker-name" defaultValue="verse" />
        <EffectHost effectId="amplify" onClose={onClose} onModuleLockChange={() => {}} />
      </>
    );

    const { reachedWindow } = pressEscapeOn(screen.getByTestId('marker-name'));

    expect(onClose).not.toHaveBeenCalled();
    expect(reachedWindow).toBe(true);
  });

  it('closing by Escape restores the real document to the engine when a Preview was running', () => {
    const doc = useAppStore.getState().documents[0];
    const load = jest.spyOn(playbackEngine, 'load').mockImplementation(() => {});
    const play = jest.spyOn(playbackEngine, 'play').mockImplementation(() => {});
    const stop = jest.spyOn(playbackEngine, 'stop').mockImplementation(() => {});
    try {
      render(<Toggle effectId="amplify" />);
      fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
      expect(screen.getByRole('button', { name: 'Stop Preview' })).toBeInTheDocument();
      load.mockClear();
      stop.mockClear();

      pressEscapeOn(document.body);

      expect(screen.getByTestId('card-gone')).toBeInTheDocument();
      expect(screen.queryByTestId('effect-host')).toBeNull();
      expect(stop).toHaveBeenCalled();
      expect(load).toHaveBeenCalledWith(expect.objectContaining({ id: doc.id }));
    } finally {
      load.mockRestore();
      play.mockRestore();
      stop.mockRestore();
    }
  });

  it('while Apply runs, Escape does nothing', async () => {
    const onClose = jest.fn();
    const onModuleLockChange = jest.fn();
    render(
      <EffectHost effectId="amplify" onClose={onClose} onModuleLockChange={onModuleLockChange} />
    );
    let finish!: (v: 'committed') => void;
    mockRun.mockReturnValueOnce(new Promise<'committed'>((resolve) => (finish = resolve)));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    });
    expect(onModuleLockChange).toHaveBeenLastCalledWith(true);
    expect(screen.getByTestId('hosted-tool-close')).toBeDisabled();

    pressEscapeOn(document.body);
    pressEscapeOn(screen.getByRole('button', { name: 'Preview' }));

    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByTestId('effect-host')).toBeInTheDocument();

    // The pass ends as before: a committed Apply closes the card itself, once.
    await act(async () => {
      finish('committed');
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onModuleLockChange).toHaveBeenLastCalledWith(false);
  });

  it('a cancelled Apply leaves the card open and idle: Escape closes it again', async () => {
    const onClose = jest.fn();
    render(<EffectHost effectId="amplify" onClose={onClose} onModuleLockChange={() => {}} />);
    mockRun.mockResolvedValueOnce('cancelled');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    });
    expect(screen.getByTestId('effect-stale-hint')).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();

    pressEscapeOn(document.body);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('with a modal dialog stacked over the card, Escape is the modal’s: the card stays', () => {
    const onClose = jest.fn();
    const closeModal = jest.fn();
    render(
      <>
        <EffectHost effectId="amplify" onClose={onClose} onModuleLockChange={() => {}} />
        <DialogShell title="Export" onClose={closeModal}>
          <span>modal body</span>
        </DialogShell>
      </>
    );
    expect(hasOpenDialog()).toBe(true);

    pressEscapeOn(document.body);

    expect(closeModal).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('uninstalls its listener on unmount: an Escape after the card is gone closes nothing', () => {
    const onClose = jest.fn();
    const { unmount } = render(
      <EffectHost effectId="amplify" onClose={onClose} onModuleLockChange={() => {}} />
    );
    unmount();

    const { reachedWindow } = pressEscapeOn(document.body);

    expect(onClose).not.toHaveBeenCalled();
    expect(reachedWindow).toBe(true);
  });
});
