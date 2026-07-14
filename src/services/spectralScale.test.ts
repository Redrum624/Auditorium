import { act, renderHook } from '@testing-library/react';
import { getSpectralScale, toggleSpectralScale, useSpectralScale } from './spectralScale';

// The store is module-level (shared across tests), so every test restores the
// documented default ('log') afterward to stay isolated from the others.
afterEach(() => {
  if (getSpectralScale() !== 'log') toggleSpectralScale();
});

describe('spectralScale store (Task F4)', () => {
  it('defaults to log', () => {
    expect(getSpectralScale()).toBe('log');
  });

  it('toggleSpectralScale flips log <-> linear', () => {
    expect(getSpectralScale()).toBe('log');
    toggleSpectralScale();
    expect(getSpectralScale()).toBe('linear');
    toggleSpectralScale();
    expect(getSpectralScale()).toBe('log');
  });

  it('useSpectralScale returns the current value', () => {
    const { result } = renderHook(() => useSpectralScale());
    expect(result.current).toBe('log');
  });

  it('subscribers (via useSpectralScale) re-render when the scale toggles', () => {
    const { result } = renderHook(() => useSpectralScale());
    expect(result.current).toBe('log');

    act(() => {
      toggleSpectralScale();
    });
    expect(result.current).toBe('linear');

    act(() => {
      toggleSpectralScale();
    });
    expect(result.current).toBe('log');
  });

  it('multiple subscribers all fire on toggle', () => {
    const a = renderHook(() => useSpectralScale());
    const b = renderHook(() => useSpectralScale());

    act(() => {
      toggleSpectralScale();
    });

    expect(a.result.current).toBe('linear');
    expect(b.result.current).toBe('linear');
  });
});
