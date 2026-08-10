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
**Remix**, **Spatial** and **Transcript**; **History** is the default. When the active document has a
tempo analysis, a persistent **TEMPO** card (BPM readout, structure strip, and
×2 / ÷2 / Re-detect) appears above the panel card.

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

Effects live in the **Effects** panel (opened from the icon rail), grouped by category, and
mirrored in the **Effects** menu. Double-click an effect (with a document
open) to open its parameter dialog, adjust settings, and apply. Every effect
processes the current selection, or the whole document when there's no
selection.

- **Amplitude** — Amplify (gain in dB), Fade (in/out; Linear, Ducked, Cosine
  or Equal power curve; ramp length as a % of the selection — 100 % shapes the
  whole selection exactly as before), Normalize (peak or RMS target level)
- **EQ & Filters** — Parametric EQ, Graphic EQ
- **Dynamics** — Compressor, Limiter, Noise Gate
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
   detection; **Re-detect from selection** re-runs it against exactly the audio
   the ratio will be applied to.
3. Enter the target BPM — or switch to a plain ratio. The dialog shows which
   quality band the resulting stretch falls in (transparent / good / extreme).
4. Optionally tick the beat-marker grid, which lays down markers at the *new*
   tempo as a separate, separately-undoable step.
5. **Apply**.

Match Tempo runs through the same WSOLA **Time Stretch** effect and the same
single write path as everything else, so markers remap proportionally and undo
behaves normally — the History entry reads `Match Tempo`, with `Add Beat
Markers` as its own entry when you asked for the grid.

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
reference voices you can reuse. Add one with **From file…** (any audio file) or
**From selection** (whatever is selected in the open document, which is the
quickest way to try a voice you already have on the timeline). A reference of
roughly **6–15 seconds of clean speech** is what the model was measured on;
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

The **Spatial** entry on the right-edge icon rail opens a positioner that
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
