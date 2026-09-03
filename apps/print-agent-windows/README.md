# Mumbai ERP — Print Agent (Windows)

A local Windows tray app that listens for order events over Socket.IO and
prints ESC/POS receipts on a USB, Bluetooth, or LAN thermal printer, without
needing a browser tab open. Runs silently in the system tray and starts
automatically on Windows boot once installed.

## What it actually listens for

The three events named in the original brief were checked against the real
backend (`apps/api/src/sockets/events.ts` / `orders.service.ts`) rather than
assumed:

| Brief said | What's real today | What this agent does |
|---|---|---|
| `new_order` | **Real.** Emitted the instant an order lands, full item list included. | Prints the new-order slip. |
| `order_modified` | **Doesn't exist.** No revision/version concept anywhere in the order schema. | Listener is wired up and ready — it will start working the day the backend adds this event — but nothing fires it yet. |
| `order_cancelled` | **Doesn't exist as its own event**, but `order_status_changed` (real) fires with `status: 'CANCELLED'` and a `reason` on every cancellation. | Treated as the cancellation trigger — this is what actually happens when an order is cancelled today. `order_cancelled` is also wired up in case the backend adds it directly later. |

Only a **Super Admin** or **Godown/Warehouse Manager** login receives these —
that's who the server puts in the "admin room" order events broadcast to
(`Room.ADMIN` in `sockets/events.ts`). Signing the agent in with a franchise
owner or cashier account will connect fine but never print anything.

## Authentication

There's no separate "device token" in this backend — a socket authenticates
with the same 15-minute access token a browser session uses. So "configured
auth token" here really means: **sign in once** (Settings → Login), and the
agent keeps itself signed in after that — it stores only the refresh token
(encrypted at rest via Windows Credential Manager, through Electron's
`safeStorage`) and proactively renews the access token every 10 minutes, well
inside the 15-minute window, using the exact same refresh-token rotation the
web app uses.

## Printing architecture

Two stages, deliberately kept separate:

1. **`node-thermal-printer`** builds the raw ESC/POS byte buffer — formatting
   only (`getBuffer()`), it never sends anything itself.
2. The bytes are sent ourselves:
   - **USB or Bluetooth** — both pair as a normal Windows printer queue
     either way, so both go through `resources/RawPrint.ps1`, a bundled
     PowerShell script that P/Invokes `winspool.drv` directly (the classic
     Microsoft "RawPrinterHelper" pattern) to push bytes past the driver
     untouched.
   - **LAN** — a raw TCP write straight to the printer's `IP:port` (almost
     always 9100), no OS driver involved.

The brief named the `printer` npm package for step 2. That package is
unmaintained (last release is grunt-era, 2017) and **fails to even install**
on any machine with Python ≥3.12 (`distutils` was removed) — which would have
made "generate a single .exe" unreliable depending on whose machine builds it.
The PowerShell approach needs nothing but Windows itself: **this app has zero
native/compiled dependencies**, which also means no `node-gyp` rebuild step
is needed after `npm install`.

Receipt layout matches `apps/web/lib/print/receipt-escpos.ts`'s
`pickListBytes()` exactly (same store name sizing, same field order, same
"New Order Receipt" subtitle position) — every print path in the system
should look the same on paper.

## Project layout

```
src/
  main.js             App entry: tray, settings window, IPC, auto-launch
  config-store.js      Persisted config (electron-store) + encrypted refresh token (safeStorage)
  api-client.js         Login / token refresh / GET order detail
  socket-client.js       Socket.IO connection, reconnect, event -> print wiring
  printer-manager.js      ESC/POS buffer building + sending (Windows queue or LAN)
  receipt-builder.js       Order data -> the small line-DSL printer-manager renders
  tray.js                   Tray icon + context menu
  notify.js                  Windows notifications
  preload.js                  contextBridge for the settings window
renderer/
  settings.html, settings.js  Settings window UI (server, login, printer, test print)
resources/
  RawPrint.ps1                  Bundled at build time (extraResources) — not inside app.asar
build/
  icon.ico, icon.png, tray-*.png  Generated placeholder icons — swap for real branding
```

## Running in development

```bash
cd apps/print-agent-windows
npm install
npm start
```

First run with no server configured opens the Settings window automatically.
Enter the server URL (the same origin the web dashboard talks to, e.g.
`https://api.your-mumbai-erp-domain.com`), sign in with a Super Admin
or Warehouse Manager account, and pick a printer. Close the window — the tray
icon keeps running.

Printer sending (`RawPrint.ps1`, and printer enumeration via `Get-Printer`)
only works on Windows — running in dev on macOS/Linux is fine for everything
except the actual print step, which fails with a clear "only works on
Windows" error rather than crashing.

## Building the installer

```bash
npm run dist
```

Produces `dist/Mumbai ERP Print Agent-Setup-<version>.exe` — a one-click
NSIS installer (no install-path prompt, per-user install so it doesn't need
admin rights, Start Menu shortcut, launches after install). `electron-builder`
can build this Windows target from macOS/Linux directly; no Wine needed for
the NSIS target.

## Tray menu

- Connection status (● Connected / Connecting… / Disconnected / Sign-in expired)
- Current printer, shown inline
- **Select Printer** — submenu listing every Windows-known printer (USB,
  Bluetooth, and any installed network printer queues), radio-checked
- **Test Print** — sends a one-line test slip to the configured printer
- **Configure Server / Sign in…** — opens the Settings window
- **Exit**

## Config persistence

Everything survives an app restart via `electron-store`
(`%APPDATA%\Mumbai ERP Print Agent\print-agent-config.json` on Windows):
server URL, selected printer/interface, paper width, and (encrypted) the
refresh token from the last sign-in — so the agent reconnects on its own after
a reboot without anyone re-entering a password.

## Notifications

A Windows toast fires on: successful print (per order), a print failure (with
the reason), and on connect/disconnect.

## Known limits / things only a real Windows machine can confirm

Built and verified as far as this can go without Windows hardware:
`npm install` is clean (zero native deps), the app boots, the settings window
renders and its IPC round-trips correctly (config get/save, printer list,
login) — verified live. Not verifiable from here: `Get-Printer` output on a
real Windows box, `RawPrint.ps1` actually reaching a physical printer, the
Windows startup registration, and Bluetooth-as-printer-queue behavior — these
need testing on an actual Windows machine with a printer attached before
relying on it in production.
