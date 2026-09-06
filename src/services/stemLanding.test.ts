/**
 * Task S5 — multitrack landing (plan ruling 6).
 *
 * THE headline test here is the MIXDOWN-IDENTITY acceptance: mixing the
 * untouched landed session down reproduces the source document sample for
 * sample, for STEREO and MONO, at 44.1 kHz and 48 kHz. That is the user's own
 * requirement ("all stems together sound identical to the source") made
 * executable, and it is what the mono routing exists for.
 *
 * The fixtures run the REAL `partitionStems` (S2) over stub estimates rather
 * than hand-written "stems", so the property under test is the one that ships:
 * a genuine masked-iSTFT partition plus its time-domain-complement residual,
 * carried through the real `mixdownSession`. No arithmetic of S5's own ever
 * touches the numbers.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

import { createDocument, docLength, type AudioDocument } from '../audio/AudioDocument';
import { partitionStems } from '../dsp/stemPartition';
import { mixdownSession } from '../multitrack/mixdown';
import { createClip, createTrack } from '../multitrack/session';
import { useSessionStore } from '../multitrack/sessionStore';
import { canUndoSession, isSessionDirty } from '../multitrack/sessionUndo';
import { defaultSessionZoom, sessionEndSample } from '../multitrack/sessionZoom';
import { FALLBACK_SESSION_LANE_WIDTH, _resetSessionLaneWidth } from '../multitrack/sessionViewport';
import { useAppStore, makeInitialState } from '../stores/appStore';
import { STEM_LABELS, type StemSeparationOutput } from './stemService';
import {
  buildStemSession,
  createStemDocuments,
  landStems,
  landVoice,
  stemSessionName,
  voiceSessionName,
  MONO_PAN_COMPENSATION_DB,
  STEM_TRACK_LABELS,
  VOICE_TRACK_LABELS,
  landSpeakers,
  speakerTrackLabels,
  speakersSessionName,
  speakerDocumentBytes,
  SPEAKER_LANDING_BUDGET_BYTES,
} from './stemLanding';
import { clearBeatGridLinks, _getBeatGridLinkForTest } from './beatGrid';
import { keepSpans } from '../dsp/spanMask';

// ---------------------------------------------------------------------------
// Fixtures — a local generator per file, this repo's convention
// (`remixService.test.ts`, `tempoCore.test.ts`, `fft.test.ts`).
// ---------------------------------------------------------------------------

const FIXTURE_LENGTH = 12000; // not a multiple of the 256-sample hop, on purpose

function makeLcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Tonal + noise content, peak well under full scale (no clamp involvement). */
function makeSourceChannels(channelCount: number, length: number, sampleRate: number): Float32Array[] {
  const out: Float32Array[] = [];
  for (let c = 0; c < channelCount; c++) {
    const rnd = makeLcg(0x5eed + c * 7919);
    const ch = new Float32Array(length);
    for (let i = 0; i < length; i++) {
      const t = i / sampleRate;
      ch[i] =
        0.3 * Math.sin(2 * Math.PI * 110 * t + c) +
        0.2 * Math.sin(2 * Math.PI * 440 * t) +
        0.12 * Math.sin(2 * Math.PI * 3000 * t + c * 0.7) +
        0.08 * (rnd() * 2 - 1);
    }
    out.push(ch);
  }
  return out;
}

/** One-pole lowpass; the building block for the stub "model estimates". */
function onePole(x: Float32Array, a: number): Float32Array {
  const y = new Float32Array(x.length);
  let z = 0;
  for (let i = 0; i < x.length; i++) {
    z += a * (x[i] - z);
    y[i] = z;
  }
  return y;
}

/**
 * Four stub estimates with genuinely different spectral character (high / low /
 * band / broadband), so the ratio masks are non-degenerate. Their absolute
 * scale is irrelevant — the mask is scale-invariant — but their SHAPES must
 * differ or every mask collapses to 1/4 and the fixture proves nothing.
 */
function makeEstimates(mix: Float32Array[]): Float32Array[][] {
  const perSource: Float32Array[][] = [[], [], [], []];
  for (const ch of mix) {
    const lpMid = onePole(ch, 0.3);
    const lpFast = onePole(ch, 0.05);
    const lpSlow = onePole(ch, 0.02);
    const high = new Float32Array(ch.length);
    const band = new Float32Array(ch.length);
    const rest = new Float32Array(ch.length);
    for (let i = 0; i < ch.length; i++) {
      high[i] = ch[i] - lpMid[i];
      band[i] = lpMid[i] - lpFast[i];
      rest[i] = 0.5 * ch[i];
    }
    perSource[0].push(high); // Drums   — transient/high
    perSource[1].push(lpSlow); // Bass   — low
    perSource[2].push(band); // Vocals  — mid band
    perSource[3].push(rest); // Other   — broadband
  }
  return perSource;
}

function addSourceDocument(
  channelCount: number,
  sampleRate: number,
  name = 'Song',
  length = FIXTURE_LENGTH
): AudioDocument {
  const doc = createDocument({
    name,
    sampleRate,
    channels: makeSourceChannels(channelCount, length, sampleRate),
    filePath: `C:/fixtures/${name}.wav`,
  });
  useAppStore.getState().addDocument(doc);
  return doc;
}

/** Builds the exact result shape S3 delivers, from a REAL partition. */
function makeOutput(doc: AudioDocument): StemSeparationOutput {
  const { stems, residual, stats } = partitionStems(doc.channels, makeEstimates(doc.channels), {
    collectStats: true,
  });
  return {
    sourceDocId: doc.id,
    sourceName: doc.name,
    sampleRate: doc.sampleRate,
    channelCount: doc.channels.length,
    lengthSamples: docLength(doc),
    stems: STEM_LABELS.map((label, i) => ({ label, channels: stems[i] })),
    residual,
    sanitisedEstimateSamples: 0,
    stats,
  };
}

function mixdownCurrentSession() {
  const docs = new Map(useAppStore.getState().documents.map((d) => [d.id, d]));
  return mixdownSession(useSessionStore.getState().session, docs);
}

interface IdentityReport {
  worstAbs: number;
  dbfs: number;
  exactFraction: number;
  compared: number;
}

/**
 * Worst |error| between the stereo mixdown and the source. A MONO source is
 * compared against BOTH master sides (the mixdown result is always stereo), so
 * a routing that fixed only one side cannot pass.
 */
function measureIdentity(
  mixed: { channels: [Float32Array, Float32Array] },
  source: Float32Array[]
): IdentityReport {
  const expectFor = (side: number) => (source.length === 1 ? source[0] : source[side]);
  let worstAbs = 0;
  let exact = 0;
  let compared = 0;
  for (let side = 0; side < 2; side++) {
    const got = mixed.channels[side];
    const want = expectFor(side);
    expect(got.length).toBe(want.length);
    for (let i = 0; i < want.length; i++) {
      const err = Math.abs(got[i] - want[i]);
      if (err > worstAbs) worstAbs = err;
      if (got[i] === want[i]) exact++;
      compared++;
    }
  }
  return {
    worstAbs,
    dbfs: worstAbs === 0 ? -Infinity : 20 * Math.log10(worstAbs),
    exactFraction: exact / compared,
    compared,
  };
}

beforeEach(() => {
  useAppStore.setState(makeInitialState());
  useSessionStore.getState().newSession(44100);
  clearBeatGridLinks();
});

// ---------------------------------------------------------------------------
// MT1 fix round (C1) — landed stems open FITTED
// ---------------------------------------------------------------------------
/*
 * Stem landing is one of the four session-load paths the MT1-1 changelog
 * claimed routed through the resolved zoom. It did not: it wrote
 * `{ samplesPerPixel: 512 }` by hand through `setState`, bypassing
 * `applySessionZoom`. Landing stems from a real song therefore opened a
 * five-track session showing about sixteen seconds of it — the reported
 * symptom, on a surface the report never mentioned because separating a song
 * is how you MOST often arrive at a long multitrack session.
 */
