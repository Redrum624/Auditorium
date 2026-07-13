'use strict';

const { isOwnOrigin, isMediaAllowed } = require('./permissionPolicy.cjs');

describe('permissionPolicy.isOwnOrigin', () => {
  test('accepts the production file:// bundle', () => {
    expect(isOwnOrigin('file:///C:/app/dist/index.html')).toBe(true);
  });

  test('accepts the pinned dev-server origins', () => {
    expect(isOwnOrigin('http://localhost:3005/')).toBe(true);
    expect(isOwnOrigin('http://127.0.0.1:3005/')).toBe(true);
  });

  test('rejects arbitrary remote origins and empty input', () => {
    expect(isOwnOrigin('https://evil.example.com')).toBe(false);
    expect(isOwnOrigin('http://localhost:9999')).toBe(false);
    expect(isOwnOrigin('')).toBe(false);
    expect(isOwnOrigin(undefined)).toBe(false);
  });
});

describe('permissionPolicy.isMediaAllowed', () => {
  test('grants media capture to our own origin', () => {
    expect(isMediaAllowed('media', 'file:///C:/app/dist/index.html')).toBe(true);
    expect(isMediaAllowed('media', 'http://localhost:3005/')).toBe(true);
  });

  test('denies media capture from a foreign origin', () => {
    expect(isMediaAllowed('media', 'https://evil.example.com')).toBe(false);
  });

  test('denies every non-media permission even from our own origin', () => {
    for (const p of ['geolocation', 'notifications', 'midi', 'camera', 'openExternal']) {
      expect(isMediaAllowed(p, 'file:///C:/app/dist/index.html')).toBe(false);
    }
  });
});
