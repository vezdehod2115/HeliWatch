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
| `app/src/main/AndroidManifest.xml` | маркер `HW:PATCH:ACTIVITY`, `configChanges` + `density`, `windowSoftInputMode=adjustResize`, `resizeableActivity=true`, `supportsPictureInPicture=true` (этап 4), deep link `heliwatch://` (`HW:PATCH:DEEPLINK`) |
| `app/src/main/java/dev/heliwatch/app/MainActivity.kt` | `HeliWatchBridge.install(this)` и `onNewIntent → handleIntent` между маркерами `HW:PATCH:MAIN` / `HW:PATCH:INTENT`, прокси `onUserLeaveHint` и `onPictureInPictureModeChanged` между маркерами `HW:PATCH:PIP`, `onPause`/`onStop` после `super` между маркерами `HW:PATCH:LIFECYCLE` (этап 8, иначе WebView остаётся на паузе) |
| `app/src/main/res/values/strings.xml` | `app_name` и `main_activity_title` = «HeliWatch» |
| `app/src/main/res/values*/themes.xml` | `Theme.Material3.Dark.NoActionBar`, тёмный `windowBackground`, прозрачные системные бары |
| `app/src/main/res/values/hw_branding.xml` | цвета окна и иконки |
| `app/src/main/res/drawable/hw_icon_foreground.xml` | вектор знака H-плеер |
| `app/src/main/res/mipmap-anydpi-v26/ic_launcher*.xml` | адаптивная иконка + monochrome |
| `app/src/main/assets/` | копии `public/blank.html`, `public/test-page.html`, `public/test-video.mp4`, sha256-манифест |

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
   Важно: конструктор контейнера **не добавляет** WebView'ы. Сначала
   `removeView(tauriWebView)` у старого родителя, затем `addView` сайта и
   Tauri-WebView ровно по одному разу. Иначе `addView` бросает
   `IllegalStateException: The specified child already has a parent`, а
   исключение через JNI из `Rust_onCreate` превращается в `SIGABRT`
   (`JNI GetJavaVM called with pending exception`).
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
   С 0.8.1 по умолчанию открывается пустая `blank.html` с зелёным градиентом
   темы: тестовая страница осталась диагностическим ассетом и в комнате не
   показывается.
6. SQLite открывается из JS через `@tauri-apps/plugin-sql`; миграции
   (`src-tauri/src/db.rs`) регистрируются в Rust-плагине `tauri-plugin-sql` с
   feature `sqlite` и применяются при `Database.load('sqlite:heliwatch.db')`.
   В `capabilities/default.json` нужны `sql:default` и `sql:allow-execute`:
   набор `sql:default` разрешает только load/select/close.

## PiP и фон (этап 4)Свои компоненты объявлены в **библиотечном манифесте плагина**
(`plugins/heliwatch/android/src/main/AndroidManifest.xml`) — AGP смержит их сам:

- `SessionService`: `foregroundServiceType="mediaPlayback|microphone"`,
  `stopWithTask="true"`;
- `MediaActionReceiver`: `exported="false"`, `PendingIntent` приходит с явным
  компонентом;
- `uses-feature android.software.picture_in_picture required="false"`.

В `gen/android` руками правится только Activity (маркеры `HW:PATCH:ACTIVITY` и
`HW:PATCH:PIP`): `supportsPictureInPicture="true"` и прокси
`onUserLeaveHint`/`onPictureInPictureModeChanged` — Tauri не отдаёт эти колбэки
плагину.

Как это работает:

1. React при входе в комнату шлёт `session_start` (code, mode, playing, micOn,
   message, videoWidth/Height). Kotlin стартует `SessionService`, просит
   POST_NOTIFICATIONS на Android 13+ и включает `setAutoEnterEnabled`.
2. Каждое изменение (пауза, микрофон, последнее сообщение, пропорции) приходит
   в `session_update` и `pip_update`. Обновлений немного: React сравнивает
   подпись снимка и не шлёт одинаковые.
3. Уход из приложения: Android 12+ входит в PiP сам, на 8–11 —
   `onUserLeaveHint` → `enterPictureInPictureMode`. Вход разрешён только при
   активной комнате.
4. Кнопки PiP (`RemoteAction`) и уведомления → `MediaActionReceiver` →
   `pip-action` в React → команда исполняется и состояние возвращается обратно.
5. `TimerGuard` после `super.onPause()`/`super.onStop()` будит оба WebView
   (`onResume` + `resumeTimers`) — `setInterval`, DataChannel и голос живут в
   фоне. Проверка — счётчик времени в PiP-полосе.

### Этап 8: почему PiP замирал и как это исправлено

