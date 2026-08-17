/**
 * Task B1 — THE beat-grid resolution layer.
 *
 * One question, one answer: *"what beat grid should be drawn for document
 * `X`?"* Every consumer of the beat feature (B2's waveform tics, B3's
 * per-clip tics, B4's snapping) reads {@link getBeatGrid} and nothing else,
 * so the inheritance rules, the honesty signals and the "never start an
 * analysis" guarantee live in exactly one place — the same shape
 * `tempoAnalysis.ts` established for the analysis itself.
 *
 * ---------------------------------------------------------------------------
 * THE THREE GUARANTEES
 * ---------------------------------------------------------------------------
 *
 * **1. Reading a grid NEVER starts an analysis.** `getBeatGrid` only ever
 * calls `getTempo`/`getRemixAnalysis`, both cached reads. A document with no
 * cached analysis simply has no grid, and drawing must cost nothing. (Plan
 * ruling 6: *"it must not appear at all when no analysis is cached — never
 * trigger an analysis just to draw"*.) The unit suite asserts this by spying
 * on `createTempoWorker`, the single entry point to any analysis.
 *
 * **2. Reading a grid never MUTATES the analysis cache in a way a caller
 * could not undo.** `getTempo` is *not* a pure read: handed a NON-LIVE
 * `AudioDocument` it compares stale channel identities, permanently flags the
 * row stale and releases its `channelRefs` — poisoning it for every other
 * consumer. This module therefore takes a document **id**, never a document,
 * and resolves the live object from `useAppStore` itself
 * (`tempoAnalysis.ts:615`'s own pattern). The id-only signature makes the
 * poisoning structurally unreachable rather than merely avoided by
 * convention.
 *
 * **3. Bar data is reported only when it was MEASURED.** See below.
 *
 * ---------------------------------------------------------------------------
 * BEATS ALWAYS, DOWNBEATS ONLY WHEN GENUINELY ANALYSED (AMENDED RULING 1)
 * ---------------------------------------------------------------------------
 * `beatSamples` exists on every analysed document — it is what `level:'tempo'`
 * produces, which is what the Properties panel, `Pipeline -> Detect Tempo` and
 * the test hook all run. `barBoundary`/`downbeatPhase`/`beatsPerBar` exist
 * ONLY on a `level:'remix'` row (`remixFeatures.ts:453-503`), which today only
 * the Auto-Remix dialog produces. So:
 *
 *  - beats are the deliverable, and {@link BeatGrid.beatSamples} is always
 *    populated (a grid with no beats is reported as *no grid at all*);
 *  - {@link BeatGrid.beatsPerBar}/{@link BeatGrid.downbeatPhase} are `null`
 *    whenever `getRemixAnalysis` does not genuinely return a remix-level row,
 *    and consumers must degrade to beats-only rather than assuming 4/4;
 *  - **bar data present but EMPTY is "no downbeats", not an error.**
 *    `deriveRemixFeatures` returns `emptyRemixAnalysis` — `beatsPerBar` and
 *    `downbeatPhase` set, `barBoundary` length 0, `numBars` 0 — whenever fewer
 *    than two boundaries fit (`remixFeatures.ts:671`), so this is a normal,
 *    reachable outcome on short or wide-metre material;
 *  - classification is {@link isDownbeat}'s
 *    `(i - downbeatPhase) % beatsPerBar === 0` — `barBoundary` is exactly the
 *    subsequence `beatSamples[downbeatPhase + m*beatsPerBar]`, so the formula
 *    is equivalent to searching the list and costs nothing per beat.
 *
 * **FORBIDDEN, and deliberately not done here:** manufacturing bar data by
 * calling `deriveRemixFeatures` with stubbed chroma and publishing it through
 * `setRemixAnalysis`. That would put a fabricated downbeat into the shared
 * cache, which Auto-Remix then *plans against* (`remixService.ts:959,979`),
 * and would consume one of the four cache slots. Never invent a value the DSP
 * did not produce.
 *
 * ---------------------------------------------------------------------------
 * DERIVED-DOCUMENT INHERITANCE — the reason this module exists (plan ruling 2)
 * ---------------------------------------------------------------------------
 * A stem must resolve to its PARENT's grid, never to an analysis of its own:
 *
 *  - the analysis cache holds `MAX_ENTRIES = 4` (`tempoAnalysis.ts:218`), so
 *    five stems plus their source would thrash it on exactly the workflow the
 *    beat feature exists for;
 *  - and it would be *wrong*: stems are time-aligned partitions of ONE
 *    recording, so they share one grid by construction. Analysing a bass stem
 *    alone can land on a half-time tempo, drawing five disagreeing grids for
 *    what is musically one grid.
 *
 * Stems are **sample-identical** to the parent (`stemService.ts:807,845` —
 * same rate, same length, same time base), so inheritance is an **identity
 * copy: no rate conversion, no offset**. {@link linkDerivedDocument} enforces
 * that precondition (equal sample rate AND equal length) and refuses the link
 * otherwise rather than silently drawing a grid at the wrong scale.
 *
 * **`Remix N` is deliberately NOT linked.** A remix document's samples are a
 * *rearrangement* of the parent's bars, not a partition of them, so the
 * parent's beat positions do not describe the remix's timeline at all — a
 * naive inherit would draw tics where the remix has no measured beat, which is
 * the "never invent a value the DSP did not produce" rule applied to positions
 * instead of to bar data. A remix document still gets a real grid the ordinary
 * way (Detect Tempo on the remix itself), which measures the audio that
 * actually exists. Mapping the parent's grid through `RemixSession.joinSamples`
 * is a legitimate future enhancement, but it is a *transformation*, not the
 * identity copy this module implements. **Mix Down has no single parent** and
 * is not linked either.
 *
 * ### What happens when the parent closes — DETACH, don't lose
 * On `closeDocumentFlow`, {@link releaseBeatGrid} snapshots the closing
 * document's grid into every child that inherits from it. The trade is
 * lopsided: the grid is a few kilobytes (an `Int32Array` of beat positions
 * plus six numbers — ~2.4 KB for a 5-minute track at 120 BPM) while the audio
 * it was derived from is ~105 MB, and closing the source right after landing
 * the stems is the *normal* next step in this workflow. Losing every stem's
 * tics at that moment would be a surprise with no upside; the stems' own audio
 * is untouched by the parent's close, so the grid stays correct.
 *
 * The snapshot copies **only what the grid needs** — never the parent's
 * analysis object, which retains `odf`/`bands`/`odfLow` (and, at remix level,
 * `chroma`/`T`/`C`/`L`/`R`/`S`) and would recreate exactly the leak class
 * every cache in this repo guards against. `beatSamples` is `.slice()`d so the
 * detached copy shares nothing with the row `invalidateTempo` is about to
 * drop.
 *
 * ### Retention discipline
 * Nothing in this module holds audio strongly. The parent link is a plain
 * **string id** (retains nothing at all), and the child's identity snapshot —
 * the "has this stem been edited since it was linked?" test — is held as
 * `WeakRef<Float32Array>[]`, following `RemixSession`'s discipline
 * (`remixService.ts:347`): while the child is unedited its live document holds
 * the same arrays strongly so `deref()` always succeeds, and a failed `deref()`
 * can only mean nothing else references that array, i.e. the audio genuinely
 * changed.
 *
 * ---------------------------------------------------------------------------
 * KNOWN BEHAVIOUR, STATED RATHER THAN PAPERED OVER
 * ---------------------------------------------------------------------------
 * **The analysis cache evicts in INSERTION order, not LRU** (`tempoAnalysis.
 * ts:339-343`). Reading a grid does not protect its row, so a grid that is
 * currently on screen silently disappears the moment a 5th document is
 * analysed — `getBeatGrid` starts returning `null` and the tics vanish with no
 * error anywhere. This is pre-existing cache behaviour that B1 does not change
 * (making reads promote a row would mean a *read* mutating eviction order, and
 * would trade this surprise for a different one: the rows an analysis needs
 * being evicted by a repaint). It is pinned by a unit test so the behaviour
 * is a decision rather than an accident, and inheritance is precisely what
 * keeps the stem workflow — six documents — inside the four-row bound.
 *
 * **Analysis staleness is one-way per row** (`isEntryFresh`'s sticky flag), so
 * an edit-then-undo leaves the grid marked stale until a re-analysis. Consumers
 * must render a stale grid *as stale* (plan ruling 6) rather than hiding it.
 */
