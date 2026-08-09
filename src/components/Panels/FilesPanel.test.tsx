import { render, screen, fireEvent } from '@testing-library/react';
import FilesPanel from './FilesPanel';
import { closeDocumentFlow } from '../../services/fileService';
import { useAppStore, makeInitialState } from '../../stores/appStore';
import { createDocument, type AudioDocument } from '../../audio/AudioDocument';

jest.mock('../../services/fileService', () => ({
  closeDocumentFlow: jest.fn(async () => {}),
}));

const mockClose = closeDocumentFlow as jest.MockedFunction<typeof closeDocumentFlow>;

function addDoc(opts: {
  name: string;
  sampleRate?: number;
  seconds?: number;
  dirty?: boolean;
  neverSaved?: boolean;
}): AudioDocument {
  const sampleRate = opts.sampleRate ?? 44100;
  const length = Math.round(sampleRate * (opts.seconds ?? 1));
  const doc = createDocument({
    name: opts.name,
    sampleRate,
    channels: [new Float32Array(length), new Float32Array(length)],
  });
  useAppStore.getState().addDocument(doc);
  const patch: Partial<AudioDocument> = {};
  if (opts.dirty) patch.dirty = true;
  if (opts.neverSaved !== undefined) patch.neverSaved = opts.neverSaved;
  if (Object.keys(patch).length > 0) useAppStore.getState().updateDocument({ ...doc, ...patch });
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

  // v1.9.1 item 3: the never-saved marker is a distinct indicator from the
  // dirty asterisk. The two flags are independent; probe all four combinations.
  it('shows the never-saved dot for a clean, never-saved (computed) document, with NO asterisk', () => {
    addDoc({ name: 'Remix 1', neverSaved: true }); // dirty false
    render(<FilesPanel />);
    const dot = screen.getByTestId('files-neversaved');
    expect(dot).toBeInTheDocument();
    expect(dot).toHaveAttribute('title', 'Never saved to disk');
    expect(screen.queryByText(/Remix 1\s*\*/)).not.toBeInTheDocument();
  });

  it('shows NO never-saved dot for a saved (on-disk) document', () => {
    addDoc({ name: 'ondisk.wav', neverSaved: false }); // dirty false
    render(<FilesPanel />);
    expect(screen.queryByTestId('files-neversaved')).not.toBeInTheDocument();
  });

  it('shows the asterisk but NO never-saved dot for a saved-but-edited document (dirty, not never-saved)', () => {
    addDoc({ name: 'edited.wav', dirty: true, neverSaved: false });
    render(<FilesPanel />);
    expect(screen.getByText(/edited\.wav\s*\*/)).toBeInTheDocument();
    expect(screen.queryByTestId('files-neversaved')).not.toBeInTheDocument();
  });

  it('shows BOTH the dot and the asterisk for a never-saved, edited document', () => {
    addDoc({ name: 'Remix 2', dirty: true, neverSaved: true });
    render(<FilesPanel />);
    expect(screen.getByTestId('files-neversaved')).toBeInTheDocument();
    expect(screen.getByText(/Remix 2\s*\*/)).toBeInTheDocument();
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
