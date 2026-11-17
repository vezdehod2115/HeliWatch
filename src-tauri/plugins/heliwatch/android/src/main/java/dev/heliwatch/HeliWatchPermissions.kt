package dev.heliwatch

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat

/**
 * Разрешения этапа 1 — заглушки под будущие голос и сервис.
 * Реально используются только проверки: запрос микрофона включает этап 3,
 * уведомления — этап 4.
 */
object HeliWatchPermissions {
  const val REQUEST_AUDIO = 4101
  const val REQUEST_NOTIFICATIONS = 4102

  fun hasAudio(context: Context): Boolean =
    ContextCompat.checkSelfPermission(
      context,
      Manifest.permission.RECORD_AUDIO,
    ) == PackageManager.PERMISSION_GRANTED

  fun requestAudio(activity: Activity) {
    ActivityCompat.requestPermissions(
      activity,
      arrayOf(Manifest.permission.RECORD_AUDIO),
      REQUEST_AUDIO,
    )
  }

  fun hasNotifications(context: Context): Boolean {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
      return true
    }
    return ContextCompat.checkSelfPermission(
      context,
      Manifest.permission.POST_NOTIFICATIONS,
    ) == PackageManager.PERMISSION_GRANTED
  }

  fun requestNotifications(activity: Activity) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      ActivityCompat.requestPermissions(
        activity,
        arrayOf(Manifest.permission.POST_NOTIFICATIONS),
        REQUEST_NOTIFICATIONS,
      )
    }
  }
}
