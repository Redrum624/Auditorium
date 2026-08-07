import { useState } from 'react';
import { act, render, screen, fireEvent } from '@testing-library/react';
import EffectDialog from './EffectDialog';
import { registerAllEffects } from '../../effects/registerAll';
import { captureNoiseProfile, clearNoiseProfile } from '../../services/noiseProfile';
import { useAppStore, makeInitialState } from '../../stores/appStore';
import { createDocument } from '../../audio/AudioDocument';
import type { PlaybackEngine } from '../../audio/PlaybackEngine';

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

// A hand-rolled PlaybackEngine stand-in (same convention as RecordDialog's
// FakeEngine) exposing just the surface EffectDialog touches, so preview
// tests never need a real Web Audio graph in jsdom.
class FakePlaybackEngine {
  load = jest.fn();
  play = jest.fn();
  stop = jest.fn();
}

function asEngine(fake: FakePlaybackEngine): PlaybackEngine {
  return fake as unknown as PlaybackEngine;
}

/** Mounts EffectDialog behind a toggle so firing a real Escape key can be
 * observed unmounting it exactly as App.tsx's onClose-driven unmount would. */
function Harness({ engine }: { engine: PlaybackEngine }) {
  const [open, setOpen] = useState(true);
  return open ? (
    <EffectDialog effectId="amplify" onClose={() => setOpen(false)} engine={engine} />
  ) : null;
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

describe('effect preview lifecycle (Task M7/F11)', () => {
  it('Preview loads a NEW temp document into the engine and toggles to Stop Preview', () => {
    const doc = seedActiveDoc();
    const fake = new FakePlaybackEngine();
    render(<EffectDialog effectId="amplify" onClose={() => {}} engine={asEngine(fake)} />);

    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));

    expect(fake.load).toHaveBeenCalledTimes(1);
    expect(fake.load.mock.calls[0][0].id).not.toBe(doc.id);
    expect(fake.play).toHaveBeenCalledWith(0);
    expect(screen.getByRole('button', { name: 'Stop Preview' })).toBeInTheDocument();
  });

  it('the explicit Stop Preview button stops the engine and reloads the real active document', () => {
    const doc = seedActiveDoc();
    const fake = new FakePlaybackEngine();
    render(<EffectDialog effectId="amplify" onClose={() => {}} engine={asEngine(fake)} />);
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    fake.load.mockClear();

    fireEvent.click(screen.getByRole('button', { name: 'Stop Preview' }));

    expect(fake.stop).toHaveBeenCalled();
    expect(fake.load).toHaveBeenCalledWith(expect.objectContaining({ id: doc.id }));
    expect(screen.getByRole('button', { name: 'Preview' })).toBeInTheDocument();
  });

  it('Escape while previewing stops the engine and reloads the real active document instead of leaving the preview loaded', () => {
    const doc = seedActiveDoc();
    const fake = new FakePlaybackEngine();
    render(<Harness engine={asEngine(fake)} />);

    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    fake.load.mockClear();

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(fake.stop).toHaveBeenCalled();
    expect(fake.load).toHaveBeenCalledWith(expect.objectContaining({ id: doc.id }));
    expect(screen.queryByTestId('effect-dialog')).not.toBeInTheDocument();
  });

  it('unmounting (Cancel/backdrop) without ever previewing does not touch the engine', () => {
    seedActiveDoc();
    const fake = new FakePlaybackEngine();
    const { unmount } = render(
      <EffectDialog effectId="amplify" onClose={() => {}} engine={asEngine(fake)} />
    );

    unmount();

    expect(fake.stop).not.toHaveBeenCalled();
    expect(fake.load).not.toHaveBeenCalled();
  });

  it('apply() stops an active preview before running the effect', () => {
    const doc = seedActiveDoc();
    const fake = new FakePlaybackEngine();
    render(<EffectDialog effectId="amplify" onClose={() => {}} engine={asEngine(fake)} />);
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    fake.stop.mockClear();
    fake.load.mockClear();

    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));

    expect(fake.stop).toHaveBeenCalled();
    expect(fake.load).toHaveBeenCalledWith(expect.objectContaining({ id: doc.id }));
  });

  it('apply() without a preview running does not call the engine at all', () => {
    seedActiveDoc();
    const fake = new FakePlaybackEngine();
    render(<EffectDialog effectId="amplify" onClose={() => {}} engine={asEngine(fake)} />);

    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));

    expect(fake.stop).not.toHaveBeenCalled();
    expect(fake.load).not.toHaveBeenCalled();
  });
});

describe('G5 glass header', () => {
  it('carries a lucide icon tile in the shell header', () => {
    seedActiveDoc();
    render(<EffectDialog effectId="amplify" onClose={() => {}} />);
    expect(screen.getByTestId('dialog-icon')).toBeInTheDocument();
  });
});
