/**
 * Envelope-follower DSP shared by the dynamics effects (compressor, limiter,
 * noise gate) and the silence detector (F2). Moved here VERBATIM from
 * `src/effects/dynamics/envelope.ts` so `src/dsp/` modules can consume it
 * without importing from the effects layer (DSP must stay pure TS with no
 * upward dependencies); that file re-exports these for its existing consumers,
 * so nothing else moved and no numeric behaviour changed.
 */

/**
 * One-pole envelope follower operating on |input|. Rises toward the input
 * using the attack time constant while the input exceeds the current
 * envelope value, and decays toward it using the release time constant
 * otherwise. `env[-1] = 0`.
 *
 * Coefficient: coef(ms) = exp(-1 / ((ms/1000) * sampleRate)). With this
 * coefficient a constant step input reaches ~63.2% (1 - 1/e) of its target
 * after `ms` worth of samples (classic RC charge/discharge behavior), and a
 * step back to zero decays to ~36.8% (1/e) of the held level after `ms`
 * worth of samples.
 */
export function envelopeFollower(
  input: Float32Array,
  sampleRate: number,
  attackMs: number,
  releaseMs: number
): Float32Array {
  const attackCoef = Math.exp(-1 / ((attackMs / 1000) * sampleRate));
  const releaseCoef = Math.exp(-1 / ((releaseMs / 1000) * sampleRate));
  const out = new Float32Array(input.length);
  let env = 0;
  for (let i = 0; i < input.length; i++) {
    const x = Math.abs(input[i]);
    env = x > env ? attackCoef * env + (1 - attackCoef) * x : releaseCoef * env + (1 - releaseCoef) * x;
    out[i] = env;
  }
  return out;
}

/** Per-sample max(|ch0[i]|, |ch1[i]|, ...) across all channels — the shared
 * sidechain/detector signal used by the compressor, limiter, and noise gate. */
export function maxAcrossChannels(channels: Float32Array[]): Float32Array {
  const length = channels[0]?.length ?? 0;
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    let m = 0;
    for (const c of channels) {
      const v = Math.abs(c[i]);
      if (v > m) m = v;
    }
    out[i] = m;
  }
  return out;
}
