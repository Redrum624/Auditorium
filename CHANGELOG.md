# Changelog

All notable changes to Auditorium are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.19.0] - 2026-08-10

**Align Vocal Timing** — warp a sung take so its syllables land on the beat when the singer drags or
rushes. `Effects → Align Vocal Timing…`

This is the thing **Match Tempo structurally cannot do**. Match Tempo applies one ratio across the
whole region, so it can move a take earlier or later as a block but cannot pull a dragged line
forward while leaving the next, rushed line alone. Alignment warps at a different rate between each
pair of syllables, through the same variable-rate, stereo-linked, pitch-preserving stretch Pitch
Correct already uses — no new stretcher was written, only the time map that drives it.

### Added

- **`Effects → Align Vocal Timing…`.** Mark the syllables you want moved (ordinary markers), pick
  the beat grid and its subdivision, confirm it, set the strength, apply. The region keeps its exact
  length — syllables move *within* it, so nothing after it slides — and pitch is preserved, so the
  result can still go through Pitch Correct.
- **`Suggest syllable markers`**, which runs an onset detector and writes its proposals in as
  ordinary, editable markers as their own undo step. It never feeds the warp directly. See below.

### The detector is a proposal, and the measurement says why

Onset detection was measured against **23 hand-marked note attacks** in an 8 s excerpt of a real
142 s solo cover vocal, cross-checked against the YIN pitch track so a portamento slide or a vibrato
dip could be told apart from a genuine note change:

| analysis parameters | best F1 @±50 ms | precision | recall | median error |
|---|---|---|---|---|
| as tempo detection ships it (11 kHz, 21 ms hop) | 0.65 | 0.56 | 0.78 | 36 ms |
| 24 kHz, 10.7 ms hop | 0.74 | 0.80 | 0.70 | 32 ms |
| **48 kHz, no decimation, 5.3 ms hop** | **0.75** | **0.88** | 0.65 | **12 ms** |

Spectral flux is built for transients and a legato vowel has none, so the tempo-detection parameters
**do not transfer**: as shipped, 44 % of the onsets reported are breaths, note *endings*, portamento
slides or vibrato peaks. Retuning for voice — no decimation, a 5.3 ms hop, and keeping the sibilant
energy an 11 kHz analysis throws away — triples the localisation accuracy and lifts precision to
0.88, which is what the suggester uses. That is still one bad anchor in eight, and at the ±30 ms
tolerance timing work actually needs, the best of the three only reaches F1 0.57.

A false anchor is not a missed opportunity: it drags a syllable-sized span of audio onto a beat it
never belonged on, **manufacturing** a timing error where there was none. So the warp acts on
**markers you confirmed**, never on raw detections, and the dialog states the measured reliability
next to the button rather than in a footnote.

### The grid is confirmed, never guessed

Tempo detection on real material put a track's drums at 159.83 BPM and its five other sources at a
mean of 109.4 — a genuine ~3:2 feel, with every confidence between 0.003 and 0.084 against the app's
own low-confidence threshold of 0.35. Both grids are musically defensible, so an automatic pick would
be a coin flip that makes every correction ⅔ or 1.5× wrong. **Apply stays disabled until you tick
that the grid is right**, and ×2 / ÷2 re-track the grid rather than relabelling it.

The **subdivision** matters as much. The same 23 attacks sit a median of 120 ms from the nearest
quarter, 63 ms from the nearest eighth and 25 ms from the nearest sixteenth — that take is on
sixteenths, and snapping it to quarters would move syllables by up to 260 ms and destroy it. So each
subdivision is labelled with **the median move it implies**, which is the fastest way to see which
grid the performance is actually on.

### Bounded, and honest at the bound

Local stretch is clamped to **0.88–1.14×** — the range this WSOLA is transparent over, not the
engine's 0.25–4× limits, because the spans being stretched are sung vowels. A move the clamp holds
back lands short of the grid, and the dialog **names how many will before you apply**, with what to
do about it.

**Strength defaults to 25 %, derived rather than chosen.** Applying strength `s` to the measured take
with the real differential between neighbouring anchors, 0.25 is the largest value at which *none* of
the 22 inter-syllable spans needs a ratio outside the transparent band — its worst is 0.888 against a
0.88 floor. At 100 %, 41–55 % of the spans would be clamped: a full-strength default would spend
half its time doing something other than what it says. Fully quantised vocals also sound
machine-made; the musical answer is usually partial.

3830 tests.

## [1.18.0] - 2026-08-10

**De-esser** — tame harsh "s" and "sh" sounds without dulling the voice.

### Added

- **`Effects → Dynamics → De-esser`.** A split-band design: a crossover isolates the sibilant region,
  a steep sidechain detector decides when sibilance is actually present, and only that band is
  reduced. **Listen** monitors what is being removed rather than what is left — which is how a
  de-esser is actually dialled in, since nobody can judge a 3 dB reduction at 7 kHz in context, but
  anyone can hear whether the isolated band contains only sibilance or also consonant detail.

  Every default is derived from measurement on a real vocal rather than chosen: the 5500 Hz crossover
  is where sibilant-versus-vowel selectivity peaks across a 3–11 kHz sweep (29.8 dB, with 5.0–6.0 kHz
  within 0.31 dB of it), and the attack and release come from measured sibilant burst durations.

### How selective it is, measured

On a real 142-second solo vocal at the shipped defaults, sibilant frames lose up to **6.75 dB** while
**98.7 % of all samples are bit-identical** — the vowels are not attenuated less than the sibilants,
they are untouched, because the detector never crosses the threshold on them.

That distinction is the whole point. A processor that pulls vowels down slightly and sibilants down
more is a low-pass filter with extra steps; it would pass a naive "did the level drop" test. The
test fixture here puts a vowel and a sibilant at **identical RMS**, so the separation comes from
spectrum alone, and shifting the detector corner by 25 % breaks the vowel bit-identity.

With no reduction applied the output is **bit-identical to the input** — the crossover sums flat, so
the effect colours nothing at rest.

### Known limits

The threshold is in absolute dBFS, like the compressor and the gate, so it is set relative to the
file rather than to the voice: a vocal roughly 5 dB hotter than the material the default was derived
on will begin engaging on vowel peaks (the effect stays small — under 0.15 dB even 20 dB hot — but
the bit-exact-at-rest property is lost). Set it by ear with **Listen** enabled. The subtractive split
also caps total reduction at about 7.7 dB, which is the price of that exact identity at rest.

3694 tests.

## [1.17.0] - 2026-08-10

**Auditorium can now change a voice.** `Edit → Voice Changer…` re-timbres a
recording so it sounds like a different speaker while keeping the words and the
delivery, using OpenVoice V2's tone-colour converter on your own CPU — no
cloud, no account, nothing leaves the machine. You give it a **reference clip**
(a file, or a selection from an open document), save it as a reusable **voice
profile**, and the conversion lands as a new document.

**It is a voice change, not a clone — and here is the measurement.** Nine
conversions across five real target voices spanning 1.3 octaves were scored
with an independent speaker-verification encoder (not the model grading its own
work). Mean cosine similarity to the **target** was **0.795** against **0.615**
to the source, **8 of 9** landed closer to the target, and **none** still
verified as the source. Three controls make that conclusive rather than
suggestive: converting a voice to *itself* stayed inside the same-speaker band,
so the round trip does not itself destroy identity; a full confusion matrix put
each output nearest the voice actually requested, 8 of 9; and **pitch-matched
rivals** — pairs of targets 0.2 and 1.7 semitones apart — still resolved
correctly, so what moves is identity and not merely pitch.

**Two limits worth knowing before you use it.** First, expect "clearly a
different person, recognisably in the target's direction", not
"indistinguishable from the target" — 5 of the 9 conversions cleared the
positive same-speaker threshold and the rest landed in between. Second, **a
target close to the source barely moves**: the single miss was two low male
voices 1.7 semitones apart. The effect is proportional to the distance between
the two voices, so a reference that already sounds like the source will read as
a subtle change. Intelligibility holds throughout — word error rate ran
**0–27 %** against the unconverted source, worst at a **+8.1-semitone** jump,
and the sentence was always recoverable — but big pitch moves are where the
words cost the most.

**Choosing a reference clip asks you to affirm that you have the right to use
that voice, and the conversion will not run until you do.** This is part of the
design rather than a notice to dismiss. The model is good enough to impersonate
— a 7.8 s clip of a public figure produced output scoring 0.831 against that
speaker, above the same-speaker threshold — and because any voice can be a
target, the choice that matters is the reference clip, so the affirmation sits
exactly there. It is a statement you make, not a disclaimer you acknowledge,
and it is never pre-ticked. Nothing is watermarked, uploaded or logged; the app
is local-first and none of that would work offline anyway.

### Added

- **Voice Changer.** Why: the request was to make a recording sound like a
  different speaker, and the spike above established that this model genuinely
  does that rather than acting as a timbre tint. How to use: `Edit → Voice
  Changer…`, accept the one-time 161 MB model download, add a reference clip
  from a file or the current selection, affirm the consent statement, name it,
  and convert. Affects: `electron/voiceChunking.cjs`, `electron/voiceHost.cjs`,
  `electron/voiceManager.cjs`, `src/services/voiceService.ts`,
  `src/components/Dialogs/VoiceChangerDialog.tsx`.
- **Reusable voice profiles** — a saved name plus the reference clip's tone
  embedding, kept across sessions, so a voice you set up once is one click away
  next time. The embedding is computed over the **whole** reference clip in a
  single pass, which the spike's sweep measured as better for identity than
  averaging over segments on the 6–12 s clips people actually use.
- **The v1.7 host arrangement, again**: the 161 MB two-file model set is
  downloaded on first use, sha256-pinned and re-verified from disk before every
  load; inference runs on the CPU in an isolated utility process with per-chunk
  progress and a time estimate; Cancel kills the process outright rather than
  asking it to stop. CPU only, deliberately — DirectML measured 13.9 of
  16.4 GB of VRAM on a 350 s input, which is certain out-of-memory on an 8 GB
  card, and CPU already runs at about 4× realtime.
- **Long recordings are chunked at ~30 s**, so peak memory stays flat instead
  of growing with the file (the graph converts a whole utterance in one run — a
  20-minute file unchunked would need roughly 6.5 GB). Measured on a 70 s
  input: 1,355 MB chunked against 1,730 MB unchunked, and still 1,351 MB when
  the input is doubled. Conversion is capped at 30 minutes of audio in one run.

### Changed

- `Edit → Voice Changer…` joins the Edit menu alongside Transcribe and Separate
  into Stems; it is enabled only when a document with audio is active.

### Fixed

- **Chunk seams were being blended out of each chunk's least reliable audio.**
  Cause: the discard margin around every join was sized from the spectrogram's
  own geometry — an analysis window overlaps its neighbours by two frames, so
  512 samples looked like enough. The decoder's context reaches far further
  than its analysis window does. Measured against the real model: a chunk's
  output starts diverging from an unchunked run about **26,260 samples** before
  its end and is audibly wrong over the last ~10,000, and the 20 ms level at a
  chunk's head is **−6.18 dB** in the first frame, only rejoining the interior
  by ~15 frames. The margin was therefore about **32× too small**, and put both
  sides of every crossfade inside the corrupted region. Fix: the margin is now
  16,384 samples (64 frames), derived from those measurements, with the overlap
  and stride following from it — 5.3 % extra inference on a path that runs at
  4–4.9× realtime. The size of the difference: at the point the crossfade
  begins, a chunk's deviation from an unchunked run is **2.5e-7** with the new
  margin and **3.4e-1** with the old one. After the fix a chunked run is
  **bit-identical** to an unchunked one for the first 28.5 s and its envelope
  correlates at 0.978. Affects: `electron/voiceChunking.cjs`,
  `electron/voiceHost.cjs`.
- **Every in-app time estimate for a conversion was wrong.** Cause: the
  renderer keeps its own copy of the chunk-plan constants (it cannot load a
  main-process `.cjs` at runtime) and the copy had been left behind by two
  successive seam redesigns, so it modelled a stride the host had not used for
  some time. Fix: corrected, and the test now loads the real module and
  compares the two rather than restating the copy's own value back at itself.
  Affects: `src/services/voiceService.ts`.

## [1.16.0] - 2026-08-10

**Transcription with speaker separation**, running entirely on your machine. No account, no upload, no cloud service.

### Added

- **`Edit → Transcribe…` turns speech into timestamped, speaker-labelled text.** A Whisper model
  transcribes the document, a speaker-embedding model groups the segments by voice, and the result
  arrives as a transcript panel plus regions on the timeline — click a segment to jump the playhead
  there. Export to **SRT** or **WebVTT** with the speaker labels included.

  The 323 MB model set is downloaded on first use, sha256-pinned and re-verified before every load,
  never bundled, and Cancel genuinely kills the work rather than just hiding it. Inference runs on
  the CPU in an isolated process; measured in the packaged app at **7.7x realtime** (70 seconds of
  audio transcribed in 9.1 seconds).

### What it does and does not do, measured

Speaker separation is the honest weak point, so here are the numbers rather than an adjective.
On concatenated single-speaker test material: **one speaker identified correctly 5 times out of 5**,
**two speakers 100%**, but **three speakers only 45% automatically** — and only 73% even when told
in advance that there are three. That is why the speaker count is a control you can set, in both
the dialog and the panel; changing it re-groups the stored voice embeddings instantly, without
transcribing again.

Treat the two-speaker figure as an upper bound: the test material has no overlapping speech and
each voice was recorded separately. Real conversation, where people talk over each other, is harder.

