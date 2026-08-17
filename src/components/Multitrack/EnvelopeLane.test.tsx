import { act, render } from '@testing-library/react';
import EnvelopeLane from './EnvelopeLane';
import TrackLane from './TrackLane';
import type { Track } from '../../multitrack/session';
import { useSessionStore } from '../../multitrack/sessionStore';
import { _resetSnapPreference, setSnapEnabled } from '../../services/snapPreference';
import { makeInitialState, useAppStore } from '../../stores/appStore';

/**
 * F0 — the envelope lane gestures, driven with REAL pointer events through the
 * component's own handlers (the ClipView.snap.test convention). Geometry used
 * throughout: laneHeight 96, PAD_Y 6 → inner 84 px; volumeDb maps
 * y=6 → +12 dB, y=48 → −24 dB, y=90 → −60 dB. Zoom 100 samples/px with
 * scroll 0, and jsdom's zero-origin getBoundingClientRect, so clientX maps
 * 1:1 to lane-local px and ×100 to samples.
 */

const SPP = 100;

function firePointer(
  element: Element,
  type: 'pointerdown' | 'pointermove' | 'pointerup',
  init: { clientX: number; clientY?: number; button?: number; altKey?: boolean }
): void {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: init.clientX,
    clientY: init.clientY ?? 0,
    button: init.button ?? 0,
    altKey: init.altKey ?? false,
  });
  Object.defineProperty(event, 'pointerId', { value: 1 });
  act(() => {
    element.dispatchEvent(event);
  });
}

function fireAlt(type: 'keydown' | 'keyup', altKey: boolean): void {
  act(() => {
    window.dispatchEvent(new KeyboardEvent(type, { key: 'Alt', altKey, bubbles: true }));
  });
}

function fireDblClick(element: Element, clientX: number, clientY: number): void {
  act(() => {
    element.dispatchEvent(
      new MouseEvent('dblclick', { bubbles: true, cancelable: true, clientX, clientY })
    );
  });
}

function track0(): Track {
  return useSessionStore.getState().session.tracks[0];
}

function renderLane(param: 'volumeDb' | 'pan' = 'volumeDb') {
  return render(
    <EnvelopeLane
      track={track0()}
      param={param}
      zoom={{ samplesPerPixel: SPP, scrollSample: 0 }}
      laneHeight={96}
    />
  );
}

// The lane measures its own clientWidth for the polyline/dot window; jsdom
// reports 0, which would cull every dot. Shadow it for this file only.
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get() {
      return 800;
    },
  });
});
afterAll(() => {
  delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientWidth;
});

beforeEach(() => {
  useAppStore.setState(makeInitialState());
  useSessionStore.getState().newSession(44100);
  _resetSnapPreference();
  setSnapEnabled(false); // snap-specific tests turn it back on
});

describe('click-to-add', () => {
  it('a click on empty lane space commits ONE key at (pixel→sample, y→value)', () => {
    const { getByTestId } = renderLane();
    const lane = getByTestId('envelope-lane');

    firePointer(lane, 'pointerdown', { clientX: 50, clientY: 48 });
    firePointer(lane, 'pointerup', { clientX: 50, clientY: 48 });

    expect(track0().automation).toEqual([
      { param: 'volumeDb', keys: [{ positionSample: 5000, value: -24 }] },
    ]);
  });

  it('press-drag-release on empty space still commits exactly ONE key, at the RELEASE point (ruling D)', () => {
    const { getByTestId } = renderLane();
    const lane = getByTestId('envelope-lane');
    let writes = 0;
    const unsub = useSessionStore.subscribe((s, p) => {
      if (s.session !== p.session) writes++;
    });

    firePointer(lane, 'pointerdown', { clientX: 50, clientY: 48 });
    firePointer(lane, 'pointermove', { clientX: 120, clientY: 6 });
    firePointer(lane, 'pointermove', { clientX: 200, clientY: 6 });
    expect(writes).toBe(0); // preview only — no store traffic mid-drag
    firePointer(lane, 'pointerup', { clientX: 200, clientY: 6 });
    unsub();

    expect(writes).toBe(1);
    expect(track0().automation).toEqual([
      { param: 'volumeDb', keys: [{ positionSample: 20000, value: 12 }] },
    ]);
  });

  it('the pan lane maps y through the pan range (top = R = +1)', () => {
    const { getByTestId } = renderLane('pan');
    const lane = getByTestId('envelope-lane');

    firePointer(lane, 'pointerdown', { clientX: 10, clientY: 6 });
    firePointer(lane, 'pointerup', { clientX: 10, clientY: 6 });

    expect(track0().automation).toEqual([
      { param: 'pan', keys: [{ positionSample: 1000, value: 1 }] },
    ]);
  });
});

