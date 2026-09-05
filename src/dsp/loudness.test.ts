import {
  designKWeighting,
  gainToTargetDb,
  integratedLoudness,
  samplePeakDb,
  ABSOLUTE_GATE_LUFS,
  K_WEIGHTING_REFERENCE_RATE,
  LOUDNESS_BLOCK_MS,
  LOUDNESS_HOP_MS,
  RELATIVE_GATE_LU,
} from './loudness';

/**
 * D5 — the pins are EBU Tech 3341's compliance cases plus the ITU-R BS.1770-4
 * 48 kHz coefficient table. The table is a CHECK on the design, never its
 * source: `designKWeighting` derives from the published prototype parameters at
 * whatever rate it is handed, and the 48 kHz run has to land on the table.
 */

// ITU-R BS.1770-4 Table 1 (stage 1, high shelf) and Table 2 (stage 2, high
// pass), both at 48 kHz. Reproduced here as the expectation, not imported.
const REF_48K_STAGE1 = {
  b0: 1.53512485958697,
  b1: -2.69169618940638,
  b2: 1.19839281085285,
  a1: -1.69065929318241,
  a2: 0.73248077421585,
};
const REF_48K_STAGE2 = {
  b0: 1.0,
  b1: -2.0,
  b2: 1.0,
  a1: -1.99004745483398,
  a2: 0.99007225036621,
};

/** EBU's compliance frequency. Non-identity by construction: never 0 dBFS. */
const TEST_TONE_HZ = 997;

/**
 * A phase-continuous sine of `seconds` at `dbfs` (PEAK amplitude, the EBU
 * convention: a 997 Hz sine at -23 dBFS peak reads -23.0 LUFS), starting at
 * absolute sample index `startSample` so consecutive segments splice without a
 * phase step — a discontinuity would ring the K-weighting high-pass and taint
 * the gating cases.
 */
function sineSegment(
  sampleRate: number,
  seconds: number,
  dbfs: number,
  startSample = 0,
  freq = TEST_TONE_HZ
): Float32Array {
  const amp = Math.pow(10, dbfs / 20);
  const n = Math.round(sampleRate * seconds);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = amp * Math.sin((2 * Math.PI * freq * (startSample + i)) / sampleRate);
  }
  return out;
}

/** Splice level-stepped segments while keeping one continuous phase. */
function sineProgramme(
  sampleRate: number,
  steps: Array<{ seconds: number; dbfs: number }>
): Float32Array {
  const total = steps.reduce((a, s) => a + Math.round(sampleRate * s.seconds), 0);
  const out = new Float32Array(total);
  let at = 0;
  for (const step of steps) {
    const seg = sineSegment(sampleRate, step.seconds, step.dbfs, at);
    out.set(seg, at);
    at += seg.length;
  }
  return out;
}

describe('designKWeighting', () => {
  it('reproduces the BS.1770-4 48 kHz stage-1 high shelf within 1e-6', () => {
    const { stage1 } = designKWeighting(K_WEIGHTING_REFERENCE_RATE);
    expect(stage1.b0).toBeCloseTo(REF_48K_STAGE1.b0, 6);
    expect(stage1.b1).toBeCloseTo(REF_48K_STAGE1.b1, 6);
    expect(stage1.b2).toBeCloseTo(REF_48K_STAGE1.b2, 6);
    expect(stage1.a1).toBeCloseTo(REF_48K_STAGE1.a1, 6);
    expect(stage1.a2).toBeCloseTo(REF_48K_STAGE1.a2, 6);
    for (const key of ['b0', 'b1', 'b2', 'a1', 'a2'] as const) {
      expect(Math.abs(stage1[key] - REF_48K_STAGE1[key])).toBeLessThan(1e-6);
    }
  });

  it('reproduces the BS.1770-4 48 kHz stage-2 high pass within 1e-6', () => {
    const { stage2 } = designKWeighting(K_WEIGHTING_REFERENCE_RATE);
    for (const key of ['b0', 'b1', 'b2', 'a1', 'a2'] as const) {
      expect(Math.abs(stage2[key] - REF_48K_STAGE2[key])).toBeLessThan(1e-6);
    }
  });

  it('is a design, not a copied table: 44.1 kHz coefficients differ materially', () => {
    const at48 = designKWeighting(48000);
    const at441 = designKWeighting(44100);
    expect(Math.abs(at441.stage1.a1 - at48.stage1.a1)).toBeGreaterThan(1e-3);
    expect(Math.abs(at441.stage2.a1 - at48.stage2.a1)).toBeGreaterThan(1e-4);
    // ...but the numerator of the high pass is rate-independent by construction.
    expect(at441.stage2.b0).toBeCloseTo(1, 12);
    expect(at441.stage2.b1).toBeCloseTo(-2, 12);
    expect(at441.stage2.b2).toBeCloseTo(1, 12);
  });

  it('exposes the BS.1770-4 block, hop and gate constants', () => {
    expect(K_WEIGHTING_REFERENCE_RATE).toBe(48000);
    expect(LOUDNESS_BLOCK_MS).toBe(400);
    expect(LOUDNESS_HOP_MS).toBe(100); // 75 % overlap
    expect(ABSOLUTE_GATE_LUFS).toBe(-70);
    expect(RELATIVE_GATE_LU).toBe(-10);
  });
});