The transcript lives for the session only — it is not written into the `.audm` file and does not
survive a restart.

### Fixed

- **Whisper's silence rule never fired, so silent passages were transcribed into confident
  fabrications.** A recording with a quiet gap could produce invented sentences carrying real
  timestamps and real speaker labels — measured on one dance-band recording as **seven fabricated
  segments**, including "One hundred and his name is A. I.". Two independent causes had to line up
  for this to hide: the no-speech probability was read from the wrong decoder position, **and** the
  pinned model spells that token `<|nocaptions|>` rather than `<|nospeech|>`, so the lookup returned
  nothing at all. Either one alone drives the probability to exactly zero for every window, which is
  why fixing only the first changed nothing visible. After the fix, the same recording produces
  **zero** fabricated segments; digital silence now reports a no-speech probability of 0.93 where it
  previously reported 0.000.

  Note that Whisper's rule is deliberately an AND — a window is skipped only when the model is both
  confident it is silence *and* uncertain about what it heard. Digital silence still emits Whisper's
  well-known `"you"`, because its own confidence in that guess sits above the threshold. That
  matches the reference implementation rather than diverging from it.

- **The timeline ribbon drew nothing at all.** The transcript lane measures its own width when it
  mounts, but the lane does not exist until a transcript does — so the measurement never ran, every
  region was culled as off-screen, and the failure was completely silent. Found by the packaged
  smoke test rather than by the unit tests, which all happened to create a transcript before the
  first render.

- **A speaker count the recording could not support was accepted and then quietly ignored.** Asking
  for six speakers on a transcript with three usable segments stored a number the panel then
  contradicted, because the request path and the re-cluster path disagreed about what to do with an
  out-of-range value — one refused it, the other silently fell back to automatic. Both now share one
  rule, the ceiling is what the recording's own evidence can separate, and an impossible count is
  refused with the real ceiling named rather than clamped behind your back.

- **A transcription process that ignored a kill request was abandoned silently**, leaving its ~1 GB
  inference arena resident while the next run started a second one. The kill result is now checked,
  retried once, and reported.

### Known limitations

- **Singing is not speech.** Whisper mangles lyrics even on a clean solo vocal — 45.6% word error
  rate, measured — and its own confidence does not flag it (−0.328 on badly-wrong singing versus
  −0.297 on perfect speech). Separating the vocal stem first helps with backing music but does not
  rescue clean singing.
- **A transcript lives only for the session.** Export to SRT or WebVTT before you close the
  document; there is no prompt on the way out.
- Transcription is capped at **2 hours** of audio per run.

Full details for every limitation above are in
[`docs/KNOWN_LIMITATIONS.md`](docs/KNOWN_LIMITATIONS.md).

## [1.15.0] - 2026-08-09

**Properly-written surround WAVs did not open at all** — any 5.1/7.1 file whose writer
followed the WAV spec was rejected with `Unsupported WAV audio format code: 65534`. That
rejection is fixed, the file's speaker layout is now read alongside the audio, and the
layout unblocks this release's feature: a user-selectable surround-to-stereo downmix
(ITU-R BS.775) in Convert Channels. A second, quieter data-loss fix rides along: Convert
Channels on a multichannel document used to keep only the front-left channel.

### Fixed

- **Spec-conforming 5.1/7.1 WAVs were rejected outright with "Unsupported WAV audio
  format code: 65534" (R6).** Symptom: File > Open failed on any multichannel WAV from a
  conforming writer (ffmpeg, Audacity, DAW exports…) — if you hit that exact message,
  this is the fix. Cause: such files carry format tag 0xFFFE (`WAVE_FORMAT_EXTENSIBLE`),
  mandatory per spec for more than two channels, and `validateFmt` accepted only tags 1
  (PCM) and 3 (IEEE float) — the wrapper tag was refused before the real sample format
  inside the extension was ever read. The only multichannel WAVs that opened were
  out-of-spec plain-tag ones, i.e. precisely the files carrying no layout information.
  Fix: the fmt parser resolves the real format from the SubFormat GUID (KSDATAFORMAT
  suffix verified), validates bit depth against the RESOLVED format, and reads
  `dwChannelMask` as the document's optional speaker layout — mask 0 is legal
  "unspecified" and stays absent; a mask whose bit count disagrees with the channel
  count is dropped rather than half-trusted; a truncated extension is rejected cleanly
  (decoding without the GUID would mean guessing int32-PCM vs float32);
  `wValidBitsPerSample` is advisory (valid bits are left-justified per spec, so
  container-scale decode is exact). No previously-openable file changes its decoded
  output — pinned by plain-tag-twin tests. Affects: `src/audio/wavCodec.ts`,
  `src/audio/decodeAudio.ts`, `src/services/fileService.ts`.
- **Convert Channels on a multichannel document silently kept only the front-left
  channel (R6).** Symptom: converting a 5.1 document to stereo produced dual-mono of
  channel 0 — the centre (on a film mix, all the dialogue), the surrounds and the LFE
  were discarded with no indication anywhere. That is data loss, not a downmix. Cause:
  `convertChannels`' stereo target predates multichannel documents and simply duplicated
  channel 0. Fix: the Convert Channels dialog performs a real downmix for >2-channel
  documents — by default the app's documented −3 dB fold, so every channel is
  represented in the output. (The historical duplicate-channel-0 behaviour survives only
  for API callers that pass no law, pinned by test.) Affects:
  `src/services/documentTools.ts`, `src/components/Dialogs/ConvertDialog.tsx`.

### Added

- **User-selectable surround downmix — ITU-R BS.775 (R6).** Why: the fixed fold treats
  centre, surrounds and LFE identically; the broadcast standard does not. How to use:
  `Edit → Convert Channels…` on a >2-channel document shows a "Surround downmix" select.
  **The default is unchanged** (the original −3 dB fold, byte-identical to before);
  BS.775 is **opt-in**: `L' = L + 0.7071·C + 0.7071·Ls`, `R' = R + 0.7071·C + 0.7071·Rs`
  (Rec. ITU-R BS.775-3 (08/2012), Annex 4 Table 2, 2/0 row; 0.7071 = 1/√2), with LFE
  discarded per the Recommendation (§5 Fig. 9, §7) and the output hard-clamped to ±1
  like every other render path. It **requires a known layout**: the option is enabled
  only when the file carried a speaker mask the matrix covers (5.1 back or side
  variants, 5.0, quad, 3/0, 2.1); an unknown or uncovered layout (7.1, height channels,
  inconsistent masks) falls back to the fold — and the dialog says which law is in
  force — because a wrong matrix misplaces content silently while a crude one is merely
  crude. Affects: `src/dsp/downmix.ts` (new), `src/audio/decodeAudio.ts`,
  `src/services/documentTools.ts`, `src/components/Dialogs/ConvertDialog.tsx`.

## [1.14.0] - 2026-08-09

**Every finalized WebM/Matroska file over 512 KB was silently playing at the wrong
speed** — that is this release's real headline, found while closing what looked like a
small format-variant gap (R5). If your `.webm`/`.mkv` imports sounded pitched-down or
slow, this is why, and it is fixed.

### Fixed

- **WebM/Matroska sniffing failed outright for ANY finalized file larger than 512 KB
  (R5).** Symptom: the file opened and decoded at 48000 Hz regardless of its real rate —
  wrong speed and pitch, with no error anywhere. Cause: the EBML walk carried a 512 KB
  byte cap, and `readEbmlElement` treats an element whose declared end exceeds the limit
  as parse doubt — so for any known-size Segment past 512 KB (i.e. essentially every
  *saved* `.webm`/`.mkv`; only sub-512 KB files and live-muxed unknown-size Segments
  ever worked) the **Segment element itself failed to parse** and the walk died at the
  top. The audit item had filed this as "deep `Tracks` unreachable"; Tracks depth was
  irrelevant. Fix: the byte cap is replaced by a per-level sibling-count bound
  (`EBML_MAX_CHILDREN = 65536` — the count-not-bytes shape `MP4_MAX_BOXES` established
  for size-driven walks; covers Tracks-after-Clusters layouts for 18+ hours of material
  while a hostile tiny-element flood stays microsecond-bounded, and zero-advance is
  impossible since every element consumes ≥ 2 bytes). Affects:
  `src/audio/sniffSampleRate.ts`.

### Added

- **Ogg FLAC and Ogg Speex sniffing (R5).** Why: `OggS` was recognised but only Vorbis
  and Opus first packets were parsed, so FLAC-in-Ogg and Speex files fell back to
  48000 Hz. Now the RFC 9639 §10.2 first packet (`0x7F FLAC`, with the inner `fLaC`
  marker also required) and the 80-byte SpeexHeader struct (rate at packet offset 36)
  yield the real rate.
- **Free-format MP3 sniffing (R5).** Why: `bitrate_index` 0000 (ISO/IEC 11172-3
  §2.4.2.3) has no bitrate-table entry and was skipped outright, so free-format streams
  fell back. A lone free header is indistinguishable from a stray sync byte, so one is
  accepted only when a second header with matching version/layer/sample-rate fields —
  itself free-format, protection bit ignored — confirms it within 2881 bytes, the
  longest frame the spec permits a free-format stream (Layer II, 160 kbps LSF table
  maximum, 8000 Hz, one padding slot).
- **Deep `moov` pinned as already handled (R5).** The audit listed MP4 files whose
  `moov` follows a large `mdat` (every non-faststart file) as unsniffable; verified
  false — the size-driven box walk always reached it. Pinned by test rather than
  "fixed", so the claim stays checkable. Genuinely unparseable layouts still fall back
  to 48000 Hz — the bounded, honest default — never an inferred guess.

### Closed without building (recorded with evidence so they stay closed)

- **P4-11, native Vorbis encoder: DROPPED, measured.** The shipped runtime's
  `AudioEncoder.isConfigSupported` reports vorbis **not supported** (mp3/flac/pcm
  likewise; only opus and aac encode), so WebCodecs cannot provide it and building it
  means implementing Vorbis I (MDCT, floor/residue codebooks) in TypeScript — a
  multi-week project. Legacy Ogg Vorbis continues to re-encode as Opus-in-Ogg, the
  deliberate modern default.
- **P4-12, legacy `.audm` partial-parse salvage: MOOT.** The legacy writer built the
  very same single JS string the reader decodes, so writer and reader hit the identical
  V8 string cap — an over-cap legacy session cannot have been produced by this app, and
  there is nothing to salvage. (v3 sessions are immune by construction.)

## [1.13.0] - 2026-08-09

**Measured before tuned** — this release builds the two measurement rigs the audit said
never existed, records honest baselines from them, and only then lands a detector
improvement whose every number is reproducible from the committed harnesses.

### Added

- **Tempo A/B bench (R4).** Why: the audit's long-quoted "63/91 correct" detector figure
  had no committed bank, harness or report behind it — unreproducible and unfalsifiable,
  so no detector claim could be checked. How to use: `node scripts/tempo-bench.cjs`
  runs a documented, deterministic 83-fixture bank (click/attack trains, drum loops
  across the ghost-note range, backbeats, tempo ramps, seeded humanly-jittered timing,
  no-tempo material; composition and seeds in `src/dsp/__fixtures__/tempoBench.ts`) and
  writes a timestamp-free JSON report that diffs byte-for-byte between runs
  (`--families`/`--limit-per-family` for subsets). The bank is a **new denominator**:
  its baseline measured **71/83 correct, 12 octave, 0 other** (committed at
  `docs/bench/tempo-bench-baseline.json`) — never comparable to "63/91". The harness is
  proven non-vacuous: deliberately broken detectors score strictly worse, and the
  generators were extracted verbatim into `src/dsp/__fixtures__/` so tests and bench
  share one definition.
- **First-play latency rig (R4, P2-7).** Why: the audit carried "the multitrack
  `AudioContext` sometimes starts slowly on first play" for months on suspicion — the
  v1.5.2 fix stabilised the smoke *test* (3 s poll) without ever measuring the
  behaviour. How to use: `node scripts/first-play-latency-rig.cjs` (after a build)
  drives the built app through cold/warm probes of `src/multitrack/firstPlayLatency.ts`.
  **The answer: measured, there is nothing to fix** — process-cold first play starts
  rendering 21.5–22.7 ms after `play()` returns (worst audible estimate 53.5 ms;
  `docs/bench/first-play-latency-baseline.json`), ~130× inside the old poll margin.

### Changed

