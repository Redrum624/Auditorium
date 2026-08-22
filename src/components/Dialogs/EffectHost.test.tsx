import { fireEvent, render, screen, within } from '@testing-library/react';
import EffectHost from './EffectHost';
import { MODULE_COLUMN_WIDTH } from '../Layout/ModuleStrip';
import { getEffect } from '../../effects/EffectRegistry';
import { registerAllEffects } from '../../effects/registerAll';
import { createDocument } from '../../audio/AudioDocument';
import { playbackEngine } from '../../audio/PlaybackEngine';
import { hasOpenDialog } from '../../services/dialogBus';
import { makeInitialState, useAppStore } from '../../stores/appStore';

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