import { useSyncExternalStore } from 'react';
import { docLength, type AudioDocument } from '../audio/AudioDocument';
import { useAppStore } from '../stores/appStore';
import { getRemixAnalysis, getTempo, useTempoVersion, type RemixAnalysis } from './tempoAnalysis';

/**
 * Everything a consumer needs to draw or snap to a beat grid, and nothing
 * else — in particular NONE of the heavy analysis payload (`odf`, `bands`,
 * `odfLow`, `chroma`, `T`/`C`/`L`/`R`/`S`).
 */
export interface BeatGrid {
  /**
   * Tracked beat positions, ascending, in samples of {@link sampleRate}.
   * Always non-empty (a zero-beat analysis resolves to `null`, not to an empty
   * grid). These are REAL tracked positions from the Ellis DP + per-beat
   * sample refinement — never a rigid grid extrapolated from a BPM — so they
   * follow a drifting take.
   *
   * **SHARED, and must never be mutated or sorted in place.** For an `origin:
   * 'own'` or live-parent grid this is the cache row's own array, handed to
   * every other consumer as well.
   */
  beatSamples: Int32Array;
  /** The rate {@link beatSamples} and {@link analyzedEndSample} are expressed
   * in — the ORIGIN document's rate. Identical to the consuming document's
   * rate for every grid this module produces (inheritance requires it), but
   * carried explicitly so a consumer that maps into another time base (B3's
   * clip mapping) never has to assume. */
  sampleRate: number;
  /** Beats per bar as MEASURED, or `null` when no genuine remix-level bar data
   * exists. Never defaulted to 4 — see AMENDED RULING 1. */
  beatsPerBar: number | null;
  /** Beat index that starts bar 0, in `[0, beatsPerBar)`, or `null` when there
   * is no bar data. */
  downbeatPhase: number | null;
  /** Number of COMPLETE measured bars: bar boundaries are beat indices
   * `downbeatPhase + m*beatsPerBar` for `m` in `[0, barCount]`. `0` whenever
   * there is no bar data — {@link isDownbeat} never classifies a beat past the
   * last measured boundary, so a partial trailing bar draws no bar line. */
  barCount: number;
  /** The detector's confidence in the tempo, `0..1`. Plan ruling 6: a doubtful
   * grid must be presented as doubtful, not as fact. */
  confidence: number;
  /** True when the analysed audio no longer matches the live document — either
   * the origin document was edited after its analysis, or (for an inherited
   * grid) the CHILD was edited after it was linked. A stale grid is still
   * returned so the tics can be marked out of date rather than blinking out. */
  stale: boolean;
  /** The analysis stops here (`MAX_ANALYSIS_SECONDS`, `tempoCore.ts`). There
   * are no beats past this sample and there must be NO extrapolation past it
   * — on a long file the grid legitimately covers only a prefix. */
  analyzedEndSample: number;
  /** True when {@link analyzedEndSample} is short of the document's length,
   * i.e. the grid deliberately covers only the analysed prefix. */
  truncated: boolean;
  /** `'own'` when the requested document holds the analysis itself,
   * `'inherited'` when it resolved through a parent (a stem). */
  origin: 'own' | 'inherited';
  /** The document whose analysis produced this grid. Equal to the requested id
   * for `origin: 'own'`. */
  originDocId: string;
  /** `false` when {@link originDocId} has been closed and this is the retained
   * detached copy. The positions are still valid — the child's audio did not
   * change when its parent closed — but no re-analysis of the origin is
   * reachable any more. */
  originOpen: boolean;
}

