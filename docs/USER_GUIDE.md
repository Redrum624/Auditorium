# Auditorium User Guide

Auditorium is a desktop audio editor (Electron + React) inspired by Adobe
Audition. This guide walks through the app as it actually behaves — every
section below matches shipped UI, not a plan. For behavior that deliberately
differs from Adobe Audition, see [`KNOWN_LIMITATIONS.md`](KNOWN_LIMITATIONS.md).

## Getting Started

### Opening a file

**File → Open…** (`Ctrl+O`) opens a native file picker. Supported formats:
`.wav`, `.mp3`, `.ogg`, `.flac`, `.m4a`, `.aac`, `.webm`. WAV files are decoded
exactly, at their original sample rate. Every other format is decoded through
the browser's Web Audio API and always lands at **48000 Hz** regardless of its
source rate (see Known Limitations) and is truncated to two channels if it has
more.

### Creating a new file

**File → New…** (`Ctrl+N`) opens a dialog to pick a sample rate (default
44100 Hz) and channel count (Mono or Stereo, default Stereo) and creates a
blank document of a chosen length.

### Recording

The **Record** button on the transport bar opens the Record dialog: pick an
input device, channel count, and sample rate, watch the live input level
meter, then start/stop. A finished recording is added to the Files panel as a
new document — it does not record into a multitrack track (see Known
Limitations).

### The Files panel (left sidebar)

Every open document is listed with its name (a trailing `*` means unsaved
changes), duration, and sample rate. Click a row to make it active; hover and
click the ✕ to close it (you'll be prompted to save if it's dirty).

## Editing

### Selection

Click-drag on the waveform/spectral canvas to select a region (samples are
the underlying unit; the UI always displays formatted time). Double-click
selects the entire document. Shift+click extends the selection from the
current cursor. `Ctrl+A` selects all; `Escape` clears the selection.

### Cut / Copy / Paste / Delete

Standard editing acts on the current selection: `Ctrl+X` cut, `Ctrl+C` copy,
`Ctrl+V` paste at the cursor, `Delete` removes the selection. Undo/redo
(`Ctrl+Z` / `Ctrl+Y` or `Ctrl+Shift+Z`) keeps up to 50 steps per file (oldest
dropped beyond that) and is tracked per document — the **History** tab in the
right sidebar lists every applied edit; click any entry to jump the
document's state to that point.

### Markers

Press `M` (or **Edit → Add Marker**) to drop a marker named `Marker N` at the
current cursor position. The **Markers** tab in the right sidebar lists every
marker on the active document: click a marker's **time** to move the cursor
there and re-center the view around it; double-click a marker's name to
rename it inline (`Enter` or clicking away commits, `Escape` cancels); the ✕
button removes it. **Edit → Next Marker** / **Previous Marker** jump the
cursor to the closest marker after/before it (no wraparound). On the waveform
and spectral canvases, each marker draws as a small orange triangle flag with
a dashed vertical line through the full height of the view, with its name
labeled next to the flag when there's enough horizontal room. Markers are
**session-only** — they are not saved into any file (see Known Limitations).

### The right sidebar (History | Markers | Properties)

The right sidebar is a three-tab strip; **History** is the default tab.

- **History** — the active document's undo history (see *Cut / Copy / Paste /
  Delete* above).
- **Markers** — the active document's marker list (see *Markers* above).
- **Properties** — read-only facts about what you're working on. In the
  waveform/spectral views it shows the active document's name, path (`—` for
  never-saved documents), sample rate, channels (Mono/Stereo), bit depth
  (always `32-bit float (internal)` — all audio is held in memory as 32-bit
  float; the original file's bit depth isn't tracked after import, see Known
  Limitations), duration, sample count, and whether it has unsaved changes —
  plus the selection's start/end/length while one exists. In the multitrack
  view it shows the selected clip's source document, track, start/offset/
  length, and an editable **Gain (dB)** field (−24..+24, committed on
  `Enter` or when the field loses focus).

## Effects

Effects live in the **Effects** panel (left sidebar), grouped by category, and
mirrored in the **Effects** menu. Double-click an effect (with a document
open) to open its parameter dialog, adjust settings, and apply. Every effect
processes the current selection, or the whole document when there's no
selection.

