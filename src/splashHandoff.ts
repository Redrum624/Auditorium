/**
 * The renderer's half of the launch splash handoff (Task S1).
 *
 * The main process creates the editor window hidden and shows it at the LAST of
 * two signals: Electron's `ready-to-show`, and this one. Which of the two is
 * later is the entire latency argument for the feature, so the moment this
 * fires is chosen deliberately:
 *
 *   * NOT at module import — that is "the bundle parsed", which is nothing the
 *     user can look at.
 *   * NOT from `requestAnimationFrame` — twice wrong. rAF runs on the wrong
 *     side of the question (before React's first commit if the scheduler has
 *     not flushed it yet, after the paint if you wait two frames for it), and
 *     Chromium does not reliably run frame callbacks for a window that has
 *     never been shown, which is precisely the window this signal exists to
 *     show. A handoff that waits for a frame in a hidden window waits for the
 *     failsafe.
 *   * From the DOM mutation that puts React's first committed element into the
 *     root container. That is the earliest instant at which "the editor is
 *     there" is true, it is observed on the microtask queue rather than the
 *     frame clock, and it happens BEFORE the paint that Electron then reports
 *     as `ready-to-show`. So in a normal launch `ready-to-show` is the later
 *     signal, and the window is shown at exactly the moment it was shown before
 *     this feature existed.
 *
 * Returns a disposer, so a caller (and the unit suite) can stop it.
 */
type ReadyBridge = { splashRendererReady?: () => void };

export function signalUiReady(
  container: Element,
  api: ReadyBridge | undefined = window.electronAPI
): () => void {
  let sent = false;

  function send(): void {
    if (sent) return;
    sent = true;
    // Absent in a browser tab under `vite dev` and in the unit suite; neither
    // has a splash waiting to be dismissed.
    api?.splashRendererReady?.();
  }

  /** React has committed when the container holds an ELEMENT. A text or comment
   * node is not the editor, and an empty container is the pre-commit state. */
  const committed = () => container.firstElementChild !== null;

  if (committed()) {
    send();
    return () => {};
  }

  // No such Electron exists, but if one did, the failure mode of waiting would
  // be an app that never appears. Hand over now instead.
  if (typeof MutationObserver !== 'function') {
    send();
    return () => {};
  }

  const observer = new MutationObserver(() => {
    if (!committed()) return;
    observer.disconnect();
    send();
  });
  observer.observe(container, { childList: true });

  return () => {
    observer.disconnect();
    sent = true;
  };
}
