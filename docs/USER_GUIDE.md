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

## Tempo, remix and stems

These features are opt-in: nothing here runs until you ask for it, so opening a
file never pays for an analysis you didn't want.

### Detecting the tempo

To find a track's tempo: open it and run **Effects → Detect Tempo**. The
analysis runs off the main thread; when it finishes, the BPM appears in three
places — the `♩ 124.0` readout in the bottom status pill, the **TEMPO** card
above the panel cards, and the **Tempo** row in the **Properties** panel.

Two marks qualify the number, and they mean different things: a trailing `?`
means low confidence (the material may not have a steady beat at all), and a
trailing `*` means the grid is **stale** — the audio has been edited since the
analysis, so re-run it.

The beats are *tracked*, not extrapolated from a rigid grid, so the result
follows a take that drifts. What the detector cannot judge is the **octave**: a
60 BPM loop can be reported as 120 with high confidence. That is what the
**×2** and **÷2** buttons on the TEMPO card (and in both dialogs) are for —
they re-track the beats at the corrected period rather than just relabelling
the number, so everything built on the grid moves with it.

Whole-document analysis is capped at the first 10 minutes; past that the result
is reported as describing the first 10 min rather than the whole file.

### Seeing the beat grid

Once a tempo has been detected, the beats themselves are drawn: a row of short
amber **tics** along the bottom edge of the waveform and spectral views, and a
matching row along the bottom of every clip in the multitrack view. Toggle them
with **View → Toggle Beat Grid** (they are on by default).

There is nothing to switch on first and nothing to wait for — but there is also
nothing to see until you have run **Detect Tempo** on that document. Drawing the
grid never starts an analysis of its own, so a file you have not analysed simply
has no tics.

What the tics mean:

- **Each tic is a beat the tracker actually found**, not a mark laid down every
  `60 / BPM` seconds. On a take that drifts, the tics drift with it — that is
  the whole point of drawing them instead of trusting the BPM number.
- **Taller, brighter tics are bar lines**, and you will only see them after an
  **Auto-Remix** analysis. An ordinary Detect Tempo measures beats and nothing
  else; the app will not invent a downbeat it never measured, so a plain
  detection gives you an unbroken row of equal tics. If the bar lines it does
  draw are on the wrong beat, the ◂ ▸ downbeat shift in the Auto-Remix dialog is
  the correction.
- **Dimmed, dashed tics mean the grid is provisional** — the same two conditions
  that put `*` (the audio was edited since the analysis) or `?` (low confidence)
  on the tempo readout. The tics do not move when this happens; they only stop
  claiming to be right. Re-run **Detect Tempo** to make them solid again.
- **The grid stops where the analysis stopped.** On a file longer than 10
  minutes the tics end at the 10-minute mark rather than continuing on a guess.
- **Zoomed all the way out**, tics are thinned to at most one every 3 pixels so
  the band stays a readable ruler instead of turning into a solid bar. Zoom in
  and the rest reappear.

If you separate a track into stems, the five stem documents show **the same
grid as their source**, in the same places — they are one recording partitioned
five ways, so they share one grid rather than being analysed five times. Closing
the source keeps the stems' tics. A `Remix N` document does *not* inherit: its
audio is a re-arrangement of the source's bars, so the source's beat positions
would be in the wrong places. Run Detect Tempo on the remix itself.

### Snapping to the grid (the magnet)

With the magnet on, editing lands on the beat. Clicking the waveform puts the
cursor on the nearest **beat or marker** within 8 screen pixels; dragging a
selection snaps the edge you are dragging (the anchor never moves); and in the
multitrack, dragging or trimming a clip snaps it to the beats and markers of the
*other* clips and to the session cursor.

- **Switch it on and off** with the **magnet button** in the toolbar pill, or
  **View → Toggle Snap to Grid**. It ships on.
- **Hold `Alt` to suspend it** for one gesture. This works *during* a drag too:
  press `Alt` mid-drag and the position stops snapping, release it and snapping
  resumes, without letting go of the mouse.
- **The pull is 8 screen pixels, not a fixed number of samples**, so it behaves
  the same at every zoom: zoom in far enough and you can place the cursor
  anywhere between two beats without touching `Alt` at all.
- The magnet and the tics are **independent settings**. Turning the tics off
  does not stop snapping, and vice versa — they answer different questions.

One thing the magnet does not override: when you drop a clip on top of another
clip on the same track, the session still nudges it clear of its neighbour, and
that nudge has the last word. The clip then sits at its neighbour's edge rather
than on a beat.

### Matching one tempo to another

To make a 128 BPM loop sit in a 124 BPM track:

1. Select the region to retarget (or select nothing, to retarget the whole
   document).
2. **Effects → Match Tempo…**. The dialog prefills the source BPM from the
   detection; **Re-detect from selection** re-runs it against exactly the audio
   the ratio will be applied to.