describe('dragging an existing key', () => {
  beforeEach(() => {
    useSessionStore
      .getState()
      .upsertAutomationKey(track0().id, 'volumeDb', { positionSample: 5000, value: -24, curve: 'smooth' });
  });

  it('moves it in ONE commit on release, carrying its curve; no mid-drag writes', () => {
    const { getByTestId } = renderLane();
    const lane = getByTestId('envelope-lane');
    let writes = 0;
    const unsub = useSessionStore.subscribe((s, p) => {
      if (s.session !== p.session) writes++;
    });

    // The key renders at (50, 48); grab it dead centre and move +10 px / up.
    firePointer(lane, 'pointerdown', { clientX: 50, clientY: 48 });
    firePointer(lane, 'pointermove', { clientX: 60, clientY: 20 });
    expect(writes).toBe(0);
    firePointer(lane, 'pointerup', { clientX: 60, clientY: 20 });
    unsub();

    expect(writes).toBe(1);
    // y=20 → −60 + (1 − 14/84)·72 = 0 dB.
    expect(track0().automation).toEqual([
      { param: 'volumeDb', keys: [{ positionSample: 6000, value: 0, curve: 'smooth' }] },
    ]);
  });

  it('a plain click on a key (no travel) writes nothing', () => {
    const { getByTestId } = renderLane();
    const lane = getByTestId('envelope-lane');
    const before = useSessionStore.getState().session;

    firePointer(lane, 'pointerdown', { clientX: 51, clientY: 49 });
    firePointer(lane, 'pointerup', { clientX: 51, clientY: 49 });

    expect(useSessionStore.getState().session).toBe(before);
  });

  it('right-click on a key deletes it (and only it)', () => {
    useSessionStore
      .getState()
      .upsertAutomationKey(track0().id, 'volumeDb', { positionSample: 9000, value: 0 });
    const { getByTestId } = renderLane();
    const lane = getByTestId('envelope-lane');

    firePointer(lane, 'pointerdown', { clientX: 50, clientY: 48, button: 2 });

    expect(track0().automation).toEqual([
      { param: 'volumeDb', keys: [{ positionSample: 9000, value: 0 }] },
    ]);
  });

  it('right-click on empty space deletes nothing', () => {
    const { getByTestId } = renderLane();
    const lane = getByTestId('envelope-lane');
    const before = useSessionStore.getState().session;

    firePointer(lane, 'pointerdown', { clientX: 400, clientY: 90, button: 2 });

    expect(useSessionStore.getState().session).toBe(before);
  });

  it('double-click cycles the key\'s outgoing segment curve (smooth → exponential)', () => {
    const { getByTestId } = renderLane();
    const lane = getByTestId('envelope-lane');

    fireDblClick(lane, 50, 48);

    expect(track0().automation?.[0].keys[0].curve).toBe('exponential');
    expect(getByTestId('envelope-curve-flash').textContent).toBe('Ducked');
  });
});

