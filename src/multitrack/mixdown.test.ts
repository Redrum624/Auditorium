import { createDocument, type AudioDocument } from '../audio/AudioDocument';
import type { Clip, Session, Track } from './session';
import { mixdownSession } from './mixdown';

// ---------------------------------------------------------------------------
// Test builders. Sessions are constructed as plain objects (mixdownSession is
// pure and never touches the store), so ids are arbitrary literals here.
// ---------------------------------------------------------------------------

let clipSeq = 0;
let trackSeq = 0;

function clip(partial: Partial<Clip> & { documentId: string }): Clip {
  return {
    id: `clip-${++clipSeq}`,
    startSample: 0,
    offsetSample: 0,
    lengthSample: 0,
    gainDb: 0,
    ...partial,
  };
}

function track(partial: Partial<Track> = {}): Track {
  return {
    id: `track-${++trackSeq}`,
    name: 'T',
    volumeDb: 0,
    pan: 0,
    muted: false,
    solo: false,
    armed: false,
    clips: [],
    ...partial,
  };
}

function session(tracks: Track[], sampleRate = 44100): Session {
  return { name: 'S', sampleRate, tracks };
}

function monoDoc(id: string, data: number[] | Float32Array, sampleRate = 44100): AudioDocument {
  const ch = data instanceof Float32Array ? data : Float32Array.from(data);
  const doc = createDocument({ name: id, sampleRate, channels: [ch] });
  return { ...doc, id };
}

function stereoDoc(
  id: string,
  left: number[],
  right: number[],
  sampleRate = 44100
): AudioDocument {
  const doc = createDocument({
    name: id,
    sampleRate,
    channels: [Float32Array.from(left), Float32Array.from(right)],
  });
  return { ...doc, id };
}

function docsMap(...docs: AudioDocument[]): Map<string, AudioDocument> {
  return new Map(docs.map((d) => [d.id, d]));
}

const CP = Math.cos(Math.PI / 4); // constant-power center gain ≈ 0.70710678

