import { render, screen, fireEvent } from '@testing-library/react';
import MarkersPanel from './MarkersPanel';
import { useAppStore, makeInitialState } from '../../stores/appStore';
import { createDocument, type AudioDocument } from '../../audio/AudioDocument';

function addDoc(): AudioDocument {
  const doc = createDocument({
    name: 'panel-test',
    sampleRate: 44100,
    channels: [new Float32Array(100000)],
  });
  useAppStore.getState().addDocument(doc);
  return doc;
}

beforeEach(() => {
  useAppStore.setState(makeInitialState());
});

describe('MarkersPanel', () => {
  it('prompts when no document is open', () => {
    render(<MarkersPanel />);
    expect(screen.getByText(/no document/i)).toBeInTheDocument();
  });

  it('shows an empty-state hint when the active doc has no markers', () => {
    addDoc();
    render(<MarkersPanel />);
    expect(screen.getByText(/no markers.*press m/i)).toBeInTheDocument();
  });

  it('renders each marker with its name and formatted position', () => {
    const doc = addDoc();
    useAppStore.getState().addMarker(doc.id, { id: 'marker-1', name: 'Intro', positionSample: 44100 });
    useAppStore.getState().addMarker(doc.id, { id: 'marker-2', name: 'Verse', positionSample: 88200 });

    render(<MarkersPanel />);
    const items = screen.getAllByTestId('markers-item');
    expect(items).toHaveLength(2);
    expect(screen.getByText('Intro')).toBeInTheDocument();
    expect(screen.getByText('Verse')).toBeInTheDocument();
    expect(screen.getByText('0:01.000')).toBeInTheDocument(); // 44100 samples @ 44100 Hz
    expect(screen.getByText('0:02.000')).toBeInTheDocument();
  });

  it('only shows markers belonging to the active document', () => {
    const doc = addDoc();
    useAppStore.getState().addMarker('doc-does-not-exist-and-is-not-active', {
      id: 'marker-1',
      name: 'Other Doc Marker',
      positionSample: 0,
    });
    useAppStore.getState().addMarker(doc.id, { id: 'marker-2', name: 'Mine', positionSample: 0 });

    render(<MarkersPanel />);
    expect(screen.queryByText('Other Doc Marker')).not.toBeInTheDocument();
    expect(screen.getByText('Mine')).toBeInTheDocument();
  });

  it('clicking the go-to (time) button sets the cursor to the marker position and centers the view around it', () => {
    const doc = addDoc();
    useAppStore.getState().addMarker(doc.id, { id: 'marker-1', name: 'Intro', positionSample: 50000 });
    useAppStore.setState({ zoom: { samplesPerPixel: 20, scrollSample: 0 } });

    render(<MarkersPanel />);
    fireEvent.click(screen.getByRole('button', { name: /go to intro/i }));

    const state = useAppStore.getState();
    expect(state.cursorSample).toBe(50000);
    // scrollSample = max(0, position - samplesPerPixel*400) = max(0, 50000 - 8000) = 42000
    expect(state.zoom.scrollSample).toBe(42000);
    expect(state.zoom.samplesPerPixel).toBe(20); // samplesPerPixel is preserved
  });

  it('clicking the go-to button near the start clamps scrollSample to 0 instead of going negative', () => {
    const doc = addDoc();
    useAppStore.getState().addMarker(doc.id, { id: 'marker-1', name: 'Intro', positionSample: 100 });
    useAppStore.setState({ zoom: { samplesPerPixel: 20, scrollSample: 5000 } });

    render(<MarkersPanel />);
    fireEvent.click(screen.getByRole('button', { name: /go to intro/i }));

    expect(useAppStore.getState().zoom.scrollSample).toBe(0);
  });

  it('double-clicking the name (real browser sequence: click, click, dblclick) does NOT move the cursor or viewport, and opens rename', () => {
    const doc = addDoc();
    useAppStore.getState().addMarker(doc.id, { id: 'marker-1', name: 'Intro', positionSample: 50000 });
    useAppStore.getState().setCursor(12345);
    useAppStore.setState({ zoom: { samplesPerPixel: 20, scrollSample: 777 } });

    render(<MarkersPanel />);
    // A real browser fires click, click, dblclick for a double-click, and all
    // three bubble up through the row. None of them may navigate.
    const name = screen.getByText('Intro');
    fireEvent.click(name);
    fireEvent.click(name);
    fireEvent.doubleClick(name);

    expect(useAppStore.getState().cursorSample).toBe(12345);
    expect(useAppStore.getState().zoom).toEqual({ samplesPerPixel: 20, scrollSample: 777 });
    // ...and rename mode opened.
    expect(screen.getByDisplayValue('Intro')).toBeInTheDocument();
  });

  it('double-clicking the name switches to an inline input; Enter commits the rename via the store', () => {
    const doc = addDoc();
    useAppStore.getState().addMarker(doc.id, { id: 'marker-1', name: 'Intro', positionSample: 0 });

    render(<MarkersPanel />);
    fireEvent.doubleClick(screen.getByText('Intro'));

    const input = screen.getByDisplayValue('Intro');
    fireEvent.change(input, { target: { value: 'Chorus' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(useAppStore.getState().markers[doc.id][0].name).toBe('Chorus');
    expect(screen.getByText('Chorus')).toBeInTheDocument();
  });

  it('blurring the rename input also commits the new name', () => {
    const doc = addDoc();
    useAppStore.getState().addMarker(doc.id, { id: 'marker-1', name: 'Intro', positionSample: 0 });

    render(<MarkersPanel />);
    fireEvent.doubleClick(screen.getByText('Intro'));
    const input = screen.getByDisplayValue('Intro');
    fireEvent.change(input, { target: { value: 'Outro' } });
    fireEvent.blur(input);

    expect(useAppStore.getState().markers[doc.id][0].name).toBe('Outro');
  });

  it('clicking the delete button removes the marker via the store', () => {
    const doc = addDoc();
    useAppStore.getState().addMarker(doc.id, { id: 'marker-1', name: 'Intro', positionSample: 0 });

    render(<MarkersPanel />);
    fireEvent.click(screen.getByRole('button', { name: /delete intro/i }));

    expect(useAppStore.getState().markers[doc.id]).toHaveLength(0);
  });
});
