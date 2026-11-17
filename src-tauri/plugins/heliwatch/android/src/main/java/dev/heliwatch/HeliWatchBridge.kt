package dev.heliwatch

import android.app.Activity
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.View
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.widget.FrameLayout
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import app.tauri.plugin.JSObject
import org.json.JSONObject
import java.lang.ref.WeakReference

/**
 * Мост между Kotlin и React: второй WebView, тач-роутинг, события сайта.
 *
 * Объект живёт весь процесс: Activity пересоздаётся только при смене конфигурации,
 * а configChanges в манифесте это запрещает (WebView переживают поворот).
 */
object HeliWatchBridge {
  private const val TAG = "HeliWatch"
  private const val MAX_PENDING_EVENTS = 64
  private const val BACK_ARM_MS = 2000L
  private const val MAX_HOOK_LENGTH = 512 * 1024

  private var activityRef: WeakReference<AppCompatActivity>? = null
  private var containerRef: HeliWatchContainer? = null
  private var siteRef: WebView? = null
  private var tauriRef: WebView? = null
  private var pluginRef: HeliWatchPlugin? = null

  private var hookSource: String? = null
  private var fileLauncher: ActivityResultLauncher<Intent>? = null
  private var pendingFileCallback: ValueCallback<Array<Uri>>? = null
  private var backCallback: OnBackPressedCallback? = null
  private var backArmedUntil = 0L
  private val deepLinkPattern = Regex("""heliwatch://(?:r/)?([0-9A-Za-z]{6})""", RegexOption.IGNORE_CASE)

  private val mainHandler = Handler(Looper.getMainLooper())
  private val pendingEvents = ArrayDeque<JSObject>()

  /** Вызывается из MainActivity.onCreate: back-навигация и лаунчеры. */
  fun install(activity: AppCompatActivity) {
    activityRef = WeakReference(activity)
    setupFileChooser(activity)
    setupBackHandling(activity)
    handleIntent(activity.intent)
  }

  /**
   * Ссылка heliwatch://r/<code>. Intent приходит и при холодном старте
   * (activity.intent), и при повторном открытии (MainActivity.onNewIntent).
   */
  fun handleIntent(intent: Intent?) {
    val raw = intent?.dataString ?: return
    if (!raw.startsWith("heliwatch://", ignoreCase = true)) {
      return
    }
    val match = deepLinkPattern.find(raw) ?: return
    val code = match.groupValues[1].uppercase()
    emitEvent(JSObject().apply {
      put("t", "deeplink")
      put("code", code)
      put("url", raw)
    })
  }

  /** Вызывается из HeliWatchPlugin.load: Tauri-WebView уже на экране. */
  fun attach(activity: Activity, tauriWebView: WebView, plugin: HeliWatchPlugin) {
    pluginRef = plugin
    val host = activity as? AppCompatActivity ?: run {
      Log.w(TAG, "attach: activity не AppCompatActivity")
      return
    }
    activityRef = WeakReference(host)
    if (containerRef != null) {
      return
    }

    tauriRef = tauriWebView
    transparent(tauriWebView)

    val site = SiteWebViewFactory.create(host, NativeBridge(::onPageMessage))
    siteRef = site

    val container = HeliWatchContainer(host, site, tauriWebView)
    container.onTap = { target, x, y -> emitTap(target, x, y) }

    val parent: ViewGroup = (tauriWebView.parent as? ViewGroup)
      ?: (host.findViewById<ViewGroup>(android.R.id.content) ?: run {
        Log.w(TAG, "attach: не найден контейнер окна")
        return
      })
    val index = parent.indexOfChild(tauriWebView).coerceAtLeast(0)
    parent.removeView(tauriWebView)

    val params = FrameLayout.LayoutParams(
      FrameLayout.LayoutParams.MATCH_PARENT,
      FrameLayout.LayoutParams.MATCH_PARENT,
    )
    container.addView(site, FrameLayout.LayoutParams(params))
    container.addView(tauriWebView, FrameLayout.LayoutParams(params))
    parent.addView(
      container,
      index,
      FrameLayout.LayoutParams(
        FrameLayout.LayoutParams.MATCH_PARENT,
        FrameLayout.LayoutParams.MATCH_PARENT,
      ),
    )
    containerRef = container
    tauriWebView.isFocusable = true
    tauriWebView.isFocusableInTouchMode = true
    transparent(tauriWebView)

    // Пока React не прислал инжект, показываем прозрачную заглушку.
    site.loadDataWithBaseURL(
      null,
      "<html><body style=\"background:transparent\"></body></html>",
      "text/html",
      "utf-8",
      null,
    )
    if (hookSource != null) {
      injectHook(site)
    }
    flushPending()
  }

