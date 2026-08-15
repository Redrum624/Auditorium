import {
  DE_ESSER_BIT_EXACT_OFFSET_DB,
  DE_ESSER_RMS_OFFSET_DB,
  GATE_CANCELLATION_DEPTH_DB,
  GATE_HEADROOM_DB,
  GATE_HOLD_MS,
  GATE_QUIET_WINDOWS,
  GATE_SEARCH_CLIMB_DB,
  GATE_SHAPED_RESIDUAL_DB,
  GATE_VOICED_FRACTION,
  STAGE_MEASURING_DETAIL,
  STAGE_RENDERING_DETAIL,
  VOCAL_CHAIN_STAGES,
  VOCAL_CHAIN_UNDO_LABEL,
  defaultStageSelection,
  deriveCompressor,
  deriveDeEsser,
  deriveDeHum,
  deriveEq,
  deriveGate,
  deriveNoiseReduction,
  deriveRemoveSilence,
  runVocalChain,
  stageById,
  stageRenderingDetail,
  type VocalChainStageId,
  type VocalChainStageProgress,
  type VocalChainStageResult,
} from './vocalChain';
import { defaultParamsFor, getEffect } from '../effects/EffectRegistry';
import { registerAllEffects } from '../effects/registerAll';
import { compressorEffect } from '../effects/dynamics/CompressorEffect';
import { noiseGateEffect } from '../effects/dynamics/NoiseGateEffect';
import { noiseReductionEffect } from '../effects/restoration/NoiseReductionEffect';
import { detectPitch } from '../dsp/pitchDetect';
import * as pitchDetect from '../dsp/pitchDetect';
import { createDocument, docLength } from '../audio/AudioDocument';
import { useAppStore, makeInitialState } from '../stores/appStore';
import { getHistory, undo } from './undoHistory';
import { ALIGN_ACCURACY_SENTENCE } from '../dsp/ctcAlign';
import {
  NOISE_WINDOW_MAX_SILENT_FRACTION,
  NOISE_WINDOW_MS,
  TILT_FFT_SIZE,
  measureNoiseWindow,
  measureNoiseWindows,
  programmeRmsDb,
  spectralTiltResidualDb,
  toDb,
} from '../dsp/chainAnalysis';
import * as chainAnalysis from '../dsp/chainAnalysis';
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

/** Gaussian floor at a stated dBFS RMS — a heavier tail than uniform, and what
 * the gate's own populations are measured on. */
