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
the browser's Web Audio API; before decoding, Auditorium sniffs the container
header (MP3 frame sync, FLAC STREAMINFO, OGG Vorbis/Opus, MP4/M4A, WebM/Matroska
EBML, and raw ADTS/AAC frame headers) to recover the source sample rate, so the
import keeps its **native rate** whenever that header is readable — only
genuinely unsniffable/exotic containers fall back to **48000 Hz** (see Known
Limitations). Audio with more than two channels is **downmixed to stereo**, not
truncated: the extra channels are blended into both L and R at −3 dB rather
than discarded.

### Creating a new file

**File → New…** (`Ctrl+N`) opens a dialog to pick a sample rate (default
44100 Hz) and channel count (Mono or Stereo, default Stereo) and creates a
blank document of a chosen length.

### Recording

The **Record** button in the toolbar pill opens the Record dialog: pick an
input device, channel count, and sample rate, watch the live input level
meter, then start/stop. A finished recording is added to the Files panel as a
new document. To record straight into a session instead, see **Recording into
the multitrack** below.

### The Files panel

Open the Files card from the right-edge icon rail (the folder icon). Every
open document is listed with its name (a trailing `*` means unsaved
changes), duration, and sample rate. Click a row to make it active; hover and
click the ✕ to close it (you'll be prompted to save if it's dirty).

Closing the **app window** with unsaved changes is guarded natively: the app
counts your dirty documents and shows a confirmation ("N file(s) have unsaved
changes.") with **Quit** (discard everything and exit) and **Cancel** (keep
the app open). With no unsaved changes the window closes immediately. If the
app is still busy with a save or export when you try to close, it no longer
force-closes after a short timeout — it asks instead ("The editor is busy (a
save or export may be running). Quit anyway?"), so an in-progress write is
never killed silently.

## Editing

### Selection

Click-drag on the waveform/spectral canvas to select a region (samples are
the underlying unit; the UI always displays formatted time). Double-click
selects the entire document. Shift+click extends the selection from the
current cursor. `Ctrl+A` selects all; `Escape` clears the selection.

### Cut / Copy / Paste / Delete

Standard editing acts on the current selection: `Ctrl+X` cut, `Ctrl+C` copy,
`Ctrl+V` paste at the cursor, `Delete` removes the selection. Undo/redo
(`Ctrl+Z` / `Ctrl+Y` or `Ctrl+Shift+Z`) keeps up to 50 steps per document,
within an 800 MB per-document memory budget — whichever limit is hit first
evicts the oldest step (a large document's effective depth can be well under
50) — and is tracked per document — the **History** panel (opened from the
icon rail) lists every applied edit; click any entry to jump the document's state to
that point. Marker add/rename/delete are undoable too (labelled `Add Marker`
/ `Rename Marker` / `Delete Marker` in the History panel), and destructive
edits that change the timeline (delete, paste, trim, replace, sample-rate
conversion, and length-changing effects like Time Stretch/Pitch Shift) remap
or drop affected markers in the same undo step, so undo restores their exact
pre-edit positions.

### Markers

Press `M` (or **Edit → Add Marker**) to drop a marker named `Marker N` at the
current cursor position. The **Markers** panel (opened from the icon rail) lists every
marker on the active document: click a marker's **time** to move the cursor
there and re-center the view around it; double-click a marker's name to
rename it inline (`Enter` or clicking away commits, `Escape` cancels); the ✕
button removes it. **Edit → Next Marker** / **Previous Marker** jump the
cursor to the closest marker after/before it (no wraparound). On the waveform
and spectral canvases, each marker draws as a small orange triangle flag with
a dashed vertical line through the full height of the view, with its name
labeled next to the flag when there's enough horizontal room.