describe('snapping (the v1.8 magnet, reused — T17/T18)', () => {
  it('a key drop snaps to a session target (the multitrack cursor) and Alt suspends it', () => {
    setSnapEnabled(true);
    useSessionStore.getState().setMtCursor(20_000);

    const { getByTestId } = renderLane();
    const lane = getByTestId('envelope-lane');

    // 199 px → raw 19 900, within 8 px (800 samples) of the cursor target.
    firePointer(lane, 'pointerdown', { clientX: 199, clientY: 48 });
    firePointer(lane, 'pointerup', { clientX: 199, clientY: 48 });
    expect(track0().automation?.[0].keys.map((k) => k.positionSample)).toEqual([20_000]);

    firePointer(lane, 'pointerdown', { clientX: 240, clientY: 48, altKey: true });
    firePointer(lane, 'pointerup', { clientX: 240, clientY: 48, altKey: true });
    expect(track0().automation?.[0].keys.map((k) => k.positionSample)).toEqual([20_000, 24_000]);
  });

  it('an Alt change with the pointer STILL recomputes the persistent preview (T20, both halves)', () => {
    setSnapEnabled(true);
    useSessionStore.getState().setMtCursor(20_000);

    const { getByTestId, container } = renderLane();
    const lane = getByTestId('envelope-lane');

    firePointer(lane, 'pointerdown', { clientX: 150, clientY: 48 });
    firePointer(lane, 'pointermove', { clientX: 199, clientY: 48 });
    const dot = () => container.querySelector('[data-testid="envelope-key"]');
    expect(dot()?.getAttribute('cx')).toBe('200'); // snapped preview: 20 000 / 100

    fireAlt('keydown', true); // pointer has not moved
    expect(dot()?.getAttribute('cx')).toBe('199'); // raw preview: 19 900 / 100

    fireAlt('keyup', false);
    expect(dot()?.getAttribute('cx')).toBe('200'); // snapped again

    firePointer(lane, 'pointerup', { clientX: 199, clientY: 48 });
    expect(track0().automation?.[0].keys.map((k) => k.positionSample)).toEqual([20_000]);
  });
});

describe('drawing', () => {
  it('with zero keys the line is the STATIC field value, dashed (the field still governs)', () => {
    useSessionStore.getState().setTrackParam(track0().id, { volumeDb: -24 });
    const { container } = renderLane();
    const line = container.querySelector('polyline');
    expect(line?.getAttribute('stroke-dasharray')).toBe('4 3');
    // −24 dB maps to y 48 everywhere (flat hold of the static value).
    expect(line?.getAttribute('points')?.startsWith('0,48.00 2,48.00')).toBe(true);
  });

  it('with keys the line is solid and follows the evaluator; dots sit at key positions', () => {
    const id = track0().id;
    useSessionStore.getState().upsertAutomationKey(id, 'volumeDb', { positionSample: 0, value: -24 });
    useSessionStore.getState().upsertAutomationKey(id, 'volumeDb', { positionSample: 40_000, value: 12 });
    const { container } = renderLane();
    const line = container.querySelector('polyline');
    expect(line?.getAttribute('stroke-dasharray')).toBeNull();
    const dots = container.querySelectorAll('[data-testid="envelope-key"]');
    expect(dots).toHaveLength(2);
    expect(dots[0].getAttribute('cx')).toBe('0');
    expect(dots[1].getAttribute('cx')).toBe('400');
    expect(dots[0].getAttribute('cy')).toBe('48'); // −24 dB
    expect(dots[1].getAttribute('cy')).toBe('6'); // +12 dB
  });
});

