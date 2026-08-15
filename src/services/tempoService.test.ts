import {
  tempoRatio,
  checkTempoChange,
  checkVariableTempoChange,
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
import * as effectRunner from './effectRunner';
// Namespace import so `buildTempoMap` can be spied on at BOTH of its call sites
// — the service's plan and the effect's rebuild inside the worker mock, which
// runs in this same realm and therefore against this same module object.
import * as tempoMapModule from '../dsp/tempoMap';

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
    expect(history.done).toEqual(['Match Tempo', 'Add Beat Markers']);

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
    expect(getHistory(docId).done).toEqual(['Match Tempo']);
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

describe('applyTempoChange — beat grid at the CURRENT tempo (v1.9.1 item 2)', () => {
  it('no-op ratio WITH markers lays the grid at ratio 1, runs no stretch, pushes only the marker step', async () => {
    const seconds = 4;
    const doc = seedDoc([sine(220, seconds)]);
    const docId = doc.id;
    const lenBefore = docLength(liveDoc(docId));
    const channelsBefore = liveDoc(docId).channels[0];
    const firstBeatSample = 1000;

    const result = await applyTempoChange({
      sourceBpm: 120,
      targetBpm: 120, // ratio EXACTLY 1 -> checkTempoChange returns 'no-op'
      addBeatMarkers: true,
      firstBeatSample,
    });
    expect(result).toEqual({ ok: true });

    // No stretch ran: no 'Match Tempo' stretch entry (only the marker step),
    // the audio length is unchanged, and the channels array is the SAME
    // reference — a WSOLA pass at ratio 1 would have allocated a fresh one via
    // replaceRegion and seamed both region edges.
    expect(getHistory(docId).done).toEqual(['Add Beat Markers']);
    expect(docLength(liveDoc(docId))).toBe(lenBefore);
    expect(liveDoc(docId).channels[0]).toBe(channelsBefore);

    // The grid lands on the CURRENT tempo's beats: spacing 60/targetBpm*SR,
    // starting at firstBeatSample verbatim (ratio 1 -> newFirstBeat === it).
    const markers = liveMarkers(docId)
      .filter((m) => m.name.startsWith('Beat '))
      .sort((a, b) => a.positionSample - b.positionSample);
    expect(markers.length).toBeGreaterThan(1);
    const spacing = (60 / 120) * SR;
    markers.forEach((m, i) => {
      expect(m.positionSample).toBe(firstBeatSample + Math.round(i * spacing));
      expect(m.name).toBe(`Beat ${i + 1}`);
    });

    // The single marker step undoes cleanly.
    undo(docId);
    expect(liveMarkers(docId).filter((m) => m.name.startsWith('Beat '))).toHaveLength(0);
    expect(getHistory(docId).done).toEqual([]);
  }, 15000);

  it('no-op ratio WITHOUT markers is still refused with no-op, lays nothing, runs no stretch (trap T1)', async () => {
    const doc = seedDoc([sine(220, 4)]);
    const docId = doc.id;
    const lenBefore = docLength(liveDoc(docId));
    const before = getHistory(docId).done.length;

    const result = await applyTempoChange({ sourceBpm: 120, targetBpm: 120 });

    expect(result).toEqual({ ok: false, reason: 'no-op' });
    expect(getHistory(docId).done.length).toBe(before);
    expect(docLength(liveDoc(docId))).toBe(lenBefore);
    expect(liveMarkers(docId).filter((m) => m.name.startsWith('Beat '))).toHaveLength(0);
  });

  it('no-op ratio with markers requested but NO firstBeatSample refuses and lays nothing', async () => {
    const doc = seedDoc([sine(220, 4)]);
    const docId = doc.id;
    const before = getHistory(docId).done.length;

    const result = await applyTempoChange({
      sourceBpm: 120,
      targetBpm: 120,
      addBeatMarkers: true,
      firstBeatSample: null,
    });

    expect(result.ok).toBe(false);
    expect(getHistory(docId).done.length).toBe(before);
    expect(liveMarkers(docId).filter((m) => m.name.startsWith('Beat '))).toHaveLength(0);
  });
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

// ---------------------------------------------------------------------------
// R7 — the OPT-IN variable-rate path
// ---------------------------------------------------------------------------

/** A confirmed grid that ACCELERATES: intervals shrink from `bpmStart` to
 * `bpmEnd` over `seconds`. Document-absolute, as `BeatGrid.beatSamples` is. */
function accelGrid(bpmStart: number, bpmEnd: number, seconds: number, sr = SR): number[] {
  const beats: number[] = [];
  let t = 0;
  while (t < seconds) {
    beats.push(Math.round(t * sr));
    t += 60 / (bpmStart + (bpmEnd - bpmStart) * (t / seconds));
  }
  return beats;
}

/** An exactly even grid at `bpm`. */
function evenGrid(bpm: number, seconds: number, sr = SR): number[] {
  const beats: number[] = [];
  const spacing = (60 / bpm) * sr;
  for (let i = 0; i * spacing < seconds * sr; i++) beats.push(Math.round(i * spacing));
  return beats;
}

describe('R7 — the default is unchanged, and that is what keeps this a minor', () => {
  it('a request WITHOUT variableRate never reaches the new code', async () => {
    const seconds = 4;
    const doc = seedDoc([sine(220, seconds)]);
    const before = docLength(liveDoc(doc.id));

    const result = await applyTempoChange({ sourceBpm: 120, targetBpm: 60 });
    expect(result.ok).toBe(true);
    // The constant path's exact contract: round(N * source/target).
    expect(docLength(liveDoc(doc.id))).toBe(Math.round(before * 2));
    expect(getHistory(doc.id).done).toEqual(['Match Tempo']);
  }, 20000);

  it('and the constant path still refuses a no-op ratio, grid or no grid', async () => {
    const doc = seedDoc([sine(220, 2)]);
    const before = docLength(liveDoc(doc.id));
    const result = await applyTempoChange({ sourceBpm: 120, targetBpm: 120 });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('no-op');
    expect(docLength(liveDoc(doc.id))).toBe(before);
  });
});

describe('checkVariableTempoChange — guards and the plan', () => {
  it('refuses with no document', () => {
    const check = checkVariableTempoChange({
      sourceBpm: 110,
      targetBpm: 110,
      variableRate: { beatSamples: [0, 1000] },
    });
    expect(check.ok).toBe(false);
    expect(check.ok === false && check.reason).toBe('no-document');
  });

  it('refuses without a variableRate request at all', () => {
    seedDoc([sine(220, 2)]);
    const check = checkVariableTempoChange({ sourceBpm: 110, targetBpm: 110 });
    expect(check.ok).toBe(false);
    expect(check.ok === false && check.reason).toBe('no-grid');
  });

  it.each([
    ['zero', 0],
    ['negative', -10],
    ['non-finite', Number.NaN],
  ])('refuses a %s target BPM', (_label, targetBpm) => {
    seedDoc([sine(220, 2)]);
    const check = checkVariableTempoChange({
      sourceBpm: 110,
      targetBpm,
      variableRate: { beatSamples: [0, 1000, 2000] },
    });
    expect(check.ok).toBe(false);
    expect(check.ok === false && check.reason).toBe('invalid-bpm');
  });

  it('refuses a grid with fewer than two beats INSIDE the region', () => {
    seedDoc([sine(220, 2)]);
    // One beat in range, one far past the end.
    const check = checkVariableTempoChange({
      sourceBpm: 110,
      targetBpm: 110,
      variableRate: { beatSamples: [1000, 10 * SR] },
    });
    expect(check.ok).toBe(false);
    expect(check.ok === false && check.reason).toBe('no-grid');
  });

  it('does NOT refuse source === target — that is the CENTRAL use of this path', () => {
    // The constant path calls this a no-op, correctly: one ratio of 1.0 does
    // nothing. A variable-rate pass at MEAN ratio 1 moves every interior beat,
    // which is exactly what varying material needs.
    seedDoc([sine(220, 8)]);
    const check = checkVariableTempoChange({
      sourceBpm: 110,
      targetBpm: 110,
      variableRate: { beatSamples: accelGrid(100, 120, 8) },
    });
    expect(check.ok).toBe(true);
    expect(check.ok && check.plan.beatCount).toBeGreaterThan(10);
  });

  it('DOES report a no-op when the grid genuinely already matches the target', () => {
    seedDoc([sine(220, 8)]);
    const check = checkVariableTempoChange({
      sourceBpm: 120,
      targetBpm: 120,
      variableRate: { beatSamples: evenGrid(120, 8) },
    });
    expect(check.ok).toBe(false);
    expect(check.ok === false && check.reason).toBe('no-op');
  });

  it('scopes the grid to the SELECTION, not the document', () => {
    const doc = seedDoc([sine(220, 8)]);
    const all = accelGrid(100, 120, 8);
    const whole = checkVariableTempoChange({
      sourceBpm: 110,
      targetBpm: 110,
      variableRate: { beatSamples: all },
    });
    useAppStore.getState().setSelection({ start: 2 * SR, end: 4 * SR });
    const scoped = checkVariableTempoChange({
      sourceBpm: 110,
      targetBpm: 110,
      variableRate: { beatSamples: all },
    });
    expect(whole.ok).toBe(true);
    expect(scoped.ok).toBe(true);
    expect(scoped.ok && scoped.plan.beatCount).toBeLessThan((whole.ok && whole.plan.beatCount) as number);
    expect(scoped.ok && scoped.plan.regionLength).toBe(2 * SR);
    // Region-relative: the first beat handed to the effect is measured from
    // the selection start, not from sample 0.
    expect(scoped.ok && scoped.plan.extra.beatSamples[0]).toBeLessThan(SR);
  });

  it('reports the clamp count rather than silently under-delivering', () => {
    seedDoc([sine(220, 8)]);
    // A grid at 120 BPM asked to become 20 BPM needs ratio 6 > MAX_RATIO 4.
    const check = checkVariableTempoChange({
      sourceBpm: 120,
      targetBpm: 20,
      variableRate: { beatSamples: evenGrid(120, 8) },
    });
    expect(check.ok).toBe(true);
    if (!check.ok) return;
    expect(check.plan.clampedCount).toBe(check.plan.beatCount - 1);
    expect(check.plan.map.maxLocalRatio).toBeCloseTo(MAX_RATIO, 6);
  });

  it('the target spacing it hands the worker is NOT rounded', () => {
    seedDoc([sine(220, 8)]);
    const check = checkVariableTempoChange({
      sourceBpm: 110,
      targetBpm: 111,
      variableRate: { beatSamples: accelGrid(100, 120, 8) },
    });
    expect(check.ok).toBe(true);
    if (!check.ok) return;
    const exact = (60 / 111) * SR;
    expect(check.plan.extra.targetSpacing).toBe(exact);
    expect(Number.isInteger(check.plan.extra.targetSpacing)).toBe(false);
  });
});

describe('applyTempoChange — the variable path end to end', () => {
  it('stretches through the worker and lands the plan’s own outLength', async () => {
    const seconds = 8;
    const doc = seedDoc([amSine(441, 110, seconds)]);
    const docId = doc.id;
    const grid = accelGrid(100, 120, seconds);

    const check = checkVariableTempoChange({
      sourceBpm: 110,
      targetBpm: 110,
      variableRate: { beatSamples: grid },
    });
    expect(check.ok).toBe(true);
    if (!check.ok) return;

    const result = await applyTempoChange({
      sourceBpm: 110,
      targetBpm: 110,
      variableRate: { beatSamples: grid },
    });
    expect(result.ok).toBe(true);
    // The plan previewed the length the run produced — the preview and the
    // worker build the map from the same pure function on the same inputs.
    expect(docLength(liveDoc(docId))).toBe(check.plan.outLength);
    expect(getHistory(docId).done).toEqual(['Match Tempo']);
  }, 30000);

  it('preserves pitch (the whole point of using WSOLA rather than resampling)', async () => {
    const seconds = 8;
    const doc = seedDoc([sine(441, seconds)]);
    const docId = doc.id;
    const before = dominantFreq(liveDoc(docId).channels[0], SR, 8192);

    const result = await applyTempoChange({
      sourceBpm: 110,
      targetBpm: 118,
      variableRate: { beatSamples: accelGrid(100, 120, seconds) },
    });
    expect(result.ok).toBe(true);
    const after = dominantFreq(liveDoc(docId).channels[0], SR, 8192);
    expect(Math.abs(after - before)).toBeLessThan(15);
  }, 30000);

  it('reports failure and writes NOTHING when the stretch never lands', async () => {
    // The fix-round-1 CRITICAL, re-armed for the new path: a worker load
    // failure must not report success and must not write a beat grid
    // describing a tempo change that never happened.
    const seconds = 8;
    const doc = seedDoc([sine(220, seconds)]);
    const docId = doc.id;
    const before = docLength(liveDoc(docId));
    _setDspWorkerLoadFailure('boom');

    const result = await applyTempoChange({
      sourceBpm: 110,
      targetBpm: 130,
      addBeatMarkers: true,
      variableRate: { beatSamples: accelGrid(100, 120, seconds) },
    });
    expect(result.ok).toBe(false);
    expect(docLength(liveDoc(docId))).toBe(before);
    expect(liveMarkers(docId).filter((m) => m.name.startsWith('Beat '))).toHaveLength(0);
    expect(getHistory(docId).done).toEqual([]);
  }, 30000);

  it('refuses before touching the document when the grid is unusable', async () => {
    const doc = seedDoc([sine(220, 4)]);
    const before = docLength(liveDoc(doc.id));
    const result = await applyTempoChange({
      sourceBpm: 110,
      targetBpm: 130,
      variableRate: { beatSamples: [500] },
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('no-grid');
    expect(docLength(liveDoc(doc.id))).toBe(before);
    expect(getHistory(doc.id).done).toEqual([]);
  });
});

/**
 * W1-5 — the resolved region that collapsed to nothing.
 *
 * The chains refuse `end <= start` outright (test-pinned, `runVocalChain` /
 * `runCoverChain` resolve `null`); the tempo paths did not. The constant path
 * ran the whole way through: `planStretch` returns its 'empty' plan,
 * `replaceRegion` allocates fresh channel arrays holding the same samples, the
 * `postDoc.channels !== doc.channels` gate reads that fresh allocation as
 * "applied", and the call returned `{ok: true}` with a 'Match Tempo' undo entry
 * pushed and the document dirtied for an edit that changed nothing.
 */
describe('applyTempoChange — a selection that clamps to an empty region', () => {
  const SECONDS = 2;
  const LEN = SECONDS * SR;

  function seedAndSelect(sel: { start: number; end: number }): AudioDocument {
    const doc = seedDoc([sine(220, SECONDS)]);
    useAppStore.getState().setSelection(sel);
    return doc;
  }

  it.each([
    ['entirely past the end', { start: LEN, end: LEN * 3 }],
    ['starting past the end', { start: LEN + 5000, end: LEN * 3 }],
    ['entirely below zero', { start: -9000, end: -5000 }],
  ])('refuses the constant path and commits nothing (%s)', async (_label, sel) => {
    const doc = seedAndSelect(sel);
    const channelsBefore = liveDoc(doc.id).channels;

    const result = await applyTempoChange({ sourceBpm: 110, targetBpm: 130 });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('empty-region');
    // Not merely "the length is the same": the exact pre-call channel arrays
    // are still in the store, so no `replaceRegion` allocation happened at all.
    expect(liveDoc(doc.id).channels).toBe(channelsBefore);
    expect(liveDoc(doc.id).dirty).toBe(false);
    expect(getHistory(doc.id).done).toEqual([]);
  });

  it('refuses the variable path by the same name, before the map is built', async () => {
    const doc = seedAndSelect({ start: LEN, end: LEN * 3 });
    const channelsBefore = liveDoc(doc.id).channels;
    const req = {
      sourceBpm: 110,
      targetBpm: 130,
      variableRate: { beatSamples: accelGrid(100, 120, SECONDS) },
    };

    // `buildTempoMap` already refused this by its own `inLen <= 0` arm, so the
    // effect never ran — but it reported `'no-grid'`, blaming a grid that was
    // fine. The plan the dialog previews and the outcome Apply returns now
    // agree, and both name the region.
    const check = checkVariableTempoChange(req);
    expect(check.ok).toBe(false);
    expect(check.ok === false && check.reason).toBe('empty-region');

    const result = await applyTempoChange(req);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('empty-region');
    expect(liveDoc(doc.id).channels).toBe(channelsBefore);
    expect(liveDoc(doc.id).dirty).toBe(false);
    expect(getHistory(doc.id).done).toEqual([]);
  });

  it('refuses the ratio-1 beat-grid path by name rather than as a bare failure', async () => {
    const doc = seedAndSelect({ start: LEN, end: LEN * 3 });

    const result = await applyTempoChange({
      sourceBpm: 110,
      targetBpm: 110, // ratio 1 -> the no-stretch grid path
      addBeatMarkers: true,
      firstBeatSample: 0,
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('empty-region');
    expect(liveMarkers(doc.id)).toHaveLength(0);
    expect(getHistory(doc.id).done).toEqual([]);
  });

  it('still runs when the selection merely OVERHANGS the end — the guard is on the resolved region', async () => {
    // The other side of the boundary, and the reason the guard reads the
    // RESOLVED pair: this selection is just as out of bounds, but it clamps to
    // a second of real audio and must be stretched, not refused.
    const doc = seedAndSelect({ start: LEN / 2, end: LEN * 3 });

    const result = await applyTempoChange({ sourceBpm: 110, targetBpm: 130 });

    expect(result.ok).toBe(true);
    expect(result.reason).toBeUndefined();
    // 110 -> 130 BPM is ratio 0.846, so the stretched half gets SHORTER while
    // the untouched half does not: the new length sits strictly between them,
    // which is the signature of exactly the resolved region having been warped.
    const newLen = docLength(liveDoc(doc.id));
    expect(newLen).toBeLessThan(LEN);
    expect(newLen).toBeGreaterThan(LEN / 2);
    expect(getHistory(doc.id).done).toEqual(['Match Tempo']);
  }, 30000);
});

describe('applyTempoChange — beat markers after a VARIABLE match', () => {
  it('lays them where the beats actually WENT, not at first + i*spacing', async () => {
    const seconds = 8;
    const doc = seedDoc([amSine(441, 110, seconds)]);
    const docId = doc.id;
    // 120 BPM asked to become 30 BPM: ratio 4 exactly at the ceiling, so
    // nothing clamps; then a grid whose intervals differ makes `placed`
    // diverge from an arithmetic re-derivation.
    const grid = accelGrid(100, 140, seconds);

    const check = checkVariableTempoChange({
      sourceBpm: 110,
      targetBpm: 110,
      variableRate: { beatSamples: grid },
    });
    expect(check.ok).toBe(true);
    if (!check.ok) return;

    const result = await applyTempoChange({
      sourceBpm: 110,
      targetBpm: 110,
      addBeatMarkers: true,
      variableRate: { beatSamples: grid },
    });
    expect(result.ok).toBe(true);

    const markers = liveMarkers(docId)
      .filter((m) => m.name.startsWith('Beat '))
      .sort((a, b) => a.positionSample - b.positionSample);
    expect(markers).toHaveLength(check.plan.map.placed.length);
    // EVERY marker, not just the first — a grid right at beat 0 and wrong
    // after is the expected failure mode for anything derived from a map.
    markers.forEach((m, i) => {
      expect(m.positionSample).toBe(Math.round(check.plan.map.placed[i]));
    });
    expect(getHistory(docId).done).toEqual(['Match Tempo', 'Add Beat Markers']);
  }, 30000);

  it('offsets them by the SELECTION start', async () => {
    const seconds = 8;
    const doc = seedDoc([amSine(441, 110, seconds)]);
    const docId = doc.id;
    const start = 2 * SR;
    useAppStore.getState().setSelection({ start, end: 6 * SR });
    const grid = accelGrid(100, 130, seconds);

    const check = checkVariableTempoChange({
      sourceBpm: 110,
      targetBpm: 110,
      variableRate: { beatSamples: grid },
    });
    expect(check.ok).toBe(true);
    if (!check.ok) return;

    const result = await applyTempoChange({
      sourceBpm: 110,
      targetBpm: 110,
      addBeatMarkers: true,
      variableRate: { beatSamples: grid },
    });
    expect(result.ok).toBe(true);

    const markers = liveMarkers(docId)
      .filter((m) => m.name.startsWith('Beat '))
      .sort((a, b) => a.positionSample - b.positionSample);
    expect(markers.length).toBeGreaterThan(2);
    markers.forEach((m, i) => {
      expect(m.positionSample).toBe(start + Math.round(check.plan.map.placed[i]));
    });
    // And they are genuinely inside the selection, not at the file head.
    expect(markers[0].positionSample).toBeGreaterThanOrEqual(start);
  }, 30000);

  it('does not lay a grid when it was not asked for', async () => {
    const seconds = 8;
    const doc = seedDoc([amSine(441, 110, seconds)]);
    const result = await applyTempoChange({
      sourceBpm: 110,
      targetBpm: 110,
      variableRate: { beatSamples: accelGrid(100, 130, seconds) },
    });
    expect(result.ok).toBe(true);
    expect(liveMarkers(doc.id).filter((m) => m.name.startsWith('Beat '))).toHaveLength(0);
    expect(getHistory(doc.id).done).toEqual(['Match Tempo']);
  }, 30000);
});

// ---------------------------------------------------------------------------
// R7 — gaps the service mutation sweep found
// ---------------------------------------------------------------------------

describe('the payload handed to the worker is exactly the region’s beats', () => {
  it('pins every converted position, not just the count', () => {
    // The earlier scoping test compared COUNTS and looked at the first element,
    // which is not enough: dropping the `b < start` guard, or loosening
    // `b >= end` to `b > end`, lets an out-of-region beat through as a NEGATIVE
    // or over-long region-relative value — and `buildTempoMap`'s own range
    // guard then silently drops it, so the count and the first element come out
    // unchanged. Both mutations survived until this test pinned the array
    // itself. The service must not hand the worker a position outside the
    // region in the first place.
    seedDoc([sine(220, 8)]);
    const start = 2 * SR;
    const end = 6 * SR;
    useAppStore.getState().setSelection({ start, end });

    const beats = [
      0, // before the region
      start - 1, // one sample before it
      start, // exactly the region start — INSIDE
      start + 1000,
      start + 2000,
      end - 1, // one sample before the end — INSIDE
      end, // exactly the region end — OUTSIDE (belongs to what follows)
      end + 1000,
    ];
    const check = checkVariableTempoChange({
      sourceBpm: 110,
      targetBpm: 110,
      variableRate: { beatSamples: beats },
    });
    expect(check.ok).toBe(true);
    if (!check.ok) return;

    expect(check.plan.extra.beatSamples).toEqual([0, 1000, 2000, end - start - 1]);
    for (const b of check.plan.extra.beatSamples) {
      expect(b).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThan(check.plan.regionLength);
    }
  });

  it('is document-absolute minus the start, with no selection meaning zero', () => {
    seedDoc([sine(220, 8)]);
    const check = checkVariableTempoChange({
      sourceBpm: 110,
      targetBpm: 110,
      variableRate: { beatSamples: [0, 1000, 2500] },
    });
    expect(check.ok).toBe(true);
    if (!check.ok) return;
    expect(check.plan.extra.beatSamples).toEqual([0, 1000, 2500]);
  });
});

describe('beat markers after a CLAMPED variable match', () => {
  it('follow the map, which is no longer an arithmetic grid', async () => {
    // The earlier marker test used a map where nothing clamped — and on such a
    // map every beat lands exactly one target spacing after the last, so
    // `placed` IS the arithmetic grid `first + i*spacing` and the two cannot be
    // told apart. A mutation replacing `map.placed[i]` with that extrapolation
    // survived it. Clamping is precisely the case `placed` exists for, so the
    // grid here contains one interval far too short to reach the target.
    const seconds = 8;
    const doc = seedDoc([amSine(441, 110, seconds)]);
    const docId = doc.id;
    // Target 60 BPM -> one beat per second. The 1000-sample interval would need
    // ratio 44.1 and is held at MAX_RATIO 4, so every later beat carries the
    // deficit and `placed` stops being evenly spaced.
    const grid = [0, SR, 2 * SR, 2 * SR + 1000, 3 * SR + 1000, 4 * SR + 1000];

    const check = checkVariableTempoChange({
      sourceBpm: 110,
      targetBpm: 60,
      variableRate: { beatSamples: grid },
    });
    expect(check.ok).toBe(true);
    if (!check.ok) return;
    // The fixture really does clamp — otherwise this proves nothing.
    expect(check.plan.clampedCount).toBeGreaterThan(0);
    const placed = Array.from(check.plan.map.placed);
    const arithmetic = placed.map((_, i) => placed[0] + i * (placed[1] - placed[0]));
    // ...and `placed` really has departed from the arithmetic grid.
    expect(Math.round(placed[placed.length - 1])).not.toBe(Math.round(arithmetic[arithmetic.length - 1]));

    const result = await applyTempoChange({
      sourceBpm: 110,
      targetBpm: 60,
      addBeatMarkers: true,
      variableRate: { beatSamples: grid },
    });
    expect(result.ok).toBe(true);

    const markers = liveMarkers(docId)
      .filter((m) => m.name.startsWith('Beat '))
      .sort((a, b) => a.positionSample - b.positionSample);
    expect(markers).toHaveLength(placed.length);
    markers.forEach((m, i) => {
      expect(m.positionSample).toBe(Math.round(placed[i]));
    });
    // And explicitly NOT where re-deriving from the target BPM would have put
    // the last one.
    expect(markers[markers.length - 1].positionSample).not.toBe(Math.round(arithmetic[arithmetic.length - 1]));
  }, 30000);

  it('caps at MAX_BEAT_MARKERS and says so once', async () => {
    const showMessageBox = installShowMessageBox();
    // A deliberately extreme grid: 600 beats 147 samples apart in a 2 s
    // document, matched to a 100-sample spacing. The BPM is absurd, and that is
    // the point — reaching the 512 cap with a musical tempo would need a
    // 256-second fixture, and the cap is about the marker COUNT, not the audio.
    const seconds = 2;
    const doc = seedDoc([amSine(441, 110, seconds)]);
    const docId = doc.id;
    const grid: number[] = [];
    for (let i = 0; i < 600; i++) grid.push(i * 147);
    const targetBpm = (60 * SR) / 100; // 100-sample target spacing

    const check = checkVariableTempoChange({
      sourceBpm: 110,
      targetBpm,
      variableRate: { beatSamples: grid },
    });
    expect(check.ok).toBe(true);
    if (!check.ok) return;
    expect(check.plan.beatCount).toBeGreaterThan(MAX_BEAT_MARKERS);

    const result = await applyTempoChange({
      sourceBpm: 110,
      targetBpm,
      addBeatMarkers: true,
      variableRate: { beatSamples: grid },
    });
    expect(result.ok).toBe(true);

    const markers = liveMarkers(docId).filter((m) => m.name.startsWith('Beat '));
    expect(markers).toHaveLength(MAX_BEAT_MARKERS);
    expect(showMessageBox).toHaveBeenCalledTimes(1);
    expect(showMessageBox.mock.calls[0][0].message).toContain(String(MAX_BEAT_MARKERS));
  }, 30000);
});

// ---------------------------------------------------------------------------
// R7 fix round 1 — the run is checked against the plan it was given
// ---------------------------------------------------------------------------

describe('the variable path checks the RESULT against the PLAN', () => {
  it('does not report success when a concurrent metadata change is the only thing that moved', async () => {
    // The variable half of the constant path's fix-round-2 finding, and the one
    // mutation that survived the first service sweep: comparing the whole
    // DOCUMENT reference instead of its `channels` false-POSITIVES, because
    // `markDirty` — and therefore an ordinary `addMarker` during the await —
    // returns a NEW document object holding the SAME channels array.
    const seconds = 8;
    const doc = seedDoc([sine(220, seconds)]);
    const docId = doc.id;
    const lenBefore = docLength(liveDoc(docId));
    const historyBefore = getHistory(docId).done.length;

    _setDspWorkerLoadFailure('boom');
    const promise = applyTempoChange({
      sourceBpm: 110,
      targetBpm: 130,
      addBeatMarkers: true,
      variableRate: { beatSamples: accelGrid(100, 120, seconds) },
    });

    // Interleaved DURING the await, exactly as the constant path's test does.
    useAppStore.getState().addMarker(docId, { id: 'user-marker-var', name: 'User Marker', positionSample: 500 });

    const result = await promise;

    expect(result.ok).toBe(false);
    // Specifically the `applied` gate, NOT the post-edit `plan-mismatch`:
    // nothing was applied at all. Distinguishing the two is what makes the
    // next unexplained failure say which one it was.
    expect(result.reason).toBeUndefined();
    expect(docLength(liveDoc(docId))).toBe(lenBefore);
    expect(getHistory(docId).done.length).toBe(historyBefore);
    expect(liveMarkers(docId).filter((m) => m.name.startsWith('Beat '))).toHaveLength(0);
    expect(liveMarkers(docId).some((m) => m.id === 'user-marker-var')).toBe(true);
  }, 30000);

  it('refuses with plan-mismatch, and writes no grid, when the run disagrees with the plan', async () => {
    // The plan and the worker build the map from the same pure function on the
    // same inputs, so they agree BY CONSTRUCTION — which is exactly why this
    // check has to be provoked deliberately to be pinned at all. Halving the
    // target spacing the worker receives, while leaving the plan untouched, is
    // the smallest faithful model of the two disagreeing: still a legal map,
    // just a different length.
    const seconds = 8;
    const doc = seedDoc([amSine(441, 110, seconds)]);
    const docId = doc.id;
    const grid = accelGrid(100, 120, seconds);
    const req = { sourceBpm: 110, targetBpm: 130, variableRate: { beatSamples: grid } };

    const planned = checkVariableTempoChange(req);
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;

    // The real implementation captured BEFORE spying. `jest.requireActual` is
    // wrong here: this module is not mocked at module level, so requireActual
    // hands back the very same object the spy has already replaced — and the
    // mock calls itself forever.
    const realRunEffect = effectRunner.runEffectOnSelection;
    const spy = jest
      .spyOn(effectRunner, 'runEffectOnSelection')
      .mockImplementation((effectId, params, opts) => {
        const extra = opts?.extra as { beatSamples: number[]; targetSpacing: number };
        return realRunEffect(effectId, params, {
          ...opts,
          extra: { ...extra, targetSpacing: extra.targetSpacing / 2 },
        });
      });

    try {
      const result = await applyTempoChange({ ...req, addBeatMarkers: true });
      expect(result.ok).toBe(false);
      expect(result.reason).toBe('plan-mismatch');
      // The audio edit itself happened and stays undoable — the refusal is
      // about the plan no longer describing it, not about the edit failing.
      expect(getHistory(docId).done).toEqual(['Match Tempo']);
      // And NO beat grid was written from a plan that no longer describes the
      // audio. That silent wrong answer is the whole point of the check.
      expect(liveMarkers(docId).filter((m) => m.name.startsWith('Beat '))).toHaveLength(0);
      expect(docLength(liveDoc(docId))).not.toBe(planned.plan.outLength);
    } finally {
      spy.mockRestore();
    }
  }, 30000);

  it('and the spy really can change the outcome — the same run, unspied, succeeds', async () => {
    // Without this, the test above would pass just as well if the spy silently
    // did nothing and `applyTempoChange` were failing for an unrelated reason.
    const seconds = 8;
    const doc = seedDoc([amSine(441, 110, seconds)]);
    const req = {
      sourceBpm: 110,
      targetBpm: 130,
      addBeatMarkers: true,
      variableRate: { beatSamples: accelGrid(100, 120, seconds) },
    };
    const planned = checkVariableTempoChange(req);
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;

    const result = await applyTempoChange(req);
    expect(result.ok).toBe(true);
    expect(docLength(liveDoc(doc.id))).toBe(planned.plan.outLength);
    expect(liveMarkers(doc.id).filter((m) => m.name.startsWith('Beat ')).length).toBeGreaterThan(0);
  }, 30000);
});

describe('the region is clamped exactly as cloneRegion clamps it (finding 7)', () => {
  it.each([
    ['an end past the document', 0, 99 * SR],
    ['a negative start', -5000, 4 * SR],
    ['both ends out of bounds', -5000, 99 * SR],
  ])('describes the real audio when the selection runs %s', (_label, start, end) => {
    // `setSelection` does NOT clamp — it stores whatever it is handed — while
    // `runEffectOnSelection`/`cloneRegion` DO. So the two resolutions
    // disagreeing is reachable through the ordinary store API even though the
    // reviewer could find no UI path to it, and an unclamped plan would
    // describe a region longer than the audio the worker is handed: the map
    // would be built for one length and applied to another.
    const seconds = 8;
    const doc = seedDoc([sine(220, seconds)]);
    const len = docLength(doc);
    useAppStore.getState().setSelection({ start, end });

    const check = checkVariableTempoChange({
      sourceBpm: 110,
      targetBpm: 110,
      variableRate: { beatSamples: accelGrid(100, 120, seconds) },
    });
    expect(check.ok).toBe(true);
    if (!check.ok) return;

    // The region never claims to be longer than the document.
    expect(check.plan.regionLength).toBeLessThanOrEqual(len);
    expect(check.plan.regionLength).toBe(Math.min(len, Math.max(end, 0)) - Math.min(len, Math.max(start, 0)));
    // And every beat handed to the worker is inside it.
    for (const b of check.plan.extra.beatSamples) {
      expect(b).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThan(check.plan.regionLength);
    }
  });

  it.each([
    ['a start of zero', 0, 99 * SR],
    ['a non-zero start', 2 * SR, 99 * SR],
    ['a NEGATIVE start', -5000, 6 * SR],
  ])('applies end to end and keeps every marker inside the document: %s', async (_label, start, end) => {
    // Unclamped, `plan.regionLength` would exceed the audio the worker actually
    // receives, `plan.outLength` would be computed for the wrong length, and
    // the plan-vs-realised check would refuse a run that was in fact correct.
    //
    // The NEGATIVE start is the case that matters most and the one an earlier
    // version of this test lacked. With the write path resolving its OWN start
    // from the selection, the plan and `cloneRegion` both clamped — so
    // `realisedDelta === plannedDelta` and the check PASSED — while the beat
    // grid was written at `-5000 + placed[i]`, negative for every early beat,
    // stored unclamped by `setMarkersForDoc` and silently collapsed to 0 only
    // at save time. Using `start: 0` alone could never see it.
    const seconds = 8;
    const doc = seedDoc([amSine(441, 110, seconds)]);
    useAppStore.getState().setSelection({ start, end });

    const req = {
      sourceBpm: 110,
      targetBpm: 130,
      addBeatMarkers: true,
      variableRate: { beatSamples: accelGrid(100, 120, seconds) },
    };
    const planned = checkVariableTempoChange(req);
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;

    const lenBefore = docLength(liveDoc(doc.id));
    const result = await applyTempoChange(req);
    expect(result.ok).toBe(true);
    expect(result.reason).toBeUndefined();
    // outLength is the REGION's new length, not the document's: the document
    // grows by the difference. (Only equal when the region IS the document,
    // which is why the single start-0 case never caught this.)
    expect(docLength(liveDoc(doc.id))).toBe(
      lenBefore - planned.plan.regionLength + planned.plan.outLength
    );

    // The plan's resolved start is the clamped one, and it is what the markers
    // were written from.
    expect(planned.plan.regionStart).toBe(Math.min(docLength(doc), Math.max(start, 0)));

    const markers = liveMarkers(doc.id).filter((m) => m.name.startsWith('Beat '));
    expect(markers.length).toBeGreaterThan(0);
    const newLen = docLength(liveDoc(doc.id));
    for (const m of markers) {
      // every beat marker lands inside the document
      expect(m.positionSample).toBeGreaterThanOrEqual(0);
      expect(m.positionSample).toBeLessThanOrEqual(newLen);
    }
    // And at the plan's own positions, offset by the plan's own start — not by
    // a start resolved a second time somewhere else.
    const placed = Array.from(planned.plan.map.placed);
    markers
      .slice()
      .sort((a, b) => a.positionSample - b.positionSample)
      .forEach((m, i) => {
        expect(m.positionSample).toBe(planned.plan.regionStart + Math.round(placed[i]));
      });
  }, 30000);
});

// ---------------------------------------------------------------------------
// L1 â€” the loose ends R7 left behind
// ---------------------------------------------------------------------------

describe('L1-1 â€” the CONSTANT path resolves its region through the same clamp', () => {
  it('a NEGATIVE selection start does not pile every early beat marker onto sample 0', async () => {
    // R7 clamped `checkVariableTempoChange`'s region and left `applyTempoChange`
    // resolving its own `start`/`end` straight off the selection. `setSelection`
    // stores whatever it is handed, so start = -40000 reached
    // `computeBeatMarkerPositions`, whose `Math.max(start, firstBeatSample)`
    // leaves a negative start untouched: `newFirstBeat` came out at -30000 and
    // every candidate before zero collapsed onto the `Math.max(0, ...)` floor.
    // Unclamped this writes FOUR markers all at position 0.
    const doc = seedDoc([sine(220, 4)]); // 176400 samples
    const docId = doc.id;
    useAppStore.getState().setSelection({ start: -40000, end: 88200 });

    const result = await applyTempoChange({
      sourceBpm: 120,
      targetBpm: 480, // ratio 0.25 â€” exactly MIN_RATIO, accepted
      addBeatMarkers: true,
      firstBeatSample: 0,
    });
    expect(result.ok).toBe(true);

    // The audio edit always used the clamped region (`cloneRegion` clamps), so
    // the document length is the same either way â€” only the markers differ.
    expect(docLength(liveDoc(docId))).toBe(176400 - 88200 + 22050);

    const positions = liveMarkers(docId)
      .filter((m) => m.name.startsWith('Beat '))
      .map((m) => m.positionSample)
      .sort((a, b) => a - b);
    // `newFirstBeat = 0`, spacing `(60/480)*44100 = 5512.5`, region end
    // `round(88200*0.25) = 22050`. Literal, so it cannot drift with the code.
    expect(positions).toEqual([0, 5513, 11025, 16538]);
  }, 20000);

  it('an END past the document does not pile the late markers onto its last sample', async () => {
    // The mirror of the same defect, on the ratio-1 grid path
    // (`layBeatGridAtCurrentTempo`), which had its own unclamped resolution too.
    // Unclamped, `regionEnd` is 4365900 and the loop emits 198 candidates of
    // which 190 collapse onto `Math.min(newLen, pos)` â€” the document's last
    // sample â€” instead of stopping at the end of the real audio.
    const doc = seedDoc([sine(220, 4)]); // 176400 samples
    const docId = doc.id;
    useAppStore.getState().setSelection({ start: 0, end: 99 * SR });

    const result = await applyTempoChange({
      sourceBpm: 120,
      targetBpm: 120, // ratio 1 -> the no-stretch beat-grid path
      addBeatMarkers: true,
      firstBeatSample: 0,
    });
    expect(result.ok).toBe(true);
    expect(docLength(liveDoc(docId))).toBe(176400); // no audio edit at all
    expect(getHistory(docId).done).toEqual(['Add Beat Markers']);

    const positions = liveMarkers(docId)
      .filter((m) => m.name.startsWith('Beat '))
      .map((m) => m.positionSample)
      .sort((a, b) => a - b);
    // spacing `(60/120)*44100 = 22050`, region end 176400.
    expect(positions).toEqual([0, 22050, 44100, 66150, 88200, 110250, 132300, 154350]);
  }, 20000);
});

describe('L1-5 â€” the two buildTempoMap call sites receive equal arguments', () => {
  it('the worker rebuilds the map from the same beats, region length and spacing', async () => {
    // This is the property the `plan-mismatch` guard actually rests on, and it
    // was unpinned. The guard is unreachable precisely BECAUSE both maps come
    // from the same pure function on identical arguments; if that ever stops
    // being true the guard starts firing, so the equality is what has to be
    // tested, not the refusal.
    //
    // The selection is out of bounds at BOTH ends on purpose: `regionLength` is
    // the one argument the two sides derive independently â€” the service from the
    // selection, the worker from `channels[0].length` after `cloneRegion` â€” so
    // it is the only one that can drift, and only an out-of-bounds selection
    // makes the clamped and unclamped values differ.
    const seconds = 8;
    const doc = seedDoc([amSine(441, 110, seconds)]);
    const len = docLength(doc);
    const start = -5000;
    const end = 99 * SR;
    expect(start).toBeLessThan(0);
    expect(end).toBeGreaterThan(len);
    useAppStore.getState().setSelection({ start, end });

    const spy = jest.spyOn(tempoMapModule, 'buildTempoMap');
    try {
      const targetBpm = 130;
      const result = await applyTempoChange({
        sourceBpm: 110,
        targetBpm,
        variableRate: { beatSamples: accelGrid(100, 120, seconds) },
      });
      expect(result.ok).toBe(true);
      expect(result.reason).toBeUndefined();

      // Exactly two derivations: the service's plan, then the worker's rebuild.
      expect(spy.mock.calls).toHaveLength(2);
      const [serviceCall, workerCall] = spy.mock.calls;

      expect(Array.from(workerCall[0])).toEqual(Array.from(serviceCall[0]));

      const clampedLength = Math.min(len, Math.max(end, 0)) - Math.min(len, Math.max(start, 0));
      expect(clampedLength).toBe(len);
      expect(serviceCall[1]).toBe(clampedLength);
      expect(workerCall[1]).toBe(clampedLength);

      // Bit for bit: `targetSpacing` crosses the worker boundary as a double and
      // is deliberately not rounded, so `toBe` is the right strictness here.
      expect(serviceCall[2]).toBe((60 / targetBpm) * SR);
      expect(Object.is(workerCall[2], serviceCall[2])).toBe(true);
    } finally {
      spy.mockRestore();
    }
  }, 30000);
});

describe('L1-6 â€” markers inside a VARIABLE match follow the map, not the average ratio', () => {
  it('puts each marker where its own audio went, as its own undo step before the beat grid', async () => {
    const seconds = 8;
    const doc = seedDoc([amSine(441, 110, seconds)]);
    const docId = doc.id;
    // A NON-ZERO region start: with start 0 the region-relative and
    // document-absolute coordinates coincide and an offset bug cannot be seen.
    const start = 2 * SR;
    const end = 6 * SR;
    useAppStore.getState().setSelection({ start, end });

    const req = {
      sourceBpm: 110,
      targetBpm: 150,
      addBeatMarkers: true,
      variableRate: { beatSamples: accelGrid(100, 130, seconds) },
    };
    const planned = checkVariableTempoChange(req);
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    const { map, regionStart, regionLength, outLength } = planned.plan;
    expect(regionStart).toBe(start);

    // Pin the marker to a TRACKED BEAT, whose landing place the map reports
    // independently as `placed[k]` â€” a different quantity from the
    // `synthesisPosAt` interpolation the service runs, agreeing with it only
    // because beats are knots. And pick the beat the region's AVERAGE ratio gets
    // most wrong, since that is the case the correction exists for.
    const beatsRel = planned.plan.extra.beatSamples;
    const meanRatio = outLength / regionLength;
    let k = 0;
    let worstDrift = -1;
    for (let i = 0; i < map.acceptedIndices.length; i++) {
      const rel = beatsRel[map.acceptedIndices[i]];
      const drift = Math.abs(Math.round(map.placed[i]) - Math.round(rel * meanRatio));
      if (drift > worstDrift) {
        worstDrift = drift;
        k = i;
      }
    }
    // If the fixture did not actually vary, this test would prove nothing.
    expect(worstDrift).toBeGreaterThan(1000);

    const beatRel = beatsRel[map.acceptedIndices[k]];
    const markerPos = regionStart + beatRel;
    const expectedPos = regionStart + Math.round(map.placed[k]);
    // What `applyEdit`'s shared proportional stretch remap produces, and what
    // shipped in v1.23.0.
    const proportionalPos = regionStart + Math.round(beatRel * meanRatio);
    expect(expectedPos).not.toBe(proportionalPos);

    const before: Marker[] = [
      { id: 'm-before', name: 'before the region', positionSample: start - 1000 },
      { id: 'm-beat', name: 'on a tracked beat', positionSample: markerPos },
      { id: 'm-after', name: 'after the region', positionSample: end + 3000 },
    ];
    useAppStore.getState().setMarkersForDoc(docId, before);

    const result = await applyTempoChange(req);
    expect(result.ok).toBe(true);
    expect(result.reason).toBeUndefined();

    const after = liveMarkers(docId);
    const posOf = (id: string) => after.find((m) => m.id === id)!.positionSample;
    expect(posOf('m-before')).toBe(start - 1000); // the warp cannot reach it
    expect(posOf('m-beat')).toBe(expectedPos);
    expect(posOf('m-after')).toBe(end + 3000 + (outLength - regionLength));

    // Three entries, in this order â€” the correction lands BEFORE the grid, so
    // the grid appends to the corrected list rather than being overwritten by a
    // snapshot taken before it existed.
    expect(getHistory(docId).done).toEqual([
      'Match Tempo',
      'Match Tempo Markers',
      'Add Beat Markers',
    ]);
    expect(after.filter((m) => m.name.startsWith('Beat ')).length).toBeGreaterThan(0);

    // Undo the grid: the correction survives.
    undo(docId);
    expect(liveMarkers(docId).filter((m) => m.name.startsWith('Beat '))).toHaveLength(0);
    expect(liveMarkers(docId).find((m) => m.id === 'm-beat')!.positionSample).toBe(expectedPos);
    // Undo the correction: the marker falls back to the proportional position
    // `applyEdit` left it at. That transient state is the stated cost of doing
    // this as a separate entry, and it is what Align Markers already ships.
    undo(docId);
    expect(liveMarkers(docId).find((m) => m.id === 'm-beat')!.positionSample).toBe(proportionalPos);
    // Undo the stretch: audio and markers both back to the start.
    undo(docId);
    expect(docLength(liveDoc(docId))).toBe(seconds * SR);
    expect(liveMarkers(docId).find((m) => m.id === 'm-beat')!.positionSample).toBe(markerPos);
  }, 30000);

  it('pushes no marker entry when every candidate lands where it already is', async () => {
    // Both no-move routes in one fixture, because they are different guards.
    // `m-before` is skipped outright — the warp cannot reach it. `m-at-start`
    // IS a candidate: it sits exactly on the region start, where
    // `synthesisPosAt` returns 0 and the proportional remap also returned 0, so
    // it is considered and found already correct. Without the `moved === 0`
    // check that second marker still buys a `Match Tempo Markers` undo entry
    // that changes nothing — a mutation sweep found that arm unpinned when this
    // test carried only the first marker.
    const seconds = 8;
    const doc = seedDoc([amSine(441, 110, seconds)]);
    const docId = doc.id;
    const start = 2 * SR;
    useAppStore.getState().setSelection({ start, end: 6 * SR });
    const before: Marker[] = [
      { id: 'm-before', name: 'before', positionSample: start - 1000 },
      { id: 'm-at-start', name: 'on the region start', positionSample: start },
    ];
    useAppStore.getState().setMarkersForDoc(docId, before);

    const result = await applyTempoChange({
      sourceBpm: 110,
      targetBpm: 150,
      variableRate: { beatSamples: accelGrid(100, 130, seconds) },
    });
    expect(result.ok).toBe(true);
    expect(getHistory(docId).done).toEqual(['Match Tempo']);
    expect(liveMarkers(docId)).toEqual(before);
  }, 30000);
});

/**
 * T6-3 — a cancelled pass, through the REAL runner and the REAL effect.
 *
 * The variable path is the one worth pinning: it commits up to THREE undo
 * entries (`Match Tempo`, `Match Tempo Markers`, `Add Beat Markers`), and only
 * the first goes through the runner. The other two are synchronous with it, so
 * one answer at the one await is what makes the pass all-or-nothing — a claim
 * that is only worth as much as a test that would notice it being false.
 */
describe('a cancelled pass commits nothing (T6-3)', () => {
  it('the constant path leaves the audio and the history untouched, and says cancelled', async () => {
    const doc = seedDoc([sine(220, 4)]);
    const before = docLength(liveDoc(doc.id));

    const result = await applyTempoChange({
      sourceBpm: 120,
      targetBpm: 60,
      shouldCancel: () => true,
    });

    expect(result).toEqual({ ok: false, reason: 'cancelled' });
    expect(docLength(liveDoc(doc.id))).toBe(before);
    expect(liveDoc(doc.id).channels[0]).toBe(doc.channels[0]);
    expect(getHistory(doc.id).done).toEqual([]);
  }, 20000);

  it('the constant path lays no beat grid over audio that was never stretched', async () => {
    const doc = seedDoc([sine(220, 4)]);

    const result = await applyTempoChange({
      sourceBpm: 120,
      targetBpm: 60,
      addBeatMarkers: true,
      firstBeatSample: 0,
      shouldCancel: () => true,
    });

    expect(result.reason).toBe('cancelled');
    // `addBeatMarkersAfterStretch` runs after the await, so without the check
    // between them a cancelled pass still wrote a grid — describing beats of a
    // tempo the document does not have.
    expect(liveMarkers(doc.id)).toEqual([]);
    expect(getHistory(doc.id).done).toEqual([]);
  }, 20000);

  it('the variable path commits none of its three entries', async () => {
    const seconds = 8;
    const doc = seedDoc([sine(220, seconds)]);
    const docId = doc.id;
    useAppStore.getState().setMarkersForDoc(docId, [
      { id: 'm0', name: 'a', positionSample: Math.round(1.5 * SR) },
      { id: 'm1', name: 'b', positionSample: Math.round(4.5 * SR) },
    ]);
    const markersBefore = liveMarkers(docId);
    const lengthBefore = docLength(liveDoc(docId));

    const result = await applyTempoChange({
      sourceBpm: 110,
      targetBpm: 110,
      variableRate: { beatSamples: accelGrid(100, 130, seconds) },
      addBeatMarkers: true,
      firstBeatSample: 0,
      shouldCancel: () => true,
    });

    expect(result).toEqual({ ok: false, reason: 'cancelled' });
    expect(docLength(liveDoc(docId))).toBe(lengthBefore);
    expect(liveDoc(docId).channels[0]).toBe(doc.channels[0]);
    // Neither `correctMarkersForWarp` nor `addBeatMarkersFromMap` ran: the
    // markers are where the user left them and no grid was appended.
    expect(liveMarkers(docId)).toEqual(markersBefore);
    expect(getHistory(docId).done).toEqual([]);
  }, 30000);

  it('commits normally when the cancel says no', async () => {
    const doc = seedDoc([sine(220, 4)]);
    const before = docLength(liveDoc(doc.id));

    const result = await applyTempoChange({
      sourceBpm: 120,
      targetBpm: 60,
      shouldCancel: () => false,
    });

    expect(result.ok).toBe(true);
    expect(docLength(liveDoc(doc.id))).toBe(Math.round(before * 2));
    expect(getHistory(doc.id).done).toEqual(['Match Tempo']);
  }, 20000);
});
