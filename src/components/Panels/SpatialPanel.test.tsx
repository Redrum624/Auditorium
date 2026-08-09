import { act, fireEvent, render } from '@testing-library/react';
import SpatialPanel from './SpatialPanel';
import { useSessionStore } from '../../multitrack/sessionStore';

/**
 * F5 — the spatial positioner panel. Pointer geometry: jsdom's
 * getBoundingClientRect is all zeros, so `positionFor` falls back to scale 1
 * and clientX/Y map 1:1 to viewBox units (300×300, centre 150/150, stage
 * radius 132 = distance 10). Front = up: (150, 150−r) is dead ahead.
 */

function firePointer(
  element: Element,
  type: 'pointerdown' | 'pointermove' | 'pointerup',
  init: { clientX: number; clientY: number; button?: number }
): void {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: init.clientX,
    clientY: init.clientY,
    button: init.button ?? 0,
  });
  Object.defineProperty(event, 'pointerId', { value: 1 });
  act(() => {
    element.dispatchEvent(event);
  });
}

function track0() {
  return useSessionStore.getState().session.tracks[0];
}

beforeEach(() => {
  useSessionStore.getState().newSession(44100);
});

describe('honest naming and the neutral position', () => {
  it('states the projection (not binaural) and shows the neutral source with no lanes', () => {
    const { getByTestId, getByText } = render(<SpatialPanel />);
    expect(getByText(/not binaural/)).toBeTruthy();

    // Neutral: azimuth 0, distance 1 (reference) → r = 13.2 px, straight up.
    const dot = getByTestId('spatial-source');
    expect(parseFloat(dot.getAttribute('cx') ?? '')).toBeCloseTo(150, 5);
    expect(parseFloat(dot.getAttribute('cy') ?? '')).toBeCloseTo(150 - 13.2, 5);
    // The projected stereo consequence: centre at unity.
    expect(getByTestId('spatial-readout').textContent).toContain('C');
    expect(getByTestId('spatial-readout').textContent).toContain('0.0 dB');
  });
});

describe('the stage drag (ruling D: preview on move, ONE commit on up)', () => {
  it('previews without writing, then commits azimuth AND distance in one store write at the cursor', () => {
    act(() => {
      useSessionStore.getState().setMtCursor(20_000);
    });
    const { getByTestId } = render(<SpatialPanel />);
    const stage = getByTestId('spatial-stage');

    let writes = 0;
    const unsub = useSessionStore.subscribe(() => {
      writes++;
    });

    // Down at hard right, half the stage out: dx = 66/132 = 0.5 → az 90,
    // distance 5. Preview only — nothing lands in the store.
    firePointer(stage, 'pointerdown', { clientX: 216, clientY: 150 });
    expect(track0().automation).toBeUndefined();
    expect(writes).toBe(0);

    // Drag to directly BEHIND at the same radius: az 180 — the dot previews.
    firePointer(stage, 'pointermove', { clientX: 150, clientY: 216 });
    expect(track0().automation).toBeUndefined();
    const dot = getByTestId('spatial-source');
    expect(parseFloat(dot.getAttribute('cx') ?? '')).toBeCloseTo(150, 3);
    expect(parseFloat(dot.getAttribute('cy') ?? '')).toBeCloseTo(216, 3);

    // Release: ONE tracks-array write carrying BOTH keys, at the cursor.
    firePointer(stage, 'pointerup', { clientX: 150, clientY: 216 });
    expect(writes).toBe(1);
    expect(track0().automation).toEqual([
      { param: 'azimuth', keys: [{ positionSample: 20_000, value: 180 }] },
      { param: 'distance', keys: [{ positionSample: 20_000, value: 5 }] },
    ]);
    unsub();
  });
});

describe('keyframe awareness (the dot follows the lanes at the playhead)', () => {
  it('evaluates the azimuth lane at the cursor with the circular evaluator', () => {
    const id = track0().id;
    act(() => {
      const s = useSessionStore.getState();
      s.upsertAutomationKey(id, 'azimuth', { positionSample: 0, value: 0 });
      s.upsertAutomationKey(id, 'azimuth', { positionSample: 1000, value: 90 });
      s.setMtCursor(500);
    });
    const { getByTestId } = render(<SpatialPanel />);
    // az(500) = 45°, distance neutral 1 → r 13.2: x = 150 + sin45·13.2.
    const dot = getByTestId('spatial-source');
    expect(parseFloat(dot.getAttribute('cx') ?? '')).toBeCloseTo(150 + Math.SQRT1_2 * 13.2, 3);
    expect(parseFloat(dot.getAttribute('cy') ?? '')).toBeCloseTo(150 - Math.SQRT1_2 * 13.2, 3);
  });
});

