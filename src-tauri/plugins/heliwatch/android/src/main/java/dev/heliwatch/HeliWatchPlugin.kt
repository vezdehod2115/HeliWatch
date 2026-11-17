package dev.heliwatch

import android.app.Activity
import android.util.Log
import android.webkit.WebView
import androidx.appcompat.app.AppCompatActivity
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

/**
 * Kotlin-плагин heliwatch.
 *
 * Tauri сам проксирует `invoke('plugin:heliwatch|site_load')` в метод `siteLoad`
 * (snake_case → lowerCamelCase) и проверяет ACL по сгенерированным permissions.
 * `load(webView)` вызывается, когда Tauri-WebView уже создан и стоит в окне —
 * здесь мы и собираем контейнер из двух WebView.
 */
@TauriPlugin
class HeliWatchPlugin(
  private val hostActivity: Activity,
) : Plugin(hostActivity) {

  override fun load(webView: WebView) {
    Log.i("HeliWatch", "plugin load: begin")
    HeliWatchBridge.attach(hostActivity, webView, this)
    Log.i("HeliWatch", "plugin load: done")
  }

  override fun onPause(activity: AppCompatActivity) {
    HeliWatchBridge.onActivityPause()
  }

  override fun onResume(activity: AppCompatActivity) {
    HeliWatchBridge.onActivityResume()
  }

  override fun onStop(activity: AppCompatActivity) {
    HeliWatchBridge.onActivityStop()
  }

  override fun onDestroy(activity: AppCompatActivity) {
    HeliWatchBridge.destroy()
  }

  /** React подписался на события? Нужно, чтобы не терять самые ранние из них. */
  fun hasSiteListener(): Boolean = hasListener(EVENT)

  @Command
  fun siteInit(invoke: Invoke) {
    val hook = invoke.getArgs().getString("hook", null)
    if (hook.isNullOrBlank()) {
      invoke.reject("site_init: пустой hook")
      return
    }
    HeliWatchBridge.setHookSource(hook)
    invoke.resolve(JSObject().put("ok", true))
  }

  @Command
  fun siteLoad(invoke: Invoke) {
    val url = invoke.getArgs().getString("url", null)
    if (url.isNullOrBlank()) {
      invoke.reject("site_load: пустой url")
      return
    }
    HeliWatchBridge.loadUrl(url)
    invoke.resolve()
  }

  @Command
  fun siteNav(invoke: Invoke) {
    val action = invoke.getArgs().getString("action", null)
    if (action.isNullOrBlank()) {
      invoke.reject("site_nav: пустое действие")
      return
    }
    HeliWatchBridge.navigate(action)
    invoke.resolve()
  }

  @Command
  fun siteCmd(invoke: Invoke) {
    HeliWatchBridge.runPageCommand(invoke.getArgs().getJSObject("cmd"))
    invoke.resolve()
  }

  @Command
  fun siteRegions(invoke: Invoke) {
    HeliWatchBridge.updateRegions(invoke.getArgs().getJSObject("payload"))
    invoke.resolve()
  }

  @Command
  fun siteInfo(invoke: Invoke) {
    invoke.resolve(HeliWatchBridge.info())
  }

  // ---------- Этап 4: фон, PiP, сервис ----------

  /** Снимок комнаты для PiP: пропорции видео, состояние кнопок, сообщение. */
  @Command
  fun pipUpdate(invoke: Invoke) {
    HeliWatchBridge.updatePip(invoke.getArgs().getJSObject("state"))
    invoke.resolve()
  }

  /** Ручной вход в PiP из панели комнаты. */
  @Command
  fun pipEnter(invoke: Invoke) {
    invoke.resolve(HeliWatchBridge.enterPip())
  }

  /** Комната открыта: foreground-сервис, запрос уведомлений, автовход в PiP. */
  @Command
  fun sessionStart(invoke: Invoke) {
    invoke.resolve(
      HeliWatchBridge.startSession(hostActivity, invoke.getArgs().getJSObject("state")),
    )
  }

  @Command
  fun sessionUpdate(invoke: Invoke) {
    HeliWatchBridge.updateSession(invoke.getArgs().getJSObject("state"))
    invoke.resolve()
  }

  @Command
  fun sessionStop(invoke: Invoke) {
    HeliWatchBridge.stopSession()
    invoke.resolve()
  }

  @Command
  fun sessionInfo(invoke: Invoke) {
    invoke.resolve(HeliWatchBridge.sessionInfo())
  }

  /** Экран не гаснет, пока идёт воспроизведение (FLAG_KEEP_SCREEN_ON). */
  @Command
  fun keepScreenOn(invoke: Invoke) {
    HeliWatchBridge.setKeepScreenOn(invoke.getArgs().getBoolean("on", false))
    invoke.resolve()
  }

  companion object {
    const val EVENT = "site-event"
  }
}
