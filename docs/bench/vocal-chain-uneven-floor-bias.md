# Uneven-floor bias in `deriveCompressor` and `deriveNoiseReduction`

Pre-registration and verdict for the T2 probe (v1.30 cleanup wave). Tracked here because
`docs/bench/` is where this repo commits measurement verdicts; see `README.md` beside this
file for the discipline this document is both an instance of and the reason for.

## Provenance — read this before the numbers

**This document was not committed before the measurement, and could not have been.** It was
written into a gitignored internal working directory, so no commit of it exists or could
exist. What is provable about its
ordering is the file's mtime — **03:13**, between the lane's previous commit (03:11) and the
probe commit (03:29) — which is consistent with the bound having been fixed before the numbers
were produced but cannot exclude an earlier measurement run. The original said "written and
committed before any number was produced"; **"committed" was false in letter**, and the claim
is corrected to the mtime statement above.

The bound itself is not in doubt on its merits — it is the project's standard 1.0 dB broadband
JND, and every number measured came out 5× to 50× away from it, so no amount of bound-shopping
would have changed a verdict. The defect is in the record, not the arithmetic. This tracked
copy exists so the next such probe does not have the same hole: see the go-forward rule in
`README.md`.

## Shapes — REGISTERED vs ADDED

**Registered before measuring:**

- `unevenFloorTake(sr)` — the fixture G1's Remove Silence RED is built on, already kept in
  `src/services/vocalChain.test.ts`: a trimmed head of exact zeros ending 25 ms after a 50 ms
  search step, a −60 dBFS stretch beside it, a sung phrase, a quiet −62 dBFS sustained phrase,
  and a −70 dBFS tail that is the take's real floor. On it the bare search returns a window
  >90 % zeros reading ~9–10 dB above the honest one. At 8 kHz and 44.1 kHz.

**Added during measurement, and disclosed:**

- `takeWithTrimmedHead(sr)` — an ordinary vocal take carrying the same defect: the same
  zeros-plus-settling-stretch head, then three sung phrases with pauses between them. **Not in
  the pre-registration and not in G1's `scratch/cc1probe/` scripts.** It was added because the
  registered shape is 90 % room tone around one short phrase — a fixture built to break a
  *deletion* stage — and the first compressor reading off it (43.66 dB) could not be
  interpreted without knowing whether it described the defect or the fixture. The added shape
  is what separates those two, and it is the more representative of the two for a vocal chain.

**What the addition changed, stated plainly.** It supplies the compressor's exculpatory
0.021 / 0.017 dB readings, and every NR figure quoted as the headline in the docblock, the
user guide and the README: the print gap **6.79 / 13.82 dB** and the end-to-end removal
**4.69→9.38** and **2.88→11.22 dB**. All five are the ADDED shape's; the Measured table below
gives the REGISTERED shape's readings for the same quantities beside them.

**No verdict turns on it.** The registered shape alone puts NR over its 1.0 dB bound by a
factor of 6.7 and 13.8 — **6.71 / 13.80 dB** of print dilution, removing 5.39 / 2.91 dB where
an honest print removes 10.47 / 11.24 — and the compressor departure rests entirely on
fix-harm measured on the *registered* shape (+31.17 dB of makeup, clamped to +24, peak driven
from −12.0 to about −1 dBFS). Had the added shape never existed, both verdicts would read the
same, off numbers within 0.1 dB of the ones quoted. It is disclosed anyway, because an
expansion that happens to be innocent is exactly the one a pre-registration is supposed to
make visible.

## Bounds — what counts as AUDIBLE, decided in advance

**`deriveCompressor`.** The bias lands on the derived threshold, and through it on the gain
reduction applied.

- **1.0 dB of derived-threshold movement.** 1 dB is the classical just-noticeable difference
  for a broadband level change. A threshold error Δ changes the applied gain reduction by at
  most Δ·(1 − 1/ratio) < Δ, so a threshold error under 1 dB cannot move what is heard by a JND.
- **0.5 dB of makeup-gain movement** — half a JND on the stage's own output level. Makeup is
  computed from the same threshold over the whole envelope, so programme level is largely
  self-correcting; what survives is a dynamics change.
- Any change of VERDICT (run ↔ decline) is categorical and exceeds the bound at any magnitude.

**`deriveNoiseReduction`.** The bias lands on the print, and through it on how much noise is
subtracted.

- **1.0 dB of mean print magnitude**, as the mean over spectral bins of
  20·log₁₀(bare print / honest print) — exactly the depth the subtraction works to, and both
  the broadband JND and 1/12 of the stage's own full reduction (`reductionDb` default 12).
- **Any change of VERDICT.** A zero-diluted `rmsDb` flatters the viability margin and could let
  the stage RUN where an honest read declines; that difference is a stage running on a print
  containing voice, so it is categorical.

**Decision rule as registered.** Exceed the bound → fix RED-first with the existing
`rejectMostlySilentWindows` mechanism. Stay inside → the review's degraded-only classification
is confirmed by measurement, pinned by a kept test, recorded in the derivation docblocks.
Either outcome is success; no claim either way without a number.

