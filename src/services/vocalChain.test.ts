import {
  DE_ESSER_BIT_EXACT_OFFSET_DB,
  DE_ESSER_RMS_OFFSET_DB,
  GATE_HEADROOM_DB,
  GATE_HOLD_MS,
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
import { createDocument, docLength } from '../audio/AudioDocument';
import { useAppStore, makeInitialState } from '../stores/appStore';
import { getHistory, undo } from './undoHistory';
import { ALIGN_ACCURACY_SENTENCE } from '../dsp/ctcAlign';
import {
  NOISE_WINDOW_MS,
  measureNoiseWindow,
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
  /** The voiced share of a 500 ms window — the statistic the gate declines on. */
  function voicedFraction(window: Float32Array): number {
    const track = detectPitch(window, SR);
    if (track.frames.length === 0) return 0;
    let voiced = 0;
    for (const f of track.frames) if (f.f0Hz !== null) voiced++;
    return voiced / track.frames.length;
  }

  const WINDOW = Math.round((NOISE_WINDOW_MS / 1000) * SR);

  /** Soft singing: a fundamental with two harmonics and vibrato, over its own
   * faint floor. Phase is integrated so the vibrato stays a vibrato. */
  function sung(rmsDb: number, f0: number, breathMs: number): Float32Array {
    const amp = Math.pow(10, rmsDb / 20);
    const out = noise(WINDOW, amp * 0.02, 5);
    let phase = 0;
    for (let i = 0; i < WINDOW; i++) {
      const t = i / SR;
      phase += (2 * Math.PI * f0 * (1 + 0.006 * Math.sin(2 * Math.PI * 5.5 * t))) / SR;
      out[i] += amp * 1.2 * (Math.sin(phase) + 0.4 * Math.sin(2 * phase) + 0.2 * Math.sin(3 * phase));
    }
    if (breathMs > 0) {
      const bn = Math.round((breathMs / 1000) * SR);
      const at = Math.round((WINDOW - bn) / 2);
      const quiet = noise(bn, Math.pow(10, (rmsDb - 25) / 20), 77);
      out.set(quiet, at);
    }
    return out;
  }

  it('separates every noise floor from every soft sung window, with the constant between them', () => {
    // Floors: uniform and Gaussian, across the range room tone actually
    // occupies, three seeds. Voice is periodic; room tone is not.
    const floors: number[] = [];
    for (const rmsDb of [-30, -45, -60, -75]) {
      for (const seed of [7, 23, 101]) {
        floors.push(voicedFraction(noise(WINDOW, Math.pow(10, rmsDb / 20) * Math.sqrt(3), seed)));
        let s = seed >>> 0;
        const g = new Float32Array(WINDOW);
        const k = Math.pow(10, rmsDb / 20) / Math.sqrt(4 / 3);
        for (let i = 0; i < WINDOW; i++) {
          const nx = (): number => {
            s = (s * 1664525 + 1013904223) >>> 0;
            return (s / 0xffffffff) * 2 - 1;
          };
          g[i] = (nx() + nx() + nx() + nx()) * k;
        }
        floors.push(voicedFraction(g));
      }
    }

    // Voices: three fundamentals across the sung range, four levels down to
    // -50 dBFS, and — the hard case — windows carrying a breath of up to
    // 350 ms of the 500, which is what drags a real sung window's fraction
    // down toward the floors.
    const voices: number[] = [];
    for (const rmsDb of [-20, -30, -40, -50]) {
      for (const f0 of [98, 196, 392]) {
        for (const breathMs of [0, 150, 250, 350]) voices.push(voicedFraction(sung(rmsDb, f0, breathMs)));
      }
    }

    expect(floors).toHaveLength(24);
    expect(voices).toHaveLength(48);

    // Absolute bounds on both populations, so a drift in either fails here
    // rather than silently widening or closing the gap. Measured over the
    // wider sweep: floors 0.000 exactly (every one), voices 0.156 at worst.
    const worstFloor = Math.max(...floors);
    const worstVoice = Math.min(...voices);
    expect(worstFloor).toBeLessThan(0.02);
    expect(worstVoice).toBeGreaterThan(0.12);

    // The constant sits between them, with room on both sides: above the
    // floors by more than two frames' worth, and more than three times below
    // the hardest sung window.
    expect(GATE_VOICED_FRACTION).toBeGreaterThan(worstFloor);
    expect(GATE_VOICED_FRACTION).toBeLessThan(worstVoice / 3);
    expect(GATE_VOICED_FRACTION).toBe(0.05);
  }, 60000);
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
