'use strict';

const path = require('node:path');
const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, shell } = require('electron');
const AutoLaunch = require('auto-launch');
const config = require('./config');
const syncLoop = require('./sync-loop');
const tally = require('./tally-client');

let tray = null;
let settingsWin = null;
let latest = syncLoop.getState();

const iconPath = (name) => path.join(__dirname, '..', 'build', name);

function statusLine() {
  if (!config.isConfigured()) return 'Not paired — open Settings';
  if (!latest.erpOk) return 'Cannot reach Mumbai ERP';
  if (!latest.tallyOk) return 'ERP OK · Tally not responding';
  if (latest.failed) return `Online · ${latest.failed} voucher(s) failed`;
  return latest.pushed ? `Online · pushed ${latest.pushed}` : 'Online · nothing pending';
}

function rebuildTray() {
  if (!tray) return;
  tray.setToolTip(`Mumbai ERP Tally Sync — ${statusLine()}`);
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
  if (settingsWin) { settingsWin.focus(); return; }
  settingsWin = new BrowserWindow({
    width: 460, height: 620, resizable: false, title: 'Mumbai ERP Tally Sync — Settings',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  settingsWin.setMenuBarVisibility(false);
  settingsWin.loadFile(path.join(__dirname, '..', 'renderer', 'settings.html'));
  settingsWin.on('closed', () => { settingsWin = null; });
}

ipcMain.handle('config:get', () => config.get());
ipcMain.handle('config:save', (_e, patch) => { const c = config.set(patch); syncLoop.start(onState); return c; });
ipcMain.handle('tally:ping', () => tally.ping());
ipcMain.handle('sync:now', async () => { await syncLoop.runOnce(); return syncLoop.getState(); });
ipcMain.handle('state:get', () => syncLoop.getState());
ipcMain.handle('open:external', (_e, url) => shell.openExternal(url));

function onState(s) {
  latest = s;
  rebuildTray();
  if (settingsWin) settingsWin.webContents.send('state', s);
}

app.on('window-all-closed', (e) => { e.preventDefault(); }); // tray app — never quit on window close
app.setLoginItemSettings?.({ openAtLogin: true });

app.whenReady().then(async () => {
  try {
    await new AutoLaunch({ name: 'Mumbai ERP Tally Sync Agent', path: app.getPath('exe') }).enable();
  } catch { /* non-fatal */ }

  const img = nativeImage.createFromPath(iconPath('tray-16.png'));
  tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img);
  rebuildTray();
  tray.on('click', openSettings);

  syncLoop.start(onState);
  if (!config.isConfigured()) openSettings();
});
