import { createTrack } from './session';
import { useSessionStore } from './sessionStore';

// ---------------------------------------------------------------------------
// F0 — the automation write boundary (upsert / remove / setCurve).
// The load-bearing assertions are the ABSENCE ones (traps T9/T11): a track
// that never touched automation has NO `automation` property at all, and a
// track whose last key is removed loses the property again — `'automation' in
// track` must be false, not merely `undefined`-valued, because the on-disk
// byte-identity pin cannot tell the difference but a future `Object.keys`
// consumer can.
// ---------------------------------------------------------------------------

function track(i = 0) {
  return useSessionStore.getState().session.tracks[i];
}

describe('automation store actions', () => {
  beforeEach(() => {
    useSessionStore.getState().newSession(44100);
  });

  it('createTrack and newSession produce tracks WITHOUT an automation property (absent means none)', () => {
    expect('automation' in createTrack('T')).toBe(false);
    for (const t of useSessionStore.getState().session.tracks) {
      expect('automation' in t).toBe(false);
    }
  });

  describe('upsertAutomationKey', () => {
    it('first key creates the lane and the field; keys land rounded, clamped and ascending', () => {
      const id = track().id;
      const s = useSessionStore.getState();
      s.upsertAutomationKey(id, 'volumeDb', { positionSample: 500.4, value: -6 });
      s.upsertAutomationKey(id, 'volumeDb', { positionSample: 100, value: 99 }); // value above +12
      s.upsertAutomationKey(id, 'volumeDb', { positionSample: -25, value: -600 }); // pos < 0, value < -60

      expect(track().automation).toEqual([
        {
          param: 'volumeDb',
          keys: [
            { positionSample: 0, value: -60 },
            { positionSample: 100, value: 12 },
            { positionSample: 500, value: -6 },
          ],
        },
      ]);
    });

    it('two params get two lanes on the same track', () => {
      const id = track().id;
      const s = useSessionStore.getState();
      s.upsertAutomationKey(id, 'volumeDb', { positionSample: 0, value: -3 });
      s.upsertAutomationKey(id, 'pan', { positionSample: 10, value: 0.5 });

      const lanes = track().automation;
      expect(lanes).toHaveLength(2);
      expect(lanes?.[0].param).toBe('volumeDb');
      expect(lanes?.[1].param).toBe('pan');
    });

    it('landing on an occupied position replaces that key (positions stay unique)', () => {
      const id = track().id;
      const s = useSessionStore.getState();
      s.upsertAutomationKey(id, 'volumeDb', { positionSample: 200, value: -6, curve: 'smooth' });
      s.upsertAutomationKey(id, 'volumeDb', { positionSample: 200, value: 3 });

      expect(track().automation?.[0].keys).toEqual([{ positionSample: 200, value: 3 }]);
    });

    it('a MOVE (replacePositionSample) relocates the key in ONE write and carries its curve', () => {
      const id = track().id;
      const s = useSessionStore.getState();
      s.upsertAutomationKey(id, 'volumeDb', { positionSample: 200, value: -6, curve: 'exponential' });
      s.upsertAutomationKey(id, 'volumeDb', { positionSample: 800, value: 6 });

      s.upsertAutomationKey(id, 'volumeDb', { positionSample: 400, value: -2 }, 200);

      expect(track().automation?.[0].keys).toEqual([
        { positionSample: 400, value: -2, curve: 'exponential' },
        { positionSample: 800, value: 6 },
      ]);
    });

    it('a MOVE dragged past a neighbour re-establishes ascending order (trap T16)', () => {
      const id = track().id;
      const s = useSessionStore.getState();
      s.upsertAutomationKey(id, 'volumeDb', { positionSample: 100, value: 1 });
      s.upsertAutomationKey(id, 'volumeDb', { positionSample: 500, value: 5 });

      s.upsertAutomationKey(id, 'volumeDb', { positionSample: 900, value: 1 }, 100);

      expect(track().automation?.[0].keys.map((k) => k.positionSample)).toEqual([500, 900]);
    });

    it('a MOVE landing on another key\'s position swallows it (no duplicate positions)', () => {
      const id = track().id;
      const s = useSessionStore.getState();
      s.upsertAutomationKey(id, 'volumeDb', { positionSample: 100, value: 1 });
      s.upsertAutomationKey(id, 'volumeDb', { positionSample: 500, value: 5 });

      s.upsertAutomationKey(id, 'volumeDb', { positionSample: 500, value: -1 }, 100);

      expect(track().automation?.[0].keys).toEqual([{ positionSample: 500, value: -1 }]);
    });

    it('an explicit valid curve wins over the moved key\'s curve; an unknown curve is dropped', () => {
      const id = track().id;
      const s = useSessionStore.getState();
      s.upsertAutomationKey(id, 'volumeDb', { positionSample: 0, value: 0, curve: 'smooth' });
      s.upsertAutomationKey(id, 'volumeDb', { positionSample: 50, value: 1, curve: 'equal-power' }, 0);
      expect(track().automation?.[0].keys[0].curve).toBe('equal-power');

      s.upsertAutomationKey(
        id,
        'pan',
        { positionSample: 0, value: 0, curve: 'bezier' as unknown as 'smooth' }
      );
      expect('curve' in (track().automation?.[1].keys[0] ?? {})).toBe(false);
    });

    it('non-finite position or value is a no-op (ignored, not clamped)', () => {
      const id = track().id;
      const before = track();
      const s = useSessionStore.getState();
      s.upsertAutomationKey(id, 'volumeDb', { positionSample: NaN, value: 0 });
      s.upsertAutomationKey(id, 'volumeDb', { positionSample: 0, value: Infinity });
      s.upsertAutomationKey(id, 'volumeDb', { positionSample: -Infinity, value: 0 });
      expect(track()).toBe(before); // not even a new track object
    });

    it('unknown track id is a no-op', () => {
      const before = useSessionStore.getState().session;
      useSessionStore.getState().upsertAutomationKey('track-nope', 'volumeDb', { positionSample: 0, value: 0 });
      expect(useSessionStore.getState().session).toBe(before);
    });

    it('every write produces fresh track/lanes/keys arrays and leaves other tracks untouched', () => {
      const s = useSessionStore.getState();
      const id = track(0).id;
      s.upsertAutomationKey(id, 'volumeDb', { positionSample: 0, value: -3 });
      const t0a = track(0);
      const t1a = track(1);
      const lanesA = t0a.automation;

      s.upsertAutomationKey(id, 'volumeDb', { positionSample: 100, value: 3 });
      const t0b = track(0);

      expect(t0b).not.toBe(t0a);
      expect(t0b.automation).not.toBe(lanesA);
      expect(t0b.automation?.[0].keys).not.toBe(lanesA?.[0].keys);
      expect(track(1)).toBe(t1a); // untouched sibling keeps its identity
    });
  });

  describe('removeAutomationKey', () => {
    it('removes exactly the key at the position; other keys and the lane survive', () => {
      const id = track().id;
      const s = useSessionStore.getState();
      s.upsertAutomationKey(id, 'volumeDb', { positionSample: 100, value: 1 });
      s.upsertAutomationKey(id, 'volumeDb', { positionSample: 200, value: 2 });

      s.removeAutomationKey(id, 'volumeDb', 100);

      expect(track().automation?.[0].keys).toEqual([{ positionSample: 200, value: 2 }]);
    });

    it('an emptied lane is removed; the OTHER param\'s lane survives', () => {
      const id = track().id;
      const s = useSessionStore.getState();
      s.upsertAutomationKey(id, 'volumeDb', { positionSample: 100, value: 1 });
      s.upsertAutomationKey(id, 'pan', { positionSample: 100, value: 0.5 });

      s.removeAutomationKey(id, 'volumeDb', 100);

      expect(track().automation).toEqual([
        { param: 'pan', keys: [{ positionSample: 100, value: 0.5 }] },
      ]);
    });

    it('removing the last key of the last lane strips the automation property entirely (T9)', () => {
      const id = track().id;
      const s = useSessionStore.getState();
      s.upsertAutomationKey(id, 'volumeDb', { positionSample: 100, value: 1 });
      expect('automation' in track()).toBe(true);

      s.removeAutomationKey(id, 'volumeDb', 100);

      expect('automation' in track()).toBe(false);
    });

    it('no-ops: unknown track, absent lane, wrong param, position with no key, non-finite position', () => {
      const id = track().id;
      const s = useSessionStore.getState();
      s.upsertAutomationKey(id, 'volumeDb', { positionSample: 100, value: 1 });
      const before = useSessionStore.getState().session;

      s.removeAutomationKey('track-nope', 'volumeDb', 100);
      s.removeAutomationKey(id, 'pan', 100);
      s.removeAutomationKey(id, 'volumeDb', 101);
      s.removeAutomationKey(id, 'volumeDb', NaN);

      expect(useSessionStore.getState().session).toBe(before);
    });
  });

  describe('setAutomationKeyCurve', () => {
    it('sets the segment curve of the key at the position (fresh arrays)', () => {
      const id = track().id;
      const s = useSessionStore.getState();
      s.upsertAutomationKey(id, 'volumeDb', { positionSample: 100, value: 1 });
      s.upsertAutomationKey(id, 'volumeDb', { positionSample: 200, value: 2 });
      const before = track();

      s.setAutomationKeyCurve(id, 'volumeDb', 100, 'smooth');

      expect(track()).not.toBe(before);
      expect(track().automation?.[0].keys).toEqual([
        { positionSample: 100, value: 1, curve: 'smooth' },
        { positionSample: 200, value: 2 },
      ]);
    });

    it('no-ops: invalid curve, unknown track/param/position', () => {
      const id = track().id;
      const s = useSessionStore.getState();
      s.upsertAutomationKey(id, 'volumeDb', { positionSample: 100, value: 1 });
      const before = useSessionStore.getState().session;

      s.setAutomationKeyCurve(id, 'volumeDb', 100, 'bezier' as unknown as 'smooth');
      s.setAutomationKeyCurve('track-nope', 'volumeDb', 100, 'smooth');
      s.setAutomationKeyCurve(id, 'pan', 100, 'smooth');
      s.setAutomationKeyCurve(id, 'volumeDb', 999, 'smooth');

      expect(useSessionStore.getState().session).toBe(before);
    });
  });
});

