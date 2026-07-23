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

## Markers persist in every container (resolved)

**Area:** Markers (`src/stores/appStore.ts` `markers`, `src/audio/wavCodec.ts`,
`src/audio/id3Chapters.ts`, `src/audio/chapterTags.ts`/`flacMeta.ts`,
`src/audio/oggPage.ts`, `src/multitrack/sessionFile.ts`)

**v1.3 behavior:** Markers round-trip through **all four supported containers**
plus sessions, sample-accurately:

- **WAV** — standard `cue `/`LIST`-`adtl` chunk pair (Audacity/Audition-
  compatible). Since v1.3, `labl` names are no longer limited to Latin-1: if
  any marker name needs it, all labels in the file are written as UTF-8
  (Audacity-style), and reading tries strict UTF-8 first with a Latin-1
  fallback for legacy files — CJK and emoji names round-trip intact.
- **MP3** — an ID3v2.3 tag with standard chapter frames (`CTOC` + one `CHAP`
  per marker with an embedded UTF-16 `TIT2` title, podcast-chapter style) plus
  a `TXXX AUDITORIUM_MARKERS` frame carrying exact sample offsets.
- **FLAC** — a `VORBIS_COMMENT` metadata block with de-facto-standard
  `CHAPTERxxx`/`CHAPTERxxxNAME` tags plus the same sample-accurate private tag.
- **OGG (Opus)** — the same chapter comments in the OpusTags header (at the
  file's 48 kHz clock).
- **`.audm` sessions** (`formatVersion: 2`) — a `markers` map per referenced
  document; v1 session files still load with zero markers.

Opening any of these seeds the store with fresh marker ids; in-place Save,
Save As, and Export all write markers back. Files saved with **no** markers are
byte-identical to pre-v1.3 output for every format.

**Remaining notes (interop granularity, not persistence gaps):** third-party
tools read the standard chapter fields at millisecond granularity (that is all
ID3 `CHAP`/vorbis `CHAPTER` timestamps can express); Auditorium itself reopens
markers sample-exactly via its private tag. Chapter-aware players (e.g. VLC)
see the vorbis-comment chapters; MP3 chapter support varies by player. Adobe
Audition does not read or write MP3/FLAC/OGG markers at all — Auditorium
exceeds parity here.

**Intended behavior:** No further work planned — this is complete.
