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
As of v1.14 (R5) the remaining in-extension variants sniff too: **Ogg FLAC**
(the RFC 9639 §10.2 `0x7F FLAC` first packet) and **Ogg Speex** (the
SpeexHeader struct) identification headers are parsed; a **free-format MP3**
(bitrate_index 0000) is accepted when a second header with matching
version/layer/sample-rate fields confirms it within 2881 bytes — the longest
frame the spec permits a free-format stream (Layer II at the 160 kbps LSF
table maximum, 8000 Hz, plus one padding slot), since a lone free header is
indistinguishable from a stray sync byte; and the WebM/Matroska EBML walk is
no longer byte-capped at 512 KB — that cap made any finalized (known-size)
Segment larger than 512 KB unsniffable outright — but walks the whole buffer
size-driven, bounded by a 65536 per-level sibling count (the same
count-not-bytes shape as the MP4 box cap, covering Tracks-after-Clusters
layouts for 18+ hours of material while a tiny-element flood stays
microsecond-bounded). Deep `moov` (after a large `mdat`, the non-faststart
layout) needed no change — the size-driven MP4 walk already reached it, now
pinned by test. Only genuinely unrecognized container layouts still fall back
to **48000 Hz**. NON-WAV audio with more than two channels is down-mixed to
stereo at import — the extra channels (index ≥ 2) are folded into both L and R
at −3 dB rather than dropped: `mix = 0.7071·mean(ch2…chN-1)`,
`L' = clamp(ch0 + mix, ±1)`, `R' = clamp(ch1 + mix, ±1)`. That import-time fold
is irreversible (it runs before the document exists) and its law is fixed —
the Web Audio decode path exposes no speaker layout, so the layout-aware
matrix below can never apply there. Multichannel **WAVs** are different: they
open with ALL channels retained (as of v1.15 including spec-conforming
`WAVE_FORMAT_EXTENSIBLE` 5.1/7.1 files, whose `dwChannelMask` speaker layout
is read with them), and the downmix is an explicit, undoable
`Edit → Convert Channels…` action with a **user-selectable law** — the
original fold (default) or ITU-R BS.775 when the layout is known (v1.15, R6).

**Intended behavior:** For unsniffable formats, add per-container parsers as
needed; the current fallback is a bounded, safe default. The user-selectable
surround downmix matrix shipped in v1.15 for WAV documents; the import-time
fold for non-WAV multichannel remains fixed because no layout metadata exists
on that path to key a matrix from.

## Surround layout is read on open but not yet written on save

**Area:** WAV encoder (`src/audio/wavCodec.ts` `encodeWav`), sessions
(`src/multitrack/sessionFile.ts`), downmix (`src/dsp/downmix.ts`,
`src/components/Dialogs/ConvertDialog.tsx`)

**v1.15 behavior (R6):** Three deferred edges of the new channel-layout
support, all fail-safe (the BS.775 option degrades to disabled; audio is never
misfolded):

1. **WAV saves still write the plain format tag, so the speaker mask is lost
   on a round-trip.** The encoder predates layout support and emits a
   44-byte plain-tag header for any channel count. Open a 5.1
   `WAVE_FORMAT_EXTENSIBLE` file → Save → reopen, and the reopened document
   has its six channels but no `dwChannelMask`; the BS.775 downmix option
   shows disabled ("needs a known layout") for it. Writer-side EXTENSIBLE
   support (fmt-40 with the mask for >2-channel documents) is the natural
   follow-up.
2. **`.audm` sessions do not persist the mask.** Session files re-embed
   documents as plain-tag WAV, so a session save/load drops the layout the
   same way. Persisting it means a session-format field addition.
3. **7.1 deliberately falls back to the fold.** BS.775-3's Annex 4 table
   covers the 3/2 family (up to L/R/C + one surround pair, ±LFE); a 3/4
   layout such as 7.1 is not in the cited table, and an uncited two-stage
   7.1→5.1→2/0 chain was not invented. A 7.1 file opens fine and downmixes
   with the fold; the dialog states which law is in force.

**Intended behavior:** Items 1–2 are planned follow-ups (write the mask where
we read it); item 3 stays until a citable 3/4 downmix is adopted.

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

**2026-08-22 (ten-item program, lot A — M4):** since this change **no command
performs an in-place audio save**. File → Save / Save As write the `.audm`
project, and Export is the only way audio leaves the app. The in-place Opus
re-encode described above (and the MP3/FLAC/WAV ones) survives only behind
the headless `saveActiveInPlace` test hook (`src/services/testHooks.ts`) and
the format-faithful round-trip suites in `fileService.test.ts`.

**Intended behavior:** No further work planned — Opus-in-Ogg is the correct
modern default. A native Vorbis encoder (to keep Vorbis sources as Vorbis) was
**dropped 2026-08-09 (R5), on measurement, not preference**: the shipped
runtime's `AudioEncoder.isConfigSupported` was probed directly and reports
**vorbis: not supported** (mp3, flac and pcm likewise; only **opus** and
**aac** can be encoded). WebCodecs therefore cannot provide it, and "add a
native Vorbis encoder" would mean implementing the Vorbis I specification in
TypeScript — MDCT, floor and residue codebooks, the lot — a multi-week
project, not a wishlist tidy-up. Do not re-open this on the assumption that
the platform encoder would do it; it will not.

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
- **`.audm` projects** (v4, still reads v1–v3) — a `markers` map per
  embedded document (every open document since v4; v3 carried only the
  clip-referenced ones); v1 session files still load with zero markers.

Opening any of these seeds the store with fresh marker ids; Export and the
project save (File → Save / Save As…, which carries every open document's
markers in the `.audm`) write markers back. Files exported with **no** markers
are byte-identical to pre-v1.3 output for every format.

**v1.4 additions:** adding, renaming, or deleting a marker now dirties the
owning document (Files-panel `*`, close/quit prompts, the async-save
staleness check) and is undoable from the History panel (`Add Marker` /
`Rename Marker` / `Delete Marker`). Destructive edits that change the
timeline — ripple delete (`Shift+Delete`), insert/paste, trim, replace,
sample-rate conversion, and length-changing effects (Time Stretch, Pitch
Shift) — remap or drop marker positions atomically with the audio, in the same
undo step; interior markers under a length-changing effect map proportionally
rather than being dropped. Delete, Cut and Silence are equal-length since the
item-7 change and leave every marker where it was, including markers inside
the silenced span. Positions are always clamped to `[0, document length]`, so
a marker can never be written to disk past the end of the file.

**v1.10 refinement (F2):** the proportional rule above is right for effects
that TRANSFORM the whole region but wrong for Remove Silence, which deletes
discontiguous interior spans — a marker on speech after a removed gap must
shift by exactly the removal before it, not by the region's average shrink
ratio. Span-deleting effects therefore report their removed spans and markers
get an exact piecewise remap; a marker INSIDE a removed span (a cue placed in
the pause — podcast chapters live there) snaps to the splice point instead of
dropping, unlike an explicit user delete.

**v1.23 refinement (R7):** the proportional rule is exact only where the local
ratio equals the region's AVERAGE ratio — which for a variable-rate Match Tempo
("Follow the tracked beats") is true almost nowhere, since the whole point is
that the rate differs bar by bar. The shared `'stretch'` remap therefore drifted
every interior marker away from the audio it marks, on strongly varying material
by the same order of magnitude the feature had just removed from the audio: on
the measured 100→120 BPM accelerando, up to ~525 ms.

**Corrected in v1.23.1 (L1-6), at the service.** `tempoService` captures the
marker list BEFORE the run and, after the commit, recomputes each position from
those ORIGINAL positions through the map the audio actually went through —
`regionStart + round(synthesisPosAt(map, pos - regionStart))` inside the region,
`pos + (outLength - regionLength)` at or after it, unchanged before it. That is
a re-computation, not an unwind: nothing tries to invert the proportional remap,
which has already lost the information needed to do so. It is the same shape
`timingAlignService` uses to move markers through its warp map, and it runs
BEFORE the beat grid so the grid appends to the corrected list.

`applyEdit`'s shared `'stretch'` remap is unchanged and still applies to Time
Stretch, Pitch Shift and every other length-changing effect that stretches a
region uniformly, where proportional IS exact.

**The cost, stated rather than hidden:** an extra undo entry per Apply. With the
beat grid on, the sequence is `Match Tempo`, then `Match Tempo Markers`, then
`Add Beat Markers`, and Ctrl+Z unwinds it newest first: the first removes the
grid and leaves the pre-existing markers corrected, the second puts them
transiently back at their proportional positions, and the third removes the
audio edit and its remap together. With the grid off there are two entries and
the same sequence is one step shorter — the first Ctrl+Z leaves the markers
proportional, the second removes the audio edit. (`Match Tempo Markers` exists
only when a pre-existing marker actually moved — over a region with no markers,
or a map that leaves them all in place, that entry is skipped and each count
above drops by one.) That is the same property
`Align Markers` and `Add Beat Markers` already ship with: a
marker write cannot ride inside `applyEdit`'s own entry, because `applyEdit` has
already committed by the time a service-level correction can run.

**Why not a `'warp'` member on the `MarkerRemap` union** (F2's route, which
earlier notes here recommended): it costs six production files plus a worker
contract change and a worker mock that fails SILENTLY if missed — an optional
field simply drops, and every unit test then passes against the old `'stretch'`
behaviour. `synthesisPosAt` also clamps into `[0, outLen]`, so a naive union
member would pin every marker at or after the region TO the region end rather
than shifting it: silent corruption, worse than the drift it replaces. The
service-side correction is one file and reaches the same positions. The union
variant remains the right long-term shape if a second variable-rate effect ever
needs it.

**The earlier note ruled out F9's route, and that ruling was over-strong.**
Align Vocal Timing preserves length, so `applyEdit`'s proportional remap is the
identity for it — but F9 does not *unwind* that remap either, and neither does
this: it recomputes from positions captured before the run. Length-changing
makes the proportional remap non-identity, not un-correctable.

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
re-encode, the project save) writes to a sibling temp file
(`<target>.<pid>.<seq>.<random>.tmp` — the random suffix on top of pid+seq makes
the name unguessable, so there is nothing for an attacker to pre-plant a symlink
at; same directory as the target, so the follow-up rename stays on one volume),
fsyncs it, closes it, then renames it over the target. A failure at any step
(encode error, disk full, permission denied) unlinks the temp file and leaves
the original untouched — an interrupted or failed save can no longer destroy
or truncate the file that was already on disk.

**2026-08-22 (lot A — M4):** no command performs an in-place audio save any
more (Save writes the `.audm` project; Export is the only audio write). The
atomic `file:write` above still covers every write the app makes — every
Export, the project save, and the headless `saveActiveInPlace` hook, which is
the only remaining caller of the in-place engine.

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

**The budget is per document, and nothing sums across documents.** Every open
document carries its own independent 800 MB ceiling, so the aggregate undo
retention is `MAX_UNDO_BYTES × (documents with history)` in the worst case —
five heavily-edited large documents open at once can legitimately pin ~4 GB
of undo snapshots between them, and no app-wide eviction exists to shed one
document's history under another's pressure. In practice the worst case
requires every open document to have been edited up to its own budget, which
is unusual; closing a document releases its entire history at once.

**Intended behavior:** No further work planned — this is the intended
memory/depth trade-off for a browser-engine-hosted editor with no swap to
disk. A global cross-document budget would be feature work (a shared eviction
policy deciding WHOSE history to shed), recorded here rather than planned.

## Project files are format v4 (binary); very large legacy sessions may not load

**Area:** Projects (`src/multitrack/sessionFile.ts`)

**2026-08-22 behavior (ten-item program, lot A — M4):** `.audm` files are
written in **format v4**: an `AUDM4\n` magic, a JSON header and the embedded
audio as raw Float32 bytes, exactly v3's layout, plus an `unreferenced`
section so that **every open document** is in the file (v3 embedded only the
documents a clip referenced), `markers` for every embedded document, and a
per-document `origin` — the path the document was opened from, restored as
its `filePath` on open. Nothing is dropped from a project save, which is why
the version had to move. **A v4 file is unreadable by builds ≤ v1.35** (their
reader hard-rejects any other `formatVersion`); v3, v2 and v1 files still open
normally. File → Save / Save As write v4; File → Open Project… reads all four.

**v1.4 behavior (v3):** the binary layout itself — no monolithic JSON string
and no base64 payload are ever built. This removed the v1/v2 format's silent
failure once embedded audio's base64 encoding pushed the session's JSON past
the JS engine's string length cap (roughly 17 minutes of embedded audio in the
old format); a save surfaces both success and failure explicitly instead of
failing quietly.

