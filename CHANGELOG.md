# Changelog

All notable changes to Auditorium are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
