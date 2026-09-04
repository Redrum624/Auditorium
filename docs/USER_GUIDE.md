# Auditorium User Guide

Auditorium is a desktop audio editor (Electron + React) inspired by Adobe
Audition. This guide walks through the app as it actually behaves — every
section below matches shipped UI, not a plan. For behavior that deliberately
differs from Adobe Audition, see [`KNOWN_LIMITATIONS.md`](KNOWN_LIMITATIONS.md).

## Getting Started

### The window

Everything except the audio itself floats over the waveform as a glass pill,
and everything is anchored on the **waveform**, not on the window:

- **Top, centred on the waveform** — the toolbar pill: `Open · Save · Export`,
  the transport (`⏮ ⏹ ▶ ⏺ ⟳`), the magnet, the view segment
  (Waveform / Spectral / Multitrack) and the zoom cluster (`− · % · + · Fit`).
- **Top right** — the **module strip**: one icon per module — **Files,
  Effects, Pipeline, Markers, Properties** — plus **Remix**, which appears only
  once a remix document exists, and then **History**, which is always last. It
  sits on top of the module column. Click an icon to open its card below the
  strip; click the **open** icon again to close the card, and the waveform takes
  the whole column's width. An open **effect card** sits between the strip and
  the module card. **Files** is the card the app opens with.
- **Bottom, centred on the waveform** — the status pill: the active file's
  `name · duration · rate · channels`, the big time readout, the cursor and
  selection times, the `♩ BPM` readout, the zoom in samples-per-pixel, and the
  L/R level meters.
- **Just above the status pill** — the **edit toolbar** (see *The edit
  toolbar* below), present whenever at least one file is open.

There is no separate file chip: the file's identity lives in the status pill,
and the zoom percentage lives in the toolbar's own `%` readout.

### The menus

Six menus: **File**, **Edit**, **Effects**, **Pipeline**, **View** and
**Help**.

- **Effects** holds **Capture Noise Print** and then every effect, grouped by
  category — the things that transform the audio you have selected — and closes
  with the **Spatial Positioner** as its own Mix group.
- **Pipeline** holds the ten long-running tools, grouped by subject:
  **Detect Tempo · Match Tempo · Align Vocal Timing · Auto-Remix**, then
  **Voice Changer · Vocal Chain · Cover Chain · Align Lyrics**, then
  **Transcribe · Separate into Stems**. These
  used to be scattered between
  the Effects and Edit menus; they are in one place now, and each one is in
  exactly one place.

The grouping is by subject, not by run order. Where several of these tools have
to be run in a particular sequence — the vocal and cover chains especially —
the order is stated in the tool's own stage notes, not implied by the menu.

Every one of these tools is also a single click in the **Pipeline** module card
— the same ten rows in the same three groups. Both doors run the same command.
(The **Effects** card lists only the effects and the Effects menu's own **Mix**
row.)

**These tools do not open a centred dialog.** Selecting one of the nine that
have a UI — Match Tempo, Align Vocal Timing, Auto-Remix, Voice Changer, Vocal
Chain, Cover Chain, Align Lyrics, Transcribe, Separate into Stems — opens it as
a **wider card in the module column**, in place of whatever card was open, with
the strip showing **Pipeline** as the active module and **widening to the
card's own width** — the bar and the open module are always exactly the same
width, in every state. Nothing is dimmed and
nothing is blocked: while the tool is open you can still select audio, move the
playhead, zoom, switch view and use the transport, so a multi-stage pass can be
watched stepping through beside the waveform it is working on. Close the tool
with the **✕** in its header. (Detect Tempo has no UI of its own — it rewrites
the TEMPO card. The Spatial Positioner, now an Effects-menu row, likewise opens
no tool card: it opens the Spatial panel.)

**While a pass is actually running**, the module strip greys out and the tool's
**✕** refuses, both saying why: a running pass keeps its progress inside the
tool, so closing it or switching module would throw the work away. It would only
ever throw it away — every tool now stops cleanly when its window closes, so a
pass you abandon changes nothing at all rather than half-landing an edit in a
file you have walked away from. Two things are suspended for the duration and
nothing else — the module switch, and **keyboard shortcuts** (`Space`, `Ctrl+Z`,
the arrows). The keyboard is held for a reason the clean stop does not cover:
`Ctrl+O` mid-pass would make another file the active one while the pass is still
running, and the result would land with your selection and cursor pointing into
the file you had just opened. The **mouse** is untouched throughout: keep
selecting, scrubbing, zooming and switching view while it runs. Everything comes
back by itself the moment the pass finishes.

Auto-Remix is the one tool that starts something on its own — it analyses the
beat grid as it opens — and that mount analysis deliberately does **not** grey
anything: the lock is only ever for a pass you started.

A menu longer than the window scrolls inside itself; it never resizes or
scrolls the app behind it.

### Zoom and Fit

The toolbar's zoom cluster is `− · % · + · Fit`.

**100% is Fit: the whole track exactly fills the editor lane.** Zooming in
raises the number — 200% shows half the track — and because Fit is also the
furthest the editor zooms out, the readout never drops below 100%.

A newly opened, imported, recorded or computed document (a stem, a remix, a
mixdown) starts fitted, so you see the whole track the moment it appears. The
**Fit** button returns to exactly that state at any time. Because Fit is the
zoom-out limit, pressing `−` or scrolling out at 100% does nothing at all —
previously it kept going, and the beat tics and the timeline kept compressing
against a waveform that had already stopped changing.

The status pill also shows the zoom in samples-per-pixel, which is the exact
figure the `%` is derived from.

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

**File → Record**, or the **Record** button in the toolbar pill, opens the
Record dialog: pick an input device, channel count, and sample rate, watch the
live input level meter, then start/stop. A finished recording is added to the Files panel as a
new document. To record straight into a session instead, see **Recording into
the multitrack** below.

### The Files panel

Open the Files card from the module strip (the folder icon). Every
open document is listed with its name (a trailing `*` means unsaved
changes), duration, and sample rate. Click a row to make it active; hover and
click the ✕ to close it (you'll be prompted to save if it's dirty).

**Where unsaved state is visible:** that trailing `*` marks the document. The
**status pill** at the bottom shows the **project** — `<project> *` whenever
anything in it is unsaved (a document with changes, a session edit, or a
project that has content but has never been saved) — in every view, so the
module card can be closed (click the active strip entry) without losing sight
of it. Nothing is lost either way: closing a dirty document still prompts, and
quitting with unsaved work still counts and asks.

Closing the **app window** with unsaved work is guarded natively: the app
counts the project's unsaved items — each document with unsaved changes, plus
one for session edits, and at least one for a project that has content but was
never saved — and shows a confirmation ("N item(s) have unsaved changes.") with
**Quit** (discard everything and exit) and **Cancel** (keep the app open). An
empty, untitled project closes immediately. If the app is still busy with a
save or export when you try to close, it no longer force-closes after a short
timeout — it asks instead ("The editor is busy (a save or export may be
running). Quit anyway?"), so an in-progress write is never killed silently.

## Editing

### Selection

Click-drag on the waveform/spectral canvas to select a region (samples are
the underlying unit; the UI always displays formatted time). Double-click
selects the segment under the pointer (the span between the two nearest
markers; the whole document when there are none). Shift+click extends the
selection from the current cursor. `Ctrl+A` selects all; `Escape` clears the
selection.

### The position line and the timeline

The **position line** is the white vertical line on the waveform and spectral
canvases — it is where playback starts and where a paste lands. Three ways to
move it:

- **Click anywhere on the canvas.** The line goes there, as it always has.
- **Drag its red handle.** A small red triangle sits at the top of the line,
  centred on it. Grab it (the pointer becomes a hand) and drag: the line
  follows live. Grabbing it does not move it, and dragging it never changes
  the selection, so you can slide the line through a selected region without
  disturbing it. The red triangle is deliberately unlike the **orange** marker
  flags, which hang to the *right* of their own dashed lines — you can tell at
  a glance which one you are about to grab. The same handle rides the
  multitrack view's session cursor, so all three views move their line the
  same way.
- **Click or drag the timeline ruler** above the canvas. The line jumps to
  that time the moment you press, and holding the button and moving scrubs it
  along. The ruler stops at the end of the track.

All three obey the magnet (see *Snapping to the grid* below): the line lands on
the nearest beat, bar or marker within 8 pixels, and holding `Alt` suspends
that for as long as you hold it. Moving the position line while something is
playing does not interrupt playback — the line is where the *next* play starts.

The position line is not part of the undo history: moving it is a view change,
not an edit, and `Ctrl+Z` will not bring it back.

### Split / Cut / Copy / Paste / Delete

