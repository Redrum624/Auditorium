# Changelog

All notable changes to Auditorium are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.35.1] - 2026-08-18

### Fixed

- **Blank desktop and start-menu icons after install.** Cause: electron-builder's
  NSIS template passes `package.json`'s `description` verbatim as the shortcut
  comment, and ours had grown to 574 characters — past the ~260-character
  shell-link comment limit, which corrupts the `.lnk`'s icon-location field
  (the v1.35.0 shortcuts carried a slice of the description where the icon path
  belongs). Fix: the description is now a 183-character ASCII one-liner, with a
  regression test pinning the limit; the full pitch lives in the README, where
  it always belonged. Affects: `package.json`,
  `electron/packageMetadata.test.cjs` (new).

## [1.35.0] - 2026-08-17

### Added

- **A portable build.** Every release now ships `Auditorium X.Y.Z portable.exe`
  beside the installer — one executable, runs from anywhere, no admin rights, and it
  shares the installed app's profile (downloaded AI models and voice profiles),
  verified empirically rather than assumed. Affects: `package.json` (portable target).
- **SHA256SUMS.txt with every release**, generated at build time over all three
  distributables in the standard two-space `sha256sum` format, CertUtil-verifiable;
  the generator fails closed when an expected artifact is missing, and regenerating
  the README.txt standalone now refreshes the sums beneath it instead of silently
  staling them. Affects: `scripts/gen-checksums.cjs` (new), `gen-readme-txt.cjs`.
- **The README got its gallery.** A deterministic capture rig
  (`scripts/readme-shots.cjs`) drives the built app on generated fixtures and
  produces eleven per-panel, effect and tool screenshots — the Vocal Chain card shown
  after a real run with its measured settings, the Cover Chain card with its honest
  caveats, the rack, two effect dialogs, the multitrack, and the side panels — laid
  out as captioned tables. The Why bullets lost their emoji. Affects: `docs/shots/`
  (new), `README.md`.

## [1.34.0] - 2026-08-16

### Changed

- **The Spatial Positioner lives in the Effects module now.** Its own Mix group at the
  end of the Effects menu and card — same command, same behavior (it focuses the
  Spatial panel), gone from Pipeline everywhere, and Pipeline's emptied Mix group is
  removed. Why: the user files it with effects, not pipelines. Affects:
  `services/menuActions.ts`, `Panels/EffectsPanel.tsx`, `Panels/PipelinePanel.tsx`,
  both e2e walkers, docs.
- **The Pipeline labels drop their trailing "…".** All nine dotted entries (Match
  Tempo, Align Vocal Timing, Auto-Remix, Voice Changer, Vocal Chain, Cover Chain,
  Align Lyrics, Transcribe, Separate into Stems) read plain; the old dots-mean-a-dialog
  convention is superseded in place with the reasoning recorded, and a registry test
  pins every Pipeline row ellipsis-free. File-menu dots keep their convention —
  the change is scoped to the Pipeline module by the user's request. Affects:
  `services/menuActions.ts` and a 27-file label sweep (tests, walkers, docs).

## [1.33.0] - 2026-08-16

### Added

- **The draggable red cursor handle rides the multitrack too.** The triangle the
  Waveform and Spectral views already share — same geometry, same color, imported from
  the same constants so the three views cannot drift — now sits on the session cursor
  at the top of the multitrack lanes: grab it (grabbing alone moves nothing), drag it
  with the magnet (Alt suspends, whole samples, snap before clamp — the editor's
  order), release without touching the transport; during playback it stays parked at
  the cursor while the playhead sweeps. A review-round mutation probe hardened the
  grab test (the press point sat inside the cursor's own snap radius, hiding a
  commit-on-grab bug class) and surfaced a real snap-order fix on the way. Affects:
  `components/Multitrack/MultitrackView.tsx`, `components/Editor/waveformRender.ts`
  (exports only), docs.

## [1.32.0] - 2026-08-15

Three lanes from the morning's feedback: the gate stops asking how loud and starts
asking where, the module bar and the open module become one width, and the magnet
learns clip edges — with rank.

### Changed

- **The automatic noise gate asks WHERE, not how loud.** Two real sessions in a row
  the level-threshold gate declined on the same take (its quietest 500 ms is a whisper
  — an unvoiced performance no threshold can separate from noise), and the user named
  the fix: "the vocals are well identified... so why can't we mute where there is no
  lyrics?" The automatic path now decides per region: a stretch is muted only when no
  word span maps there (lyrics alignment first, transcript segments as coarser
  evidence, both freshness-checked), its voiced fraction stays under the measured
  boundary, and its spectrum reads as floor rather than vocal tract — so a pause
  louder than the singing's floor now mutes, and a whisper, hum, breath or held
  consonant survives on the same evidence that used to veto the whole stage. The
  polarity hard-decline stands guard per window (a review probe proved a region-level
  statistic could be diluted into muting an inverted whisper unread — it cannot now,
  and the probe is a permanent regression test). The manual "Gate at a level I set
  instead" keeps its exact old semantics. Honest limit, measured and recorded: one
  real room reads as vocal-tract-shaped wall to wall (every one of the take's 2833
  half-seconds over the boundary), and there the automatic path still declines — now
  with the run's own numbers in the message and the manual escape beside them; the
  recorded path forward is a multi-room population, not a guessed constant. Affects:
  `services/vocalChain.ts`, `effects/dynamics/NoiseGateEffect.ts` (mute-regions side
  channel), `dsp/chainAnalysis.ts` (windowed tilt), docs.
- **The module bar and the open module are always the same width.** The bar follows
  the module: 348 px beside the panel list, 640 px while a pipeline tool is open,
  growing leftward with the card, never unequal — pixel-verified at 0.00 px delta in
  both states. Affects: `components/Layout/ModuleStrip.tsx`,
  `components/Dialogs/PipelineToolHost.tsx`, `App.tsx`.

### Added

- **Snap to clip edges, with rank.** Every other clip's start and end are magnet
  targets — cross-track and same-track, head and tail — landing sample-exact, so
  aligning one clip to another is a drag instead of arithmetic. The magnet also
  learned priority: geometry the user placed (clip edges, the cursor) outranks
  markers, which outrank derived beat lines — a beat can no longer silently steal a
  snap both were in reach of — and the drop ghost names its winner by tier. A trim
  keeps co-selected neighbours as targets (only a rigid group move excludes its own
  members). An exact butt join creates zero overlap, so the old design note fearing
  accidental crossfades is superseded in place with its reasoning recorded. Affects:
  `services/snap.ts`, `components/Multitrack/sessionSnapTargets.ts`,
  `clipDropPosition.ts`, `ClipView.tsx`, `TrackLane.tsx`, docs.

## [1.31.1] - 2026-08-15

### Fixed

- **Multitrack playback no longer plays one track early against the others.** Found
  by a real Cover Chain session: instrumental audibly ahead of both the take and a
  hand-placed original, while every clip sat exactly where the screen showed it — the
  screen was honest and the placement was sample-exact. Cause: `MultitrackPlayer.play()`
  read `ctx.currentTime` per clip, after each track's synchronous buffer bake, on a
  context that keeps running between plays — so each track was scheduled against its
  own clock base, and a slow bake (the take's 25 ms edge fades forced a per-sample
  gain pass over the whole clip) became tens of milliseconds of real inter-track
  displacement. Mix Down was always immune (offline ground truth). Fix: every track's
  buffers are built first, then ONE epoch is read and every source is scheduled
  against it — relative placement now derives from `startSample` deltas only, and the
  visual playhead anchors to the same epoch; the red test reproduced the exact drift
  before the fix. Affects: `multitrack/MultitrackPlayer.ts`.
- **The fade bake now touches only the fade.** A clip with 25 ms edge fades paid a
  per-sample gain call over its entire length at every play; the head and tail get
  the gain pass, the unity middle is copied. Byte-identical output, proven at the
  fade-region seam with a boundary fixture. Affects: `multitrack/MultitrackPlayer.ts`,
  `docs/KNOWN_LIMITATIONS.md` (the "clean play is exact" passage now says what was
  actually true — value parity held, schedule-time parity did not until this fix).

## [1.31.0] - 2026-08-15

The overnight close: the clip-editing set completed, three structural refactors the
backlog had carried for weeks, a crash surface, and every deferred review minor from
every prior wave — thirty-plus recorded items — fixed or honestly re-recorded. Ten
lanes total across the night, every one reviewed; three cleared review with zero
findings of any severity.

### Added

- **The clip-editing set is complete**: `Ctrl+A` selects every clip; `Home`/`End`
  jump the multitrack cursor to the session's start / the last clip's end;
  `Shift+Click` range-selects along a track (Ctrl wins on Ctrl+Shift); a group drag
  ghosts EVERY member live, clamped as a group exactly as it will commit; and a group
  drag now crosses tracks — members keep their relative track offsets, and when any
  member's target track would not exist the whole drag honestly stays on its own
  tracks rather than scattering. `Edit → Ripple Delete Time Selection` ships listed
  but greyed: the multitrack has no time selection yet, and the row says so rather
  than pretending. Affects: `multitrack/groupDrag.ts` (new), `sessionStore.ts`,
  `components/Multitrack/ClipView.tsx`, `services/menuActions.ts`.
- **A crash surface.** The app has had a renderer wedge in its history; it now has an
  answer: a top-level error boundary renders an honest crash card (the error text
  selectable, a Reload button) and `window.onerror`/`unhandledrejection` route
  non-React exceptions to the same card — non-fatal ones in a non-blocking notice
  that cannot freeze the app it reports on. Affects: `src/App.tsx`,
  `components/CrashSurface` (new).
- **A drop lands on the track the pointer names — header included** (single-clip
  drags; in the codebase since the original multitrack commit for the lane area, now
  honoured over the header too, with the lit lane always the lane the clip joins).

### Fixed

- **Noise Reduction stops leaving 5–8 dB of its reduction unused on uneven floors.**
  Cause: its noise print was learned from the quietest window even when that window
  was diluted by digital silence — the print described the zeros, not the floor.
  Same fix as its three siblings (the mostly-silent-window rejection), measured under
  a pre-registered bound: floor removal improved from 4.7→9.4 dB (8 kHz) and
  2.9→11.2 dB (44.1 kHz). The compressor was measured against the same bound and
  deliberately left alone — the prescribed fix is measurably worse on the one shape
  that trips it, and its error direction is "do less", which is the safe one; the
  full record lives in `docs/bench/vocal-chain-uneven-floor-bias.md` under the
  measurement discipline now written down in `docs/bench/README.md`.
- **A cleared manual gate level means "no level"** — an empty field was read as
  `0 dBFS`, a full-scale gate. Affects: `components/Dialogs/VocalChainDialog.tsx`.
- **Selection and drag polish across the multitrack**: cancelled gestures commit
  nothing; re-selecting the selected repaints nothing (and only the affected clips
  re-render on selection changes); the drop ghost holds at the lane edge; the group
  drop hint counts only clips the drag is not already moving, so it can no longer
  promise a crossfade with a clip that is vacating.
- **A selection dragged right-to-left names the span it swept.** Cause: `setSelection`
  stored whatever it was handed, so an inverted pair (`start > end`) reached the audio
  primitives, where `clampRange` throws — Copy, Silence and every effect run raised a
  `RangeError`, the status bar showed a negative duration, and the transport played
  from the later sample. `editOps.ts` had recorded the case as deliberately deferred
  to "this family's next round"; this is that round. Fix: ordered at the store WRITE,
  which is where the invariant has to live — eight consumers resolve a region against
  a document, but around twenty-five just read the pair (the status bar, the
  properties panel, the transport, the playback engine's loop bounds, three dialogs'
  readouts) and need no document to be right, so a read helper could not have reached
  them. Same shape as `applyEditorZoom`, "the ONE clamping writer". An already-ordered
  pair is returned by identity, so an unchanged write is not a new store snapshot.
  Affects: `stores/appStore.ts`, `services/selectionRegion.ts`.
- **The two passes that orphaned a finished edit now observe a cancel.** Cause: U2's
  fix round corrected its own claim that all nine hosted tools discard their work on
  unmount — seven do; Match Tempo guarded only a DOM ref and Align Vocal Timing had no
  ref at all, so a pass resolving after the tool was gone committed its stretch, its
  marker correction and its beat grid into a document the user had walked away from.
  The module lock has been mitigating it since. Fix: the cancel seam is in
  `runEffectOnSelection`, between the audio arriving and `applyEdit` writing it —
  `applyEdit` is called from inside that function, so no caller can get between the
  two, and everything from the check to the last of the three undo entries is one
  synchronous block. A cancelled pass commits nothing and reports `'cancelled'`
  instead of "nothing to move at this strength". Align's Suggest needed the same fix
  in a different shape: the animation frame it defers to still fires after unmount,
  and it writes markers plus an undo entry, so the frame is cancelled and the decision
  re-read inside it. **The module lock is deliberately NOT relaxed** — `moduleLock` is
  one flag driving four things, and the fourth (suspending the keyboard) guards a
  hazard that happens with the tool still mounted, where no cancel ref can reach it:
  `Ctrl+O` mid-pass makes another document active, and `applyEdit` writes the GLOBAL
  selection and cursor. Reasoning recorded at the lock. Affects:
  `services/effectRunner.ts`, `services/tempoService.ts`, `services/timingAlignService.ts`,
  `components/Dialogs/TempoDialog.tsx`, `components/Dialogs/AlignTimingDialog.tsx`.

### Changed

- **One resolved region, in one function.** The clamp family's rule — "resolve once,
  do not clamp twice and hope the two agree" — was written out in eight places
  (`tempoService`, `effectRunner`, `vocalChain`, `coverChain`, `timingAlignService`,
  `editOps`, `TempoDialog`, `noiseProfile`), each under its own paragraph restating
  it; `editOps.ts` counted itself the FIFTH application. The family reached fourteen
  members precisely because every new consumer re-derived the pair instead of reading
  one. Now `services/selectionRegion.ts` holds the arithmetic and the eight import it.
  Behaviour is byte-identical, pinned before the move by a suite that drives the same
  trap table through three independent surfaces. `noiseProfile` was the last raw
  member — recorded as benign because `cloneRegion` clamps what it slices, which is
  true and is not the same as correct.

## [1.30.0] - 2026-08-15

Six lanes from one day of real use: two rendering defects, the gate's real-recording
lesson, the alignment placing itself, the journey managing its own levels, a full
Audition-style clip-editing set, and a launch splash. Every lane reviewed, fix-looped,
and re-checked; two user suggestions answered by measurement rather than opinion.

### Fixed

- **Clips no longer paint over the track header at high zoom** — and stop swallowing
  its clicks. Cause: the lane never clipped its children, and the waveform canvas's
  256-px band quantum let it start almost exactly one header-width left of the lane;
  the invisible clip box also sat above the header for hit-testing, which is why
  M/S/R and the faders sometimes felt dead at scrolled zooms. Fix: the lane clips
  (`overflow: clip`, deliberately not `hidden` — no scroll container), and the band
  bound is a whole number of quanta, restoring the one-reraster-per-quantum lockstep
  a "perf" change had silently halved. Verified visually at 596% on the packaged app.
  Affects: `components/Multitrack/TrackLane.tsx`, `ClipView`, `clipBeatTics.ts`.
- **The noise gate searches the whole take for a pause** instead of judging only the
  single quietest half-second. Cause of the reported "noise was not removed": a real
  take's quietest window was a breath, and the derivation declined the whole stage.
  Now the twelve quietest passages are walked in level order (bounded by a measured
  2.5 dB climb so the search can never step up into quiet singing), a genuine
  cancellation reading anywhere hard-declines with the polarity message, and when no
  window anywhere reads as a pause, "Gate at a level I set instead" makes silence
  reachable by explicit choice — the field appears only when asked for, so an empty
  box never reads as a forgotten setting. Affects: `services/vocalChain.ts`,
  `dsp/chainAnalysis.ts`, `components/Dialogs/VocalChainDialog.tsx`.
- **The Cover Chain's session can no longer clip on Mix Down out of the box** — the
  pass that built the overshoot takes it out, trimming both faders by the overshoot
  plus 1 dB, re-measuring the trimmed sum rather than promising it, and recording one
  undoable "Cover level trim" entry. Its progress bar also stops walking backwards
  during the second measurement. Affects: `services/coverJourney.ts`.

### Added

- **The alignment places the tracks itself.** A weak or ambiguous measurement now
  auto-places the best candidate — numbers stated, rivals one "Place at ±X s" press
  away — instead of handing over three buttons; only "no relation found" still lands
  at zero. Affects: `dsp/coverAlign.ts`, `services/coverPlacement.ts`,
  `components/Dialogs/CoverChainDialog.tsx`.
