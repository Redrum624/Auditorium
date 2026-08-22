import { useState } from 'react';
import { act, render, screen, fireEvent } from '@testing-library/react';
import EffectDialog from './EffectDialog';
import { DialogHostProvider } from './DialogHost';
import { registerAllEffects } from '../../effects/registerAll';
import { runEffectOnSelection } from '../../services/effectRunner';
import { deleteSelection } from '../../services/editOps';
import { captureNoiseProfile, clearNoiseProfile } from '../../services/noiseProfile';
import { useAppStore, makeInitialState } from '../../stores/appStore';
import { createDocument } from '../../audio/AudioDocument';
import type { PlaybackEngine } from '../../audio/PlaybackEngine';

// Item 6: the hosted variants need Apply's promise held open to observe the
// lock around it. The runner is a spy over the REAL implementation, so every
// pre-existing test in this file still runs the effect it always ran.
jest.mock('../../services/effectRunner', () => {
  const actual = jest.requireActual('../../services/effectRunner');
  return { ...actual, runEffectOnSelection: jest.fn(actual.runEffectOnSelection) };
});
const mockRun = runEffectOnSelection as jest.MockedFunction<typeof runEffectOnSelection>;
const realRun = jest.requireActual<typeof import('../../services/effectRunner')>(
  '../../services/effectRunner'
).runEffectOnSelection;

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

/** Item 6: the same dialog mounted as a CARD — the presentation App's module
 * column gives it. Copied from `DialogHost.test`'s `Hosted` harness: the
 * provider's presence is the whole instruction, the dialog is unchanged. */
function Hosted({
  engine,
  onModuleLockChange = () => {},
}: {
  engine: PlaybackEngine;
  onModuleLockChange?: (locked: boolean) => void;
}) {
  const [open, setOpen] = useState(true);
  return open ? (
    <DialogHostProvider onModuleLockChange={onModuleLockChange}>
      <EffectDialog effectId="amplify" onClose={() => setOpen(false)} engine={engine} />
    </DialogHostProvider>
  ) : null;
}

beforeEach(() => {
  useAppStore.setState(makeInitialState());
  clearNoiseProfile();
  mockRun.mockReset();
  mockRun.mockImplementation(realRun);
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

  it('Escape — modal branch, kept as the unwrapped contract — while previewing stops the engine and reloads the real active document', () => {
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

/**
 * Item 6 (2026-08-18): hosted in the module column. The card installs no
 * Escape handler (Escape belongs to the stage), so its ✕ is the dismissal and
 * has to carry the same engine restore Escape carried; and the module lock —
 * the strip greyed, the shortcuts suspended — is published during Apply only
 * (N16): Preview locks nothing, and a Cancel that could unmount the dialog
 * mid-apply would release the lock while the runner still commits.
 */
describe('hosted in the module column (item 6)', () => {
  it('hosted: ✕ while previewing restores the engine', () => {
    const doc = seedActiveDoc();
    const fake = new FakePlaybackEngine();
    render(<Hosted engine={asEngine(fake)} />);
    expect(screen.queryByTestId('dialog-overlay')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    fake.load.mockClear();

    fireEvent.click(screen.getByTestId('hosted-tool-close'));

    expect(fake.stop).toHaveBeenCalled();
    expect(fake.load).toHaveBeenCalledWith(expect.objectContaining({ id: doc.id }));
    expect(screen.queryByTestId('effect-dialog')).not.toBeInTheDocument();
  });

  it('hosted: Preview publishes no lock', () => {
    seedActiveDoc();
    const fake = new FakePlaybackEngine();
    const onModuleLockChange = jest.fn();
    render(<Hosted engine={asEngine(fake)} onModuleLockChange={onModuleLockChange} />);
    onModuleLockChange.mockClear();

    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));

    expect(onModuleLockChange).not.toHaveBeenCalledWith(true);
    expect(screen.getByTestId('hosted-tool-close')).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled();
  });

  it('hosted: Apply publishes lock true then false', async () => {
    seedActiveDoc();
    const fake = new FakePlaybackEngine();
    const onModuleLockChange = jest.fn();
    render(<Hosted engine={asEngine(fake)} onModuleLockChange={onModuleLockChange} />);
    onModuleLockChange.mockClear();
    mockRun.mockResolvedValueOnce('committed');

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    });

    // The shell publishes from a `useEffect` keyed on the lock, so React runs
    // the idle effect's cleanup (`false`) before the busy effect (`true`) —
    // a re-statement of the value already held. What matters is the
    // transition: from the moment Apply starts, exactly `true` then `false`,
    // and nothing before it ever said `true`.
    const calls = onModuleLockChange.mock.calls.map(([v]) => v);
    const up = calls.indexOf(true);
    expect(up).toBeGreaterThanOrEqual(0);
    expect(calls.slice(0, up).every((v) => v === false)).toBe(true);
    expect(calls.slice(up)).toEqual([true, false]);
    expect(screen.queryByTestId('effect-dialog')).not.toBeInTheDocument();
  });

  it('Cancel and ✕ refuse while busy', async () => {
    seedActiveDoc();
    const fake = new FakePlaybackEngine();
    let finish!: (v: 'committed') => void;
    mockRun.mockReturnValueOnce(new Promise<'committed'>((resolve) => (finish = resolve)));
    render(<Hosted engine={asEngine(fake)} />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    });

    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    expect(screen.getByTestId('hosted-tool-close')).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByTestId('hosted-tool-close'));
    expect(screen.getByTestId('effect-dialog')).toBeInTheDocument();

    await act(async () => {
      finish('committed');
    });
    expect(screen.queryByTestId('effect-dialog')).not.toBeInTheDocument();
  });
});