  fun setHookSource(source: String) {
    if (source.isBlank() || source.length > MAX_HOOK_LENGTH) {
      emitError("site_init: некорректный размер инжекта")
      return
    }
    hookSource = source
    siteRef?.let { injectHook(it) }
    flushPending()
  }

  fun loadUrl(rawUrl: String) {
    val url = rawUrl.trim()
    if (url.isEmpty()) {
      return
    }
    val scheme = runCatching { Uri.parse(url).scheme?.lowercase() }.getOrNull()
    if (scheme != "https" && scheme != "http" && scheme != "file") {
      emitError("Неподдерживаемый адрес: $url")
      return
    }
    siteRef?.loadUrl(url)
  }

  fun navigate(action: String) {
    val site = siteRef ?: return
    when (action) {
      "back" -> if (site.canGoBack()) site.goBack()
      "forward" -> if (site.canGoForward()) site.goForward()
      "reload" -> site.reload()
      "stop" -> site.stopLoading()
      else -> Log.w(TAG, "navigate: неизвестное действие $action")
    }
  }

  fun runPageCommand(cmd: JSObject?) {
    if (cmd == null) {
      return
    }
    val site = siteRef ?: return
    val json = cmd.toString()
    val script =
      "(function(){try{return !!(window.__heliwatch&&window.__heliwatch.apply($json));}catch(e){return false;}})();"
    site.evaluateJavascript(script, null)
  }

  fun updateRegions(payload: JSObject?) {
    containerRef?.tapRouter?.update(payload)
  }

  fun info(): JSObject {
    val site = siteRef
    return JSObject().apply {
      put("url", site?.url ?: "")
      put("title", site?.title ?: "")
      put("canGoBack", site?.canGoBack() ?: false)
      put("canGoForward", site?.canGoForward() ?: false)
      put("hookReady", hookSource != null)
      put("fullscreen", containerRef?.isFullscreen ?: false)
    }
  }

  fun onPageStarted(webView: WebView, url: String?) {
    emitNav(webView, url, loading = true)
  }

  fun onPageCommitVisible(webView: WebView, url: String?) {
    injectHook(webView)
  }

  fun onPageFinished(webView: WebView, url: String?) {
    emitNav(webView, url, loading = false)
    injectHook(webView)
  }

  fun onTitle(webView: WebView, title: String?) {
    if (title.isNullOrBlank()) {
      return
    }
    emitEvent(JSObject().apply {
      put("t", "nav")
      put("url", webView.url ?: "")
      put("title", title)
      put("canGoBack", webView.canGoBack())
      put("canGoForward", webView.canGoForward())
      put("loading", false)
    })
  }

  fun onPageError(message: String?) {
    emitError("Страница не загрузилась: ${message ?: "неизвестная ошибка"}")
  }

  fun openExternal(uri: Uri): Boolean {
    val activity = activityRef?.get() ?: return false
    return try {
      val intent = if (uri.scheme == "intent") {
        Intent.parseUri(uri.toString(), Intent.URI_INTENT_SCHEME)
      } else {
        Intent(Intent.ACTION_VIEW, uri)
      }
      intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      activity.startActivity(intent)
      true
    } catch (error: Exception) {
      emitError("Не удалось открыть ссылку: ${error.message}")
      false
    }
  }

  // ---------- WebChromeClient: файлы, fullscreen, разрешения ----------

  fun showFileChooser(
    callback: ValueCallback<Array<Uri>>,
    params: WebChromeClient.FileChooserParams,
  ): Boolean {
    val launcher = fileLauncher ?: return false
    cancelPendingFileChooser()
    pendingFileCallback = callback
    val intent = try {
      params.createIntent()
    } catch (error: Exception) {
      Log.w(TAG, "file chooser intent", error)
      null
    }
    if (intent == null) {
      pendingFileCallback = null
      return false
    }
    return try {
      launcher.launch(intent)
      true
    } catch (error: Exception) {
      pendingFileCallback = null
      emitError("Не удалось открыть выбор файла: ${error.message}")
      false
    }
  }

  fun onFileChooserResult(resultCode: Int, data: Intent?) {
    val callback = pendingFileCallback
    pendingFileCallback = null
    if (callback == null) {
      return
    }
    val uris = try {
      WebChromeClient.FileChooserParams.parseResult(resultCode, data)
    } catch (error: Exception) {
      Log.w(TAG, "file chooser result", error)
      null
    }
    callback.onReceiveValue(uris)
  }

  fun showFullscreen(view: View, callback: WebChromeClient.CustomViewCallback) {
    containerRef?.showFullscreen(view, callback)
    emitEvent(JSObject().apply {
      put("t", "fullscreen")
      put("on", true)
    })
  }