`Ctrl+K` (**Edit → Split at Cursor**, or the scissors button on the edit
toolbar) drops a marker at the cursor — or one at each edge of the selection —
named `Split N`, as one undo step. Markers are the document's segment
boundaries: the spans between them (and between the file's start, the first
marker, the last marker and the file's end) are its **segments**, which a
double-click selects and `Ctrl+X` can cut without a selection.

Standard editing acts on the current selection: `Ctrl+X` cuts the selection —
or, with none, the segment the cursor is in — to the clipboard and leaves that
span **silent at the same length**; `Ctrl+C` copies; `Ctrl+V` pastes at the
cursor; `Delete` silences the selection in place at the same length and
collapses it to a cursor at its start. None of these moves anything that comes
after the selection, and none of them moves a marker. `Shift+Delete` is
**Ripple Delete**: it removes the selection and closes the gap — the only
editor edit that shortens the file besides Trim. Undo/redo
(`Ctrl+Z` / `Ctrl+Y` or `Ctrl+Shift+Z`) keeps up to 50 steps per document,
within an 800 MB per-document memory budget — whichever limit is hit first
evicts the oldest step (a large document's effective depth can be well under
50) — and is tracked per document — the **History** panel (opened from the
module strip) lists every applied edit; click any entry to jump the document's state to
that point. Marker add/rename/delete are undoable too (labelled `Add Marker`
/ `Rename Marker` / `Delete Marker` in the History panel), and destructive
edits that change the timeline (ripple delete, paste, trim, replace,
sample-rate conversion, and length-changing effects like Time Stretch/Pitch
Shift) remap or drop affected markers in the same undo step, so undo restores
their exact pre-edit positions. Equal-length edits — Delete, Cut, Silence —
leave every marker where it was.

### The edit toolbar

A pill of nine icon buttons floats just above the status pill, on the
waveform's axis, whenever **at least one file is open** — in the Waveform,
Spectral and Multitrack views alike. It is only ever a shortcut to commands
you already have: nothing here does anything the menu and the keyboard do not.

`Split · Merge · Copy · Paste · Delete` │ `Trim · Silence` │ `Undo · Redo`

- **Split** is `Ctrl+K` — a marker at the cursor, or one at each edge of the
  selection. In Waveform and Spectral it needs only an open file, so it is the
  one button in the first group that stays lit with nothing selected; in
  Multitrack it needs a selected clip (see below).
- **Merge** is Split's inverse and has **no keyboard shortcut** — it is this
  button and **Edit → Merge Clips**, nothing else. It is the one first-group
  button that works *only* in Multitrack: on every track that has two or more
  clips selected, those clips become a single clip running from the earliest
  start to the latest end, with silence wherever no member covered the span.
  The audio is rendered into a **new `Merge N` file** that appears in the
  Files panel and becomes the active document, so each member's clip gain and
  its fades are baked in — the merged clip itself shows gain 0 and no fades.
  A track with only one clip selected is left alone, so with a single clip
  selected the button stays grey (see *Merging clips*). In Waveform and
  Spectral the tooltip says which view can do it.
- **Trim** keeps the selected region and drops everything else;
  **Silence** zeroes the selected region in place, leaving the length alone.
  Both are undoable History steps like any other edit, and both are also in
  **Edit → Trim to Selection / Silence Selection**, directly under Delete.
  Neither has a keyboard shortcut, so neither menu row advertises one.
- Buttons grey out individually rather than disappearing. With no selection,
  Copy / Delete / Trim / Silence are greyed; with nothing on the
  clipboard, Paste is greyed; Undo and Redo follow whichever history is
  active — the **document's** in Waveform and Spectral, the **session's** in
  Multitrack.
- In the **Multitrack** view, **Split**, **Merge** and **Delete** work: Split
  cuts clips at the cursor (see *Splitting clips*), Merge joins the selected
  clips of a track into one (see *Merging clips*), and Delete removes the
  selected clips.
  Copy / Paste / Trim / Silence are greyed there, and their keyboard shortcuts
  do nothing either — Copy and Paste because there is no clip clipboard yet,
  Trim and Silence because that view has no way to select a stretch of time.
  Each button's tooltip says which of the two it is. All four edit a region of
  the **active document**, which the view does not show — and since switching
  views keeps your document selection (unless you leave Multitrack with a clip
  selected, which selects that clip's span instead — see **Views**), they would
  otherwise change a file you cannot see, with the Undo button beside them
  pointing at the session's history instead. Switch to Waveform or Spectral to
  use one.

### Markers

Press `M` (or **Edit → Add Marker**) to drop a marker named `Marker N` at the
current cursor position; `Ctrl+K` (**Split at Cursor**) drops one named
`Split N` at the cursor or at both edges of the selection. `M` is an editor
command: in the Multitrack view it does nothing, since the document it
would mark is not on screen there. `Ctrl+K` is routed by view: in Multitrack
it splits clips instead (see *Splitting clips*). Every marker — whichever command, panel
or analysis wrote it — is a **segment boundary**: a double-click on the
canvas selects the span between the two nearest markers, and `Ctrl+X` with
no selection cuts that span. The **Markers** panel (opened from the module strip) lists every
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
edits that change the timeline — ripple delete, paste, trim, replace,
sample-rate conversion, and length-changing effects like Time Stretch/Pitch
Shift — remap marker positions along with the audio rather than leaving them
stranded; equal-length edits (Delete, Cut, Silence) leave markers in place,
including markers inside the silenced span. Positions are always clamped to
the document length, so a marker can never be saved past the end of the file.

### Convert Sample Rate / Convert Channels

**Edit → Convert Sample Rate…** resamples every channel of the active
document to a chosen rate (22050/44100/48000/96000 Hz) and updates its
sample rate; markers are rescaled in lockstep so they land on the new sample
clock. **Edit → Convert Channels…** converts between Mono and Stereo (stereo
→ mono averages the two channels; mono → stereo duplicates the single
channel). Both dialogs open pre-selected to the active document's current
rate/channel count, apply to the whole document, and are undoable as a single
History-panel step.

### The panel cards (module strip)

The horizontal **module strip** at the top right opens one floating glass
panel card at a time, directly beneath it — **Files**, **Effects**,
**Pipeline**, **Markers** and **Properties**, plus **Remix** once a remix
document exists, and **History** last. **Files** is the default: it is the card
the app opens with, and nothing about the panel is remembered between runs.
Clicking the **already-open** entry closes the card, and the waveform stretches
across the column's width; clicking any entry reopens one. When the active
document has a tempo analysis, a persistent **TEMPO** card (BPM readout,
structure strip, and ×2 / ÷2 / Re-detect) appears between the strip and the
panel card.

The order is a rule rather than a list: **Files** is always first, **History**
is always last, and anything added later goes between them.

- **Files** / **Effects** — see their own sections in this guide.
- **Pipeline** — the ten Pipeline-menu tools, in the same three groups
  (**Tempo & Timing**, **Voice**, **Analysis**), each a single click.
  Choosing one replaces this card with the tool itself (see *The menus* above);
  closing the tool brings this list back. Greyed rows are unavailable right now
  for exactly the reason the menu gives.
- **Remix** — a remix document's per-splice adjustment rows (quality dot,
  Go To, Reject, Pin, Nudge, Re-roll, Revert to auto).
- **History** — the undo history of whatever is active: the **session's** in
  the multitrack view, the **active document's** elsewhere (see *Split / Cut /
  Copy / Paste / Delete* above and *Undo in the multitrack* below).
- **Markers** — the active document's marker list (see *Markers* above).
- **Remix** appears in the strip only while a remix document is open, and
  vanishes again when the last one is closed — it has nothing to show
  otherwise.
- **Spatial** and **Transcript** are not modules. They are what a tool
  produces, so they have no icon at all: **Effects → Spatial Positioner**
  opens the positioner, and **Pipeline → Transcribe** shows the transcript of
  a document that already has one (and offers to make one when it does not).
  Both still open as the same full card in the same column — nothing about
  either surface was trimmed.
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
  view it shows the selected clip's source document, track, offset and length,
  an editable **Start** field, and an editable **Gain (dB)** field (−24..+24).
  Both commit on `Enter` or when the field loses focus, and `Escape` reverts
  your typing to the committed value. **Start** is where the clip sits on the
  timeline, typed as `m:ss.mmm` or as plain seconds — the way to realise a
  stated offset exactly instead of dragging to it by eye. It goes through the
  same move a drag does, so it leaves one *Move clip* undo entry and maintains
  any crossfade the clip is in; a position before zero is refused rather than
  silently clamped, because no clip can start before zero.

## Effects

Effects live in the **Effects** panel (opened from the module strip), grouped
by category, and mirrored in the **Effects** menu. **Click** an effect (with a
document open) — from the card or the menu — and it opens as a **card in the
module column, between the module strip and the module card**, the same
348 px wide as both; the module card beneath it switches to Effects so the
other effects stay one click away. Adjust, **Preview**, **Apply**; close it
with the **✕** in its header, **Cancel** or `Escape` — the key closes the card
exactly as it closed the effect dialog before, stopping a running Preview and
keeping your selection (while **Apply** runs, `Escape` does nothing, like the
✕). The card's first line names the span **Apply** will write — the selection,
or the whole file when there is none — so a selection lost to Edit › Deselect
or to a click on the waveform is visible in the card before you press Apply.
Nothing else is dimmed: the waveform, selection, transport and keys stay live
while the card is open — and if you
switch, edit or close the document while a **Preview** plays, the transport
takes the engine back and the card gives the preview up with it, so the button
reads **Preview** again rather than stopping what you just started. While an
effect is being **applied**, the module strip greys out and the ✕ and Cancel
refuse until it finishes — the same rule as a running pipeline pass. The mouse
stays live, so you can still edit, switch or close the document while it runs;
do that and the effect is **not** applied — it commits only to the document as
you left it when you clicked Apply — the card says so and stays, and **Apply**
runs it again on the document as it is now. Closing the last document closes
the card. Every effect processes the current
selection, or the whole document when there's no selection.

Below the effects, the same card lists the Effects menu's own **Mix** row, the
**Spatial Positioner**. A tool row takes a **single** click (it is a verb
the menu already runs on one click). A greyed tool row means that command is
unavailable right now, for exactly the reason the menu gives — the panel asks
the command itself rather than keeping its own copy of the rule. The ten
Pipeline tools are not listed here: they live in the **Pipeline** module card
and menu.

- **Amplitude** — Amplify (gain in dB), Fade (in/out; Linear, Ducked, Cosine
  or Equal power curve; ramp length as a % of the selection — 100 % shapes the
  whole selection exactly as before), Normalize (peak or RMS target level)
- **EQ & Filters** — Parametric EQ, Graphic EQ
- **Dynamics** — Compressor, Limiter, Noise Gate, De-esser (tames harsh "s" and
  "sh" sounds: Frequency sets where the sibilance band starts, Threshold and
  Ratio how hard it is pulled down, and **Listen** plays back only what is being
  removed so you can hear whether you are taking out sibilance or consonants)
- **Delay & Reverb** — Echo, Reverb
- **Modulation** — Chorus, Flanger
- **Distortion** — Distortion
- **Restoration** — Remove DC Offset, DeHum, Noise Reduction, Remove Silence
  (detects pauses under a Threshold lasting at least Min silence and shortens
  each to a target — or removes it, keeping Padding — with a click-free
  crossfade at every cut; markers shift by exactly the material removed before
  them, and a marker inside a removed pause snaps to the splice point)
- **Stereo** — Channel Mixer, Pan
- **Time & Pitch** — Time Stretch, Pitch Shift, Pitch Correct (snaps a sung
  or played line to a Key and Scale — chromatic, major, or natural minor —
  with Strength scaling the correction and Retune Speed smoothing it; 0 ms is
  an instant snap, and unvoiced frames and silence pass through untouched)
- **Utility** — Invert, Reverse

### Noise Reduction (capture → apply flow)

Noise Reduction needs a noise *print* before it can run:

1. Select a region that contains only the noise you want to remove (e.g. a
   room-tone gap).
2. **Effects → Capture Noise Print** (only enabled with a selection). This
   averages the STFT magnitude spectrum of the selected region, per channel,
   and stores it in memory.
3. Open **Effects → Noise Reduction** (the Effects menu is a flat list —
   Restoration is the category heading above the row, not a submenu), adjust
   Reduction (dB), Sensitivity, and Smoothing, and apply to the region you
   actually want cleaned (the capture and the apply regions can differ).

The captured print is in-memory only: it is not saved with the document and
is cleared when you capture a new one — or when you close the document it was
captured from (the print belongs to audio that no longer exists). The Noise
Reduction dialog notices a capture or clear immediately, even while open.

### Vocal Chain (fixing a rough vocal in one pass)

**Pipeline → Vocal Chain** runs the corrections a vocal usually needs, in one
pass that lands as a single undo entry. It contains no new processing — every
stage is an effect you can also run on its own. What the chain adds is the
order, settings worked out from your actual recording, and a report.

The stages, in the order they run:

| # | Stage | On by default |
| --- | --- | --- |
| 1 | Remove DC Offset | yes |
| 2 | Align Lyrics | **manual — run it before the chain** |
| 3 | Noise Reduction | yes |
| 4 | DeHum | yes (runs only if hum is measured) |
| 5 | Remove Silence | **no** |
| 6 | Noise Gate | yes |
| 7 | Align Vocal Timing | **manual — run it before the chain** |
| 8 | Pitch Correct | yes |
| 9 | Compressor | yes |
| 10 | De-esser | yes |
| 11 | EQ (high-pass) | yes |
| 12 | Reverb | **no** |
| 13 | Limiter | yes |

The order is not stylistic. Noise reduction comes early because the pitch
detector will otherwise lock onto broadband noise and "correct" pitch that is
not there. De-essing comes *after* the compressor because compression makes
sibilance worse. Reverb comes after everything that measures or shapes the
voice, because nothing should compress or pitch-correct a tail it just added.
The **limiter is last of everything**, and that is load-bearing rather than
tidy: reverb sums a wet tail on top of the dry signal, so a reverb placed after
the limiter takes the output back over full scale — measured through this chain,
a take limited to −0.3 dBFS came back at **+6.53 dBFS** on noise, and both the
WAV writer and the MP3 encoder hard-clip that.

