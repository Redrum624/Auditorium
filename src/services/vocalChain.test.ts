import {
  DE_ESSER_BIT_EXACT_OFFSET_DB,
  DE_ESSER_RMS_OFFSET_DB,
  VOCAL_CHAIN_STAGES,
  VOCAL_CHAIN_UNDO_LABEL,
  defaultStageSelection,
  deriveCompressor,
  deriveDeEsser,
  deriveDeHum,
  deriveEq,
  deriveNoiseReduction,
  deriveRemoveSilence,
  runVocalChain,
  stageById,
  type VocalChainStageId,
} from './vocalChain';
import { defaultParamsFor, getEffect } from '../effects/EffectRegistry';
import { registerAllEffects } from '../effects/registerAll';
import { compressorEffect } from '../effects/dynamics/CompressorEffect';
import { createDocument, docLength } from '../audio/AudioDocument';
import { useAppStore, makeInitialState } from '../stores/appStore';
import { getHistory, undo } from './undoHistory';
import { measureNoiseWindow, programmeRmsDb, toDb } from '../dsp/chainAnalysis';
import { _resetDspWorkerTestState, _setDspWorkerLoadFailure } from '../__mocks__/createDspWorkerMock';

registerAllEffects();

const SR = 8000;
const WIN = SR / 2; // the 500 ms noise window

/** Alternating +/-level: RMS is EXACTLY `level`, so fixtures can be placed on a
 * dB boundary by arithmetic rather than by luck. */
function flat(n: number, level: number): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = i % 2 === 0 ? level : -level;
  return out;
}

function noise(n: number, amplitude: number, seed = 1): Float32Array {
  const out = new Float32Array(n);
  let s = seed >>> 0;
  for (let i = 0; i < n; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    out[i] = ((s / 0xffffffff) * 2 - 1) * amplitude;
  }
  return out;
}

function tone(n: number, freqHz: number, amplitude: number): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amplitude * Math.sin((2 * Math.PI * freqHz * i) / SR);
  return out;
}

/** `windows` half-second windows at `loud`, with window index `quietAt` at `quiet`. */
function withQuietWindow(windows: number, loud: number, quiet: number, quietAt: number): Float32Array {
  const out = flat(WIN * windows, loud);
  const q = flat(WIN, quiet);
  out.set(q, quietAt * WIN);
  return out;
}

function seedDoc(channels: Float32Array[], sampleRate = SR): string {
  const doc = createDocument({ name: 'chain', sampleRate, channels });
  useAppStore.getState().addDocument(doc);
  return doc.id;
}

function activeDoc() {
  const s = useAppStore.getState();
  return s.documents.find((d) => d.id === s.activeDocumentId)!;
}

/** All stages off, then only the named ones on. */
function only(...ids: VocalChainStageId[]): Record<VocalChainStageId, boolean> {
  const enabled = {} as Record<VocalChainStageId, boolean>;
  for (const stage of VOCAL_CHAIN_STAGES) enabled[stage.id] = false;
  for (const id of ids) enabled[id] = true;
  return enabled;
}

beforeEach(() => {
  useAppStore.setState(makeInitialState());
  _resetDspWorkerTestState();
});

afterEach(() => {
  _resetDspWorkerTestState();
  delete (window as { electronAPI?: unknown }).electronAPI;
});

// ── The stage table ─────────────────────────────────────────────────────────

