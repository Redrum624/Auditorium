/**
 * Bit-exact digest of a `Float32Array`, for golden pins on rendered audio
 * (v1.9 X1, ruling 9 / trap T1).
 *
 * WHY A DIGEST AT ALL. A golden pin has to fail when ANY sample changes, and
 * storing every sample of a multi-second render as a source literal is both
 * enormous and unreadable. A digest over the raw IEEE-754 bit patterns gives
 * the full-coverage half of the pin in 16 characters; the calling test stores
 * a set of exact sample values alongside it for the diagnostic half (which
 * region moved, and by how much).
 *
 * WHY IT HASHES BIT PATTERNS, NOT DECIMAL TEXT. `1e-8` and `1.0000001e-8` are
 * different `float32`s that print the same at low precision; hashing the
 * stored bits is the only formulation that cannot lose the last mantissa bit,
 * which is exactly the class of drift a fade refactor produces (traps T2/T4).
 *
 * WHY IT IS ENDIAN-INDEPENDENT. The float is written through a 4-byte scratch
 * buffer and read back as a `uint32`, then split into bytes with explicit
 * shifts rather than by reading the buffer's own byte order. The same input
 * therefore digests identically on a big-endian host, so a fixture generated
 * on this dev box is not silently tied to it. (It also sidesteps the 4-byte
 * alignment requirement a `Uint32Array` view over an arbitrary `.subarray()`
 * would impose.)
 *
 * Two independent 32-bit lanes are combined into one 64-bit hex string: a
 * single 32-bit lane would let roughly one change in 4 billion through, which
 * is a poor guarantee for the one test standing between a shared-DSP edit and
 * a silently altered auto-remix.
 */
export function float32Digest(x: Float32Array): string {
  const scratch = new ArrayBuffer(4);
  const asFloat = new Float32Array(scratch);
  const asUint = new Uint32Array(scratch);

  // FNV-1a 32-bit offset basis / prime for lane 1; a different seed and a
  // different (murmur3) mixing constant for lane 2, so the two lanes do not
  // collide on the same inputs.
  let h1 = 0x811c9dc5;
  let h2 = (0x9e3779b9 ^ x.length) >>> 0;

  for (let i = 0; i < x.length; i++) {
    asFloat[0] = x[i];
    const bits = asUint[0];
    for (let shift = 0; shift < 32; shift += 8) {
      const byte = (bits >>> shift) & 0xff;
      h1 = Math.imul(h1 ^ byte, 0x01000193);
      h2 = Math.imul(h2 ^ byte, 0x85ebca6b);
    }
    h2 = (h2 ^ (h2 >>> 13)) >>> 0;
  }

  return hex8(h1) + hex8(h2);
}

function hex8(h: number): string {
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * Source-literal form of a `number` that round-trips EXACTLY through the
 * TypeScript parser, including the sign of zero. `String(-0)` is `'0'`, so a
 * naively-generated fixture turns `-0` into `+0` and a later `Object.is`
 * comparison fails against a render that was never wrong. Used only by the
 * fixture generators, never at assert time.
 */
export function numberLiteral(v: number): string {
  if (Object.is(v, -0)) return '-0';
  if (Number.isNaN(v)) return 'NaN';
  if (v === Infinity) return 'Infinity';
  if (v === -Infinity) return '-Infinity';
  return String(v);
}