3. Enter the target BPM — or switch to a plain ratio. The dialog shows which
   quality band the resulting stretch falls in (transparent / good / extreme).
4. Optionally tick the beat-marker grid, which lays down markers at the *new*
   tempo as a separate, separately-undoable step.
5. **Apply**.

Match Tempo runs through the same WSOLA **Time Stretch** effect and the same
single write path as everything else, so markers remap proportionally and undo
behaves normally — the History entry reads `Effect: Time Stretch` (see Known
Limitations), with `Add Beat Markers` as its own entry when you asked for the
grid.

### Re-arranging a track to a length (Auto-Remix)

To make a song fit a 2-minute video without time-stretching it:

1. Open the track and run **Edit → Auto-Remix…**.
2. Confirm the tempo and the downbeat the dialog reports (use ×2 / ÷2 if the
   octave is wrong — the arrangement is built on this grid).
3. Set the target length, and adjust phrase length, crossfade, strictness or
   repeat limits if you want to.
4. **Create Remix**. The result is a **new** `Remix N` document; the source is
   never modified.

Auto-Remix cuts and repeats on real bar lines rather than stretching: it
clusters the bars into sections by timbre, chroma, loudness and rhythm, and
picks the cheapest arrangement that reaches your target, with joins constrained
to land at the top of a phrase, micro-aligned by ±10 ms and crossfaded with a
power-preserving law.

No cost function understands lyrics or phrasing, so some splice will eventually
be musically wrong even at a low score. Fix it in the **Remix** panel rather
than by re-tuning: each splice gets a row with a cost-coloured quality dot,
**Go To** (jump the cursor there), **✕ Reject** (forbid that join and re-plan
another way to hit the same length), **📌 Pin** (keep it, max 8), **◂ ▸ Nudge**
(move the edit one bar earlier or later without changing the output length),
plus **Re-roll** and **Revert to auto**. Every adjustment appears in the
History panel and steps back with `Ctrl+Z`. If you edit or close the *source*
document, the remix session goes stale and read-only — the rendered audio stays
fully editable, but it can no longer be re-planned against a grid that no
longer describes the source.

### Separating a track into stems

To split a song into drums, bass, vocals and everything else:

1. Open the file and run **Edit → Separate into Stems…**.
2. The first time only, the dialog offers the **one-time 166 MB model
   download** with byte progress. It is fetched once and kept, so later
   separations start immediately.
3. Press **Separate** and watch the per-segment progress and its time estimate.
   Separation runs at roughly **1.5× realtime** on a modern multi-core CPU
   (measured: 30 seconds of audio separated in about 20 seconds), so a
   four-minute song takes around two and a half minutes. **Cancel** stops it
   immediately.
4. When it finishes you land in the **multitrack view** with five new
   documents — `<name> — Drums`, `— Bass`, `— Vocals`, `— Other`, `— Residual`
   — one per track, in a session named `<name> — Stems`.

Two things are worth knowing before you start, because they are different kinds
of promise:

- **Nothing is lost.** The five tracks add back up to your original *sample for
  sample*: the stems are masks over your document's own spectrum, and the
  Residual track is literally whatever the four stems didn't account for. So
  mixing the untouched session down (**File → Mix Down to New File**) gives you
  the original back exactly, and muting one track gives you the original minus
  that instrument — with nothing else quietly missing.
- **How cleanly the instruments are told apart is bounded by the model.**
  Expect some bleed — a cymbal in the "Other" track, a vocal tail in the
  Residual. That is a limit of the separation, not a bug, and no setting will
  remove it. Solo each track to hear what actually landed where.

Practical notes: separation is limited to **15 minutes** of audio per run;
mixing the session down only reproduces the original exactly if the original
itself stays within ±1 (a document you have amplified past full scale is
detected and the dialog says the exact sum will not hold); a **mono** source's
stems arrive as stereo documents with identical channels (use **Edit → Convert
Channels…** if you want them mono); and the five stem documents have never been
written to disk, so closing one — or quitting — prompts you to save it.

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

Both views share the same selection, cursor, playhead, marker and beat-grid
overlays, and the same zoom/scroll gestures.

## Multitrack

**View → Multitrack** opens the session editor — it works even with no
document open. A session has a name, a sample rate, and any number of tracks.

- **Tracks**: each has a name (double-click to rename), Mute/Solo/Arm toggles,
  a volume slider (−60..+12 dB) and a pan slider (−1..1). **Add Track** adds
  an empty track. Arm (R) marks a track as a recording target — see **Recording
  into the multitrack** below.
- **Clips**: **Edit → Insert Active File at Cursor** places the whole active
  document as a clip on the selected (or first) track at the multitrack
  cursor. Drag a clip to move it and drag its edges to trim; both snap to the
  beats and markers of the other clips and to the session cursor (hold `Alt` to
  suspend that — see **Snapping to the grid**), and a clip dropped over a
  neighbour on the same track is then nudged forward clear of it rather than
  overlapping. Click a clip to select it — its facts
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