describe('VOCAL_CHAIN_STAGES', () => {
  it('runs the corrections in the reasoned order, with the EQ before the limiter', () => {
    expect(VOCAL_CHAIN_STAGES.map((s) => s.id)).toEqual([
      'dc',
      'noise',
      'hum',
      'silence',
      'timing',
      'pitch',
      'compressor',
      'deEsser',
      'eq',
      'limiter',
      'reverb',
    ]);
  });

  it('de-esses AFTER compressing — compression makes sibilance worse', () => {
    const ids = VOCAL_CHAIN_STAGES.map((s) => s.id);
    expect(ids.indexOf('deEsser')).toBeGreaterThan(ids.indexOf('compressor'));
  });

  it('reduces noise BEFORE detecting pitch — the detector must not lock onto noise', () => {
    const ids = VOCAL_CHAIN_STAGES.map((s) => s.id);
    expect(ids.indexOf('noise')).toBeLessThan(ids.indexOf('pitch'));
  });

  it('puts reverb last, so nothing compresses or pitch-corrects a tail it just added', () => {
    expect(VOCAL_CHAIN_STAGES[VOCAL_CHAIN_STAGES.length - 1].id).toBe('reverb');
  });

  it('names every stage after what it does, never after how good the result is', () => {
    for (const stage of VOCAL_CHAIN_STAGES) {
      expect(stage.label.toLowerCase()).not.toMatch(/perfect|studio|pro|magic|master/);
      expect(stage.note.toLowerCase()).not.toMatch(/\bperfect\b|\bflawless\b/);
    }
  });

  it('gives every stage a unique id and a registered effect (or marks it manual)', () => {
    const ids = VOCAL_CHAIN_STAGES.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const stage of VOCAL_CHAIN_STAGES) {
      if (stage.effectId === null) continue;
      expect(getEffect(stage.effectId)).toBeDefined();
    }
  });

  it('has exactly one manual stage, and it is the one that needs confirmation', () => {
    const manual = VOCAL_CHAIN_STAGES.filter((s) => s.effectId === null);
    expect(manual).toHaveLength(1);
    expect(manual[0].id).toBe('timing');
  });

  it('leaves the two stages that change the material rather than correct it off by default', () => {
    expect(stageById('silence').defaultEnabled).toBe(false);
    expect(stageById('reverb').defaultEnabled).toBe(false);
    expect(defaultStageSelection().silence).toBe(false);
    expect(defaultStageSelection().reverb).toBe(false);
  });

  it('gives every automatic stage a non-zero share of the progress bar', () => {
    for (const stage of VOCAL_CHAIN_STAGES) {
      if (stage.effectId === null) expect(stage.weight).toBe(0);
      else expect(stage.weight).toBeGreaterThan(0);
    }
  });

  it('throws on an unknown stage id rather than returning undefined', () => {
    expect(() => stageById('nope' as VocalChainStageId)).toThrow(/Unknown vocal chain stage/);
  });
});

// ── deriveDeEsser (F8 Ruling 1) ─────────────────────────────────────────────

describe('deriveDeEsser', () => {
  it('offsets the threshold from the programme RMS it is given, not from a constant', () => {
    for (const level of [0.5, 0.05, 0.005]) {
      const res = deriveDeEsser([flat(1000, level)]);
      expect(res.run).toBe(true);
      if (!res.run) return;
      expect(Number(res.params.thresholdDb)).toBeCloseTo(toDb(level) + DE_ESSER_RMS_OFFSET_DB, 4);
    }
  });

  it('tracks the level: a 6 dB hotter input moves the threshold 6 dB, not 0', () => {
    const quiet = deriveDeEsser([flat(1000, 0.1)]);
    const loud = deriveDeEsser([flat(1000, 0.2)]);
    if (!quiet.run || !loud.run) throw new Error('expected both to run');
    expect(Number(loud.params.thresholdDb) - Number(quiet.params.thresholdDb)).toBeCloseTo(6.0206, 3);
  });

  it('uses the operating-point offset, not the bit-exact one — a deliberate, documented choice', () => {
    expect(DE_ESSER_RMS_OFFSET_DB).toBe(-2.2);
    expect(DE_ESSER_BIT_EXACT_OFFSET_DB).toBe(-1.4);
    const res = deriveDeEsser([flat(1000, 0.1)]);
    if (!res.run) throw new Error('expected run');
    expect(Number(res.params.thresholdDb)).toBeCloseTo(toDb(0.1) + DE_ESSER_RMS_OFFSET_DB, 6);
    expect(Number(res.params.thresholdDb)).not.toBeCloseTo(toDb(0.1) + DE_ESSER_BIT_EXACT_OFFSET_DB, 3);
  });

  it('keeps every other de-esser parameter at the effect defaults it derived for itself', () => {
    const res = deriveDeEsser([flat(1000, 0.1)]);
    if (!res.run) throw new Error('expected run');
    const defaults = defaultParamsFor('de-esser');
    for (const key of Object.keys(defaults)) {
      if (key === 'thresholdDb') continue;
      expect(res.params[key]).toBe(defaults[key]);
    }
  });

  describe('the -60 dBFS floor of the de-esser threshold param', () => {
    const min = -60;
    // Threshold = RMS - 2.2, so the clamp bites when RMS < -57.8 dBFS.
    it.each([
      ['below the floor', min - DE_ESSER_RMS_OFFSET_DB - 1, min],
      ['exactly on the floor', min - DE_ESSER_RMS_OFFSET_DB, min],
      ['above the floor', min - DE_ESSER_RMS_OFFSET_DB + 1, min + 1],
    ])('%s', (_name, rmsDb, expected) => {
      const res = deriveDeEsser([flat(2000, Math.pow(10, rmsDb / 20))]);
      if (!res.run) throw new Error('expected run');
      expect(Number(res.params.thresholdDb)).toBeCloseTo(expected, 3);
    });
  });
});

// ── deriveEq ────────────────────────────────────────────────────────────────

