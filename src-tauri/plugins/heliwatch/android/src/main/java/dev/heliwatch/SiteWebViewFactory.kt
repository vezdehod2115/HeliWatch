package dev.heliwatch

import android.app.Activity
import android.graphics.Color
import android.os.Build
import android.webkit.CookieManager
import android.webkit.WebSettings
import android.webkit.WebView

/**
 * Создание WebView сайта: мобильный Chrome-UA, куки, автоплей, файлы.
 * Это единственный WebView, в который добавляется JavascriptInterface.
 */
object SiteWebViewFactory {
  fun create(activity: Activity, bridge: NativeBridge): WebView {
    val webView = WebView(activity)
    webView.setBackgroundColor(Color.TRANSPARENT)
    webView.isFocusable = true
    webView.isFocusableInTouchMode = true
    webView.overScrollMode = android.view.View.OVER_SCROLL_NEVER

    webView.settings.apply {
      javaScriptEnabled = true
      domStorageEnabled = true
      databaseEnabled = true
      mediaPlaybackRequiresUserGesture = false
      mixedContentMode = WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
      allowFileAccess = true
      allowContentAccess = true
      javaScriptCanOpenWindowsAutomatically = false
      setSupportMultipleWindows(false)
      useWideViewPort = true
      loadWithOverviewMode = true
      setSupportZoom(false)
      builtInZoomControls = false
      displayZoomControls = false
      textZoom = 100
      cacheMode = WebSettings.LOAD_DEFAULT
      userAgentString = mobileChromeUserAgent(userAgentString)
    }

    CookieManager.getInstance().apply {
      setAcceptCookie(true)
      setAcceptThirdPartyCookies(webView, true)
    }

    webView.addJavascriptInterface(bridge, "HeliNative")
    webView.webViewClient = SiteWebViewClient()
    webView.webChromeClient = SiteChromeClient(activity)

    return webView
  }

  /**
   * WebView UA содержит «; wv» и «Version/4.0» — по ним сайты распознают
   * встроенный браузер. Убираем маркеры, чтобы получить мобильный Chrome.
   */
  private fun mobileChromeUserAgent(defaultUa: String?): String {
    if (defaultUa.isNullOrBlank()) {
      return "Mozilla/5.0 (Linux; Android ${Build.VERSION.RELEASE}; ${Build.MODEL}) " +
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36"
    }
    return defaultUa
      .replace("; wv", "")
      .replace("Version/4.0 ", "")
  }
}
