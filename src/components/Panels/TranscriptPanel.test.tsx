import { FALLBACK_EDITOR_LANE_WIDTH } from '../../services/editorViewport';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import TranscriptPanel from './TranscriptPanel';
import {
  installTranscribeBackend,
  seedTranscript,
  voiceVector,
  type TranscribeBackend,
} from '../../__mocks__/transcribeBackend';
import { _resetTranscriptsForTest, getTranscript, DIARIZATION_LIMITS } from '../../services/transcribeService';
import { formatSrt } from '../../services/subtitleFormat';
import { registerDialogSetters } from '../../services/dialogBus';
import { createDocument, type AudioDocument } from '../../audio/AudioDocument';
import { useAppStore, makeInitialState } from '../../stores/appStore';
import { createClip, createTrack, type Session } from '../../multitrack/session';
import { useSessionStore } from '../../multitrack/sessionStore';
import { SPEAKER_COLORS } from '../Editor/transcriptLayout';

const EMBED_DIM = 8;
/** 3 s at 48 kHz = 1 s at the model rate, so 16 kHz cues up to 48000 fit. */
const DOC_LENGTH = 48000 * 3;

let backend: TranscribeBackend;
let openTranscribe: jest.Mock;

function seedDoc(): AudioDocument {
  const channels = [new Float32Array(DOC_LENGTH)];
  for (let i = 0; i < DOC_LENGTH; i++) channels[0][i] = Math.sin(i / 50) * 0.4;
  const doc = createDocument({ name: 'Interview.wav', sampleRate: 48000, channels });
  useAppStore.getState().addDocument(doc);
  useAppStore.getState().setActiveDocument(doc.id);
  return doc;
}

/** Two voices alternating over four one-second cues at the model rate. */
function twoSpeakerSegments() {
  return [0, 1, 2, 3].map((i) => ({
    index: i,
    startSample: i * 8000,
    endSample: (i + 1) * 8000,
    text: `line ${i}`,
    vector: voiceVector(EMBED_DIM, i % 2 === 0 ? 0 : 3, i + 1),
  }));
}

beforeEach(() => {
  useAppStore.setState(makeInitialState());
  _resetTranscriptsForTest();
  backend = installTranscribeBackend();
  openTranscribe = jest.fn();
  registerDialogSetters({
    openExportDialog: () => {},
    openNewFileDialog: () => {},
    openEffectDialog: () => {},
    openConvertDialog: () => {},
    openRecordDialog: () => {},
    openTempoDialog: () => {},
    openRemixDialog: () => {},
    openSeparateDialog: () => {},
    openTranscribeDialog: openTranscribe,
    openVoiceChangerDialog: () => {},
    openAlignTimingDialog: () => {},
    openVocalChainDialog: () => {},
    openCoverChainDialog: () => {},
    openPodcastChainDialog: () => {},
    openAlignLyricsDialog: () => {},
    focusRemixPanel: () => {},
    focusTranscriptPanel: () => {},
    focusSpatialPanel: () => {},
  });
});

