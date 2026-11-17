package dev.heliwatch

import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import android.webkit.JavascriptInterface
import org.json.JSONObject

/**
 * Мост «страница сайта → Kotlin».
 *
 * В WebView сайта регистрируется только `HeliNative.post(String)`. Никаких
 * других методов: страница не должна дотянуться до Activity или файлов.
 * Лимиты из плана: сообщение ≤ 4 КБ и не больше 30 сообщений в секунду —
 * защита от враждебной страницы, которая решит залить канал мусором.
 */
class NativeBridge(
  private val onMessage: (JSONObject) -> Unit,
) {
  private val mainHandler = Handler(Looper.getMainLooper())
  private val rateLock = Any()
  private var windowStartedAt = 0L
  private var windowCount = 0

  @JavascriptInterface
  fun post(raw: String?) {
    if (raw.isNullOrEmpty() || raw.length > MAX_MESSAGE_CHARS) {
      return
    }
    if (!allowMessage()) {
      Log.w(TAG, "HeliNative: превышен лимит сообщений")
      return
    }
    mainHandler.post {
      try {
        onMessage(JSONObject(raw))
      } catch (error: Exception) {
        Log.w(TAG, "HeliNative: некорректный JSON", error)
      }
    }
  }

  private fun allowMessage(): Boolean = synchronized(rateLock) {
    val now = SystemClock.elapsedRealtime()
    if (now - windowStartedAt >= RATE_WINDOW_MS) {
      windowStartedAt = now
      windowCount = 0
    }
    windowCount += 1
    windowCount <= MAX_MESSAGES_PER_WINDOW
  }

  private companion object {
    const val TAG = "HeliWatch"
    const val MAX_MESSAGE_CHARS = 4096
    const val MAX_MESSAGES_PER_WINDOW = 30
    const val RATE_WINDOW_MS = 1000L
  }
}