describe('F5 — the write boundary accepts the spatial params with their own ranges', () => {
  beforeEach(() => {
    useSessionStore.getState().newSession(44100);
  });

  it('azimuth/elevation/distance keys land clamped to the spatial ranges (shared arithmetic)', () => {
    const id = track().id;
    const s = useSessionStore.getState();
    s.upsertAutomationKey(id, 'azimuth', { positionSample: 0, value: 240 }); // clamps to 180
    s.upsertAutomationKey(id, 'elevation', { positionSample: 10, value: -95 }); // clamps to -90
    s.upsertAutomationKey(id, 'distance', { positionSample: 20, value: 12 }); // clamps to 10
    expect(track().automation).toEqual([
      { param: 'azimuth', keys: [{ positionSample: 0, value: 180 }] },
      { param: 'elevation', keys: [{ positionSample: 10, value: -90 }] },
      { param: 'distance', keys: [{ positionSample: 20, value: 10 }] },
    ]);
  });

  it('removing the last spatial key strips the lane, and the field when it was the only lane', () => {
    const id = track().id;
    const s = useSessionStore.getState();
    s.upsertAutomationKey(id, 'azimuth', { positionSample: 100, value: 90 });
    expect(track().automation).toHaveLength(1);
    s.removeAutomationKey(id, 'azimuth', 100);
    expect('automation' in track()).toBe(false); // absent means none (T9/T11)
  });
});
