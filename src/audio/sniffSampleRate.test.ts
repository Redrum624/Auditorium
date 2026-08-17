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

// Free-format MP3 (bitrate_index 0000): FF FB 00 00 = MPEG1 Layer III, free
// bitrate, srIndex 0 -> 44100. A second header starts `gap` bytes after the
// first header's start (`gap` is the free frame length); `secondHeader` lets a
// test present a non-matching confirmer.
function mp3FreeFormat(gap: number, secondHeader: number[] = [0xff, 0xfb, 0x00, 0x00]): number[] {
  return [0xff, 0xfb, 0x00, 0x00, ...zeros(gap - 4), ...secondHeader, ...zeros(8)];
}

// MPEG2 free-format pair: FF F3 00 00 = MPEG2, Layer III, free, srIndex 0 -> 22050.
function mp3FreeFormatMpeg2(gap: number): number[] {
  return [0xff, 0xf3, 0x00, 0x00, ...zeros(gap - 4), 0xff, 0xf3, 0x00, 0x00, ...zeros(8)];
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

function le32(n: number): number[] {
  return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
}

// Ogg FLAC first packet (RFC 9639 §10.2): 0x7F 'FLAC', mapping version 1.0,
// big-endian u16 header-packet count, then the native 'fLaC' marker, a
// metadata block header and the 34-byte STREAMINFO whose 20-bit rate field
// starts 10 bytes in — i.e. at packet offset 27 (absolute offset 55 in the
// page, so the rate's last byte is at absolute offset 57).
function oggFlac(rate: number): number[] {
  const streaminfo = zeros(34);
  streaminfo[10] = (rate >> 12) & 0xff;
  streaminfo[11] = (rate >> 4) & 0xff;
  streaminfo[12] = (rate & 0x0f) << 4;
  const payload = [
    0x7f, ...ascii('FLAC'),
    0x01, 0x00, // mapping major.minor
    0x00, 0x01, // number of header packets (BE)
    ...ascii('fLaC'),
    0x00, 0x00, 0x00, 34, // STREAMINFO metadata block header
    ...streaminfo,
  ];
  return oggPage(payload);
}

// Ogg Speex first packet: the 80-byte SpeexHeader struct (speex_header.h) —
// 8-byte magic 'Speex   ', 20-byte version string, then LE int32 fields
// speex_version_id, header_size, rate: rate at packet offset 36 (absolute
// offset 64 in the page, last byte at absolute offset 67).
function oggSpeex(rate: number): number[] {
  const payload = [
    ...ascii('Speex   '),
    ...zeros(20), // speex_version string
    ...le32(1), // speex_version_id
    ...le32(80), // header_size
    ...le32(rate),
    ...zeros(40), // mode .. reserved2
  ];
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

/** `ftyp`, a ~600 KB `mdat`, THEN `moov` — the ordinary non-faststart layout.
 * Pins that "deep moov" is handled: the size-driven walk steps over the media
 * box in one hop and no byte cap applies to the box scan. */
function mp4NonFaststart(timescale: number): number[] {
  const ftyp = box('ftyp', [...ascii('isom'), ...be32(0), ...ascii('isom')]);
  const mdat = box('mdat', zeros(600 * 1024));
  const moov = box('moov', box('trak', box('mdia', box('mdhd', mdhdContent(timescale)))));
  return [...ftyp, ...mdat, ...moov];
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

// 3-byte size vint (marker 0x20, 21 data bits) for fixture elements larger
// than the 1-byte helper's 126-byte cap.
function vintSize3(n: number): number[] {
  if (n >= 0x1fffff) throw new Error('vintSize3 supports n < 2^21 - 1');
  return [0x20 | (n >>> 16), (n >>> 8) & 0xff, n & 0xff];
}

function ebmlElement(id: number[], content: number[]): number[] {
  return [...id, ...vintSize(content.length), ...content];
}

function ebmlElementBig(id: number[], content: number[]): number[] {
  return [...id, ...vintSize3(content.length), ...content];
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

// A minimal Tracks element carrying one audio TrackEntry.
function tracksElement(rate: number): number[] {
  return ebmlElement(
    ID_TRACKS,
    ebmlElement(ID_TRACKENTRY, ebmlElement(ID_AUDIO, ebmlElement(ID_SAMPLINGFREQ, f32be(rate))))
  );
}

// Finalized (known-size) Segment larger than the old 512 KB byte cap, with
// Tracks at the FRONT — the layout of essentially every real saved .webm/.mkv.
// Under the byte cap this returned null because the Segment's own contentEnd
// exceeded the cap.
function webmBigSegmentTracksFirst(rate: number): number[] {
  const filler = ebmlElementBig(ID_VOID, zeros(600 * 1024));
  const segment = ebmlElementBig(ID_SEGMENT, [...tracksElement(rate), ...filler]);
  return [...ebmlElement(ID_EBML, []), ...segment];
}

// Tracks BEYOND the old 512 KB byte cap, after a ~600 KB Void sibling — the
// deep-Tracks case: the size-driven walk must step over the filler in one hop.
function webmDeepTracks(rate: number): number[] {
  const filler = ebmlElementBig(ID_VOID, zeros(600 * 1024));
  const segment = ebmlElementBig(ID_SEGMENT, [...filler, ...tracksElement(rate)]);
  return [...ebmlElement(ID_EBML, []), ...segment];
}

// `count` empty Void elements (2 bytes each: 1-byte id 0xEC + size 0x80) —
// the EBML analogue of freeBoxes(): a tiny-element flood at one level.
function voidFlood(count: number): number[] {
  const out = new Array<number>(count * 2);
  for (let i = 0; i < count; i++) {
    out[2 * i] = 0xec;
    out[2 * i + 1] = 0x80;
  }
  return out;
}

// Tracks preceded by `count` Void siblings at Segment level: probes the
// EBML_MAX_CHILDREN sibling bound in findEbmlChild.
function webmTracksAfterVoidFlood(count: number, rate: number): number[] {
  const segment = ebmlElementBig(ID_SEGMENT, [...voidFlood(count), ...tracksElement(rate)]);
  return [...ebmlElement(ID_EBML, []), ...segment];
}

// The audio TrackEntry preceded by `count` Void siblings INSIDE Tracks:
// probes the same bound in findAllEbmlChildren.
function webmEntryAfterVoidFloodInTracks(count: number, rate: number): number[] {
  const entry = ebmlElement(ID_TRACKENTRY, ebmlElement(ID_AUDIO, ebmlElement(ID_SAMPLINGFREQ, f32be(rate))));
  const tracks = ebmlElementBig(ID_TRACKS, [...voidFlood(count), ...entry]);
  const segment = ebmlElementBig(ID_SEGMENT, tracks);
  return [...ebmlElement(ID_EBML, []), ...segment];
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
    it('rejects a lone free-bitrate (0000) header with no confirming second header', () => {
      expect(sniffSampleRate(toBuf([0xff, 0xfb, 0x00, 0x00, ...zeros(20)]), 'a.mp3')).toBeNull();
    });
  });

  describe('MP3 free format (bitrate_index 0000)', () => {
    it('accepts a free-format header confirmed by a second matching header', () => {
      expect(sniffSampleRate(toBuf(mp3FreeFormat(24)), 'a.mp3')).toBe(44100);
    });
    it('reads a free-format MPEG2 rate (22050)', () => {
      expect(sniffSampleRate(toBuf(mp3FreeFormatMpeg2(24)), 'a.mp3')).toBe(22050);
    });
    it('accepts a confirming header immediately after the first header (gap 4)', () => {
      expect(sniffSampleRate(toBuf(mp3FreeFormat(4)), 'a.mp3')).toBe(44100);
    });
    it('accepts a confirming header at exactly MP3_MAX_FREE_FRAME (2881) bytes', () => {
      expect(sniffSampleRate(toBuf(mp3FreeFormat(2881)), 'a.mp3')).toBe(44100);
    });
    it('rejects a confirming header one byte past the window (2882)', () => {
      expect(sniffSampleRate(toBuf(mp3FreeFormat(2882)), 'a.mp3')).toBeNull();
    });
    it('does not look for confirmation inside the first header itself (sync at offset 3)', () => {
      // 0xFF at offset 3 begins a header-like pattern that overlaps the first
      // header's own 4 bytes; the confirmation scan starts at i+4 and must
      // not see it.
      expect(sniffSampleRate(toBuf([0xff, 0xfb, 0x00, 0xff, 0xfb, 0x00, 0x00, ...zeros(8)]), 'a.mp3')).toBeNull();
    });
    it('a reserved-bitrate (1111) sync does not confirm a free-format header', () => {
      expect(sniffSampleRate(toBuf(mp3FreeFormat(24, [0xff, 0xfb, 0xf0, 0x00])), 'a.mp3')).toBeNull();
    });
    it('a different-layer free sync does not confirm (Layer II vs Layer III)', () => {
      expect(sniffSampleRate(toBuf(mp3FreeFormat(24, [0xff, 0xfd, 0x00, 0x00])), 'a.mp3')).toBeNull();
    });
    it('a different-sample-rate free sync does not confirm', () => {
      expect(sniffSampleRate(toBuf(mp3FreeFormat(24, [0xff, 0xfb, 0x04, 0x00])), 'a.mp3')).toBeNull();
    });
    it('a confirming header differing only in the protection (CRC) bit still confirms', () => {
      // First header 0xFB (protection_absent=1), confirmer 0xFA (CRC present):
      // the mask (b1 & 0xFE) deliberately ignores that bit — a stream may mix
      // them, and requiring exact equality would silently fall back to 48000.
      expect(sniffSampleRate(toBuf(mp3FreeFormat(24, [0xff, 0xfa, 0x00, 0x00])), 'a.mp3')).toBe(44100);
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
    it('reads the Ogg FLAC STREAMINFO rate from the 0x7F FLAC first packet', () => {
      expect(sniffSampleRate(toBuf(oggFlac(44100)), 'a.ogg')).toBe(44100);
    });
    it('returns null when the 0x7F FLAC packet lacks the native fLaC marker', () => {
      // Both magics are required: corrupt only the inner 'fLaC' (payload offset
      // 9, absolute 37). Without the second-magic check the garbage STREAMINFO
      // bits (still 44100 here) would be returned as a rate.
      const bytes = oggFlac(44100);
      bytes[37] = 0x58; // 'f' -> 'X'
      expect(sniffSampleRate(toBuf(bytes), 'a.ogg')).toBeNull();
    });
    it('returns null for an Ogg FLAC packet whose rate field is 0', () => {
      expect(sniffSampleRate(toBuf(oggFlac(0)), 'a.ogg')).toBeNull();
    });
    it('reads the Ogg FLAC rate when the buffer ends exactly at the rate field (byte 58)', () => {
      expect(sniffSampleRate(toBuf(oggFlac(44100).slice(0, 58)), 'a.ogg')).toBe(44100);
    });
    it('returns null when the buffer ends one byte short of the Ogg FLAC rate field (byte 57)', () => {
      expect(sniffSampleRate(toBuf(oggFlac(44100).slice(0, 57)), 'a.ogg')).toBeNull();
    });
    it('reads the Speex header rate', () => {
      expect(sniffSampleRate(toBuf(oggSpeex(16000)), 'a.spx')).toBe(16000);
    });
    it('returns null for a Speex packet whose rate field is 0', () => {
      expect(sniffSampleRate(toBuf(oggSpeex(0)), 'a.spx')).toBeNull();
    });
    it('reads the Speex rate when the buffer ends exactly at the rate field (byte 68)', () => {
      expect(sniffSampleRate(toBuf(oggSpeex(16000).slice(0, 68)), 'a.spx')).toBe(16000);
    });
    it('returns null when the buffer ends one byte short of the Speex rate field (byte 67)', () => {
      expect(sniffSampleRate(toBuf(oggSpeex(16000).slice(0, 67)), 'a.spx')).toBeNull();
    });
    it('still falls back (null) for an unrecognized first-packet codec magic', () => {
      expect(sniffSampleRate(toBuf(oggPage([...ascii('UnknwnID'), ...zeros(30)])), 'a.ogg')).toBeNull();
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

    it('finds moov AFTER a large mdat (non-faststart layout) — "deep moov" is handled', () => {
      expect(sniffSampleRate(toBuf(mp4NonFaststart(44100)), 'a.m4a')).toBe(44100);
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
    it('sniffs a finalized Segment larger than 512 KB with Tracks at the front', () => {
      // Regression for the old byte cap: a known-size Segment whose contentEnd
      // exceeded 512 KB failed the walk outright, Tracks position regardless.
      expect(sniffSampleRate(toBuf(webmBigSegmentTracksFirst(48000)), 'a.webm')).toBe(48000);
    });
    it('reaches a Tracks element beyond 512 KB (deep Tracks, stepped over in one hop)', () => {
      expect(sniffSampleRate(toBuf(webmDeepTracks(44100)), 'a.webm')).toBe(44100);
    });
    it('finds Tracks read as the 65536th Segment sibling (on the EBML_MAX_CHILDREN bound)', () => {
      expect(sniffSampleRate(toBuf(webmTracksAfterVoidFlood(65535, 44100)), 'a.webm')).toBe(44100);
    });
    it('gives up (null, no hang) when Tracks is the 65537th Segment sibling', () => {
      expect(sniffSampleRate(toBuf(webmTracksAfterVoidFlood(65536, 44100)), 'a.webm')).toBeNull();
    });
    it('collects a TrackEntry read as the 65536th Tracks child (bound in findAllEbmlChildren)', () => {
      expect(sniffSampleRate(toBuf(webmEntryAfterVoidFloodInTracks(65535, 44100)), 'a.webm')).toBe(44100);
    });
    it('gives up (null, no hang) on a TrackEntry past the bound inside Tracks', () => {
      expect(sniffSampleRate(toBuf(webmEntryAfterVoidFloodInTracks(65536, 44100)), 'a.webm')).toBeNull();
    });
    it('returns null (never throws) when the Segment declares a size beyond the buffer', () => {
      const bytes = [...ebmlElement(ID_EBML, []), ...ID_SEGMENT, ...vintSize3(600 * 1024), ...zeros(10)];
      expect(sniffSampleRate(toBuf(bytes), 'a.webm')).toBeNull();
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
        () => mp3FreeFormat(24),
        flac48000,
        oggVorbis22050,
        oggOpus,
        () => oggFlac(44100),
        () => oggSpeex(16000),
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
