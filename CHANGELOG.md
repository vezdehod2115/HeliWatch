# Журнал изменений HeliWatch

Формат — [Keep a Changelog](https://keepachangelog.com/ru/1.1.0/),
версии — [SemVer](https://semver.org/lang/ru/). Новые записи сверху.
Даты в формате `YYYY-MM-DD`.

## [0.1.0] — 2026-11-17

Первый этап: каркас приложения, два WebView, тач-роутинг, тема и документация.

### Добавлено

- Каркас Tauri v2.12 для Android: React 19 + TypeScript 5.9 + Vite 8 (Rolldown)
  + Tailwind CSS 4.3 (CSS-first `@theme`, без `tailwind.config.js`).
- Нативный Kotlin-плагин `heliwatch`:
  - `HeliWatchContainer` — `FrameLayout` с сайтом снизу, прозрачным React-WebView
    сверху и слотом для fullscreen-видео;
  - `WebViewTapRouter` — прямоугольники интерактивных зон, запас 6 dp, фиксация
    цели на весь жест, блокировка фоновых касаний при открытой модалке;
  - `SiteWebViewFactory`, `SiteWebViewClient`, `SiteChromeClient` — мобильный
    Chrome-UA, куки и `CookieManager.flush()`, автоплей, системный выбор файла,
    `onShowCustomView`/`onHideCustomView`, консоль сайта в лог;
  - `NativeBridge` — `HeliNative.post(String)` для страницы сайта, лимиты 4 КБ и
    30 сообщений/с, без доступа к Activity;
  - `HeliWatchBridge` — установка контейнера, back-навигация по истории сайта с
    защитой от случайного выхода, прокси жизненного цикла WebView;
  - объявленные разрешения (INTERNET, RECORD_AUDIO, MODIFY_AUDIO_SETTINGS,
    WAKE_LOCK, FOREGROUND_SERVICE + mediaPlayback/microphone, POST_NOTIFICATIONS,
    READ_MEDIA_VIDEO/IMAGES, READ_EXTERNAL_STORAGE ≤ API 32) в библиотечном
    манифесте плагина.
- `src/native/inject/site-hook.js`: поиск `<video>` в основном документе, события
  play/pause/seek/rate/time, идемпотентный `window.__heliwatch`, выполнение
  `play`/`pause`/`seek`/`setRate`/`mute` с защитой от эха (800 мс).
- Прозрачный React-оверлей: верхняя панель (бренд, адрес, навигация, быстрые
  режимы, отладка зон) и нижняя панель (состояние видео, −10/play/+10, сворачивание).
  Все элементы вне сцены имеют `pointer-events: none`.
- `public/test-page.html` — локальная тестовая страница: видео (CC0, в APK),
  кнопки, поля сайта, выбор файла, 30 строк для скролла, переход в YouTube.
  Копируется в assets APK скриптом патчей.
- Тема: токены в `src/styles/theme.css` (фон `#06201d`, акцент `#6ff0c4`,
  радиусы 10–30 px, длительности 150–250 мс), тёмная тема Android.
- Брендинг: `docs/branding/logo.svg`, `logo-mark.svg`, `logo-variants.md`,
  `icon-source.png` (1024), исходники адаптивной иконки; адаптивная иконка и
  monochrome-слой добавлены в `gen/android`.
- Скрипты: `apply-android-patches.mjs` (идемпотентные правки gen/android,
  `HW:PATCH`-маркеры), `check-android.mjs` (`pnpm android:doctor`), `version.mjs`
  (`pnpm version:set`, синхронизация версии и `versionCode`), `icons.mjs`.
- `README.md` на русском: описание, статус 0.1.0, список будущих скриншотов,
  сборка, ограничения, стек, лицензия; `CHANGELOG.md`, `docs/android-notes.md`.

### Изменено

- `src-tauri/gen/android` — часть репозитория: `compileSdk`/`targetSdk` 36,
  `minSdk` 26, `configChanges` с `density`, `windowSoftInputMode=adjustResize`,
  `resizeableActivity=true`, deep link `heliwatch://`, `MainActivity` с
  `HeliWatchBridge.install(this)`.
- Tailwind CSS обновлён до 4.3.x: версия 4.1.x не поддерживает Vite 8 (peer
  dependencies), а Vite 8 выбран в плане. Таблица версий в `PLAN.md` обновлена.
- Минификация Vite — `oxc` (в Vite 8 Rolldown; esbuild отдельно не ставим).
- `versionCode` для Android берётся из `tauri.conf.json`
  (`major*10000 + minor*100 + patch`, для 0.1.0 — 100).

### Исправлено

- Прозрачность React-WebView: фон очищается в Kotlin и в CSS (`html`, `body`,
  `#root`), окно и тема — тёмные, без белой вспышки при старте.
- Back на Android: сначала история сайта, затем предупреждение «Ещё раз
  „назад“ — выход», и только второй back закрывает приложение.

### Удалено

- Ничего.

### Заметки

- Debug APK 0.1.0 собран под arm64-v8a (основные телефоны) на JDK 17,
  Gradle 9.6.1 и AGP 9.3.1. Сборка шла через
  Gradle с копированием `libheliwatch_lib.so` в `jniLibs`: на этой Windows-машине
  выключен режим разработчика, поэтому Tauri CLI не может создать символьную
  ссылку (и `cc` падает на `vswhom-sys` при debug-информации). Рабочий обход —
  `docs/android-notes.md`, раздел «Windows без Developer Mode».
- Тесты (`vitest`) подключаются вместе с первыми тестами протокола на этапе 2:
  версия 3.x несовместима с Vite 8, а держать второй Vite ради пустого набора
  тестов не нужно. В таблице версий `PLAN.md` это отмечено.
- Скриншоты из `PLAN.md` §6.3 появятся по мере готовности этапов; в README они
  перечислены с указанием этапа. Для 0.1.0 снимаются общий вид тестовой страницы
  и экран зон касания.

[0.1.0]: https://github.com/vezdehod2115/HeliWatch/releases/tag/v0.1.0