/**
 * The fixture LENGTH is the load-bearing part of this guard, and it was wrong.
 *
 * 512 samples/px is only a wrong zoom when it is a REACHABLE one. The shared
 * `FIXTURE_LENGTH` is 12 000 samples, whose fit is 8.72 samples/px — so a
 * hardcoded 512 is coarser than the zoom-out ceiling and `resolveSessionZoom`
 * CLAMPS it back to the fit before any assertion below can see it. This whole
 * describe therefore passed against the original bug: proven by reverting
 * `stemLanding.ts` to `{ samplesPerPixel: 512 }` and watching it stay green.
 *
 * At 20 s the fit is ~641 samples/px, 512 sits inside the range and stands. The
 * length is local to this test rather than raised on the shared constant for
 * two reasons: `FIXTURE_LENGTH` is deliberately not a multiple of the 256-sample
 * hop and other tests lean on that, and raising it globally took this suite from
 * 31 s to over 600 s (measured) because every case then partitions a 20 s source
 * into five stems. Same shape as `coverJourney.test.ts`'s own fitted-session
 * guard, for the same reason.
 */
const ZOOM_FIXTURE_LENGTH = 44100 * 20;

describe('MT1 C1: a landed stem session opens fitted', () => {
  it('lays the longest stem across the lane instead of the hardcoded 512', () => {
    _resetSessionLaneWidth();
    const source = addSourceDocument(2, 44100, 'Song', ZOOM_FIXTURE_LENGTH);
    landStems(makeOutput(source));

    const landed = useSessionStore.getState();
    const fit = defaultSessionZoom(landed.session);
    // The fixture must be able to EXPRESS the bug, or everything below is green
    // against broken code. This is the precondition the 12 000-sample fixture
    // silently failed.
    expect(fit.samplesPerPixel).toBeGreaterThan(512);
    expect(landed.mtZoom).toEqual(fit);
    expect(landed.mtZoom.scrollSample).toBe(0);
    // Every stem spans the whole source, so the fit is the source's length.
    expect(landed.mtZoom.samplesPerPixel).toBe(
      sessionEndSample(landed.session) / FALLBACK_SESSION_LANE_WIDTH
    );
  });
});

// ---------------------------------------------------------------------------
// THE ACCEPTANCE TEST
// ---------------------------------------------------------------------------

describe('mixdown identity — the untouched session reproduces the source', () => {
  /**
   * The CONTRACTUAL bound: −304 dBFS ≈ 6.3e-16, the float32-storage floor S2
   * and S3 both landed on; 1e-15 (≈ −300 dBFS) is asserted so the claim is
   * stated in the same terms the plan uses. The achieved result is stronger and
   * is asserted alongside it (`exactFraction === 1`, i.e. every sample
   * identical) — both alternatives to the shipped mono routing fail the LOOSE
   * bound too (0.196 unrouted, 5.96e-8 with the +3.01 dB fader), so this is a
   * real gate, not decoration.
   */
  const BOUND_ABS = 1e-15;

  const cases: Array<{ label: string; channels: number; sampleRate: number }> = [
    { label: 'stereo 44.1 kHz', channels: 2, sampleRate: 44100 },
    { label: 'stereo 48 kHz', channels: 2, sampleRate: 48000 },
    { label: 'mono 44.1 kHz', channels: 1, sampleRate: 44100 },
    { label: 'mono 48 kHz', channels: 1, sampleRate: 48000 },
  ];

  for (const c of cases) {
    it(`is sample-identical for ${c.label}`, () => {
      const source = addSourceDocument(c.channels, c.sampleRate);
      const sourceCopy = source.channels.map((ch) => Float32Array.from(ch));

      const result = landStems(makeOutput(source));
      expect(result.exactSumHolds).toBe(true);

      const mixed = mixdownCurrentSession();
      const report = measureIdentity(mixed, sourceCopy);

      // eslint-disable-next-line no-console
      console.log(
        `[S5 identity] ${c.label}: worst |err| = ${report.worstAbs.toExponential(3)} ` +
          `(${report.dbfs.toFixed(1)} dBFS), bit-exact ${(report.exactFraction * 100).toFixed(4)}% ` +
          `of ${report.compared} samples`
      );

      expect(report.worstAbs).toBeLessThanOrEqual(BOUND_ABS);
      expect(report.exactFraction).toBe(1);
    });
  }

  it('keeps EVERY track param at its default — the identity depends on no magic fader', () => {
    for (const channels of [1, 2]) {
      useAppStore.setState(makeInitialState());
      const source = addSourceDocument(channels, 44100);
      landStems(makeOutput(source));
      for (const t of useSessionStore.getState().session.tracks) {
        expect(t.volumeDb).toBe(0);
        expect(t.pan).toBe(0);
        expect(t.muted).toBe(false);
        expect(t.solo).toBe(false);
        expect(t.armed).toBe(false);
        expect(t.clips[0].gainDb).toBe(0);
      }
    }
  });

  it('routes a mono source as dual-mono stereo, with independent channel arrays', () => {
    const mono = addSourceDocument(1, 44100);
    const output = makeOutput(mono);
    const result = landStems(output);
    expect(result.monoRoutedAsDualMono).toBe(true);

    const delivered = [...output.stems.map((s) => s.channels), output.residual];
    const stemDocs = useAppStore.getState().documents.slice(1);
    expect(stemDocs).toHaveLength(5);
    stemDocs.forEach((d, i) => {
      expect(d.channels).toHaveLength(2);
      // Both sides are bit-exact copies of the ONE delivered mono stem...
      for (let n = 0; n < FIXTURE_LENGTH; n++) {
        expect(d.channels[0][n]).toBe(delivered[i][0][n]);
        expect(d.channels[1][n]).toBe(delivered[i][0][n]);
      }
      // ...and genuinely independent arrays, never one array aliased twice:
      // an aliased document would corrupt one channel through the other.
      expect(d.channels[0]).not.toBe(d.channels[1]);
      expect(d.channels[0]).not.toBe(delivered[i][0]);
      d.channels[0][0] = 0.5;
      expect(d.channels[1][0]).not.toBe(0.5);
      expect(delivered[i][0][0]).not.toBe(0.5);
    });
  });

  it('a stereo source is passed through with NO dual-mono routing', () => {
    const stereo = addSourceDocument(2, 44100);
    const output = makeOutput(stereo);
    const result = landStems(output);
    expect(result.monoRoutedAsDualMono).toBe(false);

    const stemDocs = useAppStore.getState().documents.slice(1);
    for (let s = 0; s < 4; s++) expect(stemDocs[s].channels).toBe(output.stems[s].channels);
    expect(stemDocs[4].channels).toBe(output.residual);
  });

  /**
   * Evidence for the rejected alternative documented in `stemLanding.ts`'s
   * header: mono documents plus the exact inverse fader (+3.0103 dB) is NOT
   * sample-identical. Built here by hand — `landStems` never produces it — so
   * the table in that header is reproducible rather than asserted.
   */
  it('pins WHY the +3.0103 dB fader route was rejected (not bit-exact)', () => {
    const mono = addSourceDocument(1, 44100);
    const sourceCopy = [Float32Array.from(mono.channels[0])];
    const output = makeOutput(mono);
    const delivered = [...output.stems.map((s) => s.channels), output.residual];

    const docs = new Map(useAppStore.getState().documents.map((d) => [d.id, d]));
    const tracks = delivered.map((channels, i) => {
      const doc = createDocument({
        name: `fader ${STEM_TRACK_LABELS[i]}`,
        sampleRate: 44100,
        channels, // MONO document — takes the constant-power pan law
      });
      docs.set(doc.id, doc);
      const track = createTrack(STEM_TRACK_LABELS[i]);
      track.volumeDb = MONO_PAN_COMPENSATION_DB;
      track.clips = [
        createClip({
          documentId: doc.id,
          startSample: 0,
          offsetSample: 0,
          lengthSample: FIXTURE_LENGTH,
        }),
      ];
      return track;
    });

    const mixed = mixdownSession({ name: 'fader', sampleRate: 44100, tracks }, docs);
    const report = measureIdentity(mixed, sourceCopy);

    // eslint-disable-next-line no-console
    console.log(
      `[S5 rejected: +${MONO_PAN_COMPENSATION_DB.toFixed(4)} dB fader on MONO docs] ` +
        `worst |err| = ${report.worstAbs.toExponential(3)} (${report.dbfs.toFixed(1)} dBFS), ` +
        `bit-exact ${(report.exactFraction * 100).toFixed(4)}%`
    );

    expect(MONO_PAN_COMPENSATION_DB).toBeCloseTo(3.0103, 4);
    expect(report.exactFraction).toBeLessThan(1); // NOT sample-identical
    expect(report.worstAbs).toBeGreaterThan(BOUND_ABS);
    // One float32 ULP near full scale — an accumulator rounding flipped by the
    // ~3.1e-16 relative residue of (x·√2)·cos(π/4), nothing larger.
    expect(report.worstAbs).toBeLessThanOrEqual(Math.pow(2, -24));
  });

  it('introduces no clipping beyond the source peak', () => {
    for (const channels of [1, 2]) {
      useAppStore.setState(makeInitialState());
      const source = addSourceDocument(channels, 44100);
      const sourcePeak = Math.max(
        ...source.channels.map((ch) => ch.reduce((m, v) => Math.max(m, Math.abs(v)), 0))
      );
      const result = landStems(makeOutput(source));
      expect(result.sourcePeak).toBeCloseTo(sourcePeak, 12);

      const mixed = mixdownCurrentSession();
      for (const side of mixed.channels) {
        for (let i = 0; i < side.length; i++) {
          expect(Math.abs(side[i])).toBeLessThanOrEqual(sourcePeak);
        }
      }
      expect(sourcePeak).toBeLessThan(1); // the fixture never reaches the clamp
    }
  });

  it('leaves the SOURCE document channels untouched (same arrays, same samples)', () => {
    const source = addSourceDocument(2, 48000);
    const refs = source.channels;
    const ref0 = source.channels[0];
    const ref1 = source.channels[1];
    const before = source.channels.map((ch) => Float32Array.from(ch));

    landStems(makeOutput(source));

    const live = useAppStore.getState().documents.find((d) => d.id === source.id)!;
    expect(live.channels).toBe(refs);
    expect(live.channels[0]).toBe(ref0);
    expect(live.channels[1]).toBe(ref1);
    for (let c = 0; c < 2; c++) {
      for (let i = 0; i < before[c].length; i++) expect(live.channels[c][i]).toBe(before[c][i]);
    }
  });

  it('leaves a MONO source document untouched too (the copy is of the STEM, not the source)', () => {
    const source = addSourceDocument(1, 44100);
    const ref0 = source.channels[0];
    const before = Float32Array.from(source.channels[0]);

    landStems(makeOutput(source));

    const live = useAppStore.getState().documents.find((d) => d.id === source.id)!;
    expect(live.channels).toHaveLength(1);
    expect(live.channels[0]).toBe(ref0);
    for (let i = 0; i < before.length; i++) expect(live.channels[0][i]).toBe(before[i]);
  });
});

