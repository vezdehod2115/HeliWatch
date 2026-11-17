> **ПРАВИЛО GIT (коммит):** После успешного завершения любого этапа или фикса задачи, проверки сборки и обновления PLAN.md/README.md — всегда выполняй `git add .` и `git commit -m "<краткое описание изменений>"`. Не завершай работу без коммита.
>
> **ПРАВИЛО GIT (пуш):** После выполнения `git commit` всегда отправляй изменения на GitHub отдельной командой `git push` (не объединяя её через `&&`). Не завершай работу, пока изменения не отправлены на GitHub.

# HeliWatch — план разработки

> **План v1 · 17.11.2026.** Единственный источник истины по архитектуре, протоколу, версиям и этапам.
> Код не пишется до утверждения плана. В конце каждого этапа обновляются: таблица статусов (§ «Статусы этапов»), версия во всех файлах (§6.1), `README.md`, при необходимости — этот план. Подробный ченджлог этапа публикуется в описании GitHub Release; `CHANGELOG.md` в репозиторий не добавляется.

HeliWatch — Android-приложение (Tauri v2, только APK) для совместного просмотра видео с голосовым и текстовым чатом: сайты и стриминги, файл с телефона хоста, один файл на двух телефонах. Своих серверов нет: WebRTC P2P, сигналинг через публичные релеи, данные — локально в SQLite.

## 0. Границы продукта (что сознательно не делаем)

| Не делаем | Причина |
|---|---|
| Онлайн-статус друзей, push-уведомления | нужен сервер; друга видно только при встрече в комнате/лобби |
| Синхронизация истории между устройствами | нет сервера; только ручной бэкап-файл |
| Обход DRM и платных подписок | невозможно; age-gate — только best effort |
| iOS/desktop-сборки | цель — Android APK |
| Более 2 зрителей стрима файла хоста | канал мобильного хоста, mesh-нагрузка |
| Чтение пикселей чужого видео как гарантия | tainted canvas на сторонних сайтах — обязателен фоллбэк |

## Статусы этапов

| № | Этап | Версия | Статус | Дата | Примечание |
|---|---|---|---|---|---|
| 1 | Каркас: Tauri/Android, два WebView, тач-роутинг, тема, лого, README, CHANGELOG | 0.1.0 | ✅ завершён | 17.11.2026 | debug APK собран; проверка на телефонах и скриншоты — по чеклисту из README |
| 2 | P2P-комнаты, identity, синхронизация сайта и локальных файлов | 0.2.2 | ✅ завершён | 17.11.2026 | 0.2.1: 16-КБ `.so`; 0.2.2: диагностика запуска (HeliWatch/RustStdoutStderr); nonce-аутентификация, режимы A/C, автокоррекция |
| 3 | Голос, чат комнаты, фото, эмодзи | 0.3.0 | ⬜ не начат | — | — |
| 4 | Фон: PiP, foreground-сервис, таймеры WebView | 0.4.0 | ⬜ не начат | — | — |
| 5 | Стрим файла с телефона хоста | 0.5.0 | ⬜ не начат | — | — |
| 6 | Открытые/закрытые комнаты, лобби, модерация | 0.6.0 | ⬜ не начат | — | — |
| 7 | Друзья, DM, статистика, бэкап, динамический акцент, age-gate | 0.7.0 | ⬜ не начат | — | — |

## 1. Версии и стек (зафиксировано)

| Слой | Пакет | Версия | Примечание |
|---|---|---|---|
| Оболочка | `tauri` (crate), `@tauri-apps/cli`, `@tauri-apps/api` | 2.12.x | MSRV Rust 1.90; шаблон Android = Gradle 9 + Kotlin 2 |
| Rust | rustc | 1.90+ | stable |
| UI | `react`, `react-dom` | 19.3.1 | `@types/react` 19.3 |
| | `typescript` | 5.9.x | strict + `noUncheckedIndexedAccess` |
| | `vite`, `@vitejs/plugin-react` | 8.1.x / из шаблона | Rolldown; точная версия плагина — по lockfile |
| | `tailwindcss`, `@tailwindcss/vite` | 4.3.x | CSS-first `@theme`, без `tailwind.config.js`; 4.1.x не поддерживает Vite 8 |
| | `zustand` | 5.1.x | |
| P2P | `trystero` + пакеты стратегий `@trystero-p2p/{nostr,mqtt,torrent}` | **0.26.0 (pin)** | 0.27 — ломающий релиз (новая identity/API), см. §2.7 |
| | `peerjs` | 1.5.x | только запасной транспорт |
| Плагины | `@tauri-apps/plugin-sql` | 2.x (2.6.0) | SQLite (sqlx), миграции — в Rust |
| | `plugin-dialog`, `plugin-fs`, `plugin-os`, `plugin-process`, `plugin-opener` | 2.x | пикеры, файлы, устройство |
| Android | Kotlin / AGP / Gradle / JDK | 2.2.x / из шаблона / 9.x / 17+ | как в шаблоне Tauri 2.12, отдельно не апгрейдим |
| | compileSdk / targetSdk / minSdk | 36 / 36 / 26 | minSdk 26: PiP + современный WebView |
| Тесты | `vitest` | 5.1.x | протокол, чанкинг, цветокоррекция, seq; подключён на этапе 2, 3.x несовместим с Vite 8 |
| Инструменты | Node / pnpm | ≥22.12 / 10.x | |

Правило: точные patch-версии фиксирует `pnpm-lock.yaml` / `Cargo.lock`. Менять версию можно только с записью в описании GitHub Release и правкой этой таблицы.

## 2. Ключевое архитектурное решение

### 2.1 Варианты и выбор