`WryActivity.onPause()` вызывает `Rust.onPause()` (а тот — наш плагин), и только
**после** этого — `mWebView.onPause()` у Tauri-WebView. Поэтому `TimerGuard`
внутри `onPause` будил WebView, которого через мгновение снова усыпляли: React
замирал, PiP показывал стоп-кадр, а при возврате приложение «висело» на очереди
событий. Теперь `MainActivity.onPause/onStop` после `super` зовут
`HeliWatchBridge.onActivityPauseAfterSuper()/onActivityStopAfterSuper()`, и оба
WebView действительно остаются живыми.

Второй баг — команды Tauri приходят из JNI-потока. `setPictureInPictureParams`
и `enterPictureInPictureMode` можно звать только из main, иначе они молча не
применялись (автовход «свайпом» не включался). `PiPController` маршалит вызовы
через `Looper`/`runOnUiThread`, а `pip_enter` ждёт результат через `CountDownLatch`.

В PiP режима «Сайт» React-слой скрывается (`HeliWatchContainer.setPipMode(...,
keepReact = false)`): видео рисует нативный WebView, второй полноэкранный слой
только нагружает композитор. `page-hook` в PiP не снимает кадр акцента, не
крутит `MutationObserver` и раз в 2.5 с пересканирует `<video>`; зоны касания в
React не отправляются (`setRegionSyncPaused`).

**Выбор фото в чате** больше не ставит видео на паузу: пока комната активна,
сайт не усыпляется на `onPause`; для локального файла WebView будится после
`super.onPause()`, а если система всё же остановила `<video>`, Kotlin шлёт
`resume-playback`, и React повторяет play. Системный пикер Tauri-WebView (фото в
чате) мы не перехватываем — флаг `fileChooserOpen` относится к пикеру сайта; для
пикера React срабатывает общий механизм возврата.

### Видео-окно комнаты (этап 8)

Адресной строки в комнате нет. `RoomScreen` измеряет прямоугольник
`VideoWindow` и шлёт `site_cmd {cmd:'setWindow', on, x, y, w, h, radius}`;
`site-hook.js` добавляет `html.hw-framed`:

```css
html.hw-framed body > * { visibility: hidden !important; }
html.hw-framed body video { visibility: visible !important; position: fixed !important;
  left: var(--hw-vx); top: var(--hw-vy); width: var(--hw-vw); height: var(--hw-vh) }
```

Предки видео получают класс `hw-frame-plain`, который сбрасывает
`transform`/`filter`/`contain` (иначе `fixed` прилипает к контейнеру плеера).
Координаты переводятся из CSS-пикселей экрана в layout viewport по
`visualViewport` — для страниц, отрисованных в десктопном layout. При навигации
`hook-ready` заставляет React прислать прямоугольник заново. В режиме поиска
(`setWindow off`) страница показывается целиком; выбор ролика возвращает
`browse = false`, и окно снова позиционирует видео. Тот же механизм использует
PiP: кадр разворачивается на весь экран.

### Зоны касания и модалки (этап 8)

`regions.ts` держит `MutationObserver` на `body` и заново подписывает
`ResizeObserver` на новые `[data-hw-region]`: без этого зона модалки появлялась
только со следующим heartbeat, и первый тап уходил сайту. Модалки помечены
`data-hw-block` — `snapshotRegions` включает `blocking`, и тап вне React-зон
гасится, а не проваливается в site-WebView. `MAX_REGIONS` поднят до 32,
дебаунс — 60 мс, heartbeat — 900 мс.

Диагностика:

```powershell
adb logcat -s HeliWatch:V ActivityManager:I | Select-String "SessionService|PiP|startForeground"
# что система думает о сервисе
adb shell dumpsys activity services dev.heliwatch.app.debug | Select-String "SessionService|foregroundServiceType"
# текущий режим Activity
adb shell dumpsys activity activities | Select-String "pinned|PiP|mPictureInPicture"
```

## Файлы, кэш и бэкап (этап 7)

Кэш фото и аватаров, а также выбор файла бэкапа появились вместе с
`tauri-plugin-fs` 2.7 и `tauri-plugin-dialog` 2.8:

- **Кэш фото** — `$APPCACHE/heliwatch-media/<sha256>.jpg`, индекс в таблице
  `media_cache`; LRU 200 МБ. **Аватары** — `$APPDATA/heliwatch-avatars/`, LRU 50
  файлов / 5 МБ. Пути относительные, `baseDir` задаёт плагин.
- **Права** (`src-tauri/capabilities/default.json`): `fs:allow-appcache-read-recursive`,
  `fs:allow-appcache-write-recursive`, `fs:allow-appdata-read-recursive`,
  `fs:allow-appdata-write-recursive`, `fs:allow-appdata-meta-recursive`,
  `dialog:default`. Без них `writeFile`/`readFile` возвращают отказ, а кэш молча
  пуст.
