import { render, screen, fireEvent } from '@testing-library/react';
import NewFileDialog from './NewFileDialog';
import { newDocument } from '../../services/fileService';
import { useAppStore, makeInitialState } from '../../stores/appStore';

jest.mock('../../services/fileService', () => ({
  newDocument: jest.fn(),
}));

const mockNewDocument = newDocument as jest.MockedFunction<typeof newDocument>;

beforeEach(() => {
  useAppStore.setState(makeInitialState());
  jest.clearAllMocks();
});

// First direct suite for this dialog (added with G5): pins the create flow the
// component has always had, plus the new glass-header contract.
describe('NewFileDialog', () => {
  it('creates a silent document from the four fields and closes', () => {
    const onClose = jest.fn();
    render(<NewFileDialog onClose={onClose} />);

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: '  take one  ' } });
    fireEvent.change(screen.getByLabelText('Sample rate'), { target: { value: '48000' } });
    fireEvent.change(screen.getByLabelText('Channels'), { target: { value: '1' } });
    fireEvent.change(screen.getByLabelText('Duration (seconds)'), { target: { value: '2.5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    expect(mockNewDocument).toHaveBeenCalledWith({
      name: 'take one',
      sampleRate: 48000,
      channels: 1,
      durationSeconds: 2.5,
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('every control carries the testid the walkers ask for it by', () => {
    // T4. This dialog had NO `data-testid` anywhere, so `e2e-navigate` could
    // only find its controls by visible text — a query that breaks on a copy
    // edit and cannot tell two buttons with the same word apart. RecordDialog's
    // `record-device` / `record-toggle` naming is the convention followed here.
    // Asserted per control rather than as a count: a count passes while the one
    // control a future leg needs is the one still missing.
    render(<NewFileDialog onClose={() => {}} />);
    for (const id of [
      'new-file-dialog',
      'new-name',
      'new-rate',
      'new-channels',
      'new-duration',
      'new-cancel',
      'new-create',
    ]) {
      expect([id, screen.queryByTestId(id) !== null]).toEqual([id, true]);
    }
    // The testids are on the controls they name, not scattered onto wrappers.
    expect(screen.getByTestId('new-name')).toBe(screen.getByLabelText('Name'));
    expect(screen.getByTestId('new-rate')).toBe(screen.getByLabelText('Sample rate'));
    expect(screen.getByTestId('new-channels')).toBe(screen.getByLabelText('Channels'));
    expect(screen.getByTestId('new-duration')).toBe(screen.getByLabelText('Duration (seconds)'));
    expect(screen.getByTestId('new-create')).toBe(screen.getByRole('button', { name: 'Create' }));
    expect(screen.getByTestId('new-cancel')).toBe(screen.getByRole('button', { name: 'Cancel' }));
  });

  it('Cancel closes without creating anything', () => {
    const onClose = jest.fn();
    render(<NewFileDialog onClose={onClose} />);

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(mockNewDocument).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  describe('G5 glass header', () => {
    it('carries a lucide icon tile in the shell header', () => {
      render(<NewFileDialog onClose={() => {}} />);
      expect(screen.getByTestId('dialog-icon')).toBeInTheDocument();
    });
  });
});