function gaussFloorDb(n: number, rmsDb: number, seed: number): Float32Array {
  let s = seed >>> 0;
  const next = (): number => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return (s / 0xffffffff) * 2 - 1;
  };
  const out = new Float32Array(n);
  const k = Math.pow(10, rmsDb / 20) / Math.sqrt(4 / 3);
  for (let i = 0; i < n; i++) out[i] = (next() + next() + next() + next()) * k;
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
      'gate',
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

  // CC1 — the gate's position, argued the same way: against the rules the
  // stages around it already state.
  describe("the Noise Gate stage's position", () => {
    const ids = VOCAL_CHAIN_STAGES.map((s) => s.id);

    it('gates BEFORE the dynamics stages, so their makeup gain multiplies zeros', () => {
      // Remove Silence's own note gives the rule ("before the dynamics stages
      // so the compressor does not lift a noise floor in gaps"), and the
      // compressor applies its makeup uniformly — below threshold there is no
      // gain reduction and the full makeup, so a gate placed after it would
      // have its silence partly refilled.
      for (const dynamics of ['compressor', 'deEsser', 'limiter'] as const) {
        expect(ids.indexOf('gate')).toBeLessThan(ids.indexOf(dynamics));
      }
    });

    it('gates AFTER the two stages that lower the floor it has to find', () => {
      // Its threshold is measured from the quietest passage of the audio that
      // reaches it. Noise Reduction and DeHum both change that passage, so
      // measuring before them would derive a threshold for audio that no
      // longer exists by the time the gate runs.
      for (const cleaner of ['noise', 'hum'] as const) {
        expect(ids.indexOf('gate')).toBeGreaterThan(ids.indexOf(cleaner));
      }
    });

    it('gates AFTER Remove Silence, whose own threshold could not survive a gated take', () => {
      // Both derive from `measureNoiseWindow`, which rejects windows at digital
      // silence. Run the gate first and every quiet window is gone, so Remove
      // Silence would measure a window containing voice and cut into it.
      expect(ids.indexOf('gate')).toBeGreaterThan(ids.indexOf('silence'));
    });

    it('is on by default — the pauses reaching silence is what the user expects', () => {
      expect(stageById('gate').defaultEnabled).toBe(true);
      expect(defaultStageSelection().gate).toBe(true);
    });

    it('is length-preserving, unlike the other stage that treats pauses', () => {
      // The whole reason it can be on by default where Remove Silence cannot:
      // it mutes in place, so the take still lines up with a backing track.
      expect(stageById('gate').note).toContain('Length-preserving');
      expect(stageById('silence').defaultEnabled).toBe(false);
    });
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
      // F11-7: both stages moved to the Pipeline menu, so the path they name
      // moved with them. Still built from `stage.label` rather than written
      // out, so a note that named the wrong stage still fails — and still
      // built from a literal section name, so a note left pointing at Effects
      // fails too. (`menuActions.test.ts` sweeps the whole of src/ for that
      // second failure mode across every command, not just these two.)
      expect(stage.note).toContain(`Run Pipeline → ${stage.label}… FIRST, then this chain`);
      expect(stage.note).not.toContain('Effects →');
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
      for (const measurer of ['noise', 'hum', 'gate', 'pitch', 'compressor', 'deEsser', 'eq', 'limiter'] as const) {
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

  // The gate's root cause, one stage away. A window that is mostly exact zeros
  // has its RMS diluted by them and its envelope peak taken from the sliver of
  // REAL material at its edge, so on a take with a stretch of digital silence
  // the bare search can return a window that measures the wrong thing. The
  // gate was taught to refuse those windows; this stage consumed them still.
  //
  // Measured first, because the direction was not obvious. On the shapes that
  // broke the gate — a silent lead-in or a mid-file cut beside a take with an
  // even floor — the derivation is SAFE and stays safe: the boundary window's
  // envelope peak is that same floor's, read over fewer samples, so it lands
  // 0.0-0.6 dB BELOW the honest reading at 8 and 44.1 kHz and Remove Silence
  // cuts marginally less. What is NOT safe is a floor that is not even: when
  // the material beside the zeros is LOUDER than the take's own quietest
  // stretch, the boundary window wins the search on its dilution and reports
  // the louder material's peak, and the threshold lands as far above the
  // floor as the two stretches are apart. Remove Silence removes material.
  describe('a stretch of digital silence beside an uneven floor', () => {
    /** `[trimmed head of zeros][louder floor][phrase][quiet sung passage]
     * [the take's own quietest floor]`.
     *
     * The head's length is deliberately NOT a whole number of search steps:
     * candidate windows start on 50 ms boundaries, so a head that ends 25 ms
     * after one leaves a candidate that is 95 % zeros and 25 ms of the louder
     * floor. That is what dilutes it under the -70 dBFS tail and wins it the
     * bare search — a trimmed lead-in landing anywhere but exactly on a step,
     * which is where a trim lands. */
    function unevenFloorTake(sr: number): {
      channel: Float32Array;
      quiet: { start: number; end: number };
    } {
      const step = Math.round(0.05 * sr);
      const head = new Float32Array(Math.round(1.5 * sr) - Math.round(step / 2));
      const louder = gaussFloorDb(Math.round(1.5 * sr), -60, 23);
      const phraseN = Math.round(0.8 * sr);
      const phrase = new Float32Array(phraseN);
      let phase = 0;
      for (let i = 0; i < phraseN; i++) {
        phase += (2 * Math.PI * 220) / sr;
        phrase[i] = 0.25 * Math.sin(phase);
      }
      // A quiet sustained phrase — real material, 8 dB over the take's own
      // floor, and the thing a wrong threshold deletes.
      const quietN = Math.round(1.5 * sr);
      const quiet = new Float32Array(quietN);
      phase = 0;
      const amp = Math.pow(10, -62 / 20) * Math.SQRT2;
      for (let i = 0; i < quietN; i++) {
        phase += (2 * Math.PI * 220) / sr;
        quiet[i] = amp * Math.sin(phase);
      }
      const tail = gaussFloorDb(Math.round(2.5 * sr), -70, 7);
      const channel = new Float32Array(head.length + louder.length + phraseN + quietN + tail.length);
      let at = head.length;
      for (const part of [louder, phrase, quiet, tail]) {
        channel.set(part, at);
        at += part.length;
      }
      const quietAt = head.length + louder.length + phraseN;
      return { channel, quiet: { start: quietAt, end: quietAt + quietN } };
    }

    /** The share of a span the silence detector reads BELOW a threshold — the
     * effect's own question, asked directly. */
    function underThreshold(
      channel: Float32Array,
      sr: number,
      span: { start: number; end: number },
      thresholdDb: number,
    ): number {
      const env = envelopeFollower(maxAcrossChannels([channel]), sr, DETECT_ATTACK_MS, DETECT_RELEASE_MS);
      let under = 0;
      for (let i = span.start; i < span.end; i++) if (toDb(env[i]) < thresholdDb) under++;
      return under / (span.end - span.start);
    }

    it('measures the floor, not the sliver of louder material beside the zeros', () => {
      for (const sr of [SR, 44100]) {
        const { channel, quiet } = unevenFloorTake(sr);

        // The precondition — this really is the boundary-window shape: the
        // bare search returns a window that is almost all zeros, while the
        // search that refuses those returns one with none.
        const bare = measureNoiseWindow([channel], sr)!;
        const honest = measureNoiseWindow([channel], sr, { rejectMostlySilentWindows: true })!;
        const zeroFraction = (w: { startSample: number; lengthSamples: number }): number => {
          let z = 0;
          for (let i = w.startSample; i < w.startSample + w.lengthSamples; i++) if (channel[i] === 0) z++;
          return z / w.lengthSamples;
        };
        expect(zeroFraction(bare)).toBeGreaterThan(0.9);
        expect(zeroFraction(honest)).toBe(0);
        // ...and the two readings really are 9-10 dB apart, which is the whole
        // defect: measured -54.98 against -64.55 at 8 kHz, -55.31 against
        // -65.31 at 44.1 kHz.
        expect(bare.envelopePeakDb - honest.envelopePeakDb).toBeGreaterThan(8);

        const res = deriveRemoveSilence([channel], sr);
        expect(res.run).toBe(true);
        if (!res.run) return;
        const thresholdDb = Number(res.params.thresholdDb);
        expect(thresholdDb).toBeCloseTo(honest.envelopePeakDb, 6);

        // And the quiet phrase is not silence: before this, half to four
        // fifths of it read as silence and a length-changing stage cut it.
        expect(underThreshold(channel, sr, quiet, thresholdDb)).toBeLessThan(0.05);
        expect(underThreshold(channel, sr, quiet, bare.envelopePeakDb)).toBeGreaterThan(0.4);

        // End to end: the phrase survives the effect. Its samples are still
        // there, so the output cannot be shorter than the material kept.
        const params = { ...res.params, minSilenceMs: 500 };
        const out = silenceRemoverEffect.process([Float32Array.from(channel)], sr, params).channels[0];
        expect(out.length).toBeGreaterThan(quiet.end - quiet.start);
      }
    }, 60000);

    it('still measures the SAME floor when the silence sits beside an even one', () => {
      // The converse, and the class N2 protects: an ordinary take whose zeros
      // adjoin nothing louder than its own floor — whether the zeros are a
      // trimmed LEAD-IN or an editing CUT carved into a pause — reads the same
      // floor either way, so refusing the boundary window changes the answer by
      // a fraction of a decibel and the stage goes on running.
      /** A floor take with a sung phrase, and `cutSec` of zeros placed either
       * in front of it or carved out of its opening pause. */
      function evenFloorTake(sr: number, sec: number, where: 'lead-in' | 'cut'): Float32Array {
        const body = gaussFloorDb(Math.round(4 * sr), -50, 7);
        const phraseN = Math.round(0.8 * sr);
        let phase = 0;
        for (let i = 0; i < phraseN; i++) {
          phase += (2 * Math.PI * 220) / sr;
          body[Math.round(1.5 * sr) + i] += 0.25 * Math.sin(phase);
        }
        if (where === 'cut') {
          body.fill(0, Math.round(0.2 * sr), Math.round(0.2 * sr) + Math.round(sec * sr));
          return body;
        }
        const channel = new Float32Array(Math.round(sec * sr) + body.length);
        channel.set(body, Math.round(sec * sr));
        return channel;
      }

      const deltas: number[] = [];
      for (const sr of [SR, 44100]) {
        for (const where of ['lead-in', 'cut'] as const) {
          for (const sec of [0.2, 0.35, 1.0, 2.0]) {
            const channel = evenFloorTake(sr, sec, where);
            // The precondition: the bare search really does land on a boundary
            // window on at least some of these, or the converse is vacuous.
            const bare = measureNoiseWindow([channel], sr)!;
            const res = deriveRemoveSilence([channel], sr);
            expect(res.run).toBe(true);
            if (!res.run) return;
            deltas.push(Number(res.params.thresholdDb) - bare.envelopePeakDb);
          }
        }
      }

      expect(deltas).toHaveLength(16);
      // The two readings agree to a fraction of a decibel across both shapes,
      // both rates and four lengths. Measured: -0.065 to +0.823 dB.
      for (const d of deltas) expect(Math.abs(d)).toBeLessThan(1);

      // DIRECTION, asserted rather than claimed. The bare reading is taken over
      // FEWER real samples, so it almost always under-reads the floor's own
      // peak and the shipped stage cut marginally LESS than the honest
      // measurement does: fifteen of sixteen members are at or above it. The
      // sixteenth is NOT a theorem broken — a boundary window's envelope peak
      // is a maximum over a DIFFERENT span, so the sign was never guaranteed —
      // and it misses by 0.065 dB, which is why the docblock says
      // "0.00-0.82 dB below, one member 0.07 dB above" and not "always below".
      expect(deltas.filter((d) => d < -0.001)).toHaveLength(1);
      expect(Math.min(...deltas)).toBeGreaterThan(-0.1);
      expect(Math.max(...deltas)).toBeGreaterThan(0.5);
    }, 60000);

    it('declines when no half-second of real material exists to measure at all', () => {
      // The cost of asking for the honest search: on a take whose every
      // candidate window is mostly zeros there is no floor to read, and this
      // stage now says so instead of deriving one from a sliver. The same
      // refusal the gate makes on the same shape — and the safe one here,
      // because the alternative is a threshold that deletes material.
      const on = Math.round(0.15 * SR);
      const off = Math.round(0.35 * SR);
      const channel = new Float32Array(Math.round(8 * SR));
      let at = 0;
      let seed = 11;
      while (at + on <= channel.length) {
        channel.set(noise(on, 0.05, seed++), at);
        at += on + off;
      }
      const res = deriveRemoveSilence([channel], SR);
      expect(res.run).toBe(false);
      if (res.run) return;
      expect(res.reason).toContain('real material');
    });
  });
});

// ── deriveGate (CC1) ────────────────────────────────────────────────────────

describe('deriveGate', () => {
  const peakDbOf = (c: Float32Array): number => {
    let peak = 0;
    for (const v of c) peak = Math.max(peak, Math.abs(v));
    return toDb(peak);
  };

  function withNoisyGap(windows: number, loud: number, quiet: number, quietAt: number): Float32Array {
    const out = flat(WIN * windows, loud);
    out.set(noise(WIN, quiet, 101), quietAt * WIN);
    return out;
  }

  /** A take that never stops but changes dynamic: a soft sustained verse
   * followed by a loud one, over a floor so low that no window is ever bare
   * room tone, and with only 150 ms breaths between phrases — every gap
   * shorter than the 500 ms this app calls a pause. The quietest 500 ms is
   * therefore SUNG, and a threshold derived from it sits over real singing. */
  function continuousTakeWithSoftVerse(): { channel: Float32Array; soft: { start: number; end: number } } {
    // No lead-in: a bare stretch of floor even a fraction of a window long
    // would win the quietest-window search and turn this back into the
    // ordinary case the stage already handles.
    const lead = 0;
    const verse = Math.round(3.5 * SR);
    const channel = noise(lead + 2 * verse, Math.pow(10, -70 / 20) * Math.sqrt(3), 55);
    const soft = { start: lead, end: lead + verse };
    // Sung with a 150 ms breath every 1.1 s, at two levels a wide dynamic
    // apart: pianissimo verse, then the chorus. Two harmonics over the
    // fundamental, because what is under test is whether the passage reads as
    // VOICE, and a bare sine is a weaker case than real singing rather than a
    // stronger one.
    for (let seg = 0; seg < 2; seg++) {
      const amp = seg === 0 ? 0.022 : 0.25;
      const from = lead + seg * verse;
      let phase = 0;
      for (let i = 0; i < verse; i++) {
        const t = i / SR;
        // Phase is INTEGRATED, not f(t)·t: the latter makes the instantaneous
        // frequency f(t) + t·f'(t), which turns a ±3 Hz vibrato into a sweep
        // hundreds of Hz wide over a phrase this long.
        phase += (2 * Math.PI * (196 * (1 + 0.006 * Math.sin(2 * Math.PI * 5.5 * t)))) / SR;
        if (t % 1.1 > 0.95) continue;
        channel[from + i] +=
          amp * (Math.sin(phase) + 0.4 * Math.sin(2 * phase) + 0.2 * Math.sin(3 * phase));
      }
    }
    return { channel, soft };
  }

  /** A two-pole resonator — how a vocal tract shapes the noise a whisper is
   * made of. Room tone has no such resonances; that difference is what the
   * unvoiced guard measures. */
  function resonate(x: Float32Array, hz: number, q: number): Float32Array {
    const w = (2 * Math.PI * hz) / SR;
    const r = Math.exp(-w / (2 * q));
    const a1 = 2 * r * Math.cos(w);
    const a2 = -r * r;
    const out = new Float32Array(x.length);
    let y1 = 0;
    let y2 = 0;
    for (let i = 0; i < x.length; i++) {
      const y = x[i] + a1 * y1 + a2 * y2;
      out[i] = y;
      y2 = y1;
      y1 = y;
    }
    return out;
  }

  function atRms(x: Float32Array, rms: number): Float32Array {
    let s = 0;
    for (let i = 0; i < x.length; i++) s += x[i] * x[i];
    const g = rms / Math.sqrt(s / Math.max(1, x.length));
    const out = new Float32Array(x.length);
    for (let i = 0; i < x.length; i++) out[i] = x[i] * g;
    return out;
  }

  /** A whispered passage: noise through three vocal-tract formants, with the
   * syllabic swell of speech. Unvoiced by construction — no fundamental — so
   * the voiced check reads exactly zero on it. */
  function whisper(n: number, rmsDb: number, seed: number): Float32Array {
    let x = noise(n, 1, seed);
    for (const [hz, q] of [
      [500, 8],
      [1500, 10],
      [2500, 12],
    ] as const) {
      if (hz < (SR / 2) * 0.9) x = resonate(x, hz, q);
    }
    for (let i = 0; i < n; i++) x[i] *= 0.55 + 0.45 * Math.sin((2 * Math.PI * 4 * i) / SR);
    return atRms(x, Math.pow(10, rmsDb / 20));
  }

  /** The N1 shape: a whispered verse and a loud sung chorus, with no pause
   * anywhere. The quietest 500 ms lands in the whisper. */
  function continuousTakeWithWhisperedVerse(): { channel: Float32Array; soft: { start: number; end: number } } {
    const verse = Math.round(3.5 * SR);
    const channel = new Float32Array(2 * verse);
    channel.set(whisper(verse, -36, 41), 0);
    let phase = 0;
    for (let i = 0; i < verse; i++) {
      phase += (2 * Math.PI * 196) / SR;
      channel[verse + i] = 0.25 * (Math.sin(phase) + 0.4 * Math.sin(2 * phase) + 0.2 * Math.sin(3 * phase));
    }
    return { channel, soft: { start: 0, end: verse } };
  }

  /** Real 1 s pauses over a -50 dBFS floor with two sung phrases, preceded by
   * a stretch of DIGITAL SILENCE — a trimmed lead-in, an edited stem, or this
   * chain's own gated output on a second pass. `measureNoiseWindow` rejects
   * windows at or under SILENCE_RMS, so what it returns here is not the silence
   * and not the floor but the boundary between them: mostly exact zeros with a
   * little real floor in it. */
  function takeWithSilentLeadIn(silenceSec: number): {
    channel: Float32Array;
    pauses: { start: number; end: number }[];
  } {
    const sil = Math.round(silenceSec * SR);
    const pause = Math.round(1.0 * SR);
    const phrase = Math.round(0.8 * SR);
    const body = 3 * pause + 2 * phrase;
    const channel = new Float32Array(sil + body);
    channel.set(gaussFloorDb(body, -50, 7), sil);
    const pauses: { start: number; end: number }[] = [];
    let at = sil;
    for (const [sung, n] of [
      [false, pause],
      [true, phrase],
      [false, pause],
      [true, phrase],
      [false, pause],
    ] as const) {
      if (!sung) pauses.push({ start: at, end: at + n });
      else {
        let phase = 0;
        for (let i = 0; i < n; i++) {
          const t = i / SR;
          phase += (2 * Math.PI * 220) / SR;
          const c = Math.min(1, t / 0.04) * Math.min(1, (n / SR - t) / 0.06);
          channel[at + i] += 0.25 * c * Math.sin(phase);
        }
      }
      at += n;
    }
    return { channel, pauses };
  }

  function zeroFractionOf(w: Float32Array): number {
    let z = 0;
    for (let i = 0; i < w.length; i++) if (w[i] === 0) z++;
    return z / w.length;
  }

  it('sets the threshold from the measured floor, above the loudest the detector reads there', () => {
    const signal = withNoisyGap(8, 0.5, 0.006, 4);
    const floor = measureNoiseWindow([signal], SR)!;
    const res = deriveGate([signal], SR);
    if (!res.run) throw new Error('expected run');
    // Strictly above, not equal: a threshold AT the floor's own peak is grazed
    // by the same floor a moment later and the gate re-opens for a full hold.
    expect(Number(res.params.thresholdDb)).toBeGreaterThan(floor.envelopePeakDb);
    expect(Number(res.params.thresholdDb)).toBe(floor.envelopePeakDb + GATE_HEADROOM_DB);
  });

  it('tracks the material: a 6 dB quieter floor gives a 6 dB lower threshold', () => {
    const a = deriveGate([withNoisyGap(8, 0.5, 0.012, 4)], SR);
    const b = deriveGate([withNoisyGap(8, 0.5, 0.006, 4)], SR);
    if (!a.run || !b.run) throw new Error('expected both to run');
    expect(Number(a.params.thresholdDb) - Number(b.params.thresholdDb)).toBeCloseTo(6.0206, 1);
  });

  it('runs its detector with the constants the threshold was measured with', () => {
    // Not a preference: `envelopePeakDb` IS the peak of an envelope followed at
    // these two constants, so a gate detector using any others measures a
    // different envelope and the threshold stops meaning what it measured.
    const res = deriveGate([withNoisyGap(8, 0.5, 0.006, 4)], SR);
    if (!res.run) throw new Error('expected run');
    expect(Number(res.params.attackMs)).toBe(DETECT_ATTACK_MS);
    expect(Number(res.params.releaseMs)).toBe(DETECT_RELEASE_MS);
  });

  it('holds for the shortest gap this app is willing to call a pause', () => {
    const res = deriveGate([withNoisyGap(8, 0.5, 0.006, 4)], SR);
    if (!res.run) throw new Error('expected run');
    // Remove Silence's own minimum, and the same constant the noise window is
    // measured over: the gate may only close on what Remove Silence would have
    // been willing to cut.
    const minSilence = getEffect('remove-silence')!.params.find((p) => p.id === 'minSilenceMs')!.default;
    expect(GATE_HOLD_MS).toBe(Number(minSilence));
    expect(GATE_HOLD_MS).toBe(NOISE_WINDOW_MS);
    expect(Number(res.params.holdMs)).toBe(GATE_HOLD_MS);
  });

  it('clamps into the param range instead of emitting settings the effect cannot take', () => {
    // A floor quiet enough that peak + headroom lands under the effect's -80 dB
    // minimum, but still ABOVE digital silence so `measureNoiseWindow` accepts
    // the window at all — the two constraints leave a narrow band, and a floor
    // below it makes the quietest MEASURABLE window the programme instead.
    const res = deriveGate([withNoisyGap(8, 0.5, 6.6e-5, 4)], SR);
    if (!res.run) throw new Error('expected run');
    const floor = measureNoiseWindow([withNoisyGap(8, 0.5, 6.6e-5, 4)], SR)!;
    expect(floor.envelopePeakDb + GATE_HEADROOM_DB).toBeLessThan(-80);
    expect(Number(res.params.thresholdDb)).toBe(-80);

    const def = getEffect('noise-gate')!;
    for (const id of ['thresholdDb', 'attackMs', 'releaseMs', 'holdMs']) {
      const param = def.params.find((p) => p.id === id)!;
      expect(Number(res.params[id])).toBeGreaterThanOrEqual(param.min!);
      expect(Number(res.params[id])).toBeLessThanOrEqual(param.max!);
    }
  });

  it('declines without a measurable noise floor', () => {
    expect(deriveGate([new Float32Array(WIN * 4)], SR).run).toBe(false);
  });

  // The failure mode a gate on by default can least afford: `measureNoiseWindow`
  // always returns the quietest 500 ms there IS, so on a recording containing no
  // pause it returns 500 ms of the recording, the threshold lands over the
  // material and every sample is muted. Each of these silenced 100 % of itself
  // before the guard, and a stage that deletes the take is worse than the noise
  // it was asked to remove.
  describe('a selection with no pause in it at all', () => {
    it('declines on a continuous tone rather than muting the whole recording', () => {
      const t = tone(SR * 3, 440, 0.25);
      const res = deriveGate([t], SR);
      expect(res.run).toBe(false);
      if (res.run) return;
      expect(res.reason).toContain('rather than a pause');
      // The guard is what stops it: the threshold really would have covered the
      // tone, so this is not a fixture that was never going to be gated.
      const floor = measureNoiseWindow([t], SR)!;
      expect(floor.envelopePeakDb + GATE_HEADROOM_DB).toBeGreaterThan(peakDbOf(t) - 6);
    });

    it('declines on steady room tone with no voice in it', () => {
      expect(deriveGate([noise(SR * 3, 0.01, 9)], SR).run).toBe(false);
    });

    it('declines when every window holds a click, so the quietest one is not a pause', () => {
      // Clicks 500 ms apart: each gap is real silence but none is a whole noise
      // window long, so every 500 ms window contains a click and the quietest
      // window reads the CLICK. Measured before the guard: 100 % silenced.
      const clicks = new Float32Array(SR * 4);
      for (let k = 0; k * 0.5 * SR < clicks.length; k++) {
        const at = Math.round(k * 0.5 * SR);
        for (let i = 0; i < Math.round(0.01 * SR) && at + i < clicks.length; i++) {
          clicks[at + i] = 0.8 * Math.exp(-i / 20);
        }
      }
      const res = deriveGate([clicks], SR);
      expect(res.run).toBe(false);
      if (res.run) return;
      expect(res.reason).toContain('gating would mute all of it');
    });

    // The middle regime, and the dangerous one. The three cases above fail
    // TOTALLY — nothing at all survives the threshold — so an all-or-nothing
    // guard separates them. A take that never stops but whose DYNAMICS vary
    // does not fail totally: the quietest 500 ms lands inside the softest sung
    // passage, the threshold lands above that passage, the loud material
    // elsewhere keeps the take from looking empty, and the gate fades a real
    // sung phrase to hard zero while reporting a cheerful Gated N s.
    it('declines when its quietest window is quiet SINGING rather than a pause', () => {
      const { channel, soft } = continuousTakeWithSoftVerse();

      // The fixture is what it claims: the quietest 500 ms really does land
      // inside the soft verse, so this is the regime under test and not a
      // take with a pause the search preferred.
      const window = measureNoiseWindow([channel], SR)!;
      expect(window.startSample).toBeGreaterThanOrEqual(soft.start);
      expect(window.startSample + window.lengthSamples).toBeLessThanOrEqual(soft.end);

      const res = deriveGate([channel], SR);
      expect(res.run).toBe(false);
      if (res.run) return;
      expect(res.reason).toContain('singing');
    });

    // N1 — the unvoiced neighbour of the case above. Periodicity cannot see it:
    // a whisper has no fundamental, so the voiced check reads 0.000 and waves it
    // through, and the passage is muted exactly as the sung one was.
    it('declines when its quietest window is an unvoiced vocal passage — a whisper', () => {
      const { channel, soft } = continuousTakeWithWhisperedVerse();

      const window = measureNoiseWindow([channel], SR)!;
      expect(window.startSample).toBeGreaterThanOrEqual(soft.start);
      expect(window.startSample + window.lengthSamples).toBeLessThanOrEqual(soft.end);
      // The precondition that makes this the N1 case and not the C1 one.
      const mono = Float32Array.from(channel.subarray(window.startSample, window.startSample + window.lengthSamples));
      const track = detectPitch(mono, SR);
      const voiced = track.frames.filter((f) => f.f0Hz !== null).length / track.frames.length;
      expect(voiced).toBe(0);

      const res = deriveGate([channel], SR);
      expect(res.run).toBe(false);
      if (res.run) return;
      expect(res.reason).toContain('vocal tract');
    });

    // N2 — the converse of all three guards. Digital silence IS a pause, and the
    // strongest evidence of one there is; but the window `measureNoiseWindow`
    // returns on such a take is the BOUNDARY between the silence and the floor,
    // mostly exact zeros, and the spectrum of that is an impulse's rather than a
    // room's. The shaping check read it as a vocal tract and refused a take with
    // real one-second pauses in it.
    describe('a take carrying a stretch of digital silence', () => {
      it('gates it, instead of mistaking the silence for a vocal tract', () => {
        const { channel } = takeWithSilentLeadIn(1.0);

        // The window really is the zeros/floor boundary — the precondition.
        const w = measureNoiseWindow([channel], SR)!;
        const win = Float32Array.from(channel.subarray(w.startSample, w.startSample + w.lengthSamples));
        expect(zeroFractionOf(win)).toBeGreaterThan(0.5);
        // ...and the shaping measure on it really does read like a voice, which
        // is what used to fire. Without this the test could pass because the
        // fit happened to come out low.
        expect(spectralTiltResidualDb(win, SR)).toBeGreaterThan(GATE_SHAPED_RESIDUAL_DB);

        // Yet the stage runs: exact zeros are a pause, not a phrase.
        const res = deriveGate([channel], SR);
        expect(res.run).toBe(true);
        if (!res.run) return;
        // And on a sane threshold — the envelope peak of the boundary window is
        // still the real floor's, because the follower rises to the non-zero
        // samples in it.
        expect(Number(res.params.thresholdDb)).toBeGreaterThan(-60);
        expect(Number(res.params.thresholdDb)).toBeLessThan(-30);
      });

      it('brings the take’s real pauses to digital silence, silent lead-in or not', () => {
        for (const silenceSec of [0, 1.0]) {
          const { channel, pauses } = takeWithSilentLeadIn(silenceSec);
          const res = deriveGate([channel], SR);
          expect(res.run).toBe(true);
          if (!res.run) return;
          const out = noiseGateEffect.process([Float32Array.from(channel)], SR, res.params).channels[0];
          // The last 300 ms of each real pause, past the hold and the fade.
          let sum = 0;
          let n = 0;
          for (const p of pauses) {
            for (let i = p.end - Math.round(0.3 * SR); i < p.end; i++) sum += out[i] * out[i];
            n += Math.round(0.3 * SR);
          }
          expect(toDb(Math.sqrt(sum / n))).toBeLessThanOrEqual(-80);
        }
      });

      it('still gates on a SECOND pass, over the zeros the first pass wrote', () => {
        // User-reachable: running the chain twice. The gate writes exact zeros,
        // so pass two sees a take that is largely digital silence — the same
        // shape as the trimmed lead-in above, produced by this stage itself.
        const { channel, pauses } = takeWithSilentLeadIn(0);
        const first = deriveGate([channel], SR);
        expect(first.run).toBe(true);
        if (!first.run) return;
        const once = noiseGateEffect.process([Float32Array.from(channel)], SR, first.params).channels;
        expect(zeroFractionOf(once[0])).toBeGreaterThan(0.2);

        const second = deriveGate(once, SR);
        expect(second.run).toBe(true);
        if (!second.run) return;
        // Idempotent where it matters: the pauses are already silent and stay so.
        const twice = noiseGateEffect.process([Float32Array.from(once[0])], SR, second.params).channels[0];
        let sum = 0;
        let n = 0;
        for (const p of pauses) {
          for (let i = p.end - Math.round(0.3 * SR); i < p.end; i++) sum += twice[i] * twice[i];
          n += Math.round(0.3 * SR);
        }
        expect(toDb(Math.sqrt(sum / n))).toBeLessThanOrEqual(-80);
      });

      // N3 — the destructive converse of the case above: digital silence
      // ADJACENT TO a soft unvoiced passage. The quietest window straddles the
      // zeros and the whisper, and exact zeros contribute nothing to an
      // envelope PEAK, so that window's peak is the WHISPER's own level — the
      // derived threshold landed 12.45 dB over the verse and the gate muted
      // 85-100 % of it at nine of ten measured lead-in lengths, the original
      // Critical's damage in the destructive direction. The fix is upstream of
      // every check: `measureNoiseWindow` refuses mostly-silent candidate
      // windows, so the measurement lands on the whisper itself — all real
      // samples — and the vocal-tract check declines exactly as it does with
      // no lead-in at all.
      it('declines on a whispered verse behind a silent lead-in — silence must not launder a whisper', () => {
        for (const leadSec of [0.2, 0.3, 0.5, 1.0, 2.0]) {
          const { channel: base } = continuousTakeWithWhisperedVerse();
          const lead = Math.round(leadSec * SR);
          const channel = new Float32Array(lead + base.length);
          channel.set(base, lead);

          const res = deriveGate([channel], SR);
          expect(res.run).toBe(false);
          if (res.run) return;
          expect(res.reason).toContain('vocal tract');
        }

        // The mechanism, pinned once: the bare search still returns the
        // zeros/whisper boundary window — that shape is real and other callers
        // keep it — while the search the gate asks for lands inside the
        // whispered verse, on real samples only.
        const { channel: base, soft } = continuousTakeWithWhisperedVerse();
        const lead = Math.round(1.0 * SR);
        const channel = new Float32Array(lead + base.length);
        channel.set(base, lead);
        const bare = measureNoiseWindow([channel], SR)!;
        expect(zeroFractionOf(Float32Array.from(channel.subarray(bare.startSample, bare.startSample + bare.lengthSamples)))).toBeGreaterThan(0.5);
        const real = measureNoiseWindow([channel], SR, { rejectMostlySilentWindows: true })!;
        expect(zeroFractionOf(Float32Array.from(channel.subarray(real.startSample, real.startSample + real.lengthSamples)))).toBe(0);
        expect(real.startSample).toBeGreaterThanOrEqual(lead + soft.start);
        expect(real.startSample + real.lengthSamples).toBeLessThanOrEqual(lead + soft.end);
      }, 60000);
    });

    // The boundary of `NOISE_WINDOW_MAX_SILENT_FRACTION`, exercised as gate
    // BEHAVIOUR on both sides and on the equality — not as a literal. The
    // scattered-zeros construction is the real class the lower side protects:
    // an undithered 16-bit converter quantises the smallest samples of a quiet
    // floor to exact zero, spread through every window.
    describe('the mostly-silent bound of the measurement behind the gate', () => {
      /** Two sung phrases with real 1 s pauses over a Gaussian floor — the
       * `takeWithSilentLeadIn(0)` shape with the floor level a parameter. */
      function takeOverFloor(floorDb: number): { channel: Float32Array; pauses: { start: number; end: number }[] } {
        const pause = Math.round(1.0 * SR);
        const phrase = Math.round(0.8 * SR);
        const body = 3 * pause + 2 * phrase;
        const channel = gaussFloorDb(body, floorDb, 7);
        const pauses: { start: number; end: number }[] = [];
        let at = 0;
        for (const [sung, n] of [
          [false, pause],
          [true, phrase],
          [false, pause],
          [true, phrase],
          [false, pause],
        ] as const) {
          if (!sung) pauses.push({ start: at, end: at + n });
          else {
            let phase = 0;
            for (let i = 0; i < n; i++) {
              const t = i / SR;
              phase += (2 * Math.PI * 220) / SR;
              const c = Math.min(1, t / 0.04) * Math.min(1, (n / SR - t) / 0.06);
              channel[at + i] += 0.25 * c * Math.sin(phase);
            }
          }
          at += n;
        }
        return { channel, pauses };
      }

      /** Zero EXACTLY `fraction` of each 50 ms chunk of every pause, at
       * LCG-shuffled positions — aperiodic, deterministic, and exact in every
       * window the search can choose, so a fixture sits ON the boundary by
       * arithmetic rather than by luck. */
      function scatterZeros(channel: Float32Array, pauses: { start: number; end: number }[], fraction: number): void {
        const chunk = Math.round(0.05 * SR);
        const per = Math.round(fraction * chunk);
        let s = 12345 >>> 0;
        const next = (): number => ((s = (s * 1664525 + 1013904223) >>> 0), s / 0x100000000);
        for (const p of pauses) {
          for (let at = p.start; at + chunk <= p.end; at += chunk) {
            const idx = Array.from({ length: chunk }, (_, i) => i);
            for (let i = chunk - 1; i > 0; i--) {
              const j = Math.floor(next() * (i + 1));
              [idx[i], idx[j]] = [idx[j], idx[i]];
            }
            for (let k = 0; k < per; k++) channel[at + idx[k]] = 0;
          }
        }
      }

      const pauseTailDb = (out: Float32Array, pauses: { start: number; end: number }[]): number => {
        let sum = 0;
        let n = 0;
        for (const p of pauses) {
          for (let i = p.end - Math.round(0.3 * SR); i < p.end; i++) sum += out[i] * out[i];
          n += Math.round(0.3 * SR);
        }
        return toDb(Math.sqrt(sum / n));
      };

      it('still gates a take whose undithered 16-bit floor quantises a fifth of it to exact zero', () => {
        // The realistic member: a -84 dBFS Gaussian floor through a 16-bit
        // converter reads 18-20 % exact zeros per 500 ms window — under the
        // bound with real margin, and this member pins that the class of
        // ordinary quiet 16-bit recordings stays in the search. (Measured: a
        // bound of 0.2 does NOT fail this take, whose windows sit just under
        // 0.2 as well — the members that defend the lower side against a drop
        // to 0.2 are the exact-scatter fixtures below and the population
        // assertion in the NOISE_WINDOW_MAX_SILENT_FRACTION suite, whose
        // -85.5 dBFS member reads 21.6-22.7 %.)
        const { channel, pauses } = takeOverFloor(-84);
        const q = new Float32Array(channel.length);
        for (let i = 0; i < channel.length; i++) q[i] = Math.round(channel[i] * 32768) / 32768;

        const res = deriveGate([q], SR);
        expect(res.run).toBe(true);
        if (!res.run) return;
        // The threshold tracks the quantised floor, not a phrase: well under
        // the -12 dBFS the phrases peak at, above the effect's -80 dB minimum.
        expect(Number(res.params.thresholdDb)).toBeLessThan(-70);
        expect(Number(res.params.thresholdDb)).toBeGreaterThan(-80);
        const out = noiseGateEffect.process([Float32Array.from(q)], SR, res.params).channels[0];
        expect(pauseTailDb(out, pauses)).toBeLessThanOrEqual(-80);
      });

      it('a floor window just UNDER the bound is still a measurement, and the take gates', () => {
        const { channel, pauses } = takeOverFloor(-50);
        scatterZeros(channel, pauses, 0.24);
        const res = deriveGate([channel], SR);
        expect(res.run).toBe(true);
        if (!res.run) return;
        const out = noiseGateEffect.process([Float32Array.from(channel)], SR, res.params).channels[0];
        expect(pauseTailDb(out, pauses)).toBeLessThanOrEqual(-80);
      });

      it('a floor window at EXACTLY the bound is still a measurement — the comparison is strict', () => {
        const { channel, pauses } = takeOverFloor(-50);
        scatterZeros(channel, pauses, 0.25);
        expect(Math.round(0.25 * Math.round(0.05 * SR)) / Math.round(0.05 * SR)).toBe(NOISE_WINDOW_MAX_SILENT_FRACTION);
        const res = deriveGate([channel], SR);
        expect(res.run).toBe(true);
        if (!res.run) return;
        const out = noiseGateEffect.process([Float32Array.from(channel)], SR, res.params).channels[0];
        expect(pauseTailDb(out, pauses)).toBeLessThanOrEqual(-80);
      });

      it('a floor just PAST the bound is not a measurement, and the stage declines fail-safe', () => {
        // With every floor window refused, the quietest window the search can
        // still return is inside a phrase; the threshold derived there sits
        // over the whole take and the all-or-nothing guard declines. Nothing
        // is gated — the fail-safe direction, chosen over measuring material
        // this close to unmeasurable.
        const { channel, pauses } = takeOverFloor(-50);
        scatterZeros(channel, pauses, 0.26);
        const res = deriveGate([channel], SR);
        expect(res.run).toBe(false);
        if (res.run) return;
        expect(res.reason.length).toBeGreaterThan(0);
      });
    });

    it('still runs on the take those three are the boundary of — pauses a window long', () => {
      // Same clicks, one noise window apart instead of half of one, over a real
      // floor. The guard must not have swallowed the case the stage is for.
      const signal = noise(SR * 4, 0.004, 13);
      for (let k = 0; k * WIN * 2 < signal.length; k++) {
        const at = k * WIN * 2;
        for (let i = 0; i < Math.round(0.2 * SR) && at + i < signal.length; i++) {
          signal[at + i] += 0.4 * Math.sin((2 * Math.PI * 220 * i) / SR);
        }
      }
      expect(deriveGate([signal], SR).run).toBe(true);
    });
  });

  // N4 — the eviction's blind spot. Refusing mostly-silent windows is right
  // for the THRESHOLD, but it can hide real audio from the search entirely:
  // when a quiet passage is ITSELF mostly zeros, every window over it is
  // refused, the search falls through to a LOUDER floor-like window, and the
  // threshold lands above the hidden passage — measured before this guard,
  // 100 % of such a whispered verse was muted. The search now keeps accounts
  // (`hiddenRealSamples`): real frames inside evicted-quieter windows that no
  // accepted window covers. Above one `TILT_FFT_SIZE` analysis frame's worth,
  // the stage DECLINES rather than classifying, because classification at
  // hidable lengths was measured and found impossible: a single-frame tilt
  // fit on an all-real FLOOR run reads up to 3.9 dB, above the whisper
  // population's own minimum at 44.1 kHz (2.41 dB) — the populations INVERT
  // at exactly the lengths that can stay hidden.
  describe("the eviction's blind spot: quiet audio that is itself mostly zeros", () => {
    /** [2 s floor @ floorDb][3.5 s verse][3.5 s chorus] — the chorus keeps the
     * all-or-nothing guard from firing, the floor stretch gives the search a
     * mostly-real window to fall through to. */
    function n4Take(verse: Float32Array, floorDb: number): { channel: Float32Array; verseAt: { start: number; end: number } } {
      const floorLen = Math.round(2 * SR);
      const chorusLen = Math.round(3.5 * SR);
      const channel = new Float32Array(floorLen + verse.length + chorusLen);
      channel.set(gaussFloorDb(floorLen, floorDb, 7), 0);
      channel.set(verse, floorLen);
      let phase = 0;
      for (let i = 0; i < chorusLen; i++) {
        phase += (2 * Math.PI * 196) / SR;
        channel[floorLen + verse.length + i] = 0.25 * (Math.sin(phase) + 0.4 * Math.sin(2 * phase) + 0.2 * Math.sin(3 * phase));
      }
      return { channel, verseAt: { start: floorLen, end: floorLen + verse.length } };
    }

    /** A verse surviving only as bursts between exact zeros — a strip-silenced
     * stem, a codec that writes hard zeros between speech. */
    function choppedVerse(kind: 'whisper' | 'sung', rmsDb: number, onSmp: number, offSmp: number): Float32Array {
      const n = Math.round(3.5 * SR);
      const out = new Float32Array(n);
      let at = 0;
      let seed = 91;
      while (at + onSmp <= n) {
        if (kind === 'whisper') out.set(whisper(onSmp, rmsDb, seed++), at);
        else {
          let ph = 0;
          const burst = new Float32Array(onSmp);
          for (let i = 0; i < onSmp; i++) {
            ph += (2 * Math.PI * 196) / SR;
            burst[i] = Math.sin(ph) + 0.4 * Math.sin(2 * ph) + 0.2 * Math.sin(3 * ph);
          }
          out.set(atRms(burst, Math.pow(10, rmsDb / 20)), at);
        }
        at += onSmp + offSmp;
      }
      return out;
    }

    const pauseTailDb = (out: Float32Array, pauses: { start: number; end: number }[]): number => {
      let sum = 0;
      let n = 0;
      for (const p of pauses) {
        for (let i = p.end - Math.round(0.3 * SR); i < p.end; i++) sum += out[i] * out[i];
        n += Math.round(0.3 * SR);
      }
      return toDb(Math.sqrt(sum / n));
    };

    it('declines when an 8-bit transfer leaves the whispered verse as fragments at its own LSB', () => {
      // At 8 bits, a -42 dBFS whisper sits at one LSB: most of its samples
      // quantise to exact zero and the rest to isolated ±1 LSB spikes. Every
      // window over the verse is mostly silent, so before this guard the
      // search fell through to the -30 dBFS floor stretch and the threshold
      // (floor peak + 3 dB) sat ~20 dB over the verse: measured, 100 % of it
      // was muted. The same take at 10 or 12 bits declines by other guards.
      const { channel } = n4Take(whisper(Math.round(3.5 * SR), -42, 41), -30);
      const q = new Float32Array(channel.length);
      for (let i = 0; i < channel.length; i++) q[i] = Math.round(channel[i] * 128) / 128;

      // The mechanism: the honest search hides a verse's worth of real frames.
      const w = measureNoiseWindow([q], SR, { rejectMostlySilentWindows: true })!;
      expect(w.hiddenRealSamples!).toBeGreaterThanOrEqual(TILT_FFT_SIZE);

      const res = deriveGate([q], SR);
      expect(res.run).toBe(false);
      if (res.run) return;
      expect(res.reason).toContain('fragments');
    });

    it('declines when the whispered verse arrives chopped between exact zeros', () => {
      // 150 ms bursts, 350 ms gaps: every 500 ms window over the verse is 70 %
      // zeros and is evicted, while no accepted window contains the bursts.
      // Before this guard: threshold from the -30 dBFS floor, 100 % muted.
      const { channel } = n4Take(choppedVerse('whisper', -42, Math.round(0.15 * SR), Math.round(0.35 * SR)), -30);
      const res = deriveGate([channel], SR);
      expect(res.run).toBe(false);
      if (res.run) return;
      expect(res.reason).toContain('fragments');
    });

    it('declines the chopped SUNG sibling too', () => {
      // Here the accepted boundary window straddling floor and the first sung
      // burst already reads voiced, so the winner check catches it — pinned so
      // the sung shape stays declined whichever guard gets there first.
      const { channel } = n4Take(choppedVerse('sung', -42, Math.round(0.15 * SR), Math.round(0.35 * SR)), -30);
      expect(deriveGate([channel], SR).run).toBe(false);
    });

    it('draws the negligibility line at one analysis frame, exactly', () => {
      // A floor fragment planted inside the lead-in zeros, off the chunk grid
      // and zero-bounded: at exactly TILT_FFT_SIZE hidden real samples the
      // stage declines; one sample shorter is debris and the take gates. The
      // line is the tilt fit's own frame — the shortest passage ANY of the
      // gate's classifiers can even form a verdict on.
      for (const [fragLen, shouldRun] of [
        [TILT_FFT_SIZE, false],
        [TILT_FFT_SIZE - 1, true],
      ] as const) {
        const { channel, pauses } = takeWithSilentLeadIn(2.0);
        channel.set(gaussFloorDb(fragLen, -50, 55), Math.round(0.5 * SR) + 200);
        const res = deriveGate([channel], SR);
        expect(res.run).toBe(shouldRun);
        if (res.run) {
          const out = noiseGateEffect.process([Float32Array.from(channel)], SR, res.params).channels[0];
          expect(pauseTailDb(out, pauses)).toBeLessThanOrEqual(-80);
        } else if (!res.run) {
          expect(res.reason).toContain('fragments');
        }
      }
    });

    it('ignores a single stray sample inside the silence', () => {
      const { channel, pauses } = takeWithSilentLeadIn(1.0);
      channel[Math.round(0.5 * SR)] = 0.01;
      const res = deriveGate([channel], SR);
      expect(res.run).toBe(true);
      if (!res.run) return;
      const out = noiseGateEffect.process([Float32Array.from(channel)], SR, res.params).channels[0];
      expect(pauseTailDb(out, pauses)).toBeLessThanOrEqual(-80);
    });

    it('hides nothing on the silence-beside-floor shape — the converse, pinned at the mechanism', () => {
      // Why N2 still gates: every real sample inside the boundary windows the
      // eviction refuses ALSO lies inside an accepted all-real floor window,
      // so nothing is hidden and proceeding is safe. This is the structural
      // form of "evicted material that genuinely is floor still gates".
      const { channel } = takeWithSilentLeadIn(1.0);
      const w = measureNoiseWindow([channel], SR, { rejectMostlySilentWindows: true })!;
      expect(w.hiddenRealSamples).toBe(0);
      expect(deriveGate([channel], SR).run).toBe(true);
    });

    // M9 — the content checks mono-mix, and the mix of an exactly
    // polarity-inverted pair is all zeros: both checks would read a silent
    // window and wave it through, where the same take in mono declines.
    // The search itself is not fooled (a frame is silent only when EVERY
    // channel is zero), so a mostly-zero MIX of a window the search accepted
    // as mostly-real can only mean cancellation — and the stage declines.
    it('declines an exactly polarity-cancelling stereo pair instead of reading its mix as a pause', () => {
      const { channel } = continuousTakeWithWhisperedVerse();
      const neg = new Float32Array(channel.length);
      for (let i = 0; i < channel.length; i++) neg[i] = -channel[i];
      const res = deriveGate([Float32Array.from(channel), neg], SR);
      expect(res.run).toBe(false);
      if (res.run) return;
      expect(res.reason).toContain('cancel');
    });

    it('still gates an ordinary correlated stereo pair — the cancellation guard needs exact inversion', () => {
      const { channel, pauses } = takeWithSilentLeadIn(1.0);
      const res = deriveGate([Float32Array.from(channel), Float32Array.from(channel)], SR);
      expect(res.run).toBe(true);
      if (!res.run) return;
      const out = noiseGateEffect.process([Float32Array.from(channel)], SR, res.params).channels[0];
      expect(pauseTailDb(out, pauses)).toBeLessThanOrEqual(-80);
    });

    // N5 — the guard's first version counted exact zeros in the MIX and read
    // anything over the window bound as cancellation. That premise is false
    // for independent channels a few LSB wide: frame silence is a PRODUCT
    // (every channel zero) while mix zeros are a SUM (L = -R at that sample),
    // and the sum runs several times the product — the quietest window of the
    // rows below reads ~26-27 % mix zeros against ~14 % silent frames, so
    // ordinary quiet quantised stereo was refused with instructions to fix a
    // polarity flip it did not have. Depth tells the cases apart where
    // counting cannot: these windows mix exactly 3.0-3.1 dB below the window
    // RMS (the uncorrelated sum of two independent channels), where a real
    // inversion mixes to digital zero, 203 dB deep.
    it('does not mistake coincidental LSB collisions for polarity — quiet quantised stereo gates (N5)', () => {
      /** Independent floors per channel (different seeds), correlated sung
       * phrases, the whole take quantised to `bits` — everyday material for a
       * quiet recording through a coarse converter. */
      function stereoQuantisedTake(bits: number, floorDb: number): { L: Float32Array; R: Float32Array; pauses: { start: number; end: number }[] } {
        const pause = Math.round(1.0 * SR);
        const phrase = Math.round(0.8 * SR);
        const body = 3 * pause + 2 * phrase;
        const L = gaussFloorDb(body, floorDb, 7);
        const R = gaussFloorDb(body, floorDb, 23);
        const pauses: { start: number; end: number }[] = [];
        let at = 0;
        for (const [sung, n] of [
          [false, pause],
          [true, phrase],
          [false, pause],
          [true, phrase],
          [false, pause],
        ] as const) {
          if (!sung) pauses.push({ start: at, end: at + n });
          else {
            let ph = 0;
            for (let i = 0; i < n; i++) {
              const t = i / SR;
              ph += (2 * Math.PI * 220) / SR;
              const c = Math.min(1, t / 0.04) * Math.min(1, (n / SR - t) / 0.06);
              L[at + i] += 0.25 * c * Math.sin(ph);
              R[at + i] += 0.25 * c * Math.sin(ph);
            }
          }
          at += n;
        }
        const steps = Math.pow(2, bits - 1);
        for (let i = 0; i < body; i++) {
          L[i] = Math.round(L[i] * steps) / steps;
          R[i] = Math.round(R[i] * steps) / steps;
        }
        return { L, R, pauses };
      }

      for (const [bits, floorDb] of [
        [8, -42],
        [12, -66],
        [16, -90],
      ] as const) {
        const { L, R, pauses } = stereoQuantisedTake(bits, floorDb);
        const res = deriveGate([L, R], SR);
        expect(res.run).toBe(true);
        if (!res.run) return;
        const out = noiseGateEffect.process([Float32Array.from(L), Float32Array.from(R)], SR, res.params).channels[0];
        expect(pauseTailDb(out, pauses)).toBeLessThanOrEqual(-80);
      }

      // The measured gap the constant sits in is enormous (3.1 vs 203 dB);
      // mutations off either edge are caught by behaviour (a low bound fails
      // the rows above on their 3 dB depth; a bound past 203 lets the
      // [ch, -ch] member's all-zero mix through to checks that read silence
      // and run). The literal pins the in-gap placement.
      expect(GATE_CANCELLATION_DEPTH_DB).toBe(60);
    });
  });

  // M4 — the half-second the content checks read is mixed INLINE (mixing the
  // whole take would allocate 25 MB to look at 500 ms of it), and the helper
  // it replaced had stereo tests of its own that the inline form inherited
  // none of. Every property that loop has to have, pinned as gate behaviour on
  // a real stereo fixture: it reads EVERY channel, it reads the WINNING
  // window rather than the head of the take, and it takes the MEAN rather
  // than the sum.
  describe('the half-second the checks read, in stereo', () => {
    /** `[2 s floor][3.5 s soft passage][3.5 s loud chorus]` per channel, with
     * the soft passage chosen independently for each — the chorus keeps the
     * all-or-nothing guard quiet and the floor is never the quietest window. */
    function stereoTake(soft: (n: number, seed: number) => Float32Array[]): Float32Array[] {
      const floorLen = Math.round(2 * SR);
      const softLen = Math.round(3.5 * SR);
      const chorusLen = Math.round(3.5 * SR);
      const softs = soft(softLen, 41);
      return softs.map((s, ch) => {
        const out = new Float32Array(floorLen + softLen + chorusLen);
        out.set(gaussFloorDb(floorLen, -40, 7 + ch), 0);
        out.set(s, floorLen);
        let phase = 0;
        for (let i = 0; i < chorusLen; i++) {
          phase += (2 * Math.PI * 196) / SR;
          out[floorLen + softLen + i] = 0.25 * (Math.sin(phase) + 0.4 * Math.sin(2 * phase) + 0.2 * Math.sin(3 * phase));
        }
        return out;
      });
    }

    it('reads every channel: a whisper in ONE channel is still a whisper', () => {
      // The destructive shape a channel-0-only mix would produce: the right
      // channel's whispered verse is the quietest 500 ms, and a gate that
      // never looked at it would derive a threshold above it and mute it.
      // The left channel is 20 dB down, so the mix is essentially the right
      // channel halved and its formants survive it — which is the point: a
      // mix that never adds the right channel reads the left one's plain
      // floor, gates, and mutes a whisper.
      const asymmetric = stereoTake((n, seed) => [gaussFloorDb(n, -70, 3), whisper(n, -50, seed)]);
      const res = deriveGate(asymmetric, SR);
      expect(res.run).toBe(false);
      if (res.run) return;
      expect(res.reason).toContain('vocal tract');

      // The converse, same levels, same window: with a floor in BOTH channels
      // there is nothing to find and the take gates.
      const symmetric = stereoTake((n) => [gaussFloorDb(n, -70, 3), gaussFloorDb(n, -50, 5)]);
      const both = deriveGate(symmetric, SR);
      expect(both.run).toBe(true);
      if (!both.run) return;
      expect(Number(both.params.thresholdDb)).toBeLessThan(-35);
    });

    it('reads the window the search won, not the head of the take', () => {
      // A whispered opening, then a take whose quietest 500 ms is an ordinary
      // floor. A mix taken from sample 0 rather than from the winner would
      // read the whisper and refuse a take that has real pauses in it.
      const { channel, pauses } = takeWithSilentLeadIn(0);
      const head = whisper(Math.round(3.5 * SR), -36, 41);
      const L = new Float32Array(head.length + channel.length);
      L.set(head, 0);
      L.set(channel, head.length);
      const R = Float32Array.from(L);
      const res = deriveGate([L, R], SR);
      expect(res.run).toBe(true);
      if (!res.run) return;
      // The precondition: the winner really is past the whispered head.
      const w = measureNoiseWindow([L, R], SR, { rejectMostlySilentWindows: true })!;
      expect(w.startSample).toBeGreaterThanOrEqual(head.length);
      const out = noiseGateEffect.process([Float32Array.from(L), Float32Array.from(R)], SR, res.params).channels[0];
      const shifted = pauses.map((p) => ({ start: p.start + head.length, end: p.end + head.length }));
      let sum = 0;
      let n = 0;
      for (const p of shifted) {
        for (let i = p.end - Math.round(0.3 * SR); i < p.end; i++) sum += out[i] * out[i];
        n += Math.round(0.3 * SR);
      }
      expect(toDb(Math.sqrt(sum / n))).toBeLessThanOrEqual(-80);
    });

    it('takes the MEAN of the channels, not their sum — pinned in dB at the cancellation boundary', () => {
      // The mix's LEVEL is observable through exactly one check, so that is
      // where it is pinned. For `[L, -g·L]` the mean mixes to L·(1-g)/2, so
      // the cancellation depth is -20·log10(1-g) + 6.02 dB and the guard's
      // 60 dB lands at 1-g = 0.002. A sum would drop the +6.02 and move the
      // crossing to 1-g = 0.001 — so a pair at 1-g = 0.0015 declines with the
      // mean (62.5 dB deep) and would NOT with the sum (56.5 dB).
      const { channel } = continuousTakeWithWhisperedVerse();
      const scaled = (g: number): Float32Array[] => {
        const R = new Float32Array(channel.length);
        for (let i = 0; i < channel.length; i++) R[i] = -g * channel[i];
        return [Float32Array.from(channel), R];
      };

      const deep = deriveGate(scaled(1 - 0.0015), SR);
      expect(deep.run).toBe(false);
      if (deep.run) return;
      expect(deep.reason).toContain('cancel');

      // ...and the converse a decibel the other way: 1-g = 0.003 is 50.5 dB
      // deep with the mean, under the guard, so the ordinary checks decide —
      // and on this whispered take they decline for the whisper, not for a
      // polarity flip.
      const shallow = deriveGate(scaled(1 - 0.003), SR);
      expect(shallow.run).toBe(false);
      if (shallow.run) return;
      expect(shallow.reason).toContain('vocal tract');
      expect(shallow.reason).not.toContain('cancel');
    });
  });

  /**
   * I1 — the cancellation verdict is a DIAGNOSIS, not a failed pause test, and
   * V2's search must not step past one.
   *
   * The whole-take inverted pair above declines because EVERY candidate
   * cancels. The shape that V2 opened is the partial one: only the take's
   * quietest passage is polarity-inverted — one channel flipped by an edit,
   * a mis-wired DI, a stem summed the wrong way — while an ordinary floor a
   * decibel up passes every check. The search would step from the one to the
   * other, derive a threshold above the inverted passage, mute it, and never
   * show the polarity warning. What is muted there is unknowable by
   * construction: the mix the checks read is digital zero, so a whispered line
   * and an empty room are the same measurement.
   */
  describe('a take whose quiet passage ALONE is polarity-inverted (I1)', () => {
    /** `[phrase][inverted whisper][phrase][ordinary floor][phrase]`, stereo.
     * The inverted passage is the quietest, the floor is the next candidate up,
     * and the two sit inside the search's own climb bound. */
    function takeWithOneInvertedPassage(
      invertedDb = -56,
      floorDb = -55
    ): {
      channels: Float32Array[];
      inverted: { start: number; end: number };
      floor: { start: number; end: number };
    } {
      const phrase = Math.round(1.2 * SR);
      const gap = Math.round(0.9 * SR);
      const L = new Float32Array(3 * phrase + 2 * gap);
      const R = new Float32Array(L.length);
      const sing = (from: number, n: number): void => {
        let phase = 0;
        for (let i = 0; i < n; i++) {
          phase += (2 * Math.PI * 196) / SR;
          const v = 0.2 * (Math.sin(phase) + 0.4 * Math.sin(2 * phase));
          L[from + i] += v;
          R[from + i] += v;
        }
      };
      let at = 0;
      sing(at, phrase);
      at += phrase;
      const inverted = { start: at, end: at + gap };
      const w = whisper(gap, invertedDb, 61);
      for (let i = 0; i < gap; i++) {
        L[at + i] = w[i];
        R[at + i] = -w[i];
      }
      at += gap;
      sing(at, phrase);
      at += phrase;
      const floor = { start: at, end: at + gap };
      const fa = gaussFloorDb(gap, floorDb, 71);
      const fb = gaussFloorDb(gap, floorDb, 72);
      for (let i = 0; i < gap; i++) {
        L[at + i] = fa[i];
        R[at + i] = fb[i];
      }
      at += gap;
      sing(at, phrase);
      return { channels: [L, R], inverted, floor };
    }

    it('is the shape it claims: a cancelling quietest window with a passing one INSIDE the climb bound', () => {
      const { channels, inverted, floor } = takeWithOneInvertedPassage();
      const cands = measureNoiseWindows(channels, SR, {
        rejectMostlySilentWindows: true,
        maxCandidates: GATE_QUIET_WINDOWS,
      });
      const inWindow = (w: { startSample: number; lengthSamples: number }, span: { start: number; end: number }) =>
        w.startSample >= span.start && w.startSample + w.lengthSamples <= span.end;

      // The quietest candidate is the inverted passage, and it really cancels:
      // its mono mix is digital zero, so the two content checks see nothing.
      expect(inWindow(cands[0], inverted)).toBe(true);
      const mono = new Float32Array(cands[0].lengthSamples);
      for (let i = 0; i < mono.length; i++) {
        mono[i] = (channels[0][cands[0].startSample + i] + channels[1][cands[0].startSample + i]) / 2;
      }
      let sq = 0;
      for (let i = 0; i < mono.length; i++) sq += mono[i] * mono[i];
      expect(cands[0].rmsDb - toDb(Math.sqrt(sq / mono.length))).toBeGreaterThan(GATE_CANCELLATION_DEPTH_DB);

      // ...and an ordinary floor sits within the climb bound of it, so the
      // search would have stepped from the one to the other. This is the
      // calibration gap: `GATE_SEARCH_CLIMB_DB` was derived on breath and
      // whisper populations, and a cancelling window lands in its PERMISSIVE
      // half.
      const passing = cands.find((c) => inWindow(c, floor));
      expect(passing).toBeDefined();
      expect(passing!.envelopePeakDb - cands[0].envelopePeakDb).toBeLessThanOrEqual(GATE_SEARCH_CLIMB_DB);

      // ...and a threshold taken there really would cover the inverted
      // passage, which is the damage: it sits below the level the gate closes
      // at, and nothing in the checks could have told anyone what it was.
      expect(passing!.envelopePeakDb + GATE_HEADROOM_DB).toBeGreaterThan(cands[0].envelopePeakDb);
    }, 120000);

    it('declines on the polarity diagnosis instead of gating past it', () => {
      const { channels } = takeWithOneInvertedPassage();
      const res = deriveGate(channels, SR);
      expect(res.run).toBe(false);
      if (res.run) return;
      expect(res.reason).toContain('cancel');
      expect(res.reason).toContain('polarity');
    }, 120000);

    it('refuses even when the cancelling passage is NOT the quietest, and says which one it is', () => {
      // The harder half of the same shape: an ordinary floor is the quietest
      // window and passes every check, so the old walk would accept it and
      // stop — the cancelling passage three decibels up would never be looked
      // at, and the gate would close over it. The diagnosis is about the FILE,
      // so it is asked of every candidate the search returned.
      const { channels, inverted, floor } = takeWithOneInvertedPassage(-55, -58);
      const cands = measureNoiseWindows(channels, SR, {
        rejectMostlySilentWindows: true,
        maxCandidates: GATE_QUIET_WINDOWS,
      });
      // The precondition: the quietest window is the honest floor, not the
      // inverted passage.
      expect(cands[0].startSample).toBeGreaterThanOrEqual(floor.start);
      expect(cands[0].startSample + cands[0].lengthSamples).toBeLessThanOrEqual(floor.end);

      const res = deriveGate(channels, SR);
      expect(res.run).toBe(false);
      if (res.run) return;
      expect(res.reason).toContain('cancel');
      expect(res.reason).toContain('polarity');
      // ...and the message may not claim the QUIETEST half-second cancelled,
      // because it did not — it names where the inversion actually is.
      expect(res.reason).not.toContain(`the quietest ${NOISE_WINDOW_MS} ms cancel`);
      const at = res.reason.match(/at ([\d.]+) s/);
      expect(at).not.toBeNull();
      const named = Number(at![1]) * SR;
      expect(named).toBeGreaterThanOrEqual(inverted.start - SR * 0.05);
      expect(named).toBeLessThan(inverted.end);
    }, 120000);
  });

  // N6 — the census's own blind spot, and the only destructive shape this
  // stage still had. A window may carry a quiet island BESIDE louder material
  // and still be accepted, because the acceptance bound constrains a window's
  // ZEROS and not its LEVELS; its RMS is then the louder material's, so it is
  // never the winner, never checked, and — being covered — never counted
  // hidden. The threshold comes from elsewhere and the island is muted whole.
  //
  // The fix is not in the derivation, which measures correctly: it is in the
  // gate, which now spends a run of digital silence OPEN (see
  // `GATE_SILENT_RUN_MS`). The two halves close on each other exactly:
  // `GATE_HOLD_MS` is `NOISE_WINDOW_MS`, so an island long enough to outlast
  // the hold is long enough to contain a whole search window and be measured
  // on its own terms — which is why the sweep below flips from RUN to a
  // vocal-tract DECLINE at 400 ms and never leaves a band uncovered.
  describe('a quiet island bracketed by digital silence (N6)', () => {
    function res2At(x: Float32Array, sr: number, hz: number, q: number): Float32Array {
      const w = (2 * Math.PI * hz) / sr;
      const r = Math.exp(-w / (2 * q));
      const a1 = 2 * r * Math.cos(w);
      const a2 = -r * r;
      const out = new Float32Array(x.length);
      let y1 = 0;
      let y2 = 0;
      for (let i = 0; i < x.length; i++) {
        const y = x[i] + a1 * y1 + a2 * y2;
        out[i] = y;
        y2 = y1;
        y1 = y;
      }
      return out;
    }

    /** The suite's whisper, at an arbitrary rate. */
    function whisperAt(n: number, rmsDb: number, seed: number, sr: number): Float32Array {
      let x = noise(n, 1, seed);
      for (const [hz, q] of [
        [500, 8],
        [1500, 10],
        [2500, 12],
      ] as const) {
        if (hz < (sr / 2) * 0.9) x = res2At(x, sr, hz, q);
      }
      for (let i = 0; i < n; i++) x[i] *= 0.55 + 0.45 * Math.sin((2 * Math.PI * 4 * i) / sr);
      return atRms(x, Math.pow(10, rmsDb / 20));
    }

    function sungAt(n: number, sr: number, amp: number): Float32Array {
      const out = new Float32Array(n);
      let phase = 0;
      for (let i = 0; i < n; i++) {
        phase += (2 * Math.PI * 220) / sr;
        out[i] = amp * Math.sin(phase);
      }
      return out;
    }

    /** `takeWithSilentLeadIn(0)` at an arbitrary rate: two sung phrases with
     * real 1 s pauses over a -50 dBFS floor. This is what sets the threshold. */
    function floorTakeAt(sr: number): Float32Array {
      const pause = Math.round(1.0 * sr);
      const phrase = Math.round(0.8 * sr);
      const channel = gaussFloorDb(3 * pause + 2 * phrase, -50, 7);
      let at = 0;
      for (const [sung, n] of [
        [false, pause],
        [true, phrase],
        [false, pause],
        [true, phrase],
        [false, pause],
      ] as const) {
        if (sung) {
          let phase = 0;
          for (let i = 0; i < n; i++) {
            const t = i / sr;
            phase += (2 * Math.PI * 220) / sr;
            const c = Math.min(1, t / 0.04) * Math.min(1, (n / sr - t) / 0.06);
            channel[at + i] += 0.25 * c * Math.sin(phase);
          }
        }
        at += n;
      }
      return channel;
    }

    function cat(parts: Float32Array[]): Float32Array {
      const out = new Float32Array(parts.reduce((a, p) => a + p.length, 0));
      let at = 0;
      for (const p of parts) {
        out.set(p, at);
        at += p.length;
      }
      return out;
    }

    /** `[floor take][0.3 s zeros][island and burst, in the given order][zeros]`
     * — the re-review's own fixture, at an arbitrary rate. */
    function islandTake(
      sr: number,
      islandMs: number,
      order: 'before' | 'after',
    ): { channel: Float32Array; island: { start: number; end: number } } {
      const zeros = new Float32Array(Math.round(0.3 * sr));
      const island = whisperAt(Math.round((islandMs / 1000) * sr), -60, 41, sr);
      const burst = sungAt(Math.round(0.5 * sr), sr, 0.25);
      const head = floorTakeAt(sr);
      const channel =
        order === 'before'
          ? cat([head, zeros, island, burst, new Float32Array(zeros.length)])
          : cat([head, zeros, burst, island, new Float32Array(zeros.length)]);
      const start = head.length + zeros.length + (order === 'before' ? 0 : burst.length);
      return { channel, island: { start, end: start + island.length } };
    }

    const removedPct = (input: Float32Array, out: Float32Array, span: { start: number; end: number }): number => {
      let a = 0;
      let b = 0;
      for (let i = span.start; i < span.end; i++) {
        a += input[i] * input[i];
        b += out[i] * out[i];
      }
      return (1 - b / a) * 100;
    };

    it('is left alone, on either side of the phrase it approaches', () => {
      // Measured before the fix, at all three rates: the island BEFORE the
      // burst was removed 100.0 %, hiddenRealSamples = 0, the stage running at
      // -41.1 / -42.2 / -42.2 dBFS off the floor take's own pauses. The mirror
      // island AFTER the burst lost 0.0 %, because `GATE_HOLD_MS` equals the
      // window length and holds the gate open across it — the exposure was
      // exactly quiet material APPROACHING a phrase out of digital silence.
      for (const sr of [SR, 44100, 48000]) {
        for (const islandMs of [200, 300]) {
          for (const order of ['before', 'after'] as const) {
            const { channel, island } = islandTake(sr, islandMs, order);
            // The precondition: the census really does see nothing here, so
            // this is the shape the hidden-material decline cannot catch.
            const noise = measureNoiseWindow([channel], sr, { rejectMostlySilentWindows: true })!;
            expect(noise.hiddenRealSamples).toBe(0);

            const res = deriveGate([channel], sr);
            expect(res.run).toBe(true);
            if (!res.run) return;
            // And the derivation is untouched by the fix: still the floor's.
            expect(Number(res.params.thresholdDb)).toBeGreaterThan(-45);
            expect(Number(res.params.thresholdDb)).toBeLessThan(-40);

            const out = noiseGateEffect.process([Float32Array.from(channel)], sr, res.params).channels[0];
            expect(removedPct(channel, out, island)).toBeLessThan(0.1);
          }
        }
      }
    }, 120000);

    it('still gates the take it sits in — the island is spared, the pauses are not', () => {
      // The converse: sparing the island must not cost the stage its job. The
      // floor take's own real pauses still reach digital silence.
      const pause = Math.round(1.0 * SR);
      const phrase = Math.round(0.8 * SR);
      const pauses = [
        { start: 0, end: pause },
        { start: pause + phrase, end: 2 * pause + phrase },
        { start: 2 * pause + 2 * phrase, end: 3 * pause + 2 * phrase },
      ];
      const { channel } = islandTake(SR, 300, 'before');
      const res = deriveGate([channel], SR);
      expect(res.run).toBe(true);
      if (!res.run) return;
      const out = noiseGateEffect.process([Float32Array.from(channel)], SR, res.params).channels[0];
      let sum = 0;
      let n = 0;
      for (const p of pauses) {
        for (let i = p.end - Math.round(0.3 * SR); i < p.end; i++) sum += out[i] * out[i];
        n += Math.round(0.3 * SR);
      }
      expect(toDb(Math.sqrt(sum / n))).toBeLessThanOrEqual(-80);
    });

    it('runs out exactly where the search takes over: the band is 375 ms, the hold is 500', () => {
      // Why one hold is enough, measured rather than argued. Up to 375 ms an
      // island is never the winner and never covered on its own terms, so the
      // gate is the only thing standing between it and the threshold; from
      // 400 ms a 500 ms search window reaches inside it, the island becomes
      // the measurement, and the vocal-tract check declines the take outright.
      // There is no island length at which neither protection applies.
      for (const sr of [SR, 44100]) {
        for (const islandMs of [100, 200, 300, 375]) {
          const { channel, island } = islandTake(sr, islandMs, 'before');
          const res = deriveGate([channel], sr);
          expect(res.run).toBe(true);
          if (!res.run) return;
          const out = noiseGateEffect.process([Float32Array.from(channel)], sr, res.params).channels[0];
          expect(removedPct(channel, out, island)).toBeLessThan(0.1);
        }
        for (const islandMs of [400, 500, 800]) {
          const { channel } = islandTake(sr, islandMs, 'before');
          const res = deriveGate([channel], sr);
          expect(res.run).toBe(false);
          if (res.run) return;
          expect(res.reason).toContain('vocal tract');
        }
      }
    }, 120000);
  });

  /**
   * V2 — the shape a real 2 min 22 s take came in with, reported 2026-08-14:
   * the quietest 500 ms of it read 4.0 dB of vocal-tract shaping, the stage
   * declined, and "the noise in the non-singing parts was not removed".
   *
   * The construction is that report's own arithmetic. The take has two halves,
   * because a room is not one level for two minutes: the singer's half is quiet
   * (a −66 dBFS floor) and every gap in it is filled by an audible breath at
   * −60 dBFS, none of them shorter than the 500 ms search window; the other
   * half is louder (a −55 dBFS floor) and carries one real 2 s pause. So the
   * quietest windows in the whole take are the BREATHES — they sit 5 dB under
   * the pause that is the only honest measurement in the file — and the take
   * declines on a half-second the derivation had no reason to prefer.
   */
  function takeWhoseQuietestWindowIsABreath(breathGaps: number): {
    channel: Float32Array;
    pause: { start: number; end: number };
    phrases: { start: number; end: number }[];
  } {
    const phrase = Math.round(1.2 * SR);
    const gap = Math.round(0.55 * SR);
    const quietLen = breathGaps * (phrase + gap) + phrase;
    const pauseLen = Math.round(2.0 * SR);
    const loudLen = phrase + pauseLen + phrase;
    const channel = new Float32Array(quietLen + loudLen);
    const phrases: { start: number; end: number }[] = [];
    const sing = (from: number, n: number, amp: number): void => {
      let phase = 0;
      for (let i = 0; i < n && from + i < channel.length; i++) {
        phase += (2 * Math.PI * 196) / SR;
        channel[from + i] += amp * (Math.sin(phase) + 0.4 * Math.sin(2 * phase));
      }
      phrases.push({ start: from, end: from + n });
    };

    channel.set(gaussFloorDb(quietLen, -66, 5), 0);
    let at = 0;
    for (let g = 0; g < breathGaps; g++) {
      sing(at, phrase, 0.15);
      at += phrase;
      const br = whisper(gap, -60, 31 + g);
      for (let i = 0; i < gap && at + i < quietLen; i++) channel[at + i] += br[i];
      at += gap;
    }
    sing(at, phrase, 0.15);

    channel.set(gaussFloorDb(loudLen, -55, 82), quietLen);
    sing(quietLen, phrase, 0.2);
    const pause = { start: quietLen + phrase, end: quietLen + phrase + pauseLen };
    sing(pause.end, phrase, 0.2);
    return { channel, pause, phrases };
  }

  /** The share of `span` the gate changed — a phrase it left alone reads 0. */
  function changedPct(before: Float32Array, after: Float32Array, span: { start: number; end: number }): number {
    let changed = 0;
    for (let i = span.start; i < span.end; i++) if (before[i] !== after[i]) changed++;
    return (changed / (span.end - span.start)) * 100;
  }

  describe('a take whose quietest window is a breath but whose pauses are real (V2)', () => {
    it('is that shape: the quietest window is an unvoiced vocal passage, and it is NOT the pause', () => {
      const { channel, pause } = takeWhoseQuietestWindowIsABreath(4);
      const w = measureNoiseWindow([channel], SR, { rejectMostlySilentWindows: true })!;
      // The window the old derivation interrogated: a breath, by the stage's
      // own measurement, and nowhere near the take's one real pause.
      const mono = Float32Array.from(channel.subarray(w.startSample, w.startSample + w.lengthSamples));
      expect(spectralTiltResidualDb(mono, SR)).toBeGreaterThan(GATE_SHAPED_RESIDUAL_DB);
      expect(w.startSample + w.lengthSamples).toBeLessThanOrEqual(pause.start);
      // ...and the pause really is a pause the stage would accept, on its own.
      const alone = Float32Array.from(channel.subarray(pause.start, pause.end));
      expect(spectralTiltResidualDb(alone, SR)).toBeLessThan(GATE_SHAPED_RESIDUAL_DB);
    });

    it('gates it, taking the threshold from the pause rather than declining on the breath', () => {
      const { channel, pause, phrases } = takeWhoseQuietestWindowIsABreath(4);
      const res = deriveGate([channel], SR);
      expect(res.run).toBe(true);
      if (!res.run) return;

      // The threshold is the PAUSE's, not the breath's: above the floor the
      // pause is made of, and below the breath the old search settled on.
      const pauseWindow = measureNoiseWindow(
        [Float32Array.from(channel.subarray(pause.start, pause.end))],
        SR,
        { rejectMostlySilentWindows: true }
      )!;
      expect(Number(res.params.thresholdDb)).toBeCloseTo(pauseWindow.envelopePeakDb + GATE_HEADROOM_DB, 1);

      const out = noiseGateEffect.process([Float32Array.from(channel)], SR, res.params).channels[0];
      // The gaps go silent...
      let sum = 0;
      const tail = Math.round(0.3 * SR);
      for (let i = pause.end - tail; i < pause.end; i++) sum += out[i] * out[i];
      expect(toDb(Math.sqrt(sum / tail))).toBeLessThanOrEqual(-80);
      // ...and every sung phrase comes back untouched.
      for (const phrase of phrases) expect(changedPct(channel, out, phrase)).toBeLessThan(0.1);
    });

    it('the same take with ONE breath gap gates too — the search is not a fixture-count trick', () => {
      const { channel, pause } = takeWhoseQuietestWindowIsABreath(1);
      const res = deriveGate([channel], SR);
      expect(res.run).toBe(true);
      if (!res.run) return;
      const out = noiseGateEffect.process([Float32Array.from(channel)], SR, res.params).channels[0];
      let sum = 0;
      const tail = Math.round(0.3 * SR);
      for (let i = pause.end - tail; i < pause.end; i++) sum += out[i] * out[i];
      expect(toDb(Math.sqrt(sum / tail))).toBeLessThanOrEqual(-80);
    });

    // Both sides of `GATE_QUIET_WINDOWS`, as behaviour. Each breath is one
    // DISTINCT candidate, so the take's real pause is candidate number
    // (breaths + 1): a take with one fewer breath than the bound still reaches
    // its pause, and a take with exactly the bound does not.
    it('reaches a pause that is the LAST candidate it is allowed to look at', () => {
      const { channel, pause } = takeWhoseQuietestWindowIsABreath(GATE_QUIET_WINDOWS - 1);
      const res = deriveGate([channel], SR);
      expect(res.run).toBe(true);
      if (!res.run) return;
      const out = noiseGateEffect.process([Float32Array.from(channel)], SR, res.params).channels[0];
      let sum = 0;
      const tail = Math.round(0.3 * SR);
      for (let i = pause.end - tail; i < pause.end; i++) sum += out[i] * out[i];
      expect(toDb(Math.sqrt(sum / tail))).toBeLessThanOrEqual(-80);
    }, 120000);

    it('declines one breath further out, and names the threshold the user can set', () => {
      const { channel } = takeWhoseQuietestWindowIsABreath(GATE_QUIET_WINDOWS);
      const res = deriveGate([channel], SR);
      expect(res.run).toBe(false);
      if (res.run) return;
      // It still names the quietest window's own failure — the passage the
      // user can hear as the quietest thing in the take...
      expect(res.reason).toContain('vocal tract');
      // ...says how much was actually looked at, rather than implying the
      // whole take was...
      expect(res.reason).toContain(`the ${GATE_QUIET_WINDOWS} quietest`);
      // ...and points at the escape, because silence must stay reachable.
      expect(res.reason).toContain("set this stage's threshold yourself");
    }, 120000);

    it('is exactly the depth the deepest take it covers needs — the derivation, measured', () => {
      // M3. Both SIDES of this constant are pinned as behaviour just above
      // (eleven gaps gate, twelve decline). What was missing is the DERIVATION
      // those two pins were cut from: how deep the search must go to reach a
      // take's real pause when N breath-filled gaps sit in front of it. Each
      // breath is one DISTINCT candidate — `measureNoiseWindows` refuses
      // overlaps — so the pause is candidate (breaths + 1). The docblock
      // narrated that law; this measures it, so widening or narrowing the
      // constant has to be argued against the shape rather than against prose.
      const depths: { gaps: number; depth: number }[] = [];
      for (const gaps of [1, 2, 4, 6, 8, 11, GATE_QUIET_WINDOWS]) {
        const { channel, pause } = takeWhoseQuietestWindowIsABreath(gaps);
        // Searched DEEPER than the constant on purpose: a measurement clipped
        // by the bound it is deriving would only be able to agree with it.
        const cands = measureNoiseWindows([channel], SR, {
          rejectMostlySilentWindows: true,
          maxCandidates: GATE_QUIET_WINDOWS * 2,
        });
        const at = cands.findIndex(
          (c) => c.startSample >= pause.start && c.startSample + c.lengthSamples <= pause.end
        );
        expect(at).toBeGreaterThanOrEqual(0);
        depths.push({ gaps, depth: at + 1 });
      }

      // The measured law, and the docblock's own numbers.
      expect(depths.map((d) => d.depth)).toEqual([2, 3, 5, 7, 9, 12, 13]);
      for (const { gaps, depth } of depths) expect(depth).toBe(gaps + 1);

      // ...and the constant is where that law was CUT. It is exactly the depth
      // an eleven-gap take needs and one short of a twelve-gap take's, which is
      // what makes the pair of behaviour pins above a boundary rather than two
      // arbitrary fixtures. It is not a claim that eleven is all a take can
      // have: each candidate costs a pitch track and a tilt fit, so the bound
      // is a price, and the take with more gaps is the one `manualThresholdDb`
      // exists for.
      expect(depths.find((d) => d.gaps === 11)!.depth).toBe(GATE_QUIET_WINDOWS);
      expect(depths.find((d) => d.gaps === GATE_QUIET_WINDOWS)!.depth).toBeGreaterThan(GATE_QUIET_WINDOWS);
      expect(GATE_QUIET_WINDOWS).toBe(12);
    }, 300000);

    it('names an escape the user can actually reach from where the refusal leaves them', () => {
      // M4. The refusal is READ in the dialog's results state, and the common
      // way to get there is a MIXED run: Noise Reduction applied, the gate
      // declined. `report.applied` is then true, the dialog is finished, and
      // the very tick the message points at is greyed by that finish — so a
      // message that stops at "tick the box" is an instruction the user cannot
      // follow without knowing to close and reopen the dialog first. It has to
      // name the control by the words on it, and name the reopen.
      const res = deriveGate([noise(SR * 3, 0.01, 9)], SR);
      expect(res.run).toBe(false);
      if (res.run) return;
      expect(res.reason).toContain('Gate at a level I set instead');
      expect(res.reason).toContain('reopen');
    }, 120000);

    it('names the escape in EVERY refusal, not only the one the search produced', () => {
      // A user who cannot reach silence has not been served by any of these
      // paragraphs, whichever measurement ran out.
      const takes: Float32Array[][] = [
        [new Float32Array(WIN * 4)], // no measurable floor at all
        [tone(SR * 3, 440, 0.25)], // nothing that is not the material
        [noise(SR * 3, 0.01, 9)], // steady room tone, no pause
        [continuousTakeWithSoftVerse().channel], // quiet singing
        [continuousTakeWithWhisperedVerse().channel], // a whisper
      ];
      for (const take of takes) {
        const res = deriveGate(take, SR);
        expect(res.run).toBe(false);
        if (res.run) return;
        expect(res.reason).toContain("set this stage's threshold yourself");
        expect(res.reason.endsWith('Nothing was gated')).toBe(true);
      }
    }, 120000);

    it('costs at most one pitch track and one tilt fit per candidate, however long the take', () => {
      // The tilt fit is an STFT and the pitch track is 12-14x dearer again, so
      // the price of looking further has to be bounded by the CANDIDATE COUNT
      // and not by the length of the recording.
      const pitch = jest.spyOn(pitchDetect, 'detectPitch');
      const tilt = jest.spyOn(chainAnalysis, 'spectralTiltResidualDb');
      try {
        const counts: number[][] = [];
        for (const gaps of [GATE_QUIET_WINDOWS, GATE_QUIET_WINDOWS * 3]) {
          pitch.mockClear();
          tilt.mockClear();
          deriveGate([takeWhoseQuietestWindowIsABreath(gaps).channel], SR);
          counts.push([pitch.mock.calls.length, tilt.mock.calls.length]);
        }
        for (const [pitchCalls, tiltCalls] of counts) {
          expect(pitchCalls).toBeLessThanOrEqual(GATE_QUIET_WINDOWS);
          expect(tiltCalls).toBeLessThanOrEqual(GATE_QUIET_WINDOWS);
        }
        // A take three times as long does not cost three times as much.
        expect(counts[1][0]).toBeLessThanOrEqual(counts[0][0]);
        expect(counts[1][1]).toBeLessThanOrEqual(counts[0][1]);
        // ...and the cheap check does the walking: only the quietest window is
        // judged in the order the messages were derived in, so the pitch track
        // runs once where the tilt fit runs on every candidate.
        expect(counts[0][0]).toBe(1);
        expect(counts[0][1]).toBe(GATE_QUIET_WINDOWS);
      } finally {
        pitch.mockRestore();
        tilt.mockRestore();
      }
    }, 300000);

    /**
     * R2 — the last word is the user's. No measurement can tell an unshaped
     * breath from room tone, and no search can conjure a pause into a take
     * that has none; but "no word, no sound" has to stay REACHABLE, so the
     * stage takes a threshold it did not measure and runs the same state
     * machine at it.
     */
    describe('the threshold the user sets when no measurement can be made', () => {
      it('gates a take that declines, at exactly the level asked for', () => {
        const { channel } = takeWhoseQuietestWindowIsABreath(GATE_QUIET_WINDOWS);
        expect(deriveGate([channel], SR).run).toBe(false);

        const res = deriveGate([channel], SR, -40);
        expect(res.run).toBe(true);
        if (!res.run) return;
        expect(Number(res.params.thresholdDb)).toBe(-40);
        // Only the SOURCE of the threshold changes: the detector, the hold and
        // the fades are the stage's own, so the manual run is the derived run
        // with one number replaced.
        expect(Number(res.params.attackMs)).toBe(DETECT_ATTACK_MS);
        expect(Number(res.params.releaseMs)).toBe(DETECT_RELEASE_MS);
        expect(Number(res.params.holdMs)).toBe(GATE_HOLD_MS);

        const out = noiseGateEffect.process([Float32Array.from(channel)], SR, res.params).channels[0];
        let silent = 0;
        for (let i = 0; i < out.length; i++) if (out[i] === 0) silent++;
        expect(silent).toBeGreaterThan(0);
      }, 120000);

      it('says the threshold is the user’s, not a measurement it never took', () => {
        const { channel } = takeWhoseQuietestWindowIsABreath(GATE_QUIET_WINDOWS);
        const res = deriveGate([channel], SR, -40);
        if (!res.run) throw new Error('expected run');
        const threshold = res.derived.find((d) => d.label.includes('Threshold'))!;
        expect(threshold.label).toContain('manual');
        expect(threshold.value).toBe('-40.0 dBFS');
        expect(threshold.from).toContain('you set');
        // It must not claim a derivation it did not make.
        expect(threshold.from).not.toContain(`${GATE_HEADROOM_DB} dB over`);
        // ...and it still reports how much of the take it will silence, which
        // is the only way the user can tell they set it too high.
        expect(res.derived.some((d) => d.label === 'Gated')).toBe(true);
      }, 120000);

      it('clamps into the effect’s own range rather than emitting a level it cannot take', () => {
        const { channel } = takeWhoseQuietestWindowIsABreath(1);
        const param = getEffect('noise-gate')!.params.find((p) => p.id === 'thresholdDb')!;
        for (const [asked, expected] of [
          [-500, param.min as number],
          [+40, param.max as number],
        ] as const) {
          const res = deriveGate([channel], SR, asked);
          if (!res.run) throw new Error('expected run');
          expect(Number(res.params.thresholdDb)).toBe(expected);
        }
      }, 120000);

      it('overrides the derivation on a take that would have gated on its own', () => {
        // The user's judgement wins over a measurement that succeeded too —
        // otherwise the box would silently do nothing on most takes.
        const { channel } = takeWhoseQuietestWindowIsABreath(1);
        const derivedRun = deriveGate([channel], SR);
        if (!derivedRun.run) throw new Error('expected the derived run to gate');
        expect(Number(derivedRun.params.thresholdDb)).not.toBe(-40);
        const manual = deriveGate([channel], SR, -40);
        if (!manual.run) throw new Error('expected run');
        expect(Number(manual.params.thresholdDb)).toBe(-40);
      }, 120000);

      it('spends nothing on a search whose answer it is about to discard', () => {
        const spy = jest.spyOn(chainAnalysis, 'measureNoiseWindows');
        try {
          const { channel } = takeWhoseQuietestWindowIsABreath(2);
          deriveGate([channel], SR, -40);
          expect(spy).not.toHaveBeenCalled();
        } finally {
          spy.mockRestore();
        }
      }, 120000);
    });

    it('says in the row the user reads what it actually searches', () => {
      // The note is rendered verbatim in the dialog. A stage that quietly
      // changed what it looks at, while its own row still described one
      // window, would be a stage nobody could reason about.
      const note = stageById('gate').note;
      expect(note).toContain(`${GATE_QUIET_WINDOWS} quietest distinct passages`);
      expect(note).toContain(`${GATE_SEARCH_CLIMB_DB} dB`);
      expect(note).not.toContain(`measured from the quietest ${NOISE_WINDOW_MS} ms`);
    });

    // The converse, and the one that matters most: a take where EVERY quiet
    // window is vocal must still decline. The search widens what is looked at;
    // it does not lower the bar any of them has to clear.
    it('still declines when every quiet passage in the take is vocal', () => {
      for (const [name, take] of [
        ['soft singing', continuousTakeWithSoftVerse().channel],
        ['a whisper', continuousTakeWithWhisperedVerse().channel],
      ] as const) {
        const res = deriveGate([take], SR);
        expect([name, res.run]).toEqual([name, false]);
        if (res.run) return;
        expect(res.reason).toContain(name === 'soft singing' ? 'singing' : 'vocal tract');
      }
    });
  });

  it('does NOT share Noise Reduction’s decline: gating needs no clean print (N3)', () => {
    // A take whose quietest passage sits within 12 dB of programme level: NR
    // refuses, because a print learned there would contain voice. The gate has
    // no print to learn — it needs only a level — and that take is exactly the
    // one whose gaps are loudest, so a shared decline would abandon the user
    // who needs the stage most.
    const noisy = withNoisyGap(8, 0.5, 0.3, 4);
    const nr = deriveNoiseReduction([noisy], SR);
    expect(nr.run).toBe(false);
    if (nr.run) return;
    expect(nr.reason).toContain('would contain voice');
    expect(deriveGate([noisy], SR).run).toBe(true);
  });
});

// ── The two constants deriveGate introduces, and their populations ─────────
// Both are kept sweeps rather than docblock narrative: a constant whose only
// justification is a comment is a constant that can be edited without anything
// failing, and both of these are load-bearing in BOTH directions.

describe('GATE_HEADROOM_DB', () => {
  /** Gaussian floor — a heavier tail than uniform, and the distribution the
   * worst graze in the full sweep came from. RMS is solved for, not guessed:
   * a sum of four uniforms on [-1,1] has variance 4/3. */
  function gaussFloor(n: number, rmsDb: number, seed: number): Float32Array {
    let s = seed >>> 0;
    const next = (): number => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return (s / 0xffffffff) * 2 - 1;
    };
    const out = new Float32Array(n);
    const k = Math.pow(10, rmsDb / 20) / Math.sqrt(4 / 3);
    for (let i = 0; i < n; i++) out[i] = (next() + next() + next() + next()) * k;
    return out;
  }

  function takeWithPauses(gapSec: number, floorDb: number, seed: number) {
    const plan = [
      { sung: false, sec: gapSec },
      { sung: true, sec: 1.2 },
      { sung: false, sec: gapSec },
      { sung: true, sec: 1.0 },
      { sung: false, sec: gapSec },
    ];
    const total = plan.reduce((a, p) => a + Math.round(p.sec * SR), 0);
    const ch = gaussFloor(total, floorDb, seed);
    const pauses: { start: number; end: number }[] = [];
    let at = 0;
    for (const p of plan) {
      const n = Math.round(p.sec * SR);
      if (!p.sung) pauses.push({ start: at, end: at + n });
      else {
        let phase = 0;
        for (let i = 0; i < n; i++) {
          const t = i / SR;
          phase += (2 * Math.PI * 220) / SR;
          const c = Math.min(1, t / 0.04) * Math.min(1, (n / SR - t) / 0.06);
          ch[at + i] += 0.25 * c * Math.sin(phase);
        }
      }
      at += n;
    }
    return { ch, pauses };
  }

  /** How far the floor's own envelope rises ABOVE the threshold derived from
   * the quietest window, measured in the settled part of each interior pause —
   * 300 ms clear of the previous phrase's decay and of the next one's onset, so
   * what is measured is the floor and not a phrase edge. */
  function graze(ch: Float32Array, pauses: { start: number; end: number }[], floorPeakDb: number): number {
    const env = envelopeFollower(maxAcrossChannels([ch]), SR, DETECT_ATTACK_MS, DETECT_RELEASE_MS);
    const guard = Math.round(0.3 * SR);
    let worst = -Infinity;
    for (const p of pauses.slice(1, -1)) {
      for (let i = p.start + guard; i < p.end - guard; i++) {
        const d = toDb(env[i]) - floorPeakDb;
        if (d > worst) worst = d;
      }
    }
    return worst;
  }

  it('is larger than the floor ever grazes the level it is measured from, raw AND after Noise Reduction', () => {
    // The corner the full 144-take sweep (4 rates x 3 gap lengths x 3 floors x
    // 2 distributions x 2 seeds) found worst, reproduced here in eight takes:
    // 8 kHz, short pauses, Gaussian floor. The lean slice lands on the full
    // sweep's exact worst figures, which is why it is the slice that is kept.
    let worstRaw = -Infinity;
    let worstAfterNr = -Infinity;
    for (const gapSec of [1.5, 3.0]) {
      for (const floorDb of [-35, -45]) {
        for (const seed of [7, 23]) {
          const { ch, pauses } = takeWithPauses(gapSec, floorDb, seed);
          const raw = measureNoiseWindow([ch], SR)!;
          worstRaw = Math.max(worstRaw, graze(ch, pauses, raw.envelopePeakDb));

          const nr = deriveNoiseReduction([ch], SR);
          if (!nr.run) throw new Error('expected Noise Reduction to run on this fixture');
          (globalThis as { __effectExtra?: unknown }).__effectExtra = nr.extra;
          const out = noiseReductionEffect.process([Float32Array.from(ch)], SR, nr.params).channels;
          delete (globalThis as { __effectExtra?: unknown }).__effectExtra;
          const after = measureNoiseWindow(out, SR)!;
          worstAfterNr = Math.max(worstAfterNr, graze(out[0], pauses, after.envelopePeakDb));
        }
      }
    }

    // The graze is REAL — a headroom of 0 would put the threshold under the
    // floor's own extreme, which is the defect this constant exists for.
    expect(worstRaw).toBeGreaterThan(0.3);
    // Noise Reduction makes it worse, not better: its residual is peakier than
    // the floor it replaced. This is why a 1 dB headroom would not do, and the
    // audio that reaches this stage is always the post-NR audio.
    expect(worstAfterNr).toBeGreaterThan(worstRaw);

    // Absolute windows, so this fails if either population moves — writing the
    // bounds in terms of GATE_HEADROOM_DB would move with the constant and so
    // could never fail. Measured: 0.946 dB raw, 2.369 dB after NR.
    expect(worstRaw).toBeLessThan(1.5);
    expect(worstAfterNr).toBeGreaterThan(1.8);
    expect(worstAfterNr).toBeLessThan(2.9);

    // And the constant covers the worst of them. Drop it to 2 and this fails.
    expect(worstAfterNr).toBeLessThan(GATE_HEADROOM_DB);
    expect(GATE_HEADROOM_DB).toBe(3);
  }, 60000);
});

