import { dragToSelection, exceedsDragThreshold, shiftClickAnchor } from './selectionGestures';

describe('dragToSelection', () => {
  it('normalizes anchor/current into a min/max SelectionRange', () => {
    expect(dragToSelection(100, 500)).toEqual({ start: 100, end: 500 });
    expect(dragToSelection(500, 100)).toEqual({ start: 100, end: 500 });
  });

  it('returns null when the drag collapses to a single point (click)', () => {
    expect(dragToSelection(200, 200)).toBeNull();
  });
});

describe('exceedsDragThreshold', () => {
  it('is false within the default 3px threshold', () => {
    expect(exceedsDragThreshold(10, 12)).toBe(false);
    expect(exceedsDragThreshold(10, 13)).toBe(false);
  });

  it('is true past the default 3px threshold', () => {
    expect(exceedsDragThreshold(10, 14)).toBe(true);
    expect(exceedsDragThreshold(10, 4)).toBe(true);
  });

  it('honors a custom threshold', () => {
    expect(exceedsDragThreshold(0, 8, 10)).toBe(false);
    expect(exceedsDragThreshold(0, 11, 10)).toBe(true);
  });
});

describe('shiftClickAnchor', () => {
  it('anchors on the cursor when there is no existing selection', () => {
    expect(shiftClickAnchor(500, null, 1000)).toBe(1000);
  });

  it('anchors on the selection start when clicking at or after it', () => {
    expect(shiftClickAnchor(800, { start: 200, end: 600 }, 0)).toBe(200);
    expect(shiftClickAnchor(200, { start: 200, end: 600 }, 0)).toBe(200);
  });

  it('anchors on the selection end when clicking before the start', () => {
    expect(shiftClickAnchor(50, { start: 200, end: 600 }, 0)).toBe(600);
  });
});
