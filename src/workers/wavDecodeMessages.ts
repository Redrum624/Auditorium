/**
 * Message shapes for the WAV decode worker, shared by the worker, its client
 * (`src/audio/decodeWavOffThread.ts`) and its test double
 * (`src/__mocks__/createWavDecodeWorkerMock.ts`) — the same three-way contract
 * `dspWorkerMessages.ts` holds for the DSP worker.
 */
import type { WavMarker } from '../audio/wavCodec';

export interface WavDecodeRequest {
  type: 'decode';
  id: number;
  /** The file's raw bytes. TRANSFERRED, not cloned — the renderer's own
   * reference is detached by the post, which is the point: the bytes exist in
   * exactly one place at a time. */
  bytes: ArrayBuffer;
}

export interface WavDecodeDone {
  type: 'done';
  id: number;
  /** Transferred back the same way, one buffer per channel. */
  channels: Float32Array[];
  sampleRate: number;
  bitDepth: number;
  markers: WavMarker[];
  channelMask?: number;
}

export interface WavDecodeError {
  type: 'error';
  id: number;
  message: string;
}

export type WavDecodeResponse = WavDecodeDone | WavDecodeError;
