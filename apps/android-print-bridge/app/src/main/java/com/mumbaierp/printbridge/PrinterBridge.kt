package com.mumbaierp.printbridge

import android.Manifest
import android.app.Activity
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothClass
import android.bluetooth.BluetoothManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.util.Base64
import android.util.Log
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.core.content.FileProvider
import org.json.JSONArray
import org.json.JSONObject
import print.Print
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * The `window.AndroidPrinter` JavaScript interface.
 *
 * Protocol (mirrored by apps/web/lib/print/android-bridge.ts):
 *   JS calls  AndroidPrinter.request(id, method, paramsJson)   — returns immediately
 *   we reply  window.__mumbaiErpPrinterBridgeResolve(id, resultJson) on the UI thread,
 *   where resultJson is {"ok":true,"data":…} or {"ok":false,"error":"…"}.
 *
 * All printer I/O runs on a single background executor: the vendor SDK keeps
 * global connection state (one open port), so serializing every operation is
 * both required for correctness and a natural fit for a receipt printer.
 */
class PrinterBridge(private val activity: Activity, private val webView: WebView) {

    companion object {
        private const val TAG = "MumbaiErpPrinterBridge"
        private const val PREFS = "mumbai_erp_print_bridge"
        private const val KEY_MAC = "printer_mac"
        private const val KEY_NAME = "printer_name"
        private const val CONNECT_ATTEMPTS = 2
        private const val WRITE_CHUNK = 4096
    }

    private val appContext: Context = activity.applicationContext
    private val executor = Executors.newSingleThreadExecutor()
    private val prefs = appContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    // Permission round-trip: bridge thread parks on the latch while the user
    // answers the Android 12+ BLUETOOTH_CONNECT dialog raised by MainActivity.
    @Volatile private var permissionLatch: CountDownLatch? = null
    @Volatile private var permissionGranted = false

    /** Synchronous marker so the web app can feature-detect the bridge. */
    @JavascriptInterface
    fun getBridgeVersion(): String = "1.0"

    @JavascriptInterface
    fun request(id: String, method: String, paramsJson: String) {
        executor.execute {
            val result: JSONObject = try {
                val params = if (paramsJson.isBlank()) JSONObject() else JSONObject(paramsJson)
                when (method) {
                    "getPairedPrinters" -> ok(pairedPrinters())
                    "connect" -> ok(connect(params.getString("mac")))
                    "disconnect" -> { disconnect(); ok(JSONObject.NULL) }
                    "write" -> { write(Base64.decode(params.getString("data"), Base64.DEFAULT)); ok(JSONObject.NULL) }
                    "getStatus" -> ok(status())
                    "openPdf" -> { openPdf(params.getString("data"), params.optString("filename", "document.pdf")); ok(JSONObject.NULL) }
                    else -> err("Unknown bridge method: $method")
                }
            } catch (t: Throwable) {
                Log.e(TAG, "Bridge call '$method' failed", t)
                err(t.message ?: t.javaClass.simpleName)
            }
            deliver(id, result)
        }
    }

    fun onBluetoothPermissionResult(granted: Boolean) {
        permissionGranted = granted
        permissionLatch?.countDown()
    }

    /** Close the port when the app goes away; the printer stays paired. */
    fun shutdown() {
        executor.execute { runCatching { Print.PortClose() } }
        executor.shutdown()
    }

    // ── Bluetooth plumbing ───────────────────────────────────────────────────

    private fun requireBluetoothPermission() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return
        // SCAN is needed alongside CONNECT even though we never discover: the
        // vendor SDK calls cancelDiscovery() while opening the socket, which
        // Android 12+ gates behind BLUETOOTH_SCAN.
        val missing = arrayOf(Manifest.permission.BLUETOOTH_CONNECT, Manifest.permission.BLUETOOTH_SCAN)
            .filter { appContext.checkSelfPermission(it) != PackageManager.PERMISSION_GRANTED }
        if (missing.isEmpty()) return

