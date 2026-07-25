# Changelog

All notable changes to Auditorium are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.4.0] - 2026-07-25

Integrity release. A seven-dimension audit of the v1.3 codebase produced 18 independently verified defects; all are fixed here, three of them data-loss class. Every finding below was double-verified (one reviewer trying to refute it, one judging real-world impact) before being scheduled.

### Fixed

- **Marker work was silently discarded on close.** Cause: marker add/rename/delete mutated only the marker map and never touched the document, while every loss gate (the close prompt, the quit guard's dirty count, the Files-panel `*`, and the async-save staleness check) keys on the document's dirty flag — so an hour of annotation on an otherwise-unedited file closed with no prompt at all, and the UI actively reported "nothing unsaved". Fix: marker mutations now replace the owning document with `dirty: true`, which repairs all four gates at once. Affects: `src/stores/appStore.ts`.
- **A failed or interrupted Save destroyed the original file.** Cause: `file:write` did a single `fs.writeFile` over the destination, which truncates on open — so a write that failed partway (disk full, removable drive pulled, quit mid-write) left the user's source file a truncated fragment while the error dialog implied the disk copy was intact. Fix: writes now go to a sibling temp file, are fsynced and closed, then renamed over the target; any failure unlinks the temp and leaves the original byte-for-byte untouched. Affects: `electron/atomicWrite.cjs`, `electron/ipc.cjs`.
- **Save Session failed silently on sessions over roughly 17 minutes of audio.** Cause: the `.audm` writer built one base64 string of the entire embedded audio, exceeding V8's maximum string length; the exception propagated to an uncaught click handler, so no file was written and no error appeared — and because Save Session had no success feedback either, success and failure were indistinguishable. Fix: `.audm` format v3 assembles a binary buffer directly (`AUDM3\n` magic + JSON header + raw Float32 payload), which removes the ceiling and base64's 33% overhead; save and open now report failure explicitly and success visibly. v1/v2 sessions still load. Affects: `src/multitrack/sessionFile.ts`.
- **Markers didn't follow destructive edits.** Cause: `applyEdit` — the single write path for destructive edits — never touched markers, so deleting or inserting audio left every later marker labelling the wrong sound, and sample-rate conversion left them on the old clock. Saved files could carry cue points past end-of-file, which reopening then clamped, making the corruption permanent. Fix: delete/insert/replace/trim shift or drop markers, sample-rate conversion rescales them, and length-changing effects (Time Stretch, Pitch Shift) map interior markers proportionally — all inside the same undo step as the audio change, always clamped to the document length. Affects: `src/services/editOps.ts`, `src/services/documentTools.ts`, `src/services/effectRunner.ts`.
- **Ctrl+Z after adding a marker reverted the previous audio edit instead.** Cause: marker operations never created undo entries, so undo silently targeted the last audio edit. Fix: marker add/rename/delete push labelled undo entries (`Add Marker` / `Rename Marker` / `Delete Marker`) visible in the History panel. Affects: `src/services/undoHistory.ts`, `src/services/menuActions.ts`, `src/components/Panels/MarkersPanel.tsx`.
- **Undo after Save reported the document as clean.** Cause: undo entries snapshotted the dirty flag as it was at edit time, so undoing past a save restored `dirty: false` while the audio in memory no longer matched the file on disk — closing then discarded the difference with no prompt. Fix: dirty is now derived from the undo position relative to a save point rather than restored from a snapshot. Affects: `src/services/undoHistory.ts`.
- **MP3 marker positions were wrong whenever the encoder changed the sample rate.** Cause: markers were written at the document's rate, but the MP3 encoder silently resamples (a 96 kHz document produces a 48 kHz file), so every marker landed at double its time and piled up at end-of-file. An initial fix mirrored the encoder's rate-selection logic and was still measurably wrong by 8–27% for non-standard rates such as 22254 Hz (classic Mac) and 8012 Hz (telephony), which the app can reach because it preserves native import rates. Fix: the true output rate is now read from the encoded MPEG frame header, which is correct by construction for every rate and bitrate. Affects: `src/audio/mp3Encoder.ts`.
- **FLAC files declared spec-invalid block sizes.** Cause: STREAMINFO's minimum/maximum block size included the final partial frame, contradicting the fixed-blocksize strategy the frames themselves declare, and streams under 16 samples produced a maximum below the spec floor that ffmpeg and Chromium reject — Auditorium could not reopen its own file. Fix: block sizes now follow RFC 9639/libFLAC (last partial frame excluded, floored at 16). Affects: `src/audio/flacEncoder.ts`.
- **Global shortcuts stayed live under modal dialogs.** Cause: the keydown handler skipped only text inputs, so Ctrl+O behind an open Export dialog switched the active document and Export then wrote the wrong file; Escape also closed every stacked dialog at once. Fix: a dialog stack gates the shortcut handler and scopes Escape to the topmost dialog. Affects: `src/services/shortcuts.ts`, `src/services/dialogBus.ts`, `src/components/Dialogs/DialogShell.tsx`.
- **Dismissing an effect dialog mid-preview left the preview playing**, with the shared player still holding the throwaway processed snippet, so the next Play produced audio that didn't match the waveform. Fix: closing the dialog by any route (Escape, backdrop, Cancel, Apply) stops the preview and reloads the real document. Affects: `src/components/Dialogs/EffectDialog.tsx`.
- **Escape or a stray backdrop click discarded an in-progress recording** with no confirmation. Fix: while recording, only the explicit Stop and Close buttons dismiss the dialog. Affects: `src/components/Dialogs/RecordDialog.tsx`.
- **Quitting while the app was busy discarded unsaved work without asking.** Cause: the close guard destroyed the window unconditionally 2 s after an unanswered close request, without distinguishing a crashed renderer from one merely busy in a long synchronous encode. Fix: the guard now asks before quitting when the renderer is alive, and the reply reports in-flight saves as well as unsaved documents. Affects: `electron/closeGuard.cjs`, `src/App.tsx`.
- **Saving while playing stopped playback and re-copied the whole audio buffer.** Cause: the transport reloaded the engine on any document-object change, including metadata-only ones — which, after the marker fix above, would have meant every marker drop restarting playback. Fix: the reload keys on the fields that actually invalidate the buffer. Affects: `src/components/Layout/TransportBar.tsx`.
- **Memory grew without bound in three places**: undo history capped step count but not bytes (50 snapshots of a long file is gigabytes), the player kept the last closed document's full buffer for the session, and the spectrogram mixed down the entire document on every zoom or scroll instead of the visible window. Fix: an 800 MB per-document undo budget charged by the audio each step actually pins, a `unload()` on close, and viewport-only spectrogram processing. Affects: `src/services/undoHistory.ts`, `src/audio/PlaybackEngine.ts`, `src/components/Editor/SpectrogramView.tsx`.
- Saving to a network share failed after opening from one (UNC paths were refused for writes while allowed for reads); a DSP worker that failed to load hung the Apply promise forever; the recorder retained the previous take's raw buffers; corrupt WAV cue chunks and hostile session metadata produced raw type errors rather than clear messages. Affects: `electron/writePathPolicy.cjs`, `src/services/effectRunner.ts`, `src/audio/RecordingEngine.ts`, `src/multitrack/sessionFile.ts`.

### Changed

- In-place WAV Save retags the document's bit depth to 32-bit float, so Properties describes the file that is actually on disk; Save As replaces the source extension in the suggested name (`song.mp3` → `song.wav`, previously `song.mp3.wav`) and enforces `.wav` on the chosen path.
- In-place FLAC Save rounds bit depth up rather than down — a 20-bit source now saves as 24-bit instead of being truncated to 16-bit.
- MP3 chapter interop frames cap at the first 255 markers (the private exact-position tag still carries all of them), so the chapter table can no longer declare a count it doesn't contain.
- Write-path policy: genuine network shares (`\\server\share\...`) are now allowed, while local-alias and administrative shares (`\\localhost\C$`, `\\...\ADMIN$`, any `$`-suffixed share) and extended-length/device paths are refused. Test and dev-server entry points are additionally gated on the build being unpackaged.
- Documentation corrected against the code: the user guide had claimed since v1.3 that MP3 and FLAC markers don't survive a save (they have since v1.3), and both the guide and README described FLAC in-place save as "verbatim at the source bit depth" when it rounds to 16 or 24.

## [1.3.0] - 2026-07-22

### Added

- Marker persistence in **every** container, not just WAV. Why: v1.2 could only persist markers in `.wav` and `.audm` sessions; MP3/FLAC/OGG were documented as container-inherent gaps — but published standards exist for all three. MP3 now writes an ID3v2.3 tag with chapter frames (`CTOC` + one `CHAP` per marker with an embedded UTF-16 `TIT2` title — the podcast-chapters standard) prepended to the encoded stream; FLAC inserts a `VORBIS_COMMENT` metadata block and OGG (Opus) extends its OpusTags header, both carrying de-facto-standard `CHAPTERxxx`/`CHAPTERxxxNAME` tags (readable by chapter-aware players; support varies by player and container). Every format also embeds a private `AUDITORIUM_MARKERS` tag with exact sample offsets, so reopening in Auditorium is sample-accurate even though the interop chapter fields are millisecond-granular. Opening an MP3/FLAC/OGG with chapters — including files tagged by other tools (ID3v2.3 and v2.4, all text encodings) — seeds the marker list. Files saved with zero markers remain byte-identical to v1.2.1 output. How to use: nothing new — drop markers with `M` and Save/Export as before.
- Unicode WAV marker names. Why: `labl` text was written as Latin-1, corrupting CJK/emoji names on WAV save. Now a file whose marker names all fit Latin-1 is written exactly as before (byte-identical), and any file needing more switches all its labels to UTF-8 (Audacity's convention); reading tries strict UTF-8 first and falls back to Latin-1 for legacy files. Affects: `src/audio/wavCodec.ts`.
- 64-bit (largesize) MP4 box sniffing. Why: MP4/M4A files using `size == 1` extended boxes fell back to 48 kHz decode; the box walk now reads the 64-bit size (bounds-checked in the BigInt domain) and version-1 `mdhd` headers are covered by a pinned test. Affects: `src/audio/sniffSampleRate.ts`.

### Changed

- `docs/KNOWN_LIMITATIONS.md`: marker persistence is resolved for all containers; the only remaining notes are interop granularity (ms in standard chapter fields), lossy-format generation loss, genuinely unrecognized containers, and the >2-channel downmix law.

## [1.2.1] - 2026-07-22

### Fixed

- Editing during an in-place `.ogg` save could be silently lost. Cause: `.ogg` is the only asynchronous encode path (WebCodecs), and `saveDocument` wrote its pre-encode snapshot back into the store with `dirty: false` after the await — an edit made while the encoder ran was clobbered by the stale snapshot and marked saved. Fix: after the await, the store is updated only if the live document is still the exact pre-save snapshot (reference equality — every edit produces a fresh document object); otherwise the newer edit is kept and the document stays dirty, matching "save, then edit" semantics. A per-document in-flight guard also prevents a second concurrent Save from interleaving file writes ("Save in progress" notice). Affects: `src/services/fileService.ts`.
- Unexpected OGG encoder errors were invisible to the user. Cause: `saveDocument` and `exportDocument` only handled the typed `OggEncoderUnavailableError` (save-as-WAV fallback); any other encoder rejection (e.g. a WebCodecs `DOMException`) propagated as an unhandled rejection with no dialog. Fix: non-typed encode errors now surface through the same error message box already used for file-write failures, and the document stays dirty. Affects: `src/services/fileService.ts`.
- Corrupt WAV files could produce spurious markers. Cause: the `cue ` chunk decoder bounded its reads by the end of the file buffer instead of the chunk's declared size, so a corrupt `numCuePoints` let it interpret bytes of the following chunks as cue points. Fix: cue-point reads are clamped to the declared chunk size (mirroring the existing `LIST/adtl` clamp) and the iteration count is capped by what the chunk can actually hold; malformed files parse what fits and never throw. Affects: `src/audio/wavCodec.ts`.

### Changed

- WebM sniffing test coverage: added fixtures for sibling-element skipping at every EBML walk level, a leading video track followed by an audio track, and two audio tracks (first wins — pinned); removed the dead `unknownSize` field. No production behavior change. Affects: `src/audio/sniffSampleRate.ts`.

## [1.2.0] - 2026-07-19

### Added

- Marker persistence: markers now survive to disk. `.wav` files carry a standard `cue `/`LIST`-`adtl` chunk pair (one cue point + one labeled `labl` per marker), written on in-place Save, Save As, and WAV Export, and read back on Open — so markers round-trip through the file, not just the session. `.audm` sessions (`formatVersion: 2`) additionally embed a `markers` map for every document referenced by a clip; v1 session files still load (with zero markers). Why: v1's markers were session-only and vanished on close, forcing users to re-annotate every reopen. How to use: drop markers with `M` as before — Save/Save As/Export a `.wav`, or save a session, and they persist automatically.
- OGG (Opus) export and format-faithful save: File > Export gains **OGG (Opus)** at 96/128/192 kbps, and a document opened from `.ogg` now keeps its path and re-encodes in place as Opus-in-Ogg on Save (128 kbps), matching the existing WAV/MP3/FLAC format-faithful behavior. Implemented as a pure-TypeScript, RFC 3533/7845-conformant Ogg page muxer (`src/audio/oggPage.ts`) feeding packets from the host's WebCodecs `AudioEncoder`. Legacy Ogg Vorbis sources are re-encoded as Opus (a modern, universally decodable codec) rather than round-tripped as Vorbis. If WebCodecs is unavailable, in-place Save falls back to the save-as-WAV dialog and Export reports an error instead of writing a broken file. Why: v1.1 could only open `.ogg` and re-save it as WAV, losing the original container. How to use: File > Export > OGG (Opus), or open an `.ogg` file and press Save.
- Native-rate import for WebM and raw AAC (ADTS): `sniffSampleRate` now also parses WebM/Matroska (a bounded EBML walk down to `Segment → Tracks → TrackEntry → Audio → SamplingFrequency`, with Opus tracks fixed at 48000 Hz regardless of the stored value) and ADTS/AAC frame headers (`sampling_frequency_index`, requiring two consecutive valid frames before trusting a sync). Why: these two containers previously fell through to the 48000 Hz fallback even when their real rate was readable. How to use: nothing to do — opening a `.webm` or raw `.aac` file now keeps its native rate automatically.

### Fixed

- Intermediate Ogg page granule positions overstated decoder-output position by the pre-skip amount. Cause: the muxer added `preSkip` to every audio page's cumulative granule instead of only the final (trimmed) page, so a strict RFC 7845 validator would see granules exceed the true decoder-output count on non-final pages. Fix: intermediate pages now carry the exact cumulative 48 kHz decoder-output count (`packetIndex × 960`); only the final page's granule is `preSkip + totalSamples`, matching the spec. Affects: `src/audio/oggPage.ts` (`muxOpusStream`).

### Changed

- `docs/KNOWN_LIMITATIONS.md`: all three v1.1-era gaps (unsniffable-container fallback, Ogg round-tripping as WAV, session-only markers) are now resolved or narrowed to their genuinely-remaining edges — see the file for exact current behavior.

## [1.1.0] - 2026-07-14

### Added

- Multitrack punch-in recording: arm tracks (R), position the cursor, and Record — the take lands as a clip on every armed track. Why: the arm flag was visual-only in v1.0. How to use: multitrack view → R on a track → Record.
- FLAC support: lossless FLAC export (16-bit) and format-faithful in-place Save for documents opened from `.flac` (16/24-bit verbatim-subframe encoder validated against Chromium's decoder) and `.mp3` (re-encoded at 192 kbps).
- Source bit depth: Properties shows "N-bit source → 32-bit float" for WAV/FLAC documents.
- Spectral display: logarithmic frequency axis by default (View > Spectral: Toggle Log/Linear Scale), rendered at native HiDPI resolution.
- Native quit guard: closing the window with unsaved changes asks for confirmation (replaces the best-effort in-page guard).

### Changed

- Paste now resamples clipboard audio to the destination document's rate (pitch/duration preserved). Cause: v1.0 inserted raw samples across rate mismatches.
- Non-WAV imports keep their native sample rate via container-header sniffing (MP3/FLAC/OGG/M4A; unsniffable containers fall back to 48 kHz). >2-channel content is downmixed to stereo (−3 dB blend) instead of truncated.
- Time Stretch / Pitch Shift use stereo-linked WSOLA (one similarity search on the mid signal drives both channels), keeping the stereo image phase-coherent.
- Multitrack volume/pan/mute/solo changes are now live during playback, and realtime monitoring uses the exact per-clip pan law of Mix Down (monitor matches render on all content).

### Fixed

- Spectrogram raster misalignment at fit-zoom. Cause: the minimum-hop clamp strode past the visible span when span/width < 128, painting the right side black. Fix: fractional stride spanning exactly [start, end). Affects: `src/workers/spectrogramCore.ts`.
- Multitrack recorder stop re-entrancy could double-commit a take (two docs + overlapping clips) on rapid stop triggers. Cause: async stop guard flipped after the engine flush. Fix: synchronous tri-state claim. Affects: `src/multitrack/multitrackRecord.ts`.
- Clip mini-waveforms are cached offscreen (bounded LRU, purged on clip/track/doc removal), cutting zoom-time redraw cost.

## [1.0.0] - 2026-07-13

### Added

- Waveform editor: per-sample amplitude view with zoom (mouse wheel) and scroll, selection, and playhead.
- Spectral frequency display: off-main-thread spectrogram (linear axis, inferno color map) of the active document.
- Multitrack editor: sessions with tracks (volume, pan, mute/solo/arm), draggable/trimmable clips, and per-clip gain.
- Recorder: input-device selection, live level meter, and capture into a new document.
- Effects rack (22 effects) with a parameter dialog: Amplify, Normalize, Fade, Parametric EQ, Graphic EQ, Compressor, Limiter, Noise Gate, Echo, Reverb, Chorus, Flanger, Distortion, Remove DC Offset, DeHum, Noise Reduction, Channel Mixer, Pan, Time Stretch, Pitch Shift, Invert, and Reverse.
- Noise Reduction workflow: capture a noise print from a selection, then subtract it from the target region.
- Editing: cut/copy/paste/delete on sample-accurate selections, with per-document undo/redo history.
- Markers: session markers with a list panel, rename, and next/previous navigation.
- File I/O: open WAV/MP3/OGG/FLAC/M4A/AAC/WebM; export WAV (16/24/32-bit float) and MP3 (128/192/256/320 kbps CBR).
- Sessions: save/open multitrack sessions as `.audm`, and mix down a session to a new stereo document.
- Packaging: Windows NSIS installer (electron-builder) with a generated app icon and a plain-text `README.txt`.
- Docs: user guide, keyboard-shortcuts reference, and known-limitations notes.