describe('TrackLane integration', () => {
  function renderTrackLane() {
    return render(
      <TrackLane
        track={track0()}
        docs={new Map()}
        zoom={{ samplesPerPixel: SPP, scrollSample: 0 }}
        sessionRate={44100}
        laneHeight={96}
        selectedClipId={null}
        isDragTarget={false}
        resolveTrackAt={() => null}
        onDragOverTrack={() => {}}
      />
    );
  }

  it('renders the overlay only for the open track+param, as a TrackLane child (T29)', () => {
    const { queryByTestId, rerender } = renderTrackLane();
    expect(queryByTestId('envelope-lane')).toBeNull();

    act(() => {
      useSessionStore.getState().setMtEnvelope({ trackId: track0().id, param: 'volumeDb' });
    });
    expect(queryByTestId('envelope-lane')).not.toBeNull();
    expect(queryByTestId('envelope-lane')?.closest('[data-track-id]')).not.toBeNull();

    act(() => {
      useSessionStore.getState().setMtEnvelope({ trackId: 'track-other', param: 'volumeDb' });
    });
    rerender(
      <TrackLane
        track={track0()}
        docs={new Map()}
        zoom={{ samplesPerPixel: SPP, scrollSample: 0 }}
        sessionRate={44100}
        laneHeight={96}
        selectedClipId={null}
        isDragTarget={false}
        resolveTrackAt={() => null}
        onDragOverTrack={() => {}}
      />
    );
    expect(queryByTestId('envelope-lane')).toBeNull();
  });

  it('an envelope pointerdown does NOT clear the clip selection (T25 — stopPropagation)', () => {
    act(() => {
      useSessionStore.getState().setSelectedClip('clip-keep');
      useSessionStore.getState().setMtEnvelope({ trackId: track0().id, param: 'volumeDb' });
    });
    const { getByTestId } = renderTrackLane();

    firePointer(getByTestId('envelope-lane'), 'pointerdown', { clientX: 100, clientY: 40 });

    expect(useSessionStore.getState().selectedClipId).toBe('clip-keep');
  });
});

describe('F5 — spatial params on the envelope lane', () => {
  it('an azimuth lane labels itself, formats degrees, and maps y to the +/-180 range', () => {
    const { getByTestId, getByText } = render(
      <EnvelopeLane
        track={track0()}
        param="azimuth"
        zoom={{ samplesPerPixel: SPP, scrollSample: 0 }}
        laneHeight={96}
      />
    );
    expect(getByText(/Azimuth · click add/)).toBeTruthy();
    const lane = getByTestId('envelope-lane');
    // y=6 (PAD_Y, top) = +180; the preview readout formats degrees.
    firePointer(lane, 'pointerdown', { clientX: 50, clientY: 6 });
    expect(getByTestId('envelope-readout').textContent).toBe('180°');
    firePointer(lane, 'pointerup', { clientX: 50, clientY: 6 });
    expect(track0().automation).toEqual([
      { param: 'azimuth', keys: [{ positionSample: 5000, value: 180 }] },
    ]);
  });

  it('with NO keys the dashed line sits at the parameter NEUTRAL (distance -> 1x, not 0)', () => {
    const { getByTestId } = render(
      <EnvelopeLane
        track={track0()}
        param="distance"
        zoom={{ samplesPerPixel: SPP, scrollSample: 0 }}
        laneHeight={96}
      />
    );
    // distance range 0..10, neutral 1: y = 6 + (1 - 1/10)*84 = 81.6.
    const points = getByTestId('envelope-svg').querySelector('polyline')?.getAttribute('points');
    expect(points).toBeTruthy();
    const first = (points ?? '').split(' ')[0].split(',');
    expect(parseFloat(first[1])).toBeCloseTo(81.6, 1);
  });

  it('draws an azimuth wrap segment from the CIRCULAR evaluator (short arc, not the long ramp)', () => {
    const id = track0().id;
    act(() => {
      const s = useSessionStore.getState();
      s.upsertAutomationKey(id, 'azimuth', { positionSample: 0, value: 170 });
      s.upsertAutomationKey(id, 'azimuth', { positionSample: 80_000, value: -170 });
    });
    const { getByTestId } = render(
      <EnvelopeLane
        track={track0()}
        param="azimuth"
        zoom={{ samplesPerPixel: SPP, scrollSample: 0 }}
        laneHeight={96}
      />
    );
    const points = getByTestId('envelope-svg').querySelector('polyline')?.getAttribute('points') ?? '';
    // x=200px -> s=20000, u=0.25: short arc az=175 -> y = 6 + (1-(175+180)/360)*84
    // = 7.17; the LINEAR long ramp would read az=85 -> y = 28.17.
    const at200 = points.split(' ').find((p) => p.startsWith('200,'));
    expect(at200).toBeTruthy();
    expect(parseFloat((at200 ?? '').split(',')[1])).toBeCloseTo(6 + (1 - 355 / 360) * 84, 1);
  });
});
