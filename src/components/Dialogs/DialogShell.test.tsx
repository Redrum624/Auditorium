import { render, screen, fireEvent } from '@testing-library/react';
import DialogShell from './DialogShell';

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
});
