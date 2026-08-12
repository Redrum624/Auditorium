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
import { ALIGN_ACCURACY_SENTENCE } from '../dsp/ctcAlign';
import { measureNoiseWindow, programmeRmsDb, toDb } from '../dsp/chainAnalysis';
import { envelopeFollower, maxAcrossChannels } from '../dsp/envelope';
import { DETECT_ATTACK_MS, DETECT_RELEASE_MS } from '../dsp/silenceDetect';
import { silenceRemoverEffect } from '../effects/restoration/SilenceRemoverEffect';
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
  it('runs the corrections in the reasoned order, with the EQ and the reverb before the limiter', () => {
    expect(VOCAL_CHAIN_STAGES.map((s) => s.id)).toEqual([
      'dc',
      'lyrics',
      'noise',
      'hum',
      'silence',
      'timing',
      'pitch',
      'compressor',
      'deEsser',
      'eq',
      'reverb',
      'limiter',
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

  // The reverb used to be the last entry in this array, and this test asserted
  // exactly that. It was changed deliberately: `reverb` sums a wet tail on top
  // of the dry signal, so a reverb AFTER the limiter takes the output back over
  // full scale — measured through `runVocalChain` at +6.53 dBFS on noise
  // limited to -0.3 dBFS. The reason the old assertion gave for reverb being
  // last is preserved below and is what is actually asserted now: nothing that
  // COMPRESSES OR PITCH-CORRECTS may see the tail. The limiter is neither; its
  // whole job is to see the final peak.
  it('runs reverb after every stage that measures or shapes the voice', () => {
    const ids = VOCAL_CHAIN_STAGES.map((s) => s.id);
    for (const shaper of ['dc', 'noise', 'hum', 'silence', 'pitch', 'compressor', 'deEsser', 'eq'] as const) {
      expect(ids.indexOf('reverb')).toBeGreaterThan(ids.indexOf(shaper));
    }
  });

  it('runs the Limiter LAST of every stage that touches the audio, reverb included', () => {
    // Not tidiness. The limiter's own note, rendered verbatim to the user,
    // promises that nothing downstream can lift the output back over the
    // ceiling — a promise that is only true when nothing is downstream. The
    // end-to-end proof is the Ruling-C test far below; this one pins the array
    // that decides it, because `runVocalChain` iterates it in order.
    const last = VOCAL_CHAIN_STAGES[VOCAL_CHAIN_STAGES.length - 1];
    expect(last.id).toBe('limiter');
    const audible = VOCAL_CHAIN_STAGES.filter((s) => s.effectId !== null);
    expect(audible[audible.length - 1].id).toBe('limiter');
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

  // Two stages are manual, and every property that makes a stage manual is
  // asserted over BOTH rather than over a named one — a third manual stage
  // added without a weight of 0, or switched on by default, would otherwise
  // slip through a test that only ever looked at `timing`.
  it('marks exactly the two stages that need the user to choose WHAT to change as manual', () => {
    const manual = VOCAL_CHAIN_STAGES.filter((s) => s.effectId === null);
    expect(manual.map((s) => s.id)).toEqual(['lyrics', 'timing']);
    for (const stage of manual) {
      expect(stage.weight).toBe(0);
      expect(stage.defaultEnabled).toBe(false);
      // Each one tells the user where to run it, and to run it FIRST — a
      // manual stage that did not would be a row that does nothing and says
      // nothing about why.
      expect(stage.note).toContain('Not an automatic stage.');
      expect(stage.note).toContain(`Run Effects → ${stage.label}… FIRST, then this chain`);
    }
  });

  // F6 Ruling 4 — the `lyrics` stage's position, argued against the rules the
  // stages around it already state rather than inherited from a proposal.
  describe("the Align Lyrics stage's position", () => {
    const ids = VOCAL_CHAIN_STAGES.map((s) => s.id);

    it('comes after Remove DC Offset, because the splice matches level by RMS', () => {
      expect(ids.indexOf('lyrics')).toBe(ids.indexOf('dc') + 1);
    });

    it('comes before every stage that MOVES samples, so the word positions still describe the audio', () => {
      // Remove Silence's own note: every sample after the first shortened
      // pause moves earlier. Align Vocal Timing warps. Either one run first
      // would leave the spans pointing at audio that has shifted.
      for (const mover of ['silence', 'timing'] as const) {
        expect(ids.indexOf('lyrics')).toBeLessThan(ids.indexOf(mover));
      }
    });

    it('comes before every stage that MEASURES the material, so the replacement is inside what they measure', () => {
      // A replacement is a fresh microphone take with its own room tone. Every
      // one of these derives its settings from a measurement of the audio that
      // reaches it (the noise print, the compressor threshold, the de-esser
      // threshold, the EQ corner, the limiter's ceiling check).
      for (const measurer of ['noise', 'hum', 'pitch', 'compressor', 'deEsser', 'eq', 'limiter'] as const) {
        expect(ids.indexOf('lyrics')).toBeLessThan(ids.indexOf(measurer));
      }
    });

    it('quotes the CROSS-MODEL accuracy, and only that one', () => {
      const note = stageById('lyrics').note;
      expect(note).toContain(ALIGN_ACCURACY_SENTENCE);
      // Ruling 5: the hand-marked medians (28 ms sung, 36 ms spoken, 48 ms
      // nearest-onset) are upper bounds, because the spike could not listen and
      // legato boundaries are missing from that ground truth. None of them may
      // reach the UI.
      for (const forbidden of ['28 ms', '36 ms', '48 ms']) expect(note).not.toContain(forbidden);
    });

    it('promises no assessment of how any word was sung', () => {
      const note = stageById('lyrics').note.toLowerCase();
      for (const forbidden of ['mispronounce', 'pronunciation', 'score', 'correct pronunciation', 'coach']) {
        expect(note).not.toContain(forbidden);
      }
    });
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

  // ── The knee, pinned against arithmetic the chain does not share ──────────
  // `deriveCompressor` predicts the makeup gain by running the effect's OWN
  // `reductionDb` over the envelope. That is deliberate — it is what stops a
  // second copy of the compression law drifting — but it makes the prediction
  // BLIND to that law being wrong: break the knee and the prediction and the
  // rendering move together, so `predicts the makeup gain exactly` above still
  // passes. Measured: the mutation `/(2 * kneeDb)` -> `/kneeDb` in
  // `CompressorEffect.reductionDb` survives this entire suite.
  //
  // So this test computes the expected makeup from a knee formula written out
  // HERE, and never calls `reductionDb`. Everything else it takes from the
  // chain (the threshold, which the knee does not enter) or from the shared
  // envelope code (which the mutation does not touch), so what is left under
  // test is the compression law itself.
  describe('the makeup prediction, against arithmetic that does not call reductionDb', () => {
    /** Ten half-second windows only ~1.2 dB apart, plus the quiet passage the
     * noise floor needs. The narrow spread is the point: the derived threshold
     * is the median of the sounding envelope, so a programme this tight puts
     * essentially every sounding sample INSIDE the +/- kneeDb/2 knee, where the
     * quadratic branch is the only one that runs. `programme()` spans 6 dB and
     * straddles the knee edge, which is how a broken knee hid there. */
    function kneeProgramme(): Float32Array {
      const levels = [0.14, 0.16, 0.14, 0.16, 0.001, 0.16, 0.14, 0.16, 0.14, 0.16];
      const out = new Float32Array(WIN * levels.length);
      levels.forEach((level, w) => out.set(flat(WIN, level), w * WIN));
      return out;
    }

    /** The standard soft knee, written from the definition rather than
     * imported: no reduction below the knee, `overDb * slope` above it, and a
     * quadratic across a knee `kneeDb` wide centred on the threshold. Reaching
     * for `reductionDb` here would make the whole test a tautology. */
    function expectedReductionDb(overDb: number, ratio: number, kneeDb: number): number {
      const slope = 1 - 1 / ratio;
      const half = kneeDb / 2;
      if (overDb <= -half) return 0;
      if (overDb >= half) return overDb * slope;
      const x = overDb + half; // 0 at the bottom of the knee, kneeDb at the top
      return (slope * x * x) / (2 * kneeDb);
    }

    /** The chain's own prediction loop, with `expectedReductionDb` in place of
     * `reductionDb` and nothing else changed. */
    function expectedMakeupDb(channels: Float32Array[], params: Record<string, unknown>): number {
      const thresholdDb = Number(params.thresholdDb);
      const ratio = Number(params.ratio);
      const kneeDb = Number(params.kneeDb);
      const env = envelopeFollower(
        maxAcrossChannels(channels),
        SR,
        Number(params.attackMs),
        Number(params.releaseMs)
      );
      let sumSqIn = 0;
      let sumSqOut = 0;
      for (let i = 0; i < env.length; i++) {
        const gain = Math.pow(10, -expectedReductionDb(toDb(env[i]) - thresholdDb, ratio, kneeDb) / 20);
        for (const c of channels) {
          const x = c[i];
          sumSqIn += x * x;
          const y = x * gain;
          sumSqOut += y * y;
        }
      }
      return 10 * Math.log10(sumSqIn / sumSqOut);
    }

    it('sits inside the knee, so the quadratic branch is what the number is made of', () => {
      // Guards the test above: if the fixture ever drifted out of the knee, the
      // assertion would still pass and would have stopped measuring anything.
      const channels = [kneeProgramme()];
      const res = deriveCompressor(channels, SR);
      if (!res.run) throw new Error('expected run');
      const kneeDb = Number(res.params.kneeDb);
      expect(kneeDb).toBeGreaterThan(0);

      const floor = measureNoiseWindow(channels, SR)!;
      const gate = Math.pow(10, floor.envelopePeakDb / 20);
      const gateEnv = envelopeFollower(maxAcrossChannels(channels), SR, DETECT_ATTACK_MS, DETECT_RELEASE_MS);
      const compEnv = envelopeFollower(
        maxAcrossChannels(channels),
        SR,
        Number(res.params.attackMs),
        Number(res.params.releaseMs)
      );
      let sounding = 0;
      let inKnee = 0;
      for (let i = 0; i < compEnv.length; i++) {
        if (gateEnv[i] <= gate) continue;
        sounding++;
        if (Math.abs(toDb(compEnv[i]) - Number(res.params.thresholdDb)) <= kneeDb / 2) inKnee++;
      }
      expect(sounding).toBeGreaterThan(0);
      expect(inKnee / sounding).toBeGreaterThan(0.9);
    });

    it('predicts the makeup the soft-knee law actually implies', () => {
      const channels = [kneeProgramme()];
      const res = deriveCompressor(channels, SR);
      if (!res.run) throw new Error('expected run');
      // Tight rather than "close": both sides are the same arithmetic identity
      // in float64, differing only in association.
      expect(Number(res.params.makeupDb)).toBeCloseTo(expectedMakeupDb(channels, res.params), 9);
    });

    it('and that prediction really does depend on the knee', () => {
      // Resolving power. Without this, a knee whose contribution rounded away
      // would let the assertion above pass while measuring nothing: the same
      // loop with the knee taken out has to land somewhere else.
      const channels = [kneeProgramme()];
      const res = deriveCompressor(channels, SR);
      if (!res.run) throw new Error('expected run');
      const withKnee = expectedMakeupDb(channels, res.params);
      const hardKnee = expectedMakeupDb(channels, { ...res.params, kneeDb: 0 });
      expect(Math.abs(withKnee - hardKnee)).toBeGreaterThan(0.05);
    });

    it('predicts it for STEREO too, inside the knee', () => {
      // The prediction loop sums over every channel. A right channel carrying
      // its quiet window somewhere else has a different in/out energy ratio, so
      // a loop that only ever read channel 0 lands on a different number.
      const left = kneeProgramme();
      const rightLevels = [0.15, 0.13, 0.15, 0.13, 0.15, 0.13, 0.15, 0.0009, 0.15, 0.13];
      const right = new Float32Array(left.length);
      rightLevels.forEach((level, w) => right.set(flat(WIN, level), w * WIN));
      const channels = [left, right];
      const res = deriveCompressor(channels, SR);
      if (!res.run) throw new Error('expected run');
      expect(Number(res.params.makeupDb)).toBeCloseTo(expectedMakeupDb(channels, res.params), 9);
    });
  });

  /** Percentiles of 50 ms frame level over SOUNDING frames — the quantity a
   * vocal compressor is there to narrow. Peak-to-RMS crest factor is NOT that
   * quantity: a 10 ms attack does not catch a shorter transient, so crest can
   * rise while the envelope narrows, which is exactly what happens here. */
  function activeLevels(channels: Float32Array[]): { p10: number; p50: number; p90: number } {
    const floor = measureNoiseWindow(channels, SR)!;
    const gate = Math.pow(10, floor.envelopePeakDb / 20);
    const env = envelopeFollower(maxAcrossChannels(channels), SR, DETECT_ATTACK_MS, DETECT_RELEASE_MS);
    const win = Math.round(0.05 * SR);
    const hop = Math.round(0.01 * SR);
    const vals: number[] = [];
    for (let start = 0; start + win <= channels[0].length; start += hop) {
      let sounding = false;
      for (let i = start; i < start + win; i += 8) {
        if (env[i] > gate) {
          sounding = true;
          break;
        }
      }
      if (!sounding) continue;
      let sum = 0;
      for (const c of channels) for (let i = 0; i < win; i++) sum += c[start + i] * c[start + i];
      vals.push(toDb(Math.sqrt(sum / (win * channels.length))));
    }
    vals.sort((a, b) => a - b);
    const q = (f: number): number => vals[Math.min(vals.length - 1, Math.round(f * (vals.length - 1)))];
    return { p10: q(0.1), p50: q(0.5), p90: q(0.9) };
  }

  /** Ten half-second windows spanning ~25 dB of level, one of them the quiet
   * passage the noise floor is measured from. `programme()` spans only 6 dB,
   * which leaves a working compressor able to narrow the spread by under 1 dB —
   * too little to tell from nothing. */
  function wideProgramme(): Float32Array {
    const levels = [0.02, 0.35, 0.05, 0.5, 0.001, 0.03, 0.4, 0.06, 0.45, 0.025];
    const out = new Float32Array(WIN * levels.length);
    levels.forEach((level, w) => out.set(flat(WIN, level), w * WIN));
    return out;
  }

  it('actually compresses: quiet material comes UP, loud material comes DOWN, the spread narrows', () => {
    // Named for what it asserts. The earlier version of this test was named for
    // the crest factor falling and asserted only `makeupDb > 0`, so it passed
    // while the crest factor ROSE — a test named for the one property that
    // became this task's headline concern, unable to observe it.
    const channels = [wideProgramme()];
    const res = deriveCompressor(channels, SR);
    if (!res.run) throw new Error('expected run');
    expect(Number(res.params.makeupDb)).toBeGreaterThan(0);

    const before = activeLevels(channels);
    const after = activeLevels(compressorEffect.process(channels, SR, res.params).channels);

    expect(after.p10).toBeGreaterThan(before.p10);
    expect(after.p90).toBeLessThan(before.p90);
    // Measured on this fixture: p10 +4.65 dB, p50 +6.37, p90 -0.46, so the
    // spread narrows 5.11 dB. The bound sits between that and the 0 dB a
    // compressor that stopped working would give — the same signature the
    // reviewer measured on the real take (p10 +2.00, p90 -0.62, -2.63 dB).
    const spreadBefore = before.p90 - before.p10;
    const spreadAfter = after.p90 - after.p10;
    expect(spreadBefore - spreadAfter).toBeGreaterThan(3);
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

  // ENABLES the manual stages end to end rather than trusting the table. F7
  // shipped a whole stage that could be deleted with the suite still green
  // because no test ever switched it on; a manual stage has the mirror risk —
  // a wiring change that let one reach `resolveStage` would hit
  // `defaultParamsFor(null as string)` and throw, and only a run with it ON
  // can see that.
  const MANUAL_IDS = VOCAL_CHAIN_STAGES.filter((s) => s.effectId === null).map((s) => s.id);

  it.each(MANUAL_IDS)('never runs the manual stage %s, even when it is switched on', async (id) => {
    seedDoc([noise(WIN * 4, 0.3, 5)]);
    const started: string[] = [];
    const report = await runVocalChain({
      enabled: { ...only('dc'), [id]: true },
      onStageStart: (s) => started.push(s.id),
    });
    expect(started).not.toContain(id);
    expect(report!.stages.find((s) => s.id === id)!.status).toBe('manual');
  });

  it('leaves the audio byte-identical when EVERY manual stage is switched on and nothing else is', async () => {
    // The passthrough invariant, restated for the manual stages: switching all
    // of them on must still apply nothing at all. `applied` false is the
    // observable claim — the chain never even reaches `applyEdit`.
    const original = zeroMean(WIN * 4);
    const docId = seedDoc([Float32Array.from(original)]);
    const historyBefore = getHistory(docId).done.length;
    const enabled = only(...MANUAL_IDS);

    const started: string[] = [];
    const report = await runVocalChain({ enabled, onStageStart: (s) => started.push(s.id) });

    expect(started).toEqual([]);
    expect(report!.applied).toBe(false);
    expect(getHistory(docId).done.length).toBe(historyBefore);
    const after = activeDoc().channels[0];
    for (let i = 0; i < original.length; i++) expect(after[i]).toBe(original[i]);
    for (const id of MANUAL_IDS) {
      expect(report!.stages.find((s) => s.id === id)!.status).toBe('manual');
    }
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

  describe('the de-esser stage inside the chain (F8 Ruling 1 — the reason F8 shipped first)', () => {
    /** Loud material either side of a long, very quiet gap. Removing the gap
     * raises the programme RMS a long way, which is what makes it usable as a
     * probe for WHICH buffer a later stage measures. */
    function withLongGap(): Float32Array {
      const out = new Float32Array(WIN * 18);
      out.set(flat(WIN * 3, 0.4), 0);
      out.set(flat(WIN * 12, 0.0006), WIN * 3);
      out.set(flat(WIN * 3, 0.4), WIN * 15);
      return out;
    }

    it('RUNS, and reports the threshold it derived', async () => {
      // Nothing else in this suite enables `deEsser` through runVocalChain, so
      // without this the whole stage could be dropped from `resolveStage` and
      // the suite would stay green (found in review — it did).
      seedDoc([noise(WIN * 8, 0.3, 41)]);
      const report = await runVocalChain({ enabled: only('deEsser') });

      const deEsser = report!.stages.find((st) => st.id === 'deEsser')!;
      expect(deEsser.status).toBe('applied');
      expect(deEsser.derived.map((d) => d.label)).toEqual(['Threshold']);
      expect(report!.applied).toBe(true);
    });

    it('derives its threshold from the SOURCE level when it is the only stage', async () => {
      const source = noise(WIN * 8, 0.3, 42);
      seedDoc([Float32Array.from(source)]);
      const report = await runVocalChain({ enabled: only('deEsser') });
      const threshold = Number(
        report!.stages.find((st) => st.id === 'deEsser')!.derived[0].value.replace(/[^-0-9.]/g, '')
      );
      expect(threshold).toBeCloseTo(programmeRmsDb([source]) + DE_ESSER_RMS_OFFSET_DB, 1);
    });

    it('derives it from the UPSTREAM STAGE OUTPUT, not the source — the ordering is real', async () => {
      // Ruling 1 says the measurement is taken at the de-esser's INPUT. Proving
      // that needs an upstream stage that actually moves the level: the
      // compressor cannot, because its derived makeup restores programme RMS by
      // construction, so source and post-compressor derive the same number and
      // a mis-wired chain would look identical. Remove Silence moves it a lot.
      const source = withLongGap();

      // What the de-esser's input will be: the same fixture after Remove
      // Silence, produced by running the chain with ONLY that stage.
      seedDoc([Float32Array.from(source)]);
      await runVocalChain({ enabled: only('silence') });
      const intermediate = Array.from(activeDoc().channels[0]);
      const intermediateRmsDb = programmeRmsDb([Float32Array.from(intermediate)]);
      const sourceRmsDb = programmeRmsDb([source]);
      // The probe is only meaningful if the two levels genuinely differ.
      expect(Math.abs(intermediateRmsDb - sourceRmsDb)).toBeGreaterThan(2);

      useAppStore.setState(makeInitialState());
      seedDoc([Float32Array.from(source)]);
      const report = await runVocalChain({ enabled: only('silence', 'deEsser') });
      const threshold = Number(
        report!.stages.find((st) => st.id === 'deEsser')!.derived[0].value.replace(/[^-0-9.]/g, '')
      );

      expect(threshold).toBeCloseTo(intermediateRmsDb + DE_ESSER_RMS_OFFSET_DB, 1);
      expect(threshold).not.toBeCloseTo(sourceRmsDb + DE_ESSER_RMS_OFFSET_DB, 1);
    });

    it('tracks a compressor that does NOT give the level back', () => {
      // The chain's own makeup restores programme RMS exactly, so in the shipped
      // configuration "after the compressor" is a numerical no-op. The structure
      // still has to be right, because a user-set makeup breaks that tie — this
      // pins the property directly on the derivation.
      const channels = [noise(WIN * 8, 0.3, 43)];
      const res = deriveCompressor(channels, SR);
      if (!res.run) throw new Error('expected run');

      const restoring = compressorEffect.process(channels, SR, res.params).channels;
      const hotter = compressorEffect.process(channels, SR, {
        ...res.params,
        makeupDb: Number(res.params.makeupDb) + 6,
      }).channels;

      const atSource = deriveDeEsser(channels);
      const atRestoring = deriveDeEsser(restoring);
      const atHotter = deriveDeEsser(hotter);
      if (!atSource.run || !atRestoring.run || !atHotter.run) throw new Error('expected run');

      // Restoring makeup: same number, which is exactly why nothing caught a
      // mis-wired chain until the Remove Silence probe above.
      expect(Number(atRestoring.params.thresholdDb)).toBeCloseTo(Number(atSource.params.thresholdDb), 1);
      // 6 dB of extra makeup must move the threshold 6 dB.
      expect(Number(atHotter.params.thresholdDb) - Number(atRestoring.params.thresholdDb)).toBeCloseTo(6, 1);
    });
  });

  describe('a stage that turned out to have nothing to do', () => {
    it('says so, rather than reporting a blank where its work should be', async () => {
      // The limiter on material far below its ceiling: `gain` stays exactly 1
      // (a + (1 - a) is exact for a in [0.5, 1] by Sterbenz), so every sample
      // comes back bit-identical.
      seedDoc([noise(WIN * 6, 0.05, 44)]);
      const report = await runVocalChain({ enabled: only('limiter') });

      const limiter = report!.stages.find((st) => st.id === 'limiter')!;
      expect(limiter.status).toBe('applied');
      expect(limiter.delta!.identicalFraction).toBe(1);
      expect(limiter.detail).toBe('nothing to do — every sample came back unchanged');
    });

    it('does not claim it when the stage DID change something', async () => {
      seedDoc([noise(WIN * 8, 0.3, 45)]);
      const report = await runVocalChain({ enabled: only('compressor') });
      const compressor = report!.stages.find((st) => st.id === 'compressor')!;
      expect(compressor.delta!.identicalFraction).toBeLessThan(1);
      expect(compressor.detail).toBeUndefined();
    });

    it('lets a stage own account win over the generic one', async () => {
      // Pitch Correct returns a byte-identical copy when it finds nothing to
      // correct, so the generic clause would mask its own message. Steady
      // digital silence is unvoiced throughout: no frame can be corrected.
      seedDoc([new Float32Array(SR * 2)]);
      const report = await runVocalChain({ enabled: only('pitch') });
      const pitch = report!.stages.find((st) => st.id === 'pitch')!;
      expect(pitch.delta!.identicalFraction).toBe(1);
      expect(pitch.detail).toBe('already in tune — no frame was moved');
    });
  });

  describe('the enabled map', () => {
    it('treats an ABSENT stage as off — nothing runs that was not asked for', async () => {
      seedDoc([noise(WIN * 6, 0.3, 46)]);
      const started: string[] = [];
      // Only `dc` is named at all; every other key is missing, not `false`.
      const report = await runVocalChain({
        enabled: { dc: true },
        onStageStart: (st) => started.push(st.id),
      });
      expect(started).toEqual(['dc']);
      for (const stage of report!.stages) {
        if (stage.id === 'dc') expect(stage.status).toBe('applied');
        else expect(stage.status === 'off' || stage.status === 'manual').toBe(true);
      }
    });

    it('treats an EMPTY map as every stage off', async () => {
      seedDoc([noise(WIN * 6, 0.3, 47)]);
      const report = await runVocalChain({ enabled: {} });
      expect(report!.applied).toBe(false);
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

  // ── The ceiling, with Reverb ON ───────────────────────────────────────────
  // The defect this section exists for: `reverb` was registered AFTER `limiter`
  // through v1.23.0, while the limiter's note — rendered verbatim to the user —
  // promised that nothing downstream could lift the output back over the
  // ceiling. Reverb sums a wet tail on top of the dry signal, so it is a level
  // stage whatever its purpose is, and it is downstream of nothing now.
  //
  // Every assertion here is on a fixture that MEASURABLY breaks without the
  // reorder: in the shipped order these three came back at +6.53, +0.98 and
  // +5.51 dBFS, and both `encodeWav` and the MP3 encoder hard-clip that.
  describe('the limiter ceiling holds with Reverb switched on', () => {
    const ceilingDb = () => Number(getEffect('limiter')!.params.find((p) => p.id === 'ceilingDb')!.default);

    /** The peak of what actually landed IN THE DOCUMENT, not of the report —
     * the promise is about the file the user will export. */
    function committedPeakDb(): number {
      let peak = 0;
      for (const c of activeDoc().channels) for (const v of c) peak = Math.max(peak, Math.abs(v));
      return toDb(peak);
    }

    it('catches the tail the reverb summed on top: +6.53 dBFS in the shipped order', async () => {
      // Full-scale noise: the limiter has real work before the reverb even
      // starts, so the take reaching the reverb is genuinely AT the ceiling.
      seedDoc([noise(WIN * 6, 1.0, 77)]);
      const report = await runVocalChain({ enabled: only('limiter', 'reverb') });

      const reverb = report!.stages.find((s) => s.id === 'reverb')!;
      const limiter = report!.stages.find((s) => s.id === 'limiter')!;
      expect(reverb.status).toBe('applied');
      expect(limiter.status).toBe('applied');

      // The fixture really did threaten the ceiling — this is the number the
      // OUTPUT used to be, measured at the reverb's own output, so the test
      // cannot pass because the fixture stopped clipping.
      expect(reverb.delta!.peakAfterDb).toBeGreaterThan(0);
      expect(limiter.delta!.peakBeforeDb).toBe(reverb.delta!.peakAfterDb);

      // THE promise.
      expect(report!.after.peakDb).toBeLessThanOrEqual(ceilingDb() + 0.01);
      expect(report!.after.peakDb).toBeLessThan(0);
      expect(committedPeakDb()).toBeLessThanOrEqual(ceilingDb() + 0.01);
    });

    it('holds on a tone too, where the overshoot was only +0.98 dBFS', async () => {
      // A 220 Hz tone is the cover chain's own probe for this defect, and it
      // overshoots by under a dB — a guard sized to the noise case would miss
      // it, and it would clip just the same.
      seedDoc([tone(WIN * 6, 220, 1.0)]);
      const report = await runVocalChain({ enabled: only('limiter', 'reverb') });

      expect(report!.stages.find((s) => s.id === 'reverb')!.delta!.peakAfterDb).toBeGreaterThan(0);
      expect(report!.after.peakDb).toBeLessThanOrEqual(ceilingDb() + 0.01);
      expect(committedPeakDb()).toBeLessThanOrEqual(ceilingDb() + 0.01);
    });

    it('holds on the path a user actually takes: the default selection with Reverb opted in', async () => {
      // Reverb is `defaultEnabled: false`, which is why this survived — no test
      // ran the default stage list with it on. That list is read from the
      // engine, so a stage added or defaulted differently is covered here too.
      seedDoc([noise(WIN * 6, 1.0, 78)]);
      const enabled = { ...defaultStageSelection(), reverb: true };
      const report = await runVocalChain({ enabled });

      expect(report!.stages.find((s) => s.id === 'reverb')!.status).toBe('applied');
      expect(report!.stages.find((s) => s.id === 'limiter')!.status).toBe('applied');
      expect(report!.after.peakDb).toBeLessThanOrEqual(ceilingDb() + 0.01);
      expect(committedPeakDb()).toBeLessThanOrEqual(ceilingDb() + 0.01);
    });

    it('leaves the tail shaped by the limiter alone — no compressor or pitch stage sees it', async () => {
      // The reason the reverb is late at all. Moving it ahead of the limiter
      // must not move it ahead of anything that would compress or retune a tail
      // the chain just invented, so this asserts against the RUN, not the table:
      // every stage that started before the reverb, and only the limiter after.
      seedDoc([noise(WIN * 6, 0.5, 79)]);
      const started: VocalChainStageId[] = [];
      await runVocalChain({
        enabled: only('pitch', 'compressor', 'deEsser', 'reverb', 'limiter'),
        onStageStart: (s) => started.push(s.id),
      });
      expect(started).toEqual(['pitch', 'compressor', 'deEsser', 'reverb', 'limiter']);
      expect(started.slice(started.indexOf('reverb') + 1)).toEqual(['limiter']);
    });

    // ── …and the path the reorder does NOT close ──────────────────────────
    // The reorder makes the limiter's promise true while the limiter is
    // RUNNING. Switched off, the reverb is the last stage that touches the
    // audio again and the same over-scale buffer reaches both writers. It is
    // WARNED, in the cover chain's Ruling C shape, not blocked.
    it('names the peak when Reverb runs with the Limiter switched off, and still runs', async () => {
      seedDoc([noise(WIN * 6, 1.0, 81)]);
      const report = await runVocalChain({ enabled: only('reverb') });

      const reverb = report!.stages.find((s) => s.id === 'reverb')!;
      expect(reverb.status).toBe('applied');
      // The fixture really does come back over full scale, so the warning has
      // something to be about — it is not firing on a code path.
      expect(reverb.delta!.peakAfterDb).toBeGreaterThan(0);
      expect(report!.after.peakDb).toBeGreaterThan(0);

      expect(reverb.warning).toBeDefined();
      expect(reverb.warning).toMatch(/above full scale/);
      expect(reverb.warning).toMatch(/Limiter/);
      expect(reverb.warning).toMatch(/hard-clip/);
      // THE number, this run's own, not a figure from a document.
      expect(reverb.warning).toContain(`+${reverb.delta!.peakAfterDb.toFixed(1)} dBFS`);

      // A warning, not a refusal: the stage ran and the document was edited.
      expect(report!.applied).toBe(true);
      expect(getHistory(activeDoc().id).done.length).toBeGreaterThan(0);
    });

    it('says nothing when the Limiter is on, because then the ceiling holds', async () => {
      // Same fixture, same over-scale tail at the reverb's OWN output — the one
      // difference is the stage that catches it. A warning that showed here too
      // would be a warning nobody reads.
      seedDoc([noise(WIN * 6, 1.0, 81)]);
      const report = await runVocalChain({ enabled: only('reverb', 'limiter') });

      const reverb = report!.stages.find((s) => s.id === 'reverb')!;
      expect(reverb.status).toBe('applied');
      expect(reverb.delta!.peakAfterDb).toBeGreaterThan(0);
      expect(reverb.warning).toBeUndefined();
      expect(report!.after.peakDb).toBeLessThanOrEqual(ceilingDb() + 0.01);
    });

    it('says nothing on material the tail never takes over full scale', async () => {
      // The limiter is off here too, so this is the peak doing the deciding and
      // not the stage selection.
      seedDoc([noise(WIN * 6, 0.02, 82)]);
      const report = await runVocalChain({ enabled: only('reverb') });

      const reverb = report!.stages.find((s) => s.id === 'reverb')!;
      expect(reverb.status).toBe('applied');
      expect(reverb.delta!.peakAfterDb).toBeLessThan(0);
      expect(reverb.warning).toBeUndefined();
    });

    it('leaves every other stage unwarned — it is the reverb that is unguarded, not the run', async () => {
      // Full-scale noise with the limiter off and the reverb off: the stages
      // that run are level stages too, but none of them SUMS a tail, and none of
      // them may claim the reverb's caveat.
      seedDoc([noise(WIN * 6, 1.0, 83)]);
      const report = await runVocalChain({ enabled: only('dc', 'compressor', 'deEsser') });
      for (const s of report!.stages) expect(s.warning).toBeUndefined();
    });
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

  it('composes the cuts and the tail together when a shortening stage and a growing one both run', async () => {
    // No test ever enabled a stage that SHORTENS and a stage that GROWS in the
    // same run, so `removedTotal` was zero wherever the insert rule reads it:
    // both the tail's LENGTH and the POINT it is inserted at could ignore the
    // cuts entirely and every marker still landed where the suite expected. The
    // two errors do not cancel — they compound, and the marker at the end of the
    // region comes out a whole reverb tail early.
    const signal = new Float32Array(WIN * 12);
    signal.set(flat(WIN * 2, 0.5), 0);
    signal.set(flat(WIN * 6, 0.0005), WIN * 2);
    signal.set(flat(WIN * 4, 0.5), WIN * 8);
    const docId = seedDoc([signal]);
    const length = docLength(activeDoc());
    useAppStore.getState().setMarkersForDoc(docId, [
      { id: 'head', positionSample: WIN, name: 'head' },
      { id: 'afterGap', positionSample: WIN * 9, name: 'after the gap' },
      { id: 'end', positionSample: length, name: 'end' },
    ]);
    useAppStore.getState().setSelection({ start: 0, end: length });

    const report = await runVocalChain({ enabled: only('silence', 'reverb') });
    expect(report!.stages.find((s) => s.id === 'silence')!.status).toBe('applied');
    expect(report!.stages.find((s) => s.id === 'reverb')!.status).toBe('applied');

    // How much Remove Silence takes out, measured from the effect ITSELF on the
    // same audio and the chain's own derived parameters — not read back from the
    // report, whose only length figures are the two the rule under test uses.
    const resolution = deriveRemoveSilence([signal], SR);
    if (!resolution.run) throw new Error('expected run');
    const cut = silenceRemoverEffect.process([Float32Array.from(signal)], SR, resolution.params);
    const removed = signal.length - cut.channels[0].length;
    const tail = report!.outputSamples - (report!.regionSamples - removed);
    // Both stages really did move the length, in opposite directions — without
    // this the test would silently fall back to the single-stage cases above.
    expect(removed).toBeGreaterThan(0);
    expect(tail).toBeGreaterThan(0);

    const markers = useAppStore.getState().markers[docId];
    // Before the gap: untouched by either rule.
    expect(markers.find((m) => m.id === 'head')!.positionSample).toBe(WIN);
    // After the gap and before the tail: moved by the cuts only.
    expect(markers.find((m) => m.id === 'afterGap')!.positionSample).toBe(WIN * 9 - removed);
    // At the end of the region: pulled back by the cuts and pushed forward by
    // the whole tail, which lands it on the region's new end exactly.
    expect(markers.find((m) => m.id === 'end')!.positionSample).toBe(report!.outputSamples);
  });
});
