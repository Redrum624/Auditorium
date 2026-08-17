# `docs/bench/` — committed measurement verdicts

Numbers this project has actually measured, kept where a future reader can check them against
the claim that cites them. A figure quoted in a docblock, in `KNOWN_LIMITATIONS.md` or in a
CHANGELOG entry should be traceable to a file here or to the script that produced it — the rule
that got the tempo detector's long-quoted "63/91 correct" retired, because nobody could
re-measure it.

## What is here

| File | What it records | Produced by |
|---|---|---|
| `tempo-bench-baseline.json`, `tempo-bench-r4-jitter-tolerant.json` | Tempo detector A/B over the 83-fixture bank, per family and per row | `scripts/tempo-bench.cjs` |
| `first-play-latency-baseline.json` | First-play latency: process-cold, fresh-context-warm-process, warm replays | `scripts/first-play-latency-rig.cjs` |
| `mt1-play-latency-44100.json`, `mt1-play-latency-48000.json` | The same rig per session rate (MT1) | `scripts/first-play-latency-rig.cjs` |
| `mt2-play-latency-adopted.json`, `mt2-play-latency-mixed-warm.json` | The same rig for rate adoption and mixed-warm sessions (MT2) | `scripts/first-play-latency-rig.cjs` |
| `stem-second-pass-rejected.json` | Four real model passes answering "does a second separation pass help?" — verdict: 0.00 dB | `scripts/stem-second-pass-probe.cjs` |
| `vocal-chain-uneven-floor-bias.md` | Pre-registration and verdict for the uneven-floor bias in `deriveCompressor` / `deriveNoiseReduction` | in-suite probe, method in the document |

Nothing in `npm test` enumerates this directory; suites reference individual files by name.
Adding a file here does not touch the gate.

## The discipline, when a measurement will DECIDE something

Most files here answer "how fast / how good is this". A few decide a design question, and those
carry a failure mode of their own: once the numbers exist, the bound they are judged against
can be chosen to suit them, and nobody can tell afterwards. So when a measurement is going to
settle a decision:

1. **Write the bound down first, with its justification** — what magnitude would count as
   audible, or wrong, or worth changing code over, and why that magnitude.
2. **Commit it here BEFORE the numbers land.** Not into a scratch directory, and not into
   any gitignored working path — a document written there proves nothing about
   its own ordering and rests on a file mtime. Committing the bound first puts the ordering in
   the git DAG, where it is checkable by anyone, forever. This rule exists because the
   `vocal-chain-uneven-floor-bias` probe did the first step and not the second, and its
   "committed before any number" claim had to be retracted to "written at 03:13, mtime only".
3. **Name the shapes you will measure on.** If the set grows once measuring starts — and it
   often should, because the first reading frequently shows the registered fixture was
   answering a different question — then say so in the same document: which shapes were
   registered, which were added, one line on why the addition was needed, and whether any
   verdict turns on it. An undisclosed expansion is the exact thing pre-registration exists to
   prevent, and it looks identical whether it was innocent or not.
4. **Record both outcomes as success.** A probe that reports "inside the bound, classification
   confirmed" is worth the same as one that finds a bug. A probe that can only justify a change
   is not a measurement.
5. **Departing from the registered rule is allowed, and must be labelled.** Sometimes measuring
   the prescribed fix is what reveals it to be harmful — information the registration could not
   have had. Say "this is a departure from the rule above", give the reason in numbers, and
   leave a falsifiable test behind so the decision can be reversed by evidence rather than
   re-argued.
