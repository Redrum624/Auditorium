# Auditorium

![Auditorium](docs/screenshot.png)

![Spectral view](docs/screenshot-spectral.png)

*Spectral frequency display (log scale)*

Auditorium is a free, Audition-class desktop audio editor for Windows, built on
Electron and React. It does destructive waveform editing and spectral-frequency
editing, ships 22 built-in effects, spectral noise reduction, microphone
recording, a multitrack editor with sessions and mixdown, and tempo detection,
tempo matching and auto-remix — all processing runs locally with pure-TypeScript
DSP, no cloud and no account.

## Install

### From a release (recommended)

Once the repository is published, download **`Auditorium Setup <version>.exe`**
from the project's GitHub **Releases** page and run it. The installer is an NSIS
wizard:

1. Run `Auditorium Setup <version>.exe`.
2. Choose an install location (the wizard lets you change the default).
3. Finish — a desktop shortcut named **Auditorium** is created. Launch it from
   the shortcut or the Start menu.

A plain-text `Auditorium <version> README.txt` ships next to the installer.

### Build from source

Prerequisites: [Node.js](https://nodejs.org/) 20+ and Git on Windows x64.

```bash
git clone <repository-url> auditorium
cd auditorium
npm install
npm run build:win
```

The versioned installer is written to `release/Auditorium Setup <version>.exe`
(with its `README.txt` beside it). To run the app unpackaged during development,
use `npm run dev`.

## Modules

- **Waveform Editor** — the default per-sample amplitude view with zoom, scroll, selection, cursor, and playhead.
- **Spectral Frequency Display** — an off-main-thread spectrogram (logarithmic frequency axis by default, toggleable to linear, inferno color map, HiDPI-rendered) of the active document.
- **Multitrack Editor** — a session timeline of tracks and clips with per-track volume/pan/mute/solo/arm and draggable, trimmable clips.
- **Recorder** — a record dialog with input-device selection, channel/sample-rate choice, and a live input-level meter.
- **Effects Rack** — a categorized effects panel and menu; each effect opens a parameter dialog with a preview before applying.
- **Files Panel** — the left-sidebar list of open documents with name, dirty marker, duration, and sample rate.
- **History Panel** — the active document's undo history; click any entry to jump the document to that state.
- **Markers Panel** — the active document's marker list with jump-to, inline rename, and delete.
- **Properties Panel** — read-only facts about the active document or selected clip (path, rate, channels, bit depth, duration, selection, detected tempo).
- **Transport & Level Meters** — play/pause/stop, record, the view toggle, time readout, and output level meters.
- **Tempo Readout** — the status bar's `♩ BPM` and the Properties panel's Tempo row, showing the detected tempo with its confidence, a staleness marker, and ×2 / ÷2 buttons that re-track the beat grid at the corrected period.
- **Match Tempo Dialog** — source BPM (prefilled from the detection, re-detectable from the selection), target BPM or ratio, the stretch-quality band, and an optional beat-marker grid at the new tempo.
- **Auto-Remix Dialog & Remix Panel** — the dialog analyses the track and takes tempo/time-signature confirmation, phrase length, target length, crossfade, strictness and repeat options; the Remix panel is the fourth right-sidebar tab, listing one row per splice with a cost-coloured quality dot, Go To, ✕ Reject, 📌 Pin, ◂ ▸ Nudge, Re-roll and Revert to auto.

## Features

**Effects (22), grouped by category:**

- **Amplitude** — Amplify, Normalize, Fade.
- **EQ & Filters** — Parametric EQ, Graphic EQ.
- **Dynamics** — Compressor, Limiter, Noise Gate.
- **Delay & Reverb** — Echo, Reverb.
- **Modulation** — Chorus, Flanger.
- **Distortion** — Distortion.
- **Restoration** — Remove DC Offset, DeHum, Noise Reduction.
- **Stereo** — Channel Mixer, Pan.
- **Time & Pitch** — Time Stretch, Pitch Shift.
- **Utility** — Invert, Reverse.

**Editing & workflow:**

- Cut, copy, paste, and delete on sample-accurate `[start, end)` selections.
- Per-document undo/redo history, up to 50 steps within an 800 MB per-document memory budget (oldest step evicted once either limit is hit), browsable in the History panel; marker add/rename/delete are undoable too (`Add Marker`/`Rename Marker`/`Delete Marker`).
- Selection by click-drag, double-click (select all), shift-click (extend), `Ctrl+A`, and `Escape` to clear.
- Zoom and scroll on both the waveform and spectral views (mouse wheel), sharing one cursor/selection/playhead.
- Session markers: drop with `M`, rename inline, jump to next/previous, list in the Markers panel. Markers persist to disk in every supported container: `.wav` (cue/adtl chunks, Unicode names), `.mp3` (ID3v2.3 chapter frames), `.flac` (VORBIS_COMMENT chapter tags), `.ogg` (OpusTags chapter comments), and `.audm` sessions — sample-accurate on reopen. Destructive edits (delete, paste, trim, replace, sample-rate conversion, length-changing effects) remap or drop marker positions along with the audio, clamped to the document length.
- **Convert Sample Rate / Convert Channels**: `Edit → Convert Sample Rate…` resamples the whole document to a chosen rate (22050/44100/48000/96000 Hz), rescaling markers in lockstep; `Edit → Convert Channels…` converts Mono ↔ Stereo. Both are undoable.
- Loop-playback toggle on the transport bar (`transport.toggleLoop`).
- **Noise-print workflow**: capture a noise print from a selection, then Noise Reduction subtracts it from the target region.
- Recording device selection, channel count, and sample rate in the record dialog.
- **Export**: WAV at 16-bit, 24-bit, or 32-bit float; FLAC (16-bit, lossless); MP3 at 128/192/256/320 kbps (CBR); OGG (Opus) at 96/128/192 kbps.
- **Format-faithful Save**: Save re-encodes in place into the source container — WAV (32-bit float; the document's bit-depth metadata is retagged to 32-bit float afterward so Properties reports the truth about the file on disk), MP3 (192 kbps), FLAC (16-bit or 24-bit, rounded up from the source depth — a 20-bit source saves as 24-bit, never truncated), or OGG (Opus-in-Ogg, 128 kbps). The Properties panel reports the source file's bit depth ("16-bit source → 32-bit float"). If WebCodecs is unavailable, an in-place OGG Save falls back to Save As WAV. Save As always writes WAV and replaces the source extension in the suggested name (`song.mp3` → `song.wav`).
- **Atomic in-place saves**: every in-place Save writes to a sibling temp file and only replaces the original once the write completes, so an interrupted or failed save can't corrupt or truncate the file on disk.
- **OGG (Opus) export and save**: a pure-TypeScript, RFC 3533/7845-conformant Ogg muxer pairs with the host's WebCodecs `AudioEncoder` — legacy Ogg Vorbis sources re-encode as Opus (not round-tripped as Vorbis).
- **Native-rate WebM and AAC (ADTS) import**: container-header sniffing now also covers WebM/Matroska (EBML), raw ADTS/AAC, and 64-bit (largesize) MP4 boxes, so these keep their native sample rate on open instead of falling back to 48000 Hz.
- **Marker persistence in every format**: WAV cue/adtl (UTF-8 label fallback for non-Latin names), MP3 ID3v2.3 CTOC/CHAP chapters, FLAC and OGG vorbis-comment `CHAPTERxxx` tags (readable by chapter-aware players; support varies by player and container) — each alongside a sample-accurate private tag so markers reopen exactly where they were dropped.
- **Spectral log/linear toggle**: the Spectral Frequency Display's frequency axis switches between logarithmic (default) and linear scaling.
- **Multitrack punch-in recording**: arm one or more tracks with their **R** toggle, position the multitrack cursor, then press **Record** — the take lands as a clip on every track that was armed when it started.
- **Sessions**: save/open multitrack sessions as `.audm` (format v3 — a binary layout with no size-limited base64 encoding, so Save Session no longer fails silently on large embedded audio; older v1/v2 session files still open), and mix down a whole session to a new stereo document.
- **Tempo detection**: `Effects → Detect Tempo` runs a shared off-thread beat-tracking pass (log-band spectral-flux onsets → harmonic-comb tempo estimate → Ellis dynamic-programming beat tracking → sample-accurate refinement) and reports the BPM plus a confidence score in the status bar and the Properties panel. The beats are tracked, not extrapolated, so the grid follows a drifting take; ×2 / ÷2 buttons re-track at the corrected period when the octave is wrong. Whole-document analysis is capped at 10 minutes and flags the result as truncated past that.
- **Match Tempo**: `Effects → Match Tempo…` retargets a selection (or the whole document) from a source BPM to a target BPM or a plain ratio through the WSOLA time stretch, showing whether the resulting stretch is transparent, good, or extreme, and optionally laying down a beat-marker grid at the new tempo as its own undo step.
- **Auto-Remix**: `Edit → Auto-Remix…` re-arranges a track's own bars to reach a requested length and writes the result to a new `Remix N` document, leaving the source untouched. Bar boundaries come from the tracked beats; each boundary is described by timbre, chroma, loudness and local rhythm and clustered into sections, and a 2-D lattice dynamic program picks the cheapest phrase-congruent arrangement (Φ = 8 bars by default) reaching the target. Joins are micro-aligned by ±10 ms cross-correlation and crossfaded with a power-preserving, length-neutral gain law. The Remix panel then lets you reject, pin, or nudge any individual splice, re-roll the whole arrangement, or revert to the automatic one — every adjustment undoable from the History panel.
- Keyboard shortcuts throughout — see [`KEYBOARD_SHORTCUTS.md`](KEYBOARD_SHORTCUTS.md) for the full table.

See the [User Guide](docs/USER_GUIDE.md) for a full walkthrough and
[Known Limitations](docs/KNOWN_LIMITATIONS.md) for where Auditorium deliberately
differs from Adobe Audition.

## Architecture

The **Electron main process** owns all OS access and is hardened: every
`BrowserWindow` runs with `contextIsolation`, `sandbox`, and `nodeIntegration:
false`, and a preload whitelist exposes only a typed `window.electronAPI` over
IPC. File writes pass through a fail-closed write-path policy, and the renderer
never touches `fs`/`path` — file bytes travel over IPC as `ArrayBuffer`s.

The **renderer** is React plus canvas. Zustand holds the app state (documents,
selection, zoom, playback, markers); the waveform, spectrogram, and multitrack
views draw to `<canvas>` for interactive, sample-accurate rendering of large
buffers.

The **DSP** is pure, synchronous TypeScript — each effect is a `process()` that
takes and returns `Float32Array` channels and never mutates its input. Heavy
work (effects and spectrogram computation) runs in Web Workers so the UI stays
responsive; the same effect registry is imported by both the app and the worker.

## License

[MIT](LICENSE) © 2026 Auditorium contributors.
