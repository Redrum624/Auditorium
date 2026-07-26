import {
  tempoRatio,
  checkTempoChange,
  applyTempoChange,
  detectRegionTempo,
  tempoQualityBand,
  MAX_BEAT_MARKERS,
  QUALITY_TRANSPARENT_MIN_RATIO,
  QUALITY_TRANSPARENT_MAX_RATIO,
  QUALITY_GOOD_MIN_RATIO,
  QUALITY_GOOD_MAX_RATIO,
} from './tempoService';
import { createDocument, docLength, type AudioDocument } from '../audio/AudioDocument';
import { useAppStore, makeInitialState } from '../stores/appStore';
import type { Marker } from '../stores/appStore';
import { getHistory, undo } from './undoHistory';
import { getTempo, clearAllTempo } from './tempoAnalysis';
import { MIN_RATIO, MAX_RATIO } from '../dsp/wsola';
import { resampleChannel } from '../dsp/resample';
import { fft } from '../dsp/fft';
import { registerAllEffects } from '../effects/registerAll';
import { _resetDspWorkerTestState, _setDspWorkerLoadFailure } from '../__mocks__/createDspWorkerMock';

// App.tsx registers effects at startup; tempoService's applyTempoChange goes
// through runEffectOnSelection('time-stretch', ...), which looks the effect
// up by id — mirror that startup step here (effectRunner.test.ts convention).
registerAllEffects();

const SR = 44100;

function sine(freq: number, seconds: number, amplitude = 1, sr = SR): Float32Array {
  const n = Math.round(seconds * sr);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amplitude * Math.sin((2 * Math.PI * freq * i) / sr);
  return out;
}

/** 441 Hz tone amplitude-modulated by a `bpm`-rate envelope (period 60/bpm
 * seconds), simulating percussive/musical content rather than a pure tone. */
function amSine(freq: number, bpm: number, seconds: number, sr = SR): Float32Array {
  const n = Math.round(seconds * sr);
  const out = new Float32Array(n);
  const beatHz = bpm / 60;
  for (let i = 0; i < n; i++) {
    const carrier = Math.sin((2 * Math.PI * freq * i) / sr);
    const env = 0.5 + 0.5 * Math.sin((2 * Math.PI * beatHz * i) / sr);
    out[i] = carrier * env;
  }
  return out;
}

/** A unit-impulse click train at `bpm` beats/minute (repo convention, mirrors
 * tempoCore.test.ts / tempoAnalysis.test.ts's own local copy). */
function clickTrain(bpm: number, seconds: number, sr = SR): Float32Array {
  const n = Math.round(seconds * sr);
  const out = new Float32Array(n);
  const interval = Math.round((60 / bpm) * sr);
  for (let i = 0; i < n; i += interval) out[i] = 1;
  return out;
}

/** Dominant frequency (Hz) via the FFT peak bin over a Hann-windowed
 * mid-signal slice — copied from pitchEffects.test.ts:55-75. */
function dominantFreq(x: Float32Array, sr: number, windowSize: number): number {
  const start = Math.max(0, Math.floor((x.length - windowSize) / 2));
  const re = new Float32Array(windowSize);
  const im = new Float32Array(windowSize);
  for (let i = 0; i < windowSize; i++) {
    const w = 0.5 * (1 - Math.cos((2 * Math.PI * i) / windowSize));
    re[i] = (x[start + i] ?? 0) * w;
  }
  fft(re, im);
  let maxMag = -1;
  let maxBin = 0;
  for (let k = 1; k < windowSize / 2; k++) {
    const mag = re[k] * re[k] + im[k] * im[k];
    if (mag > maxMag) {
      maxMag = mag;
      maxBin = k;
    }
  }
  return (maxBin * sr) / windowSize;
}

