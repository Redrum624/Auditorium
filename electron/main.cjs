const { app, BrowserWindow, dialog, ipcMain, session } = require('electron');
const path = require('node:path');
const { registerIpc } = require('./ipc.cjs');
const { createCloseGuard } = require('./closeGuard.cjs');
const { setAppPaths } = require('./writePathPolicy.cjs');
const { isMediaAllowed } = require('./permissionPolicy.cjs');

app.setName('audition_app');

let mainWindow = null;

// Native close guard (Task F8): the window's 'close' event is intercepted, the
// renderer reports its dirty-document count over IPC, and main shows a native
// Quit/Cancel message box when the count is non-zero. See closeGuard.cjs.
const closeGuard = createCloseGuard({ ipcMain, dialog });

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
      // TEST-ONLY: forward the smoke-harness flag into the sandboxed preload via
      // process.argv (the documented channel for sandboxed preloads). Empty in
      // any normal run, so the renderer never installs test hooks in production.
      additionalArguments: process.env.AUDITORIUM_TEST === '1' ? ['--auditorium-test'] : []
    }
  });

  win.once('ready-to-show', () => {
    win.show();
  });

  if (process.env.VITE_DEV_SERVER === '1') {
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

app.whenReady().then(() => {
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
