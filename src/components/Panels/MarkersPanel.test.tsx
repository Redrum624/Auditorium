import { FALLBACK_EDITOR_LANE_WIDTH } from '../../services/editorViewport';
import { render, screen, fireEvent, act } from '@testing-library/react';
import MarkersPanel from './MarkersPanel';
import { useAppStore, makeInitialState } from '../../stores/appStore';
import { createDocument, type AudioDocument } from '../../audio/AudioDocument';
import { undo, getHistory } from '../../services/undoHistory';
import { createClip, createTrack, type Session } from '../../multitrack/session';
import { useSessionStore } from '../../multitrack/sessionStore';

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
    // F11 fix round: centred on the lane's MEASURED width, clamped by the
    // store's one resolver. Nothing has published a width in this suite, so
    // the documented fallback applies. The old expectation (42000) came from
    // an inline "~800px viewport" guess that also bypassed the clamp — at fit,
    // where every freshly opened document now sits, that guess scrolled past
    // an end the waveform could not follow.
    const half = (FALLBACK_EDITOR_LANE_WIDTH * 20) / 2;
    expect(state.zoom.scrollSample).toBe(50000 - half);
    expect(state.zoom.samplesPerPixel).toBe(20); // samplesPerPixel is preserved
  });

  // F11 fix round (I2): the regression that shipped. Every freshly opened
  // document now sits at FIT, where the whole track is already on screen and
  // `maxScroll` is 0 — so one click on a marker used to write a positive
  // `scrollSample`, and the beat tics and the timeline ruler slid off the end
  // of a waveform that could not follow them. The F11-9 symptom, through a
  // door F11-9 never closed.
  it('does not scroll at all when the document already fits — the default state now', () => {
    const doc = addDoc(); // addDocument fits it
    useAppStore.getState().addMarker(doc.id, {
      id: 'marker-1',
      name: 'Outro',
      positionSample: 99_000,
    });
    const atFit = useAppStore.getState().zoom;
    expect(atFit.scrollSample).toBe(0);

    render(<MarkersPanel />);
    fireEvent.click(screen.getByRole('button', { name: /go to outro/i }));

    expect(useAppStore.getState().cursorSample).toBe(99_000);
    expect(useAppStore.getState().zoom.scrollSample).toBe(0);
    // Same object: nothing repaints either, which is what makes "nothing
    // moved" observable rather than merely equal.
    expect(useAppStore.getState().zoom).toBe(atFit);
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

  describe('rename state across document switches (Task M7/F26)', () => {
    it('exits an in-progress rename when the active document changes, instead of silently resuming it on return', () => {
      const docA = addDoc();
      useAppStore.getState().addMarker(docA.id, { id: 'marker-1', name: 'Intro', positionSample: 0 });
      const docB = addDoc(); // becomes active
      useAppStore.getState().addMarker(docB.id, { id: 'marker-2', name: 'Verse', positionSample: 0 });
      useAppStore.getState().setActiveDocument(docA.id);

      render(<MarkersPanel />);
      fireEvent.doubleClick(screen.getByText('Intro'));
      expect(screen.getByDisplayValue('Intro')).toBeInTheDocument();

      // Switch away and back WITHOUT ever pressing Enter/Escape/blur.
      act(() => useAppStore.getState().setActiveDocument(docB.id));
      act(() => useAppStore.getState().setActiveDocument(docA.id));

      // The switch must have exited edit mode, not silently carried it across
      // documents — the input must not reappear on return.
      expect(screen.queryByDisplayValue('Intro')).not.toBeInTheDocument();
      expect(screen.getByText('Intro')).toBeInTheDocument();
    });
  });

  describe('go-to and multitrack view (Task M7/F27)', () => {
    it('switches out of multitrack view so the cursor/zoom jump is visible', () => {
      const doc = addDoc();
      useAppStore.getState().addMarker(doc.id, { id: 'marker-1', name: 'Intro', positionSample: 50000 });
      useAppStore.setState({ view: 'multitrack' });

      render(<MarkersPanel />);
      fireEvent.click(screen.getByRole('button', { name: /go to intro/i }));

      const state = useAppStore.getState();
      expect(state.view).toBe('waveform');
      expect(state.cursorSample).toBe(50000);
    });

    it('leaves the view alone when already in waveform', () => {
      const doc = addDoc();
      useAppStore.getState().addMarker(doc.id, { id: 'marker-1', name: 'Intro', positionSample: 50000 });
      expect(useAppStore.getState().view).toBe('waveform');

      render(<MarkersPanel />);
      fireEvent.click(screen.getByRole('button', { name: /go to intro/i }));

      expect(useAppStore.getState().view).toBe('waveform');
      expect(useAppStore.getState().cursorSample).toBe(50000);
    });

    // Lot E (item 4, N14) regression pin: the panel's leaver stays the RAW
    // `setView` — it jumps inside the marker's document, so a foreign clip
    // selected in the session must not drag the active document along.
    it('stays on the marker’s document even with a foreign clip selected in the session', () => {
      const doc = addDoc();
      const other = addDoc();
      useAppStore.getState().setActiveDocument(doc.id);
      useAppStore.getState().addMarker(doc.id, { id: 'marker-1', name: 'Intro', positionSample: 50000 });
      const clip = createClip({ documentId: other.id, startSample: 0, offsetSample: 0, lengthSample: 1000 });
      const track = createTrack('Track 1');
      track.clips = [clip];
      const session: Session = { name: 'Pin', sampleRate: 44100, tracks: [track] };
      useSessionStore.setState({
        session,
        selectedClipId: clip.id,
        selectedClipIds: [clip.id],
        mtCursorSample: 0,
        mtPlayState: 'stopped',
        mtPlayheadSample: 0,
        mtEnvelope: null,
      });
      useAppStore.setState({ view: 'multitrack' });

      render(<MarkersPanel />);
      fireEvent.click(screen.getByRole('button', { name: /go to intro/i }));

      const state = useAppStore.getState();
      expect(state.activeDocumentId).toBe(doc.id);
      expect(state.cursorSample).toBe(50000);
      expect(state.view).toBe('waveform');
    });
  });

  describe('marker undo (Task M2 / F5)', () => {
    it('renaming a marker is undoable and shows up in the history as "Rename Marker"', () => {
      const doc = addDoc();
      useAppStore.getState().addMarker(doc.id, { id: 'marker-1', name: 'Intro', positionSample: 0 });

      render(<MarkersPanel />);
      fireEvent.doubleClick(screen.getByText('Intro'));
      const input = screen.getByDisplayValue('Intro');
      fireEvent.change(input, { target: { value: 'Chorus' } });
      fireEvent.keyDown(input, { key: 'Enter' });
      expect(useAppStore.getState().markers[doc.id][0].name).toBe('Chorus');
      expect(getHistory(doc.id).done).toEqual(['Rename Marker']);

      undo(doc.id);
      expect(useAppStore.getState().markers[doc.id][0].name).toBe('Intro');
    });

    it('committing a rename with the same (trimmed) name is a no-op: no undo entry, no rename call', () => {
      const doc = addDoc();
      useAppStore.getState().addMarker(doc.id, { id: 'marker-1', name: 'Intro', positionSample: 0 });

      render(<MarkersPanel />);
      fireEvent.doubleClick(screen.getByText('Intro'));
      const input = screen.getByDisplayValue('Intro');
      // Trailing whitespace trims down to the same name as the marker already has.
      fireEvent.change(input, { target: { value: '  Intro  ' } });
      fireEvent.keyDown(input, { key: 'Enter' });

      expect(useAppStore.getState().markers[doc.id][0].name).toBe('Intro');
      expect(getHistory(doc.id).done).toEqual([]);
    });

    it('deleting a marker is undoable and shows up in the history as "Delete Marker"', () => {
      const doc = addDoc();
      useAppStore.getState().addMarker(doc.id, { id: 'marker-1', name: 'Intro', positionSample: 0 });

      render(<MarkersPanel />);
      fireEvent.click(screen.getByRole('button', { name: /delete intro/i }));
      expect(useAppStore.getState().markers[doc.id]).toHaveLength(0);
      expect(getHistory(doc.id).done).toEqual(['Delete Marker']);

      undo(doc.id);
      expect(useAppStore.getState().markers[doc.id]).toHaveLength(1);
      expect(useAppStore.getState().markers[doc.id][0].name).toBe('Intro');
    });
  });
});