afterEach(() => {
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

describe('TranscriptPanel — empty states', () => {
  it('says so with no document open', () => {
    render(<TranscriptPanel />);
    expect(screen.getByText('No document open.')).toBeInTheDocument();
  });

  it('offers the dialog when the document has no transcript', () => {
    seedDoc();
    render(<TranscriptPanel />);
    expect(screen.getByText('No transcript for this document.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Transcribe/ }));
    expect(openTranscribe).toHaveBeenCalledTimes(1);
  });

  it('says no speech was found rather than showing an empty list', async () => {
    const doc = seedDoc();
    await act(async () => {
      await seedTranscript(backend, doc.id, []);
    });
    render(<TranscriptPanel />);
    expect(screen.getByText('No speech was found in this document.')).toBeInTheDocument();
    expect(screen.queryByTestId('transcript-list')).not.toBeInTheDocument();
  });
});

describe('TranscriptPanel — the transcript', () => {
  let doc: AudioDocument;

  beforeEach(async () => {
    doc = seedDoc();
    await act(async () => {
      await seedTranscript(backend, doc.id, twoSpeakerSegments());
    });
  });

  // F11-8. The Transcript stopped being a module-strip entry (the user ruled
  // it a single tool, not a module) and the Transcribe tool now shows this
  // panel rather than the dialog once a transcript exists. That makes this
  // button load-bearing rather than decorative: it is the ONLY way back to the
  // dialog from here, and the stale banner has been telling the user to
  // "Transcribe again" with no control to do it with since F4b.
  it('offers Transcribe again, the one way back to the dialog once a transcript exists', () => {
    render(<TranscriptPanel />);
    const again = screen.getByTestId('transcript-retranscribe');
    expect(again).toHaveTextContent('Transcribe again…');
    fireEvent.click(again);
    expect(openTranscribe).toHaveBeenCalledTimes(1);
  });

  it('lists one row per segment with its text', () => {
    render(<TranscriptPanel />);
    const rows = screen.getAllByTestId('transcript-item');
    expect(rows).toHaveLength(4);
    expect(screen.getByText('line 0')).toBeInTheDocument();
    expect(screen.getByText('line 3')).toBeInTheDocument();
  });

  it('shows each row\'s start time in the DOCUMENT\'s timeline', () => {
    render(<TranscriptPanel />);
    // Model sample 8000 at 16 kHz = 0.5 s; the doc is 48 kHz, so 24000.
    const buttons = screen.getAllByTestId('transcript-goto');
    expect(buttons[0]).toHaveTextContent('0:00.000');
    expect(buttons[1]).toHaveTextContent('0:00.500');
  });

  it('labels the two speakers and colours them differently', () => {
    render(<TranscriptPanel />);
    const chips = screen.getAllByTestId('transcript-speaker');
    expect(chips[0]).toHaveTextContent('Speaker 1');
    expect(chips[1]).toHaveTextContent('Speaker 2');
    expect(chips[0].style.color).not.toBe(chips[1].style.color);
  });

  it('uses the shared speaker palette, so the ribbon and the list agree', () => {
    render(<TranscriptPanel />);
    const chips = screen.getAllByTestId('transcript-speaker');
    const rgb = (hex: string) => {
      const n = parseInt(hex.slice(1), 16);
      return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
    };
    expect(chips[0].style.color).toBe(rgb(SPEAKER_COLORS[0]));
    expect(chips[1].style.color).toBe(rgb(SPEAKER_COLORS[1]));
  });

  it('moves the cursor to a segment when its time is clicked', () => {
    render(<TranscriptPanel />);
    fireEvent.click(screen.getAllByTestId('transcript-goto')[2]);
    // Model sample 16000 -> 48000 document samples.
    expect(useAppStore.getState().cursorSample).toBe(48000);
  });

  it('leaves the multitrack view first, so the cursor jump is visible', () => {
    act(() => {
      useAppStore.getState().setView('multitrack');
    });
    render(<TranscriptPanel />);
    fireEvent.click(screen.getAllByTestId('transcript-goto')[1]);
    expect(useAppStore.getState().view).toBe('waveform');
  });

  // Lot E (item 4, N14) regression pin: the panel's leaver stays the RAW
  // `setView` — it jumps inside the transcript's document, so a foreign clip
  // selected in the session must not drag the active document along.
  it('keeps the transcript’s document active even with a foreign clip selected in the session', () => {
    const other = createDocument({
      name: 'Other.wav',
      sampleRate: 48000,
      channels: [new Float32Array(1000)],
    });
    act(() => {
      useAppStore.getState().addDocument(other);
      useAppStore.getState().setActiveDocument(doc.id);
    });
    const clip = createClip({ documentId: other.id, startSample: 0, offsetSample: 0, lengthSample: 500 });
    const track = createTrack('Track 1');
    track.clips = [clip];
    const session: Session = { name: 'Pin', sampleRate: 48000, tracks: [track] };
    useSessionStore.setState({
      session,
      selectedClipId: clip.id,
      selectedClipIds: [clip.id],
      mtCursorSample: 0,
      mtPlayState: 'stopped',
      mtPlayheadSample: 0,
      mtEnvelope: null,
    });
    act(() => {
      useAppStore.getState().setView('multitrack');
    });
    render(<TranscriptPanel />);
    fireEvent.click(screen.getAllByTestId('transcript-goto')[1]);
    expect(useAppStore.getState().view).toBe('waveform');
    expect(useAppStore.getState().activeDocumentId).toBe(doc.id);
  });

  it('re-centres the viewport on the clicked segment', () => {
    act(() => {
      useAppStore.getState().setZoom({ samplesPerPixel: 10, scrollSample: 0 });
    });
    render(<TranscriptPanel />);
    fireEvent.click(screen.getAllByTestId('transcript-goto')[3]);
    // F11 fix round: centred on the lane's MEASURED width (the documented
    // fallback here — nothing has published one in this suite) and clamped by
    // the store, instead of the old inline "~800px viewport" guess that
    // bypassed the clamp: 72000 - (1600 * 10) / 2.
    expect(useAppStore.getState().zoom.scrollSample).toBe(
      72000 - (FALLBACK_EDITOR_LANE_WIDTH * 10) / 2
    );
  });

  it('states the measured three-speaker accuracy rather than implying confidence', () => {
    render(<TranscriptPanel />);
    const note = screen.getByTestId('transcript-confidence-note');
    expect(note).toHaveTextContent(`${Math.round(DIARIZATION_LIMITS.threeSpeakerAccuracy * 100)}%`);
    expect(note).toHaveTextContent(`1–${DIARIZATION_LIMITS.reliableUpTo} speakers`);
  });

  it('reports the auto-detected count in the picker', () => {
    render(<TranscriptPanel />);
    expect(screen.getByTestId('transcript-speaker-count')).toHaveValue('auto');
    expect(screen.getByRole('option', { name: 'Detected: 2' })).toBeInTheDocument();
  });
});

describe('TranscriptPanel — the speaker-count control', () => {
  let doc: AudioDocument;

  beforeEach(async () => {
    doc = seedDoc();
    await act(async () => {
      await seedTranscript(backend, doc.id, twoSpeakerSegments());
    });
  });

  it('re-clusters to a forced count without another transcription run', async () => {
    render(<TranscriptPanel />);
    const before = backend.runCalls;
    fireEvent.change(screen.getByTestId('transcript-speaker-count'), { target: { value: '1' } });
    await waitFor(() => {
      expect(screen.getAllByTestId('transcript-speaker')[1]).toHaveTextContent('Speaker 1');
    });
    expect(backend.runCalls).toBe(before);
    expect(getTranscript(doc.id)?.speakerCount).toBe(1);
  });

  it('re-renders the list immediately, without a remount', async () => {
    render(<TranscriptPanel />);
    expect(screen.getAllByTestId('transcript-speaker')[1]).toHaveTextContent('Speaker 2');
    fireEvent.change(screen.getByTestId('transcript-speaker-count'), { target: { value: '1' } });
    await waitFor(() => {
      const labels = screen.getAllByTestId('transcript-speaker').map((e) => e.textContent);
      expect(new Set(labels).size).toBe(1);
    });
  });

  it('goes back to auto-detection', async () => {
    render(<TranscriptPanel />);
    fireEvent.change(screen.getByTestId('transcript-speaker-count'), { target: { value: '1' } });
    await waitFor(() => expect(getTranscript(doc.id)?.requestedSpeakerCount).toBe(1));
    fireEvent.change(screen.getByTestId('transcript-speaker-count'), { target: { value: 'auto' } });
    await waitFor(() => expect(getTranscript(doc.id)?.requestedSpeakerCount).toBeNull());
    expect(getTranscript(doc.id)?.speakerCount).toBe(2);
  });

  it('never offers a count the EVIDENCE cannot support', () => {
    // Four embedded segments: 5 and 6 are impossible, and offering them would
    // store a number the list below then contradicts.
    render(<TranscriptPanel />);
    expect(getTranscript(doc.id)?.maxUsableSpeakers).toBe(4);
    const options = Array.from(
      screen.getByTestId('transcript-speaker-count').querySelectorAll('option')
    ).map((o) => o.value);
    expect(options).toEqual(['auto', '1', '2', '3', '4']);
  });

  it('offers at most MAX_SPEAKERS however many segments were embedded', async () => {
    // Eight embeddable segments, but the clusterer only considers six.
    const many = seedDoc();
    await act(async () => {
      await seedTranscript(
        backend,
        many.id,
        Array.from({ length: 8 }, (_, i) => ({
          index: i,
          startSample: i * 4000,
          endSample: (i + 1) * 4000,
          text: `line ${i}`,
          vector: voiceVector(EMBED_DIM, i % 4, i + 1),
        }))
      );
    });
    act(() => {
      useAppStore.getState().setActiveDocument(many.id);
    });
    render(<TranscriptPanel />);
    const options = Array.from(
      screen.getByTestId('transcript-speaker-count').querySelectorAll('option')
    ).map((o) => o.value);
    expect(options).toEqual(['auto', '1', '2', '3', '4', '5', '6']);
  });
});

describe('TranscriptPanel — unknown speakers and staleness', () => {
  it('marks an unattributable segment Unknown instead of guessing', async () => {
    const doc = seedDoc();
    await act(async () => {
      // [A, ?, B] — the gap sits between two different voices.
      await seedTranscript(backend, doc.id, [
        { index: 0, startSample: 0, endSample: 8000, text: 'a', vector: voiceVector(EMBED_DIM, 0, 1) },
        { index: 1, startSample: 8000, endSample: 8200, text: 'short' },
        { index: 2, startSample: 8200, endSample: 16000, text: 'b', vector: voiceVector(EMBED_DIM, 3, 2) },
      ]);
    });
    render(<TranscriptPanel />);
    expect(screen.getAllByTestId('transcript-speaker')[1]).toHaveTextContent('Unknown');
    expect(screen.getByTestId('transcript-unknown-note')).toHaveTextContent('1 segment(s)');
  });

  it('says nothing about unknown speakers when there are none', async () => {
    const doc = seedDoc();
    await act(async () => {
      await seedTranscript(backend, doc.id, twoSpeakerSegments());
    });
    render(<TranscriptPanel />);
    expect(screen.queryByTestId('transcript-unknown-note')).not.toBeInTheDocument();
  });

  it('warns when the audio changed under the transcript, and keeps the transcript', async () => {
    const doc = seedDoc();
    await act(async () => {
      await seedTranscript(backend, doc.id, twoSpeakerSegments());
    });
    render(<TranscriptPanel />);
    expect(screen.queryByTestId('transcript-stale')).not.toBeInTheDocument();
    act(() => {
      useAppStore.getState().updateDocument({ ...doc, channels: [new Float32Array(DOC_LENGTH)] });
    });
    await waitFor(() => expect(screen.getByTestId('transcript-stale')).toBeInTheDocument());
    expect(screen.getAllByTestId('transcript-item')).toHaveLength(4);
  });
});

describe('TranscriptPanel — export', () => {
  let doc: AudioDocument;

  beforeEach(async () => {
    doc = seedDoc();
    await act(async () => {
      await seedTranscript(backend, doc.id, twoSpeakerSegments());
    });
  });

  it('writes SRT through the native save dialog', async () => {
    render(<TranscriptPanel />);
    fireEvent.click(screen.getByTestId('transcript-export-srt'));
    await waitFor(() => expect(backend.writeFile).toHaveBeenCalledTimes(1));
    expect(backend.showSaveDialog).toHaveBeenCalledWith(
      expect.objectContaining({ defaultPath: 'Interview.srt' })
    );
    const written = new TextDecoder().decode(new Uint8Array(backend.writeFile.mock.calls[0][1]));
    const transcript = getTranscript(doc.id)!;
    expect(written).toBe(formatSrt(transcript.segments, transcript.sampleRate));
  });

  it('writes WebVTT through the native save dialog', async () => {
    render(<TranscriptPanel />);
    fireEvent.click(screen.getByTestId('transcript-export-vtt'));
    await waitFor(() => expect(backend.writeFile).toHaveBeenCalledTimes(1));
    expect(backend.showSaveDialog).toHaveBeenCalledWith(
      expect.objectContaining({ defaultPath: 'Interview.vtt' })
    );
    const written = new TextDecoder().decode(new Uint8Array(backend.writeFile.mock.calls[0][1]));
    expect(written.startsWith('WEBVTT')).toBe(true);
  });

  it('exports the speaker labels the panel is showing', async () => {
    render(<TranscriptPanel />);
    fireEvent.click(screen.getByTestId('transcript-export-srt'));
    await waitFor(() => expect(backend.writeFile).toHaveBeenCalledTimes(1));
    const written = new TextDecoder().decode(new Uint8Array(backend.writeFile.mock.calls[0][1]));
    expect(written).toMatch(/Speaker 1: line 0/);
    expect(written).toMatch(/Speaker 2: line 1/);
  });

  it('exports the RE-CLUSTERED labels after the speaker count is changed', async () => {
    render(<TranscriptPanel />);
    fireEvent.change(screen.getByTestId('transcript-speaker-count'), { target: { value: '1' } });
    await waitFor(() => expect(getTranscript(doc.id)?.speakerCount).toBe(1));
    fireEvent.click(screen.getByTestId('transcript-export-srt'));
    await waitFor(() => expect(backend.writeFile).toHaveBeenCalledTimes(1));
    const written = new TextDecoder().decode(new Uint8Array(backend.writeFile.mock.calls[0][1]));
    expect(written).toMatch(/Speaker 1: line 1/);
    expect(written).not.toMatch(/Speaker 2/);
  });
});
