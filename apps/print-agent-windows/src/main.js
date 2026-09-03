'use strict';

const path = require('node:path');
const { app, BrowserWindow, ipcMain, Menu } = require('electron');
const AutoLaunch = require('auto-launch');

const configStore = require('./config-store');
const apiClient = require('./api-client');
const socketClient = require('./socket-client');
const printerManager = require('./printer-manager');
const receiptBuilder = require('./receipt-builder');
const tray = require('./tray');
const notify = require('./notify');

// One instance only -- a second launch (e.g. Windows re-running the startup
// entry after a fast user-switch) just focuses the existing tray app's
// settings window instead of opening a second socket connection that would
// double-print every order.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => openSettingsWindow());
}

// No dock/taskbar presence -- this runs purely from the tray.
if (app.dock) app.dock.hide();

let settingsWindow = null;

function openSettingsWindow() {
  if (settingsWindow) {
    settingsWindow.show();
    settingsWindow.focus();
    return;
  }
  settingsWindow = new BrowserWindow({
    width: 460,
    height: 720,
    resizable: false,
    title: 'Print Agent Settings',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  Menu.setApplicationMenu(null);
  settingsWindow.loadFile(path.join(__dirname, '..', 'renderer', 'settings.html'));
  settingsWindow.on('closed', () => { settingsWindow = null; });
}

const trayHandlers = {
  onOpenSettings: () => openSettingsWindow(),
  onTestPrint: () => runTestPrint(),
  onSelectPrinter: (printerName) => {
    configStore.setPrinter({ printerInterface: 'system', printerName });
    tray.rebuild(trayHandlers);
  },
  onQuit: () => app.quit(),
};

async function runTestPrint() {
  try {
    const lines = receiptBuilder.buildNewOrderReceipt({
      orderNumber: 'TEST-0000',
      outletName: 'Test Print',
      isGstBill: false,
      orderDate: new Date().toISOString(),
      items: [{ name: 'Test Item', unit: 'Pc', qty: 1, price: 0 }],
    });
    const { paperWidth } = configStore.getConfig();
    const buffer = printerManager.buildEscPosBuffer(lines, { paperWidth });
    await printerManager.sendToConfiguredPrinter(buffer);
    notify.notify('Print Agent', 'Test slip sent.');
    return { ok: true };
  } catch (err) {
    notify.notify('Print Agent', `Test print failed: ${err.message}`);
    throw err;
  }
}

/** Logs in with the saved refresh token (if any) and starts the socket connection. */
async function connect() {
  try {
    const accessToken = await apiClient.resumeSession();
    if (accessToken) socketClient.start();
    else tray.setStatus('disconnected', trayHandlers);
  } catch (err) {
    console.error('[main] failed to resume session', err.message);
    tray.setStatus('auth-expired', trayHandlers);
  }
}

function wireIpc() {
  ipcMain.handle('config:get', () => configStore.getConfig());

  ipcMain.handle('config:save-server', (_e, serverUrl) => {
    configStore.setServerUrl(serverUrl);
  });

  ipcMain.handle('config:login', async (_e, { identifier, password }) => {
    await apiClient.login(identifier, password);
    socketClient.stop();
    socketClient.start();
  });

  ipcMain.handle('config:logout', () => {
    socketClient.stop();
    apiClient.logout();
    tray.setStatus('disconnected', trayHandlers);
  });

  ipcMain.handle('printer:list', () => printerManager.listPrinters());

  ipcMain.handle('printer:save', (_e, settings) => {
    configStore.setPrinter(settings);
    tray.rebuild(trayHandlers);
  });

  ipcMain.handle('printer:test', () => runTestPrint());

  ipcMain.handle('bluetooth:open-pairing', () => printerManager.openBluetoothPairingSettings());
  ipcMain.handle('bluetooth:detect', () => printerManager.detectBluetoothCandidates());
  ipcMain.handle('bluetooth:install', async (_e, { portName, printerName }) => {
    await printerManager.installBluetoothPrinter(portName, printerName);
    tray.rebuild(trayHandlers); // the new printer should now show up in Select Printer
  });

  ipcMain.handle('status:get', () => socketClient.status);
}

function wireSocketEvents() {
  socketClient.on('status', (status) => {
    tray.setStatus(status, trayHandlers);
    if (settingsWindow) settingsWindow.webContents.send('status:changed', status);
    if (status === 'connected') notify.connected();
    if (status === 'disconnected') notify.disconnected();
  });
  socketClient.on('printed', (description) => notify.printSuccess(description));
  socketClient.on('print-error', (info) => notify.printFailure(info));
}

async function setupAutoLaunch() {
  // Windows only -- packaged NSIS build registers the installed .exe path;
  // running unpackaged (`npm start`) skips this rather than registering a
  // dev-tree path that won't exist after the next `npm install`.
  if (process.platform !== 'win32' || !app.isPackaged) return;
  const autoLaunch = new AutoLaunch({ name: 'Mumbai ERP Print Agent', path: app.getPath('exe') });
  try {
    const enabled = await autoLaunch.isEnabled();
    if (!enabled) await autoLaunch.enable();
  } catch (err) {
    console.error('[main] failed to register startup entry', err.message);
  }
}

app.whenReady().then(async () => {
  tray.build(trayHandlers);
  wireIpc();
  wireSocketEvents();
  await setupAutoLaunch();
  await connect();

  // Open Settings on first-ever run (no server configured yet) so the app
  // isn't a silent icon with nothing to click on setup.
  if (!configStore.getConfig().serverUrl) openSettingsWindow();
});

// Tray app: closing the settings window (or having none open) must never quit
// the app the way it would for a normal window-based app on Windows/Linux.
app.on('window-all-closed', (e) => e.preventDefault());

app.on('before-quit', () => {
  socketClient.stop();
  apiClient.stop();
});