That ordering only protects you while the limiter is actually running. **Switch
the limiter off and leave Reverb on**, and the reverb becomes the last stage
that touches the audio — a level stage with nothing after it — so the output can
come back above full scale, and both the WAV writer and the MP3 encoder will
hard-clip it on export. The chain says so when it happens: the reverb's row in
the results shows a warning naming the peak it actually reached (for example
*"the output now peaks at +2.4 dBFS, above full scale"*) and telling you to
switch the Limiter on or bring the level down before exporting. It appears only
when the output really did go over — on material where the tail never crosses
0 dBFS there is nothing to warn about — and it never blocks the run: a tail over
an already-hot take is a legitimate thing to want if you intend to lower it
afterwards.

**Nothing is set by taste.** Each stage starts from its own effect's defaults
and the chain overrides only what the recording decides:

- the **de-esser's threshold** is measured at its own input — that is, after the
  compressor, because an upstream compressor changes what its detector sees;
- the **compressor's threshold** is the level your take is above half the time
  while it is actually sounding, and its **makeup gain** is exactly the level
  the compression took away;
- the **noise print** is learned from the quietest 500 ms of **real material**
  in the selection — never from a stretch of digital silence or from a window
  mostly made of one, because the print *is* that window's spectrum and zeros in
  it describe the zeros rather than your room. Measured on a take with a trimmed
  lead-in, reading the diluted window left 4.7 dB (at 8 kHz) to 8.3 dB (at
  44.1 kHz) of the stage's 12 dB of reduction unused. Noise Reduction declines
  outright when no half-second of real material exists at all — a stem
  strip-silenced by a tool with no hold — because a print learned from a
  fragment is priced by a floor that never contained it;
- the **silence threshold** is the loudest that quiet passage ever reads —
  measured over the quietest 500 ms of **real material**, so a trimmed lead-in
  or an edited cut cannot pass a sliver of louder audio off as the floor;
  Remove Silence declines outright on a take with no half-second of real
  material left in it, because a stage that deletes what it calls silence must
  not guess the level;
- the **gate** derives no level at all: it mutes the stretches where the
  evidence says no vocal activity lives (see its own section below);
- the **high-pass** sits an octave below the lowest note actually sung.

**The stretches where you are not singing go to actual silence.** The **Noise
Gate** stage mutes them, and it is on by default because it is what most people
mean by "clean up this take" — Noise Reduction can only pull a floor down by
12 dB, and the compressor's makeup gain then lifts what is left, so before this
stage a pause was quieter but never quiet. It **mutes in place rather than
cutting**, which is why it can be on by default where Remove Silence cannot:
nothing moves, so a take stays lined up with its backing track.

**It decides WHERE, not how loud.** Earlier releases derived a level and muted
everything under it, which meant the noise in your pauses had to be *quieter*
than your softest singing — and on a real take it often is not: a chair, a
fan, a neighbour's TV can all sit above a pianissimo phrase. This stage now
asks a different question: *where is the vocal activity?* A stretch is muted
only when the evidence says no vocal activity lives in it — so pause noise
**louder than your softest singing still goes**, which no threshold could ever
reach. The evidence, in the order it is consulted:

- **Your aligned lyrics or transcript place the words.** If you have run
  **Pipeline → Align Lyrics** or **Transcribe** on this audio and have not
  edited it since, every word's span marks singing, and nothing inside a word
  span is ever muted — however quiet the word is. This is the strongest
  evidence there is, and the only kind that can protect singing too quiet to
  measure: run Align Lyrics first if your take has passages like that.
- **Every half-second of the selection is measured for a vocal tract.** A
  whisper, a breath, a held consonant — noise that has been through a mouth
  carries resonances a room's noise does not, and any stretch showing them is
  kept, whether or not a word maps there. Without lyrics or a transcript this
  measurement is also how the singing itself is found, which makes the
  no-words path deliberately more conservative: singing *quieter than the
  pause noise* is invisible to measurement, and such a take declines rather
  than gambles.
- **Anything voiced is kept.** Humming, an "oooh", a soft line the tilt
  measurement cannot see — if the pitch detector reads voiced frames in a
  candidate stretch, the whole stretch stays.

**Only stretches of at least 500 ms qualify** — the shortest gap this app is
willing to call a pause at all (the same minimum Remove Silence uses), so a
stop-consonant closure, a breath gap or a dip inside a held note is never even
a candidate. Each muted stretch closes behind the same 20 ms fade the manual
gate uses and reopens instantly where the next activity begins. The gate's row
in the report says which evidence decided, how many regions were muted and for
how many seconds, how many candidate stretches were *kept* for vocal evidence,
and — measured on the output — how much of the selection now sits at digital
silence.

**Digital silence is left exactly as it is.** Zeros stay zeros; a run of exact
zeros is never *evidence* about the material beside it, so a whispered line
next to a trimmed lead-in cannot be muted on the silence's account; quiet
audio that survives only as fragments between zeros — an 8-bit transfer, a
stem another tool strip-silenced with no hold — is never muted unheard; and a
take whose pauses are already exact zeros declines, having nothing left for a
gate to do.

**And when nothing qualifies, it declines instead of guessing.** A take that
never pauses for half a second is left alone entirely — a legato or continuous
performance is not gated, whatever its level. A take where every stretch
between activity carries vocal evidence declines and says how many stretches
were kept, and for which evidence. A take that reads as one long noise floor —
a held tone, bare room tone, clicks — declines rather than muting all of it.
In every case the stage reports **Did not run** with its reason, and not one
sample is changed.

**Three limitations, stated so you can avoid them.** A room whose own noise
carries resonances — a fan, an air conditioner, a machine anywhere near the
microphone — can read as vocal-tract shape in **every** half-second of a
take: measured on the very recording that motivated this redesign, every one
of its 2833 windows did, and the stage then declines outright (its message
says so, and names this reading). For that room, the manual threshold below
is the tool — no measurement in this stage can tell resonant machinery from a
whisper, and it refuses to guess. Vocal material *quieter
than the noise floor around it* — singing buried under the room, a whisper
under hiss — is invisible to every measurement here; with word evidence it is
protected by its span, but without words a muted stretch can take such
material with it, exactly as a level gate always did. And a resonant noise
that is not a voice — a chair creak, a squeaky pedal — reads as a vocal tract
and is *kept*: the creak's half-second survives as a short island while the
floor around it is muted. The measured populations overlap outright there (a
creak reads 4.1 dB of vocal-tract shape, inside the whisper family's own
range), so no boundary exists that mutes the creak and keeps the whisper —
the stage keeps both and says so in its Kept row.

**And when it declines, you can still gate it yourself.** Every refusal ends
by saying so, because a refusal that leaves you with nothing is not a service:
tick **Gate at a level I set instead** on the Noise Gate row and type a
threshold in dBFS. Everything under that level goes to silence — this is the
level gate of earlier releases, byte for byte: the same 500 ms hold, the same
20 ms fades, the same rule about digital silence. It is the one setting in the
whole chain that comes from you rather than from the recording, so the stage
says so — its row reads **Threshold (manual)** and states, next to it, how
many seconds of the selection the level will actually silence, which is how
you tell you set it too high. It also wins on a take the stage *could* decide
for itself, deliberately — a box that quietly did nothing on most recordings
would be worse than no box.

An **empty** box means no level has been named — not 0 dBFS, which is full
scale and would gate the whole take. Apply waits until you type one, and says
so beside the box; untick the option if you would rather the stage decided for
itself after all. And note *where* you usually read the refusal: if the rest
of the chain applied, that run is finished and every control in the dialog is
greyed, including this one. Close the dialog and open **Vocal Chain** again to
set the level; the refusal's own text says the same thing.

**One stage depends on another.** The high-pass corner comes from the lowest note
the pitch detector measured, so **switching Pitch Correct off also switches the EQ
off** — it declines and says so rather than guessing a corner. That matters
because Pitch Correct is the slow stage and turning it off is the obvious way to
speed the pass up; the stage list says so next to the EQ, before you run
anything.

**A stage with nothing to do says so.** On a recording with no mains hum, DeHum
reports the two readings it took and declines rather than notching a hole in
nothing. Noise Reduction declines if there is no passage quiet enough to learn
from, and says why. Nothing runs that you did not see.

Two stages are off by default because they change the material rather than
correct it: **Remove Silence** shortens pauses, which moves everything after
them and takes the take out of sync with a backing track, and **Reverb** adds a
tail no measurement of a recording can ask for.

**Two more are listed but never run automatically**, because each needs you to
say *what* to change rather than *whether* to change it. Run each from its own
tool before the chain:

- **Align Lyrics** (stage 2) replaces one word you pick with a fresh take of it.
  It sits second, right after DC offset, and the position is a consequence
  rather than a preference: a replacement is a fresh microphone take carrying
  its own room tone, so it has to be in the file before Noise Reduction learns
  its print and before the compressor, de-esser, EQ and limiter measure the
  levels they set themselves from — run after them and the seam joins cleaned
  audio to a raw take, with no stage left to reconcile the two floors. It also
  has to come before Remove Silence and Align Vocal Timing, which move every
  sample after the point they edit and would leave the word positions describing
  audio that has shifted. DC offset still goes first for the chain's own stated
  reason: the splice matches the new word's level to the old one's by RMS, and a
  DC bias inflates that measurement.
- **Align Vocal Timing** (stage 6) needs you to confirm the beat grid and the
  syllables first. Timing belongs before pitch, because warping changes the
  windows the pitch detector uses.

<!-- P1: the live stepper -->
**While it runs, the same list is live.** From the moment you press Apply, every
stage keeps its place in the list and gains a state: *Waiting*, *Running*,
*✓ Ran*, *Did not run*, *Switched off*, or *Manual step* for the two that this
chain never runs itself. The stage in progress is highlighted
and says what it is doing — *Measuring* while it works its settings out from the
audio reaching it, then *Rendering* with the settings it just measured shown on
the line — with its own bar for how far through **that stage** the pass is. The
stages still to come are dimmed; the ones already finished settle into their
full report there and then, so you can read what the compressor decided while
Pitch Correct is still going. The bar at the foot of the tool is labelled
*Whole pass* and is weighted by the measured stage times — it is deliberately a
different number from the highlighted row's own bar, which measures only how far
through **that one stage** the pass is.

After the run, every stage reports what it did: the settings it derived and what
it derived them from, the measured RMS and peak before and after, and how much
of the audio it left bit-identical — plus a before/after table of loudness,
peak, crest factor and noise floor. A stage that declined shows the measurement
that made it decline.

Pitch Correct dominates the running time (roughly 0.4× real time on its own; the
whole chain took about 105 seconds on a 142-second stereo take).

### Cover Chain (the whole journey, from the song and your take to a session)

<!-- CP1: the chain became the journey -->
`Pipeline → Cover Chain` takes **two documents** — the original song, and the vocal you
recorded — and does the whole thing: separates the original, cleans your take, works out
where your take belongs against it, matches your take's tone and level to the original
singer's, builds a session with the original's music and your take on it, and smooths
the edges. Open both files, pick them in the two boxes at the top, press **Run the
journey**.

