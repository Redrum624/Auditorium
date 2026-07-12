import { render, screen, fireEvent } from '@testing-library/react';
import FilesPanel from './FilesPanel';
import { closeDocumentFlow } from '../../services/fileService';
import { useAppStore, makeInitialState } from '../../stores/appStore';
import { createDocument, type AudioDocument } from '../../audio/AudioDocument';

jest.mock('../../services/fileService', () => ({
  closeDocumentFlow: jest.fn(async () => {}),
}));

const mockClose = closeDocumentFlow as jest.MockedFunction<typeof closeDocumentFlow>;

function addDoc(opts: { name: string; sampleRate?: number; seconds?: number; dirty?: boolean }): AudioDocument {
  const sampleRate = opts.sampleRate ?? 44100;
  const length = Math.round(sampleRate * (opts.seconds ?? 1));
  const doc = createDocument({
    name: opts.name,
    sampleRate,
    channels: [new Float32Array(length), new Float32Array(length)],
  });
  useAppStore.getState().addDocument(doc);
  if (opts.dirty) useAppStore.getState().updateDocument({ ...doc, dirty: true });
  return useAppStore.getState().documents.at(-1)!;
}

beforeEach(() => {
  useAppStore.setState(makeInitialState());
  jest.clearAllMocks();
});

describe('FilesPanel', () => {
  it('shows an empty-state message with no documents', () => {
    render(<FilesPanel />);
    expect(screen.getByText(/no files open/i)).toBeInTheDocument();
  });

  it('lists a row per document with name, duration, and sample rate', () => {
    addDoc({ name: 'song.wav', sampleRate: 44100, seconds: 65 });
    render(<FilesPanel />);
    const rows = screen.getAllByTestId('files-item');
    expect(rows).toHaveLength(1);
    expect(screen.getByText('song.wav')).toBeInTheDocument();
    // 65s -> 1:05, 44100Hz -> 44.1 kHz
    expect(screen.getByText(/1:05/)).toBeInTheDocument();
    expect(screen.getByText(/44\.1 kHz/)).toBeInTheDocument();
  });

  it('marks dirty documents with an asterisk', () => {
    addDoc({ name: 'edited.wav', dirty: true });
    render(<FilesPanel />);
    expect(screen.getByText(/edited\.wav\s*\*/)).toBeInTheDocument();
  });

  it('activates a document when its row is clicked', () => {
    const first = addDoc({ name: 'a.wav' });
    const second = addDoc({ name: 'b.wav' });
    // b is active after being added; click a to switch.
    expect(useAppStore.getState().activeDocumentId).toBe(second.id);

    render(<FilesPanel />);
    fireEvent.click(screen.getByText('a.wav'));
    expect(useAppStore.getState().activeDocumentId).toBe(first.id);
  });

  it('closes a document through closeDocumentFlow when ✕ is clicked', () => {
    const doc = addDoc({ name: 'a.wav' });
    render(<FilesPanel />);
    fireEvent.click(screen.getByLabelText('Close a.wav'));
    expect(mockClose).toHaveBeenCalledWith(doc.id);
  });
});
