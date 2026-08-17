'use strict';

const { isOwnOrigin, isMediaAllowed } = require('./permissionPolicy.cjs');

describe('permissionPolicy.isOwnOrigin', () => {
  test('accepts the production file:// bundle', () => {
    expect(isOwnOrigin('file:///C:/app/dist/index.html')).toBe(true);
  });

  test('accepts the pinned dev-server origins', () => {
    expect(isOwnOrigin('http://localhost:3005/')).toBe(true);
    expect(isOwnOrigin('http://localhost:3005')).toBe(true);
    expect(isOwnOrigin('http://127.0.0.1:3005/')).toBe(true);
  });

  test('rejects lookalike hosts and ports (no prefix matching)', () => {
    expect(isOwnOrigin('http://localhost:30050')).toBe(false);
    expect(isOwnOrigin('http://evillocalhost:3005')).toBe(false);
    expect(isOwnOrigin('https://localhost:3005')).toBe(false); // wrong scheme
  });

  test('rejects arbitrary remote origins, garbage and empty input', () => {
    expect(isOwnOrigin('https://evil.example.com')).toBe(false);
    expect(isOwnOrigin('http://localhost:9999')).toBe(false);
    expect(isOwnOrigin('not a url')).toBe(false);
    expect(isOwnOrigin('')).toBe(false);
    expect(isOwnOrigin(undefined)).toBe(false);
  });
});

describe('permissionPolicy.isMediaAllowed', () => {
  const OWN = 'file:///C:/app/dist/index.html';

  test('grants audio-only media capture to our own origin', () => {
    expect(isMediaAllowed('media', OWN, { mediaTypes: ['audio'] })).toBe(true);
    expect(isMediaAllowed('media', 'http://localhost:3005/', { mediaTypes: ['audio'] })).toBe(
      true
    );
  });

  test('denies camera (video) capture even from our own origin', () => {
    expect(isMediaAllowed('media', OWN, { mediaTypes: ['video'] })).toBe(false);
    expect(isMediaAllowed('media', OWN, { mediaTypes: ['audio', 'video'] })).toBe(false);
  });

  test('handles the check-handler singular mediaType shape', () => {
    expect(isMediaAllowed('media', OWN, { mediaType: 'audio' })).toBe(true);
    expect(isMediaAllowed('media', OWN, { mediaType: 'video' })).toBe(false);
    expect(isMediaAllowed('media', OWN, { mediaType: 'unknown' })).toBe(false);
  });

  test('grants when no media type detail is supplied (documented: origin-gated only)', () => {
    expect(isMediaAllowed('media', OWN)).toBe(true);
    expect(isMediaAllowed('media', OWN, {})).toBe(true);
  });

  test('denies media capture from a foreign origin regardless of type', () => {
    expect(isMediaAllowed('media', 'https://evil.example.com', { mediaTypes: ['audio'] })).toBe(
      false
    );
  });

  test('denies every non-media permission even from our own origin', () => {
    for (const p of ['geolocation', 'notifications', 'midi', 'camera', 'openExternal']) {
      expect(isMediaAllowed(p, OWN, { mediaTypes: ['audio'] })).toBe(false);
    }
  });
});
