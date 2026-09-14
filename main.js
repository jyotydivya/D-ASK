const { app, BrowserWindow, screen, ipcMain, Tray, Menu, session } = require('electron');
const path = require('path');
const { createServer } = require('http');
const { parse } = require('url');
const next = require('next');

const dev = process.env.NODE_ENV !== 'production';
const nextApp = next({ dev, dir: __dirname });
const handle = nextApp.getRequestHandler();

let mainWindow;
let tray = null;

async function createWindow() {
  await nextApp.prepare();

  const port = process.env.PORT || 3000;
  const server = createServer((req, res) => {
    const parsedUrl = parse(req.url, true);
    handle(req, res, parsedUrl);
  });
  
  server.listen(port, (err) => {
    if (err) throw err;
    console.log(`> Ready on http://localhost:${port}`);
  });

  // Grant microphone and camera permissions automatically
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    if (permission === 'media') {
      callback(true);
    } else {
      callback(false);
    }
  });

  const { width, height } = screen.getPrimaryDisplay().workAreaSize;

  // JARVIS Orb style full screen borderless window
  mainWindow = new BrowserWindow({
    width: width,
    height: height,
    x: 0,
    y: 0,
    transparent: false,
    frame: false,
    hasShadow: false,
    resizable: true,
    alwaysOnTop: false,
    skipTaskbar: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true
    }
  });
  
  mainWindow.maximize();

  mainWindow.loadURL(`http://localhost:${port}`);

  // Tray icon (using public/favicon.ico as fallback if exists)
  try {
    tray = new Tray(path.join(__dirname, 'public/favicon.ico'));
    const contextMenu = Menu.buildFromTemplate([
      { label: 'Show D-ASK', click: () => mainWindow.show() },
      { label: 'Hide D-ASK', click: () => mainWindow.hide() },
      { label: 'Quit', click: () => { app.isQuiting = true; app.quit(); } }
    ]);
    tray.setToolTip('D-ASK Orb');
    tray.setContextMenu(contextMenu);
  } catch(e) {
    console.warn("Could not load tray icon.", e.message);
  }

  mainWindow.on('close', function (event) {
    if (!app.isQuiting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