- **Бэкап**: путь выбирает `plugin-dialog` (SAF на Android возвращает
  `content://`), а файл пишет/читает `plugin-fs` — его Android-часть умеет
  открывать content-URI через ContentResolver. Поэтому `backup.ts` вызывает
  `writeTextFile`/`readTextFile`, а не `std::fs`: обычный путь к `content://`
  не применим. Диалог добавляет выбранный файл в scope, прав на весь диск нет.
- **Проверка на устройстве:** экспорт → файл открывается любым просмотрщиком
  JSON; импорт «слить» не стирает локальных друзей; импорт «заменить» меняет
  идентичность только при валидной паре ключей.

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

## Диагностика запуска (0.2.2)

Если приложение падает с `SIGABRT` сразу после сплэша, смотрите main-буфер, а не
только `-b crash`:

```powershell
adb logcat -c
adb shell am start -n dev.heliwatch.app.debug/dev.heliwatch.app.MainActivity
adb logcat -d -s RustStdoutStderr:V HeliWatch:V > heli-key.txt
```

Тег `HeliWatch`: `onCreate: begin` → `after super` → `MainActivity install` →
`plugin load` → `attach: container ready`.
Тег `RustStdoutStderr`: `Rust run() start` → `plugin setup: probe-before-sql` →
`probe-after-sql` → `app setup reached` → `PANIC`/`RUN ERROR`.

Последняя достигнутая строка указывает слой: Kotlin, Rust-плагин, WebView или JS.

## Android 15/16 и 16-КБ страницы памяти

На устройствах с 16-КБ страницами (Android 15+ на части Pixel и других)
`dlopen` отклоняет нативную библиотеку, если её LOAD-сегменты выровнены на
4 КБ. Симптом: несколько секунд зелёного фона окна, затем процесс падает с
`SIGABRT`; в `adb logcat -b crash` нет Java-стека приложения.

В репозитории лежит `.cargo/config.toml`:

```toml
[target.aarch64-linux-android]
rustflags = ["-C", "link-arg=-Wl,-z,max-page-size=16384"]
[target.x86_64-linux-android]
rustflags = ["-C", "link-arg=-Wl,-z,max-page-size=16384"]
```

После сборки проверяйте:

```powershell
llvm-readelf -l <libheliwatch_lib.so>   # LOAD ... Align 0x4000
zipalign -c -P 16 -v 4 <apk> | Select-String 'lib/arm64-v8a'
# ...libheliwatch_lib.so (OK)
```

Если `.so` остался с `Align 0x1000`, значит Rust не увидел `.cargo/config.toml`
(запускайте сборку из корня репозитория) или `RUSTFLAGS` перетёрли флаги.

## Windows без Developer Mode
На машине без режима разработчика (и без права создавать символьные ссылки)
`pnpm tauri android build --apk --debug` доходит до упаковки `.so` и падает:
`Failed to create a symbolic link ... jniLibs`. Плюс `cc`/`cl.exe` может не
собрать C-часть `libsqlite3-sys` (SQLite-плагин) или `vswhom-sys` с
debug-информацией (`D8050`). Поэтому сборка идёт с `CARGO_PROFILE_DEV_DEBUG=0`.
Обход, которым собран APK 0.2.x–0.7.x:

```powershell
# 0. (этап 7) Дочерние build-скрипты из target не могут писать в .cargo
#    на этой машине — уводим target во временный каталог вне репозитория.
$env:CARGO_TARGET_DIR="$env:TEMP\heliwatch-target"

# 1. Сборка dist + Rust для arm64. Ошибка symlink в конце ожидаема:
$env:CARGO_PROFILE_DEV_DEBUG="0"
$env:JAVA_HOME="C:\Program Files\Eclipse Adoptium\jdk-17.0.21.9-hotspot"
$env:ANDROID_HOME="C:\Android\Sdk"
$env:NDK_HOME="C:\Android\Sdk\ndk\27.2.12479018"
pnpm tauri android build --apk --debug

# 2. Кладём .so в jniLibs вручную:
$jni = "src-tauri/gen/android/app/src/main/jniLibs/arm64-v8a"
New-Item -ItemType Directory -Force $jni | Out-Null
Copy-Item "$env:TEMP\heliwatch-target\aarch64-linux-android\debug\libheliwatch_lib.so" "$jni/" -Force

# 3. Gradle без rust-задач (они снова упрутся в symlink):
.\src-tauri\gen\android\gradlew.bat -p src-tauri/gen/android assembleUniversalDebug `
  -x rustBuildUniversalDebug -x rustBuildArm64Debug -x rustBuildArmDebug `
  -x rustBuildX86Debug -x rustBuildX86_64Debug --console=plain
```

APK получится только для arm64-v8a. Если нужен эмулятор x86_64, соберите
соответствующий Rust-таргет тем же способом и добавьте `.so` в
`jniLibs/x86_64/`. Включение режима разработчика Windows или `mklink /H` не
помогут: cargo-mobile2 создаёт именно символьную ссылку.

