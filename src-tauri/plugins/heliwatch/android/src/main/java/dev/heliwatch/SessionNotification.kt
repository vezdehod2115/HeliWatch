package dev.heliwatch

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat

/**
 * Уведомление foreground-сервиса комнаты и его кнопки.
 *
 * Канал `heliwatch_room` создаётся один раз. Кнопки не выполняют действие сами:
 * каждая — `PendingIntent` в [MediaActionReceiver], а команду исполняет React
 * (пауза, микрофон, выход из комнаты).
 */
object SessionNotification {
  const val CHANNEL_ID = "heliwatch_room"
  const val NOTIFICATION_ID = 4210

  private const val REQUEST_CONTENT = 4200
  private const val REQUEST_TOGGLE = 4201
  private const val REQUEST_MIC = 4202
  private const val REQUEST_LEAVE = 4203

  fun ensureChannel(context: Context) {
    val manager = context.getSystemService(NotificationManager::class.java) ?: return
    if (manager.getNotificationChannel(CHANNEL_ID) != null) {
      return
    }
    val channel = NotificationChannel(
      CHANNEL_ID,
      "Комната HeliWatch",
      NotificationManager.IMPORTANCE_LOW,
    ).apply {
      description = "Идёт совместный просмотр: голос, чат и управление из шторки"
      setShowBadge(false)
      enableVibration(false)
      setSound(null, null)
    }
    manager.createNotificationChannel(channel)
  }

  fun build(context: Context): Notification {
    ensureChannel(context)
    val builder = NotificationCompat.Builder(context, CHANNEL_ID)
      .setSmallIcon(R.drawable.hw_ic_stat)
      .setContentTitle("HeliWatch · ${SessionState.code}")
      .setContentText(SessionState.notificationText())
      .setSubText(
        when (SessionState.mode) {
          "local" -> "Локальный файл"
          "stream" -> "Файл хоста"
          else -> "Сайт"
        },
      )
      .setContentIntent(contentIntent(context))
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setSilent(true)
      .setShowWhen(false)
      .setCategory(NotificationCompat.CATEGORY_TRANSPORT)
      .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
      .setPriority(NotificationCompat.PRIORITY_LOW)

    val toggle = if (SessionState.playing) "Пауза" else "Играть"
    builder.addAction(
      if (SessionState.playing) R.drawable.hw_ic_pause else R.drawable.hw_ic_play,
      toggle,
      MediaActionReceiver.pendingIntent(
        context,
        MediaActionReceiver.ACTION_TOGGLE,
        MediaActionReceiver.SOURCE_NOTIFICATION,
        REQUEST_TOGGLE,
      ),
    )
    builder.addAction(
      if (SessionState.micOn) R.drawable.hw_ic_mic else R.drawable.hw_ic_mic_off,
      if (SessionState.micOn) "Выключить микрофон" else "Включить микрофон",
      MediaActionReceiver.pendingIntent(
        context,
        MediaActionReceiver.ACTION_MIC,
        MediaActionReceiver.SOURCE_NOTIFICATION,
        REQUEST_MIC,
      ),
    )
    builder.addAction(
      R.drawable.hw_ic_leave,
      "Выйти из комнаты",
      MediaActionReceiver.pendingIntent(
        context,
        MediaActionReceiver.ACTION_LEAVE,
        MediaActionReceiver.SOURCE_NOTIFICATION,
        REQUEST_LEAVE,
      ),
    )

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      builder.setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
    }

    return builder.build()
  }

  private fun contentIntent(context: Context): PendingIntent {
    val launch = context.packageManager.getLaunchIntentForPackage(context.packageName)
      ?: Intent(Intent.ACTION_MAIN).setPackage(context.packageName)
    launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED)
    val flags = PendingIntent.FLAG_UPDATE_CURRENT or
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) PendingIntent.FLAG_IMMUTABLE else 0
    return PendingIntent.getActivity(context, REQUEST_CONTENT, launch, flags)
  }
}
