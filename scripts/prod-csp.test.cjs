'use strict';

const fs = require('fs');
const path = require('path');

// Guards the production CSP hardening done by the `harden-production-csp`
// Vite plugin (vite.config.ts): dev-only connect-src grants (`ws:`,
// `http://localhost:3005`, needed for Vite HMR) must NOT survive into
// dist/index.html. This only runs after `npm run build` has produced a
// dist/ output; it's skipped (not failed) when dist/ is absent so `npm test`
// stays green without requiring a build first (e.g. plain CI unit-test runs).
const distIndexPath = path.join(__dirname, '..', 'dist', 'index.html');
const hasDistIndex = fs.existsSync(distIndexPath);

(hasDistIndex ? describe : describe.skip)('production dist/index.html CSP', () => {
  test('connect-src is hardened to \'self\' with no dev-server grants', () => {
    const html = fs.readFileSync(distIndexPath, 'utf8');
    const match = html.match(/connect-src [^;"]*/);
    expect(match).not.toBeNull();
    expect(match[0]).toBe("connect-src 'self'");
    expect(html).not.toContain('ws:');
    expect(html).not.toContain('localhost:3005');
  });
});
