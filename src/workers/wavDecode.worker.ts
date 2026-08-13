import { decodeWav } from '../audio/wavCodec';
import type { WavDecodeRequest } from './wavDecodeMessages';

// Protocol: the renderer posts a `decode` request carrying the file's bytes as
// a TRANSFERRED ArrayBuffer; the worker replies `done` with the per-channel
// Float32Arrays transferred back, or `error` with the failure message — never
// letting a throw escape uncaught (the same shape tempo.worker.ts and
// spectrogram.worker.ts use).
//
// Why this exists: `decodeWav` walks the file sample by sample and allocates
// one Float32Array per channel. On a 68 MB WAV that is ~17 million iterations
// and ~68 MB of new arrays, and it ran on the renderer's main thread, so the
// UI stopped painting and stopped answering input for the whole of it — the
// window in which the incident's stray click landed on a control the user
// could not see was disabled. Here the same work costs the main thread one
// postMessage.
//
// Transferring in BOTH directions is the other half. Cloning would defeat the
// point: the bytes would exist twice (renderer + worker) while decoding, and
// the decoded samples twice again on the way back. Transferred, each buffer
// exists in exactly one place at any moment, and the renderer's own reference
// to the file bytes is detached by the post — which is why openFilePath reads
// every scrap of container metadata BEFORE handing them over.

// Narrow cast so this compiles under the DOM lib without the conflicting
// `webworker` lib `self` declaration (mirrors tempo.worker.ts).
const ctx = self as unknown as {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent<WavDecodeRequest>) => void) | null;
};

ctx.onmessage = (e: MessageEvent<WavDecodeRequest>) => {
  const msg = e.data;
  if (!msg || msg.type !== 'decode') return;

  try {
    const { channels, sampleRate, bitDepth, markers, channelMask } = decodeWav(msg.bytes);
    // Every channel comes out of `new Float32Array(numFrames)` and owns its
    // own buffer, so each one is transferable on its own.
    ctx.postMessage(
      { type: 'done', id: msg.id, channels, sampleRate, bitDepth, markers, channelMask },
      channels.map((c) => c.buffer)
    );
  } catch (err) {
    ctx.postMessage({
      type: 'error',
      id: msg.id,
      message: err instanceof Error ? err.message : String(err),
    });
  }
};