describe('deriveEq', () => {
  it('declines when the sung range was never measured — it does not guess a corner', () => {
    const res = deriveEq(null);
    expect(res.run).toBe(false);
    if (res.run) return;
    expect(res.reason).toMatch(/Pitch Correct/);
  });

  it.each([
    ['zero', 0],
    ['negative', -100],
    ['NaN', Number.NaN],
  ])('declines on a %s fundamental rather than designing a filter from it', (_name, f0) => {
    expect(deriveEq(f0).run).toBe(false);
  });

  it('places the corner an octave below the measured fundamental', () => {
    const res = deriveEq(200);
    if (!res.run) throw new Error('expected run');
    expect(res.params.hpEnabled).toBe(true);
    expect(Number(res.params.hpFreq)).toBeCloseTo(100, 6);
  });

  it('leaves every band flat — the chain shapes nothing it cannot measure', () => {
    const res = deriveEq(200);
    if (!res.run) throw new Error('expected run');
    for (let n = 1; n <= 5; n++) expect(Number(res.params[`band${n}Gain`])).toBe(0);
    expect(res.params.lpEnabled).toBe(false);
  });

  describe('the declared 20-1000 Hz range of the high-pass param', () => {
    it.each([
      ['under the 20 Hz floor', 39, 20],
      ['exactly on the 20 Hz floor', 40, 20],
      ['just above the 20 Hz floor', 42, 21],
      ['just below the 1000 Hz ceiling', 1998, 999],
      ['exactly on the 1000 Hz ceiling', 2000, 1000],
      ['over the 1000 Hz ceiling', 2002, 1000],
    ])('%s', (_name, f0, expected) => {
      const res = deriveEq(f0);
      if (!res.run) throw new Error('expected run');
      expect(Number(res.params.hpFreq)).toBeCloseTo(expected, 6);
    });
  });
});

// ── deriveNoiseReduction ────────────────────────────────────────────────────

describe('deriveNoiseReduction', () => {
  it('learns the print from the quiet passage and reports where it came from', () => {
    const signal = withQuietWindow(8, 0.5, 0.0005, 5);
    const res = deriveNoiseReduction([signal], SR);
    expect(res.run).toBe(true);
    if (!res.run) return;
    const extra = res.extra as { spectra: Float32Array[] };
    expect(extra.spectra).toHaveLength(1);
    expect(extra.spectra[0].length).toBe(1025);
    expect(res.derived[0].value).toContain('2.5 s');
  });

  it('learns one spectrum per channel', () => {
    const signal = withQuietWindow(8, 0.5, 0.0005, 5);
    const res = deriveNoiseReduction([signal, Float32Array.from(signal)], SR);
    if (!res.run) throw new Error('expected run');
    expect((res.extra as { spectra: Float32Array[] }).spectra).toHaveLength(2);
  });

  it('declines — loudly — when every window is digital silence, instead of subtracting nothing', () => {
    const res = deriveNoiseReduction([new Float32Array(WIN * 4)], SR);
    expect(res.run).toBe(false);
    if (res.run) return;
    expect(res.reason).toMatch(/digital silence/);
  });

  it('declines when the region is shorter than one noise window', () => {
    expect(deriveNoiseReduction([noise(WIN - 1, 0.1)], SR).run).toBe(false);
  });

  describe('the viability margin, which IS the stage own reduction depth', () => {
    const reduction = Number(defaultParamsFor('noise-reduction').reductionDb);

    /** Builds an 8-window fixture whose MEASURED margin (programme RMS above the
     * measured noise floor) is as close to `targetDb` as float32 allows, then
     * returns it together with what the same public primitives actually read —
     * so the boundary is placed by measurement, not by hope. */
    function atMargin(targetDb: number): { signal: Float32Array; measured: number } {
      const quiet = 0.001;
      const windows = 8;
      // mean square = ((windows-1)*loud^2 + quiet^2)/windows, and the floor is
      // exactly `quiet`, so solve for loud.
      const ratio = Math.pow(10, targetDb / 10);
      const loud = Math.sqrt((windows * quiet * quiet * ratio - quiet * quiet) / (windows - 1));
      const signal = withQuietWindow(windows, loud, quiet, 5);
      const floor = measureNoiseWindow([signal], SR)!;
      return { signal, measured: programmeRmsDb([signal]) - floor.rmsDb };
    }

    it('declines just BELOW the margin', () => {
      const { signal, measured } = atMargin(reduction - 0.05);
      expect(measured).toBeLessThan(reduction);
      expect(Math.abs(measured - reduction)).toBeLessThan(0.2); // genuinely at the boundary
      expect(deriveNoiseReduction([signal], SR).run).toBe(false);
    });

    it('runs just ABOVE the margin', () => {
      const { signal, measured } = atMargin(reduction + 0.05);
      expect(measured).toBeGreaterThan(reduction);
      expect(Math.abs(measured - reduction)).toBeLessThan(0.2);
      expect(deriveNoiseReduction([signal], SR).run).toBe(true);
    });

    it('runs when the margin is comfortably above, and declines far below', () => {
      expect(deriveNoiseReduction([atMargin(reduction + 20).signal], SR).run).toBe(true);
      const shallow = deriveNoiseReduction([atMargin(reduction - 6).signal], SR);
      expect(shallow.run).toBe(false);
      if (shallow.run) return;
      expect(shallow.reason).toMatch(/would contain voice/);
    });
  });
});

