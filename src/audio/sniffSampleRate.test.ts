import { sniffSampleRate, readFlacStreamInfo } from './sniffSampleRate';

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

// 0xFF 0xF3 0x90 0x00: MPEG2 (10), Layer III (01), bitrate idx 9, srIndex 0 -> 22050.
function mp3Mpeg2_22050(): number[] {
  return [0xff, 0xf3, 0x90, 0x00, ...zeros(20)];
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

// 'fLaC' + STREAMINFO carrying rate 44100 AND a 16-bit sample size (stereo), so
// readFlacStreamInfo's bit-depth math has a real value to read. From byte 18:
// rate[0..19]=44100, channels-1[20..22]=1, bits-1[23..27]=15.
//   b[18]=0x0A, b[19]=0xC4, b[20]=(0x4<<4)|(1<<1)|0=0x42, b[21]=0xF0
function flac44100_16bit(): number[] {
  const b = zeros(42);
  ascii('fLaC').forEach((v, i) => (b[i] = v));
  b[7] = 34;
  b[18] = 0x0a;
  b[19] = 0xc4;
  b[20] = 0x42;
  b[21] = 0xf0;
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

// 64-bit "largesize" box: size field == 1, then an 8-byte big-endian largesize
// immediately after the 4-byte type, per ISO/IEC 14496-12 (16-byte header total).
function be64(n: number | bigint): number[] {
  const buf = new ArrayBuffer(8);
  new DataView(buf).setBigUint64(0, BigInt(n), false);
  return Array.from(new Uint8Array(buf));
}

function box64(type: string, content: number[]): number[] {
  return [...be32(1), ...ascii(type), ...be64(16 + content.length), ...content];
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

// mdhd version 1: creation_time/modification_time widen to u64, so timescale
// shifts to content offset 20 (4 version+flags + 8 + 8).
function mdhdContentV1(timescale: number): number[] {
  return [
    0x01, 0x00, 0x00, 0x00, // version 1 + flags
    ...zeros(8), // creation_time (u64)
    ...zeros(8), // modification_time (u64)
    ...be32(timescale), // timescale (content offset 20)
    ...zeros(8), // duration (u64)
    ...zeros(2), // language
    ...zeros(2), // pre_defined
  ];
}

function mp4WithMdhd(mdhdBytes: number[]): number[] {
  const mdhd = box('mdhd', mdhdBytes);
  const mdia = box('mdia', mdhd);
  const trak = box('trak', mdia);
  const moov = box('moov', trak);
  const ftyp = box('ftyp', [...ascii('isom'), ...be32(0), ...ascii('isom')]);
  return [...ftyp, ...moov];
}

function mp4(timescale: number): number[] {
  return mp4WithMdhd(mdhdContent(timescale));
}

function mp4V1(timescale: number): number[] {
  return mp4WithMdhd(mdhdContentV1(timescale));
}

// moov itself uses a 64-bit largesize header.
function mp4LargesizeMoov(timescale: number): number[] {
  const mdhd = box('mdhd', mdhdContent(timescale));
  const mdia = box('mdia', mdhd);
  const trak = box('trak', mdia);
  const moov = box64('moov', trak);
  const ftyp = box('ftyp', [...ascii('isom'), ...be32(0), ...ascii('isom')]);
  return [...ftyp, ...moov];
}

// trak (nested inside a regular moov) uses a 64-bit largesize header.
function mp4LargesizeTrak(timescale: number): number[] {
  const mdhd = box('mdhd', mdhdContent(timescale));
  const mdia = box('mdia', mdhd);
  const trak = box64('trak', mdia);
  const moov = box('moov', trak);
  const ftyp = box('ftyp', [...ascii('isom'), ...be32(0), ...ascii('isom')]);
  return [...ftyp, ...moov];
}

// Top-level box declares size==1 with a largesize far beyond the actual
// buffer (only the 16-byte header is present) — must yield null, not throw.
function mp4LargesizeExceedsBuffer(): number[] {
  const ftyp = box('ftyp', [...ascii('isom'), ...be32(0), ...ascii('isom')]);
  const badBox = [...be32(1), ...ascii('moov'), ...be64(1_000_000)];
  return [...ftyp, ...badBox];
}

// `count` empty 8-byte `free` boxes — the padding a hostile (or merely
// pathological) file uses to make the top-level box walk run forever.
function freeBoxes(count: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < count; i++) out.push(...be32(8), ...ascii('free'));
  return out;
}

/** `ftyp`, then `count` empty `free` boxes, THEN the real `moov`. */
function mp4WithLeadingFree(count: number, timescale: number): number[] {
  const ftyp = box('ftyp', [...ascii('isom'), ...be32(0), ...ascii('isom')]);
  const moov = box('moov', box('trak', box('mdia', box('mdhd', mdhdContent(timescale)))));
  return [...ftyp, ...freeBoxes(count), ...moov];
}

/** `ftyp`, the real `moov`, THEN `count` empty `free` boxes — the shape a
 * fragmented/faststart file has (structure at the front, bulk after). */
function mp4WithTrailingFree(count: number, timescale: number): number[] {
  const ftyp = box('ftyp', [...ascii('isom'), ...be32(0), ...ascii('isom')]);
  const moov = box('moov', box('trak', box('mdia', box('mdhd', mdhdContent(timescale)))));
  return [...ftyp, ...moov, ...freeBoxes(count)];
}

// Top-level box declares size==1 with a largesize beyond Number.MAX_SAFE_INTEGER
// — must be rejected without ever converting to an imprecise Number.
function mp4LargesizeExceedsSafeInteger(): number[] {
  const ftyp = box('ftyp', [...ascii('isom'), ...be32(0), ...ascii('isom')]);
  const badBox = [...be32(1), ...ascii('moov'), ...be64(2n ** 60n)];
  return [...ftyp, ...badBox];
}

// --- WebM / Matroska (EBML) ---------------------------------------------------
//
// Hand-built minimal EBML: EBML-header element (empty content) + Segment >
// Tracks > TrackEntry > [CodecID] > Audio > SamplingFrequency. Every element
// here uses a 1-byte size vint (0x80 | length, length <= 126), which the real
// Matroska/EBML spec IDs below support given how small these fixtures are.

const ID_EBML = [0x1a, 0x45, 0xdf, 0xa3]; // EBML header, 4-byte id, marker 0x10
const ID_SEGMENT = [0x18, 0x53, 0x80, 0x67];
const ID_TRACKS = [0x16, 0x54, 0xae, 0x6b];
const ID_TRACKENTRY = [0xae];
const ID_AUDIO = [0xe1];
const ID_SAMPLINGFREQ = [0xb5];
const ID_CODECID = [0x86];

// Real Matroska/EBML IDs the sniffer never looks for, used purely as "inert
// sibling" elements to exercise findEbmlChild's skip-and-advance behavior.
const ID_VOID = [0xec]; // Void: 1-byte id
const ID_SEEKHEAD = [0x11, 0x4d, 0x9b, 0x74]; // SeekHead: 4-byte id (Segment child)
const ID_TRACKNUMBER = [0xd7]; // TrackNumber: 1-byte id (TrackEntry child)
const ID_CHANNELS = [0x9f]; // Channels: 1-byte id (Audio child)

function vintSize(n: number): number[] {
  if (n > 126) throw new Error('fixture helper only supports 1-byte size vints (n <= 126)');
  return [0x80 | n]; // marker bit (length=1) | 7-bit value
}

function ebmlElement(id: number[], content: number[]): number[] {
  return [...id, ...vintSize(content.length), ...content];
}

function f32be(n: number): number[] {
  const buf = new ArrayBuffer(4);
  new DataView(buf).setFloat32(0, n, false);
  return Array.from(new Uint8Array(buf));
}

function f64be(n: number): number[] {
  const buf = new ArrayBuffer(8);
  new DataView(buf).setFloat64(0, n, false);
  return Array.from(new Uint8Array(buf));
}

// Builds EBML-header + Segment > Tracks > TrackEntry > [CodecID] > Audio > SamplingFrequency.
function webmAudio(rateBytes: number[], codecId?: string): number[] {
  const samplingFreq = ebmlElement(ID_SAMPLINGFREQ, rateBytes);
  const audio = ebmlElement(ID_AUDIO, samplingFreq);
  const codec = codecId ? ebmlElement(ID_CODECID, ascii(codecId)) : [];
  const trackEntry = ebmlElement(ID_TRACKENTRY, [...codec, ...audio]);
  const tracks = ebmlElement(ID_TRACKS, trackEntry);
  const segment = ebmlElement(ID_SEGMENT, tracks);
  const header = ebmlElement(ID_EBML, []);
  return [...header, ...segment];
}

function webmFloat32(rate: number): number[] {
  return webmAudio(f32be(rate));
}

function webmFloat64(rate: number): number[] {
  return webmAudio(f64be(rate));
}

// SamplingFrequency deliberately carries a DIFFERENT value (8000) than the
// expected result (48000) to prove the Opus override wins regardless of it.
function webmOpus(): number[] {
  return webmAudio(f32be(8000), 'A_OPUS');
}

// Tracks > [video TrackEntry (CodecID V_VP8, no Audio child), audio TrackEntry
// (SamplingFrequency)]. The video entry has no Audio child, so the sniffer's
// per-entry loop must `continue` past it rather than stopping there.
function webmVideoThenAudioTrack(rate: number): number[] {
  const videoEntry = ebmlElement(ID_TRACKENTRY, ebmlElement(ID_CODECID, ascii('V_VP8')));
  const audioEntry = ebmlElement(
    ID_TRACKENTRY,
    ebmlElement(ID_AUDIO, ebmlElement(ID_SAMPLINGFREQ, f32be(rate)))
  );
  const tracks = ebmlElement(ID_TRACKS, [...videoEntry, ...audioEntry]);
  const segment = ebmlElement(ID_SEGMENT, tracks);
  const header = ebmlElement(ID_EBML, []);
  return [...header, ...segment];
}

// Tracks > [audio TrackEntry(rate1), audio TrackEntry(rate2)]. Pins current
// behavior: the sniffer returns the FIRST TrackEntry's rate.
function webmTwoAudioTracks(rate1: number, rate2: number): number[] {
  const entry1 = ebmlElement(ID_TRACKENTRY, ebmlElement(ID_AUDIO, ebmlElement(ID_SAMPLINGFREQ, f32be(rate1))));
  const entry2 = ebmlElement(ID_TRACKENTRY, ebmlElement(ID_AUDIO, ebmlElement(ID_SAMPLINGFREQ, f32be(rate2))));
  const tracks = ebmlElement(ID_TRACKS, [...entry1, ...entry2]);
  const segment = ebmlElement(ID_SEGMENT, tracks);
  const header = ebmlElement(ID_EBML, []);
  return [...header, ...segment];
}

// Inserts an inert sibling element before the target at every walk level
// `sniffWebm` uses findEbmlChild on: top-level (before Segment), inside
// Segment (before Tracks), inside TrackEntry (before Audio), and inside Audio
// (before SamplingFrequency). Exercises findEbmlChild's sibling advancement
// (`offset = el.contentEnd`) at each of those four call sites in one fixture.
function webmWithSiblingsAtEveryLevel(rate: number): number[] {
  const channelsSibling = ebmlElement(ID_CHANNELS, [0x02]);
  const samplingFreq = ebmlElement(ID_SAMPLINGFREQ, f32be(rate));
  const audio = ebmlElement(ID_AUDIO, [...channelsSibling, ...samplingFreq]);

  const trackNumberSibling = ebmlElement(ID_TRACKNUMBER, [0x01]);
  const trackEntry = ebmlElement(ID_TRACKENTRY, [...trackNumberSibling, ...audio]);

  const seekHeadSibling = ebmlElement(ID_SEEKHEAD, zeros(2));
  const tracks = ebmlElement(ID_TRACKS, trackEntry);
  const segment = ebmlElement(ID_SEGMENT, [...seekHeadSibling, ...tracks]);

  const header = ebmlElement(ID_EBML, []);
  const voidSibling = ebmlElement(ID_VOID, zeros(3));
  return [...header, ...voidSibling, ...segment];
}

// --- ADTS / AAC ----------------------------------------------------------------

// Encodes just the fixed 7-byte ADTS header fields the sniffer reads: sync,
// layer=00, sampling_frequency_index, and frame_length. All other bits
// (profile, channel_config, buffer_fullness, ...) are zeroed — the sniffer
// ignores them.
function adtsFrame(freqIndex: number, frameLength: number): number[] {
  const b1 = 0xf1; // sync low nibble 1111, ID=0, layer=00, protection_absent=1
  const b2 = (freqIndex & 0x0f) << 2;
  const b3 = (frameLength >> 11) & 0x03;
  const b4 = (frameLength >> 3) & 0xff;
  const b5 = (frameLength & 0x07) << 5;
  const b6 = 0x00;
  return [0xff, b1, b2, b3, b4, b5, b6];
}

// Two back-to-back frames, frameLength=7 (header-only, no payload) so the
// second frame's sync sits immediately after the first header.
function adtsTwoFrames(freqIndex: number): number[] {
  const frame = adtsFrame(freqIndex, 7);
  return [...frame, ...frame];
}

// ID3v2 header (10 bytes, syncsafe size=0) directly followed by two valid frames.
function adtsWithId3(freqIndex: number): number[] {
  return [...ascii('ID3'), 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, ...adtsTwoFrames(freqIndex)];
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
    it('rejects a header with the reserved bitrate index 1111', () => {
      // Otherwise-valid MPEG1 Layer III header but bitrate index 0b1111.
      expect(sniffSampleRate(toBuf([0xff, 0xfb, 0xf0, 0x00, ...zeros(20)]), 'a.mp3')).toBeNull();
    });
    it('rejects a header with the free bitrate index 0000', () => {
      expect(sniffSampleRate(toBuf([0xff, 0xfb, 0x00, 0x00, ...zeros(20)]), 'a.mp3')).toBeNull();
    });
  });

  describe('FLAC', () => {
    it('reads the STREAMINFO sample rate', () => {
      expect(sniffSampleRate(toBuf(flac48000()), 'a.flac')).toBe(48000);
    });
  });

  describe('readFlacStreamInfo', () => {
    it('reads both the sample rate and the source bit depth', () => {
      expect(readFlacStreamInfo(toBuf(flac44100_16bit()))).toEqual({
        sampleRate: 44100,
        bitDepth: 16,
      });
    });

    it('returns null for non-FLAC bytes', () => {
      expect(readFlacStreamInfo(toBuf([...ascii('RIFF'), ...zeros(40)]))).toBeNull();
    });

    it('returns null (never throws) for a truncated STREAMINFO', () => {
      expect(readFlacStreamInfo(toBuf(ascii('fLaC')))).toBeNull();
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
    it('reads the mdhd v1 (64-bit creation/modification times) timescale', () => {
      expect(sniffSampleRate(toBuf(mp4V1(48000)), 'a.m4a')).toBe(48000);
    });
    it('reads a 64-bit largesize moov box', () => {
      expect(sniffSampleRate(toBuf(mp4LargesizeMoov(44100)), 'a.m4a')).toBe(44100);
    });
    it('reads a 64-bit largesize trak box', () => {
      expect(sniffSampleRate(toBuf(mp4LargesizeTrak(44100)), 'a.m4a')).toBe(44100);
    });
    it('returns null (never throws) when a largesize exceeds the buffer', () => {
      expect(sniffSampleRate(toBuf(mp4LargesizeExceedsBuffer()), 'a.m4a')).toBeNull();
    });
    it('returns null (never throws) when a largesize exceeds Number.MAX_SAFE_INTEGER', () => {
      expect(sniffSampleRate(toBuf(mp4LargesizeExceedsSafeInteger()), 'a.m4a')).toBeNull();
    });

    // MP4_MAX_BOXES: unbounded, a 200 MB file of ~25 M empty `free` boxes froze
    // the main thread and OOMed on a 25-million-element box array.
    it('stops scanning after MP4_MAX_BOXES sibling boxes instead of walking a free-box flood', () => {
      // moov sits past the cap, so the bounded prefix never reaches it: the
      // deliberate cost of the bound, and the proof that it exists.
      expect(sniffSampleRate(toBuf(mp4WithLeadingFree(4200, 44100)), 'a.m4a')).toBeNull();
    });

    it('still finds a moov that precedes a huge free-box run (the bound is a prefix, not a failure)', () => {
      expect(sniffSampleRate(toBuf(mp4WithTrailingFree(4200, 44100)), 'a.m4a')).toBe(44100);
    });

    it('a free-box flood with no moov at all returns null without throwing', () => {
      const ftyp = box('ftyp', [...ascii('isom'), ...be32(0), ...ascii('isom')]);
      expect(sniffSampleRate(toBuf([...ftyp, ...freeBoxes(20000)]), 'a.m4a')).toBeNull();
    });
  });

  describe('WebM / Matroska (EBML)', () => {
    it('reads a float32 SamplingFrequency', () => {
      expect(sniffSampleRate(toBuf(webmFloat32(48000)), 'a.webm')).toBe(48000);
    });
    it('reads a float64 SamplingFrequency', () => {
      expect(sniffSampleRate(toBuf(webmFloat64(44100)), 'a.webm')).toBe(44100);
    });
    it('returns 48000 for an Opus track regardless of the stored SamplingFrequency', () => {
      expect(sniffSampleRate(toBuf(webmOpus()), 'a.webm')).toBe(48000);
    });
    it('skips a leading video TrackEntry (no Audio child) to find the audio entry', () => {
      expect(sniffSampleRate(toBuf(webmVideoThenAudioTrack(44100)), 'a.webm')).toBe(44100);
    });
    it('finds Tracks/Audio/SamplingFrequency past sibling elements at every walk level', () => {
      expect(sniffSampleRate(toBuf(webmWithSiblingsAtEveryLevel(48000)), 'a.webm')).toBe(48000);
    });
    it('returns the FIRST audio TrackEntry rate when two are present', () => {
      expect(sniffSampleRate(toBuf(webmTwoAudioTracks(44100, 96000)), 'a.webm')).toBe(44100);
    });
    it('returns null for truncated/garbage EBML', () => {
      expect(sniffSampleRate(toBuf([0x1a, 0x45, 0xdf, 0xa3]), 'a.webm')).toBeNull();
      expect(sniffSampleRate(toBuf([0x1a, 0x45, 0xdf, 0xa3, ...zeros(40)]), 'a.webm')).toBeNull();
    });
  });

  describe('ADTS / AAC', () => {
    it.each([
      [0, 96000],
      [3, 48000],
      [7, 22050],
      [11, 8000],
    ])('reads sampling_frequency_index %i as %i Hz', (freqIndex, expectedRate) => {
      expect(sniffSampleRate(toBuf(adtsTwoFrames(freqIndex)), 'a.aac')).toBe(expectedRate);
    });
    it('skips an ID3v2 header before the first frame', () => {
      expect(sniffSampleRate(toBuf(adtsWithId3(3)), 'a.aac')).toBe(48000);
    });
    it('rejects a single valid frame not confirmed by a second (two-frame rule)', () => {
      const bytes = [...adtsFrame(3, 7), ...zeros(7)];
      expect(sniffSampleRate(toBuf(bytes), 'a.aac')).toBeNull();
    });
    it('rejects an invalid/reserved sampling_frequency_index', () => {
      expect(sniffSampleRate(toBuf(adtsTwoFrames(12)), 'a.aac')).toBeNull();
      expect(sniffSampleRate(toBuf(adtsTwoFrames(15)), 'a.aac')).toBeNull();
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
      const makers = [
        mp3Mpeg1_44100,
        mp3WithId3,
        flac48000,
        oggVorbis22050,
        oggOpus,
        () => mp4(44100),
        () => mp4V1(48000),
        () => mp4LargesizeMoov(44100),
        () => webmFloat32(48000),
        () => webmOpus(),
        () => adtsTwoFrames(3),
      ];
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