describe('integratedLoudness — EBU Tech 3341 compliance cases', () => {
  it('997 Hz at -23 dBFS in both channels reads -23.0 LUFS (+/-0.1)', () => {
    const sine = sineSegment(48000, 20, -23);
    const lufs = integratedLoudness([sine, sine], 48000);
    expect(lufs).not.toBeNull();
    expect(lufs as number).toBeGreaterThan(-23.1);
    expect(lufs as number).toBeLessThan(-22.9);
  });

  it('997 Hz at -33 dBFS in both channels reads -33.0 LUFS (+/-0.1)', () => {
    const sine = sineSegment(48000, 20, -33);
    const lufs = integratedLoudness([sine, sine], 48000);
    expect(lufs as number).toBeGreaterThan(-33.1);
    expect(lufs as number).toBeLessThan(-32.9);
  });

  it('a 20 s stretch at -40 dBFS inserted mid-programme is gated out (-23.0 +/-0.1)', () => {
    const programme = sineProgramme(48000, [
      { seconds: 10, dbfs: -23 },
      { seconds: 20, dbfs: -40 },
      { seconds: 10, dbfs: -23 },
    ]);
    const lufs = integratedLoudness([programme, programme], 48000);
    expect(lufs as number).toBeGreaterThan(-23.1);
    expect(lufs as number).toBeLessThan(-22.9);
  });

  it('the -40 dBFS stretch alone reads about -40, so the gate is what removed it', () => {
    const quiet = sineSegment(48000, 20, -40);
    const lufs = integratedLoudness([quiet, quiet], 48000);
    expect(lufs as number).toBeGreaterThan(-40.1);
    expect(lufs as number).toBeLessThan(-39.9);
  });

  it('20 s of digital silence reads null (every block below the absolute gate)', () => {
    const silence = new Float32Array(48000 * 20);
    expect(integratedLoudness([silence, silence], 48000)).toBeNull();
  });

  it('the same signal at 44100 and 48000 agrees within 0.1 LU', () => {
    const at48 = integratedLoudness(
      [sineSegment(48000, 20, -23), sineSegment(48000, 20, -23)],
      48000
    );
    const at441 = integratedLoudness(
      [sineSegment(44100, 20, -23), sineSegment(44100, 20, -23)],
      44100
    );
    expect(at48).not.toBeNull();
    expect(at441).not.toBeNull();
    expect(Math.abs((at48 as number) - (at441 as number))).toBeLessThan(0.1);
  });

  it('-23 dBFS in ONE channel of a stereo pair reads -26.0 (+/-0.1): half the power', () => {
    const sine = sineSegment(48000, 20, -23);
    const silence = new Float32Array(sine.length);
    const lufs = integratedLoudness([sine, silence], 48000);
    expect(lufs as number).toBeGreaterThan(-26.1);
    expect(lufs as number).toBeLessThan(-25.9);
  });

  it('a mono -23 dBFS document also reads -26.0: one channel, weight 1', () => {
    const sine = sineSegment(48000, 20, -23);
    const lufs = integratedLoudness([sine], 48000);
    expect(lufs as number).toBeGreaterThan(-26.1);
    expect(lufs as number).toBeLessThan(-25.9);
  });

  /**
   * D5 scopes the measurement to mono/stereo: every channel weighs 1.0 and none
   * is excluded, which is NOT what BS.1770-4 does for surround (Ls/Rs at 1.41,
   * LFE dropped). >2-channel documents are reachable — `decodeAudio.ts` passes a
   * multichannel WAV through undownmixed — so the equal weighting is pinned
   * here rather than assumed, and D6's Podcast Chain refuses such documents.
   */
  it('a silent third channel adds nothing: 3ch reads the same as the stereo pair', () => {
    const sine = sineSegment(48000, 20, -23);
    const silence = new Float32Array(sine.length);
    const stereo = integratedLoudness([sine, sine], 48000) as number;
    const threeCh = integratedLoudness([sine, sine, silence], 48000) as number;
    expect(threeCh).toBeGreaterThan(-23.1);
    expect(threeCh).toBeLessThan(-22.9);
    expect(threeCh).toBeCloseTo(stereo, 9);
  });

  it('a third channel carrying the same tone is weighted 1.0: -23 + 10*log10(3/2)', () => {
    const sine = sineSegment(48000, 20, -23);
    const threeCh = integratedLoudness([sine, sine, sine], 48000) as number;
    const expected = -23 + 10 * Math.log10(3 / 2); // -21.2394
    expect(threeCh).toBeGreaterThan(expected - 0.1);
    expect(threeCh).toBeLessThan(expected + 0.1);
  });

  it('200 ms of signal is shorter than one 400 ms block and reads null', () => {
    const short = sineSegment(48000, 0.2, -23);
    expect(integratedLoudness([short, short], 48000)).toBeNull();
  });

  it('exactly one block worth of signal (400 ms) still measures', () => {
    const oneBlock = sineSegment(48000, 0.4, -23);
    const lufs = integratedLoudness([oneBlock, oneBlock], 48000);
    expect(lufs).not.toBeNull();
    expect(lufs as number).toBeGreaterThan(-23.3);
    expect(lufs as number).toBeLessThan(-22.7);
  });

  it('an empty channel list and zero-length channels read null', () => {
    expect(integratedLoudness([], 48000)).toBeNull();
    expect(integratedLoudness([new Float32Array(0)], 48000)).toBeNull();
  });

  it('a non-positive sample rate reads null rather than dividing by zero', () => {
    const sine = sineSegment(48000, 1, -23);
    expect(integratedLoudness([sine, sine], 0)).toBeNull();
  });

  it('does not mutate the input channels', () => {
    const sine = sineSegment(48000, 1, -23);
    const before = Float32Array.from(sine);
    integratedLoudness([sine, sine], 48000);
    expect(Array.from(sine)).toEqual(Array.from(before));
  });

  it('is monotone in level: +7 dB of input is +7 LU of reading', () => {
    const quiet = sineSegment(48000, 20, -30);
    const loud = sineSegment(48000, 20, -23);
    const a = integratedLoudness([quiet, quiet], 48000) as number;
    const b = integratedLoudness([loud, loud], 48000) as number;
    expect(b - a).toBeGreaterThan(6.9);
    expect(b - a).toBeLessThan(7.1);
  });

  it('channels of unequal length measure over the common span', () => {
    const long = sineSegment(48000, 20, -23);
    const short = long.subarray(0, 48000 * 5);
    const lufs = integratedLoudness([long, Float32Array.from(short)], 48000);
    expect(lufs).not.toBeNull();
    // 5 s of a stereo pair at -23 in both channels; the trailing 15 s is not
    // half-silence, it is simply outside the measured span.
    expect(lufs as number).toBeGreaterThan(-23.1);
    expect(lufs as number).toBeLessThan(-22.9);
  });
});

