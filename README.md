# Auditorium

![Auditorium](docs/screenshot.png)

![Spectral view](docs/screenshot-spectral.png)

*Spectral frequency display (log scale)*

Auditorium is a free, Audition-class desktop audio editor for Windows, built on
Electron and React. It does destructive waveform editing and spectral-frequency
editing, ships 24 built-in effects, spectral noise reduction, microphone
recording, a multitrack editor with sessions, mixdown and volume/pan
automation envelopes, tempo detection, tempo matching and auto-remix, stem
separation that splits a track into drums/bass/vocals/other and a residual
which add back up to the original sample for sample, and speech transcription
with speaker labels that exports as SRT or WebVTT — all processing runs
locally, no cloud and no account.

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
- **Multitrack Editor** — a session timeline of tracks and clips with per-track volume/pan/mute/solo/arm, draggable, trimmable clips carrying non-destructive edge fades and crossfaded overlaps, per-track automation envelopes (volume, pan, and the three spatial parameters) edited on the lane itself, and full session undo/redo (one step per gesture).
- **Spatial Panel** — a playhead-following positioner (Spatial entry on the icon rail) that places a track's sound around the listener by azimuth, elevation and distance — a stereo projection (amplitude pan + distance level, not binaural) — writing automation keys on release.
- **Recorder** — a record dialog with input-device selection, channel/sample-rate choice, and a live input-level meter.
- **Effects Rack** — a categorized effects panel and menu; each effect opens a parameter dialog with a preview before applying.
- **Files Panel** — the list of open documents (name, dirty marker, duration, sample rate), opened from the right-edge icon rail.
- **History Panel** — the undo history of whatever is active (the session's in the multitrack view, the active document's elsewhere); click any entry to jump to that state.
- **Markers Panel** — the active document's marker list with jump-to, inline rename, and delete.
- **Properties Panel** — read-only facts about the active document or selected clip (path, rate, channels, bit depth, duration, selection, detected tempo).
- **Transport & Level Meters** — play/pause/stop, record, loop, the view toggle and a zoom cluster in the top toolbar pill; the time readout and output level meters in the floating bottom status pill.
- **Tempo Readout** — the status pill's `♩ BPM`, the TEMPO card above the panel cards, and the Properties panel's Tempo row, showing the detected tempo with its confidence, a staleness marker, and ×2 / ÷2 buttons that re-track the beat grid at the corrected period.
- **Match Tempo Dialog** — source BPM (prefilled from the detection, re-detectable from the selection), target BPM or ratio, the stretch-quality band, and an optional beat-marker grid at the new tempo.
- **Auto-Remix Dialog & Remix Panel** — the dialog analyses the track and takes tempo/time-signature confirmation, phrase length, target length, crossfade, strictness and repeat options; the Remix panel (the Remix entry on the icon rail) lists one row per splice with a cost-coloured quality dot, Go To, Reject, Pin, Nudge earlier/later, Re-roll and Revert to auto.
- **Separate into Stems Dialog** — the one-time 166 MB model download with byte progress, the five track names and both guarantees stated up front, per-segment separation progress with a time estimate, Cancel, and an honest post-run note when a source above full scale means the five tracks cannot add back to it exactly.
- **Transcribe Dialog** — the one-time ~323 MB model download with byte progress, the speaker count chosen up front (auto, or 1–6), the measured limits of speaker separation stated before you commit, phase-by-phase progress with a time estimate, and a Cancel that kills the inference process.
- **Transcript Panel** — the active document's transcript (the Transcript entry on the icon rail): one row per spoken segment with its time, speaker and text, a Go-to that moves the cursor, a speaker-count control that re-groups instantly without re-transcribing, a warning when the audio has changed under the transcript, and SRT / WebVTT export.

## Features

**Effects (24), grouped by category:**

- **Amplitude** — Amplify, Normalize, Fade.
- **EQ & Filters** — Parametric EQ, Graphic EQ.
- **Dynamics** — Compressor, Limiter, Noise Gate.
- **Delay & Reverb** — Echo, Reverb.
- **Modulation** — Chorus, Flanger.
- **Distortion** — Distortion.
- **Restoration** — Remove DC Offset, DeHum, Noise Reduction, Remove Silence.
- **Stereo** — Channel Mixer, Pan.
- **Time & Pitch** — Time Stretch, Pitch Shift, Pitch Correct.
- **Utility** — Invert, Reverse.

**Editing & workflow:**

