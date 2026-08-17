/**
 * Task S5 — multitrack landing for a completed stem separation (plan ruling 6).
 *
 * Takes the in-memory {@link StemSeparationOutput} that `stemService`'s
 * `separateStems` resolves with and turns it into what the user actually works
 * with: FIVE documents (`<source> — Drums` … `<source> — Residual`) plus a
 * fresh multitrack session holding one full-length clip per stem, then switches
 * to the multitrack view. This module synthesises no audio — every sample it
 * lands is a `Float32Array` handed over by S3 verbatim (or, for a mono source,
 * a bit-exact copy of one; see MONO below).
 *
 * ---------------------------------------------------------------------------
 * THE GUARANTEE THIS MODULE MUST NOT BREAK (plan ruling 1)
 * ---------------------------------------------------------------------------
 * `residual := mix − Σ stems` is a time-domain complement, so the five tracks
 * sum back to the source EXACTLY — "down to the sample, not to a tolerance".
 * That only survives the mix bus if every track contributes its stored sample
 * values UNCHANGED, which means:
 *
 *  - **Track order matters.** Residual is LAST because `partitionStems`
 *    computed it as the float32 remainder AFTER the four stems were summed in
 *    ruling-6 order; `mixdownSession` accumulates track by track with a float32
 *    store per `+=`, so replaying that same order is what makes
 *    `Σ stems + (mix − Σ stems)` collapse back to `mix` sample for sample.
 *  - **Every param stays at its default** — unity gain, centre pan, no
 *    mute/solo. Not "defaults except a magic number the user must not touch":
 *    a session whose exactness depended on a non-default fader would silently
 *    lose the guarantee the first time someone reset that fader.
 *
 * ---------------------------------------------------------------------------
 * MONO — measured, not assumed (plan ruling 6: "compensated if needed —
 * measure, don't assume")
 * ---------------------------------------------------------------------------
 * `mixdownSession` picks its pan law from the CLIP SOURCE's channel count. A
 * mono clip takes the constant-power law (`monoPanGains`), which at centre is
 * `gL = gR = cos(π/4) ≈ 0.7071` — the single channel feeds both master sides at
 * −3 dB. Five mono stem tracks at unity therefore sum to 0.707 × the source:
 * S2's review measured 0.205 absolute (−13.8 dBFS), and this module's own
 * acceptance test reproduces it (0.196 @ 44.1 kHz, 0.198 @ 48 kHz) whenever the
 * routing below is removed. A STEREO clip takes the balance law
 * (`stereoBalanceGains`), which IS unity at centre — which is why only mono
 * needs anything at all.
 *
 * **The mechanism: a mono source's stems are laid down as DUAL-MONO STEREO
 * documents** (channel 0 and channel 1 are both bit-exact copies of the mono
 * stem), so every stem clip takes the unity balance law and each master side
 * receives the stem samples unmultiplied. It is exact BY CONSTRUCTION — the
 * mono path becomes the same arithmetic as the stereo path, not a second path
 * that happens to agree.
 *
 * The alternative — mono documents plus a per-track fader of 20·log10(√2)
 * ≈ +3.0103 dB, the exact inverse of the law — was implemented and MEASURED,
 * and it does NOT reach exactness:
 *
 * | mono routing                   | worst \|err\| | dBFS   | bit-exact samples |
 * |--------------------------------|---------------|--------|-------------------|
 * | none (unity fader, mono docs)  | 1.96e-1       | −14.1  | 0 %               |
 * | +3.0103 dB fader, mono docs    | 5.96e-8       | −144.5 | 97.47 %           |
 * | dual-mono stereo docs (SHIPPED)| 0             | −∞     | 100 %             |
 *
 * The fader's residue is not a bug to hunt down, it is arithmetic: mixdown
 * computes `(x · g) · gL` with TWO float64 roundings, and `g · gL` is
 * 1.0000000000000002 rather than 1, because `gL`'s exact reciprocal is not a
 * representable double (so no scalar `g` can make that product the identity —
 * this is a proof, not a tuning failure). The resulting ≤3.14e-16 relative
 * perturbation is ~8 orders below float32 granularity, yet it still flips the
 * master bus's float32 rounding on 2.5 % of samples, each by one ULP. Ruling 1
 * says "not to a tolerance", so the fader route is rejected.
 *
 * Cost of the shipped route, stated plainly: a mono source's five stem
 * documents occupy twice what mono stems would — i.e. exactly what a STEREO
 * source of the same duration already costs, which is the envelope S3's
 * 15-minute cap was sized against, so it introduces no new worst case. The two
 * channels are independent copies, never the same array aliased twice: nothing
 * else in this codebase creates an aliased document and a future in-place
 * mutation would corrupt one channel through the other.
 *
 * ---------------------------------------------------------------------------
 * THE CONDITION THE GUARANTEE CARRIES (S2 review, measured)
 * ---------------------------------------------------------------------------
 * `mixdownSession` HARD CLAMPS the master bus to ±1 (`mixdown.ts:68-70,155-158`).
 * A document whose samples exceed full scale — reachable after gain/EQ inside
 * the app — therefore reconstructs with large error (S2 measured 0.600 at
 * |mix| = 1.6) even though the raw sum is still exact. That clamp is documented
 * v1 behaviour and is deliberately NOT defeated here. Instead the condition is
 * DETECTED and reported: {@link StemLandingResult.sourcePeak} and
 * {@link StemLandingResult.exactSumHolds} tell the caller (S6's dialog, S7's
 * smoke) whether the identity actually holds for THIS document, so the user can
 * be told the truth rather than being sold a guarantee that silently doesn't
 * hold.
 */