Если CLI упал на symlink до генерации `tauri.build.gradle.kts`, в нём может не
быть подключений плагинов. Для этапа 7 там должны быть:

```kotlin
dependencies {
    implementation(project(":tauri-plugin-fs"))
    implementation(project(":tauri-plugin-dialog"))
}
```

Иначе Gradle не найдёт классы `tauri-plugin-fs`/`dialog` (сборка Kotlin упадёт
на unresolved reference). `tauri.settings.gradle` CLI генерирует раньше и в нём
эти плагины уже есть.

## Частые проблемы

| Симптом | Что проверить |
|---|---|
| `compileSdk 37 not installed` | Вернуть `compileSdk = 36` скриптом (`pnpm android:patch`) или доставить platform 37; проекту нужен 36. |
| «Permission heliwatch:default not found» | Сборка плагина упала раньше; проверьте `links = "tauri-plugin-heliwatch"` в его `Cargo.toml` и `pnpm android:doctor`. |
| Плагин не компилируется в Gradle | `tauri.settings.gradle`/`tauri.build.gradle.kts` не сгенерированы: пересоберите через CLI (не через Android Studio в первый раз). |
| Белая вспышка при старте | Тема и `windowBackground` перетёрты — повторите `pnpm android:patch`. |
| Сайт не виден под React | Проверьте `setBackgroundColor(TRANSPARENT)` у Tauri-WebView и `transparent: true` в `tauri.conf.json`; на некоторых прошивках включите запасной split-режим (этап 4). |
| Тапы по панели уходят на сайт | Откройте «Отладка → зоны касания» (иконка жука): красные рамки — то, что реально пришло в Kotlin. Проверьте dpr и пересчёт после анимации. С 0.8.0 новые панели ловит `MutationObserver`, у модалок есть `data-hw-block` (тапы вне зон гасятся, а не уходят сайту). |
| Клавиатура скрывает панель | В манифесте должен быть `windowSoftInputMode="adjustResize"`; React пересылает зоны на `visualViewport.resize`. |
| Back закрывает приложение с первого раза | Не применён `HeliWatchBridge.install(this)`; `pnpm android:doctor` покажет. |
| PiP не открывается по «домой» | Проверить `supportsPictureInPicture=true` (маркер `HW:PATCH:ACTIVITY`), маркеры `HW:PATCH:PIP` и `HW:PATCH:LIFECYCLE` в MainActivity, что комната активна и `pipEnabled` включён. С 0.8.0 параметры PiP ставятся из UI-потока: если `setAutoEnterEnabled` вызывался из JNI-потока, автовход молча не включался. На Android 11 и ниже вход делает `onUserLeaveHint`. |
| «SecurityException» при старте сервиса | На Android 14+ тип `microphone` нельзя объявлять без выданного RECORD_AUDIO и активного микрофона: сервис стартует с `mediaPlayback`, микрофон добавляется вторым `startForeground`. Смотрите logcat `HeliWatch`. |
| Нет кнопок в уведомлении | Android 13+: не выдано POST_NOTIFICATIONS. Сервис при этом работает; разрешение запрашивается при входе в комнату. |
| В PiP чёрный экран вместо видео | Сайт не отдал кадр (DRM/аппаратный декодер) — PiP показывает поверхность WebView, а не отдельный плеер. Проверьте тот же сайт в обычном режиме; ограничение описано в README. |
| APK огромный | `public/test-video.mp4` попадает и в assets сайта, и в Tauri-бандл. Для релиза заменить на короткий ролик или стримить по URL. |
| `vswhom-sys`: `D8050` при `cl.exe` | Собирать с `CARGO_PROFILE_DEV_DEBUG=0` (символы Rust не нужны для проверки) или включить Developer Mode/полноценный VS Build Tools. |
| `Failed to create a symbolic link ... jniLibs` | Windows без Developer Mode: см. раздел выше — скопировать `.so` и запустить Gradle с `-x rustBuild...`. |

## Ручное восстановление за 5 минут

Если скрипты недоступны:

1. `pnpm tauri android init`;
2. в `app/build.gradle.kts` — 36/36/26;
3. в манифесте — `configChanges` с `density`, `adjustResize`, `resizeableActivity`, `supportsPictureInPicture`;
4. в `MainActivity.onCreate` — `HeliWatchBridge.install(this)`, плюс
   `onUserLeaveHint`/`onPictureInPictureModeChanged` → `HeliWatchBridge`;
5. скопировать `public/test-page.html` и `public/test-video.mp4` в
   `app/src/main/assets/`;
6. `pnpm icons` и `pnpm android:patch` (или вручную повторить ресурсы из таблицы).

После любого восстановления: `pnpm android:doctor`.