- **Amplitude** — Amplify (gain in dB), Fade (in/out, linear/exponential/
  cosine curve), Normalize (peak or RMS target level)
- **EQ & Filters** — Parametric EQ, Graphic EQ
- **Dynamics** — Compressor, Limiter, Noise Gate
- **Delay & Reverb** — Echo, Reverb
- **Modulation** — Chorus, Flanger
- **Distortion** — Distortion
- **Restoration** — Remove DC Offset, DeHum, Noise Reduction
- **Stereo** — Channel Mixer, Pan
- **Time & Pitch** — Time Stretch, Pitch Shift
- **Utility** — Invert, Reverse

### Noise Reduction (capture → apply flow)

Noise Reduction needs a noise *print* before it can run:

1. Select a region that contains only the noise you want to remove (e.g. a
   room-tone gap).
2. **Effects → Capture Noise Print** (only enabled with a selection). This
   averages the STFT magnitude spectrum of the selected region, per channel,
   and stores it in memory.
3. Open **Effects → Restoration → Noise Reduction**, adjust Reduction (dB),
   Sensitivity, and Smoothing, and apply to the region you actually want
   cleaned (the capture and the apply regions can differ).

The captured print is in-memory only: it is not saved with the document and
is cleared when you capture a new one.

## Views

Switch between views from the transport bar's view toggle or **View** menu:

- **Waveform** — the default per-sample amplitude view, with zoom (mouse
  wheel) and scroll.
- **Spectral** — a spectrogram (logarithmic frequency axis by default,
  −90..0 dB range, inferno-style color map, rendered at full device-pixel
  resolution) of the mono mix of the active document, computed off the main
  thread. Toggle to a linear axis via **View → Spectral: Toggle Log/Linear
  Scale**.

Both views share the same selection, cursor, playhead, and marker overlays,
and the same zoom/scroll gestures.

## Multitrack

**View → Multitrack** opens the session editor — it works even with no
document open. A session has a name, a sample rate, and any number of tracks.

- **Tracks**: each has a name (double-click to rename), Mute/Solo/Arm toggles,
  a volume slider (−60..+12 dB) and a pan slider (−1..1). **Add Track** adds
  an empty track. Track arm (R) is currently visual-only — see Known
  Limitations.
- **Clips**: **Edit → Insert Active File at Cursor** places the whole active
  document as a clip on the selected (or first) track at the multitrack
  cursor. Drag a clip to move it (it snaps forward past overlaps rather than
  overlapping); drag its edges to trim. Click a clip to select it — its facts
  (source document, start/offset/length, and an editable gain in dB) appear
  in the **Properties** tab.
- **Playback**: the multitrack view has its own transport, cursor, and
  playhead, driven by the same transport bar buttons. There is no pause in
  multitrack playback (v1) — Play/Pause toggles play↔stop. Volume, pan, and
  mute/solo changes apply **live while playing** — the realtime monitor uses the
  same pan law as Mix Down, so it matches the render. Clip moves, trims, and clip
  gain take effect on the next play.
- **Mix Down**: **File → Mix Down to New File** renders the whole session
  offline to a new stereo document (added to the Files panel), respecting
  mute/solo/volume/pan/gain.
- **Sessions**: **File → Save Session…** / **Open Session…** persist the
  session (tracks, clips, and their source document references) to a `.audm`
  file.

An empty session (no clips on any track) shows an inline hint pointing at
Insert Active File; the main editor area shows "Open an audio file (Ctrl+O)
or create a new one (Ctrl+N)" when no document is open in the waveform/
spectral views.

## Export

**File → Export…** (`Ctrl+E`) renders the active document to a new file
without changing the open document's path or dirty state:

- **WAV**: 16-bit, 24-bit, or 32-bit float.
- **MP3**: 128/192/256/320 kbps (constant bitrate only — see Known
  Limitations for the VBR gap).

**File → Save** (`Ctrl+S`) / **Save As…** always writes WAV (32-bit float);
see Known Limitations for how this interacts with non-WAV sources.

## Shortcuts reference

See [`KEYBOARD_SHORTCUTS.md`](../KEYBOARD_SHORTCUTS.md) at the repo root for
the full, exact table (transcribed from `src/services/shortcuts.ts`).
