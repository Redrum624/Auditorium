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
Chromium's `decodeAudioData` no longer resamples the output. Only genuinely
unrecognized/exotic container layouts and 64-bit-box MP4 files still fall back
to **48000 Hz**. Audio with more than two channels is down-mixed to stereo —
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
surfaces an error rather than writing a broken file. Ogg has no standard marker
chunk, so markers are not written to `.ogg` (same as MP3/FLAC; use WAV or the
`.audm` session to persist markers).

**Intended behavior:** No further work planned — Opus-in-Ogg is the correct
modern default. A native Vorbis encoder (to keep Vorbis sources as Vorbis) is a
possible future refinement but not needed for round-tripping.

## Markers are not persisted in MP3/FLAC (resolved for WAV and sessions)

**Area:** Markers (`src/stores/appStore.ts` `markers`, `src/audio/wavCodec.ts`
`encodeWav`/`decodeWav`, `src/multitrack/sessionFile.ts`)

**v1.2 behavior:** Markers now round-trip through the two containers that matter
most. `encodeWav`/`decodeWav` write and read a standard `cue `/`LIST`-`adtl`
chunk pair (one cue point + one NUL-terminated `labl` per marker, Audacity/
Audition-compatible), so opening and saving/exporting a `.wav` file — at any
bit depth, including in-place Save and Save As — keeps its markers. Opening a
`.wav` seeds the app store with fresh marker ids read back from the file. The
`.audm` session format (`formatVersion: 2`) adds an optional `markers` map keyed
by document id, embedded for any document referenced by a clip; loading a
session seeds the store with fresh marker ids, and v1 session files (no
`markers` key) still load fine with zero markers. Closing a document still
discards its markers from the live store (`closeDocument` deletes the
`markers[id]` entry) — but if the document was a `.wav` file or was saved as
part of a session, its markers survive on disk and come back on reopen.

**Remaining gap:** MP3 and FLAC have no standard marker/cue-chunk field, so an
in-place Save or Export to either format still does not carry markers — only
the `.audm` session format (or re-saving as WAV) preserves them for those
sources.

**Intended behavior:** No further work planned; MP3/FLAC markers are a
container-format limitation, not a missing feature — Adobe Audition has the
same restriction for those formats.