// ---------------------------------------------------------------------------
// Documents (requirement 1)
// ---------------------------------------------------------------------------

describe('the five stem documents', () => {
  it('creates exactly five, named `<source> — <label>` in ruling-6 order', () => {
    const source = addSourceDocument(2, 44100, 'My Song');
    const result = landStems(makeOutput(source));

    const docs = useAppStore.getState().documents;
    expect(docs).toHaveLength(6); // the source + five stems
    expect(docs.slice(1).map((d) => d.name)).toEqual([
      'My Song — Drums',
      'My Song — Bass',
      'My Song — Vocals',
      'My Song — Other',
      'My Song — Residual',
    ]);
    expect(result.documentIds).toEqual(docs.slice(1).map((d) => d.id));
    expect(STEM_TRACK_LABELS).toEqual(['Drums', 'Bass', 'Vocals', 'Other', 'Residual']);
  });

  it('inherits neverSaved from createDocument (S4) and is not dirty or on disk', () => {
    const source = addSourceDocument(2, 44100);
    landStems(makeOutput(source));
    for (const d of useAppStore.getState().documents.slice(1)) {
      expect(d.neverSaved).toBe(true);
      expect(d.filePath).toBeNull();
      expect(d.dirty).toBe(false);
    }
  });

  it('carries the source sample rate and full length onto every stem document', () => {
    const source = addSourceDocument(1, 48000);
    landStems(makeOutput(source));
    for (const d of useAppStore.getState().documents.slice(1)) {
      expect(d.sampleRate).toBe(48000);
      expect(docLength(d)).toBe(FIXTURE_LENGTH);
    }
  });

  it('activates the first stem, not the Residual', () => {
    const source = addSourceDocument(2, 44100);
    const result = landStems(makeOutput(source));
    expect(useAppStore.getState().activeDocumentId).toBe(result.documentIds[0]);
  });
});

// ---------------------------------------------------------------------------
// Session (requirement 2)
// ---------------------------------------------------------------------------

describe('the stem session', () => {
  it('replaces the session with five tracks, Residual LAST', () => {
    const source = addSourceDocument(2, 48000, 'Track A');
    const result = landStems(makeOutput(source));

    const state = useSessionStore.getState();
    expect(state.session.name).toBe('Track A — Stems');
    expect(stemSessionName('Track A')).toBe('Track A — Stems');
    expect(state.session.sampleRate).toBe(48000);
    expect(state.session.tracks.map((t) => t.name)).toEqual([
      'Drums',
      'Bass',
      'Vocals',
      'Other',
      'Residual',
    ]);
    expect(state.session.tracks[4].name).toBe('Residual');
    expect(result.trackIds).toEqual(state.session.tracks.map((t) => t.id));
  });

  it('gives each track exactly one full-length clip at offset 0', () => {
    const source = addSourceDocument(2, 44100);
    const result = landStems(makeOutput(source));

    const tracks = useSessionStore.getState().session.tracks;
    tracks.forEach((t, i) => {
      expect(t.clips).toHaveLength(1);
      const clip = t.clips[0];
      expect(clip.documentId).toBe(result.documentIds[i]);
      expect(clip.startSample).toBe(0);
      expect(clip.offsetSample).toBe(0);
      expect(clip.lengthSample).toBe(FIXTURE_LENGTH);
    });
  });

  it('switches to the multitrack view and clears session transients', () => {
    useSessionStore.setState({ selectedClipId: 'clip-stale', mtCursorSample: 999, mtPlayheadSample: 42 });
    const source = addSourceDocument(2, 44100);
    landStems(makeOutput(source));

    expect(useAppStore.getState().view).toBe('multitrack');
    const s = useSessionStore.getState();
    expect(s.selectedClipId).toBeNull();
    expect(s.mtCursorSample).toBe(0);
    expect(s.mtPlayheadSample).toBe(0);
    expect(s.mtPlayState).toBe('stopped');
  });

  it('discards whatever session was open before', () => {
    useSessionStore.getState().newSession(44100);
    useSessionStore.getState().addTrack();
    expect(useSessionStore.getState().session.tracks).toHaveLength(5);

    const source = addSourceDocument(2, 44100);
    landStems(makeOutput(source));
    const names = useSessionStore.getState().session.tracks.map((t) => t.name);
    expect(names).not.toContain('Track 1');
    expect(names).toHaveLength(5);
  });
});

// ---------------------------------------------------------------------------
// CC4 (CJ-1) — the two halves, separately
// ---------------------------------------------------------------------------

