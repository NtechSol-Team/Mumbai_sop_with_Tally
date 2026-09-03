package com.mumbaierp.printbridge

import android.annotation.SuppressLint
import android.app.Activity
import android.app.AlertDialog
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.os.Bundle
import android.util.Log
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.ConsoleMessage
import android.webkit.CookieManager
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.swiperefreshlayout.widget.SwipeRefreshLayout
import android.widget.EditText
import android.widget.FrameLayout

/**
 * Kiosk-style host for the Mumbai ERP web app.
 *
 * The entire product stays the deployed Next.js app — this activity only adds
 * what mobile Chrome cannot do: a Bluetooth Classic (SPP) pipe to ESC/POS
 * receipt printers via the vendor SDK, exposed to the page as
 * `window.AndroidPrinter` (see PrinterBridge).
 */
class MainActivity : Activity() {

    companion object {
        private const val TAG = "MumbaiErpPrintBridge"
        private const val PREFS = "mumbai_erp_print_bridge"
        private const val KEY_URL = "app_url"
        private const val DEFAULT_URL = "https://your-mumbai-erp-domain.com"
        const val PERMISSION_REQUEST_BLUETOOTH = 4001
    }

    private lateinit var webView: WebView
    private lateinit var swipeRefresh: SwipeRefreshLayout
    private lateinit var bridge: PrinterBridge
    private val prefs by lazy { getSharedPreferences(PREFS, Context.MODE_PRIVATE) }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // A till must never dim mid-shift.
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        webView = WebView(this)
        webView.setBackgroundColor(Color.WHITE)

        // Pull-to-refresh: after a server update, staff can swipe down to load the
        // latest app without reinstalling or clearing data. Gated to only fire when
        // the page is already scrolled to the very top, so it never hijacks normal
        // scrolling inside the POS product grid or cart.
        swipeRefresh = SwipeRefreshLayout(this).apply {
            addView(
                webView,
                ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT),
            )
            setOnRefreshListener { webView.reload() }
            setOnChildScrollUpCallback { _, _ -> webView.scrollY > 0 }
        }
        setContentView(
            swipeRefresh,
            FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT),
        )

        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true            // localStorage: auth/session, offline POS queue, printer settings
            databaseEnabled = true
            cacheMode = WebSettings.LOAD_DEFAULT
            mediaPlaybackRequiresUserGesture = false // POS success/error beeps
            setSupportZoom(false)
            useWideViewPort = true
            loadWithOverviewMode = true
        }
        CookieManager.getInstance().setAcceptCookie(true)

        webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val url = request.url
                // Keep the web app in-app; send everything else (tel:, upi:,
                // mailto:, external sites) to the matching Android app.
                return if (url.scheme == "http" || url.scheme == "https") false else {
                    runCatching { startActivity(Intent(Intent.ACTION_VIEW, url)) }
                    true
                }
            }

            override fun onPageFinished(view: WebView, url: String) {
                swipeRefresh.isRefreshing = false
                applyPullToRefreshPolicy(url)
            }

            // Fires on client-side (SPA) route changes too, not just full loads —
            // so entering/leaving the POS terminal is caught even though Next.js
            // navigates without reloading the page.
            override fun doUpdateVisitedHistory(view: WebView, url: String, isReload: Boolean) {
                applyPullToRefreshPolicy(url)
            }

            override fun onRenderProcessGone(view: WebView, detail: android.webkit.RenderProcessGoneDetail): Boolean {
                // Chrome renderer crashed/was killed — rebuild rather than take the app down.
                Log.w(TAG, "WebView renderer gone (crashed=${detail.didCrash()}), recreating")
                recreate()
                return true
            }
        }

        webView.webChromeClient = object : WebChromeClient() {
            override fun onConsoleMessage(msg: ConsoleMessage): Boolean {
                Log.d(TAG, "[web] ${msg.message()} (${msg.sourceId()}:${msg.lineNumber()})")
                return true
            }
        }

        bridge = PrinterBridge(this, webView)
        // Must be attached before loadUrl so window.AndroidPrinter exists at page start.
        webView.addJavascriptInterface(bridge, "AndroidPrinter")

        val url = prefs.getString(KEY_URL, null)
        if (url.isNullOrBlank()) promptForUrl(firstRun = true) else webView.loadUrl(url)
    }

    /**
     * Pull-to-refresh is off on the POS terminal (and its kitchen view). Those
     * screens scroll their own inner lists, not the page body, so the WebView's
     * scroll position stays at 0 and a downward swipe would otherwise be read as
     * a refresh — reloading mid-sale instead of scrolling the menu. Everywhere
     * else (dashboard, orders, …) the page body scrolls normally, so swipe-to-
     * refresh stays available. The `pos-items` admin page is intentionally NOT
     * matched — only the live terminal path `/pos` and anything beneath it.
     */
    private fun applyPullToRefreshPolicy(url: String) {
        val path = android.net.Uri.parse(url).path ?: ""
        swipeRefresh.isEnabled = !(path == "/pos" || path.startsWith("/pos/"))
    }

    /** First-run setup and later reconfiguration of which Mumbai ERP deployment to load. */
    private fun promptForUrl(firstRun: Boolean) {
        val input = EditText(this).apply {
            hint = DEFAULT_URL
            setText(prefs.getString(KEY_URL, DEFAULT_URL))
            inputType = android.text.InputType.TYPE_TEXT_VARIATION_URI
        }
        AlertDialog.Builder(this)
            .setTitle(getString(R.string.url_dialog_title))
            .setMessage(getString(R.string.url_dialog_message))
            .setView(input)
            .setCancelable(!firstRun)
            .setPositiveButton(getString(R.string.url_dialog_save)) { _, _ ->
                var url = input.text.toString().trim().ifBlank { DEFAULT_URL }
                if (!url.startsWith("http://") && !url.startsWith("https://")) url = "https://$url"
                prefs.edit().putString(KEY_URL, url).apply()
                webView.loadUrl(url)
            }
            .apply { if (!firstRun) setNegativeButton(getString(R.string.cancel), null) }
            .show()
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        when {
            webView.canGoBack() -> webView.goBack()
            else -> AlertDialog.Builder(this)
                .setTitle(getString(R.string.exit_dialog_title))
                .setItems(
                    arrayOf(
                        getString(R.string.exit_dialog_reload),
                        getString(R.string.exit_dialog_change_url),
                        getString(R.string.exit_dialog_exit),
                    ),
                ) { _, which ->
                    when (which) {
                        0 -> webView.reload()
                        1 -> promptForUrl(firstRun = false)
                        2 -> finish()
                    }
                }
                .setNegativeButton(getString(R.string.cancel), null)
                .show()
        }
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == PERMISSION_REQUEST_BLUETOOTH) {
            val granted = grantResults.isNotEmpty() &&
                grantResults.all { it == android.content.pm.PackageManager.PERMISSION_GRANTED }
            bridge.onBluetoothPermissionResult(granted)
        }
    }

    override fun onDestroy() {
        if (isFinishing) bridge.shutdown()
        super.onDestroy()
    }
}
