use tauri::plugin::{Builder, TauriPlugin};
use tauri::Runtime;

/// Android-плагин HeliWatch: второй WebView, тач-роутинг и мост событий сайта.
///
/// Команды (`site_init`, `site_load`, ...) реализованы в Kotlin в
/// android/src/main/java/dev/heliwatch. Rust регистрирует Android-плагин и
/// объявляет его права; Tauri сам проксирует вызовы JS в Kotlin.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("heliwatch")
        .setup(|_app, api| {
            #[cfg(target_os = "android")]
            api.register_android_plugin("dev.heliwatch", "HeliWatchPlugin")?;
            #[cfg(not(target_os = "android"))]
            let _ = api;
            Ok(())
        })
        .build()
}