/** Interior slice [loFrac, hiFrac) of a signal, e.g. the interior 20-80%. */
function interiorSlice(x: Float32Array, loFrac: number, hiFrac: number): Float32Array {
  const lo = Math.floor(x.length * loFrac);
  const hi = Math.floor(x.length * hiFrac);
  return x.subarray(lo, hi);
}

function zeroCrossingRate(x: Float32Array, sr = SR): number {
  const start = Math.floor(x.length * 0.2);
  const end = Math.floor(x.length * 0.8);
  let count = 0;
  let prevSign = 0;
  for (let i = start; i < end; i++) {
    const s = x[i] > 0 ? 1 : x[i] < 0 ? -1 : 0;
    if (s !== 0) {
      if (prevSign !== 0 && s !== prevSign) count++;
      prevSign = s;
    }
  }
  const seconds = (end - start) / sr;
  return seconds > 0 ? count / seconds : 0;
}

function seedDoc(channels: Float32Array[], sampleRate = SR): AudioDocument {
  const doc = createDocument({ name: 'test.wav', sampleRate, channels });
  useAppStore.getState().addDocument(doc);
  return doc;
}

/** Re-reads a document by id from the live store (post-edit). */
function liveDoc(docId: string): AudioDocument {
  const doc = useAppStore.getState().documents.find((d) => d.id === docId);
  if (!doc) throw new Error(`liveDoc: not found: ${docId}`);
  return doc;
}

function liveMarkers(docId: string): Marker[] {
  return useAppStore.getState().markers[docId] ?? [];
}

function installShowMessageBox(): jest.Mock {
  const showMessageBox = jest.fn(async () => 0);
  (window as unknown as { electronAPI: { showMessageBox: typeof showMessageBox } }).electronAPI = {
    showMessageBox,
  };
  return showMessageBox;
}

beforeEach(() => {
  useAppStore.setState(makeInitialState());
  clearAllTempo();
  _resetDspWorkerTestState();
});

afterEach(() => {
  _resetDspWorkerTestState();
  delete (window as { electronAPI?: unknown }).electronAPI;
});

describe('tempoRatio', () => {
  it('is sourceBpm / targetBpm', () => {
    expect(tempoRatio(120, 90)).toBeCloseTo(4 / 3, 10);
    expect(tempoRatio(120, 160)).toBeCloseTo(0.75, 10);
    expect(tempoRatio(120, 120)).toBe(1);
  });
});

describe('applyTempoChange — duration exactness', () => {
  it('120->90 (ratio 4/3) stretches a whole-doc region to EXACTLY round(N*4/3)', async () => {
    const N = 352800; // 8s @ 44.1kHz
    const doc = seedDoc([sine(220, N / SR)]);
    const result = await applyTempoChange({ sourceBpm: 120, targetBpm: 90 });
    expect(result.ok).toBe(true);
    expect(docLength(liveDoc(doc.id))).toBe(470400);
  }, 15000);

  it('120->160 (ratio 0.75) stretches a whole-doc region to EXACTLY round(N*0.75)', async () => {
    const N = 352800;
    const doc = seedDoc([sine(220, N / SR)]);
    const result = await applyTempoChange({ sourceBpm: 120, targetBpm: 160 });
    expect(result.ok).toBe(true);
    expect(docLength(liveDoc(doc.id))).toBe(264600);
  }, 15000);

  it('120->127 (non-integral ratio) lands within 1 sample of round(N*ratio)', async () => {
    const N = 352800;
    const doc = seedDoc([sine(220, N / SR)]);
    const result = await applyTempoChange({ sourceBpm: 120, targetBpm: 127 });
    expect(result.ok).toBe(true);
    const expected = Math.round(N * (120 / 127));
    // Margin of 1: the ratio round-trips through stretchPercent = ratio*100
    // and back inside TimeStretchEffect, which can move the rounding
    // boundary by one sample for a non-integral target.
    expect(Math.abs(docLength(liveDoc(doc.id)) - expected)).toBeLessThanOrEqual(1);
  }, 15000);
});

