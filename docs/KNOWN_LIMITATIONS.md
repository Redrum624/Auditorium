# Known Limitations

Tracked deviations from full Adobe Audition parity. Each entry names the area,
the current v1 behavior, and the intended future behavior.

## Unsniffable containers fall back to 48000 Hz; >2-channel downmix law

**Area:** File > Open (`src/audio/decodeAudio.ts` `decodeArrayBuffer`,
`src/audio/sniffSampleRate.ts`)

**v1.2 behavior:** Non-WAV imports now arrive at their **native sample rate**.
Before decoding, `sniffSampleRate` parses the container header (MP3 frame sync,
FLAC STREAMINFO, OGG Vorbis/Opus identification, MP4/M4A `mdhd` timescale, a
defensive WAV `fmt` reader, a bounded WebM/Matroska EBML walk down to
`Segment→Tracks→TrackEntry→Audio→SamplingFrequency` — with Opus tracks fixed at
48000 Hz regardless of the stored value — and an ADTS/AAC frame-header
`sampling_frequency_index` scan requiring two consecutive valid frames before
trusting the sync) and the `OfflineAudioContext` is built at that rate, so
Chromium's `decodeAudioData` no longer resamples the output. As of v1.3 the
MP4 walk also handles 64-bit (largesize) boxes and version-1 `mdhd` headers.
Only genuinely unrecognized/exotic container layouts still fall back to
**48000 Hz**. Audio with more than two channels is down-mixed to stereo —
the extra channels (index ≥ 2) are folded into both L and R at −3 dB rather
than dropped: `mix = 0.7071·mean(ch2…chN-1)`, `L' = clamp(ch0 + mix, ±1)`,
`R' = clamp(ch1 + mix, ±1)`.

**Intended behavior:** For unsniffable formats, add per-container parsers as
needed; the current fallback is a bounded, safe default. The downmix is a fixed
−3 dB fold; a user-selectable surround downmix matrix could follow.

## Ogg sources re-encode in place as Opus-in-Ogg (resolved)

**Area:** File > Save / Save As / Export (`src/services/fileService.ts`,
`src/audio/oggOpusEncoder.ts`, `src/audio/oggPage.ts`)

**v1.2 behavior:** Save is now **format-faithful for `.ogg` too**. A document
opened from `.ogg` keeps its `filePath`, and Save re-encodes it **in place as
Opus-in-Ogg**: the audio is resampled to Opus's canonical 48 kHz (via the
existing windowed-sinc `resampleChannel`), encoded to Opus packets by the host's
WebCodecs `AudioEncoder`, and wrapped by a pure-TypeScript Ogg page muxer
(`oggPage.ts` — RFC 3533 framing with the non-reflected CRC-32 poly 0x04C11DB7,
RFC 7845 OpusHead/OpusTags headers, byte-exact lacing, and cross-page packet
spanning with the continued flag). Legacy Ogg **Vorbis** sources are therefore
re-encoded as **Opus** in the same Ogg container — a modern, universally
decodable codec — rather than round-tripping Vorbis. File > Export also offers
**OGG (Opus)** at 96/128/192 kbps; in-place Save uses 128 kbps. As with MP3
in-place Save, each Save is a **lossy → lossy** re-encode, so repeated saves
accumulate generation loss (the same caveat noted for MP3). Only genuinely
exotic sources (m4a, aac, webm, unrecognized) are still opened with
`filePath = null` and fall back to save-as WAV on first Save.