/**
 * Whether beat `beatIndex` starts a bar.
 *
 * `barBoundary` is exactly the subsequence
 * `beatSamples[downbeatPhase + m*beatsPerBar]`, so this phase test is
 * equivalent to searching the boundary list and costs O(1) per beat — which
 * matters, because the waveform re-renders every animation frame during
 * playback.
 *
 * Always `false` when there is no measured bar data. Beats BEFORE the first
 * downbeat are not classified (they belong to a partial bar the detector never
 * bounded), and neither are beats past the last measured boundary — reporting
 * either would extrapolate a bar line the analysis did not produce.
 */
export function isDownbeat(grid: BeatGrid, beatIndex: number): boolean {
  const { beatsPerBar, downbeatPhase } = grid;
  if (beatsPerBar === null || downbeatPhase === null) return false;
  if (beatIndex < downbeatPhase) return false;
  const rel = beatIndex - downbeatPhase;
  if (rel % beatsPerBar !== 0) return false;
  return rel / beatsPerBar <= grid.barCount;
}

// ---------------------------------------------------------------------------
// Provenance links
// ---------------------------------------------------------------------------

/** The grid fields kept alive after the origin document closes — scalars plus
 * one small `Int32Array` copy. Deliberately NOT the analysis object. */
interface DetachedGrid {
  beatSamples: Int32Array;
  sampleRate: number;
  beatsPerBar: number | null;
  downbeatPhase: number | null;
  barCount: number;
  confidence: number;
  stale: boolean;
  analyzedEndSample: number;
  truncated: boolean;
  originDocId: string;
}