describe('GATE_VOICED_FRACTION', () => {
  /** The voiced share of a 500 ms window — the statistic the gate declines on.
   * Measured at the window's OWN rate, because that is the only rate the gate
   * ever sees it at: `detectPitch` sizes its frame from `sampleRate / F0_MIN`,
   * so the same 500 ms carries the same 46 frames whatever the rate, and any
   * difference between rates is the detector's, not the window's. */
  function voicedFraction(window: Float32Array, sr: number): number {
    const track = detectPitch(window, sr);
    if (track.frames.length === 0) return 0;
    let voiced = 0;
    for (const f of track.frames) if (f.f0Hz !== null) voiced++;
    return voiced / track.frames.length;
  }

  const windowAt = (sr: number): number => Math.round((NOISE_WINDOW_MS / 1000) * sr);

  /** Soft singing: a fundamental with two harmonics and vibrato, over its own
   * faint floor. Phase is integrated so the vibrato stays a vibrato. */
  function sung(rmsDb: number, f0: number, breathMs: number, sr: number): Float32Array {
    const n = windowAt(sr);
    const amp = Math.pow(10, rmsDb / 20);
    const out = noise(n, amp * 0.02, 5);
    let phase = 0;
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      phase += (2 * Math.PI * f0 * (1 + 0.006 * Math.sin(2 * Math.PI * 5.5 * t))) / sr;
      out[i] += amp * 1.2 * (Math.sin(phase) + 0.4 * Math.sin(2 * phase) + 0.2 * Math.sin(3 * phase));
    }
    if (breathMs > 0) {
      const bn = Math.round((breathMs / 1000) * sr);
      const at = Math.round((n - bn) / 2);
      const quiet = noise(bn, Math.pow(10, (rmsDb - 25) / 20), 77);
      out.set(quiet, at);
    }
    return out;
  }

  /** The residual a real Noise Reduction pass leaves in a pause — the floor
   * that ACTUALLY reaches this stage in the chain, since NR runs before the
   * gate. Its spectrum is a subtraction remnant, not the room's own, which is
   * why it is a member of the population rather than a footnote to it. */
  function postNrPauseWindow(sr: number): Float32Array {
    const pause = Math.round(1.0 * sr);
    const phrase = Math.round(0.8 * sr);
    const channel = gaussFloorDb(3 * pause + 2 * phrase, -50, 7);
    let at = 0;
    for (const [sungPart, n] of [
      [false, pause],
      [true, phrase],
      [false, pause],
      [true, phrase],
      [false, pause],
    ] as const) {
      if (sungPart) {
        let phase = 0;
        for (let i = 0; i < n; i++) {
          const t = i / sr;
          phase += (2 * Math.PI * 220) / sr;
          const c = Math.min(1, t / 0.04) * Math.min(1, (n / sr - t) / 0.06);
          channel[at + i] += 0.25 * c * Math.sin(phase);
        }
      }
      at += n;
    }
    const nr = deriveNoiseReduction([channel], sr);
    if (!nr.run) throw new Error('expected Noise Reduction to run on this fixture');
    (globalThis as { __effectExtra?: unknown }).__effectExtra = nr.extra;
    const out = noiseReductionEffect.process([Float32Array.from(channel)], sr, nr.params).channels[0];
    delete (globalThis as { __effectExtra?: unknown }).__effectExtra;
    // The middle of the second pause: 300 ms clear of the phrase either side.
    const from = pause + phrase + Math.round(0.3 * sr);
    return Float32Array.from(out.subarray(from, from + windowAt(sr)));
  }

  it('separates every noise floor from every soft sung window, with the constant between them', () => {
    // Every rate this app records and imports at, because the detector's frame
    // is sized in samples and the classifier is the thing under test — a
    // population taken at one rate says nothing about the others.
    const RATES = [8000, 22050, 44100, 48000];

    // Floors: uniform and Gaussian, across the range room tone actually
    // occupies, three seeds. Voice is periodic; room tone is not.
    const floors: number[] = [];
    for (const sr of RATES) {
      const n = windowAt(sr);
      for (const rmsDb of [-30, -45, -60, -75]) {
        for (const seed of [7, 23, 101]) {
          floors.push(voicedFraction(noise(n, Math.pow(10, rmsDb / 20) * Math.sqrt(3), seed), sr));
          floors.push(voicedFraction(gaussFloorDb(n, rmsDb, seed), sr));
        }
      }
    }

    // ...and the one member the constant's own note claims and the population
    // used to omit: what Noise Reduction actually hands this stage.
    const residuals = RATES.map((sr) => voicedFraction(postNrPauseWindow(sr), sr));

    // Voices: three fundamentals across the sung range, four levels down to
    // -50 dBFS, and — the hard case — windows carrying a breath of up to
    // 350 ms of the 500, which is what drags a real sung window's fraction
    // down toward the floors.
    const voices: number[] = [];
    for (const sr of RATES) {
      for (const rmsDb of [-20, -30, -40, -50]) {
        for (const f0 of [98, 196, 392]) {
          for (const breathMs of [0, 150, 250, 350]) voices.push(voicedFraction(sung(rmsDb, f0, breathMs, sr), sr));
        }
      }
    }

    expect(floors).toHaveLength(96);
    expect(residuals).toHaveLength(4);
    expect(voices).toHaveLength(192);

    // Absolute bounds on both populations, so a drift in either fails here
    // rather than silently widening or closing the gap.
    const worstFloor = Math.max(...floors, ...residuals);
    const worstVoice = Math.min(...voices);
    expect(worstFloor).toBeLessThan(0.02);
    expect(worstVoice).toBeGreaterThan(0.12);

    // The constant sits between them, with room on both sides: above the
    // floors by more than two frames' worth, and more than three times below
    // the hardest sung window.
    expect(GATE_VOICED_FRACTION).toBeGreaterThan(worstFloor);
    expect(GATE_VOICED_FRACTION).toBeLessThan(worstVoice / 3);
    expect(GATE_VOICED_FRACTION).toBe(0.05);
  }, 600000);
});

