export interface ElectronAPI {
  readFile(path: string): Promise<ArrayBuffer>;
  writeFile(path: string, data: ArrayBuffer): Promise<{ ok: true } | { ok: false; error: string }>;
  showOpenDialog(opts: { filters?: { name: string; extensions: string[] }[]; multi?: boolean }): Promise<string[] | null>;
  showSaveDialog(opts: { defaultPath?: string; filters?: { name: string; extensions: string[] }[] }): Promise<string | null>;
  showMessageBox(opts: { type?: 'info' | 'warning' | 'error' | 'question'; title?: string; message: string; buttons?: string[] }): Promise<number>;
  windowMinimize(): void; windowToggleMaximize(): void; windowClose(): void;
  onWindowMaximized(cb: (isMax: boolean) => void): () => void;   // returns unsubscribe
  onCloseRequested(cb: () => void): () => void;                  // returns unsubscribe (Task F8 close guard)
  respondCloseRequest(dirtyCount: number): void;                 // renderer's reply to 'app:close-requested'
  getAppVersion(): Promise<string>;
  pathBasename(p: string): string;      // implemented in preload (string ops only, no IPC)
}
declare global { interface Window { electronAPI: ElectronAPI } }