## Measured

Counterfactuals were taken with a mirror of each derivation's own arithmetic, validated against
the shipped function by reproducing its numbers exactly from the bare reading.

**This table is the authority on shape attribution.** Every row carries the shape it was
measured on — `REGISTERED` = `unevenFloorTake`, `ADDED` = `takeWithTrimmedHead`, `BOTH` where
the reading is the same fact on each. Where a row's headline number comes from one shape, the
other shape's reading for the same quantity is given beside it, so nothing rests on which one
happened to be quoted. The lane report (`task-T2-report.md`) defers to this table.

| Shape | Quantity | 8 kHz | 44.1 kHz |
|---|---|---|---|
| **REGISTERED** | window inflation (bare − honest, envelope peak) | **9.57 dB** | **9.46 dB** |
| *ADDED* | *the same, on the ordinary take* | *9.23 dB* | *9.39 dB* |
| **ADDED** | **NR** print gap, mean bin magnitude | **6.79 dB** | **13.82 dB** |
| *REGISTERED* | *the same, on the registered shape* | *6.71 dB* | *13.80 dB* |
| **ADDED** | **NR** floor removed, diluted print (end to end) | **4.69 dB** | **2.88 dB** |
| *REGISTERED* | *the same* | *5.39 dB* | *2.91 dB* |
| **ADDED** | **NR** floor removed, honest print (end to end) | **9.38 dB** | **11.22 dB** |
| *REGISTERED* | *the same* | *10.47 dB* | *11.24 dB* |
| **ADDED** | **NR** reduction left unused (honest − diluted) | **4.69 dB** | **8.34 dB** |
| *REGISTERED* | *the same* | *5.08 dB* | *8.33 dB* |
| **BOTH** | **NR** verdict flip (run ↔ decline) | none | none |
| **ADDED** | **Compressor** threshold shift | **0.021 dB** | **0.017 dB** |
| **ADDED** | **Compressor** makeup shift | **0.008 dB** | **0.006 dB** |
| **REGISTERED** | **Compressor** threshold shift | **43.66 dB** | **43.15 dB** |
| **REGISTERED** | **Compressor** makeup asked for, honest vs shipped | **+31.17 vs +0.53 dB** | **+31.11 vs +0.76 dB** |
| **REGISTERED** | **Compressor** output peak, honest vs shipped (input −12.04 dBFS) | **−1.55 vs −11.51 dBFS** | **−0.63 vs −11.28 dBFS** |

The eleven bold rows are the eleven measured quantities; the italic rows are the same
quantities on the other shape, added here so the attribution is checkable rather than asserted.
The two end-to-end NR rows and the "left unused" row are read over the same span on both shapes
(the last 0.7 s to the last 0.1 s of the take, clear of the final phrase); an earlier
registered-shape-only pass over a wider tail span read 5.35 / 10.36 dB at 8 kHz and 2.91 /
11.30 dB at 44.1, which is why the comparable pass is the one quoted.

**Correction (micro-fix).** The first version of this file left six of the eleven rows
unlabelled and its Verdict prose attributed the print-dilution figures **6.79 / 13.82 dB** to
the REGISTERED shape. Those are the **ADDED** shape's numbers; the registered shape reads
**6.71 / 13.80 dB**. The claim they were supporting — that the registered shape alone puts NR
over its 1.0 dB bound — is unaffected and remains true by a factor of 6.7 and 13.8.

## Verdict

**`deriveNoiseReduction` — over the bound by 5–8× on the output, on BOTH shapes. FIXED.**
4.69 / 8.34 dB of its 12 dB left unused on the ADDED ordinary take, 5.08 / 8.33 dB on the
REGISTERED one — the verdict does not depend on which is read. Its print *is* the window's
magnitude spectrum, so a window mostly made of exact zeros describes the zeros rather than
the room and the stage does its 12 dB job at a third to a half depth. It now asks for
`rejectMostlySilentWindows` — the mechanism the gate, Remove Silence and
`wordSplice.trimSilence` already use — and declines when no half-second of real material
exists. Kept as behaviour in `the print, when the take carries digital silence beside an uneven
floor` (`src/services/vocalChain.test.ts`), converse and null case fixtured beside it.

**`deriveCompressor` — NOT changed, and the measurement is why.** Its window is neither a
threshold nor a print: it is the sounding/silent boundary for a MEDIAN, and a median is decided
by the middle of a distribution rather than its edge — hence 0.021 dB on the ADDED take, which
has programme in it. On the REGISTERED 90 %-room-tone shape the prescribed fix is worse: the
+24 dB parameter clamp breaks by 7 dB the makeup identity the design rests on, and the peak is
driven into the limiter. The shipped path's error direction is *do less*, which is the
fail-safe direction; the three siblings were moved because their errors delete material or
corrupt a print. **This is a disclosed departure from the decision rule above** — the rule was
written before the harm of its own prescription was measurable. Both halves are kept as
falsifiable tests in `the noise window this stage does NOT ask to be honest, and why`, and the
`deriveCompressor` docblock carries the numbers.
