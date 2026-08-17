const { app, BrowserWindow, dialog, ipcMain, session } = require('electron');
const path = require('node:path');
const { registerIpc } = require('./ipc.cjs');
const { createCloseGuard } = require('./closeGuard.cjs');
const { setAppPaths } = require('./writePathPolicy.cjs');
const { isMediaAllowed } = require('./permissionPolicy.cjs');
const { isPackagedGateOpen } = require('./prodGate.cjs');
const { shouldAutoOpenDevTools } = require('./devToolsPolicy.cjs');
const { createStemManager, registerStemIpc } = require('./stemManager.cjs');
const { createTranscribeManager, registerTranscribeIpc } = require('./transcribeManager.cjs');
const { createVoiceManager, registerVoiceIpc } = require('./voiceManager.cjs');
const { createAlignManager, registerAlignIpc } = require('./alignManager.cjs');
const { runStemSelftest, parseStemSelftestArgs } = require('./stemSelftest.cjs');
const { createSplashController } = require('./splash.cjs');

app.setName('audition_app');

// Ask V8 for the largest old-generation heap it will give us, before anything
// can allocate. USER REQUEST, verbatim: "put the memory allocation higher! it
// makes no sense that 2 songs can't fit on 64Gb RAM".
//
// What this actually does, measured on the machine that hit the incident
// rather than assumed (see .superpowers/sdd/task-O1-report.md):
//
//   * The switch DOES reach the renderers, not just the main process. Asking
//     for 512 lowers the renderer's reported jsHeapSizeLimit to 631 MiB, which
//     is how we know the value is honoured where the audio lives.
//   * 16384 does NOT produce a 16 GiB heap. The renderer reports 3585.8 MiB
//     with this switch and 3585.8 MiB without it: V8 clamps to the ceiling its
//     pointer-compressed heap cage allows, and the default is already at that
//     ceiling. So this line asks for the maximum and gets the maximum; it does
//     not RAISE anything on this platform.
//   * It could not have been the fix on its own anyway, because the audio is
//     not in that heap. Typed-array backing stores are external to it: with
//     both incident files open (~123 MB of Float32Array) the renderer's
//     usedJSHeapSize stayed at 9.5 MiB, and a probe allocated 10 GB of
//     Float32Array without failing, with and without this switch.
//
// It stays because asking for the platform maximum is free and correct, and
// because a future Electron with a larger cage should get the benefit without
// anyone having to remember. The measures that actually fixed the open are the
// copy elimination (preload.cjs, fileService.openFilePath), the off-thread
// decode (decodeAudio.ts) and the clean rollback.
//
// Set before `app.whenReady()` because V8 reads its heap configuration at
// isolate creation.
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=16384');

let mainWindow = null;

// Native close guard (Task F8): the window's 'close' event is intercepted, the
// renderer reports its dirty-document count over IPC, and main shows a native
// Quit/Cancel message box when the count is non-zero. See closeGuard.cjs.
// In test mode (same gate as the renderer test hooks) the guard destroys
// instead of asking — an unattended smoke run has no one to click a dialog.
const closeGuard = createCloseGuard({
  ipcMain,
  dialog,
  autoConfirmQuit: isPackagedGateOpen(app.isPackaged, process.env.AUDITORIUM_TEST),
});

/**
 * S1 (splash): `showWhenReady` is false for the launch window, because the splash
 * controller shows it — at the LAST of Electron's `ready-to-show` and the
 * renderer's own "the editor is committed" signal, which in a normal launch is
 * `ready-to-show` itself (see electron/splash.cjs for why that ordering holds
 * and why it costs nothing). The macOS re-open path passes nothing and gets the
 * old behaviour: the window shows itself, with no splash in front of it.
 */
function createWindow({ showWhenReady = true } = {}) {
  const win = new BrowserWindow({
    width: 1600,
    height: 1000,
    minWidth: 1100,
    minHeight: 700,
    frame: false,
    backgroundColor: '#1a1a1e',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      // DevTools stay available while developing but are compiled out of a
      // packaged build: an installed app has no legitimate use for them, and
      // leaving them on hands anyone at the keyboard (or anything that can
      // reach the renderer) a full console against the privileged
      // window.electronAPI surface.
      devTools: !app.isPackaged,
      // TEST-ONLY: forward the smoke-harness flag into the sandboxed preload via
      // process.argv (the documented channel for sandboxed preloads). Empty in
      // any normal run, so the renderer never installs test hooks in production.
      // F23: also gated on !app.isPackaged, so a packaged build can never be
      // coerced into installing test hooks just by an env var being set.
      additionalArguments: isPackagedGateOpen(app.isPackaged, process.env.AUDITORIUM_TEST)
        ? ['--auditorium-test']
        : []
    }
  });

  win.once('ready-to-show', () => {
    if (showWhenReady) win.show();
    // USER RULE: while developing, the console is open without being asked
    // for. Dev runs only -- see devToolsPolicy.cjs for why a packaged build
    // and the smoke harness are both excluded. Detached so it never takes
    // width from the window the app laid itself out for.
    if (
      shouldAutoOpenDevTools({
        isPackaged: app.isPackaged,
        viteDevServer: process.env.VITE_DEV_SERVER,
        auditoriumTest: process.env.AUDITORIUM_TEST,
      })
    ) {
      win.webContents.openDevTools({ mode: 'detach' });
    }
  });

  // F23: also gated on !app.isPackaged, so a packaged build always loads the
  // built bundle even if VITE_DEV_SERVER somehow ended up set in its env.
  if (isPackagedGateOpen(app.isPackaged, process.env.VITE_DEV_SERVER)) {
    win.loadURL('http://localhost:3005');
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }

  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  win.webContents.on('will-navigate', (event, url) => {
    if (url !== win.webContents.getURL()) {
      event.preventDefault();
    }
  });

  win.on('close', (event) => closeGuard.handleClose(win, event));

  mainWindow = win;
  return win;
}

