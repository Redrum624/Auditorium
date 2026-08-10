import { act, fireEvent, render, screen } from '@testing-library/react';
import TranscriptRibbon from './TranscriptRibbon';
import {
  installTranscribeBackend,
  seedTranscript,
  voiceVector,
  type TranscribeBackend,
} from '../../__mocks__/transcribeBackend';
import { _resetTranscriptsForTest } from '../../services/transcribeService';
import { createDocument, type AudioDocument } from '../../audio/AudioDocument';
import { useAppStore, makeInitialState } from '../../stores/appStore';
import { speakerColor } from './transcriptLayout';

const EMBED_DIM = 8;
const DOC_LENGTH = 48000 * 3;
/** jsdom gives every element a 0x0 layout, so the lane's ResizeObserver would
 * read width 0 and cull everything. Pinning `clientWidth` is the only way to
 * exercise the layout at all — the same stand-in TimelineRuler-style
 * measurement needs. */
const LANE_WIDTH = 400;

let backend: TranscribeBackend;
let widthSpy: jest.SpyInstance;

function seedDoc(): AudioDocument {
  const channels = [new Float32Array(DOC_LENGTH)];
  const doc = createDocument({ name: 'Interview.wav', sampleRate: 48000, channels });
  useAppStore.getState().addDocument(doc);
  useAppStore.getState().setActiveDocument(doc.id);
  return doc;
}

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
  widthSpy = jest
    .spyOn(HTMLElement.prototype, 'clientWidth', 'get')
    .mockReturnValue(LANE_WIDTH);
  // jsdom has no ResizeObserver.
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
});