interface LinkEntry {
  /** By ID, never by object: a link retains nothing. */
  parentDocId: string;
  /** The child's channel arrays at link time, held WEAKLY (see the module
   * header's retention discipline). A mismatch means the child has been edited
   * since it was derived, so the inherited grid no longer describes it. */
  childChannelRefs: WeakRef<Float32Array>[];
  /** Set when {@link parentDocId} closes; `null` while the parent is open. */
  detached: DetachedGrid | null;
}

/** `childDocId -> link`. Module-level rather than in `appStore` because it
 * holds `WeakRef`s and a typed-array snapshot (neither belongs in serialisable
 * UI state) and because a link change must not re-render every store consumer
 * — the same shape `tempoAnalysis`'s `cache`, `remixService`'s `sessions` and
 * `noiseProfile` all use, and like those it is invalidated explicitly from
 * `closeDocumentFlow`. The `appStore.markers` precedent (cleanup for free
 * inside `closeDocument`) was considered and rejected: the parent-close
 * DETACH has to read the tempo cache and the still-live document, which cannot
 * happen inside a zustand reducer, so a store-resident map would still need an
 * explicit hook in `closeDocumentFlow` and the lifecycle would end up split
 * across two files instead of one. */
const links = new Map<string, LinkEntry>();

// ---------------------------------------------------------------------------
// Reactivity — one subscription point for B2/B3
// ---------------------------------------------------------------------------

let linkVersion = 0;
const listeners = new Set<() => void>();

function bumpLinkVersion(): void {
  linkVersion++;
  for (const listener of listeners) listener();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function getLinkSnapshot(): number {
  return linkVersion;
}

/**
 * A change token for everything {@link getBeatGrid} can depend on: analysis
 * run start / progress / completion / invalidation (`useTempoVersion`) AND
 * provenance-link changes. Both counters are monotonic, so their sum is a
 * monotonic change token — its VALUE is meaningless, only its changing is.
 *
 * A component that reads `getBeatGrid` but does not already re-render on the
 * relevant store change must depend on this, or its tics will not appear when
 * an analysis completes (they would wait for an unrelated re-render).
 */
export function useBeatGridVersion(): number {
  const tempoVersion = useTempoVersion();
  const provenanceVersion = useSyncExternalStore(subscribe, getLinkSnapshot, getLinkSnapshot);
  return tempoVersion + provenanceVersion;
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

function liveDoc(docId: string): AudioDocument | undefined {
  return useAppStore.getState().documents.find((d) => d.id === docId);
}

/** The same identity test as `remixService.ts`'s `sameWeakChannelRefs`: a
 * failed `deref()` can only happen once nothing else in the process holds that
 * array, which for a live document means its audio genuinely changed. */
function sameWeakChannelRefs(a: readonly WeakRef<Float32Array>[], b: Float32Array[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].deref() !== b[i]) return false;
  }
  return true;
}