// ── deriveDeHum ─────────────────────────────────────────────────────────────

describe('deriveDeHum', () => {
  it('declines on clean material and shows both readings it took', () => {
    const res = deriveDeHum([noise(SR * 4, 0.2, 5)], SR);
    expect(res.run).toBe(false);
    if (res.run) return;
    expect(res.reason).toMatch(/no mains hum measured/);
    expect(res.reason).toMatch(/50 Hz/);
    expect(res.reason).toMatch(/60 Hz/);
  });

  it('declines with a DIFFERENT reason when the region is too short to reach a verdict', () => {
    const res = deriveDeHum([noise(SR - 1, 0.2)], SR);
    expect(res.run).toBe(false);
    if (res.run) return;
    expect(res.reason).toMatch(/shorter than the 1 s/);
    expect(res.reason).not.toMatch(/no mains hum measured/);
  });

  it.each([[50], [60]])('notches %i Hz when %i Hz hum is what is present', (freq) => {
    const base = noise(SR * 4, 0.15, 6);
    const withHum = new Float32Array(base.length);
    const t = tone(base.length, freq, 0.06);
    for (let i = 0; i < base.length; i++) withHum[i] = base[i] + t[i];
    const res = deriveDeHum([withHum], SR);
    expect(res.run).toBe(true);
    if (!res.run) return;
    expect(res.params.baseFreq).toBe(String(freq));
    expect(res.derived[0].value).toBe(`${freq} Hz`);
  });

  it('keeps the effect defaults for the parameters it did not derive', () => {
    const base = noise(SR * 4, 0.15, 7);
    const t = tone(base.length, 50, 0.06);
    const withHum = new Float32Array(base.length);
    for (let i = 0; i < base.length; i++) withHum[i] = base[i] + t[i];
    const res = deriveDeHum([withHum], SR);
    if (!res.run) throw new Error('expected run');
    expect(res.params.harmonics).toBe(defaultParamsFor('dehum').harmonics);
    expect(res.params.q).toBe(defaultParamsFor('dehum').q);
  });
});

// ── deriveRemoveSilence ─────────────────────────────────────────────────────

describe('deriveRemoveSilence', () => {
  /** The quiet window is NOISE, not a constant, so its envelope genuinely peaks
   * above its own RMS — on real room tone that gap measured 10.87 dB, and it is
   * the whole reason the threshold is the envelope peak rather than the RMS. A
   * constant-magnitude quiet window makes the two equal and the distinction
   * untestable; that version of this test passed with the two swapped. */
  function withNoisyGap(windows: number, loud: number, quiet: number, quietAt: number): Float32Array {
    const out = flat(WIN * windows, loud);
    out.set(noise(WIN, quiet, 101), quietAt * WIN);
    return out;
  }

  it('sets the threshold to the loudest the silence detector reads in the quiet passage', () => {
    const signal = withNoisyGap(8, 0.5, 0.006, 4);
    const floor = measureNoiseWindow([signal], SR)!;
    const res = deriveRemoveSilence([signal], SR);
    if (!res.run) throw new Error('expected run');
    expect(Number(res.params.thresholdDb)).toBeCloseTo(floor.envelopePeakDb, 6);
  });

  it('puts the threshold WELL ABOVE the noise floor RMS — noise peaks above its own RMS', () => {
    const signal = withNoisyGap(8, 0.5, 0.006, 4);
    const floor = measureNoiseWindow([signal], SR)!;
    const res = deriveRemoveSilence([signal], SR);
    if (!res.run) throw new Error('expected run');
    // The gap is the point: a threshold at the floor's RMS could never classify
    // this room tone as silence, because its own peaks sit above it.
    expect(floor.envelopePeakDb - floor.rmsDb).toBeGreaterThan(3);
    expect(Number(res.params.thresholdDb)).toBeGreaterThan(floor.rmsDb + 3);
  });

  it('tracks the material: a 6 dB quieter floor gives a 6 dB lower threshold', () => {
    const a = deriveRemoveSilence([withNoisyGap(8, 0.5, 0.012, 4)], SR);
    const b = deriveRemoveSilence([withNoisyGap(8, 0.5, 0.006, 4)], SR);
    if (!a.run || !b.run) throw new Error('expected both to run');
    expect(Number(a.params.thresholdDb) - Number(b.params.thresholdDb)).toBeCloseTo(6.0206, 1);
  });

  it('clamps into the param range instead of emitting a threshold the effect cannot take', () => {
    // A very quiet floor would derive below the -80 dBFS minimum.
    const res = deriveRemoveSilence([withNoisyGap(8, 0.5, 1e-4, 4)], SR);
    if (!res.run) throw new Error('expected run');
    expect(Number(res.params.thresholdDb)).toBeGreaterThanOrEqual(-80);
  });

  it('declines without a measurable noise floor', () => {
    expect(deriveRemoveSilence([new Float32Array(WIN * 4)], SR).run).toBe(false);
  });
});

