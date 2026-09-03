'use strict';

const path = require('node:path');
const { Tray, Menu, nativeImage } = require('electron');
const configStore = require('./config-store');
const printerManager = require('./printer-manager');

const ICON_PATH = path.join(__dirname, '..', 'build', 'tray-32.png');

const STATUS_LABEL = {
  connected: 'Connected',
  connecting: 'Connecting…',
  disconnected: 'Disconnected',
  'auth-expired': 'Sign-in expired',
};

let tray = null;
let currentStatus = 'disconnected';
let rebuildSeq = 0; // guards against a slow (PowerShell-backed) listPrinters() resolving out of order and clobbering a newer rebuild

function build(handlers) {
  tray = new Tray(nativeImage.createFromPath(ICON_PATH));
  tray.setToolTip('Mumbai ERP Print Agent');
  rebuild(handlers);
  return tray;
}

async function rebuild(handlers) {
  if (!tray) return;
  const seq = ++rebuildSeq;
  const cfg = configStore.getConfig();
  const printers = await printerManager.listPrinters();
  if (seq !== rebuildSeq || !tray) return; // superseded by a later call, or the tray was torn down while we awaited

  const printerItems = printers.length
    ? printers.map((p) => ({
        label: p.name,
        type: 'radio',
        checked: cfg.printerInterface === 'system' && p.name === cfg.printerName,
        click: () => handlers.onSelectPrinter(p.name),
      }))
    : [{ label: 'No printers found', enabled: false }];

  const menu = Menu.buildFromTemplate([
    { label: `● ${STATUS_LABEL[currentStatus] || currentStatus}`, enabled: false },
    { label: cfg.printerInterface === 'network' ? `Printer: ${cfg.printerNetworkAddress || 'not set'} (LAN)` : `Printer: ${cfg.printerName || 'not set'}`, enabled: false },
    { type: 'separator' },
    { label: 'Select Printer', submenu: printerItems },
    { label: 'Test Print', click: handlers.onTestPrint },
    { type: 'separator' },
    { label: 'Configure Server / Sign in…', click: handlers.onOpenSettings },
    { type: 'separator' },
    { label: 'Exit', click: handlers.onQuit },
  ]);
  tray.setContextMenu(menu);
  tray.setToolTip(`Mumbai ERP Print Agent — ${STATUS_LABEL[currentStatus] || currentStatus}`);
}

function setStatus(status, handlers) {
  currentStatus = status;
  rebuild(handlers);
}

module.exports = { build, rebuild, setStatus };
