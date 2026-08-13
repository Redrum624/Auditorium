// F11-0: FIRST import, and it must stay first — it switches off React 19's
// dev-only DevTools timing track for exactly the span of react-dom's module
// evaluation (see src/dev/userTimingGuard.ts for the incident and the
// mechanism). Anything imported above it that reaches react-dom would evaluate
// react-dom before the guard is installed, and the guard would do nothing.
import './dev/installUserTimingGuard';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
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
