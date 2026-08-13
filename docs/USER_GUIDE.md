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
- **Top right** — the **module strip**: one icon per panel (Files, Effects,
  Markers, History, Properties, Remix, Spatial, Transcript), sitting on top of
  the module column. Click an icon to open its card below the strip; click the
  **open** icon again to close the card, and the waveform takes the whole
  column's width.
- **Bottom, centred on the waveform** — the status pill: the active file's
  `name · duration · rate · channels`, the big time readout, the cursor and
  selection times, the `♩ BPM` readout, the zoom in samples-per-pixel, and the
  L/R level meters.
- **Just above the status pill** — the **edit toolbar** (see *The edit
  toolbar* below), present whenever at least one file is open.

There is no separate file chip: the file's identity lives in the status pill,
and the zoom percentage lives in the toolbar's own `%` readout.

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

Open the Files card from the module strip (the folder icon). Every
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
module strip) lists every applied edit; click any entry to jump the document's state to
that point. Marker add/rename/delete are undoable too (labelled `Add Marker`
/ `Rename Marker` / `Delete Marker` in the History panel), and destructive
edits that change the timeline (delete, paste, trim, replace, sample-rate
conversion, and length-changing effects like Time Stretch/Pitch Shift) remap
or drop affected markers in the same undo step, so undo restores their exact
pre-edit positions.

### The edit toolbar

A pill of eight icon buttons floats just above the status pill, on the
waveform's axis, whenever **at least one file is open** — in the Waveform,
Spectral and Multitrack views alike. It is only ever a shortcut to commands
you already have: nothing here does anything the menu and the keyboard do not.

`Cut · Copy · Paste · Delete` │ `Trim · Silence` │ `Undo · Redo`

- **Trim** keeps the selected region and drops everything else;
  **Silence** zeroes the selected region in place, leaving the length alone.
  Both are undoable History steps like any other edit, and both are also in
  **Edit → Trim to Selection / Silence Selection**, directly under Delete.
  Neither has a keyboard shortcut, so neither menu row advertises one.
- Buttons grey out individually rather than disappearing. With no selection,
  Cut / Copy / Delete / Trim / Silence are greyed; with nothing on the
  clipboard, Paste is greyed; Undo and Redo follow whichever history is
  active — the **document's** in Waveform and Spectral, the **session's** in
  Multitrack.
- In the **Multitrack** view, Cut / Copy / Paste / Trim / Silence are always
  greyed, and their keyboard shortcuts do nothing there either. All five edit a
  region of the **active document**, which that view does not show — and since
  switching views keeps your selection, they would otherwise change a file you
  cannot see, with the Undo button beside them pointing at the session's
  history instead. Hover one for the reason; switch to Waveform or Spectral to
  use it. **Delete** does work there — it removes the selected clip.

### Markers

Press `M` (or **Edit → Add Marker**) to drop a marker named `Marker N` at the
current cursor position. The **Markers** panel (opened from the module strip) lists every
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

### The panel cards (module strip)

The horizontal **module strip** at the top right opens one floating glass
panel card at a time, directly beneath it — **Files**, **Effects**,
**Markers**, **History**, **Properties**, **Remix**, **Spatial** and
**Transcript**; **History** is the default. Clicking the **already-open**
entry closes the card, and the waveform stretches across the column's width;
clicking any entry reopens one. When the active document has a tempo analysis,
a persistent **TEMPO** card (BPM readout, structure strip, and ×2 / ÷2 /
Re-detect) appears between the strip and the panel card.

- **Files** / **Effects** — see their own sections in this guide.
- **Remix** — a remix document's per-splice adjustment rows (quality dot,
  Go To, Reject, Pin, Nudge, Re-roll, Revert to auto).
- **History** — the undo history of whatever is active: the **session's** in
  the multitrack view, the **active document's** elsewhere (see *Cut / Copy /
  Paste / Delete* above and *Undo in the multitrack* below).
- **Markers** — the active document's marker list (see *Markers* above).
- **Transcript** — the active document's transcript, once you have run one
  (see *Transcribing speech* below).
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

Effects live in the **Effects** panel (opened from the module strip), grouped by category, and
mirrored in the **Effects** menu. Double-click an effect (with a document
open) to open its parameter dialog, adjust settings, and apply. Every effect
processes the current selection, or the whole document when there's no
selection.

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
3. Open **Effects → Restoration → Noise Reduction**, adjust Reduction (dB),
   Sensitivity, and Smoothing, and apply to the region you actually want
   cleaned (the capture and the apply regions can differ).

The captured print is in-memory only: it is not saved with the document and
is cleared when you capture a new one — or when you close the document it was
captured from (the print belongs to audio that no longer exists). The Noise
Reduction dialog notices a capture or clear immediately, even while open.

