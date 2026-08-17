import { createClip, createTrack } from './session';

describe('createTrack', () => {
  it('creates an empty track with default params and a track-N id', () => {
    const track = createTrack('Lead');
    expect(track.id).toMatch(/^track-\d+$/);
    expect(track.name).toBe('Lead');
    expect(track.volumeDb).toBe(0);
    expect(track.pan).toBe(0);
    expect(track.muted).toBe(false);
    expect(track.solo).toBe(false);
    expect(track.armed).toBe(false);
    expect(track.clips).toEqual([]);
  });

  it('assigns sequentially increasing ids across calls', () => {
    const a = createTrack('A');
    const b = createTrack('B');
    const na = Number(a.id.split('-')[1]);
    const nb = Number(b.id.split('-')[1]);
    expect(nb).toBe(na + 1);
  });
});

describe('createClip', () => {
  it('creates a clip with the given geometry and a clip-N id', () => {
    const clip = createClip({ documentId: 'doc-1', startSample: 100, offsetSample: 10, lengthSample: 500 });
    expect(clip.id).toMatch(/^clip-\d+$/);
    expect(clip.documentId).toBe('doc-1');
    expect(clip.startSample).toBe(100);
    expect(clip.offsetSample).toBe(10);
    expect(clip.lengthSample).toBe(500);
    expect(clip.gainDb).toBe(0);
  });

  it('honors an explicit gainDb', () => {
    const clip = createClip({
      documentId: 'doc-1',
      startSample: 0,
      offsetSample: 0,
      lengthSample: 100,
      gainDb: -6,
    });
    expect(clip.gainDb).toBe(-6);
  });

  it('assigns sequentially increasing ids across calls', () => {
    const a = createClip({ documentId: 'doc-1', startSample: 0, offsetSample: 0, lengthSample: 10 });
    const b = createClip({ documentId: 'doc-1', startSample: 10, offsetSample: 0, lengthSample: 10 });
    const na = Number(a.id.split('-')[1]);
    const nb = Number(b.id.split('-')[1]);
    expect(nb).toBe(na + 1);
  });
});
