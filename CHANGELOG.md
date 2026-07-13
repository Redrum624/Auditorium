# Changelog

All notable changes to Auditorium are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - TBD

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
