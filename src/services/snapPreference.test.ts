import { isBeatGridVisible, setBeatGridVisible } from './beatGridDisplay';
import {
  _resetSnapPreference,
  _subscribeToSnapPreference,
  isSnapEnabled,
  setSnapEnabled,
  toggleSnap,
} from './snapPreference';

describe('snapPreference', () => {
  afterEach(() => _resetSnapPreference());

  it('defaults to ON', () => {
    expect(isSnapEnabled()).toBe(true);
  });

  it('toggleSnap flips and returns the NEW value', () => {
    expect(toggleSnap()).toBe(false);
    expect(isSnapEnabled()).toBe(false);
    expect(toggleSnap()).toBe(true);
    expect(isSnapEnabled()).toBe(true);
  });

  it('notifies subscribers only when the value actually changed', () => {
    const seen = jest.fn();
    const unsubscribe = _subscribeToSnapPreference(seen);

    setSnapEnabled(true); // already true
    expect(seen).not.toHaveBeenCalled();

    setSnapEnabled(false);
    expect(seen).toHaveBeenCalledTimes(1);

    setSnapEnabled(false); // no change
    expect(seen).toHaveBeenCalledTimes(1);

    unsubscribe();
    setSnapEnabled(true);
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it('is INDEPENDENT of the beat-grid display preference', () => {
    // Hiding the tics must not silently disable the magnet: a user who finds
    // the tics visually noisy can still want positions to land on them, and a
    // user who wants the ruler without the pull has the magnet toggle.
    setBeatGridVisible(false);
    expect(isBeatGridVisible()).toBe(false);
    expect(isSnapEnabled()).toBe(true);

    setSnapEnabled(false);
    setBeatGridVisible(true);
    expect(isBeatGridVisible()).toBe(true);
    expect(isSnapEnabled()).toBe(false);
  });
});