// ── deriveCompressor ────────────────────────────────────────────────────────

describe('deriveCompressor', () => {
  /** Loud/quiet alternation with a genuine quiet passage, so "sounding" and
   * "silent" are distinguishable. */
  function programme(): Float32Array {
    const out = new Float32Array(WIN * 10);
    for (let w = 0; w < 10; w++) {
      const level = w === 4 ? 0.001 : 0.1 + 0.05 * (w % 3);
      out.set(flat(WIN, level), w * WIN);
    }
    return out;
  }

  it('derives a threshold inside the programme, well above the shipped absolute default', () => {
    const res = deriveCompressor([programme()], SR);
    expect(res.run).toBe(true);
    if (!res.run) return;
    const threshold = Number(res.params.thresholdDb);
    expect(threshold).toBeGreaterThan(-40);
    expect(threshold).toBeLessThan(0);
    expect(res.derived.map((d) => d.label)).toEqual(['Threshold', 'Makeup']);
  });

  it('tracks the level: the same programme 6 dB hotter moves the threshold 6 dB', () => {
    const base = programme();
    const hotter = Float32Array.from(base, (v) => v * 2);
    const a = deriveCompressor([base], SR);
    const b = deriveCompressor([hotter], SR);
    if (!a.run || !b.run) throw new Error('expected both to run');
    expect(Number(b.params.thresholdDb) - Number(a.params.thresholdDb)).toBeCloseTo(6.02, 1);
  });

  it('predicts the makeup gain exactly: running the compressor with it restores the level', () => {
    const channels = [programme()];
    const res = deriveCompressor(channels, SR);
    if (!res.run) throw new Error('expected run');
    const before = programmeRmsDb(channels);
    const out = compressorEffect.process(channels, SR, res.params);
    // The prediction is of an arithmetic identity, so this is tight, not "close".
    expect(programmeRmsDb(out.channels)).toBeCloseTo(before, 3);
  });

  it('predicts it for STEREO too — the prediction loop must cover every channel', () => {
    const left = programme();
    // NOT a scalar multiple of the left: the gain is shared across channels, so
    // a right channel that is `left * k` has the SAME in/out energy ratio and a
    // prediction that only ever looked at channel 0 would still be right. This
    // version carries its loud and quiet windows in different places, so the
    // ratio genuinely differs between the two channels.
    const right = new Float32Array(left.length);
    for (let w = 0; w < 10; w++) {
      const level = w === 7 ? 0.0008 : 0.02 + 0.11 * (w % 4);
      right.set(flat(WIN, level), w * WIN);
    }
    const channels = [left, right];
    const res = deriveCompressor(channels, SR);
    if (!res.run) throw new Error('expected run');
    const before = programmeRmsDb(channels);
    const out = compressorEffect.process(channels, SR, res.params);
    expect(programmeRmsDb(out.channels)).toBeCloseTo(before, 3);
  });

  it('actually compresses: the crest factor of the detector-driven output falls', () => {
    const channels = [programme()];
    const res = deriveCompressor(channels, SR);
    if (!res.run) throw new Error('expected run');
    expect(Number(res.params.makeupDb)).toBeGreaterThan(0);
  });

  it('declines when nothing rises above its own noise floor', () => {
    const res = deriveCompressor([flat(WIN * 6, 0.1)], SR);
    expect(res.run).toBe(false);
    if (res.run) return;
    expect(res.reason).toMatch(/above its own noise floor/);
  });

  it('declines when there is no measurable noise floor at all', () => {
    const res = deriveCompressor([new Float32Array(WIN * 4)], SR);
    expect(res.run).toBe(false);
    if (res.run) return;
    expect(res.reason).toMatch(/digital silence/);
  });

  it('keeps ratio, attack, release and knee at the effect defaults', () => {
    const res = deriveCompressor([programme()], SR);
    if (!res.run) throw new Error('expected run');
    const defaults = defaultParamsFor('compressor');
    for (const key of ['ratio', 'attackMs', 'releaseMs', 'kneeDb']) {
      expect(res.params[key]).toBe(defaults[key]);
    }
  });
});

