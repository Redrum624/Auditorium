import { registerEffect } from './EffectRegistry';
import { amplifyEffect } from './basic/AmplifyEffect';
import { normalizeEffect } from './basic/NormalizeEffect';
import { fadeEffect } from './basic/FadeEffect';
import { reverseEffect } from './basic/ReverseEffect';
import { invertEffect } from './basic/InvertEffect';
import { dcRemoveEffect } from './basic/DcRemoveEffect';
import { parametricEqEffect } from './eq/ParametricEqEffect';
import { graphicEqEffect } from './eq/GraphicEqEffect';
import { compressorEffect } from './dynamics/CompressorEffect';
import { limiterEffect } from './dynamics/LimiterEffect';
import { noiseGateEffect } from './dynamics/NoiseGateEffect';
import { deEsserEffect } from './dynamics/DeEsserEffect';
import { echoEffect } from './time/EchoEffect';
import { reverbEffect } from './time/ReverbEffect';
import { chorusEffect } from './time/ChorusEffect';
import { flangerEffect } from './time/FlangerEffect';
import { distortionEffect } from './color/DistortionEffect';
import { deHumEffect } from './restoration/DeHumEffect';
import { noiseReductionEffect } from './restoration/NoiseReductionEffect';
import { silenceRemoverEffect } from './restoration/SilenceRemoverEffect';
import { channelMixerEffect } from './stereo/ChannelMixerEffect';
import { panEffect } from './stereo/PanEffect';
import { timeStretchEffect } from './pitch/TimeStretchEffect';
import { pitchShiftEffect } from './pitch/PitchShiftEffect';
import { pitchCorrectEffect } from './pitch/PitchCorrectEffect';
import { alignTimingEffect } from './time/AlignTimingEffect';
import { matchTempoVariableEffect } from './time/MatchTempoVariableEffect';

let registered = false;

/**
 * Registers every built-in effect into the module-level registry. Idempotent —
 * a guard flag makes repeat calls no-ops, so both `App.tsx` and `dsp.worker.ts`
 * can import and call this safely without triggering a duplicate-id throw.
 */
export function registerAllEffects(): void {
  if (registered) return;
  registered = true;
  registerEffect(amplifyEffect);
  registerEffect(normalizeEffect);
  registerEffect(fadeEffect);
  registerEffect(reverseEffect);
  registerEffect(invertEffect);
  registerEffect(dcRemoveEffect);
  registerEffect(parametricEqEffect);
  registerEffect(graphicEqEffect);
  registerEffect(compressorEffect);
  registerEffect(limiterEffect);
  registerEffect(noiseGateEffect);
  registerEffect(deEsserEffect);
  registerEffect(echoEffect);
  registerEffect(reverbEffect);
  registerEffect(chorusEffect);
  registerEffect(flangerEffect);
  registerEffect(distortionEffect);
  registerEffect(deHumEffect);
  registerEffect(noiseReductionEffect);
  registerEffect(silenceRemoverEffect);
  registerEffect(channelMixerEffect);
  registerEffect(panEffect);
  registerEffect(timeStretchEffect);
  registerEffect(pitchShiftEffect);
  registerEffect(pitchCorrectEffect);
  // Hidden (F9): registered so the worker can run it, kept out of the menu and
  // the effects browser because it is driven by AlignTimingDialog's confirmed
  // anchor list, not by the generic params dialog.
  registerEffect(alignTimingEffect);
  // Hidden (R7): same reason — it is driven by TempoDialog's CONFIRMED beat
  // grid, and a params-only dialog could never supply one.
  registerEffect(matchTempoVariableEffect);
}
