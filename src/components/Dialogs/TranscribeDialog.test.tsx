import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import TranscribeDialog, { runLabel } from './TranscribeDialog';
import {
  installTranscribeBackend,
  voiceVector,
  type TranscribeBackend,
} from '../../__mocks__/transcribeBackend';
import {
  DIARIZATION_LIMITS,
  MAX_SPEAKERS,
  _resetTranscriptsForTest,
  getTranscript,
  isTranscribing,
  type TranscribeProgress,
} from '../../services/transcribeService';
import { registerDialogSetters } from '../../services/dialogBus';
import { createDocument, type AudioDocument } from '../../audio/AudioDocument';
import { useAppStore, makeInitialState } from '../../stores/appStore';

const EMBED_DIM = 8;
const DOC_LENGTH = 48000 * 3;

let backend: TranscribeBackend;
let focusTranscript: jest.Mock;

function seedDoc(): AudioDocument {
  const doc = createDocument({ name: 'Interview.wav', sampleRate: 48000, channels: [new Float32Array(DOC_LENGTH)] });
  useAppStore.getState().addDocument(doc);
  useAppStore.getState().setActiveDocument(doc.id);
  return doc;
}

/** Waits until the model-state probe has resolved and the dialog has settled
 * into its ready (or missing-model) state. */
async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  });
}

beforeEach(() => {
  useAppStore.setState(makeInitialState());
  _resetTranscriptsForTest();
  backend = installTranscribeBackend();
  focusTranscript = jest.fn();
  registerDialogSetters({
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
    focusTranscriptPanel: focusTranscript,
    focusSpatialPanel: () => {},
  });
});