  fun hideFullscreen() {
    containerRef?.hideFullscreen()
    emitEvent(JSObject().apply {
      put("t", "fullscreen")
      put("on", false)
    })
  }

  fun onActivityPause() {
    siteRef?.onPause()
    runCatching { CookieManager.getInstance().flush() }
  }

  fun onActivityResume() {
    siteRef?.onResume()
  }

  fun destroy() {
    containerRef?.hideFullscreen()
    backCallback?.remove()
    backCallback = null
    pendingFileCallback?.onReceiveValue(null)
    pendingFileCallback = null
    siteRef?.destroy()
    siteRef = null
    containerRef = null
    tauriRef = null
    pluginRef = null
    pendingEvents.clear()
  }

  // ---------- Внутреннее ----------

  private fun setupFileChooser(activity: AppCompatActivity) {
    try {
      fileLauncher = activity.registerForActivityResult(
        ActivityResultContracts.StartActivityForResult(),
      ) { result ->
        onFileChooserResult(result.resultCode, result.data)
      }
    } catch (error: IllegalStateException) {
      Log.w(TAG, "file chooser launcher недоступен", error)
    }
  }

  private fun setupBackHandling(activity: AppCompatActivity) {
    backCallback?.remove()
    val callback = object : OnBackPressedCallback(true) {
      override fun handleOnBackPressed() {
        val site = siteRef
        if (site != null && site.canGoBack()) {
          site.goBack()
          return
        }
        val now = System.currentTimeMillis()
        if (now > backArmedUntil) {
          backArmedUntil = now + BACK_ARM_MS
          emitEvent(JSObject().apply {
            put("t", "back-root")
          })
          return
        }
        isEnabled = false
        activity.onBackPressedDispatcher.onBackPressed()
        isEnabled = true
      }
    }
    activity.onBackPressedDispatcher.addCallback(activity, callback)
    backCallback = callback
  }

  private fun cancelPendingFileChooser() {
    pendingFileCallback?.onReceiveValue(null)
    pendingFileCallback = null
  }

  private fun injectHook(webView: WebView) {
    val source = hookSource ?: return
    val script = PageHook.wrap(source)
    webView.evaluateJavascript(script) { result ->
      val ok = result != null && (result.contains("ok") || result.contains("already"))
      emitEvent(JSObject().apply {
        put("t", "hook")
        put("ready", ok)
        put("href", webView.url ?: "")
        put("videoCount", 0)
      })
    }
  }

  private fun onPageMessage(message: JSONObject) {
    val type = message.optString("t")
    if (type.isEmpty() || type.length > 32) {
      return
    }
    emitEvent(JSObject().apply {
      put("t", "page")
      put("event", type)
      put("data", message)
    })
  }

  private fun emitNav(webView: WebView, url: String?, loading: Boolean) {
    emitEvent(JSObject().apply {
      put("t", "nav")
      put("url", url ?: webView.url ?: "")
      put("title", webView.title ?: "")
      put("canGoBack", webView.canGoBack())
      put("canGoForward", webView.canGoForward())
      put("loading", loading)
    })
  }

  private fun emitTap(target: WebViewTapRouter.Target, xCss: Float, yCss: Float) {
    emitEvent(JSObject().apply {
      put("t", "tap")
      put(
        "target",
        when (target) {
          WebViewTapRouter.Target.REACT -> "react"
          WebViewTapRouter.Target.SITE -> "site"
          WebViewTapRouter.Target.BLOCKED -> "blocked"
        },
      )
      put("x", xCss.toDouble())
      put("y", yCss.toDouble())
    })
  }

  private fun emitError(message: String) {
    emitEvent(JSObject().apply {
      put("t", "error")
      put("message", message)
    })
  }

  private fun emitEvent(payload: JSObject) {
    mainHandler.post {
      val plugin = pluginRef
      if (plugin != null && plugin.hasSiteListener()) {
        plugin.trigger(HeliWatchPlugin.EVENT, payload)
      } else {
        if (pendingEvents.size >= MAX_PENDING_EVENTS) {
          pendingEvents.removeFirst()
        }
        pendingEvents.addLast(payload)
      }
    }
  }

  private fun flushPending() {
    val plugin = pluginRef ?: return
    while (pendingEvents.isNotEmpty() && plugin.hasSiteListener()) {
      plugin.trigger(HeliWatchPlugin.EVENT, pendingEvents.removeFirst())
    }
  }

  private fun transparent(webView: WebView) {
    webView.setBackgroundColor(Color.TRANSPARENT)
  }
}
