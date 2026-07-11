const { app, BrowserWindow } = require('electron');
const { execSync } = require('child_process');
const path = require('path');

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
      webPreferences: { contextIsolation: true }
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
