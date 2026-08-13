/**
 * VoiceChangerDialog (F3) — the consent affirmation's UI surface, the profile
 * list, the four-state model flow and the run lifecycle.
 *
 * THE CONSENT PINS live at the top: the checkbox is NEVER pre-checked, resets
 * when the chosen voice changes, and Convert/Save Voice stay disabled without
 * it. Removing the checkbox gate turns these red (the service and manager
 * layers pin their own gates independently).
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import VoiceChangerDialog from './VoiceChangerDialog';
import { registerDialogSetters } from '../../services/dialogBus';
import { createDocument } from '../../audio/AudioDocument';
import { useAppStore, makeInitialState } from '../../stores/appStore';
import {
  VOICE_MODEL_BYTES,
  TONE_EMBEDDING_SIZE,
  type VoiceProfile,
  type VoiceProgress,
} from '../../services/voiceService';

const mockService = {
  getVoiceModelState: jest.fn(),
  ensureVoiceModels: jest.fn(),
  convertDocumentVoice: jest.fn(),
  createVoiceProfile: jest.fn(),
  deleteVoiceProfile: jest.fn(),
  cancelVoiceRun: jest.fn(),
  ensureVoiceProfilesLoaded: jest.fn(),
  getVoiceProfiles: jest.fn(),
  getVoiceProfilesLoadError: jest.fn(),
  useVoiceVersion: jest.fn(),
};

jest.mock('../../services/voiceService', () => ({
  ...jest.requireActual('../../services/voiceService'),
  getVoiceModelState: (...a: unknown[]) => mockService.getVoiceModelState(...a),
  ensureVoiceModels: (...a: unknown[]) => mockService.ensureVoiceModels(...a),
  convertDocumentVoice: (...a: unknown[]) => mockService.convertDocumentVoice(...a),
  createVoiceProfile: (...a: unknown[]) => mockService.createVoiceProfile(...a),
  deleteVoiceProfile: (...a: unknown[]) => mockService.deleteVoiceProfile(...a),
  cancelVoiceRun: (...a: unknown[]) => mockService.cancelVoiceRun(...a),
  ensureVoiceProfilesLoaded: (...a: unknown[]) => mockService.ensureVoiceProfilesLoaded(...a),
  getVoiceProfiles: (...a: unknown[]) => mockService.getVoiceProfiles(...a),
  getVoiceProfilesLoadError: (...a: unknown[]) => mockService.getVoiceProfilesLoadError(...a),
  useVoiceVersion: (...a: unknown[]) => mockService.useVoiceVersion(...a),
}));

function makeProfile(id: string, name: string): VoiceProfile {
  return {
    id,
    name,
    embedding: new Float32Array(TONE_EMBEDDING_SIZE),
    createdAt: 1,
    sourceName: `${name}.wav`,
  };
}

function seedDoc(length = 48000): void {
  const doc = createDocument({
    name: 'Take 7.wav',
    sampleRate: 48000,
    channels: [new Float32Array(length).fill(0.1)],
  });
  useAppStore.getState().addDocument(doc);
}

let unregister: (() => void) | null = null;

beforeEach(() => {
  useAppStore.setState(makeInitialState());
  jest.clearAllMocks();
  mockService.getVoiceModelState.mockResolvedValue({
    downloaded: true,
    bytes: VOICE_MODEL_BYTES,
    expectedBytes: VOICE_MODEL_BYTES,
  });
  mockService.ensureVoiceModels.mockResolvedValue({ ok: true });
  mockService.ensureVoiceProfilesLoaded.mockResolvedValue(undefined);
  mockService.getVoiceProfiles.mockReturnValue([]);
  mockService.getVoiceProfilesLoadError.mockReturnValue(null);
  mockService.useVoiceVersion.mockReturnValue(0);
  mockService.cancelVoiceRun.mockResolvedValue(true);
  mockService.deleteVoiceProfile.mockResolvedValue({ ok: true, persistError: null });
  unregister = registerDialogSetters({
    openExportDialog: () => {},
    openNewFileDialog: () => {},
    openEffectDialog: () => {},
    openConvertDialog: () => {},
    openRecordDialog: () => {},
    openTempoDialog: () => {},
    openRemixDialog: () => {},
    openSeparateDialog: () => {},
    openTranscribeDialog: () => {},
    openVoiceChangerDialog: () => {},
    openAlignTimingDialog: () => {},
    openVocalChainDialog: () => {},
    openCoverChainDialog: () => {},
    openAlignLyricsDialog: () => {},
    focusRemixPanel: () => {},
    focusTranscriptPanel: () => {},
    focusSpatialPanel: () => {},
  });
});

afterEach(() => {
  unregister?.();
});

async function renderDialog(onClose = jest.fn()) {
  const utils = render(<VoiceChangerDialog onClose={onClose} />);
  await act(async () => {
    await Promise.resolve();
  });
  return { ...utils, onClose };
}

describe('THE CONSENT AFFIRMATION', () => {
  test('is NEVER pre-checked, and Convert stays disabled until the user sets it', async () => {
    seedDoc();
    mockService.getVoiceProfiles.mockReturnValue([makeProfile('voice-1', 'Alice')]);
    await renderDialog();

    fireEvent.click(screen.getByTestId('voice-profile-voice-1'));
    const checkbox = screen.getByTestId('voice-consent') as HTMLInputElement;
    expect(checkbox.checked).toBe(false); // never pre-checked — the ruling
    expect(checkbox.closest('label')?.textContent).toMatch(/I have the right to use this voice/);
    expect(screen.getByTestId('voice-convert')).toBeDisabled();

    fireEvent.click(checkbox);
    expect((screen.getByTestId('voice-consent') as HTMLInputElement).checked).toBe(true);
    expect(screen.getByTestId('voice-convert')).toBeEnabled();
  });

  test('is not even rendered before a voice is chosen', async () => {
    seedDoc();
    mockService.getVoiceProfiles.mockReturnValue([makeProfile('voice-1', 'Alice')]);
    await renderDialog();
    expect(screen.queryByTestId('voice-consent')).toBeNull();
    expect(screen.getByTestId('voice-convert')).toBeDisabled();
  });

  test('RESETS when the chosen voice changes — consent for Alice never covers Bob', async () => {
    seedDoc();
    mockService.getVoiceProfiles.mockReturnValue([
      makeProfile('voice-1', 'Alice'),
      makeProfile('voice-2', 'Bob'),
    ]);
    await renderDialog();
    fireEvent.click(screen.getByTestId('voice-profile-voice-1'));
    fireEvent.click(screen.getByTestId('voice-consent'));
    expect((screen.getByTestId('voice-consent') as HTMLInputElement).checked).toBe(true);

    fireEvent.click(screen.getByTestId('voice-profile-voice-2'));
    expect((screen.getByTestId('voice-consent') as HTMLInputElement).checked).toBe(false);
    expect(screen.getByTestId('voice-convert')).toBeDisabled();
  });

  test('the affirmation crosses into the service call as consentAffirmed: true', async () => {
    seedDoc();
    mockService.getVoiceProfiles.mockReturnValue([makeProfile('voice-1', 'Alice')]);
    mockService.convertDocumentVoice.mockResolvedValue({
      ok: true,
      docId: 'd2',
      docName: 'Take 7 — Alice voice',
      sanitisedSamples: 0,
    });
    const { onClose } = await renderDialog();
    fireEvent.click(screen.getByTestId('voice-profile-voice-1'));
    fireEvent.click(screen.getByTestId('voice-consent'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('voice-convert'));
    });
    expect(mockService.convertDocumentVoice).toHaveBeenCalledWith(
      expect.objectContaining({ profileId: 'voice-1', consentAffirmed: true })
    );
    expect(onClose).toHaveBeenCalled(); // clean success closes the dialog
  });

  test('Save Voice is gated exactly the same way', async () => {
    seedDoc(96000);
    useAppStore.getState().setSelection({ start: 0, end: 48000 });
    await renderDialog();
    fireEvent.click(screen.getByTestId('voice-add-selection'));
    expect((screen.getByTestId('voice-consent') as HTMLInputElement).checked).toBe(false);
    expect(screen.getByTestId('voice-save')).toBeDisabled();
    fireEvent.click(screen.getByTestId('voice-consent'));
    expect(screen.getByTestId('voice-save')).toBeEnabled();

    mockService.createVoiceProfile.mockResolvedValue({
      ok: true,
      profile: makeProfile('voice-1', 'Take 7 voice'),
      persistError: null,
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('voice-save'));
    });
    expect(mockService.createVoiceProfile).toHaveBeenCalledWith(
      expect.objectContaining({ consentAffirmed: true, sourceName: 'Take 7.wav (selection)' })
    );
  });
});

describe('model state flow', () => {
  test('missing model shows the download section; the button downloads and re-probes', async () => {
    seedDoc();
    mockService.getVoiceModelState
      .mockResolvedValueOnce({ downloaded: false, bytes: null, expectedBytes: VOICE_MODEL_BYTES })
      .mockResolvedValue({ downloaded: true, bytes: VOICE_MODEL_BYTES, expectedBytes: VOICE_MODEL_BYTES });
    await renderDialog();
    expect(screen.getByTestId('voice-model-missing').textContent).toMatch(/161 MB one-time download/);
    await act(async () => {
      fireEvent.click(screen.getByText('Download Model'));
    });
    expect(mockService.ensureVoiceModels).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByTestId('voice-model-missing')).toBeNull());
  });

  test('a failed download keeps the button and shows the error inline', async () => {
    seedDoc();
    mockService.getVoiceModelState.mockResolvedValue({
      downloaded: false,
      bytes: null,
      expectedBytes: VOICE_MODEL_BYTES,
    });
    mockService.ensureVoiceModels.mockResolvedValue({ ok: false, error: 'offline' });
    await renderDialog();
    await act(async () => {
      fireEvent.click(screen.getByText('Download Model'));
    });
    expect(screen.getByTestId('voice-error').textContent).toBe('offline');
    expect(screen.getByText('Download Model')).toBeInTheDocument();
  });

  test('a model-missing refusal from the service flips the dialog back to the download state', async () => {
    seedDoc();
    mockService.getVoiceProfiles.mockReturnValue([makeProfile('voice-1', 'Alice')]);
    mockService.convertDocumentVoice.mockResolvedValue({
      ok: false,
      status: 'model-missing',
      message: 'The voice model has not been downloaded yet.',
    });
    await renderDialog();
    fireEvent.click(screen.getByTestId('voice-profile-voice-1'));
    fireEvent.click(screen.getByTestId('voice-consent'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('voice-convert'));
    });
    expect(screen.getByTestId('voice-error').textContent).toMatch(/not been downloaded/);
    expect(screen.getByTestId('voice-model-missing')).toBeInTheDocument();
  });
});

describe('run lifecycle', () => {
  function deferredConvert() {
    let resolve!: (r: unknown) => void;
    mockService.convertDocumentVoice.mockImplementation(
      (req: { onProgress?: (p: VoiceProgress) => void }) =>
        new Promise((r) => {
          resolve = r;
          req.onProgress?.({
            phase: 'converting',
            done: 1,
            total: 2,
            fraction: 0.75,
            elapsedMs: 1000,
            estimatedRemainingMs: 30000,
          });
        })
    );
    return () => resolve;
  }

  test('while running: progress narrates the chunk loop and the footer is a single Cancel', async () => {
    seedDoc();
    mockService.getVoiceProfiles.mockReturnValue([makeProfile('voice-1', 'Alice')]);
    const getResolve = deferredConvert();
    await renderDialog();
    fireEvent.click(screen.getByTestId('voice-profile-voice-1'));
    fireEvent.click(screen.getByTestId('voice-consent'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('voice-convert'));
    });
    expect(screen.getByTestId('voice-progress-label').textContent).toBe('Converting — chunk 1 of 2 · 0:30 left');
    expect(screen.getByTestId('voice-progress').style.width).toBe('75%');
    expect(screen.queryByTestId('voice-convert')).toBeNull();

    fireEvent.click(screen.getByText('Cancel'));
    expect(mockService.cancelVoiceRun).toHaveBeenCalledTimes(1);
    await act(async () => {
      getResolve()({ ok: false, status: 'cancelled', message: 'The conversion was cancelled.' });
    });
    expect(screen.getByTestId('voice-error').textContent).toMatch(/cancelled/);
  });

  test('unmounting mid-run cancels the conversion', async () => {
    seedDoc();
    mockService.getVoiceProfiles.mockReturnValue([makeProfile('voice-1', 'Alice')]);
    const getResolve = deferredConvert();
    const { unmount } = await renderDialog();
    fireEvent.click(screen.getByTestId('voice-profile-voice-1'));
    fireEvent.click(screen.getByTestId('voice-consent'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('voice-convert'));
    });
    unmount();
    expect(mockService.cancelVoiceRun).toHaveBeenCalledTimes(1);
    await act(async () => {
      getResolve()({ ok: false, status: 'cancelled', message: 'cancelled' });
    });
  });

  test('a sanitised-samples result stays open with the honest note instead of silently closing', async () => {
    seedDoc();
    mockService.getVoiceProfiles.mockReturnValue([makeProfile('voice-1', 'Alice')]);
    mockService.convertDocumentVoice.mockResolvedValue({
      ok: true,
      docId: 'd2',
      docName: 'Take 7 — Alice voice',
      sanitisedSamples: 3,
    });
    const { onClose } = await renderDialog();
    fireEvent.click(screen.getByTestId('voice-profile-voice-1'));
    fireEvent.click(screen.getByTestId('voice-consent'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('voice-convert'));
    });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByTestId('voice-note').textContent).toMatch(/3 non-finite sample/);
  });
});

describe('profiles and references', () => {
  test('the honest-limits text quotes the measured numbers', async () => {
    seedDoc();
    await renderDialog();
    const limits = screen.getByTestId('voice-limits').textContent ?? '';
    expect(limits).toMatch(/not a forensic-grade clone/);
    expect(limits).toMatch(/1\.7 semitones/);
    expect(limits).toMatch(/27% at \+8\.1 semitones/);
  });

  test('from-selection is disabled without a selection; delete removes and deselects', async () => {
    seedDoc();
    mockService.getVoiceProfiles.mockReturnValue([makeProfile('voice-1', 'Alice')]);
    await renderDialog();
    expect(screen.getByTestId('voice-add-selection')).toBeDisabled();

    fireEvent.click(screen.getByTestId('voice-profile-voice-1'));
    fireEvent.click(screen.getByTestId('voice-delete-voice-1'));
    expect(mockService.deleteVoiceProfile).toHaveBeenCalledWith('voice-1');
    // Selection cleared with the profile — Convert cannot target a ghost.
    expect(screen.getByTestId('voice-convert')).toBeDisabled();
  });

  test('a failed save keeps the pending reference and shows the message', async () => {
    seedDoc(96000);
    useAppStore.getState().setSelection({ start: 0, end: 48000 });
    mockService.createVoiceProfile.mockResolvedValue({
      ok: false,
      status: 'bad-reference',
      message: 'The reference clip is too short.',
    });
    await renderDialog();
    fireEvent.click(screen.getByTestId('voice-add-selection'));
    fireEvent.click(screen.getByTestId('voice-consent'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('voice-save'));
    });
    expect(screen.getByTestId('voice-error').textContent).toMatch(/too short/);
    expect(screen.getByTestId('voice-pending')).toBeInTheDocument();
  });

  test('discarding a pending reference clears it without touching the service', async () => {
    seedDoc(96000);
    useAppStore.getState().setSelection({ start: 0, end: 48000 });
    await renderDialog();
    fireEvent.click(screen.getByTestId('voice-add-selection'));
    fireEvent.click(screen.getByTestId('voice-discard-reference'));
    expect(screen.queryByTestId('voice-pending')).toBeNull();
    expect(mockService.createVoiceProfile).not.toHaveBeenCalled();
  });
});