Six stages run, top to bottom, each reporting what it measured:

1. **Separate the Original** — runs the separation model over the song and lays down its
   five stems, then sums the four non-vocal ones into a `— Instrumental` document. That
   sum is exact rather than approximate: separation's one hard guarantee is that its five
   outputs add back up to the mix to the last bit, so "the original with its vocal
   removed" is arithmetic here, not an estimate. **If this song's stems are already open**
   — five documents named `<song> — Drums`, `— Bass`, `— Vocals`, `— Other`, `— Residual`,
   each at the song's rate and length — the stage reuses them and says so, because a model
   pass is minutes and there is no reason to pay for it twice. What it cannot see is an
   edit to the song that left its length unchanged; separate again if you have edited it.
2. **Clean the Take (Vocal Chain)** — the whole Vocal Chain on your take. Its eleven stages
   appear nested under this row, each with its own status and reason, rather than hidden
   behind one bar. This is also where the pauses between your phrases go to silence: the
   Vocal Chain's Noise Gate stage is on by default and mutes in place, so nothing shifts
   out of sync with the instrumental. The match below is a correction to a **clean** take:
   match the timbre of a noisy one and you match the noise too.
3. **Align with the Original** — see below.
4. **Match to the Original Vocal** — the four matching stages, described below, against
   the separated original vocal. Nested under this row the same way.
5. **Build the Session** — a two-track session: the instrumental on one track, your
   matched take on the other, at the offset stage 3 found.
6. **Smooth and Check the Level** — 25 ms edge fades on your take so neither end starts
   or stops mid-waveform, and one mixdown of the finished session to measure what the two
   tracks actually sum to.

**The alignment is a placement, not a warp.** Stage 3 cross-correlates the onset envelope
of your take **as you recorded it** with the separated original vocal's and reports the
offset it found along with the confidence that produced it. Not the cleaned take: the
take's samples are snapshotted before stage 2 runs, because this measurement reads
*onsets* and the chain writes its own — the noise gate puts an attack at every open and
close that the original never had, and the pitch corrector moves the real ones. (Only the
samples come from before the chain; the take document still supplies the sample rate, and
a take closed mid-run declines the stage rather than measuring against a ghost.) Your whole
take is then placed at that offset — nothing is stretched and no syllable is moved, so a take that drifts against the record
still drifts. Two thresholds have to be cleared before the number is believed, and both
are measured rather than chosen.

**The reference is the separated vocal, and deliberately not the song.** Refining the lag
against the **original song** as well was built, shipped, and withdrawn one release later,
and it is worth saying why because the idea is a good one until it is measured. The song
has not been through the separation model and it shares the stem's timeline exactly —
separation's five outputs sum back to the mix bit for bit — so it looks like the better
ruler. It is not, because sharing a *timeline* is not sharing *onsets*: the measurement
reads spectral flux, and accompaniment sitting under a vocal dilutes the flux at that
vocal's own attacks, so the song's onsets land late of the same singer's. Measured on the
app's own test pair, sweeping the backing from 52 dB under the vocal up to 8 dB under it,
the separated vocal recovers the built-in offset to 0.07 ms at every level while the song
costs between 3.3 ms and 12.9 ms — growing with the backing, and past the ±10 ms promised
below at an ordinary balance. There is no correction for it either: the only way to measure
the bias is the lag between the two rulers, and subtracting that returns the separated
vocal's answer. So the vocal stays the reference. The cost of that choice is stated rather
than hidden: if the separation smears the attacks in the stem, your take is placed by that
smear, and nothing in the two files can buy it back.

**The pass places the tracks itself, even when it cannot fully believe the number.** A
match the stage calls *ambiguous* ("several places about equally well") or *weak* is
**placed at its own measured lag**, with the same both-tracks-move arithmetic and the same
25 ms edge fades a believed alignment uses. It is not offered for you to accept: the
measured guess is the best evidence there is, and asking you to press a button to apply it
is asking a question the pass could already answer. What the align row does instead is tell
you what it did and hand you the alternatives — "placed at −8.257 s; if that is the wrong
spot, these matched too" — with each rival lag its own **Place at ±X s** button showing
that lag's correlation and how far it stands above the next, and the measured guess first
among them; one press re-places both clips at any other lag as a single undo entry. (The
first placement itself is not undoable, and the row does not claim it is: it was made while
the session was being built, and building a session clears session history the same way
opening one does. Dragging a clip, or typing a new **Start** in the Properties panel, is
always available.)

**Two outcomes are still placed at the start.** *Unrelated* — a take no arm could
distinguish from the band measured for pairs with no relation at all — and a measurement
that classified itself not at all: auto-placing those would be the app guessing exactly
where it has just said it has no guess. Those rows say so, state the numbers, and carry
the single **Apply the measured offset anyway** button. Whichever arm you get, the row's
own sentence names the control that is actually on screen for that measurement and never
the other one, and its advice is **sign-aware**, because it has to be: no clip can start
before zero, so a guess *before* the original's start can only be realised by dragging the
**Instrumental** later — dragging your take can only make it worse. (No row suggests Align
Vocal Timing for this. That tool warps document audio to a confirmed beat grid; it cannot
move a clip on the timeline at all, for either sign. It stays recommended where it belongs
— under a *believed* alignment, for a take that drifts.)
Any offset can also simply be typed: the Properties panel's clip **Start** is an editable
time field. Known offsets come back
within 10 ms in both signs, at equal rates and across 44.1/48 kHz — but that figure assumes
a normal take level. It is level-dependent and it degrades without warning: 8.4 ms at unity,
10.9 ms at −40 dB, 21.6 ms at −70 dB, and the take is BELIEVED at all three, so a very quiet
take is placed a frame or two out rather than refused. Normalise a quiet take before running
the journey; `docs/KNOWN_LIMITATIONS.md` carries the measured table. If the take belonged
*before* the original's own start, both tracks are pushed later by the same amount rather
than your take being clamped to zero — clamping would have silently thrown away the offset
that was just measured.

**Key and tempo are not decided for you.** This is the fourth of the four sentences the
tool states above its own button, and it was missing here. Pitch and timing each need you
to confirm the target first: on the song this was measured on, the drums read ~160 BPM
while everything else read ~109, every confidence below the app's own threshold — an
automatic pick would have been a coin flip. That is why the journey aligns but does not
transpose or re-time, and why the two tools below stay yours to run.

**Two tools stay manual, deliberately, and are worth running afterwards.**
`Pipeline → Align Lyrics` replaces one word you pick with a fresh take of that word;
nothing in the app judges which word is wrong, and a per-phone quality scorer was built,
measured at 0.642 AUC against a 0.500 chance baseline, and cut. `Pipeline → Align Vocal
Timing` warps timing but needs you to confirm the beat grid first — see the note in that
section about why nothing picks it for you. If you use Align Lyrics, run the journey
again afterwards, so the replaced word is in the file before any stage measures a level or
learns a noise print from it.

**Cancel works between stages.** The run takes minutes and the separation is most of it.
The session is built only at stage 5, so cancelling before then leaves you with the
documents the pass produced — the stems, and your take with whatever passes had already
finished — and no session. Nothing is left half-built.

**Undo stays per-pass.** The Vocal Chain leaves one entry named "Vocal Chain" on your take
and the matching stages leave one named "Cover Chain"; the report lists them. There is
deliberately no single entry that undoes the whole journey: an undo entry belongs to one
document, and this pass touches two documents and a session.

#### The four matching stages

Three are on by default:

- **Match EQ to the Original Vocal** — compares the long-term octave-band energy of the
  two recordings and realises the difference on the Graphic EQ. It works from 500 Hz up
  and never asks for more than ±10.9 dB; both limits are measured, not chosen, and the
  stage's own note says why. The report gives you a table per band: what the match
  **wanted**, what it **realised**, and the **gain** the EQ was handed. Those are three
  different numbers on purpose — a cascade of overlapping filters does not deliver the
  gains it is given, so the gains are pre-compensated and what you are shown in the
  realised column is what the audio actually received. If a band could not be reached
  inside the EQ's own ±12 dB, the stage says so with both numbers.
- **Match Loudness** — moves your take to the original vocal's level, measured over the
  *sounding* parts of each. It runs after the EQ, because the EQ deliberately leaves the
  broadband level out of its curve and hands it here, and after Match Reverb, because a
  tail moves the level this stage is setting.
- **Limiter (headroom)** — catches the peak at −0.3 dBFS, **last of every stage that
  touches the audio**, so nothing after it can put the output back over the ceiling. On a
  take that never reaches the ceiling it reports that it did nothing. Switch it off and
  Match Loudness will tell you, with the number, if the result is going to pass 0 dBFS.

**Match Reverb** is off by default and will usually decline even when you switch it on.
It measures the original vocal's decay and compares it with the shortest decay this
app's Reverb can produce (0.710 s); if the original is drier than that — as both vocals
this was measured on were, at 0.28 s and 0.40 s — the stage says which two numbers made
it refuse rather than adding space that is not there. When it does engage it runs after
the EQ and before the two level stages, because the tail it adds moves both the level and
the peak. Two things it cannot tell you: its estimator has only ever been *validated* on
this app's own reverb and on synthetic decays, never on a real reverberant vocal, and its
linearity check cannot tell a curved fall from a room — a slow fade with no reverberation
in it at all scores higher than either validated control. So a decay it reports is
evidence of a fall, not proof of a room.

<!-- P1: the live stepper — CP1: now over the journey's six stages, with the two chains nested -->
**While it runs, the same list is live.** Every stage keeps its place and gains a state —
*Waiting*, *Running*, *✓ Done*, *✓ Reused*, *Did not run*, *Cancelled* or *Failed* — and
the stage in progress is highlighted, says what it is doing, and carries its own bar for
how far through **that stage** the pass is. Stages 2 and 4 are themselves multi-stage
chains, and their rows carry the nested chain's *own* live line underneath — the stage it
is on, what that stage is doing, and how far through it is — rather than collapsing ten
stages behind one bar. The bar at the foot of the tool is labelled *Whole journey* and
is deliberately a different number from the highlighted row's: separation is roughly nine
tenths of the work, so that bar can sit almost still while a great deal is happening.

<!-- CP1: what the journey tool deliberately does not show -->
**What the journey report does not show, and where to find it.** The old Cover Chain dialog
printed two tables: the match curve band by band (what the EQ was asked for, what it realised,
what gain it was handed) and a before/after table of loudness, envelope spread, noise floor and
spectral distance. Neither is in the journey report, and that is a decision rather than an
oversight — the journey nests two whole chains inside six stages, and reproducing both chains'
tables would put four tables and about ninety numbers on one screen, which is a report nobody
reads. What the journey shows instead is every stage's own status, reason and derived settings,
including each nested stage's. **The tables still exist**: run `Pipeline → Cover Chain`'s
matching stages on their own — or open the take and run the Vocal Chain — and each chain's own
tool reports itself in full, exactly as before. Nothing was removed from the engines; the
numbers are one tool away rather than in front of you.