describe('applyTempoChange — pitch preservation', () => {
  it('preserves 441 Hz through a 120->80 (ratio 1.5) stretch, with a discriminating resample control', async () => {
    const seconds = 3;
    const doc = seedDoc([amSine(441, 120, seconds)]);
    const result = await applyTempoChange({ sourceBpm: 120, targetBpm: 80 });
    expect(result.ok).toBe(true);

    const out = liveDoc(doc.id).channels[0];
    const interior = interiorSlice(out, 0.2, 0.8);
    const freq = dominantFreq(interior, SR, 16384);
    expect(Math.abs(freq - 441) / 441).toBeLessThan(0.02);

    // Zero-crossing rate over the interior must also read ~882/s (441 Hz),
    // within +/-8% (wsola.test.ts:101 convention).
    const zcr = zeroCrossingRate(out);
    expect(Math.abs(zcr - 882) / 882).toBeLessThan(0.08);

    // Discriminating control: a naive "resample to slow down" implementation
    // targeting the SAME 1.5x duration as the WSOLA output above (fix round
    // 1: `SR * 1.5`, not `SR / 1.5` — the latter produces a SHORTER buffer,
    // modelling a speed-UP rather than the slow-down under test here) drags
    // the pitch down proportionally instead of preserving it — it must NOT
    // read anywhere near 441 Hz, proving the test actually bites (a
    // resample-based implementation could never pass the assertions above).
    const fixture = amSine(441, 120, seconds);
    const control = resampleChannel(fixture, SR, SR * 1.5);
    const controlInterior = interiorSlice(control, 0.2, 0.8);
    const controlFreq = dominantFreq(controlInterior, SR, Math.min(16384, controlInterior.length));
    expect(Math.abs(controlFreq - 441) / 441).toBeGreaterThan(0.2);
  }, 15000);
});

describe('applyTempoChange — markers', () => {
  it('remaps interior/trailing markers proportionally and undo restores both audio length and marker positions', async () => {
    const N = 10000;
    const doc = seedDoc([sine(220, N / SR)]);
    const docId = doc.id;

    const before: Marker[] = [
      { id: 'm-1', name: 'at start', positionSample: 2000 }, // region start
      { id: 'm-2', name: '25% in', positionSample: 3500 }, // 25% into [2000,8000)
      { id: 'm-3', name: 'after region', positionSample: 9000 },
    ];
    useAppStore.getState().setMarkersForDoc(docId, before);
    useAppStore.getState().setSelection({ start: 2000, end: 8000 });

    const historyBefore = getHistory(docId);
    const result = await applyTempoChange({ sourceBpm: 120, targetBpm: 60 }); // ratio 2
    expect(result.ok).toBe(true);

    const newLen = docLength(liveDoc(docId));
    expect(newLen).toBe(10000 - 6000 + 12000); // region 6000 -> 12000

    const after = liveMarkers(docId);
    const byId = (id: string) => after.find((m) => m.id === id)!;
    expect(byId('m-1').positionSample).toBe(2000 + Math.round((2000 - 2000) * 2));
    expect(byId('m-2').positionSample).toBe(2000 + Math.round((3500 - 2000) * 2));
    expect(byId('m-3').positionSample).toBe(9000 + (12000 - 6000));
    for (const m of after) {
      expect(m.positionSample).toBeGreaterThanOrEqual(0);
      expect(m.positionSample).toBeLessThanOrEqual(newLen);
    }

    expect(getHistory(docId).done.length).toBe(historyBefore.done.length + 1);

    undo(docId);
    expect(docLength(liveDoc(docId))).toBe(N);
    const restored = liveMarkers(docId);
    expect(restored.map((m) => ({ id: m.id, pos: m.positionSample })).sort((a, b) => a.pos - b.pos)).toEqual(
      before.map((m) => ({ id: m.id, pos: m.positionSample })).sort((a, b) => a.pos - b.pos)
    );
  }, 15000);
});

