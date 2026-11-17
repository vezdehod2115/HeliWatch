package dev.heliwatch

import android.app.PendingIntent
import android.app.PictureInPictureParams
import android.app.RemoteAction
import android.content.Intent
import android.graphics.Rect
import android.graphics.drawable.Icon
import android.os.Build
import android.util.Log
import android.util.Rational
import android.widget.FrameLayout
import androidx.appcompat.app.AppCompatActivity
import app.tauri.plugin.JSObject

/**
 * PiP для двух WebView.
 *
 * Пропорции и `sourceRectHint` берутся из текущего видео (React присылает
 * `videoWidth/videoHeight`), действия — пауза/плей, микрофон, «развернуть».
 * На Android 12+ вход делает система (`setAutoEnterEnabled`), на 11 и ниже —
 * `onUserLeaveHint()`. Вход разрешён только при активной комнате.
 */
class PiPController(
  private val activity: AppCompatActivity,
  private val container: () -> FrameLayout?,
  private val onModeChanged: (Boolean) -> Unit,
) {
  var isInPip = false
    private set

  /** Последняя причина отказа: показывается в UI, если PiP недоступен. */
  var lastError: String? = null
    private set

  fun update(state: JSObject?) {
    if (state == null) {
      return
    }
    SessionState.update(
      code = state.optString("code", SessionState.code),
      title = state.optString("title", SessionState.title),
      mode = state.optString("mode", SessionState.mode),
      playing = state.optBoolean("playing", SessionState.playing),
      micOn = state.optBoolean("micOn", SessionState.micOn),
      message = state.optString("message", SessionState.message),
      width = state.optInt("videoWidth", SessionState.videoWidth).takeIf { it > 0 },
      height = state.optInt("videoHeight", SessionState.videoHeight).takeIf { it > 0 },
    )
    if (state.has("roomActive")) {
      SessionState.roomActive = state.optBoolean("roomActive", SessionState.roomActive)
    }
    apply()
  }

  /** Пересчитывает параметры окна: пропорции, зону видео и кнопки. */
  fun apply() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
      return
    }
    if (activity.isFinishing || activity.isDestroyed) {
      return
    }
    runCatching {
      activity.setPictureInPictureParams(buildParams())
    }.onFailure { Log.w(TAG, "setPictureInPictureParams", it) }
  }

  /** Ручной вход из кнопки в панели комнаты. */
  fun enter(): Boolean {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
      lastError = "PiP появился в Android 8"
      return false
    }
    if (isInPip) {
      return true
    }
    if (!SessionState.roomActive) {
      lastError = "Сначала войдите в комнату"
      return false
    }
    if (!SessionState.pipEnabled) {
      lastError = "PiP выключен в настройках HeliWatch"
      return false
    }
    if (activity.isFinishing || activity.isDestroyed) {
      return false
    }
    apply()
    return runCatching {
      activity.enterPictureInPictureMode(buildParams())
    }.onFailure { error ->
      Log.w(TAG, "enterPictureInPictureMode", error)
      lastError = "Устройство не поддержало PiP: ${error.message ?: "ошибка"}"
    }.getOrDefault(false)
  }

  /**
   * Вызывается из MainActivity.onUserLeaveHint. На Android 12+ вход выполняет
   * система по `setAutoEnterEnabled`, поэтому здесь только старые версии.
   */
  fun onUserLeaveHint() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
      return
    }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      return
    }
    if (!SessionState.roomActive || !SessionState.pipEnabled || isInPip) {
      return
    }
    enter()
  }

  fun onModeChanged(inPip: Boolean) {
    isInPip = inPip
    SessionState.pipActive = inPip
    apply()
    onModeChanged(inPip)
  }

  /**
   * Выход из окна: комната закончилась, показывать в PiP больше нечего.
   *
   * Публичного `finishPictureInPictureMode()` у Activity нет, поэтому задачу
   * уводим назад (`moveTaskToBack(false)` для корневой Activity) — система
   * закрывает PiP-окно, приложение остаётся в фоне, а не выпрыгивает на экран.
   */
  fun exit() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O || !isInPip) {
      return
    }
    if (activity.isFinishing || activity.isDestroyed) {
      return
    }
    runCatching {
      if (activity.isInPictureInPictureMode) {
        activity.moveTaskToBack(false)
      }
    }.onFailure { Log.w(TAG, "moveTaskToBack из PiP", it) }
  }

  /** Сброс при выходе из комнаты и при уничтожении Activity. */
  fun release() {
    SessionState.pipActive = false
    isInPip = false
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && !activity.isFinishing) {
      runCatching {
        activity.setPictureInPictureParams(
          PictureInPictureParams.Builder()
            .setAutoEnterEnabled(false)
            .setActions(emptyList())
            .build(),
        )
      }
    }
  }

  // ---------- Внутреннее ----------

  private fun buildParams(): PictureInPictureParams {
    val builder = PictureInPictureParams.Builder()
      .setAspectRatio(aspectRational())
    sourceRect()?.let { rect ->
      if (!rect.isEmpty) {
        builder.setSourceRectHint(rect)
      }
    }
    builder.setActions(buildActions())
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      builder.setAutoEnterEnabled(SessionState.roomActive && SessionState.pipEnabled)
      builder.setSeamlessResizeEnabled(false)
    }
    return builder.build()
  }

  private fun aspectRational(): Rational {
    // Пропорция уже ограничена 0.42…2.39 в SessionState — это лимиты Android PiP.
    val scaled = (SessionState.aspectRatio() * 1000).toInt().coerceAtLeast(1)
    return Rational(scaled, 1000)
  }

  /** Прямоугольник видео в координатах окна: по центру, с сохранением пропорций. */
  private fun sourceRect(): Rect? {
    val view = container() ?: return null
    val width = view.width
    val height = view.height
    if (width <= 0 || height <= 0) {
      return null
    }
    val aspect = SessionState.aspectRatio()
    var rectWidth = width
    var rectHeight = (width / aspect).toInt()
    if (rectHeight > height) {
      rectHeight = height
      rectWidth = (height * aspect).toInt()
    }
    val left = (width - rectWidth) / 2
    val top = (height - rectHeight) / 2
    val location = IntArray(2)
    view.getLocationInWindow(location)
    return Rect(
      location[0] + left,
      location[1] + top,
      location[0] + left + rectWidth,
      location[1] + top + rectHeight,
    )
  }

  private fun buildActions(): List<RemoteAction> {
    if (!SessionState.roomActive) {
      return emptyList()
    }
    val actions = mutableListOf<RemoteAction>()
    actions.add(
      remoteAction(
        icon = if (SessionState.playing) R.drawable.hw_ic_pause else R.drawable.hw_ic_play,
        title = if (SessionState.playing) "Пауза" else "Играть",
        action = MediaActionReceiver.ACTION_TOGGLE,
        requestCode = REQUEST_TOGGLE,
      ),
    )
    actions.add(
      remoteAction(
        icon = if (SessionState.micOn) R.drawable.hw_ic_mic else R.drawable.hw_ic_mic_off,
        title = if (SessionState.micOn) "Выключить микрофон" else "Включить микрофон",
        action = MediaActionReceiver.ACTION_MIC,
        requestCode = REQUEST_MIC,
      ),
    )
    actions.add(
      RemoteAction(
        Icon.createWithResource(activity, R.drawable.hw_ic_expand),
        "Развернуть",
        "Вернуться в HeliWatch",
        expandPendingIntent(),
      ),
    )
    return actions
  }

  private fun remoteAction(
    icon: Int,
    title: String,
    action: String,
    requestCode: Int,
  ): RemoteAction = RemoteAction(
    Icon.createWithResource(activity, icon),
    title,
    title,
    MediaActionReceiver.pendingIntent(
      activity,
      action,
      MediaActionReceiver.SOURCE_PIP,
      requestCode,
    ),
  )

  private fun expandPendingIntent(): PendingIntent {
    val launch = activity.packageManager.getLaunchIntentForPackage(activity.packageName)
      ?: Intent(Intent.ACTION_MAIN).setPackage(activity.packageName)
    launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED)
    val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    return PendingIntent.getActivity(activity, REQUEST_EXPAND, launch, flags)
  }

  companion object {
    private const val TAG = "HeliWatch"
    private const val REQUEST_TOGGLE = 4311
    private const val REQUEST_MIC = 4312
    private const val REQUEST_EXPAND = 4313
  }
}