Markers persist to disk in every supported container — `.wav` (cue/adtl
chunks), `.mp3` (ID3v2.3 chapter frames), `.flac` (VORBIS_COMMENT chapter
tags), and `.ogg` (OpusTags chapter comments) — on in-place Save, Save As, and
Export, and read back sample-accurately the next time the file is opened; a
multitrack session's markers are embedded in the `.audm` file. Adding,
renaming, or deleting a marker marks the document dirty (the Files-panel `*`,
the close/quit prompts) and is undoable from the History panel. Destructive
edits that change the timeline — delete, paste, trim, replace, sample-rate
conversion, and length-changing effects like Time Stretch/Pitch Shift — remap
marker positions along with the audio rather than leaving them stranded;
positions are always clamped to the document length, so a marker can never be
saved past the end of the file.

### Convert Sample Rate / Convert Channels

**Edit → Convert Sample Rate…** resamples every channel of the active
document to a chosen rate (22050/44100/48000/96000 Hz) and updates its
sample rate; markers are rescaled in lockstep so they land on the new sample
clock. **Edit → Convert Channels…** converts between Mono and Stereo (stereo
→ mono averages the two channels; mono → stereo duplicates the single
channel). Both dialogs open pre-selected to the active document's current
rate/channel count, apply to the whole document, and are undoable as a single
History-panel step.

### The panel cards (icon rail)

The vertical icon rail at the right edge opens one floating glass panel card
at a time — **Files**, **Effects**, **Markers**, **History**, **Properties**,
and **Remix**; **History** is the default. When the active document has a
tempo analysis, a persistent **TEMPO** card (BPM readout, structure strip, and
×2 / ÷2 / Re-detect) appears above the panel card.

- **Files** / **Effects** — see their own sections in this guide.
- **Remix** — a remix document's per-splice adjustment rows (quality dot,
  Go To, Reject, Pin, Nudge, Re-roll, Revert to auto).
- **History** — the active document's undo history (see *Cut / Copy / Paste /
  Delete* above).
- **Markers** — the active document's marker list (see *Markers* above).
- **Properties** — read-only facts about what you're working on. In the
  waveform/spectral views it shows the active document's name, path (`—` for
  never-saved documents), sample rate, channels (Mono/Stereo), bit depth,
  duration, sample count, and whether it has unsaved changes — plus the
  selection's start/end/length while one exists. All audio is held in memory
  as 32-bit float, but for WAV/FLAC sources the original file's bit depth is
  recorded on import and shown alongside it, e.g. `16-bit source → 32-bit
  float`; MP3/OGG sources (which carry no meaningful source depth) show
  `32-bit float (internal)`. Save writes the document back into its source
  container for `.wav`, `.mp3`, `.flac`, and `.ogg` (see *Format-faithful
  Save* below for the exact depth/bitrate each format writes). In the multitrack
  view it shows the selected clip's source document, track, start/offset/
  length, and an editable **Gain (dB)** field (−24..+24, committed on
  `Enter` or when the field loses focus; `Escape` reverts your typing to the
  committed value).

## Effects

Effects live in the **Effects** panel (opened from the icon rail), grouped by category, and
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
is cleared when you capture a new one — or when you close the document it was
captured from (the print belongs to audio that no longer exists). The Noise
Reduction dialog notices a capture or clear immediately, even while open.

## Views

Switch between views from the toolbar pill's view segment or **View** menu:

- **Waveform** — the default per-sample amplitude view, with zoom (mouse
  wheel) and scroll.
- **Spectral** — a spectrogram (logarithmic frequency axis by default,
  −90..0 dB range, inferno-style color map, rendered at full device-pixel
  resolution) of the mono mix of the active document, computed off the main
  thread. Toggle to a linear axis via **View → Spectral: Toggle Log/Linear
  Scale**. If a spectrogram computation fails, a small "Spectrogram failed"
  note appears in the view (details go to the developer console); the next
  successful recompute — e.g. after zooming — clears it.

Both views share the same selection, cursor, playhead, and marker overlays,
and the same zoom/scroll gestures.

## Multitrack

**View → Multitrack** opens the session editor — it works even with no
document open. A session has a name, a sample rate, and any number of tracks.