**The level check fixes what the pass itself created.** Stage 6 mixes the finished session
down and reports the peak the two tracks summed to **before** the master bus's ±1 clamp —
the clamped render peaks at 0 dBFS by construction and could never tell you this. If that
sum passes full scale, the pass does not hand the overshoot back to you: **both** faders
come down by it (plus 1 dB of headroom, for the inter-sample overshoot an MP3 decoder
reconstructs), the trimmed session is summed a second time to check, and the row states the
trim, the target and the measured result. Both faders move by the *same* amount, so the
balance Match Loudness set between your take and the instrumental is untouched — this is a
level trim on two faders and nothing else. Nothing is normalised, limited or mastered on
your behalf: a session that already fits is not touched, and a sum that fits is never
brought *up* to a target. The trim is one undo away — `Cover level trim` on the session's
own history — and if you move a fader back up afterwards, nothing checks the sum a second
time.

**The envelope spread is reported and never corrected.** A "matched compressor" was
built and cut: the move it asks for changes sign depending on how the measurement is
gated, which makes it a property of the analysis rather than of the singer.

**Two things to expect.** The instrumental you lay the cover over is **not clean** — it
still contains the original singer, about 18 dB below the music and only 10 dB below it
in the band your own voice occupies. Exact summation is a statement about arithmetic, not
about whether the original singer is audible in the bed; she is, most audibly in sparse
passages. **Running the separation a second time over the instrumental does not fix this**,
and that was measured rather than assumed: it moves the residual 0.00 dB across
250 Hz–4 kHz (worst octave 0.04 dB), because what survives the first pass is exactly what
the model already decided was music. The numbers are in `docs/KNOWN_LIMITATIONS.md`. And the match is a *shaping*: on the song it was built against it moved about
±1.2 dB across 500 Hz–4 kHz with +3.5 dB of air at 8 kHz. It is a real, measured
correction. It will not turn a poor take into a good one.

**When it finishes** the `<song> — Cover` session is open in the multitrack view, ready to
play and to **Mix Down**.

## Tempo, remix, stems, transcription and the voice changer

These features are opt-in: nothing here runs until you ask for it, so opening a
file never pays for an analysis you didn't want.

### Detecting the tempo

To find a track's tempo: open it and run **Pipeline → Detect Tempo**. The
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
octave-correction buttons on the TEMPO card — and in the Properties panel's
Tempo row, and in the Match Tempo, Align Vocal Timing and Auto-Remix tools —
are for: they re-track the beats at the corrected period rather than just
relabelling the number, so everything built on the grid moves with it. The
labels vary by surface: the **TEMPO card** and the **Align Vocal Timing** tool
render them as **×2** and **÷2**; the **Match Tempo** and **Auto-Remix** tools
and the **Properties** Tempo row use plain `x2` and `/2` (the Properties row
lists `/2` first). Same operation everywhere, whatever the glyph.

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
  draw are on the wrong beat, the ◂ ▸ downbeat shift in the Auto-Remix tool is
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
multitrack, dragging or trimming a clip snaps it to the **edges** (start and
end) of the *other* clips — on any track — to their beats and markers, and to
the session cursor. **Split at Cursor** cuts exactly where the cursor sits:
place it with a click, a drag or a ruler scrub and it is already on the beat,
marker or clip edge the magnet chose (hold `Alt` while placing it to cut
off-grid); the split itself never snaps.

When two kinds of target are both within reach, the magnet prefers what you
**placed** over what was **derived**: a clip edge or the session cursor beats a
marker, and a marker beats a beat line. Drag a clip's head onto its
neighbour's end and it lands there sample-exact — a clean butt join with no
overlap and no crossfade — even when a beat happens to sit a pixel closer.
When dropping from the Files panel, the drop line turns **white** when an edge
or the cursor has caught the clip, and stays **cyan** on a beat or marker.

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

Dropping a clip on top of another clip on the same track keeps it exactly where
the magnet showed it — the overlap is deliberate, and the two clips' facing
fades are set to span it so it plays as a crossfade. Hold **Ctrl** at the drop
to push the clip forward clear of its neighbour instead (it then sits at the
neighbour's edge rather than on a beat).

### Matching one tempo to another

To make a 128 BPM loop sit in a 124 BPM track:

1. Select the region to retarget (or select nothing, to retarget the whole
   document).
2. **Pipeline → Match Tempo**. The tool prefills the source BPM from the
   detection; **Re-detect from selection** re-runs it against the region the
   ratio will be applied to. A selection of 30 seconds or less is analysed in
   full; a longer one is measured over a **centred 30-second excerpt** of it
   rather than end to end, because detection wants a representative stretch, not
   a complete one.
3. Enter the target BPM — or switch to a plain ratio. The tool shows which
   quality band the resulting stretch falls in (transparent / good / extreme).
4. Optionally tick the beat-marker grid, which lays down markers at the *new*
   tempo as a separate, separately-undoable step.
5. **Apply**.

If the material's own tempo *moves* — an accelerando, a ritardando, rubato, or a
step change partway through — one ratio is the wrong tool, because it corrects
the drift only on average and leaves the middle of the region furthest out. Set
**Correction** to **Follow the tracked beats**. That builds a tempo *map* from
the beat grid and moves each tracked beat onto the target grid individually
instead of sharing one ratio between them. On synthetic accelerandi with exact
ground truth, the worst interior beat improves from 526 ms off to 4.6 ms at a
0.83 BPM/s drift — 526 ms being 0.96 of a beat, so nearly a full beat out in the
middle of a passage most listeners would call steady.

It is opt-in and the default is unchanged, deliberately: a steady loop does not
want per-bar correction, and a wrong single ratio is uniformly wrong and audible
at once, while a wrong tempo map is wrong *differently in every bar* — much
harder to hear and impossible to undo by ear. So it is only ever built from a
grid you have confirmed with the tick, and that tick is cleared by every ×2 / ÷2
re-track and every re-detect. On a perfectly steady grid it reproduces the
one-ratio result byte for byte.

One thing it does not do: it follows the **beats**, not the singing — see below.

Match Tempo runs through the same WSOLA **Time Stretch** effect and the same
single write path as everything else, so undo behaves normally — the History
entry reads `Match Tempo`. How many entries one Apply leaves depends on the
mode. The **default one-ratio** path leaves at most two: `Match Tempo`, which
carries the marker remap inside it, and — only if you ticked the grid —
`Add Beat Markers`. **Follow the tracked beats** adds one in between: markers
you already had inside the region are moved through the tempo map itself rather
than proportionally, so they stay on the audio they mark, and that correction is
its own `Match Tempo Markers` entry. Its full sequence is therefore
`Match Tempo`, `Match Tempo Markers`, `Add Beat Markers`. One Ctrl+Z steps back
through them one at a time, newest first.

### Making a sung take land on the beat

Match Tempo cannot fix this — including in its follow-the-beats mode, and the
reason is worth being precise about, because the two features now look similar
and are not. Follow-the-beats warps by the **tracked beats of the material**: it
puts the beats where the target grid wants them. Align Vocal Timing warps by
**syllables you marked**. A singer who drags one line and rushes the next is off
*relative to beats that are already in the right place*, so a tempo map moves the
beats she is already late against and leaves her just as late. **Align Vocal
Timing** can fix it, because it warps at a different rate between each pair of
syllables — anchors that describe the singing rather than the pulse.

Use follow-the-beats when the *music's* tempo moves; use Align Vocal Timing when
the *singer* moves against a tempo that does not.

It works from *anchors you confirm*, never from a detector's guess:

1. Detect the tempo first (**Pipeline → Detect Tempo**) — the alignment needs a
   beat grid and will never start an analysis on its own.
2. Drop a marker on each syllable you want moved (`M`). Or open the tool and
   press **Suggest syllable markers**, which runs an onset detector and writes
   its proposals in as ordinary markers — then delete the wrong ones. On a real
   solo vocal roughly one proposal in eight is not a syllable (it is a breath, a
   note ending, or a slide), and about a third of the syllables are missed, so
   this step is a starting point, not an answer.
3. **Pipeline → Align Vocal Timing**.
4. Check the grid. The tool shows the BPM the tracked beats imply and the
   detector's confidence, with ×2 / ÷2 to re-track if the octave is wrong.
5. Choose the subdivision. Each option is labelled with the median move it would
   make — that number is the fastest way to tell which grid the performance is
   actually on. A median of 120 ms on **Beat** and 25 ms on **¼ beat** means the
   line is sitting on sixteenths, and snapping it to beats would wreck it.
6. Tick **Grid and subdivision are correct**. Apply stays disabled until you do.
7. Set **Strength**. It defaults to 25 %, and the tool reports how much of the
   median move is left in place. Fully quantised vocals sound machine-made; the
   musical answer is usually partial.
8. **Apply**.

The region keeps its exact length — syllables move *within* it, so nothing after
it slides. Local stretch is clamped to 0.88–1.14× (the range where this stretch
is transparent); a move the clamp holds back lands short of the grid, and the
tool says how many will before you apply rather than after. Pitch is preserved,
so the result can still go through Pitch Correct.

### Fixing one word without singing the whole take again

You know which word came out wrong — you can hear it. What you want is to sing
that one word again and drop it in, not to re-record the line. **Pipeline → Align
Lyrics** is that.

It works from lyrics *you already have*. The model is never asked what was sung;
it is given the words and asked only where each one is.

1. **Pipeline → Align Lyrics**. The first run downloads a 378 MB acoustic model
   (once, kept with the app's settings).
2. Paste the lyrics, or press **Load from file…** for a `.txt` / `.lrc`. One line
   per line of the song — the words are laid out the way you wrote them.
3. Press **Align**. It runs on the CPU at about 16x realtime, so a three-minute
   song takes roughly ten seconds. With a selection active, only that selection
   is placed.
4. **Click a word to hear exactly that word.** Nothing else plays. Hearing one
   word in isolation is usually all it takes to decide whether it is the one.
5. With the word still selected, press **Record replacement** and sing just that
   word. Press **Stop**.
6. Press **Replace word**.

What the splice does for you, none of which you have to set:

- The silence around your fresh take is trimmed off, against a threshold that
  tries two rungs in turn. The first is the same rule Remove Silence uses — the
  loudest the silence detector reads inside the quietest 500 ms of *your
  recording*. When nothing in the take clears that, the second rung is digital
  silence itself, and that is what makes two ordinary recordings work: one whose
  pauses are literal zeros rather than room tone (a gated interface, a bounced
  file), and one punched in tight with no pause either side at all — a
  self-relative threshold cannot tell those apart from a recording that is
  silent, and it used to refuse them. If nothing clears either rung, the take is
  used whole rather than trimmed. A take that really is silent is refused
  outright, and that is judged separately, against digital silence rather than
  against the take's own level.
- Its level is matched to the word it replaces, and its median pitch is shifted
  to that word's. (Median pitch, not the contour: the word you are replacing is
  usually the one that came out wrong, and its melody is not the one to copy.)
- The take is time-fitted to the span it has to fill, so **no sample position in
  the document moves** — a backing track still lines up, and every other word's
  position is still exact, so you can go straight on to the next word without
  aligning again.
- The two crossfades sit **outside** the word, not across its edges. The whole of
  the old word is replaced; none of it is left mixed under the new one.

The tool reports what it matched — the level correction in dB, the pitch shift
in semitones, the fit ratio and the two seam lengths — and the whole thing is one
`Ctrl+Z`.

**What the positions are worth.** Word starts land within a median 20 ms, and
88 % of them within 100 ms. That is the agreement between two acoustic models
that share no training data, no label set and no size, measured over 51 sung
words of one performance by one singer — a number that involves no hand-marking
at all. Speech is easier: 91 % within 100 ms on the 22-word spoken control, so
aligning a podcast script against its recording is a real use of this.

**It does not tell you which word is wrong, and that is deliberate.** A
per-phone pronunciation scorer was built against this same model and measured on
this same material: it separated the known problem words from the rest at AUC
0.642 against a chance baseline of 0.500, and it flagged 46 of 51 words. A tool
that flags nine words in ten while being barely better than a coin toss is worse
than no tool, so it was cut. Every word in the tool looks identical until you
select it.

**If the lyrics don't match, it says so — and still shows you.** Forced alignment
always returns a position for every word, including when the words are wrong: it
will place the wrong lyrics confidently in the wrong places. A warning appears
when the words do not appear to match the audio. It is a warning, never a
refusal, because the measurement behind it is not clean enough to overrule you —
the positions are shown either way, and a few clicks tell you which it is.

**Replacements come from the microphone.** There is no "import a replacement from
a file" button; the take is recorded here, in your own voice.

### Re-arranging a track to a length (Auto-Remix)

To make a song fit a 2-minute video without time-stretching it:

1. Open the track and run **Pipeline → Auto-Remix**.
2. Confirm the tempo and the downbeat the tool reports (use ×2 / ÷2 if the
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
another way to hit the same length), **📌 Pin** (keep it — see below),
**◂ ▸ Nudge** (move the edit one bar earlier or later without changing the
output length), plus **Re-roll** and **Revert to auto**. Every adjustment
appears in the History panel and steps back with `Ctrl+Z`.

**Pinning, and where the promise stops.** A pin is a guarantee: a pinned splice
survives every re-plan and re-roll, or the panel tells you by name why it could
not — you rejected it, it is not a legal splice for the current phrase and
repeat settings, or it cannot coexist with the other pins you kept. A rejection
always wins over a pin. **That guarantee covers up to 4 pins.** You may pin up
to 8, but from the 5th onward the planner cannot enforce them exactly (the
search it would need doubles in size and time with every pin), so it falls back
to treating pins as strong preferences — and says so, both on the pin button
before you press it and in a note above the list afterwards. Unpin back down to
4 and re-roll to get the guarantee back. If you edit or close the *source*
document, the remix session goes stale and read-only — the rendered audio stays
fully editable, but it can no longer be re-planned against a grid that no
longer describes the source.

### Separating a track into stems

To split a song into drums, bass, vocals and everything else:

1. Open the file and run **Pipeline → Separate into Stems**.
2. The first time only, the tool offers the **one-time 166 MB model
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
detected and the tool says the exact sum will not hold); a **mono** source's
stems arrive as stereo documents with identical channels (use **Edit → Convert
Channels…** if you want them mono); and the five stem documents have never been
written to disk, so closing one — or quitting — prompts you to save it.

