import { render, screen, fireEvent } from '@testing-library/react';
import HistoryPanel from './HistoryPanel';
import {
  deleteSelection,
  rippleDeleteSelection,
  silenceSelection,
  pushMarkerUndo,
} from '../../services/editOps';
import { clearHistory } from '../../services/undoHistory';
import { useAppStore, makeInitialState } from '../../stores/appStore';
import { createDocument, docLength, type AudioDocument } from '../../audio/AudioDocument';

function addDoc(samples: number): AudioDocument {
  const ch = new Float32Array(samples);
  for (let i = 0; i < samples; i++) ch[i] = i + 1;
  const doc = createDocument({ name: 'panel-test', sampleRate: 44100, channels: [ch] });
  useAppStore.getState().addDocument(doc);
  return doc;
}

beforeEach(() => {
  useAppStore.setState(makeInitialState());
});

describe('HistoryPanel', () => {
  it('prompts when no document is open', () => {
    render(<HistoryPanel />);
    expect(screen.getByText(/no document/i)).toBeInTheDocument();
  });

  it('shows an empty-state message when the active doc has no edits', () => {
    addDoc(10);
    render(<HistoryPanel />);
    expect(screen.getByText(/no edits/i)).toBeInTheDocument();
  });

  it('lists edit labels for the active document oldest-first', () => {
    const doc = addDoc(10);
    clearHistory(doc.id);
    useAppStore.getState().setSelection({ start: 2, end: 5 });
    silenceSelection(); // 'Silence' (keeps the selection)
    deleteSelection(); // 'Delete'

    render(<HistoryPanel />);
    const items = screen.getAllByTestId('history-item').map((el) => el.textContent);
    expect(items).toEqual(['Silence', 'Delete']);
  });

  it('clicking a done entry undoes back to that point', () => {
    const doc = addDoc(10);
    clearHistory(doc.id);
    useAppStore.getState().setSelection({ start: 2, end: 5 });
    silenceSelection(); // length stays 10
    // Item 7: plain Delete is equal-length now; the length-changing step this
    // test needs is the ripple (Shift+Del).
    rippleDeleteSelection(); // removes 3 samples -> length 7

    render(<HistoryPanel />);
    expect(docLength(useAppStore.getState().documents[0])).toBe(7);

    // Click the first (oldest) applied edit -> undo everything after it.
    fireEvent.click(screen.getByRole('button', { name: 'Silence' }));
    expect(docLength(useAppStore.getState().documents[0])).toBe(10);

    // 'Ripple Delete' is now an undone (grayed) entry; clicking it redoes.
    fireEvent.click(screen.getByRole('button', { name: 'Ripple Delete' }));
    expect(docLength(useAppStore.getState().documents[0])).toBe(7);
  });

  it('lists marker undo labels alongside edit labels (Task M2 / F5)', () => {
    const doc = addDoc(10);
    clearHistory(doc.id);
    pushMarkerUndo('Add Marker', doc.id, [], [{ id: 'marker-1', name: 'M', positionSample: 0 }]);

    render(<HistoryPanel />);
    expect(screen.getByRole('button', { name: 'Add Marker' })).toBeInTheDocument();
  });
});