**Remaining limitation:** a **legacy v1/v2** session file whose JSON already
exceeds the JS string cap still cannot be loaded — Open Project reports a
clear error instead of crashing, but the file itself is unreadable either way.
Resaving it (File → Save As… writes v4, once it can be opened at all) avoids
the ceiling entirely, since neither binary layout — v3 or v4 — builds that
string.

**Intended behavior:** No further work planned for the binary layout itself.
A v1/v2-specific recovery tool (partial-parse salvage) is **moot, not merely
unplanned** (closed 2026-08-08, R2-4): the legacy *writer* built the very same
single JS string the reader decodes — `serializeSession` base64-encoded each
document and `JSON.stringify`-ed the result into one string of the same
length — so writer and reader hit the identical V8 string cap. Any legacy
`.audm` this app successfully wrote is by construction readable; an over-cap
legacy file can only have come from another tool, and there is nothing of
Auditorium's to salvage. (The over-cap error path is pinned by test.)

## Export length vs playback length in multitrack

**Area:** File → Export… in the multitrack view (`src/services/fileService.ts`
`exportSessionMixdown`, `src/multitrack/mixdown.ts`)

**2026-08-22 behavior (lot A — M5):** Export in the multitrack view is
**byte-identical to Mix Down to New File**: it writes what `mixdownSession`
renders, and that render stops at the last **audible** clip end
(`mixdown.ts`, `sessionLength` over the audible tracks). The transport
(`MultitrackPlayer.ts`) and the timeline (`sessionZoom.ts`) run to the last
clip end over **all** tracks, muted included — so a session whose longest clip
sits on a muted track exports **shorter** than the transport's end position.

**Intended behavior:** Unchanged by design. M5 fixes Export to the mixdown,
and the mixdown is playback ground truth for what is heard; the tail past the
last audible clip is silence the player merely counts through. Padding the
export to the transport length would write silence nobody asked for, and
trimming the player would change playback behaviour for an export concern.

## Closing a document after a project save does not dirty the project

**Area:** Project dirtiness (`src/services/fileService.ts`
`projectHasUnsavedWork`)

**2026-08-22 behavior (lot A — M4):** the project is dirty when any document
has unsaved work, the session history is off its save point, or the project
has content and has never been written. **Removing a document from the
working set is none of those**: after a project save, closing a clean
document (its audio is in the `.audm`) leaves every remaining document clean,
the session untouched and the path set — so the Save pill stays grey and the
chip shows no star, while the next Save silently writes a file without that
document.

**The same blind spot, the other direction — opening a document into an
already-saved project.** `openFilePath` (`src/services/fileService.ts:281`)
builds the document through `createDocument`, which starts it `dirty: false`
(`src/audio/AudioDocument.ts:87`), and passes `neverSaved: false` because the
audio came off disk. Reading a file therefore touches none of the three
clauses either: no document is dirty, the session history never moved, and
the path is still set — so **Save stays grey and the newly opened file is
absent from the `.audm`** until something else dirties the project. The
symptom is worse than the closing case (a file the user can see in the Files
panel is silently missing from the next save rather than silently dropped),
but the cause is identical: adding to or removing from the working set is not
part of M4's dirty definition.

**Intended behavior:** Recorded, not planned, for both directions. The file
on disk is not wrong (it holds what was saved); what is missing is a "the
working set changed" signal. Counting a closed or newly opened document as
dirt would need a per-project record of what the last save contained, which
is feature work beyond M4's definition.

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
REPEATED work across presses but not the cost of one cold roll.

**A pin used to be a strong preference; since v1.21.0 (R4b) it is a
guarantee** — for up to `MAX_REQUIRED_JOINS = 4` pins. `planRemix` takes
`requiredJoins` and enforces it exactly with a subset axis on its DP (state
`(p, n, S)`, `S` the bitmask of satisfied pins), so the returned plan contains
every pinned join or names the ones it could not and why: the key is also
rejected (`forbidden`), it is not a legal splice for the current settings
(`no-candidate`), or it cannot coexist with the pins that were kept
(`incompatible`). The maximum satisfiable pin set falls out of the same table,
so there is no relaxation pass or retry loop.

The residual is the `2^K` the exactness costs, and it is the reason for the
cap. The table is 12 bytes per cell (`Float64Array` cost + `Int32Array`
parent) over `(M+1)*(Nmax+1)*2^K` cells: at the worst case reachable
(`M = 499`, `Nmax = 1497`, 749 000 cells, 8.99 MB at K = 0) that is 143.8 MB
at K = 4 and 2.30 GB at K = 8. Time scales with it too, and slightly worse than
the table does: measured at `M = 496`, one DP run costs **1.00x / 1.85x /
3.46x / 6.58x / 13.2x** of the K = 0 run at K = 0…4, so each additional pin
costs between **1.85x and 2.01x** the run before it (1.85, 1.87, 1.90, 2.01) —
so a four-pin Re-roll on a ten-minute source is seconds of worker time rather
than milliseconds. The routing threshold
multiplies by `2^K` and is re-evaluated per plan, so those seconds are always
spent in a worker, never on the main thread.

**Read that 13.2x as per-DP-run, and compound it with the paragraph above.**
Re-roll at `rollIndex = k` re-derives rolls `0..k` to stay deterministic and
stateless, so it runs `k+1` DPs and pays the `2^K` factor on each. The two
costs multiply rather than add: the worst case a user can reach from the panel
is a late Re-roll press at four pins, and it is several times the single-run
figure — not the ~4 s a reader would derive from 13.2x alone.