        val latch = CountDownLatch(1)
        permissionLatch = latch
        permissionGranted = false
        activity.runOnUiThread {
            activity.requestPermissions(missing.toTypedArray(), MainActivity.PERMISSION_REQUEST_BLUETOOTH)
        }
        // The dialog needs a human — wait generously, then fail loudly.
        latch.await(60, TimeUnit.SECONDS)
        permissionLatch = null
        if (!permissionGranted) {
            throw IllegalStateException("Bluetooth permission denied — allow \"Nearby devices\" for Mumbai ERP Print Bridge in Android settings")
        }
    }

    private fun adapter(): BluetoothAdapter {
        val manager = appContext.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager
        val adapter = manager?.adapter ?: throw IllegalStateException("This device has no Bluetooth")
        if (!adapter.isEnabled) {
            activity.runOnUiThread {
                runCatching { activity.startActivity(Intent(BluetoothAdapter.ACTION_REQUEST_ENABLE)) }
            }
            throw IllegalStateException("Bluetooth is turned off — turn it on and try again")
        }
        return adapter
    }

    private fun pairedPrinters(): JSONArray {
        requireBluetoothPermission()
        val out = JSONArray()
        for (device in adapter().bondedDevices) {
            out.put(JSONObject().apply {
                put("name", device.name ?: device.address)
                put("mac", device.address)
                put("likelyPrinter", device.bluetoothClass?.majorDeviceClass == BluetoothClass.Device.Major.IMAGING)
            })
        }
        return out
    }

    // ── Printer connection (vendor SDK) ──────────────────────────────────────

    private fun connect(mac: String): JSONObject {
        requireBluetoothPermission()
        adapter() // validates Bluetooth is on before the SDK tries the socket

        if (Print.IsOpened() && prefs.getString(KEY_MAC, null) == mac) return status()
        runCatching { Print.PortClose() }

        var lastError: Throwable? = null
        for (attempt in 1..CONNECT_ATTEMPTS) {
            try {
                // SPP connect, exactly as the vendor demo does it. 0 == SUCCEED.
                val rc = Print.PortOpen(appContext, "Bluetooth,$mac")
                if (rc == 0) {
                    val name = runCatching {
                        adapter().bondedDevices.firstOrNull { it.address == mac }?.name
                    }.getOrNull() ?: mac
                    prefs.edit().putString(KEY_MAC, mac).putString(KEY_NAME, name).apply()
                    return status()
                }
                lastError = IllegalStateException("Printer refused connection (code $rc)")
            } catch (t: Throwable) {
                lastError = t
            }
            if (attempt < CONNECT_ATTEMPTS) Thread.sleep(600)
        }
        throw IllegalStateException(
            "Could not connect to the printer — make sure it is on and in range (${lastError?.message ?: "unknown error"})",
        )
    }

    /** Re-open the last saved printer when the link has dropped. */
    private fun ensureConnected() {
        if (Print.IsOpened()) return
        val mac = prefs.getString(KEY_MAC, null)
            ?: throw IllegalStateException("No printer connected — open Printer Settings and connect one")
        connect(mac)
    }

    private fun disconnect() {
        runCatching { Print.PortClose() }
        // Explicit disconnect means "stop using this printer" — forget it so
        // the next print doesn't silently redial it.
        prefs.edit().remove(KEY_MAC).remove(KEY_NAME).apply()
    }

    private fun write(bytes: ByteArray) {
        requireBluetoothPermission()
        ensureConnected()
        var offset = 0
        var reconnected = false
        while (offset < bytes.size) {
            val end = minOf(offset + WRITE_CHUNK, bytes.size)
            val rc = try {
                Print.WriteData(bytes.copyOfRange(offset, end))
            } catch (t: Throwable) {
                -1
            }
            if (rc < 0) {
                // A stale socket (printer power-cycled) usually dies on the first
                // chunk — safe to redial and restart the document. Failures after
                // data already flowed must NOT restart, or we'd print half twice.
                if (offset == 0 && !reconnected) {
                    reconnected = true
                    runCatching { Print.PortClose() }
                    ensureConnected()
                    continue
                }
                throw IllegalStateException("Printer connection lost while printing — check the printer and reprint")
            }
            offset = end
        }
    }

    // ── Status (DLE EOT real-time status, best-effort) ───────────────────────

    private fun status(): JSONObject {
        val connected = runCatching { Print.IsOpened() }.getOrDefault(false)
        val st = JSONObject()
        st.put("connected", connected)
        st.put("mac", prefs.getString(KEY_MAC, null) ?: JSONObject.NULL)
        st.put("name", prefs.getString(KEY_NAME, null) ?: JSONObject.NULL)
        var online: Any = JSONObject.NULL
        var paperOut: Any = JSONObject.NULL
        var coverOpen: Any = JSONObject.NULL
        if (connected) {
            // Not every printer/firmware answers DLE EOT — nulls mean "unknown",
            // and the web side prints anyway rather than blocking the till.
            runCatching {
                val paper = Print.GetRealTimeStatus(4)
                if (paper != null && paper.isNotEmpty()) paperOut = (paper[0].toInt() and 0x60) != 0
            }
            runCatching {
                val offline = Print.GetRealTimeStatus(2)
                if (offline != null && offline.isNotEmpty()) {
                    coverOpen = (offline[0].toInt() and 0x04) != 0
                    online = (offline[0].toInt() and 0x08) == 0
                }
            }
        }
        st.put("online", online)
        st.put("paperOut", paperOut)
        st.put("coverOpen", coverOpen)
        return st
    }

    // ── PDF hand-off (A4 GST bills viewed/printed outside the WebView) ───────

    private fun openPdf(base64: String, filename: String) {
        val dir = File(appContext.cacheDir, "pdfs").apply { mkdirs() }
        val safeName = filename.replace(Regex("[^A-Za-z0-9._-]"), "_").ifBlank { "document.pdf" }
        val file = File(dir, safeName)
        file.writeBytes(Base64.decode(base64, Base64.DEFAULT))
        val uri = FileProvider.getUriForFile(appContext, "${appContext.packageName}.fileprovider", file)
        val intent = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(uri, "application/pdf")
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        try {
            activity.startActivity(intent)
        } catch (t: Throwable) {
            throw IllegalStateException("No PDF viewer installed on this device")
        }
    }

    // ── Result delivery ──────────────────────────────────────────────────────

    private fun ok(data: Any): JSONObject = JSONObject().put("ok", true).put("data", data)

    private fun err(message: String): JSONObject = JSONObject().put("ok", false).put("error", message)

    private fun deliver(id: String, result: JSONObject) {
        val js = "window.__mumbaiErpPrinterBridgeResolve && window.__mumbaiErpPrinterBridgeResolve(" +
            "${JSONObject.quote(id)}, ${JSONObject.quote(result.toString())})"
        activity.runOnUiThread { webView.evaluateJavascript(js, null) }
    }
}