describe('GATE_SHAPED_RESIDUAL_DB', () => {
  function res2(x: Float32Array, sr: number, hz: number, q: number): Float32Array {
    const w = (2 * Math.PI * hz) / sr;
    const r = Math.exp(-w / (2 * q));
    const a1 = 2 * r * Math.cos(w);
    const a2 = -r * r;
    const out = new Float32Array(x.length);
    let y1 = 0;
    let y2 = 0;
    for (let i = 0; i < x.length; i++) {
      const y = x[i] + a1 * y1 + a2 * y2;
      out[i] = y;
      y2 = y1;
      y1 = y;
    }
    return out;
  }

  function at(x: Float32Array, rmsDb: number): Float32Array {
    let s = 0;
    for (let i = 0; i < x.length; i++) s += x[i] * x[i];
    const g = Math.pow(10, rmsDb / 20) / Math.sqrt(s / Math.max(1, x.length));
    const out = new Float32Array(x.length);
    for (let i = 0; i < x.length; i++) out[i] = x[i] * g;
    return out;
  }

  /** Room tone rolled off by a one-pole at `cutHz` — rumble, HVAC, a preamp's
   * hiss. The tilted members are the point: they are what defeats spectral
   * flatness and centroid, and what the straight-line fit absorbs. */
  function floorTilted(n: number, sr: number, rmsDb: number, seed: number, cutHz: number): Float32Array {
    const src = noise(n, 1, seed);
    const a = Math.exp((-2 * Math.PI * cutHz) / sr);
    const out = new Float32Array(n);
    let y = 0;
    for (let i = 0; i < n; i++) {
      y = a * y + (1 - a) * src[i];
      out[i] = y;
    }
    return at(out, rmsDb);
  }

  function whisperWin(n: number, sr: number, rmsDb: number, seed: number, modulated: boolean): Float32Array {
    let x = noise(n, 1, seed);
    for (const [hz, q] of [
      [500, 8],
      [1500, 10],
      [2500, 12],
    ] as const) {
      if (hz < (sr / 2) * 0.9) x = res2(x, sr, hz, q);
    }
    if (modulated) for (let i = 0; i < n; i++) x[i] *= 0.55 + 0.45 * Math.sin((2 * Math.PI * 4 * i) / sr);
    return at(x, rmsDb);
  }

  it('separates a vocal tract from a room, where flatness and centroid cannot', () => {
    const floors: number[] = [];
    const vocals: number[] = [];
    for (const sr of [8000, 22050, 44100, 48000]) {
      const n = Math.round((NOISE_WINDOW_MS / 1000) * sr);
      for (const seed of [7, 23, 101]) {
        floors.push(spectralTiltResidualDb(at(noise(n, 1, seed), -40), sr));
        for (const cut of [400, 800, 2500]) {
          floors.push(spectralTiltResidualDb(floorTilted(n, sr, -40, seed, cut), sr));
        }
      }
      for (const seed of [7, 23]) {
        vocals.push(spectralTiltResidualDb(whisperWin(n, sr, -40, seed, true), sr));
        vocals.push(spectralTiltResidualDb(whisperWin(n, sr, -40, seed, false), sr));
        // Sibilants as a SINGLE broad resonance — the least-shaped member of
        // the family, and the one that sets the lower bound. Only those below
        // Nyquist at this rate, which is why 8 kHz keeps just the low ones.
        for (const [hz, q] of [
          [2800, 3],
          [3000, 3],
          [4000, 4],
          [6000, 5],
        ] as const) {
          if (hz < (sr / 2) * 0.9) vocals.push(spectralTiltResidualDb(at(res2(noise(n, 1, seed), sr, hz, q), -40), sr));
        }
      }
    }
    expect(floors).toHaveLength(48);
    expect(vocals.length).toBeGreaterThanOrEqual(20);

    // Absolute windows on both populations, so a drift in either fails here
    // rather than quietly closing the gap. Measured across the four rates:
    // floors 0.63-1.91 dB, unvoiced vocal 3.20-10.58 dB.
    const worstFloor = Math.max(...floors);
    const worstVocal = Math.min(...vocals);
    expect(worstFloor).toBeLessThan(2.2);
    expect(worstVocal).toBeGreaterThan(3.0);

    // The constant sits inside the measured gap, with margin on both sides.
    expect(GATE_SHAPED_RESIDUAL_DB).toBeGreaterThan(worstFloor * 1.25);
    expect(GATE_SHAPED_RESIDUAL_DB).toBeLessThan(worstVocal * 0.8);
    expect(GATE_SHAPED_RESIDUAL_DB).toBe(2.5);
  }, 60000);

  it('the one unvoiced passage this cannot catch, measured rather than forgotten', () => {
    // Broadband hiss with no vocal-tract shaping, at a constant level — a
    // first-order high-passed noise. A person can make this sound, but nothing
    // about the SIGNAL is vocal: it lands inside the floor population here, and
    // it lands inside it on the four other statistics that were tried. This
    // test exists so that limitation stays measured; if some future signal
    // separates it, this is what will fail and say so.
    for (const sr of [8000, 44100]) {
      const n = Math.round((NOISE_WINDOW_MS / 1000) * sr);
      const src = noise(n, 1, 41);
      const a = Math.exp((-2 * Math.PI * Math.min(1200, sr * 0.3)) / sr);
      const hp = new Float32Array(n);
      let y = 0;
      for (let i = 0; i < n; i++) {
        y = a * y + (1 - a) * src[i];
        hp[i] = src[i] - y;
      }
      const shaped = spectralTiltResidualDb(at(hp, -36), sr);
      expect(shaped).toBeLessThan(GATE_SHAPED_RESIDUAL_DB);
    }
  }, 60000);
});

