# HeliWatch: правила ProGuard для библиотеки плагина.
# Классы плагина ищутся Tauri по имени через JNI/reflection, поэтому их нельзя
# переименовывать в release-сборке.
-keep class dev.heliwatch.HeliWatchPlugin { *; }
-keep class dev.heliwatch.NativeBridge { *; }
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}
