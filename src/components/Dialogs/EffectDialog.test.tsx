import { act, render, screen } from '@testing-library/react';
import EffectDialog from './EffectDialog';
import { registerAllEffects } from '../../effects/registerAll';
import { captureNoiseProfile, clearNoiseProfile } from '../../services/noiseProfile';
import { useAppStore, makeInitialState } from '../../stores/appStore';
import { createDocument } from '../../audio/AudioDocument';

registerAllEffects();

function seedActiveDoc() {
  const doc = createDocument({
    name: 'noise.wav',
    sampleRate: 44100,
    channels: [new Float32Array(8192)],
  });
  useAppStore.getState().addDocument(doc);
  return doc;
}

beforeEach(() => {
  useAppStore.setState(makeInitialState());
  clearNoiseProfile();
});

afterEach(() => {
  clearNoiseProfile();
});

describe('EffectDialog noise-reduction gating (Task F8: reactive hasNoiseProfile)', () => {
  it('shows the capture hint and disables Apply without a noise profile', () => {
    seedActiveDoc();
    render(<EffectDialog effectId="noise-reduction" onClose={() => {}} />);
    expect(screen.getByTestId('noise-profile-hint')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled();
  });

  it('reacts to a capture while open: hint disappears and Apply enables', () => {
    seedActiveDoc();
    render(<EffectDialog effectId="noise-reduction" onClose={() => {}} />);
    expect(screen.getByTestId('noise-profile-hint')).toBeInTheDocument();

    act(() => captureNoiseProfile());

    expect(screen.queryByTestId('noise-profile-hint')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Apply' })).toBeEnabled();
  });

  it('reacts to a clear while open: hint returns and Apply disables', () => {
    seedActiveDoc();
    captureNoiseProfile();
    render(<EffectDialog effectId="noise-reduction" onClose={() => {}} />);
    expect(screen.queryByTestId('noise-profile-hint')).not.toBeInTheDocument();

    act(() => clearNoiseProfile());

    expect(screen.getByTestId('noise-profile-hint')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled();
  });
});
