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
import { createDocument, docLength, type AudioDocument } from '../audio/AudioDocument';
import { partitionStems } from '../dsp/stemPartition';
import { mixdownSession } from '../multitrack/mixdown';
import { createClip, createTrack } from '../multitrack/session';
import { useSessionStore } from '../multitrack/sessionStore';
import { defaultSessionZoom, sessionEndSample } from '../multitrack/sessionZoom';
import { FALLBACK_SESSION_LANE_WIDTH, _resetSessionLaneWidth } from '../multitrack/sessionViewport';
import { useAppStore, makeInitialState } from '../stores/appStore';
import { STEM_LABELS, type StemSeparationOutput } from './stemService';
import {
  buildStemSession,
  createStemDocuments,
  landStems,
  stemSessionName,
  MONO_PAN_COMPENSATION_DB,
  STEM_TRACK_LABELS,
} from './stemLanding';
import { clearBeatGridLinks, _getBeatGridLinkForTest } from './beatGrid';

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
