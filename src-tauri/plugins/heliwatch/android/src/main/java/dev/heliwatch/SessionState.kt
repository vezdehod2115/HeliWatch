package dev.heliwatch

/**
 * Состояние активной комнаты, общее для PiP и foreground-сервиса.
 *
 * Живёт в процессе приложения: React присылает снимок (`session_start` /
 * `session_update`), Kotlin использует его для окна PiP, уведомления и
 * WakeLock'а. Источник истины по-прежнему React — здесь только копия,
 * чтобы системные колбэки (кнопки PiP, уведомление) отвечали без JS.
 */
object SessionState {
  /** Комната открыта: можно входить в PiP и держать сервис. */
  var roomActive = false

  var code = ""
  var title = ""
  var mode = "site"
  var playing = false

  /** Микрофон реально передаёт звук (включён и не замьючен). */
  var micOn = false

  /** Последнее сообщение чата: строка в PiP-окне и в уведомлении. */
  var message = ""

  var videoWidth = 16
  var videoHeight = 9

  /** Окно PiP прямо сейчас на экране. */
  var pipActive = false

  /** Настройка «автовход в PiP» (этап 7): false — PiP не открывается сам. */
  var pipEnabled = true

  fun update(
    code: String? = null,
    title: String? = null,
    mode: String? = null,
    playing: Boolean? = null,
    micOn: Boolean? = null,
    message: String? = null,
    width: Int? = null,
    height: Int? = null,
    pipEnabled: Boolean? = null,
  ) {
    if (code != null) {
      this.code = code
    }
    if (title != null) {
      this.title = title
    }
    if (mode != null) {
      this.mode = mode
    }
    if (playing != null) {
      this.playing = playing
    }
    if (micOn != null) {
      this.micOn = micOn
    }
    if (message != null) {
      this.message = message
    }
    if (width != null && width > 0) {
      this.videoWidth = width
    }
    if (height != null && height > 0) {
      this.videoHeight = height
    }
    if (pipEnabled != null) {
      this.pipEnabled = pipEnabled
    }
  }

  /** Пропорции текущего видео с разумными границами Android PiP (0.42…2.39). */
  fun aspectRatio(): Float {
    val width = videoWidth.coerceAtLeast(1)
    val height = videoHeight.coerceAtLeast(1)
    val aspect = width.toFloat() / height.toFloat()
    return aspect.coerceIn(MIN_ASPECT, MAX_ASPECT)
  }

  fun notificationText(): String {
    val state = if (playing) "смотрим" else "на паузе"
    val mic = if (micOn) ", микрофон включён" else ""
    return "Комната $code · $state$mic"
  }

  fun reset() {
    roomActive = false
    code = ""
    title = ""
    mode = "site"
    playing = false
    micOn = false
    message = ""
    videoWidth = 16
    videoHeight = 9
    pipActive = false
    pipEnabled = true
  }

  const val MIN_ASPECT = 0.42f
  const val MAX_ASPECT = 2.39f
}
