'use strict';

const { isPackagedGateOpen } = require('./prodGate.cjs');

describe('prodGate.isPackagedGateOpen (F23)', () => {
  test('open when the env flag is exactly "1" and the app is unpackaged', () => {
    expect(isPackagedGateOpen(false, '1')).toBe(true);
  });

  test('closed when the app is packaged, regardless of the env flag', () => {
    expect(isPackagedGateOpen(true, '1')).toBe(false);
  });

  test('closed when the env flag is unset', () => {
    expect(isPackagedGateOpen(false, undefined)).toBe(false);
  });

  test('closed when the env flag is present but not exactly "1"', () => {
    expect(isPackagedGateOpen(false, '0')).toBe(false);
    expect(isPackagedGateOpen(false, 'true')).toBe(false);
    expect(isPackagedGateOpen(false, '')).toBe(false);
  });

  test('closed when both packaged and the env flag is unset', () => {
    expect(isPackagedGateOpen(true, undefined)).toBe(false);
  });

  test('treats an undefined isPackaged as unpackaged (the require("electron") string-stub shape outside a real Electron process, e.g. under Jest)', () => {
    expect(isPackagedGateOpen(undefined, '1')).toBe(true);
  });
});
