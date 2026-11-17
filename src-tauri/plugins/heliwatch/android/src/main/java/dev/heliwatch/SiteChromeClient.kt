package dev.heliwatch

import android.content.Context
import android.util.Log
import android.view.View
import android.webkit.ConsoleMessage
import android.webkit.PermissionRequest
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebView

/** Fullscreen-видео, системный пикер файла, микрофон и консоль сайта. */
class SiteChromeClient(
  private val context: Context,
) : WebChromeClient() {
  override fun onShowFileChooser(
    webView: WebView,
    filePathCallback: ValueCallback<Array<android.net.Uri>>,
    fileChooserParams: FileChooserParams,
  ): Boolean {
    return HeliWatchBridge.showFileChooser(filePathCallback, fileChooserParams)
  }

  override fun onPermissionRequest(request: PermissionRequest) {
    val wantsAudio = request.resources.any {
      it == PermissionRequest.RESOURCE_AUDIO_CAPTURE
    }
    // Микрофон сайта — только если системное разрешение уже выдано (этап 3).
    if (wantsAudio && HeliWatchPermissions.hasAudio(context)) {
      request.grant(request.resources)
    } else {
      request.deny()
    }
  }

  override fun onShowCustomView(view: View, callback: CustomViewCallback) {
    HeliWatchBridge.showFullscreen(view, callback)
  }

  override fun onHideCustomView() {
    HeliWatchBridge.hideFullscreen()
  }

  override fun onCreateWindow(
    view: WebView,
    isDialog: Boolean,
    isUserGesture: Boolean,
    resultMsg: android.os.Message,
  ): Boolean = false

  override fun onConsoleMessage(consoleMessage: ConsoleMessage): Boolean {
    Log.d(
      TAG,
      "site console: ${consoleMessage.message()} " +
        "@${consoleMessage.sourceId()}:${consoleMessage.lineNumber()}",
    )
    return true
  }

  override fun onReceivedTitle(view: WebView, title: String?) {
    HeliWatchBridge.onTitle(view, title)
  }

  private companion object {
    const val TAG = "HeliWatchSite"
  }
}
