import { signalUiReady } from './splashHandoff';

/**
 * The renderer's half of the splash handoff (Task S1). What is being tested is
 * a claim about WHEN, not about what: the signal must go out when the editor is
 * genuinely in the document, and it must go out before the frame that paints it
 * — because Electron's `ready-to-show` fires after that frame, and the launch
 * only stays free if the renderer's half is the earlier of the two.
 *
 * That is why this waits on a DOM mutation rather than on `requestAnimationFrame`:
 * rAF is the wrong side of the paint, and it does not run at all in a window
 * that has not been shown, which is exactly the window this signal is for.
 */

/** Lets a MutationObserver callback run. jsdom schedules them as microtasks. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function makeApi() {
  const calls: number[] = [];
  return {
    calls,
    api: {
      splashRendererReady: () => {
        calls.push(1);
      },
    },
  };
}

describe('signalUiReady', () => {
  test('signals immediately when the UI is already committed', async () => {
    // React can commit synchronously before this ever runs; the handoff must
    // not then wait for a mutation that has already happened.
    const container = document.createElement('div');
    container.appendChild(document.createElement('main'));
    const { calls, api } = makeApi();

    signalUiReady(container, api);
    expect(calls).toHaveLength(1);
  });

  test('waits for the first committed element, then signals', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const { calls, api } = makeApi();

    signalUiReady(container, api);
    expect(calls).toHaveLength(0);

    container.appendChild(document.createElement('main'));
    await settle();
    expect(calls).toHaveLength(1);
  });

  test('an empty container is not a committed UI', async () => {
    // React 19 attaches nothing to the container before its first commit; a
    // mutation that leaves the container still empty (a stray comment node, a
    // removal) is not the moment the editor exists.
    const container = document.createElement('div');
    document.body.appendChild(container);
    const { calls, api } = makeApi();

    signalUiReady(container, api);
    container.appendChild(document.createComment('not the app'));
    await settle();
    expect(calls).toHaveLength(0);

    container.appendChild(document.createElement('main'));
    await settle();
    expect(calls).toHaveLength(1);
  });

  test('signals exactly once, however much the UI churns afterwards', async () => {
    // StrictMode remounts, effects, the first store update — all of it lands as
    // more mutations. The handoff is one-shot in main too, but sending it over
    // and over would be noise on a channel that means "this happened".
    const container = document.createElement('div');
    document.body.appendChild(container);
    const { calls, api } = makeApi();

    signalUiReady(container, api);
    container.appendChild(document.createElement('main'));
    await settle();
    container.appendChild(document.createElement('aside'));
    container.firstElementChild?.remove();
    await settle();

    expect(calls).toHaveLength(1);
  });

  test('stops observing once it has signalled', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const { api } = makeApi();
    const disconnect = jest.fn();
    const observe = jest.fn();
    const original = window.MutationObserver;
    const held: { fire: (() => void) | null } = { fire: null };
    // @ts-expect-error -- a deliberately minimal stand-in
    window.MutationObserver = class {
      constructor(cb: () => void) {
        held.fire = cb;
      }
      observe = observe;
      disconnect = disconnect;
    };

    try {
      signalUiReady(container, api);
      container.appendChild(document.createElement('main'));
      held.fire?.();
      expect(disconnect).toHaveBeenCalledTimes(1);
    } finally {
      window.MutationObserver = original;
    }
  });

  test('the returned disposer stops it from ever signalling', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const { calls, api } = makeApi();

    const stop = signalUiReady(container, api);
    stop();
    container.appendChild(document.createElement('main'));
    await settle();

    expect(calls).toHaveLength(0);
  });

  test('a page with no electronAPI is a no-op, not a crash', async () => {
    // The renderer runs in a browser tab under `vite dev` and in jsdom under
    // the unit suite; neither has a bridge, and neither has a splash to end.
    const container = document.createElement('div');
    document.body.appendChild(container);

    expect(() => signalUiReady(container, undefined)).not.toThrow();
    container.appendChild(document.createElement('main'));
    await expect(settle()).resolves.toBeUndefined();
  });

  test('a bridge without the method is a no-op too', () => {
    const container = document.createElement('div');
    container.appendChild(document.createElement('main'));
    expect(() => signalUiReady(container, {} as never)).not.toThrow();
  });

  test('signals immediately when the platform has no MutationObserver', () => {
    // There is no such Electron, but the failure mode if there were is an app
    // that never appears — so the fallback is "hand over now", not "wait".
    const container = document.createElement('div');
    document.body.appendChild(container);
    const { calls, api } = makeApi();
    const original = window.MutationObserver;
    // @ts-expect-error -- removing it is the point
    delete window.MutationObserver;

    try {
      signalUiReady(container, api);
      expect(calls).toHaveLength(1);
    } finally {
      window.MutationObserver = original;
    }
  });
});
