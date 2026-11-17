package dev.heliwatch

import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.util.Log
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import java.lang.ref.WeakReference

/**
 * Foreground-сервис активной комнаты.
 *
 * Держит процесс и WebView живыми в фоне: тип `mediaPlayback` объявляется сразу,
 * `microphone` добавляется вторым `startForeground` только когда микрофон реально
 * включён и RECORD_AUDIO выдан (требование Android 14: без этого типа система
 * глушит микрофон в фоне). WakeLock — partial, с таймаутом, только пока комната
 * активна.
 */
class SessionService : Service() {
  private var wakeLock: PowerManager.WakeLock? = null
  private var foregroundStarted = false

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onCreate() {
    super.onCreate()
    SessionNotification.ensureChannel(this)
    instance = WeakReference(this)
    acquireWakeLock()
    isRunning = true
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    when (intent?.action) {
      ACTION_START -> {
        readState(intent)
        SessionState.roomActive = true
        isRunning = true
        raiseForeground()
      }

      ACTION_UPDATE -> {
        readState(intent)
        refresh()
      }

      ACTION_STOP -> stopRoom()
      else -> Log.w(TAG, "неизвестное действие сервиса: ${intent?.action}")
    }
    return START_NOT_STICKY
  }

  /** Обновление состояния из плагина: уведомление, тип сервиса, WakeLock. */
  fun refresh() {
    acquireWakeLock()
    raiseForeground()
  }

  override fun onDestroy() {
    releaseWakeLock()
    if (foregroundStarted) {
      runCatching {
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
      }
      foregroundStarted = false
    }
    if (instance?.get() === this) {
      instance = null
    }
    isRunning = false
    super.onDestroy()
  }

  // ---------- Внутреннее ----------

  private fun readState(intent: Intent) {
    SessionState.update(
      code = intent.getStringExtra(EXTRA_CODE),
      title = intent.getStringExtra(EXTRA_TITLE),
      mode = intent.getStringExtra(EXTRA_MODE),
      playing = intent.getBooleanExtra(EXTRA_PLAYING, SessionState.playing),
      micOn = intent.getBooleanExtra(EXTRA_MIC, SessionState.micOn),
      message = intent.getStringExtra(EXTRA_MESSAGE),
    )
  }

  private fun raiseForeground() {
    val notification = SessionNotification.build(this)
    val type = foregroundType()
    try {
      ServiceCompat.startForeground(this, SessionNotification.NOTIFICATION_ID, notification, type)
      foregroundStarted = true
    } catch (error: Exception) {
      // Android 12+ запрещает старт сервиса из фона, Android 14 — microphone-тип
      // без активного микрофона. Комната продолжает работать, приложение не падает.
      Log.e(TAG, "startForeground не удался (type=$type)", error)
      HeliWatchBridge.onServiceError("Фоновый режим недоступен: ${error.message ?: "ошибка"}")
      if (type != 0) {
        runCatching {
          ServiceCompat.startForeground(
            this,
            SessionNotification.NOTIFICATION_ID,
            notification,
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
              ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK
            } else {
              0
            },
          )
          foregroundStarted = true
        }.onFailure { Log.e(TAG, "startForeground без типа тоже не удался", it) }
      }
    }
  }

  /**
   * `microphone`-тип добавляется только когда микрофон включён и разрешён:
   * на Android 14 иначе SecurityException, а до Android 11 тип объявлять нечем.
   */
  private fun foregroundType(): Int {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
      return 0
    }
    var type = ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R &&
      SessionState.micOn &&
      HeliWatchPermissions.hasAudio(this)
    ) {
      type = type or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
    }
    return type
  }

  private fun stopRoom() {
    SessionState.roomActive = false
    if (foregroundStarted) {
      ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
      foregroundStarted = false
    }
    releaseWakeLock()
    stopSelf()
  }

  private fun acquireWakeLock() {
    if (!SessionState.roomActive) {
      return
    }
    try {
      if (wakeLock?.isHeld == true) {
        wakeLock?.release()
      }
      val manager = getSystemService(PowerManager::class.java) ?: return
      wakeLock = manager.newWakeLock(
        PowerManager.PARTIAL_WAKE_LOCK,
        "heliwatch:room",
      ).apply {
        setReferenceCounted(false)
        acquire(WAKE_TIMEOUT_MS)
      }
    } catch (error: Exception) {
      Log.w(TAG, "WakeLock не выдан", error)
      wakeLock = null
    }
  }

  private fun releaseWakeLock() {
    val lock = wakeLock
    wakeLock = null
    runCatching {
      if (lock?.isHeld == true) {
        lock.release()
      }
    }.onFailure { Log.w(TAG, "WakeLock release", it) }
  }

  companion object {
    private const val TAG = "HeliWatch"
    private const val ACTION_START = "dev.heliwatch.SESSION_START"
    private const val ACTION_UPDATE = "dev.heliwatch.SESSION_UPDATE"
    private const val ACTION_STOP = "dev.heliwatch.SESSION_STOP"

    private const val EXTRA_CODE = "code"
    private const val EXTRA_TITLE = "title"
    private const val EXTRA_MODE = "mode"
    private const val EXTRA_PLAYING = "playing"
    private const val EXTRA_MIC = "mic"
    private const val EXTRA_MESSAGE = "message"

    private const val WAKE_TIMEOUT_MS = 10 * 60 * 1000L

    /** Сервис запущен в текущем процессе. */
    var isRunning = false
      private set

    private var instance: WeakReference<SessionService>? = null

    /** Стартует сервис и возвращает текст ошибки или null, если всё хорошо. */
    fun start(context: Context): String? {
      SessionNotification.ensureChannel(context)
      val intent = Intent(context, SessionService::class.java).setAction(ACTION_START)
      putState(intent)
      return try {
        ContextCompat.startForegroundService(context, intent)
        null
      } catch (error: Exception) {
        Log.e(TAG, "не удалось запустить SessionService", error)
        "Фоновый сервис не запустился: ${error.message ?: "ошибка"}"
      }
    }

    /**
     * Обновляет уведомление и тип сервиса после смены микрофона/воспроизведения.
     *
     * Если сервис уже жив, метод зовётся напрямую: `startForegroundService` из
     * фона на Android 12+ может быть запрещён, а прямой вызов — нет.
     */
    fun update(context: Context) {
      instance?.get()?.let { service ->
        service.refresh()
        return
      }
      if (!isRunning) {
        return
      }
      val intent = Intent(context, SessionService::class.java).setAction(ACTION_UPDATE)
      putState(intent)
      runCatching { ContextCompat.startForegroundService(context, intent) }
        .onFailure { Log.w(TAG, "SessionService.update", it) }
    }

    fun stop(context: Context) {
      val intent = Intent(context, SessionService::class.java)
      runCatching { context.stopService(intent) }
        .onFailure { Log.w(TAG, "SessionService.stop", it) }
      isRunning = false
    }

    private fun putState(intent: Intent) {
      intent.putExtra(EXTRA_CODE, SessionState.code)
      intent.putExtra(EXTRA_TITLE, SessionState.title)
      intent.putExtra(EXTRA_MODE, SessionState.mode)
      intent.putExtra(EXTRA_PLAYING, SessionState.playing)
      intent.putExtra(EXTRA_MIC, SessionState.micOn)
      intent.putExtra(EXTRA_MESSAGE, SessionState.message)
    }
  }
}