- **Jitter-tolerant octave disambiguation (R4, the T2 reviewer's named follow-up).**
  Why: the period-match penalty charged full price for *zero-mean human timing jitter*,
  structurally favouring a machine-regular octave error over an honestly-played track.
  What changed: the penalty now decomposes into systematic offset from the requested
  period (the collapse signature — **kept at full weight**; mean-centring it away
  measured *worse* than changing nothing, 70/83) plus zero-mean scatter (benign jitter —
  down-weighted to 0.35, swept across 0–1 on the bank with a 0.15–0.5 plateau all
  beating the old form). Result on the committed bank: **71/83 → 74/83 correct, 12 → 9
  octave errors** — the flips are the jittered-human drum loop the item was about plus
  the two loud-ghost 90 BPM loops that had sat as a KNOWN-UNRESOLVED `it.failing` since
  v1.5 (now folded into the passing acceptance test). The 9 remaining misses are the two
  evidenced structural limitations documented in `chooseOctave`'s comment; the bank is
  synthetic, so this is not a real-world-material claim. `docs/KNOWN_LIMITATIONS.md`
  now cites the reproducible numbers.

## [1.12.0] - 2026-08-09

**Multitrack edits are now undoable** — the last structural gap in the session editor.
Before this release, `Ctrl+Z` after dragging a clip fell through to the last *document*
edit; now every session edit reverts: clip moves, trims, deletes and gain, fade and
crossfade edits (arm/release included), automation keys, track add/remove/rename, the
faders and toggles, spatial placements, recorded takes, and New Session itself.

### Added

- **Session undo/redo (R3).** Why: since v1.9 made overlap an invited gesture and
  v1.10/v1.11 added automation, ever more of the user's work lived in the one place undo
  could not reach. How it routes, plainly: **the session has its own history, exactly like
  each document has its own** — `Ctrl+Z`/`Ctrl+Y` in the **multitrack view** address the
  **session's** stack (no document needs to be open); in the waveform/spectral editors
  they address the **active document's**, unchanged. The History panel shows whichever is
  active. **One gesture is one undo step**: a trim or fade drag commits live on every
  pointermove, but the whole drag reverts with a single `Ctrl+Z` (pointerdown opens a
  transaction, pointerup commits exactly one entry); a recorded take across several armed
  tracks, an Arm/Release Crossfade (two fade writes) and a spatial drop (three parameters)
  are each one step; contiguous keyboard nudges on the same fader coalesce within a
  1-second window. **View state is never undoable**: scroll, zoom, cursor, playhead,
  selection and envelope-lane visibility create no entries — though undoing an edit
  restores the selection to the affected clip so the result is visible. The session keeps
  up to 50 steps in memory, like documents; Open Session and stem landing start a fresh
  history, and New Session is itself undoable. Entries are snapshot pairs of the
  immutable session state and retain **no audio** (a realistic snapshot measures ~8.5 KB
  of structural data; verified by a reachability walk, not asserted).

### Fixed

- **Redo of a clip/track removal left the clip's waveform bitmap (and its document
  channels reference) in the render cache.** Cause: the original remove actions purge the
  cache after their store write, but undo/redo swap whole state snapshots without
  re-running the action, so the purge never fired on the redo path. Fix: the undo
  apply-side re-derives the purge by diffing clip ids across the swap. Affects:
  `sessionStore.ts` (found while answering R3's snapshot-retention question).
- **No-op session writes no longer replace state.** Cause: `renameTrack`, `setTrackParam`,
  `addClip`, `setClipGain` and `setClipFade` rebuilt the session object even when an
  unknown id or an unchanged value (a blur without an edit) changed nothing — harmless
  before, but a noise undo entry once recording keyed on the state reference. Fix:
  reference-stable guards; content behaviour is identical. Affects: `sessionStore.ts`.

## [1.11.0] - 2026-08-09

One feature completes the outstanding-work list: the **spatial panner** — place each
track's sound around the listener in 3D (azimuth, elevation, distance), drag it live on a
positioner panel, and automate the position with keys on the timeline. The placement is
named for what it is: a **stereo projection** — amplitude panning plus distance level —
**not binaural** (no HRTF, no interaural delay), and the playback≡mixdown invariant holds
at v1.10's strongest tier across it: the live render is bit-identical to Mix Down even
while the position sweeps through the ±180° azimuth seam.

### Added

- **Spatial placement: a 3D position per track, automated on the timeline.** Why: pan
  places a sound on a line; the user asked to move sounds around the listener in 3D, with
  keys on the timeline. Three new automation parameters — **azimuth** (−180°..180°, 0 =
  front, positive = right), **elevation** (−90°..90°) and **distance** (0..10× a reference
  distance) — ride the v1.10 automation system unchanged: the same keys, per-segment
  curves, hold semantics, snapping, envelope-lane gestures and `.audm` persistence. How to
  use: the **Spatial** entry on the icon rail opens the positioner — a top-down stage
  (front = up) with the listener at the centre; drag the source to set direction and
  distance, the slider beneath for elevation. The panel follows the playhead (the dot
  moves with automation during playback), previews while you drag, and commits **once on
  release**, writing azimuth and distance keys together at the playhead; the three lane
  toggles open ordinary envelope lanes for timeline editing. What is shown during a drag
  is exactly what lands — including a not-yet-released elevation tweak, which rides the
  next stage commit.
- **The projection, stated plainly.** The audible placement is amplitude panning — the
  position's component along the interaural axis, `sin(azimuth)·cos(elevation)`, fed to
  the same per-clip pan laws pan automation uses — times the Web Audio inverse distance
  law (unity at or inside the reference circle, −6 dB at 2×, −20 dB at 10×). It is **not
  binaural**: a source behind the listener sounds like its mirror in front, elevation only
  narrows the image toward centre, and there is no interaural time difference (a
  time-varying delay is a resampling problem that produces Doppler artefacts unless
  carefully interpolated — omitted rather than approximated). Web Audio's built-in HRTF
  `PannerNode` was rejected because it has no offline equivalent: what you monitored would
  no longer be what Mix Down exports. The panel and the docs say all of this; the "Stereo:"
  readout shows the actual stereo position and level a placement produces.
- **Azimuth wraps the short way.** The azimuth circle's ±180° seam is a real musical
  decision: a segment between two keys always travels the **short arc** — keys at 170° and
  −170° sweep 20° *behind* the listener, never 340° back across the front. **To sweep the
  long way round deliberately, add an intermediate key along the intended path** (e.g. at
  0° for a front pass). Keys exactly opposite each other take the leftward arc (a fixed,
  tested tie-break). The seam is inaudible by construction (the projection is periodic);
  the envelope lane draws the numeric wrap as a vertical jump, which is the honest picture.
- **Parity, extended and measured.** Both engines compute spatial gains from one shared
  TypeScript function (position → projection → pan law → distance gain), baked exactly as
  volume/pan automation is. Measured in the built app against the real Web Audio engine:
  with volume and all three spatial lanes moving — azimuth crossing the seam, distance
  crossing the reference boundary — the live render is **bit-identical to Mix Down (worst
  error 0, 100 % of samples exact)**, anchored against independently computed law values.

### Changed

- **While any spatial lane has a key, the spatial position IS the track's placement** —
  the pan fader *and* a pan envelope are superseded entirely (the fader disables with an
  explanation naming the Spatial panel). Rationale: pan and spatial placement compute the
  same thing, and composing two placement laws would double-apply position; this is v1.10's
  override-not-offset ruling one level up. Remove the spatial keys and pan governs again.
  Byte-identical playback for every session without spatial lanes is pinned, as always.
- **`.audm` carries the spatial lanes at the same format version (3).** Additive optional
  keys on the existing per-track `automation` field — nothing else changed, so a spatial
  session opens in older builds with the lanes preserved-but-inert (the v1.10 mechanism),
  a session without spatial lanes stays byte-identical on disk, and hostile values from a
  hand-edited file are clamped or dropped at the parse boundary before either engine sees
  them.
- **The end-to-end smoke gains a spatial step**: a real positioner gesture against the
  built app (one drag → one batched commit of azimuth+distance keys, the pan fader's
  supersession title asserted from the real DOM), the seam-crossing bit-identity render
  measurement above with law anchors computed in the harness's own arithmetic (balance law
  for the stereo fixture, probes guarded off the tone's zero crossings), and a
  spatial-carrying `.audm` round trip.

### Known gaps

- Rear/elevation cues, ITD and HRTF are consciously out of scope for the stereo
  projection; the upgrade path (an HRTF backend behind the same position→gains interface)
  and the frozen-preview commit rule are documented with their reasoning in
  `docs/KNOWN_LIMITATIONS.md`.

## [1.10.0] - 2026-08-09

Three features close out the outstanding-work list: **automation keys** — timeline envelopes that make track volume and pan vary over time, the foundation for every future time-varying parameter — plus two effects, **Pitch Correct** (scale-snapped pitch correction) and **Remove Silence** (podcast pause tightening with exact marker remapping). Automation extends the playback≡mixdown invariant to moving parameters and lands it *stronger* than the fades did: the built app's live graph renders bit-identical to Mix Down across a moving envelope, exact to the last float32 bit.

### Added

- **Track automation: volume and pan envelopes on the multitrack timeline.** Why: every track parameter was a single static value over the whole session — no ride-the-fader mixes, and no foundation for the planned 3D panner, which needs keys on a timeline. A lane per (track, parameter) holds ordered keys `{position, value, curve}`; between keys the value interpolates through the same shared curve family the fades use (per-segment choice of Equal gain / Equal power / Smooth / Ducked; straight-line default), before the first and after the last key the nearest value is **held**, never extrapolated. **The lane governs**: while it has keys, it *is* the parameter — the header fader is disabled and its static value ignored (override, not offset: a drawn envelope means *that* to be the volume), and a lane emptied of keys hands back to the fader with the field removed entirely. How to use: the small activity toggle beside each header slider opens the track's envelope lane — click to add a key, drag to move it (snapping to the same beat/marker targets as every other timeline gesture; `Alt` suspends), right-click to delete, double-click to cycle the segment's curve. Editing during playback re-bakes just the affected track in place, live.
- **The parity invariant survives automation — bit-exact.** Cause: the realtime player's track volume/pan were live gain nodes, and browser AudioParam scheduling is render-quantum interpolated — it *cannot* be sample-identical to the offline mixdown, which is precisely why v1.9 baked its fades. Automation is therefore **baked** the same way, from one shared evaluator both engines call with the same timeline sample, in the same multiply order. A pan envelope on a mono clip promotes the *player's buffer* to two channels with the **mono** constant-power law's moving gains baked in — the clip stays mono and Mix Down still applies the mono law, so which law governs never changes (the one detail that could have silently changed how an existing session sounds). Measured in the built app against the real Web Audio engine: with both lanes moving, the live render is **bit-identical to Mix Down over the whole session — worst error 0, 100 % of samples exact** (v1.9's fades achieved ≤1 ULP inside crossfades; automation reaches exact because a baked envelope rounds once at the same point in both paths).
- **Pitch Correct** (`Effects → Time & Pitch`): scale-snapped pitch correction for a sung or played line. Why: the effect rack could shift pitch by a constant interval but not *correct* a drifting performance toward the notes it was aiming for. A YIN detector (measured on known-f0 fixtures: sub-cent on pure tones through the vocal range, no octave errors across every fixture) tracks the line frame by frame with an explicit voiced/unvoiced decision; each voiced frame snaps to the nearest note of the chosen **Key** and **Scale** (Chromatic / Major / Natural minor), **Strength** scales the correction (0–100 %), and **Retune Speed** smooths it (0 ms = instant snap, with a readout showing the smoothing corner frequency). The correction is applied as a *time-varying* generalisation of the constant Pitch Shift's two-stage design — variable WSOLA stretch, then a variable resampler reading the cumulative ratio map — sharing the same DSP modules, preserving inter-channel phase by construction, and restoring the input length exactly. Unvoiced frames and silence pass through untouched.
- **Remove Silence** (`Effects → Restoration`): tightens or removes the pauses in a spoken take. Why: cutting dead air by hand is the single most repetitive podcast edit. An envelope follower finds every run under **Threshold** lasting at least **Min silence**; each is either shortened to **Shorten to** or removed outright (keeping **Padding** on both sides), and every cut is spliced with a short crossfade so no click marks the join. **Markers survive exactly**: the effect reports each removed span and a new exact cuts-remap shifts every downstream marker by precisely the material removed before it — not the region's average ratio, which the audit measured misplacing markers by hundreds of milliseconds — and a marker *inside* a removed pause snaps to the splice point instead of being dropped, because podcast chapter markers live exactly there. Detection deliberately errs toward keeping speech: the envelope release means a pause is detected starting ~100 ms late, never early (documented with the arithmetic in `docs/KNOWN_LIMITATIONS.md`).

### Changed