import { createDocument, docLength, type AudioDocument } from '../audio/AudioDocument';
import { createClip, createTrack, type Session, type Track } from '../multitrack/session';
import { useSessionStore } from '../multitrack/sessionStore';
import { clearSessionHistory } from '../multitrack/sessionUndo';
import { useAppStore } from '../stores/appStore';
import { linkDerivedDocument } from './beatGrid';
import { STEM_LABELS, type StemSeparationOutput } from './stemService';
import { defaultSessionZoom } from '../multitrack/sessionZoom';

/**
 * The five track/document labels in the order ruling 6 pins them, Residual
 * LAST (see the ordering note in the module header — it is load-bearing for the
 * exact-sum identity, not cosmetic).
 */
export const STEM_TRACK_LABELS = [...STEM_LABELS, 'Residual'] as const;
export type StemTrackLabel = (typeof STEM_TRACK_LABELS)[number];

/**
 * The per-track fader that would exactly invert the constant-power pan law:
 * 20·log10(√2) = +3.0102999566398121 dB. Exported for documentation and for the
 * test that pins WHY it is not what ships — see the measurement table in the
 * module header. `landStems` never applies it.
 */
export const MONO_PAN_COMPENSATION_DB = 20 * Math.log10(Math.SQRT2);

/** Name given to the session that lands the stems: `<source> — Stems`. */
export function stemSessionName(sourceName: string): string {
  return `${sourceName} — Stems`;
}

/**
 * CC4 (CJ-1) — the DOCUMENTS half of a landing, on its own.
 *
 * Landing stems is two independent acts: creating five documents (additive —
 * nothing that was open changes) and REPLACING the session with one built from
 * them (destructive — the previous session and its undo history go). The
 * standalone Separate dialog wants both and says so. The cover journey wants
 * only the first: its own contract is that no session exists until its stage 5,
 * and calling the whole landing at stage 1 made that contract false for every
 * user who cancelled in between. Splitting the act is what makes the sentence
 * true, rather than rewording the sentence to match the code.
 */
export interface StemDocumentsResult {
  /** The five created document ids, in track order (Residual last). */
  documentIds: string[];
  /**
   * True when the source was MONO and its stems were laid down as dual-mono
   * stereo documents (see the module header). False for a stereo source, whose
   * stems are the delivered arrays themselves.
   */
  monoRoutedAsDualMono: boolean;
  /**
   * Peak |sample| of the SOURCE document, or `null` when the source document is
   * no longer open and the check could not be made (the stems still land — they
   * are valid audio regardless; only the verdict below is unknown).
   */
  sourcePeak: number | null;
  /**
   * Whether mixing the untouched session down reproduces the source exactly.
   * `false` when `sourcePeak > 1`: the master bus's ±1 clamp flat-tops the sum
   * (see the module header). `null` when it could not be determined.
   */
  exactSumHolds: boolean | null;
}