describe('CC4 (CJ-1): the documents half lands documents and NOTHING else', () => {
  it('creates the five documents without touching the session or its history', () => {
    useSessionStore.getState().newSession(44100);
    useSessionStore.getState().addTrack();
    const before = useSessionStore.getState().session;
    useSessionStore.setState({ selectedClipId: 'clip-mine', mtCursorSample: 999 });
    useAppStore.setState({ view: 'waveform' });

    const source = addSourceDocument(2, 44100);
    const result = createStemDocuments(makeOutput(source));

    // Everything the ADDITIVE half promises.
    expect(result.documentIds).toHaveLength(5);
    const docs = useAppStore.getState().documents;
    expect(result.documentIds.map((id) => docs.find((d) => d.id === id)!.name)).toEqual(
      STEM_TRACK_LABELS.map((l) => `${source.name} — ${l}`)
    );
    expect(useAppStore.getState().activeDocumentId).toBe(result.documentIds[0]);

    // …and everything it must NOT do. The session object is the SAME object,
    // not an equal one: a replacement that happened to rebuild the same shape
    // would still have dropped the user's session undo history.
    const after = useSessionStore.getState();
    expect(after.session).toBe(before);
    expect(after.selectedClipId).toBe('clip-mine');
    expect(after.mtCursorSample).toBe(999);
    // Nor does it drag the user into the multitrack view.
    expect(useAppStore.getState().view).toBe('waveform');
  });

  it('is exactly what landStems does, plus the session half', () => {
    const source = addSourceDocument(2, 44100);
    const output = makeOutput(source);
    const documents = createStemDocuments(output);
    const session = buildStemSession(output, documents.documentIds);

    expect(useSessionStore.getState().session.tracks.map((t) => t.clips[0].documentId)).toEqual(
      documents.documentIds
    );
    expect(session.sessionName).toBe(stemSessionName(source.name));
    expect(session.trackIds).toEqual(useSessionStore.getState().session.tracks.map((t) => t.id));
    expect(useAppStore.getState().view).toBe('multitrack');
  });
});

// ---------------------------------------------------------------------------
// The condition the guarantee carries (S2 review handoff)
// ---------------------------------------------------------------------------

describe('over-unity sources — the ±1 master clamp', () => {
  /** Same fixture, scaled past full scale so the master bus clamp engages. */
  function addHotSource(sampleRate: number): AudioDocument {
    const channels = makeSourceChannels(2, FIXTURE_LENGTH, sampleRate).map((ch) => {
      const out = new Float32Array(ch.length);
      for (let i = 0; i < ch.length; i++) out[i] = ch[i] * 2.4;
      return out;
    });
    const doc = createDocument({ name: 'Hot', sampleRate, channels, filePath: 'C:/fixtures/hot.wav' });
    useAppStore.getState().addDocument(doc);
    return doc;
  }

  /** The same fixture with one sample driven to exactly +1 and one to exactly
   * −1 — a normalised master, the commonest thing a user drops on this app. It
   * sits ON the boundary, which is the one place `<= 1` and `< 1` disagree. */
  function addFullScaleSource(sampleRate: number): AudioDocument {
    const raw = makeSourceChannels(2, FIXTURE_LENGTH, sampleRate);
    const peak = Math.max(...raw.map((ch) => ch.reduce((m, v) => Math.max(m, Math.abs(v)), 0)));
    const channels = raw.map((ch) => {
      const out = new Float32Array(ch.length);
      for (let i = 0; i < ch.length; i++) out[i] = ch[i] * (0.9 / peak);
      return out;
    });
    channels[0][1234] = 1;
    channels[1][5678] = -1;
    const doc = createDocument({ name: 'Normalised', sampleRate, channels, filePath: 'C:/fixtures/norm.wav' });
    useAppStore.getState().addDocument(doc);
    return doc;
  }

  it('reports exactSumHolds:true at a peak of EXACTLY 1, where the sum still reconstructs', () => {
    const source = addFullScaleSource(44100);
    const sourceCopy = source.channels.map((ch) => Float32Array.from(ch));
    const result = landStems(makeOutput(source));

    // ON the boundary, not near it: nothing else in this suite sits here, and
    // `< 1` would flag the amber "won't add back exactly" on every normalised
    // master that ships.
    expect(result.sourcePeak).toBe(1);
    expect(result.exactSumHolds).toBe(true);

    // …and the claim is true: the clamp never engages, so the identity holds
    // sample for sample. An amber warning here would be a lie.
    const report = measureIdentity(mixdownCurrentSession(), sourceCopy);
    // eslint-disable-next-line no-console
    console.log(
      `[S5 identity @ peak 1.0] worst |err| = ${report.worstAbs.toExponential(3)}, ` +
        `bit-exact ${(report.exactFraction * 100).toFixed(4)}%`
    );
    expect(report.exactFraction).toBe(1);
    expect(report.worstAbs).toBe(0);
  });

  it('reports exactSumHolds:false and the peak, instead of claiming an identity it cannot deliver', () => {
    const source = addHotSource(44100);
    const sourceCopy = source.channels.map((ch) => Float32Array.from(ch));
    const result = landStems(makeOutput(source));

    expect(result.sourcePeak).toBeGreaterThan(1);
    expect(result.exactSumHolds).toBe(false);

    // The clamp really does break the identity — this is why it is reported.
    const report = measureIdentity(mixdownCurrentSession(), sourceCopy);
    expect(report.worstAbs).toBeGreaterThan(0.1);

    // ...and the clamp is NOT defeated: the mixdown still never exceeds ±1.
    for (const side of mixdownCurrentSession().channels) {
      for (let i = 0; i < side.length; i++) expect(Math.abs(side[i])).toBeLessThanOrEqual(1);
    }
  });

  it('records beat-grid provenance for every stem, so the five tracks share ONE grid (Task B1)', () => {
    const source = addSourceDocument(2, 44100);
    const result = landStems(makeOutput(source));

    expect(result.documentIds).toHaveLength(5);
    for (const docId of result.documentIds) {
      expect(_getBeatGridLinkForTest(docId)).toEqual({ parentDocId: source.id, detached: false });
    }
    // The source itself inherits from nothing.
    expect(_getBeatGridLinkForTest(source.id)).toBeUndefined();
  });

  it('records provenance for a MONO source too — dual-mono stems keep the same time base', () => {
    const source = addSourceDocument(1, 44100);
    const result = landStems(makeOutput(source));

    expect(result.monoRoutedAsDualMono).toBe(true);
    for (const docId of result.documentIds) {
      expect(_getBeatGridLinkForTest(docId)?.parentDocId).toBe(source.id);
    }
  });

  it('records NO provenance when the source document is already gone — there is nothing to inherit', () => {
    const source = addSourceDocument(2, 44100);
    const output = makeOutput(source);
    useAppStore.getState().closeDocument(source.id);

    const result = landStems(output);

    for (const docId of result.documentIds) {
      expect(_getBeatGridLinkForTest(docId)).toBeUndefined();
    }
  });

  it('reports null when the source document is gone and the check cannot be made', () => {
    const source = addSourceDocument(2, 44100);
    const output = makeOutput(source);
    useAppStore.getState().closeDocument(source.id);

    const result = landStems(output);
    expect(result.sourcePeak).toBeNull();
    expect(result.exactSumHolds).toBeNull();
    // The stems still land — they are valid audio regardless.
    expect(useAppStore.getState().documents).toHaveLength(5);
    expect(useSessionStore.getState().session.tracks).toHaveLength(5);
  });
});

