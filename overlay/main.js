const { app, BrowserWindow, ipcMain, desktopCapturer, screen } = require('electron');
const { execSync } = require('child_process');
const path = require('path');

// Screenshot av skarmens topp-remsa (Dota-topbaren) for fiendehjalte-avlasning.
// BARA remsan lamnar datorn — aldrig hela skarmen. Se preload.js + servern.
ipcMain.handle('dhs-capture-top-strip', async () => {
  try {
    const disp = screen.getPrimaryDisplay();
    const size = {
      width: Math.round(disp.size.width * disp.scaleFactor),
      height: Math.round(disp.size.height * disp.scaleFactor)
    };
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: size });
    const src = sources.find(s => String(s.display_id) === String(disp.id)) || sources[0];
    if (!src || src.thumbnail.isEmpty()) return null;
    const stripH = Math.max(60, Math.round(size.width * 80 / 1919)); // samma proportion som servern raknar med
    const strip = src.thumbnail.crop({ x: 0, y: 0, width: size.width, height: stripH });
    return strip.toPNG().toString('base64');
  } catch (e) {
    return null; // servern hanterar utebliven bild som "kunde inte lasa av"
  }
});

// Steam skriver den just nu inloggade anvandarens 32-bitars account_id hit —
// sa widgeten kan sjalv veta vem den kors som, utan nagon per-spelare-config.
function getSteamAccountId() {
  try {
    const out = execSync('reg query "HKCU\\Software\\Valve\\Steam\\ActiveProcess" /v ActiveUser', { encoding: 'utf8' });
    const m = out.match(/REG_DWORD\s+0x([0-9a-fA-F]+)/);
    if (!m) return null;
    const id = parseInt(m[1], 16);
    return id > 0 ? id : null; // 0 = ingen inloggad
  } catch (e) {
    return null; // Steam kors inte, eller nyckeln finns inte an
  }
}

// En instans i taget — ett klick pa dhsoverlay://-lanken medan appen redan kors
// ska bara vakna den befintliga instansen, inte oppna ett andra fonster.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) loadWithCurrentAccount(); // uppdatera direkt vid nytt klick, ifall Steam-kontot bytts
  });

  let win;
  let lastAccountId = null;

  function loadWithCurrentAccount() {
    const accountId = getSteamAccountId();
    if (accountId === lastAccountId) return;
    lastAccountId = accountId;
    win.loadFile('index.html', { search: accountId ? 'accountId=' + accountId : '' });
  }

  function createWindow() {
    win = new BrowserWindow({
      width: 360,
      height: 140,
      x: 20,
      y: 20,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      focusable: false,
      hasShadow: false,
      webPreferences: { contextIsolation: true, preload: path.join(__dirname, 'preload.js') }
    });
    win.setIgnoreMouseEvents(true);
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    loadWithCurrentAccount();
    // Om Steam startas/loggas in EFTER widgeten — hamta ratt konto inom 10 sek utan omstart.
    setInterval(loadWithCurrentAccount, 10000);
  }

  app.whenReady().then(() => {
    // Registrerar dhsoverlay:// sa Hero Pool Manager-sidans lank kan starta/vacka
    // appen — sa spelaren aldrig behover leta ratt pa start.bat efter forsta gangen.
    app.setAsDefaultProtocolClient('dhsoverlay', process.execPath, [path.resolve(__dirname)]);
    createWindow();
  });
  app.on('window-all-closed', () => app.quit());
}
