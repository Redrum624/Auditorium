import { decodeWav } from '../audio/wavCodec';
import type { WavDecodeRequest } from '../workers/wavDecodeMessages';

// Test-only fault injection: when set, every 'decode' request replies with an
// `error` message instead of decoding (mirrors createTempoWorkerMock's
// `_setTempoWorkerError`). Reset in afterEach via
// `_resetWavDecodeWorkerTestState`.
let injectedError: string | null = null;

export function _setWavDecodeWorkerError(message: string | null): void {
  injectedError = message;
}

// Test-only fault injection: when set, `createWavDecodeWorker` THROWS instead
// of returning a worker — the "this environment has no workers" branch, which
// must fall back to decoding on the main thread rather than failing the open.
let constructionFailure: string | null = null;

export function _setWavDecodeWorkerConstructionFailure(message: string | null): void {
  constructionFailure = message;
}

// Test-only fault injection: when set, the instance fires `onerror` instead of
// ever answering — a worker that failed to LOAD, after the bytes were already
// transferred away (mirrors createDspWorkerMock's `_setDspWorkerLoadFailure`).
let loadFailureMessage: string | null = null;

export function _setWavDecodeWorkerLoadFailure(message: string | null): void {
  loadFailureMessage = message;
}

// Test-only capture: how many workers have been constructed, and how many were
// terminated. The client promises one worker per decode and no survivors.
let constructCount = 0;
let terminateCount = 0;

export function _getWavDecodeWorkerCounts(): { constructed: number; terminated: number } {
  return { constructed: constructCount, terminated: terminateCount };
}

// Test-only capture: the transfer list of the last posted request. jsdom
// cannot actually detach an ArrayBuffer, so this is how a test checks that the
// client asked for a TRANSFER rather than a clone — the difference between one
// copy of the file and two.
let lastTransfer: Transferable[] | undefined;

export function _getLastWavDecodeTransfer(): Transferable[] | undefined {
  return lastTransfer;
}

export function _resetWavDecodeWorkerTestState(): void {
  injectedError = null;
  constructionFailure = null;
  loadFailureMessage = null;
  constructCount = 0;
  terminateCount = 0;
  lastTransfer = undefined;
}

/**
 * Move an ArrayBuffer the way a real `postMessage(msg, [bytes])` does: the
 * returned buffer holds the contents, and the ORIGINAL is left detached.
 *
 * This matters more than it looks. Without it the double is more permissive
 * than the thing it stands in for: `openFilePath` must read a file's container
 * metadata BEFORE handing the bytes to the decoder, and with a non-detaching
 * double, moving any of those reads back below the decode passes every test
 * here and then throws `TypeError` on the first real FLAC/MP3/OGG open.
 *
 * `ArrayBuffer.prototype.transfer` is the primitive that does it (V8 11.x /
 * Node 21+, present in this project's jest environment — verified before
 * relying on it). `structuredClone` with a transfer list would do the same job
 * but is NOT defined in jest's jsdom environment, so it is the fallback rather
 * than the first choice. If neither exists the double degrades to copying
 * without detaching — the old, weaker behaviour, and better than failing to
 * decode at all.
 */
function transferBuffer(bytes: ArrayBuffer): ArrayBuffer {
  const withTransfer = bytes as ArrayBuffer & { transfer?: () => ArrayBuffer };
  if (typeof withTransfer.transfer === 'function') return withTransfer.transfer();
  if (typeof structuredClone === 'function') {
    return structuredClone(bytes, { transfer: [bytes] });
  }
  return bytes.slice(0);
}

/**
 * Test double for the WAV decode worker: runs the SAME `decodeWav` the real
 * wavDecode.worker.ts calls, synchronously behind a microtask, emitting the
 * same message shapes — `done` or `error` — with a `terminated` guard so a
 * terminated instance never emits again.
 *
 * It emulates the real transfer in both directions: the posted `bytes` are
 * moved out of the caller's reach before decoding (see `transferBuffer`), so a
 * caller that keeps using them after handing them over fails here exactly as
 * it would in the app.
 */
class FakeWavDecodeWorker {
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  private terminated = false;

  postMessage(message: unknown, transfer?: Transferable[]): void {
    const msg = message as WavDecodeRequest;
    if (this.terminated || !msg || msg.type !== 'decode') return;
    lastTransfer = transfer;

    // Take ownership the moment the message is posted, exactly as the real
    // structured-clone transfer does — including on the load-failure path,
    // where the bytes are just as gone (which is precisely why the client
    // cannot fall back to an in-place decode after posting).
    const owned = transfer && transfer.includes(msg.bytes) ? transferBuffer(msg.bytes) : msg.bytes;

    if (loadFailureMessage !== null) {
      const failure = loadFailureMessage;
      queueMicrotask(() => {
        if (this.terminated) return;
        this.onerror?.({ message: failure } as ErrorEvent);
      });
      return;
    }

    queueMicrotask(() => {
      if (this.terminated) return;
      try {
        if (injectedError !== null) throw new Error(injectedError);
        const { channels, sampleRate, bitDepth, markers, channelMask } = decodeWav(owned);
        this.emit({
          type: 'done',
          id: msg.id,
          channels,
          sampleRate,
          bitDepth,
          markers,
          channelMask,
        });
      } catch (err) {
        this.emit({
          type: 'error',
          id: msg.id,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    });
  }

  private emit(data: unknown): void {
    if (this.terminated) return;
    this.onmessage?.({ data } as MessageEvent);
  }

  terminate(): void {
    this.terminated = true;
    terminateCount++;
  }

  addEventListener(): void {}
  removeEventListener(): void {}
}

export function createWavDecodeWorker(): Worker {
  if (constructionFailure !== null) throw new Error(constructionFailure);
  constructCount++;
  return new FakeWavDecodeWorker() as unknown as Worker;
}
