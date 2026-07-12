import { render, screen } from '@testing-library/react';
import WaveformView from './WaveformView';
import { createDocument, type AudioDocument } from '../../audio/AudioDocument';
import { useAppStore, makeInitialState } from '../../stores/appStore';
import { clearAllPeaks } from '../../services/peaksCache';

function makeDoc(): AudioDocument {
  const ch = new Float32Array(4096);
  for (let i = 0; i < ch.length; i++) ch[i] = Math.sin(i / 20) * 0.5;
  return createDocument({ name: 'clip.wav', sampleRate: 44100, channels: [ch, ch.slice()] });
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
});