describe('the elevation slider', () => {
  it('a pending elevation preview rides the stage commit — nothing shown is discarded', () => {
    act(() => {
      useSessionStore.getState().setMtCursor(8_000);
    });
    const { getByTestId } = render(<SpatialPanel />);
    // Adjust elevation WITHOUT releasing, then drag the stage and release:
    fireEvent.change(getByTestId('spatial-elevation'), { target: { value: '45' } });
    expect(track0().automation).toBeUndefined();

    let writes = 0;
    const unsub = useSessionStore.subscribe(() => {
      writes++;
    });
    const stage = getByTestId('spatial-stage');
    firePointer(stage, 'pointerdown', { clientX: 216, clientY: 150 });
    firePointer(stage, 'pointerup', { clientX: 216, clientY: 150 });
    unsub();

    // ONE write carrying all three lanes — the previewed elevation included.
    expect(writes).toBe(1);
    expect(track0().automation).toEqual([
      { param: 'azimuth', keys: [{ positionSample: 8_000, value: 90 }] },
      { param: 'distance', keys: [{ positionSample: 8_000, value: 5 }] },
      { param: 'elevation', keys: [{ positionSample: 8_000, value: 45 }] },
    ]);
  });

  it('previews on change (no write) and commits ONE elevation key on release', () => {
    act(() => {
      useSessionStore.getState().setMtCursor(4_000);
    });
    const { getByTestId } = render(<SpatialPanel />);
    const slider = getByTestId('spatial-elevation');

    fireEvent.change(slider, { target: { value: '30' } });
    expect(track0().automation).toBeUndefined(); // preview only

    firePointer(slider, 'pointerup', { clientX: 0, clientY: 0 });
    expect(track0().automation).toEqual([
      { param: 'elevation', keys: [{ positionSample: 4_000, value: 30 }] },
    ]);
  });
});

describe('what is SHOWN during a drag is what lands (frozen preview during playback)', () => {
  it('an XY drag over a MOVING elevation lane commits the drag-start (displayed) elevation', () => {
    // Elevation lane moving 0 → 90 over [0, 1000]. The stage drag freezes the
    // whole shown position at pointerdown; when the playhead advances during
    // the drag, pointerup writes the FROZEN elevation the panel displayed —
    // not the value the lane reached meanwhile. Deliberate (review round 2):
    // the dot and readouts are a promise about what will land.
    const id = track0().id;
    act(() => {
      const s = useSessionStore.getState();
      s.upsertAutomationKey(id, 'elevation', { positionSample: 0, value: 0 });
      s.upsertAutomationKey(id, 'elevation', { positionSample: 1000, value: 90 });
      s.setMtPlayState('playing');
      s.setMtPlayheadSample(0);
    });
    const { getByTestId } = render(<SpatialPanel />);
    const stage = getByTestId('spatial-stage');

    firePointer(stage, 'pointerdown', { clientX: 216, clientY: 150 }); // el frozen at 0
    act(() => {
      useSessionStore.getState().setMtPlayheadSample(500); // lane now reads 45
    });
    firePointer(stage, 'pointerup', { clientX: 216, clientY: 150 });

    expect(track0().automation).toEqual([
      {
        param: 'elevation',
        keys: [
          { positionSample: 0, value: 0 },
          { positionSample: 500, value: 0 }, // the frozen, DISPLAYED value
          { positionSample: 1000, value: 90 },
        ],
      },
      { param: 'azimuth', keys: [{ positionSample: 500, value: 90 }] },
      { param: 'distance', keys: [{ positionSample: 500, value: 5 }] },
    ]);
  });
});

describe('lane toggles and the track selector', () => {
  it('opens the azimuth envelope lane for the governed track', () => {
    const { getByTestId } = render(<SpatialPanel />);
    fireEvent.click(getByTestId('spatial-lane-toggle-azimuth'));
    expect(useSessionStore.getState().mtEnvelope).toEqual({
      trackId: track0().id,
      param: 'azimuth',
    });
    fireEvent.click(getByTestId('spatial-lane-toggle-azimuth'));
    expect(useSessionStore.getState().mtEnvelope).toBeNull();
  });

  it('switching track routes the commit to the chosen track', () => {
    const t2 = useSessionStore.getState().session.tracks[1];
    const { getByTestId } = render(<SpatialPanel />);
    fireEvent.change(getByTestId('spatial-track-select'), { target: { value: t2.id } });

    const stage = getByTestId('spatial-stage');
    firePointer(stage, 'pointerdown', { clientX: 216, clientY: 150 });
    firePointer(stage, 'pointerup', { clientX: 216, clientY: 150 });

    expect(track0().automation).toBeUndefined();
    const written = useSessionStore.getState().session.tracks[1].automation;
    expect(written).toEqual([
      { param: 'azimuth', keys: [{ positionSample: 0, value: 90 }] },
      { param: 'distance', keys: [{ positionSample: 0, value: 5 }] },
    ]);
  });
});