/** Bar data ONLY when it was genuinely measured — see AMENDED RULING 1. */
function barDataOf(remix: RemixAnalysis | null): Pick<BeatGrid, 'beatsPerBar' | 'downbeatPhase' | 'barCount'> {
  const none = { beatsPerBar: null, downbeatPhase: null, barCount: 0 };
  if (!remix) return none;
  const { beatsPerBar, downbeatPhase, numBars, barBoundary } = remix;
  // `barBoundary`/`numBars` are absent on a row that is level:'remix' without
  // ever having been through `deriveRemixFeatures` (the regrid write-back
  // window, and the test-only relabel hook), and EMPTY on a genuine
  // `emptyRemixAnalysis`. Both are "no downbeats", not an error.
  if (!Number.isInteger(beatsPerBar) || beatsPerBar < 1) return none;
  if (!Number.isInteger(downbeatPhase) || downbeatPhase < 0 || downbeatPhase >= beatsPerBar) return none;
  if (!barBoundary || barBoundary.length < 1) return none;
  if (!Number.isInteger(numBars) || numBars < 1) return none;
  return { beatsPerBar, downbeatPhase, barCount: numBars };
}

/** The grid held by the document itself, or `null` when it has no cached
 * analysis (or one that found no beats). Both reads are cached reads against
 * the LIVE document — nothing is ever started here. */
function ownGrid(doc: AudioDocument): BeatGrid | null {
  const tempo = getTempo(doc);
  if (!tempo || tempo.beatSamples.length === 0) return null;
  return {
    beatSamples: tempo.beatSamples,
    sampleRate: doc.sampleRate,
    ...barDataOf(getRemixAnalysis(doc)),
    confidence: tempo.confidence,
    stale: tempo.stale,
    analyzedEndSample: tempo.analyzedEndSample,
    truncated: tempo.truncated,
    origin: 'own',
    originDocId: doc.id,
    originOpen: true,
  };
}

function fromDetached(snapshot: DetachedGrid, childStale: boolean): BeatGrid {
  return {
    beatSamples: snapshot.beatSamples,
    sampleRate: snapshot.sampleRate,
    beatsPerBar: snapshot.beatsPerBar,
    downbeatPhase: snapshot.downbeatPhase,
    barCount: snapshot.barCount,
    confidence: snapshot.confidence,
    stale: snapshot.stale || childStale,
    analyzedEndSample: snapshot.analyzedEndSample,
    truncated: snapshot.truncated,
    origin: 'inherited',
    originDocId: snapshot.originDocId,
    originOpen: false,
  };
}

function resolve(docId: string, seen: Set<string>): BeatGrid | null {
  // Cycle guard: links are set by trusted call sites today, but a chain that
  // closed on itself would otherwise recurse forever.
  if (seen.has(docId)) return null;
  seen.add(docId);

  // Never `getTempo(someDocumentObject)` — always the live one (guarantee 2).
  const doc = liveDoc(docId);
  if (!doc) return null;

  // An analysis the user explicitly ran on THIS document wins: it measures the
  // audio actually in front of them. Inheritance is the fallback, not an
  // override.
  const own = ownGrid(doc);
  if (own) return own;

  const link = links.get(docId);
  if (!link) return null;

  // Has this derivative been edited since it was linked? If so the parent's
  // positions no longer describe it, and the honest report is "stale", not
  // "no grid" — the user can still see roughly where the beats were.
  const childStale = !sameWeakChannelRefs(link.childChannelRefs, doc.channels);

  if (link.detached) return fromDetached(link.detached, childStale);

  const parent = resolve(link.parentDocId, seen);
  if (!parent) return null;
  return {
    ...parent,
    stale: parent.stale || childStale,
    origin: 'inherited',
  };
}

/**
 * THE selector: the beat grid to draw for `docId`, or `null` when there is
 * none. **Never starts an analysis** and never mutates the analysis cache
 * beyond the staleness observation a live-document read already performs.
 *
 * Resolution order:
 *  1. the document's OWN cached analysis (a user-run Detect Tempo wins);
 *  2. its parent's grid, if it is a linked derivative (a stem);
 *  3. the detached copy retained when that parent closed;
 *  4. otherwise `null`.
 *
 * Takes an ID rather than an `AudioDocument` on purpose — see guarantee 2 in
 * the module header.
 */
