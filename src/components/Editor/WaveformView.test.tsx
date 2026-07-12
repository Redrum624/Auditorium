import { act, render, screen } from '@testing-library/react';
import WaveformView from './WaveformView';
import { createDocument, docLength, type AudioDocument } from '../../audio/AudioDocument';
import { useAppStore, makeInitialState } from '../../stores/appStore';
import { clearAllPeaks } from '../../services/peaksCache';

function makeDoc(): AudioDocument {
  const ch = new Float32Array(4096);
  for (let i = 0; i < ch.length; i++) ch[i] = Math.sin(i / 20) * 0.5;
  return createDocument({ name: 'clip.wav', sampleRate: 44100, channels: [ch, ch.slice()] });
}

// jsdom has no window.PointerEvent, so @testing-library's fireEvent.pointerDown
// falls back to a bare `Event` that silently drops clientX/shiftKey/detail
// (the Event constructor only reads bubbles/cancelable/composed from init).
// Dispatch a real MouseEvent instead -- it carries those UIEvent/MouseEvent
// fields correctly -- and attach pointerId as a plain extra property, which
// is all WaveformView's handlers read off the event.
function firePointer(
  element: Element,
  type: 'pointerdown' | 'pointermove' | 'pointerup',
  init: { clientX: number; clientY?: number; pointerId?: number; shiftKey?: boolean; detail?: number }
): void {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: init.clientX,
    clientY: init.clientY ?? 0,
    shiftKey: init.shiftKey ?? false,
    detail: init.detail ?? 1,
  });
  Object.defineProperty(event, 'pointerId', { value: init.pointerId ?? 1 });
  act(() => {
    element.dispatchEvent(event);
  });
}

describe('WaveformView', () => {
  beforeEach(() => {
    useAppStore.setState(makeInitialState());
    clearAllPeaks();
  });

  it('mounts with a document and renders the waveform canvas and ruler', () => {
    const doc = makeDoc();
    render(<WaveformView doc={doc} />);
    expect(screen.getByTestId('waveform-view')).toBeInTheDocument();
    expect(screen.getByTestId('waveform-canvas')).toBeInTheDocument();
    expect(screen.getByTestId('timeline-ruler')).toBeInTheDocument();
  });

  describe('mouse selection', () => {
    it('pointerdown sets the cursor to the clicked sample and clears any existing selection', () => {
      const doc = makeDoc();
      useAppStore.setState({ selection: { start: 10, end: 20 } });
      render(<WaveformView doc={doc} />);
      const canvas = screen.getByTestId('waveform-canvas');
      const spp = useAppStore.getState().zoom.samplesPerPixel;

      firePointer(canvas, 'pointerdown', { clientX: 2, pointerId: 1 });
      expect(useAppStore.getState().cursorSample).toBe(2 * spp);

      firePointer(canvas, 'pointerup', { clientX: 2, pointerId: 1 });
      expect(useAppStore.getState().selection).toBeNull();
    });

    it('dragging past the 3px threshold creates a live selection', () => {
      const doc = makeDoc();
      render(<WaveformView doc={doc} />);
      const canvas = screen.getByTestId('waveform-canvas');

      firePointer(canvas, 'pointerdown', { clientX: 0, pointerId: 1 });
      firePointer(canvas, 'pointermove', { clientX: 2, pointerId: 1 });
      expect(useAppStore.getState().selection).toBeNull(); // within threshold

      firePointer(canvas, 'pointermove', { clientX: 10, pointerId: 1 });
      const sel = useAppStore.getState().selection;
      expect(sel).not.toBeNull();
      expect(sel!.start).toBe(0);
      expect(sel!.end).toBeGreaterThan(0);

      firePointer(canvas, 'pointerup', { clientX: 10, pointerId: 1 });
      // Selection made during the drag survives pointerup.
      expect(useAppStore.getState().selection).toEqual(sel);
    });

    it('double-click selects the entire document', () => {
      const doc = makeDoc();
      render(<WaveformView doc={doc} />);
      const canvas = screen.getByTestId('waveform-canvas');

      firePointer(canvas, 'pointerdown', { clientX: 5, pointerId: 1, detail: 2 });

      expect(useAppStore.getState().selection).toEqual({ start: 0, end: docLength(doc) });
    });

    it('shift+click extends the selection from the cursor when there is none yet', () => {
      const doc = makeDoc();
      useAppStore.setState({ cursorSample: 100 });
      render(<WaveformView doc={doc} />);
      const canvas = screen.getByTestId('waveform-canvas');
      const spp = useAppStore.getState().zoom.samplesPerPixel;

      firePointer(canvas, 'pointerdown', { clientX: 5, pointerId: 1, shiftKey: true });

      expect(useAppStore.getState().selection).toEqual({ start: 100, end: 5 * spp });
    });
  });
});
