import { StrictMode } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import DialogShell from './DialogShell';
import { hasOpenDialog } from '../../services/dialogBus';

function escape(): void {
  fireEvent.keyDown(document, { key: 'Escape' });
}

describe('DialogShell', () => {
  it('Escape dismisses via onClose', () => {
    const onClose = jest.fn();
    render(<DialogShell title="A" onClose={onClose}>content</DialogShell>);

    escape();

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('a backdrop mousedown dismisses via onClose', () => {
    const onClose = jest.fn();
    render(<DialogShell title="A" onClose={onClose}>content</DialogShell>);

    fireEvent.mouseDown(screen.getByTestId('dialog-overlay'));

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('a mousedown inside the panel does not dismiss (stopPropagation)', () => {
    const onClose = jest.fn();
    render(<DialogShell title="A" onClose={onClose}>content</DialogShell>);

    fireEvent.mouseDown(screen.getByRole('dialog'));

    expect(onClose).not.toHaveBeenCalled();
  });

  describe('dismissable={false} (Task M7/F12)', () => {
    it('Escape does not dismiss', () => {
      const onClose = jest.fn();
      render(
        <DialogShell title="A" onClose={onClose} dismissable={false}>
          content
        </DialogShell>
      );

      escape();

      expect(onClose).not.toHaveBeenCalled();
    });

    it('a backdrop mousedown does not dismiss', () => {
      const onClose = jest.fn();
      render(
        <DialogShell title="A" onClose={onClose} dismissable={false}>
          content
        </DialogShell>
      );

      fireEvent.mouseDown(screen.getByTestId('dialog-overlay'));

      expect(onClose).not.toHaveBeenCalled();
    });
  });

  describe('stacked dialogs (Task M7/F25)', () => {
    it('one Escape closes only the topmost of two stacked dialogs', () => {
      const onCloseA = jest.fn();
      const onCloseB = jest.fn();
      render(<DialogShell title="A" onClose={onCloseA}>a</DialogShell>);
      render(<DialogShell title="B" onClose={onCloseB}>b</DialogShell>);

      escape();

      expect(onCloseB).toHaveBeenCalledTimes(1);
      expect(onCloseA).not.toHaveBeenCalled();
    });

    it('once the topmost dialog unmounts, the next Escape reaches the one beneath it', () => {
      const onCloseA = jest.fn();
      const onCloseB = jest.fn();
      render(<DialogShell title="A" onClose={onCloseA}>a</DialogShell>);
      const resultB = render(<DialogShell title="B" onClose={onCloseB}>b</DialogShell>);

      escape();
      expect(onCloseB).toHaveBeenCalledTimes(1);
      expect(onCloseA).not.toHaveBeenCalled();

      // Simulates the parent unmounting B in response to onCloseB.
      resultB.unmount();

      escape();
      expect(onCloseA).toHaveBeenCalledTimes(1);
    });
  });

  // G5 (v1.6 glass UI): the shell's PANEL is a glass card with the Vitrine
  // modal header anatomy (IconTile + title + optional subtitle) instead of the
  // flat uppercase h2. BEHAVIOUR (stack, Escape, backdrop, veto — everything
  // above) is untouched; these pin only the new presentational contract.
  describe('G5 glass card anatomy', () => {
    it('the panel is a glass card at the 360px default width, accessibly named by its title', () => {
      render(<DialogShell title="A" onClose={() => {}}>content</DialogShell>);
      const panel = screen.getByRole('dialog', { name: 'A' });
      expect(panel).toHaveClass('glass-card');
      expect(panel).toHaveClass('dc-rise');
      expect(panel).toHaveStyle({ width: '360px' });
    });

    it('width grows per-dialog via the width prop (mockup: Remix at 600px)', () => {
      render(
        <DialogShell title="A" onClose={() => {}} width={600}>
          content
        </DialogShell>
      );
      expect(screen.getByRole('dialog', { name: 'A' })).toHaveStyle({ width: '600px' });
    });

    it('an icon renders inside the header icon tile; none renders without the prop', () => {
      const { unmount } = render(
        <DialogShell title="A" onClose={() => {}} icon={<span data-testid="glyph" />}>
          content
        </DialogShell>
      );
      expect(screen.getByTestId('dialog-icon')).toContainElement(screen.getByTestId('glyph'));
      unmount();

      render(<DialogShell title="A" onClose={() => {}}>content</DialogShell>);
      expect(screen.queryByTestId('dialog-icon')).not.toBeInTheDocument();
    });

    it('a subtitle renders under the title when given, and not otherwise', () => {
      const { unmount } = render(
        <DialogShell title="A" onClose={() => {}} subtitle="song.wav · 1:04">
          content
        </DialogShell>
      );
      expect(screen.getByText('song.wav · 1:04')).toBeInTheDocument();
      unmount();

      render(<DialogShell title="A" onClose={() => {}}>content</DialogShell>);
      expect(screen.queryByText('song.wav · 1:04')).not.toBeInTheDocument();
    });

    it('the title renders exactly once (the flat uppercase h2 is gone, not duplicated)', () => {
      render(<DialogShell title="Unique Title" onClose={() => {}}>content</DialogShell>);
      expect(screen.getAllByText('Unique Title')).toHaveLength(1);
      expect(document.querySelector('h2')).toBeNull();
    });
  });

  // Fix round 1 (CRITICAL): main.tsx renders the whole app under <StrictMode>,
  // which double-invokes render and, for effects, runs a dev-only
  // mount->cleanup->remount probe. The original DialogShell called
  // `pushDialog()` directly inside the `useState` lazy initializer — a
  // render-phase side effect. Under StrictMode that push ran twice (or leaked
  // if a render was discarded) while only one pop was ever scheduled, so
  // `hasOpenDialog()` stayed permanently true after unmount (locking out every
  // global shortcut) and Escape stopped matching `isTopDialog`, dismissing
  // nothing (F25 inverted). These tests must be exercised under <StrictMode>
  // or they silently pass against the bug they exist to catch.
  describe('StrictMode double-invoke safety (fix round 1 regression)', () => {
    it('registers exactly one token per real mount: hasOpenDialog is false once unmounted', () => {
      const onClose = jest.fn();
      const { unmount } = render(
        <StrictMode>
          <DialogShell title="A" onClose={onClose}>
            content
          </DialogShell>
        </StrictMode>
      );

      expect(hasOpenDialog()).toBe(true);

      unmount();

      expect(hasOpenDialog()).toBe(false);
    });

    it('Escape still dismisses via onClose', () => {
      const onClose = jest.fn();
      const { unmount } = render(
        <StrictMode>
          <DialogShell title="A" onClose={onClose}>
            content
          </DialogShell>
        </StrictMode>
      );

      escape();

      expect(onClose).toHaveBeenCalledTimes(1);
      unmount();
    });

    it('one Escape still closes only the topmost of two stacked dialogs', () => {
      const onCloseA = jest.fn();
      const onCloseB = jest.fn();
      const resultA = render(
        <StrictMode>
          <DialogShell title="A" onClose={onCloseA}>
            a
          </DialogShell>
        </StrictMode>
      );
      const resultB = render(
        <StrictMode>
          <DialogShell title="B" onClose={onCloseB}>
            b
          </DialogShell>
        </StrictMode>
      );

      escape();

      expect(onCloseB).toHaveBeenCalledTimes(1);
      expect(onCloseA).not.toHaveBeenCalled();
      expect(hasOpenDialog()).toBe(true); // A is still open

      resultB.unmount();
      resultA.unmount();
      expect(hasOpenDialog()).toBe(false);
    });
  });
});