describe('samplePeakDb', () => {
  it('reads the peak of the loudest channel in dBFS', () => {
    const a = Float32Array.from([0.1, -0.2, 0.15]);
    const b = Float32Array.from([0.05, 0.47315125896148047, -0.3]); // -6.5 dBFS
    expect(samplePeakDb([a, b])).toBeCloseTo(-6.5, 6);
  });

  it('is -Infinity for an all-zero input', () => {
    expect(samplePeakDb([new Float32Array(128), new Float32Array(128)])).toBe(-Infinity);
    expect(samplePeakDb([])).toBe(-Infinity);
  });

  it('reads the magnitude, so a negative peak counts', () => {
    const only = Float32Array.from([0.01, -0.5011872336272722]); // -6 dBFS
    // 5 digits, not 6: the literal is a double and the array is float32, so the
    // stored value is quantised. Deterministic, but not worth pinning to the
    // last bit of that rounding.
    expect(samplePeakDb([only])).toBeCloseTo(-6, 5);
  });
});

describe('gainToTargetDb', () => {
  it('is target minus measured', () => {
    expect(gainToTargetDb(-21.5, -16)).toBeCloseTo(5.5, 12);
    expect(gainToTargetDb(-12.25, -19)).toBeCloseTo(-6.75, 12);
  });

  it('applying the gain lands the target: -23 dBFS programme to -16 LUFS', () => {
    const sine = sineSegment(48000, 20, -23);
    const measured = integratedLoudness([sine, sine], 48000) as number;
    const gainDb = gainToTargetDb(measured, -16);
    const lin = Math.pow(10, gainDb / 20);
    const scaled = Float32Array.from(sine, (v) => v * lin);
    const after = integratedLoudness([scaled, scaled], 48000) as number;
    expect(after).toBeCloseTo(-16, 3);
  });
});
