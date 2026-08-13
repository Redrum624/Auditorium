/**
 * F11-0 — the dev-profiler wedge, part 2: the backstop.
 *
 * WHY THIS EXISTS
 * ---------------
 * React 19's development react-dom carries a component-render profiler
 * (`logComponentRender`) that publishes each commit to the DevTools performance
 * track via `performance.measure(name, { detail })`. The `detail` it passes
 * includes the props that CHANGED on the re-rendered component, serialised by a
 * generic leaf walker: values that are neither a plain Array nor a plain Object
 * fall through its classification and are recursed into as ordinary objects at
 * depth 2 (< its depth cap of 3). A `Float32Array` is exactly such a value — it
 * has integer own enumerable properties, one per sample.
 *
 * `<WaveformView doc={doc}/>` and `<SpectrogramView doc={doc}/>` used to pass
 * the WHOLE `AudioDocument`, whose `channels: Float32Array[]` is a top-level
 * field. The SECOND change of a large document (a second file opened, or any
 * edit that replaces one) therefore diffed old-vs-new and asked the structured
 * cloner to serialise ~30.7M entries for the user's two files: ~4 GB of JS heap
 * against a 3.5 GB renderer ceiling. The clone throws `DataCloneError`, and the
 * throw escapes `flushPassiveEffects` BEFORE `executionContext` is restored, so
 * React's `CommitContext` bit leaks permanently: every later update dies with
 * "Should not already be working" and the renderer never renders again. The
 * zustand subscriptions registered in the never-mounted passive effects go
 * deaf, the playback engine never loads, shortcuts and dialogs never install.
 *
 * The REAL fix is that neither view takes a channels-bearing object as a prop
 * any more (they take `docId` and select the document out of the store). This
 * module is the backstop for every OTHER component that might one day hold a
 * large object in a prop, and it is dev-only by construction — the production
 * react-dom has no `logComponentRender` at all.
 *
 * HOW IT WORKS
 * ------------
 * react-dom computes `supportsUserTiming` ONCE, at module-evaluation time, from
 * `typeof performance.measure === "function"`, and that single boolean gates the
 * entire instrumentation body. So the whole timing track can be switched off for
 * the session by making `performance.measure` non-callable for exactly as long
 * as react-dom's module body takes to evaluate, then putting it back.
 *
 * The restoration is scheduled as a MICROTASK. Evaluating a synchronous ES
 * module graph is one uninterrupted synchronous run: the importer's own body,
 * and every module it imports, finish before the microtask queue is drained. So
 * a guard installed by the first import in `main.tsx` is still in place when
 * react-dom evaluates, and is gone again before any application code runs.
 *
 * NOTHING IN THIS APP CALLS `performance.measure` (verified by grep over the
 * whole repo in the O1 round, and re-verified here), so the window in which it
 * is non-callable costs the app nothing; the restoration exists so that
 * anything ELSE loaded later — DevTools, an extension, a future profiler of our
 * own — finds an intact `Performance`.
 *
 * The mechanics live here, in a plain testable function with no `import.meta`
 * in sight (ts-jest compiles this project to CommonJS, where `import.meta` is a
 * syntax error). The DEV gate and the single side-effecting call live in
 * `installUserTimingGuard.ts`, which nothing but `main.tsx` imports.
 */

/** The narrow shape this module touches — a plain object in the tests, the real
 * `Performance` in the app. */
export interface UserTimingHost {
  measure?: unknown;
}

/** Restores `measure` to exactly the state it was in before {@link suspendUserTiming}:
 * an own property is redefined with its original descriptor, and a merely
 * INHERITED method is uncovered by deleting the own shadow this module wrote. */
function makeRestore(host: UserTimingHost): () => void {
  const own = Object.getOwnPropertyDescriptor(host, 'measure');
  return () => {
    delete host.measure;
    if (own) Object.defineProperty(host, 'measure', own);
  };
}

/**
 * Makes `host.measure` non-callable NOW and schedules its restoration.
 *
 * Returns the restore function, so a caller (or a test) can put it back
 * immediately rather than waiting for the scheduled turn. Restoration is
 * idempotent: running it twice leaves the same state as running it once.
 *
 * A host that has no callable `measure` to begin with is left completely
 * untouched — there is nothing to hide, and writing an own `undefined` onto it
 * would be a change with no purpose.
 */
export function suspendUserTiming(
  host: UserTimingHost,
  schedule: (fn: () => void) => void = queueMicrotask
): () => void {
  if (typeof host.measure !== 'function') {
    return () => {};
  }
  const restore = makeRestore(host);
  // An own data property shadowing the prototype method: `typeof
  // performance.measure` now reads "undefined", which is what react-dom's
  // module-level `supportsUserTiming` probe sees.
  Object.defineProperty(host, 'measure', {
    value: undefined,
    writable: true,
    configurable: true,
    enumerable: false,
  });
  schedule(restore);
  return restore;
}
