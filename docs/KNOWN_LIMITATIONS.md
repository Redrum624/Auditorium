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
