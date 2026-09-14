'use strict';

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, shell } = require('electron');
const { desktopConfigPath, loginItemSettings } = require('./desktop');
const config = require('./config');

// Keep the old application identity for upgrade/single-instance compatibility.
app.setPath('userData', path.join(app.getPath('appData'), 'mumbai-erp-tally-agent'));
config.setStorePath(desktopConfigPath({ override: process.env.MUMBAI_ERP_TALLY_CONFIG,
  home: os.homedir(), appData: app.getPath('appData'), userData: app.getPath('userData') }));
const smokeTest = process.argv.includes('--smoke-test');
const haveLock = app.requestSingleInstanceLock();
if (!haveLock) app.quit();

const syncLoop = require('./sync-loop');
const tally = require('./tally-client');

let tray = null;
let settingsWin = null;
let latest = syncLoop.getState();

const iconPath = (name) => path.join(__dirname, '..', 'build', name);

function statusLine() {
  try { if (!config.isConfigured()) return 'Not paired — open Settings'; }
  catch { return 'Invalid configuration — open Settings'; }
  if (!latest.erpOk) return 'Cannot reach Arthx ERP';
  if (!latest.tallyOk) return latest.tallyReachable ? 'ERP OK · Tally company not verified' : 'ERP OK · Tally not responding';
  if (latest.lastError) return 'Sync needs attention — open Settings';
  if (latest.failed) return `Online · ${latest.failed} voucher(s) failed`;
  return latest.pushed ? `Online · pushed ${latest.pushed}` : 'Online · nothing pending';
}

function rebuildTray() {
  if (!tray) return;
  tray.setToolTip(`Arthx ERP Tally Sync — ${statusLine()}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: statusLine(), enabled: false },
    { type: 'separator' },
    { label: 'Sync now', click: () => syncLoop.runOnce() },
    { label: 'Settings…', click: openSettings },
    { type: 'separator' },
    { label: 'Quit', click: () => { syncLoop.stop(); app.quit(); } },
  ]));
}

function openSettings() {
  if (settingsWin) { if (settingsWin.isMinimized()) settingsWin.restore(); settingsWin.show(); settingsWin.focus(); return; }
  settingsWin = new BrowserWindow({
    width: 600, height: 900, minWidth: 460, minHeight: 640, resizable: true, icon: iconPath('icon.png'), title: 'Arthx ERP Tally Sync — Settings',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  settingsWin.setMenuBarVisibility(false);
  settingsWin.loadFile(path.join(__dirname, '..', 'renderer', 'settings.html'));
  settingsWin.on('closed', () => { settingsWin = null; });
}

ipcMain.handle('config:get', () => ({ ...config.get(), agentVersion: app.getVersion(), companySource: config.companySource(), startupError }));
ipcMain.handle('config:save', (_e, patch) => { const c = config.set(patch); configureStartup(c.startWithWindows); syncLoop.start(onState); return c; });
function connectionDraft(draft = {}) {
  const c = { ...config.get() };
  for (const key of ['tallyHost', 'tallyPort', 'tallyCompany']) if (draft[key] !== undefined) c[key] = draft[key];
  config.validate(c);
  return c;
}
ipcMain.handle('tally:companies', (_e, draft) => tally.discoverCompanies(connectionDraft(draft)));
ipcMain.handle('tally:ping', async (_e, draft) => {
  const p = await tally.ping(connectionDraft(draft));
  return { ok: p.reachable && p.companyOpen && !p.error, ...p };
});
ipcMain.handle('sync:now', async () => { await syncLoop.runOnce(); return syncLoop.getState(); });
ipcMain.handle('state:get', () => syncLoop.getState());
ipcMain.handle('open:external', (_e, url) => shell.openExternal(url));

function onState(s) {
  latest = s;
  rebuildTray();
  if (settingsWin) settingsWin.webContents.send('state', s);
}

let startupError = null;
function configureStartup(enabled) {
  startupError = null;
  if (!app.isPackaged || process.platform !== 'win32' || smokeTest) return;
  try {
    app.setLoginItemSettings(loginItemSettings(app.getPath('exe'), enabled));
  } catch (error) {
    startupError = `Could not update Windows startup: ${error.message}`;
  }
}

app.on('window-all-closed', () => {}); // Closing Settings leaves the tray agent running.
app.on('before-quit', () => syncLoop.stop());
app.on('second-instance', () => { if (app.isReady()) openSettings(); });
app.on('activate', () => { if (app.isReady()) openSettings(); });

if (haveLock) app.whenReady().then(async () => {
  const img = nativeImage.createFromPath(iconPath('icon.png'));
  if (img.isEmpty()) throw new Error('The packaged tray icon is missing. Reinstall the agent.');
  tray = new Tray(img.resize({ width: 16, height: 16 }));
  rebuildTray();
  tray.on('click', openSettings);

  if (smokeTest) {
    // Native Windows CI check: no startup registration, credentials or sync writes.
    openSettings();
    await new Promise((resolve, reject) => {
      settingsWin.webContents.once('did-finish-load', resolve);
      settingsWin.webContents.once('did-fail-load', (_event, code, description) => reject(new Error(`${code}: ${description}`)));
    });
    const preloadReady = await settingsWin.webContents.executeJavaScript('typeof window.agent?.getConfig === "function"');
    if (!preloadReady) throw new Error('The packaged preload bridge did not load.');
    fs.writeFileSync(process.env.ARTHX_SMOKE_OUTPUT || path.join(os.tmpdir(), 'arthx-tally-smoke.json'),
      JSON.stringify({ ok: true, platform: process.platform, version: app.getVersion(), packaged: app.isPackaged, preloadReady, iconReady: !img.isEmpty() }));
    app.exit(0);
    return;
  }

  try { configureStartup(config.get().startWithWindows); } catch { /* Settings reports invalid config. */ }
  syncLoop.start(onState);
  try { if (!process.argv.includes('--autostart') || !config.isConfigured() || startupError) openSettings(); }
  catch { openSettings(); }
}).catch((error) => {
  console.error(error.message);
  app.exit(1);
});
