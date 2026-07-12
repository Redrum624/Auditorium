# Known Limitations

Tracked deviations from full Adobe Audition parity. Each entry names the area,
the current v1 behavior, and the intended future behavior.

## Paste across differing sample rates

**Area:** Edit > Paste (`src/services/editOps.ts` `pasteAtCursor`, `src/services/clipboard.ts`)

**v1 behavior:** The clipboard stores the copied audio at its source sample
rate. Pasting into a document with a different sample rate inserts the raw
samples as-is — no resampling — so the pasted region plays back at the
destination document's rate and its perceived pitch/duration shifts accordingly.

**Intended behavior:** Adobe Audition resamples clipboard audio to the
destination document's sample rate on paste. Once the resampler lands (Task 12),
`pasteAtCursor` should convert `clipboard.channels` from `clipboard.sampleRate`
to the destination `sampleRate` before inserting. Tracked for Task 23.