If WebCodecs is unavailable in the host (no Opus encoder), an in-place `.ogg`
Save falls back to the save-as WAV dialog — the lossless default — and Export
surfaces an error rather than writing a broken file. As of v1.3, markers ARE
written to `.ogg`: the OpusTags header carries de-facto-standard
`CHAPTERxxx`/`CHAPTERxxxNAME` vorbis comments (at the file's 48 kHz clock)
plus a sample-accurate private `AUDITORIUM_MARKERS` tag, and reopening the
file restores them exactly.

**Intended behavior:** No further work planned — Opus-in-Ogg is the correct
modern default. A native Vorbis encoder (to keep Vorbis sources as Vorbis) is a
possible future refinement but not needed for round-tripping.

## Markers persist in every container, remap under edits, and are undoable (resolved)

**Area:** Markers (`src/stores/appStore.ts` `markers`, `src/services/editOps.ts`,
`src/services/undoHistory.ts`, `src/audio/wavCodec.ts`, `src/audio/id3Chapters.ts`,
`src/audio/chapterTags.ts`/`flacMeta.ts`, `src/audio/oggPage.ts`,
`src/multitrack/sessionFile.ts`)

**v1.3/v1.4 behavior:** Markers round-trip through **all four supported
containers** plus sessions, sample-accurately:

- **WAV** — standard `cue `/`LIST`-`adtl` chunk pair (Audacity/Audition-
  compatible). Since v1.3, `labl` names are no longer limited to Latin-1: if
  any marker name needs it, all labels in the file are written as UTF-8
  (Audacity-style), and reading tries strict UTF-8 first with a Latin-1
  fallback for legacy files — CJK and emoji names round-trip intact.
- **MP3** — an ID3v2.3 tag with standard chapter frames (`CTOC` + one `CHAP`
  per marker with an embedded UTF-16 `TIT2` title, podcast-chapter style) plus
  a `TXXX AUDITORIUM_MARKERS` frame carrying exact sample offsets. As of v1.4
  the `CTOC`/`CHAP` interop frames cap at the first 255 markers by position
  (the `CTOC` child count always matches); the private `TXXX` tag still
  carries the full list regardless of count, so Auditorium itself never loses
  a marker — only third-party chapter readers see the 255 cap.
- **FLAC** — a `VORBIS_COMMENT` metadata block with de-facto-standard
  `CHAPTERxxx`/`CHAPTERxxxNAME` tags plus the same sample-accurate private tag.
- **OGG (Opus)** — the same chapter comments in the OpusTags header (at the
  file's 48 kHz clock).
- **`.audm` sessions** (v3, still reads v1/v2) — a `markers` map per
  referenced document; v1 session files still load with zero markers.

Opening any of these seeds the store with fresh marker ids; in-place Save,
Save As, and Export all write markers back. Files saved with **no** markers are
byte-identical to pre-v1.3 output for every format.

**v1.4 additions:** adding, renaming, or deleting a marker now dirties the
owning document (Files-panel `*`, close/quit prompts, the async-save
staleness check) and is undoable from the History panel (`Add Marker` /
`Rename Marker` / `Delete Marker`). Destructive edits that change the
timeline — delete, insert/paste, trim, replace, sample-rate conversion, and
length-changing effects (Time Stretch, Pitch Shift) — remap or drop marker
positions atomically with the audio, in the same undo step; interior markers
under a length-changing effect map proportionally rather than being dropped.
Positions are always clamped to `[0, document length]`, so a marker can never
be written to disk past the end of the file.

**v1.10 refinement (F2):** the proportional rule above is right for effects
that TRANSFORM the whole region but wrong for Remove Silence, which deletes
discontiguous interior spans — a marker on speech after a removed gap must
shift by exactly the removal before it, not by the region's average shrink
ratio. Span-deleting effects therefore report their removed spans and markers
get an exact piecewise remap; a marker INSIDE a removed span (a cue placed in
the pause — podcast chapters live there) snaps to the splice point instead of
dropping, unlike an explicit user delete.

**Remaining notes (interop granularity, not persistence gaps):** third-party
tools read the standard chapter fields at millisecond granularity (that is all
ID3 `CHAP`/vorbis `CHAPTER` timestamps can express); Auditorium itself reopens
markers sample-exactly via its private tag. Chapter-aware players are expected
to see the vorbis-comment chapters (not independently verified against a
specific player); MP3 chapter support varies by player. Adobe
Audition does not read or write MP3/FLAC/OGG markers at all — Auditorium
exceeds parity here.

**Intended behavior:** No further work planned — this is complete.

## In-place saves are atomic (resolved)

**Area:** File writes (`electron/ipc.cjs`, `electron/atomicWrite.cjs`)

**v1.4 behavior:** Every `file:write` (in-place Save, format-faithful
re-encode, Save Session) writes to a sibling temp file (`<target>.<pid>.<seq>.tmp`,
same directory as the target — so the follow-up rename stays on one volume),
fsyncs it, closes it, then renames it over the target. A failure at any step
(encode error, disk full, permission denied) unlinks the temp file and leaves
the original untouched — an interrupted or failed save can no longer destroy
or truncate the file that was already on disk.

**Intended behavior:** No further work planned — this is complete.

## Undo history is bounded by bytes as well as by step count

**Area:** Undo/redo (`src/services/undoHistory.ts`)

**v1.4 behavior:** Undo keeps up to 50 steps per document, but also enforces
an 800 MB per-document memory budget (`MAX_UNDO_BYTES`) computed from the
captured channel data of each entry; whichever limit is hit first evicts the
oldest step (at least one entry is always kept, even if it alone exceeds the
budget). In practice the byte budget binds well before the 50-step count on
large documents — a 10-minute stereo 44.1 kHz document's whole-document
snapshots run roughly 200 MB each, so its effective undo depth is around 3-4
steps, not 50; a very large document (e.g. long high-res multitrack sources)
can be down to a single step.

**Intended behavior:** No further work planned — this is the intended
memory/depth trade-off for a browser-engine-hosted editor with no swap to
disk.

## Session files are format v3 (binary); very large legacy sessions may not load

**Area:** Multitrack sessions (`src/multitrack/sessionFile.ts`)

**v1.4 behavior:** `.audm` sessions are now written in **format v3**: an
`AUDM3\n` magic, a JSON header, and the embedded audio as raw Float32 bytes
assembled into one buffer — no monolithic JSON string and no base64 payload
are ever built. This removes the v1/v2 format's silent failure once embedded
audio's base64 encoding pushed the session's JSON past the JS engine's string
length cap (roughly 17 minutes of embedded audio in the old format); Save
Session now surfaces both success and failure explicitly instead of failing
quietly. v3 sessions load exactly like v1/v2 wrote them; v1/v2 files still
open normally.

**Remaining limitation:** a **legacy v1/v2** session file whose JSON already
exceeds the JS string cap (built by a pre-v1.4 Auditorium, or by another tool)
still cannot be loaded — Open Session now reports a clear error instead of
crashing, but the file itself is unreadable either way. Resaving as v3 (once
it can be opened at all) avoids the ceiling entirely, since v3 never builds
that string. There is no migration path for a legacy session that is already
too large to open.

**Intended behavior:** No further work planned for v3 itself; a v1/v2-specific
recovery tool (partial-parse salvage) is not planned.

## Closing while busy asks instead of force-quitting

**Area:** Window close guard (`electron/closeGuard.cjs`)

**v1.4 behavior:** The native close handler waits up to 2 seconds for the
renderer to report its dirty-document count. Previously, a renderer that
was merely busy (not crashed) but slow to reply within that window was
force-destroyed. Now the guard fails closed: it only force-destroys when the
`webContents` is actually crashed or already destroyed; otherwise it shows a
native confirm — "The editor is busy (a save or export may be running). Quit
anyway?" — since a busy renderer's true dirty count, and whether a save is
mid-flight, are both unknown at that point.

**Intended behavior:** No further work planned — this is complete.

## UNC network-share saves are allowed; local-alias and admin shares are refused

**Area:** Write-path policy (`electron/writePathPolicy.cjs`)

**v1.4 behavior:** A well-formed UNC path (`\\server\share\...`, at least a
server and a share component) is now an allowed save target — users can open
a file from a NAS/network share and save back to it — subject to the same
forbidden-directory containment and symlink/TOCTOU checks as any other write.
Rejected by design, regardless of well-formedness:

- Windows extended-length (`\\?\...`) and device (`\\.\...`) path prefixes,
  including when spelled with mixed/forward slashes that `path.resolve`
  would otherwise normalize back into one of those forms.
- UNC paths that loop back to this machine under a local alias — `localhost`,
  `127.0.0.0/8` literals, `::1`/`[::1]`, `<hostname>.ipv6-literal.net`
  encodings, or this machine's own hostname.
- Any `$`-suffixed share (`C$`, `ADMIN$`, `IPC$`, or a custom hidden share),
  on any host — these reach a local drive root directly and match none of the
  drive-letter-rooted forbidden-directory prefixes otherwise.

Both loopback-alias and `$`-share forms resolve to the same filesystem the
drive-letter checks already protect, so they're rejected outright rather than
mapped back to a drive letter for containment.

**Intended behavior:** No further work planned — this is complete.

## A remix adjustment retains its own pre-edit snapshot; ~8 of them evict the oldest

**Area:** Auto-Remix session (`src/services/remixService.ts`), undo history
(`src/services/undoHistory.ts`)

**v1.5 behavior:** Every remix adjustment (reject / nudge / re-roll / reset /
target or crossfade change) rewrites the remix document through the single
`applyEdit` write path, so each one pushes a `'Remix'` undo entry that retains
that document's PRE-edit channel snapshot — about 105 MB for a 5-minute stereo
remix. `MAX_UNDO_BYTES` is 800 MB per document, so roughly eight adjustments
reach the budget and the oldest entries are evicted, always keeping at least
one. Undo still works; it simply cannot reach arbitrarily far back on a long
remix.

This is intended, not a leak. The alternative — remixing the SOURCE document
in place — is worse in exactly the same currency: `applyEdit` would then
charge the whole SOURCE per entry, the A/B reference the user needs would be
destroyed, and the eviction pressure would land on the file they actually care
about. Producing a new document per remix (as Mix Down does, and as Audition's
own Remix does) confines the cost to the derived artefact.

**Intended behavior:** No further work planned — this is complete.

## A remix adjustment costs TWO undo presses (sometimes one)

**Area:** Auto-Remix session (`src/services/remixService.ts`)

**v1.5 behavior:** An adjustment normally pushes two entries — `'Remix'` (the
new arrangement) then `'Remix Markers'` (the fresh edit-point markers) — so
stepping back one arrangement takes two Ctrl+Z presses. `applyEdit`'s marker
remap can only DROP or SHIFT markers that already exist, never invent one, and
every old join marker describes a splice the new arrangement no longer has;
seeding the new ones therefore cannot ride inside the arrangement's own entry.
Widening `applyEdit` to carry an explicit marker list was considered and
rejected as an unjustified change to the app's single write path.

The count is conditional, not fixed: an arrangement with no joins, or the
"Mark edit points" option turned off, produces exactly ONE entry. Anything
reading the history must read its actual length rather than assume two.

**Intended behavior:** No further work planned — this is complete.

## Remix planning is off-thread only above `MAX_DP_CELLS`

**Area:** Auto-Remix planner routing (`src/services/remixService.ts`,
`src/workers/remixPlan.worker.ts`)

**v1.5 behavior:** The remix DP is ~O(bars²). Below `MAX_DP_CELLS` (250 000
lattice cells) it runs on the main thread; above it, each session spawns its
own plan worker and the analysis is posted once and kept resident there, so
adjustments stay responsive on long material.

Measured main-thread cost at 120 BPM 4/4, so the threshold's meaning is
concrete: **~20 ms for a 4-minute song** (120 bars, 0.17× the cell limit) and
**~120 ms for a 10-minute set** (300 bars) — which is already 1.08× the limit,
so a set that long routes to the worker rather than running here at all. At
the 600-second analysis cap (200 BPM, 499 bars — 3.0× the limit) a single plan
is ~300 ms and a third Re-roll press ~1 s, which is why anything past the
limit is routed off-thread rather than left to freeze the window. (An earlier
draft of this entry said "~1 ms for a typical song"; that was the 64-second
test fixture, not a song, and understated a real song by ~20×.)

Each session's worker keeps its OWN resident copy of the analysis (~1.7 MB of
typed arrays). Two remixes made from the same source therefore hold two
copies, plus the renderer's own cached one. Both are released when the remix
or its source is closed.

Two residual costs are accepted rather than engineered around. Each Re-roll
press is dearer than the last, because `planRemix` re-derives every previous
roll to stay deterministic and stateless; a per-session memo removes the
REPEATED work across presses but not the cost of one cold roll. And a pinned
("locked") join is a **strong preference, not a guarantee**: the planner has
no "required joins" constraint, so a pin is honoured by exempting that join
from the re-roll and over-repetition penalties and giving it one join-toll of
cost advantage. It can still lose to a genuinely cheaper arrangement, and it
cannot survive being rejected — a rejection is a hard constraint and wins.
Measured over 156 pin/press cases across three scales (32, 128 and 496 bars,
both the Re-roll and Reject paths): **preserved 156/156**, against **38/156
before this mechanism existed** (and 0/106 on the Re-roll path specifically,
where the re-roll penalty used to push a join out precisely because it was in
the plan being re-rolled). When a pin is dropped the session reports it
(`lockedJoinsDropped`) instead of leaving a pin badge on a join that no longer
exists.

**Intended behavior:** No further work planned — this is complete.

## A computed document prompts before closing, and undo cannot silence it (resolved)

**Area:** Document model (`src/audio/AudioDocument.ts`), close path
(`src/services/fileService.ts` `closeDocumentFlow`), quit guard (`src/App.tsx`
→ `electron/closeGuard.cjs`); the documents themselves come from Auto-Remix
(`src/services/remixService.ts`), Mix Down (`src/services/menuActions.ts`),
recording, File > New and stem separation.

**v1.5 behavior (the defect):** `Remix N` was created the way Mix Down creates
its output — `createDocument` + `addDocument`, no undo entry — so it inherited
`dirty: false` and closed silently. A user who rejected three joins, nudged a
fourth, and then closed the document lost that arrangement with no prompt, even
though the audio had never been on disk. Quitting the app discarded it just as
quietly: the close guard counted only dirty documents.

**Why `dirty: true` at creation was the wrong fix.** `undoHistory` re-derives
`dirty` from the undo position relative to the save point rather than restoring
a snapshotted value (the v1.4 fix for "undo after Save reported the document as
clean"), so a `dirty` stamped at creation survives exactly until the first
Ctrl+Z and then silently clears itself — a gap that looks fixed and is not.

**v1.7 behavior:** documents carry a second, independent flag —
**`neverSaved`** — that records PROVENANCE rather than edit state.

- **Set at creation** for audio the app computed: Mix Down output, `Remix N`,
  microphone and track recordings, File > New, and separated stems. The default
  in `createDocument` is "true when there is no `filePath`", so a new creation
  site is protected by default; opened files pass `neverSaved: false`
  explicitly — including exotic containers (m4a/aac/webm), which keep no
  `filePath` because they cannot be saved back in place but whose audio is
  nonetheless sitting on disk. Documents recreated from a `.audm` session are
  `false` for the same reason: their bytes live inside the session file.
- **Cleared only by a successful save** — Save As, or an in-place Save — on the
  same branch that clears `dirty` and marks the undo save point. A cancelled
  dialog, a failed write, and a save whose staleness check rejects (an edit
  landed mid-encode/write) all leave it set.
- **Never touched by undo or redo.** `applyDerivedDirty` rewrites `dirty` and
  nothing else, so undoing past the creation point cannot silence the prompt —
  the failure mode a stamped `dirty` would have had.
- **Consulted alongside `dirty`** by `closeDocumentFlow`, which asks
  "*<name>* has never been saved to a file. Save it before closing?" (Save /
  Don't Save / Cancel) rather than the "Unsaved changes" wording, which would
  imply a file exists to save changes back into; and by the renderer's reply to
  the native close guard, so quitting with an unsaved Remix open shows the
  Quit/Cancel box instead of discarding it. Choosing Save and then cancelling
  the save-as dialog aborts the close, exactly as it does for a dirty document.
- **A session save does NOT clear it.** `.audm` embeds only CLIP-REFERENCED
  documents, as a point-in-time copy under a foreign id that reopening restores
  as a NEW document; the document itself still has no path of its own and File
  > Save still prompts a save-as. Clearing the flag on a session save would
  silently un-guard every open document the session never contained. Likewise
  **Export does not clear it** — an export writes somewhere else and leaves
  `filePath`/`dirty` alone, and the flag follows the same rule.

The cost is one extra prompt: a computed document you genuinely don't want
always takes a "Don't Save" click. That is the deliberate direction to err in —
the alternative lost the work with no click at all.

Related, and by design rather than by omission: when a remix's SOURCE document
is edited or closed, the session goes **stale and read-only** — the panel shows
a banner, every adjustment control is disabled, and only **Go To** stays live.
The rendered audio is untouched and remains fully editable as an ordinary
document; what is unavailable is re-planning it against a grid that no longer
describes the source.

**Intended behavior:** No further work planned — this is complete.

## Tempo detection makes octave errors; both tempo features assume a steady tempo

**Area:** Tempo analysis (`src/dsp/tempoCore.ts`, `src/services/tempoAnalysis.ts`),
Match Tempo (`src/services/tempoService.ts`), Auto-Remix (`src/dsp/remixPlan.ts`)

**v1.5 behavior:** Three limits, all inherent to the approach rather than
defects to be tuned out.

**1. Octave errors are mitigated, not eliminated.** Measured over 91 synthetic
fixtures spanning 60–200 BPM: **63 exact, 27 octave errors (half/double/⅔), 1
non-octave miss.** The harmonic comb, log-Gaussian prior and beat-salience vote
resolve most half/double ambiguity, but half-time feels, drum & bass, shuffles
and drum-less intros still defeat it, and the disambiguator only chooses among
{⅓, ½, ⅔, 1, 3/2, 2, 3}× the comb winner — a first-stage miss outside that
family is unrecoverable. The confidence score **cannot** catch this: periodicity
is invariant under octave choice (the structure really is there at 2×), and a
60 BPM loop misread as 120 scored the highest confidence in the whole bank. The
165–200 BPM band on uniform content is additionally phase-unstable by design.
The remedy is therefore the **×2 / ÷2 control**, which re-tracks the grid at the
corrected period rather than relabelling the displayed number, plus the manual
BPM field and the Auto-Remix dialog's explicit tempo confirmation. No feature
presents a detected BPM as authoritative.

**2. Downbeat phase can be wrong** independently of the tempo. The detector
assumes the low-frequency accent falls on beat 1; reggae, heavily syncopated
pop and anacrusic intros land 1–3 beats off, which puts every splice off the
bar line even at a correct tempo. `downbeatConfidence` is reported as a soft
hint and is explicitly **not** a gate — its log compression flattens a genuine
2× accent, so any threshold would reject correct detections on most real music.
The Auto-Remix dialog's structure strip is where a wrong grid becomes visible
before anything is committed, and the ◂ ▸ shift is the correction.

**3. Match Tempo assumes a FIXED source tempo; the remix assumes a CONSTANT
one.** Match Tempo applies a single ratio across the whole region, so material
that speeds up or slows down inside the selection is corrected only on average.
The remix's bar boundaries come from real tracked beats (so late splices still
land on the beat on a drifting take — a genuine improvement over a rigid grid),
but the phrase arithmetic (`a ≡ b mod Φ`) and the duration model still assume a
stable meter: heavy rubato or a mid-song tempo change produces phrase-congruent
joins that are musically wrong. `ibiCv` in the analysis carries real information
about drift and is the only signal the user gets. Related: the achieved length
is **bar-quantised** — a target is met to within one bar, measured at **+7.2 %**
on accelerating material — and the cost function models nothing about lyrics, so
a join can score 0.05 and still cut a vocal mid-syllable. Chroma is also
key-blind but not transposition-aware, so a final-chorus key change reads as
harmonically distant and the planner avoids precisely the join a producer would
make.

**4. In strict phrase mode the set of reachable lengths is COARSE.** Every run
must be at least Φ = 8 bars long and every join must be phrase-congruent, so a
source of `M` bars can only reach a sparse ladder of lengths — on a 31-bar
source at 120 BPM 4/4 the shortest arrangement carrying a join renders at 24
bars (48 s), and anything shorter is refused as `too-short` rather than
approximated. This is why the Auto-Remix dialog clamps its length control to
the planner's reported `[minOutputSample, maxOutputSample]` window instead of
letting a request fail: an unreachable target is reported with the reachable
minimum, never silently mis-served. Loose phrase mode (`minRunBars = 4`,
congruence demoted to a soft penalty) reaches a much denser set of lengths at
the cost of cutting mid-phrase more often.

Whole-document analysis is additionally capped at `MAX_ANALYSIS_SECONDS = 600`;
past that the result is flagged `truncated` and surfaced as "first 10 min"
rather than silently describing a prefix.

**Intended behavior:** The corrections (×2 / ÷2, manual BPM, downbeat shift,
per-join reject/nudge) are the design, not a stopgap — a detector that cannot
reliably self-assess must not gate. A 12-rotation transposition-aware chroma
comparison would fix the key-change case at 12× the cost of the chroma term;
not included, and recorded here rather than left to be discovered as a bug.

## Stem bleed is model-bounded; the exact sum is guaranteed but conditional

**Area:** Separate into Stems (`electron/stemHost.cjs`,
`electron/stemManager.cjs`, `src/dsp/stemPartition.ts`,
`src/services/stemService.ts`, `src/services/stemLanding.ts`,
`src/components/Dialogs/SeparateDialog.tsx`)

**v1.7 behavior:** The two halves of "isolate every instrument without losing
any sound" are different kinds of promise, and Auditorium keeps them
differently. Both are stated in the dialog itself, in every state, before you
commit to the 166 MB download.

**What is guaranteed, by construction:** the five tracks add back up to the
source *sample for sample*. The model's raw waveforms are never shipped as
stems; they are used only to build Wiener-style ratio masks over the ORIGINAL
document's STFT (`mᵢ = |Sᵢ|²/(Σ|Sⱼ|²+ε)`, clamped so `Σmᵢ ≤ 1`), and the
Residual is the **time-domain complement** `mix − Σ stems` — one subtraction,
not a fifth mask, so there is no tolerance to tune. Measured through the real
`mixdownSession`: worst |error| **exactly 0**, **100.0000 %** of samples
bit-identical, for stereo *and* mono sources at both 44.1 kHz and 48 kHz. The
track order is part of the mechanism, not cosmetics — moving the Residual off
the last track breaks the identity (5.2e-7 at 44.1 kHz, 1.19e-6 at 48 kHz,
bit-exact 100 % → ~73 %), because the master bus accumulates track by track
with a float32 store per `+=` and Residual-last replays the order the
complement was computed in.

**What is NOT guaranteed:** how cleanly the instruments are separated. Bleed
between stems — a cymbal in `Other`, a vocal tail in the Residual — is bounded
by the model and is not a defect. Nothing in the app can remove it, no setting
trades it off, and the honest evidence is per-stem audition plus the visible
Residual track. On the reference track the raw model residual measured
−45.4 dBFS, i.e. −31.9 dB below the mix.

**The one condition the guarantee carries — a source above full scale.**
`mixdownSession` hard-clamps the master bus to ±1. A document whose samples
exceed full scale (reachable after an Amplify or an EQ boost) therefore
reconstructs with large error even though the raw sum is still exact — measured
0.600 at |mix| = 1.6, against a raw sum error of 3.5e-15. **The clamp is
detected, not defeated:** the landing measures the source peak and reports
`exactSumHolds`, and the dialog stays open on an amber note naming the peak
("This document peaks above full scale (2.40) … reduce the source level and
separate again if you need the exact sum") instead of closing on a promise it
cannot keep. When the source document has already been closed, the result is
reported as *unknown* rather than as either verdict. The stems themselves are
complete and valid audio in every case.

**Mono sources produce dual-mono STEREO stems.** `mixdownSession` picks its pan
law from the clip source's channel count: the two-channel law is exactly unity
at centre, while the mono law is `cos/sin(π/4)`. Measured, mono stem documents
reconstruct with 0.196 absolute error (−14.1 dBFS) at unity, and still only
97.47 % bit-exact with the exact inverse +3.0103 dB fader, because mixdown
computes `(x·g)·g_L` with two roundings and `cos(π/4) ≠ sin(π/4)` (they differ
by one ULP), so **no scalar gain can be the identity**. Laying the stems down as
dual-mono makes the mono path the *same arithmetic* as the stereo path, exact
by construction with every track parameter left at its default. The cost: a
mono source's five stems occupy what a stereo source's already do, and
exporting one yields a stereo file with identical channels (**Edit → Convert
Channels…** converts it).

**Separation is capped at 15 minutes of audio per run.** Not a round number:
renderer RSS during the mask/complement pass was measured at **4.4 MB per
second of audio** (15 s → 516 MB, 30 s → 584 MB, 60 s → 716 MB; 264 MB per
minute), so 15 minutes is where the renderer alone approaches 4 GB while the
inference process holds its own ~5 GB. The utility process enforces an outer
30-minute bound; from the renderer that bound is unreachable, so the refusal
you see quotes the 15 minutes that actually apply.

**Inference is CPU-only and there is no GPU path to enable.** Measured on an
RTX 3080 Laptop (16 GB VRAM), 30 s of real material: `onnxruntime-node` CPU
**1.52× realtime** at 5.0 GB peak (1.57× / 5,068 MB in the shipped host);
**DirectML never finished the first 7.8 s segment** — killed at 708 s with
20.8 GB host memory and 15.7 of 16 GB VRAM consumed; `onnxruntime-web` wasm
**0.20×**, and only with graph optimisation disabled (`'all'` dies at session
creation with `std::bad_alloc`). The DirectML DLLs are therefore not packaged
at all.

**Intended behavior:** The exact-sum guarantee, the mono routing and the CPU
architecture are settled — no further work planned. Separation quality is a
property of the model: a better or newer checkpoint (or a user-selectable stem
count beyond the fixed 4 + Residual of v1.7) is the only lever, and would be a
model/UI change rather than a fix to this pipeline.

## The beat grid shows only what was measured; snapping targets beats, not clip edges

**Area:** Beat grid (`src/services/beatGrid.ts`,
`src/components/Editor/waveformRender.ts`,
`src/components/Editor/useBeatGridOverlay.ts`,
`src/components/Multitrack/clipBeatTics.ts`), snapping (`src/services/snap.ts`,
`src/components/Editor/editorSnapTargets.ts`,
`src/components/Multitrack/sessionSnapTargets.ts`)

**v1.8 behavior, items 4–5 updated for v1.9:** Five limits, each a
consequence of drawing only what the analysis actually produced — except
item 5, which v1.9 resolved and which is kept here as the record of what
remains of it.

**1. The tics are a tracked grid, so they follow a drifting take — and every
tempo-detection limit above applies to them unchanged.** `beatSamples` comes
from the Ellis dynamic-programming tracker with per-beat sample refinement, not
from `60 / BPM` repeated across the file, which is why the tics stay on the beat
on material that speeds up or slows down (measured in v1.5: 7.7 ms worst-case
error where a rigid grid was off by 1455 ms). The flip side is that they inherit
the detector's octave errors and downbeat-phase errors wholesale: a 60 BPM loop
misread as 120 draws twice as many tics, all of them in real onset positions, and
the ×2 / ÷2 control is the correction — it re-tracks the grid rather than
relabelling the number, so the drawn tics move with it.

**2. Bar lines require a remix-level analysis; an ordinary Detect Tempo has
none.** `barBoundary`, `downbeatPhase` and `beatsPerBar` live only on a
`level:'remix'` analysis, which only the Auto-Remix dialog produces. Every other
path — the Properties panel, `Effects → Detect Tempo`, the test hook — produces a
tempo-level result carrying `beatSamples` and nothing else, so the grid it draws
is an unbroken row of equal tics with no visible bar 1. This is deliberate: the
alternative was deriving bar data from stubbed features and publishing it into
the shared analysis cache, which would have invented a downbeat the DSP never
measured *and* handed it to Auto-Remix to plan against. When bar data is present
but empty (fewer than two boundaries fit), that is handled as "no downbeats"
rather than as an error, and `beatsPerBar` is always read as data — 4/4 is never
assumed.

**3. The grid stops at the analysed end, and can vanish when a fifth document is
analysed.** Whole-document analysis is capped at `MAX_ANALYSIS_SECONDS = 600`, so
on a longer file the tics end at the 10-minute mark and nothing is extrapolated
past it. Separately, the tempo cache holds `MAX_ENTRIES = 4` and evicts in
**insertion order, not least-recently-used** — reading a grid does not protect
it, so a grid on screen can disappear when a fifth document is analysed, with no
error anywhere. Promoting a row on read was considered and rejected: it would
make a repaint reorder eviction, trading this surprise for a worse one. What
keeps the workflow this feature exists for inside four rows is inheritance —
a source plus its five stems occupy one row, not six.

**4. Snapping targets beats, bar lines and markers — not clip edges.**
Butt-joining two clips is the other classic multitrack magnet and it is not
here. Same-track clip boundaries became first-class crossfade joins in v1.9,
but clip-edge snap targets still did not land with them; the precise butt-join
affordance is instead the Ctrl-drag nudge (below), which lands a clip exactly
at its neighbour's end. In practice head-to-head alignment mostly works
anyway, because a clip's first beat usually coincides with its start. Bar lines
add nothing to the target set even when they exist, and that is arithmetic rather
than an omission: every bar line already *is* one of the beats. The timeline
ruler does not snap either — it is a seek surface showing seconds, with its own
zoom and time base.

**5. The Ctrl-drag nudge commits somewhere the preview does not show.** v1.8's
"overlap nudge outranks the magnet" limitation resolved exactly as predicted:
since v1.9 (X5) `resolveOverlap` no longer relocates clips by default, so
snap-then-nudge degraded to snap-only, a dropped clip commits precisely where
the preview showed it — overlapping a same-track neighbour if that is where it
was dropped (the overlap arms a crossfade) — and nothing in the gesture layer
changed. What remains is the deliberate residue: holding **Ctrl** at the drop
re-enables the v1.8 forward-only nudge, and in that one opted-into case the
committed position (the neighbour's end) is not the position the preview
showed, because only the session store knows the target track's other clips.
Intent first, validity second — the reverse order could pull a clip back into
the overlap it had just been moved clear of.

**Intended behavior:** 1–3 are properties of the data and are surfaced rather
than smoothed over: a provisional grid (stale, or below `CONFIDENCE_LOW`) is
drawn dimmed and dashed with its geometry unchanged, and no grid at all is drawn
without a cached analysis. 4 remains sequenced, not dropped — clip-edge snap
targets can now be defined without ambiguity (the boundary's meaning settled in
v1.9) and Ctrl-drag covers the butt-join in the meantime. 5 is the pinned
preview/commit contract: divergence exists only under the Ctrl opt-out, never
on a default drop.

## Remove Silence detects a pause starting ~100 ms late (safe direction, by design)

**Area:** Remove Silence effect (`src/effects/restoration/SilenceRemoverEffect.ts`,
detector in `src/dsp/silenceDetect.ts`).

**Behavior a user will notice:** with "Min silence" at 500 ms, a physical gap of
~550 ms can survive untouched. The detector's envelope does not drop to the
threshold the instant speech stops — it decays there over
`release · ln(level/threshold)`, about 100 ms for speech 44 dB above the
default −50 dB threshold — so the *detected* run is roughly 100 ms shorter than
the physical gap. In practice the effective minimum physical gap is
"Min silence" + ~100 ms, and every processed gap keeps that much extra
material at its head on top of the padding.

**Why it is built this way:** the 20 ms release is the shortest that still
bridges the gaps between glottal pulses inside voiced speech (lowest common
speaking f0 ≈ 75 Hz → 13.3 ms between pulses; τ = 13.3/ln 2 ≈ 19.2 ms keeps
the inter-pulse droop under 6 dB). A faster release would see sub-threshold
slivers inside words and cut into speech; the chosen constant only ever errs
toward removing *less*. The gap's END is accurate to ~1 ms (1 ms attack), so
speech onsets are never clipped. If a bordering gap must be caught, lowering
"Min silence" by ~100 ms compensates exactly.

## An open envelope lane owns its track lane; automation overrides the fader

**Area:** F0 automation keys (`src/components/Multitrack/EnvelopeLane.tsx`,
`src/multitrack/automation.ts`, `src/multitrack/MultitrackPlayer.ts`).

**Behavior a user will notice:** three things, all deliberate. (1) While a
track's envelope lane is open (the Activity toggle in the track header), the
overlay owns every pointer event on that lane — clips underneath cannot be
selected, dragged or trimmed until the envelope is closed. (2) While a lane
has at least one key, that parameter's header slider is disabled and the live
fader is inert: the envelope IS the parameter (override, not offset), and the
slider's stored value only returns to force when the last key is removed.
(3) Editing automation during playback re-bakes and reschedules only the
affected track from the current position; the handover is scheduled-clock
accurate but not sample-seamless, so a tiny seam can occur at the moment of
the edit. A clean play (and every mixdown) is exact.

**Why it is built this way:** (1) is the standard DAW automation-mode
contract — a lane cannot serve two gesture vocabularies at once, and the
overlay stopping propagation is also what protects the clip selection under
it. (2) is ruling B: a user who draws a volume envelope means *that* to be
the volume; letting the fader offset it would make the drawn curve a lie.
(3) is the cost of ruling A: envelopes are BAKED into the player's buffers
from the same shared evaluator the offline mixdown multiplies — the only
implementation that keeps live playback sample-identical to `mixdownSession`
(the playback≡mixdown invariant held since v1.1) — so an edit needs a
rebuild, and the rebuild is scoped to one track and one commit per gesture
rather than per pointermove.

## Spatial placement is a stereo projection, not binaural 3D audio

**Area:** F5 spatial positioner (`src/dsp/spatial.ts`,
`src/multitrack/mixdown.ts` `autoSpatialGainsAt`,
`src/components/Panels/SpatialPanel.tsx`).

**Behavior a user will notice:** four things, all deliberate. (1) A source
placed BEHIND the listener sounds identical to its mirror position in front
— the stage shows "front" and "behind", but the audio folds the rear onto
the front. (2) Raising elevation narrows the image toward the centre; at the
zenith every azimuth sounds dead centre, and elevation at azimuth 0 changes
nothing at all. (3) Distance changes only level (unity at or inside the
reference circle, −6 dB at 2×, −20 dB at the 10× range edge) — no air
absorption, no reverb cue. (4) While any spatial lane has a key, the track's
pan — the slider AND a pan envelope — is superseded entirely; the pan slider
disables with an explanation.

**Why it is built this way:** (1)–(3) are the honest limits of amplitude
panning: the projection `sin(azimuth)·cos(elevation)` is the source
direction's component along the interaural axis, and front/back or
median-plane cues simply do not exist in two channel gains. True binaural
placement needs HRTF convolution — a licensed HRIR dataset, per-sample
convolution, and a model download on the scale of stem separation — and Web
Audio's built-in `PannerNode` HRTF was rejected because it has no offline
equivalent: what you heard would no longer be what `mixdownSession` exports,
breaking the exact playback≡mixdown parity F0 established (both engines
compute spatial gains from one shared TypeScript function instead, proven
equal to the last float32 bit). ITD (interaural delay) is likewise omitted
rather than approximated: a time-varying delay line is a resampling problem
that produces Doppler-like artefacts unless carefully interpolated. The
interface (position lanes → per-sample gain pair) is exactly the seam a
future HRTF backend would slot into. (4) is F0's override-not-offset ruling
one level up: spatial placement and pan compute the same thing, and two
placement laws composed would double-apply position; the more specific
system governs while it exists.

Azimuth automation interpolates along the SHORT arc across the ±180° seam
(keys at 170° and −170° mean a 20° pass behind the listener, not a 340°
sweep through the front); a deliberate long sweep is written by adding an
intermediate key. Keys exactly opposite (180° apart) travel the
decreasing-azimuth arc — through the left — as a fixed, pinned tie-break.

One consequence of the positioner's what-you-see-lands rule: the whole
preview freezes when a drag starts, so dragging the stage during playback
while an elevation lane is moving writes an elevation key at the value shown
when the drag began (the frozen dot/readout), not at the value the lane
reached by release. The panel displays exactly what will be committed.