| № | Вариант | Итог |
|---|---|---|
| 1 | `<iframe>` внутри React-WebView | ✗ X-Frame-Options/CSP, DRM, нет инжекта, логины не работают |
| 2 | **Нативный Kotlin-плагин + второй WebView** в контейнере: сайт снизу, прозрачный React сверху | ✓ **выбран** |
| 3 | `window.add_child` / multiwebview Tauri | ✗ только desktop (tauri#11794, #11528), unstable |
| 4 | Custom Tabs / внешний браузер | ✗ нет JS-инжекта и синхронизации |
| 5 | Локальный HTTP-прокси с перезаписью заголовков | ✗ ломает CSP/логины/DRM, тянет сервер в процесс |
| 6 | WebRTC и чат внутри страницы сайта | ✗ запрещено: сессия рвётся при навигации |

Вариант 2 даёт: один процесс, полный контроль над сайтом (куки, инжект, `onShowCustomView`), а WebRTC/чат остаются в React-WebView, который никогда не навигируется. Альтернатива «сессия в фоновом сервисе» не решает главного — UI и WebRTC должны жить в одном постоянном контексте, а сервис всё равно будет обращаться к тому же WebView.

### 2.2 Слои и мосты

- **React-WebView (Tauri)** — постоянный контекст: `RTCPeerConnection`, DataChannel, состояние комнаты, чат, SQLite, весь UI. Не перезагружается при навигации по сайтам (только dev-перезагрузка).
- **Site WebView** — изолированный мир для сайта: навигация, логины, инжект. Нет доступа к Tauri API; `addJavascriptInterface` отдаёт только `HeliNative.post(String)` (лимит 4 КБ и 30 сообщений/с — защита от враждебной страницы).
- **Kotlin-плагин `heliwatch`** — контейнер двух WebView, тач-роутинг, `WebChromeClient` (файлы, микрофон, fullscreen), мост событий сайта, дальше — сервис и PiP. Код плагина живёт вне `gen/` (§3.1).
- **Rust** — регистрация плагина, миграции SQLite, конфиг. Бизнес-логики нет.
- **Мосты:** React→Kotlin — `invoke('plugin:heliwatch|site_cmd', {cmd})`; Kotlin→React — `pluginHandle.trigger('site-event', payload)` + `listen('plugin:heliwatch|site-event')`; страница→Kotlin — `HeliNative.post(json)`; Kotlin→страница — `evaluateJavascript("__heliwatch.apply(...)")`.
- **Инжект:** `site-hook.js` — исходник в `src/native/inject/`, собирается Vite (`?raw`), при первом старте передаётся в Kotlin строкой. Применяется на `onPageCommitVisible`, идемпотентно (один `window.__heliwatch`). `initialization_script` из `tauri.conf.json` здесь **не подходит**: он применяется к нашему React-WebView, а не к сайту.
- **Цепочка примера:** тап «play» в React → `invoke` → `evaluateJavascript` → hook вызывает `video.play()` с флагом `applyingRemote` → событие `play` → `post` → `trigger` → React обновляет state → `send('play')` в DataChannel.
- Сайт с WebRTC-слоем **не общается вообще**: в режиме A медиа — это видео самого сайта, голос и чат живут в React.
- **Медиа vs команды:** голос и видео — `MediaStream` через transceiver'ы; всё управление, чат и файлы — JSON/бинарные чанки в DataChannel.
- **Автоплей:** первый тап по оверлею «Нажмите, чтобы включить звук» даёт user-gesture (сайту — `setMediaPlaybackRequiresUserGesture(false)`, локальному видео в React — `play()` из обработчика тапа); после разблокировки входящие команды применяются без клика.

### 2.3 Проброс касаний между WebView

Контейнер `HeliWatchContainer : FrameLayout` (снизу вверх): `siteWebView` → слот fullscreen-видео (`onShowCustomView`) → `tauriWebView` (прозрачный). Обычный hit-test не работает: верхний WebView съедает любые касания, до нижнего они не доходят.

1. React отправляет в Kotlin список интерактивных прямоугольников: `{v:1, dpr, regions:[{id,x,y,w,h}], blocking:boolean}` — CSS-пиксели от левого верхнего угла WebView; Kotlin умножает на `dpr` (страница с `width=device-width, initial-scale=1`, `viewport-fit=cover`).
2. `dispatchTouchEvent` в контейнере на `ACTION_DOWN` один раз выбирает цель: точка внутри regions → React; иначе → сайт; при `blocking` (открыта модалка/панель на весь экран) — касание гасится. Цель фиксируется на весь жест (`MOVE/UP/CANCEL` и все указатели), событие отдаётся напрямую `child.dispatchTouchEvent(ev)`.
3. `pointer-events:none` на всех неинтерактивных слоях React; прямоугольники — объединённые bbox (≤12 штук), пересчёт после анимации панели, поворота, показа/скрытия клавиатуры (`ResizeObserver` + дебаунс 80 мс, не чаще кадра).
4. Регионы React расширяются на 6 dp — граница панели не «протекает» на сайт. Обратная ошибка (устаревший region ловит тап) диагностируется: экран «Отладка → зоны касания» рисует прямоугольники поверх.
5. Клавиатура: тап по полю сайта уходит в site-WebView, тот сам запрашивает фокус и IME; при проблеме на этапе 1 — принудительный `requestFocus()`/`clearFocus()` в роутере.
6. Запасной вариант, если на устройстве прозрачность/роутинг ведут себя плохо: разделение экрана без наложения (панель React сверху, сайт ниже, чат — колонкой сбоку). Режим включается флагом в настройках.

### 2.4 PiP и фон для двух WebView

- В PiP обе поверхности остаются живыми, Activity не пересоздаётся: в манифесте `supportsPictureInPicture=true`, `resizeableActivity=true`, `configChanges=screenSize|smallestScreenSize|screenLayout|orientation|keyboardHidden|uiMode|density`.
- JS получает событие `pip-mode` → React переключается в компактный слой (скрыты панели, чат, адресная строка; остаётся видео + полоса последнего сообщения), сайту ставится класс `hw-pip` (стиль скрывает его собственные контролы), инжект не перезагружается.
- Тач-роутинг в PiP отключён (всё гасится) — системный тап по окну разворачивает приложение.
- `setPictureInPictureParams`: `aspectRatio` из пропорций текущего видео (сайт сообщает `videoWidth/videoHeight`), `sourceRectHint` — прямоугольник видео в координатах окна; на Android 12+ `setAutoEnterEnabled(true)` и вход делает система, на 11 и ниже — `enterPictureInPictureMode()` из `onUserLeaveHint()`, в обоих случаях только при `roomActive`.
- `RemoteAction`: пауза/плей, мут микрофона, вернуться. Клик → `PendingIntent` → broadcast-receiver в плагине → `trigger('pip-action')` → React выполняет и присылает `update_pip_state` для актуальных иконок.
- **Таймеры:** Tauri/`WryActivity.onPause()` может вызвать `webView.onPause()` и `pauseTimers()` (глобально для процесса). MainActivity после `super.onPause()`/`super.onStop()` при `roomActive` вызывает `onResume()` + `resumeTimers()` для обоих WebView. Корректность проверяется спайком на реальных телефонах: счётчик `setInterval`, DataChannel-пинг и аудио-уровень в PiP и в фоне (этап 4), а не догадками.
- В фоне без PiP процесс держит foreground-сервис (`mediaPlayback`, микрофон — только после выдачи RECORD_AUDIO и явного включения микрофона, повторным `startForeground`).

### 2.5 Динамический акцент: путь цвета

`site-hook.js` раз в 1.2–1.5 с рисует текущий кадр в canvas 16×16, считает средний цвет в линейном пространстве, отбрасывает почти чёрные/белые пиксели, шлёт `{t:'frame', rgb, w, h}` через мост только при заметном изменении. `getImageData` на чужом видео кидает `SecurityError` (tainted canvas) → отправляется `{t:'frame', rgb:null}`.

Kotlin форвардит как `site-event` → `accentService`: OKLCH-коррекция (L ∈ 0.62–0.86, C ≥ 0.06, оттенок сохраняется, при C < 0.05 — мятный), проверка контраста к фону ≥ 4.5:1, сглаживание EMA, дедбенд ΔE < 4, не чаще 1.5 с → `--accent` на `:root`, transition 700 мс; `--accent-soft` через `color-mix`. Фоллбэк на `#6ff0c4`: нет кадра, пауза, ошибка, tainted, вне комнаты/просмотра, режим выключен в настройках (по умолчанию включён). Для режимов B и C цвет считается прямо в React из локального `<video>` (blob/asset — canvas не tainted). В PiP самплинг продолжается с интервалом 2 с.

Акцент применяется через переменные: кнопки и иконки, ползунки и прогресс, индикатор речи, свои сообщения в чате, подсветка реакций, фокус-ринги, активный пункт навигации. Тема меняется в одном месте — `src/styles/theme.css` (`@theme`: фон `#06201d`, текст, вторичный текст, радиусы 16–24, длительности 150–250 мс, прозрачность панелей).

### 2.6 Риски решения и смягчение

| Риск | Смягчение |
|---|---|
| `backdrop-filter` не видит нижний WebView (разные слои) | стекло = полупрозрачный фон + рамка + шум; настоящий blur только над своим видео |
| Прозрачность React-WebView на части прошивок даёт артефакты | `setBackgroundColor(TRANSPARENT)` + `html,body{background:transparent}`; проверка на 3+ устройствах на этапе 1; запасной split-режим |
| Память: два WebView | site-WebView создаётся только в режиме A и уничтожается при выходе из комнаты |
| Потеря касаний на границах | slop 6 dp, gesture lock, отладочная визуализация зон |
| Tauri обновит `gen/` | весь Kotlin — в плагине; правки app-манифеста — идемпотентным скриптом с маркерами (§3.1) |
| PiP-видео в WebView | `setMediaPlaybackRequiresUserGesture(false)`, проверка на Android 12–16; при системном ограничении — PiP показывает React-видео (режимы B/C) |

### 2.7 trystero 0.26.0 (pin) и почему не 0.27

0.27 (11.11.2026) — ломающий релиз: новые identity на WebCrypto, `on*()`-методы, встроенные роли/модерация, `@trystero-p2p/core`. Наша identity и протокол заданы отдельно (§4.4), поэтому сначала стабильная 0.26.0 с известным API (`joinRoom`, `makeAction`, `addStream`, `getPeers`, `getRelaySockets`, `selfId`). Весь доступ к trystero изолирован в `src/net/trystero.ts`; миграция на 0.27+ — отдельным этапом 0.8.x после оценки встроенных ролей и `makeState`.
>
> В 0.26 подпути `trystero/mqtt` и `trystero/torrent` — пустые заглушки с предупреждением; стратегии подключаются пакетами `@trystero-p2p/mqtt` и `@trystero-p2p/torrent` той же версии 0.26.0. Это не меняет API: `joinRoom/config/makeAction` общие из `@trystero-p2p/core`.

## 3. Структура проекта

```
HeliWatch/
├─ PLAN.md  README.md  LICENSE
├─ package.json  pnpm-lock.yaml  vite.config.ts  tsconfig.json  index.html
├─ docs/
│  ├─ branding/   logo.svg, logo-mark.svg, logo-variants.md, icon-source.png (1024), android/{foreground,background}.svg
│  ├─ screenshots/ 01…14*.jpg (см. §6.3)
│  └─ android-notes.md   что и зачем правим в gen/android, как восстанавливать
├─ scripts/  apply-android-patches.mjs, icons.mjs, version.mjs, check-android.mjs
├─ src/
│  ├─ main.tsx  App.tsx  styles/{theme.css, globals.css}
│  ├─ app/{router.tsx, Shell.tsx}
│  ├─ features/{lobby,room,site,videofile,localplay,chat,dm,friends,profile,stats,settings,pip,about}
│  ├─ net/{trystero.ts,peerjs.ts,protocol.ts,room.ts,identity.ts,blobs.ts,lobby.ts,outbox.ts,negotiation.ts}
│  ├─ media/{voice.ts,stream.ts,capture.ts,ducking.ts,accent.ts,flags.ts}
│  ├─ native/{siteBridge.ts,nativeBridge.ts,pip.ts,service.ts,permissions.ts,inject/site-hook.js}
│  ├─ db/{index.ts,migrations.ts,repo/{profile,friends,dm,outbox,stats,avatars,settings,rooms}.ts,backup.ts}
│  └─ stores/{profile,room,chat,ui,settings,stats}.ts
└─ src-tauri/
   ├─ Cargo.toml  tauri.conf.json  build.rs  src/{main.rs,lib.rs,db.rs}
   ├─ plugins/heliwatch/            # локальный Android-плагин, код вне gen/
   │  ├─ Cargo.toml  src/lib.rs  permissions/default.toml
   │  └─ android/build.gradle.kts  android/src/main/AndroidManifest.xml
   │     └─ android/src/main/java/dev/heliwatch/{HeliWatchPlugin,HeliWatchContainer,WebViewTapRouter,
   │        SiteWebViewFactory,SiteChromeClient,NativeBridge,PermissionHelper,FileChooserHelper,
   │        PiPController,SessionService,SessionNotification,MediaActionReceiver,TimerGuard}.kt
   └─ gen/android/                  # генерируется tauri android init, в git, правится точечно
```

### 3.1 Что где правим в `gen/android` и почему это выживает

| Файл | Правка | Как сохраняется |
|---|---|---|
| `app/src/main/AndroidManifest.xml` | `<uses-permission>` (INTERNET, RECORD_AUDIO, MODIFY_AUDIO_SETTINGS, WAKE_LOCK, FOREGROUND_SERVICE, FOREGROUND_SERVICE_MEDIA_PLAYBACK, FOREGROUND_SERVICE_MICROPHONE, POST_NOTIFICATIONS, READ_MEDIA_VIDEO/IMAGES, READ_EXTERNAL_STORAGE maxSdk=32); `<service>` + `<receiver>`; activity: `label="HeliWatch"`, `supportsPictureInPicture`, `resizeableActivity`, `configChanges`, `launchMode="singleTask"`, `intent-filter` для `heliwatch://r/<code>` | permissions/service/receiver — в **библиотечном манифесте плагина** (AGP мержит автоматически); activity-атрибуты и intent-filter — `apply-android-patches.mjs` по маркерам (`<!-- HW:PATCH -->` в XML, `// HW:PATCH` в Gradle), проверка `pnpm android:doctor` |
| `app/src/main/java/.../MainActivity.kt` | `HeliWatchBridge.install(this)` в `onCreate`, прокси `onPause/onStop/onUserLeaveHint/onNewIntent/onActivityResult` (если плагин не успевает сам) | тот же патч-скрипт; файл в git |
| `app/src/main/java/.../generated/*` | не трогаем | перегенерируется CLI |
| `app/build.gradle.kts` | `implementation(project(":tauri-plugin-heliwatch"))`, `packaging`/`ndk` при необходимости | патч-скрипт (идемпотентно); зависимости — в `plugins/heliwatch/android/build.gradle.kts` |
| `settings.gradle.kts` | `include(":tauri-plugin-heliwatch")` + `projectDir` | патч-скрипт |
| `app/src/main/res/values/strings.xml`, `mipmap-*` | `app_name=HeliWatch`, иконки | `pnpm icons` (`tauri icon`) + патч `strings.xml` |
| `versionCode`/`versionName` | из `tauri.conf.json` (`bundle.android.versionCode`) | конфиг, не gradle |

Правила: (1) `src-tauri/gen/android` **в git** — это часть проекта, а не мусор; (2) весь свой Kotlin — в `plugins/heliwatch`, в `gen/` только вызовы-однострочники; (3) после `tauri android init` запускается `pnpm android:doctor`, который проверяет все маркеры и падает, если правка потерялась; (4) `docs/android-notes.md` — инструкция ручного восстановления за 5 минут.

### 3.2 Нативный слой (этапы 1–4)

`HeliWatchContainer`: `FrameLayout` с двумя WebView и слотом fullscreen. `SiteWebViewFactory`: мобильный Chrome UA, `domStorageEnabled`, `databaseEnabled`, `mediaPlaybackRequiresUserGesture(false)`, `mixedContentMode=COMPATIBILITY`, `CookieManager.setAcceptCookie(true)` + `flush()` на `onPause`, `setSupportMultipleWindows(false)`, `WebChromeClient` с `onShowFileChooser` (системный пикер, `accept="image/*"`/`video/*`), `onPermissionRequest` (микрофон выдаётся только при уже выданном RECORD_AUDIO), `onShowCustomView/onHideCustomView`, `onConsoleMessage` в лог. `PermissionHelper`: `ActivityCompat.requestPermissions` для RECORD_AUDIO (первое включение микрофона) и POST_NOTIFICATIONS (Android 13+), результат — событием в JS. `TimerGuard`: `resumeTimers()`/`onResume()` после `super`, пока комната активна. `PiPController`, `SessionService` (mediaPlayback → microphone), `MediaActionReceiver` — этап 4.

Экран и CPU: `FLAG_KEEP_SCREEN_ON` на окне, пока комната активна и идёт воспроизведение (команда из JS); partial `WakeLock` — только в сервисе на время активной комнаты, с таймаутом и обязательным `release()` (разрешение WAKE_LOCK объявлено в манифесте плагина).

## 4. Протокол WebRTC

### 4.1 Транспорт и роли

Комната = trystero-комната (`appId: heliwatch-v1`, `roomId` = короткий код, лобби = `heliwatch-lobby-v1`). Один JSON-action `hw` (поле `t` — тип), один бинарный action `hw-blob` для чанков. Конверт: `{v:1, t, id, ts, from, to?, rid, d, sig?}` — `id` ULID, `ts` монотонные мс, `from` = userId. Режимы: **A** — сайт/стриминг в site-WebView, **B** — стрим файла с телефона хоста, **C** — у каждого свой локальный файл (синхронизируется только таймкод). Вход: код из 6 символов (Crockford base32, без похожих букв) или ссылка `heliwatch://r/<code>` (intent-filter в манифесте, без сервера). Роли: **хост** (создатель, авторитет по составу/лимитам/карточке лобби) и **участник**; `driver` — тот, чьё состояние воспроизведения считается истиной (режим A/C — любой, режим B — хост). Mesh до `limit` (по умолчанию 4, максимум 6).

### 4.2 Порядок установки соединения

1. `joinRoom` с `rtcConfig` (STUN/TURN) и стратегией сигналинга; при отсутствии пиров/сокетов релея 8 с — следующая стратегия (nostr → mqtt → torrent), затем peerjs-фоллбэк.
2. `onPeerJoin` → обе стороны шлют `hello {nonce, pub}`; nonce 128 бит, живёт 60 с, одноразовый.
3. Гость подписывает nonce хоста → `join`; хост проверяет подпись, версию, пароль (`pwHash`), лимит, бан-лист.
4. Хост шлёт `welcome` с подписью над nonce гостя: `hostUserId`, состав, лимиты, `state` (с `seq`), `epoch`.
5. Если комната с подтверждением — `join-request` (стук) → UI хоста → `join-accept`/`join-deny` → `welcome`.
6. На каждого пира: `addTransceiver` audio `sendrecv`, video (`sendonly` у хоста в B, иначе `recvonly`); далее только `replaceTrack` (§4.6).
7. Дальше: `profile`, `status`, `state` каждые 5 с от driver'а и при каждом изменении, `ping` 10 с.

### 4.3 Сообщения DataChannel

| `t` | Поля `d` | Кому | Подпись |
|---|---|---|---|
| `hello` | `nonce`, `pub` | 1↔1 сразу после соединения | — |
| `join` | `nonce`, `pwHash?`, `peerId`, `profile{name,color,avatarHash}`, `ver` | гость→хост | ✔ над nonce хоста + rid + peerId |
| `welcome` | `nonce`, `hostUserId`, `room{code,title,mode,limit,closed,knock}`, `members[]`, `state`, `epoch` | хост→гость | ✔ над nonce гостя |
| `room-meta` | `title?`, `limit?`, `closed?`, `knock?` | хост→всем | ✔ |
| `join-request` / `join-accept` / `join-deny` | `reason` | гость↔хост | — |
| `profile` | `name`, `color`, `avatarHash` | всем | — |
| `avatar-need` / `avatar-start` / `avatar-chunk` / `avatar-end` | `hash`, `mime`, `size`, `chunks` / `i`, `data` | 1→1 | — |
| `state` | `playing`, `t`, `rate`, `src{mode,url?,fileHash?,duration}`, `seq`, `by` | driver→всем | — |
| `play` / `pause` / `seek` / `rate` | `t` / `t` / `t` / `r,t` | всем | — |
| `resync` | `to?` | всем | — |
| `site-url` | `url` | хост→всем | — |
| `control-lock` | `locked` | хост→всем | — |
| `room-chat` | `text`, `replyTo?` | всем | — |
| `reaction` | `emoji`, `x?`, `y?` | всем | — |
| `status` | `watching\|buffering\|paused\|away`, `t?` | всем, 10 с | — |
| `typing` | `on` | всем | — |
| `image-start` / `image-chunk` / `image-end` / `image-cancel` | `id`, `mime`, `size`, `w`, `h`, `chunks`, `scope`, `to?` | 1→1 или всем | — |
| `stream-start` / `stream-stop` / `capability` | `videoHash?`, `maxViewers` | хост→всем | — |
| `lobby-probe` | — | новичок в лобби | — |
| `lobby-announce` / `lobby-update` / `lobby-remove` | `card{code,title,mode,closed,limit,count,hasPassword,hostUserId,updatedAt}` | всем в лобби | ✔ |
| `kick` / `ban` | `target`, `reason`, `until?` | хост→target + всем | ✔ |
| `mute-request` | `target` | хост→target | — |
| `host-transfer` / `host-claim` | `target`, `epoch` / `epoch` | всем | ✔ / — |
| `friend-request` / `friend-accept` / `friend-remove` | `from`, `name`, `color`, `avatarHash` | 1→1, может идти из outbox | ✔ |
| `dm-message` | `to`, `text` или `imageId`, `kind`, `ts` | 1→1 или outbox | ✔ |
| `dm-ack` | `msgId`, `ts` | 1→1 | — |
| `dm-outbox-sync` / `dm-outbox-offer` | `ids[]` / `messages[]` | 1→1 при встрече | — / ✔ у вложенных |
| `bye` | `left\|host-left\|kicked\|banned\|closed` | всем | — |
| `ping` / `pong` | — | 1↔1, 10 с | — |

### 4.4 Идентичность и подписи

WebCrypto ECDSA P-256, ключ создаётся при первом запуске, JWK хранится в SQLite (app-private; обёртка Android Keystore — 0.8+). `userId` = base64url(SPKI DER) — публичный ключ и есть идентификатор; в UI показывается короткий отпечаток из 8 символов. Подпись: `ECDSA-SHA256(canonicalJson({v,t,id,ts,from,to,rid,d}) + "heliwatch/v1/" + t)`, канонизация — сортировка ключей, без пробелов; тег типа защищает от переноса подписи между типами. Хост сверяет `d.peerId` из `join` с peerId соединения trystero и запоминает пару peerId↔userId: подпись доказывает владение ключом, а канал — что сообщения идут именно из этого соединения (защита от «пересадки» identity); nonce гасится после использования, повторный `join` с тем же nonce отклоняется.

Подписываются только сообщения, живущие вне канала или ретранслируемые: `join`, `welcome`, `lobby-*`, `kick`/`ban`/`host-transfer`, `room-meta`, `friend-*`, `dm-message` (и `dm` внутри outbox). Внутри аутентифицированного DTLS-канала `state/play/pause/seek/rate/resync/room-chat/reaction/status/typing/image-*` **не подписываются** — не грузим CPU. `kick`/`ban`/`room-meta` подписываются всегда, хотя сейчас доставляются напрямую: они редкие (несколько за сессию) и меняют права, а подпись нужна на случай ретрансляции и смены хоста. `hello/join-request/join-accept/deny/profile/avatar` — без подписи (до или внутри проверенного канала). Шифрование DM при ретрансляции (ECDH + AES-GCM) — 0.8+, поле `enc` зарезервировано.

### 4.5 Конфликты, петли, расхождения

1. `state.seq` — Lamport-счётчик комнаты: применяем только `seq > lastSeq`, при равенстве побеждает `from` лексикографически больше. Это снимает гонки «одновременный seek».
2. Эхо-защита: `isRemoteAction` в React (команда из сети не отправляется обратно), `applyingRemote` на 800 мс в инжекте, подавление событий, вызванных нами же (сверка `expectedT` ±0.3 с).
3. Автокоррекция: расхождение > 1.5 с → `seek`; 0.3–1.5 с → временный `rate` 1.05/0.95 на 4 с (A/C, если сайт поддерживает); < 0.3 с — ничего. Не более 1 коррекции в 2 с, не более 5 команд в 5 с на пира.
4. `status: buffering` и `waiting` → коррекции пауза 5 с; `playing=false` у driver'а → все стоят.
5. Хост ушёл: successor = min(`joinedAt`, `userId`) среди оставшихся, рассылает `host-claim{epoch+1}`; в режиме B комната закрывается (`bye: host-left`), миграции нет.
6. `control-lock` от хоста запрещает `play/pause/seek` зрителям (они видят «управляет хост»); `resync` разрешён всегда.

### 4.6 Пересогласование треков (после входа в комнату)

На `onPeerJoin` создаём у каждого пира по transceiver'у audio `sendrecv` и video (роль зависит от режима) через `room.getPeers()[peerId]`. Микрофон: `sender.replaceTrack(micTrack)` при включении, `replaceTrack(null)` при выключении — **без renegotiation**, у собеседника просто тишина; факт выключения передаём `status`. Стрим файла (B): хост делает `replaceTrack(videoTrack)` на своём video-sender'е, зрители уже имеют `recvonly`-трансивер; стоп — `replaceTrack(null)` + `stream-stop`. `onnegotiationneeded` остаётся страховкой: perfect negotiation (impolite = хост, polite = гость, rollback при коллизии) на случай peerjs-фоллбэка и поздно подключившегося пира; тоггл микрофона renegotiation не запускает.

### 4.7 Чанкинг, backpressure, фото и аватары

Чанк 16 КиБ (`ArrayBuffer`, `hw-blob`), изображение ≤ 2 МБ после клиентского сжатия (canvas, длинная сторона 1280, JPEG 0.8). Отправитель: `image-start{size,chunks,sha256}` → цикл с `bufferedAmount`: высокий порог 1 МиБ, низкий 256 КиБ, ожидание `bufferedamountlow` (таймаут 10 с → `image-cancel`), прогресс в UI, кнопка «Отмена». Получатель: сборка по порядку, таймаут 30 с, проверка размера и SHA-256, при mismatch — один `image-nack` (повтор), затем `cancel`. Файлы — в `plugin-fs` кэше (LRU 200 МБ), миниатюры 256 px в canvas, в чате превью, тап — полноэкранный просмотр со свайпом. Аватары: та же схема, ≤128×128, лимит 50 файлов / 5 МБ, обмен по `avatarHash` (не шлём повторно). Лимит текста 4000 символов.

### 4.8 Сигналинг, ICE/TURN, лобби

- Стратегии: default `nostr`, затем `mqtt`, затем `torrent`; смена после 8 с без пиров или при пустых `getRelaySockets()`. peerjs — только если все три не дали соединения (публичный PeerServer, доступность не гарантируем); в UI предупреждение «соединение через резервный канал».
- ICE: STUN `stun.l.google.com:19302`, `stun1.l.google.com:19302`, `stun.cloudflare.com:3478`; TURN Open Relay (`openrelay.metered.ca:80`, `:443`, `turns:443`, транспорт tcp/udp) — best effort, лимиты публичные. В настройках можно вставить свой TURN (JSON) и включить «только TURN» для отладки. Нет кандидатов за 12 с → подсказка про TURN, а не молчаливое зависание.
- Лобби: `heliwatch-lobby-v1`; хост держит одну карточку, `announce` каждые 25 с (±5 с джиттера), `update` при изменении состава/режима, `remove` при закрытии/заполнении. Остальные держат карту карточек с TTL 70 с, отбрасывают устаревшие, спам-rate-limit 1 публикация / 5 с на хост, локальный блок-лист. Новичок на `onPeerJoin` шлёт `lobby-probe` (хосты отвечают своей карточкой, не чаще 1/с).
- Жизненный цикл: вход в рабочую комнату → **сразу** `lobby.leave()` и остановка таймеров; хост при заполнении/закрытии снимает карточку и выходит из лобби; при освобождении места — снова заходит и публикует. Лобби и рабочая комната одновременно не открыты (rate limit релеев, батарея).
- Переподключение к лобби/комнате: exponential backoff 2 → 4 → 8 → … → 60 с с джиттером, один реконнект за раз, статус в UI.
- Парная комната друзей (опционально, **по умолчанию выключено**): пока приложение на экране, друг может открыть комнату на двоих с фиксированным id `dm:<hash(пары)>`, и DM доставляется сразу; при сворачивании/уходе в фон комната закрывается, батарея не тратится. Включают обе стороны явно, в настройках есть пояснение про расход.

## 5. Локальная БД (SQLite, `plugin-sql`) и бэкап

| Таблица | Ключ | Поля / примечание |
|---|---|---|
| `profile` | `id=1` | `user_id`, `display_name` (валидация 2–24 символа), `name_color` (палитра или свой), `avatar_hash`, `created_at` |
| `keys` | `id=1` | `public_jwk`, `private_jwk`, `created_at` (app-private; не в логах) |
| `friends` | `user_id` | `display_name`, `name_color`, `avatar_hash`, `added_at`, `last_meet_at`, `blocked` |
| `blocklist` | `user_id` | `reason`, `created_at`, `expires_at` (сессия/навсегда) |
| `dm_messages` | `id` | `peer_user_id`, `dir`, `kind(text\|image)`, `body`, `image_path`, `ts`, `status(sent\|delivered)`, `sig`; индекс `(peer_user_id, ts)` |
| `outbox` | `id` | `to_user_id`, `payload_json`, `sig`, `created_at`, `attempts`, `next_attempt_at`, `status` |
| `sessions` | `id` | `room_code`, `mode`, `started_at`, `ended_at`, `end_reason(left\|timeout\|kick\|crash)`, `peers_json`, `host_user_id`; heartbeat 30 с |
| `peer_stats` | `(peer_user_id, day)` | `sessions`, `seconds_total`, `seconds_voice`, `seconds_watch`, `modes_json`, `last_meet_at` |
| `room_chat` | `id` | `room_code`, `ts`, `from_user_id`, `kind`, `body`, `image_path`, `saved` (история — только по желанию) |
| `avatars` | `hash` | `path`, `size`, `last_used_at` (LRU 50 / 5 МБ) |
| `settings` | `key` | `value_json`: динамический акцент, прозрачность чата, громкость голоса, ducking, TURN, PiP |
| `recent_rooms` | `code` | `last_join_at` |

Правило хранилища: всё важное — только в SQLite (профиль, ключи, друзья, DM, статистика, настройки). `localStorage` не используем даже для UI-флагов: WebView может его почистить.

Сессии устойчивы к обрывам: строка открывается при входе, `heartbeat` каждые 30 с; при старте приложения «зависшие» сессии закрываются с `ended_at = last_heartbeat`, `end_reason=timeout`. Время пишется каждому участнику (mesh). Чистка: сессии > 365 дней, картинки LRU 200 МБ, DM-история без жёсткого лимита, но картинки — по LRU.

**Бэкап** — один JSON-файл `heliwatch-backup-YYYYMMDD-HHmm.json`: `{format:"heliwatch-backup", schema:1, app:"0.7.0", exportedAt, checksum, profile, identity{publicJwk,privateJwk}|null, friends, blocklist, dm_messages, sessions, peer_stats, settings, media?{base64}}`. По умолчанию медиа не включается; ключи включаются с явным предупреждением («файл = ваша личность»), можно исключить. Импорт: проверка `format`/`schema`/`checksum`, режимы «слить» (по `ts`/`updated_at`, локальное новее не затирается) и «заменить»; после импорта — перезапуск инициализации сторов.

## 6. Версии, release notes, README, скриншоты

### 6.1 Версионирование

SemVer. Первый релиз `0.1.0`; завершённый этап = minor bump (`0.1.0 → 0.2.0 → … → 0.7.0`), исправления внутри этапа = patch (`0.2.1`, `0.2.2`). Версия меняется одной командой `pnpm version:set X.Y.Z` синхронно в `package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json` (+ `bundle.android.versionCode = major*10000+minor*100+patch`, `0.2.0 → 200`), `Cargo.lock` пересобирается; APK собирается только из выровненной версии (`check-android.mjs` падает при рассинхроне).

### 6.2 Release notes и README

Подробный ченджлог этапа — в описании GitHub Release (`gh release create ... --notes-file ...`), не отдельным файлом в репозитории. Формат заметок — Keep a Changelog: «Добавлено / Изменено / Исправлено / Удалено», записи на русском, дата `YYYY-MM-DD`. Временный файл заметок создаётся вне репозитория и удаляется после публикации; `CHANGELOG.md` не коммитится.

`README.md` (по образцу README музыкального плеера): логотип и название, слоган одной фразой, бейджи (версия, MIT, Android, Tauri, React, TypeScript), «Что это», полное описание возможностей, «Скриншоты» (сетка 2 колонки + подписи, плейсхолдеры пока нет файлов), «Скачать» (Releases + как поставить APK), «Как это работает» (P2P без серверов, ограничения), «Сборка из исходников» (Node, pnpm, Rust, Android SDK/NDK, `dev` и `tauri android build --apk`), «Ограничения и известные проблемы», «Стек», «Лицензия» и дисклеймер о независимости от YouTube, VK, Rutube. Обновляется в конце каждого этапа.

### 6.3 Скриншоты (`docs/screenshots/`, JPG, 1080×2340 и 2340×1080)

Нужно снять: `01-lobby.jpg` (список открытых комнат), `02-room-site.jpg` (режим «Сайт», оверлей), `03-room-file.jpg` (файл хоста), `04-room-local.jpg` (локальный файл на двух телефонах), `05-chat-landscape.jpg` (чат-колонка в ландшафте), `06-chat-emoji.jpg` (эмодзи-панель и реакции), `07-photo-fullscreen.jpg`, `08-dm.jpg` (личный чат), `09-friends-profile.jpg`, `10-stats.jpg`, `11-settings.jpg` (динамический акцент), `12-pip.jpg` (PiP-окно), `13-accent.jpg` (кадр видео → акцент), `14-about.jpg`. README — сетка 2 колонки с подписями; пока файлов нет, вместо картинок — плейсхолдеры и этот список.

### 6.4 Логотип и docs

Три варианта SVG в `docs/branding/logo-variants.md`: **A «Два экрана»** — два скруглённых экрана, в пересечении читается play; **B «H-плеер»** — монограмма H, перекладина заменена треугольником play; **C «Плей и два круга»** — участники вокруг плей-кнопки. Выбран **B**: читается в 16–24 px, уникален, точно ложится в адаптивную иконку и анимируется в сплэше; A остаётся горизонтальным локапом для README и OG-картинки, C отклонён — круги сливаются в малом размере. Мотивов вертолётов/винтов и чужих логотипов нет.

Иконки: `docs/branding/icon-source.png` (1024 из SVG) → `pnpm icons` (`tauri icon`) → `mipmap-*`; адаптивная иконка Android: foreground — знак `#6ff0c4` (safe zone 66%), background — `#06201d` с мягким градиентом, monochrome-слой для themed icons (Android 13+). `docs/`: `branding/`, `screenshots/`, `android-notes.md`.

## 7. Этапы

Общий DoD любого этапа: `pnpm build` и `cargo check` чистые, APK собирается (`tauri android build --apk`), нет ошибок в консоли, план/статусы/версия/README обновлены, названы скриншоты, заметки этапа опубликованы в GitHub Release.

**Этап 1 — Каркас · 0.1.0**
Цель: приложение запускается, сайт в нижнем WebView, прозрачный React сверху, касания работают, тёмная тема, лого, документация. Без WebRTC, PiP и сервисов.
Файлы: `package.json`, `vite.config.ts`, `src/styles/theme.css`, `src/App.tsx`, `src/native/{siteBridge,nativeBridge}.ts`, `src/native/inject/site-hook.js` (только детект видео + тестовый обмен), `public/test-page.html` (кнопки, видео, поля ввода, скролл), `src-tauri/plugins/heliwatch/**` (контейнер, роутер, chrome client, разрешения-заглушки), `src-tauri/tauri.conf.json`, патч-скрипты, `docs/branding/*`, `README.md`, `CHANGELOG.md`.
Готово: `tauri android dev` и APK; внизу открывается тестовая страница (`youtube.com` и локальная `test-page.html` с кнопками/видео), сверху React-панель; тап по кнопкам сайта срабатывает, тап по панели — нет; тема/токены на месте; системные разрешения объявлены; выбор файла через пикер открывается.
Чеклист на телефонах (Android 11/13/15): сайт скроллится и играет, оверлей не мешает; тапы на границе панели не теряются; клавиатура открывается в React-инпуте и в поле сайта; поворот экрана не ломает раскладку; логин в YouTube сохраняется после перезапуска; `back` уходит по истории сайта и не закрывает приложение при открытой панели; прозрачность без артефактов; память < 400 МБ.

**Этап 2 — P2P, identity, синхронизация · 0.2.2**
Цель: комната по коду/ссылке, аутентификация по nonce, синхронизация сайта (A) и локальных файлов (C), «Отсинхронизировать ко мне».
Файлы: `src/net/*`, `src/db/*`, `src/native/inject/site-hook.js` (полный набор событий), `src/features/{room,site,localplay}/*`, `src-tauri/src/db.rs` (миграции).
Готово: два телефона в комнате, play/pause/seek/rate синхронны (< 1.5 с), расхождение правится автокоррекцией, петли отсутствуют, неверная подпись/чужой nonce отклоняются, обрыв сети → автопереподключение.
Чеклист: YouTube и Rutube, пауза на одном — пауза у второго, seek и скорость, локальные файлы с разными размерами (только таймкод), уход и возврат в комнату, смена сети Wi-Fi↔LTE, симметричный NAT (мобильный интернет) — соединение через TURN.

**Этап 3 — Голос и чат комнаты · 0.3.0**
Цель: голос с эхо/шумоподавлением, муты, индикатор речи, ducking, чат поверх видео, строка последнего сообщения, фото с чанкингом, эмодзи-панель (категории, недавние сверху, системные Unicode без библиотек) и быстрые реакции 6–8.
Файлы: `src/media/{voice,ducking}.ts`, `src/net/blobs.ts`, `src/features/{chat,voice}/*`, `src/native/{permissions,fileChooser}.kt`, `src/db/repo/*`.
Готово: голос в обе стороны, `replaceTrack` без renegotiation, индикатор речи, чат < 300 мс, фото 2 МБ с прогрессом и отменой, эмодзи и реакции.
Чеклист: включение микрофона на ходу не рвёт медиа; отказ в RECORD_AUDIO обработан; наушники/динамик; нажатие «назад» не съедает сообщение; фото 2 МБ на LTE; обрыв посреди передачи → понятная ошибка и повтор.

**Этап 4 — Фон, PiP, сервис · 0.4.0**
Цель: PiP с RemoteAction, foreground-сервис (mediaPlayback → microphone после разрешения), таймеры WebView не встают, экран не гаснет.
Файлы: `PiPController.kt`, `SessionService.kt`, `SessionNotification.kt`, `MediaActionReceiver.kt`, `TimerGuard.kt`, патчи манифеста, `src/native/{pip,service}.ts`, `src/features/pip/*`.
Готово: сворачивание → PiP с видео и строкой сообщения; звук и DataChannel живы в PiP и в фоне 10+ минут; микрофон не заглушается в фоне; `setInterval`-сердцебиение не замирает; выход из PiP восстанавливает UI.
Чеклист: Android 12/13/14/15, Pixel/Samsung/Xiaomi, свернуть жестом «домой», выключить экран, входящий звонок, поворот в PiP, уведомление с кнопками, «выйти из комнаты» из уведомления, отсутствие SecurityException при старте сервиса.

**Этап 5 — Стрим файла хоста · 0.5.0**
Цель: `captureStream()` (+ canvas/WebAudio фоллбэк), зрители 1–2, предупреждение о нагрузке, .mkv с предупреждением.
Файлы: `src/media/{stream,capture}.ts`, `src/features/videofile/*`, `stream-start/stop` в протоколе.
Готово: зритель видит и слышит файл, пауза/seek хоста синхронны, третий зритель отклоняется, уход хоста закрывает комнату.
Чеклист: mp4 и webm, mkv с предупреждением, звук в стриме, нагрев/дропы на 2 зрителях, PiP при стриме.

**Этап 6 — Открытые/закрытые комнаты, лобби, модерация · 0.6.0**
Цель: лобби-карточки, пароль как ключ сигналинга, «постучаться», kick/ban/mute-request, передача хоста и миграция, лимиты.
Файлы: `src/net/lobby.ts`, `src/features/lobby/*`, модерация в `features/room`, `src/db/repo/{blocklist,rooms}.ts`.
Готово: список живых комнат, карточка исчезает при заполнении/закрытии, вход только по коду у закрытой, бан работает на сессию и локально, миграция хоста в A/C.
Чеклист: две комнаты в лобби, TTL карточки после убийства хоста, спам-карточки режутся, пароль неверный — понятная ошибка, кик и бан, передача хоста, заполнение лимита.

**Этап 7 — Друзья, DM, статистика, бэкап, акцент, age-gate · 0.7.0**
Цель: профиль и аватар, друзья с взаимным подтверждением и приглашением по коду/ссылке, DM отдельным экраном и хранилищем, outbox, парная комната друзей (по умолчанию выключена), статистика, бэкап, динамический акцент, YouTube age-gate (best effort, последним).
Файлы: `src/features/{friends,dm,profile,stats,settings,about}/*`, `src/net/{outbox,identity}.ts`, `src/media/accent.ts`, `src/db/backup.ts`, age-gate-блок в `site-hook.js`.
Готово: DM не смешивается с чатом комнаты (типы, UI, БД), недоставленное уходит в outbox и доставляется при следующей встрече, статистика переживает краш, бэкап/импорт, акцент из видео с фоллбэком на мятный, age-gate не ломает остальное.
Чеклист: два аккаунта в друзьях, приглашение по ссылке, отправка DM вне комнаты → доставка при следующей встрече, парная комната и её расход батареи, фото в DM, экспорт/импорт на другом устройстве, статистика после обрыва, видео с tainted canvas → мятный, выключение акцента, age-gate-видео.

## 8. Известные риски и ограничения

| Риск | Что делаем |
|---|---|
| WebView сайта: DRM/защищённое видео, отдельные плееры | не обещаем; сайт сообщает об ошибке, комната продолжает работать |
| `.mkv` может не играть | предупреждение при выборе, `.mp4/.webm` приоритет |
| YouTube age-gate | best effort, отдельный этап, feature-flag, логи, без падения |
| TURN публичный, может быть недоступен/лимитирован | свой TURN в настройках, понятная ошибка, peerjs-фоллбэк |
| Публичный сигналинг и лобби нестабильны | 3 стратегии, backoff, TTL карточек, статус в UI |
| Rate limit релеев при частых реконнектах | один реконнект за раз, backoff до 60 с, лобби закрывается при входе в комнату |
| Два наложенных WebView: прозрачность и производительность | проверка на устройствах, split-режим, site-WebView только в режиме A |
| Потеря касаний на границах зон | slop, gesture lock, визуализация зон, крупные тач-цели |
| SecurityException на Android 14+ при типе сервиса | старт только `mediaPlayback`; `microphone` — повторным `startForeground` после разрешения и включения мика |
| Микрофон заглушается в фоне без `microphone`-типа | тип добавляется до сворачивания, проверка на устройствах |
| Заморозка таймеров WebView в PiP/фоне | `resumeTimers`/`onResume` после `super`, спайк-проверка счётчиками |
| DRM/видео в PiP, различия прошивок | тесты на Pixel/Samsung/Xiaomi, документация ограничений |
| Строка сообщения в PiP нечитаема | крупный шрифт, наложение на низ видео, только чтение (ввод невозможен) |
| mesh-нагрузка при > 4 участниках | лимит хоста 4 (макс. 6), предупреждение, отказ новым |
| Фото по DataChannel: размер и скорость | 2 МБ, сжатие, 16 КиБ чанки, backpressure, отмена/повтор |
| Спам и модерация без сервера | rate limit карточек, TTL, локальный блок-лист, жалоба = блок |
| Нет онлайн-статуса и пушей | описано в README и в UI друзей |
| История не синхронизируется, теряется без бэкапа | бэкап-файл, напоминание в настройках |
| Tainted canvas на чужих сайтах | обязательный фоллбэк на `#6ff0c4` |
