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
  it('is false below the default 3px threshold', () => {
    expect(exceedsDragThreshold(10, 12)).toBe(false); // diff = 2
    expect(exceedsDragThreshold(10, 8)).toBe(false); // diff = 2, leftward
  });

  it('is true at exactly the default 3px threshold (drag >= 3px selects)', () => {
    expect(exceedsDragThreshold(10, 13)).toBe(true); // diff = 3
    expect(exceedsDragThreshold(10, 7)).toBe(true); // diff = 3, leftward
  });

  it('is true past the default 3px threshold', () => {
    expect(exceedsDragThreshold(10, 14)).toBe(true);
    expect(exceedsDragThreshold(10, 4)).toBe(true);
  });

  it('honors a custom threshold (inclusive)', () => {
    expect(exceedsDragThreshold(0, 8, 10)).toBe(false);
    expect(exceedsDragThreshold(0, 10, 10)).toBe(true);
    expect(exceedsDragThreshold(0, 11, 10)).toBe(true);
  });
});

describe('shiftClickAnchor', () => {
  it('anchors on the cursor when there is no existing selection', () => {
    expect(shiftClickAnchor(500, null, 1000)).toBe(1000);
  });

  it('anchors on the end edge when clicking inside the selection nearer the start', () => {
    // Farthest edge wins so the larger span {300,600} is kept, not {200,300}.
    expect(shiftClickAnchor(300, { start: 200, end: 600 }, 0)).toBe(600);
  });

  it('anchors on the start edge when clicking inside the selection nearer the end', () => {
    expect(shiftClickAnchor(550, { start: 200, end: 600 }, 0)).toBe(200);
  });

  it('keeps start as the anchor on an exact-midpoint tie', () => {
    expect(shiftClickAnchor(400, { start: 200, end: 600 }, 0)).toBe(200);
  });

  it('anchors on the end edge when clicking left of the selection', () => {
    expect(shiftClickAnchor(50, { start: 200, end: 600 }, 0)).toBe(600);
  });

  it('anchors on the start edge when clicking right of the selection', () => {
    expect(shiftClickAnchor(800, { start: 200, end: 600 }, 0)).toBe(200);
  });
});