- **`.audm` gains optional per-track automation lanes and the format version again does NOT bump.** Same reasoning as the v1.9 fade keys, same mechanism: the binary reader rejects on a version *equality*, so lanes ride as additive optional keys — absent means none, and a session that never touched automation is **byte-identical** on disk to what v1.9.2 wrote (pinned). An automation-carrying session opens in the shipped v1.9.2 build **and round-trips through it with the lanes intact** — verified against the real v1.9.2 installer's bundled reader and writer (recovered from the published release), not inferred: both its parse and serialize paths spread unknown track keys through untouched, so v1.9.2 carries the `automation` field as inert data and writes it back on save. A user who opens an automated session in v1.9.2 and re-saves loses nothing; v1.9.2 simply cannot edit or play the automation. The unknown-key spread tolerance is additionally pinned at track level in this build's suite (the mechanism's first track-level test). Lane data from disk is untrusted and re-normalised at the parse boundary on both the v3 and legacy paths — a hand-edited `value: 1e999` never reaches either engine's gain path.
- **No existing session changes how it sounds.** A session without lanes takes the literally unchanged pre-automation render branches in both engines — pinned byte-for-byte — and a zero-key lane is indistinguishable from no lane at all.
- **The end-to-end smoke gains an automation step**: real envelope gestures against the built app (add, drag, delete through the actual pointer path, with the fader-disable and field-absence asserted from the real store), the bit-identity render measurement above, and an automation-carrying `.audm` round trip.

### Known gaps

- While a track's envelope lane is open it owns that lane's pointer events (clips there pause until it closes); a governed parameter's fader is intentionally inert; and a mid-play automation edit re-bakes start-accurately, not sample-seamlessly. All three are deliberate and documented with their reasoning in `docs/KNOWN_LIMITATIONS.md`.

## [1.9.2] - 2026-08-08

A patch release closing five small review follow-ups from the v1.9.x audit trail — four code, one docs. Nothing here changes rendered audio: the auto-remix golden pin and the fade goldens are untouched.

### Fixed

- **Match Tempo's History entry read `Effect: Time Stretch`.** Cause: `effectRunner` hardcoded the undo label as `Effect: ${def.name}` and Match Tempo reuses the shared time-stretch effect, so History named how the work was done rather than what the user asked for. Fix: `runEffectOnSelection`'s trailing positionals became a `RunEffectOptions` object with an optional `label` override (an options object rather than a 5th positional, so a transposed `(extra, label)` pair cannot type-check silently); Match Tempo passes `Match Tempo`, every other effect still logs `Effect: <name>` (pinned), and the v1.9.1 no-op-with-markers path still logs only `Add Beat Markers`. Labels are in-memory only — never serialized into `.audm` — so the override cannot affect undo restore or session reload. The corresponding `docs/KNOWN_LIMITATIONS.md` section ("Match Tempo appears in History as `Effect: Time Stretch`", formerly "no further work planned") is resolved and was **removed**. Affects: `src/services/effectRunner.ts`, `src/services/tempoService.ts`, `src/components/Dialogs/EffectDialog.tsx`, `src/services/testHooks.ts`, their tests, `docs/KNOWN_LIMITATIONS.md`, `docs/USER_GUIDE.md`.
- **A near-vacuous float32-store assertion in the fades suite could not fail.** Cause: the probe sat at index 0 of a 3-sample exponential fade-out, where the gain is exactly 1 — the assertion held even if `applyFadeOut` wrote nothing, and every n=3 exponential gain (1, 0.25, 0) is unity-or-dyadic, invisible to store rounding. Fix, two rounds: moved to index 1 of a 4-sample ramp (gain (2/3)², non-dyadic, < 1), then the source changed to `fround(0.7)` — chosen by execution, because with `fround(1/3)` a pre-narrowed float32 gain (a gain LUT, the exact refactor the test exists to catch) still passed at both non-dyadic gains. Skip-the-write, keep-double-bits and pre-narrow-the-gain now each fail distinctly; all three mutation-verified red. Affects: `src/dsp/fades.test.ts`.
- **Two stale comments on load-bearing code.** (a) The remix golden test's header said print mode "skips the comparisons"; since v1.9's X1 hardening it prints the two fixture blocks and then deliberately throws so a stray `REMIX_GOLDEN_PRINT` can never read as a passing gate — the header now says so. (b) `writePathPolicy`'s trailing-strip doc claimed `\s` covers "ALL Unicode and control whitespace"; measured: U+0085 (NEL, `White_Space=Yes`) is NOT matched by `\s` (and U+FEFF is, despite `White_Space=No`) — the comment on the security-critical normalisation now states the exact class and why the NEL gap is non-exploitable (Windows canonicalizes away only {dot, U+0020} in those positions). Comment-only; no behaviour change. Affects: `src/dsp/remixRender.golden.test.ts`, `electron/writePathPolicy.cjs`.

### Added

- **The Fade dialog shows the ramp length in absolute time.** Why: `Length` is a % of the selection, and 50% of a 3 s selection is very different from 50% of 30 s — there was no way to see the seconds. How to use: open Effects → Fade; a `≈ m:ss.mmm` readout beside the Length field tracks the typed value and the live selection (it follows a re-select while the dialog is open), and falls back to the whole document when nothing is selected, exactly like Apply does. Built on a new optional, display-only `EffectParamDef.readout(value, ctx)` capability; it mirrors the effect's own clamp and rounding so the number shown is the number written, and every effect without a readout renders exactly as before (pinned). Affects: `src/effects/types.ts`, `src/effects/basic/FadeEffect.ts`, `src/components/Dialogs/EffectDialog.tsx`.

### Documentation

- **The outstanding-work audit (`docs/superpowers/plans/2026-08-07-outstanding-work.md`) now tells the truth as of v1.9.1.** It predated v1.7/v1.8/v1.9 and misled in four ways. The plan-verdict table gains the v1.7.0/v1.8.0/v1.9.0 rows (eleven plans, not eight); P1 (User Guide, beat-grid overlay, beat-grid-at-current-tempo, never-saved marker) and P3 (stems, beat grid + snapping, crossfades) are marked shipped with their releases and tags; P4-12 (legacy `.audm` salvage) is closed as **MOOT** — the legacy writer builds the identical single JS string the reader decodes, so an over-cap legacy file cannot have been produced by this app; and P4-13 records v1.9.1's security fix, noting the audit's "not exploitable" framing was disproven by measurement. Still-open items (P2-4, P2-5, P4-9/10/11, P4-14) were deliberately not re-scoped.

## [1.9.1] - 2026-08-08

A patch release closing four independent gaps found by an audit sweep of v1.9.0. The security fix leads; it and its class were **found by reading, then confirmed by execution** against the real `isWriteAllowed` — not inferred. No released build is known to have been exploited, and none is claimed safe by assertion: the bypass required a specific decorated path spelling reaching the write-policy gate, which the audit produced deliberately.

### Fixed

- **UNC write-policy fail-open on trailing dots and spaces (security).** Cause: `normalizeUncHost` stripped exactly **one** trailing dot, so a loopback-alias host wearing two-or-more trailing dots — or a trailing space, which Windows canonicalizes away identically — survived normalisation *unrecognised* and escaped the local-alias/admin-share refusal. Measured allowed at HEAD before the fix: `\\localhost..\music\x.wav`, `\\localhost...\music\x.wav`, `\\127.0.0.1..\music\x.wav`, `\\localhost \music\x.wav`, `\\127.1..\share\a.wav`, `\\<own-hostname>..\music\x.wav`. Treated as a **class** ("handles one, not N"), the same single-strip shape was present — and until now unmeasured — in the `$`-share test: Windows strips trailing dots/spaces from a *share* name too, so `\\NAS\C$.\evil.wav`, `\\NAS\ADMIN$..\evil.wav` and `\\NAS\C$ \evil.wav` resolved to the admin share while the bare `/\$$/` saw the dot/space and not the `$` — also allowed. Fix: a shared `stripTrailingDotsAndSpaces` (anchored `/[.\s]+$/`) applied to the host after the IPv6-bracket strip and to the share before the `$` test — deliberately wider than Windows' exact {dot, space} set, fail-closed. The IPv6 bracket strip (single-level, plus an independent alternate-data-stream colon gate) and the abbreviated-IPv4 parser were audited and found already correct — the abbreviated forms only leaked via the upstream host strip this fix closes. Affects: `electron/writePathPolicy.cjs`, `electron/writePathPolicy.test.cjs` (+24 pins across the 0/1/2/3-dot boundary, space, dot+space, host and share roles; the single-strip mutation turns 9 red).
- **A NAS literally named `UNC` was refused.** Cause: a dead `|| host === 'unc'` defensive arm in `isLocalAliasOrAdminShareUncPath` treated `\\UNC\music\take.wav` as a `\\?\UNC\...` extended-length re-entry. Fix: dropped that arm — the real re-entry shape is already rejected upstream by the device/extended-path checks, and the `'?'` arm is kept. Affects: `electron/writePathPolicy.cjs`.
- **`removeClip` stranded a partner's facing fade.** Cause: deleting one member of an armed crossfade pair ran no fade maintenance, so the survivor's facing fade stayed in place as a surprise solo fade — audible. Fix: snapshot the pre-overlap state *before* the clip is filtered out, then reuse the existing `maintainFacingFades` disarm pass (no bespoke logic). `removeTrack` needs no equivalent — crossfade pairing is intra-track, so a deleted track takes both members of every pair with it. Affects: `src/multitrack/sessionStore.ts`, `src/multitrack/sessionStore.overlap.test.ts`.

### Added

- **Lay the beat grid at the current tempo, without a stretch.** Why: a no-op ratio (target = source) was a dead end even with *Add beat markers* ticked — the tempo guard refused it and Apply stayed disabled — so seeding a beat grid at the existing tempo was unreachable. How to use: open Match Tempo, leave the target equal to the source, tick *Add beat markers*, and Apply now lays the grid. The `1e-6` no-op guard is deliberately kept (relaxing it would re-enable a real WSOLA pass at ratio 1.0, seaming the region and pushing a bogus stretch undo entry for users who did *not* ask for markers); instead a no-op-with-markers request routes to a new no-stretch marker path that reuses the already-ratio-1-safe marker pass and pushes only the *Add Beat Markers* undo step. Affects: `src/services/tempoService.ts`, `src/components/Dialogs/TempoDialog.tsx`.
- **A visible never-saved marker.** Why: a computed document (`Remix N`, Mix Down, a stem, a recording, File → New) prompts on close, but nothing in the UI said so — the Files panel's `*` and the Properties "Dirty" row read `dirty` only, so the prompt looked unprompted. How to use: a never-saved document now shows a small amber dot in the Files panel (with a "Never saved to disk" tooltip) and a "Never saved" row in Properties, both visually distinct from the dirty `*` — *dirty* means "has unsaved edits", *never saved* means "has no file on disk at all", and a document can be both. `hasUnsavedWork` is now exported and single-sources the close-guard predicate. Affects: `src/components/Panels/FilesPanel.tsx`, `src/components/Panels/PropertiesPanel.tsx`, `src/services/fileService.ts`, `src/App.tsx`.

## [1.9.0] - 2026-08-08

Crossfades and fade curves: every multitrack clip gains non-destructive, re-editable edge fades; same-track overlap becomes a deliberate, first-class edit that renders as a real crossfade; and one crossfade law — the correlation-compensated, level-preserving gain law proven in Auto-Remix — now serves both features from a single shared DSP module. Live playback and Mix Down apply bit-identical fade gains, verified end to end against the real Web Audio engine in the built app.

### Added

- **Non-destructive clip fades.** Why: fading a clip previously meant destructively editing its source document, which every other clip referencing that document then inherited. A clip's `fadeInSample`/`fadeOutSample` and per-edge curve are now clip *properties*, applied at render time — identically in the realtime player (baked into the source buffers, never AudioParam automation, so a seek cannot shift the envelope) and in the offline mixdown (applied per clip before the master sum, so the hard-clamp semantics are untouched). How to use: select a clip and drag the small square handles in its top corners (the top 10 px of each end belongs to the fade handle; edge trim keeps the band below), or type exact lengths in the Properties panel's Fades section. One clamp policy lives in one place: a fade can never exceed its clip, the two fades may meet but never cross, and the standing fade wins the room.
- **Crossfaded same-track overlap.** Why: v1.8's `moveClip` silently nudged an overlapping drop forward, so deliberate layering and DAW-style crossfading were both impossible. A drop now commits exactly where the preview shows it, and a drop that overlaps a same-track neighbour **arms the pair** — both facing fades are set to span the overlap — so the region renders as a genuine crossfade (X-shaped gain lines plus a width readout, drawn from the renderer's own resolved state so the picture cannot disagree with the audio). Moves and trims re-arm at the new width; **Arm**/**Release** in the Properties panel manage a raw overlap directly; **Ctrl held at the drop** restores the v1.8 forward-only nudge (also the precise butt-join affordance), surfaced by an in-clip hint while dragging. A crossfade fires only for a *canonical pair* — genuine overlap with a distinct outgoing side, no containment, no third clip intruding, and both facing fades spanning the overlap exactly; anything else renders as honest solo fades over a raw sum, so a recorded punch-in layered over a take is never silently reshaped.
- **A genuine constant-power crossfade option — and a curve set named by behaviour.** The clip curve picker offers **Equal power** (the default: holds the level when the two sides are different material), **Equal gain** (holds the level when both sides are the same material, e.g. a loop seam), **Smooth** (equal gain with eased ends) and **Ducked** (drops fast, returns late, a deliberate dip at the join). Through the pair law every curve choice is exactly level-preserving — the curve picks the *trajectory*, the law holds the power — so the classic "equal-gain dips 3 dB" trap applies only to solo fades, never to an armed crossfade.
- **The destructive Fade effect gains the Equal power curve and a ramp-length control** (`Length`, % of the selection; 100 % = the whole selection, byte-identical to v1.8.0 output — pinned by a golden fixture generated *before* the refactor). Its curve math now comes from the same shared `dsp/fades.ts` family as the clip fades.

### Changed

- **"Exponential" is now labelled "Ducked"** in both the clip fade picker and the Fade effect dialog. Cause: the shape is `t²` — quadratic — so the old name was wrong twice over (formula-named, and the wrong formula). The persisted curve id is unchanged; only the user-facing string moved. The clip picker uses summing-law names (Equal power/Equal gain) because a crossfade has two sides; the destructive Fade effect keeps **Linear**/**Cosine** because a solo fade over a selection has no second signal and no join, so a summing-law name would describe nothing — same underlying curves, deliberately different vocabulary, and no name that is factually wrong.
- **The auto-remix crossfade law was extracted to `src/dsp/fades.ts`** and generalised (`k = √(g0² + g1² + 2ρ·g0·g1)`, exact for any curve pair, reducing to the pinned expression on the equal-power path) so manual crossfades and Auto-Remix cannot drift apart. Auto-remix output is **byte-identical** across the extraction — pinned by a rendered-audio golden fixture (768-configuration grid verified: 0 diffs) plus a double-precision gain table, because a float32 audio pin alone is provably blind to sub-ULP gain-law errors.
- **`.audm` gains four optional per-clip fade keys and the format version deliberately does NOT bump.** Cause: the binary AUDM3 reader rejects on a version *equality*, so a bump would have made every v1.9 session unreadable in v1.8.0 and every existing `.audm` unreadable in v1.9 — a data-loss-class change in a ruling that asked for compatibility. With additive optional keys, absent keys read as "no fade", a fade-less save stays **byte-identical** to v1.8.0's output, and a fade-carrying session still opens in the shipped v1.8.0 binary minus the fades — verified against the actual v1.8.0 installer payload: the packaged 1.8.0 app opened a v1.9 fade-carrying session through its real Open Session flow with structure and overlap geometry intact and no fade UI, and the 1.8.0 bundle's mixdown of that session matched the raw-sum reference *exactly* (identical RMS and peak to the last double digit) while differing audibly from v1.9's crossfaded render — loaded, minus the fades, nothing silently applied.
- **No existing session changes how it sounds.** A pre-v1.9 session has no fade fields, so it takes the literally unchanged v1.8 render path — pinned byte-for-byte against a v1.8.0 reference mix, for overlapping and non-overlapping sessions alike. An overlap without exactly-spanning facing fades still raw-sums and hard-clamps exactly as before.
- **Playback/mixdown parity now extends to fades and is verified against the real audio engine.** The unit parity suite proves the player's scheduled graph and the offline mixdown compute identical envelopes; the end-to-end smoke then renders the real player graph through a real `OfflineAudioContext` in the built app and compares against `mixdownSession` — measured: **bit-identical outside the crossfade region, worst error 5.96e-8 (one float32 ULP) inside**, with law anchors computed independently of the app's own DSP.