// Stem-host self-test mode (S1): `--stem-selftest-out=<json>` runs the
// packaged-app proof — spawn the inference utility process, run one segment,
// write a JSON verdict, exit — with NO window and none of the normal app
// surface. See electron/stemSelftest.cjs for the security stance.
const stemSelftestArgs = parseStemSelftestArgs(process.argv);

app.whenReady().then(() => {
  if (stemSelftestArgs) {
    void runStemSelftest({ app, ...stemSelftestArgs }).then((code) => app.exit(code));
    return;
  }

  setAppPaths({ appPath: app.getAppPath(), userData: app.getPath('userData') });

  // Grant ONLY microphone/audio capture ('media' restricted to audio media
  // types), and only to our own renderer bundle; deny everything else (camera,
  // geolocation, notifications, …). Both handlers are wired so the two Chromium
  // code paths (the async permission *request* and the synchronous permission
  // *check* getUserMedia consults) use the same policy, with their respective
  // details shapes (mediaTypes vs mediaType) forwarded for the audio-only gate.
  // See electron/permissionPolicy.cjs.
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const url = webContents ? webContents.getURL() : '';
    callback(isMediaAllowed(permission, url, details));
  });
  ses.setPermissionCheckHandler((_webContents, permission, requestingOrigin, details) => {
    return isMediaAllowed(permission, requestingOrigin, details);
  });

  // S1 (splash) — the launch splash. Order is the whole latency argument: the editor
  // window is constructed and its `loadURL`/`loadFile` is already in flight
  // BEFORE the splash BrowserWindow is created, so nothing on the critical path
  // waits on this feature. (The reference implementation this follows defers
  // its main window behind `setTimeout(..., 300)` to give the splash a head
  // start; that is 300 ms of pure added launch latency, and it is not copied.)
  const win = createWindow({ showWhenReady: false });

  const splash = createSplashController({
    BrowserWindow,
    ipcMain,
    splashFile: path.join(__dirname, 'splash.html'),
    // Its OWN preload, not the editor's: a 9 KB status page has no use for
    // file reads, dialogs or the manager IPC, and a second window is a second
    // attack surface. See electron/splashPreload.cjs.
    preloadFile: path.join(__dirname, 'splashPreload.cjs'),
    icon: path.join(__dirname, '..', 'assets', 'icon.ico'),
    // A second BrowserWindow is a second attack surface: same DevTools policy
    // as the editor, compiled out of a packaged build.
    devTools: !app.isPackaged,
    // A dev run loads http://localhost:3005, and a cold Vite transforms the
    // whole module graph on that first request — legitimately longer than the
    // packaged failsafe allows. Same gate as the loadURL in createWindow, so
    // the two can never disagree about what a dev run is.
    failsafeMs: isPackagedGateOpen(app.isPackaged, process.env.VITE_DEV_SERVER) ? 20000 : 5000,
  });
  splash.open();
  splash.adoptMainWindow(win);

  registerIpc(() => mainWindow);

  // Stem separation (S1): the manager owns the model download and the
  // inference utility-process lifetime; dispose on quit guarantees no orphan
  // inference process outlives the app (plan ruling 7).
  const stemManager = createStemManager({ userDataDir: app.getPath('userData') });
  registerStemIpc({ ipcMain, manager: stemManager, getWin: () => mainWindow });
  app.on('will-quit', () => stemManager.dispose());

  // Transcription (F4): same shape, a second independent manager. Its own
  // utility process, its own model directory, its own dispose — the two
  // features never share a child, so cancelling or quitting one cannot leave
  // the other's inference running.
  const transcribeManager = createTranscribeManager({ userDataDir: app.getPath('userData') });
  registerTranscribeIpc({ ipcMain, manager: transcribeManager, getWin: () => mainWindow });
  app.on('will-quit', () => transcribeManager.dispose());

  // Voice changer (F3): same shape again, a third independent manager. It
  // also owns the voice-profile store (userData/voice-profiles.json).
  const voiceManager = createVoiceManager({ userDataDir: app.getPath('userData') });
  registerVoiceIpc({ ipcMain, manager: voiceManager, getWin: () => mainWindow });
  app.on('will-quit', () => voiceManager.dispose());

  // Align Lyrics (F6): same shape again, a fourth independent manager. Its own
  // utility process and its own model directory, so cancelling or quitting an
  // alignment cannot touch a transcription or a stem separation.
  const alignManager = createAlignManager({ userDataDir: app.getPath('userData') });
  registerAlignIpc({ ipcMain, manager: alignManager, getWin: () => mainWindow });
  app.on('will-quit', () => alignManager.dispose());

  // The ONE milestone main can honestly send. Everything above — the splash,
  // the editor window, the IPC, the four managers — happens in this single
  // synchronous block, and the main process cannot dispatch the splash page's
  // 'did-finish-load' while it runs: only the last value written here can ever
  // reach the page. So it is written once, after the work it names. The stages
  // the user sees DURING the wait hang off the editor's own async events, in
  // electron/splash.cjs.
  splash.progress(40, 'Services and audio engines ready.');

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      // No splash on this path: the app is already warm, there is no init left
      // to report, and the window shows itself as it always did.
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
