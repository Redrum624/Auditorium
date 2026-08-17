// F11-0 — the dev-profiler wedge, part 2: the one side effect.
//
// Imported FIRST by `src/main.tsx`, before anything that pulls in react-dom.
// The whole mechanism, and the incident it exists for, is documented on
// `suspendUserTiming` in ./userTimingGuard.ts — read that first.
//
// This file is deliberately tiny and deliberately untested: it holds the two
// things the mechanics module cannot hold. `import.meta` is a syntax error
// under ts-jest's CommonJS output, so the DEV gate cannot live in a module any
// test imports; and a module whose whole purpose is a side effect at import
// time cannot be imported by a test without performing it.
//
// The `import.meta.env` read is cast rather than typed: pulling in
// `vite/client` would widen this project's `types` array for one boolean.
// `=== true` so a production build (where Vite substitutes the literal `false`)
// and any non-Vite host (where `env` is absent entirely) both fall through.

import { suspendUserTiming } from './userTimingGuard';

const DEV = (import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV === true;

if (DEV && typeof performance !== 'undefined') {
  suspendUserTiming(performance);
}