- Cut, copy, paste, and delete on sample-accurate `[start, end)` selections.
- Per-document undo/redo history, up to 50 steps within an 800 MB per-document memory budget (oldest step evicted once either limit is hit), browsable in the History panel; marker add/rename/delete are undoable too (`Add Marker`/`Rename Marker`/`Delete Marker`).
- Session undo/redo for the multitrack: every clip, fade, automation and track edit is undoable, one step per gesture (a whole trim drag, a recorded take, an armed crossfade each revert with one `Ctrl+Z`); `Ctrl+Z` in the multitrack view addresses the session's own 50-step history, in the editor views the active document's — view changes, selection and scrolling are never undo steps.
- Selection by click-drag, double-click (select all), shift-click (extend), `Ctrl+A`, and `Escape` to clear.
- Zoom and scroll on both the waveform and spectral views (mouse wheel, plus the toolbar pill's − / % / + / Fit cluster), sharing one cursor/selection/playhead.
- Session markers: drop with `M`, rename inline, jump to next/previous, list in the Markers panel. Markers persist to disk in every supported container: `.wav` (cue/adtl chunks, Unicode names), `.mp3` (ID3v2.3 chapter frames), `.flac` (VORBIS_COMMENT chapter tags), `.ogg` (OpusTags chapter comments), and `.audm` sessions — sample-accurate on reopen. Destructive edits (delete, paste, trim, replace, sample-rate conversion, length-changing effects) remap or drop marker positions along with the audio, clamped to the document length.
- **Convert Sample Rate / Convert Channels**: `Edit → Convert Sample Rate…` resamples the whole document to a chosen rate (22050/44100/48000/96000 Hz), rescaling markers in lockstep; `Edit → Convert Channels…` converts Mono ↔ Stereo, and for a surround document offers the downmix law below. Both are undoable.
- **Surround WAV import & selectable downmix**: spec-conforming multichannel WAVs (`WAVE_FORMAT_EXTENSIBLE` 5.1/7.1, PCM or float) open with all channels and their speaker layout (`dwChannelMask`); Convert Channels then downmixes to stereo with either the default −3 dB fold (unchanged from earlier releases) or, opt-in when the layout is known, the ITU-R BS.775 matrix (centre and surrounds at −3 dB, LFE discarded per the Recommendation).
- Loop-playback toggle in the toolbar pill (`transport.toggleLoop`).
- **Noise-print workflow**: capture a noise print from a selection, then Noise Reduction subtracts it from the target region.
- Recording device selection, channel count, and sample rate in the record dialog.
- **Export**: WAV at 16-bit, 24-bit, or 32-bit float; FLAC (16-bit, lossless); MP3 at 128/192/256/320 kbps (CBR); OGG (Opus) at 96/128/192 kbps.
- **Format-faithful Save**: Save re-encodes in place into the source container — WAV (32-bit float; the document's bit-depth metadata is retagged to 32-bit float afterward so Properties reports the truth about the file on disk), MP3 (192 kbps), FLAC (16-bit or 24-bit, rounded up from the source depth — a 20-bit source saves as 24-bit, never truncated), or OGG (Opus-in-Ogg, 128 kbps). The Properties panel reports the source file's bit depth ("16-bit source → 32-bit float"). If WebCodecs is unavailable, an in-place OGG Save falls back to Save As WAV. Save As always writes WAV and replaces the source extension in the suggested name (`song.mp3` → `song.wav`).
- **Atomic in-place saves**: every in-place Save writes to a sibling temp file and only replaces the original once the write completes, so an interrupted or failed save can't corrupt or truncate the file on disk.
- **OGG (Opus) export and save**: a pure-TypeScript, RFC 3533/7845-conformant Ogg muxer pairs with the host's WebCodecs `AudioEncoder` — legacy Ogg Vorbis sources re-encode as Opus (not round-tripped as Vorbis).
- **Native-rate import across container variants**: container-header sniffing covers WAV, FLAC, MP3 (including free-format streams), Ogg first packets (Vorbis, Opus, FLAC, Speex), MP4/M4A (64-bit largesize boxes and non-faststart layouts), WebM/Matroska (EBML, any file size — a v1.14 fix; before it, every finalized WebM/Matroska file over 512 KB silently decoded at 48000 Hz), and raw ADTS/AAC, so files keep their native sample rate on open; only genuinely unrecognized layouts fall back to 48000 Hz.
- **Marker persistence in every format**: WAV cue/adtl (UTF-8 label fallback for non-Latin names), MP3 ID3v2.3 CTOC/CHAP chapters, FLAC and OGG vorbis-comment `CHAPTERxxx` tags (readable by chapter-aware players; support varies by player and container) — each alongside a sample-accurate private tag so markers reopen exactly where they were dropped.
- **Spectral log/linear toggle**: the Spectral Frequency Display's frequency axis switches between logarithmic (default) and linear scaling.
- **Multitrack punch-in recording**: arm one or more tracks with their **R** toggle, position the multitrack cursor, then press **Record** — the take lands as a clip on every track that was armed when it started.
- **Sessions**: save/open multitrack sessions as `.audm` (format v3 — a binary layout with no size-limited base64 encoding, so Save Session no longer fails silently on large embedded audio; older v1/v2 session files still open), and mix down a whole session to a new stereo document.
- **Clip fades**: every multitrack clip carries non-destructive fade-in/fade-out — corner handles on the selected clip, exact length fields and a curve picker (Equal power / Equal gain / Smooth / Ducked) in the Properties panel — applied identically in live playback and Mix Down, saved in the `.audm`, and re-editable at any time.
- **Crossfades**: dragging a clip into a same-track neighbour commits the overlap verbatim and arms a real crossfade (both facing fades span the overlap; the pair is rendered with the same correlation-compensated, level-preserving gain law Auto-Remix uses); moves and trims re-arm at the new width, Arm/Release manage it from the Properties panel, and holding Ctrl at the drop restores the old push-clear nudge. A fade-carrying session still opens in v1.8.0, minus the fades.
- **Track automation**: per-track volume and pan envelopes — keys on the multitrack timeline with per-segment curves, edited directly on the lane (click to add, drag to move with snapping, right-click to delete, double-click to change the curve); an active envelope overrides its fader, plays and mixes down with bit-identical gains, and saves in the `.audm` (a lane-free session stays byte-identical on disk, and an automation session opens in v1.9.2 and round-trips through it with the lanes preserved — v1.9.2 just cannot edit or play them).
- **Spatial placement**: drag a track's sound around the listener in the Spatial panel — azimuth, elevation and distance automate on the timeline like any other lane, render as a stereo projection (amplitude panning plus inverse-distance level; honestly named — not binaural, no HRTF), supersede the pan control while active, interpolate azimuth the short way around the ±180° circle (add an intermediate key for a deliberate long sweep), play and mix down bit-identically, and save in the `.audm` at the same format version.
- **Pitch Correct**: scale-snapped pitch correction — a YIN pitch detector tracks the sung/played line, snaps each voiced frame to the chosen key and scale (chromatic, major, or natural minor) with adjustable Strength and Retune Speed, and resynthesises through a time-varying stretch+resample pair that preserves the input length exactly.
- **Remove Silence**: detects pauses under a threshold and either shortens each to a target length or removes it (keeping padding), splicing every cut with a click-free crossfade and remapping markers by the exact material removed before them — a marker inside a removed pause snaps to the splice point instead of being lost.
- **Fade effect curves**: the destructive Fade effect gains the Equal power curve and a ramp-length control (% of the selection); its "Exponential" option is now labelled **Ducked** — the shape is quadratic, and the new name describes what it sounds like.
- **Tempo detection**: `Effects → Detect Tempo` runs a shared off-thread beat-tracking pass (log-band spectral-flux onsets → harmonic-comb tempo estimate → Ellis dynamic-programming beat tracking → sample-accurate refinement) and reports the BPM plus a confidence score in the status pill and the Properties panel. The beats are tracked, not extrapolated, so the grid follows a drifting take; ×2 / ÷2 buttons re-track at the corrected period when the octave is wrong. Whole-document analysis is capped at 10 minutes and flags the result as truncated past that.
- **Beat grid**: once a tempo has been detected, the tracked beats are drawn as tics along the bottom of the waveform and spectral editors and on every multitrack clip (mapped through the clip's own offset, trim and sample rate), so you can see where the beat actually falls rather than inferring it from a BPM number; a stale or low-confidence grid is drawn dimmed and dashed rather than as fact, bar lines appear only when an Auto-Remix analysis genuinely measured a metre, stems inherit their source's grid instead of being re-analysed, and `View → Toggle Beat Grid` switches it off.
- **Snapping ("the magnet")**: the cursor, the moving edge of a selection, and multitrack clip drags and trims quantise onto the nearest beat or marker within 8 screen pixels — hold **Alt** to suspend it for a precise off-grid edit, or switch it off entirely with the toolbar magnet button or `View → Toggle Snap to Grid`.
- **Match Tempo**: `Effects → Match Tempo…` retargets a selection (or the whole document) from a source BPM to a target BPM or a plain ratio through the WSOLA time stretch, showing whether the resulting stretch is transparent, good, or extreme, and optionally laying down a beat-marker grid at the new tempo as its own undo step.
- **Auto-Remix**: `Edit → Auto-Remix…` re-arranges a track's own bars to reach a requested length and writes the result to a new `Remix N` document, leaving the source untouched. Bar boundaries come from the tracked beats; each boundary is described by timbre, chroma, loudness and local rhythm and clustered into sections, and a 2-D lattice dynamic program picks the cheapest phrase-congruent arrangement (Φ = 8 bars by default) reaching the target. Joins are micro-aligned by ±10 ms cross-correlation and crossfaded with a power-preserving, length-neutral gain law. The Remix panel then lets you reject, pin, or nudge any individual splice, re-roll the whole arrangement, or revert to the automatic one — every adjustment undoable from the History panel.
- **Stem separation**: `Edit → Separate into Stems…` splits the active document into **Drums, Bass, Vocals, Other** and a **Residual**, creating five documents and a five-track multitrack session. The five tracks add back up to the original **sample for sample** — the model's estimates are only used to build ratio masks over the original document's own spectrum, and the Residual is the time-domain complement `mix − Σ stems`, so mixing the untouched session down reproduces the source exactly (measured: worst error 0, 100 % of samples bit-identical, mono and stereo, 44.1 and 48 kHz). How cleanly the instruments are told apart is bounded by the model, and the UI says so rather than promising otherwise. The 166 MB model is downloaded on first use (sha256-pinned, re-verified before every load), inference runs on the CPU in an isolated process with per-segment progress and a Cancel that kills it outright, and separation is capped at 15 minutes of audio.
- **Transcription with speaker separation**: `Edit → Transcribe…` turns speech into timestamped text with a speaker label per segment, using Whisper (base) and a CAM++ speaker-embedding model running locally on the CPU — no cloud, no account, nothing leaves the machine. The transcript appears in the Transcript panel and as coloured regions on the editor's timeline; clicking either moves the cursor there. Timestamps are kept in document samples, so they line up with the waveform at any sample rate, and export as SRT or WebVTT with the speaker labels. **What the speaker separation is worth, measured:** on clean recordings with one voice at a time it told two speakers apart with 100 % of segments correct and recognised a single speaker as one person every time, but it placed only 45 % of segments correctly with three speakers — 73 % even when told there were three. Overlapping speech is not detected at all: a segment with two voices in it gets one label. The speaker count is therefore a control, not just a readout — set it yourself in the Transcript panel and the grouping is recomputed instantly, with no second transcription run. The ~323 MB model set is downloaded on first use (sha256-pinned, re-verified before every load), inference runs in an isolated process with progress and a Cancel that kills it outright, and a job is capped at 2 hours of audio.
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

**Stem separation and transcription** are the exceptions to the
pure-TypeScript rule, and they are contained the same way: neural inference
runs on `onnxruntime-node` (CPU execution provider) inside an Electron
`utilityProcess` — one per feature, never shared — so the renderer never loads
it and the working set can be killed instantly on Cancel. Everything built on
top of the models is ordinary TypeScript: the mask/complement DSP that turns
stem estimates into an exact partition, and the Ward-linkage speaker
clustering that turns voice embeddings into speaker labels. There is no GPU
path: on an RTX 3080 Laptop the DirectML provider never finished a single
7.8 s stem segment before exhausting 15.7 of 16 GB of VRAM, while the CPU
provider runs stem separation at ~1.5x realtime and transcription at ~9x.

## Credits

- **Stem separation model** — **HT-Demucs** (Hybrid Transformer Demucs) by
  **Meta AI**, MIT licensed, used through the **StemSplitio** ONNX export
  ([`StemSplitio/htdemucs-onnx`](https://huggingface.co/StemSplitio/htdemucs-onnx),
  `htdemucs_fp16weights.onnx`, MIT). The model is downloaded from that
  repository on first use and is not bundled with Auditorium.
- **Speech recognition model** — **Whisper (base)** by **OpenAI**, Apache-2.0,
  used through the ONNX export at
  [`onnx-community/whisper-base`](https://huggingface.co/onnx-community/whisper-base).
- **Speaker-embedding model** — **CAM++** trained on VoxCeleb by the
  **WeSpeaker** project, Apache-2.0, taken from the
  [sherpa-onnx speaker-recognition model release](https://github.com/k2-fsa/sherpa-onnx/releases/tag/speaker-recongition-models)
  (`wespeaker_en_voxceleb_CAM++.onnx`). Both are downloaded on first use and
  are not bundled with Auditorium.

## License

[MIT](LICENSE) © 2026 Auditorium contributors.