/**
 * Fix round 2 (round-1 finding 2): the card is not modal, so the mouse stays
 * live while Apply runs — the edit pill, the Edit menu, File › Close and the
 * Files panel can all change the document the runner resolved its region
 * against before the worker returns. The runner asks `shouldCancel` ONCE,
 * between the audio arriving and `applyEdit` writing it (T6-3's seam), and a
 * `true` commits nothing. The dialog answers for the document as the user
 * left it when they clicked Apply: same id, same audio, still the active one.
 */
describe('Apply against a document that moved under the worker (fix round 2)', () => {
  // Written out rather than imported, so the sentence the user reads is pinned.
  const STALE_HINT =
    'The document changed while the effect was running, so nothing was applied. Apply again to run it on the document as it is now.';

  /** Clicks Apply with the runner held open and returns the predicate it was
   * handed, plus the resolver that lets the run finish. */
  async function applyHeld() {
    let finish!: (v: 'committed' | 'cancelled') => void;
    mockRun.mockReturnValueOnce(
      new Promise<'committed' | 'cancelled'>((resolve) => (finish = resolve))
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    });
    const opts = mockRun.mock.calls[0][2];
    expect(opts?.shouldCancel).toBeDefined();
    return { shouldCancel: opts!.shouldCancel!, finish };
  }

  it('hands the runner a shouldCancel that is false while the document stands as it was — a metadata write does not trip it', async () => {
    const doc = seedActiveDoc();
    render(<Hosted engine={asEngine(new FakePlaybackEngine())} />);
    const { shouldCancel, finish } = await applyHeld();

    expect(shouldCancel()).toBe(false);
    // A rename or a dirty flag swaps the store's doc object but keeps its
    // audio — the `channels` reference, the same key Toolbar's engine load
    // uses to tell an audio edit from a metadata write.
    act(() => {
      useAppStore.getState().updateDocument({ ...doc, name: 'renamed.wav', dirty: true });
    });
    expect(shouldCancel()).toBe(false);

    await act(async () => {
      finish('committed');
    });
    expect(screen.queryByTestId('effect-dialog')).not.toBeInTheDocument();
  });

  it('answers true once the audio changed under it — a Delete, as the pill and the Edit menu run it', async () => {
    seedActiveDoc();
    useAppStore.getState().setSelection({ start: 0, end: 4096 });
    render(<Hosted engine={asEngine(new FakePlaybackEngine())} />);
    const { shouldCancel, finish } = await applyHeld();

    act(() => {
      deleteSelection();
    });
    expect(shouldCancel()).toBe(true);
    await act(async () => {
      finish('cancelled');
    });
  });

  it('answers true when another document became the active one', async () => {
    seedActiveDoc();
    render(<Hosted engine={asEngine(new FakePlaybackEngine())} />);
    const { shouldCancel, finish } = await applyHeld();

    act(() => {
      useAppStore.getState().addDocument(
        createDocument({ name: 'other.wav', sampleRate: 44100, channels: [new Float32Array(1024)] })
      );
    });
    expect(shouldCancel()).toBe(true);
    await act(async () => {
      finish('cancelled');
    });
  });

  it('answers true when the document was closed', async () => {
    const doc = seedActiveDoc();
    render(<Hosted engine={asEngine(new FakePlaybackEngine())} />);
    const { shouldCancel, finish } = await applyHeld();

    act(() => {
      useAppStore.getState().closeDocument(doc.id);
    });
    expect(shouldCancel()).toBe(true);
    await act(async () => {
      finish('cancelled');
    });
  });

  it('a cancelled Apply keeps the card open, releases the lock, and says nothing was applied', async () => {
    seedActiveDoc();
    const onModuleLockChange = jest.fn();
    render(
      <Hosted engine={asEngine(new FakePlaybackEngine())} onModuleLockChange={onModuleLockChange} />
    );
    onModuleLockChange.mockClear();
    mockRun.mockResolvedValueOnce('cancelled');

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    });

    expect(screen.getByTestId('effect-dialog')).toBeInTheDocument();
    expect(screen.getByTestId('effect-stale-hint')).toHaveTextContent(STALE_HINT);
    expect(screen.getByRole('button', { name: 'Apply' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled();
    expect(screen.getByTestId('hosted-tool-close')).toBeEnabled();
    // The shell publishes from a `useEffect` keyed on the lock: with the card
    // still mounted, the busy -> idle transition runs that effect's cleanup
    // AND its next run, both saying `false`. What matters is that the `true`
    // is followed by nothing but `false` — the lock is released, not held.
    const calls = onModuleLockChange.mock.calls.map(([v]) => v);
    const up = calls.indexOf(true);
    expect(up).toBeGreaterThanOrEqual(0);
    expect(calls.slice(up + 1).length).toBeGreaterThan(0);
    expect(calls.slice(up + 1).every((v) => v === false)).toBe(true);

    // Apply again: the hint clears while the run is held open, and a commit
    // closes the card exactly as it always did.
    let finish!: (v: 'committed') => void;
    mockRun.mockReturnValueOnce(new Promise<'committed'>((resolve) => (finish = resolve)));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    });
    expect(screen.queryByTestId('effect-stale-hint')).toBeNull();
    await act(async () => {
      finish('committed');
    });
    expect(screen.queryByTestId('effect-dialog')).not.toBeInTheDocument();
  });

  it('a refused Apply still closes the card — its failure dialog has already been shown', async () => {
    seedActiveDoc();
    render(<Hosted engine={asEngine(new FakePlaybackEngine())} />);
    mockRun.mockResolvedValueOnce('refused');

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    });

    expect(screen.queryByTestId('effect-dialog')).not.toBeInTheDocument();
    expect(screen.queryByTestId('effect-stale-hint')).toBeNull();
  });
});