### Transcribing speech

To turn speech into timestamped text with a speaker label per segment:

1. Open the recording and run **Pipeline → Transcribe**.
2. The first time only, the tool offers the **one-time ~323 MB model
   download** with byte progress (Whisper base, plus a speaker-embedding
   model). They are fetched once and kept.
3. Choose the **number of speakers**, or leave it on *Detect automatically*.
   You can change this afterwards — see the honesty note below.
4. Press **Transcribe**. Progress runs through decoding, then a short pass
   that measures each segment's voice, then the grouping. Transcription runs
   at roughly **9x realtime** on a modern multi-core CPU, so a ten-minute
   interview takes about a minute. **Cancel** stops it immediately.
5. You land in the **Transcript** panel: one row per spoken segment with its
   time, its speaker and its text. Click a row's time to move the cursor
   there. The same segments appear as coloured bars in a thin strip between
   the time ruler and the waveform — click one to jump to it.

**To come back to a transcript later**, run **Pipeline → Transcribe** again on
the same document: when a transcript already exists the tool shows it rather
than re-running the model, so it costs nothing to reach. The panel itself has
the button to run a fresh one when you actually want that. (There is no
Transcript icon in the module strip: a transcript is what the Transcribe tool
produces, not a module of its own.)

**Read this before you trust the speaker labels.** Speaker separation was
measured on clean recordings with one voice at a time. It told **two**
speakers apart with every segment correct, and recognised a single speaker as
one person every time. With **three** it placed only 45 % of segments
correctly — 73 % even when told there were three. And it does not detect
**overlapping speech** at all: a segment with two people talking over each
other gets one label. So the **Speakers** control in the panel is there to be
used: set the count yourself and the grouping is recomputed instantly from the
voices already measured, with no second transcription run. A segment the
grouping could not place — too short to measure, or sitting between two
different voices — is labelled **Unknown** rather than guessed into someone's
mouth.

**Exporting.** The **SRT** and **WebVTT** buttons write standard subtitle
files with the speaker labels included (`Speaker 1: ...` in SRT, the spec's
own `<v Speaker 1>` voice span in WebVTT). Times are kept as sample positions
internally and only converted at the moment of writing, so they line up with
the audio exactly.

**Practical notes:** a job is capped at **2 hours** of audio; the language is
detected automatically; **singing is not speech** and Whisper mangles lyrics
even on a clean solo vocal (see
[Known Limitations](KNOWN_LIMITATIONS.md) for the measured word error rates);
and if you edit the audio after transcribing, the panel warns you that the
times no longer line up rather than quietly throwing the transcript away.

**A transcript lasts only as long as the session.** It is not saved into the
audio file or the `.audm`, and closing the document — or quitting — discards
it without asking. **Export to SRT or WebVTT before you close** if you want to
keep it; that file holds the same timestamps, speakers and text the panel
shows.

### Changing a voice

`Pipeline → Voice Changer` makes a recording sound like a different speaker while
keeping the words and the delivery. Everything runs on your own CPU — no
account, no upload.

**Setting up a voice.** The tool holds a list of **voice profiles**: saved
reference voices you can reuse. Add one with **New voice from file…** (any audio
file) or **New voice from selection** (whatever is selected in the open document,
which is the quickest way to try a voice you already have on the timeline; it
stays disabled until something is selected). A reference of
roughly **6–12 seconds of clean speech** is what the model was measured on;
much shorter gives it little to work with, and it will not accept a reference
longer than 350 seconds.

**The consent affirmation.** Before a reference clip can be saved — and again
before any conversion runs — you have to tick the statement that you have the
right to use that voice. It is never pre-ticked, and the Convert button stays
refused until it is set. This is deliberate and it is not a formality: the
conversion is good enough to impersonate a real person, and since any recording
can be a reference, the decision that matters is which clip you point it at.

**Converting.** Pick a profile, tick the affirmation, and press **Convert**.
The first run downloads a 161 MB model set (shown with byte progress); after
that it is instant to start. Progress reports the resampling, embedding and
conversion phases with a time estimate, and **Cancel** kills the inference
process outright rather than waiting for it to finish. The result arrives as a
**new mono 22050 Hz document** named after the source and the profile — your
original is untouched. Expect roughly **4× realtime** on a modern laptop CPU:
a three-minute vocal takes about 45 seconds.

**What to expect from the result.** It is a voice *change*, not a clone.
Measured against an independent speaker-verification encoder over nine
conversions to five real voices, the output landed closer to the target than to
the source in 8 of 9 cases and never still verified as the source — but only
about half cleared the threshold that would call it the *same* person as the
target. So the honest expectation is "clearly someone else, recognisably in the
target's direction".

Two things follow from that, and they are the difference between a good result
and a disappointing one:

- **Pick a reference that sounds different from the source.** The effect is
  proportional to the distance between the two voices. The one conversion that
  failed to move was between two low male voices 1.7 semitones apart. If the
  reference already sounds like the speaker you are converting, the change will
  be subtle by nature, not by fault.
- **Big pitch moves cost clarity.** Word error rate against the unconverted
  source ran from 0 % up to 27 %, and the worst case was the largest jump
  (+8.1 semitones). The sentence stayed recoverable in every test, but if the
  words matter more than the disguise, choose a nearer target.

**Practical notes:** a run is capped at **30 minutes** of audio; long
recordings are processed in ~30-second chunks so memory stays flat rather than
growing with the file; and profiles persist between sessions, so a voice you
set up once is one click away next time.

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

Leaving **Multitrack** for Waveform or Spectral with a clip selected opens
that clip's source document with the clip's span selected, the cursor at its
start and the view fitted to it. With several clips selected the primary (the
one the **Properties** tab shows) is used; with no clip selected, or a clip
whose source file has been closed, the editor shows the document you left as
before. The carry is one-way — the editor selection does not flow back into
the session.

Both views share the same selection, cursor, playhead, marker and beat-grid
overlays, and the same zoom/scroll gestures.

## Multitrack

**View → Multitrack** opens the session editor — it works even with no
document open. A session has a name, a sample rate, and any number of tracks.

<!-- MT2: session rate adoption -->
### The session's sample rate

**An empty session takes the sample rate of the first file you put on it.** A
new session starts at 44 100 Hz, but that is a placeholder rather than a
choice — until a clip is on the timeline there is nothing measured in that rate
— so inserting or dropping a 48 kHz file re-states the session at 48 kHz and
places the clip at its own length. Nothing is converted, and playback starts
immediately.

Once the session holds a clip its rate is fixed. A later file at a different
rate is **converted** to the session's rate as it is placed, which is the only
answer that keeps two files at two rates in the same timeline. That conversion
now happens once, in the background, when the file is placed — not every time
you press Play.

A session loaded from a `.audm` keeps whatever rate it was saved at, and one
built for you — by **Separate Stems**' "place in a session" or by the **Cover
Chain** — takes it from the audio it is built out of. Those all adopt on their
next insert too, but only while they are still empty of clips.

<!-- MT1: session zoom/Fit semantics -->
### Zoom and Fit in the multitrack

The toolbar's `− · % · + · Fit` cluster follows whichever view is open, and in
the multitrack it drives the **session**, not the document behind it. It stays
live even with no document open, because the session is what it zooms.

**100% is Fit: the LONGEST track exactly fills the lane.** A session opens
fitted, so a 2:58 track is on screen whole rather than showing its first few
seconds. Fit is also the furthest the session zooms out, so the readout never
drops below 100% and pressing `−` at 100% does nothing.

Dropping or inserting the **first** clip into an empty session re-fits it —
there was nothing on the timeline to have chosen a zoom for. After that your
zoom is yours: later inserts leave it alone, so placing a clip against a beat
at high zoom does not yank the timeline back out. The one exception is a
session already sitting exactly at Fit, which stays fitted (this is also what
makes dropping several files at once show all of them rather than just the
first). Resizing the window keeps a fitted session fitted.

`Ctrl`+wheel zooms on the pointer and `Shift`+wheel scrolls, both bounded by the
same limits as the buttons.

- **Tracks**: each has a name (double-click to rename), Mute/Solo/Arm toggles,
  a volume slider (−60..+12 dB) and a pan slider (−1..1). **Add Track** adds
  an empty track. Arm (R) marks a track as a recording target — see **Recording
  into the multitrack** below.