describe('mixdownSession', () => {
  it('sums overlapping clips sample-accurately (constant-power center pan)', () => {
    // Mono ramp doc: value[i] = i / 1000.
    const ramp = Array.from({ length: 1000 }, (_, i) => i / 1000);
    const doc = monoDoc('doc-1', ramp);
    const s = session([
      track({ clips: [clip({ documentId: 'doc-1', startSample: 0, lengthSample: 1000 })] }),
      track({ clips: [clip({ documentId: 'doc-1', startSample: 500, lengthSample: 1000 })] }),
    ]);

    const { channels, sampleRate } = mixdownSession(s, docsMap(doc));
    const [L, R] = channels;

    expect(sampleRate).toBe(44100);
    expect(L.length).toBe(1500); // max clip end = 500 + 1000

    // s=200 (only clip A): doc[200] * CP.
    expect(L[200]).toBeCloseTo((200 / 1000) * CP, 6);
    // s=600 (overlap): (doc[600] + doc[100]) * CP.
    expect(L[600]).toBeCloseTo((600 / 1000 + 100 / 1000) * CP, 6);
    // s=1200 (only clip B, reads doc[700]): doc[700] * CP.
    expect(L[1200]).toBeCloseTo((700 / 1000) * CP, 6);
    // Left and right identical at center pan.
    expect(R[600]).toBeCloseTo(L[600], 6);
  });

  it('applies constant-power pan law to a mono source', () => {
    const doc = monoDoc('doc-1', new Float32Array(100).fill(0.5));
    const at = (pan: number) =>
      mixdownSession(
        session([track({ pan, clips: [clip({ documentId: 'doc-1', lengthSample: 100 })] })]),
        docsMap(doc)
      ).channels;

    const center = at(0);
    expect(center[0][0]).toBeCloseTo(0.5 * CP, 6);
    expect(center[1][0]).toBeCloseTo(0.5 * CP, 6);

    const left = at(-1);
    expect(left[0][0]).toBeCloseTo(0.5, 6); // gL = cos(0) = 1
    expect(left[1][0]).toBeCloseTo(0, 6); // gR = sin(0) = 0

    const right = at(1);
    expect(right[0][0]).toBeCloseTo(0, 6); // gL = cos(pi/2) = 0
    expect(right[1][0]).toBeCloseTo(0.5, 6); // gR = sin(pi/2) = 1
  });

  it('applies balance pan law to a stereo source (unity at center)', () => {
    const doc = stereoDoc('doc-1', new Array(100).fill(0.4), new Array(100).fill(0.8));
    const at = (pan: number) =>
      mixdownSession(
        session([track({ pan, clips: [clip({ documentId: 'doc-1', lengthSample: 100 })] })]),
        docsMap(doc)
      ).channels;

    const center = at(0);
    expect(center[0][0]).toBeCloseTo(0.4, 6); // gL = 1
    expect(center[1][0]).toBeCloseTo(0.8, 6); // gR = 1

    const right = at(1);
    expect(right[0][0]).toBeCloseTo(0, 6); // gL = cos(pi/2) = 0
    expect(right[1][0]).toBeCloseTo(0.8, 6); // gR = 1

    const left = at(-1);
    expect(left[0][0]).toBeCloseTo(0.4, 6); // gL = 1
    expect(left[1][0]).toBeCloseTo(0, 6); // gR = cos(pi/2) = 0
  });

  it('silences muted tracks and excludes them from the length', () => {
    const a = monoDoc('doc-a', new Float32Array(100).fill(0.5));
    const b = monoDoc('doc-b', new Float32Array(200).fill(0.9));
    const s = session([
      track({ pan: -1, clips: [clip({ documentId: 'doc-a', lengthSample: 100 })] }),
      track({ muted: true, pan: -1, clips: [clip({ documentId: 'doc-b', lengthSample: 200 })] }),
    ]);

    const { channels } = mixdownSession(s, docsMap(a, b));
    // Length only over the audible track (100), not the muted one (200).
    expect(channels[0].length).toBe(100);
    // Track A alone (pan -1 => gL 1): 0.5; muted B contributes nothing.
    expect(channels[0][0]).toBeCloseTo(0.5, 6);
  });

  it('solos: a soloed track silences non-soloed tracks; mute still wins on a soloed track', () => {
    const a = monoDoc('doc-a', new Float32Array(100).fill(0.5));
    const b = monoDoc('doc-b', new Float32Array(100).fill(0.9));

    const soloed = session([
      track({ solo: true, pan: -1, clips: [clip({ documentId: 'doc-a', lengthSample: 100 })] }),
      track({ pan: -1, clips: [clip({ documentId: 'doc-b', lengthSample: 100 })] }),
    ]);
    const out = mixdownSession(soloed, docsMap(a, b)).channels;
    expect(out[0][0]).toBeCloseTo(0.5, 6); // only the soloed track

    // Soloed AND muted => silent (mute wins).
    const both = session([
      track({ solo: true, muted: true, pan: -1, clips: [clip({ documentId: 'doc-a', lengthSample: 100 })] }),
    ]);
    const empty = mixdownSession(both, docsMap(a)).channels;
    expect(empty[0].length).toBe(0);
  });

  it('applies clip gain and track volume as linear multipliers', () => {
    const doc = monoDoc('doc-1', new Float32Array(100).fill(0.8));
    const clipGain = mixdownSession(
      session([track({ pan: -1, clips: [clip({ documentId: 'doc-1', lengthSample: 100, gainDb: -6 })] })]),
      docsMap(doc)
    ).channels;
    expect(clipGain[0][0]).toBeCloseTo(0.8 * Math.pow(10, -6 / 20), 5);

    const trackVol = mixdownSession(
      session([
        track({ pan: -1, volumeDb: -6, clips: [clip({ documentId: 'doc-1', lengthSample: 100 })] }),
      ]),
      docsMap(doc)
    ).channels;
    expect(trackVol[0][0]).toBeCloseTo(0.8 * Math.pow(10, -6 / 20), 5);

    // Combined: clip -6 dB AND track -6 dB multiply.
    const combined = mixdownSession(
      session([
        track({ pan: -1, volumeDb: -6, clips: [clip({ documentId: 'doc-1', lengthSample: 100, gainDb: -6 })] }),
      ]),
      docsMap(doc)
    ).channels;
    expect(combined[0][0]).toBeCloseTo(0.8 * Math.pow(10, -6 / 20) * Math.pow(10, -6 / 20), 5);
  });

  it('resamples a clip whose document rate differs from the session rate', () => {
    // 500-sample constant 0.5 doc at 22050; a 1000-sample (session-rate) clip.
    const doc = monoDoc('doc-1', new Float32Array(500).fill(0.5), 22050);
    const s = session(
      [track({ clips: [clip({ documentId: 'doc-1', offsetSample: 0, lengthSample: 1000 })] })],
      44100
    );

    const { channels } = mixdownSession(s, docsMap(doc));
    // 500 source samples resample to 1000 session samples (length doubles).
    expect(channels[0].length).toBe(1000);
    // A constant stays constant through the (DC-normalized) resampler; center pan.
    expect(channels[0][500]).toBeCloseTo(0.5 * CP, 4);
    expect(channels[1][500]).toBeCloseTo(0.5 * CP, 4);
  });

  it('hard-clamps the master bus to +/-1', () => {
    const doc = monoDoc('doc-1', new Float32Array(100).fill(1.0));
    const s = session([
      track({ pan: -1, clips: [clip({ documentId: 'doc-1', lengthSample: 100 })] }),
      track({ pan: -1, clips: [clip({ documentId: 'doc-1', lengthSample: 100 })] }),
    ]);

    const { channels } = mixdownSession(s, docsMap(doc));
    // Two full-scale left-panned mono clips sum to 2.0 -> clamped to 1.0.
    expect(channels[0][0]).toBe(1);
    // Right stays 0 (pan -1 => gR 0).
    expect(channels[1][0]).toBe(0);
  });

  it('returns two empty channels for an empty (or all-muted) session', () => {
    const emptySession = session([track(), track()], 48000);
    const empty = mixdownSession(emptySession, docsMap());
    expect(empty.sampleRate).toBe(48000);
    expect(empty.channels[0].length).toBe(0);
    expect(empty.channels[1].length).toBe(0);

    const doc = monoDoc('doc-1', new Float32Array(100).fill(0.5));
    const allMuted = session([
      track({ muted: true, clips: [clip({ documentId: 'doc-1', lengthSample: 100 })] }),
    ]);
    const out = mixdownSession(allMuted, docsMap(doc));
    expect(out.channels[0].length).toBe(0);
  });

  it('reports progress ending at 1', () => {
    const doc = monoDoc('doc-1', new Float32Array(100).fill(0.5));
    const s = session([
      track({ clips: [clip({ documentId: 'doc-1', lengthSample: 100 })] }),
      track({ clips: [clip({ documentId: 'doc-1', startSample: 100, lengthSample: 100 })] }),
    ]);
    const seen: number[] = [];
    mixdownSession(s, docsMap(doc), (f) => seen.push(f));
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[seen.length - 1]).toBe(1);
  });
});
