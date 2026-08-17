'use strict';

// T3 (v1.28 ledger) — the ONE place the synced cover pair's ground truth lives.
//
// It was in two: `make-test-cover.cjs` planted the take `+0.75 s` later, and
// `e2e-smoke.cjs` asserted the aligner recovers `-0.75 s` — a hand-typed
// negation of a number the other file owned, with nothing binding them. Change
// the plant and the smoke goes on asserting the old truth; it would fail, but
// it would fail as "the aligner is wrong" rather than as "these two disagree",
// which is the expensive kind of red.
//
// The negation is the interesting half and it is derived here, once, with its
// reason attached rather than restated at each end.
//
// Plain CJS with no dependencies on purpose: `make-test-cover.cjs` is a
// generator that must run under bare `node` with nothing installed beyond the
// standard library, so it cannot reach `e2e-lib.cjs` (which pulls in
// Playwright) and this must not grow a dependency either.

/**
 * How much later the take's copy of the shared syllable schedule is laid down,
 * in seconds. The ground truth is BUILT, not measured: both files render the
 * SAME schedule and only the lead differs.
 */
const SYNC_OFFSET_SECONDS = 0.75;

/**
 * The same fact as the aligner reports it — and it is NEGATIVE.
 *
 * `coverAlign`'s offset is "the take's sample 0 on the reference's timeline",
 * so a take carrying 0.75 s of leading silence has to START 0.75 s EARLIER for
 * its syllables to land on the song's. The journey then places it at zero and
 * shifts BOTH tracks, which is the negative-offset arm doing its job.
 */
const COVER_SYNC_OFFSET_SECONDS = -SYNC_OFFSET_SECONDS;

module.exports = { SYNC_OFFSET_SECONDS, COVER_SYNC_OFFSET_SECONDS };
