'use client';

/**
 * Typed client for the `window.AndroidPrinter` JavaScript interface injected
 * by the Mumbai ERP Print Bridge wrapper app (apps/android-print-bridge).
 *
 * The native side must never block the WebView's JS thread on Bluetooth I/O,
 * so the bridge is asynchronous: we call `AndroidPrinter.request(id, method,
 * paramsJson)`, the app does the work on a background executor, and delivers
 * the result by invoking `window.__mumbaiErpPrinterBridgeResolve(id, resultJson)`.
 * This module turns that round-trip into ordinary Promises.
 */

export interface BridgePrinter {
  name: string;
  mac: string;
  /** True when Android reports the device's Bluetooth class as an imaging device. */
  likelyPrinter: boolean;
}

export interface BridgeStatus {
  connected: boolean;
  mac: string | null;
  name: string | null;
  /** Best-effort DLE EOT status — null when the printer didn't answer in time. */
  online: boolean | null;
  paperOut: boolean | null;
  coverOpen: boolean | null;
}

interface RawAndroidPrinter {
  request(id: string, method: string, paramsJson: string): void;
  getBridgeVersion(): string;
}

interface BridgeResult {
  ok: boolean;
  data?: unknown;
  error?: string;
}

declare global {
  interface Window {
    AndroidPrinter?: RawAndroidPrinter;
    __mumbaiErpPrinterBridgeResolve?: (id: string, resultJson: string) => void;
  }
}

/** True when running inside the Mumbai ERP Print Bridge Android app. */
export function hasAndroidBridge(): boolean {
  return typeof window !== 'undefined' && typeof window.AndroidPrinter?.request === 'function';
}

const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: number }>();
let seq = 0;

function installResolver(): void {
  if (window.__mumbaiErpPrinterBridgeResolve) return;
  window.__mumbaiErpPrinterBridgeResolve = (id, resultJson) => {
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    clearTimeout(entry.timer);
    try {
      const res = JSON.parse(resultJson) as BridgeResult;
      if (res.ok) entry.resolve(res.data);
      else entry.reject(new Error(res.error || 'Printer bridge error'));
    } catch {
      entry.reject(new Error('Malformed response from printer bridge'));
    }
  };
}

function call<T>(method: string, params: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<T> {
  if (!hasAndroidBridge()) return Promise.reject(new Error('Android printer bridge not available'));
  installResolver();
  const id = `p${++seq}-${Date.now()}`;
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Printer bridge timed out (${method})`));
    }, timeoutMs);
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
    try {
      window.AndroidPrinter!.request(id, method, JSON.stringify(params));
    } catch (e) {
      pending.delete(id);
      clearTimeout(timer);
      reject(e instanceof Error ? e : new Error(String(e)));
    }
  });
}

function toBase64(bytes: Uint8Array): string {
  let bin = '';
  const CHUNK = 0x8000; // avoid call-stack limits on large receipts/images
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

export const androidPrinter = {
  /** Paired Bluetooth devices — the user pairs the printer once in Android Settings. */
  getPairedPrinters: () => call<BridgePrinter[]>('getPairedPrinters'),

  /** Open (or re-open) the SPP connection; the app remembers the MAC for reconnects. */
  connect: (mac: string) => call<BridgeStatus>('connect', { mac }, 45_000),

  disconnect: () => call<void>('disconnect'),

  /** Send raw ESC/POS bytes. The app auto-reconnects to the saved printer if needed. */
  write: (bytes: Uint8Array) => call<void>('write', { data: toBase64(bytes) }, 60_000),

  getStatus: () => call<BridgeStatus>('getStatus', {}, 15_000),

  /** Hand a PDF (e.g. an A4 GST bill) to Android to open in the system viewer. */
  openPdf: async (blob: Blob, filename: string) => {
    const buf = new Uint8Array(await blob.arrayBuffer());
    return call<void>('openPdf', { data: toBase64(buf), filename }, 30_000);
  },
};
