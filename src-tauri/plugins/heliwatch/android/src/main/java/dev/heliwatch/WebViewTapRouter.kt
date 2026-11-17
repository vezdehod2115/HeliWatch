package dev.heliwatch

import org.json.JSONObject

/**
 * Прямоугольники интерактивных элементов React-слоя.
 *
 * React присылает координаты в CSS-пикселях от левого верхнего угла своего WebView
 * вместе с devicePixelRatio. Kotlin переводит их в пиксели экрана, расширяет на
 * 6 dp (запас на границе панели) и на ACTION_DOWN выбирает, кому отдать жест.
 */
class WebViewTapRouter {
  enum class Target { REACT, SITE, BLOCKED }

  private class Region(
    val x: Float,
    val y: Float,
    val w: Float,
    val h: Float,
  )

  private var regions: List<Region> = emptyList()

  @Volatile
  var dpr: Float = 1f
    private set

  @Volatile
  var blocking: Boolean = false
    private set

  fun update(payload: JSONObject?) {
    if (payload == null) {
      regions = emptyList()
      blocking = false
      dpr = 1f
      return
    }
    if (payload.optInt("v", 0) != 1) {
      return
    }
    val scale = payload.optDouble("dpr", 1.0).toFloat()
    dpr = if (scale.isFinite() && scale > 0.1f) scale else 1f

    val parsed = ArrayList<Region>()
    val array = payload.optJSONArray("regions")
    if (array != null) {
      for (index in 0 until array.length()) {
        val item = array.optJSONObject(index) ?: continue
        val x = item.optDouble("x", Double.NaN).toFloat()
        val y = item.optDouble("y", Double.NaN).toFloat()
        val w = item.optDouble("w", Double.NaN).toFloat()
        val h = item.optDouble("h", Double.NaN).toFloat()
        if (!x.isFinite() || !y.isFinite() || !w.isFinite() || !h.isFinite()) {
          continue
        }
        if (w <= 0f || h <= 0f) {
          continue
        }
        parsed.add(Region(x, y, w, h))
      }
    }
    regions = parsed
    blocking = payload.optBoolean("blocking", false)
  }

  /** Точка в пикселях экрана; slop — 6 dp из плана. */
  fun hitTest(x: Float, y: Float, slopPx: Float): Target {
    for (region in regions) {
      val left = region.x * dpr - slopPx
      val top = region.y * dpr - slopPx
      val right = (region.x + region.w) * dpr + slopPx
      val bottom = (region.y + region.h) * dpr + slopPx
      if (x >= left && x <= right && y >= top && y <= bottom) {
        return Target.REACT
      }
    }
    return if (blocking) Target.BLOCKED else Target.SITE
  }
}