**The panel's pin cap stays 8, deliberately higher than 4.** Past the cap the
guarantee is not partially in force, and it is worth being exact about that:
`planRemix` assigns the WHOLE feasible set to `preferredKeys` (`preferred` is
the `lockedJoins` behaviour — exemption plus `LOCK_BONUS`) and reports
`mode: 'preference'`, so with five feasible pins **none of the five is
guaranteed**, not "the first four are and the fifth is not". The panel says so
in those terms ("More than 4 pins: the planner cannot guarantee them all, so it
is treating **every** pin as a strong preference. Unpin down to 4 to get the
guarantee back") rather than degrading silently, and unpinning back to four
restores the guarantee on the next re-plan.

The cap counts only the pins that reach the search. A pin you rejected
(`forbidden`) or that is not a legal splice for the current settings
(`no-candidate`) is dropped by triage before the DP runs and consumes no bit,
so six pressed pins can still be fully enforced — which is why the panel reads
its wording from the planner's own `mode` rather than from the pin count.

Lowering the cap to 4 would make the guarantee unconditional at the price of
taking four pins away from a user who is arranging by hand.

Measured against the preference it replaces, over 102 pin/press cases across
five scales (32–496 bars) and five presses per pin: the preference kept the
pin **83/102**, the guarantee **102/102**, changing the chosen arrangement in
22 cases at a mean clean-cost premium of **+2.17**. On the sharper case — a
pin the cheapest plan does not contain, 109 cases — the preference kept it
**0/109** and the guarantee **109/109**, at a mean premium of **+5.18**. A
rejection still wins over a pin, and is reported as such by name.

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

## Tempo detection makes octave errors; Match Tempo can follow a varying tempo, the remix still assumes a constant meter

**Area:** Tempo analysis (`src/dsp/tempoCore.ts`, `src/services/tempoAnalysis.ts`),
Match Tempo (`src/services/tempoService.ts`), Auto-Remix (`src/dsp/remixPlan.ts`)

**v1.5 behavior:** Three limits, all inherent to the approach rather than
defects to be tuned out.

**1. Octave errors are mitigated, not eliminated.** Measured on the committed,
deterministic 83-fixture bank (v1.13, `scripts/tempo-bench.cjs`, results in
`docs/bench/`): **74 exact, 9 octave errors, 0 non-octave misses**, spanning
click/attack trains, drum loops across the ghost-note range, backbeats, tempo
ramps, humanly-jittered timing, and no-tempo material. (An earlier "63 of 91"
figure circulated from v1.5; that bank was never preserved, so it is not
reproducible and not comparable — the committed bank is its own denominator.)
The harmonic comb, log-Gaussian prior, beat-salience vote and the v1.13
jitter-tolerant period-match resolve most half/double ambiguity, but the
remaining misses are structural: genuine multi-member octave families in the
165–200 BPM band, prior-pull doubling on slow loops with strong half-period
energy (a drumLoop(75) misread as 150 reports confidence 1.0 — the highest in
the bank), and loud-ghost content whose doubled reading is honestly present in
the audio. The disambiguator only chooses among {⅓, ½, ⅔, 1, 3/2, 2, 3}× the
comb winner — a first-stage miss outside that family is unrecoverable. The
confidence score **cannot** catch any of this: periodicity is invariant under
octave choice (the structure really is there at 2×). The
165–200 BPM band on uniform content is additionally phase-unstable by design.
The remedy is therefore the **×2 / ÷2 control**, which re-tracks the grid at the
corrected period rather than relabelling the displayed number, plus the manual
BPM field and the Auto-Remix tool's explicit tempo confirmation. No feature
presents a detected BPM as authoritative.

**2. Downbeat phase can be wrong** independently of the tempo. The detector
assumes the low-frequency accent falls on beat 1; reggae, heavily syncopated
pop and anacrusic intros land 1–3 beats off, which puts every splice off the
bar line even at a correct tempo. `downbeatConfidence` is reported as a soft
hint and is explicitly **not** a gate — its log compression flattens a genuine
2× accent, so any threshold would reject correct detections on most real music.
The Auto-Remix tool's structure strip is where a wrong grid becomes visible
before anything is committed, and the ◂ ▸ shift is the correction.

**3. Varying material: TWO different limits, with different causes and
different fixes.** They were run together in one paragraph until v1.23.0, which
is part of why neither got fixed. A tempo that *varies* and a meter that
*changes* break different things:

**3a. Match Tempo can now FOLLOW a varying tempo — opt in (v1.23.0).** Match
Tempo's default is still ONE ratio for the whole region, which is right for
steady material and is what a user reaching for it on a loop wants. When the
tempo drifts, the **Correction → "Follow the tracked beats"** mode builds a
tempo *map* from the confirmed beat grid and moves each tracked beat onto the
target grid individually. Measured on synthetic accelerandi whose beat positions
are exact by construction (24 s, 48 kHz, through the real engine), against the
*most favourable* single ratio there is — the one matching the region's total
duration, which pins the first and last beat exactly:

| material | tempo slope | one ratio: median / worst beat error | following the beats |
|---|---|---|---|
| 108→112 BPM, target 110 | 0.17 BPM/s | 78.8 ms / 104.4 ms | 0.36 ms / 4.6 ms |
| 100→120 BPM, target 110 | 0.83 BPM/s | 393.9 ms / 525.8 ms | 1.8 ms / 4.6 ms |
| 90→140 BPM, target 115 | 2.08 BPM/s | 951.3 ms / 1274.4 ms | 4.4 ms / 9.8 ms |
| steady 120, target 110 | 0 | 0 ms / 0 ms | identical, byte for byte |

525.8 ms is **0.96 of a 545 ms beat** — on a gentle accelerando one ratio leaves
the middle of the region off by nearly a whole beat. The remaining few
milliseconds on the right-hand column are WSOLA's own placement error, not the
map's, and they do not grow with the slope.

**Your other markers inside the region follow the map too (fixed in v1.23.1).**
The beat grid this mode lays has always been exact — it comes from the tempo
map's own placed positions — but in v1.23.0 every OTHER marker inside the
corrected region was remapped proportionally by the shared write path, which is
right only where the local rate equals the region average; on strongly varying
material that error was the same order as the one being removed from the audio
(up to ~525 ms on the 100→120 fixture above). `tempoService` now recomputes each
of those markers from its PRE-run position through the map itself, as a separate
`Match Tempo Markers` undo entry. See the marker-persistence entry ('Markers
persist in every container', v1.23 refinement / v1.23.1 correction) for the
mechanism, the undo cost it carries, and why the `MarkerRemap` union variant was
not the route taken.

**What it still cannot do, and says so:** the local ratio is bounded by the same
`0.25x–4x` limit the constant path enforces, per beat interval rather than once
for the region. A beat the bound holds back is moved as far as it allows and
**counted in the tool** rather than silently under-delivered. And the map is
only ever built from a beat grid the user has **confirmed** — the tick is
cleared by every ×2 / ÷2 re-track and every re-detect — because a wrong single
ratio is uniformly wrong and audible at once, while a wrong tempo map is wrong
*differently in every bar*: harder to hear, harder to attribute, impossible to
undo by ear. (For a *sung* take that drags in one line and rushes in the next,
**Align Vocal Timing** is still the better answer — it warps between confirmed
syllables rather than between beats. Its own limits are in section 3c.)

**3b. The remix still assumes a CONSTANT METER, and this half is open.** The
remix's bar boundaries come from real tracked beats, so late splices still land
on the beat on a drifting take — a genuine improvement over a rigid grid, and it
is why 3a's fix does not carry over here. What breaks is different: bar
boundaries are derived by striding the beat list at a *constant* beats-per-bar
(`remixFeatures.ts`), so a section in another meter walks the bar grid off the
real downbeats. Measured on synthetic 120 BPM fixtures with exactly-known
downbeats, through the real `analyzeTempo` → `deriveRemixFeatures` pipeline:

| fixture | boundaries landing on a true downbeat | median boundary error | phrase-congruent joins that are musically congruent |
|---|---|---|---|
| 4/4 throughout, 36 bars (control) | 35 / 36 | 0.6 ms | **100 %** |
| 4/4 ×16, **3/4 ×4**, 4/4 ×16 | 32 / 35 | 0.6 ms | **32 / 96 = 33 %** |
| 4/4 ×16, **3/4 ×5**, 4/4 ×16 | 17 / 35 | **499 ms** (a full beat) | 16 / 20 identifiable = 80 % |

The last column counts only pairs whose BOTH endpoints can still be matched to
a real downbeat; pairs that cannot are excluded from the numerator *and* the
denominator, which is why the control scores 100 % rather than being charged
for its trailing partial bar. That convention is also why row 3's percentage
looks better than row 2's while the material is worse: the 3/4 × 5 bridge
destroys so many boundaries that only **20** phrase-congruent pairs remain
identifiable at all, against 96 for row 2. Read row 3's first two columns, not
its last.

A bridge whose beat count is a multiple of the assumed meter (3/4 × 4 = 12
beats) lets the boundary *positions* re-align afterwards, but the bar
*numbering* is permanently shifted — so `a ≡ b mod Φ` congruence still holds
arithmetically while only a third of those joins (32 of 96) connect the same
position in the real phrase. A bridge whose beat count is **not** a multiple
(3/4 × 5 = 15 beats) is worse: **18 of 35** bar lines sit a full beat off the
downbeat for the rest of the track, and most bar pairs stop being identifiable
at all.

**Why it is not fixed yet, stated rather than hidden:** the app has **no meter
detector at all** — `beatsPerBar` is a single time signature the user picks in
the Auto-Remix tool — so variable meter needs a new surface for the user to
say where the meter changes, and it may not be driven from an unconfirmed
detection (see the octave-error entry above for why detector confidence cannot
gate this class of error). Beyond that, the per-bar descriptor matrix the
planner scores against is `4 × beatsPerBar` columns wide in `remixFeatures.ts`
and re-derived at that width in `remixCost.ts`; variable meter makes it ragged.
That is a reshape of the matrices the DP indexes, in the same release that
already reshaped the DP itself with the required-joins subset axis — two
structural changes to one DP is how a golden corpus stops meaning anything. It
is recorded as open work, with these numbers, rather than attempted at the end
of a release. `ibiCv` in the analysis carries real information about drift and
remains the only automatic signal the user gets.

Related, and unchanged: the achieved length is **bar-quantised** — a target is
met to within one bar, measured at **+7.2 %** on accelerating material — and the
cost function models nothing about lyrics, so a join can score 0.05 and still cut
a vocal mid-syllable. Chroma is also key-blind but not transposition-aware, so a
final-chorus key change reads as harmonically distant and the planner avoids
precisely the join a producer would make.

**3c. Align Vocal Timing will not find your syllables for you, and says so.**
Its onset detector was measured against 23 hand-marked note attacks in an 8 s
excerpt of a real 142 s solo cover vocal. At the parameters tempo detection
ships with, **44 % of the onsets it reports are not note attacks** — they are
breaths, note *endings*, portamento slides and vibrato peaks (best F1 0.65 at a
±50 ms tolerance; precision 0.56, recall 0.78, median localisation error
36 ms). Retuning for voice — no decimation, a 5.3 ms hop instead of 21 ms —
lifts that to precision 0.88, recall 0.65 and 12 ms median error, and that is
what `Suggest syllable markers` uses; at the ±30 ms tolerance timing work
actually needs, the best of the three parameterisations still only reaches
F1 0.57. Each of those "best" thresholds was also chosen on the same 8 s it was
scored on, so they are optimistic in-sample figures.

Spectral flux is built for transients and a legato vowel has none; this is a
property of the signal, not a tuning bug. So the feature does **not** warp
detected onsets. It warps **markers** — which you placed, or kept after looking
at what the detector proposed — and the suggestion step deliberately produces
ordinary, editable markers rather than anchors. A false anchor is not a missed
opportunity: it drags a syllable-sized span of audio onto a beat it never
belonged on, manufacturing a timing error where there was none.

**3d. Align Vocal Timing cannot pick the grid, and a wrong one is worse than
none.** Tempo detection on real material put a track's drums at 159.83 BPM and
its five other sources at a mean of 109.4 — a genuine ~3:2 feel, with every
confidence between 0.003 and 0.084 against the app's own `CONFIDENCE_LOW` of
0.35. Both grids are musically defensible, so an automatic pick would be a coin
flip that makes every correction ⅔ or 1.5× wrong. The **subdivision** matters
just as much: the same 23 attacks sit a median of 120 ms from the nearest
quarter note, 63 ms from the nearest eighth and 25 ms from the nearest
sixteenth. That take is on sixteenths with ~31 ms rms of human micro-timing;
snapping it to quarters would move syllables by up to 260 ms and destroy it.
Apply is therefore gated on an explicit confirmation, and the tool labels each
subdivision with the median move it implies so the choice is made from the
measurement rather than from the label.

**3e. The local stretch is bounded, and a bounded move lands short.** Local
ratio is clamped to 0.88–1.14× — the range this WSOLA is transparent over
(section 3's quality bands), not the engine's 0.25–4× limits, because the spans
being stretched are sung vowels. A correction that would need more than that is
applied as far as the bound allows and the anchor lands short of the grid; the
tool names how many moves that will affect before you apply. Adding more
markers spreads each move over a longer span and is usually the fix. Strength
defaults to 25 % for the same reason: at 100 % on the measured take, 41–55 % of
the inter-syllable spans would need a ratio outside the transparent band, so a
full-strength default would spend half its time clamped. Finally, the region's
**duration is pinned** — alignment moves syllables within a region, never
changes its length — so a syllable close to the region edge has little room to
absorb its move and is the most likely to be held back.

**4. In strict phrase mode the set of reachable lengths is COARSE.** Every run
must be at least Φ = 8 bars long and every join must be phrase-congruent, so a
source of `M` bars can only reach a sparse ladder of lengths — on a 31-bar
source at 120 BPM 4/4 the shortest arrangement carrying a join renders at 24
bars (48 s), and anything shorter is refused as `too-short` rather than
approximated. This is why the Auto-Remix tool clamps its length control to
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
reliably self-assess must not gate. **3a shipped in v1.23.0** and is complete;
what it deliberately did NOT do is 3b, which stays open with the numbers above
and needs two things this release could not responsibly add: a surface for the
user to declare where the meter changes (there is no meter detector, and an
unconfirmed one may not drive it), and a ragged per-bar descriptor matrix — a
reshape of the matrices the remix DP indexes, in the same release that already
reshaped the DP with the required-joins subset axis. A 12-rotation
transposition-aware chroma comparison would fix the key-change case at 12× the
cost of the chroma term; not included, and recorded here rather than left to be
discovered as a bug.

## Stem bleed is model-bounded; the exact sum is guaranteed but conditional

**Area:** Separate into Stems (`electron/stemHost.cjs`,
`electron/stemManager.cjs`, `src/dsp/stemPartition.ts`,
`src/services/stemService.ts`, `src/services/stemLanding.ts`,
`src/components/Dialogs/SeparateDialog.tsx`)

**v1.7 behavior:** The two halves of "isolate every instrument without losing
any sound" are different kinds of promise, and Auditorium keeps them
differently. Both are stated in the tool itself, in every state, before you
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
`exactSumHolds`, and the tool stays open on an amber note naming the peak
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

## A cover sits on an instrumental that still contains the original singer

**Area:** Cover Chain (`src/services/coverChain.ts` — `COVER_CHAIN_RESIDUAL_SENTENCE`
and the `RESIDUAL_*` constants), Separate into Stems
(`src/services/stemService.ts`), `src/components/Dialogs/CoverChainDialog.tsx`

**This is the headline limitation of the Cover Chain, and it is stated in the tool before
you run it rather than here alone.**

v1.7's separation guarantee is **exact sum** — the five stems add back to the mix sample for
sample, measured bit-exact and re-confirmed at 1.4e−14 on this song. It is not, and never was,
perceptual cleanliness. So the instrumental you get by muting the Vocals track still contains
the original singer.

How much was measured against a ground truth a user will not have: the official instrumental
release of the same song is a separate master, so `mix − g·instrumental` **is** the original
vocal, sample for sample, and `bed − g·instrumental` is exactly what separation left behind.
Over the 132 vocal-active usable seconds of a real song:

| | |
|---|---|
| The residual, below the bed | **−17.95 dB** |
| The residual, below the original vocal | **−11.28 dB** |
| Worst usable second (t = 146 s) | **−8.9 dB** |
| Measurement floor | −39.7 dB |

It is the **singer**, not damage to the band: the same measure on instrumental-only seconds
reads −39.69 dB, so 21.7 dB more error appears the moment the singer sings. And it sits
exactly where it hurts — per octave, over vocal-active frames, it is 11.49 dB below the music
at 250–500 Hz, **9.52 dB** at 500 Hz–1 kHz, 11.79 dB at 1–2 kHz and 11.45 dB at 2–4 kHz. That
is the band a lead vocal occupies, the band the ear is most sensitive in, and the band your
own cover will compete for. A 10 dB margin is not masking.

**In practice:** you will hear a ghost of the original singer under your cover, most audibly
in sparse passages.

**A second separation pass over the instrumental does not help, and that was measured.** It is
the first thing anyone suggests — a user did, in a real Cover Chain run: "maybe do a more
targeted second pass on what's left". Four real model passes were run to answer it
(`scripts/stem-second-pass-probe.cjs`; verdict `docs/bench/stem-second-pass-rejected.json`),
over a mix constructed so the bed is known to the sample: a real vocal-free master, plus a
real singing recording, summed. The residual is then `instrumental − bed` exactly — no
alignment, no estimate — and it is read by the same `longTermAverageSpectrum` /
`bandLevelDb` the figures above name.

| Measured over a 28 s window, 250 Hz–4 kHz | |
|---|---|
| The residual after pass 1, below the bed | **−17.29 dB** — the −17.95 dB above, re-measured by a different route (same song, a different 28 s window, a constructed mix) |
| The residual after pass 2, below the bed | **−17.29 dB** |
| **What the second pass removed** | **0.00 dB** (worst octave 0.04 dB) |
| The second pass's own Vocals output, below the instrumental | −43.04 dB in band (−58.37 below 250 Hz, −45.17 above 4 kHz) |
| Vocal-free music through the same pass | unchanged: 0.00 dB in band, what it removed 88.83 dB down |
| Exact sum, all four passes | 0 ULP, 100 % bit-exact |

The decision gate was written down before the measurement: build the pass if it took ≥ 3 dB
off the residual AND left vocal-free music within 1 dB. It passed the second test and failed
the first by the whole margin. The reason is not that the pass needs better targeting: what
survives pass 1 is precisely the energy this model's mask already assigned to the music, so
the same model asked the same question a second time returns the same answer. The only
quantity that moves at all is the instrumental's *ungated* broadband level, +1.78 dB — every
gated band level, which is what the figures above measure, is unchanged to 0.00 dB. Whatever
the second pass emits, it is not in the frames the app calls sounding, and it is not a
reduction of anything. **So there is no second-pass feature, and this is why** — the cost
would have been another ~20 s of inference per 30 s of audio and ~5 GB of RSS for a change
of zero.

**The figure is documentation, not a per-song estimate**, and that is deliberate. Three
run-time estimators were built and all three were measured wrong. Complex-STFT coherence
between the bed and the vocal stem is degenerate by construction for this separator (both
outputs are real masks over the *same* mix spectrum, so they share phase in every bin and
coherence is 1 regardless of leakage). A per-band least-squares projection of the bed onto
the vocal failed its own null test, claiming 84 % of the bed's bass was leaked vocal on
seconds containing no vocal at all. A mask-only proxy agreed to 0.5 dB computed per frame per
bin and was out by 11 dB computed from frame-summed energies — one agreement in one
formulation on one song is not validation. A number wearing the authority of a measurement it
has not earned is worse than a stated fact.

## The Cover Chain matches tone and level. It does not match dynamics, and it will usually refuse to match reverb

**Area:** Cover Chain (`src/services/coverChain.ts` — `SPREAD_GATE_SWEEP`,
`deriveMatchReverb`), the measures behind it (`src/dsp/coverMatch.ts` —
`activeEnvelopeSpread`, `estimateDecay`, `reverbRt60Seconds`),
`src/effects/time/ReverbEffect.ts`

**There is no matched compressor, on purpose.** The active-envelope spread (F7's measure: the
p90 − p10 of the compressor's own detector while the material is sounding) reads 13.62 dB on
the reference take and 12.74 dB on the separated original vocal — a required move of
**−0.88 dB**, which is smaller than the measurement's own reference error. Sweeping the
analysis gate shows why no other answer is available either:

| gate | 15 dB | 20 dB | 25 dB | 30 dB | 40 dB |
|---|---|---|---|---|---|
| move the match would ask for | **+0.43** | −0.88 | −3.55 | −9.71 | −6.71 |
| the same from ground truth | +0.83 | −0.44 | −2.13 | −5.50 | **+2.90** |
| reference vs ground-truth disagreement | 0.40 | 0.44 | 1.41 | 4.21 | **9.61** |

The answer **changes sign** between 15 and 20 dB, and the ground truth changes sign again at
40. Where the reference is trustworthy (gate ≤ 20 dB, disagreement < 0.5 dB) the move is under
1 dB — i.e. nothing. Where a substantial move appears (gate ≥ 30 dB) the reference has stopped
agreeing with the ground truth by 4 to 10 dB, because the gate has reached into the take's room
noise and the separator's near-silence. A quantity whose sign depends on an analysis parameter
is not a measurement. The spread is **reported**, before and after; nothing is derived from it.

**Match Reverb ships as a stage that usually declines.** The estimator itself is sound —
ISO 3382-1's T20 fit, validated against the app's own Freeverb at 1.26 s where the closed form
says 1.45 s (−13 %) and 2.92 s where it says 3.20 s (−9 %), and reading 0.28 s on a dry take.
The problem is the effect: `ReverbEffect` is Freeverb with `combFeedback = 0.7 + 0.28 · roomSize`
and a longest comb of 1617 samples at 44.1 kHz, so at `roomSize = 0` — its own minimum — **the
shortest reverb the app can produce is 0.710 s**. The reference song's original vocal measures
0.40 s. There is no setting of this effect that matches it, and the closest offer would add
roughly twice the decay that is there. The stage compares the two numbers and says so, which
also means it *will* engage on a song whose vocal carries a decay longer than 0.710 s.

**What "will engage" is and is not.** That the comparison fires is pinned — against the
effect's own closed-form decay law and against synthetic decays, and, since v1.22.0, in the
packaged app against a generated reverberant reference. What has never been tested is the
engage path on **real reverberant material**: every vocal this feature was measured on was dry
(0.28 s on the take, 0.40 s on the separated original), so no real recording has ever driven
this stage to derive a room size. Combined with the linearity blind spot below, that means a
take with a long non-reverberant fall — a slow fade, a sustained note dying away — can engage
the stage, and the room size it then derives is derived from a fall that is not a room.

Two further limits on the estimate, stated rather than corrected. It reads 9–13 % **short** of
the closed form on the app's own reverb, so a matched room size errs slightly dry. And its
linearity check cannot tell a curved fall from a real decay: a pure amplitude ramp — falling
linearly in amplitude, strongly bent in dB, containing no reverberation whatever — scores a
minimum r² of 0.910, *higher* than either validated reverb control (0.883 and 0.859). What the
check removes is **ragged** fits, not curved ones. A decay this estimator reports is evidence of
a fall, not proof of a room.

## The cover journey's alignment is a placement, not a warp — and its confidence was measured on constructed audio

<!-- CP1 -->
**Area:** the alignment (`src/dsp/coverAlign.ts`), its ground truth
(`src/dsp/__fixtures__/coverAlignFixtures.ts`), the stage that consumes it
(`src/services/coverJourney.ts`)

**One offset moves the whole take.** The stage cross-correlates the two onset envelopes and
places the take at the single lag that best matches. Nothing is stretched and no syllable is
moved, so a take that **drifts** against the record — starts together and ends a beat late —
is placed at whatever offset best fits it *on average* and still drifts. That is not a defect
to be fixed here: warping needs a confirmed beat grid (Align Vocal Timing) or a chosen word
(Align Lyrics), and both refuse to guess for the reason each states. The journey lists them as
refinements to run afterwards.

CC2 put a number on "still drifts" rather than leaving it as a shrug. The overlap is cut into
windows that are aligned **independently**, and the slope of the line through their lags is the
drift. Below **0.057 s of slide across the overlap** the take is still placed and the drift is
reported alongside it; above that one rigid lag has stopped being an answer and the placement
becomes a `weak` guess with the drift named. Measured: a take running 0.5 % slow over 20 s
slides 0.084–0.101 s and lands in that arm. The regime this arm cannot resolve is stated below.

**The thresholds are measured, and what they were measured ON is constructed audio.** The sweep
in `coverAlign.test.ts` builds twenty-four cover pairs — one syllable schedule rendered twice,
the second at pitches scaled 1.26× with ±50 % dynamics jitter and noise, 44.1 kHz against
48 kHz — of which eight also carry **±40 ms of per-syllable human timing variance**, against an
unrelated population of twenty-eight pairs: sixteen from unrelated schedules, four whose
reference is a **leakage stem** (the song's accompaniment 40 dB down under a noise floor), and
eight that are **room tone**, taking each side in turn.

| | prominence | peak correlation |
|---|---|---|
| covers (incl. ±40 ms human timing) | 0.217 – 0.537 | 0.8085 – 0.9326 |
| unrelated (incl. leakage, room tone) | 0.0001 – 0.2491 | 0.3776 – 0.6538 |
| a song whose section repeats | 0.0011 – 0.0139 | 0.8763 – 0.8991 |
| two metronomes at one tempo | 0.0132 – 0.0241 | 0.9539 – 0.9577 |
| **shipped floor** | **0.12** | **0.731** (guess floor **0.692**) |

Read that table carefully, because the two columns no longer answer the same question. **Peak
correlation is what separates a cover from unrelated audio** — floor 0.731, the middle of a
measured gap it clears by 0.077 on both sides. **Prominence no longer can**, and the table says
why: against the enlarged unrelated population it does not merely fail to separate, it
*inverts*, the best unrelated pair reaching 0.2491 against the worst cover's 0.217. What
prominence separates cleanly is a different question — "does ONE lag stand out, or several?" —
and its floor of 0.12 is derived against the last two rows, where a genuine partial match one
section (or one beat) away collapses it while the peak stays high. Those rows are answered
`ambiguous`, with the guard-separated candidate lags carried for the user to choose from, and
are never applied automatically.

Between 0.692 and 0.731 sits a **gap zone**: above every unrelated pair the sweep can build,
below acceptance. A take landing there is offered as a `weak` guess when nothing contradicts it,
and called unrelated only when the independently-aligned windows ran and disagreed.

Every floor is a point inside a measured gap and the test fails if a gap ever stops containing
its floor by the stated margin. What no ground truth is available for is a **real** cover
against a **real** separated vocal: nobody knows the true offset of a recording made in a room,
and the negative case — a take that is not the same song — cannot be constructed from a fixture
pair that is related by construction. The leakage and room-tone members model the two failures
this repo has actually measured, but they are models: real separator artifacts have spectral
character no fixture here reproduces. So the numbers above describe how the measure behaves on
audio built to exercise it, not a false-accept rate on real material. The refusal arm is what
that uncertainty is spent on: the take goes to the start of the original and the numbers are
stated, because a take placed at a confidently wrong offset is harder to notice than one left
at zero.

**The evidence was rebuilt once already, because it refused a real cover.** The floors before
CC2 were 0.186 prominence / 0.607 correlation, calibrated on cover pairs whose take shared the
reference's onsets *to the sample*. A human being does not: at ±40 ms of per-syllable variance
the peak fell to 0.434–0.569 and the run was refused **while the recovered offset was still
correct to 29 ms**. That was not a threshold in the wrong place — 0.423, the figure a real user
was refused at, sat inside the old unrelated population's own range, so no floor could have
separated them. Both coarse envelopes are now low-passed (240 ms, swept) so onset lobes span
human timing, which is why the floors above are higher and the populations wider.

**Accuracy, and where it stops.** Known offsets are recovered to within **10 ms** in both
signs, at equal sample rates and across 44.1/48 kHz, mono and stereo. On the harsher sweep —
where the two recordings are genuinely different performances, eight of them sung with ±40 ms
of human timing variance — the residual is up to **28.9 ms**, and that is disagreement between
two performances about where a syllable starts rather than error in the measurement. Note it is
*below* the 40 ms of variance that produced it: the aligner averages the jitter out rather than
following any one syllable. The fine pass runs on **unsmoothed** envelopes and may only refine
the coarse answer inside ±0.2 s; it can never find a different verse.

**A drift too small to name still costs you milliseconds.** The piecewise arm's slope is fitted
through three to twelve windows, and on a short take the noise on that fit is comparable to a
real, mild drift: measured, a take running 0.2 % slow over 20 s produces a slope inside the
no-drift control's own band, so it is **reported and not gated** — and its placement error is a
real **15–30 ms**. The number is on the measurement (`driftSecondsPerMinute`) precisely so a
caller quoting the ±10 ms above can quote the drift beside it. A longer recording measures its
own drift better; twenty seconds is where this arm is weakest.

**That accuracy is measured at one GAIN, and a quiet take degrades it.** The onset envelope is
spectral flux, and flux falls with level while the analysis floor does not, so a take recorded
far below full scale carries a weaker envelope for the same performance. Measured on the same
ground-truth pair, scaling the take only:

| take gain | offset error | prominence |
|---|---|---|
| 1.0 (unity) | 8.4 ms | 0.474 |
| −40 dB | 10.9 ms | — |
| −70 dB | 21.6 ms | 0.379 |

At −40 dB the error has already passed the 10 ms the rest of this feature claims, and at −70 dB
it is more than double it. **The alignment is still believed at all three** — the confidence
floors are cleared throughout, so nothing warns you — which is exactly why it is written down
here: a very quiet take gets a placement that is silently a frame or two out, not a refusal. The
−40 dB case is pinned by a test so the boundary is a known property rather than something a user
discovers. If your take is that quiet, normalise or amplify it before running the journey (the
Vocal Chain at stage 2 does raise the level, but the alignment at stage 3 measures what stage 2
left, so a take that started at −70 dB has already been through the chain by then and the residue
is what it is).

## The cover journey leaves two undo entries, not one

<!-- CP1 -->
**Area:** `src/services/coverJourney.ts`, `src/services/editOps.ts`,
`src/multitrack/sessionUndo.ts`

A journey run leaves **"Vocal Chain"** and **"Cover Chain"** on the take, in that order, and
the report lists them. It does not leave one entry that undoes the whole pass, and that is a
decision rather than an oversight.

An undo entry in this app belongs to **one document**. A single journey entry would have to span
two documents (the take, plus the five stem documents and the instrumental the pass created) and
a session replacement whose own history is deliberately cleared, load-shaped, exactly as Open
Session and stem landing clear theirs. Making that one entry is a change to the undo data model
in both `editOps` and `sessionUndo` — a joint scope neither has — and it is not a change worth
making behind a cover feature. It is recorded here as future work.

What this means in practice: undoing twice returns your take to what it was before the journey
touched it. It does not remove the stem documents, the instrumental, or the session — those are
creations rather than edits, and closing them is how they go away.

## The match curve is realised in band energy, and the Graphic EQ cannot always reach it

**Area:** the cascade solve (`src/dsp/graphicEqCascade.ts` — `realisedBandEnergyDb`,
`solveCascadeGains`, `GRAPHIC_EQ_MAX_ABS_DB`), the curve
(`src/dsp/coverMatch.ts` — `matchCurve`, `MATCH_MIN_CENTRE_HZ`, `MATCH_BOUND_DB`),
`src/services/coverChain.ts` `deriveMatchEq`, `src/effects/eq/GraphicEqEffect.ts`

The Cover Chain's match curve is a difference of octave-band **energies**, and the Graphic EQ
that realises it is a cascade of overlapping peaking filters at Q = 1.4. Two consequences, both
measured, both surfaced rather than hidden:

- **The gain a band is given is not the response it produces.** A lone +6 dB band leaks 1.15 dB
  into each neighbour an octave away, and on an alternating ±3 dB curve the response at the
  centres is off by up to 1.0 dB — comparable to the entire correction on this material.
- **A peaking filter delivers its full gain only at its centre**, so a cascade whose centre
  response equals the curve moves each band's *energy* by measurably less. Measured end to end:
  matching the centres closed 70 % of the spectral distance to the original vocal
  (1.94 → 0.58 dB); matching the band energies closed **82 %** (1.94 → 0.34 dB).
- **How much energy a filter takes out of an octave depends on where inside that octave the
  signal's energy sits**, so the band average has to be weighted by the take's own spectrum.
  Averaging the filter's response over the octave's bins *unweighted* — which is the same as
  assuming every recording is flat across every octave — misreported what the audio received by
  up to **0.94 dB** on a real 30 s vocal while the chain printed "within 0.008 dB of the
  target". The weighted figure tracks the delivered value to 0.04 dB. Fixed in v1.22.0 before
  release; recorded here because it is the shape of mistake this section exists to prevent.

The chain therefore solves for the band gains whose *band-energy* response, **in this take's own
spectrum**, equals the requested curve, and reports the realised figure beside the requested one
for every band, including the bands outside the matched range — which receive no gain of their
own and still show the leak from their neighbours.

**It does not always reach the target, and says so.** A band-energy move near the ±10.9 dB
bound is not reachable at all: measured at 48 kHz, a lone band pushed to the +12 dB rail moves
its octave's energy by only +9.73 dB at 500 Hz falling to +9.17 dB at 8 kHz, and by −8.91 to
−7.94 dB at the −12 dB rail. So above roughly ±9 dB it is the **effect's** clamp that acts and
not the derived ±10.9 dB bound, and the top of that bound cannot be delivered. When that
happens the realised column
shows what was actually delivered, the summary line reads "up to X dB SHORT of the target", and
a sentence names EVERY band that fell short with both of its numbers — not just the worst one, or
the others would be shown in the table and absent from the line that exists to make a shortfall
impossible to miss. What is never shown is the requested curve dressed
up as an outcome.

## The beat grid shows only what was measured; snapping targets edges, beats and markers, by rank

**Area:** Beat grid (`src/services/beatGrid.ts`,
`src/components/Editor/waveformRender.ts`,
`src/components/Editor/useBeatGridOverlay.ts`,
`src/components/Multitrack/clipBeatTics.ts`), snapping (`src/services/snap.ts`,
`src/components/Editor/editorSnapTargets.ts`,
`src/components/Multitrack/sessionSnapTargets.ts`)

**v1.8 behavior, items 4–5 updated for v1.9, item 4 resolved since:** Five
limits, each a consequence of drawing only what the analysis actually produced
— except items 4 and 5, which later releases resolved and which are kept here
as the record of what remains of them.

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
`level:'remix'` analysis, which only the Auto-Remix tool produces. Every other
path — the Properties panel, `Pipeline → Detect Tempo`, the test hook — produces a
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
past it. Separately, the tempo cache holds `MAX_ENTRIES = 4` and evicts the
**least-recently-WRITTEN** row — analysing a document moves its row to the front
(the write is a delete+set re-insertion), but **reading a grid does not protect
it**, so a grid on screen can disappear when a fifth document is analysed, with
no error anywhere. Promoting a row on read was considered and rejected: it would
make a repaint reorder eviction, trading this surprise for a worse one. What
keeps the workflow this feature exists for inside four rows is inheritance —
a source plus its five stems occupy one row, not six.

**4. RESOLVED — clip edges are snap targets now, and the set is ranked.**
The exclusion this item recorded ("snapping targets beats, bar lines, markers
and the playhead — not clip edges") ended exactly as its last sentence
predicted: once v1.9 settled the boundary's meaning, edge targets could be
defined without ambiguity, and they landed. Every *other* clip's start and end
— cross-track and same-track — now pulls a dragged clip's head and tail, so a
butt join is a drag instead of a Ctrl-nudge, and because a crossfade arms only
on a *strict* overlap, the snapped join (end == start) arms nothing: edge
snapping prevents the accidental micro-overlap crossfades the old exclusion
feared. What remains of the item: the target set is now RANKED, not flat —
edges and the session cursor outrank markers outrank beats, resolving
nearest-first within the highest rank that has a candidate — so a beat one
pixel nearer no longer silently robs an aimed-for edge. A group drag excludes
every co-moving member's contribution (their captured positions are stale by
the drag's own delta). Bar lines still add nothing to the target set even when
they exist, and that is arithmetic rather than an omission: every bar line
already *is* one of the beats. The editor's own set is still beats plus
markers, flat; the multitrack ruler's seek and envelope keys snap against the
flat union of the session set (a seeked cursor aims no clip edge, and its own
old position as a dominant target would pin it in place). Split at Cursor is a
point CONSUMER of the cursor rather than a gesture of its own, and so never
re-snaps it: in the multitrack the session cursor is itself a tier-0 target, so
a re-snap would be a guaranteed no-op, and in the editors the set has no cursor
target at all, so a re-snap could only move the cut off the line the user is
looking at.

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
without a cached analysis. 4 is delivered — the sequencing it promised ran its
course, and the record above describes the shipped ranked target set. 5 is the
pinned preview/commit contract: divergence exists only under the Ctrl opt-out,
never on a default drop.

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

## The Noise Gate's decisions rest on constructed populations — and what changed when a real recording fell outside them

<!-- V2 / G2 -->
**Area:** the Vocal Chain's Noise Gate stage (`deriveGate` in
`src/services/vocalChain.ts`), the activity segmentation behind it
(`windowedTiltResidualsDb` in `src/dsp/chainAnalysis.ts`), and every constant
either of them consults: `GATE_HEADROOM_DB`, `GATE_VOICED_FRACTION`,
`GATE_SHAPED_RESIDUAL_DB`, `GATE_CANCELLATION_DEPTH_DB`,
`NOISE_WINDOW_MAX_SILENT_FRACTION`, `GATE_MIN_REGION_MS`.

**Every one of those constants is placed between two measured populations, and
every member of every population is audio this repository generated.** Gaussian
and uniform floors, one-pole tilts at 400/800/2500 Hz, whispers modelled as
noise through three resonators, sibilants as one resonator, sung tones as a
fundamental with two harmonics and vibrato. They are honest models and the gaps
they leave are wide — the vocal-tract check separates 0.63–1.91 dB of floor from
3.20–10.58 dB of unvoiced voice — but a gap between two synthetic populations is
evidence about the synthesis, not a promise about a microphone.

**A real recording landed outside them twice, and the strategy changed because
of it.** Reported 2026-08-14: a 2 min 22 s sung take whose quietest 500 ms
measured **4.0 dB** of departure from a straight spectral tilt, against the
2.5 dB the check calls voice. The take declined twice — once on that single
window, once after a widened search ran out of candidates — and the user's
report stood: "the noise in the non-singing parts was not removed". The user
then named the correct inversion themselves: *"the vocals are well identified…
so why can't we mute where there is no lyrics?"* Since G2 the automatic gate
does exactly that: it derives **no level at all** and instead mutes the
stretches between vocal activity — word spans from a fresh lyrics alignment or
transcript when one exists, plus every half-second measuring as a vocal tract
— with each stretch still vetoed by the voiced and vocal-tract checks before
it is muted. The decline family that came from "cannot measure a trustworthy
level floor" is gone: a pause is found by WHERE it is, not by being the
quietest thing in the take, and the reported twelve-breath shape now gates at
any breath count.

**What the redesign could NOT close, measured on that same take.** The 2.5 dB
vocal-tract boundary is still an absolute constant, and the reported room
defeats it wall to wall: every one of the take's 2833 half-second windows
reads over it — 3.01 dB at the very quietest, 3.0–3.9 dB across its audible
pauses, 4.8–10.2 dB across its vocal content — raw and after Noise Reduction
alike. The room's own machinery IS a resonant source, so the take reads as
vocal activity end to end and the stage declines (the message now names the
shaped-room reading explicitly). A take-relative boundary was measured and
rejected rather than guessed: over stationary shaped-room models (fan, HVAC,
machinery, boom at three rates, three seeds) a room's windows spread only
0.14–0.77 dB above their own minimum, but a whisper ON such a room stands
0.00–2.19 dB above it — the zero being a whisper whose formants the room's
stronger resonances bury — so the two populations overlap outright and no
relative constant exists either. On this room, the manual threshold is the
tool, and the measured numbers for that take: −50 dBFS gates 41.1 s of its
142 s, −55 dBFS gates 22.1 s, −58 dBFS gates 9.5 s.

**What the redesign does NOT close, stated plainly:**

- **Vocal material quieter than the noise around it is invisible to
  measurement.** With word evidence it is protected by its span; without, a
  take whose singing sits under the pause noise DECLINES (nothing is muted on
  ignorance), and sub-floor material *inside* a muted stretch — a whisper
  10 dB under the room tone — is muted with the floor, exactly as a level
  gate always muted it. Run **Pipeline → Align Lyrics** first when a take has
  passages like that; the word spans are the only evidence that can vouch for
  them.
- **A resonant non-vocal noise reads as a voice and is kept.** Measured: a
  120 ms chair-creak burst (a 180 Hz resonance) inside a 500 ms floor window
  reads **4.06 dB** of vocal-tract shape — inside the whisper population's own
  3.20–10.58 dB range — so no boundary exists that mutes the creak and keeps
  the whisper, even where word evidence says nothing was sung there. The veto
  is kept in both paths: a creak survives as a short island while the floor
  around it is muted, and the report's Kept row counts it. An isolated soft
  tick averaged over a longer window stays under the boundary and mutes with
  the floor.
- **Unshaped broadband hiss at a steady level is still a floor** to every
  statistic here (the pre-G2 limitation, unchanged): a breath recorded so far
  off-mic that the room shaped it has no pitch, no resonances, no syllabic
  movement, and a stretch of it between phrases will be muted. If that is your
  recording, switch the stage off or use the manual threshold.

**The manual escape is unchanged.** The **Gate at a level I set instead** box
is the level gate of earlier releases, byte for byte — same hold, same fades,
same digital-silence rules — and every refusal of the automatic path still
ends by pointing at it. Silence stays reachable whether or not the populations
describe your room.

**How the remaining gaps would be closed.** Only by measuring real rooms and
real singers: noise floors recorded in ordinary domestic and project spaces
against real whispers and breaths, and a population of real non-vocal
transients (chairs, pedals, thumps) against both. Until that exists, these
constants are calibrated to models, and this entry says so.

## The Vocal Chain evens out the envelope; it does not lower the peak-to-RMS ratio

**Area:** Vocal Chain (`src/services/vocalChain.ts`), compressor and limiter stages.

**Behavior a user will notice:** the chain's own before/after table reports the
**crest factor going UP**, not down. On the reference vocal it reads 18.08 dB
before and 22.24 dB after. That looks like the opposite of "evened out", and if
you read crest factor as "how consistent is this take", you will read it
backwards.

**Why it happens, measured:** the compressor's shipped 10 ms attack does not
catch a transient shorter than 10 ms, while the makeup gain derived to restore
the level lifts that transient along with everything else. On the reference take
the compressor stage holds programme RMS at −27.87 dBFS and moves the peak from
−9.81 to −6.32 dBFS — very nearly the whole +3.6 dB of makeup. What the stage
*does* even out is the envelope between roughly −27 and −18 dBFS, by up to 6.5 dB;
peak-to-RMS is simply not the number that shows it.

The limiter would catch those transients, but only if they reached its ceiling.
On this take the output peaks at −5.69 dBFS against a −0.3 dBFS ceiling, so the
limiter honestly reports leaving every sample unchanged. On a hotter recording it
engages and the crest factor stops rising.

**What it is not:** it is not distortion, and it is not a stage misbehaving —
every stage did exactly what it was derived to do. Fixing the number would mean
either shortening a compressor attack default that was chosen and reviewed on its
own merits, or having the chain choose a delivery loudness, which is a mastering
decision no measurement of a recording can make. Both were rejected as out of
scope for a feature whose job is to compose already-reviewed effects.

**If you want the peaks under control:** run Normalize or the Limiter on its own
afterwards, with a ceiling you choose.

## The Vocal Chain's de-esser only touches the harshest sibilants

**Area:** Vocal Chain de-esser stage; the underlying threshold derivation is F8's.

**Behavior a user will notice:** on the reference vocal the chain leaves
**97.7 % of samples bit-identical** through the de-esser stage, and whole-file
energy above 5.5 kHz moves only −48.44 → −48.63 dBFS. "The chain de-essed it" is
a weaker claim than it sounds.

**Why it is built this way:** the threshold is derived to reproduce the de-esser's
own measured operating point (programme RMS − 2.2 dB), which sits *above* the
median sibilant on purpose — the effect exists to remove harshness, not to remove
every "s". Its own task measured −0.36 dB mean over sibilant frames at that
setting, with a −4.26 dB worst frame. The chain reproduces that faithfully rather
than pushing it harder, because a de-esser dialled in harder than its reviewed
operating point, inside a pass where nobody is listening, is exactly the wrong
place to be aggressive.

**If you want more:** open the De-esser on its own, use its Listen switch to hear
what is being removed, and lower the threshold until it is removing what you want.

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
the edit. A clean play (and every mixdown) is value-exact: every baked
sample equals what `mixdownSession` computes. For a long time "exact"
stopped there, and said nothing about WHEN each track's samples were
scheduled — until the shared scheduling epoch, each track's sources were
anchored to their own `ctx.currentTime` reading, taken after that track's
synchronous buffer bakes, so on a warm context a clean play could start one
track tens of milliseconds early against its siblings while every sample
value was still right. `play()` now builds every track first, reads the
clock once, and schedules all sources against that single epoch (plus
`SCHEDULE_LEAD`, on a running clock only, in `MultitrackPlayer.ts`), so a
clean play is value-exact AND placement-exact: track-to-track timing
derives from clip positions alone.

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

## Speaker separation is reliable for one or two voices, not three

**Area:** F4 transcription (`electron/transcribeHost.cjs`,
`electron/transcribeManager.cjs`, `src/dsp/speakerClustering.ts`,
`src/services/transcribeService.ts`,
`src/components/Panels/TranscriptPanel.tsx`).

**Behavior a user will notice:** `Pipeline → Transcribe` labels every segment
with a speaker, and on two-voice material it is right. With three or more
voices it is not, and it will still hand you a confident-looking answer with
the wrong number of speakers in it. It also has no idea when two people talk
at once: a segment containing two voices gets one label, silently.

**The measurement.** Ground truth by construction — every chunk cut from a
single-speaker recording, so its true speaker is whichever file it came from;
2 s chunks, CAM++ embeddings, the shipped clustering. Ten cases:

| Case | Result |
|---|---|
| 5 single-speaker sets | 5/5 returned **1 speaker** |
| 4 two-speaker sets | 4/4 returned **2 speakers**, **100 %** of segments correct |
| 1 three-speaker set | returned 2, **45 %** of segments correct — **73 %** even when told there were three |

Two things follow. First, **the speaker count is a control, not a readout**:
the Transcript panel lets you set it, and the grouping is recomputed from the
stored voice embeddings instantly, with no second transcription run. Second,
**100 % on two speakers is an upper bound, not a field expectation** — that
material was concatenated single-speaker recordings, so it had clean cuts, no
crosstalk, no overlapping speech, and different channel conditions per
speaker, all of which make the job easier than a real conversation.

**Why it is built this way:** the failure is in the count selection *and* in
the clustering, so neither half can be patched alone — forcing k = 3 still
only reached 73 %, which means CAM++ embeddings over 2 s chunks are simply not
cleanly separable for that trio. Frame-level diarization with overlap
detection is a different model class (pyannote's segmentation models), and
those are HuggingFace-gated, which the on-demand-download design rules out.
The obvious cheap fix was measured and rejected: thresholding the silhouette
score cannot separate "one speaker" from "two" here — single-speaker sets
scored up to 0.379 and the weakest genuine two-speaker set also scored 0.379,
a zero-width gap. What does separate them is the average-linkage cosine
between the two clusters of the best 2-way split (single-speaker sets 0.554 to
0.890, multi-speaker sets 0.231 to 0.262), so `SAME_SPEAKER_COSINE = 0.40`
sits at the midpoint of that gap. Segments shorter than 0.5 s are not embedded
at all (below that an embedding is more noise than voice); they inherit a
label only when their neighbouring labelled segments agree, and are marked
**Unknown** otherwise rather than guessed.

## Transcription is speech recognition, and singing is not speech

**Area:** F4 transcription (`electron/whisperDecode.cjs`,
`electron/transcribeHost.cjs`).

**Behavior a user will notice:** transcribing a song gives you plausible
English that is not the lyrics. On clean solo singing the output is partly
right and partly invented. Over a backing band the model is confident enough
to be caught: those windows now come back **empty** rather than fabricated
(see the silence rule below). Clean singing is the case with no warning,
because there is no signal to warn from.

**The measurement.** whisper-base, 16 kHz mono, against a spoken control:

| Material | Realtime factor | Mean avgLogprob | Word error rate |
|---|---|---|---|
| Spoken control (`jfk.wav`, 11 s) | 9.02x | −0.297 | **0.0 %** |
| Sung, solo voice + light guitar (60 s) | 14.20x | −0.328 | **45.6 %** |
| Sung with a dance band (60 s) | 14.71x | −1.248 | unusable |

The clean-singing output recovers real phrases and then systematically
mangles function words, substitutes content words, and collapses into
repetition — 77 words emitted against 114 in the reference, with the third
verse replaced by a repeat of the second. The band recording produces fluent
sentences bearing no relation to the lyrics.

**Why there is no confidence warning for clean singing:** the model's own
confidence does not notice. avgLogprob was −0.328 on 45.6 %-WER singing versus
−0.297 on 0 %-WER speech — indistinguishable. Whisper's standard silence rule
(`noSpeechProb > 0.6` AND `avgLogprob < −1.0`, both required, as the host
implements) does not fire on it either: re-measured after the no-speech signal
was repaired, clean singing reports `noSpeechProb` **0.05 to 0.42** — real,
varying, and below the 0.6 threshold throughout. So there is no threshold that
separates "sung and wrong" from "spoken and right", and inventing one would be
worse than saying this plainly.

The band recording is different, and it is the one case the rule does catch:
both halves fire (avgLogprob −1.248, below −1.0, with a high no-speech
probability), so those windows are skipped and **nothing** is emitted. Measured
A/B on the same 60 s file: with the no-speech signal broken it produced **7
fabricated segments** ("One hundred and his name is A. I.", …); with it
repaired, **0**. Separating the vocal stem first
(`Pipeline → Separate into Stems`) is still what moves that material from
*discarded* to *usable* — but nothing rescues clean singing.

*(An earlier revision of this entry reported `noSpeechProb` as 0.000 on every
sung segment. That was measuring a defect, not singing: the probability was
read from the wrong decoder row AND the token was looked up under a spelling
this model does not use, so it read 0 for every input. Both are fixed; the WER
figures and the avgLogprob comparison above were never affected by it.)*

## A transcript lives only for the session

**Area:** F4 transcription (`src/services/transcribeService.ts`,
`src/components/Panels/TranscriptPanel.tsx`).

**Behavior a user will notice:** a transcript is held in memory for as long as
the document stays open. Closing the document discards it, and so does quitting
the app — reopening the file gives you the audio back but not the words, and
there is no prompt on the way out. On a two-hour interview that is a minute of
inference to redo.

**Why it is built this way:** the transcript is a *view* over the audio, not
part of it. Nothing in the app's file formats has anywhere to put it: WAV, MP3,
FLAC and OGG carry cue points but not timed text, and `.audm` sessions describe
clips and tracks rather than document-scoped analyses (tempo analyses and remix
plans are session-only for the same reason). Writing it into the marker list —
the one container that does persist — was rejected deliberately: markers are
points, they carry no speaker, and they are written into the cue chunks of
every file you export afterwards, so a transcript would silently follow your
audio into every deliverable.

**The workaround, and it is a real one:** export the transcript to SRT or
WebVTT from the panel before you close. That is a lossless record of exactly
what the panel shows — timestamps, speaker labels and text — in a format other
tools read. Re-importing it is not supported.


## The voice changer changes a voice; it does not clone one, and a near target barely moves

**Area:** F3 voice changer (`electron/voiceHost.cjs`, `electron/voiceChunking.cjs`,
`electron/voiceManager.cjs`, `src/services/voiceService.ts`,
`src/components/Dialogs/VoiceChangerDialog.tsx`).

**Behavior a user will notice:** `Pipeline → Voice Changer` produces audio that
sounds like a different person, but usually not *specifically and
unmistakably* the person in the reference clip. And when the reference already
sounds like the source, the output can be almost indistinguishable from the
input — which reads as "the feature did nothing" rather than as "these two
voices are close together".

**The measurement.** Nine conversions were run across two source recordings and
five real target voices spanning 1.3 octaves, scored with Resemblyzer's GE2E
d-vector — a speaker-verification encoder independent of OpenVoice, so the
model is not grading its own work. Calibrated on the same material, the
same-speaker band was 0.817–0.940 (mean 0.873) and the different-speaker band
0.391–0.845 (mean 0.628), putting the midpoint threshold at 0.750.

| Result | Value |
|---|---|
| Mean cosine to the **target** | **0.795** |
| Mean cosine to the **source** | 0.615 |
| Closer to the target than the source | **8 of 9** |
| Still verifying as the **source** (> 0.750) | **0 of 9** |
| Verifying positively as the **target** (> 0.750) | 5 of 9 |
| Share of the source→target pitch gap covered | 94 % |

So identity genuinely moves, and it moves toward the voice actually requested —
a full confusion matrix put each output nearest its own target in 8 of 9 cases,
and pitch-matched rival targets (0.2 and 1.7 semitones apart) still resolved
correctly, which rules out "it is only shifting pitch". But only 5 of 9 cleared
the positive same-speaker threshold. **The honest expectation is "clearly a
different person, recognisably in the target's direction", not
"indistinguishable from the target".**

**The near-target case, specifically.** The single conversion that landed closer
to the source than the target was `trump → dingzhen`: two low male voices
**1.7 semitones** apart, where the output's median f0 did not move at all
(0 % of the gap covered). The effect is proportional to the distance between
source and target, so this is inherent to the approach rather than a bug.

**Intelligibility is a real cost at large pitch moves.** Word error rate against
a transcript of the *unconverted* source, measured with this repo's own
Whisper-base:

| Conversion | WER | Conversion | WER |
|---|---:|---|---:|
| self-conversion (both sources) | **0.0 %** | source A → trump | 9.1 % |
| source A → azuma | 4.5 % | source A → dingzhen | 13.6 % |
| source A → s2p2 | 13.6 % | source B → azuma / teio / s2p2 | 20.0 % |
| source A → **teio (+8.1 st)** | **27.3 %** | source B → dingzhen | 0.0 % |

Both self-conversion controls are a perfect 0 %, so the pipeline adds no
intrinsic word damage — the degradation scales with the size of the pitch move.
The sentence was recoverable in every case (the worst single error was
"ask not" → "there's not"), but **27 % is the ceiling to plan around** if the
words matter more than the disguise.

**The workaround:** choose a reference voice that is genuinely distant from the
source, and prefer a nearer one when clarity matters more than the degree of
change. There is no setting to trade between the two — `tau` is fixed at
OpenVoice's default 0.3, which the spike's sweep measured as best for identity
on 6–12 s references.

## A chunk seam is a blend of two different renditions, not a continuation of one

**Area:** F3 voice changer (`electron/voiceChunking.cjs`, `electron/voiceHost.cjs`).

**Behavior a user will notice:** almost nothing — but it is worth knowing why
the output of a long conversion is not reproducible from its parts. Converting
the same audio twice gives a bit-identical result, and converting a *file* is
deterministic; but the audio after roughly the first 28.5 seconds is not the
audio an unchunked conversion of the same file would have produced.

**Why.** The exported decoder is deterministic but **not frame-shift-equivariant**:
extending its analysis window to the left by a single 256-sample hop leaves the
interior completely decorrelated (measured rms difference 0.349 against a signal
rms of 0.186 — the difference is larger than the signal). A chunk that starts
mid-file therefore renders the same words in the same voice with entirely
different fine structure. Long inputs must be chunked — the graph converts a
whole utterance in one run, so an unchunked 20-minute file would need roughly
6.5 GB of RSS — and no overlap size can buy sample-level agreement with an
unchunked run past the first chunk.

**What is guaranteed instead.** Each line below gives the value measured on the
70 s fixture and, in brackets, the bound `electron/voiceIntegration.test.cjs`
actually asserts against the real model — the two are not the same thing, and
the measured figure is not what the test enforces:

- the first chunk's exclusive region is **bit-identical** to an unchunked run —
  measured max difference exactly 0 over 28.5 s (asserted: exactly 0);
- right up to the crossfade, including the stretch where the chunk has already
  begun to drift, the deviation is **2.5e-7** (asserted: below 1e-4). This is
  the line that sizes the discard margin: the same measurement with the
  2-frame margin the first draft used is **3.4e-1**, a factor of 1.6 million;
- the 20 ms RMS envelopes correlate at **0.978** with total RMS agreeing to
  **0.038 dB** (asserted: correlation ≥ 0.95, gap ≤ 1.0 dB). This is a coarse
  same-audio check, not a seam check — it reads 0.975–0.978 even with the
  broken margin;
- the crossfade window's own RMS sits **+2.08 dB** above the windows either
  side of it (asserted: below 3.5 dB).

That last figure is the honest cost of the seam law, and it is worth stating
plainly. Seams are **constant-power** (sin/cos) over 25 ms. Constant power is
the correct law for *uncorrelated* material, which is what the decoder produces
globally — but over a 25 ms window on tonal material the two renditions turn
out to be roughly half-correlated (equal gain measures −0.87 dB on the same
seam, implying a correlation near 0.45), and constant power therefore
over-sums. Constant power is kept anyway because it is exactly right in the
structural case (ρ = 0, which is what the shift-invariance measurement says the
decoder does) and errs by at most +3 dB in the coherent case, whereas equal
gain has the mirror-image failure and dips 3 dB on genuinely decorrelated
material. An earlier revision of this entry claimed the two renditions were
simply "decorrelated" at the seam and that a 6 dB bound would fail the rejected
equal-gain design. Neither was true: the measured correlation is about 0.45, and
−5.6 dB passes a 6 dB bound.

**The precedent this used to cite argues the other way, and that is worth being
honest about.** The paragraph above once justified the +2.08 dB by calling
constant power "the app's own established join law (the v1.9 crossfade ruling,
and `remixService.ts`'s default)". Auto-Remix does not default to constant
power. It MEASURES the correlation at the join it is about to make
(`bestAlignLag` returns the normalised correlation at the chosen lag) and hands
that ρ to `crossfadeGains`, whose `1/k` normaliser — `k = sqrt(g0² + g1² +
2ρg0g1)` — makes the summed level hold exactly at that ρ. In other words, the
app's real join law CANCELS precisely the over-sum this entry accepts, and it
would cancel this one: at ρ ≈ 0.45 the exact law is available and the +2.08 dB
is not a law, it is an un-normalised sin/cos pair. The one place the app does
pass ρ = 0 is multitrack (`CROSSFADE_RHO`), and its own comment says why —
nothing there measures anything, so 0 is the honest assumption rather than an
invented estimate. Here something IS measurable.

So the seam is what it is: constant power over 25 ms, +2.08 dB on tonal
material, kept because it is exactly right at ρ = 0 (which is what the
shift-invariance measurement says the decoder does globally) and bounded at
+3 dB in the coherent case, whereas equal gain fails the other way. That is a
defensible trade-off on its own terms. It is not one the remix renderer
endorses.

Seams are placed 16,384 samples clear of each chunk edge because that is the
measured reach of the decoder's context deficiency — the spectrogram's own
2-frame overlap suggests 512 samples, and that figure is wrong by a factor
of 32.

**One metric that was tried and removed**, because it could not do what it
appeared to: comparing the chunked run's 20 ms frames against the unchunked
run's near a seam. Away from any seam that comparison already spreads
**±14.26 dB** purely from rendition decorrelation, so every bound below 14 dB
was measuring noise. The −1.46 dB an earlier revision published as "the worst
level change at a seam" was one such frame, 5,574 samples from the nearest
crossfade.

**Practical consequence:** peak memory stays flat with input length (measured
1,355 MB on a 70 s input and 1,351 MB on double that, against 1,730 MB for the
unchunked path on the 70 s input) at a cost of 5.3 % extra inference.

## Align Lyrics places words; it never judges how they were sung

**Area:** F6 Align Lyrics (`electron/alignHost.cjs`, `electron/alignManager.cjs`,
`src/dsp/ctcAlign.ts`, `src/dsp/wordSplice.ts`, `src/services/alignLyricsService.ts`,
`src/components/Dialogs/AlignLyricsDialog.tsx`).

**Behavior a user will notice:** the tool gives every word a position and lets
you hear and replace any one of them, but it never says which word is wrong. If
you came looking for a pronunciation coach, this is not one, and the name says
so.

**The measurement that decided it.** Goodness of Pronunciation was implemented
in the Witt & Young posterior-ratio form over a forced alignment of the known
phone sequence, in three variants (spike frames with the minimum over a word's
phones; the full realised segment with the minimum; the full segment with the
mean), and scored against the eight word tokens in the recording's known error
clusters.

| GOP variant | AUC (suspect worse than clean) | top-10 catches | words flagged |
|---|---|---|---|
| spike frames, min over phones | **0.642** | 3 of 8 | 46 of 51 |
| full segment, min over phones | 0.663 | 2 of 8 | **51 of 51** |
| full segment, mean over phones | 0.642 | 3 of 8 | 51 of 51 |

Chance is 0.500. Both halves of the test fail: the ranking barely beats a coin
toss, *and* the scorer flags nine words in ten, so "flagged" carries no
information. The intrusive-/r/ word the investigation was most confident about
ranked 35th of 51.

**Why, and what it would take to change.** The scorer is not broken — on the
native spoken control the same implementation scores 19 of 22 words at exactly
0.000 and flags only three rhotic-vowel words where the dictionary form and the
speaker's realisation genuinely diverge. The difference is the material: the
acoustic model's free-decode phone error rate is 14.5 % on that speech and
**68.1 % on this singing**. Alignment only asks the model to *place* known text;
GOP asks it to *read* the audio. Placing survives what reading does not — the
same checkpoint free-decodes the sung take at 47.1 % word error, more than
double the Whisper this app already ships, and still places words to a 20 ms
cross-model median. Reviving GOP would need an acoustic model trained on
singing, with a permissive licence and an ONNX export; none was found.

**One confound is open and is stated rather than resolved:** whether the
collapse is caused by singing or by this singer's non-native accent could not be
measured, because no native singer's isolated vocal was available and a full mix
would confound rather than control. The available evidence points at singing
(the same app's transcription measured 45.6 % word error on native clean solo
singing against 21.6 % on this singer), but that is corroboration across
different recordings, not proof.

## Alignment accuracy is 20 ms cross-model, on one performance by one singer

**Area:** as above.

**Behavior a user will notice:** a word's highlighted span can begin or end a
little before or after where you would place it by ear, most visibly on short
function words and on words that begin with a vowel.

**The measurement, and why this is the figure quoted.** Two acoustic models that
share no training data, no label set and no size — a 95 M-parameter LibriSpeech
character model and a 317 M-parameter multilingual 392-phone model — were each
asked to place the *same* known text, and their word starts compared. No human
marked anything.

| Material | n | median difference | within 100 ms |
|---|---|---|---|
| sung vocal | 51 | **20 ms** | 45 of 51 (88 %) |
| spoken control | 22 | **20 ms** | 20 of 22 (91 %) |

Two exact controls back it up with no ground truth at all: inserting exactly
1.000 s of silence moved every later word by exactly 1.000 s (14 of 14 sung,
15 of 15 spoken, maximum error 0.000 s — the aligner is not drifting), and all
51 sung and 22 spoken word spans sat above a −25 dB-relative floor, so no word
was placed on silence.

**What this number is not.** It is n = 51 words, one performance, one singer.
The two models disagree by more than 100 ms on 8 of the 51, and every one of
those is a short function word or a vowel-initial word, which is where both
models are weakest. The same investigation also produced figures against a
hand-marked ground truth — median 28 ms on the one sung line whose word
assignment was forced rather than chosen (n = 7), 36 ms on the 22-word spoken
control, and 48 ms to the nearest aligned word start over 19 unlabelled sung
onsets. **Those are deliberately not quoted anywhere in the app**, because the
person marking them
could not listen to the audio, so word boundaries in legato singing that carry
no amplitude, spectral-flux or pitch cue are simply absent from that ground
truth — which can only inflate the result.

**Audio longer than 30 seconds is aligned in several passes.** The host's
inference chunk is 30 s, which is where its working set stays comparable to the
app's other models (a single 180 s pass peaked at 7.6 GB and 600 s failed
outright). Chunking perturbs the whole grid rather than its edges, because
attention is global: measured against a single-pass reference over 197 words,
about one word start in six differs, by up to 40 ms — the same order as the
aligner's own precision. Audio that fits in one chunk is bit-identical to a
single pass (0 of 73 onsets moved). Carrying context on either side of a chunk
was measured at 0, 0.5, 1, 2 and 4 seconds and was no better, and worse on the
worst case, so it is not carried.

## The wrong-lyrics warning is a warning; it neither refuses nor catches everything

**Area:** as above (`LYRICS_MATCH_THRESHOLD` in `src/dsp/ctcAlign.ts`).

**Behavior a user will notice:** paste lyrics that belong to a different song and
the words are still placed — confidently, and in the wrong places — with a
warning above them. Occasionally the warning appears on lyrics that *are*
correct, and occasionally lyrics that are wrong slip through without it.

**Why there is no refusal.** CTC forced alignment has no "could not align"
outcome. As long as the audio has more frames than the token sequence needs, a
path exists and the search returns it. The only handle is the path's own score,
and it is a real one: on the reference sung take the correct lyrics score
−0.1766 nats/frame against −0.9506 for the *same 51 words shuffled* across five
fixed seeds — a length-matched control, because a longer wrong text is penalised
for its length alone.

**Where the threshold came from.** Two files support "a gate is feasible", not an
operating point, so a bank was built: the real recordings on disk cut into 15
passages whose text is known for the whole of them, each scored against its own
text and against length-matched wrong text (the same words under five shuffles,
another passage's text at the closest word count, and lyrics over material with
no voice in it) — 16 correct rows and 103 wrong ones. The split is by *material*,
not by row, and candidate thresholds are midpoints between consecutive
calibration scores, so no held-out value could be selected.

| statistic | calibration | held out |
|---|---|---|
| whole-path score | 8 true / 0 false negatives, 0 false positives | 7 true / **1 false negative**, 1 false positive |
| **median per-word score** | 8 true / 0 false negatives, 0 false positives | 8 true / **0 false negatives**, 4 false positives |

The median per-word score ships. Its one false negative is the difference: the
path score's failure is the 142-second reference take, which sings the six lines
*twice* — the correct lyrics describe half of it, and a mean over every frame
charges them for the half they do not describe. Telling a user their own correct
lyrics do not match their own recording is precisely the confident-wrong failure
this feature exists to avoid.

**What is left, stated:** held-out data is **not separable**. The wrong text
closest to the line sits 0.09 nats above the correct text furthest from it, and
four wrong rows pass the chosen threshold — three of them shuffles over the
two-pass take, where the aligner has seventy spare seconds to hide a wrong word
order in. A gate that refused would eventually refuse correct work; a gate that
accepted silently would eventually accept nonsense. So it says what it measured
and shows the spans anyway.

## A replacement that is nothing but room tone is spliced, not refused

**Area:** F6 replace-a-word (`src/dsp/wordSplice.ts`, `src/dsp/chainAnalysis.ts`,
`src/services/alignLyricsService.ts`).

**Behavior a user will notice:** record a replacement, say nothing into the
microphone, and press Replace. The splice runs. It level-matches the room tone
it captured up to the replaced word's level, so you hear a burst of hiss where
the word was. One undo removes it.

**Why.** "Silent" is judged against an **absolute** floor — `SILENCE_RMS`, one
LSB of 16-bit PCM — and room tone sits above it. It used to be judged against
the recording's **own** floor, which refused this case correctly and refused two
legitimate recordings with it:

- a take whose pauses are **literal zeros** (a gated interface, a DAW bounce —
  and Chromium's fake capture device, which is what the packaged smoke records).
  `measureNoiseWindow` rejects every window at or below digital silence, so it
  hands back the quietest window it could find *containing the word*, the derived
  threshold becomes the word's own envelope peak, and nothing clears it. Measured
  on the fake device: threshold **0.973**, longest run above it **14 samples**
  against a bar of 960 — a take carrying two full-scale beeps, refused as silent.
- a word **punched in tight**, with no room tone either side. The quietest 500 ms
  is then as loud as the rest. Measured on 1.52 s of stationary tone: **0 samples
  of 72 960** rose above the threshold.

A self-relative threshold cannot tell "uniformly loud" from "uniformly silent",
and it was firing on the wrong one. The trim now falls back to the absolute floor
when the recording's own floor yields no run, and the refusal is judged against
that absolute floor too.

**What is left, stated:** room tone and a tight punch-in are indistinguishable at
the absolute floor, and nothing separates them without inventing a level this app
has not measured. So the trade is deliberate and it runs this way round: a wrong
splice costs one undo, a wrong refusal costs a re-recording.

## A replacement can only be recorded, not imported

**Area:** F6 replace-a-word (`src/services/alignLyricsService.ts`).

**Behavior a user will notice:** the Align Lyrics tool records the replacement
from the microphone and offers no way to bring one in from a file. (The "Load
from file…" button beside the lyrics box reads *words*; it never touches audio.)

**Why.** Scope, and only scope — the technical reason this entry used to give (a
file whose lead-in is literal zeros would be refused) is fixed, above. Recording
is also the better answer to the thing the feature is for: a replacement sung
here **is** your voice, with no provenance to defend.

## Opening a large file freezes the window for about a tenth of a second per 50 MiB, and it is the delivery, not the decode

**Area:** `electron/ipc.cjs` `file:read` → `electron/preload.cjs` `readFile` →
`src/services/fileService.ts`.

**Behavior a user will notice:** opening a large WAV stops the window — no
hover, no scroll, no keystroke — for roughly a tenth of a second per 50 MiB,
before any decoding starts. It is short, it happens once per open, and it is
real.

**Measured** (`scripts/open-ipc-probe.cjs`, verdict
`docs/bench/t4-open-ipc-delivery.json`, 5 reads per file in the built app):

| File | Size | `await readFile()` | Main thread BLOCKED | One in-renderer copy of the same bytes |
|---|---|---|---|---|
| real-song-48k.wav | 65.2 MiB | 206.3 ms | **137.5 ms** | 14.8 ms |
| long-real-take.wav | 52.1 MiB | 173.5 ms | **114.2 ms** | 13.6 ms |
| long70.wav (control) | 5.9 MiB | 20.1 ms | 14.4 ms | 1.8 ms |

The block is measured rather than inferred: a 4 ms interval runs across the read
and the longest gap between its ticks IS the stall. The detector is calibrated
in the same run against a deliberate 120 ms block (detected: 122.2 ms).

**Why.** It is per-byte work on the renderer's main thread — 2.11, 2.19 and
2.44 ms per MiB across the three sizes, a straight line through the origin
rather than a fixed per-call cost. Two copies are in it and neither is avoidable
from where the code stands: `ipcRenderer.invoke` has no transfer list, so an
`ArrayBuffer` returned from `ipcMain.handle` is **structured-cloned**, and
`contextBridge` **copies it again** on the way into the page's world — the
isolated-world boundary the whole security model rests on. `ipcRenderer` is
main-thread-only, so both land there.

**What it would cost to fix, and why it has not been.** One plain copy of
65 MiB costs 14.8 ms on this machine; the delivery costs about **nine times**
that. The headroom is real, and reaching it means carrying the buffer over a
`MessageChannelMain` port as a *transferable* rather than as a return value — a
new channel and a new protocol for every caller of `file:read`. That is an
architecture change, and the pass that measured this was scoped to measure
first and fix only what a cheap, safe change could clear. Chunking the delivery
would break the freeze into slices without reducing the total work.

**Not this:** the decode. The 308 ms decode freeze this app used to have was
fixed along with three redundant copies (~205 → ~65 MiB per open). What remains
is the hand-off itself.

## Transport keys during a hosted effect Preview

**Area:** the effect card in the module column (`src/components/Dialogs/EffectHost.tsx`,
`src/components/Dialogs/EffectDialog.tsx`), global shortcuts
(`src/services/shortcuts.ts`)

**Current behavior:** since the 2026-08-18 program (item 6) an effect opens as
a **card in the module column** rather than a modal. A card is not modal by
design: it joins no dialog stack, so every global shortcut stays live while it
is open — that is what lets you select, scrub and play beside it. **Preview**
auditions the effect by loading a throwaway preview document into the
playback engine, and during that preview the global keys still act on the
engine: `Space` pauses or resumes the **preview**, and the transport keys act
on the document the engine is holding, which is the preview copy, not the
real document. The card publishes its module lock during **Apply only**
(N16): Preview greys nothing and suspends nothing, because it is one click to
end and locking the strip for it would be worse than the key landing on the
preview. **Stop Preview**, the **✕**, **Cancel**, **Apply** and `Escape` all restore
the real document to the engine, exactly as the modal's Escape did.

**`Escape` closes the card; a selection lost some other way still widens
Apply.** Since N18 (2026-08-23) `Escape` with an idle effect card open closes
the card — the ✕'s own path — and the key is claimed before the global table
can run **Deselect**, so the selection survives (see `KEYBOARD_SHORTCUTS.md`).
What remains is the rest of the class: Edit › Deselect and a plain click on
the waveform still clear the selection with the card open, and because an
effect resolves its region from the live selection when Apply runs — reading
"no selection" as the whole file — the next **Apply** then writes the entire
document rather than the span you previewed, as one undo entry. The hosted
pipeline tools resolve the same way (Match Tempo, the Vocal Chain and the Cover
Chain), and for them `Escape` still does nothing. It is not silenced: the
card's first line names the span Apply will write and switches to "Whole file"
the moment the selection goes, so the widening is visible before Apply is
pressed, and `Ctrl+Z` undoes it in one step.

**A Preview the mouse takes away.** Because the card is not modal, a preview
can also be ended by something other than the card: switch document in the
Files panel, ripple the audio with the edit pill, or convert the sample rate,
and the transport loads that document into the shared engine, which stops and
replaces the preview. The card watches the same change and gives the preview
up with it — the button goes back to reading **Preview**, and pressing it
starts a fresh preview of the document you moved to instead of stopping the
playback you just started there.

**Mouse edits during Apply.** The same non-modal design holds while an effect
is being **applied**: the module strip, the card's ✕ and Cancel are held and
the global keys are suspended for the duration, but the mouse is never
suspended — the edit pill, the Edit menu, File › Close and the Files panel
stay live, exactly as they do during a running pipeline pass — with one
exception, added in the final round: a menu command that would UNMOUNT the
card mid-Apply is refused rather than obeyed, with the same "A pass is
running" message a pipeline pass gives (it names the effect). That covers
`Pipeline › Transcribe` on a take you have already transcribed, whose reveal
path used to clear the module lock on its way to the Analysis panel. The
runner
resolves the target region when Apply starts and commits the processed audio
to that same span when the worker returns (`src/services/effectRunner.ts`,
`runEffectOnSelection`), so the card hands it a `shouldCancel` (T6-3's seam,
asked once between the audio arriving and the commit): an Apply commits only
to the document as you left it when you clicked — same document, same audio,
still the active one. Edit it, switch to another document or close it in
between and nothing is written; the card stays and says so, and Apply runs
the effect again on the document as it is now. What remains: the pipeline
tools that commit after a worker pass from their own services (the Vocal
Chain, Align Lyrics) still carry that window — let their progress finish
before editing.

**Intended behavior:** a narrower seam than the module lock — "hold the
keyboard" without "hold the module column" — could route transport keys to the
real document during a preview, or end the preview first. (`Escape` is the
one key the effect card does answer, with its own dismissal and without taking
any other key from the waveform — N18 — which is the shape that seam would
take for the rest.) It is the same
second seam the pipeline tools' lock already wants (see `App.tsx`,
`refuseWhileRunning`) and is a change of its own. The Apply-time window is
closed for effects at the card (`EffectDialog`'s `shouldCancel`); the pipeline
services that commit after their own worker pass (`vocalChain.ts`,
`alignLyricsService.ts`) want the same guard, and that is their change, not
the card's.

## Merge Clips bakes the members into a new document

**Area:** Merge Clips (`src/multitrack/mergeClips.ts`, `src/services/menuActions.ts`
`mergeSelectedClips` / `canMergeSelectedClips`, the edit pill's **Merge** button)

**Current behavior:** a merge is a **render**, not a re-labelling. Every track
with two or more selected clips gets one new clip spanning
`[min(start), max(start + length))`, and the audio behind it is a new
`Merge N` document — `createDocument` + `addDocument`, the same computed
document Mix Down and the stem separator produce. Five consequences follow from
that, all of them by design and all of them visible to the user:

- **Clip gain and fades are inside the audio now.** Each member is written
  through the renderer's own path — `readClipSlice` × `dbToLinear(gainDb)` ×
  the resolved fade gain — so the merged clip is created at gain 0 dB with no
  fade keys at all. The Properties panel therefore shows a clip that looks
  untouched over audio that is anything but, and a member's -6 dB or its
  fade-in can no longer be dialled back: the only way to reach them again is
  to undo the merge.
- **Undo restores the clips; it does not un-mint the document.** The document
  is created outside the session gesture (the Mixdown pattern), so one
  `Ctrl+Z` puts every member back with its original id while `Merge N` stays
  open in the Files panel. It is `neverSaved`, so closing it asks first — an
  undone merge leaves a file behind that you have to dismiss by hand. If the
  user closes `Merge N` anyway and then REDOES the merge, the merged clip
  comes back referencing a document that no longer exists: it plays silent
  and is dropped from the next project save. `Ctrl+Z` recovers the members
  again.
- **A mono member in a stereo merge lands at -3.01 dB per side.** The merged
  document is mono only when *every* member's document is mono; otherwise a
  mono member is written into both channels scaled by `Math.SQRT1_2`. That is
  the level the mono pan law gives a **centred** clip (`monoPanGains(0)` =
  `cos(π/4)`), so a mono clip on a centred track merges at exactly the level it
  played at. A hard-panned track does not: pan is a track property and is never
  baked, so after the merge that track pans a **stereo** document and switches
  laws — `stereoBalanceGains(-1)` passes the left channel at 1.0 where
  `monoPanGains(-1)` gave the mono source 1.0 — and the member comes back up to
  3.01 dB quieter than it played. The same law switch also shifts the
  **stereo image** at any non-centre pan, not only at the hard extreme: a mono
  clip panned to +0.5 renders at `monoPanGains(0.5)` ≈ {0.383, 0.924} (L/R)
  before the merge and at `Math.SQRT1_2 × stereoBalanceGains(0.5)` ≈ {0.500,
  0.707} after it — the image audibly narrows even though the pan value
  itself never changed. This is not limited to a static pan: `autoPanGainsAt`
  and `autoSpatialGainsAt` both pick their gain law from the same `mono` flag,
  so an automated pan or spatial sweep through a merged track shifts the same
  way.
- **A crossfade with a clip outside the selection is torn in half.** Fade specs
  are resolved over the whole track — the renderer's own view — so the member's
  side of a crossfade with an unselected neighbour is baked into the merged
  audio as a fade. Removing that member then disarms the neighbour's facing
  fade, and the neighbour is left playing at full level under the merged clip's
  baked fade. The overlap stops being equal-power; select both sides of a
  crossfade, or expect to re-arm it afterwards.
- **Unselected clips inside the span are overlapped, not merged.** A clip that
  sits inside `[min(start), max(start + length))` but was not selected is
  neither absorbed nor pushed aside. The merged clip simply lands on top of it,
  exactly as a drop would — overlap is first-class in this session model — so
  both are heard.

**Intended behavior:** unchanged by design for all five. The whole point of the
verb is to turn several clips into one piece of audio, which means committing
the per-clip level and shape that made them sound the way they did; a merge
that kept gain and fades editable would be a group, not a merge. The mono
scaling is a deliberate choice of *which* level to preserve (centre) rather
than a rounding error, and the crossfade and overlap cases follow from merging
a **selection** rather than a region — widening either would silently change
clips the user did not choose.
