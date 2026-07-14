# Known Limitations

Tracked deviations from full Adobe Audition parity. Each entry names the area,
the current v1 behavior, and the intended future behavior.

## Unsniffable containers fall back to 48000 Hz; >2-channel downmix law

**Area:** File > Open (`src/audio/decodeAudio.ts` `decodeArrayBuffer`,
`src/audio/sniffSampleRate.ts`)

**v1.1 behavior:** Non-WAV imports now arrive at their **native sample rate**.
Before decoding, `sniffSampleRate` parses the container header (MP3 frame sync,
FLAC STREAMINFO, OGG Vorbis/Opus identification, MP4/M4A `mdhd` timescale, and a
defensive WAV `fmt` reader) and the `OfflineAudioContext` is built at that rate,
so Chromium's `decodeAudioData` no longer resamples the output. Only containers
whose rate cannot be sniffed (an exotic/unrecognized layout, or a 64-bit-box
MP4) fall back to **48000 Hz**. Audio with more than two channels is down-mixed
to stereo — the extra channels (index ≥ 2) are folded into both L and R at −3 dB
rather than dropped: `mix = 0.7071·mean(ch2…chN-1)`, `L' = clamp(ch0 + mix, ±1)`,
`R' = clamp(ch1 + mix, ±1)`.

**Intended behavior:** For unsniffable formats, add per-container parsers as
needed; the current fallback is a bounded, safe default. The downmix is a fixed
−3 dB fold; a user-selectable surround downmix matrix could follow.

## Source bit depth is not tracked after import

**Area:** File > Open / Properties (`src/audio/decodeAudio.ts`,
`src/components/Panels/PropertiesPanel.tsx`)

**v1 behavior:** The original file's **source bit depth is not tracked after
import** (for WAV or any other format) — all audio is held in memory as 32-bit
float (`Float32Array`), which is what the Properties panel's "Bit Depth" row
reports.

**Intended behavior:** Record the source bit depth on import and surface it in
the Properties panel (e.g. "16-bit source → 32-bit float").

## Save always writes WAV; non-WAV sources become save-as

**Area:** File > Save / Save As (`src/services/fileService.ts` `saveDocument`,
`openFilePath`)

**v1 behavior:** The app only ever *writes* WAV (32-bit float). A document opened
from a non-WAV source keeps `filePath = null`, so the first Save opens a save-as
dialog defaulting to a `.wav` file rather than overwriting the original in its
source format. Documents opened from a `.wav` keep their path and Save writes
straight back. Re-encoding to MP3 (or any lossy format) is available only via
File > Export, which never changes the document's path or dirty state.

**Intended behavior:** Round-trip a file back to its original container/format on
Save (e.g. re-encode MP3 in place), gated on the format-aware encoder set.

## Track arm (R) is visual-only — no multitrack recording

**Area:** Multitrack > TrackHeader (`src/components/Multitrack/TrackHeader.tsx`)

**v1 behavior:** The R toggle stores the `armed` flag but nothing consumes it.
Recording happens only via the single-file Record dialog (transport record button),
which creates a new document rather than recording into an armed track at the playhead.

**Intended behavior:** Audition-style punch-in recording onto armed tracks.

## Markers are session-only (not persisted)

**Area:** Markers (`src/stores/appStore.ts` `markers`, `src/components/Panels/MarkersPanel.tsx`,
`src/services/menuActions.ts` `marker.add`/`marker.next`/`marker.prev`)

**v1 behavior:** Markers live only in the in-memory app store (`markers: Record<docId, Marker[]>`),
keyed by document id. They are not written into `.wav`/`.mp3` exports (this app's
WAV/MP3 encoders have no marker/cue-chunk support), not round-tripped through
File > Save/Save As, and not included in a saved multitrack session (`.audm`,
`src/multitrack/sessionFile.ts`) even when the source document is inserted as a
clip. Closing a document also discards its markers (`closeDocument` deletes the
`markers[id]` entry). Reopening the same file later starts with zero markers.

**Intended behavior:** Adobe Audition persists markers with the file (a WAV
cue/label chunk, or its own metadata sidecar) and/or with the session. Doing
the same here needs either a WAV cue-chunk writer/reader or a marker section
in the `.audm` session format — neither exists yet.
