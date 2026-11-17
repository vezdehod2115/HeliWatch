package dev.heliwatch

import android.util.Log
import android.webkit.WebView
import java.lang.ref.WeakReference

/**
 * Не даёт WebView «заснуть» в PiP и в фоне, пока комната активна.
 *
 * `WryActivity.onPause()` вызывает `WebView.onPause()` у Tauri-WebView, а
 * Chromium может останавливать таймеры процесса, когда Activity уходит назад.
 * Поэтому после `super.onPause()`/`super.onStop()` плагин возвращает оба WebView
 * в активное состояние: `onResume()` + глобальный `resumeTimers()`.
 *
 * Спайк-проверка на телефоне — счётчик в PiP-слое React (`PipLayer`): он тикает
 * раз в секунду и в свёрнутом окне, и в фоне.
 */
object TimerGuard {
  private const val TAG = "HeliWatch"

  private val views = mutableListOf<WeakReference<WebView>>()
  private var foreground = true

  fun register(vararg webViews: WebView) {
    views.clear()
    for (view in webViews) {
      views.add(WeakReference(view))
    }
  }

  fun clear() {
    views.clear()
  }

  fun setForeground(value: Boolean) {
    foreground = value
  }

  fun isForeground(): Boolean = foreground

  /**
   * Вызывается после `super.onPause()`/`super.onStop()` из плагина.
   * Возвращает true, если комната активна и таймеры пришлось «будить».
   */
  fun keepAlive(): Boolean {
    if (!SessionState.roomActive) {
      return false
    }
    for (ref in views) {
      val view = ref.get() ?: continue
      runCatching {
        view.resumeTimers()
        view.onResume()
      }.onFailure { Log.w(TAG, "TimerGuard: не удалось разбудить WebView", it) }
    }
    return true
  }
}
