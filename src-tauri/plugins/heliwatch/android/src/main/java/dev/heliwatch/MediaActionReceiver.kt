package dev.heliwatch

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log

/**
 * Кнопки PiP-окна и уведомления комнаты.
 *
 * `PendingIntent` ведёт сюда (broadcast), отсюда — событие `pip-action` в React.
 * Решение «играть или пауза» принимает React: он владеет состоянием видео,
 * а Kotlin только переносит нажатие.
 */
class MediaActionReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context?, intent: Intent?) {
    val action = intent?.getStringExtra(EXTRA_ACTION) ?: return
    val source = intent.getStringExtra(EXTRA_SOURCE) ?: SOURCE_NOTIFICATION
    Log.i(TAG, "media action: $action ($source)")
    HeliWatchBridge.onMediaAction(action, source)
  }

  companion object {
    private const val TAG = "HeliWatch"

    const val ACTION_MEDIA = "dev.heliwatch.action.MEDIA"
    const val EXTRA_ACTION = "action"
    const val EXTRA_SOURCE = "source"

    const val SOURCE_PIP = "pip"
    const val SOURCE_NOTIFICATION = "notification"

    const val ACTION_TOGGLE = "toggle"
    const val ACTION_MIC = "mic"
    const val ACTION_EXPAND = "expand"
    const val ACTION_LEAVE = "leave"

    fun pendingIntent(
      context: Context,
      action: String,
      source: String,
      requestCode: Int,
    ): PendingIntent {
      val intent = Intent(context, MediaActionReceiver::class.java).apply {
        this.action = ACTION_MEDIA
        putExtra(EXTRA_ACTION, action)
        putExtra(EXTRA_SOURCE, source)
        // Явный компонент: PendingIntent не уйдёт чужому приложению.
        setPackage(context.packageName)
      }
      val flags = PendingIntent.FLAG_UPDATE_CURRENT or
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) PendingIntent.FLAG_IMMUTABLE else 0
      return PendingIntent.getBroadcast(context, requestCode, intent, flags)
    }
  }
}