/** CC4 (CJ-1) — what the SESSION half adds to {@link StemDocumentsResult}. */
export interface StemSessionResult {
  /** The five created track ids, in document order. */
  trackIds: string[];
  /** `<source> — Stems`, also the default filename for Save Session. */
  sessionName: string;
}

export interface StemLandingResult {
  /** The five created document ids, in track order (Residual last). */
  documentIds: string[];
  /** The five created track ids, in the same order. */
  trackIds: string[];
  /** `<source> — Stems`, also the default filename for Save Session. */
  sessionName: string;
  /**
   * True when the source was MONO and its stems were laid down as dual-mono
   * stereo documents (see the module header). False for a stereo source, whose
   * stems are the delivered arrays themselves.
   */
  monoRoutedAsDualMono: boolean;
  /**
   * Peak |sample| of the SOURCE document, or `null` when the source document is
   * no longer open and the check could not be made (the stems still land — they
   * are valid audio regardless; only the verdict below is unknown).
   */
  sourcePeak: number | null;
  /**
   * Whether mixing the untouched session down reproduces the source exactly.
   * `false` when `sourcePeak > 1`: the master bus's ±1 clamp flat-tops the sum
   * (see the module header). `null` when it could not be determined.
   */
  exactSumHolds: boolean | null;
}

/** Largest |sample| across every channel; 0 for an empty document. */
function peakAmplitude(channels: Float32Array[]): number {
  let peak = 0;
  for (const ch of channels) {
    for (let i = 0; i < ch.length; i++) {
      const v = ch[i] < 0 ? -ch[i] : ch[i];
      if (v > peak) peak = v;
    }
  }
  return peak;
}

/**
 * Channels for one stem document. A stereo (or already multi-channel) stem is
 * handed through by reference — no copy, no touch. A MONO stem becomes two
 * independent bit-exact copies so the clip takes mixdown's unity balance law
 * (module header, MONO).
 */
function documentChannels(stem: Float32Array[]): Float32Array[] {
  if (stem.length !== 1) return stem;
  return [Float32Array.from(stem[0]), Float32Array.from(stem[0])];
}

/**
 * CC4 (CJ-1) — the ADDITIVE half of a landing: five documents, the first of
 * them active, each carrying the source's beat-grid provenance. Nothing that
 * was already open changes, and in particular NO SESSION IS TOUCHED — which is
 * the whole reason this half exists on its own (see {@link StemDocumentsResult}).
 *
 * Documents are created with the `mixdownToNewFile` pattern (`createDocument`
 * then `addDocument`, no undo entry — creating a document is not an edit to any
 * document, so there is nothing to undo). They carry no `filePath`, so S4's
 * `createDocument` stamps `neverSaved: true` automatically and closing one
 * prompts; this module deliberately does NOT pass the flag, so the protection
 * keeps coming from the one place that owns it.
 */
