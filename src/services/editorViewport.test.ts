import {
  FALLBACK_EDITOR_LANE_WIDTH,
  editorLaneWidth,
  setEditorLaneWidth,
  _resetEditorLaneWidth,
} from './editorViewport';

/**
 * F11-3 — the measured editor lane width. Small enough to be obvious, but two
 * of its properties are load-bearing for the zoom: it must never report 0 (a
 * zero lane makes every derived samples-per-pixel infinite), and it must report
 * whether the effective width actually CHANGED, because that is what stops a
 * resize observer firing at the same size from re-fitting the view under the
 * user's hands.
 */
beforeEach(() => {
  _resetEditorLaneWidth();
});

describe('editorLaneWidth', () => {
  it('falls back to the historical nominal viewport before anything is measured', () => {
    expect(editorLaneWidth()).toBe(FALLBACK_EDITOR_LANE_WIDTH);
    expect(FALLBACK_EDITOR_LANE_WIDTH).toBe(1600);
  });

  it('reports the last measurement once a lane has reported one', () => {
    setEditorLaneWidth(942);
    expect(editorLaneWidth()).toBe(942);
    setEditorLaneWidth(431.5);
    expect(editorLaneWidth()).toBe(431.5);
  });
});

describe('setEditorLaneWidth', () => {
  it('returns true only when the effective width changed', () => {
    expect(setEditorLaneWidth(900)).toBe(true);
    expect(setEditorLaneWidth(900)).toBe(false);
    expect(setEditorLaneWidth(901)).toBe(true);
  });

  it('reports no change when the first measurement happens to equal the fallback', () => {
    expect(setEditorLaneWidth(FALLBACK_EDITOR_LANE_WIDTH)).toBe(false);
    expect(editorLaneWidth()).toBe(FALLBACK_EDITOR_LANE_WIDTH);
  });

  it('rejects the widths a hidden or unlaid-out lane reports', () => {
    setEditorLaneWidth(900);
    for (const bad of [0, -1, NaN, Infinity]) {
      expect(setEditorLaneWidth(bad)).toBe(false);
      expect(editorLaneWidth()).toBe(900);
    }
  });
});
