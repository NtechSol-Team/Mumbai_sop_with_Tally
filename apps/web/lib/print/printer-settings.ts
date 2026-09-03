'use client';

/**
 * Persisted receipt-printer configuration (per device, in localStorage —
 * printers are physically attached to a till, so per-browser is correct).
 */

export type TransportKind = 'auto' | 'android' | 'webbt' | 'system';

export interface PrinterSettings {
  /**
   * auto    — Android bridge if present, else Web Bluetooth if paired, else system dialog.
   * android — force the wrapper-app bridge (Bluetooth Classic via vendor SDK).
   * webbt   — force Web Bluetooth (BLE printers, works in plain Chrome).
   * system  — force the old hidden-iframe window.print() path.
   */
  transport: TransportKind;
  paperWidthMm: 58 | 80;
  /** Print the store logo image at the top of receipts (slower on cheap printers). */
  printLogo: boolean;
  /** Print the receipt number as a CODE128 barcode at the bottom of receipts. */
  printBarcode: boolean;
  /** Last Web Bluetooth printer we connected to (for display / auto-reconnect). */
  webBtName?: string;
  webBtDeviceId?: string;
  /** Last bridge printer (MAC is also persisted natively by the Android app). */
  androidMac?: string;
  androidName?: string;
}

const KEY = 'mumbai-erp-printer-settings';

const DEFAULTS: PrinterSettings = {
  transport: 'auto',
  paperWidthMm: 80,
  printLogo: false,
  printBarcode: false,
};

export function getPrinterSettings(): PrinterSettings {
  if (typeof window === 'undefined') return { ...DEFAULTS };
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? { ...DEFAULTS, ...(JSON.parse(raw) as Partial<PrinterSettings>) } : { ...DEFAULTS };
  } catch {
    return { ...DEFAULTS };
  }
}

export function savePrinterSettings(patch: Partial<PrinterSettings>): PrinterSettings {
  const next = { ...getPrinterSettings(), ...patch };
  localStorage.setItem(KEY, JSON.stringify(next));
  return next;
}

/** Font-A characters per line for the configured paper width. */
export function colsFor(s: PrinterSettings): number {
  return s.paperWidthMm === 58 ? 32 : 48;
}

/** Printable dot width for the configured paper (203dpi heads). */
export function dotsFor(s: PrinterSettings): number {
  return s.paperWidthMm === 58 ? 384 : 576;
}
