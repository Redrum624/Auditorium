'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

const electronAPI = {
  // The bytes arrive as a Uint8Array (Electron structured-clones main's
  // Buffer). Unconditionally slicing it made a SECOND full-size copy of every
  // file opened, alive at the same time as the first -- 130 MB of this world
  // for a 65 MiB WAV before decoding had allocated a single sample, and a
  // third copy follows regardless when the return value crosses
  // contextBridge, which copies (measured: mutating this world's buffer after
  // the return does not change what the page sees). The slice only has a job
  // when the view is a window into a larger or offset buffer; measured on a
  // real 65 MiB read, the clone delivers byteOffset 0 with byteLength ===
  // buffer.byteLength, so hand that buffer straight on and keep the copy for
  // the views that need it.
  readFile: (path) =>
    ipcRenderer.invoke('file:read', path).then((buf) => {
      if (buf.byteOffset === 0 && buf.byteLength === buf.buffer.byteLength) {
        return buf.buffer;
      }
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    }),

  writeFile: (path, data) => ipcRenderer.invoke('file:write', path, data),

  showOpenDialog: (opts) => ipcRenderer.invoke('dialog:open', opts),
  showSaveDialog: (opts) => ipcRenderer.invoke('dialog:save', opts),
  showMessageBox: (opts) => ipcRenderer.invoke('dialog:message', opts),

  windowMinimize: () => ipcRenderer.send('window:minimize'),
  windowToggleMaximize: () => ipcRenderer.send('window:toggle-maximize'),
  windowClose: () => ipcRenderer.send('window:close'),

  onWindowMaximized: (cb) => {
    const listener = (_event, isMax) => cb(isMax);
    ipcRenderer.on('window:maximized-changed', listener);
    return () => ipcRenderer.removeListener('window:maximized-changed', listener);
  },

  // Native close guard (Task F8): main asks over 'app:close-requested'; the
  // renderer answers with its dirty-document count over 'app:close-response'.
  onCloseRequested: (cb) => {
    const listener = () => cb();
    ipcRenderer.on('app:close-requested', listener);
    return () => ipcRenderer.removeListener('app:close-requested', listener);
  },
  respondCloseRequest: (dirtyCount, inFlightSaveCount) =>
    ipcRenderer.send('app:close-response', dirtyCount, inFlightSaveCount),

  // Stem separation (v1.7). Channels, payload shapes and event layouts are
  // documented in electron/stemManager.cjs's module header; this bridge adds
  // no logic of its own beyond the on*/unsubscribe pattern used above.
  stemsModelState: () => ipcRenderer.invoke('stems:model-state'),
  stemsEnsureModel: () => ipcRenderer.invoke('stems:ensure-model'),
  onStemsModelProgress: (cb) => {
    const listener = (_event, payload) => cb(payload);
    ipcRenderer.on('stems:model-progress', listener);
    return () => ipcRenderer.removeListener('stems:model-progress', listener);
  },
  stemsSeparate: (req) => ipcRenderer.invoke('stems:separate', req),
  stemsCancel: () => ipcRenderer.invoke('stems:cancel'),
  onStemsProgress: (cb) => {
    const listener = (_event, payload) => cb(payload);
    ipcRenderer.on('stems:progress', listener);
    return () => ipcRenderer.removeListener('stems:progress', listener);
  },
  onStemsChunk: (cb) => {
    const listener = (_event, payload) => cb(payload);
    ipcRenderer.on('stems:chunk', listener);
    return () => ipcRenderer.removeListener('stems:chunk', listener);
  },

  // Transcription (F4). Channels, payload shapes and event layouts are
  // documented in electron/transcribeManager.cjs's module header; this bridge
  // adds no logic of its own beyond the on*/unsubscribe pattern used above.
  transcribeModelState: () => ipcRenderer.invoke('transcribe:model-state'),
  transcribeEnsureModels: () => ipcRenderer.invoke('transcribe:ensure-models'),
  onTranscribeModelProgress: (cb) => {
    const listener = (_event, payload) => cb(payload);
    ipcRenderer.on('transcribe:model-progress', listener);
    return () => ipcRenderer.removeListener('transcribe:model-progress', listener);
  },
  transcribeRun: (req) => ipcRenderer.invoke('transcribe:run', req),
  transcribeCancel: () => ipcRenderer.invoke('transcribe:cancel'),
  onTranscribeProgress: (cb) => {
    const listener = (_event, payload) => cb(payload);
    ipcRenderer.on('transcribe:progress', listener);
    return () => ipcRenderer.removeListener('transcribe:progress', listener);
  },
  onTranscribeLanguage: (cb) => {
    const listener = (_event, payload) => cb(payload);
    ipcRenderer.on('transcribe:language', listener);
    return () => ipcRenderer.removeListener('transcribe:language', listener);
  },
  onTranscribeSegment: (cb) => {
    const listener = (_event, payload) => cb(payload);
    ipcRenderer.on('transcribe:segment', listener);
    return () => ipcRenderer.removeListener('transcribe:segment', listener);
  },
  onTranscribeEmbedding: (cb) => {
    const listener = (_event, payload) => cb(payload);
    ipcRenderer.on('transcribe:embedding', listener);
    return () => ipcRenderer.removeListener('transcribe:embedding', listener);
  },

  // Lyrics alignment (F6). Channels, payload shapes and event layouts are
  // documented in electron/alignManager.cjs's module header; this bridge adds
  // no logic of its own beyond the on*/unsubscribe pattern used above.
  alignModelState: () => ipcRenderer.invoke('align:model-state'),
  alignEnsureModels: () => ipcRenderer.invoke('align:ensure-models'),
  onAlignModelProgress: (cb) => {
    const listener = (_event, payload) => cb(payload);
    ipcRenderer.on('align:model-progress', listener);
    return () => ipcRenderer.removeListener('align:model-progress', listener);
  },
  alignRun: (req) => ipcRenderer.invoke('align:run', req),
  alignCancel: () => ipcRenderer.invoke('align:cancel'),
  onAlignProgress: (cb) => {
    const listener = (_event, payload) => cb(payload);
    ipcRenderer.on('align:progress', listener);
    return () => ipcRenderer.removeListener('align:progress', listener);
  },

  // Voice changer (F3). Channels, payload shapes and event layouts are
  // documented in electron/voiceManager.cjs's module header; this bridge adds
  // no logic of its own beyond the on*/unsubscribe pattern used above.
  voiceModelState: () => ipcRenderer.invoke('voice:model-state'),
  voiceEnsureModels: () => ipcRenderer.invoke('voice:ensure-models'),
  onVoiceModelProgress: (cb) => {
    const listener = (_event, payload) => cb(payload);
    ipcRenderer.on('voice:model-progress', listener);
    return () => ipcRenderer.removeListener('voice:model-progress', listener);
  },
  voiceEmbed: (req) => ipcRenderer.invoke('voice:embed', req),
  voiceConvert: (req) => ipcRenderer.invoke('voice:convert', req),
  voiceCancel: () => ipcRenderer.invoke('voice:cancel'),
  onVoiceProgress: (cb) => {
    const listener = (_event, payload) => cb(payload);
    ipcRenderer.on('voice:progress', listener);
    return () => ipcRenderer.removeListener('voice:progress', listener);
  },
  onVoiceChunk: (cb) => {
    const listener = (_event, payload) => cb(payload);
    ipcRenderer.on('voice:chunk', listener);
    return () => ipcRenderer.removeListener('voice:chunk', listener);
  },
  voiceProfilesLoad: () => ipcRenderer.invoke('voice:profiles-load'),
  voiceProfilesSave: (req) => ipcRenderer.invoke('voice:profiles-save', req),

  getAppVersion: () => ipcRenderer.invoke('app:version'),

  // Launch splash (S1): the EDITOR's end of the handoff. `splashRendererReady`
  // is consumed only by src/splashHandoff.ts. The signal is one-shot and
  // carries nothing — main treats a second one as a no-op — so a renderer can
  // at most show a window main was about to show anyway.
  //
  // The splash page's end (`onSplashProgress`) is NOT here: the splash window
  // runs electron/splashPreload.cjs, which is those two methods and nothing
  // else, so a status page is not handed this whole privileged surface.
  splashRendererReady: () => ipcRenderer.send('splash:renderer-ready'),

  pathBasename: (p) => p.split(/[\\/]/).pop(),

  // F11-4: where a file dragged in from Explorer actually lives. Electron 32
  // removed `File.path`, and `webUtils.getPathForFile` replaced it — it must
  // be called HERE, with the File object handed across the bridge, because the
  // mapping lives in the renderer process, not in main (there is no IPC form
  // of this call). Returns null for anything that is not a real dropped file,
  // so the renderer refuses politely instead of opening a path it invented.
  // F11 (C1): ...and, in the same breath, tells main that THIS path is one the
  // user approved by dropping it. `file:read` refuses any path the user has not
  // approved, and a dropped path passes through neither the open nor the save
  // dialog, so without this every real Explorer drop was refused — invisibly to
  // the smoke, which is the one environment where that gate is disabled.
  //
  // The approval is minted HERE rather than in the renderer because this is the
  // only place that can tell a real drop from a forged one: `getPathForFile`
  // returns "" for any `File` web content built itself, so a non-empty return
  // is proof of a genuine user drop. The renderer never sees the channel —
  // `ipcRenderer` is not exposed, and this object is frozen.
  //
  // Async because the approval must be registered in main BEFORE the renderer
  // asks to read the file; the caller awaits it.
  pathForFile: async (file) => {
    let p;
    try {
      p = webUtils.getPathForFile(file);
    } catch {
      return null;
    }
    if (typeof p !== 'string' || p.length === 0) return null;
    try {
      await ipcRenderer.invoke('file:approveDropped', p);
    } catch {
      // Main refused to approve it (bad shape). Report "no path" rather than
      // hand back one that is guaranteed to be refused a moment later.
      return null;
    }
    return p;
  }
};

Object.freeze(electronAPI);

contextBridge.exposeInMainWorld('electronAPI', electronAPI);

// TEST-ONLY: expose whether the app was launched by the smoke harness so
// App.tsx can install its window.__test hooks. The flag arrives via
// webPreferences.additionalArguments (see electron/main.cjs); false in a
// normal run.
contextBridge.exposeInMainWorld(
  '__auditoriumTest',
  process.argv.includes('--auditorium-test')
);

delete window.module;
delete window.exports;
delete window.require;