describe('applyTempoChange — optional beat markers', () => {
  it('adds beat markers spaced 60/targetBpm*sampleRate as a SECOND, separately-labelled undo step', async () => {
    const seconds = 4;
    const doc = seedDoc([sine(220, seconds)]);
    const docId = doc.id;
    const firstBeatSample = 1000;

    const result = await applyTempoChange({
      sourceBpm: 120,
      targetBpm: 60, // ratio 2
      addBeatMarkers: true,
      firstBeatSample,
    });
    expect(result.ok).toBe(true);

    const history = getHistory(docId);
    expect(history.done).toEqual(['Effect: Time Stretch', 'Add Beat Markers']);

    const markers = liveMarkers(docId).filter((m) => m.name.startsWith('Beat '));
    expect(markers.length).toBeGreaterThan(1);

    const ratio = 2;
    const spacing = (60 / 60) * SR; // targetBpm=60 -> 1 beat/sec
    const newFirstBeat = 0 + Math.round((firstBeatSample - 0) * ratio);
    markers.forEach((m, i) => {
      expect(m.positionSample).toBe(newFirstBeat + Math.round(i * spacing));
      expect(m.name).toBe(`Beat ${i + 1}`);
    });

    // Undoing the SECOND entry only removes the beat markers, leaving the
    // stretch itself (and its own marker remap) intact.
    undo(docId);
    expect(liveMarkers(docId).filter((m) => m.name.startsWith('Beat ')).length).toBe(0);
    expect(getHistory(docId).done).toEqual(['Effect: Time Stretch']);
  }, 15000);

  it('caps beat markers at MAX_BEAT_MARKERS and shows one info dialog when truncated', async () => {
    const showMessageBox = installShowMessageBox();
    const seconds = 20;
    const doc = seedDoc([sine(220, seconds)]);
    const docId = doc.id;

    // targetBpm chosen so 1-beat spacing (60/targetBpm*sampleRate = 882
    // samples) is tiny relative to the 20s region, forcing far more than
    // MAX_BEAT_MARKERS candidate positions (~1200 uncapped).
    const result = await applyTempoChange({
      sourceBpm: 3600,
      targetBpm: 3000, // ratio 1.2, comfortably in range
      addBeatMarkers: true,
      firstBeatSample: 0,
    });
    expect(result.ok).toBe(true);

    const markers = liveMarkers(docId).filter((m) => m.name.startsWith('Beat '));
    expect(markers.length).toBe(MAX_BEAT_MARKERS);
    expect(showMessageBox).toHaveBeenCalledTimes(1);
    expect(showMessageBox.mock.calls[0][0]).toMatchObject({ type: 'info' });
  }, 15000);

  it('clamps a firstBeatSample below the region start instead of piling markers onto sample 0', async () => {
    const seconds = 4;
    const doc = seedDoc([sine(220, seconds)]);
    const docId = doc.id;
    useAppStore.getState().setSelection({ start: 20000, end: 20000 + 40000 });

    const result = await applyTempoChange({
      sourceBpm: 120,
      targetBpm: 60, // ratio 2
      addBeatMarkers: true,
      firstBeatSample: 500, // below the region's own start (20000)
    });
    expect(result.ok).toBe(true);

    const markers = liveMarkers(docId)
      .filter((m) => m.name.startsWith('Beat '))
      .sort((a, b) => a.positionSample - b.positionSample);
    expect(markers.length).toBeGreaterThan(1);
    // Exactly one marker at the (clamped) region start — not several piled
    // onto 0 by an un-clamped negative offset.
    expect(markers[0].positionSample).toBe(20000);
    expect(markers.filter((m) => m.positionSample === 0)).toHaveLength(0);
  }, 15000);
});

