'use strict';

// Permission policy for the app's session — kept electron-free so it is unit
// testable in a plain Node environment (main.cjs, which requires electron and
// calls app.setName at module load, cannot be imported by Jest).
//
// The renderer is our own bundle, loaded via file:// in production or the pinned
// dev-server origin in development. We grant ONLY microphone/audio capture
// ('media' with audio-only media types) to that origin — required for the Record
// feature — and deny every other permission (camera, geolocation, notifications,
// etc.) and any request whose origin isn't ours. The origin check is
// belt-and-suspenders for a file:// bundle (there is no remote content), but we
// implement it anyway so a hijacked navigation can't silently gain the mic.

const DEV_HOSTS = new Set(['localhost', '127.0.0.1']);
const DEV_PORT = '3005';

/** True when the request originates from our own renderer bundle. The dev
 * origin is compared on parsed protocol/host/port (never a string prefix, so
 * `localhost:30050` or lookalike hosts can't slip through). */
function isOwnOrigin(url) {
  if (typeof url !== 'string' || url.length === 0) return false;
  if (url.startsWith('file://')) return true;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return parsed.protocol === 'http:' && DEV_HOSTS.has(parsed.hostname) && parsed.port === DEV_PORT;
}

/**
 * Decide a permission request/check: only 'media' from our own origin, and only
 * for AUDIO capture. Chromium's 'media' permission bundles camera and mic, so
 * the media types must be inspected — `details.mediaTypes` (array, permission
 * *request* handler) or `details.mediaType` (string, permission *check*
 * handler). Any mention of video/unknown is denied. When no type detail is
 * supplied at all (some check paths, e.g. device enumeration, omit it) the
 * decision falls back to the origin gate alone — documented choice: denying
 * there would break enumerateDevices labels without protecting anything, since
 * an actual camera capture always carries its media type.
 */
function isMediaAllowed(permission, requestingUrl, details) {
  if (permission !== 'media') return false;
  if (!isOwnOrigin(requestingUrl)) return false;
  const types = details && details.mediaTypes;
  if (Array.isArray(types)) return types.every((t) => t === 'audio');
  const single = details && details.mediaType;
  if (typeof single === 'string') return single === 'audio';
  return true;
}

module.exports = { isOwnOrigin, isMediaAllowed };
