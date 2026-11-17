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
}
