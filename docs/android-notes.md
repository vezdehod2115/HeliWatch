# Android-слой: что правим в gen/android и как восстановить

`src-tauri/gen/android` — часть репозитория. Папку создаёт `tauri android init`,
а наши правки применяет идемпотентный скрипт. Если папку перегенерировали,
достаточно двух команд:

```powershell
pnpm tauri android init   # пересоздаёт gen/android (спросит подтверждение)
pnpm android:patch        # возвращает все правки HeliWatch
pnpm android:doctor       # проверяет, что ничего не потеряно
```

## Что именно правится

`scripts/apply-android-patches.mjs`:

| Файл | Правка |
|---|---|
| `app/build.gradle.kts` | `compileSdk = 36`, `targetSdk = 36`, `minSdk = 26` |
| `app/src/main/AndroidManifest.xml` | маркер `HW:PATCH:ACTIVITY`, `configChanges` + `density`, `windowSoftInputMode=adjustResize`, `resizeableActivity=true`, deep link `heliwatch://` (`HW:PATCH:DEEPLINK`) |
| `app/src/main/java/dev/heliwatch/app/MainActivity.kt` | `HeliWatchBridge.install(this)` и `onNewIntent → handleIntent` между маркерами `HW:PATCH:MAIN` / `HW:PATCH:INTENT` |
| `app/src/main/res/values/strings.xml` | `app_name` и `main_activity_title` = «HeliWatch» |
| `app/src/main/res/values*/themes.xml` | `Theme.Material3.Dark.NoActionBar`, тёмный `windowBackground`, прозрачные системные бары |
| `app/src/main/res/values/hw_branding.xml` | цвета окна и иконки |
| `app/src/main/res/drawable/hw_icon_foreground.xml` | вектор знака H-плеер |
| `app/src/main/res/mipmap-anydpi-v26/ic_launcher*.xml` | адаптивная иконка + monochrome |
| `app/src/main/assets/` | копии `public/test-page.html`, `public/test-video.mp4`, sha256-манифест |

`scripts/icons.mjs` (`pnpm icons`) вызывает `tauri icon` из
`docs/branding/icon-source.png`; PNG-иконки `mipmap-*` обновляются в
`gen/android` напрямую (адаптивные XML-файлы после этого лучше применить заново:
`pnpm android:patch`).

## Почему Kotlin-плагин не прописан в settings.gradle руками

Tauri CLI при сборке читает cargo-metadata плагинов (build script печатает
`cargo:android_library_path`) и генерирует служебные файлы:

- `gen/android/tauri.settings.gradle` — `include ':tauri-plugin-heliwatch'` и путь
  к `src-tauri/plugins/heliwatch/android`;
- `gen/android/tauri.build.gradle.kts` — `implementation` плагина для `:app`.

Оба файла в `.gitignore` (`gen/android/.gitignore`) и пересоздаются при каждой
сборке. Поэтому в шаблоне `settings.gradle` остаётся только `apply from`, а
`pnpm android:doctor` предупреждает, если файлы ещё не появились (до первой
сборки это нормально). Если в вашей версии CLI автоподключение не сработало,
добавьте вручную:

```groovy
include ':tauri-plugin-heliwatch'
project(':tauri-plugin-heliwatch').projectDir = new File(rootDir, '../../plugins/heliwatch/android')
```

и `implementation(project(":tauri-plugin-heliwatch"))` в `app/build.gradle.kts`.

## Как устроен контейнер

1. Wry/Tauri создаёт `RustWebView` и вызывает `setContentView(webView)`.
2. Плагин получает WebView в `load(webView)`, создаёт `HeliWatchContainer` и
   переносит Tauri-WebView внутрь контейнера: сайт — снизу, React — сверху.
3. Контейнер перехватывает `dispatchTouchEvent`: на `ACTION_DOWN` выбирает цель
   по списку прямоугольников из React, фиксирует её на весь жест и отдаёт события
   нужному WebView напрямую. Верхний прозрачный WebView больше не «съедает» тапы.
4. `HeliWatchBridge.install(this)` в `MainActivity.onCreate` регистрирует
   back-обработчик, launcher системного выбора файла и разбирает стартовый
   `Intent` со ссылкой `heliwatch://r/<код>`. Повторное открытие ссылки при
   `launchMode=singleTask` приходит в `onNewIntent` — там вызывается
   `HeliWatchBridge.handleIntent(intent)` (маркер `HW:PATCH:INTENT`).
5. Сайт стартует с прозрачной заглушки; React при монтировании шлёт
   `site_init` (исходник `site-hook.js`) и `site_load` (тестовая страница).
6. SQLite открывается из JS через `@tauri-apps/plugin-sql`; миграции
   (`src-tauri/src/db.rs`) регистрируются в Rust-плагине `tauri-plugin-sql` с
   feature `sqlite` и применяются при `Database.load('sqlite:heliwatch.db')`.
   В `capabilities/default.json` нужны `sql:default` и `sql:allow-execute`:
   набор `sql:default` разрешает только load/select/close.

## Окружение (Windows, проверено)

- JDK 17 (Temurin) — `JAVA_HOME`;
- Android SDK: platform 36, build-tools 36.0.0 — `ANDROID_HOME`;
- NDK 27.2 — `NDK_HOME`;
- Rust targets: `aarch64-linux-android`, `armv7-linux-androideabi`,
  `i686-linux-android`, `x86_64-linux-android`;
