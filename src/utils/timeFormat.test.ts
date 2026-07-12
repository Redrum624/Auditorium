import { formatTime, parseTime } from './timeFormat';

describe('formatTime', () => {
  it('formats one second at 44.1k as 0:01.000', () => {
    expect(formatTime(44100, 44100)).toBe('0:01.000');
  });

  it('formats zero samples as 0:00.000', () => {
    expect(formatTime(0, 44100)).toBe('0:00.000');
  });

  it('formats 90.5 seconds as 1:30.500', () => {
    expect(formatTime(90.5 * 44100, 44100)).toBe('1:30.500');
  });

  it('zero-pads seconds and milliseconds', () => {
    // 65.007 s -> 1:05.007
    expect(formatTime(Math.round(65.007 * 48000), 48000)).toBe('1:05.007');
  });

  it('does not roll minutes into hours (75 minutes stays 75:00.000)', () => {
    expect(formatTime(75 * 60 * 44100, 44100)).toBe('75:00.000');
  });
});

describe('parseTime', () => {
  it('parses m:ss.mmm to a sample count', () => {
    expect(parseTime('1:30.500', 44100)).toBe(Math.round(90.5 * 44100));
  });

  it('parses m:ss (no milliseconds)', () => {
    expect(parseTime('0:02', 44100)).toBe(2 * 44100);
  });

  it('parses plain seconds', () => {
    expect(parseTime('90.5', 44100)).toBe(Math.round(90.5 * 44100));
  });

  it('is the inverse of formatTime on ms-aligned values', () => {
    const sr = 44100;
    for (const samples of [0, 44100, 3991050, Math.round(65.007 * 44100)]) {
      const round = Math.round((Math.round((samples / sr) * 1000) / 1000) * sr);
      expect(parseTime(formatTime(samples, sr), sr)).toBe(round);
    }
  });

  it('returns null on garbage', () => {
    expect(parseTime('abc', 44100)).toBeNull();
    expect(parseTime('', 44100)).toBeNull();
    expect(parseTime('1:2:3', 44100)).toBeNull();
    expect(parseTime('1:99', 44100)).toBeNull();
  });

  it('returns null on negative input', () => {
    expect(parseTime('-5', 44100)).toBeNull();
    expect(parseTime('-1:30.000', 44100)).toBeNull();
  });
});