describe('applyTempoChange — the stretch never lands (fix round 1, CRITICAL)', () => {
  it('reports failure and adds no beat markers / no undo entry when the DSP worker fails to load', async () => {
    const seconds = 4;
    const doc = seedDoc([sine(220, seconds)]);
    const docId = doc.id;
    const lenBefore = docLength(liveDoc(docId));
    const historyBefore = getHistory(docId).done.length;

    _setDspWorkerLoadFailure('boom');
    const result = await applyTempoChange({
      sourceBpm: 120,
      targetBpm: 60, // ratio 2
      addBeatMarkers: true,
      firstBeatSample: 1000,
    });

    expect(result.ok).toBe(false);
    expect(docLength(liveDoc(docId))).toBe(lenBefore);
    expect(getHistory(docId).done.length).toBe(historyBefore);
    expect(liveMarkers(docId).filter((m) => m.name.startsWith('Beat '))).toHaveLength(0);
  }, 15000);

  it('PROBE-e1: still reports failure when an unrelated store action (add marker) fires during the failing stretch', async () => {
    // markDirty (appStore.ts) — and therefore addMarker/renameMarker/
    // removeMarker/a save-point clean — returns {...doc, dirty:true}: a NEW
    // document object with the SAME `channels` reference. Comparing the
    // whole document reference (fix round 1's original check) would read
    // this as "the stretch applied" even though it never did (fix round 2,
    // reviewer finding). A long stretch is exactly when a user has time to
    // do one of these ordinary actions.
    const seconds = 4;
    const doc = seedDoc([sine(220, seconds)]);
    const docId = doc.id;
    const lenBefore = docLength(liveDoc(docId));
    const historyBefore = getHistory(docId).done.length;

    _setDspWorkerLoadFailure('boom');
    const promise = applyTempoChange({
      sourceBpm: 120,
      targetBpm: 60, // ratio 2
      addBeatMarkers: true,
      firstBeatSample: 1000,
    });

    // Interleaved DURING the await, before the (failing) worker's own
    // microtask has a chance to run: an ordinary, unrelated marker add.
    useAppStore.getState().addMarker(docId, { id: 'user-marker', name: 'User Marker', positionSample: 500 });

    const result = await promise;

    expect(result.ok).toBe(false);
    expect(docLength(liveDoc(docId))).toBe(lenBefore);
    expect(getHistory(docId).done.length).toBe(historyBefore);
    expect(liveMarkers(docId).filter((m) => m.name.startsWith('Beat '))).toHaveLength(0);
    // The user's own concurrent action is not what this test is about losing
    // — only about not reporting a corrupted stretch as a success.
    expect(liveMarkers(docId).some((m) => m.id === 'user-marker')).toBe(true);
  });
});

describe('tempoQualityBand', () => {
  it('labels the ruled bands exactly (data, not prose-only, so the UI copy cannot drift)', () => {
    expect(tempoQualityBand(1)).toBe('transparent');
    expect(tempoQualityBand(QUALITY_TRANSPARENT_MIN_RATIO)).toBe('transparent');
    expect(tempoQualityBand(QUALITY_TRANSPARENT_MAX_RATIO)).toBe('transparent');
    expect(tempoQualityBand(0.6)).toBe('good');
    expect(tempoQualityBand(QUALITY_GOOD_MIN_RATIO)).toBe('good');
    expect(tempoQualityBand(QUALITY_GOOD_MAX_RATIO)).toBe('good');
    expect(tempoQualityBand(MIN_RATIO)).toBe('extreme');
    expect(tempoQualityBand(MAX_RATIO)).toBe('extreme');
    expect(tempoQualityBand(0.3)).toBe('extreme');
    expect(tempoQualityBand(3)).toBe('extreme');
  });
});