- **Audition-style clip editing in the multitrack**: `Ctrl+Left/Right` jump the
  cursor between clip edges (inside a clip: its own start/end); `Ctrl+Click` builds a
  multi-selection whose members drag as a group and delete together; `Shift+Delete`
  is Ripple Delete — remove the selection and close the gaps, crossfades re-arming
  through the same maintenance a drag uses, one undo restoring everything; `Escape`
  clears; the Properties panel shows "N clips selected". A fade-corner grab is an
  edit gesture and keeps the selection. Multi-selection is view state: session files
  and undo history are unchanged. Affects: `multitrack/sessionStore.ts`,
  `components/Multitrack/*`, `services/shortcuts.ts`, `KEYBOARD_SHORTCUTS.md`.
- **A launch splash** in the app's own glass, with real init milestones (the ladder
  the user actually sees: 40/60/80/90/100), a bar that only climbs, and a failsafe
  that never leaves a red error over a healthy-but-slow launch. Measured across
  before/after launches: no added latency — the editor's load is already in flight
  before the splash window exists. The e2e rigs now select the editor window by the
  URL it loaded, never by arrival order. Affects: `electron/splash.cjs`,
  `electron/splash.html`, `electron/main.cjs`, `scripts/e2e-lib.cjs`.

### Answered by measurement (no feature shipped, on purpose)

- **"Why not compare against the original song?"** Measured: an onset envelope is
  spectral flux, and accompaniment under a vocal dilutes the flux at that vocal's own
  attacks — refining against the full song relocates the placement onto a ruler whose
  zero has moved, by exactly the amount it moved, at every bed level tested. No
  correction survives that identity, so the separated vocal stays the ruler; the
  sweep lives on as a kept 8-second derivation test. (A prototype of that refinement
  briefly regressed the smoke's ±10 ms contract to 13 ms during this cycle; the smoke
  caught it and the prototype is gone — placements recover the planted offset to
  0.07 ms again.)
- **"Maybe a targeted second pass on what's left?"** (v1.28's measured NO-GO,
  re-affirmed): the probe that produced it now derives its stem order from the
  host's own exports and throws before writing any verdict if the exact-sum law is
  violated — the answer stands on enforced foundations.

## [1.29.0] - 2026-08-14

The fix wave — "fix what needs fixing": a controller triage of every finding
the v1.28.0 reviews recorded, closing every known destructive-direction defect
in the codebase. Two lanes, two reviews, two fix rounds, zero train conflicts.

### Fixed

<!-- G1: the gate follow-through -->
- **A quiet voice island bracketed by digital silence is no longer muted by the
  gate.** Cause: the gate's census counted real audio hidden in evicted-quieter
  windows, but an island sitting beside a burst lived in loud windows the
  census never saw — v1.28.0 shipped this documented (~375 ms bound). Fix: the
  gate has nothing to remove inside a run of exact zeros, so it no longer
  spends one closing — a zero-run ≥ 50 ms (measured: quantisation produces at
  most 29.63 ms of contiguous zeros; edits write 300 ms and up) leaves the gate
  open, and what emerges gets the same hold a phrase's tail gets. The rule is
  monotone in the pass direction — it can only pass more audio, never mute
  more — so every failure mode is a leak, not a chop. The manual Noise Gate
  effect gains the same rule. Affects: `effects/dynamics/NoiseGateEffect.ts`,
  `services/vocalChain.ts`.
- **Remove Silence no longer deletes soft singing on uneven noise floors.**
  Cause: its threshold derivation consumed the same quietest-window search the
  gate's five review rounds interrogated, WITHOUT the mostly-silent-window
  rejection — measured: a boundary window diluted by digital silence reported
  a threshold ~10 dB high, reading 51–80% of a real −62 dBFS sung phrase as
  silence for a stage that deletes what it names. Same fix, same mechanism;
  Remove Silence now declines honestly on strip-silenced takes it used to run
  on. The same defect's last consumer, `wordSplice`'s trim threshold — which
  could shave a replacement word's aspirated onset when the take carried
  device-written zeros — got the same rejection; the whole word now survives.
  The remaining consumers of the bare search were classified and are safe or
  degraded-only (gain error / under-reduction), recorded in the review.
  Affects: `services/vocalChain.ts`, `dsp/wordSplice.ts`, `dsp/chainAnalysis.ts`.
<!-- H1: the hygiene batch -->
- **A clip moved to where it already is costs nothing.** Cause: `moveClip` had
  no no-op guard (its sibling `setClipFade` did), so a bare click into the new
  Start field re-quantised the clip, re-ran fade maintenance, and minted an
  undo entry. Both guards now exist: the store early-returns on a same-position
  move, and the Start field treats input that formats to the committed display
  as a no-op — typing `1` on an off-grid clip no longer commits a one-sample
  move. Affects: `multitrack/sessionStore.ts`, `components/Panels/PropertiesPanel.tsx`.
- **The Cover Chain's reuse row tells the truth about the copy it left
  beside.** Cause: the description inferred "your own edits" from a document
  not having been picked, which is false when two copies match the sum (the
  undone-edit case). The description now derives from the samples themselves.
  Affects: `services/coverJourney.ts`.

### Changed

- `guessRemedy`'s candidate flag is now a required parameter — its default was
  the mechanism of a prior bug; a future caller must now decide explicitly.
- The gate's voiced-check populations are measured at 8, 44.1 and 48 kHz (were
  8 kHz only) with the post-NR member the docblock always claimed; stereo
  coverage restored for the gate's window mix; the alignment fixtures the
  reviews flagged as emitter-impossible now match the shipped contract.
- "Adoption writes nothing" is a claim a test can now falsify (identity +
  dirty pin), and the even-floor converse asserts its direction with its one
  measured exception explicitly accounted.

## [1.28.0] - 2026-08-14

The Cover Chain wave — born from one real cover session and three user reports:
noise survived between phrases, a real song's alignment was refused, and "check
for any other bugs". A verified hunt confirmed both reports and found four more.
Four lanes, four reviews, eleven fix rounds, one train, one assembly review.

### Fixed

<!-- CC1: the gate -->
- **Audio between sung phrases now reaches actual silence.** Cause: **the Vocal
  Chain had no gate stage at all** — its header claimed Noise Reduction "handles
  the floor", but NR is hard-capped at −12 dB per bin, declines entirely on noisy
  takes (the margin was measured against ungated whole-take RMS), and the
  compressor's makeup then lifted the residue. A registered-but-unused
  `noise-gate` effect existed with zero call sites. Fix: a measured gate stage —
  threshold from the quietest **mostly-real** window (windows over 25% exact
  zeros are refused by the measurement itself, because digital silence is proof
  of a pause, never the measurement of one), a 3 dB swept headroom, and two
  fail-safe refusals derived from non-overlapping populations: a YIN voiced
  check (voice is periodic) and a spectral-tilt residual check (a whisper
  carries vocal-tract resonances; a room's noise is a straight line in
  log-frequency — the log axis is load-bearing: a linear fit inverts the
  populations). A census of real samples hidden inside evicted windows declines
  when more than one FFT frame's worth exists. Inter-phrase floor measured:
  raw −45.01 dBFS → old chain −55.81 → **gated −240 dBFS, digital silence**.
  Five review rounds each found the previous guard's converse; every surviving
  predicate now has both sides pinned by behaviour tests. Known limits recorded
  in `docs/KNOWN_LIMITATIONS.md`: takes with no ≥500 ms pause decline (legato),
  steady unshaped hiss is physically indistinguishable from a pause and declines,
  and a quiet island ≤ ~375 ms bracketed by digital silence immediately before a
  burst is invisible to the census (the hold protects the mirror side).
  Affects: `services/vocalChain.ts`, `dsp/chainAnalysis.ts`,
  `effects/dynamics/NoiseGateEffect.ts` (first consumer).
<!-- CC2: alignment evidence -->
- **A real human cover is no longer refused by the aligner.** The reported case:
  correlation 0.423 against a floor of 0.607, refused — while the measured
  offset was very likely correct. Cause: **the confidence floors were calibrated
  on constructed covers whose take shared the reference's onsets to the sample**;
  ±40 ms of ordinary human timing variance dropped correlation into 0.43–0.57
  with the offset still correct to 0.029 s, and the old single-envelope evidence
  provably could not separate that band from unrelated audio (no floor value
  could work). Fix: the evidence changed, not just the floors — 240 ms ODF
  smoothing (lifts real covers +0.42, unrelated only +0.20, restoring
  separability), piecewise per-window lag agreement as a drift-robust second
  signal, and every threshold re-derived from enlarged populations (timing
  jitter, tempo drift, repeated choruses, leakage-like stems, room tone,
  same-tempo metronomes) inside kept tests with asserted margins:
  correlation floor 0.607 → **0.731**, prominence repurposed to drive ambiguity
  (**0.12**), new weak-guess floor **0.692**. The ±40 ms regime now scores
  0.809–0.933 vs unrelated ≤ 0.653. Four outcomes replace the binary verdict:
  `confident` (applied), `ambiguous` (repeated chorus — candidate placements
  offered, never auto-applied), `weak` (a usable guess, offered), `unrelated`.
  Measured drift is reported as seconds-per-minute instead of "not believable".
  Gain dependence and synthetic-population calibration remain recorded limits.
  Affects: `dsp/coverAlign.ts`, its fixtures, `services/coverJourney.ts`.
<!-- CC3: the refusal becomes actionable -->
- **A refused alignment is now actionable — and the advice is finally honest.**
  The user's case: best guess −8.258 s, refused, message said "drag it on the
  timeline, or run Align Vocal Timing". Cause: **for a negative offset only the
  instrumental can move** (clips clamp at zero — dragging the take can only
  increase the error), and Align Vocal Timing is a marker-to-grid warp that
  cannot move clips at all and needs a beat grid a fresh take doesn't have.
  Fix: sign-aware refusal copy naming the clip that can actually move and the
  amount; a one-click **"Apply the measured offset anyway"** (or per-candidate
  "Place at ±X s" rows when several placements are offered) that moves both
  clips through the same arithmetic as the confident arm, as one undoable
  gesture; the Place row stops claiming "measured offset +0.000 s" on refusal;
  and the clip Start in Properties became a typeable field. The refusal
  sentence and the dialog's controls branch on the same predicate, so the
  message can never name a control that isn't on screen.
  Affects: `services/coverJourney.ts`, `services/coverPlacement.ts` (new),
  `components/Dialogs/CoverChainDialog.tsx`, `components/Panels/PropertiesPanel.tsx`.
<!-- CC4: journey correctness -->
- **The Cover Chain keeps its own promises.** Four defects from the verified
  hunt: (1) a fresh separation installed a Stems session at stage 1 — four
  stages before the journey's own contract said any session is touched,
  destroying the user's session and undo history, with the cancel report then
  claiming "there is no session"; fixed by splitting stem landing into a
  documents-only half the journey uses (cancel now genuinely leaves the session
  untouched). (2) A mono take rendered 3.01 dB under the loudness Match
  Loudness had just set (constant-power pan vs the stereo instrumental's unity
  law); compensated at placement, stated in the Place row, and preserved by the
  apply-guess path. (3) A leakage-only Vocals stem (a real model behaviour,
  measured 41 dB down) crushed the take via Match Loudness with no warning; a
  measured plausibility floor now declines with the number. (4) Re-running the
  journey double-processed the take and accumulated ~85 MB duplicate
  Instrumental documents; reuse is now proven by content — a candidate is
  adopted only when it already holds the freshly computed sum sample-for-sample,
  so adoption writes nothing and can never destroy an edit (in-process or after
  a save/reopen round-trip), and a prior pass is announced before Run. Plus:
  honest decline wording when a document is closed mid-run, and the smoothing
  stage reads its one peak through a peak-only mixdown instead of allocating a
  ~346 MB full render. Affects: `services/coverJourney.ts`,
  `services/stemLanding.ts`, `services/coverChain.ts`, `multitrack/mixdown.ts`.

### Added

- **Noise Gate** as the Vocal Chain's eleventh automatic stage (see above) —
  in both the standalone Vocal Chain and the Cover Chain's clean stage.
- **Alignment outcome model** with candidate placements and measured drift,
  consumed by the Cover Chain's stepper and report.
- **Editable clip Start** in the Properties panel — type an exact position;
  commits like the sibling fields, one undo entry, no phantom moves on blur.
- **Peak-only mixdown mode** (`mixdownSessionPeak`) for consumers that need one
  number, not a render.

## [1.27.0] - 2026-08-13

### Fixed

<!-- MT2: session rate adoption -->
- **Play no longer stalls for twenty seconds on a session made of two songs.** This was the
  reported bug — "it takes a while to start the play with 2 tracks" — and 1.26.0 shipped it
  measured but unfixed. Cause: **the session's sample rate was decided once and never revisited.**
  `makeSession(44100)` set it at store init, `newSession` repeated the number, and the three insert
  paths (Insert Active File, a lane drop, the `insertActiveDocAsClip` test hook) all converted the
  *clip* to the session instead of the other way round — two of them with their own inlined copy of
  the conversion arithmetic `documentClipLength` already owned. So two 48 kHz files put on a
  session nobody had chosen a rate for were rate-mismatched by construction, and
  `MultitrackPlayer.play()` ran the 64-tap sinc over every sample of every clip, synchronously,
  before scheduling a single note.

  Three fixes, in order of how much each was worth:

  1. **An empty session adopts the rate of the first document put on it.** A session with no clips
     denominates nothing the user placed — 44 100 was a default, not a decision — so the first file
     names the rate, the clip lands at ratio 1, and there is nothing to resample. Adoption carries
     every session-sample number that exists at that moment (the cursor, the playhead, the zoom —
     re-resolved through `resolveSessionZoom`, never a raw `samplesPerPixel`) and is recorded inside
     the insert's own gesture, so one Ctrl+Z lifts the clip and the rate together. A session that
     already holds a clip never changes rate: two documents at two rates cannot both be native, and
     converting one of them is the honest answer.
  2. **A clip read that stays inside its file stops copying it.** With the rates matched, `play()`
     still took 222.8 ms, all of it `readClipSlice` building each slice with a per-sample
     JavaScript loop — ~34.6 M iterations and ~138 MB allocated — to produce arrays that
     `AudioBuffer.copyToChannel` copied again one line later. A fully in-range read at the session's
     own rate is now a `subarray` window onto the document and `copyToChannel` makes the single copy
     the graph needs; the zero-fill survives for reads that run off an edge, as one `set()` instead
     of a per-sample conditional. (1.26.0's entry blamed this residual on `readClipSlice`'s copy
     *plus* `buildClipBuffer`'s scale loop. The scale loop was already skipped at unity gain with no
     fade — the copy was the whole of it.)
  3. **The sinc left the play path for the sessions that still need it.**
     `multitrack/clipResampleCache.ts` holds each conversion per (document audio, session rate, clip
     window), warmed at *insert* time on `requestIdleCallback`, and shared by the realtime player
     and the offline mixdown through the same `readClipSlice`. The key is the **channel arrays**,
     not the document id: `AudioDocument` carries no revision counter and its id survives every
     edit, but `applyEdit`'s helpers allocate fresh channel arrays, so their identity *is* the
     revision counter — a `WeakMap` on them collects with the document, and a per-entry identity
     check catches a channel swapped underneath it. Bounded by construction: one document's worth of
     samples per document, LRU past that.

  Measured on the packaged app, same fixtures and same machine as 1.26.0's numbers — two 180 s
  stereo 48 kHz clips, `play()` medians, verdicts committed under `docs/bench/`:

  | session | `play()` process-cold | fresh ctx, warm process | re-play, running ctx |
  |---|---|---|---|
  | 1.26.0, 44 100 Hz (mismatched) | 22 039 ms | 21 237 ms | 42 718 ms |
  | 1.26.0, 48 000 Hz (matched) | 223 ms | 182 ms | 275 ms |
  | **now, reported flow (adopts 48 000)** | **30.9 ms** | **25.8 ms** | **25.4 ms** |
  | **now, genuinely mixed-rate, warm cache** | **25.6 ms** | **25.2 ms** | **24.7 ms** |

  The audible estimate the rig also reports (~50 ms) is measured AFTER `play()` returns and must be
  added to it, not read instead of it. Reproduce: `npm run build`, then
  `node scripts/first-play-latency-rig.cjs --launches=1 --probes-per-launch=2 --content=songs` and
  `--content=mixed`. The rig now READS the session's rate back from the app
  (`getStateSummary().sessionSampleRate`) instead of assuming it is the number it passed to
  `newSession` — an inference that adoption made false, and that would have had the verdict
  reporting a live resample branch over a session with none.
  Affects: `multitrack/sessionStore.ts`, `multitrack/sessionInsert.ts` (new),
  `multitrack/clipResampleCache.ts` (new), `multitrack/mixdown.ts`, `multitrack/laneDrop.ts`,
  `services/menuActions.ts`, `services/testHooks.ts`, `scripts/first-play-latency-rig.cjs`.

