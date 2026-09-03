'use client';

/**
 * Web Bluetooth (BLE) transport for ESC/POS printers — the no-install path.
 *
 * Chrome on Android (and desktop) exposes BLE GATT only; it cannot open the
 * Bluetooth Classic SPP socket most receipt printers use, which is exactly why
 * the wrapper app exists. But many printers are dual-mode and additionally
 * expose a BLE "serial" service with a writable characteristic. When the
 * printer does, this transport drives it from the plain browser.
 *
 * The service/characteristic UUIDs below cover the BLE bridges found on the
 * common Chinese thermal-printer modules (JK/Goojprt/Xprinter/ISSC/HM-10…).
 *
 * Every stage of the connection lifecycle logs under the `[print/ble]` tag so a
 * dropped link can be diagnosed from the DevTools console instead of guessed at
 * — BLE modules drop an idle GATT link readily, and the drop is otherwise
 * completely silent.
 */

// ── Minimal Web Bluetooth typings (not in TS's dom lib) ─────────────────────
interface BluetoothRemoteGATTCharacteristicLike {
  uuid?: string;
  properties: { write: boolean; writeWithoutResponse: boolean; notify: boolean; indicate: boolean };
  writeValueWithResponse?: (data: Uint8Array) => Promise<void>;
  writeValueWithoutResponse?: (data: Uint8Array) => Promise<void>;
  writeValue: (data: Uint8Array) => Promise<void>;
  startNotifications?: () => Promise<unknown>;
}
interface BluetoothRemoteGATTServiceLike {
  uuid: string;
  getCharacteristics(): Promise<BluetoothRemoteGATTCharacteristicLike[]>;
}
interface BluetoothRemoteGATTServerLike {
  connected: boolean;
  connect(): Promise<BluetoothRemoteGATTServerLike>;
  disconnect(): void;
  getPrimaryServices(): Promise<BluetoothRemoteGATTServiceLike[]>;
}
export interface BluetoothDeviceLike {
  id: string;
  name?: string;
  gatt?: BluetoothRemoteGATTServerLike;
  addEventListener(type: 'gattserverdisconnected', listener: () => void): void;
}
interface BluetoothLike {
  requestDevice(options: {
    filters?: Array<{ services?: Array<string | number>; namePrefix?: string }>;
    acceptAllDevices?: boolean;
    optionalServices?: Array<string | number>;
  }): Promise<BluetoothDeviceLike>;
  getDevices?: () => Promise<BluetoothDeviceLike[]>;
}

function getBluetooth(): BluetoothLike | undefined {
  if (typeof navigator === 'undefined') return undefined;
  return (navigator as Navigator & { bluetooth?: BluetoothLike }).bluetooth;
}

export function webBluetoothSupported(): boolean {
  return !!getBluetooth();
}

// ── Diagnostics ──────────────────────────────────────────────────────────────
const TAG = '[print/ble]';
const log = (...a: unknown[]) => console.info(TAG, ...a);
const warn = (...a: unknown[]) => console.warn(TAG, ...a);
const fail = (...a: unknown[]) => console.error(TAG, ...a);

// ── Known printer BLE services ───────────────────────────────────────────────
const PRINTER_SERVICES: string[] = [
  '000018f0-0000-1000-8000-00805f9b34fb', // common ESC/POS BLE service (char 2af1)
  'e7810a71-73ae-499d-8c15-faa9aef0c3f2', // "BlueTooth Printer" module (char bef8d6c9)
  '49535343-fe7d-4ae5-8fa9-9fafd205e455', // ISSC/Microchip transparent UART
  '0000ff00-0000-1000-8000-00805f9b34fb', // Xprinter et al.
  '0000ffe0-0000-1000-8000-00805f9b34fb', // HM-10 style UART
  '0000fee7-0000-1000-8000-00805f9b34fb', // some Goojprt/JP modules
];

/**
 * Name prefixes thermal printers actually advertise, used to narrow the chooser
 * for the (common) printers that advertise no service UUIDs at all. Covers the
 * TVS-E RP series plus the usual OEM module names.
 */
const PRINTER_NAME_PREFIXES = ['RP', 'RPP', 'TVS', 'PT-', 'POS', 'XP-', 'MTP', 'MPT', 'GP-', 'JP', 'BlueTooth Printer', 'Printer'];

