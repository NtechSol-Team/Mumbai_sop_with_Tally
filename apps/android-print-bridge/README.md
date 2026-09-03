# Mumbai ERP Print Bridge (Android)

A small Android app that wraps the deployed Mumbai ERP web app in a full-screen WebView and
gives it what mobile Chrome cannot: **Bluetooth ESC/POS receipt printing**.

## Why this app exists

| | Windows till | Android tablet (plain Chrome) | Android tablet (this app) |
|---|---|---|---|
| How receipts print | `window.print()` → OS printer driver | ❌ Android print framework has no service for BT receipt printers | ✅ raw ESC/POS bytes → vendor SDK → Bluetooth SPP |
| Web Bluetooth | n/a | BLE only — most ESC/POS printers are Bluetooth *Classic* (SPP), invisible to it | n/a (bridge used instead) |

The web app generates the ESC/POS bytes itself (`apps/web/lib/print/`). This app is a
dumb, reliable pipe: it exposes `window.AndroidPrinter` to the page, and pushes whatever
bytes the page hands it into the printer through `ESC_SDK_V1.23.01.jar` (the vendor's
Android SDK from the `Android_ESC_V1.23.01` package). All receipt layout lives in one
place — the web app — so Windows and Android receipts stay identical.

## JS bridge contract

Injected as `window.AndroidPrinter` before page load:

```
getBridgeVersion(): string                      // sync feature-detection marker
request(id, method, paramsJson): void           // async; result delivered via
window.__mumbaiErpPrinterBridgeResolve(id, json)     //   {"ok":true,"data":…} | {"ok":false,"error":…}
```

Methods: `getPairedPrinters`, `connect {mac}`, `disconnect`, `write {data: base64 ESC/POS}`,
`getStatus`, `openPdf {data, filename}`. The TypeScript client is
`apps/web/lib/print/android-bridge.ts`.

Behaviour worth knowing:

- **Reconnect**: the last connected printer MAC is persisted; `write` re-opens the port
  automatically if the link dropped (printer power-cycled, tablet slept). A reconnect is
  only attempted *before any bytes flowed*, so a mid-receipt failure never reprints half
  a document on its own.
- **Status**: `getStatus` answers DLE EOT real-time queries (paper out, cover open) when
  the printer supports them; unknown values come back `null` and printing proceeds.
- **Permissions**: on Android 12+ the app requests `BLUETOOTH_CONNECT` ("Nearby devices")
  the first time the page touches the printer; older Androids need nothing at runtime.
  Only *paired* devices are listed — pair the printer once in Android Settings →
  Bluetooth (PIN is usually `0000` or `1234`).
- **PDFs**: A4 GST bills can't go to a 58/80mm printer; the page hands them over and the
  app opens the system PDF viewer (share/print from there).

## Build

Requirements: JDK 17 and the Android SDK (Android Studio, or command-line tools with
`platforms;android-34` + `build-tools;34.0.0`). If the SDK isn't auto-detected, create
`local.properties` here with `sdk.dir=/Users/<you>/Library/Android/sdk`.

```bash
cd apps/android-print-bridge
./gradlew assembleRelease        # → app/build/outputs/apk/release/app-release.apk
```

The release build is signed with the debug key on purpose so the APK can be sideloaded
straight onto tills. For Play-Store distribution, add a real signing config in
`app/build.gradle`.

Install on the tablet (USB debugging on): `adb install app-release.apk`, or copy the APK
over and open it.

## Configure & use

1. Pair the printer in Android **Settings → Bluetooth** (one time).
2. Open **Mumbai ERP Print Bridge**. First launch asks for the server address — enter your
   deployed web app URL (e.g. `https://your-mumbai-erp-domain.com`, or `http://192.168.x.x:3100`
   for LAN dev; cleartext http is allowed for this).
3. Log in as usual, open **POS → printer icon (Printer settings)**:
   - the dialog shows *"Receipts print via: Bluetooth printer app"*,
   - pick the paired printer from the list → **Connect**,
   - **Test print** — the slip exercises text sizes, QR, barcode and the logo image.
4. Sell something — the receipt prints silently, no dialogs.

Back button: navigates the web app back; on the root page it offers *Reload / Change
server address / Exit*.

## Project layout

- `app/libs/ESC_SDK_V1.23.01.jar` — vendor SDK (checked in; the `print.Print` facade is used)
- `app/src/main/jniLibs/` — vendor `.so` libs (serial/LZO paths of the SDK; not used by
  Bluetooth printing but included so no SDK code path can crash on a missing native lib)
- `MainActivity.kt` — WebView host, URL config, permission plumbing
- `PrinterBridge.kt` — the `window.AndroidPrinter` implementation (executor-serialized
  SDK calls, reconnect, DLE EOT status, PDF hand-off)