export function createStemDocuments(output: StemSeparationOutput): StemDocumentsResult {
  const app = useAppStore.getState();

  const stemChannelSets: Float32Array[][] = [
    ...output.stems.map((s) => s.channels),
    output.residual,
  ];

  const docs: AudioDocument[] = STEM_TRACK_LABELS.map((label, i) =>
    createDocument({
      name: `${output.sourceName} — ${label}`,
      sampleRate: output.sampleRate,
      channels: documentChannels(stemChannelSets[i]),
    })
  );
  for (const doc of docs) app.addDocument(doc);

  // `addDocument` activates whatever was added last, which would leave the
  // Residual — the diagnostic leftover — as the active document. The headline
  // output is the first stem, so activate that instead.
  app.setActiveDocument(docs[0].id);

  // Task B1: this is the only moment the SOURCE document's id is in scope for
  // the stems, so it is where their beat-grid provenance is recorded. Every
  // stem is a time-aligned partition of the source at the same rate and the
  // same length, so its grid IS the source's grid — an identity copy, no rate
  // or offset conversion. Without the link each stem would have to be analysed
  // on its own, which thrashes the 4-row analysis cache (5 stems + source) and
  // can land a bass stem on a half-time tempo, drawing five disagreeing grids
  // for one recording. `linkDerivedDocument` re-verifies the rate/length
  // precondition and simply declines if it ever stops holding.
  for (const doc of docs) linkDerivedDocument(doc.id, output.sourceDocId);

  const source = useAppStore.getState().documents.find((d) => d.id === output.sourceDocId);
  const sourcePeak = source && docLength(source) > 0 ? peakAmplitude(source.channels) : null;

  return {
    documentIds: docs.map((d) => d.id),
    monoRoutedAsDualMono: output.channelCount === 1,
    sourcePeak,
    exactSumHolds: sourcePeak === null ? null : sourcePeak <= 1,
  };
}

/**
 * CC4 (CJ-1) — the DESTRUCTIVE half: a five-track session over the documents
 * {@link createStemDocuments} just created, installed in place of whatever
 * session was open, and the multitrack view. Every caller of THIS half is
 * replacing the user's session, which is why it is a separate call: a caller
 * that only wanted documents cannot reach it by accident.
 *
 * `documentIds` must be in {@link STEM_TRACK_LABELS} order — Residual LAST,
 * which the module header explains is load-bearing for the exact-sum identity.
 */
export function buildStemSession(
  output: StemSeparationOutput,
  documentIds: readonly string[]
): StemSessionResult {
  const tracks: Track[] = documentIds.map((documentId, i) => {
    const track = createTrack(STEM_TRACK_LABELS[i]);
    track.clips = [
      createClip({
        documentId,
        startSample: 0,
        offsetSample: 0,
        // Session rate == document rate == output.sampleRate, so session
        // samples and document samples are the same unit here.
        lengthSample: output.lengthSamples,
      }),
    ];
    return track;
  });

  const session: Session = {
    name: stemSessionName(output.sourceName),
    sampleRate: output.sampleRate,
    tracks,
  };

  // Wholesale session replacement, following `openSessionViaDialog`'s apply
  // block: every transient (selection, cursor, zoom, transport) belonged to the
  // session that just went away.
  useSessionStore.setState({
    session,
    selectedClipId: null,
    mtCursorSample: 0,
    // MT1 (C1): fitted, not the hardcoded 512 — see sessionFile's twin. Landing
    // stems is how a user MOST often arrives at a long multitrack session, so
    // this path showed the reported symptom more often than the one it was
    // filed against.
    mtZoom: defaultSessionZoom(session),
    mtPlayState: 'stopped',
    mtPlayheadSample: 0,
  });
  // R3: stem landing is a LOAD-shaped replacement (this module deliberately
  // follows openSessionViaDialog's apply block) — it starts a new editing
  // timeline, so the previous session's undo history is dropped rather than
  // recorded. Leaving it standing would be worse than either: entries are
  // whole-state snapshots, so undoing a pre-landing entry would silently
  // revert the landing itself (the recording invariant in sessionUndo.ts).
  clearSessionHistory();
  useAppStore.getState().setView('multitrack');

  return { trackIds: tracks.map((t) => t.id), sessionName: session.name };
}

/**
 * Lands a completed separation: five documents + a five-track session + the
 * multitrack view. Synchronous and self-contained — the caller (S6's dialog)
 * needs nothing else to finish the flow.
 *
 * CC4 (CJ-1): now literally the two halves above, in order, and nothing else.
 * Its behaviour is unchanged and is still pinned by this module's whole suite —
 * the standalone Separate dialog documents that it replaces the session, so it
 * is the caller that WANTS both halves.
 */
export function landStems(output: StemSeparationOutput): StemLandingResult {
  const documents = createStemDocuments(output);
  const session = buildStemSession(output, documents.documentIds);
  return { ...documents, ...session };
}
