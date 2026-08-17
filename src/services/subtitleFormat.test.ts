import {
  TranscriptSegment,
  defaultSpeakerName,
  formatSrt,
  formatTimestamp,
  formatWebVtt,
} from './subtitleFormat';

const SR = 16000;

function seg(
  startSeconds: number,
  endSeconds: number,
  text: string,
  speaker: number | null = null
): TranscriptSegment {
  return {
    startSample: Math.round(startSeconds * SR),
    endSample: Math.round(endSeconds * SR),
    text,
    speaker,
  };
}

describe('formatTimestamp', () => {
  it('formats SRT with a comma and WebVTT with a dot', () => {
    expect(formatTimestamp(1.5, 'srt')).toBe('00:00:01,500');
    expect(formatTimestamp(1.5, 'vtt')).toBe('00:00:01.500');
  });

  it('decomposes hours, minutes, seconds and milliseconds', () => {
    expect(formatTimestamp(3661.234, 'vtt')).toBe('01:01:01.234');
  });

  it('does not cap the hour field on long recordings', () => {
    // 100 h — truncating to two digits would move the cue by 100 hours.
    expect(formatTimestamp(360000, 'vtt')).toBe('100:00:00.000');
  });

  it('rounds to milliseconds before decomposing, so 59.9996 s carries', () => {
    expect(formatTimestamp(59.9996, 'vtt')).toBe('00:01:00.000');
    expect(formatTimestamp(59.9994, 'vtt')).toBe('00:00:59.999');
  });

  it('clamps negative time to zero', () => {
    expect(formatTimestamp(-1, 'srt')).toBe('00:00:00,000');
  });

  it('throws on non-finite input rather than emitting NaN into a cue', () => {
    expect(() => formatTimestamp(NaN, 'srt')).toThrow(/non-finite/);
    expect(() => formatTimestamp(Infinity, 'vtt')).toThrow(/non-finite/);
  });

  // millisecond rounding boundary, all three roles
  it('rounds the millisecond boundary below/at/above the half', () => {
    expect(formatTimestamp(0.0014, 'vtt')).toBe('00:00:00.001');
    expect(formatTimestamp(0.0015, 'vtt')).toBe('00:00:00.002');
    expect(formatTimestamp(0.0016, 'vtt')).toBe('00:00:00.002');
  });
});

describe('defaultSpeakerName', () => {
  it('maps the 0-based internal index to a 1-based label', () => {
    expect(defaultSpeakerName(0)).toBe('Speaker 1');
    expect(defaultSpeakerName(3)).toBe('Speaker 4');
  });
});

describe('formatSrt', () => {
  it('numbers cues from 1 and emits the arrow line', () => {
    const out = formatSrt([seg(0, 1.5, 'hello'), seg(2, 3, 'world')], SR);
    expect(out).toBe('1\n00:00:00,000 --> 00:00:01,500\nhello\n\n2\n00:00:02,000 --> 00:00:03,000\nworld\n');
  });

  it('prefixes the speaker label when the segment has one', () => {
    const out = formatSrt([seg(0, 1, 'hi', 0), seg(1, 2, 'there', 1)], SR);
    expect(out).toContain('Speaker 1: hi');
    expect(out).toContain('Speaker 2: there');
  });

  it('omits the label for an unknown speaker even with labels enabled', () => {
    const out = formatSrt([seg(0, 1, 'hi', null)], SR, { includeSpeakers: true });
    expect(out).toContain('\nhi');
    expect(out).not.toContain('Speaker');
  });

  it('omits all labels when includeSpeakers is false', () => {
    const out = formatSrt([seg(0, 1, 'hi', 0)], SR, { includeSpeakers: false });
    expect(out).not.toContain('Speaker');
  });

  it('uses a custom speaker namer', () => {
    const out = formatSrt([seg(0, 1, 'hi', 0)], SR, { speakerName: (n) => `Guest ${n}` });
    expect(out).toContain('Guest 0: hi');
  });

  it('returns an empty string for an empty transcript', () => {
    expect(formatSrt([], SR)).toBe('');
  });

  it('drops blank segments instead of emitting an empty cue', () => {
    const out = formatSrt([seg(0, 1, '   '), seg(1, 2, 'kept')], SR);
    expect(out).toBe('1\n00:00:01,000 --> 00:00:02,000\nkept\n');
  });

  it('strips interior blank lines that would split a cue in two', () => {
    const out = formatSrt([seg(0, 1, 'a\n\n\nb')], SR);
    expect(out).toBe('1\n00:00:00,000 --> 00:00:01,000\na\nb\n');
  });

  it('normalises CRLF so a Windows-authored text does not double-space', () => {
    const out = formatSrt([seg(0, 1, 'a\r\nb')], SR);
    expect(out).toContain('a\nb');
    expect(out).not.toContain('\r');
  });

  it('sorts cues into ascending start order', () => {
    const out = formatSrt([seg(5, 6, 'later'), seg(1, 2, 'earlier')], SR);
    expect(out.indexOf('earlier')).toBeLessThan(out.indexOf('later'));
    expect(out.startsWith('1\n00:00:01,000')).toBe(true);
  });

  it('clamps an end that precedes its start rather than emitting a reversed cue', () => {
    const out = formatSrt([{ startSample: 2 * SR, endSample: 1 * SR, text: 'x', speaker: null }], SR);
    expect(out).toContain('00:00:02,000 --> 00:00:02,000');
  });

  it('converts samples with the given sample rate, not a hardcoded one', () => {
    const at44k = formatSrt([{ startSample: 44100, endSample: 88200, text: 'x', speaker: null }], 44100);
    expect(at44k).toContain('00:00:01,000 --> 00:00:02,000');
  });

  it('rejects a non-positive sample rate', () => {
    expect(() => formatSrt([seg(0, 1, 'x')], 0)).toThrow(/positive/);
    expect(() => formatSrt([seg(0, 1, 'x')], -1)).toThrow(/positive/);
    expect(() => formatSrt([seg(0, 1, 'x')], NaN)).toThrow(/positive/);
  });
});