### Documentation

- The User Guide gained **Clip fades and crossfades** — including the behaviours you cannot guess: Ctrl-at-drop vs Alt, why dragging a facing-fade handle dissolves an armed pair (Arm/Release are the managed path), when an overlap is honestly *not* a crossfade, the fade-handle/trim split on a selected clip's top corners, coinciding handles on very narrow clips, and the intruded-pair silence/revive rule — plus the curve-name mapping between the clip picker and the Fade effect.
- `docs/KNOWN_LIMITATIONS.md`: the v1.8 "overlap nudge outranks the magnet" limitation is **resolved** — a dropped clip commits where the preview shows it; the only preview/commit divergence left is the opted-in Ctrl nudge. Clip-edge snap targets remain absent; Ctrl-drag covers the butt-join in the meantime.
- The smoke suite gained a crossfade step (real pointer drag to overlap, arm/release/re-arm, `.audm` round trip, real-Web-Audio parity render with independent law anchors, and the Ctrl-nudge disarm), backed by new scalar test hooks (`setClipFade`, `getClipFadeState`, `armCrossfade`, `releaseCrossfade`, `renderSessionWebAudio`).

## [1.8.0] - 2026-08-08

The beat grid becomes visible and magnetic: the tracked beats are drawn as tics along the bottom of the waveform and spectral editors and on every multitrack clip, and the cursor, selection edges, clip drags and clip trims snap onto them. Nothing new is computed — `analysis.beatSamples` has held real, per-beat tracked positions since v1.5; v1.8 draws them and edits against them.

### Added

- **Beat tics on the waveform and spectral editors (`View → Toggle Beat Grid`).** Why: *"better than just BPM, the beat is not always constant in a song."* The positions come from the Ellis dynamic-programming tracker with per-beat sample refinement, so the tics follow a take that drifts (measured during v1.5: 7.7 ms worst-case error where a rigid BPM grid was off by 1455 ms) instead of being extrapolated from one number. One band at the bottom of the canvas whatever the channel count — the grid is a property of time, not of a channel — 9 px tall, drawn after the spectrogram raster is blitted so it can never freeze at a stale zoom. Nothing is drawn until an analysis is actually cached: reading the grid never starts one, so opening a file still costs nothing. How to use: run `Effects → Detect Tempo`, and the tics appear; `View → Toggle Beat Grid` turns them off (they ship on).
- **Beat tics per multitrack clip, mapped through the clip's own trim and sample rate.** Source-sample `b` draws at `clip.startSample + round((b − clip.offsetSample) × sessionRate / docRate)`, clipped to the clip's half-open extent, so a rate-mismatched or start-trimmed clip keeps its tics glued to the audio it actually plays. The band is a separate overlay pinned to the clip element's bottom edge, never the clip's own waveform raster — that raster is capped at 4096 device px and blit-stretched across the clip's width, which is right for an envelope and fatal for a position. The overlay's backing store is 1:1 with its CSS size (measured in the smoke: 1206 device px for 689 CSS px at dpr 1.75) and is rasterised only over the slice of the clip that can be on screen, so a 50-million-pixel-wide clip still allocates a viewport-sized canvas.
- **Snapping — "the magnet" (toolbar magnet button, `View → Toggle Snap to Grid`, hold `Alt` to suspend).** Why: *"make the bar be able to magnet on those tics."* Cursor placement, the moving edge of a selection, clip drag and clip trim quantise onto the nearest target within **8 screen pixels** — a pixel tolerance, not a sample one, because a fixed sample tolerance is unusable across zoom levels. Targets are the tracked beats and the markers; in the multitrack they are every *other* clip's mapped beats and markers plus the session cursor (a clip cannot snap to its own grid — that is a no-op by construction). `Alt` is read on every pointer event rather than latched at pointer-down, so it suspends the magnet mid-drag and resumes on release; it was verified free against the built app (the Electron default menu is still installed, but the window is frameless, so there is no menu bar for `Alt` to steal). The snap engine is a pure function of (position, targets, samples-per-pixel, tolerance) with a binary search over the targets — it runs on every `pointermove`, and it never mutates the analysis cache's shared `Int32Array`.
- **Stems inherit their source's beat grid** instead of each being analysed on their own. Two reasons, the second decisive: the tempo cache holds four documents, so five stems plus their source would thrash it on exactly the workflow this feature exists for; and analysing a bass stem alone can land on a different (or half-time) tempo, which would draw five disagreeing grids for what is musically one grid. A stem records its parent's id at landing, and the grid resolves through it — an identity copy, since stems are sample-identical to the parent. Closing the source **detaches** rather than erases: the child keeps a copy of the beat positions (~2.4 KB for a five-minute track, against the ~105 MB the close exists to free) and reports that its origin is gone. `Remix N` documents deliberately do **not** inherit — a remix's samples are a *rearrangement* of the parent's bars, so the parent's beat positions do not describe the remix timeline at all, and drawing them would invent beats the DSP never measured there. A remix gets a real grid the ordinary way, by detecting tempo on the remix itself.

### Changed

- **Bar lines are drawn only when a metre was genuinely measured, and an ordinary Detect Tempo does not measure one.** The plan called for bar lines to be visually distinct from beats; the implementation survey overturned it on a fact: `barBoundary` / `downbeatPhase` / `beatsPerBar` exist only on a `level:'remix'` analysis, which only the Auto-Remix dialog produces. Every ordinary path — the Properties panel, `Effects → Detect Tempo`, the test hook — produces a tempo-level result carrying `beatSamples` and nothing else. So beats are the deliverable and are always drawn; downbeats are an enhancement, drawn taller and brighter only when a remix-level analysis genuinely returned a well-formed metre, and `beatsPerBar` is read as data rather than assumed to be 4. The alternative — manufacturing bar data from stubbed features — would have published a downbeat the DSP never produced into the cache Auto-Remix then plans against. Nothing here can do that: the drawing path does not import the feature deriver at all.
- **A stale or low-confidence grid is drawn provisionally rather than as fact.** The same two conditions that put `*` (stale) and `?` (below `CONFIDENCE_LOW = 0.35`) on the status pill's tempo readout make the tics dimmer and dashed — dim *and* dashed, so the signal survives a colour-blind or dimmed display. The geometry does not move, so a grid going stale does not shift the tics; it only stops claiming to be right. With no cached analysis nothing is drawn at all.
- **At extreme zoom-out the tics thin instead of filling in.** At maximum zoom-out a five-minute track at 120 BPM collapses to ~600 beats over ~50 CSS px — 0.08 px apart, i.e. a solid amber block that says nothing. At most one tic is drawn per 3 CSS px, which turns that back into a legible ~17-tic ruler. It is a *pixel* rule, not a "every 4th beat" rule, so it needs no `beatsPerBar` (which usually does not exist) and can never lie about metre; at any working zoom it never fires.
- **Snap runs before the store's overlap nudge, and the consequence is stated rather than hidden.** The magnet is a user-intent transform in screen space (only the gesture layer has the zoom and the pixel tolerance); `moveClip`'s overlap nudge is a validity transform in sample space (only the store knows the other clips on the track). Intent first, validity second is the only order that cannot produce an invalid result — so when the nudge fires, the committed clip start is *not* a snap target. Clip drag is previewed by a CSS transform and committed through the store, and both derive from one function, so the preview shows the snapped position and the clip does not jump on drop.

### Fixed

- **The stem realtime benchmark could fail a routine `npm test` because the machine was busy, not because the code was slow.** Cause: `electron/stemIntegration.test.cjs` asserted `>= 1×` wall-clock realtime on every run, guarded by a CPU-quiescence wait taken *before* each attempt — but an attempt takes ~20 s, so load arriving mid-run contaminated the measurement the wait existed to protect, and the "at least one quiet attempt" flag then forced the assert onto the contaminated number (observed: 0.86×, 0.84×, 1.08× on three consecutive attempts). Fix: correctness and performance are gated separately. The correctness assertions — four stems in order, exact tiling, all finite, none silent, progress per segment, RMS/residual/peak-RSS reported — always run. The wall-clock assertion is now explicitly opt-in via `STEM_INTEGRATION=1` and is otherwise **reported, never silently dropped**. The gate itself is unchanged at `>= 1×` and, under the opt-in, is now asserted unconditionally (the auto-skip is gone), so that path is stricter than before. The speed claim was already measured on a quiescent machine and is recorded here (P0 1.52×, the shipped host 1.57×); re-asserting it on every routine run measured the machine's current load rather than this code. Affects: `electron/stemIntegration.test.cjs`.

### Documentation

- The User Guide gained **Seeing the beat grid** and **Snapping to the grid (the magnet)**.
- `docs/KNOWN_LIMITATIONS.md` records what the grid does and does not promise: beats follow a drifting take because they are tracked rather than extrapolated; bar lines need a remix-level analysis; the grid stops at the analysed end on files longer than the 10-minute analysis cap; the tempo cache's four rows evict in insertion order, so a displayed grid can vanish when a fifth document is analysed; and snapping targets beats, bars and markers but not clip edges.

## [1.7.0] - 2026-08-07

Stem separation: `Edit → Separate into Stems…` splits the active document into **Drums, Bass, Vocals, Other and a Residual**, lands the five as documents in a new five-track multitrack session, and guarantees that mixing that session down reproduces the original **sample for sample**. This is the app's first ML/native dependency (`onnxruntime-node`, CPU only, in an isolated `utilityProcess`); everything else stays pure-TypeScript DSP, and the model is downloaded on demand rather than bundled.

### Added

- **Stem separation (`Edit → Separate into Stems…`).** Why: the request was to isolate every instrument, remix by instrument, *without polluting one instrument with another and without removing any sound*. Those are two different kinds of promise and the feature treats them differently, in the UI as well as in the code:
  - **"No sound removed" is a hard guarantee, exact by construction.** The neural model's raw waveforms are never shipped as stems. They are used only to build Wiener-style ratio masks (`mᵢ = |Sᵢ|²/(Σ|Sⱼ|²+ε)`, clamped so `Σmᵢ ≤ 1`) over the **original document's** STFT, at the document's own sample rate; the four stems are the masked iSTFT (COLA-satisfying Hann², hop N/4, measured COLA sum 1.5), and the **Residual is the time-domain complement** `mix − Σ stems` — a single subtraction, not a fifth mask. Measured through the real `mixdownSession`, the untouched landed session reproduces the source with worst |error| **exactly 0** and **100.0000 %** of samples bit-identical, for stereo *and* mono sources at both 44.1 kHz and 48 kHz. That is an acceptance test (unit and end-to-end smoke), not a hope; moving the Residual off the last track breaks it (5.2e-7 @ 44.1 kHz, bit-exact 100 % → ~73 %), which is why the track order is load-bearing.
  - **"No pollution" is a quality target bounded by the model, and is worded that way.** Bleed between stems is a limit of the separation, not a defect; the dialog says so in every state, and the audible evidence is the per-stem audition plus the visible Residual track. On the reference track the raw model residual measured −45.4 dBFS, i.e. **−31.9 dB below the mix**.
  - How to use: open a file, `Edit → Separate into Stems…`, download the model once (166 MB), press **Separate**, watch the per-segment progress (or **Cancel**, which kills the inference process outright), and land in the multitrack view with five tracks.
- **On-demand, checksum-pinned model download.** Why: the 166 MB HT-Demucs ONNX export is larger than the whole app and most users will never ask for stems, so bundling it would have taxed every download for a feature nobody had opted into. The file is fetched on first use to `userData/models/htdemucs_fp16weights.onnx`, verified **in memory** against sha256 `d05c269d…db70a` and its exact size (165,612,636 bytes) before an atomic temp+rename commit, and **re-verified from disk before every load** — a corrupt or truncated file is deleted and re-downloaded, and the inference process is not even spawned on a mismatch. Downloads retry three times with backoff, refuse an over-size response before reading a body byte, and report offline failure inline instead of leaving a broken state.
- **A separation is a first-class long job.** Per-segment progress with a time estimate from the measured rate, a Cancel that kills the utility process (returning its ~5 GB immediately), busy-integration with the close guard, and a staleness discipline that aborts cleanly if the source document is edited or closed mid-run — stems are never delivered for audio that changed. Quitting mid-run leaves no orphan process.

