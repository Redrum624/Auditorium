import { nextId } from '../audio/AudioDocument';

export interface Clip {
  id: string; // 'clip-N'
  documentId: string; // source AudioDocument id
  startSample: number; // position on session timeline (in session sampleRate)
  offsetSample: number; // start offset into the source document
  lengthSample: number; // number of samples taken from the source document
  gainDb: number;
}

export interface Track {
  id: string; // 'track-N'
  name: string;
  volumeDb: number; // -60..+12, default 0
  pan: number; // -1 (L) .. 1 (R), default 0
  muted: boolean;
  solo: boolean;
  armed: boolean;
  clips: Clip[]; // sorted by startSample; MAY overlap — see the overlap contract on sessionStore's addClip
}

export interface Session {
  name: string;
  sampleRate: number;
  tracks: Track[];
}

/** Creates a fresh, empty track with default params (`volumeDb: 0, pan: 0`,
 * all flags false) and a sequential 'track-N' id. */
export function createTrack(name: string): Track {
  return {
    id: nextId('track'),
    name,
    volumeDb: 0,
    pan: 0,
    muted: false,
    solo: false,
    armed: false,
    clips: [],
  };
}

/** Creates a clip referencing a region of a source AudioDocument, with a
 * sequential 'clip-N' id. `gainDb` defaults to 0 when omitted. */
export function createClip(opts: {
  documentId: string;
  startSample: number;
  offsetSample: number;
  lengthSample: number;
  gainDb?: number;
}): Clip {
  return {
    id: nextId('clip'),
    documentId: opts.documentId,
    startSample: opts.startSample,
    offsetSample: opts.offsetSample,
    lengthSample: opts.lengthSample,
    gainDb: opts.gainDb ?? 0,
  };
}
