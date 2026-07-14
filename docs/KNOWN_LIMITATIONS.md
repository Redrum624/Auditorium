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

## Ogg (and other exotic containers) become save-as WAV

**Area:** File > Save / Save As (`src/services/fileService.ts` `saveDocument`,
`openFilePath`)

**v1.1 behavior:** Save is now **format-faithful** for the common containers.
A document opened from `.wav`, `.mp3`, or `.flac` keeps its `filePath` and Save
re-encodes **in place into that same container**: WAV → 32-bit float, MP3 → 192
kbps CBR, FLAC → verbatim FLAC at the source bit depth (16 or 24). Only `.ogg`
and other unrecognized/exotic sources (m4a, aac, webm) are still opened with
`filePath = null`, so their first Save falls back to a save-as `.wav` dialog —
Auditorium has no Ogg Vorbis/Opus encoder, and re-encoding a lossy source to a
different lossy container on every Save would silently degrade it. The original
source bit depth is recorded on import and shown in the Properties panel
("16-bit source → 32-bit float").

**Intended behavior:** Add an Ogg Vorbis/Opus encoder to round-trip `.ogg`
sources in place as well; until then, save-as WAV is the safe lossless default.

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
