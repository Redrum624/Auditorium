import { render } from '@testing-library/react';
import ClipView from './ClipView';
import { createDocument, type AudioDocument } from '../../audio/AudioDocument';
import { _resetClipWaveformCache } from './clipWaveformCache';
import type { Clip } from '../../multitrack/session';

// jsdom has no 2d backend (getContext returns null, which makes ClipView's
// draw effect bail before sizing the canvas), so install a minimal recording
// stub. ONE shared object serves both the on-screen canvas and the cache's
// offscreen canvas -- fine here, since the assertions only need the blit call
// and the canvas elements' width/height attributes.
let drawImage: jest.Mock;
let getContextSpy: jest.SpyInstance;

beforeEach(() => {
  _resetClipWaveformCache();
  drawImage = jest.fn();
  const fakeCtx = {
    setTransform: jest.fn(),
    clearRect: jest.fn(),
    fillRect: jest.fn(),
    drawImage,
    fillStyle: '',
  };
  getContextSpy = jest
    .spyOn(HTMLCanvasElement.prototype, 'getContext')
    .mockImplementation(() => fakeCtx as unknown as CanvasRenderingContext2D);
});

afterEach(() => {
  getContextSpy.mockRestore();
});

function seedDoc(lengthSamples: number): AudioDocument {
  const channel = new Float32Array(lengthSamples);
  for (let n = 0; n < channel.length; n++) channel[n] = Math.sin((2 * Math.PI * 220 * n) / 44100);
  return createDocument({ name: 'clip-src.wav', sampleRate: 44100, channels: [channel] });
}

function makeClip(lengthSample: number): Clip {
  return { id: 'clip-1', documentId: 'doc-1', startSample: 0, offsetSample: 0, lengthSample, gainDb: 0 };
}

function renderClip(doc: AudioDocument, clip: Clip, samplesPerPixel: number) {
  return render(
    <ClipView
      clip={clip}
      doc={doc}
      trackId="track-1"
      zoom={{ samplesPerPixel, scrollSample: 0 }}
      sessionRate={44100}
      laneHeight={64}
      selected={false}
      resolveTrackAt={() => null}
      onDragOverTrack={() => {}}
    />
  );
}

describe('ClipView waveform raster width cap (v1.5.2)', () => {
  // Both the on-screen canvas and the cached offscreen bitmap used to be
  // sized to the clip's FULL timeline pixel width (~7.6 MB per clip at
  // default zoom, ~30 MB at 4x, LRU-retained 200 deep). The raster is now
  // capped at 4096 device pixels and blit-scaled across the clip's CSS width.
  it('caps the drawn canvases at 4096 device pixels for a clip far wider than any viewport', () => {
    const doc = seedDoc(20000);
    // samplesPerPixel=1 -> the clip spans 20 000 timeline pixels.
    const { container } = renderClip(doc, makeClip(20000), 1);

    const canvas = container.querySelector('canvas') as HTMLCanvasElement;
    expect(canvas.width).toBeLessThanOrEqual(4096); // on-screen backing store
    expect(canvas.height).toBe(42); // laneHeight - 22, dpr 1 -- unchanged

    // The cached offscreen bitmap (drawImage's source) is capped too, and the
    // blit maps its FULL extent onto the FULL backing store -- the whole clip
    // range stretched across the whole clip element, so alignment survives.
    expect(drawImage).toHaveBeenCalled();
    const args = drawImage.mock.calls[drawImage.mock.calls.length - 1];
    const off = args[0] as HTMLCanvasElement;
    expect(off.width).toBeLessThanOrEqual(4096);
    expect(args.slice(1)).toEqual([0, 0, off.width, off.height, 0, 0, canvas.width, canvas.height]);
  });

  it('leaves clips narrower than the cap at their exact pixel width', () => {
    const doc = seedDoc(4410);
    // samplesPerPixel=44.1 -> 100 timeline pixels.
    const { container } = renderClip(doc, makeClip(4410), 44.1);

    const canvas = container.querySelector('canvas') as HTMLCanvasElement;
    expect(canvas.width).toBe(100);

    const args = drawImage.mock.calls[drawImage.mock.calls.length - 1];
    expect((args[0] as HTMLCanvasElement).width).toBe(100);
  });
});
