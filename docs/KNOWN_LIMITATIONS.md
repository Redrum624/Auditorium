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

## Non-WAV imports are resampled to 48000 Hz

**Area:** File > Open (`src/audio/decodeAudio.ts` `decodeArrayBuffer`)

**v1 behavior:** WAV files are decoded by our own `decodeWav`, preserving the
exact samples and original sample rate. Every other format (mp3, ogg, flac,
m4a, aac, webm) is decoded through the Web Audio API's `decodeAudioData` on an
`OfflineAudioContext(1, 1, 48000)`. Chromium resamples `decodeAudioData` output
to the context's sample rate, so all non-WAV imports arrive at **48000 Hz**
regardless of their source rate. Audio with more than two channels is truncated
to the first two (L/R).

**Intended behavior:** Decode non-WAV sources at their native sample rate (or
resample deliberately) and support a proper channel down-mix. Requires a
format-aware decoder rather than the browser's fixed-rate `decodeAudioData`.

## Save always writes WAV; non-WAV sources become save-as

**Area:** File > Save / Save As (`src/services/fileService.ts` `saveDocument`,
`openFilePath`)

**v1 behavior:** The app only ever *writes* WAV (32-bit float). A document opened
from a non-WAV source keeps `filePath = null`, so the first Save opens a save-as
dialog defaulting to a `.wav` file rather than overwriting the original in its
source format. Documents opened from a `.wav` keep their path and Save writes
straight back. Re-encoding to MP3 (or any lossy format) is available only via
File > Export, which never changes the document's path or dirty state.

**Intended behavior:** Round-trip a file back to its original container/format on
Save (e.g. re-encode MP3 in place), gated on the format-aware encoder set.
