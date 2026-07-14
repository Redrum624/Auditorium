import { sniffSampleRate } from './sniffSampleRate';

// --- fixture helpers ---------------------------------------------------------

function ascii(s: string): number[] {
  return Array.from(s, (c) => c.charCodeAt(0));
}

function be32(n: number): number[] {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}

function toBuf(bytes: number[]): ArrayBuffer {
  return new Uint8Array(bytes).buffer;
}

function zeros(n: number): number[] {
  return new Array(n).fill(0);
}

// --- MP3 ---------------------------------------------------------------------

// 0xFF 0xFB 0x90 0x00: sync=0xFFE, MPEG1 (11), Layer III (01), srIndex 0 -> 44100.
function mp3Mpeg1_44100(): number[] {
  return [0xff, 0xfb, 0x90, 0x00, ...zeros(20)];
}

// 0xFF 0xF3 0x00 0x00: MPEG2 (10), Layer III (01), srIndex 0 -> 22050.
function mp3Mpeg2_22050(): number[] {
  return [0xff, 0xf3, 0x00, 0x00, ...zeros(20)];
}

// ID3v2 header (10 bytes) with a syncsafe body size of 5, five filler bytes,
// then a valid MPEG1 44100 frame header at offset 15.
function mp3WithId3(): number[] {
  return [
    ...ascii('ID3'), 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x05, // 10-byte tag header, size=5
    ...zeros(5), // tag body
    0xff, 0xfb, 0x90, 0x00, ...zeros(10),
  ];
}

// --- FLAC --------------------------------------------------------------------

// 'fLaC' + STREAMINFO metadata block. Rate 20 bits at byte offset 18.
// 48000 = 0xBB80 -> b0=0x0B, b1=0xB8, b2=0x00.
function flac48000(): number[] {
  const b = zeros(42);
  ascii('fLaC').forEach((v, i) => (b[i] = v));
  b[4] = 0x00; // block type 0 (STREAMINFO), not last
  b[5] = 0x00;
  b[6] = 0x00;
  b[7] = 34; // STREAMINFO length
  b[18] = 0x0b;
  b[19] = 0xb8;
  b[20] = 0x00;
  return b;
}

// --- OGG ---------------------------------------------------------------------

function oggPage(payload: number[]): number[] {
  const b = zeros(27 + 1 + payload.length);
  ascii('OggS').forEach((v, i) => (b[i] = v));
  b[4] = 0x00; // stream structure version
  b[5] = 0x02; // header_type: first page
  b[26] = 0x01; // page_segments = 1
  b[27] = payload.length & 0xff; // segment table (single lace)
  payload.forEach((v, i) => (b[28 + i] = v));
  return b;
}

// Vorbis identification header: 0x01 'vorbis', version u32, channels, rate LE u32.
// Rate at payload offset 12. 22050 = 0x5622 -> LE 0x22 0x56 0x00 0x00.
function oggVorbis22050(): number[] {
  const payload = [
    0x01, ...ascii('vorbis'),
    0x00, 0x00, 0x00, 0x00, // vorbis_version
    0x02, // channels
    0x22, 0x56, 0x00, 0x00, // sample rate LE = 22050
    ...zeros(8),
  ];
  return oggPage(payload);
}

function oggOpus(): number[] {
  const payload = [...ascii('OpusHead'), ...zeros(11)];
  return oggPage(payload);
}

// --- MP4 / M4A ---------------------------------------------------------------

function box(type: string, content: number[]): number[] {
  return [...be32(8 + content.length), ...ascii(type), ...content];
}

function mdhdContent(timescale: number): number[] {
  return [
    0x00, 0x00, 0x00, 0x00, // version 0 + flags
    ...zeros(4), // creation_time
    ...zeros(4), // modification_time
    ...be32(timescale), // timescale (content offset 12)
    ...zeros(4), // duration
    ...zeros(2), // language
    ...zeros(2), // pre_defined
  ];
}