afterEach(() => {
  widthSpy.mockRestore();
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

describe('TranscriptRibbon', () => {
  it('renders nothing at all when the document has no transcript', () => {
    seedDoc();
    const { container } = render(<TranscriptRibbon />);
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when the transcript is empty (an untranscribed editor keeps its layout)', async () => {
    const doc = seedDoc();
    await act(async () => {
      await seedTranscript(backend, doc.id, []);
    });
    const { container } = render(<TranscriptRibbon />);
    expect(container.firstChild).toBeNull();
  });

  it('draws one region per visible segment', async () => {
    const doc = seedDoc();
    await act(async () => {
      await seedTranscript(backend, doc.id, twoSpeakerSegments());
    });
    act(() => {
      // 400 px x 400 samples/px = 160000 document samples visible; the whole
      // 144000-sample transcript fits.
      useAppStore.getState().setZoom({ samplesPerPixel: 400, scrollSample: 0 });
    });
    render(<TranscriptRibbon />);
    expect(screen.getAllByTestId('transcript-region')).toHaveLength(4);
  });

  it('positions and sizes each region from the zoom', async () => {
    const doc = seedDoc();
    await act(async () => {
      await seedTranscript(backend, doc.id, twoSpeakerSegments());
    });
    act(() => {
      useAppStore.getState().setZoom({ samplesPerPixel: 400, scrollSample: 0 });
    });
    render(<TranscriptRibbon />);
    const regions = screen.getAllByTestId('transcript-region');
    // Segment 1 spans model 8000..16000 = document 24000..48000, i.e. 60..120 px.
    expect(regions[1].style.left).toBe('60px');
    expect(regions[1].style.width).toBe('60px');
  });

  it('culls the segments scrolled out of view', async () => {
    const doc = seedDoc();
    await act(async () => {
      await seedTranscript(backend, doc.id, twoSpeakerSegments());
    });
    act(() => {
      // 400 px x 60 samples/px = 24000 samples: exactly the first cue's span.
      useAppStore.getState().setZoom({ samplesPerPixel: 60, scrollSample: 0 });
    });
    render(<TranscriptRibbon />);
    // Cue 0 covers [0, 24000) and cue 1 starts AT 24000, which is the first
    // sample of the next screenful — so exactly one region shows.
    expect(screen.getAllByTestId('transcript-region')).toHaveLength(1);
  });

  it('colours each region by speaker, matching the panel\'s palette', async () => {
    const doc = seedDoc();
    await act(async () => {
      await seedTranscript(backend, doc.id, twoSpeakerSegments());
    });
    act(() => {
      useAppStore.getState().setZoom({ samplesPerPixel: 400, scrollSample: 0 });
    });
    render(<TranscriptRibbon />);
    const regions = screen.getAllByTestId('transcript-region');
    expect(regions[0].dataset.speaker).toBe('0');
    expect(regions[1].dataset.speaker).toBe('1');
    const rgb = (hex: string) => {
      const n = parseInt(hex.slice(1), 16);
      return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
    };
    expect(regions[0].style.background).toBe(rgb(speakerColor(0)));
    expect(regions[1].style.background).toBe(rgb(speakerColor(1)));
  });

  it('marks an unattributed segment as unknown rather than colouring it as a speaker', async () => {
    const doc = seedDoc();
    await act(async () => {
      await seedTranscript(backend, doc.id, [
        { index: 0, startSample: 0, endSample: 8000, text: 'a', vector: voiceVector(EMBED_DIM, 0, 1) },
        { index: 1, startSample: 8000, endSample: 8200, text: 'short' },
        { index: 2, startSample: 8200, endSample: 16000, text: 'b', vector: voiceVector(EMBED_DIM, 3, 2) },
      ]);
    });
    act(() => {
      useAppStore.getState().setZoom({ samplesPerPixel: 400, scrollSample: 0 });
    });
    render(<TranscriptRibbon />);
    expect(screen.getAllByTestId('transcript-region')[1].dataset.speaker).toBe('unknown');
  });

  it('carries the segment text as the hover title', async () => {
    const doc = seedDoc();
    await act(async () => {
      await seedTranscript(backend, doc.id, twoSpeakerSegments());
    });
    act(() => {
      useAppStore.getState().setZoom({ samplesPerPixel: 400, scrollSample: 0 });
    });
    render(<TranscriptRibbon />);
    expect(screen.getAllByTestId('transcript-region')[2]).toHaveAttribute('title', 'line 2');
  });

  it('moves the cursor to the segment start when a region is clicked', async () => {
    const doc = seedDoc();
    await act(async () => {
      await seedTranscript(backend, doc.id, twoSpeakerSegments());
    });
    act(() => {
      useAppStore.getState().setZoom({ samplesPerPixel: 400, scrollSample: 0 });
    });
    render(<TranscriptRibbon />);
    fireEvent.click(screen.getAllByTestId('transcript-region')[2]);
    // Model 16000 -> document 48000.
    expect(useAppStore.getState().cursorSample).toBe(48000);
  });

  // The packaged-app order, and the one the jsdom tests above did NOT cover:
  // the editor mounts the ribbon on an UNtranscribed document (so it renders
  // null and there is no element to measure), and the transcript arrives
  // later. A width measurement installed by a `[]`-dependency effect never
  // re-runs, so the lane stays 0 px wide and every region is culled — the
  // ribbon silently draws nothing for the whole session. Found by the
  // packaged smoke run, pinned here.
  it('measures the lane when the transcript arrives AFTER the first render', async () => {
    const doc = seedDoc();
    act(() => {
      useAppStore.getState().setZoom({ samplesPerPixel: 400, scrollSample: 0 });
    });
    const { container } = render(<TranscriptRibbon />);
    expect(container.firstChild).toBeNull();

    await act(async () => {
      await seedTranscript(backend, doc.id, twoSpeakerSegments());
    });

    expect(screen.getAllByTestId('transcript-region')).toHaveLength(4);
    expect(screen.getAllByTestId('transcript-region')[1].style.left).toBe('60px');
  });

  it('writes NO markers into the store (the transcript is never persisted as cues)', async () => {
    const doc = seedDoc();
    await act(async () => {
      await seedTranscript(backend, doc.id, twoSpeakerSegments());
    });
    render(<TranscriptRibbon />);
    expect(useAppStore.getState().markers[doc.id] ?? []).toEqual([]);
  });
});