describe('param derived readout (R2-2, v1.9.2)', () => {
  function seedDoc(lengthSamples: number, sampleRate = 44100) {
    const doc = createDocument({
      name: 'tone.wav',
      sampleRate,
      channels: [new Float32Array(lengthSamples)],
    });
    useAppStore.getState().addDocument(doc);
    return doc;
  }

  it('Fade Length shows the selection percentage as absolute time, and follows the typed value', () => {
    seedDoc(8192);
    // 4410 samples at 44.1 kHz = exactly 100 ms.
    act(() => useAppStore.getState().setSelection({ start: 1000, end: 5410 }));
    render(<EffectDialog effectId="fade" onClose={() => {}} />);

    // Default lengthPercent = 100 -> the whole 100 ms selection.
    expect(screen.getByTestId('effect-param-readout-lengthPercent')).toHaveTextContent('≈ 0:00.100');

    fireEvent.change(screen.getByLabelText('Length (% of selection)'), { target: { value: '50' } });
    expect(screen.getByTestId('effect-param-readout-lengthPercent')).toHaveTextContent('≈ 0:00.050');
  });

  it('falls back to the WHOLE document when nothing is selected — the runner fallback, not 0:00 (trap T11)', () => {
    seedDoc(44100); // 1 s, no selection
    render(<EffectDialog effectId="fade" onClose={() => {}} />);
    expect(screen.getByTestId('effect-param-readout-lengthPercent')).toHaveTextContent('≈ 0:01.000');
  });

  it('re-reads a selection made while the dialog is open instead of going stale', () => {
    seedDoc(44100);
    render(<EffectDialog effectId="fade" onClose={() => {}} />);
    expect(screen.getByTestId('effect-param-readout-lengthPercent')).toHaveTextContent('≈ 0:01.000');

    act(() => useAppStore.getState().setSelection({ start: 0, end: 22050 }));

    expect(screen.getByTestId('effect-param-readout-lengthPercent')).toHaveTextContent('≈ 0:00.500');
  });

  it('a param without the capability renders no readout element — existing effects are unchanged', () => {
    seedDoc(8192);
    render(<EffectDialog effectId="amplify" onClose={() => {}} />);
    expect(screen.queryByTestId('effect-param-readout-gainDb')).toBeNull();
    expect(screen.queryByText(/≈/)).toBeNull();
  });
});

describe('G5 glass header', () => {
  it('carries a lucide icon tile in the shell header', () => {
    seedActiveDoc();
    render(<EffectDialog effectId="amplify" onClose={() => {}} />);
    expect(screen.getByTestId('dialog-icon')).toBeInTheDocument();
  });
});