### Changed

- **Inference runs on `onnxruntime-node`, CPU execution provider, inside an Electron `utilityProcess` — and the GPU path is deliberately absent.** Why, measured on this machine (RTX 3080 Laptop, 16 GB VRAM) over 30 s of real material: **CPU 1.52× realtime** at 5.0 GB peak (re-measured in the shipped host at **1.57×** / 5,068 MB); **DirectML disqualified** — the first 7.8 s segment never finished, the run was killed at **708 s** with 20.8 GB host and **15.7/16 GB of VRAM** consumed; **onnxruntime-web wasm 0.20×**, and only with graph optimisation disabled (`'all'` dies at session creation with `std::bad_alloc`). "GPU present" is not "GPU usable" for this graph, so there is no DML code path to fall back to, and no DirectML DLL in the package (which also cut the installer by **58.8 MB, −35.5 %**, to 106,896,907 bytes). The renderer never loads onnxruntime: the 5 GB peak lives in a process that can crash or be killed without taking the editor with it.
- **Separation is capped at 15 minutes of audio**, derived from a measurement rather than a guess: renderer RSS during the mask/complement pass grows **4.4 MB per second of audio** (measured 15 s → 516 MB, 30 s → 584 MB, 60 s → 716 MB, i.e. 264 MB per minute), so 15 minutes is the point where the renderer alone would approach 4 GB while the inference process holds its own 5 GB. The utility process keeps an outer 30-minute bound of its own; from the renderer that bound is unreachable, and the refusal the user sees quotes the 15-minute limit that actually applies.
- **A mono source's stems land as dual-mono stereo documents.** Why: `mixdownSession` picks its pan law from the clip source's channel count, and the two-channel law is *exactly* unity at centre while the mono law is `cos/sin(π/4)` — measured, a mono routing reconstructs with 0.196 absolute error (−14.1 dBFS) with no compensation, and still only 97.47 % bit-exact with the exact inverse +3.0103 dB fader, because `(x·g)·g_L` rounds twice. Dual-mono makes the mono path *the same arithmetic* as the stereo path, so the guarantee holds by construction with every track parameter left at its default. Cost: a mono source's five stems occupy what a stereo source's already do.
- Stem documents, like every other computed document, are protected by the new `neverSaved` flag (below) — closing one, or quitting with one open, prompts rather than discarding.
- Attribution added to the README: **HT-Demucs** (Meta AI, MIT) and the **StemSplitio** ONNX export.

### Fixed

- **Computed documents closed silently, losing work that had never been on disk.** Cause: `Remix N`, Mix Down output, recordings and File > New documents are created with `createDocument` + `addDocument` and inherit `dirty: false`, so `closeDocumentFlow` closed them without asking and the quit guard — which counted only dirty documents — discarded them on exit. Stamping `dirty: true` at creation would have looked like a fix and not been one: `undoHistory` re-derives `dirty` from the undo position relative to the save point, so the flag would silently clear itself on the first Ctrl+Z. Fix: documents carry a second, independent flag, **`neverSaved`**, recording provenance rather than edit state — set by default whenever there is no `filePath`, cleared only by a successful save (a cancelled dialog, a failed write and a staleness-rejected save all leave it set), never touched by undo/redo, and consulted alongside `dirty` by both the close flow and the quit guard. A session save deliberately does *not* clear it: `.audm` embeds only clip-referenced documents, so clearing there would un-guard exactly the documents the file does not contain. Affects: `src/audio/AudioDocument.ts`, `src/services/fileService.ts`, `src/App.tsx`, `electron/closeGuard.cjs`. This is the defect stem separation would otherwise have inherited five times over per run.

### Documentation

- The User Guide gained the walkthroughs it was missing: **Separate into Stems**, and — a gap since v1.5 — **Detect Tempo**, **Match Tempo** and **Auto-Remix**.
- `docs/KNOWN_LIMITATIONS.md` records the stem-separation entry: model-bounded bleed, the exact-sum guarantee and the one condition it carries (a source peaking above ±1 is detected and reported, not silently reconstructed wrong), the 15-minute cap, dual-mono stems, and the CPU-only rationale.

## [1.6.0] - 2026-08-07

Full-app visual rework into the "Glass · Sectioned" design language shared with Vitrine (`photo_app`), from a user-approved mockup. Why: the two apps are a family and should look like one. This is a visual-language port, not a redesign: **zero features added or removed**, and every menu command, keyboard shortcut, dialog flow, DOM event contract, `data-testid` and aria-label is unchanged — the 1,824-test suite and the end-to-end smoke are the regression harness and pass throughout (two styling-only colour assertions were updated with the accent move, nothing else).

### Changed