### Vocal Chain (fixing a rough vocal in one pass)

**Effects → Vocal Chain…** runs the corrections a vocal usually needs, in one
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
| 6 | Align Vocal Timing | **manual — run it before the chain** |
| 7 | Pitch Correct | yes |
| 8 | Compressor | yes |
| 9 | De-esser | yes |
| 10 | EQ (high-pass) | yes |
| 11 | Reverb | **no** |
| 12 | Limiter | yes |

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
- the **noise print** is learned from the quietest 500 ms in the selection;
- the **silence threshold** is the loudest that quiet passage ever reads;
- the **high-pass** sits an octave below the lowest note actually sung.

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
dialog before the chain:

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

After the run, every stage reports what it did: the settings it derived and what
it derived them from, the measured RMS and peak before and after, and how much
of the audio it left bit-identical — plus a before/after table of loudness,
peak, crest factor and noise floor. A stage that declined shows the measurement
that made it decline.

Pitch Correct dominates the running time (roughly 0.4× real time on its own; the
whole chain took about 105 seconds on a 142-second stereo take).

### Cover Chain (matching your take to the record's vocal)

`Effects → Cover Chain…` takes the vocal you recorded and the *separated original vocal*
of the song you are covering, and matches your take's tone and level to it.

**Do this first, in this order.** The chain lists all of it, and refuses to do any of
it for you, because each step needs a decision only you can make:

1. Open the original song and run `Edit → Separate into Stems…`. That gives you a
   five-track session and, among the new documents, `<song> — Vocals`: the original
   vocal *as a signal*, carrying whatever was done to it in the mix. That document is
   what everything below matches against.
2. If a word came out wrong, `Effects → Align Lyrics…`. This is **before** the vocal
   chain and not after it: the replacement has to be in the file before any stage
   measures a level or learns a noise print from it, or the new word sits in a
   de-noised, level-matched take with none of that applied to it. Nothing in the app
   judges which word is wrong; you pick it.
3. If your take drifts against the record, `Effects → Align Vocal Timing…`. Also before
   the vocal chain, for the same reason. It needs you to confirm the beat grid — see the
   note in that section about why nothing picks it for you.
4. Open your take and run `Effects → Vocal Chain…` on it, last of the four. The match is
   a correction to a **clean** take — match the timbre of a noisy one and you match the
   noise too.