describe('formatWebVtt', () => {
  it('always emits the WEBVTT signature, including for an empty transcript', () => {
    expect(formatWebVtt([], SR)).toBe('WEBVTT\n');
    expect(formatWebVtt([seg(0, 1, 'hi')], SR).startsWith('WEBVTT\n\n')).toBe(true);
  });

  it('uses dot-separated timestamps and no cue numbers', () => {
    const out = formatWebVtt([seg(0, 1.5, 'hello')], SR);
    expect(out).toBe('WEBVTT\n\n00:00:00.000 --> 00:00:01.500\nhello\n');
  });

  it('wraps a labelled cue in the spec voice span', () => {
    const out = formatWebVtt([seg(0, 1, 'hi', 0)], SR);
    expect(out).toContain('<v Speaker 1>hi</v>');
  });

  it('emits bare text for an unknown speaker', () => {
    const out = formatWebVtt([seg(0, 1, 'hi', null)], SR);
    expect(out).toContain('\nhi\n');
    expect(out).not.toContain('<v');
  });

  it('escapes markup characters so a stray angle bracket cannot eat the cue', () => {
    const out = formatWebVtt([seg(0, 1, 'a < b & c > d')], SR);
    expect(out).toContain('a &lt; b &amp; c &gt; d');
    expect(out).not.toMatch(/a < b/);
  });

  it('escapes the speaker name too', () => {
    const out = formatWebVtt([seg(0, 1, 'hi', 0)], SR, { speakerName: () => 'A<B' });
    expect(out).toContain('<v A&lt;B>hi</v>');
  });

  it('rejects a non-positive sample rate', () => {
    expect(() => formatWebVtt([seg(0, 1, 'x')], 0)).toThrow(/positive/);
  });
});

describe('round trip against a strict-ish parser', () => {
  // Re-parsing catches structural mistakes (a missing blank line, a stray
  // number) that a substring assertion would sail past.
  function parseSrt(text: string): { index: number; start: string; end: string; body: string }[] {
    if (text === '') return [];
    return text
      .replace(/\n$/, '')
      .split('\n\n')
      .map((block) => {
        const lines = block.split('\n');
        const m = /^(\d{2,}:\d{2}:\d{2},\d{3}) --> (\d{2,}:\d{2}:\d{2},\d{3})$/.exec(lines[1]);
        if (!m) throw new Error(`bad timing line: ${JSON.stringify(lines[1])}`);
        if (!/^\d+$/.test(lines[0])) throw new Error(`bad index line: ${JSON.stringify(lines[0])}`);
        return { index: Number(lines[0]), start: m[1], end: m[2], body: lines.slice(2).join('\n') };
      });
  }

  it('produces cues that parse back with contiguous 1-based numbering', () => {
    const segments = [
      seg(0, 2, 'first line', 0),
      seg(2.5, 4.25, 'second\nline', 1),
      seg(10, 11, 'third', 0),
    ];
    const cues = parseSrt(formatSrt(segments, SR));
    expect(cues.map((c) => c.index)).toEqual([1, 2, 3]);
    expect(cues[0]).toMatchObject({ start: '00:00:00,000', end: '00:00:02,000', body: 'Speaker 1: first line' });
    expect(cues[1].body).toBe('Speaker 2: second\nline');
    expect(cues[2].start).toBe('00:00:10,000');
  });

  it('a transcript with blank segments still yields contiguous numbering', () => {
    const cues = parseSrt(formatSrt([seg(0, 1, 'a'), seg(1, 2, ''), seg(2, 3, 'b')], SR));
    expect(cues.map((c) => c.index)).toEqual([1, 2]);
  });
});
