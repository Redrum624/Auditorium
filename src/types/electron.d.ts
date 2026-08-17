export interface ElectronAPI {
  readFile(path: string): Promise<ArrayBuffer>;
  writeFile(path: string, data: ArrayBuffer): Promise<{ ok: true } | { ok: false; error: string }>;
  showOpenDialog(opts: { filters?: { name: string; extensions: string[] }[]; multi?: boolean }): Promise<string[] | null>;
  showSaveDialog(opts: { defaultPath?: string; filters?: { name: string; extensions: string[] }[] }): Promise<string | null>;
  showMessageBox(opts: { type?: 'info' | 'warning' | 'error' | 'question'; title?: string; message: string; buttons?: string[]; defaultId?: number }): Promise<number>;
  windowMinimize(): void; windowToggleMaximize(): void; windowClose(): void;
  onWindowMaximized(cb: (isMax: boolean) => void): () => void;   // returns unsubscribe
  onCloseRequested(cb: () => void): () => void;                  // returns unsubscribe (Task F8 close guard)
  respondCloseRequest(dirtyCount: number, inFlightSaveCount: number): void; // renderer's reply to 'app:close-requested'
  getAppVersion(): Promise<string>;

  // Launch splash (S1): the editor renderer's one-shot "the UI is committed"
  // signal; see src/splashHandoff.ts. The splash page's own half
  // (`onSplashProgress`) is NOT part of this interface — the splash window runs
  // its own two-method preload (electron/splashPreload.cjs) and its page is
  // plain JS, so nothing typed by this file can call it.
  splashRendererReady(): void;
  // Stem separation (v1.7, tasks S1/S3). Renderer code goes through
  // `src/services/stemService.ts`, never these directly.
  stemsModelState(): Promise<{ downloaded: boolean; bytes: number | null; expectedBytes: number }>;
  stemsEnsureModel(): Promise<{ ok: true; path: string } | { ok: false; error: string }>;
  onStemsModelProgress(cb: (p: { received: number; total: number }) => void): () => void;  // returns unsubscribe
  stemsSeparate(req: { sampleRate: number; channels: ArrayBuffer[] }): Promise<{ ok: true; totalSegments: number } | { ok: false; cancelled?: true; error?: string }>;
  stemsCancel(): Promise<{ cancelled: boolean }>;
  onStemsProgress(cb: (p: { segment: number; totalSegments: number }) => void): () => void; // returns unsubscribe
  onStemsChunk(cb: (c: { offset: number; samples: number; data: ArrayBuffer }) => void): () => void; // returns unsubscribe

  // Transcription (F4). Renderer code goes through
  // `src/services/transcribeService.ts`, never these directly.
  transcribeModelState(): Promise<{ downloaded: boolean; bytes: number | null; expectedBytes: number }>;
  transcribeEnsureModels(): Promise<{ ok: true } | { ok: false; error: string }>;
  onTranscribeModelProgress(cb: (p: { file: string; fileIndex: number; fileCount: number; received: number; total: number }) => void): () => void; // returns unsubscribe
  transcribeRun(req: { sampleRate: number; samples: ArrayBuffer; language: string }): Promise<{ ok: true; segmentCount: number } | { ok: false; cancelled?: true; error?: string }>;
  transcribeCancel(): Promise<{ cancelled: boolean }>;
  onTranscribeProgress(cb: (p: { stage: 'transcribe' | 'embed'; done: number; total: number }) => void): () => void; // returns unsubscribe
  onTranscribeLanguage(cb: (p: { language: string; probability: number }) => void): () => void; // returns unsubscribe
  onTranscribeSegment(cb: (s: { index: number; startSample: number; endSample: number; text: string; avgLogprob: number; noSpeechProb: number; compressionRatio: number }) => void): () => void; // returns unsubscribe
  onTranscribeEmbedding(cb: (e: { segmentIndex: number; vector: ArrayBuffer }) => void): () => void; // returns unsubscribe

  // Voice changer (F3). Renderer code goes through
  // `src/services/voiceService.ts`, never these directly. `consent` is the
  // F3 consent affirmation and is REQUIRED true by the main-process parser.
  voiceModelState(): Promise<{ downloaded: boolean; bytes: number | null; expectedBytes: number }>;
  voiceEnsureModels(): Promise<{ ok: true } | { ok: false; error: string }>;
  onVoiceModelProgress(cb: (p: { file: string; fileIndex: number; fileCount: number; received: number; total: number }) => void): () => void; // returns unsubscribe
  voiceEmbed(req: { sampleRate: number; samples: ArrayBuffer; consent: boolean }): Promise<{ ok: true; vector: ArrayBuffer } | { ok: false; cancelled?: true; error?: string }>;
  voiceConvert(req: { sampleRate: number; samples: ArrayBuffer; target: ArrayBuffer; consent: boolean }): Promise<{ ok: true; chunkCount: number; sanitisedSamples: number } | { ok: false; cancelled?: true; error?: string }>;
  voiceCancel(): Promise<{ cancelled: boolean }>;
  onVoiceProgress(cb: (p: { stage: 'embed' | 'convert'; done: number; total: number }) => void): () => void; // returns unsubscribe
  onVoiceChunk(cb: (c: { offset: number; samples: number; data: ArrayBuffer }) => void): () => void; // returns unsubscribe
  voiceProfilesLoad(): Promise<{ ok: true; profiles: unknown[] } | { ok: false; error: string }>;
  voiceProfilesSave(req: { profiles: unknown[] }): Promise<{ ok: true } | { ok: false; error: string }>;

  pathBasename(p: string): string;      // implemented in preload (string ops only, no IPC)
  // F11: async since the fix round — the preload also registers the dropped
  // path as read-approved in main before handing it back, and the caller must
  // not start reading before that lands. `null` when the File has no disk path
  // (web content built it) or main refused to approve its shape.
  pathForFile(file: File): Promise<string | null>; // preload-only (webUtils.getPathForFile)
}
declare global { interface Window { electronAPI: ElectronAPI } }