describe('checkTempoChange / applyTempoChange — guards', () => {
  it('refuses "no-document" when there is no active document', () => {
    expect(checkTempoChange({ sourceBpm: 120, targetBpm: 90 })).toEqual({
      ok: false,
      reason: 'no-document',
    });
  });

  it('refuses "invalid-bpm" for a non-finite/zero/negative bpm', () => {
    seedDoc([sine(220, 0.2)]);
    expect(checkTempoChange({ sourceBpm: 120, targetBpm: 0 })).toEqual({
      ok: false,
      reason: 'invalid-bpm',
    });
    expect(checkTempoChange({ sourceBpm: 0, targetBpm: 120 })).toEqual({
      ok: false,
      reason: 'invalid-bpm',
    });
    expect(checkTempoChange({ sourceBpm: NaN, targetBpm: 120 })).toEqual({
      ok: false,
      reason: 'invalid-bpm',
    });
    expect(checkTempoChange({ sourceBpm: 120, targetBpm: -5 })).toEqual({
      ok: false,
      reason: 'invalid-bpm',
    });
  });

  it('refuses "no-op" when source === target, and applyTempoChange leaves history untouched', async () => {
    const doc = seedDoc([sine(220, 0.2)]);
    expect(checkTempoChange({ sourceBpm: 120, targetBpm: 120 })).toEqual({
      ok: false,
      reason: 'no-op',
    });
    const before = getHistory(doc.id).done.length;
    const result = await applyTempoChange({ sourceBpm: 120, targetBpm: 120 });
    expect(result).toEqual({ ok: false, reason: 'no-op' });
    expect(getHistory(doc.id).done.length).toBe(before);
  });

  it('refuses "out-of-range" for 120->600 (ratio 0.2) and performs NO edit', async () => {
    const doc = seedDoc([sine(220, 0.2)]);
    expect(checkTempoChange({ sourceBpm: 120, targetBpm: 600 })).toEqual({
      ok: false,
      reason: 'out-of-range',
    });
    const before = getHistory(doc.id).done.length;
    const result = await applyTempoChange({ sourceBpm: 120, targetBpm: 600 });
    expect(result).toEqual({ ok: false, reason: 'out-of-range' });
    expect(getHistory(doc.id).done.length).toBe(before);
  });
});

describe('MIN_RATIO / MAX_RATIO boundary', () => {
  beforeEach(() => {
    seedDoc([sine(220, 0.2)]);
  });

  it('accepts ratio exactly MIN_RATIO (0.25) and exactly MAX_RATIO (4)', () => {
    expect(MIN_RATIO).toBe(0.25);
    expect(MAX_RATIO).toBe(4);
    // 30/120 = 0.25 exactly; 120/30 = 4 exactly.
    expect(checkTempoChange({ sourceBpm: 30, targetBpm: 120 })).toEqual({ ok: true, ratio: 0.25 });
    expect(checkTempoChange({ sourceBpm: 120, targetBpm: 30 })).toEqual({ ok: true, ratio: 4 });
  });

  it('rejects ratio 0.2499 and 4.001 as out-of-range', () => {
    // 2499/10000 = 0.2499
    expect(checkTempoChange({ sourceBpm: 2499, targetBpm: 10000 })).toEqual({
      ok: false,
      reason: 'out-of-range',
    });
    // 4001/1000 = 4.001
    expect(checkTempoChange({ sourceBpm: 4001, targetBpm: 1000 })).toEqual({
      ok: false,
      reason: 'out-of-range',
    });
  });
});

describe('detectRegionTempo', () => {
  it('returns bpm within 1 of 120 on a 60s click train, selection over seconds 10-30, without populating the shared cache', () => {
    const doc = seedDoc([clickTrain(120, 60)]);
    useAppStore.getState().setSelection({ start: 10 * SR, end: 30 * SR });

    const result = detectRegionTempo();
    expect(result).not.toBeNull();
    expect(result!.bpm).not.toBeNull();
    expect(Math.abs((result!.bpm as number) - 120)).toBeLessThanOrEqual(1);

    expect(getTempo(liveDoc(doc.id))).toBeNull();
  }, 15000);

  it('returns null when there is no active document', () => {
    expect(detectRegionTempo()).toBeNull();
  });
});