(The Cover Chain dialog lists these four in registry order, which is the order they are
*listed* rather than the order to *do* them: they are manual stages, so nothing runs them
and the registry's order carries no promise about them. The order to do them is the one
above, and each stage's own note repeats it.)

**Then run the chain.** With your take active, open `Effects → Cover Chain…`, choose the
`— Vocals` document in the **Reference** picker, and press Apply. Three automatic stages
are on by default:

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

The whole pass is **one undo entry**. Every stage reports what it did or why it did
nothing, and the before/after table gives loudness, envelope spread, noise floor and the
spectral distance from the original vocal, with the original vocal's own reading of each
beside them. Only two of those five rows are **targets** — the loudness and the spectral
distance. The Peak row's target is the Limiter's own −0.3 dBFS ceiling, not the original
vocal's peak; the envelope spread is reported and never corrected; and nothing here
matches a noise floor. The table marks the two rows that are matched.

**The envelope spread is reported and never corrected.** A "matched compressor" was
built and cut: the move it asks for changes sign depending on how the measurement is
gated, which makes it a property of the analysis rather than of the singer.

**Two things to expect.** The instrumental you lay the cover over is **not clean** — it
still contains the original singer, about 18 dB below the music and only 10 dB below it
in the band your own voice occupies. And the match is a *shaping*: on the song it was
built against it moved about ±1.2 dB across 500 Hz–4 kHz with +3.5 dB of air at 8 kHz. It
is a real, measured correction. It will not turn a poor take into a good one.

**Finally, place it.** Open the `— Stems` session the separation created, mute its
**Vocals** track, and drag your corrected take in as a new track.

## Tempo, remix, stems, transcription and the voice changer

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
octave-correction buttons on the TEMPO card — and in the Properties panel's
Tempo row, and in the Match Tempo, Align Vocal Timing and Auto-Remix dialogs —
are for: they re-track the beats at the corrected period rather than just
relabelling the number, so everything built on the grid moves with it. The
labels vary by surface: the **TEMPO card** and the **Align Vocal Timing** dialog
render them as **×2** and **÷2**; the **Match Tempo** and **Auto-Remix** dialogs
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

Dropping a clip on top of another clip on the same track keeps it exactly where
the magnet showed it — the overlap is deliberate, and the two clips' facing
fades are set to span it so it plays as a crossfade. Hold **Ctrl** at the drop
to push the clip forward clear of its neighbour instead (it then sits at the
neighbour's edge rather than on a beat).

### Matching one tempo to another

To make a 128 BPM loop sit in a 124 BPM track:

1. Select the region to retarget (or select nothing, to retarget the whole
   document).
2. **Effects → Match Tempo…**. The dialog prefills the source BPM from the
   detection; **Re-detect from selection** re-runs it against the region the
   ratio will be applied to. A selection of 30 seconds or less is analysed in
   full; a longer one is measured over a **centred 30-second excerpt** of it
   rather than end to end, because detection wants a representative stretch, not
   a complete one.
3. Enter the target BPM — or switch to a plain ratio. The dialog shows which
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

1. Detect the tempo first (**Effects → Detect Tempo**) — the alignment needs a
   beat grid and will never start an analysis on its own.
2. Drop a marker on each syllable you want moved (`M`). Or open the dialog and
   press **Suggest syllable markers**, which runs an onset detector and writes
   its proposals in as ordinary markers — then delete the wrong ones. On a real
   solo vocal roughly one proposal in eight is not a syllable (it is a breath, a
   note ending, or a slide), and about a third of the syllables are missed, so
   this step is a starting point, not an answer.
3. **Effects → Align Vocal Timing…**.
4. Check the grid. The dialog shows the BPM the tracked beats imply and the
   detector's confidence, with ×2 / ÷2 to re-track if the octave is wrong.
5. Choose the subdivision. Each option is labelled with the median move it would
   make — that number is the fastest way to tell which grid the performance is
   actually on. A median of 120 ms on **Beat** and 25 ms on **¼ beat** means the
   line is sitting on sixteenths, and snapping it to beats would wreck it.
6. Tick **Grid and subdivision are correct**. Apply stays disabled until you do.
7. Set **Strength**. It defaults to 25 %, and the dialog reports how much of the
   median move is left in place. Fully quantised vocals sound machine-made; the
   musical answer is usually partial.
8. **Apply**.

The region keeps its exact length — syllables move *within* it, so nothing after
it slides. Local stretch is clamped to 0.88–1.14× (the range where this stretch
is transparent); a move the clamp holds back lands short of the grid, and the
dialog says how many will before you apply rather than after. Pitch is preserved,
so the result can still go through Pitch Correct.

### Fixing one word without singing the whole take again

You know which word came out wrong — you can hear it. What you want is to sing
that one word again and drop it in, not to re-record the line. **Effects → Align
Lyrics…** is that.

It works from lyrics *you already have*. The model is never asked what was sung;
it is given the words and asked only where each one is.

1. **Effects → Align Lyrics…**. The first run downloads a 378 MB acoustic model
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

The dialog reports what it matched — the level correction in dB, the pitch shift
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
than no tool, so it was cut. Every word in the dialog looks identical until you
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

### Transcribing speech

To turn speech into timestamped text with a speaker label per segment:

1. Open the recording and run **Edit → Transcribe…**.
2. The first time only, the dialog offers the **one-time ~323 MB model
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

`Edit → Voice Changer…` makes a recording sound like a different speaker while
keeping the words and the delivery. Everything runs on your own CPU — no
account, no upload.

**Setting up a voice.** The dialog holds a list of **voice profiles**: saved
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
  suspend that — see **Snapping to the grid**). A clip dropped over a
  neighbour on the same track overlaps it deliberately and the overlap plays
  as a crossfade; hold `Ctrl` at the drop to nudge it forward clear of the
  neighbour instead (see **Clip fades and crossfades** below). Click a clip
  to select it — its facts (source document, start/offset/length, and an
  editable gain in dB) appear in the **Properties** tab, along with its
  fade lengths and curves.
- **Playback**: the multitrack view has its own transport, cursor, and
  playhead, driven by the same toolbar-pill transport buttons. There is no pause in
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
- **Sessions**: **File → Save Session…** / **Open Session…** persist the
  session (tracks, clips, their source document references, embedded audio,
  and markers) to a `.audm` file. Sessions are written in format v3, a binary
  layout (JSON header + raw audio payload, no base64) that removes the old
  v1/v2 format's silent failure on large embedded audio; Save Session now
  reports success or failure explicitly instead of failing quietly. Older
  `.audm` files (v1/v2) still open normally.

### Undo in the multitrack (session history)

Every session edit is undoable: clip moves, trims, deletes and gain changes,
fade and crossfade edits (arm/release included), automation-key adds, moves,
deletes and curve changes, track add/remove/rename, the fader and pan sliders,
the M/S/R toggles, spatial placements, recorded takes, and **New Session**
itself.

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
  only. **Open Session** and stem landing start a fresh history (undo does
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

The **Spatial** entry on the module strip opens a positioner that
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
