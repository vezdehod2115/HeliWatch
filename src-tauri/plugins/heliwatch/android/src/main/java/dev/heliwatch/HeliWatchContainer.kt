package dev.heliwatch

import android.content.Context
import android.graphics.Color
import android.view.MotionEvent
import android.view.View
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.widget.FrameLayout

/**
 * Контейнер двух WebView: сайт снизу, прозрачный React сверху, слот fullscreen.
 *
 * Обычный hit-test тут не работает: верхний WebView съедает все касания.
 * Поэтому контейнер сам на ACTION_DOWN выбирает цель по прямоугольникам из React
 * и фиксирует её на весь жест, включая все указатели.
 */
class HeliWatchContainer(
  context: Context,
  private val siteWebView: WebView,
  private val tauriWebView: WebView,
) : FrameLayout(context) {

  val tapRouter = WebViewTapRouter()
  var onTap: ((WebViewTapRouter.Target, Float, Float) -> Unit)? = null

  private var gestureTarget: WebViewTapRouter.Target? = null
  private var fullscreenView: View? = null
  private var fullscreenCallback: WebChromeClient.CustomViewCallback? = null
  private val slopPx = 6f * resources.displayMetrics.density

  val isFullscreen: Boolean
    get() = fullscreenView != null

  init {
    setBackgroundColor(Color.TRANSPARENT)
    // WebView'ы добавляет HeliWatchBridge.attach ПОСЛЕ removeView(tauriWebView):
    // на момент load() Tauri-WebView уже лежит в content-контейнере Activity,
    // и addView здесь падал бы с "The specified child already has a parent"
    // (JNI abort при вызове из Rust_onCreate).
  }

  override fun dispatchTouchEvent(ev: MotionEvent): Boolean {
    // В fullscreen всё получает системный слой видео.
    if (fullscreenView != null) {
      return super.dispatchTouchEvent(ev)
    }

    when (ev.actionMasked) {
      MotionEvent.ACTION_DOWN -> {
        val target = tapRouter.hitTest(ev.x, ev.y, slopPx)
        gestureTarget = target
        val scale = tapRouter.dpr.coerceAtLeast(0.5f)
        onTap?.invoke(target, ev.x / scale, ev.y / scale)
        if (target == WebViewTapRouter.Target.BLOCKED) {
          return true
        }
        val child = childFor(target) ?: return true
        child.requestFocus()
        child.dispatchTouchEvent(ev)
        return true
      }

      MotionEvent.ACTION_MOVE,
      MotionEvent.ACTION_POINTER_DOWN,
      MotionEvent.ACTION_POINTER_UP -> {
        val target = gestureTarget ?: return super.dispatchTouchEvent(ev)
        if (target == WebViewTapRouter.Target.BLOCKED) {
          return true
        }
        childFor(target)?.dispatchTouchEvent(ev)
        return true
      }

      MotionEvent.ACTION_UP,
      MotionEvent.ACTION_CANCEL -> {
        val target = gestureTarget
        gestureTarget = null
        if (target == null) {
          return super.dispatchTouchEvent(ev)
        }
        if (target != WebViewTapRouter.Target.BLOCKED) {
          childFor(target)?.dispatchTouchEvent(ev)
        }
        return true
      }

      else -> return super.dispatchTouchEvent(ev)
    }
  }

  fun showFullscreen(view: View, callback: WebChromeClient.CustomViewCallback) {
    if (fullscreenView != null) {
      fullscreenCallback?.onCustomViewHidden()
      return
    }
    fullscreenView = view
    fullscreenCallback = callback
    siteWebView.visibility = View.INVISIBLE
    tauriWebView.visibility = View.INVISIBLE
    addView(
      view,
      LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT),
    )
    view.requestFocus()
  }

  fun hideFullscreen() {
    val view = fullscreenView ?: return
    fullscreenView = null
    fullscreenCallback = null
    removeView(view)
    siteWebView.visibility = View.VISIBLE
    tauriWebView.visibility = View.VISIBLE
  }

  fun destroy() {
    hideFullscreen()
    tapRouter.update(null)
  }

  private fun childFor(target: WebViewTapRouter.Target): WebView? = when (target) {
    WebViewTapRouter.Target.REACT -> tauriWebView
    WebViewTapRouter.Target.SITE -> siteWebView
    WebViewTapRouter.Target.BLOCKED -> null
  }
}
