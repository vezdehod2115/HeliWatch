package dev.heliwatch.app

import android.os.Bundle
import androidx.activity.enableEdgeToEdge
import dev.heliwatch.HeliWatchBridge

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    // HW:PATCH:MAIN:BEGIN
    HeliWatchBridge.install(this)
    // HW:PATCH:MAIN:END
  }

    // HW:PATCH:INTENT:BEGIN
    override fun onNewIntent(intent: android.content.Intent) {
      super.onNewIntent(intent)
      HeliWatchBridge.handleIntent(intent)
    }
    // HW:PATCH:INTENT:END
}