afterEach(() => {
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

describe('TranscribeDialog — the honesty obligations', () => {
  it('offers the speaker count BEFORE the run, labelled with what auto is worth', async () => {
    seedDoc();
    render(<TranscribeDialog onClose={() => {}} />);
    await settle();
    const select = screen.getByTestId('transcribe-speakers');
    expect(select).toHaveValue('auto');
    expect(
      screen.getByRole('option', { name: `Detect automatically (reliable for 1–${DIARIZATION_LIMITS.reliableUpTo})` })
    ).toBeInTheDocument();
  });

  it('never offers a count the clusterer would clamp', async () => {
    seedDoc();
    render(<TranscribeDialog onClose={() => {}} />);
    await settle();
    const options = Array.from(screen.getByTestId('transcribe-speakers').querySelectorAll('option'));
    expect(options.map((o) => o.value)).toEqual([
      'auto',
      ...Array.from({ length: MAX_SPEAKERS }, (_, i) => String(i + 1)),
    ]);
  });

  it('states the measured three-speaker numbers, both of them', async () => {
    seedDoc();
    render(<TranscribeDialog onClose={() => {}} />);
    await settle();
    const note = screen.getByTestId('transcribe-diarization-note');
    expect(note).toHaveTextContent(`${Math.round(DIARIZATION_LIMITS.threeSpeakerAccuracy * 100)}%`);
    expect(note).toHaveTextContent(`${Math.round(DIARIZATION_LIMITS.threeSpeakerAccuracyWhenTold * 100)}%`);
  });

  it('says overlapping speech is not handled', async () => {
    seedDoc();
    render(<TranscribeDialog onClose={() => {}} />);
    await settle();
    expect(screen.getByTestId('transcribe-diarization-note')).toHaveTextContent(/Overlapping speech is not detected/);
  });

  it('says the count can be changed afterwards without re-transcribing', async () => {
    seedDoc();
    render(<TranscribeDialog onClose={() => {}} />);
    await settle();
    expect(screen.getByTestId('transcribe-diarization-note')).toHaveTextContent(
      /without transcribing again/
    );
  });
});

describe('TranscribeDialog — the model download', () => {
  it('states the size before starting, and offers the download', async () => {
    seedDoc();
    backend.modelDownloaded = false;
    render(<TranscribeDialog onClose={() => {}} />);
    await settle();
    expect(screen.getByTestId('transcribe-model-missing')).toHaveTextContent('323 MB');
    expect(screen.getByRole('button', { name: 'Download Models' })).toBeInTheDocument();
    // No Transcribe button while the models are missing.
    expect(screen.queryByRole('button', { name: 'Transcribe' })).not.toBeInTheDocument();
  });

  it('does not show the download block once the models are present', async () => {
    seedDoc();
    render(<TranscribeDialog onClose={() => {}} />);
    await settle();
    expect(screen.queryByTestId('transcribe-model-missing')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Transcribe' })).toBeEnabled();
  });
});

describe('TranscribeDialog — running', () => {
  it('disables Transcribe with no document open', async () => {
    render(<TranscribeDialog onClose={() => {}} />);
    await settle();
    expect(screen.getByRole('button', { name: 'Transcribe' })).toBeDisabled();
    expect(screen.getByTestId('transcribe-error')).toHaveTextContent('No document is open.');
  });

  it('swaps Close/Transcribe for a single Cancel while running', async () => {
    seedDoc();
    render(<TranscribeDialog onClose={() => {}} />);
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Transcribe' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Close' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Transcribe' })).not.toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    });
  });

  it('Cancel kills the run', async () => {
    seedDoc();
    render(<TranscribeDialog onClose={() => {}} />);
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Transcribe' }));
    await waitFor(() => expect(isTranscribing()).toBe(true));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    });
    await waitFor(() => expect(isTranscribing()).toBe(false));
    expect(backend.cancelCalls).toBe(1);
  });

  it('cancels an in-flight run when the dialog unmounts', async () => {
    seedDoc();
    const { unmount } = render(<TranscribeDialog onClose={() => {}} />);
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Transcribe' }));
    await waitFor(() => expect(isTranscribing()).toBe(true));
    await act(async () => {
      unmount();
    });
    await waitFor(() => expect(isTranscribing()).toBe(false));
    expect(backend.cancelCalls).toBe(1);
  });

  it('shows progress from the host', async () => {
    seedDoc();
    render(<TranscribeDialog onClose={() => {}} />);
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Transcribe' }));
    await waitFor(() => expect(isTranscribing()).toBe(true));
    await act(async () => {
      backend.emit.progress({ stage: 'transcribe', done: 24000, total: 48000 });
    });
    expect(screen.getByTestId('transcribe-progress-label')).toHaveTextContent('50%');
    expect(screen.getByTestId('transcribe-progress').style.width).toBe('50%');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    });
  });

  it('passes the chosen speaker count into the run', async () => {
    const doc = seedDoc();
    const onClose = jest.fn();
    render(<TranscribeDialog onClose={onClose} />);
    await settle();
    fireEvent.change(screen.getByTestId('transcribe-speakers'), { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: 'Transcribe' }));
    await waitFor(() => expect(isTranscribing()).toBe(true));
    await act(async () => {
      // THREE embedded segments, so a count of 3 is something the evidence
      // can actually support — one segment cannot be split three ways and is
      // now refused rather than silently downgraded.
      for (let i = 0; i < 3; i++) {
        backend.emit.segment({
          index: i,
          startSample: i * 8000,
          endSample: (i + 1) * 8000,
          text: `line ${i}`,
          avgLogprob: -0.3,
          noSpeechProb: 0.02,
          compressionRatio: 1.4,
        });
      }
      for (let i = 0; i < 3; i++) {
        const v = voiceVector(EMBED_DIM, i, i + 1);
        backend.emit.embedding({
          segmentIndex: i,
          vector: v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) as ArrayBuffer,
        });
      }
      backend.settle({ ok: true, segmentCount: 3 });
    });
    await waitFor(() => expect(getTranscript(doc.id)).not.toBeNull());
    expect(getTranscript(doc.id)?.requestedSpeakerCount).toBe(3);
  });

  it('shows the refusal inline when the audio cannot support the chosen count', async () => {
    // One embeddable segment, three speakers asked for: impossible, and the
    // dialog must say so rather than quietly transcribing with automatic
    // detection and letting the user believe they got what they picked.
    const doc = seedDoc();
    const onClose = jest.fn();
    render(<TranscribeDialog onClose={onClose} />);
    await settle();
    fireEvent.change(screen.getByTestId('transcribe-speakers'), { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: 'Transcribe' }));
    await waitFor(() => expect(isTranscribing()).toBe(true));
    await act(async () => {
      backend.emit.segment({
        index: 0,
        startSample: 0,
        endSample: 8000,
        text: 'a',
        avgLogprob: -0.3,
        noSpeechProb: 0.02,
        compressionRatio: 1.4,
      });
      const v = voiceVector(EMBED_DIM, 0, 1);
      backend.emit.embedding({
        segmentIndex: 0,
        vector: v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) as ArrayBuffer,
      });
      backend.settle({ ok: true, segmentCount: 1 });
    });
    await waitFor(() =>
      expect(screen.getByTestId('transcribe-error')).toHaveTextContent(/between 1 and 1/)
    );
    expect(onClose).not.toHaveBeenCalled();
    expect(getTranscript(doc.id)).toBeNull();
  });

  it('sends the user to the Transcript panel and closes on success', async () => {
    const doc = seedDoc();
    const onClose = jest.fn();
    render(<TranscribeDialog onClose={onClose} />);
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Transcribe' }));
    await waitFor(() => expect(isTranscribing()).toBe(true));
    await act(async () => {
      backend.settle({ ok: true, segmentCount: 0 });
    });
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(focusTranscript).toHaveBeenCalledTimes(1);
    expect(getTranscript(doc.id)).not.toBeNull();
  });

  it('shows a host failure inline and stays open', async () => {
    seedDoc();
    const onClose = jest.fn();
    render(<TranscribeDialog onClose={onClose} />);
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Transcribe' }));
    await waitFor(() => expect(isTranscribing()).toBe(true));
    await act(async () => {
      backend.settle({ ok: false, error: 'the host exploded' });
    });
    await waitFor(() => expect(screen.getByTestId('transcribe-error')).toHaveTextContent('the host exploded'));
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('runLabel', () => {
  function p(over: Partial<TranscribeProgress>): TranscribeProgress {
    return {
      phase: 'transcribing',
      done: 0,
      total: 0,
      fraction: 0,
      elapsedMs: 0,
      estimatedRemainingMs: null,
      ...over,
    };
  }

  it('names the resampling phase before anything is known', () => {
    expect(runLabel(null, null)).toBe('Preparing the audio…');
  });

  it('shows the percentage while transcribing', () => {
    expect(runLabel(p({ phase: 'transcribing', done: 1, total: 4, fraction: 0.25 }), null)).toBe(
      'Transcribing — 25%'
    );
  });

  it('counts segments, not samples, while embedding', () => {
    expect(runLabel(p({ phase: 'embedding', done: 2, total: 5 }), null)).toBe('Measuring voices — 2 of 5');
  });

  it('names the clustering phase', () => {
    expect(runLabel(p({ phase: 'clustering' }), null)).toBe('Grouping the voices…');
  });

  it('appends the remaining time when there is one', () => {
    expect(runLabel(p({ phase: 'transcribing', done: 1, total: 2, fraction: 0.5 }), 90000)).toBe(
      'Transcribing — 50% · 1:30 left'
    );
  });
});