- **Dragging a file onto a track**: drop a row from the **Files** panel onto a
  track lane and that document becomes a clip where you dropped it. You can
  also drag an audio file straight from Explorer onto a lane — it is opened
  through the normal open path (so it appears in the Files panel too) and then
  placed. While you drag, the lane under the pointer highlights and a ghost
  line shows exactly where the clip will start; **no highlight means no
  action**, so dropping anywhere that is not a lane does nothing. The drop
  position snaps like a clip drag does, and `Alt` suspends that. The whole drop
  is a single undo step (`Add clip`, or `Add clips` when you drop several files
  at once), so one `Ctrl+Z` lifts all of it. Dropping something that is not an
  audio file is refused the same way **File → Open** refuses it, and leaves
  nothing half-created.
- **Clips**: **Edit → Insert Active File at Cursor** places the whole active
  document as a clip on the selected (or first) track at the multitrack
  cursor. Drag a clip to move it and drag its edges to trim; both snap to the
  beats and markers of the other clips and to the session cursor (hold `Alt` to
  suspend that — see **Snapping to the grid**). A single clip dragged onto
  another track lands there: the track under the pointer is the one that
  highlights and the one the drop commits to, and **its name column counts as
  part of it**, so a drag that has wandered left over the controls still drops
  on the row you are pointing at. Point at no row at all — the ruler, the space
  below the last track — and the clip simply stays on its own track, which is
  what the preview showed you. A clip dropped over a
  neighbour on the same track overlaps it deliberately and the overlap plays
  as a crossfade; hold `Ctrl` at the drop to nudge it forward clear of the
  neighbour instead (see **Clip fades and crossfades** below). Click a clip
  to select it — its facts (source document, start/offset/length, and an
  editable gain in dB) appear in the **Properties** tab, along with its
  fade lengths and curves; switch to Waveform or Spectral to open that clip's
  source span in the editor (see **Views**).
- **Playback**: the multitrack view has its own transport, cursor, and
  playhead, driven by the same toolbar-pill transport buttons. The session
  cursor wears the same **red triangle handle** as the editor views, at the
  top of the lanes: grab it and drag to move the cursor live — grabbing alone
  moves nothing, the drag obeys the session magnet (`Alt` suspends it), and
  moving the cursor never interrupts a running playback, because the cursor is
  where the *next* play starts. There is no pause in
  multitrack playback (v1) — Play/Pause toggles play↔stop. Volume, pan, and
  mute/solo changes apply **live while playing** — the realtime monitor uses the
  same pan law as Mix Down, so it matches the render. Clip moves, trims, and clip
  gain take effect on the next play. A parameter governed by an automation
  envelope is the exception: its fader is disabled and the envelope carries
  the value (see **Track automation** below).
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
- **Projects**: **File → Save** / **Save As…** (`Ctrl+S` / `Ctrl+Shift+S`)
  write the **project** to a `.audm` file — in every view, not only this one.
  The project is the session (tracks, clips, automation, fades) plus **every
  open document** with its audio, markers, name and origin path, whether or
  not a clip references it — nothing is dropped. **File → Open Project…**
  restores all of them into the Files panel and switches to the multitrack
  view. Project files are format v4, a binary layout (JSON header + raw audio
  payload, no base64); v1–v3 `.audm` files still open normally, but a v4 file
  does not open in older builds (v1.35 and earlier). The status pill shows the
  project's name, starred while anything in it is unsaved.

<!-- K1: clip selection, edge navigation, ripple delete -->
### Selecting clips, walking the edges, and ripple delete

**Selecting.** Clicking a clip selects it, and clicking empty lane space
clears the selection — as before. **`Ctrl+Click` adds a clip to the selection
instead of replacing it**, and `Ctrl+Click` on a clip already in the selection
takes it back out. The set may span tracks. `Escape` clears it. Every selected
clip wears the selected border, and the Properties panel shows **"N clips
selected"** above its fields.

**`Shift+Click`** extends the selection from the primary (below) to the clip you
click, taking **every clip between them on that track**, in timeline order. It
*adds* to what is already selected rather than replacing it, so a set built with
`Ctrl+Click` survives a `Shift+Click` that extends it. Across tracks it acts as
a plain click: a range needs one timeline to be a range, and sweeping every clip
inside a rectangle is not what `Shift+Click` means in a track-based editor. With
both modifiers held, `Ctrl` wins and the click is a toggle.

**`Ctrl+A`** selects every clip on every track. In the waveform and spectral
editors the same key still selects the whole file — the multitrack view has no
document region on screen to select.

The clip you clicked **last** is the *primary*, and it is the one the panel's
single-clip controls edit — Start, Gain, the fade lengths and curves — as well
as the one carrying the corner fade handles. Those controls are single-clip
editors and stay that way: a length field showing one clip's value while
committing to five would be lying about what it does.

**What the set does.** Three things, and each is one undo step:

- **Drag** any selected clip and the **whole set moves with it**, rigidly, by
  the same amount. **Every member previews the move while you drag**, not just
  the one under the pointer, and the preview is the position the drop will
  commit — including where the drop is refused. If the drag would push the
  earliest member before the start of the timeline, the whole group stops there
  together rather than the leading clip flattening against zero while the rest
  keep going, and the preview stops with it instead of sliding somewhere the
  clips then snap back from.

  **Onto another track.** The clip you grabbed joins the track under the
  pointer, and every other member shifts by the same number of tracks — so a
  group spread over two lanes is still spread over two lanes when it lands. If
  that would push any member off the top or the bottom of the track list,
  **nothing changes track at all**: the group is never half-moved, because
  there is no partial shift that keeps its shape. The highlighted lane always
  shows where the grabbed clip will actually land, so a group that cannot move
  down lights its own lane rather than the one you are pointing at.

  Holding **`Ctrl` at the drop** — the push-clear nudge on a single-clip drag —
  does **nothing** on a group drag: pushing only the colliding member clear
  would change the spacing between the clips you are dragging, and a group drag
  that deforms the group is not the gesture you made. The group lands where you
  dropped it, and any overlap that creates arms a crossfade as usual. The drop
  hint that appears over an overlap says so — during a group drag it offers no
  `Ctrl` nudge, because there is none to offer.
- **`Delete`** removes every selected clip, leaving the gaps where they were.
- **`Shift+Delete`** is **Ripple Delete** — see below.

**Walking the clip edges.** `Ctrl+Left` and `Ctrl+Right` move the multitrack
cursor to the previous/next **clip boundary**. With the cursor inside a clip
that means its start and its end; keep pressing and the cursor walks the union
of every clip start and end **across all tracks**, which is what makes it a
navigation gesture rather than a two-position toggle. Standing exactly on a
boundary, the next press moves to the one beyond it, so the key never appears
stuck. Past the last edge (or before the first) nothing moves — there is no
wraparound, and no invented boundary at the start of the session. The magnet is
not involved: these targets are already exact, and snapping could only pull the
cursor off the edge you asked for.

It also works while the session is playing. The multitrack cursor is **where
the next Play starts**, not the running playhead, so moving it mid-playback
re-arms the next start and leaves the transport alone.

**`Home` and `End`** move the same cursor to the two ends of the session:
`Home` to sample 0, `End` to the end of the **last clip on any track**, each
scrolling the timeline so the destination is on screen. Both leave the zoom
level alone. `End` is unavailable in an empty session, where the end and the
start are the same place; `Home` always works. In the waveform and spectral
editors the two keys still address the active file, unchanged.

**Ripple Delete** (`Shift+Delete`, or **Edit → Ripple Delete**) removes the
selected clip(s) **and closes the gap**: on each affected track, every clip
that lies entirely after a removed clip slides left by that clip's span. It is
per track — deleting a clip on track 1 never moves anything on track 2 — and
per selection: with several clips selected, each track closes its own gaps, and
two selected clips that overlap each other remove their union once rather than
their two lengths twice. A clip that merely *overlapped* the removed one is not
"after" it and does not move.

The whole thing is one undo step: one `Ctrl+Z` puts the clips back **and**
undoes every shift. If a shifted clip lands on top of its new neighbour, that
overlap arms a crossfade exactly as dragging it there would have — it goes
through the same maintenance a drag does, not a special case.

**Edit → Ripple Delete Time Selection** sits under it and is **greyed out in
every view**, in this version and deliberately. It would remove a stretch of
*time* from every track at once and close the gap everywhere — but the
multitrack view has no way to select a stretch of time: it has a cursor and a
clip selection, and dragging on its ruler moves the cursor rather than sweeping
a range. Until that gesture exists there is nothing for the command to act on,
so the row says so by staying unavailable rather than by silently doing
something else. Ripple Delete of the **selected clips** (above) is the form that
works today, and selecting the clips that cover the stretch you want gone is the
way to get the same result.

### Splitting clips

`Ctrl+K`, **Edit → Split at Cursor**, or the edit pill's **Split** button cuts,
at the **cursor**, every clip under it on every track that owns a selected clip.
One selected clip splits its own track; clips selected across several tracks
split all of those tracks; with nothing selected the command is greyed, because
"which tracks" has no answer.

That is deliberately track-scoped rather than clip-scoped: an unselected clip
sitting under the cursor on a selected clip's track is cut too, so a cut across
a stack of tracks is one act rather than one per clip.

The left piece keeps the clip's fade-in, the right piece its fade-out, and the
new seam has none — the two halves butt together, so nothing is heard at the
cut. A crossfade with a neighbour survives untouched.

The cursor has to sit **inside** a clip, at least 32 samples from either edge,
and outside any overlap with another clip on the same track. A clip that fails
any of those is simply left alone; when no clip on the selected tracks
qualifies, the row and the button are greyed rather than doing nothing quietly.