### Added

- **Clip waveform drawing is now covered by tests that read what it draws**, not only where it
  lands. Three mutations survived the suite until now: flipping the sign of the waveform's
  `center − v·amp` mapping, dropping `clip.offsetSample` from the drawn window's origin, and
  dropping or inverting the `docRate/sessionRate` ratio the window advances by. Each is a picture
  silently of the wrong audio. `ClipView.waveform.test.tsx` kills all three, with asymmetric
  fixtures (a symmetric one cannot tell a sign flip from the truth) and an explicitly-constructed
  mixed-rate session so the adoption above cannot make the third test vacuous.

## [1.26.0] - 2026-08-13

### Fixed

<!-- MT1: multitrack polish -->
- **The multitrack now opens Fit on the longest track.** A 2:58 session opened showing about 18
  seconds of itself, at "100%". Cause: the session had no zoom RULE, only four copies of the
  constant `{ samplesPerPixel: 512 }` (`newSession`, Open Session, stem landing, the test hooks), a
  fifth clamp written inline in the wheel handler, and no knowledge anywhere of how wide the lane
  is — 512 samples/px is 16 seconds of timeline whatever is on it. The toolbar's `− · % · + · Fit`
  cluster made it unreachable from the other side: it drove the EDITOR unconditionally, so in the
  multitrack view Fit fitted a document the user was not looking at, or was dead with none open.
  Fix: `sessionZoom.ts` resolves every session zoom through one clamp (fit == the zoom-out ceiling,
  100% == fit, the editor's F11-3/F11-9 ruling restated for a session) against a lane width
  `MultitrackView` measures and publishes; the cluster follows the active view; the first clip into
  an empty session re-fits, later inserts do not. **All FOUR session-load paths** commit a fitted
  zoom — `newSession`, Open Session, stem landing and the `openSessionFrom` test hook. The last
  three were missed on the first pass and are the reason the bug outlived it: opening the reported
  2:58 `.audm` still gave 512 samples/px against a fit of 5704.8, i.e. 15.97 s visible at ~1114%,
  and nothing downstream rescued it (`publishSessionLaneWidth` only re-fits a view already AT its
  fit). A session that gets SHORTER — delete a clip, trim one, undo — re-resolves too, so the zoom
  can never sit past a ceiling that moved under it and read as "fitted" to the next insert.
  Affects: `multitrack/sessionZoom.ts`, `multitrack/sessionViewport.ts`,
  `multitrack/sessionStore.ts`, `multitrack/sessionFile.ts`, `services/stemLanding.ts`,
  `services/testHooks.ts`, `components/Multitrack/`, `components/Layout/Toolbar.tsx`.

- **Clip waveforms in the multitrack are drawn to the same standard as the editor's.** Clips
  rendered as a coarse solid blob or a thin sparse line. Cause: a clip's envelope was rasterised
  across its FULL timeline width, capped at 4096 device px, then blit-STRETCHED over that width —
  so a 3-minute clip drew its visible portion from a small fraction of those columns and magnified
  it. Fix: the visible band is drawn at 1:1×dpr through the editor's own bucket/sample draw, now
  exported so the two surfaces cannot drift; the full-clip raster and its cap are retired. That is
  NOT "strictly less memory than the capped raster" — an earlier draft of this entry said so and it
  is false, because it compared a CSS-pixel band against a device-pixel cap: the band's backing
  store is ~4864 device px at dpr 2, which is LARGER than the 4096-px cap it replaces. The real win
  is that the raster no longer scales with clip LENGTH (a 3-minute clip cost ~7.6 MB at default
  zoom and ~30 MB at 4×) and that the LRU-200 cache retaining up to two hundred of them is gone
  entirely — peak memory falls by orders of magnitude, while the per-clip raster merely becomes
  bounded instead of unbounded. Affects: `components/Multitrack/ClipView.tsx`,
  `components/Editor/waveformRender.ts`.

- **Native `<select>` popups no longer render light-gray text on white.** Reported against Cover
  Chain's Reference picker. Cause: NOT the missing `color-scheme` the report assumed — that has
  been declared on `:root` since G1. Chromium paints a select's dropdown listbox with the author's
  background, as its own widget rather than on the glass surface, and three selects set a
  translucent white (`rgba(255,255,255,.04/.05/.06)`) that composites dark on the stage and
  near-white in the popup, under text coloured for near-black. An author background outranks the
  UA's dark base. Fix: an opaque `--glass-field-bg` token plus `select`/`option` element rules, and
  the three inline backgrounds switched over. The SELECTED row — the one under the cursor when the
  popup opens — needed the same treatment: it was `var(--accent-soft)`, itself translucent, and is
  now that accent composited over the field background once (`#1c3238`). Affects: `index.css`,
  `components/UI/glass.tsx`, `components/Dialogs/CoverChainDialog.tsx`,
  `components/Panels/SpatialPanel.tsx`.

<!-- CP1: fix round -->
- **A cover journey cancelled at the last stage no longer claims there is no session.** Cause: the
  cancel copy branched on `place || smooth` and said "there is no session" for both, but stage 5
  has already built the session by the time stage 6 can be cancelled — so the one sentence a user
  could check against their own screen was false. Fix: the message is per-boundary and now names
  what stage 6 did *not* do (the take is placed, its edges are not faded, the level is unchecked).
  Affects: `src/services/coverJourney.ts`.
- **A sub-service that throws mid-journey now produces a report instead of a rejected promise.**
  Cause: `runCoverJourney` had no `catch`, and the dialog has a `finally` but no `catch` either, so
  an exception left no report set while the rows from the part of the run that *had* happened
  stayed on screen looking like an outcome. Fix: the running stage is recorded as `failed` with the
  error's own message, everything after it as `pending`, and the report returns `completed: false`.
  Affects: `src/services/coverJourney.ts`.
- **The Cover Chain dialog no longer shows half-run stage rows beside a start-up error.** Cause: the
  journey rewrite dropped the `busy` arm from the row lookup that the previous dialog had, so
  results pushed by the live callback survived a run that could not start. Fix: restored, and pinned
  by a test. Affects: `src/components/Dialogs/CoverChainDialog.tsx`.

<!-- M4: found by combining the three lines -->
- **Three guards were passing on nothing, and one of them was guarding the release's headline fix.**
  (1) `stemLanding.test.ts`'s fitted-session guard used a 12 000-sample fixture whose fit is 8.72
  samples/px, so a hardcoded 512 is coarser than the zoom-out ceiling and gets CLAMPED back to the
  fit before any assertion sees it — reverting `stemLanding.ts` to the original bug left the suite
  green. It now uses a 20 s fixture (local to that test: raising the shared constant took the suite
  from 31 s to over 600 s, measured) and asserts `fit > 512` first, so the fixture cannot silently
  stop being able to express the bug. (2) `nativeSelect.test.tsx`'s source law matched `background:`
  and `background-color:` but not React's `backgroundColor:` — the spelling every select in this app
  would actually use, and one already present in four places — and its own self-test never exercised
  camelCase, so the hole was invisible from inside the test. The matcher now covers it, including
  behind a ternary, while a following `border:` still cannot be mistaken for the background. (3) The
  walker's select sweep named the Spatial and Properties pickers in its docblock while running only
  inside the dialog walk, where neither panel is mounted; it now sweeps both cards, and reports how
  many selects each contributed so a zero cannot hide. Affects: `src/services/stemLanding.test.ts`,
  `src/components/UI/nativeSelect.test.tsx`, `scripts/e2e-navigate.cjs`.
- **Two packaged-walk steps were silently testing nothing, each broken by a change the other line
  made.** Neither line could have seen it: the multitrack work never ran the smoke, and the Pipeline
  work never ran the walker. (1) The session-undo step's trim drag grabbed a clip's right edge at
  its layout rect, but a session now opens FITTED, so a 2 s clip fills the lane exactly and the
  step's own +150 px move pushed that edge outside the visible lane — the coordinate still looked
  valid and `elementFromPoint` returned the view rather than the resize handle, so the drag trimmed
  nothing. It clicks Fit first now, which also gives the multitrack's Fit button its first packaged
  exercise. (2) The Transcript step closed Transcribe with `cancelDialog`, which presses Escape and
  waits for the modal backdrop to vanish; Transcribe is one of the nine that now open HOSTED, draws
  no backdrop and installs no Escape handler, so the helper reported success having closed nothing
  and the walk's liveness guard caught the tool still open. It uses the hosted-aware
  `dismissOpenTool` now. Affects: `scripts/e2e-smoke.cjs`, `scripts/e2e-navigate.cjs`.
<!-- M4: found by combining the three lines -->
- **The cover journey's session opened at 512 samples/px instead of fitted.** Cause: stage 5 builds
  its session through the same load-shaped apply `openSessionViaDialog` and `landStems` use, and it
  was written in parallel with the fix that gave those four paths a resolved zoom — so it shipped a
  FIFTH copy of the hardcoded `{ samplesPerPixel: 512 }` the other four had just lost. It bites
  hardest here: a cover session is a whole song plus a take, i.e. exactly the minutes-long material
  the original report was filed against, and 512 samples/px is ~16 s of timeline whatever is on it.
  Fix: `defaultSessionZoom(session)`, as the other four do. Affects: `src/services/coverJourney.ts`.
- **The cover journey's take picker rendered light-gray on white when opened.** Cause: the journey
  rewrite added a SECOND document picker, and it carried the translucent `rgba(255,255,255,.05)`
  background that the native-select fix had just removed from every select in the app — the new
  control never had the fix because it did not exist when the fix was written. Fix: the opaque
  `--glass-field-bg`, and the existing source-derived guard now covers it.
  Affects: `src/components/Dialogs/CoverChainDialog.tsx`.

### Added

<!-- CP1: the alignment DSP -->
- **Automatic global alignment of a cover take to the original vocal.** Why: placement was the one step
  of the journey the app could not do at all, and doing it wrong is worse than not doing it — a take
  placed at a confidently wrong offset is harder to notice than one left at zero. How it works: it
  cross-correlates the app's own onset envelope (`tempoCore.onsetEnvelope`) of the two recordings, in two
  passes — a coarse pass with both signals brought to a fixed 22.05 kHz analysis rate, which decides
  *where* and *whether to believe it*, and a fine pass at each file's own rate refining that inside
  ±0.2 s. Onset flux rather than a level envelope is what makes the refusal arm work at all: two
  unrelated recordings of singing have similar amounts of silence and similar loud sections, so their
  level envelopes correlate on the shape of "someone is singing"; their attacks do not line up. Two
  single-pass designs were built and measured and lost first — a full-rate-only pass left the two
  populations OVERLAPPING (worst cover 0.152 prominence against best unrelated 0.155), and a coarse pass
  over `decimateMono`'s ~11 kHz was worse still (0.2035 against 0.2045). Both confidence thresholds are
  points inside a measured gap, and the test that derives them prints both populations every run and
  fails if the gap ever stops containing the shipped constants. Below either threshold the stage places
  the take at the start of the original and states the numbers rather than guessing. It is a
  **placement, not a warp**: Align Vocal Timing and Align Lyrics stay manual, each because it needs a
  decision only the user can make. Affects: `src/dsp/coverAlign.ts` (new),
  `src/dsp/__fixtures__/coverAlignFixtures.ts` (new).

<!-- CP1: the pre-clamp peak -->
- **`mixdownSession` now reports the peak the bus reached before the master clamp.** Why: the clamped
  output cannot answer "did this session sum over full scale?" — its own peak is at most 1.0 by
  construction, so a render that flat-topped for thirty seconds and one that never came near the ceiling
  read identically. The cover journey's final level check needs the number the clamp removed. How: it is
  measured inside the clamp pass itself, the one place the pre-clamp value is still in scope, rather than
  by a second summation that would have to re-derive every gain, pan and fade. Affects:
  `src/multitrack/mixdown.ts`.

<!-- U2: the module-bar reorder and the Pipeline module. -->
- **A Pipeline module.** Why: the user asked to "add a module 'Pipeline' to choose pipelines from".
  The eleven long-running tools had two doors — the Pipeline menu, and the bottom of the Effects
  card, reachable only by scrolling past every registered effect. How to use: click **Pipeline** in
  the module strip; the card lists the same eleven rows in the same four groups (Tempo & Timing,
  Voice, Analysis, Mix), one click each, greyed by the command's own predicate.
  Affects: `src/components/Panels/PipelinePanel.tsx`, `src/services/pipelineTools.ts`,
  `src/components/Panels/EffectsPanel.tsx`.
- **Pipeline tools open IN the module column instead of as a modal.** Why: the user asked that
  selecting a pipeline "open the module in the extended modules instead of a modal" — a multi-stage
  pass is something you watch, and a centred modal covered the waveform it was working on. How to
  use: pick a tool from the Pipeline card, the Pipeline menu or the Effects card's tool rows; it
  mounts as a wide card in the module column with the strip showing Pipeline as the active module,
  no backdrop and nothing dimmed, so you can keep selecting audio, moving the playhead, zooming and
  switching view while the stepper runs beside the waveform. Close it with the ✕ in its header.
  Nine tools moved (Match Tempo, Align Vocal Timing, Auto-Remix, Voice Changer, Vocal Chain, Cover
  Chain, Align Lyrics, Transcribe, Separate into Stems); Detect Tempo and Spatial Positioner have no
  UI of their own, and New File / Export / Convert / Record / the per-effect parameter dialogs stay
  modal — each is one question rather than a workspace.
  Affects: `src/components/Dialogs/DialogHost.tsx`,
  `src/components/Dialogs/PipelineToolHost.tsx`, `src/components/Dialogs/DialogShell.tsx`,
  `src/services/dialogBus.ts`, `src/App.tsx`.

<!-- M4: found by combining the three lines -->
- **The packaged smoke now exercises the alignment's BELIEVED arm, not just its refusal.** Why: the
  Cover Chain's fixtures are filtered noise with no syllables, so every packaged run to date proved
  that a bad alignment is refused and none proved that a good one is believed and lands where it
  says — the more dangerous half, since a take placed at a confidently wrong offset is harder to
  notice than one left at zero. How: `make-test-cover.cjs` emits a pair rendering ONE syllable
  schedule twice, the take's laid down 0.75 s later as a different performance, so the offset is
  built in rather than measured; the smoke drives it through all six real stages and asserts the
  recovered offset against that constant within the DSP's proven ±10 ms — measured at **1.39 ms**,
  correlation 0.946 and prominence 0.668 against floors of 0.607 and 0.186. It is also the first
  packaged exercise of the negative-offset arm, which shifts both tracks rather than clamping the
  take to zero. The song ships WITH ITS STEMS, so stage 1 takes its reuse path, and that is a
  finding rather than a convenience: driving the real separation model with a synthetic mix routes
  essentially all of it to Other (source RMS −17.99 dBFS; the Vocals stem came back −59.28, i.e. 41
  dB down and empty), so the alignment was handed a silent reference and correctly refused. A fresh
  model pass on this arm would need a real vocal recording, which the repo cannot carry; the
  fresh-separation path stays covered by the noise pass beside it.
  Affects: `scripts/make-test-cover.cjs`, `scripts/e2e-smoke.cjs`.

### Changed

<!-- MT1: multitrack polish -->
- **The first-play latency rig can build the session that was reported** (`--content=songs`,
  `--session-rate=`): two 3-minute stereo 48 kHz clips on two tracks. Its previous one-track
  2-second tone existed so `playCallMs` measured graph build "and not content size" — content size
  is the whole defect. Affects: `scripts/first-play-latency-rig.cjs`,
  `scripts/make-test-latency.cjs`.

<!-- CP1: the Cover Chain becomes the whole journey -->
- **The Cover Chain now does the whole journey instead of listing five things for you to do.** Why: the
  shipped chain matched a take's tone and level and then documented five manual steps either side of it
  — separate the original, run the Vocal Chain, repair words, align timing, build the session. Every one
  of those was a defensible decision on its own and their sum was not the product the name promises. The
  user, after running it: *"you are supposed to input the original song AND the vocals, clean the vocals,
  align with original, remove the vocals from original, add cleaned vocals to music of original, smooth."*
  How to use: open the original song and your vocal take, `Pipeline → Cover Chain…`, pick both in the two
  boxes at the top, press **Run the journey**. Six stages run unattended — separate (reusing this song's
  stems when they are already open, and saying which it did), clean with the full Vocal Chain, align,
  match with the four existing matching stages, build a two-track session, smooth and check the level —
  each reporting what it measured, and the two stages that are themselves chains nesting their own
  chains' stages rather than collapsing them behind one bar. Cancel works between stages; the session is
  built only at stage 5, so cancelling earlier leaves documents and no session, and the dialog says so
  *before* the run. Undo stays per-sub-pass ("Vocal Chain" and "Cover Chain"), and the report says why
  there is deliberately no single entry across all of it: an undo entry belongs to one document, and this
  pass touches two documents and a session. Affects: `src/services/coverJourney.ts` (new),
  `src/components/Dialogs/CoverChainDialog.tsx`, `src/services/testHooks.ts`, `scripts/e2e-smoke.cjs`.

<!-- U2: the module-bar reorder and the Pipeline module. -->
- **The module strip's order, and the card the app opens with.** Why: the user asked to "reorder the
  module in the module bar, make 'Files' default at opening, 'History' always last". How to use:
  nothing to do — the strip now reads Files, Effects, Pipeline, Markers, Properties, [Remix], History,
  and the app opens on the **Files** card instead of History. Remix's contextual slot is unmoved; it
  is History that overtakes it. The order is stored as a SLOT per module rather than as a fixed
  sequence, so a module added later declares where it belongs and cannot silently land after History.
  Affects: `src/components/Layout/ModuleStrip.tsx`, `src/App.tsx`.
- **Switching module is refused while a pipeline pass is running, and says why.** Cause: every one of
  the nine tools keeps its pass in component state and cancels it on unmount, so unmounting a running
  tool discards the pass rather than backgrounding it. Fix: while a pass runs the module strip greys
  out and the tool's ✕ refuses, both carrying the reason; the rest of the app — waveform, transport,
  toolbar, editing — stays live throughout, and only the two actions that would throw the pass away
  are blocked. Global keyboard shortcuts are suppressed for the duration of a run only, keeping the
  guard that stops a `Ctrl+O` landing a running pass on a document the user just replaced.
  Affects: `src/App.tsx`, `src/services/dialogBus.ts`, `src/components/Layout/ModuleStrip.tsx`.

<!-- M4: found by combining the three lines -->
- **The Cover Chain tool asks for 640 px rather than 680, so the hosted card and the stage keep
  their measured sizes.** Why: `TOOL_HOST_WIDTH` is DERIVED from these nine tools — it is the widest
  width any of them asks `DialogShell` for — so a tool widening itself widens the host card for
  every tool and costs the waveform 40 px at every window size. The journey rewrite arrived asking
  for 680, which would have cut the lane at the minimum window to 378 px, under the 400 px floor.
  Nothing in the rewrite needed it: the two multi-column tables that made this the widest tool in
  the first place (the per-band EQ curve and the before/after summary) were REMOVED by that same
  rewrite, and what remains is a vertical stack of flowing text and full-width bars with no
  fixed-width content. Affects: `src/components/Dialogs/CoverChainDialog.tsx`.

### Removed

<!-- MT1: multitrack polish -->
- **`clipWaveformCache` and its eight call sites.** Once clip waveforms started drawing straight to
  the on-screen canvas, nothing produced a cache entry any more: `getClipWaveformCanvas` had zero
  production callers, so the eight `purgeClip`/`clearClipWaveformCache` calls scattered across the
  store, the session loader, `fileService`, stem landing and the test hooks were maintaining a Map
  that was permanently empty — as was the undo binding's clip-id diffing and `removeTrack`'s
  `removedClipIds` bookkeeping, which existed only to feed it. Its 170-line suite passed by calling
  the dead producer directly to manufacture the entries it then certified were purged. Deleted
  rather than left as a trap for the next reader to wire something into.

## [1.25.0] - 2026-08-13

### Fixed

- **Opening a large file no longer freezes the window, and no longer costs an extra copy of it.** Cause:
  four independent contributors on one path. `preload.cjs` ended every `readFile` with an
  unconditional `buf.buffer.slice(...)`, a full second copy of the file alive alongside the first, and
  it is only ever *needed* when the received view is a window into a larger buffer — measured on a real
  65 MiB read, the IPC clone delivers `byteOffset 0` with `byteLength === buffer.byteLength`, so the
  copy bought nothing there. `openFilePath` then read its container metadata (FLAC stream info, ID3
  chapters, Vorbis comment, Opus tags) *after* decoding, so the whole file had to stay readable
  alongside its own decoded samples. `decodeArrayBuffer` handed `decodeAudioData` another copy
  (`buf.slice(0)`) for non-WAV sources. And `decodeWav` — a per-sample loop, ~17 million iterations for
  that file — ran on the renderer's main thread, so the window could neither paint nor answer input for
  the whole of it; measured on the incident's own files, the pre-fix open blocked the main thread for
  **308 ms**. Fix: the preload copies only when the view really is offset or short; `openFilePath` lifts
  every scrap of metadata out *before* the decode, which lets the decode CONSUME the buffer instead of
  coexisting with it; and WAV decoding moved to a worker (`src/workers/wavDecode.worker.ts`) with the
  bytes transferred in and the channels transferred back, so neither direction clones. For a 65.2 MiB
  file the transient peak drops from ~195 MiB to ~130 MiB, and what coexists with the decoded samples
  from ~130 MiB to nothing — the document alone. One copy in that count is **not** removable here:
  `contextBridge` copies return values across the world boundary (measured directly — mutating the
  preload's buffer after the return leaves the page's copy unchanged), so ~65 MiB exists twice at the
  hand-off however the preload is written. The main-thread block during an open now tracks the cost of
  merely *reading* the file (**217 ms vs a 187 ms read-only floor**) rather than exceeding it by the
  length of the decode. Only WAV moved: the other formats decode through `decodeAudioData`, which the
  Web Audio API does not expose to workers. Affects: `electron/preload.cjs`,
  `src/services/fileService.ts`, `src/audio/decodeAudio.ts`, `src/audio/decodeWavOffThread.ts`,
  `src/workers/wavDecode.worker.ts`.
- **A failed open now leaves nothing behind instead of wedging the app.** Cause: `openFilePath` added
  the document to the store and *then* seeded its markers, with no rollback anywhere. A failure after
  the add left a document that was selected, undrawable, and read by every panel that follows the
  active document — which is precisely the state the incident ended in. Fix: the whole open is wrapped;
  anything that throws after the add rolls the document back out and releases its history and peak
  caches, and the error propagates so the caller names the file in one dialog. The rollback also puts
  the *view* back: `closeDocument` re-activates whichever document is last, which is only coincidentally
  the one that was active, so with A and B open and A active a failed open of C used to leave B active
  and A's selection, cursor and zoom gone. All four are captured before the open and restored. Affects:
  `src/services/fileService.ts`.
- **The Files panel says which file it is opening.** Why: now that a large decode no longer freezes the
  UI, a long open is *invisible* rather than obvious — and "responsive but showing nothing" is as
  unreadable as a freeze. Files being read and decoded appear in the panel with an `Opening…` row until
  they land or fail. Affects: `src/services/openProgress.ts`, `src/components/Panels/FilesPanel.tsx`.
- **Save does nothing on a document with nothing to save.** Cause: `file.save` was gated on merely
  having an open document, and an in-place Save is not a cheap no-op — it re-encodes every sample and
  overwrites the source file, and for a 16- or 24-bit WAV it retags the document as 32-bit float on the
  way, so Properties starts reporting a different file than the one that was opened. A stray click on a
  pill 3 px from Open, or Ctrl+S at any moment, did all of that to a clean document. Fix: gated twice —
  the command's `enabled` and the Toolbar pill both require unsaved work, and `saveDocumentLocked`
  returns early for a clean document with a `filePath`. The predicate is `hasUnsavedWork`, the one the
  close guard already prompts on, so "the app would warn me about losing this" and "Save does
  something" cannot disagree; it covers `neverSaved`, so a computed document still saves its first
  time. Save As is untouched — it is an explicit "write this to a file I name" gesture and is
  meaningful with no edits behind it. Affects: `src/services/menuActions.ts`,
  `src/services/fileService.ts`, `src/components/Layout/Toolbar.tsx`.
- **A denied write offers a way out instead of a dead end.** Cause: a failed write surfaced the write
  layer's reason ("Write denied (protected directory)", EACCES, a full disk) in a dialog with one
  button. The text was right; the dialog offered nothing to do about it, while the action that resolves
  every one of those reasons is writing somewhere else. Fix: both write sites offer
  `['Save As…', 'Cancel']` and route the first choice to the save-as flow, which retries by looping
  rather than recursing — the answer to a refused location is another location, so the offer repeats
  without growing the stack, and it ends when the user cancels either dialog. The keyboard default is
  **Cancel**: the box appears unbidden on a failure the user did not cause, so a stray Return on it
  does nothing rather than opening a file dialog (`defaultId` is now forwarded across the dialog IPC,
  sanitized against the button list that actually survived validation). Affects:
  `src/services/fileService.ts`, `electron/ipc.cjs`.
- **Save is no longer Open's immediate neighbour in the toolbar.** Cause: the two pills sat 3 px apart
  with nothing between them, so a click aimed at Open that landed one pill to the right ran a full
  re-encode and overwrite of the file on disk. Fix: the same divider the toolbar's other groups use now
  separates them. Affects: `src/components/Layout/Toolbar.tsx`.
- **Ctrl+W closes the document, as the File menu has always claimed.** Cause: the `File > Close` row has
  advertised `Ctrl+W` since Task 11, but `SHORTCUT_TABLE` never carried the combo — the label named a
  key that did nothing. Verified in the running app rather than only against the table: Electron's
  default application menu *is* present and *does* bind `CommandOrControl+W` to `role: 'close'`, but it
  never fires here (the window is frameless and carries no menu bar), so pressing Ctrl+W before this
  change did nothing at all — two documents open, two documents still open, window untouched. Fix:
  wired to `file.close`, i.e. `closeDocumentFlow`, so the accelerator inherits the
  prompt-before-discarding guard. It closes one document and leaves the window alone. Affects:
  `src/services/shortcuts.ts`.
- **The toolbar pill really is on the waveform's axis now, with the module card closed as well as
  open.** Cause: the band clamped its right padding to `max(inset, 362px)` to keep the pill from
  sliding under the module strip once the closed card let the stage run on beneath it. Measured in
  the built app, the clamp was guarding against something that cannot happen and cost the claim it
  was protecting: the pill is 860.5 px wide, so centred on the closed-card axis (799.7) it ends at
  1230 while the strip starts at 1237.4 — it clears by 7.4 px. The clamp instead pinned it at 625.7,
  **174 px off** the axis the status and edit pills sat on, in a state this release newly made
  reachable, while the guide, the README and this file all said the three pills shared one axis. Fix:
  the padding mirrors the stage's insets on both sides, so all three centre together in both states.
  The clearance is thin and depends on the zoom readout's width, so the packaged smoke now asserts
  the toolbar pill's centre in BOTH card states — it had been collecting that rectangle and never
  checking it — and asserts that the pill clears the strip at the default zoom and at the deepest
  zoom the fixture allows. Affects: `src/components/Layout/Toolbar.tsx`, `scripts/e2e-smoke.cjs`.
<!-- F11: the F11 series' Fixed entries start here. -->
- **The dev app no longer wedges itself the second time a large file changes.** Cause: React 19's
  DEVELOPMENT react-dom publishes every commit to the DevTools performance track with
  `performance.measure(name, { detail })`, and the `detail` carries the props that CHANGED on the
  re-rendered component, serialised by a generic leaf walker. A `Float32Array` is neither a plain Array
  nor a plain Object to that walker, so it falls into generic recursion and is enumerated one entry per
  sample. `<WaveformView doc={doc}/>` and `<SpectrogramView doc={doc}/>` passed the WHOLE
  `AudioDocument`, whose `channels` is a top-level field, so the second change of a large document
  asked the structured cloner to serialise ~30.7 million entries — about 4 GB against a 3.5 GB renderer
  ceiling. The resulting `DataCloneError` escaped `flushPassiveEffects` BEFORE `executionContext` was
  restored, leaving React's `CommitContext` bit set permanently: every later update died with "Should
  not already be working", so the renderer never rendered again, the zustand subscriptions registered
  in the never-mounted passive effects went deaf, the playback engine never loaded, and no shortcut or
  dialog ever installed. Fix, in two parts. Both editor views now take a **document id** and select the
  document out of the store, so the prop is a string and the profiler's diff is two cheap entries —
  which is also the right shape regardless of the profiler, since a 65 MiB object graph in a prop
  defeats memoisation and hangs DevTools' own prop inspector. And a dev-only backstop covers every
  other component: react-dom computes `supportsUserTiming` ONCE, when its module evaluates, from
  `typeof performance.measure === "function"`, so a side-effect module imported first in `main.tsx`
  makes `performance.measure` non-callable for exactly the span of the (synchronous) import graph's
  evaluation and restores it on the next microtask — after react-dom's init, before any app code. The
  app itself never calls `performance.measure`. Production is unaffected either way: the production
  react-dom has no `logComponentRender` at all. Affects: `src/App.tsx`,
  `src/components/Editor/WaveformView.tsx`, `src/components/Editor/SpectrogramView.tsx`,
  `src/dev/userTimingGuard.ts`, `src/dev/installUserTimingGuard.ts`, `src/main.tsx`.
- **A long menu scrolls instead of adding empty space at the bottom of the app.** Cause: not what it
  looked like. The dropdown is `position: absolute`, so it never changed an ancestor's layout box —
  but `index.css` gives `html, body, #root` `height: 100%` and **nothing** in that chain sets
  `overflow: hidden`, and an absolutely-positioned box still contributes to the DOCUMENT's scrollable
  overflow region. A panel taller than the window therefore made the whole document scrollable, and
  because `body` is a flex column, scrolling it read exactly as "a new space at the bottom pushing
  everything else up". The Effects menu was about 33 rows (~900 px), so any window under ~940 px hit
  it. Fix: the panel is rendered through a portal into `document.body` with `position: fixed`, its
  top/left measured from the section wrapper, `max-height` set to the space actually below it (floor
  96 px) and `overflow-y: auto`. The portal is load-bearing rather than stylistic — `TitleBar` carries
  `backdrop-filter`, which would make it the containing block for a fixed descendant and reinstate the
  bug. Z-order is unchanged (50, above the glass cards' 20 and below dialogs' 40). Affects:
  `src/components/Layout/MenuBar.tsx`.
- **Zooming out past the end of the track stopped moving the tics and the timeline.** Cause: the
  waveform and its overlays disagree about where the track ends. `getPeaksForRange` clamps its request
  to the channel's real length and then spreads the survivors over all buckets, so once the visible
  window runs past the end the painted waveform is byte-identical for every further zoom-out — while
  the beat tics and the ruler map through `sampleToPixel` with the raw `samplesPerPixel` and no clamp,
  and keep compressing. The two clamp paths were also 32× apart: the wheel gesture allowed
  `length / 50` while the fit was `length / 1600`, so that whole incoherent range was reachable. Fix:
  one clamped resolution in the store (`resolveZoom`), which is now the only place either clamp
  exists; the wheel, the −/+ buttons, Fit, document activation and the lane re-measure all funnel
  through it, and the renderer, the tic layer and the ruler read the one resolved pair. The zoom-out
  limit and the fit are now the same number by construction, so they cannot disagree. Affects:
  `src/stores/appStore.ts`, `src/components/Editor/useEditorGestures.ts`,
  `src/components/Layout/Toolbar.tsx`, `src/services/editorViewport.ts`.

- **The cursor and a dragged selection now always land on a whole sample.** Cause: the editor's gesture
  resolver (`snapped()`) returned its raw, pixel-derived value untouched whenever the magnet was
  suspended with Alt or the document carried no snap targets — and `pixelToSample` produces a fraction
  of a sample at any zoom that is not a whole number of samples per pixel, which since F11-3 is the
  *normal* state of a freshly-opened document (a fitted zoom is `docLength / laneWidth`). The result
  was committed straight to `setCursor` and to `dragToSelection`, so both the cursor and a dragged
  selection could sit between two samples; the packaged navigation walker caught a cursor resting at
  sample 121308.03126517865. It was never only a display nit, because `marker.add` writes
  `positionSample: cursorSample` verbatim — the fraction became marker DATA, and travelled from there
  into the cue chunk of every export written from it. `TimelineRuler`, the other surface that writes
  this same field, had always rounded its own seek, so the two disagreed about whether `cursorSample`
  is an integer at all. Fix: `snapped()` rounds on both arms, settling it where the value is produced.
  The snapping arm is unaffected in practice — snap targets are integer sample positions already, so
  the round is a no-op there and only the raw path moves, by less than one sample. Affects:
  `src/components/Editor/useEditorGestures.ts`.

### Added
<!-- F11: the F11 series' Added entries start here. -->
- **The position line has a red handle you can drag.** Why: the line could be placed by clicking but
  never *grabbed*, so nudging it meant re-clicking and hoping. A red triangle now sits at the top of
  the line, centred on it, with a generous grab area and `grab`/`grabbing` feedback. It is drawn by one
  function shared by the waveform and spectral views, so the two cannot drift, and it is deliberately
  unmistakable next to a marker flag: red against the marker's orange, isoceles and centred ON the line
  against the marker's right-hanging right angle, over the same solid white line as before. Grabbing it
  does not move it, dragging it never touches the selection, and a double-press on it does not select
  all. The drag reuses the existing magnet verbatim — the same `snapSample` call, the same targets
  frozen at pointerdown, the same `Alt` escape hatch re-read on every event. The cursor stays view
  state: nothing here is undoable. Affects: `src/components/Editor/waveformRender.ts`,
  `src/components/Editor/useEditorGestures.ts`, `src/components/Editor/SpectrogramView.tsx`.
- **The timeline seeks on the press and scrubs while you hold it.** Why: the ruler already seeked, but
  on `click` — which fires only after the button comes back up, so the line lagged the press, and
  holding the pointer did nothing at all. The handler moved to pointerdown/move/up: the seek lands on
  the press, and holding and dragging scrubs the position line live out of the same code. The position
  goes through the same magnet the canvas uses, with the same `Alt` suspension and with the targets
  frozen at the press so an analysis completing mid-scrub cannot move the pointer under your hand; the
  multitrack ruler passes its own session targets at its own zoom rather than being quantised at the
  editor's scale. Seeks are clamped to the track's length now, not only at zero. Playback is untouched:
  moving the position line has never re-seeked a running engine. Affects:
  `src/components/Editor/TimelineRuler.tsx`, `src/components/Editor/WaveformView.tsx`,
  `src/components/Editor/SpectrogramView.tsx`, `src/components/Multitrack/MultitrackView.tsx`.
- **A newly opened track is shown whole, fitted to the lane.** Why: opening a file laid it out at a
  nominal 1600-pixel viewport (`docLength / 1600`), which is not the editor's actual width and was
  never fit-to-canvas — and the **Fit** button restored exactly that same not-quite-fit, so the gap
  existed twice. The editor lane now publishes the width it actually measures, and both the open and
  the Fit button use it: the whole track exactly fills the lane. This applies to everything that
  arrives through `addDocument` — opens, imports, recordings, stems, remixes and mixdowns — so a
  computed document shows itself whole on first sight too. **Zoom-% semantics, stated deliberately
  rather than drifted into: 100% is Fit — the whole track exactly fills the editor lane. Zooming in
  raises the number (200% shows half the track), and because Fit is also the furthest the editor zooms
  out, the readout never drops below 100%.** Affects: `src/stores/appStore.ts`,
  `src/services/editorViewport.ts`, `src/components/Layout/Toolbar.tsx`,
  `src/components/Editor/WaveformView.tsx`, `src/components/Editor/SpectrogramView.tsx`.
- **A Pipeline menu, holding the ten advanced tools in one place.** Why: Detect Tempo, Match Tempo,
  Align Vocal Timing, Auto-Remix, Voice Changer, Vocal Chain, Cover Chain, Align Lyrics, Transcribe
  and Separate into Stems had accumulated across the head and tail of the Effects menu and the middle
  of the Edit menu, over ten releases, with no rule saying which went where. They are **moved, not
  copied**, into a sixth top-level menu grouped by subject: Tempo & Timing, Voice, Analysis. Ids,
  enablement predicates, labels, shortcuts and run bodies are untouched — only placement moved.
  `Capture Noise Print` deliberately stayed at the top of Effects: it is an instant profile of the
  selection rather than a long pass, and the only thing it primes is the Noise Reduction effect a few
  rows below it. `MenuSection['title']` was a closed five-value union guarded by a code comment citing
  "Plan Ruling 5"; the user overruled that ruling, and the comment now records the reversal rather
  than the rule. One thing is genuinely given up: the Effects head used to list Align Vocal Timing,
  Align Lyrics and Vocal Chain adjacently *because that is the order they must be run in*, and
  grouping by subject drops that hint — the stage notes in `vocalChain.ts` and `coverChain.ts` are now
  the only surface that states run order, and their tests still pin it. Every string naming an old path
  was swept — in the app, and (a second review found 23 survivors the first pass had missed, a third
  four more) in the README, the known-limitations log, five code comments, two smoke step headers that
  contradicted their own bodies, and the two Electron integration tests whose skip message told the
  user to download models from a menu that no longer offers them. The claim is now a sweep of the
  whole repo rather than of the app alone, and it is checkable: no `Effects →`/`Edit →` (or `>`, or
  `->`) string outside the historical planning records — deliberately left alone —
  names a command that moved. Affects: `src/services/menuActions.ts`,
  `src/components/Dialogs/{AlignTimingDialog,CoverChainDialog}.tsx`,
  `src/effects/time/{AlignTimingEffect,MatchTempoVariableEffect}.ts`,
  `src/services/{coverChain,vocalChain,beatGrid,beatGridDisplay}.ts`, `README.md`,
  `docs/KNOWN_LIMITATIONS.md`, `scripts/e2e-smoke.cjs`,
  `electron/{transcribeIntegration,voiceIntegration}.test.cjs`.
- **The Effects module card carries the Pipeline tools, one click each.** Why: the tools shipped
  menu-only across ten releases while the card still listed nothing but the effect registry — and the
  card is the surface this user actually works from. The effect list is unchanged and still first;
  below it the same three groups as the Pipeline menu, each row firing the same `runCommand` the menu
  fires. Labels and enablement are read from the command registry itself (`getMenuSections`,
  `isCommandEnabled`), never copied, so the panel and the menu cannot disagree about what a command is
  called or when it is available. Tool rows are a **single** click, against the effect rows'
  double-click: an effect row opens a parameter dialog, a tool row runs a verb the menu already runs
  on one click. Affects: `src/components/Panels/EffectsPanel.tsx`.
- **A file can be dragged onto a multitrack track — from the Files panel or from Explorer.** Why: the
  user's words were "we can't drag a file on a track in multitrack, it's a real issue". They were
  exactly right: HTML5 drag-and-drop did not exist anywhere in this app — no `draggable`, no
  `dataTransfer`, no `onDrop`, and no bridge that could learn a dropped file's path at all. The only
  way to get audio into a session was *Insert Active File at Cursor*, which places the ACTIVE document
  at the CURSOR — never the file you meant, at the place you pointed. Dragging a Files-panel row onto a
  lane now places that document where you dropped it; dragging an audio file from Explorer opens it
  through the REAL open path — the same decode, the same rollback, the same failure dialog — and then
  places it identically. The drop position goes through the clip drag's own magnet, which was
  extracted to `clipDropPosition.ts` and is now called by BOTH the drag and the drop rather than
  copied (the three lines it replaced were deleted from `ClipView`, not duplicated). The lane
  highlights and a ghost line shows the snapped start while dragging, so "no highlight, no action" is
  readable before you let go. One drop is one session-history entry (`Add clip` / `Add clips`),
  following the `Record clip`/`Record clips` precedent, so a single undo lifts a whole multi-file
  drop. A dropped path is also the first one that reaches `file:read` without having been through the
  open or save dialog, so it needed read-approval of its own: the preload mints it beside
  `webUtils.getPathForFile`, over a channel the renderer cannot reach, and only for a path
  `getPathForFile` returned non-empty — which it does only for a genuine user drop, never for a `File`
  web content constructed itself. Affects:
  `src/components/Multitrack/{clipDropPosition,TrackLane,ClipView}.tsx`,
  `src/multitrack/{laneDrop,session}.ts`, `src/components/Panels/FilesPanel.tsx`,
  `electron/{preload,ipc}.cjs`.
- **A file dropped anywhere that is not a track lane does nothing.** Why: belt and braces around the
  drop target above. `navigateOnDragDrop` — the flag that would make Chromium replace the whole app
  with a file viewer — has defaulted to false since Electron 3 and this app never sets it, so this is
  insurance against config drift rather than a fix for a live bug, and the code says so. It fires only
  for drags carrying `Files`: an earlier unconditional version also suppressed the default action of
  TEXT drags, which is what inserts dropped text into a field. Affects: `src/App.tsx`.


- **DevTools open by themselves on a dev run.** Why: a standing user rule — while developing, the
  console is open without anyone asking for it. Detached, so it never takes width from the window the
  layout was built for. Dev runs only: the gate is `VITE_DEV_SERVER`, the same signal `main.cjs`
  already routes the dev-server load on, and it fails closed on an unknown `isPackaged`, so a packaged
  build can never be talked into it by an env var. `AUDITORIUM_TEST` suppresses it ahead of everything
  else, because the packaged smoke pins its window geometry and a second window would race
  `firstWindow()`. Affects: `electron/devToolsPolicy.cjs`, `electron/main.cjs`.
- **An acceptance run for large opens.** `node scripts/e2e-open-large.cjs` drives the built app over the
  smoke's Playwright-Electron rig and opens two large WAVs back to back, asserting both documents, the
  second's rendered waveform, the in-flight row, and a real click accepted afterwards. Its
  responsiveness check is self-calibrating: it first measures what delivering the same file over IPC
  costs the main thread on its own, then requires the full open to block no longer than that. Affects:
  `scripts/e2e-open-large.cjs`.
- **An icon-only edit toolbar, floating above the bottom bar.** Why: cut/copy/paste/delete and
  undo/redo had no pointer surface at all — they lived in the Edit menu and on the keyboard only.
  How to use it: eight lucide glyphs in three groups — `Cut · Copy · Paste · Delete` │
  `Trim · Silence` │ `Undo · Redo` — on the waveform's axis, 16 px above the status pill, present in
  Waveform, Spectral AND Multitrack whenever at least one file is open and absent only in the empty
  app. It adds no edit logic: every button hands an id to `runCommand`, and every enabled state is
  that command's OWN predicate read through a new `isCommandEnabled`, so the bar cannot drift from
  the menu. Buttons grey individually rather than disappearing — no selection greys
  Cut/Copy/Delete/Trim/Silence, an empty clipboard greys Paste, and Undo/Redo follow whichever
  history is active (the session's in Multitrack, the document's elsewhere). In Multitrack all five
  region verbs are greyed with a tooltip saying why — see the behaviour change below. Affects:
  `src/components/Layout/EditToolbar.tsx`, `src/services/menuActions.ts`, `src/App.tsx`.
- **Trim to Selection and Silence Selection are reachable at last.** Why: `trimToSelection` and
  `silenceSelection` have been in `editOps` since Task 22 with no command in front of them — the only
  caller was the test hooks. How to use them: the edit toolbar's middle group, or **Edit → Trim to
  Selection / Silence Selection**, directly under Delete and sharing that group's `hasSelection`
  rule. Both are ordinary undoable History steps and neither operation changed. Neither menu row
  advertises a shortcut, because neither command has one bound — this release already retired two
  labels that named keys doing nothing. Affects: `src/services/menuActions.ts`.
<!-- P1: the live stepper -->
- **The Vocal Chain and the Cover Chain show every step live while the pass runs.** Why: the user
  asked to "see all the steps from top to bottom and what is happening in the current tool", and
  both dialogs listed every stage top to bottom already — what they could not say WHILE running was
  which stage was in flight, how far through *that* stage the pass was, or what it was doing. The
  whole live surface was one label and one overall bar, for a vocal pass whose slowest stage alone
  takes a minute and a cover pass where Match EQ carries 56 of the 68 weight and Match Reverb
  another 32, most of which is one indivisible measurement. How to use it: press Apply and watch
  the stage list. Each row keeps its place and carries a state — *Waiting*, *Running*, *✓ Ran*,
  *Did not run*, *Switched off*, *Manual step*. The running row is highlighted, names its phase
  (*Measuring* the audio reaching it, then *Rendering* with the settings it just measured shown on
  the line) and carries its own bar at its own fraction; rows still to come are dimmed; rows that
  have finished settle into their full report there and then, so the compressor's derived threshold
  is readable while Pitch Correct is still running. The bar at the foot is the whole pass and now
  says so — it and the highlighted row's bar are different quantities that legitimately disagree
  (mid-Match-EQ the row reads 50 % while the pass reads 41 %), and unlabelled that reads as a bug.
  The *Measuring* line is **painted** before the measurement runs, not merely emitted before it:
  `resolveStage` is synchronous, so without a yield to the next frame both announcements collapsed
  into one React flush and the word never reached a screen — worst on the Cover Chain, where
  `deriveMatchEq`'s long-term spectrum of the take is 1.75 s of frozen main thread with the previous
  stage's row still showing. The engine side is additive — `runVocalChain`/`runCoverChain` gained
  optional `onStageProgress` (`{stageId, label, phase, stageFraction, detail}`, the fraction scoped
  to one stage) and `onStageResult`, which hands over the VERY object that lands in `report.stages`
  rather than a copy. That identity is what stops the live text and the finished report becoming two
  sets of strings to keep in step, and it is pinned as such: a stage's live **report block** is
  asserted byte-identical to the finished one (the state badge deliberately differs — `✓ Ran · 1.2 s`
  live against `Ran · 1.2 s` after). No chain behaviour changed; the yield is gated on the callback
  being present, so the test hooks and the packaged smoke — which pass none of the new callbacks —
  keep bit-for-bit their previous timing. A run that FAILS shows nothing — the engine rolls the
  document back, so the stages that had reported are cleared rather than left looking like an
  outcome. Affects: `src/services/vocalChain.ts`, `src/services/coverChain.ts`,
  `src/components/Dialogs/VocalChainDialog.tsx`, `src/components/Dialogs/CoverChainDialog.tsx`.

- **A second packaged pass — `npm run navigate` — walks every surface the app can open.** Why: the
  scripted smoke is a *scenario* — one long round trip through open/edit/chain/export/reopen, deep and
  narrow, driven mostly through `window.__test` because that is where the numbers are. Nothing walked
  the app the way a user does, so whole surfaces had no packaged coverage at all, and three shipped
  mechanisms had no runtime observer of any kind. The walker's law is that **every surface opens, does
  one real thing, and closes, leaving the app healthy**: after each step two real animation frames must
  land, the store must answer, nothing may be left open, and a real pointer click must still drive a
  React round trip. Its rosters are **derived, never listed** — the menu sections from
  `menuActions.ts`'s LAYOUT table, the dialogs from the `src/components/Dialogs/` directory listing
  (each mapped to the command that opens it, including one hop out through a service, so a dialog with
  no reachable door FAILS the run), the module panels from `MODULE_PANELS`, the views from the
  toolbar's own segment array, the effects from the live registry. Enabled state is asserted as a
  *difference* — the same menu read with no document and with one — because asking the same predicate
  twice proves nothing. It is what finally observed P1's **Measuring** paint: a MutationObserver over
  the real Vocal Chain dialog records every stage row transition with the frame it happened on, and
  asserts a row read *Measuring*, that a frame was rendered, and only then *Rendering* — the yield
  itself, not just the two words in order. Native OS pickers are stubbed in the main process (a real
  `showSaveDialog` blocks Electron with a window no harness can reach), which proves the renderer path
  and its cancel handling, not the OS widget. The smoke's launch/pin/assert/pointer plumbing moved to
  `scripts/e2e-lib.cjs` so both passes drive one rig rather than two copies; the smoke is unchanged in
  behaviour and still reports its 763 assertions. How to use: `npm run build && npm run navigate`.
  Affects: `scripts/e2e-navigate.cjs`, `scripts/e2e-lib.cjs`, `scripts/e2e-smoke.cjs`, `package.json`.

### Changed
<!-- F11: the F11 series' Changed entry. -->
- **The module strip carries five permanent modules, and Remix only when there is a remix.** Why: the
  user's ruling — "Spatial and Transcript are single tools, they should not be a module. Remix should
  only appear when a remix is created." A module is something you keep open beside the audio; Spatial
  and Transcript are what a tool *produces*, and Remix has nothing to show until a remix exists. The
  strip now draws **Files, Effects, Markers, History, Properties**, plus **Remix** while any remix
  document is open — asked with `remixService`'s own existing question, not a new flag. Spatial is
  reached by **Pipeline → Spatial Positioner** (a fourth **Mix** group, and the matching row in the
  Effects card); the transcript by **Pipeline → Transcribe…**, which now REVEALS an existing
  transcript instead of re-running the model, with the re-run button moved into the panel where it
  belongs. **Neither surface was trimmed**: both still open as the same full card in the same column,
  because the card registry (what can be rendered) and the strip roster (what draws an icon) are now
  two different lists instead of one. Affects: `src/components/Layout/ModuleStrip.tsx`, `src/App.tsx`,
  `src/services/{menuActions,dialogBus}.ts`, `src/components/Panels/{TranscriptPanel,EffectsPanel}.tsx`.

- **BEHAVIOUR CHANGE — Cut, Copy, Paste, Trim and Silence no longer do anything in the Multitrack
  view, including from the keyboard.** Why: all five act on a region of the *active document*, and
  the multitrack view does not show that document. Switching views deliberately keeps your selection
  (so coming back to Waveform finds your work where you left it), which meant that in Multitrack
  those verbs silently edited a file you could not see, with no feedback anywhere in the session —
  and the Undo beside them routes to the *session's* history in that view, so it could not reverse
  what they had just done. The edit toolbar greyed three of them and left **Trim and Silence lit**,
  where one click destroyed everything outside the selection in the hidden document. What changed for
  you: **`Ctrl+X` / `Ctrl+C` / `Ctrl+V` in the Multitrack view now do nothing** instead of editing the
  hidden document — previously they "worked", which was the same trap with no button on it. The gate
  is on the commands themselves, so the toolbar, the Edit menu and the keyboard cannot disagree, and
  each greyed button says which view to switch to. `Delete` is unaffected: it already removes the
  selected *clip* there, by design. Affects: `src/services/menuActions.ts`,
  `src/components/Layout/EditToolbar.tsx`.
- **The window is laid out around the waveform now, not around the window.** Why: the user's rule for
  this pass was "we want the waveform as wide as possible, not like a photo", settled through five
  mockup iterations (option E2 of the layout mockups). How it
  works: the vertical icon rail at the right edge is gone — the same eight module icons are now a
  horizontal **module strip** sitting on top of the module column at the card's own width, so the two
  surfaces cost one width instead of two, and the column moved out to the window's 14 px margin. The
  editor lane's clearance stopped being a constant: the stage publishes `--stage-inset-left/right`,
  which the lane, the toolbar band and the bottom band all lay out against, so the toolbar and status
  pills are centred on the WAVEFORM rather than on the window and re-centre in the same layout pass
  whenever the column opens or closes. At the pinned 1600 px smoke window the lane goes from 1129 to
  **1209** CSS px with a card open, and to **1571** with none — both measured on the packaged run,
  against a stage that realises as 1599 CSS px rather than 1600. Affects: `src/App.tsx`,
  `src/index.css`, `src/components/Layout/ModuleStrip.tsx`, `src/components/Layout/Toolbar.tsx`,
  `src/components/Layout/StatusBar.tsx`.
- **Clicking the open module entry closes its card.** Why: "the waveform runs nearly the full window
  width with no card open" is unreachable while the card cannot be closed, and the strip's own entry
  is the only affordance that can close what it opened without inventing a second control.
  `aria-pressed` already carried the state; the title spells the toggle out. Affects:
  `src/components/Layout/ModuleStrip.tsx`, `src/App.tsx`, `scripts/e2e-smoke.cjs`.
- **The top-left file chip is retired; its identity readout moved into the bottom bar.** Why: the chip
  spent a whole floating surface on `name · duration · rate · channels` plus a zoom percentage the
  toolbar's own `− % +` group already showed live. How to read it: the status pill now opens with
  `name │ duration · rate · channels`, compactly (`2:35.4 · 44.1k · stereo`), replacing its old
  `44100 Hz · 2ch · N smp` segment — which stated rate and channels a second time and spent the rest
  on a raw sample count the Properties panel owns. The chip's `file-chip` testid moved with the
  readout. Affects: `src/components/Layout/Toolbar.tsx`, `src/components/Layout/StatusBar.tsx`,
  `docs/USER_GUIDE.md`, `README.md`.

### Note

- `--max-old-space-size=16384` is now passed to V8 (`electron/main.cjs`), per an explicit request to
  raise the memory ceiling. Measured, it does not raise anything on this platform and is not what fixed
  the open: the switch does reach the renderers (asking for 512 lowers the reported limit to 631 MiB),
  but 16384 yields **3585.8 MiB — byte for byte what the default already gives**, because V8 clamps to
  its pointer-compressed heap cage. The audio was never in that heap either: with both incident files
  open (~123 MB of `Float32Array`) the renderer's `usedJSHeapSize` is 9.5 MiB, and a probe allocated
  10 GB of `Float32Array` with and without the switch. The line stays because asking for the platform
  maximum is free and a larger future cage should benefit, but the copy elimination, the off-thread
  decode and the clean rollback above are what changed the behaviour.

## [1.24.0] - 2026-08-12

### Fixed

- **The Vocal Chain's Limiter now runs last, so its ceiling is one the output actually keeps.** Cause:
  the chain registered `reverb` AFTER `limiter` and iterates the stage array in order with no
  post-loop clamp — while the limiter's note, rendered verbatim in the dialog, promised the user that
  "nothing downstream can lift the output back over the ceiling". `ReverbEffect` sums a wet tail on
  top of the dry signal, so it is a level stage whatever its purpose is, and it was downstream. This
  is the same defect the Cover Chain was fixed for by reordering; the Cover Chain got the reorder and
  the Vocal Chain kept the copy. Measured through `runVocalChain` itself, in the order that shipped
  through v1.23.0: full-scale noise limited to −0.3 dBFS came back at **+6.53 dBFS**, a 220 Hz tone at
  **+0.98 dBFS**, and the default stage selection with Reverb switched on at **+5.51 dBFS**. Both the
  WAV writer and the MP3 encoder hard-clip that. Fix: `reverb` moves ahead of `limiter`, which makes
  BOTH stage notes true at once — reverb still runs after everything that compresses or pitch-corrects,
  which is the only reason its own note gives for being late, and the limiter is genuinely last. The
  same three fixtures now land at **−0.30 dBFS**, on the committed document rather than on the report.
  Reverb is off by default, so only a user who opted in was affected. Affects:
  `src/services/vocalChain.ts`, `docs/USER_GUIDE.md`.
- **…and the one path that reorder does not close is now named rather than shipped silently.** Cause:
  the limiter's promise only holds while the limiter is RUNNING. Switch it off with Reverb on and the
  reverb is once again the last stage that touches the audio, the same over-scale buffer reaches both
  writers, and nothing between the chain and the file said so — while the Cover Chain has warned for
  its equivalent since Ruling C. Fix: when the Reverb ran, the Limiter is off, and the output actually
  came back above full scale, the reverb's own result carries a warning naming **this run's measured
  peak**, and the dialog renders it in amber above that stage's measurements. The run is NOT blocked —
  a tail over a hot take that the user intends to bring down afterwards is a legitimate thing to want,
  and the chain has no measurement that says otherwise. All three conditions are observations, so the
  line stays quiet on material the tail never takes over 0 dBFS. Affects:
  `src/services/vocalChain.ts`, `src/components/Dialogs/VocalChainDialog.tsx`.
- **…and the Cover Chain, whose Ruling C the warning above was borrowed from, now has it too.** Cause:
  Ruling C lives inside `deriveMatchLoudness`, and that function is only ever resolved for a stage the
  user switched ON. With **Match Reverb on and both level stages off** — Match Loudness and the
  Limiter — the wet tail is the last thing to touch the audio and nothing anywhere warned: the case
  the Limiter's own note measures at **+0.37 dBFS** on a 220 Hz tone and **+5.34 dBFS** on noise at
  the reverb's shortest room, rising to **+2.66** and **+7.76** at its longest. Fix: the same measured
  post-hoc warning the Vocal Chain just got, on the same three observations — the stage is Match
  Reverb, neither level stage after it is on, and the output actually came back above full scale —
  carried on the reverb stage's own result and naming this run's peak. The run is not blocked.
  Affects: `src/services/coverChain.ts`.
- **Match Tempo refuses a selection that clamps to nothing instead of committing an edit that changed
  nothing.** Cause: a selection resolving to an empty region (`{4000, 9000}` on a 4000-sample
  document) ran the whole constant-ratio path — `planStretch` returned its 'empty' plan,
  `replaceRegion` allocated fresh channel arrays holding the same samples, and the
  `postDoc.channels !== doc.channels` success gate read that fresh allocation as a real edit. The call
  reported success having pushed a `Match Tempo` undo entry and marked the document unsaved. Fix: both
  tempo paths, and the ratio-1 beat-grid path, refuse an empty resolved region BEFORE any effect runs,
  with a named reason the dialog renders — the same refusal both chains already make. The variable
  path already declined, but blamed the beat grid; it now names the region too. Affects:
  `src/services/tempoService.ts`, `src/components/Dialogs/TempoDialog.tsx`.
- **Four comments that described code that does something else.** The Cover Chain's "Vocal Chain on
  the Take" note said the vocal chain sets a *limiter* from the take's own levels; it does not, and
  says so itself — a ceiling is an absolute level, so that stage runs on the effect's own −0.3 dBFS.
  `EffectRegistry.defaultParamsFor` and `vocalChain.ts` both undercounted the chain's parameter
  overrides (two and three respectively); there are **five** — de-esser threshold, compressor
  threshold and makeup, Remove Silence threshold, DeHum base frequency, EQ high-pass corner — and
  Noise Reduction is not one of them, because its noise print travels as `extra` and changes no
  parameter. Both `runVocalChain` and `runCoverChain` documented resolving `null` "when every stage is
  off"; both always resolve a report with `applied: false` there, which is what lets the dialog show
  the reason each stage gave. Affects: `src/services/vocalChain.ts`, `src/services/coverChain.ts`,
  `src/effects/EffectRegistry.ts`.
- **Markers added with no other edit are no longer silently discarded on close.** Cause:
  `setMarkersForDoc` never marks a document dirty (the file-load paths share it and must not), and
  `pushUndo` only advances a counter — so `Effects → Align Vocal Timing… → Suggest syllable markers`
  on a document loaded from disk left it flagged clean with new markers, and File → Close (or quit)
  discarded them without a prompt, even though markers persist to WAV cue chunks, ID3 chapters and
  FLAC/Opus tags on save. Fix: `pushMarkerUndo` — the layer that means "a marker edit happened" —
  stamps dirty with exactly the `position !== savePoint` expression the undo path derives, so the
  flag and the derivation cannot disagree after undo. Affects: `src/services/editOps.ts`.
- **One resolved region everywhere a selection is read.** Cause: nine code paths resolved
  `start`/`end` (or a paste cursor) from the raw store value while the audio path clamps through
  `cloneRegion`/`clampRange` — so the audio and everything derived from it (marker remaps, cut
  offsets, the silence zero-fill, post-edit selection and cursor, chain region metrics,
  syllable-marker proposals) could disagree about what the region was. Through the store API a
  negative start produced markers at negative positions and a cursor at −8000; Silence — the
  documented "length unchanged" operation — grew a 4000-sample document to 9000; `alignRegion`
  proposed a syllable at sample −22084. No UI gesture constructs such a selection (gestures clamp),
  so in the shipped app this was latent — fixed because the store API is public surface and the
  packaged smoke now drives it. Fix, applied identically in all nine: resolve and clamp ONCE, and
  every consumer reads the same resolved pair — `tempoService` (variable in v1.23.0, constant now),
  `effectRunner` (four consumers of one raw read), `vocalChain`, `coverChain`, `alignRegion`, and
  `editOps`'s Cut / Delete / Paste (both arms) / Trim / Silence. `noiseProfile` carries the same
  shape and is verified benign (its only reader is the clamping clone). Affects:
  `src/services/tempoService.ts`, `src/services/effectRunner.ts`, `src/services/vocalChain.ts`,
  `src/services/coverChain.ts`, `src/services/timingAlignService.ts`, `src/services/editOps.ts`.
- **Match Tempo also refuses a region that resolves empty on the variable path with the true
  reason** — it refused before, but blamed the grid (`'no-grid'`) for what was a region problem;
  the refusal reason is now `'empty-region'` on both paths, previewed in the dialog where the
  variable path already previews. Affects: `src/services/tempoService.ts`.
- **The Cover Chain's EQ shortfall message says which direction it missed in.** Cause: the sentence
  printed `Math.abs(realised − target)` with "short" hardcoded, so an overshoot read as "4.29 dB
  short". Fix: the word follows the sign. Affects: `src/services/coverChain.ts`.
- **Comments and docs corrected against the code, repo-wide — twice, because the first corrections
  contained their own errors.** A claims audit checked every number, ordering guarantee, precedent
  citation and exhaustiveness claim in comments, dialog copy and docs against the implementing
  code: 13 of 15 flagged claims plus ~20 smaller ones were false and are fixed — among them the
  user guide's promise that Re-detect measures "exactly the audio the ratio will be applied to"
  (it measures a centred excerpt capped at 30 s), a WSOLA tie-break documented backwards, a stale
  "not implemented" header, and a KNOWN_LIMITATIONS paragraph that justified a splice seam by
  citing a precedent that in fact corrects the very overshoot it was cited to excuse. A follow-up
  adversarial review of the corrections themselves then caught four NEW false sentences the fixes
  had introduced (an octave-button label claim wrong for the third time in three authors, an
  unconditional "not all of it", an undo count off by one in exactly the scenario it premised) —
  all rewritten against the code and, for the label sentence, against all five rendering
  components read individually. Behaviour unchanged except as listed above.

### Changed

- **The test suite can no longer be green while the behaviour it names is broken (39 cases, plus
  what the review of the fixes found).** An audit found 39 tests that passed regardless of the
  production code — fixtures pinned at identity values (`start: 0`, `key: 'C'`, `kneeDb: 0`, mono,
  all defaults), assertions that restated the implementation, substring matches blind to swapped
  table cells, and one assertion that was flaky rather than weak (it caught its mutation on
  millisecond jitter about half the time). Every fix was demonstrated by reproducing the named
  mutation GREEN, then proving it RED. Among what is now actually pinned: the compressor's
  soft-knee law (executed by no test before, inherited by the Vocal Chain's gain prediction),
  stereo stem routing (104 tests were green with the instruments swapped between channels), the
  lyrics-match verdict source, and the remix crossfade slider actually re-rendering audio.
- **The packaged smoke now drives the app the way a user does: 512 → 711 assertions.** New test
  hooks (`setSelection`, `redoActive`, `editOp`, `convertChannels`, `newDocument`) opened the
  region-boundary class that had zero packaged coverage; the smoke now selects before it
  processes, verifies a region effect leaves everything outside bit-identical (including the
  off-by-one probe at the boundary), round-trips undo → redo → undo byte-exactly with an
  anti-vacuous guard, exercises every one of the 25 visible effects against real material with
  undo byte-restores (up from 2), cuts and deletes with seam and clipboard invariants, survives a
  file that will not decode, distinguishes a clean refusal from an effect that crashed behind an
  error dialog, and unwinds the variable Match Tempo's documented three-entry undo. Every new
  assertion class was demonstrated able to fail by mutating the production code it names and
  watching the packaged run go red. The run's window geometry is now pinned at startup and
  asserted (this machine's two displays previously decided how many beats were on screen, which
  made one honest pixel assertion flaky), and every tracked beat in view must be drawn, exactly.

## [1.23.0] - 2026-08-12

**Match Tempo can follow a tempo that moves.** Until now it applied one ratio across the whole
region, so a take that speeds up was corrected only *on average* — and `docs/KNOWN_LIMITATIONS.md`
recorded that as an **inherent** limit. It was not one. `timeStretchVariableLinked` has done
variable-rate, stereo-linked, pitch-preserving stretching since the Pitch Correct release, and Align
Vocal Timing already drove it; Match Tempo simply never supplied it a map. Now it can, and the new
**Correction → "Follow the tracked beats"** mode moves each tracked beat onto the target grid
individually instead of sharing one ratio between them.

**How much that was costing, measured rather than asserted.** On synthetic accelerandi whose beat
positions are exact by construction (24 s, 48 kHz, through the real engine), compared against the
*most favourable single ratio there is* — the one matching the region's total duration, which pins
the first and last beat exactly:

| material | tempo slope | one ratio: median / worst beat error | following the beats |
|---|---|---|---|
| 108→112 BPM, target 110 | 0.17 BPM/s | 78.8 ms / 104.4 ms | 0.36 ms / 4.6 ms |
| 100→120 BPM, target 110 | 0.83 BPM/s | 393.9 ms / 525.8 ms | 1.8 ms / 4.6 ms |
| 90→140 BPM, target 115 | 2.08 BPM/s | 951.3 ms / 1274.4 ms | 4.4 ms / 9.8 ms |

525.8 ms is **0.96 of a 545 ms beat**: on a gentle accelerando, one ratio leaves the middle of the
region off by nearly a whole beat. The few milliseconds remaining in the last column are WSOLA's own
placement error, not the map's, and unlike the single ratio's they do not grow with the slope.

**It is opt-in, and the default is unchanged byte for byte.** A user who reached for Match Tempo on a
steady loop does not want per-bar correction applied to it. The mode is entered deliberately, and only
against a beat grid the user has **confirmed** — the tick is cleared by every ×2 / ÷2 re-track and
every re-detect, so it can never outlive the grid it confirmed. That gate is not ceremony: a wrong
single ratio is uniformly wrong and a musician hears it immediately, while **a wrong tempo map is
wrong differently in every bar** — harder to hear, harder to attribute, and impossible to undo by ear.

**And half of the old limitation is still open, now stated as its own entry.** The remix's phrase
arithmetic still assumes a constant meter, which is a *different* limitation with a different cause;
running the two together in one paragraph is part of why neither got fixed. It is now measured and
recorded separately — see `KNOWN_LIMITATIONS.md` §3b.

### Added

- **`Effects → Match Tempo…` → Correction → "Follow the tracked beats".** Builds a tempo map from the
  confirmed beat grid and corrects each beat interval on its own. Available only when the grid is the
  document's own, fresh, and has at least two beats inside the region — one measured interval is the
  minimum from which a local tempo can be read at all. The dialog reports the beat count, the range of
  local ratios, the resulting duration, and how many beats the ratio bound had to hold back.
- **The quality label reports the WORST segment, never an average.** An average that reads
  "transparent" while one bar is stretched 4× is exactly the reassurance this dialog must not give.
- **Beat markers after a variable-rate match are laid where the beats actually went**, from the map's
  own placed positions rather than re-derived as `first + i × spacing` — which is wrong the moment one
  interval is held back by the ratio bound, and would draw markers where the audio's beats are not.
- **Deterministic varying-tempo fixture generators** (`src/dsp/__fixtures__/tempoFixtures.ts`):
  linear accelerando, step tempo change, rubato of known amplitude, and a meter change with known bar
  boundaries — plus a centred tone-burst renderer whose energy centroid *is* the beat, so the reported
  error is an absolute millisecond figure and not a correlation against a re-detected grid.

### Changed

- **`docs/KNOWN_LIMITATIONS.md` §3 is split into the two limitations it always was**: §3a (Match
  Tempo's single ratio — now fixed, with the numbers) and §3b (the remix's constant-meter assumption
  — still open, with the numbers). The section heading no longer claims "both tempo features assume a
  steady tempo", because one of them no longer does.
- `analysisPosAt` / `synthesisPosAt` / `warpRatios` now take a structural `PiecewiseTimeMap`, so the
  tempo map reuses one implementation of the piecewise-linear inverse instead of carrying a second
  copy. No behaviour change; the timing-warp suite is unchanged.

### Fixed

- Nothing user-visible. The variable path is new surface; every existing Match Tempo call takes the
  same code it did in 1.22.0.

### Known limitations (unchanged or newly measured)

- **The remix still assumes a constant meter.** Measured at 120 BPM with exactly-known downbeats: a
  4/4 control keeps 35/36 bar boundaries on a true downbeat and **100 %** of phrase-congruent joins
  musically congruent; a **3/4 × 4** bridge keeps the positions but shifts the bar numbering, dropping
  that to **33 %**; a **3/4 × 5** bridge puts **18 of 35** bar lines a full beat (499 ms) off for the
  rest of the track. Not fixed here: the app has no meter detector at all, so it needs a surface for
  the user to declare where the meter changes, and the per-bar descriptor matrix the planner scores
  against would have to become ragged — a reshape of the matrices the remix DP indexes, in the same
  release that already reshaped that DP with the required-joins subset axis.
- **The local ratio is bounded by the same 0.25×–4× limit the constant path enforces**, applied per
  beat interval rather than once for the region. A beat the bound holds back is moved as far as it
  allows and counted in the dialog, never silently under-delivered.
- **A variable-rate match remaps interior markers proportionally**, which is exact only where the
  local ratio equals the region's average. The beat grid it lays afterwards is exact; other markers
  inside a heavily varying region can drift from the audio they mark.

## [1.22.0] - 2026-08-11

**Sing over a song you love, and have your take match the record's vocal.** `Effects → Cover Chain…`
takes the vocal you just recorded and the *separated original vocal* of the song you are covering, and
matches your take's tone and level to it. The hard-sounding half of that — "work out what was done to
the voice in the finished mix" — turns out not to be blind reverse-engineering of a plugin chain,
because separation hands the processed original vocal over **as a signal**. So it is matching against
a reference, and every setting comes from a measurement of the two recordings rather than from taste.

**The headline limitation is stated in the dialog, above the button, not in a footnote.** The
instrumental separation leaves behind is *not* clean: it still contains the original singer, measured
**17.95 dB below the music** overall and only **9.5–11.8 dB below it across 250 Hz–4 kHz** — the band
your own voice occupies — with a worst measured second of **8.9 dB**. You will hear a ghost of the
original singer under your cover, most audibly in sparse passages. v1.7's separation guarantee is that
the stems sum back to the mix exactly; it never was that each stem is perceptually clean. That figure
is stated as the measurement it is, and deliberately **not** computed per song: three plausible
run-time estimators were built and all three were measured wrong (one degenerate by construction, one
claiming 84 % of the bed's bass was leaked vocal on seconds containing no vocal at all, one agreeing
to 0.5 dB in one formulation and out by 11 dB in another).

**And the name is not a promise the DSP cannot keep.** On the song this was built against, the match
is a shaping of about ±1.2 dB across 500 Hz–4 kHz with +3.5 dB of air at 8 kHz. It is a real,
correctly-signed, measured correction, and it is a small one. A single take still has to be a good
take.

### Added

- **Cover Chain (`Effects → Cover Chain…`) — match a new vocal take to the original singer's.** Nine
  stages in registry order — which is the order the four automatic ones run in (Match EQ, Match
  Reverb, Match Loudness, then the Limiter, last of everything that touches the audio) and the order
  the five manual ones are *listed* in, not the order to do them; each says so in its own note. Each
  stage carries the note that says why it sits there, each automatic one is switchable on its own, and
  the whole pass lands as **one undo entry**. Five stages are manual by
  design and say so rather than pretending: separating the original (it runs a model and produces new
  documents), the Vocal Chain on your take (its own pass, with its own undo entry), Align Lyrics (you
  pick the word — nothing here judges which one is wrong), Align Vocal Timing (you confirm the grid),
  and placing the cover on the instrumental (it builds a session rather than editing the take).
  Afterwards every stage reports what it did, and a before/after table gives loudness, envelope
  spread, noise floor and the spectral distance from the original vocal, against the original vocal's
  own column as the target.
- **Match EQ, bounded and restricted by measurement.** The long-term octave-band energy of your take
  is compared with the separated original vocal's and the difference realised on the Graphic EQ —
  **from 500 Hz up only**, and bounded to **±10.9 dB**. Both limits are measured against ground truth
  rather than chosen: below 500 Hz the separated reference is mostly not the vocal (at 125 Hz its own
  separation error *exceeds* it by 5.1 dB, and the raw curve asks for its largest boosts exactly
  there), and 10.9 dB is the weakest retained band's own signal-to-separation-error ratio, past which
  a "match" would be correcting the separation instead of the singer. Above 500 Hz the curve computed
  from a separated vocal and the curve computed from the true vocal agree to within **0.28 dB** in
  every band.
- **Match Loudness, on a gated level.** Your take is moved to the original vocal's level measured over
  the *sounding* parts of each. That gating is not decoration: an ungated comparison of the same two
  files carries a 0.7 dB bias purely because 88.5 % of the take is sounding against 75.8 % of the
  separated reference. (It is not called LUFS, because it is not: there is no K-weighting and no
  400 ms block structure, only BS.1770-4's relative-gate structure.)
- **A Limiter stage that owns the headroom the loudness match has no view on**, at −0.3 dBFS, **last
  of every stage that touches the audio** so nothing downstream can lift the output back over the
  ceiling. That ordering is load-bearing rather than tidy: Match Reverb sums a wet tail onto the dry
  signal, and a take limited to −0.3 dBFS with this reverb on top of it comes back at +0.37 dBFS on a
  220 Hz tone and +5.34 dBFS on noise at the reverb's shortest room — which both the WAV and the MP3
  writer hard-clip. Switch the limiter off and Match Loudness names the peak it is about to produce
  instead of clipping silently.
- **A Match Reverb stage that derives its own refusal.** It estimates the original vocal's decay by
  ISO 3382-1's T20 method — validated first against the app's own reverb at 1.26 s where the closed
  form says 1.45 s, and 2.92 s where it says 3.20 s — and compares it with the shortest decay this
  app's Reverb can produce. On the reference song the original vocal reads **0.40 s** against a floor
  of **0.710 s**, so the stage declines and says exactly that, rather than being absent or quietly
  adding twice the space that is there. It engages on a vocal whose decay is longer than that floor —
  a path pinned against the effect's own closed-form decay law, against synthetic decays, and in the
  packaged app against a generated reverberant reference, but **never yet on real reverberant
  material**, because both vocals this was measured on were dry (0.28 s and 0.40 s). Read with the
  estimator's disclosed blind spot — its linearity check cannot tell a curved fall from a room — that
  means a long non-reverberant fall can engage it. When it does engage it runs after the EQ and before
  the two level stages, because the tail it adds moves both the level and the peak.

### How the match is realised

Nothing in this release changes an existing user-visible behaviour, so there is no `Changed` section.
The Graphic EQ effect itself is unaltered — dial +6 dB into one of its bands by hand and it still
leaks 1.15 dB into each neighbour an octave away, exactly as before. What follows happens **inside the
Cover Chain**, which is what solves for the gains it hands that effect.

- **The band gains the chain derives are pre-compensated, and the chain reports what the audio
  actually received.** The EQ is a cascade of overlapping peaking filters, so the gain a band is given
  is not the response it produces: a lone +6 dB band leaks 1.15 dB into each neighbour an octave away.
  Worse, the match curve is a difference of octave-band *energies*, and a peaking filter delivers its
  full gain only at its centre — so a cascade whose centre response equals the curve moves the band's
  energy by measurably less. The chain solves for the gains whose *band-energy* response equals the
  requested curve, and shows the realised figure next to the requested one, per band. Measured end to
  end on the reference song, the spectral distance to the original vocal closed 70 % when the centres
  were matched and **82 % (1.94 → 0.34 dB)** when the band energies were.
- **That band energy is measured in your take's own spectrum**, not in a flat one. How much energy a
  filter removes from an octave depends on where inside that octave the signal's energy sits, so the
  average has to be weighted by the spectrum the cascade acts on. An unweighted average — the same as
  assuming every recording is flat across every octave — misreports what the audio received by up to
  **0.94 dB** on a real 30 s vocal; the weighted one tracks it to **0.04 dB**.
- **Where the EQ cannot reach a band's target, the shortfall is named with both numbers** rather than
  the target being echoed back as an outcome. The top of the ±10.9 dB bound is not reachable at all:
  measured at 48 kHz, a lone band at the +12 dB rail moves its octave's energy by only +9.73 dB at
  500 Hz falling to +9.17 dB at 8 kHz, so above roughly ±9 dB it is the effect's own clamp that acts.

### Not shipped, and why

- **There is no matched compressor.** The move a dynamics match would ask for on this material changes
  **sign** across the analysis gate (+0.43 / −0.88 / −3.55 / −9.71 / −6.71 dB at gates of
  15 / 20 / 25 / 30 / 40 dB), and where the reference is trustworthy the required move is under 1 dB —
  i.e. nothing. A quantity whose sign depends on an analysis parameter is not a measurement, and a
  knob that moves for reasons you cannot attribute is worse than no knob. The active-envelope spread
  is still **reported**, before and after, because the number is informative; nothing is derived from
  it.
- **Key and tempo are still yours to confirm.** Pitch and timing both need you to pick the target, and
  the reference song is the proof: its drums track at ~160 BPM while five other sources agree at ~109,
  every confidence between 0.003 and 0.167 against the app's own 0.35 threshold. Both grids are
  musically defensible, so an automatic pick would be a coin flip that silently makes every correction
  ⅔ or 1.5× wrong.

### Measured end to end

On the reference material — a 142 s solo vocal take at 48 kHz against the separated original vocal of
a 178 s song at 44.1 kHz — the whole chain, with Match EQ, Match Loudness and the Limiter on:

Only two of the five rows are targets, and the table says which — the original vocal's peak, envelope
spread and noise floor are readings the chain reports beside yours, not numbers any stage moves
towards. (The Peak row's target is the Limiter's own −0.3 dBFS ceiling.)

| | before | after | the original vocal | matched to it? |
|---|---|---|---|---|
| Loudness (sounding parts) | −25.96 dBFS | **−16.35 dBFS** | −16.35 dBFS | yes |
| Peak | −9.68 dBFS | −0.84 dBFS | −0.18 dBFS | no — the ceiling is the target |
| Envelope spread | 13.62 dB | 12.92 dB | 12.73 dB | no — reported, never corrected |
| Noise floor | −61.26 dBFS | −52.44 dBFS | — | no |
| Spectral distance from the original vocal | 1.94 dB | **0.34 dB** | 0 by definition | yes |

The applied curve was +0.54 / −1.15 / −1.90 / −1.04 / +3.54 dB at 500 Hz – 8 kHz, realised to inside
the solve's own 0.01 dB tolerance, with 10.19 dB of broadband level handed to the loudness stage rather
than baked into the shape. Handing those gains to the EQ *as-is* would have missed the curve by
**1.15 dB** of band energy — the like-for-like figure, measured on a flat spectrum at 48 kHz and larger
on a shaped one. (An earlier draft of this entry quoted 0.280 dB for that baseline. That number is the
error in **centre response**, which is not the quantity the target is expressed in; comparing the two
understated the un-compensated error fourfold.) The Limiter had nothing to catch
and said so — the EQ's cuts had already taken 0.67 dB off the peak before the +9.50 dB gain went on.
The noise floor rises with the gain, as it must: the match lifts the whole take.

## [1.21.0] - 2026-08-11

**A remix pin is now a promise the software actually makes.** Pinning a splice in the Remix panel used
to be a strong preference: the planner exempted the pinned join from its penalties and gave it a small
cost advantage, but nothing *prevented* a drop, and the tooltip had to say "a preference, not a
guarantee". It is a hard constraint now.

The reason for the change was semantic — "pinned" is a promise, and a preference is not one — and the
re-measurement it prompted found the evidence the preference had been resting on was worthless. The
v1.5-era "156 out of 156" came from a rig that could not fail: it only ever pinned joins the planner
had already chosen, which is the one case a cost bonus is bound to win. Re-measured on a same-shape
reconstruction (the original rig was never committed), the preference kept the pin **83 times out of
102** in that ordinary case — five scales from 32 to 496 bars, five entry points per pin — and **0
times out of 109** when the pin is a splice the cheapest arrangement does not contain. The guarantee
keeps it **102/102** and **109/109**.

It costs what forcing an edge the cost function did not want costs, and the panel keeps reporting it:
a mean clean-cost premium of **+2.17** where it changes the arrangement in the ordinary matrix (22 of
102 cases) and **+5.18** in the sharper one, and 13 plans over the repetition bound rather than 11.

**And you can now fix one word of a vocal without singing the take again.** Paste the lyrics you
already have, and **Align Lyrics** gives every word a position; click a word to hear exactly that
word, then record a fresh take of just that word and it is spliced in with its level, median pitch
and seams matched to what was there — without moving a single sample position, so a backing track
still lines up. It does **not** tell you which word is wrong: a per-phone pronunciation scorer was
built against the same model and measured at AUC 0.642 on this material against a 0.500 chance
baseline, flagging 46 of 51 words, and was cut rather than shipped. Your ear picks the word; the tool
makes it reachable.

### Added

- **Align Lyrics (`Effects → Align Lyrics…`) — place the words you already have, then replace one of
  them without redoing the take.** Paste or load the lyrics, and every word gets a position from a
  wav2vec2 character-CTC forced alignment running locally on the CPU. Click a word to hear exactly
  that word; pick one, record a fresh take of just that word, and it is spliced in with the silence
  trimmed off it, its level and median pitch matched to what it replaces, and the crossfades placed
  OUTSIDE the word span so none of the old word survives under the new one. The splice is
  length-preserving, so no sample position moves and the next word can be replaced without re-running
  the model. Why: re-singing one word is the honest answer to "fix this in her own voice" — it *is*
  her voice, with no cloned-TTS provenance to defend — and it needs no detector. How to use: Detect
  nothing first; open the dialog, paste the lyrics, press Align, click a word, press Record
  replacement, then Replace word.
- **The measured placement accuracy is shipped UI text, in the dialog and in the Vocal Chain stage
  note.** Word starts land within a median 20 ms and 88 % within 100 ms — the agreement between two
  acoustic models sharing no training data, label set or size, over 51 sung words of one performance
  by one singer. The same investigation also measured against a hand-marked ground truth — median
  28 ms on the sung line whose word assignment was forced rather than chosen, 36 ms on the 22-word
  spoken control, 48 ms to the nearest word start on 19 unlabelled sung onsets. Those figures are
  recorded in `docs/KNOWN_LIMITATIONS.md` and deliberately **never appear in the app**, because the
  person marking that ground truth could not listen to the audio, so legato word boundaries carrying
  no amplitude or F0 cue are simply absent from it — which can only inflate the result. Three tests
  pin their absence from the accuracy sentence, the stage note and the rendered dialog.
- **A "these lyrics don't appear to match this audio" warning.** CTC forced alignment structurally
  never says "could not align" — given the wrong lyrics it returns a confident placement of the wrong
  words. The gate is the median per-word score against a threshold chosen on a held-out bank of 16
  correct and 103 wrong rows, split by material rather than by row. The median per-word score beat the
  whole-path score on the case that matters: a take that sings its lyrics twice charges the path score
  for the half the text does not describe and it lands below the line, and telling a user their own
  correct lyrics do not match their own recording is exactly the failure this feature exists to avoid.
  Held-out data is not separable, so it is a **warning and never a refusal** — the positions are shown
  either way.
- **An `Align Lyrics` stage in the Vocal Chain**, manual and second in the order, right after Remove
  DC Offset. Its position is argued from the rules the stages around it already state: a replacement
  is a fresh microphone take with its own room tone, so it must be in the file before Noise Reduction
  learns a print and before the compressor, de-esser, EQ and limiter measure what they set themselves
  from; and it must precede Remove Silence and Align Vocal Timing, which move every sample after the
  point they edit and would leave the word positions describing audio that has shifted. DC offset
  still goes first, for the chain's own stated reason — the splice matches level by RMS, and a DC bias
  inflates that measurement.

- **`requiredJoins` in the remix planner — a pinned splice is guaranteed, for up to four pins.** The
  dynamic program gained a subset axis: its state is now `(source bar, output bar, set of pins
  satisfied)`, so the plan it returns contains every pinned splice or names the ones it could not and
  why. Two cheaper designs were ruled out by measurement rather than argument — a counter over-counts,
  because 28 of 126 real plans traverse the same splice twice; a fixed pin order does not exist,
  because 1 326 of 2 173 candidate splice pairs are realizable in *both* orders.
- **Named, categorised reasons when a pin cannot be kept.** "Some pins were dropped" is gone. The panel
  now names the splice by its bars and says which of four things happened: you rejected it (a rejection
  still wins over a pin), it is not a legal splice for the current phrase and repeat settings, it
  cannot coexist with the other pins that *were* kept, or there were more than four pins. The first two
  are decided before the search runs, so they are instant and exact.
- **A plain statement when the guarantee is not in force.** The panel's pin limit stays 8 while the
  guarantee covers 4, and past the cap the guarantee does not survive on the first four: the planner
  degrades the *whole* set to the old best-effort preference, so with five pins none of the five is
  guaranteed rather than one of them being unlucky. The panel says exactly that — before the fifth pin
  is pressed and again in a banner afterwards ("treating every pin as a strong preference. Unpin down
  to 4 to get the guarantee back") — and unpinning back to four restores it on the next re-plan. Pins
  the planner threw out before the search, because you rejected them or they are not a legal splice,
  use no slot at all, so more than four pins can still be fully enforced and the panel says that too.
  A silently downgraded guarantee would be worse than no guarantee.

### Changed

- **Auto-Remix planning moves to a background worker sooner, and can move there mid-session.** Each pin
  doubles the planner's table (`2^K` for K pins: 143.8 MB and 13.2x the time at four pins, on a
  ten-minute source). The threshold that decides main-thread-versus-worker now multiplies by that
  factor and is re-checked on every re-plan, because a remix is created with no pins and acquires them
  afterwards — without this, four pins on a large track would have frozen the window.
- **A pinned splice no longer receives the tie-break cost bonus** it got as a preference. The bonus
  cannot change *whether* a forced splice appears, only how cheap the paths containing it look — and
  a plan that plays the same splice twice would collect it twice. Measured over 102 pin/press cases,
  keeping it changed the arrangement in 4 of them, for a mean cost increase of 0.144 across those
  four and one case where a phrase was repeated an extra time.

### Fixed

- **A take recorded for one word could be spliced into a different one.** Cause: clicking a word in
  the Align Lyrics dialog is also how you *listen* to it, so a user holding a recording could move the
  selection just by auditioning a neighbour, and Replace would then drop that recording on top of the
  wrong word. Fix: the take carries the word it was recorded for, Replace is enabled only when the two
  agree, and the dialog says which word the take belongs to. Affects:
  `src/components/Dialogs/AlignLyricsDialog.tsx`. Found by asserting the Replace invariant across all
  eight combinations of (take recorded, selection moved after it, audio changed under it) rather than
  across the three that were obvious.
- **A stale alignment reported itself as fresh.** Cause: the dialog derived staleness through a
  `useMemo` keyed on the alignment's version counter, but staleness changes when the *document*
  changes, so an edit under a finished alignment never re-derived it. Fix: both reads are cheap (a map
  lookup and an array-identity compare) and now happen every render. Affects:
  `src/components/Dialogs/AlignLyricsDialog.tsx`.
- **A perfectly good replacement recording was refused as silent.** Cause: the splice trimmed the
  silence off your take against a threshold derived from the take's *own* quietest 500 ms — and that
  is only a noise floor when the recording has one above digital silence. Two ordinary recordings do
  not. A take whose pauses are **literal zeros** (a gated interface, a DAW bounce) makes
  `measureNoiseWindow` reject every quiet window and hand back one *containing the word*, so the
  threshold becomes the word's own envelope peak: measured on Chromium's fake capture device, a take
  carrying two full-scale beeps produced a threshold of 0.973 and a longest run of 14 samples against
  a bar of 960 — refused as silent. And a word **punched in tight**, with no room tone either side,
  has a quietest 500 ms as loud as everything else: 0 samples of 72 960 rose above it. A self-relative
  threshold cannot tell "uniformly loud" from "uniformly silent", and it was firing on the wrong one.
  Fix: the threshold is a two-rung ladder — the recording's own floor when it has one, and digital
  silence itself (`SILENCE_RMS`, 2⁻¹⁵, the same constant `measureNoiseWindow` already rejects windows
  at) when that finds nothing; and "silent" is now judged against that absolute floor rather than
  against the recording's own level. Affects: `src/dsp/wordSplice.ts`. Trade, deliberately this way
  round: a take that is nothing but room tone is now spliced instead of refused, because nothing
  separates it from a tight punch-in without inventing a level — a wrong splice costs one undo, a
  wrong refusal costs a re-recording. Recorded in `docs/KNOWN_LIMITATIONS.md`, which also loses the
  entry claiming this was unreachable from the microphone path.

- **Closes P2-5 of the v1.9-era work audit**, one of its two remaining items. Its own ruling was "do
  it if real usage ever shows dropped pins; otherwise the preference stands" — superseded, because a
  documented trade-off is to be eliminated rather than accepted. **P4-14 (variable-tempo material)
  stays open**: it is queued as R7 and not built.

## [1.20.0] - 2026-08-11

**Vocal Chain** — one pass that applies the corrections a rough vocal usually needs, as a single undo
step. `Effects → Vocal Chain…`

**It contains no new processing.** Every stage is an effect Auditorium already shipped: DC offset,
noise reduction, de-hum, silence removal, pitch correction, compression, de-essing, a high-pass,
limiting and reverb. What is new is the *order*, *settings derived from your actual recording*, and a
report that never hides what happened.

Nothing is set by taste. Each stage starts from its own effect's defaults and the chain overrides only
what it measured on the audio reaching that stage — the de-esser's threshold at its own input (after
the compressor, because compression makes sibilance worse and changes what its detector sees), the
compressor's threshold at the level the take is above half the time while it is sounding, its makeup
gain at exactly the level the compression removed, the noise print from the quietest 500 ms, the
silence threshold from the loudest that passage ever reads, and the high-pass an octave under the
lowest note actually sung.

**A stage with nothing to do says so.** On a recording without mains hum, DeHum reports the two
readings it took and declines rather than notching a hole in nothing. Nothing runs that you did not
see.

### Added

- **Vocal Chain** (`Effects → Vocal Chain…`). Ten stages listed in the order they run, each with the
  note saying why it sits there and why it is on or off, each switchable on its own. After the pass
  every stage reports the settings it derived and what it derived them from, the measured RMS and peak
  before and after, and how much of the audio it left bit-identical; a stage that declined shows the
  measurement that made it decline. Underneath, a before/after table of loudness, peak, crest factor
  and noise floor. The whole pass is one undo entry.
- **Remove Silence and Reverb ship off by default** — they change the material rather than correct it.
  Removing pauses is length-changing, so everything after the first shortened pause moves earlier and
  the take no longer lines up with a backing track (4.74 s would go from the reference vocal); reverb
  adds a tail no measurement of a recording can ask for. Both are one click away.
- **Align Vocal Timing is listed but never run automatically.** It needs you to confirm the beat grid
  and the syllable moves first, so it is a step you run *before* the chain — timing belongs before
  pitch, because warping moves the windows the pitch detector uses.

### Changed

- The worker leg of `runEffectOnSelection` is extracted and shared, so the chain runs its stages
  through exactly the same path a single Apply uses rather than becoming a second one. Single-effect
  behaviour is unchanged.
- Pitch Correct now reports what it did — how many frames it moved and by how many cents — which the
  chain shows, and the sung range it measured, which the chain's high-pass corner is derived from
  rather than paying for a second pitch-detection pass.

### Measured, on a real 142-second solo vocal

| | Before | After |
| --- | --- | --- |
| Noise floor | −61.26 dBFS | **−67.37 dBFS** |
| Pitch deviation from nearest semitone (median) | 23.27 cents | **14.74 cents** |
| Programme level | −27.76 dBFS | −27.93 dBFS |
| Length | unchanged | unchanged |

**One number will look wrong, and it is worth knowing why before you measure it.** The **crest factor
rises** (18.08 → 22.24 dB) **while the active envelope narrows 2.63 dB** — quiet material comes up
2.00 dB, loud material comes down 0.62 dB. Both are true, and only the pair is useful. A vocal
compressor with a 10 ms attack cannot catch a shorter transient, so the makeup gain lifts those peaks
even as everything sustained is pulled together; peak-to-RMS measures the peak it did not catch, not
the evenness it did produce. If you measure crest factor and conclude the chain did nothing, measure
the envelope instead. See [Known Limitations](docs/KNOWN_LIMITATIONS.md).

The de-esser is deliberately gentle for the same reason its own defaults are: it reproduces its
measured operating point, which sits above the median sibilant, so it pulls down the harsh sibilants
and leaves 97.7 % of samples bit-identical. Open the De-esser on its own, with Listen, if you want
more.

**Switching Pitch Correct off also switches the EQ off** — the high-pass corner comes from the lowest
note that stage measured, so without it the EQ declines rather than guessing. The stage list says so
before you run anything. Pitch Correct is also 55 % of the running time (about 105 s for a 142 s
take).

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

- **The outstanding-work audit now tells the truth as of v1.9.1.** It predated v1.7/v1.8/v1.9 and misled in four ways. The plan-verdict table gains the v1.7.0/v1.8.0/v1.9.0 rows (eleven plans, not eight); P1 (User Guide, beat-grid overlay, beat-grid-at-current-tempo, never-saved marker) and P3 (stems, beat grid + snapping, crossfades) are marked shipped with their releases and tags; P4-12 (legacy `.audm` salvage) is closed as **MOOT** — the legacy writer builds the identical single JS string the reader decodes, so an over-cap legacy file cannot have been produced by this app; and P4-13 records v1.9.1's security fix, noting the audit's "not exploitable" framing was disproven by measurement. Still-open items (P2-4, P2-5, P4-9/10/11, P4-14) were deliberately not re-scoped.

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

## [1.5.2] - 2026-08-07

Deferred-fixes release: the audit findings deliberately carried out of v1.5.0/v1.5.1, fixed in one pass. No feature changes.

### Fixed

- **Multitrack clip waveforms allocated canvases as wide as the whole clip.** Cause: `ClipView` sized both its on-screen canvas and the cached offscreen bitmap to the clip's FULL timeline pixel width — ~7.6 MB per clip at default zoom, ~30 MB at 4× — and the offscreen copies were retained 200-deep by the module LRU. Fix: the raster is capped at 4096 device pixels and blit-scaled across the clip's CSS width; the envelope still spans the clip's whole sample range, so alignment is exact at every zoom and only sub-column detail (invisible beyond any real viewport) is lost. The cache key is unchanged. Affects: `src/components/Multitrack/ClipView.tsx`.
- **Playing in Spectral view re-rasterised the whole spectrogram every frame.** Cause: the paint effect's deps include `playback.positionSample` (the playhead overlay must move), and each paint called `createImageData` and re-ran the full per-pixel LUT pass — a 0.5–2 GB/s allocation transient during playback. Fix: the rendered raster is cached in a ref keyed by (magnitudes identity, backing size) and blitted per paint; the playhead is drawn as an overlay on top, and only new data or a resize re-rasterises. Affects: `src/components/Editor/SpectrogramView.tsx`.
- **`dialog:*` IPC handlers forwarded renderer-supplied opts unvalidated into native OS dialogs.** Cause: `showOpenDialog`/`showSaveDialog`/`showMessageBox` received the renderer's opts object as-is, so a compromised renderer could render arbitrary text in real OS chrome (and steer open-dialog `properties`). Fix: shapes are validated at the trust boundary — message type from an allow-list, buttons/filters bounded arrays of the expected primitive shapes, strings length-capped (truncated, never rejected, so a long error message still produces its dialog), unknown keys dropped by construction. Every legitimate call-site shape passes through intact. Affects: `electron/ipc.cjs`.
- **The WAV `LIST`/`adtl` label map was uncapped.** Cause: `decodeWav` inserted every `labl` sub-chunk into a Map before any cue point was consulted, so a crafted ~100 MB chunk could grow it to ~8 M entries. Fix: capped at the first 10 000 by position, never throwing — the same pattern as id3Chapters' 255-entry CTOC cap; a cue point whose label fell past the cap degrades to the existing "Marker N" fallback. Affects: `src/audio/wavCodec.ts`.
- **NTFS alternate-data-stream write targets passed the path policy.** Cause: `C:\x\evil.exe:payload.wav` names an ADS on `evil.exe`, but `extname` sees `.wav`, so it passed the extension check and both policy stages; the write then failed EINVAL at the atomic rename — after the temp-file create had already materialised a 0-byte `evil.exe`. Fix: any `:` past the drive-letter position (index 1) of the resolved path is rejected; the drive colon itself and colon-free UNC paths are untouched. Affects: `electron/writePathPolicy.cjs`.
- **`analyzeTempo` hung forever for `minBpm <= 0`.** Cause: the tempo-candidate grid is multiplicative (`bpm *= 1.005`), so a non-positive `minBpm` never advances. Latent — every in-app caller passes the 60/200 defaults — but `AnalyzeTempoOptions` is exported. Fix: a non-positive or inverted BPM range throws a `RangeError` at the entry point, before any content-based early return. Affects: `src/dsp/tempoCore.ts`.
- **Smoke step 6b was flaky on a cold first run.** Cause: `multitrackLiveParamCheck` sampled its two playhead positions across one fixed 400 ms window, which sometimes elapsed before the player's `AudioContext` had started (`{advanced:false, pos1:0, pos2:0}`), passing on re-run. Fix (test harness only, app playback untouched): poll up to 3 s for the transport to demonstrably advance, then settle 150 ms (10× the 15 ms param-ramp time constant) before sampling — the assertions are unchanged in strength, and the volume-gain read now always lands past the ramp. Affects: `src/services/testHooks.ts`.

## [1.5.1] - 2026-08-07

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

## [1.1.0] - 2026-07-15

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
