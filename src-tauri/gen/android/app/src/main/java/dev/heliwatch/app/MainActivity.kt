package dev.heliwatch.app

import android.os.Bundle
import android.util.Log
import androidx.activity.enableEdgeToEdge
import dev.heliwatch.HeliWatchBridge

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    Log.i(TAG, "onCreate: begin")
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    Log.i(TAG, "onCreate: after super")
    // HW:PATCH:MAIN:BEGIN
    HeliWatchBridge.install(this)
    // HW:PATCH:MAIN:END
    Log.i(TAG, "onCreate: after install")
  }

    // HW:PATCH:INTENT:BEGIN
    override fun onNewIntent(intent: android.content.Intent) {
      super.onNewIntent(intent)
      HeliWatchBridge.handleIntent(intent)
    }
    // HW:PATCH:INTENT:END

  private companion object {
    const val TAG = "HeliWatch"
  }

  // HW:PATCH:PIP:BEGIN
  override fun onUserLeaveHint() {
    super.onUserLeaveHint()
    HeliWatchBridge.onUserLeaveHint()
  }

  override fun onPictureInPictureModeChanged(
    isInPictureInPictureMode: Boolean,
    newConfig: android.content.res.Configuration,
  ) {
    super.onPictureInPictureModeChanged(isInPictureInPictureMode, newConfig)
    HeliWatchBridge.onPictureInPictureModeChanged(isInPictureInPictureMode)
  }
  // HW:PATCH:PIP:END

  // HW:PATCH:LIFECYCLE:BEGIN
  override fun onPause() {
    super.onPause()
    HeliWatchBridge.onActivityPauseAfterSuper()
  }

  override fun onStop() {
    super.onStop()
    HeliWatchBridge.onActivityStopAfterSuper()
  }
  // HW:PATCH:LIFECYCLE:END
}
