import '@testing-library/jest-dom';

// jsdom ships no ResizeObserver; components that observe their container need it.
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
(globalThis as unknown as { ResizeObserver: typeof ResizeObserverStub }).ResizeObserver =
  ResizeObserverStub;

// jsdom has no 2D canvas backend. Returning null (instead of throwing a noisy
// "not implemented" error) lets canvas components take their null-context guard.
if (typeof HTMLCanvasElement !== 'undefined') {
  HTMLCanvasElement.prototype.getContext = (() =>
    null) as typeof HTMLCanvasElement.prototype.getContext;
}