export function getBeatGrid(docId: string): BeatGrid | null {
  return resolve(docId, new Set());
}

/**
 * Records that `childDocId`'s audio is a sample-identical derivative of
 * `parentDocId`'s, so it inherits the parent's beat grid instead of being
 * analysed separately (plan ruling 2). Called from `landStems`, the one moment
 * the parent id is in scope for a stem.
 *
 * Refuses — silently, leaving the child with no grid rather than a wrong one —
 * when either document is not open, when the ids are the same, or when the
 * two are not sample-identical (different rate or different length). That
 * check is what makes "identity copy, no conversion" a *verified* precondition
 * rather than an assertion: `Remix N` and Mix Down are excluded by policy (see
 * the module header), and anything else that drifts from the stem shape is
 * excluded by measurement.
 */
export function linkDerivedDocument(childDocId: string, parentDocId: string): void {
  if (childDocId === parentDocId) return;
  const child = liveDoc(childDocId);
  const parent = liveDoc(parentDocId);
  if (!child || !parent) return;
  if (child.sampleRate !== parent.sampleRate) return;
  if (docLength(child) !== docLength(parent)) return;

  links.set(childDocId, {
    parentDocId,
    childChannelRefs: child.channels.map((c) => new WeakRef(c)),
    detached: null,
  });
  bumpLinkVersion();
}

/**
 * MANDATORY in `closeDocumentFlow`, and it must run **before**
 * `closeDocument()`/`invalidateTempo()`: it reads the closing document's grid
 * while the document is still live and its cache row still armed.
 *
 * Does two things:
 *  - drops `docId`'s own link entry, so this module never becomes the repo's
 *    first uncleaned per-document store;
 *  - DETACHES every child that inherits from `docId`, copying the small grid
 *    (positions + scalars, never the analysis object) into the child's link so
 *    a stem keeps its tics when the source is closed to free its ~105 MB. A
 *    child whose parent had no grid to hand over loses its link entirely —
 *    there is nothing left for it to inherit, ever.
 *
 * Idempotent, and a no-op for an id with no links either way.
 */
export function releaseBeatGrid(docId: string): void {
  let changed = links.delete(docId);

  let snapshot: DetachedGrid | null | undefined;
  for (const [childId, link] of links) {
    if (link.parentDocId !== docId || link.detached) continue;
    if (snapshot === undefined) {
      const grid = getBeatGrid(docId);
      snapshot = grid
        ? {
            // `.slice()`: an INDEPENDENT copy, so nothing here references the
            // cache row `invalidateTempo` is about to drop (and so no
            // `odf`/`bands`/`chroma` payload is retained through it).
            beatSamples: grid.beatSamples.slice(),
            sampleRate: grid.sampleRate,
            beatsPerBar: grid.beatsPerBar,
            downbeatPhase: grid.downbeatPhase,
            barCount: grid.barCount,
            confidence: grid.confidence,
            stale: grid.stale,
            analyzedEndSample: grid.analyzedEndSample,
            truncated: grid.truncated,
            originDocId: grid.originDocId,
          }
        : null;
    }
    if (snapshot) link.detached = snapshot;
    else links.delete(childId);
    changed = true;
  }

  if (changed) bumpLinkVersion();
}

/** Empties every provenance link — test isolation only. */
export function clearBeatGridLinks(): void {
  links.clear();
  bumpLinkVersion();
}

/**
 * Test-only: the provenance link recorded for `docId`, or `undefined` when
 * there is none. The map is deliberately invisible through the public surface
 * (consumers ask for a grid, not for where it came from), and its lifecycle —
 * created at `landStems`, detached on the parent's close, removed on its own —
 * is exactly what has to be asserted rather than assumed.
 */
export function _getBeatGridLinkForTest(
  docId: string
): { parentDocId: string; detached: boolean } | undefined {
  const link = links.get(docId);
  if (!link) return undefined;
  return { parentDocId: link.parentDocId, detached: link.detached !== null };
}
