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
destination document's sample rate on paste. The resampler exists (`src/dsp/resample.ts`);
`pasteAtCursor` should convert `clipboard.channels` from `clipboard.sampleRate`
to the destination `sampleRate` before inserting. Planned for v1.1.

## Non-WAV imports are resampled to 48000 Hz

**Area:** File > Open (`src/audio/decodeAudio.ts` `decodeArrayBuffer`)

**v1 behavior:** WAV files are decoded by our own `decodeWav`, preserving the
exact samples and original sample rate. Every other format (mp3, ogg, flac,
m4a, aac, webm) is decoded through the Web Audio API's `decodeAudioData` on an
`OfflineAudioContext(1, 1, 48000)`. Chromium resamples `decodeAudioData` output
to the context's sample rate, so all non-WAV imports arrive at **48000 Hz**
regardless of their source rate. Audio with more than two channels is truncated
to the first two (L/R). The original file's **source bit depth is not tracked
after import** either (for WAV or any other format) — all audio is held in
memory as 32-bit float (`Float32Array`), which is what the Properties panel's
"Bit Depth" row reports.

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

## Time Stretch / Pitch Shift process stereo channels independently

**Area:** Effects > Time & Pitch (`src/effects/pitch/TimeStretchEffect.ts`,
`src/effects/pitch/PitchShiftEffect.ts`, `src/dsp/wsola.ts`)

**v1 behavior:** WSOLA time stretch and the resample-based pitch shift run the
left and right channels through completely separate similarity searches. Each
channel independently picks the copy offset that best matches its own waveform,
so the two channels can pick different offsets at the same moment. Output
LENGTHS stay identical (same input length and factor produce the same
`round(N*ratio)`), but the fine-grained inter-channel PHASE relationship is not
preserved. On a strongly correlated stereo image (e.g. a mono-ish mix or a
hard-panned transient) this can cause subtle stereo-image widening or wander
during heavily stretched/shifted passages.

**Intended behavior:** Adobe Audition uses a stereo-linked WSOLA that derives a
single set of frame offsets from a combined mid (or max-correlation) detector
and applies it to both channels, keeping the stereo image phase-locked. Tracked
for a future pass — the DSP already centralizes the search in `wsola.ts`, so
linking is a matter of sharing the chosen offset across channels rather than
running the search twice.

## Spectral display uses a linear frequency axis

**Area:** View > Spectral Frequency Display (`src/workers/spectrogramCore.ts`,
`src/components/Editor/SpectrogramView.tsx`)

**v1 behavior:** Spectrogram rows map linearly to FFT bins
(`bin = row * (fftSize/2) / height`), so the vertical axis is linear in
frequency: the octaves below 1 kHz — where most musical detail lives — occupy
only a small strip at the bottom of the display, while the top half of the view
covers the comparatively sparse 10–22 kHz region. Rendering is also done at
device-pixel-ratio 1, so the raster is slightly soft on HiDPI screens.

**Intended behavior:** Adobe Audition defaults to a logarithmic frequency axis
(with linear as an option), which spreads low-frequency content across most of
the display. A log mapping only changes the row→bin function in
`spectrogramCore.ts`; the worker protocol and view are already agnostic to it.

## Multitrack parameter changes are not live during playback

**Area:** Multitrack > playback (`src/multitrack/MultitrackPlayer.ts`, `src/services/transportService.ts`)

**v1 behavior:** The realtime multitrack player builds its WebAudio graph once per
`play()` — volume, pan, mute/solo, clip gain, and clip geometry changes made while
playing do not affect the running audio. Stop and play again to hear them. Source
`AudioBuffer`s are also rebuilt on every `play()` (no cross-play cache).

**Intended behavior:** Bind track parameters to live `GainNode`/`StereoPannerNode`
AudioParams so slider moves are audible immediately, and cache per-document buffers
keyed on channel identity.

## Track arm (R) is visual-only — no multitrack recording

**Area:** Multitrack > TrackHeader (`src/components/Multitrack/TrackHeader.tsx`)

**v1 behavior:** The R toggle stores the `armed` flag but nothing consumes it.
Recording happens only via the single-file Record dialog (transport record button),
which creates a new document rather than recording into an armed track at the playhead.

**Intended behavior:** Audition-style punch-in recording onto armed tracks.

## Markers are session-only (not persisted)

**Area:** Markers (`src/stores/appStore.ts` `markers`, `src/components/Panels/MarkersPanel.tsx`,
`src/services/menuActions.ts` `marker.add`/`marker.next`/`marker.prev`)

**v1 behavior:** Markers live only in the in-memory app store (`markers: Record<docId, Marker[]>`),
keyed by document id. They are not written into `.wav`/`.mp3` exports (this app's
WAV/MP3 encoders have no marker/cue-chunk support), not round-tripped through
File > Save/Save As, and not included in a saved multitrack session (`.audm`,
`src/multitrack/sessionFile.ts`) even when the source document is inserted as a
clip. Closing a document also discards its markers (`closeDocument` deletes the
`markers[id]` entry). Reopening the same file later starts with zero markers.

**Intended behavior:** Adobe Audition persists markers with the file (a WAV
cue/label chunk, or its own metadata sidecar) and/or with the session. Doing
the same here needs either a WAV cue-chunk writer/reader or a marker section
in the `.audm` session format — neither exists yet.

## Realtime multitrack pan law differs slightly from mixdown

**Area:** Multitrack playback vs. Mix Down (`src/multitrack/MultitrackPlayer.ts` vs `src/multitrack/mixdown.ts`)

**v1 behavior:** Realtime monitoring pans through WebAudio `StereoPannerNode`
(equal-power for mono, its built-in stereo law), while the offline mixdown uses the
documented constant-power (mono) / balance (stereo) law. The rendered mixdown is
authoritative; monitoring can differ by a fraction of a dB on panned stereo tracks.

**Intended behavior:** Implement the mixdown pan law manually in the realtime graph
(per-channel gain nodes) so monitor and render match exactly.