const WRITE_CHUNK = 120;   // safe for un-negotiated MTUs across cheap modules
const CHUNK_DELAY_MS = 15; // pacing for writeWithoutResponse fire-and-forget

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class WebBluetoothPrinter {
  private device: BluetoothDeviceLike | null = null;
  private characteristic: BluetoothRemoteGATTCharacteristicLike | null = null;
  /**
   * Devices already carrying our disconnect listener. `connectTo` runs again on
   * every redial, and addEventListener would stack a fresh copy each time —
   * leaking a handler per reconnect and firing N times on the next drop. A
   * WeakSet keeps this from pinning device objects in memory.
   */
  private listenerBound = new WeakSet<BluetoothDeviceLike>();
  /** When the current link came up, so a drop can report how long it survived. */
  private connectedAt = 0;

  get connectedName(): string | null {
    return this.device?.gatt?.connected ? this.device.name ?? 'BLE printer' : null;
  }

  /**
   * Show the browser's device picker (must be called from a user gesture) and
   * connect. Returns the picked device's id/name for persistence.
   *
   * Filtered by known printer services and name prefixes by default, so the
   * chooser stops listing every phone, watch and speaker in range. Printers
   * that advertise neither are unreachable that way, so `allDevices` reopens
   * the unfiltered chooser as an explicit escape hatch.
   */
  async pick(opts: { allDevices?: boolean } = {}): Promise<{ id: string; name: string }> {
    const bt = getBluetooth();
    if (!bt) throw new Error('Web Bluetooth is not supported in this browser');

    log('requestDevice →', opts.allDevices ? 'ALL devices (unfiltered)' : 'filtered to printers');
    const device = await bt.requestDevice(
      opts.allDevices
        ? { acceptAllDevices: true, optionalServices: PRINTER_SERVICES }
        : {
            filters: [
              ...PRINTER_SERVICES.map((s) => ({ services: [s] })),
              ...PRINTER_NAME_PREFIXES.map((namePrefix) => ({ namePrefix })),
            ],
            optionalServices: PRINTER_SERVICES,
          },
    );
    log('picked', device.name ?? '(unnamed)', device.id);
    await this.connectTo(device);
    return { id: device.id, name: device.name ?? 'BLE printer' };
  }

  /**
   * Try to reconnect to a previously-granted device without a picker. Works
   * when the browser supports the persistent-permissions backend
   * (navigator.bluetooth.getDevices); otherwise the user re-picks once per session.
   */
  async reconnectKnown(deviceId: string): Promise<boolean> {
    const bt = getBluetooth();
    if (!bt?.getDevices) {
      log('reconnectKnown skipped — this browser has no getDevices()');
      return false;
    }
    try {
      const devices = await bt.getDevices();
      const device = devices.find((d) => d.id === deviceId);
      if (!device) {
        warn('reconnectKnown: saved device not in granted list', deviceId);
        return false;
      }
      log('reconnectKnown →', device.name ?? '(unnamed)', deviceId);
      await this.connectTo(device);
      return true;
    } catch (e) {
      warn('reconnectKnown failed', e);
      return false;
    }
  }

  private async connectTo(device: BluetoothDeviceLike): Promise<void> {
    if (!device.gatt) throw new Error('Device has no GATT server');
    this.device = device;

    if (!this.listenerBound.has(device)) {
      device.addEventListener('gattserverdisconnected', () => {
        const heldFor = this.connectedAt ? ((Date.now() - this.connectedAt) / 1000).toFixed(1) : '?';
        // The drop that used to be invisible. BLE modules commonly close an idle
        // link after a few seconds; seeing the duration here is what tells you
        // whether that's what happened.
        warn(`gattserverdisconnected — ${device.name ?? '(unnamed)'} dropped after ${heldFor}s`);
        this.characteristic = null;
        this.connectedAt = 0;
      });
      this.listenerBound.add(device);
    }

    log('gatt.connect →', device.name ?? '(unnamed)');
    const server = await device.gatt.connect();
    this.connectedAt = Date.now();
    log('gatt connected, discovering services…');

    // Collect every writable characteristic under every matching service — not
    // just the first — before picking one. A device advertising several known
    // printer services (as several cheap clone modules do) may have more than
    // one plausible write target; if the one we pick turns out to be wrong
    // (write succeeds, printer stays silent), this log is what tells us what
    // else to try instead of guessing blind through another deploy.
    const services = await server.getPrimaryServices();
    log('services found:', services.map((s) => s.uuid).join(', ') || '(none)');
    const candidates: Array<{ svc: BluetoothRemoteGATTServiceLike; ch: BluetoothRemoteGATTCharacteristicLike }> = [];
    for (const svc of services) {
      if (!PRINTER_SERVICES.includes(svc.uuid)) continue;
      for (const ch of await svc.getCharacteristics()) {
        if (ch.properties.write || ch.properties.writeWithoutResponse) candidates.push({ svc, ch });
      }
    }
    if (candidates.length) {
      log(
        `${candidates.length} writable characteristic(s) found:`,
        candidates.map((c) => `${c.ch.uuid ?? '?'}@${c.svc.uuid} (write=${c.ch.properties.write},noResp=${c.ch.properties.writeWithoutResponse})`).join(' | '),
      );
    }

    const picked = candidates[0];
    if (!picked) {
      fail('no writable characteristic under any known printer service — disconnecting');
      device.gatt.disconnect();
      this.characteristic = null;
      this.connectedAt = 0;
      throw new Error(
        'No writable printer service found — this printer does not expose BLE printing. Use the Mumbai ERP Print Bridge app instead.',
      );
    }
    if (candidates.length > 1) {
      warn('multiple write candidates found — using the first; if nothing prints, this is the first thing to try changing');
    }
    this.characteristic = picked.ch;
    log('using characteristic', picked.ch.uuid ?? '(uuid n/a)', 'on service', picked.svc.uuid,
      `(write=${picked.ch.properties.write}, writeWithoutResponse=${picked.ch.properties.writeWithoutResponse})`);

    // Some BLE-UART bridge modules (common on cheap clone printers) only start
    // relaying writes to the printer's UART once a client has subscribed to
    // notifications on a characteristic in the same service — even though we
    // never read a response. Skipped silently if the service has no such
    // characteristic, or the printer doesn't require it; either way this must
    // never block printing, so any failure here is logged, not thrown.
    const notifyCh = await picked.svc.getCharacteristics()
      .then((chs) => chs.find((c) => c.properties.notify || c.properties.indicate))
      .catch(() => undefined);
    if (notifyCh?.startNotifications) {
      try {
        await notifyCh.startNotifications();
        log('subscribed to notify characteristic', notifyCh.uuid ?? '(uuid n/a)', '— some bridge modules gate printing on this');
      } catch (e) {
        warn('startNotifications failed (continuing anyway)', e);
      }
    }
  }

  async ensureConnected(savedDeviceId?: string): Promise<void> {
    if (this.characteristic && this.device?.gatt?.connected) return;
    if (this.device?.gatt && !this.device.gatt.connected) {
      // Session device exists but link dropped (printer power-cycled) — redial.
      log('link is down, redialling the session device');
      await this.connectTo(this.device);
      return;
    }
    if (savedDeviceId && (await this.reconnectKnown(savedDeviceId))) return;
    throw new Error('BLE printer not connected');
  }

  async write(bytes: Uint8Array): Promise<void> {
    const ch = this.characteristic;
    if (!ch || !this.device?.gatt?.connected) throw new Error('BLE printer not connected');

    const chunks = Math.ceil(bytes.length / WRITE_CHUNK);
    const useNoResponse = ch.properties.writeWithoutResponse && !!ch.writeValueWithoutResponse;
    log(`write ${bytes.length} bytes in ${chunks} chunk(s), mode=${useNoResponse ? 'withoutResponse' : 'withResponse'}`);

    const startedAt = Date.now();
    let sent = 0;
    try {
      for (let i = 0; i < bytes.length; i += WRITE_CHUNK) {
        // A mid-write drop otherwise surfaces as an opaque GATT error; naming it
        // tells you the link died rather than the printer rejecting the data.
        if (!this.device?.gatt?.connected) {
          throw new Error(`link dropped mid-write after ${sent}/${bytes.length} bytes`);
        }
        const chunk = bytes.subarray(i, i + WRITE_CHUNK);
        if (useNoResponse) {
          await ch.writeValueWithoutResponse!(chunk);
          await sleep(CHUNK_DELAY_MS); // let the module's UART buffer drain
        } else if (ch.writeValueWithResponse) {
          await ch.writeValueWithResponse(chunk);
        } else {
          await ch.writeValue(chunk);
        }
        sent += chunk.length;
      }
      log(`write complete — ${sent} bytes in ${Date.now() - startedAt}ms`);
    } catch (e) {
      fail(`write failed after ${sent}/${bytes.length} bytes (${Date.now() - startedAt}ms)`, e);
      throw e;
    }
  }

  disconnect(): void {
    log('disconnect() called by app');
    this.device?.gatt?.disconnect();
    this.characteristic = null;
    this.connectedAt = 0;
  }
}

/** Module-level singleton — the till talks to one receipt printer at a time. */
export const webBtPrinter = new WebBluetoothPrinter();
