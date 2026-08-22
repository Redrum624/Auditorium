import { render, screen, within } from '@testing-library/react';
import EffectHost from './EffectHost';
import { MODULE_COLUMN_WIDTH } from '../Layout/ModuleStrip';
import { getEffect } from '../../effects/EffectRegistry';
import { registerAllEffects } from '../../effects/registerAll';
import { createDocument } from '../../audio/AudioDocument';
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
