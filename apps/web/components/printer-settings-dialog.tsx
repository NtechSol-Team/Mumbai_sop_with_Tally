'use client';

import { useCallback, useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { Banknote, Bluetooth, Printer, RefreshCw, Unplug } from 'lucide-react';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { cn } from '@/lib/utils';
import {
  getPrinterSettings,
  savePrinterSettings,
  type PrinterSettings,
  type TransportKind,
} from '@/lib/print/printer-settings';
import { androidPrinter, hasAndroidBridge, type BridgePrinter, type BridgeStatus } from '@/lib/print/android-bridge';
import { webBluetoothSupported, webBtPrinter } from '@/lib/print/web-bluetooth';
import { resolveRawTransport, printRaw } from '@/lib/print/print-manager';
import { testSlipBytes } from '@/lib/print/receipt-escpos';
import { printOpenDrawer } from '@/lib/print';

/**
 * Receipt-printer setup for this till. Windows tills can ignore it (system
 * dialog remains the default there); Android tablets use it to connect the
 * Bluetooth printer — through the Mumbai ERP Print Bridge app when installed, or
 * Web Bluetooth for BLE-capable printers in plain Chrome.
 */
export function PrinterSettingsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const [settings, setSettings] = useState<PrinterSettings>(getPrinterSettings);
  const [printers, setPrinters] = useState<BridgePrinter[]>([]);
  const [bridgeStatus, setBridgeStatus] = useState<BridgeStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const bridge = hasAndroidBridge();
  const webBt = webBluetoothSupported();

  const update = (patch: Partial<PrinterSettings>) => setSettings(savePrinterSettings(patch));

  const refreshBridge = useCallback(async () => {
    if (!hasAndroidBridge()) return;
    try {
      const [list, status] = await Promise.all([androidPrinter.getPairedPrinters(), androidPrinter.getStatus()]);
      // Printer-class devices first so the right one is usually on top.
      setPrinters([...list].sort((a, b) => Number(b.likelyPrinter) - Number(a.likelyPrinter)));
      setBridgeStatus(status);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not reach the printer bridge');
    }
  }, []);

  useEffect(() => {
    if (open) {
      setSettings(getPrinterSettings());
      void refreshBridge();
    }
  }, [open, refreshBridge]);

  const connectBridge = async (mac: string, name: string) => {
    setBusy(mac);
    try {
      const status = await androidPrinter.connect(mac);
      setBridgeStatus(status);
      update({ androidMac: mac, androidName: name });
      toast.success(`Connected to ${name}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Connection failed');
    } finally {
      setBusy(null);
    }
  };

  // allDevices reopens the unfiltered chooser: the normal one is narrowed to
  // known printer services/names, which hides printers advertising neither.
  const pairWebBt = async (allDevices = false) => {
    setBusy(allDevices ? 'webbt-all' : 'webbt');
    try {
      const dev = await webBtPrinter.pick({ allDevices });
      update({ webBtDeviceId: dev.id, webBtName: dev.name });
      toast.success(`Connected to ${dev.name}`);
    } catch (e) {
      // User closing the chooser throws — don't nag about that.
      const msg = e instanceof Error ? e.message : String(e);
      if (!/cancelled|canceled|chooser|No device selected/i.test(msg)) toast.error(msg);
    } finally {
      setBusy(null);
    }
  };

  const testPrint = async () => {
    setBusy('test');
    try {
      const res = await printRaw(await testSlipBytes(settings), { statusCheck: false });
      if (res.ok) toast.success('Test page sent to printer');
      else toast.error(res.error ?? 'Test print failed');
    } finally {
      setBusy(null);
    }
  };

  const openDrawer = async () => {
    setBusy('drawer');
    try {
      const res = await printOpenDrawer();
      if (res.ok) toast.success('Drawer-open signal sent');
      else toast.error(res.error ?? 'Could not open the drawer');
    } finally {
      setBusy(null);
    }
  };

  const active = resolveRawTransport(settings);
  const activeLabel =
    active === 'android'
      ? `Bluetooth printer app${bridgeStatus?.name ? ` — ${bridgeStatus.name}` : ''}`
      : active === 'webbt'
        ? `Web Bluetooth${settings.webBtName ? ` — ${settings.webBtName}` : ''}`
        : 'System print dialog (browser)';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-md">
        <DialogHeader><DialogTitle>Printer Settings</DialogTitle></DialogHeader>

        <div className={cn('rounded-md px-3 py-2 text-caption font-medium',
          active ? 'bg-success/10 text-success' : 'bg-muted text-muted-foreground')}>
          Receipts print via: {activeLabel}
        </div>

        <div className="space-y-3">
          <label className="block">
            <span className="text-caption font-medium">Print method</span>
            <Select
              className="mt-1"
              value={settings.transport}
              onChange={(e) => update({ transport: e.target.value as TransportKind })}
            >
              <option value="auto">Auto (recommended)</option>
              <option value="android" disabled={!bridge}>
                Bluetooth printer app{bridge ? '' : ' — not detected'}
              </option>
              <option value="webbt" disabled={!webBt}>
                Web Bluetooth (BLE){webBt ? '' : ' — not supported here'}
              </option>
              <option value="system">System print dialog</option>
            </Select>
          </label>

          <label className="block">
            <span className="text-caption font-medium">Paper width</span>
            <Select
              className="mt-1"
              value={String(settings.paperWidthMm)}
              onChange={(e) => update({ paperWidthMm: Number(e.target.value) as 58 | 80 })}
            >
              <option value="80">80 mm (48 characters)</option>
              <option value="58">58 mm (32 characters)</option>
            </Select>
          </label>

          <label className="flex items-center gap-2 text-body">
            <input type="checkbox" className="h-4 w-4 accent-[hsl(var(--primary))]"
              checked={settings.printLogo} onChange={(e) => update({ printLogo: e.target.checked })} />
            Print store logo on receipts
          </label>
          <label className="flex items-center gap-2 text-body">
            <input type="checkbox" className="h-4 w-4 accent-[hsl(var(--primary))]"
              checked={settings.printBarcode} onChange={(e) => update({ printBarcode: e.target.checked })} />
            Print receipt-number barcode
          </label>
        </div>

        {bridge && (
          <div className="space-y-2 rounded-md border border-border p-3">
            <div className="flex items-center justify-between">
              <p className="text-label font-semibold">Paired Bluetooth printers</p>
              <Button variant="ghost" size="icon" title="Refresh list" onClick={() => void refreshBridge()}>
                <RefreshCw className="h-4 w-4" />
              </Button>
            </div>
            {bridgeStatus?.connected && (
              <div className="flex items-center justify-between rounded bg-success/10 px-2 py-1.5 text-caption text-success">
                <span>Connected: {bridgeStatus.name ?? bridgeStatus.mac}</span>
                <button
                  className="inline-flex items-center gap-1 font-medium underline"
                  onClick={() => void androidPrinter.disconnect().then(refreshBridge)}
                >
                  <Unplug className="h-3 w-3" /> Disconnect
                </button>
              </div>
            )}
            {bridgeStatus?.paperOut && (
              <p className="rounded bg-danger/10 px-2 py-1.5 text-caption font-medium text-danger">Printer is out of paper</p>
            )}
            <div className="max-h-44 space-y-1 overflow-y-auto">
              {printers.length === 0 && (
                <p className="text-caption text-muted-foreground">
                  No paired devices. Pair the printer in Android Settings → Bluetooth first, then refresh.
                </p>
              )}
              {printers.map((p) => (
                <button
                  key={p.mac}
                  disabled={busy != null}
                  onClick={() => void connectBridge(p.mac, p.name)}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-md border border-border px-2 py-1.5 text-left text-body hover:bg-surface',
                    bridgeStatus?.mac === p.mac && bridgeStatus.connected && 'border-success bg-success/5',
                  )}
                >
                  <Printer className={cn('h-4 w-4 shrink-0', p.likelyPrinter ? 'text-primary' : 'text-muted-foreground')} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{p.name}</span>
                    <span className="block text-caption text-muted-foreground">{p.mac}</span>
                  </span>
                  {busy === p.mac && <span className="text-caption text-muted-foreground">Connecting…</span>}
                </button>
              ))}
            </div>
          </div>
        )}

        {!bridge && webBt && (
          <div className="space-y-2 rounded-md border border-border p-3">
            <p className="text-label font-semibold">Web Bluetooth printer</p>
            <p className="text-caption text-muted-foreground">
              Works with BLE-capable printers straight from Chrome. If your printer never shows up
              or won't print, install the Mumbai ERP Print Bridge app — it supports every Bluetooth printer.
            </p>
            {settings.webBtName && (
              <p className="text-caption">
                Saved printer: <span className="font-medium">{settings.webBtName}</span>
                {webBtPrinter.connectedName ? ' (connected)' : ' (will reconnect on print)'}
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" loading={busy === 'webbt'} onClick={() => void pairWebBt()}>
                <Bluetooth className="h-4 w-4" /> {settings.webBtName ? 'Change printer…' : 'Connect printer…'}
              </Button>
              <Button variant="ghost" size="sm" loading={busy === 'webbt-all'} onClick={() => void pairWebBt(true)}>
                Printer not listed?
              </Button>
            </div>
            <p className="text-caption text-muted-foreground">
              The chooser only lists likely printers. If yours isn&apos;t there, use
              <span className="font-medium"> Printer not listed?</span> to show every Bluetooth device in range.
            </p>
          </div>
        )}

        {active && (
          <p className="text-caption text-muted-foreground">
            Drawer not opening on sale? Try <span className="font-medium">Open Drawer</span> below first — if that
            doesn&apos;t pop it either, the drawer cable isn&apos;t plugged into the printer (or this printer has no
            drawer port). If it does open, the cashier only needs it after a cash-taking sale.
          </p>
        )}

        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>Close</Button>
          <Button variant="secondary" loading={busy === 'drawer'} disabled={!active}
            title={active ? undefined : 'Connect a Bluetooth printer first'}
            onClick={() => void openDrawer()}>
            <Banknote className="h-4 w-4" /> Open Drawer
          </Button>
          <Button loading={busy === 'test'} disabled={!active} title={active ? undefined : 'Connect a Bluetooth printer first'}
            onClick={() => void testPrint()}>
            <Printer className="h-4 w-4" /> Test print
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
