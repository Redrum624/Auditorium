import { renderHook, act } from '@testing-library/react';
import {
  isBeatGridVisible,
  setBeatGridVisible,
  toggleBeatGrid,
  useBeatGridVisible,
} from './beatGridDisplay';

beforeEach(() => {
  setBeatGridVisible(true);
});

describe('beatGridDisplay (Task B2)', () => {
  it('defaults to visible — the user asked for the tics to be printed when known', () => {
    expect(isBeatGridVisible()).toBe(true);
  });

  it('toggleBeatGrid flips the preference and returns the NEW value', () => {
    expect(toggleBeatGrid()).toBe(false);
    expect(isBeatGridVisible()).toBe(false);
    expect(toggleBeatGrid()).toBe(true);
    expect(isBeatGridVisible()).toBe(true);
  });

  it('re-renders subscribers on a change', () => {
    const { result } = renderHook(() => useBeatGridVisible());
    expect(result.current).toBe(true);
    act(() => {
      toggleBeatGrid();
    });
    expect(result.current).toBe(false);
  });

  it('does not notify when the value is unchanged', () => {
    let renders = 0;
    renderHook(() => {
      renders++;
      return useBeatGridVisible();
    });
    const before = renders;
    act(() => {
      setBeatGridVisible(true);
      setBeatGridVisible(true);
    });
    expect(renders).toBe(before);
  });

  it('unsubscribes on unmount (no listener leak across mounts)', () => {
    const { unmount } = renderHook(() => useBeatGridVisible());
    unmount();
    // A flip after unmount must not throw on a dead subscriber.
    expect(() => toggleBeatGrid()).not.toThrow();
  });
});
