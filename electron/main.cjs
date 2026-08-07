const { app, BrowserWindow, dialog, ipcMain, session } = require('electron');
const path = require('node:path');
const { registerIpc } = require('./ipc.cjs');
const { createCloseGuard } = require('./closeGuard.cjs');
const { setAppPaths } = require('./writePathPolicy.cjs');
const { isMediaAllowed } = require('./permissionPolicy.cjs');
const { isPackagedGateOpen } = require('./prodGate.cjs');
const { createStemManager, registerStemIpc } = require('./stemManager.cjs');
const { runStemSelftest, parseStemSelftestArgs } = require('./stemSelftest.cjs');

app.setName('audition_app');

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

function createWindow() {
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
    win.show();
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

  createWindow();
  registerIpc(() => mainWindow);

  // Stem separation (S1): the manager owns the model download and the
  // inference utility-process lifetime; dispose on quit guarantees no orphan
  // inference process outlives the app (plan ruling 7).
  const stemManager = createStemManager({ userDataDir: app.getPath('userData') });
  registerStemIpc({ ipcMain, manager: stemManager, getWin: () => mainWindow });
  app.on('will-quit', () => stemManager.dispose());

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