/**
 * V2 — the two populations behind the bound on how far the search may climb.
 *
 * The search walks the take's quietest passages until one reads as a pause, and
 * the threshold it then derives sits ABOVE every quieter passage it stepped
 * over. Whether that is a fix or a fresh act of destruction is a question of
 * how far it climbed, measured in the very statistic the threshold is built
 * from — the envelope peak the silence detector reads inside a window. So the
 * quantity is `accepted.envelopePeakDb - quietest.envelopePeakDb`: how much
 * higher the gate closes than it would have closed on the quietest passage.
 */
describe('GATE_SEARCH_CLIMB_DB', () => {
  function res2At(x: Float32Array, sr: number, hz: number, q: number): Float32Array {
    const w = (2 * Math.PI * hz) / sr;
    const r = Math.exp(-w / (2 * q));
    const a1 = 2 * r * Math.cos(w);
    const a2 = -r * r;
    const out = new Float32Array(x.length);
    let y1 = 0;
    let y2 = 0;
    for (let i = 0; i < x.length; i++) {
      const y = x[i] + a1 * y1 + a2 * y2;
      out[i] = y;
      y2 = y1;
      y1 = y;
    }
    return out;
  }

  function whisperAt(n: number, rmsDb: number, seed: number, sr: number): Float32Array {
    let x = noise(n, 1, seed);
    for (const [hz, q] of [
      [500, 8],
      [1500, 10],
      [2500, 12],
    ] as const) {
      if (hz < (sr / 2) * 0.9) x = res2At(x, sr, hz, q);
    }
    for (let i = 0; i < n; i++) x[i] *= 0.55 + 0.45 * Math.sin((2 * Math.PI * 4 * i) / sr);
    let s = 0;
    for (let i = 0; i < n; i++) s += x[i] * x[i];
    const g = Math.pow(10, rmsDb / 20) / Math.sqrt(s / Math.max(1, n));
    for (let i = 0; i < n; i++) x[i] *= g;
    return x;
  }

  function sing(into: Float32Array, from: number, n: number, sr: number, amp: number): void {
    let phase = 0;
    for (let i = 0; i < n && from + i < into.length; i++) {
      phase += (2 * Math.PI * 196) / sr;
      into[from + i] += amp * (Math.sin(phase) + 0.4 * Math.sin(2 * phase));
    }
  }

  /** The reported shape: a quiet half whose every gap is an audible breath, and
   * a louder half carrying the take's one real pause. */
  function breathTake(sr: number, gaps: number, seed: number): { channel: Float32Array; pause: { start: number; end: number } } {
    const phrase = Math.round(1.2 * sr);
    const gap = Math.round(0.55 * sr);
    const quietLen = gaps * (phrase + gap) + phrase;
    const pauseLen = Math.round(2.0 * sr);
    const loudLen = phrase + pauseLen + phrase;
    const channel = new Float32Array(quietLen + loudLen);
    channel.set(gaussFloorDb(quietLen, -66, seed), 0);
    let at = 0;
    for (let g = 0; g < gaps; g++) {
      sing(channel, at, phrase, sr, 0.15);
      at += phrase;
      const br = whisperAt(gap, -60, seed * 31 + g, sr);
      for (let i = 0; i < gap && at + i < quietLen; i++) channel[at + i] += br[i];
      at += gap;
    }
    sing(channel, at, phrase, sr, 0.15);
    channel.set(gaussFloorDb(loudLen, -55, seed + 77), quietLen);
    sing(channel, quietLen, phrase, sr, 0.2);
    const pause = { start: quietLen + phrase, end: quietLen + phrase + pauseLen };
    sing(channel, pause.end, phrase, sr, 0.2);
    return { channel, pause };
  }

  /** The destructive converse: a quiet vocal PASSAGE that lives below an
   * ordinary floor, so a threshold taken from the floor mutes it whole. */
  function whisperUnderFloorTake(sr: number, seed: number): { channel: Float32Array; floor: { start: number; end: number } } {
    const floorLen = Math.round(2 * sr);
    const softLen = Math.round(3.5 * sr);
    const chorusLen = Math.round(3.5 * sr);
    const channel = new Float32Array(floorLen + softLen + chorusLen);
    channel.set(gaussFloorDb(floorLen, -40, seed), 0);
    channel.set(whisperAt(softLen, -50, seed + 3, sr), floorLen);
    sing(channel, floorLen + softLen, chorusLen, sr, 0.25);
    return { channel, floor: { start: 0, end: floorLen } };
  }

  /** The same converse in the shape N6 records: a quiet island bracketed by
   * digital silence, beside a take whose own pauses set the threshold. */
  function islandUnderFloorTake(sr: number, islandMs: number, seed: number): { channel: Float32Array; floor: { start: number; end: number } } {
    const pause = Math.round(1.0 * sr);
    const phrase = Math.round(0.8 * sr);
    const headLen = 3 * pause + 2 * phrase;
    const zeros = Math.round(0.3 * sr);
    const islandLen = Math.round((islandMs / 1000) * sr);
    const burst = Math.round(0.5 * sr);
    const channel = new Float32Array(headLen + zeros + islandLen + burst + zeros);
    channel.set(gaussFloorDb(headLen, -50, seed), 0);
    sing(channel, pause, phrase, sr, 0.25);
    sing(channel, 2 * pause + phrase, phrase, sr, 0.25);
    channel.set(whisperAt(islandLen, -60, seed + 5, sr), headLen + zeros);
    sing(channel, headLen + zeros + islandLen, burst, sr, 0.25);
    return { channel, floor: { start: 0, end: headLen } };
  }

  /** I1's shape at an arbitrary rate: an ordinary floor a decibel above a
   * quiet passage whose channels cancel. It belongs in THIS population because
   * of where it lands in it — see the test that consumes it. */
  function cancellingUnderFloorTake(sr: number, seed: number): Float32Array[] {
    const phrase = Math.round(1.2 * sr);
    const gap = Math.round(0.9 * sr);
    const L = new Float32Array(3 * phrase + 2 * gap);
    const R = new Float32Array(L.length);
    const both = (from: number, n: number): void => {
      const before = Float32Array.from(L.subarray(from, from + n));
      sing(L, from, n, sr, 0.2);
      for (let i = 0; i < n; i++) R[from + i] += L[from + i] - before[i];
    };
    let at = 0;
    both(at, phrase);
    at += phrase;
    const w = whisperAt(gap, -56, seed + 61, sr);
    for (let i = 0; i < gap; i++) {
      L[at + i] = w[i];
      R[at + i] = -w[i];
    }
    at += gap;
    both(at, phrase);
    at += phrase;
    const fa = gaussFloorDb(gap, -55, seed + 71);
    const fb = gaussFloorDb(gap, -55, seed + 72);
    for (let i = 0; i < gap; i++) {
      L[at + i] = fa[i];
      R[at + i] = fb[i];
    }
    at += gap;
    both(at, phrase);
    return [L, R];
  }

  /** The climb from the quietest candidate to the quietest candidate lying
   * wholly inside `span` — the passage that IS the take's honest floor. */
  function climb(channel: Float32Array, sr: number): number | null {
    const cands = measureNoiseWindows([channel], sr, {
      rejectMostlySilentWindows: true,
      maxCandidates: GATE_QUIET_WINDOWS,
    });
    const reads = (w: { startSample: number; lengthSamples: number }): boolean => {
      const mono = Float32Array.from(channel.subarray(w.startSample, w.startSample + w.lengthSamples));
      if (spectralTiltResidualDb(mono, sr) > GATE_SHAPED_RESIDUAL_DB) return false;
      const track = detectPitch(mono, sr);
      const voiced =
        track.frames.length === 0 ? 0 : track.frames.filter((f) => f.f0Hz !== null).length / track.frames.length;
      return voiced <= GATE_VOICED_FRACTION;
    };
    if (cands.length === 0 || reads(cands[0])) return null;
    for (let i = 1; i < cands.length; i++) {
      if (reads(cands[i])) return cands[i].envelopePeakDb - cands[0].envelopePeakDb;
    }
    return null;
  }

  it('separates the take that must gate from the take that must not', () => {
    const breaths: number[] = [];
    const passages: number[] = [];
    for (const sr of [8000, 22050, 44100, 48000]) {
      for (const seed of [5, 17, 29]) {
        for (const gaps of [1, 2, 4]) {
          const c = climb(breathTake(sr, gaps, seed).channel, sr);
          if (c !== null) breaths.push(c);
        }
        const w = climb(whisperUnderFloorTake(sr, seed).channel, sr);
        if (w !== null) passages.push(w);
        for (const islandMs of [400, 500, 800]) {
          const i = climb(islandUnderFloorTake(sr, islandMs, seed).channel, sr);
          if (i !== null) passages.push(i);
        }
      }
    }
    // Both populations are non-empty: every member really is a take whose
    // quietest window is vocal and whose search therefore climbs.
    expect(breaths).toHaveLength(36);
    expect(passages).toHaveLength(45);

    const worstBreath = Math.max(...breaths);
    const closestPassage = Math.min(...passages);
    // A breath peaks with the room it sits on, so the pause that vouches for
    // the take reaches very nearly the same level — some members NEGATIVE.
    expect(Math.min(...breaths)).toBeLessThan(0);
    expect(worstBreath).toBeLessThan(2.0);
    // A quiet vocal passage under an ordinary floor is a level regime of its
    // own, and the take's own pauses sit well clear of it.
    expect(closestPassage).toBeGreaterThan(3.1);
    expect(Math.max(...passages)).toBeGreaterThan(6.5);

    // The constant sits inside the measured gap with the same margin on both
    // sides — the profile `GATE_SHAPED_RESIDUAL_DB` carries.
    expect(GATE_SEARCH_CLIMB_DB / worstBreath).toBeGreaterThan(1.25);
    expect(closestPassage / GATE_SEARCH_CLIMB_DB).toBeGreaterThan(1.25);
    expect(GATE_SEARCH_CLIMB_DB).toBe(2.5);
    // ...and it is under the headroom the stage already adds: the search may
    // not move the threshold by as much as the derivation itself does.
    expect(GATE_SEARCH_CLIMB_DB).toBeLessThan(GATE_HEADROOM_DB);
  }, 600000);

  /**
   * I1 — the population's own boundary, stated: a CANCELLING quiet passage
   * lands in the PERMISSIVE half of this constant, so the climb bound is not
   * what protects it and never could be. That is why the cancellation verdict
   * is a hard decline rather than a refusal the search may step past, and this
   * test is here so the gap cannot silently reopen: if someone widens the
   * populations above without reading them, this member still says the level
   * is the wrong instrument for this shape.
   */
  it('a cancelling passage lands INSIDE the permissive band, which is why level cannot decide it', () => {
    const climbs: number[] = [];
    for (const sr of [8000, 22050, 44100, 48000]) {
      for (const seed of [5, 17, 29]) {
        const channels = cancellingUnderFloorTake(sr, seed);
        const cands = measureNoiseWindows(channels, sr, {
          rejectMostlySilentWindows: true,
          maxCandidates: GATE_QUIET_WINDOWS,
        });
        // The cancelling window is the quietest, and the next candidate up is
        // an ordinary floor: exactly the step the search would have taken.
        const mono = new Float32Array(cands[0].lengthSamples);
        for (let i = 0; i < mono.length; i++) {
          mono[i] = (channels[0][cands[0].startSample + i] + channels[1][cands[0].startSample + i]) / 2;
        }
        let sq = 0;
        for (let i = 0; i < mono.length; i++) sq += mono[i] * mono[i];
        expect(cands[0].rmsDb - toDb(Math.sqrt(sq / mono.length))).toBeGreaterThan(GATE_CANCELLATION_DEPTH_DB);
        climbs.push(cands[1].envelopePeakDb - cands[0].envelopePeakDb);
      }
    }
    expect(climbs).toHaveLength(12);
    // INSIDE the band the search is allowed to cross — the same half the
    // breath population occupies, not the destructive one.
    expect(Math.max(...climbs)).toBeLessThanOrEqual(GATE_SEARCH_CLIMB_DB);

    // ...and the stage refuses anyway, on the diagnosis rather than the level.
    for (const sr of [8000, 44100]) {
      const res = deriveGate(cancellingUnderFloorTake(sr, 5), sr);
      expect(res.run).toBe(false);
      if (res.run) return;
      expect(res.reason).toContain('cancel');
    }
  }, 600000);
});

