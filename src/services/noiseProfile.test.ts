import { renderHook, act } from '@testing-library/react';
import {
  captureNoiseProfile,
  getNoiseProfile,
  clearNoiseProfile,
  getNoiseProfileVersion,
  useNoiseProfileVersion,
} from './noiseProfile';
import { createDocument } from '../audio/AudioDocument';
import { stft } from '../dsp/stft';
import { useAppStore, makeInitialState } from '../stores/appStore';

const SR = 44100;
const FFT = 2048;
const HOP = 512;

function makeNoise(seedInit: number, amp: number): () => number {
  let seed = seedInit;
  return () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return (seed / 0x7fffffff - 0.5) * 2 * amp;
  };
}

function noiseBuffer(length: number, seed: number): Float32Array {
  const rand = makeNoise(seed, 0.05);
  const buf = new Float32Array(length);
  for (let n = 0; n < length; n++) buf[n] = rand();
  return buf;
}

function averageMagnitude(region: Float32Array): Float32Array {
  const { frames } = stft(region, FFT, HOP);
  const bins = FFT / 2 + 1;
  const avg = new Float32Array(bins);
  for (const fr of frames) for (let k = 0; k < bins; k++) avg[k] += fr[k];
  for (let k = 0; k < bins; k++) avg[k] /= frames.length;
  return avg;
}

beforeEach(() => {
  useAppStore.setState(makeInitialState());
  clearNoiseProfile();
});

describe('noiseProfile', () => {
  it('captures an averaged magnitude spectrum per channel from the selection', () => {
    const left = noiseBuffer(SR, 111);
    const right = noiseBuffer(SR, 222);
    const doc = createDocument({ name: 'noise.wav', sampleRate: SR, channels: [left, right] });
    useAppStore.getState().addDocument(doc);
    useAppStore.getState().setSelection({ start: 4096, end: 24576 });

    captureNoiseProfile();
    const profile = getNoiseProfile();
    expect(profile).not.toBeNull();
    expect(profile!.docSampleRate).toBe(SR);
    expect(profile!.spectra.length).toBe(2);
    for (const s of profile!.spectra) {
      expect(s.length).toBe(FFT / 2 + 1);
      for (const v of s) expect(v).toBeGreaterThanOrEqual(0);
    }

    // Matches a manual average over the same region for channel 0.
    const expected = averageMagnitude(left.subarray(4096, 24576));
    for (let k = 0; k < expected.length; k += 32) {
      expect(profile!.spectra[0][k]).toBeCloseTo(expected[k], 4);
    }
  });

  it('captures the whole document when there is no selection', () => {
    const mono = noiseBuffer(20000, 333);
    const doc = createDocument({ name: 'm.wav', sampleRate: SR, channels: [mono] });
    useAppStore.getState().addDocument(doc);
    // addDocument clears any selection.
    captureNoiseProfile();
    const profile = getNoiseProfile();
    expect(profile).not.toBeNull();
    expect(profile!.spectra.length).toBe(1);
  });

  it('is a no-op when no document is active', () => {
    captureNoiseProfile();
    expect(getNoiseProfile()).toBeNull();
  });

  it('clearNoiseProfile resets the stored profile', () => {
    const mono = noiseBuffer(8192, 444);
    const doc = createDocument({ name: 'm.wav', sampleRate: SR, channels: [mono] });
    useAppStore.getState().addDocument(doc);
    captureNoiseProfile();
    expect(getNoiseProfile()).not.toBeNull();
    clearNoiseProfile();
    expect(getNoiseProfile()).toBeNull();
  });

  it('records the docId the profile was captured from (Task F8)', () => {
    const mono = noiseBuffer(8192, 555);
    const doc = createDocument({ name: 'm.wav', sampleRate: SR, channels: [mono] });
    useAppStore.getState().addDocument(doc);
    captureNoiseProfile();
    expect(getNoiseProfile()!.docId).toBe(doc.id);
  });

  it('bumps the version on capture and on a clearing clear (Task F8)', () => {
    const mono = noiseBuffer(8192, 666);
    const doc = createDocument({ name: 'm.wav', sampleRate: SR, channels: [mono] });
    useAppStore.getState().addDocument(doc);

    const v0 = getNoiseProfileVersion();
    captureNoiseProfile();
    const v1 = getNoiseProfileVersion();
    expect(v1).toBeGreaterThan(v0);
    clearNoiseProfile();
    expect(getNoiseProfileVersion()).toBeGreaterThan(v1);
  });

  it('clearing an already-empty slot does not bump the version', () => {
    const v0 = getNoiseProfileVersion();
    clearNoiseProfile();
    expect(getNoiseProfileVersion()).toBe(v0);
  });

  it('useNoiseProfileVersion re-renders subscribers on capture/clear (Task F8)', () => {
    const mono = noiseBuffer(8192, 777);
    const doc = createDocument({ name: 'm.wav', sampleRate: SR, channels: [mono] });
    useAppStore.getState().addDocument(doc);

    const { result } = renderHook(() => useNoiseProfileVersion());
    const v0 = result.current;
    act(() => captureNoiseProfile());
    expect(result.current).toBeGreaterThan(v0);
    const v1 = result.current;
    act(() => clearNoiseProfile());
    expect(result.current).toBeGreaterThan(v1);
  });
});
