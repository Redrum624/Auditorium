// The AudioWorkletProcessor that performs microphone capture, provided as a
// source STRING so the engine can register it from a Blob URL
// (`URL.createObjectURL(new Blob([RECORDER_WORKLET_SOURCE]))`) — no separate
// bundle entry or asset path is needed, which keeps Vite/electron packaging
// trivial. The processor copies each render quantum's input channels into
// per-channel accumulation buffers and posts them back to the main thread in
// batches of >= 8192 frames (transferring the underlying ArrayBuffers so no copy
// crosses the thread boundary). On a 'flush' message from the engine (sent by
// stop()) it posts the remaining accumulated frames as a `final: true` batch so
// the engine knows the recording is complete.
//
// Runs in the AudioWorklet global scope, where `AudioWorkletProcessor`,
// `registerProcessor`, `sampleRate` and `currentTime` are ambient globals — the
// string is never type-checked as part of the app; its only compile-time check
// is the `new Function(...)` syntax assertion in RecordingEngine.test.ts.

export const RECORDER_WORKLET_SOURCE = `
class RecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._batchFrames = 8192;
    this._channels = 0;
    this._blocks = [];   // per channel: array of Float32Array render quanta
    this._frames = 0;    // accumulated frames since the last post
    this.port.onmessage = (event) => {
      if (event.data === 'flush') this._post(true);
    };
  }

  _ensureChannels(count) {
    if (this._channels === count) return;
    this._channels = count;
    this._blocks = [];
    for (let c = 0; c < count; c++) this._blocks.push([]);
    this._frames = 0;
  }

  _post(isFinal) {
    const channels = [];
    for (let c = 0; c < this._channels; c++) {
      const blocks = this._blocks[c];
      let length = 0;
      for (let i = 0; i < blocks.length; i++) length += blocks[i].length;
      const merged = new Float32Array(length);
      let offset = 0;
      for (let i = 0; i < blocks.length; i++) {
        merged.set(blocks[i], offset);
        offset += blocks[i].length;
      }
      channels.push(merged);
      this._blocks[c] = [];
    }
    this._frames = 0;
    const transfer = channels.map((a) => a.buffer);
    this.port.postMessage({ channels: channels, final: !!isFinal }, transfer);
  }

  process(inputs) {
    const input = inputs[0];
    if (input && input.length > 0 && input[0] && input[0].length > 0) {
      this._ensureChannels(input.length);
      for (let c = 0; c < input.length; c++) {
        // Copy: the input Float32Array is reused across render quanta.
        this._blocks[c].push(new Float32Array(input[c]));
      }
      this._frames += input[0].length;
      if (this._frames >= this._batchFrames) this._post(false);
    }
    return true;
  }
}

registerProcessor('recorder', RecorderProcessor);
`;
