/**
 * Deterministic unit vectors for speaker-embedding fixtures.
 *
 * WHY a production module and not a test helper: the diarization tests, the
 * `diarizeBackend` fake (Task 3) and the model-free `separateSpeakersLand`
 * test hook (Task 6, D6) all need the SAME synthetic "voice" so a landing
 * driven from the hook exercises exactly the vectors the unit tests pinned.
 * A hook that ships in the renderer bundle cannot import from a `.test.ts`
 * file, so the recipe lives here. It is the `voiceVector` recipe from
 * `src/__mocks__/transcribeBackend.ts` verbatim (Task 6 moves that call site
 * here); the constants are its own, not a measurement.
 *
 * Pure maths, no DOM, no Electron, no `jest` globals.
 */

/**
 * A unit vector pointing mostly along `axis`, with a small deterministic
 * wobble (±0.01 per dimension) so two members of a group are close but not
 * identical — a fixture that is off identity values, as the plan's testing
 * rule requires. Same `(dim, axis, seed)` → bit-identical vector.
 *
 * The wobble is a 31-bit LCG (Numerical Recipes' `1103515245 / 12345`),
 * kept verbatim from `voiceVector` so existing fixtures keep their values.
 * `seed` is consumed as given; callers wanting distinct members pass distinct
 * seeds.
 */
export function unitVector(dim: number, axis: number, seed: number): Float32Array {
  if (!Number.isInteger(dim) || dim <= 0) throw new RangeError(`unitVector: dim must be a positive integer (got ${dim})`);
  if (!Number.isInteger(axis) || axis < 0 || axis >= dim) {
    throw new RangeError(`unitVector: axis ${axis} is outside 0..${dim - 1}`);
  }
  let s = seed;
  const rand = (): number => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff - 0.5;
  };
  const v = new Float32Array(dim);
  for (let i = 0; i < dim; i++) v[i] = 0.02 * rand();
  v[axis] += 1;
  let norm = 0;
  for (let i = 0; i < dim; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm);
  for (let i = 0; i < dim; i++) v[i] /= norm;
  return v;
}
