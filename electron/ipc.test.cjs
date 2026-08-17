'use strict';

const path = require('node:path');
const { _testing } = require('./ipc.cjs');

describe('ipc.cjs file:read approval gate (_testing)', () => {
  beforeEach(() => {
    _testing.resetApproved();
  });

  test('a path is not approved until approvePath is called', () => {
    expect(_testing.isReadApproved('D:\\music\\in.wav')).toBe(false);
  });

  test('approvePath makes a path approved', () => {
    _testing.approvePath('D:\\music\\in.wav');
    expect(_testing.isReadApproved('D:\\music\\in.wav')).toBe(true);
  });

  test('approval is case-insensitive', () => {
    _testing.approvePath('D:\\Music\\In.WAV');
    expect(_testing.isReadApproved('d:\\music\\in.wav')).toBe(true);
  });

  test('approval normalizes non-canonical relative segments to the same absolute path', () => {
    const approved = path.resolve('D:\\music\\sub\\..\\in.wav');
    _testing.approvePath(approved);
    expect(_testing.isReadApproved('D:\\music\\in.wav')).toBe(true);
  });

  test('resetApproved clears all previously approved paths', () => {
    _testing.approvePath('D:\\music\\in.wav');
    _testing.resetApproved();
    expect(_testing.isReadApproved('D:\\music\\in.wav')).toBe(false);
  });

  test('approving one path does not approve a different path', () => {
    _testing.approvePath('D:\\music\\in.wav');
    expect(_testing.isReadApproved('D:\\music\\other.wav')).toBe(false);
  });
});