- Node.js 22.12+, pnpm 10.

Сборка:

```powershell
$env:JAVA_HOME="C:\Program Files\Eclipse Adoptium\jdk-17.0.21.9-hotspot"
$env:ANDROID_HOME="C:\Android\Sdk"
$env:NDK_HOME="C:\Android\Sdk\ndk\27.2.12479018"
pnpm android:apk
```

APK: `src-tauri/gen/android/app/build/outputs/apk/universal/debug/`.

## Windows без Developer Mode

На машине без режима разработчика (и без права создавать символьные ссылки)
`pnpm tauri android build --apk --debug` доходит до упаковки `.so` и падает:
`Failed to create a symbolic link ... jniLibs`. Плюс `cc`/`cl.exe` может не
собрать C-часть `libsqlite3-sys` (SQLite-плагин) или `vswhom-sys` с
debug-информацией (`D8050`). Поэтому сборка идёт с `CARGO_PROFILE_DEV_DEBUG=0`.
Обход, которым собран APK 0.2.0:

```powershell
# 1. Сборка dist + Rust для arm64. Ошибка symlink в конце ожидаема:
$env:CARGO_PROFILE_DEV_DEBUG="0"
$env:JAVA_HOME="C:\Program Files\Eclipse Adoptium\jdk-17.0.21.9-hotspot"
$env:ANDROID_HOME="C:\Android\Sdk"
$env:NDK_HOME="C:\Android\Sdk\ndk\27.2.12479018"
pnpm tauri android build --apk --debug

# 2. Кладём .so в jniLibs вручную:
$jni = "src-tauri/gen/android/app/src/main/jniLibs/arm64-v8a"
New-Item -ItemType Directory -Force $jni | Out-Null
Copy-Item "src-tauri/target/aarch64-linux-android/debug/libheliwatch_lib.so" "$jni/" -Force

# 3. Gradle без rust-задач (они снова упрутся в symlink):
.\src-tauri\gen\android\gradlew.bat -p src-tauri/gen/android assembleUniversalDebug `
  -x rustBuildUniversalDebug -x rustBuildArm64Debug -x rustBuildArmDebug `
  -x rustBuildX86Debug -x rustBuildX86_64Debug --console=plain
```

Получится APK только для arm64-v8a. Если нужен эмулятор x86_64, соберите
соответствующий Rust-таргет тем же способом и добавьте `.so` в
`jniLibs/x86_64/`. Включение режима разработчика Windows или `mklink /H`
не помогут: cargo-mobile2 создаёт именно символьную ссылку.

## Частые проблемы

| Симптом | Что проверить |
|---|---|
| `compileSdk 37 not installed` | Вернуть `compileSdk = 36` скриптом (`pnpm android:patch`) или доставить platform 37; проекту нужен 36. |
| «Permission heliwatch:default not found» | Сборка плагина упала раньше; проверьте `links = "tauri-plugin-heliwatch"` в его `Cargo.toml` и `pnpm android:doctor`. |
| Плагин не компилируется в Gradle | `tauri.settings.gradle`/`tauri.build.gradle.kts` не сгенерированы: пересоберите через CLI (не через Android Studio в первый раз). |
| Белая вспышка при старте | Тема и `windowBackground` перетёрты — повторите `pnpm android:patch`. |
| Сайт не виден под React | Проверьте `setBackgroundColor(TRANSPARENT)` у Tauri-WebView и `transparent: true` в `tauri.conf.json`; на некоторых прошивках включите запасной split-режим (этап 4). |
| Тапы по панели уходят на сайт | Откройте «Отладка → зоны касания» (иконка жука): красные рамки — то, что реально пришло в Kotlin. Проверьте dpr и пересчёт после анимации. |
| Клавиатура скрывает панель | В манифесте должен быть `windowSoftInputMode="adjustResize"`; React пересылает зоны на `visualViewport.resize`. |
| Back закрывает приложение с первого раза | Не применён `HeliWatchBridge.install(this)`; `pnpm android:doctor` покажет. |
| APK огромный | `public/test-video.mp4` попадает и в assets сайта, и в Tauri-бандл. Для релиза заменить на короткий ролик или стримить по URL. |
| `vswhom-sys`: `D8050` при `cl.exe` | Собирать с `CARGO_PROFILE_DEV_DEBUG=0` (символы Rust не нужны для проверки) или включить Developer Mode/полноценный VS Build Tools. |
| `Failed to create a symbolic link ... jniLibs` | Windows без Developer Mode: см. раздел выше — скопировать `.so` и запустить Gradle с `-x rustBuild...`. |

## Ручное восстановление за 5 минут

Если скрипты недоступны:

1. `pnpm tauri android init`;
2. в `app/build.gradle.kts` — 36/36/26;
3. в манифесте — `configChanges` с `density`, `adjustResize`, `resizeableActivity`;
4. в `MainActivity.onCreate` — `HeliWatchBridge.install(this)`;
5. скопировать `public/test-page.html` и `public/test-video.mp4` в
   `app/src/main/assets/`;
6. `pnpm icons` и `pnpm android:patch` (или вручную повторить ресурсы из таблицы).

После любого восстановления: `pnpm android:doctor`.