describe('NOISE_WINDOW_MAX_SILENT_FRACTION', () => {
  // The bound `measureNoiseWindow` applies when `deriveGate` asks it to refuse
  // mostly-silent candidate windows. Its BEHAVIOUR on both sides and on the
  // equality is pinned in the `deriveGate` suite (`the mostly-silent bound of
  // the measurement behind the gate`, plus the whisper-launder and the three
  // digital-silence tests); what lives here is the two measured populations
  // its placement comes from.

  /** A floor window with its leading `f` replaced by exact zeros — the
   * boundary shape a take with a stretch of digital silence produces. */
  function withZeroHead(n: number, f: number, seed: number): Float32Array {
    const w = gaussFloorDb(n, -50, seed);
    const z = Math.round(f * n);
    for (let i = 0; i < z; i++) w[i] = 0;
    return w;
  }

  it('every window it can still return measures like a floor to the checks downstream', () => {
    const fractions = [0, 0.1, 0.2, 0.25, 0.3, 0.4, 0.5, 0.6, 0.9];
    const worstAt = new Map<number, number>();
    for (const sr of [8000, 22050, 44100, 48000]) {
      const n = Math.round((NOISE_WINDOW_MS / 1000) * sr);
      for (const f of fractions) {
        for (const seed of [7, 23, 101]) {
          const v = spectralTiltResidualDb(withZeroHead(n, f, seed), sr);
          worstAt.set(f, Math.max(worstAt.get(f) ?? -Infinity, v));
        }
      }
    }

    // Measured worst per fraction over this sweep (4 rates x 3 seeds):
    // 1.709 / 1.747 / 1.801 / 1.777 / 1.935 / 1.968 / 2.234 / 2.598 / 4.244 dB.
    // The climb is NOT monotone — it dips at 0.2 -> 0.25 — which is why no
    // assertion here claims it is; the placement rests on the absolute levels.
    //
    // At the bound itself, a zero-headed floor window still reads INSIDE the
    // 0.63…1.91 dB floor population `GATE_SHAPED_RESIDUAL_DB` is derived from:
    // the largest swept fraction with that property, so nothing the search can
    // hand the content checks is outside what their constant was measured on.
    const atBound = worstAt.get(NOISE_WINDOW_MAX_SILENT_FRACTION);
    expect(atBound).toBeDefined();
    expect(atBound!).toBeLessThan(1.911);
    // One step further and the window has already left that population...
    expect(worstAt.get(0.3)!).toBeGreaterThan(1.911);
    // ...and past half zeros the fit reads a plain floor as a VOCAL TRACT —
    // the measured false decline (N2: 10 of 10 sub-chunk offsets refused at
    // 8 kHz) that rejecting these windows exists to prevent.
    expect(worstAt.get(0.6)!).toBeGreaterThan(GATE_SHAPED_RESIDUAL_DB);
    expect(worstAt.get(0.9)!).toBeGreaterThan(GATE_SHAPED_RESIDUAL_DB);
  }, 120000);

  it('sits above the scattered exact zeros an undithered 16-bit floor really carries', () => {
    // The lower side's population: quantising a Gaussian floor to 16 bits
    // turns its smallest samples into EXACT zeros, scattered through every
    // window. Per 500 ms window, measured here at 8 and 44.1 kHz, three seeds:
    // 1.0-1.3 % at -60 dBFS, 4.3-5.0 % at -72, 9.1-9.7 % at -78, 17.7-19.3 %
    // at -84 and 21.6-22.7 % at -85.5 dBFS (worst member 22.73 %, at 8 kHz).
    // Those windows are ordinary quiet recordings and must stay
    // in the search — the bound cannot drop to 0.2 without evicting a real
    // floor, and the -85.5 dBFS member proves the corridor is that narrow.
    let worst = 0;
    for (const sr of [8000, 44100]) {
      const n = Math.round((NOISE_WINDOW_MS / 1000) * sr);
      for (const floorDb of [-60, -72, -78, -84, -85.5]) {
        for (const seed of [7, 23, 101]) {
          const w = gaussFloorDb(n, floorDb, seed);
          let zeros = 0;
          for (let i = 0; i < n; i++) {
            if (Math.round(w[i] * 32768) / 32768 === 0) zeros++;
          }
          worst = Math.max(worst, zeros / n);
        }
      }
    }
    expect(worst).toBeGreaterThan(0.2);
    expect(worst).toBeLessThan(NOISE_WINDOW_MAX_SILENT_FRACTION);

    // ...and the very next step down crosses it: a -87 dBFS floor reads
    // 25.2-26.4 % on the same population — every member above the bound — so
    // that is where the class starts declining fail-safe. This is the figure
    // the constant's docblock quotes; pinned here so it cannot drift (M8).
    let crossedMin = 1;
    for (const sr of [8000, 44100]) {
      const n = Math.round((NOISE_WINDOW_MS / 1000) * sr);
      for (const seed of [7, 23, 101]) {
        const w = gaussFloorDb(n, -87, seed);
        let zeros = 0;
        for (let i = 0; i < n; i++) {
          if (Math.round(w[i] * 32768) / 32768 === 0) zeros++;
        }
        crossedMin = Math.min(crossedMin, zeros / n);
      }
    }
    expect(crossedMin).toBeGreaterThan(NOISE_WINDOW_MAX_SILENT_FRACTION);
  });

  it('pins the constant the two populations bracket', () => {
    expect(NOISE_WINDOW_MAX_SILENT_FRACTION).toBe(0.25);
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

  // CC1 / N2 — the ordering constraint the gate imposes, and the invariant that
  // makes it free. The gate now runs BEFORE this stage so the makeup gain
  // multiplies zeros rather than lifting a floor; the apparent price is that
  // "sounding" is defined against a noise floor the gate has just silenced, and
  // `measureNoiseWindow` rejects digital-silence windows by construction
  // (chainAnalysis.ts:148). It is not a price, because GATE_HOLD_MS IS
  // NOISE_WINDOW_MS: the gate holds its gain at 1 for exactly one noise window
  // after the level drops, so every pause it closes on keeps an untouched one
  // in front of the fade.
  //
  // This is the test that stops those two constants drifting apart. Shorten the
  // hold below the noise window and the pauses stop carrying a measurable
  // floor; this is where that shows up.
  describe('what survives the gate, and what does not', () => {
    /** Phrases over a real floor with pauses long enough that the gate reaches
     * hard zero inside them. `padSamples` slides the whole take against
     * `measureNoiseWindow`'s 50 ms chunk grid, so the gate's fade lands at
     * every phase relative to the windows the search can choose from — the
     * variable this describe exists to sweep. */
    function gappedProgramme(floorDb: number, padSamples: number): Float32Array {
      const out = noise(WIN * 20 + padSamples, Math.pow(10, floorDb / 20) * Math.sqrt(3), 5);
      for (const w of [4, 5, 10, 11, 16, 17]) {
        let phase = 0;
        for (let i = 0; i < WIN; i++) {
          phase += (2 * Math.PI * 220) / SR;
          out[padSamples + w * WIN + i] += 0.2 * Math.sin(phase);
        }
      }
      return out;
    }

    it('the FLOOR READING does not: on a gated take the quietest window is a fade tail, tens of dB low', () => {
      // The mechanism, stated honestly because a previous version of this test
      // asserted the opposite and passed on one lucky fixture. `measureNoiseWindow`
      // does NOT return the untouched hold window — it returns the QUIETEST
      // window it accepts, and after gating that is one straddling the fade,
      // kept out of the reject bin only by sitting above SILENCE_RMS
      // (2^-15, chainAnalysis.ts). Which window wins depends on where the fade
      // falls against the 50 ms chunk grid, so it moves with the floor level
      // and with the take's alignment.
      let worstUnderRead = 0;
      for (const floorDb of [-30, -40, -50]) {
        for (const padSamples of [0, 137, 331]) {
          const raw = gappedProgramme(floorDb, padSamples);
          const gate = deriveGate([raw], SR);
          if (!gate.run) throw new Error('expected the gate to run');
          const gated = noiseGateEffect.process([Float32Array.from(raw)], SR, gate.params).channels;
          const before = measureNoiseWindow([raw], SR)!;
          const after = measureNoiseWindow(gated, SR);
          // It is always still MEASURABLE — that much of the old claim holds,
          // and it is what stops `deriveCompressor` declining.
          expect(after).not.toBeNull();
          worstUnderRead = Math.max(worstUnderRead, before.envelopePeakDb - after!.envelopePeakDb);
        }
      }
      // Measured across this sweep and the wider one: the under-read reaches
      // tens of dB. Asserted so that restating the old "reads the same level"
      // claim fails here instead of shipping.
      expect(worstUnderRead).toBeGreaterThan(3);
    }, 60000);

    it('the COMPRESSOR THRESHOLD does, across floor levels and fade phases', () => {
      // The invariant that actually matters, and the one the ordering
      // constraint (N2) needed: whatever the floor reading does, the boundary
      // the compressor derives from it barely moves, because the samples the
      // under-read newly admits are few beside the sounding material and the
      // gated gaps are exactly zero — never above any positive threshold.
      let worstDelta = 0;
      let sawRealGating = false;
      for (const floorDb of [-30, -40, -50]) {
        for (const padSamples of [0, 137, 331]) {
          const raw = gappedProgramme(floorDb, padSamples);
          const gate = deriveGate([raw], SR);
          if (!gate.run) throw new Error('expected the gate to run');
          const gated = noiseGateEffect.process([Float32Array.from(raw)], SR, gate.params).channels;

          const zeros = gated[0].reduce((n: number, v: number) => (v === 0 ? n + 1 : n), 0);
          if (zeros / gated[0].length > 0.3) sawRealGating = true;

          const onRaw = deriveCompressor([raw], SR);
          const onGated = deriveCompressor(gated, SR);
          if (!onRaw.run || !onGated.run) throw new Error('expected both to run');
          worstDelta = Math.max(
            worstDelta,
            Math.abs(Number(onGated.params.thresholdDb) - Number(onRaw.params.thresholdDb))
          );
        }
      }
      // Without this the sweep could pass on audio the gate never touched.
      expect(sawRealGating).toBe(true);
      // Measured worst on THIS sweep — the one running here, three floor
      // levels x three fade phases: 0.0917 dB, at floor -30 dB / pad 137. (The
      // wider out-of-tree sweep at two rates and six phases read 0.052 dB; the
      // number quoted beside a test has to be the one that test measures.) An
      // absolute bound, not one phrased in terms of anything that moves with it.
      expect(worstDelta).toBeLessThan(0.5);
    }, 60000);
  });

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

  // V2/R2 — the escape has to reach the audio, not merely exist in the
  // derivation. One option on the run, one stage, one number.
  it('carries a gate threshold the user set through to the stage that runs', async () => {
    // Steady room tone with no voice and no pause: the stage declines, and no
    // search can change that — there is nothing in the take BUT the floor.
    const roomTone = noise(SR * 3, 0.01, 9);
    seedDoc([Float32Array.from(roomTone)]);
    const declined = await runVocalChain({ enabled: only('gate') });
    const before = declined!.stages.find((s) => s.id === 'gate')!;
    expect(before.status).toBe('declined');
    expect(before.reason).toContain("set this stage's threshold yourself");

    useAppStore.setState(makeInitialState());
    seedDoc([Float32Array.from(roomTone)]);
    const manual = await runVocalChain({ enabled: only('gate'), gateThresholdDb: -30 });
    const after = manual!.stages.find((s) => s.id === 'gate')!;
    expect(after.status).toBe('applied');
    expect(after.derived[0].label).toContain('manual');
    expect(after.derived[0].value).toBe('-30.0 dBFS');
    // ...and the audio really was gated at it: the take is a −44 dBFS floor,
    // so a −30 dBFS gate takes all of it to digital silence.
    expect(activeDoc().channels[0].some((v) => v !== 0)).toBe(false);
  }, 60000);

  it('leaves the derivation alone when the user set no threshold', async () => {
    // The converse: the option is absent on every ordinary run, and its
    // absence must not change a single number the stage derives.
    const take = flat(WIN * 8, 0.5);
    take.set(noise(WIN, 0.006, 101), 4 * WIN);
    seedDoc([Float32Array.from(take)]);
    const report = await runVocalChain({ enabled: only('gate') });
    const gate = report!.stages.find((s) => s.id === 'gate')!;
    expect(gate.status).toBe('applied');
    expect(gate.derived[0].label).toBe('Threshold');
    const direct = deriveGate([take], SR);
    if (!direct.run) throw new Error('expected run');
    expect(gate.derived[0].value).toBe(`${Number(direct.params.thresholdDb).toFixed(1)} dBFS`);
  }, 60000);

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

  // ── The live view (P1) ────────────────────────────────────────────────────
  // `onProgress` is ONE number over the whole pass. It cannot say which stage is
  // running, how far through THAT stage the run is, or what the stage is doing —
  // and a stepper that highlights the current stage needs all three. These pin
  // the additive contract; nothing about the chain's behaviour changes with the
  // callbacks absent, which is what every other test in this file runs without.
  //
  // THE FIXTURE IS PART OF THE PIN. On uniform noise the quietest 500 ms is as
  // loud as the rest, so `deriveCompressor` finds nothing above its own floor
  // and DECLINES — a stage that declines never reaches the rendering phase at
  // all, and a first draft of these tests was measuring an empty one without
  // saying so. Eight loud windows with one genuinely quiet one give the gate a
  // floor to measure and a programme to sit above, and `runsEverything` below
  // fails if that ever stops being true.
  const stepperFixture = (): Float32Array => withQuietWindow(8, 0.3, 0.003, 3);
  const STEPPER_IDS = ['dc', 'compressor', 'limiter'] as const;

  it('runs every stage the live-view tests assume runs — the fixture, guarded', async () => {
    seedDoc([stepperFixture()]);
    const report = await runVocalChain({ enabled: only(...STEPPER_IDS) });
    for (const id of STEPPER_IDS) {
      expect(report!.stages.find((s) => s.id === id)!.status).toBe('applied');
    }
  });

  it('reports stage-scoped progress against the stage that is actually running, in chain order', async () => {
    seedDoc([stepperFixture()]);
    const seen: VocalChainStageProgress[] = [];
    await runVocalChain({
      enabled: only(...STEPPER_IDS),
      onStageProgress: (p) => seen.push(p),
    });
    // GROUPED, not merely present. A `new Set(...)` comparison is satisfied by
    // an implementation that interleaves every stage's events, which would tell
    // a stepper nothing about which row to highlight — so the run-length
    // encoding is what is asserted, and a stage may appear in it only once.
    const runs: VocalChainStageId[] = [];
    for (const e of seen) if (runs[runs.length - 1] !== e.stageId) runs.push(e.stageId);
    expect(runs).toEqual(['dc', 'compressor', 'limiter']);
    // Each event names the stage's own label, so the UI never has to look it up.
    for (const e of seen) expect(e.label).toBe(stageById(e.stageId).label);
  });

  it('scopes every fraction to the ONE stage it describes, inside [0, 1]', async () => {
    seedDoc([stepperFixture()]);
    // The two callbacks are captured TOGETHER, in arrival order, because the
    // claim under test is a relation between them: `stageFraction` must not be
    // the overall fraction under a new name. Asserting the range alone does not
    // reach that — the overall fraction is in [0, 1] too, and an implementation
    // that simply forwarded it passed a range-only version of this test.
    const seen: (VocalChainStageProgress & { overall: number })[] = [];
    let overall = 0;
    await runVocalChain({
      enabled: only(...STEPPER_IDS),
      onProgress: (f) => {
        overall = f;
      },
      onStageProgress: (p) => seen.push({ ...p, overall }),
    });

    for (const e of seen) {
      expect(e.stageFraction).toBeGreaterThanOrEqual(0);
      expect(e.stageFraction).toBeLessThanOrEqual(1);
    }
    // It restarts at 0 for every stage. The overall fraction never returns to 0
    // once the first stage has moved, so this alone kills a forwarded overall at
    // the two announcement sites.
    expect(seen.filter((e) => e.stageFraction === 0)).toHaveLength(6); // measuring + rendering-0, × 3 stages
    expect(seen.some((e) => e.stageFraction > 0 && e.stageFraction < 1)).toBe(true);
    // And it is genuinely a different quantity from the overall one: an early
    // stage is FURTHER through itself than the pass is through the chain, and a
    // late stage is LESS far. Both directions are asserted, so a constant offset
    // or a monotone rescaling of the overall fraction cannot satisfy them.
    const inFlight = seen.filter((e) => e.stageFraction > 0 && e.stageFraction < 1);
    expect(inFlight.some((e) => e.stageFraction > e.overall)).toBe(true);
    expect(inFlight.some((e) => e.stageFraction < e.overall)).toBe(true);
    // Monotone WITHIN a stage: the fraction may only go backwards at a boundary.
    for (let i = 1; i < seen.length; i++) {
      if (seen[i].stageId !== seen[i - 1].stageId) continue;
      expect(seen[i].stageFraction).toBeGreaterThanOrEqual(seen[i - 1].stageFraction);
    }
  });

  // Emission ORDER is not the same claim as emission VISIBILITY, and the first
  // version of this block only pinned the order. `resolveStage` is a plain
  // synchronous call, so announcing the measurement, taking it and announcing
  // the render all happened inside ONE non-yielding block: React collapses the
  // two state updates into a single flush, the final value wins, and no frame
  // can be presented until the task ends. The word "Measuring" was emitted in
  // the right order and could never reach a screen — worst on Cover Chain's
  // Match Reverb, whose entire cost IS the measurement, which went straight
  // from Waiting to Did not run while the main thread sat frozen on the
  // previous row. That is the looks-like-a-hang symptom this feature exists to
  // remove.
  //
  // The observation is a TIMER, because a timer is the thing that can only have
  // run if the engine gave the main thread back. A microtask would not do: it
  // drains before paint, so a `Promise.resolve()` yield would satisfy an
  // ordering test while presenting nothing.

  it('hands the main thread back between announcing a measurement and taking it', async () => {
    seedDoc([stepperFixture()]);
    const yielded = new Set<VocalChainStageId>();
    const sawYield = new Map<VocalChainStageId, boolean>();
    await runVocalChain({
      enabled: only(...STEPPER_IDS),
      onStageProgress: (p) => {
        if (p.phase === 'measuring') {
          yielded.delete(p.stageId);
          setTimeout(() => yielded.add(p.stageId), 0);
          return;
        }
        // The first rendering event of this stage is the far side of
        // `resolveStage`. If the timer above has already fired by now, a task
        // boundary — and therefore a paint — happened in between.
        if (!sawYield.has(p.stageId)) sawYield.set(p.stageId, yielded.has(p.stageId));
      },
    });
    expect([...sawYield.keys()]).toEqual([...STEPPER_IDS]);
    for (const id of STEPPER_IDS) expect(sawYield.get(id)).toBe(true);
  });

  it('paints the announcement BEFORE the measurement runs, not after it', async () => {
    // The timer test proves a task boundary fell between the two
    // announcements. It cannot say which SIDE of the expensive part the
    // boundary is on — moving the announcement below `resolveStage` still
    // yields, still emits in the right order, and still leaves the user
    // staring at the previous stage's row for the whole of the measurement,
    // which is the entire defect. So the paint and the measurement are
    // interleaved into one ordered list and the position is asserted.
    //
    // `invocationCallOrder` is a single monotonic counter shared by every jest
    // mock, which is what makes an ordering across two unrelated functions
    // observable at all.
    seedDoc([stepperFixture()]);
    const raf = jest.spyOn(window, 'requestAnimationFrame');
    const noiseWindow = jest.spyOn(chainAnalysis, 'measureNoiseWindow');

    // ONE stage, so the call sequence is short enough to assert exactly:
    // before-metrics measures the noise window, then the stage announces
    // itself, then `deriveCompressor` measures it again, then after-metrics.
    await runVocalChain({ enabled: only('compressor'), onStageProgress: () => {} });

    expect(raf).toHaveBeenCalledTimes(1);
    const paint = raf.mock.invocationCallOrder[0];
    const measurements = noiseWindow.mock.invocationCallOrder;
    expect(measurements).toHaveLength(3);
    // One before the paint (the run's own before-metrics, which is not the
    // stage's work) and TWO after it: the compressor's derivation and the
    // after-metrics. A yield placed below `resolveStage` moves the derivation
    // to the wrong side and leaves one.
    expect(measurements.filter((o) => o < paint)).toHaveLength(1);
    expect(measurements.filter((o) => o > paint)).toHaveLength(2);

    noiseWindow.mockRestore();
    raf.mockRestore();
  });

  it('yields ONLY for a consumer that asked for stage progress — the contract stays additive', async () => {
    // The yield is real work: a frame per stage. `testHooks` and the packaged
    // smoke drive these chains with no callbacks at all and must keep exactly
    // today's timing, so the gate is part of the contract rather than an
    // optimisation. Observed at the scheduler, which is where a stray yield
    // would show up.
    const raf = jest.spyOn(window, 'requestAnimationFrame');

    seedDoc([stepperFixture()]);
    await runVocalChain({ enabled: only(...STEPPER_IDS) });
    expect(raf).not.toHaveBeenCalled();

    useAppStore.setState(makeInitialState());
    seedDoc([stepperFixture()]);
    await runVocalChain({ enabled: only(...STEPPER_IDS), onStageProgress: () => {} });
    expect(raf.mock.calls.length).toBeGreaterThanOrEqual(STEPPER_IDS.length);

    raf.mockRestore();
    // PW1: the same explicit budget as its cover-chain twin — two whole chains
    // in one test, and jest's 5 s default is not a budget anyone chose for that.
  }, 60_000);

  it('measures before it renders, on every stage, and says so', async () => {
    seedDoc([stepperFixture()]);
    const seen: VocalChainStageProgress[] = [];
    await runVocalChain({
      enabled: only(...STEPPER_IDS),
      onStageProgress: (p) => seen.push(p),
    });
    for (const id of STEPPER_IDS) {
      const phases = seen.filter((e) => e.stageId === id).map((e) => e.phase);
      expect(phases[0]).toBe('measuring');
      // Once it renders it never goes back to measuring: the two phases are an
      // order, not a pair of labels that can alternate.
      expect(phases.indexOf('rendering')).toBeGreaterThan(-1);
      expect(phases.lastIndexOf('measuring')).toBeLessThan(phases.indexOf('rendering'));
    }
    for (const e of seen.filter((p) => p.phase === 'measuring')) {
      expect(e.detail).toBe(STAGE_MEASURING_DETAIL);
    }
  });

  it("makes the rendering line the stage's OWN derived settings, not a second copy of them", async () => {
    seedDoc([stepperFixture()]);
    const seen: VocalChainStageProgress[] = [];
    const report = await runVocalChain({
      enabled: only(...STEPPER_IDS),
      onStageProgress: (p) => seen.push(p),
    });

    // The compressor derives two values; the expectation is read out of the
    // REPORT rather than written here, so a drift between what the live line
    // says and what the finished report says is a failure rather than a
    // difference nobody notices.
    const compressor = report!.stages.find((s) => s.id === 'compressor')!;
    expect(compressor.derived.length).toBeGreaterThan(0);
    const rendering = seen.filter((e) => e.stageId === 'compressor' && e.phase === 'rendering');
    expect(rendering.length).toBeGreaterThan(0);
    for (const e of rendering) {
      expect(e.detail).toBe(stageRenderingDetail(compressor.derived));
      for (const d of compressor.derived) expect(e.detail).toContain(d.value);
    }

    // The limiter derives NOTHING — a ceiling is an absolute level — and says
    // that instead of showing an empty line.
    const limiter = report!.stages.find((s) => s.id === 'limiter')!;
    expect(limiter.derived).toEqual([]);
    for (const e of seen.filter((p) => p.stageId === 'limiter' && p.phase === 'rendering')) {
      expect(e.detail).toBe(STAGE_RENDERING_DETAIL);
    }
  });

  it('hands out each stage result the moment it lands — the very objects the report carries', async () => {
    seedDoc([stepperFixture()]);
    const seen: VocalChainStageResult[] = [];
    const report = await runVocalChain({
      enabled: only(...STEPPER_IDS),
      onStageResult: (r) => seen.push(r),
    });

    // Every stage, run or not, in registry order — the same list the smoke
    // compares against `registryStageIds`, so a live view built on this cannot
    // show a different set of rows from the finished report.
    expect(seen.map((r) => r.id)).toEqual(VOCAL_CHAIN_STAGES.map((s) => s.id));
    // IDENTITY, not equality. This is what makes "the live row shows the
    // report's own strings" structural rather than a promise: there is only one
    // object, so there is nothing to keep in sync.
    expect(seen).toHaveLength(report!.stages.length);
    for (let i = 0; i < seen.length; i++) expect(seen[i]).toBe(report!.stages[i]);
  });

  it('fires the result callback for a stage that DECLINES too, with its reason', async () => {
    // Too short for the hum probe, so DeHum declines — the live view must be
    // able to say so while the rest of the pass is still running, which it
    // cannot do if only applied stages report.
    seedDoc([noise(Math.round(SR * 0.75), 0.3, 46)]);
    const seen: VocalChainStageResult[] = [];
    const report = await runVocalChain({ enabled: only('hum', 'limiter'), onStageResult: (r) => seen.push(r) });
    const hum = seen.find((r) => r.id === 'hum')!;
    expect(hum.status).toBe('declined');
    expect(hum.reason).toEqual(expect.any(String));
    expect(hum).toBe(report!.stages.find((s) => s.id === 'hum'));
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

  // ── One resolved region, every consumer (L11) ─────────────────────────────
  // `setSelection` stores whatever it is handed. `cloneRegion` and
  // `replaceRegion` clamp into `[0, docLength]`, but `regionSamples`, the marker
  // rules' absolute offsets and the post-edit selection/cursor were all built
  // from the RAW pair — so an out-of-bounds selection gave the chain's arithmetic
  // a region the audio never used. Same defect family as R7's `plan.regionStart`,
  // L1's constant tempo path and L9's `runEffectOnSelection`: resolve ONCE, and
  // every consumer reads that pair.

  it('measures and remaps against the CLAMPED region when a NON-ZERO start pairs with an end past the document (L11)', async () => {
    const docId = seedDoc([noise(WIN * 4, 0.3, 21)]);
    const length = docLength(activeDoc());
    useAppStore.getState().setMarkersForDoc(docId, [
      { id: 'inside', positionSample: WIN * 2, name: 'inside' },
      { id: 'end', positionSample: length, name: 'end' },
    ]);
    // Clamps to [WIN, length): three windows of audio, not the raw five.
    useAppStore.getState().setSelection({ start: WIN, end: length + WIN * 2 });

    const report = await runVocalChain({ enabled: only('reverb') });

    // The region the chain SAYS it worked on is the region `cloneRegion` handed
    // the stages — against the raw pair this read WIN * 5, a span longer than
    // the whole document.
    expect(report!.regionSamples).toBe(WIN * 3);
    const grew = report!.outputSamples - report!.regionSamples;
    expect(grew).toBeGreaterThan(0);
    // Which makes `grew` the tail the reverb actually added: the raw pair turned
    // it into `tail - WIN * 2`, and the document's own length disagreed with it.
    expect(docLength(activeDoc())).toBe(length + grew);

    const markers = useAppStore.getState().markers[docId];
    // Before the region's end: untouched either way.
    expect(markers.find((m) => m.id === 'inside')!.positionSample).toBe(WIN * 2);
    // At the region's end, which IS the document's end: pushed back by the whole
    // tail. Against the raw pair the insert point landed at `length + WIN * 2`,
    // past every marker there is, so this one stayed at `length` — a cue point
    // left sitting inside the tail instead of after it.
    expect(markers.find((m) => m.id === 'end')!.positionSample).toBe(length + grew);
  });

  it('offsets the cuts, the selection and the cursor from the CLAMPED start when the selection begins before sample 0 (L11)', async () => {
    // Loud / long silence / loud, with the region stopping one window short of
    // the end so the clamp is the only thing moving `start`.
    const signal = new Float32Array(WIN * 12);
    signal.set(flat(WIN * 2, 0.5), 0);
    signal.set(flat(WIN * 6, 0.0005), WIN * 2);
    signal.set(flat(WIN * 4, 0.5), WIN * 8);
    const docId = seedDoc([signal]);
    const length = docLength(activeDoc());
    useAppStore.getState().setMarkersForDoc(docId, [
      { id: 'atGap', positionSample: WIN * 2, name: 'at the gap' },
      { id: 'afterGap', positionSample: WIN * 9, name: 'after the gap' },
    ]);
    // Clamps to [0, WIN * 11): eleven windows, not the raw thirteen.
    useAppStore.getState().setSelection({ start: -WIN * 2, end: WIN * 11 });

    const report = await runVocalChain({ enabled: only('silence') });
    expect(report!.stages.find((s) => s.id === 'silence')!.status).toBe('applied');

    // Measured off the DOCUMENT, not read back from the report — the report's
    // own length figures are half of what is under test here.
    const removed = length - docLength(activeDoc());
    expect(removed).toBeGreaterThan(0);
    expect(report!.regionSamples).toBe(WIN * 11);
    expect(report!.outputSamples).toBe(WIN * 11 - removed);

    const markers = useAppStore.getState().markers[docId];
    // The cut the worker reported is relative to the region it RECEIVED, which
    // began at the clamped 0. Offset by the raw -WIN * 2 the whole gap slid two
    // windows earlier, swallowing this marker and snapping it onto the join.
    expect(markers.find((m) => m.id === 'atGap')!.positionSample).toBe(WIN * 2);
    expect(markers.find((m) => m.id === 'afterGap')!.positionSample).toBe(WIN * 9 - removed);

    // The post-edit state reads the same resolved pair; the raw one left the
    // document selected from -WIN * 2 with the cursor there too.
    expect(useAppStore.getState().selection).toEqual({ start: 0, end: WIN * 11 - removed });
    expect(useAppStore.getState().cursorSample).toBe(0);
  });
});

// ── The gate: the audio between sung phrases (CC1) ──────────────────────────
// The user's report, verbatim: "it didn't remove the noises where nothing is
// played, in fact if no word is spoken remove all sound". Through v1.27.0 no
// enabled stage could: Noise Reduction's per-bin gain floors at -12 dB, and the
// compressor's makeup then multiplies whatever floor is left by a number above
// one. These are the acceptance tests for the gate stage that closes it.

describe('the audio between sung phrases', () => {
  /** Room tone at -45 dBFS RMS. Audible-real, not a token floor: uniform noise
   * of amplitude A has RMS A/sqrt(3), so the amplitude is solved for the level
   * rather than picked. A fixture whose "noise" sat at -300 dBFS would let a
   * gate that does nothing pass, which is the local anti-pattern. */
  const FLOOR_DBFS = -45;
  const NOISE_AMPLITUDE = Math.pow(10, FLOOR_DBFS / 20) * Math.sqrt(3);

  /** These fixtures run at a real recording rate rather than the suite's 8 kHz,
   * and the reason is measured. Noise Reduction's STFT is a FIXED 2048/512
   * (NoiseReductionEffect.ts:19-20) regardless of the rate, so at 8 kHz one
   * analysis window spans 256 ms and the stage smears each phrase a quarter of
   * a second into the pause on either side of it — an artefact of the fixture's
   * rate, not of the chain. At 44.1 kHz the same window is 46 ms. A gate tuned
   * against the 8 kHz version would be tuned against that artefact. */
  const RATE = 44100;

  interface Span {
    start: number;
    end: number;
  }

  /** One sung note: vibrato, and an attack/decay contour so the boundaries are
   * real onsets and releases rather than steps. */
  function sing(channel: Float32Array, at: number, n: number, rate: number): void {
    let phase = 0;
    for (let i = 0; i < n; i++) {
      const t = i / rate;
      const contour = Math.min(1, t / 0.04) * Math.min(1, (n / rate - t) / 0.06);
      // Integrated phase, so the ±4 Hz vibrato stays ±4 Hz: writing
      // sin(2*pi*f(t)*t) instead gives an instantaneous frequency of
      // f(t) + t*f'(t), which sweeps far outside the vibrato band.
      phase += (2 * Math.PI * (220 + 4 * Math.sin(2 * Math.PI * 5.5 * t))) / rate;
      channel[at + i] += 0.25 * contour * Math.sin(phase);
    }
  }

  /** A take of sung phrases over that floor: three notes separated by 2 s
   * pauses carrying room tone and nothing else. The pauses are what the user
   * is complaining about. */
  function phrasesOverNoise(): { channel: Float32Array; pauses: Span[] } {
    const plan: { sung: boolean; sec: number }[] = [
      { sung: false, sec: 0.8 },
      { sung: true, sec: 1.2 },
      { sung: false, sec: 2.0 },
      { sung: true, sec: 1.0 },
      { sung: false, sec: 2.0 },
      { sung: true, sec: 1.2 },
      { sung: false, sec: 0.8 },
    ];
    const total = plan.reduce((sum, p) => sum + Math.round(p.sec * RATE), 0);
    const channel = noise(total, NOISE_AMPLITUDE, 7);
    const pauses: Span[] = [];
    let at = 0;
    for (const part of plan) {
      const n = Math.round(part.sec * RATE);
      if (!part.sung) pauses.push({ start: at, end: at + n });
      else sing(channel, at, n, RATE);
      at += n;
    }
    return { channel, pauses };
  }

  /** A 3.4 s held note carrying two internal drops to the bare floor — a
   * 120 ms stop-consonant closure and a 400 ms dip — then a 2 s pause. Both
   * dips are shorter than the 500 ms this app calls a pause, so both are
   * articulation and neither may close the gate; the pause after them is
   * longer, and must. */
  function heldNoteWithDips(): { channel: Float32Array; phrase: Span; dips: Span[]; pause: Span } {
    const lead = Math.round(0.8 * RATE);
    const phraseLen = Math.round(3.4 * RATE);
    const pauseLen = Math.round(2.0 * RATE);
    const channel = noise(lead + phraseLen + pauseLen, NOISE_AMPLITUDE, 31);
    const phrase = { start: lead, end: lead + phraseLen };
    const dips = [
      { start: lead + Math.round(1.2 * RATE), end: lead + Math.round(1.32 * RATE) },
      { start: lead + Math.round(2.2 * RATE), end: lead + Math.round(2.6 * RATE) },
    ];
    // Sung in the three stretches the dips leave, so each dip is genuinely bare
    // room tone rather than a quieter note.
    let at = phrase.start;
    for (const dip of dips) {
      sing(channel, at, dip.start - at, RATE);
      at = dip.end;
    }
    sing(channel, at, phrase.end - at, RATE);
    return { channel, phrase, dips, pause: { start: phrase.end, end: phrase.end + pauseLen } };
  }

  function rmsDbOver(channel: Float32Array, spans: Span[]): number {
    let sum = 0;
    let n = 0;
    for (const span of spans) {
      for (let i = span.start; i < span.end; i++) sum += channel[i] * channel[i];
      n += span.end - span.start;
    }
    return toDb(Math.sqrt(sum / Math.max(1, n)));
  }

  /** The LAST second of each 2 s pause between phrases. A gate cannot close at
   * the instant a phrase ends — it holds, then fades — so the measurement is
   * taken where the gate claims to be shut, not across the close itself. The
   * interior pauses only: the leading and trailing ones are not "between"
   * anything. */
  function betweenPhrases(pauses: Span[]): Span[] {
    return pauses.slice(1, -1).map((p) => ({ start: p.end - RATE, end: p.end }));
  }

  it('reaches digital silence in the pauses, running the chain as it ships', async () => {
    const { channel, pauses } = phrasesOverNoise();
    seedDoc([Float32Array.from(channel)], RATE);

    await runVocalChain({ enabled: defaultStageSelection() });

    const gaps = betweenPhrases(pauses);
    // The fixture's own floor is audible-real, so this test can fail: the
    // untouched take reads about -45 dBFS between the phrases.
    expect(rmsDbOver(channel, gaps)).toBeGreaterThan(-50);
    expect(rmsDbOver(activeDoc().channels[0], gaps)).toBeLessThanOrEqual(-80);
  }, 120000);

  it('is the ONLY stage that can: every other default leaves the pauses audible', async () => {
    // The measurement behind the user's report. Same take, same chain, the gate
    // alone switched off — which is exactly the stage selection that shipped
    // through v1.27.0.
    const { channel, pauses } = phrasesOverNoise();
    seedDoc([Float32Array.from(channel)], RATE);

    await runVocalChain({ enabled: { ...defaultStageSelection(), gate: false } });

    // Noise Reduction's per-bin gain floors at -12 dB and the compressor's
    // makeup lifts what is left, so the pauses land within a few dB of where
    // they started — nowhere near silence.
    const withoutGate = rmsDbOver(activeDoc().channels[0], betweenPhrases(pauses));
    expect(withoutGate).toBeGreaterThan(-70);
    expect(withoutGate).toBeLessThan(-45);
  }, 120000);

  it('never closes inside a phrase: a 120 ms closure and a 400 ms dip come back untouched', async () => {
    // Chatter is the failure the header used to cite as the reason for having
    // no gate at all ("a threshold that can chatter on a held note"). The gate
    // alone is switched on, so bit-identity IS the claim that its gain never
    // left 1 across the phrase — no other stage can be blamed for a changed
    // sample, and none can hide a changed one either.
    const { channel, phrase, dips, pause } = heldNoteWithDips();
    seedDoc([Float32Array.from(channel)], RATE);

    const report = await runVocalChain({ enabled: only('gate') });
    expect(report!.stages.find((s) => s.id === 'gate')!.status).toBe('applied');
    const out = activeDoc().channels[0];

    // Each dip on its own, so a failure says WHICH one closed the gate. This is
    // the chatter claim exactly: both are shorter than the 500 ms hold, so the
    // gate may not even begin to fade inside either.
    for (const dip of dips) {
      let changed = 0;
      for (let i = dip.start; i < dip.end; i++) if (out[i] !== channel[i]) changed++;
      expect(changed).toBe(0);
    }

    // ...and the note around them, from the point it has actually risen. The
    // fixture's own attack contour ramps the note in from nothing over its
    // first ATTACK_SEC, and audio genuinely below the threshold is audio the
    // gate is right to mute — measured, that is the first 3.1 ms of the note.
    // Everything after the ramp is the claim.
    const ATTACK_SEC = 0.04;
    let changedInPhrase = 0;
    for (let i = phrase.start + Math.round(ATTACK_SEC * RATE); i < phrase.end; i++) {
      if (out[i] !== channel[i]) changedInPhrase++;
    }
    expect(changedInPhrase).toBe(0);

    // ...and the gate was not simply inert: the pause after the phrase is
    // silent, which is the only thing that makes the bit-identity above mean
    // anything.
    expect(rmsDbOver(out, [{ start: pause.end - RATE, end: pause.end }])).toBeLessThanOrEqual(-80);
  }, 120000);
});
