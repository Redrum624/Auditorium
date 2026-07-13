'use strict';

// Permission policy for the app's session — kept electron-free so it is unit
// testable in a plain Node environment (main.cjs, which requires electron and
// calls app.setName at module load, cannot be imported by Jest).
//
// The renderer is our own bundle, loaded via file:// in production or the pinned
// dev-server origin in development. We grant ONLY microphone/audio capture (the
// 'media' permission) to that origin — required for the Record feature — and
// deny every other permission (camera, geolocation, notifications, etc.) and any
// request whose origin isn't ours. The origin check is belt-and-suspenders for a
// file:// bundle (there is no remote content), but we implement it anyway so a
// hijacked navigation can't silently gain the mic.

/** True when the request originates from our own renderer bundle. */
function isOwnOrigin(url) {
  if (typeof url !== 'string' || url.length === 0) return false;
  return (
    url.startsWith('file://') ||
    url.startsWith('http://localhost:3005') ||
    url.startsWith('http://127.0.0.1:3005')
  );
}

/** Decide a permission request/check. Only 'media' from our own origin is allowed. */
function isMediaAllowed(permission, requestingUrl) {
  if (permission !== 'media') return false;
  return isOwnOrigin(requestingUrl);
}

module.exports = { isOwnOrigin, isMediaAllowed };