- **Tracks**: each has a name (double-click to rename), Mute/Solo/Arm toggles,
  a volume slider (−60..+12 dB) and a pan slider (−1..1). **Add Track** adds
  an empty track. Arm (R) marks a track as a recording target — see **Recording
  into the multitrack** below.
- **Clips**: **Edit → Insert Active File at Cursor** places the whole active
  document as a clip on the selected (or first) track at the multitrack
  cursor. Drag a clip to move it (it snaps forward past overlaps rather than
  overlapping); drag its edges to trim. Click a clip to select it — its facts
  (source document, start/offset/length, and an editable gain in dB) appear
  in the **Properties** tab.
- **Playback**: the multitrack view has its own transport, cursor, and
  playhead, driven by the same toolbar-pill transport buttons. There is no pause in
  multitrack playback (v1) — Play/Pause toggles play↔stop. Volume, pan, and
  mute/solo changes apply **live while playing** — the realtime monitor uses the
  same pan law as Mix Down, so it matches the render. Clip moves, trims, and clip
  gain take effect on the next play.
- **Recording into the multitrack**: **arm** one or more tracks with their **R**
  toggle, position the multitrack cursor where the take should begin, then press
  **Record** in the toolbar pill. The session plays back from the cursor as a
  monitor while your input is captured; press **Record** again (or **Stop**) to
  end the take. The recording becomes a new *Track Recording* document and is
  dropped as a clip at the punch-in point on every track that was armed when you
  started. The Record button and the armed tracks' R toggles pulse red while a
  take is running. (The Record button is disabled until at least one track is
  armed.)
- **Mix Down**: **File → Mix Down to New File** renders the whole session
  offline to a new stereo document (added to the Files panel), respecting
  mute/solo/volume/pan/gain.
- **Sessions**: **File → Save Session…** / **Open Session…** persist the
  session (tracks, clips, their source document references, embedded audio,
  and markers) to a `.audm` file. Sessions are written in format v3, a binary
  layout (JSON header + raw audio payload, no base64) that removes the old
  v1/v2 format's silent failure on large embedded audio; Save Session now
  reports success or failure explicitly instead of failing quietly. Older
  `.audm` files (v1/v2) still open normally.

An empty session (no clips on any track) shows an inline hint pointing at
Insert Active File; the main editor area shows "Open an audio file (Ctrl+O)
or create a new one (Ctrl+N)" when no document is open in the waveform/
spectral views.

## Export

**File → Export…** (`Ctrl+E`) renders the active document to a new file
without changing the open document's path or dirty state:

- **WAV**: 16-bit, 24-bit, or 32-bit float.
- **FLAC**: 16-bit, lossless (verbatim — no quality setting).
- **MP3**: 128/192/256/320 kbps (constant bitrate only).
- **OGG (Opus)**: 96/128/192 kbps.

**File → Save** (`Ctrl+S`) is **format-faithful**: for a document opened from
`.wav`, `.mp3`, `.flac`, or `.ogg` it re-encodes in place into that same
container — WAV as 32-bit float (Properties updates to reflect this), MP3 at
192 kbps, FLAC at 16-bit or 24-bit (rounded up from the source depth — a
20-bit source saves as 24-bit, never truncated to 16), OGG as Opus-in-Ogg at
128 kbps (if the host has no WebCodecs Opus encoder, an in-place OGG Save
falls back to the Save As… dialog instead). Documents opened from other
exotic containers (M4A, AAC, WebM, or anything unrecognized), and brand-new
untitled documents, always use a **Save As…** dialog that writes WAV (32-bit
float, replacing the source extension in the suggested name — `song.mp3`
defaults to `song.wav`). **Save As…** always writes WAV.

Every in-place save (Save, and the format-faithful re-encodes above) writes
to a temporary file next to the target and only replaces it once the write is
complete, so an interrupted or failed save can no longer corrupt or truncate
the original file on disk.

## Shortcuts reference

See [`KEYBOARD_SHORTCUTS.md`](../KEYBOARD_SHORTCUTS.md) at the repo root for
the full, exact table (transcribed from `src/services/shortcuts.ts`).
