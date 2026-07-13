// Verifies the Jest moduleNameMapper swaps createSpectrogramWorker for the
// functional sync mock, and that the mock emits a `done` message whose grid
// matches the shared pure core.
import { createSpectrogramWorker } from './createSpectrogramWorker';
import { computeSpectrogramColumns } from './spectrogramCore';

interface Done {
  type: 'done';
  id: number;
  mags: Float32Array;
  width: number;
  height: number;
}

it('mock spectrogram worker replies `done` with a core-consistent grid', async () => {
  const SR = 44100;
  const channel = new Float32Array(8192);
  for (let n = 0; n < channel.length; n++) channel[n] = Math.sin((2 * Math.PI * 1000 * n) / SR);

  const worker = createSpectrogramWorker();
  const done = new Promise<Done>((resolve) => {
    worker.onmessage = (e: MessageEvent) => resolve(e.data as Done);
  });
  worker.postMessage({
    type: 'compute',
    id: 7,
    channel,
    sampleRate: SR,
    startSample: 0,
    endSample: 8192,
    width: 20,
    height: 64,
    fftSize: 2048,
  });

  const msg = await done;
  expect(msg.type).toBe('done');
  expect(msg.id).toBe(7);
  expect(msg.width).toBe(20);
  expect(msg.height).toBe(64);
  expect(msg.mags.length).toBe(20 * 64);

  const expected = computeSpectrogramColumns({
    channel,
    startSample: 0,
    endSample: 8192,
    width: 20,
    height: 64,
    fftSize: 2048,
  });
  expect(Array.from(msg.mags)).toEqual(Array.from(expected));

  worker.terminate();
});