The whole act is **one undo step**, however many clips it cut. Afterwards the
right-hand pieces of the clips you had selected join the selection (the
left-hand pieces keep the original clips' identity), so a second `Ctrl+K`
further along the timeline acts on the same tracks.

### Merging clips

**Edit → Merge Clips**, or the edit pill's **Merge** button, does the opposite:
it takes the clips you have selected on a track and gives you **one** clip in
their place. There is no keyboard shortcut, and the command is greyed outside
the multitrack view.

Selection decides everything. Every track that has **two or more** of its clips
selected is merged, all of them in the same act; a track with only one selected
clip is left exactly as it was, which is why the button is grey when a single
clip is selected. The new clip runs from the **earliest start** to the **latest
end** of its members, and every part of that span no member covered comes back
as **silence** — merging two clips with a gap between them gives you one clip
with the gap still audible as nothing, not a clip with the gap closed up.

The audio is rendered, not referenced. Each merge writes a new file named
`Merge N` into the Files panel — the same kind of computed document Mix Down
and the stem separator produce — and makes it the active one. What goes into it
is exactly what you were hearing from those clips: each member's **clip gain**
and its **fades** (including a crossfade armed between two members) are
rendered into the samples. What stays outside is everything that belongs to the
**track** rather than the clip — volume, pan, mute, solo and automation still
apply to the merged clip as they did to its members. So the merged clip itself
reads gain 0 dB with no fades in the Properties panel: those are inside the
audio now, and re-editing them means undoing the merge.

Clips you did **not** select are not touched. One sitting inside the merged
span is neither absorbed nor moved — the merged clip simply overlaps it, the
same way a clip dropped on top of another does.

The whole thing is **one undo step** however many tracks merged, and undo puts
the original clips back exactly as they were. It does not remove the `Merge N`
file, though: like every computed document it stays open in the Files panel,
and it will ask before closing because its audio has never been on disk.

### Undo in the multitrack (session history)

Every session edit is undoable: clip moves, trims, deletes, gain changes and
splits, fade and crossfade edits (arm/release included), automation-key adds,
moves, deletes and curve changes, track add/remove/rename, the fader and pan
sliders, the M/S/R toggles, spatial placements, recorded takes, and **New
Session** itself.

- **Where Ctrl+Z goes**: the session has its own undo history, separate from
  every document's — the same per-document model the editor already follows.
  In the **multitrack view**, `Ctrl+Z`/`Ctrl+Y` address the **session's**
  history (no document needs to be open); in the waveform or spectral editor
  they address the **active document's**, exactly as before. The History
  panel shows whichever history is active.
- **One gesture is one step**: a drag is a single undo step no matter how
  many times the screen updated on the way — one `Ctrl+Z` reverts a whole
  trim or fade drag, a recorded take across several armed tracks, or an Arm
  Crossfade (both facing fades together). Contiguous keyboard nudges on the
  same fader (arrow keys within about a second) merge into one step too.
- **View state is not undoable**: scrolling, zooming, moving the cursor or
  playhead, selecting a clip, and opening an envelope lane never create undo
  steps — undo is for edits, not navigation. Undoing an edit does restore
  the selection to the affected clip so you can see what changed.
- **Limits**: like documents, the session keeps up to 50 steps, in memory
  only. **Open Project…** and stem landing start a fresh history (undo does
  not reach across a load); **New Session** is itself undoable.

### Clip fades and crossfades

Clip fades are **non-destructive clip properties** — they shape the clip's
level at render time (identically in live playback and Mix Down) without ever
touching the audio samples, unlike the destructive **Fade** effect in the
editor. They are saved in the `.audm` session; a session with no fades stays
byte-identical on disk to what v1.8.0 wrote, and a fade-carrying session
still opens in v1.8.0 — just without the fades.

**Shaping a fade.** Select a clip: two small square handles appear in its top
corners. Drag the left handle right to lengthen the fade-in, the right handle
left to lengthen the fade-out; the shaded ramp overlay is the actual gain
curve the renderer will apply. The **top 10 pixels at each end of a selected
clip belong to the fade handle**, not to edge trim — trim still works from
the rest of the edge band below the handle. On a clip narrower than about
20 pixels the two handles coincide; zoom in to grab them separately. The
selected clip's **Properties** panel has a Fades section with an exact length
field and a curve picker per edge; a fade can never exceed its clip, and the
two fades can meet but never cross (the standing fade wins the room).

**The curves.** The clip picker names curves by the **summing law** they
hold, because a crossfade has two sides: **Equal power** (holds the level
when the two sides are different material — the default), **Equal gain**
(holds the level when both sides are the same material, e.g. a loop
repeating), **Smooth** (equal gain with eased ends), and **Ducked** (drops
fast and comes back late, leaving a deliberate dip at the join). The
destructive Fade *effect* keeps shape names — **Linear** and **Cosine** —
because a solo fade over a selection has no second signal and no join, so a
summing-law name would describe nothing there; Linear is the same curve as
Equal gain and Cosine the same as Smooth, and the effect also offers Equal
power. ("Ducked" is the curve formerly labelled "Exponential" — the shape is
`t²`, which is quadratic, so that name was simply wrong.)

**Overlapping is deliberate, and it crossfades.** Dragging a clip into a
same-track neighbour commits exactly where the preview shows it and **arms
the pair**: both facing fades are set to span the overlap, and the overlap
renders as a real crossfade (the X-shaped gain lines and a width readout are
drawn in the region). Moving or trimming either clip re-arms the pair at the
new width automatically. Two modifier keys do different things here:

- **Ctrl held at the drop** restores the old v1.8 behaviour instead — the
  dropped clip is pushed forward clear of the neighbour (this is also the
  precise way to butt-join two clips). A pill inside the dragged clip shows
  which of the two will happen.
- **Alt** suspends the snapping magnet, exactly as everywhere else — it does
  not affect overlap behaviour.

**When an overlap is NOT a crossfade.** A crossfade renders only when both
facing fades **exactly** span the overlap. Anything else — partial facing
fades, a raw layered take, equal start positions, one clip fully containing
the other, or three clips piled on one region — renders as honest solo fades
over a raw sum (which can clip, and is hard-clamped, exactly as in v1.8.0).
Recorded punch-ins and Insert Active File never write fades: layering a take
over another is left as a raw sum until you decide otherwise.

**Arm and Release are the managed path.** For an overlap that is capable but
not armed, the Properties panel shows **Arm crossfade** (it writes both
facing fades to the exact width; it is disabled when a fade on the far side
of either clip leaves no room). **Release** clears both facing fades and
returns the overlap to a raw sum. Note that **dragging a facing-fade handle
of an armed pair dissolves the crossfade** into two solo fades — the fade no
longer spans the overlap exactly, so the pair stops crossfading (visible
immediately in the overlay, and recoverable with Arm). To adjust a
crossfade's width, move or trim the clips; to manage its existence, use
Arm/Release. Each side's **curve** stays freely editable while armed.

**A third clip silences, not destroys.** If another clip moves onto an armed
pair's overlap region, the crossfade stops rendering (three simultaneous
signals have no pair law) and the panel reports the overlap as a raw sum —
but the stored fades are deliberately left in place, so moving the intruder
away revives the crossfade with no further action.

### Track automation (volume and pan envelopes)

Automation makes a track's **volume** or **pan** vary over time: an envelope
of keys drawn on the track lane itself, applied identically in live playback
and Mix Down (bit-exact — the envelope is baked into the render on both
paths, never approximated by the audio graph's own parameter scheduling).

**Opening a lane.** Each track header has a small activity toggle beside its
volume slider and another beside its pan slider. Click one to open that
parameter's envelope over the track lane (one envelope is open at a time;
click again to close it). While a lane is open it owns the track lane's
mouse — close it to select, drag, or trim the clips underneath.

**Editing.**

- **Click** empty lane space to add a key at that time and value (up is
  louder / pan right; the current value is shown in a readout while you
  hold). With no keys yet, the dashed line shows the fader's own value —
  the first key takes over from it.
- **Drag** a key to move it in time and value. Keys snap to the same beat
  and marker targets as every other timeline gesture; hold `Alt` to suspend
  the magnet. The store commits once, on release.
- **Right-click** a key to delete it. Deleting the last key hands the
  parameter back to the fader.
- **Double-click** a key to cycle the curve of the segment leading to the
  *next* key — Equal gain (a straight line, the default), Equal power,
  Smooth, or Ducked, the same curve family as the clip fades; a small label
  flashes the new choice.

**The envelope governs.** While a lane has at least one key, that parameter's
header slider is disabled and its static value is ignored — the envelope *is*
the volume (or pan). Before the first key and after the last one the nearest
key's value is held flat; a single key therefore holds its value for the
whole timeline. Editing during playback re-bakes just the affected track, so
the change is heard without restarting the transport.

**Sessions.** Envelopes save into the `.audm` alongside everything else. A
session that never used automation stays byte-identical on disk to what
earlier versions wrote, and an automation-carrying session still opens in
v1.9.2 — the lanes are simply not shown there and survive a re-save.

### Spatial placement (the Spatial panel)

**Effects → Spatial Positioner** (or the **Mix** row in the Effects card)
opens a positioner that
places a track's sound around the listener: a top-down stage (front is up)
where you drag the source, an elevation slider, and readouts for the three
position parameters — **azimuth** (direction, −180°..180°, positive to the
right), **elevation** (−90°..90°) and **distance** (multiples of a reference
distance, 0..10×).

**What it is — honestly.** The placement is a **stereo projection**:
amplitude panning (the position's component along the left–right axis) plus
distance level (unity at or inside the reference circle, −6 dB at 2×, −20 dB
at 10×). It is **not binaural** — there is no HRTF processing — so a source
behind you sounds like its mirror in front, and elevation only narrows the
image toward the centre (straight overhead is dead centre). The panel's
"Stereo:" readout always shows the actual stereo position and level your
placement produces.

**Placing and keyframing.** The panel follows the playhead: the dot shows the
track's spatial automation evaluated at the current position, moving during
playback. Dragging the dot previews the new position and, on release, writes
**azimuth and distance keys together** at the playhead (the elevation slider
does the same for elevation; an unreleased elevation tweak rides along with
the next stage commit — what the panel shows at release is exactly what
lands). Keys live on ordinary envelope lanes: the three small toggles open
the azimuth / elevation / distance lanes on the track for timeline editing
with the same gestures as volume and pan (click add, drag move, right-click
delete, double-click curve).

**Spatial supersedes pan.** While any spatial lane has a key, the track's
placement comes from the spatial position and the pan control — the fader
*and* a pan envelope — is ignored; the pan slider disables with an
explanation. Remove the spatial keys to hand placement back to pan.

**The ±180° seam.** Azimuth is a circle, and a segment between two keys
always travels the **short way** around it: keys at 170° and −170° sweep 20°
behind the listener, not 340° back across the front. To make a sound travel
the long way round deliberately, add an intermediate key along the intended
path (for example at 0° for a front pass). Keys exactly opposite each other
take the leftward arc, by definition.

Spatial placement renders identically in live playback and Mix Down (baked,
bit-exact — the same guarantee as volume and pan automation) and saves into
the `.audm` with everything else; older builds open a spatial session with
the lanes preserved but inert.

An empty session (no clips on any track) shows an inline hint pointing at
Insert Active File; the main editor area shows "Open an audio file (Ctrl+O)
or create a new one (Ctrl+N)" when no document is open in the waveform/
spectral views.

## Export

**File → Export…** (`Ctrl+E`) renders the active document to a new file
without changing the open document's path or dirty state:

- **WAV**: 16-bit, 24-bit, or 32-bit float.
- **FLAC**: 16-bit, lossless (verbatim — no quality setting).
- **MP3**: 128/192/256/320 kbps (constant bitrate only). MP3 encoding — here
  and in the format-faithful MP3 Save below — is provided by the bundled
  **lamejs** library (LGPL-3.0); see
  [`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md) at the repository root.
- **OGG (Opus)**: 96/128/192 kbps.

In the **multitrack view**, Export renders the **session mixdown** — the same
render as **File → Mix Down to New File** (mute/solo, volume/pan, automation,
fades, hard-clamped; length = the last audible clip end) — to the chosen
format, without adding a document to the Files panel and without markers. The
default file name is the project name. If nothing is audible (an empty or
all-muted session) Export reports "Nothing audible to export." and writes no
file.

Every export writes to a temporary file next to the target and only replaces
it once the write is complete, so an interrupted or failed export can no
longer corrupt or truncate a file already on disk.

**File → Save** (`Ctrl+S`) and **Save As…** (`Ctrl+Shift+S`) write the
**project** (`.audm`) — never an audio file. Export is the only way audio
leaves the app. Save with a project path writes there silently; Save with no
path opens the Save As dialog; Save As always asks, and renames the project to
the file's name. See **Projects** under the multitrack section for what the
file contains.

## Shortcuts reference

See [`KEYBOARD_SHORTCUTS.md`](../KEYBOARD_SHORTCUTS.md) at the repo root for
the full, exact table (transcribed from `src/services/shortcuts.ts`).