// ---------------------------------------------------------------------------
// Lot A (M4) — a landed stem session is a NEW, unsaved project: whatever
// `.audm` was open before is not where these tracks live.
// ---------------------------------------------------------------------------
describe('lot A (M4): a landed stem session is a new, unsaved project', () => {
  it('clears projectPath and starts with a clean session history', () => {
    useSessionStore.getState().setProjectPath('D:\\p.audm');
    // A recorded session edit BEFORE the landing: the landing must DROP the
    // stack, so nothing is left to undo and the session sits at the mark.
    useSessionStore.getState().renameSession('edited before landing');
    expect(isSessionDirty()).toBe(true);
    const source = addSourceDocument(2, 44100);

    landStems(makeOutput(source));

    expect(useSessionStore.getState().projectPath).toBeNull();
    expect(canUndoSession()).toBe(false);
    expect(isSessionDirty()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// D4 — Separate Voice: the SAME separation run, landed as two tracks
// ---------------------------------------------------------------------------
/**
 * `landVoice` is `landStems` over a different partition of the SAME output: the
 * Vocals stem alone on one track, and everything else — Drums, Bass, Other and
 * the Residual — summed onto a second. Nothing new is separated and no second
 * model run happens; the arithmetic below is the whole difference.
 *
 * The fixtures are the ones the stem tests already use, so the sum under test
 * is a REAL partition (`partitionStems` over stub estimates) rather than five
 * hand-written arrays that would agree with any implementation.
 */

/**
 * Drums + Bass + Other + Residual, accumulated in float64 — deliberately NOT
 * the shipped float32 loop, so the assertion compares two different
 * computations rather than one against itself.
 */
function expectedBacking(output: StemSeparationOutput): {
  sum: Float64Array[];
  /** Σ|term| per sample — the scale the float32 error bound below is stated
   *  against, because these four terms CANCEL (the fixture's masked stems reach
   *  |9.9| where their sum is often near zero, so the error of a float32
   *  accumulation is set by the size of the terms, never by the size of the
   *  answer). */
  magnitude: Float64Array[];
} {
  const parts = [
    ...output.stems.filter((s) => s.label !== 'Vocals').map((s) => s.channels),
    output.residual,
  ];
  const channelCount = parts[0].length;
  const sum: Float64Array[] = [];
  const magnitude: Float64Array[] = [];
  for (let c = 0; c < channelCount; c++) {
    const s = new Float64Array(output.lengthSamples);
    const m = new Float64Array(output.lengthSamples);
    for (const part of parts) {
      for (let i = 0; i < s.length; i++) {
        s[i] += part[c][i];
        m[i] += Math.abs(part[c][i]);
      }
    }
    sum.push(s);
    magnitude.push(m);
  }
  return { sum, magnitude };
}

function vocalsOf(output: StemSeparationOutput): Float32Array[] {
  return output.stems.find((s) => s.label === 'Vocals')!.channels;
}

describe('D4 landVoice — the two documents', () => {
  it('creates exactly two, named `<source> — Voice` and `<source> — Backing`', () => {
    const source = addSourceDocument(2, 44100, 'My Song');
    const result = landVoice(makeOutput(source));

    const docs = useAppStore.getState().documents;
    expect(docs).toHaveLength(3); // the source + Voice + Backing
    expect(docs.slice(1).map((d) => d.name)).toEqual(['My Song — Voice', 'My Song — Backing']);
    expect(result.documentIds).toEqual(docs.slice(1).map((d) => d.id));
    expect(VOICE_TRACK_LABELS).toEqual(['Voice', 'Backing']);
  });

  it('lands the Vocals stem as the Voice document, sample for sample', () => {
    const source = addSourceDocument(2, 44100);
    const output = makeOutput(source);
    const result = landVoice(output);

    const voice = useAppStore.getState().documents.find((d) => d.id === result.documentIds[0])!;
    expect(voice.channels).toEqual(vocalsOf(output));
    // A stereo stem is handed through untouched, as `documentChannels` promises.
    expect(voice.channels[0]).toBe(vocalsOf(output)[0]);
  });

  it('sums Drums + Bass + Other + Residual onto the Backing document, every sample', () => {
    const source = addSourceDocument(2, 44100);
    const output = makeOutput(source);
    const result = landVoice(output);

    const backing = useAppStore.getState().documents.find((d) => d.id === result.documentIds[1])!;
    const { sum: want, magnitude } = expectedBacking(output);
    expect(backing.channels).toHaveLength(2);

    /*
     * The bound is the CLASSICAL one for a float32 accumulation —
     * `(n−1)·eps·Σ|term|`, n = 4 — rather than the plan's `toBeCloseTo(…, 6)`
     * (5e-7 absolute), which measurement showed is unreachable by any correct
     * implementation here: this fixture's masked stems reach |9.9| and largely
     * cancel, so float32 storage alone is granular to 9.5e-7 at the terms and
     * the error of the sum is set by their size, never by the size of the
     * answer. Stated as a ratio it is the sharper claim: every sample, at every
     * magnitude, inside the arithmetic's own error bound with one rounding to
     * spare for storing the result.
     */
    const EPS32 = 1.1920929e-7;
    let worstRatio = 0;
    let worstAbs = 0;
    for (let c = 0; c < want.length; c++) {
      expect(backing.channels[c]).toHaveLength(want[c].length);
      for (let i = 0; i < want[c].length; i++) {
        const err = Math.abs(backing.channels[c][i] - want[c][i]);
        if (err > worstAbs) worstAbs = err;
        const bound = EPS32 * Math.max(magnitude[c][i], Math.abs(want[c][i]));
        if (bound > 0 && err / bound > worstRatio) worstRatio = err / bound;
      }
    }
    expect(worstRatio).toBeLessThanOrEqual(4);
    // The absolute size of that error, pinned as measured: 7.0e-7 worst over
    // 24 000 samples of stems that reach |9.9| — a fortieth of the smallest
    // step a 16-bit file can store.
    expect(worstAbs).toBeLessThan(1e-6);
    // Not vacuous: the Backing is genuinely different audio from the Voice.
    expect(backing.channels[0]).not.toEqual(vocalsOf(output)[0]);
  });

  it('Voice + Backing is the source again, to the plan’s 1e-6', () => {
    const source = addSourceDocument(2, 44100);
    const output = makeOutput(source);
    const result = landVoice(output);

    const docs = useAppStore.getState().documents;
    const voice = docs.find((d) => d.id === result.documentIds[0])!;
    const backing = docs.find((d) => d.id === result.documentIds[1])!;

    let worst = 0;
    let exact = 0;
    let compared = 0;
    for (let c = 0; c < source.channels.length; c++) {
      for (let i = 0; i < FIXTURE_LENGTH; i++) {
        const got = voice.channels[c][i] + backing.channels[c][i];
        const err = Math.abs(got - source.channels[c][i]);
        if (err > worst) worst = err;
        if (Math.fround(got) === source.channels[c][i]) exact++;
        compared++;
      }
    }
    expect(compared).toBe(2 * FIXTURE_LENGTH);
    expect(worst).toBeLessThan(1e-6);
    /*
     * The honest half of the claim, measured: 4.32e-7 worst and 66 % of samples
     * bit-identical. Two tracks CANNOT be bit-exact the way five are — the
     * five-track landing replays the partition's own accumulation order, which
     * is what makes `Σ stems + (mix − Σ stems)` collapse back to `mix` sample
     * for sample, and re-associating that sum into (Vocals) + (the other four)
     * rounds differently. So this pins the tolerance the plan states and the
     * fraction is left unasserted rather than dressed up as exactness — and the
     * dialog's voice copy says the same thing in words.
     */
    expect(exact / compared).toBeGreaterThan(0.5);
  });

  it('activates the Voice document, not the Backing', () => {
    const source = addSourceDocument(2, 44100);
    const result = landVoice(makeOutput(source));
    expect(useAppStore.getState().activeDocumentId).toBe(result.documentIds[0]);
  });

  it('carries the source rate and full length onto both, unsaved and clean', () => {
    const source = addSourceDocument(2, 48000);
    landVoice(makeOutput(source));
    for (const d of useAppStore.getState().documents.slice(1)) {
      expect(d.sampleRate).toBe(48000);
      expect(docLength(d)).toBe(FIXTURE_LENGTH);
      expect(d.neverSaved).toBe(true);
      expect(d.filePath).toBeNull();
      expect(d.dirty).toBe(false);
    }
  });

  it('records the source’s beat-grid provenance on both documents', () => {
    const source = addSourceDocument(2, 44100);
    const result = landVoice(makeOutput(source));
    for (const docId of result.documentIds) {
      expect(_getBeatGridLinkForTest(docId)?.parentDocId).toBe(source.id);
    }
  });

  it('follows the dual-mono rule for a MONO source, on both tracks', () => {
    const source = addSourceDocument(1, 44100);
    const output = makeOutput(source);
    const result = landVoice(output);

    expect(result.monoRoutedAsDualMono).toBe(true);
    const docs = useAppStore.getState().documents;
    for (const id of result.documentIds) {
      const doc = docs.find((d) => d.id === id)!;
      expect(doc.channels).toHaveLength(2);
      expect(doc.channels[0]).toEqual(doc.channels[1]);
      // Independent copies, never one array aliased twice (S5's rule).
      expect(doc.channels[0]).not.toBe(doc.channels[1]);
    }
    // …and the copies really are the mono material, not silence.
    const voice = docs.find((d) => d.id === result.documentIds[0])!;
    expect(voice.channels[0]).toEqual(vocalsOf(output)[0]);
  });

  it('reports the source peak and the exactness verdict exactly as landStems does', () => {
    const source = addSourceDocument(2, 44100);
    const result = landVoice(makeOutput(source));
    expect(result.sourcePeak).toBeGreaterThan(0);
    expect(result.sourcePeak).toBeLessThanOrEqual(1);
    expect(result.exactSumHolds).toBe(true);
  });

  it('reports null for both when the source document is gone', () => {
    const source = addSourceDocument(2, 44100);
    const output = makeOutput(source);
    useAppStore.getState().closeDocument(source.id);

    const result = landVoice(output);

    expect(result.sourcePeak).toBeNull();
    expect(result.exactSumHolds).toBeNull();
    // The two documents still land — they are valid audio regardless.
    expect(useAppStore.getState().documents).toHaveLength(2);
    expect(useSessionStore.getState().session.tracks).toHaveLength(2);
  });
});

describe('D4 landVoice — the two-track session', () => {
  it('replaces the session with Voice then Backing, at the output rate', () => {
    const source = addSourceDocument(2, 48000, 'Track A');
    const result = landVoice(makeOutput(source));

    const state = useSessionStore.getState();
    expect(state.session.name).toBe('Track A — Voice + Backing');
    expect(voiceSessionName('Track A')).toBe('Track A — Voice + Backing');
    expect(state.session.sampleRate).toBe(48000);
    expect(state.session.tracks.map((t) => t.name)).toEqual(['Voice', 'Backing']);
    expect(result.trackIds).toEqual(state.session.tracks.map((t) => t.id));
  });

  it('gives each track exactly one full-length clip at offset 0', () => {
    const source = addSourceDocument(2, 44100);
    const result = landVoice(makeOutput(source));

    const tracks = useSessionStore.getState().session.tracks;
    tracks.forEach((t, i) => {
      expect(t.clips).toHaveLength(1);
      expect(t.clips[0].documentId).toBe(result.documentIds[i]);
      expect(t.clips[0].startSample).toBe(0);
      expect(t.clips[0].offsetSample).toBe(0);
      expect(t.clips[0].lengthSample).toBe(FIXTURE_LENGTH);
    });
  });

  it('switches to the multitrack view, clears the transients and the project path', () => {
    useSessionStore.getState().setProjectPath('D:\\p.audm');
    useSessionStore.getState().renameSession('edited before landing');
    useSessionStore.setState({
      selectedClipId: 'clip-stale',
      mtCursorSample: 999,
      mtPlayheadSample: 42,
    });
    const source = addSourceDocument(2, 44100);

    landVoice(makeOutput(source));

    expect(useAppStore.getState().view).toBe('multitrack');
    const s = useSessionStore.getState();
    expect(s.selectedClipId).toBeNull();
    expect(s.mtCursorSample).toBe(0);
    expect(s.mtPlayheadSample).toBe(0);
    expect(s.mtPlayState).toBe('stopped');
    expect(s.projectPath).toBeNull();
    expect(canUndoSession()).toBe(false);
    expect(isSessionDirty()).toBe(false);
  });

  it('opens FITTED, like every other session-load path (MT1 C1)', () => {
    _resetSessionLaneWidth();
    const source = addSourceDocument(2, 44100, 'Song', ZOOM_FIXTURE_LENGTH);
    landVoice(makeOutput(source));

    const landed = useSessionStore.getState();
    const fit = defaultSessionZoom(landed.session);
    expect(fit.samplesPerPixel).toBeGreaterThan(512);
    expect(landed.mtZoom).toEqual(fit);
    expect(landed.mtZoom.scrollSample).toBe(0);
  });

  it('mixes back down to the source — stereo and mono, through the real mixdown', () => {
    for (const channelCount of [2, 1]) {
      useAppStore.setState(makeInitialState());
      useSessionStore.getState().newSession(44100);
      const source = addSourceDocument(channelCount, 44100);
      landVoice(makeOutput(source));

      const report = measureIdentity(mixdownCurrentSession(), source.channels);
      expect([channelCount, report.compared]).toEqual([channelCount, 2 * FIXTURE_LENGTH]);
      // Measured 4.32e-7 for both, i.e. −127 dBFS: the same re-association
      // rounding as above, carried through the REAL mixdown — and for the mono
      // source that is only true because both documents took the dual-mono
      // route (unrouted, this reads 0.196).
      expect([channelCount, report.worstAbs < 1e-6]).toEqual([channelCount, true]);
    }
  });
});

// ---------------------------------------------------------------------------
// D4 — Separate Speakers: one document per speaker, plus the Backing
// ---------------------------------------------------------------------------
/**
 * `landSpeakers` is `landVoice` with the Voice track split N ways: each speaker
 * gets the FULL Vocals stem with everything outside their own turns taken to
 * silence by `keepSpans` (D4), and the Backing is the same sum `landVoice`
 * lands. The assertions below compare the landed documents against
 * `keepSpans`' own output rather than against a mask re-implemented here, and
 * against `landVoice`'s Backing rather than a hand-written sum — so a change to
 * either shared piece shows up as a failure here instead of a silent drift.
 *
 * There is deliberately NO exact-sum assertion for the speaker tracks: the edge
 * fades remove audio and an overlapping turn is carried twice, which D4 states
 * and the dialog's copy repeats.
 */

/**
 * Speaker 1 owns the first half PLUS a turn that sits inside speaker 2's half;
 * speaker 2 owns the second half. `[8000, 9000)` is therefore held by BOTH, and
 * it is 1000 samples — wider than two 441-sample ramps, so it has a unity
 * interior to compare.
 */
const SPEAKER_SPANS = [
  [
    { startSample: 0, endSample: 6000 },
    { startSample: 8000, endSample: 9000 },
  ],
  [{ startSample: 6000, endSample: 12000 }],
];

function docById(id: string): AudioDocument {
  return useAppStore.getState().documents.find((d) => d.id === id)!;
}

describe('D4 landSpeakers — one document per speaker plus the Backing', () => {
  it('creates N + 1 documents, named `<source> — Speaker k` and `<source> — Backing`', () => {
    const source = addSourceDocument(2, 44100, 'My Song');
    const result = landSpeakers(makeOutput(source), SPEAKER_SPANS);

    const docs = useAppStore.getState().documents;
    expect(docs).toHaveLength(4); // the source + two speakers + Backing
    expect(docs.slice(1).map((d) => d.name)).toEqual([
      'My Song — Speaker 1',
      'My Song — Speaker 2',
      'My Song — Backing',
    ]);
    expect(result.documentIds).toEqual(docs.slice(1).map((d) => d.id));
  });

  it('lands each speaker as the Vocals stem masked to that speaker’s spans', () => {
    const source = addSourceDocument(2, 44100);
    const output = makeOutput(source);
    const result = landSpeakers(output, SPEAKER_SPANS);

    for (let k = 0; k < SPEAKER_SPANS.length; k++) {
      const doc = docById(result.documentIds[k]);
      expect(doc.channels).toEqual(keepSpans(vocalsOf(output), SPEAKER_SPANS[k], output.sampleRate));
      // Not vacuous: masking really removed audio the Voice document keeps.
      expect(doc.channels[0]).not.toEqual(vocalsOf(output)[0]);
      expect(docLength(doc)).toBe(FIXTURE_LENGTH);
    }
    // …and the two speakers are different audio from each other.
    expect(docById(result.documentIds[0]).channels[0]).not.toEqual(
      docById(result.documentIds[1]).channels[0]
    );
  });

  it('carries an overlapping turn on BOTH speakers, and each speaker’s own half on one', () => {
    const source = addSourceDocument(2, 44100);
    const output = makeOutput(source);
    const result = landSpeakers(output, SPEAKER_SPANS);
    const vocals = vocalsOf(output);
    const first = docById(result.documentIds[0]).channels;
    const second = docById(result.documentIds[1]).channels;

    // Interior of [8000, 9000), clear of both 441-sample ramps.
    let bothCarry = 0;
    let audible = 0;
    for (let i = 8441; i < 8559; i++) {
      for (let c = 0; c < 2; c++) {
        if (first[c][i] === vocals[c][i] && second[c][i] === vocals[c][i]) bothCarry++;
        if (vocals[c][i] !== 0) audible++;
      }
    }
    expect([bothCarry, audible]).toEqual([236, 236]);

    // Away from the overlap each speaker holds their own half alone.
    expect(first[0][3000]).toBe(vocals[0][3000]);
    expect(second[0][3000]).toBe(0);
    expect(second[0][11000]).toBe(vocals[0][11000]);
    expect(first[0][11000]).toBe(0);
  });

  it('lands the same Backing as landVoice, sample for sample', () => {
    const source = addSourceDocument(2, 44100);
    const output = makeOutput(source);

    const speakers = landSpeakers(output, SPEAKER_SPANS);
    const viaSpeakers = docById(speakers.documentIds[2]).channels.map((c) => Float32Array.from(c));

    // The SAME output landed the other way: the Backing is the one thing the
    // two landings must agree on exactly (D4 — "plus `<source> — Backing`
    // unchanged"), so it is compared against the shipped path, not a local sum.
    const voice = landVoice(output);
    const viaVoice = docById(voice.documentIds[1]).channels;

    expect(viaSpeakers).toEqual([...viaVoice]);
    expect(viaSpeakers[0]).not.toEqual(vocalsOf(output)[0]);
  });

  it('orders the tracks Speaker 1 … Speaker N then Backing, in a `— Speakers` session', () => {
    const source = addSourceDocument(2, 48000, 'Track A');
    const result = landSpeakers(makeOutput(source), SPEAKER_SPANS);

    const state = useSessionStore.getState();
    expect(state.session.name).toBe('Track A — Speakers');
    expect(speakersSessionName('Track A')).toBe('Track A — Speakers');
    expect(state.session.sampleRate).toBe(48000);
    expect(state.session.tracks.map((t) => t.name)).toEqual(['Speaker 1', 'Speaker 2', 'Backing']);
    expect(result.trackIds).toEqual(state.session.tracks.map((t) => t.id));
    expect(result.sessionName).toBe('Track A — Speakers');
  });

  it('masks at the DOCUMENT’s own rate — 480-sample ramps at 48 kHz, not 441', () => {
    // The rate is the one parameter of `keepSpans` that changes the samples it
    // writes (`spanMask.test.ts` pins 441 @ 44.1 kHz against 480 @ 48 kHz), and
    // every other assertion in this describe runs at 44,100 — where a landing
    // that passed a hardcoded 44,100 instead of `output.sampleRate` is
    // indistinguishable from the shipped one. This case is that mutant's only
    // executioner, so it pins the ramp on the landed samples themselves as well
    // as against `keepSpans` at the document's rate.
    const source = addSourceDocument(2, 48000, 'At 48k');
    const output = makeOutput(source);
    const result = landSpeakers(output, SPEAKER_SPANS);
    const vocals = vocalsOf(output);

    for (let k = 0; k < SPEAKER_SPANS.length; k++) {
      expect(docById(result.documentIds[k]).channels).toEqual(
        keepSpans(vocals, SPEAKER_SPANS[k], 48000)
      );
    }

    // Speaker 2's span opens at 6000, so its fade-in reaches unity on its LAST
    // ramp sample: 6000 + 480 − 1 here, and 6000 + 441 − 1 at 44.1 kHz.
    const second = docById(result.documentIds[1]).channels[0];
    expect(second[6479]).toBe(vocals[0][6479]);
    expect(second[6478]).not.toBe(vocals[0][6478]);
    // The 44.1 kHz ramp would have finished 39 samples earlier — the sample
    // that separates the two rates, still attenuated at this one.
    expect(second[6440]).not.toBe(vocals[0][6440]);
    // Not vacuous: real audio at both, so "not equal" means attenuated and not
    // a pair of zeros compared against each other.
    expect(vocals[0][6440]).not.toBe(0);
    expect(vocals[0][6478]).not.toBe(0);
  });

  it('gives each track exactly one full-length clip at offset 0', () => {
    const source = addSourceDocument(2, 44100);
    const result = landSpeakers(makeOutput(source), SPEAKER_SPANS);

    const tracks = useSessionStore.getState().session.tracks;
    expect(tracks).toHaveLength(3);
    tracks.forEach((t, i) => {
      expect(t.clips).toHaveLength(1);
      expect(t.clips[0].documentId).toBe(result.documentIds[i]);
      expect(t.clips[0].startSample).toBe(0);
      expect(t.clips[0].offsetSample).toBe(0);
      expect(t.clips[0].lengthSample).toBe(FIXTURE_LENGTH);
    });
    expect(useAppStore.getState().view).toBe('multitrack');
  });

  it('activates Speaker 1, not the Backing', () => {
    const source = addSourceDocument(2, 44100);
    const result = landSpeakers(makeOutput(source), SPEAKER_SPANS);
    expect(useAppStore.getState().activeDocumentId).toBe(result.documentIds[0]);
  });

  it('links every document to the source and leaves them unsaved and clean', () => {
    const source = addSourceDocument(2, 44100);
    const result = landSpeakers(makeOutput(source), SPEAKER_SPANS);

    for (const id of result.documentIds) {
      expect(_getBeatGridLinkForTest(id)?.parentDocId).toBe(source.id);
      const doc = docById(id);
      expect(doc.sampleRate).toBe(44100);
      expect(doc.neverSaved).toBe(true);
      expect(doc.filePath).toBeNull();
      expect(doc.dirty).toBe(false);
    }
  });

  it('widens a MONO source to dual-mono on every speaker track', () => {
    const source = addSourceDocument(1, 44100);
    const output = makeOutput(source);
    const result = landSpeakers(output, SPEAKER_SPANS);

    expect(result.monoRoutedAsDualMono).toBe(true);
    for (const id of result.documentIds) {
      const doc = docById(id);
      expect(doc.channels).toHaveLength(2);
      expect(doc.channels[0]).toEqual(doc.channels[1]);
      // Independent copies, never one array aliased twice (S5's rule).
      expect(doc.channels[0]).not.toBe(doc.channels[1]);
    }
    // …and the copies are the MASKED mono material, not the whole stem.
    const masked = keepSpans(vocalsOf(output), SPEAKER_SPANS[0], output.sampleRate);
    expect(docById(result.documentIds[0]).channels[0]).toEqual(masked[0]);
  });

  it('reports the source peak but makes NO exact-sum claim — D4', () => {
    const source = addSourceDocument(2, 44100);
    const output = makeOutput(source);
    const result = landSpeakers(output, SPEAKER_SPANS);

    // The peak is a fact about the SOURCE and is measured for speakers exactly
    // as for stems.
    expect(result.sourcePeak).toBeGreaterThan(0);
    // The verdict is not. D4: "No exact-sum claim for speakers" — the edge
    // fades remove audio at every turn and the overlap span is carried by BOTH
    // documents, so the tracks cannot add back to the source whatever the peak
    // is. `null` is this module's "could not be determined / no claim in either
    // direction" value, and the dialog renders it as silence (S5's contract);
    // `true` would be a false guarantee, `false` would blame a clamp that is
    // not what is happening.
    expect(result.exactSumHolds).toBeNull();
    // Not vacuous: the same source through `landVoice` DOES answer the
    // question, so the null is the speaker landing's own stance and not a peak
    // measurement that failed.
    expect(landVoice(makeOutput(addSourceDocument(2, 44100, 'Other'))).exactSumHolds).toBe(true);
  });
});

describe('D4 landSpeakers — one speaker, or none, is landVoice', () => {
  it('delegates a single span array to landVoice, which lands the WHOLE stem', () => {
    const source = addSourceDocument(2, 44100, 'My Song');
    const output = makeOutput(source);
    const result = landSpeakers(output, [SPEAKER_SPANS[0]]);

    expect(useAppStore.getState().documents.slice(1).map((d) => d.name)).toEqual([
      'My Song — Voice',
      'My Song — Backing',
    ]);
    expect(useSessionStore.getState().session.tracks.map((t) => t.name)).toEqual([
      'Voice',
      'Backing',
    ]);
    expect(result.sessionName).toBe(voiceSessionName('My Song'));
    // The Voice document is the stem itself — handed through by reference, NOT
    // masked to the one speaker's spans (D4: a confirmed count of 1 delegates).
    expect(docById(result.documentIds[0]).channels[0]).toBe(vocalsOf(output)[0]);
  });

  it('delegates zero span arrays to landVoice too — the D5 no-speakers case', () => {
    const source = addSourceDocument(2, 44100, 'My Song');
    const output = makeOutput(source);
    const result = landSpeakers(output, []);

    expect(useSessionStore.getState().session.tracks.map((t) => t.name)).toEqual([
      'Voice',
      'Backing',
    ]);
    expect(docById(result.documentIds[0]).channels[0]).toBe(vocalsOf(output)[0]);
  });
});

describe('D4 the speaker landing’s memory budget', () => {
  it('speakerTrackLabels names the speakers in order and puts Backing last', () => {
    expect(speakerTrackLabels(1)).toEqual(['Speaker 1', 'Backing']);
    expect(speakerTrackLabels(2)).toEqual(['Speaker 1', 'Speaker 2', 'Backing']);
    expect(speakerTrackLabels(3)).toEqual(['Speaker 1', 'Speaker 2', 'Speaker 3', 'Backing']);
    // The labels ARE the document suffixes, so the two can never disagree.
    const source = addSourceDocument(2, 44100, 'My Song');
    landSpeakers(makeOutput(source), SPEAKER_SPANS);
    expect(useAppStore.getState().documents.slice(1).map((d) => d.name)).toEqual(
      speakerTrackLabels(2).map((l) => `My Song — ${l}`)
    );
  });

  it('speakerDocumentBytes is the document’s own footprint: samples × channels × 4', () => {
    const stereo = addSourceDocument(2, 44100, 'Stereo');
    expect(speakerDocumentBytes(makeOutput(stereo))).toBe(FIXTURE_LENGTH * 2 * 4);

    // A MONO source lands DUAL-MONO (this module's header), so its documents
    // cost two channels too — the budget must count what is allocated, not the
    // source's channel count.
    const mono = addSourceDocument(1, 44100, 'Mono');
    expect(speakerDocumentBytes(makeOutput(mono))).toBe(FIXTURE_LENGTH * 2 * 4);
  });

  it('reproduces D4’s stated figure for a 15-minute 44.1 kHz stereo source', () => {
    const fifteenMinutes = {
      lengthSamples: 15 * 60 * 44100,
      channelCount: 2,
    } as StemSeparationOutput;
    const bytes = speakerDocumentBytes(fifteenMinutes);
    expect(bytes).toBe(317_520_000);
    // D4: "317,520,000 B, i.e. 317.5 MB each; 1.9 GB at N = 6" — and six of
    // them are over budget. 318 is that figure to the nearest whole MB.
    expect(Math.round(bytes / 1e6)).toBe(318);
    expect(Math.round((6 * bytes) / 1e8) / 10).toBe(1.9);
    expect(6 * bytes).toBeGreaterThan(SPEAKER_LANDING_BUDGET_BYTES);

    // …and what a landing COSTS is N + 1 of them, because `landSpeakers`
    // builds the Backing at the same full length (asserted below on the real
    // landing, not asserted here from arithmetic alone). At N = 6 that is
    // 2.2 GB, not 1.9; the boundary a 15-minute stereo source meets is N = 3,
    // where four documents pass 1.2 GB — while N = 2, three documents at
    // 952.6 MB, still fits. Priced at N alone, N = 3 would have looked like
    // 952.6 MB and landed 1.27 GB.
    expect(Math.round((7 * bytes) / 1e8) / 10).toBe(2.2);
    expect(4 * bytes).toBeGreaterThan(SPEAKER_LANDING_BUDGET_BYTES);
    expect(3 * bytes).toBeLessThan(SPEAKER_LANDING_BUDGET_BYTES);
  });

  it('a landing is N + 1 documents, which is what the budget has to price', () => {
    // The fact the dialog's gate rests on, pinned on the landing itself: three
    // speaker span arrays produce FOUR documents. `SPEAKER_SPANS` is the
    // module's two-speaker fixture, so this uses a three-speaker one to keep
    // the count off the fixture's own identity.
    const source = addSourceDocument(2, 44100);
    const output = makeOutput(source);
    const threeSpeakers = [
      [{ startSample: 0, endSample: 1_000 }],
      [{ startSample: 2_000, endSample: 3_000 }],
      [{ startSample: 4_000, endSample: 5_000 }],
    ];
    const result = landSpeakers(output, threeSpeakers);
    expect(result.documentIds).toHaveLength(threeSpeakers.length + 1);
    // ...and every one of them is FULL LENGTH, which is why they all cost
    // `speakerDocumentBytes` each — including the Backing, the last of them.
    for (const id of result.documentIds) {
      expect(docLength(docById(id))).toBe(FIXTURE_LENGTH);
    }
  });

  it('SPEAKER_LANDING_BUDGET_BYTES is the D4 constant, and lands nothing on its own', () => {
    expect(SPEAKER_LANDING_BUDGET_BYTES).toBe(1_200_000_000);
    // The budget is the DIALOG's gate (D4/D5): the landing itself never
    // truncates, drops a speaker, or refuses — a document over budget still
    // lands in full if a caller asks for it.
    const source = addSourceDocument(2, 44100);
    const output = makeOutput(source);
    const result = landSpeakers(output, SPEAKER_SPANS);
    expect(result.documentIds).toHaveLength(3);
    expect(docLength(docById(result.documentIds[0]))).toBe(FIXTURE_LENGTH);
  });
});

// ---------------------------------------------------------------------------
// D4 — the `exactSumHolds` contract, where a reader actually meets it
// ---------------------------------------------------------------------------
/**
 * `landSpeakers` returns `exactSumHolds: null` beside a fully determined
 * `sourcePeak` (the case pinned above). Until D4 that combination could not
 * occur: `createStemDocuments` derives the verdict as `sourcePeak === null ?
 * null : sourcePeak <= 1`, so `null` meant one thing only — "could not be
 * determined". The reader who has to know that meaning has changed is looking
 * at the FIELD, not at `landSpeakers`' docblock, which is why this is asserted
 * on the declarations themselves: a `null` documented as "unknown" and returned
 * as "no claim" is how a caller ends up printing a clamp warning, or nothing at
 * all, for the wrong reason.
 */
describe('D4 exactSumHolds — the field documents BOTH meanings of null', () => {
  const source = readFileSync(join(__dirname, 'stemLanding.ts'), 'utf8');

  it('says so on every declaration of the field, not only in landSpeakers’ own doc', () => {
    const blocks = [
      ...source.matchAll(/\/\*\*((?:(?!\*\/)[\s\S])*)\*\/\s*exactSumHolds: boolean \| null;/g),
    ];
    // Both result shapes carry it: the documents half and the full landing.
    expect(blocks).toHaveLength(2);
    for (const [, body] of blocks) {
      const text = body.replace(/^[ \t]*\*[ \t]?/gm, '').replace(/\s+/g, ' ');
      expect(text).toContain('could not be determined');
      // …and the second meaning, named with the function that returns it.
      expect(text).toContain('landSpeakers');
      expect(text).toMatch(/no exact-sum claim|makes no claim/i);
    }
  });

  it('is the behaviour the docs now describe: null WITH a measured source peak', () => {
    const output = makeOutput(addSourceDocument(2, 44100));
    const speakers = landSpeakers(output, SPEAKER_SPANS);
    expect([speakers.exactSumHolds, speakers.sourcePeak === null]).toEqual([null, false]);

    // The other half of the contract still holds — a landing that IS a
    // partition answers the question — so the doc's first meaning is not
    // rewritten by the second.
    const voice = landVoice(makeOutput(addSourceDocument(2, 44100, 'Other')));
    expect([voice.exactSumHolds, voice.sourcePeak === null]).toEqual([true, false]);
  });
});
