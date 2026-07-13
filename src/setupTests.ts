import '@testing-library/jest-dom';
import { TextEncoder, TextDecoder } from 'node:util';

// jest-environment-jsdom runs tests in an isolated jsdom window that does not
// inherit Node's global TextEncoder/TextDecoder. Both are standard Web APIs
// present natively in the real Electron/Chromium renderer this app ships in —
// this only backfills the test-environment gap, it changes no production code.
if (typeof globalThis.TextEncoder === 'undefined') {
  (globalThis as unknown as { TextEncoder: typeof TextEncoder }).TextEncoder = TextEncoder;
}
if (typeof globalThis.TextDecoder === 'undefined') {
  (globalThis as unknown as { TextDecoder: typeof TextDecoder }).TextDecoder = TextDecoder;
}

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
