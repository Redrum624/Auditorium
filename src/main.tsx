// F11-0: FIRST import, and it must stay first — it switches off React 19's
// dev-only DevTools timing track for exactly the span of react-dom's module
// evaluation (see src/dev/userTimingGuard.ts for the incident and the
// mechanism). Anything imported above it that reaches react-dom would evaluate
// react-dom before the guard is installed, and the guard would do nothing.
import './dev/installUserTimingGuard';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { signalUiReady } from './splashHandoff';
import './index.css';

const container = document.getElementById('root');
if (!container) {
  throw new Error('root element not found');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>
);

// S1: the editor window is created hidden behind the launch splash and is shown
// when this reports the UI is genuinely committed. Armed AFTER render() and
// before any paint, so it observes React's first commit rather than guessing at
// it — see src/splashHandoff.ts for why it is a DOM observation and not a frame
// callback. A no-op anywhere there is no splash (a browser tab, the unit suite).
signalUiReady(container);
