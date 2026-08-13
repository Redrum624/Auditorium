import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import DialogShell from './DialogShell';
import { DialogHostProvider } from './DialogHost';
import { hasOpenDialog } from '../../services/dialogBus';

/**
 * U2-3: the MOUNTING seam.
 *
 * The user asked that selecting a pipeline "open the module in the extended
 * modules instead of a modal". Every one of those tools renders its body inside
 * `DialogShell`, so the shell — the shared shell, not any dialog's internals —
 * is the one place where "modal" is decided. Wrapped in a `DialogHostProvider`
 * it drops the fixed overlay, the backdrop and the dialog stack, and becomes
 * in-flow card chrome; unwrapped it is byte-for-byte the modal it always was
 * (which `DialogShell.test` still pins in full).
 *
 * Nothing in this file touches a dialog COMPONENT. That is the point: CP1 is
 * rewriting CoverChainDialog's internals concurrently, and the seam has to hold
 * without either side knowing about the other.
 */
function Hosted({
  dismissable = true,
  onClose = () => {},
  onDismissableChange = () => {},
}: {
  dismissable?: boolean;
  onClose?: () => void;
  onDismissableChange?: (v: boolean) => void;
}) {
  return (
    <DialogHostProvider onDismissableChange={onDismissableChange}>
      <DialogShell title="Cover Chain" subtitle="take.wav · 3:12" dismissable={dismissable} onClose={onClose}>
        <p>chain body</p>
      </DialogShell>
    </DialogHostProvider>
  );
}

describe('DialogShell hosted in the module column', () => {
  it('renders the dialog’s own body and header, with no backdrop over the stage', () => {
    render(<Hosted />);
    expect(screen.getByText('chain body')).toBeInTheDocument();
    expect(screen.getByText('Cover Chain')).toBeInTheDocument();
    expect(screen.getByText('take.wav · 3:12')).toBeInTheDocument();
    // The whole user-visible difference: no dimmed full-screen layer.
    expect(screen.queryByTestId('dialog-overlay')).not.toBeInTheDocument();
    expect(screen.getByTestId('hosted-tool')).toBeInTheDocument();
  });

  it('is a region rather than a modal dialog', () => {
    render(<Hosted />);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('region', { name: 'Cover Chain' })).toBeInTheDocument();
  });

  /**
   * The stage stays LIVE — that is the entire point ("watch the stepper beside
   * the waveform"). `hasOpenDialog()` is what `shortcuts.ts` bails out of every
   * global shortcut on, so a hosted tool that registered on the stack would
   * silently take Space, Ctrl+O and the arrow keys away from the editor.
   */
  it('does not register on the open-dialog stack, so global shortcuts stay live', () => {
    expect(hasOpenDialog()).toBe(false);
    const { unmount } = render(<Hosted />);
    expect(hasOpenDialog()).toBe(false);
    unmount();
    expect(hasOpenDialog()).toBe(false);
  });

  // Escape belongs to the stage now (it clears a selection there). A hosted
  // tool that swallowed it would be a focus trap by another name.
  it('does not close on Escape — the ✕ is the tool’s only dismissal', () => {
    const onClose = jest.fn();
    render(<Hosted onClose={onClose} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('closes from its header ✕, through the dialog’s own onClose', () => {
    const onClose = jest.fn();
    render(<Hosted onClose={onClose} />);
    fireEvent.click(screen.getByTestId('hosted-tool-close'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  /**
   * `dismissable={!busy}` is the signal every one of the nine tools ALREADY
   * publishes to this shell — it is how a modal refuses Escape and a backdrop
   * click mid-run. Hosted, it is the only honest reading of "a pass is
   * running" available without editing a dialog's internals, so the host reads
   * it for its own guards.
   */
  it('refuses its own ✕ while the dialog says it is not dismissable', () => {
    const onClose = jest.fn();
    render(<Hosted dismissable={false} onClose={onClose} />);
    const close = screen.getByTestId('hosted-tool-close') as HTMLButtonElement;
    expect(close.disabled).toBe(true);
    expect(close.title).toBe('This pass is running — it cannot be closed yet');
    fireEvent.click(close);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('publishes every change of that flag to the host', () => {
    const onDismissableChange = jest.fn();
    function Toggle() {
      const [dismissable, setDismissable] = useState(true);
      return (
        <>
          <button type="button" onClick={() => setDismissable((d) => !d)}>
            toggle
          </button>
          <Hosted dismissable={dismissable} onDismissableChange={onDismissableChange} />
        </>
      );
    }
    render(<Toggle />);
    expect(onDismissableChange).toHaveBeenLastCalledWith(true);

    fireEvent.click(screen.getByRole('button', { name: 'toggle' }));
    expect(onDismissableChange).toHaveBeenLastCalledWith(false);

    fireEvent.click(screen.getByRole('button', { name: 'toggle' }));
    expect(onDismissableChange).toHaveBeenLastCalledWith(true);
  });

  // The host must not be left believing a pass is still running after the
  // tool goes — that would lock the module strip permanently.
  it('reports dismissable again when the hosted tool unmounts mid-run', () => {
    const onDismissableChange = jest.fn();
    const { unmount } = render(
      <Hosted dismissable={false} onDismissableChange={onDismissableChange} />
    );
    expect(onDismissableChange).toHaveBeenLastCalledWith(false);
    unmount();
    expect(onDismissableChange).toHaveBeenLastCalledWith(true);
  });
});
