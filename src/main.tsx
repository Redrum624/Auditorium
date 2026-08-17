// F11-0: FIRST import, and it must stay first — it switches off React 19's
// dev-only DevTools timing track for exactly the span of react-dom's module
// evaluation (see src/dev/userTimingGuard.ts for the incident and the
// mechanism). Anything imported above it that reaches react-dom would evaluate
// react-dom before the guard is installed, and the guard would do nothing.
import './dev/installUserTimingGuard';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import CrashBoundary from './components/Layout/CrashBoundary';
import { signalUiReady } from './splashHandoff';
import './index.css';

const container = document.getElementById('root');
if (!container) {
  throw new Error('root element not found');
}

// T4: the crash surface wraps the WHOLE app, and it is the outermost thing
// inside the root for a reason — an error boundary catches only what is below
// it, so anything mounted beside it here would crash to a blank window exactly
// as the app used to. It also has to be inside `createRoot().render()` rather
// than around it: React's own unhandled-render path is what left this app
// frozen once, and only a boundary in the tree intercepts that.
createRoot(container).render(
  <StrictMode>
    <CrashBoundary>
      <App />
    </CrashBoundary>
  </StrictMode>
);

// S1: the editor window is created hidden behind the launch splash and is shown
// when this reports the UI is genuinely committed. Armed AFTER render() and
// before any paint, so it observes React's first commit rather than guessing at
// it — see src/splashHandoff.ts for why it is a DOM observation and not a frame
// callback. A no-op anywhere there is no splash (a browser tab, the unit suite).
//
// T4 interaction, and it is the right one: if the very first render throws, the
// crash card is what React commits, so this still fires and the splash still
// hands over. The user gets a window that says what happened rather than a
// windowless wait ending in the failsafe.
signalUiReady(container);