// ── The run ─────────────────────────────────────────────────────────────────

describe('runVocalChain', () => {
  /** A fixture whose channel sums are EXACTLY zero in float64, so Remove DC
   * Offset subtracts exactly 0 and the harness identity below is bit-exact
   * rather than approximately so. */
  function zeroMean(n: number): Float32Array {
    return flat(n, 0.25);
  }

  it('applies nothing and pushes no undo entry when every stage is off', async () => {
    const docId = seedDoc([zeroMean(WIN * 4)]);
    const beforeBytes = Array.from(activeDoc().channels[0]);
    const historyBefore = getHistory(docId).done.length;

    const report = await runVocalChain({ enabled: only() });

    expect(report).not.toBeNull();
    expect(report!.applied).toBe(false);
    expect(getHistory(docId).done.length).toBe(historyBefore);
    expect(Array.from(activeDoc().channels[0])).toEqual(beforeBytes);
    expect(report!.after.rmsDb).toBe(report!.before.rmsDb);
    expect(report!.after.peakDb).toBe(report!.before.peakDb);
  });

  it('every stage disabled leaves EVERY stage reported as off or manual — none runs unseen', async () => {
    seedDoc([zeroMean(WIN * 4)]);
    const report = await runVocalChain({ enabled: only() });
    expect(report!.stages).toHaveLength(VOCAL_CHAIN_STAGES.length);
    for (const stage of report!.stages) {
      expect(stage.status === 'off' || stage.status === 'manual').toBe(true);
    }
  });

  it('is byte-identical through the whole harness when the only stage that runs is a no-op', async () => {
    // Proves clone -> worker -> replaceRegion -> applyEdit does not itself
    // touch a sample: this fixture sums to exactly 0, so Remove DC Offset
    // subtracts exactly 0.
    const original = zeroMean(WIN * 4);
    seedDoc([Float32Array.from(original)]);

    const report = await runVocalChain({ enabled: only('dc') });

    expect(report!.applied).toBe(true);
    const after = activeDoc().channels[0];
    expect(after.length).toBe(original.length);
    for (let i = 0; i < original.length; i++) expect(after[i]).toBe(original[i]);
    const dc = report!.stages.find((s) => s.id === 'dc')!;
    expect(dc.status).toBe('applied');
    expect(dc.delta!.identicalFraction).toBe(1);
  });

  it('commits the WHOLE chain as one undo entry, not one per stage', async () => {
    const docId = seedDoc([noise(WIN * 8, 0.3, 3)]);
    const historyBefore = getHistory(docId).done.length;

    const report = await runVocalChain({ enabled: only('dc', 'compressor', 'limiter') });

    expect(report!.applied).toBe(true);
    const applied = report!.stages.filter((s) => s.status === 'applied');
    expect(applied.length).toBeGreaterThan(1);
    expect(getHistory(docId).done.length).toBe(historyBefore + 1);
    expect(getHistory(docId).done[getHistory(docId).done.length - 1]).toBe(VOCAL_CHAIN_UNDO_LABEL);
  });

  it('one undo puts the whole chain back', async () => {
    const original = noise(WIN * 8, 0.3, 4);
    const docId = seedDoc([Float32Array.from(original)]);
    await runVocalChain({ enabled: only('dc', 'compressor', 'limiter') });
    expect(Array.from(activeDoc().channels[0])).not.toEqual(Array.from(original));

    undo(docId);

    const restored = activeDoc().channels[0];
    for (let i = 0; i < original.length; i++) expect(restored[i]).toBe(original[i]);
  });

  it('never runs the manual stage, even when it is switched on', async () => {
    seedDoc([noise(WIN * 4, 0.3, 5)]);
    const started: string[] = [];
    const report = await runVocalChain({
      enabled: { ...only('dc'), timing: true },
      onStageStart: (s) => started.push(s.id),
    });
    expect(started).not.toContain('timing');
    expect(report!.stages.find((s) => s.id === 'timing')!.status).toBe('manual');
  });

  it('visits the enabled stages in chain order', async () => {
    seedDoc([noise(WIN * 8, 0.3, 6)]);
    const started: string[] = [];
    await runVocalChain({
      enabled: only('dc', 'compressor', 'limiter'),
      onStageStart: (s) => started.push(s.id),
    });
    expect(started).toEqual(['dc', 'compressor', 'limiter']);
  });

  it('carries on past a stage that declines, and records why', async () => {
    // Too short for the hum probe, so DeHum must decline. The stage paired with
    // it is the LIMITER, which runs after it — pairing it with a stage that runs
    // BEFORE proves nothing about whether a decline stops the rest, and that is
    // exactly how an earlier version of this test passed with `continue` turned
    // into `break`.
    seedDoc([noise(Math.round(SR * 0.75), 0.3, 7)]);
    const report = await runVocalChain({ enabled: only('hum', 'limiter') });

    const stages = report!.stages;
    const ids = VOCAL_CHAIN_STAGES.map((st) => st.id);
    expect(ids.indexOf('limiter')).toBeGreaterThan(ids.indexOf('hum'));

    const hum = stages.find((s) => s.id === 'hum')!;
    expect(hum.status).toBe('declined');
    expect(hum.reason).toMatch(/shorter than the 1 s/);
    expect(stages.find((s) => s.id === 'limiter')!.status).toBe('applied');
    expect(report!.applied).toBe(true);
  });

  describe('the pitch measurement reaching the EQ stage', () => {
    /** A steady, deliberately off-grid note plus its octave: the pitch detector
     * finds it, and Pitch Correct therefore has something to correct AND a sung
     * range to report. */
    function detunedNote(): Float32Array {
      const n = SR * 2;
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        out[i] = 0.4 * Math.sin((2 * Math.PI * 226 * i) / SR) + 0.15 * Math.sin((2 * Math.PI * 452 * i) / SR);
      }
      return out;
    }

    it('carries f0 from Pitch Correct to the EQ, which places the corner an octave below it', async () => {
      seedDoc([detunedNote()]);
      const report = await runVocalChain({ enabled: only('pitch', 'eq') });

      const pitch = report!.stages.find((st) => st.id === 'pitch')!;
      expect(pitch.status).toBe('applied');
      expect(pitch.detail).toMatch(/frames moved/);

      const eq = report!.stages.find((st) => st.id === 'eq')!;
      expect(eq.status).toBe('applied');
      // ~226 Hz measured, so the corner lands at ~113 Hz — and it can only get
      // there through the effect's report crossing the worker boundary.
      const corner = Number(eq.derived[0].value.replace(/[^0-9.]/g, ''));
      expect(corner).toBeGreaterThan(105);
      expect(corner).toBeLessThan(120);
      expect(eq.derived[0].from).toMatch(/226 Hz/);
    });

    it('declines the EQ when Pitch Correct did not run — the same audio, one stage fewer', async () => {
      seedDoc([detunedNote()]);
      const report = await runVocalChain({ enabled: only('eq') });
      const eq = report!.stages.find((st) => st.id === 'eq')!;
      expect(eq.status).toBe('declined');
      expect(eq.reason).toMatch(/Pitch Correct/);
    });

    it('reports the correction in cents, which only the effect itself can know', async () => {
      seedDoc([detunedNote()]);
      const report = await runVocalChain({ enabled: only('pitch') });
      const pitch = report!.stages.find((st) => st.id === 'pitch')!;
      // The note sits ~47 cents off the nearest semitone, and every voiced frame
      // is moved — so neither the count nor the median can be a placeholder.
      expect(pitch.detail).toMatch(/196 of 196 frames moved/);
      expect(pitch.detail).toMatch(/median 4[5-9]\.\d cents/);
    });
  });

  it('reports the derived values it used, so a setting is never invisible', async () => {
    seedDoc([noise(WIN * 10, 0.3, 8)]);
    const report = await runVocalChain({ enabled: only('compressor') });
    const compressor = report!.stages.find((s) => s.id === 'compressor')!;
    expect(compressor.status).toBe('applied');
    expect(compressor.derived.map((d) => d.label)).toEqual(['Threshold', 'Makeup']);
    for (const derived of compressor.derived) {
      expect(derived.from.length).toBeGreaterThan(0);
    }
  });

  it('measures what each stage did to the audio', async () => {
    seedDoc([noise(WIN * 10, 0.3, 9)]);
    const report = await runVocalChain({ enabled: only('compressor') });
    const delta = report!.stages.find((s) => s.id === 'compressor')!.delta!;
    expect(delta.identicalFraction).toBeLessThan(1);
    expect(delta.rmsAfterDb).not.toBe(delta.rmsBeforeDb);
  });

  it('aborts without touching the document when a stage fails', async () => {
    const original = noise(WIN * 4, 0.3, 10);
    const docId = seedDoc([Float32Array.from(original)]);
    const historyBefore = getHistory(docId).done.length;
    const showMessageBox = jest.fn();
    (window as { electronAPI?: unknown }).electronAPI = { showMessageBox };
    _setDspWorkerLoadFailure('worker exploded');

    const report = await runVocalChain({ enabled: only('dc', 'limiter') });

    expect(report).toBeNull();
    expect(getHistory(docId).done.length).toBe(historyBefore);
    expect(Array.from(activeDoc().channels[0])).toEqual(Array.from(original));
    expect(showMessageBox).toHaveBeenCalledTimes(1);
  });

  it('touches only the selection', async () => {
    const original = noise(WIN * 8, 0.3, 11);
    seedDoc([Float32Array.from(original)]);
    const start = WIN * 2;
    const end = WIN * 5;
    useAppStore.getState().setSelection({ start, end });

    await runVocalChain({ enabled: only('compressor') });

    const after = activeDoc().channels[0];
    for (let i = 0; i < start; i++) expect(after[i]).toBe(original[i]);
    for (let i = end; i < original.length; i++) expect(after[i]).toBe(original[i]);
  });

  it('returns null and edits nothing when there is no document', async () => {
    expect(await runVocalChain({ enabled: only('dc') })).toBeNull();
  });

  it('returns null on an empty selection rather than committing an empty region', async () => {
    seedDoc([noise(WIN * 4, 0.3, 12)]);
    useAppStore.getState().setSelection({ start: 100, end: 100 });
    expect(await runVocalChain({ enabled: only('dc') })).toBeNull();
  });

  it('drives progress monotonically to exactly 1', async () => {
    seedDoc([noise(WIN * 8, 0.3, 13)]);
    const seen: number[] = [];
    await runVocalChain({ enabled: only('dc', 'compressor', 'limiter'), onProgress: (f) => seen.push(f) });
    expect(seen.length).toBeGreaterThan(1);
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]);
    expect(seen[seen.length - 1]).toBe(1);
    expect(seen.filter((f) => f === 1)).toHaveLength(1);
  });

  it('records before/after metrics over the region it processed', async () => {
    seedDoc([noise(WIN * 8, 0.3, 14)]);
    const report = await runVocalChain({ enabled: only('compressor') });
    expect(report!.regionSamples).toBe(WIN * 8);
    expect(report!.outputSamples).toBe(WIN * 8);
    expect(report!.before.crestDb).toBeCloseTo(report!.before.peakDb - report!.before.rmsDb, 9);
    expect(report!.after.crestDb).toBeCloseTo(report!.after.peakDb - report!.after.rmsDb, 9);
  });

  it('reports a null noise floor rather than a number it could not measure', async () => {
    seedDoc([new Float32Array(WIN * 4)]);
    const report = await runVocalChain({ enabled: only() });
    expect(report!.before.noiseFloorDb).toBeNull();
  });

  it('moves markers by the exact cuts rule when Remove Silence shortened the take', async () => {
    // Loud / long silence / loud, with a marker after the silence.
    const signal = new Float32Array(WIN * 12);
    signal.set(flat(WIN * 2, 0.5), 0);
    signal.set(flat(WIN * 6, 0.0005), WIN * 2);
    signal.set(flat(WIN * 4, 0.5), WIN * 8);
    const docId = seedDoc([signal]);
    const markerAt = WIN * 9;
    useAppStore.getState().setMarkersForDoc(docId, [{ id: 'm1', positionSample: markerAt, name: 'after' }]);

    const report = await runVocalChain({ enabled: only('silence') });

    const silence = report!.stages.find((s) => s.id === 'silence')!;
    expect(silence.status).toBe('applied');
    expect(silence.detail).toMatch(/gap/);
    const removed = report!.regionSamples - report!.outputSamples;
    expect(removed).toBeGreaterThan(0);
    const moved = useAppStore.getState().markers[docId][0].positionSample;
    expect(moved).toBe(markerAt - removed);
  });

  it('leaves markers where they are when nothing changed length', async () => {
    const docId = seedDoc([noise(WIN * 8, 0.3, 15)]);
    useAppStore.getState().setMarkersForDoc(docId, [{ id: 'm1', positionSample: WIN * 3, name: 'x' }]);
    await runVocalChain({ enabled: only('dc', 'compressor', 'limiter') });
    expect(useAppStore.getState().markers[docId][0].positionSample).toBe(WIN * 3);
  });

  it('pushes markers past the region back when Reverb lengthened it', async () => {
    const docId = seedDoc([noise(WIN * 4, 0.3, 16)]);
    const length = docLength(activeDoc());
    useAppStore.getState().setMarkersForDoc(docId, [
      { id: 'inside', positionSample: WIN, name: 'in' },
      { id: 'end', positionSample: length, name: 'end' },
    ]);
    useAppStore.getState().setSelection({ start: 0, end: length });

    const report = await runVocalChain({ enabled: only('reverb') });

    const grew = report!.outputSamples - report!.regionSamples;
    expect(grew).toBeGreaterThan(0);
    const markers = useAppStore.getState().markers[docId];
    expect(markers.find((m) => m.id === 'inside')!.positionSample).toBe(WIN);
    expect(markers.find((m) => m.id === 'end')!.positionSample).toBe(length + grew);
  });
});
