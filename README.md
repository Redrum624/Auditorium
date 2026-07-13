# Auditorium

<!-- Screenshot captured from the running app in Task 25 (release smoke). Until
     then docs/screenshot.png is a placeholder. -->
![Auditorium](docs/screenshot.png)

Auditorium is a free, Audition-class desktop audio editor for Windows, built on
Electron and React. It does destructive waveform editing and spectral-frequency
editing, ships 22 built-in effects, spectral noise reduction, microphone
recording, and a multitrack editor with sessions and mixdown — all processing
runs locally with pure-TypeScript DSP, no cloud and no account.

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
- **Spectral Frequency Display** — an off-main-thread spectrogram (linear frequency axis, inferno color map) of the active document.
- **Multitrack Editor** — a session timeline of tracks and clips with per-track volume/pan/mute/solo/arm and draggable, trimmable clips.
- **Recorder** — a record dialog with input-device selection, channel/sample-rate choice, and a live input-level meter.
- **Effects Rack** — a categorized effects panel and menu; each effect opens a parameter dialog with a preview before applying.
- **Files Panel** — the left-sidebar list of open documents with name, dirty marker, duration, and sample rate.
- **History Panel** — the active document's undo history; click any entry to jump the document to that state.
- **Markers Panel** — the active document's marker list with jump-to, inline rename, and delete.
- **Properties Panel** — read-only facts about the active document or selected clip (path, rate, channels, bit depth, duration, selection).
- **Transport & Level Meters** — play/pause/stop, record, the view toggle, time readout, and output level meters.

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
- Per-document undo/redo history, up to 50 steps, browsable in the History panel.
- Selection by click-drag, double-click (select all), shift-click (extend), `Ctrl+A`, and `Escape` to clear.
- Zoom and scroll on both the waveform and spectral views (mouse wheel), sharing one cursor/selection/playhead.
- Session markers: drop with `M`, rename inline, jump to next/previous, list in the Markers panel.
- **Noise-print workflow**: capture a noise print from a selection, then Noise Reduction subtracts it from the target region.
- Recording device selection, channel count, and sample rate in the record dialog.
- **Export**: WAV at 16-bit, 24-bit, or 32-bit float; MP3 at 128/192/256/320 kbps (CBR).
- **Sessions**: save/open multitrack sessions as `.audm`, and mix down a whole session to a new stereo document.
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