- **The whole UI sits on glass surfaces over a radial near-black stage.** Design tokens (glass surfaces, blur, borders, shadows, text and radius scales, the canvas radial) are ported verbatim from Vitrine's `src/index.css`; components mirror Vitrine's Layout anatomy. The accent stays Auditorium cyan `#26c6da` (user-approved in the mockup) and everything derives from tokens, so a one-token flip to Vitrine blue remains possible. No new dependencies. Affects: `src/index.css`, new `src/components/UI/glass.tsx` primitives, every Layout/Panel/Dialog component.
- **Both sidebars became a right-edge icon rail + floating glass cards.** The 240 px left column (Files/Effects) and the 280 px right tab strip are gone; all six panels — Files, Effects, Markers, History, Properties, Remix — open from one vertical icon rail into a floating 348 px card column, with a persistent TEMPO card (BPM readout, structure strip, ×2 / ÷2 / Re-detect) above the panel card whenever the active document has a cached analysis. Behaviour note: Files and Effects are no longer always-visible; nothing functionally required them to be (no drag-drop targets exist, and the open flow never focused a panel).
- **The bottom transport bar was retired into two floating chrome pills.** File ops, transport (plus a Go to Start button), the view segment and a new zoom cluster (− / % / + / Fit, driving the existing wheel-zoom state with the wheel's own factor and clamps) sit in a top-centre toolbar pill, with a file chip (name · duration · rate · channels · zoom) top-left; the prominent time readout and the level meters moved into the floating bottom status pill alongside its existing readouts. Every command id, shortcut, enabled-state rule and aria-label carried over verbatim.
- **Window chrome went glass**: frameless titlebar with the ◈ AUDITORIUM wordmark, chrome-styled menus, and lucide window buttons (the close button's Windows-red hover became Vitrine's subtle white hover). The close path still routes through the close guard — window buttons never bypass the unsaved-changes prompt.
- **All seven dialogs sit on one glass DialogShell** — radius-20 card on a blurred scrim, icon-tile header with title/subtitle, uppercase section labels, glass fields/sliders, accent primary buttons. Escape/backdrop/busy-veto semantics and every testid are untouched. Native OS dialogs (save/close prompts, error boxes) are unchanged — they cannot take glass styling.
- **The editor canvas became the stage.** Waveform/spectral lanes and multitrack track rows float as rounded, inset-ring cards over the radial background; the timeline ruler is muted chrome text. Selection is now accent-soft with ring edges, and the playhead is accent with a soft glow in every view — the multitrack playhead moved from yellow to accent to match. Canvas drawing code (peaks, spectrogram, markers) is untouched beyond routing colour constants through the tokens; markers keep their amber, the cursor stays white.
- **Icons are lucide line icons throughout** — remaining emoji/unicode glyph controls (✕ ◂ ▸ 📌 ⏮ ▶ ⏺ ⟲ …) were swept to their lucide equivalents. Notation readouts are deliberately kept as text: the `♩ BPM` readout, the `*` stale and `?` low-confidence markers, and the `●○` confidence meter.
- **Scrollbars app-wide are the 6 px Vitrine thin style** — the ported scrollbar CSS is global by nature, so every panel and dialog list scrollbar changed with it.
- Hero screenshots (`docs/screenshot.png`, `docs/screenshot-spectral.png`) recaptured from the running v1.6 app, staged with the synthetic ABAB fixture; README and User Guide prose updated where it described the old anatomy (left/right sidebars, tab strip, bottom transport bar).

## [1.5.2] - 2026-07-28

Deferred-fixes release: the audit findings deliberately carried out of v1.5.0/v1.5.1, fixed in one pass. No feature changes.

### Fixed

- **Multitrack clip waveforms allocated canvases as wide as the whole clip.** Cause: `ClipView` sized both its on-screen canvas and the cached offscreen bitmap to the clip's FULL timeline pixel width — ~7.6 MB per clip at default zoom, ~30 MB at 4× — and the offscreen copies were retained 200-deep by the module LRU. Fix: the raster is capped at 4096 device pixels and blit-scaled across the clip's CSS width; the envelope still spans the clip's whole sample range, so alignment is exact at every zoom and only sub-column detail (invisible beyond any real viewport) is lost. The cache key is unchanged. Affects: `src/components/Multitrack/ClipView.tsx`.
- **Playing in Spectral view re-rasterised the whole spectrogram every frame.** Cause: the paint effect's deps include `playback.positionSample` (the playhead overlay must move), and each paint called `createImageData` and re-ran the full per-pixel LUT pass — a 0.5–2 GB/s allocation transient during playback. Fix: the rendered raster is cached in a ref keyed by (magnitudes identity, backing size) and blitted per paint; the playhead is drawn as an overlay on top, and only new data or a resize re-rasterises. Affects: `src/components/Editor/SpectrogramView.tsx`.
- **`dialog:*` IPC handlers forwarded renderer-supplied opts unvalidated into native OS dialogs.** Cause: `showOpenDialog`/`showSaveDialog`/`showMessageBox` received the renderer's opts object as-is, so a compromised renderer could render arbitrary text in real OS chrome (and steer open-dialog `properties`). Fix: shapes are validated at the trust boundary — message type from an allow-list, buttons/filters bounded arrays of the expected primitive shapes, strings length-capped (truncated, never rejected, so a long error message still produces its dialog), unknown keys dropped by construction. Every legitimate call-site shape passes through intact. Affects: `electron/ipc.cjs`.
- **The WAV `LIST`/`adtl` label map was uncapped.** Cause: `decodeWav` inserted every `labl` sub-chunk into a Map before any cue point was consulted, so a crafted ~100 MB chunk could grow it to ~8 M entries. Fix: capped at the first 10 000 by position, never throwing — the same pattern as id3Chapters' 255-entry CTOC cap; a cue point whose label fell past the cap degrades to the existing "Marker N" fallback. Affects: `src/audio/wavCodec.ts`.
- **NTFS alternate-data-stream write targets passed the path policy.** Cause: `C:\x\evil.exe:payload.wav` names an ADS on `evil.exe`, but `extname` sees `.wav`, so it passed the extension check and both policy stages; the write then failed EINVAL at the atomic rename — after the temp-file create had already materialised a 0-byte `evil.exe`. Fix: any `:` past the drive-letter position (index 1) of the resolved path is rejected; the drive colon itself and colon-free UNC paths are untouched. Affects: `electron/writePathPolicy.cjs`.
- **`analyzeTempo` hung forever for `minBpm <= 0`.** Cause: the tempo-candidate grid is multiplicative (`bpm *= 1.005`), so a non-positive `minBpm` never advances. Latent — every in-app caller passes the 60/200 defaults — but `AnalyzeTempoOptions` is exported. Fix: a non-positive or inverted BPM range throws a `RangeError` at the entry point, before any content-based early return. Affects: `src/dsp/tempoCore.ts`.
- **Smoke step 6b was flaky on a cold first run.** Cause: `multitrackLiveParamCheck` sampled its two playhead positions across one fixed 400 ms window, which sometimes elapsed before the player's `AudioContext` had started (`{advanced:false, pos1:0, pos2:0}`), passing on re-run. Fix (test harness only, app playback untouched): poll up to 3 s for the transport to demonstrably advance, then settle 150 ms (10× the 15 ms param-ramp time constant) before sampling — the assertions are unchanged in strength, and the volume-gain read now always lands past the ramp. Affects: `src/services/testHooks.ts`.

## [1.5.1] - 2026-07-28

Platform release: Electron upgraded four majors. No feature changes.

### Changed

- **Electron 39.8.10 → 43.3.0.** Why: Electron supports its latest three majors, so 39 had aged out of the support window and was no longer receiving Chromium security backports — the largest standing exposure for an app that opens untrusted audio files. The full gate (1686 unit tests, typecheck, production build, and the end-to-end smoke against the packaged app — including all three v1.5 tempo/remix steps) passes unchanged on 43.
- Behaviour note inherited from Electron 43: an **Open dialog with no explicit starting directory now opens in Downloads** rather than the OS's last-used location. Save dialogs are unaffected (they already receive an explicit default path).
- Dev note inherited from Electron 42: `npm install` no longer downloads the Electron binary via postinstall; it is fetched on first launch (`npx electron --version` warms it for CI or a fresh clone).

### Fixed

- **Smoke runs no longer leave an Electron window that has to be closed by hand.** Cause: on teardown — and especially on a mid-run failure with a dirty document — the close guard showed its native Quit/Cancel prompt, which blocked `app.close()` forever in a run with nobody at the console, and also hid the failure's error text until the app was killed manually. Fix: in test mode (the same gate as the renderer test hooks) the guard destroys the window instead of asking, and the smoke's teardown force-kills the process if a graceful close hasn't completed within 10 s. Packaged behaviour is unchanged — the prompt still protects real users. Affects: `electron/closeGuard.cjs`, `electron/main.cjs`, `scripts/e2e-smoke.cjs`.

## [1.5.0] - 2026-07-27

Three new opt-in capabilities built on one shared beat-tracking core: tempo detection, tempo matching, and auto-remix. Everything is pure TypeScript — no new dependencies — and every heavy pass runs off the main thread.

### Added

- **Tempo detection.** `Effects → Detect Tempo` analyses the active document and the status bar (`♩ 124.0`) and the Properties panel's **Tempo** row report the result with its confidence. Why: three separate features needed a beat grid, and computing it three times — or computing it on open, for every file, whether or not anyone asked — was the wrong trade. One shared cache (keyed on channel identity, four documents deep) serves all of them, and opening a file still costs nothing: detection is explicit. The pipeline decimates to ~11 kHz with a triple-cascaded boxcar, takes a 24-band log-spectral-flux onset envelope, picks the period by harmonic comb plus a log-Gaussian prior with a beat-salience octave vote, then tracks real beats with an Ellis dynamic-programming pass and refines each one to the sample. Because the beats are *tracked*, not extrapolated from a rigid grid, the result follows a drifting take instead of walking away from it. Confidence is a **content** gate, not a correctness one — measured across 91 fixtures it reliably refuses material with no tempo at all, but it cannot detect an octave error (a 60 BPM loop misread as 120 scored the highest confidence in the whole bank), so the readout and both dialogs carry **×2 / ÷2** buttons that re-track the grid at the corrected period rather than merely relabelling the number. How to use: `Effects → Detect Tempo`, then read the status bar; press ×2 or ÷2 if the octave is wrong.
- **Match Tempo.** `Effects → Match Tempo…` retargets a selection (or the whole document) from a source BPM to a target BPM, or to a plain ratio. Why: "make this 128 BPM loop sit in a 124 BPM track" previously meant computing the percentage by hand and typing it into Time Stretch. The dialog prefills the detected BPM, offers **Re-detect from selection** so the displayed number always describes the audio the ratio will be applied to, shows which quality band the resulting stretch falls in (transparent / good / extreme), and can lay down a beat-marker grid at the new tempo as a separate, separately-undoable step. It runs through the existing WSOLA `Time Stretch` effect and the single `applyEdit` write path, so markers remap proportionally and undo behaves exactly as it does for any other effect. How to use: select a region (or nothing, for the whole file), `Effects → Match Tempo…`, confirm the source BPM, enter the target, Apply.
- **Auto-Remix.** `Edit → Auto-Remix…` rebuilds a track to a requested length by re-arranging its own bars, and writes the result to a **new** `Remix N` document. Why: shortening a song to fit a video, or stretching a loop to fill a slot, is otherwise manual splice work — and doing it by time-stretching wrecks the material. Remix instead cuts and repeats on real bar lines: it derives bar boundaries from the tracked beats, describes every boundary by timbre, chroma, loudness and local rhythm, clusters those descriptors into sections, and runs a 2-D lattice dynamic program that picks the cheapest arrangement reaching the target. Joins are constrained to phrase congruence (`from ≡ to (mod Φ)`, Φ = 8 by default) so cuts land at the top of a phrase, are micro-aligned by ±10 ms normalised cross-correlation, and are crossfaded with a `k = √(1 + 2ρ·g₀·g₁)` gain law that is provably power-preserving at every measured correlation — and length-neutral, so the output length is an exact consequence of the plan rather than an approximation of it. The source document is never modified. How to use: `Edit → Auto-Remix…`, confirm the tempo and downbeat, set a target length, `Create Remix`.
- **Remix panel** (the fourth right-sidebar tab). Why: no cost function models lyrics or phrasing, so some join will eventually be musically wrong even at a low score — the fix has to be a control, not better tuning. Each splice gets a row with a cost-coloured quality dot (tooltipped with all six cost terms), **Go To** (moves the cursor to the splice and switches out of multitrack view so it is never a silent no-op), **✕ Reject** (forbids that join for good and re-plans another way to hit the same length), **📌 Pin** (max 8), **◂ ▸ Nudge** (moves an edit one bar earlier/later in the song without changing the output length), plus **Re-roll**, **Revert to auto**, and a global crossfade slider that re-renders without re-planning. Adjustments go through `applyEdit`, so they appear in the History panel and step back with Ctrl+Z.

### Changed

- The Properties panel gained a **Tempo** row, and the status bar a `♩` BPM readout; both mark a stale grid (`*`) and a low-confidence detection (`?`) rather than presenting a bare number as authoritative.
- Closing a document now also drops its cached tempo/remix analysis and any remix session derived from it, so a closed file's audio is not retained by the analysis cache.
- Whole-document analysis is capped at `MAX_ANALYSIS_SECONDS = 600`; past that the result is flagged `truncated` and reported as "first 10 min" rather than silently describing a prefix.
- New known limitations recorded in `docs/KNOWN_LIMITATIONS.md`: the remix document's `dirty: false` close behaviour, the two-undo-entries-per-adjustment contract, the fixed/constant-tempo assumptions, and the `Effect: Time Stretch` History label for Match Tempo.

### Fixed

Found by a pre-release audit pass (security, dependency hygiene, and memory/unbounded-growth sweeps run independently against the finished feature work).

- **Analysis allocated the whole file when it only ever reads the first 10 minutes.** Cause: `monoSnapshot` built and transferred a full-length mono copy, while the worker truncates to `MAX_ANALYSIS_SECONDS` internally — a 2-hour stereo document allocated ~1.27 GB to analyse 105 MB of it, and every ×2 / ÷2 press re-paid it for a ~50 ms operation. Fix: clamp the snapshot to the bound the analysis actually uses (plus one sample, so the `truncated` flag still fires). Affects: `src/services/tempoAnalysis.ts`.
- **A stale remix session stranded a live worker thread.** Cause: when the source audio changed, the session was flagged stale in place and never released — retaining the source channel arrays (~105 MB), the analysis, and its plan worker, permanently, even though every adjustment then refused. Fix: terminate the plan worker on the stale transition and hold the source references weakly, so an undo can still re-arm the session without pinning the audio. Affects: `src/services/remixService.ts`.
- **A stale tempo cache row pinned the pre-edit channel arrays.** Cause: staleness was flagged without releasing the references, so an analysed-then-edited document held ~105 MB per row. This also quietly under-reported the undo budget, whose eviction assumes dropping an entry frees its snapshot. Fix: release the references the first time a reader observes the identity mismatch. Affects: `src/services/tempoAnalysis.ts`.
- **A failed remix render orphaned its plan worker.** Cause: `renderRemix` and document creation ran after the last termination guard and before the session was stored, so a throw left a worker with nothing able to reach it — and each retry added another. Fix: terminate on the failure path and re-throw. Affects: `src/services/remixService.ts`.
- **`file:write` had no user-approval gate**, unlike `file:read`. Cause: writes were validated only against the path policy, never against a path the user had actually chosen, so any future renderer compromise could silently overwrite audio files anywhere outside the protected directories. Fix: writes must now target a path approved by a save/open dialog. Note the subtlety: the save flows append the format extension *after* the dialog returns, so the approved set has to admit that transformation. Affects: `electron/ipc.cjs`, `src/services/fileService.ts`.
- **MP4/M4A sniffing had no scan cap**, unlike every other container sniffer. Cause: the box walk was bounded only by the file. A crafted file of millions of empty boxes froze the main thread and then exhausted memory. Fix: cap the number of sibling boxes walked, returning what was collected rather than failing — a byte cap would have broken non-faststart files, where `moov` legitimately sits at the end. Affects: `src/audio/sniffSampleRate.ts`.
- **A WAV header declaring 0 channels was accepted as valid.** Cause: `validateFmt` checked neither channel count nor sample rate, so the decode "succeeded" with no channels and threw later, far from the cause; a zero sample rate made the duration infinite. Fix: validate both at parse time. Affects: `src/audio/wavCodec.ts`.
- **Three error paths leaked their resources**: a failed effect dispatch never terminated its worker, an errored Ogg/Opus export never closed its encoder, and a failed recording stop left the graph connected and the engine marked as still recording. Fix: release in `finally` in each case. Affects: `src/services/effectRunner.ts`, `src/audio/oggOpusEncoder.ts`, `src/audio/RecordingEngine.ts`.
- DevTools are no longer available in packaged builds. Affects: `electron/main.cjs`.

## [1.4.0] - 2026-07-25

Integrity release. A seven-dimension audit of the v1.3 codebase produced 18 independently verified defects; all are fixed here, three of them data-loss class. Every finding below was double-verified (one reviewer trying to refute it, one judging real-world impact) before being scheduled.

### Fixed

- **Marker work was silently discarded on close.** Cause: marker add/rename/delete mutated only the marker map and never touched the document, while every loss gate (the close prompt, the quit guard's dirty count, the Files-panel `*`, and the async-save staleness check) keys on the document's dirty flag — so an hour of annotation on an otherwise-unedited file closed with no prompt at all, and the UI actively reported "nothing unsaved". Fix: marker mutations now replace the owning document with `dirty: true`, which repairs all four gates at once. Affects: `src/stores/appStore.ts`.
- **A failed or interrupted Save destroyed the original file.** Cause: `file:write` did a single `fs.writeFile` over the destination, which truncates on open — so a write that failed partway (disk full, removable drive pulled, quit mid-write) left the user's source file a truncated fragment while the error dialog implied the disk copy was intact. Fix: writes now go to a sibling temp file, are fsynced and closed, then renamed over the target; any failure unlinks the temp and leaves the original byte-for-byte untouched. Affects: `electron/atomicWrite.cjs`, `electron/ipc.cjs`.
- **Save Session failed silently on sessions over roughly 17 minutes of audio.** Cause: the `.audm` writer built one base64 string of the entire embedded audio, exceeding V8's maximum string length; the exception propagated to an uncaught click handler, so no file was written and no error appeared — and because Save Session had no success feedback either, success and failure were indistinguishable. Fix: `.audm` format v3 assembles a binary buffer directly (`AUDM3\n` magic + JSON header + raw Float32 payload), which removes the ceiling and base64's 33% overhead; save and open now report failure explicitly and success visibly. v1/v2 sessions still load. Affects: `src/multitrack/sessionFile.ts`.
- **Markers didn't follow destructive edits.** Cause: `applyEdit` — the single write path for destructive edits — never touched markers, so deleting or inserting audio left every later marker labelling the wrong sound, and sample-rate conversion left them on the old clock. Saved files could carry cue points past end-of-file, which reopening then clamped, making the corruption permanent. Fix: delete/insert/replace/trim shift or drop markers, sample-rate conversion rescales them, and length-changing effects (Time Stretch, Pitch Shift) map interior markers proportionally — all inside the same undo step as the audio change, always clamped to the document length. Affects: `src/services/editOps.ts`, `src/services/documentTools.ts`, `src/services/effectRunner.ts`.
- **Ctrl+Z after adding a marker reverted the previous audio edit instead.** Cause: marker operations never created undo entries, so undo silently targeted the last audio edit. Fix: marker add/rename/delete push labelled undo entries (`Add Marker` / `Rename Marker` / `Delete Marker`) visible in the History panel. Affects: `src/services/undoHistory.ts`, `src/services/menuActions.ts`, `src/components/Panels/MarkersPanel.tsx`.
- **Undo after Save reported the document as clean.** Cause: undo entries snapshotted the dirty flag as it was at edit time, so undoing past a save restored `dirty: false` while the audio in memory no longer matched the file on disk — closing then discarded the difference with no prompt. Fix: dirty is now derived from the undo position relative to a save point rather than restored from a snapshot. Affects: `src/services/undoHistory.ts`.
- **MP3 marker positions were wrong whenever the encoder changed the sample rate.** Cause: markers were written at the document's rate, but the MP3 encoder silently resamples (a 96 kHz document produces a 48 kHz file), so every marker landed at double its time and piled up at end-of-file. An initial fix mirrored the encoder's rate-selection logic and was still measurably wrong by 8–27% for non-standard rates such as 22254 Hz (classic Mac) and 8012 Hz (telephony), which the app can reach because it preserves native import rates. Fix: the true output rate is now read from the encoded MPEG frame header, which is correct by construction for every rate and bitrate. Affects: `src/audio/mp3Encoder.ts`.
- **FLAC files declared spec-invalid block sizes.** Cause: STREAMINFO's minimum/maximum block size included the final partial frame, contradicting the fixed-blocksize strategy the frames themselves declare, and streams under 16 samples produced a maximum below the spec floor that ffmpeg and Chromium reject — Auditorium could not reopen its own file. Fix: block sizes now follow RFC 9639/libFLAC (last partial frame excluded, floored at 16). Affects: `src/audio/flacEncoder.ts`.
- **Global shortcuts stayed live under modal dialogs.** Cause: the keydown handler skipped only text inputs, so Ctrl+O behind an open Export dialog switched the active document and Export then wrote the wrong file; Escape also closed every stacked dialog at once. Fix: a dialog stack gates the shortcut handler and scopes Escape to the topmost dialog. Affects: `src/services/shortcuts.ts`, `src/services/dialogBus.ts`, `src/components/Dialogs/DialogShell.tsx`.
- **Dismissing an effect dialog mid-preview left the preview playing**, with the shared player still holding the throwaway processed snippet, so the next Play produced audio that didn't match the waveform. Fix: closing the dialog by any route (Escape, backdrop, Cancel, Apply) stops the preview and reloads the real document. Affects: `src/components/Dialogs/EffectDialog.tsx`.
- **Escape or a stray backdrop click discarded an in-progress recording** with no confirmation. Fix: while recording, only the explicit Stop and Close buttons dismiss the dialog. Affects: `src/components/Dialogs/RecordDialog.tsx`.
- **Quitting while the app was busy discarded unsaved work without asking.** Cause: the close guard destroyed the window unconditionally 2 s after an unanswered close request, without distinguishing a crashed renderer from one merely busy in a long synchronous encode. Fix: the guard now asks before quitting when the renderer is alive, and the reply reports in-flight saves as well as unsaved documents. Affects: `electron/closeGuard.cjs`, `src/App.tsx`.
- **Saving while playing stopped playback and re-copied the whole audio buffer.** Cause: the transport reloaded the engine on any document-object change, including metadata-only ones — which, after the marker fix above, would have meant every marker drop restarting playback. Fix: the reload keys on the fields that actually invalidate the buffer. Affects: `src/components/Layout/TransportBar.tsx`.
- **Memory grew without bound in three places**: undo history capped step count but not bytes (50 snapshots of a long file is gigabytes), the player kept the last closed document's full buffer for the session, and the spectrogram mixed down the entire document on every zoom or scroll instead of the visible window. Fix: an 800 MB per-document undo budget charged by the audio each step actually pins, a `unload()` on close, and viewport-only spectrogram processing. Affects: `src/services/undoHistory.ts`, `src/audio/PlaybackEngine.ts`, `src/components/Editor/SpectrogramView.tsx`.
- Saving to a network share failed after opening from one (UNC paths were refused for writes while allowed for reads); a DSP worker that failed to load hung the Apply promise forever; the recorder retained the previous take's raw buffers; corrupt WAV cue chunks and hostile session metadata produced raw type errors rather than clear messages. Affects: `electron/writePathPolicy.cjs`, `src/services/effectRunner.ts`, `src/audio/RecordingEngine.ts`, `src/multitrack/sessionFile.ts`.

### Changed

- In-place WAV Save retags the document's bit depth to 32-bit float, so Properties describes the file that is actually on disk; Save As replaces the source extension in the suggested name (`song.mp3` → `song.wav`, previously `song.mp3.wav`) and enforces `.wav` on the chosen path.
- In-place FLAC Save rounds bit depth up rather than down — a 20-bit source now saves as 24-bit instead of being truncated to 16-bit.
- MP3 chapter interop frames cap at the first 255 markers (the private exact-position tag still carries all of them), so the chapter table can no longer declare a count it doesn't contain.
- Write-path policy: genuine network shares (`\\server\share\...`) are now allowed, while local-alias and administrative shares (`\\localhost\C$`, `\\...\ADMIN$`, any `$`-suffixed share) and extended-length/device paths are refused. Test and dev-server entry points are additionally gated on the build being unpackaged.
- Documentation corrected against the code: the user guide had claimed since v1.3 that MP3 and FLAC markers don't survive a save (they have since v1.3), and both the guide and README described FLAC in-place save as "verbatim at the source bit depth" when it rounds to 16 or 24.

## [1.3.0] - 2026-07-22

### Added

- Marker persistence in **every** container, not just WAV. Why: v1.2 could only persist markers in `.wav` and `.audm` sessions; MP3/FLAC/OGG were documented as container-inherent gaps — but published standards exist for all three. MP3 now writes an ID3v2.3 tag with chapter frames (`CTOC` + one `CHAP` per marker with an embedded UTF-16 `TIT2` title — the podcast-chapters standard) prepended to the encoded stream; FLAC inserts a `VORBIS_COMMENT` metadata block and OGG (Opus) extends its OpusTags header, both carrying de-facto-standard `CHAPTERxxx`/`CHAPTERxxxNAME` tags (readable by chapter-aware players; support varies by player and container). Every format also embeds a private `AUDITORIUM_MARKERS` tag with exact sample offsets, so reopening in Auditorium is sample-accurate even though the interop chapter fields are millisecond-granular. Opening an MP3/FLAC/OGG with chapters — including files tagged by other tools (ID3v2.3 and v2.4, all text encodings) — seeds the marker list. Files saved with zero markers remain byte-identical to v1.2.1 output. How to use: nothing new — drop markers with `M` and Save/Export as before.
- Unicode WAV marker names. Why: `labl` text was written as Latin-1, corrupting CJK/emoji names on WAV save. Now a file whose marker names all fit Latin-1 is written exactly as before (byte-identical), and any file needing more switches all its labels to UTF-8 (Audacity's convention); reading tries strict UTF-8 first and falls back to Latin-1 for legacy files. Affects: `src/audio/wavCodec.ts`.
- 64-bit (largesize) MP4 box sniffing. Why: MP4/M4A files using `size == 1` extended boxes fell back to 48 kHz decode; the box walk now reads the 64-bit size (bounds-checked in the BigInt domain) and version-1 `mdhd` headers are covered by a pinned test. Affects: `src/audio/sniffSampleRate.ts`.

### Changed

- `docs/KNOWN_LIMITATIONS.md`: marker persistence is resolved for all containers; the only remaining notes are interop granularity (ms in standard chapter fields), lossy-format generation loss, genuinely unrecognized containers, and the >2-channel downmix law.

## [1.2.1] - 2026-07-22

### Fixed

- Editing during an in-place `.ogg` save could be silently lost. Cause: `.ogg` is the only asynchronous encode path (WebCodecs), and `saveDocument` wrote its pre-encode snapshot back into the store with `dirty: false` after the await — an edit made while the encoder ran was clobbered by the stale snapshot and marked saved. Fix: after the await, the store is updated only if the live document is still the exact pre-save snapshot (reference equality — every edit produces a fresh document object); otherwise the newer edit is kept and the document stays dirty, matching "save, then edit" semantics. A per-document in-flight guard also prevents a second concurrent Save from interleaving file writes ("Save in progress" notice). Affects: `src/services/fileService.ts`.
- Unexpected OGG encoder errors were invisible to the user. Cause: `saveDocument` and `exportDocument` only handled the typed `OggEncoderUnavailableError` (save-as-WAV fallback); any other encoder rejection (e.g. a WebCodecs `DOMException`) propagated as an unhandled rejection with no dialog. Fix: non-typed encode errors now surface through the same error message box already used for file-write failures, and the document stays dirty. Affects: `src/services/fileService.ts`.
- Corrupt WAV files could produce spurious markers. Cause: the `cue ` chunk decoder bounded its reads by the end of the file buffer instead of the chunk's declared size, so a corrupt `numCuePoints` let it interpret bytes of the following chunks as cue points. Fix: cue-point reads are clamped to the declared chunk size (mirroring the existing `LIST/adtl` clamp) and the iteration count is capped by what the chunk can actually hold; malformed files parse what fits and never throw. Affects: `src/audio/wavCodec.ts`.

### Changed

- WebM sniffing test coverage: added fixtures for sibling-element skipping at every EBML walk level, a leading video track followed by an audio track, and two audio tracks (first wins — pinned); removed the dead `unknownSize` field. No production behavior change. Affects: `src/audio/sniffSampleRate.ts`.

## [1.2.0] - 2026-07-19

### Added

- Marker persistence: markers now survive to disk. `.wav` files carry a standard `cue `/`LIST`-`adtl` chunk pair (one cue point + one labeled `labl` per marker), written on in-place Save, Save As, and WAV Export, and read back on Open — so markers round-trip through the file, not just the session. `.audm` sessions (`formatVersion: 2`) additionally embed a `markers` map for every document referenced by a clip; v1 session files still load (with zero markers). Why: v1's markers were session-only and vanished on close, forcing users to re-annotate every reopen. How to use: drop markers with `M` as before — Save/Save As/Export a `.wav`, or save a session, and they persist automatically.
- OGG (Opus) export and format-faithful save: File > Export gains **OGG (Opus)** at 96/128/192 kbps, and a document opened from `.ogg` now keeps its path and re-encodes in place as Opus-in-Ogg on Save (128 kbps), matching the existing WAV/MP3/FLAC format-faithful behavior. Implemented as a pure-TypeScript, RFC 3533/7845-conformant Ogg page muxer (`src/audio/oggPage.ts`) feeding packets from the host's WebCodecs `AudioEncoder`. Legacy Ogg Vorbis sources are re-encoded as Opus (a modern, universally decodable codec) rather than round-tripped as Vorbis. If WebCodecs is unavailable, in-place Save falls back to the save-as-WAV dialog and Export reports an error instead of writing a broken file. Why: v1.1 could only open `.ogg` and re-save it as WAV, losing the original container. How to use: File > Export > OGG (Opus), or open an `.ogg` file and press Save.
- Native-rate import for WebM and raw AAC (ADTS): `sniffSampleRate` now also parses WebM/Matroska (a bounded EBML walk down to `Segment → Tracks → TrackEntry → Audio → SamplingFrequency`, with Opus tracks fixed at 48000 Hz regardless of the stored value) and ADTS/AAC frame headers (`sampling_frequency_index`, requiring two consecutive valid frames before trusting a sync). Why: these two containers previously fell through to the 48000 Hz fallback even when their real rate was readable. How to use: nothing to do — opening a `.webm` or raw `.aac` file now keeps its native rate automatically.

### Fixed

- Intermediate Ogg page granule positions overstated decoder-output position by the pre-skip amount. Cause: the muxer added `preSkip` to every audio page's cumulative granule instead of only the final (trimmed) page, so a strict RFC 7845 validator would see granules exceed the true decoder-output count on non-final pages. Fix: intermediate pages now carry the exact cumulative 48 kHz decoder-output count (`packetIndex × 960`); only the final page's granule is `preSkip + totalSamples`, matching the spec. Affects: `src/audio/oggPage.ts` (`muxOpusStream`).

### Changed

- `docs/KNOWN_LIMITATIONS.md`: all three v1.1-era gaps (unsniffable-container fallback, Ogg round-tripping as WAV, session-only markers) are now resolved or narrowed to their genuinely-remaining edges — see the file for exact current behavior.

## [1.1.0] - 2026-07-14

### Added

- Multitrack punch-in recording: arm tracks (R), position the cursor, and Record — the take lands as a clip on every armed track. Why: the arm flag was visual-only in v1.0. How to use: multitrack view → R on a track → Record.
- FLAC support: lossless FLAC export (16-bit) and format-faithful in-place Save for documents opened from `.flac` (16/24-bit verbatim-subframe encoder validated against Chromium's decoder) and `.mp3` (re-encoded at 192 kbps).
- Source bit depth: Properties shows "N-bit source → 32-bit float" for WAV/FLAC documents.
- Spectral display: logarithmic frequency axis by default (View > Spectral: Toggle Log/Linear Scale), rendered at native HiDPI resolution.
- Native quit guard: closing the window with unsaved changes asks for confirmation (replaces the best-effort in-page guard).

### Changed

- Paste now resamples clipboard audio to the destination document's rate (pitch/duration preserved). Cause: v1.0 inserted raw samples across rate mismatches.
- Non-WAV imports keep their native sample rate via container-header sniffing (MP3/FLAC/OGG/M4A; unsniffable containers fall back to 48 kHz). >2-channel content is downmixed to stereo (−3 dB blend) instead of truncated.
- Time Stretch / Pitch Shift use stereo-linked WSOLA (one similarity search on the mid signal drives both channels), keeping the stereo image phase-coherent.
- Multitrack volume/pan/mute/solo changes are now live during playback, and realtime monitoring uses the exact per-clip pan law of Mix Down (monitor matches render on all content).

### Fixed

- Spectrogram raster misalignment at fit-zoom. Cause: the minimum-hop clamp strode past the visible span when span/width < 128, painting the right side black. Fix: fractional stride spanning exactly [start, end). Affects: `src/workers/spectrogramCore.ts`.
- Multitrack recorder stop re-entrancy could double-commit a take (two docs + overlapping clips) on rapid stop triggers. Cause: async stop guard flipped after the engine flush. Fix: synchronous tri-state claim. Affects: `src/multitrack/multitrackRecord.ts`.
- Clip mini-waveforms are cached offscreen (bounded LRU, purged on clip/track/doc removal), cutting zoom-time redraw cost.

## [1.0.0] - 2026-07-13

### Added

- Waveform editor: per-sample amplitude view with zoom (mouse wheel) and scroll, selection, and playhead.
- Spectral frequency display: off-main-thread spectrogram (linear axis, inferno color map) of the active document.
- Multitrack editor: sessions with tracks (volume, pan, mute/solo/arm), draggable/trimmable clips, and per-clip gain.
- Recorder: input-device selection, live level meter, and capture into a new document.
- Effects rack (22 effects) with a parameter dialog: Amplify, Normalize, Fade, Parametric EQ, Graphic EQ, Compressor, Limiter, Noise Gate, Echo, Reverb, Chorus, Flanger, Distortion, Remove DC Offset, DeHum, Noise Reduction, Channel Mixer, Pan, Time Stretch, Pitch Shift, Invert, and Reverse.
- Noise Reduction workflow: capture a noise print from a selection, then subtract it from the target region.
- Editing: cut/copy/paste/delete on sample-accurate selections, with per-document undo/redo history.
- Markers: session markers with a list panel, rename, and next/previous navigation.
- File I/O: open WAV/MP3/OGG/FLAC/M4A/AAC/WebM; export WAV (16/24/32-bit float) and MP3 (128/192/256/320 kbps CBR).
- Sessions: save/open multitrack sessions as `.audm`, and mix down a session to a new stereo document.
- Packaging: Windows NSIS installer (electron-builder) with a generated app icon and a plain-text `README.txt`.
- Docs: user guide, keyboard-shortcuts reference, and known-limitations notes.