function mp4(timescale: number): number[] {
  const mdhd = box('mdhd', mdhdContent(timescale));
  const mdia = box('mdia', mdhd);
  const trak = box('trak', mdia);
  const moov = box('moov', trak);
  const ftyp = box('ftyp', [...ascii('isom'), ...be32(0), ...ascii('isom')]);
  return [...ftyp, ...moov];
}

// -----------------------------------------------------------------------------

describe('sniffSampleRate', () => {
  describe('MP3', () => {
    it('reads MPEG1 Layer III 44100', () => {
      expect(sniffSampleRate(toBuf(mp3Mpeg1_44100()), 'a.mp3')).toBe(44100);
    });
    it('reads MPEG2 22050', () => {
      expect(sniffSampleRate(toBuf(mp3Mpeg2_22050()), 'a.mp3')).toBe(22050);
    });
    it('skips an ID3v2 header before the first frame', () => {
      expect(sniffSampleRate(toBuf(mp3WithId3()), 'a.mp3')).toBe(44100);
    });
  });

  describe('FLAC', () => {
    it('reads the STREAMINFO sample rate', () => {
      expect(sniffSampleRate(toBuf(flac48000()), 'a.flac')).toBe(48000);
    });
  });

  describe('OGG', () => {
    it('reads the Vorbis identification header rate', () => {
      expect(sniffSampleRate(toBuf(oggVorbis22050()), 'a.ogg')).toBe(22050);
    });
    it('returns 48000 for Opus', () => {
      expect(sniffSampleRate(toBuf(oggOpus()), 'a.opus')).toBe(48000);
    });
  });

  describe('MP4 / M4A', () => {
    it('reads the mdhd timescale', () => {
      expect(sniffSampleRate(toBuf(mp4(44100)), 'a.m4a')).toBe(44100);
    });
    it('returns null when the timescale is out of the audio range', () => {
      expect(sniffSampleRate(toBuf(mp4(999999)), 'a.m4a')).toBeNull();
    });
  });

  describe('WAV (defensive)', () => {
    it('reads the fmt chunk sample rate', () => {
      const view = new DataView(new ArrayBuffer(44));
      const put = (o: number, s: string) => Array.from(s, (c, i) => view.setUint8(o + i, c.charCodeAt(0)));
      put(0, 'RIFF');
      view.setUint32(4, 36, true);
      put(8, 'WAVE');
      put(12, 'fmt ');
      view.setUint32(16, 16, true);
      view.setUint16(20, 1, true);
      view.setUint16(22, 2, true);
      view.setUint32(24, 44100, true);
      put(36, 'data');
      view.setUint32(40, 0, true);
      expect(sniffSampleRate(view.buffer, 'a.wav')).toBe(44100);
    });
  });

  describe('malformed / garbage', () => {
    it('returns null for an empty buffer', () => {
      expect(sniffSampleRate(new ArrayBuffer(0), 'a.mp3')).toBeNull();
    });
    it('returns null for random garbage', () => {
      expect(sniffSampleRate(toBuf([1, 2, 3, 4, 5, 6, 7, 8]), 'a.bin')).toBeNull();
    });
    it('returns null for all-zero data', () => {
      expect(sniffSampleRate(toBuf(zeros(200)), 'a.bin')).toBeNull();
    });

    it('never throws for any truncation of a valid fixture', () => {
      const makers = [mp3Mpeg1_44100, mp3WithId3, flac48000, oggVorbis22050, oggOpus, () => mp4(44100)];
      for (const make of makers) {
        const full = make();
        for (let len = 0; len <= full.length; len++) {
          const sliced = toBuf(full.slice(0, len));
          let result: number | null = null;
          expect(() => {
            result = sniffSampleRate(sliced, 'x');
          }).not.toThrow();
          expect(result === null || typeof result === 'number').toBe(true);
        }
      }
    });
  });
});
