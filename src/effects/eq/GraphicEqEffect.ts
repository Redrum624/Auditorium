import type { EffectDefinition, EffectParamDef } from '../types';
import { designBiquad, processBiquad } from '../../dsp/biquad';

const Q = 1.4;

/** 10 ISO-ish octave bands, doubling from 31.25 Hz to 16 kHz. Exported because
 * F10's match curve is delivered through this effect and declares the same
 * centres in `src/dsp/coverMatch.ts` (DSP may not import from effects); its test
 * pins the two lists equal so a change here cannot silently diverge. */
export const GRAPHIC_EQ_BANDS: { id: string; label: string; freq: number }[] = [
  { id: 'g31', label: '31 Hz', freq: 31.25 },
  { id: 'g63', label: '63 Hz', freq: 62.5 },
  { id: 'g125', label: '125 Hz', freq: 125 },
  { id: 'g250', label: '250 Hz', freq: 250 },
  { id: 'g500', label: '500 Hz', freq: 500 },
  { id: 'g1k', label: '1 kHz', freq: 1000 },
  { id: 'g2k', label: '2 kHz', freq: 2000 },
  { id: 'g4k', label: '4 kHz', freq: 4000 },
  { id: 'g8k', label: '8 kHz', freq: 8000 },
  { id: 'g16k', label: '16 kHz', freq: 16000 },
];

function buildParams(): EffectParamDef[] {
  return GRAPHIC_EQ_BANDS.map((b) => ({
    id: b.id,
    label: b.label,
    type: 'number',
    min: -12,
    max: 12,
    step: 0.1,
    unit: 'dB',
    default: 0,
  }));
}

/**
 * 10-band graphic EQ: a cascade of fixed-center peaking biquads (Q=1.4) at
 * the standard octave centers. Bands at unity gain (|gain| <= 0.01 dB) are
 * skipped entirely since a 0 dB peaking stage is an identity filter anyway
 * (cheaper, and avoids designing biquads whose center may sit at/above
 * Nyquist for low sample rates).
 */
export const graphicEqEffect: EffectDefinition = {
  id: 'graphic-eq',
  name: 'Graphic EQ',
  category: 'EQ & Filters',
  params: buildParams(),
  process(channels, sampleRate, params, onProgress) {
    const nyquist = sampleRate / 2;
    const coeffsList = GRAPHIC_EQ_BANDS.filter((b) => {
      const gainDb = Number(params[b.id] ?? 0);
      return Math.abs(gainDb) > 0.01 && b.freq < nyquist;
    }).map((b) => designBiquad('peaking', sampleRate, b.freq, Q, Number(params[b.id] ?? 0)));

    const out = channels.map((c, chIdx) => {
      let signal: Float32Array = coeffsList.length > 0 ? c : Float32Array.from(c);
      for (const coeffs of coeffsList) signal = processBiquad(signal, coeffs);
      onProgress?.((chIdx + 1) / channels.length);
      return signal;
    });

    return { channels: out };
  },
};
