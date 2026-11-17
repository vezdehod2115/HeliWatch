package dev.heliwatch

import android.graphics.Bitmap
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient

/**
 * Навигация и инжект page-hook.
 *
 * Инжект выполняется на onPageCommitVisible (страница уже видна, DOM строится)
 * и продублирован на onPageFinished — для страниц, где первый колбэк не пришёл.
 * Сам скрипт идемпотентен.
 */
class SiteWebViewClient : WebViewClient() {
  override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
    HeliWatchBridge.onPageStarted(view, url)
  }

  override fun onPageCommitVisible(view: WebView, url: String?) {
    HeliWatchBridge.onPageCommitVisible(view, url)
  }

  override fun onPageFinished(view: WebView, url: String?) {
    HeliWatchBridge.onPageFinished(view, url)
  }

  override fun shouldOverrideUrlLoading(
    view: WebView,
    request: WebResourceRequest,
  ): Boolean {
    val uri = request.url
    val scheme = uri.scheme?.lowercase()
    if (scheme == "http" || scheme == "https" || scheme == "file") {
      return false
    }
    return !HeliWatchBridge.openExternal(uri)
  }

  override fun onReceivedError(
    view: WebView,
    request: WebResourceRequest,
    error: WebResourceError,
  ) {
    if (request.isForMainFrame) {
      HeliWatchBridge.onPageError(error.description?.toString())
    }
  }
}
