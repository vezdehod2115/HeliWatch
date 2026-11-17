#!/usr/bin/env node
/**
 * Идемпотентно применяет правки к сгенерированному `src-tauri/gen/android`.
 *
 * Зачем скрипт: `tauri android init` перегенерирует папку и теряет ручные правки.
 * Все изменения помечены маркерами `HW:PATCH`; `pnpm android:doctor` проверяет,
 * что после перегенерации ничего не потерялось. Инструкция — docs/android-notes.md.
 *
 * Скрипт не трогает сгенерированный каталог `generated` в MainActivity.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const genAndroid = path.join(root, 'src-tauri', 'gen', 'android');
const appDir = path.join(genAndroid, 'app');
const mainDir = path.join(appDir, 'src', 'main');
const resDir = path.join(mainDir, 'res');
const assetsDir = path.join(mainDir, 'assets');
const publicDir = path.join(root, 'public');

const COMPILE_SDK = 36;
const TARGET_SDK = 36;
const MIN_SDK = 26;

const changedFiles = [];
const skippedFiles = [];

function log(message) {
  process.stdout.write(`[android:patch] ${message}\n`);
}

async function exists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readText(filePath) {
  const content = await readFile(filePath, 'utf8');
  return content.replace(/\r\n/g, '\n');
}

async function writeIfChanged(filePath, content, label = path.relative(root, filePath)) {
  const previous = (await exists(filePath)) ? await readFile(filePath, 'utf8') : null;
  if (previous === content) {
    skippedFiles.push(label);
    return false;
  }
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, 'utf8');
  changedFiles.push(label);
  return true;
}

async function patchText(filePath, patcher) {
  if (!(await exists(filePath))) {
    throw new Error(
      `нет файла ${path.relative(root, filePath)} — сначала выполните pnpm tauri android init`,
    );
  }
  const content = await readText(filePath);
  const next = patcher(content, path.relative(root, filePath));
  await writeIfChanged(filePath, next);
}

function mustReplace(content, pattern, replacement, what) {
  if (!pattern.test(content)) {
    throw new Error(`не найден шаблон для правки: ${what}`);
  }
  return content.replace(pattern, replacement);
}

async function ensureDir(dir) {
  await mkdir(dir, { recursive: true });
}

async function copyAsset(name) {
  const source = path.join(publicDir, name);
  if (!(await exists(source))) {
    throw new Error(`нет ассета ${path.relative(root, source)}`);
  }
  const target = path.join(assetsDir, name);
  await ensureDir(assetsDir);
  const sourceBytes = await readFile(source);
  const targetBytes = (await exists(target)) ? await readFile(target) : null;
  if (targetBytes && sourceBytes.equals(targetBytes)) {
    skippedFiles.push(path.relative(root, target));
    return;
  }
  await writeFile(target, sourceBytes);
  changedFiles.push(path.relative(root, target));
}

async function patchAppGradle() {
  const file = path.join(appDir, 'build.gradle.kts');
  await patchText(file, (content) => {
    let next = content;
    next = mustReplace(
      next,
      /compileSdk\s*=\s*\d+/,
      `compileSdk = ${COMPILE_SDK}`,
      'compileSdk',
    );
    next = mustReplace(next, /targetSdk\s*=\s*\d+/, `targetSdk = ${TARGET_SDK}`, 'targetSdk');
    next = mustReplace(next, /minSdk\s*=\s*\d+/, `minSdk = ${MIN_SDK}`, 'minSdk');

    // Kotlin-плагин — отдельный Gradle-проект. Tauri CLI подключает его
    // автоматически в tauri.build.gradle.kts, но при сборке напрямую через
    // Gradle (без developer mode на Windows) зависимость должна быть здесь.
    if (!next.includes(':tauri-plugin-heliwatch')) {
      if (!next.includes('dependencies {\n')) {
        throw new Error('в app/build.gradle.kts не найден блок dependencies');
      }
      next = next.replace(
        'dependencies {\n',
        'dependencies {\n    // HW:PATCH:PLUGIN-DEP (Kotlin-плагин HeliWatch)\n    implementation(project(":tauri-plugin-heliwatch"))\n',
      );
    }

    // Этап 7: plugin-fs и plugin-dialog — тоже отдельные Gradle-проекты.
    // При сборке через CLI они попадают в tauri.build.gradle.kts, но прямой
    // запуск Gradle (Windows без developer mode) читает только этот файл.
    if (!next.includes(':tauri-plugin-fs')) {
      next = next.replace(
        'dependencies {\n',
        'dependencies {\n    // HW:PATCH:PLUGIN-DEP (файловый кэш и бэкап этапа 7)\n    implementation(project(":tauri-plugin-fs"))\n    implementation(project(":tauri-plugin-dialog"))\n',
      );
    }

    return next;
  });

  // app/build.gradle.kts заканчивается apply(from = "tauri.build.gradle.kts").
  // Tauri CLI создаёт этот файл при сборке; для прямого запуска Gradle создаём
  // пустую заготовку, чтобы apply не упал.
  const tauriBuildFile = path.join(genAndroid, 'tauri.build.gradle.kts');
  if (!(await exists(tauriBuildFile))) {
    await writeFile(
      tauriBuildFile,
      '// Служебный файл Tauri CLI; правки HeliWatch — в scripts/apply-android-patches.mjs.\n',
      'utf8',
    );
    changedFiles.push(path.relative(root, tauriBuildFile));
  }
}

async function patchManifest() {
  const file = path.join(mainDir, 'AndroidManifest.xml');
  await patchText(file, (content) => {
    let next = content;

    const activityMatch = next.match(/<activity\b[^>]*>/);
    if (!activityMatch) {
      throw new Error('в манифесте не найден <activity>');
    }
    let activityTag = activityMatch[0];

    const configMatch = activityTag.match(/android:configChanges="([^"]*)"/);
    if (!configMatch) {
      throw new Error('у activity нет android:configChanges');
    }
    const flags = new Set(configMatch[1].split('|'));
    flags.add('density');
    flags.add('orientation');
    flags.add('screenSize');
    flags.add('smallestScreenSize');
    flags.add('screenLayout');
    flags.add('keyboardHidden');
    flags.add('uiMode');
    activityTag = activityTag.replace(
      /android:configChanges="[^"]*"/,
      `android:configChanges="${[...flags].join('|')}"`,
    );

    if (!activityTag.includes('android:windowSoftInputMode=')) {
      activityTag = activityTag.replace(
        /<activity\b/,
        '<activity\n            android:windowSoftInputMode="adjustResize"',
      );
    }
    if (!activityTag.includes('android:resizeableActivity=')) {
      activityTag = activityTag.replace(
        /<activity\b/,
        '<activity\n            android:resizeableActivity="true"',
      );
    }
    // PiP (этап 4): окно видео поверх других приложений.
    if (!activityTag.includes('android:supportsPictureInPicture=')) {
      activityTag = activityTag.replace(
        /<activity\b/,
        '<activity\n            android:supportsPictureInPicture="true"',
      );
    }

    next = next.replace(
      activityMatch[0],
      next.includes('<!-- HW:PATCH:ACTIVITY -->')
        ? activityTag
        : `<!-- HW:PATCH:ACTIVITY -->\n        ${activityTag}`,
    );

    const deeplink = `            <!-- HW:PATCH:DEEPLINK:BEGIN -->
            <intent-filter>
                <action android:name="android.intent.action.VIEW" />
                <category android:name="android.intent.category.DEFAULT" />
                <category android:name="android.intent.category.BROWSABLE" />
                <data android:scheme="heliwatch" />
            </intent-filter>
            <!-- HW:PATCH:DEEPLINK:END -->
`;
    if (!next.includes('HW:PATCH:DEEPLINK:BEGIN')) {
      next = next.replace(/\n(\s*)<\/activity>/, `\n${deeplink}$1</activity>`);
    }

    return next;
  });
}

async function patchMainActivity() {
  const file = path.join(
    mainDir,
    'java',
    'dev',
    'heliwatch',
    'app',
    'MainActivity.kt',
  );
  await patchText(file, (content) => {
    let next = content;
    const importLine = 'import dev.heliwatch.HeliWatchBridge';
    if (!next.includes(importLine)) {
      next = next.replace(
        /import androidx\.activity\.enableEdgeToEdge\n/,
        `import androidx.activity.enableEdgeToEdge\n${importLine}\n`,
      );
      if (!next.includes(importLine)) {
        throw new Error('не удалось добавить import HeliWatchBridge в MainActivity.kt');
      }
    }

    const block = `    // HW:PATCH:MAIN:BEGIN
    HeliWatchBridge.install(this)
    // HW:PATCH:MAIN:END`;
    if (/^[ \t]*\/\/ HW:PATCH:MAIN:BEGIN[\s\S]*?\/\/ HW:PATCH:MAIN:END/m.test(next)) {
      next = next.replace(
        /^[ \t]*\/\/ HW:PATCH:MAIN:BEGIN[\s\S]*?\/\/ HW:PATCH:MAIN:END/m,
        block,
      );
    } else {
      next = next.replace(
        /super\.onCreate\(savedInstanceState\)\n/,
        `super.onCreate(savedInstanceState)\n${block}\n`,
      );
    }
    if (!next.includes('HeliWatchBridge.install(this)')) {
      throw new Error('не удалось вставить HeliWatchBridge.install() в MainActivity.kt');
    }

    // Ссылка heliwatch://r/<code> при повторном открытии приходит в onNewIntent.
    const intentBlock = `    // HW:PATCH:INTENT:BEGIN
    override fun onNewIntent(intent: android.content.Intent) {
      super.onNewIntent(intent)
      HeliWatchBridge.handleIntent(intent)
    }
    // HW:PATCH:INTENT:END`;
    if (/^[ \t]*\/\/ HW:PATCH:INTENT:BEGIN[\s\S]*?\/\/ HW:PATCH:INTENT:END/m.test(next)) {
      next = next.replace(
        /^[ \t]*\/\/ HW:PATCH:INTENT:BEGIN[\s\S]*?\/\/ HW:PATCH:INTENT:END/m,
        intentBlock,
      );
    } else {
      next = next.replace(/\n}\s*$/, `\n\n${intentBlock}\n}\n`);
    }
    if (!next.includes('HeliWatchBridge.handleIntent(intent)')) {
      throw new Error('не удалось вставить onNewIntent() в MainActivity.kt');
    }

    // PiP (этап 4): Activity не отдаёт эти колбэки плагину Tauri, поэтому
    // проксируем их в HeliWatchBridge вручную.
    const pipBlock = `  // HW:PATCH:PIP:BEGIN
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
  // HW:PATCH:PIP:END`;
    if (/^[ \t]*\/\/ HW:PATCH:PIP:BEGIN[\s\S]*?\/\/ HW:PATCH:PIP:END/m.test(next)) {
      next = next.replace(
        /^[ \t]*\/\/ HW:PATCH:PIP:BEGIN[\s\S]*?\/\/ HW:PATCH:PIP:END/m,
        pipBlock,
      );
    } else {
      next = next.replace(/\n}\s*$/, `\n\n${pipBlock}\n}\n`);
    }
    if (!next.includes('HeliWatchBridge.onUserLeaveHint()')) {
      throw new Error('не удалось вставить onUserLeaveHint() в MainActivity.kt');
    }
    if (!next.includes('HeliWatchBridge.onPictureInPictureModeChanged(')) {
      throw new Error('не удалось вставить onPictureInPictureModeChanged() в MainActivity.kt');
    }
    return next;
  });
}

async function patchStrings() {
  const file = path.join(resDir, 'values', 'strings.xml');
  await writeIfChanged(
    file,
    `<resources>
    <string name="app_name">HeliWatch</string>
    <string name="main_activity_title">HeliWatch</string>
</resources>
`,
  );
}

async function patchThemes() {
  const themeFiles = [
    path.join(resDir, 'values', 'themes.xml'),
    path.join(resDir, 'values-night', 'themes.xml'),
  ];
  for (const file of themeFiles) {
    await patchText(file, (content) => {
      let next = mustReplace(
        content,
        /(<style name="Theme\.[^"]+" parent=")[^"]*(")/,
        `$1Theme.Material3.Dark.NoActionBar$2`,
        'parent темы',
      );
      if (!next.includes('android:windowBackground')) {
        next = next.replace(
          /(<style name="Theme\.[^"]+"[^>]*>)\n?/,
          `$1
        <item name="android:windowBackground">@color/hw_window_background</item>
        <item name="android:statusBarColor">@android:color/transparent</item>
        <item name="android:navigationBarColor">@android:color/transparent</item>
        <item name="android:windowLightStatusBar">false</item>
`,
        );
      }
      return next;
    });
  }
}

async function writeBrandingResources() {
  await writeIfChanged(
    path.join(resDir, 'values', 'hw_branding.xml'),
    `<resources>
    <!-- Фон окна и адаптивной иконки HeliWatch. -->
    <color name="hw_window_background">#06201D</color>
    <color name="hw_icon_background">#06201D</color>
</resources>
`,
  );

  const foreground = `<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="108dp"
    android:height="108dp"
    android:viewportWidth="512"
    android:viewportHeight="512">
    <!-- H: две скруглённые стойки -->
    <path
        android:fillColor="#6FF0C4"
        android:pathData="M137,142 A33,33 0 0 1 170,175 L170,337 A33,33 0 0 1 137,370 A33,33 0 0 1 104,337 L104,175 A33,33 0 0 1 137,142 Z" />
    <path
        android:fillColor="#6FF0C4"
        android:pathData="M375,142 A33,33 0 0 1 408,175 L408,337 A33,33 0 0 1 375,370 A33,33 0 0 1 342,337 L342,175 A33,33 0 0 1 375,142 Z" />
    <!-- Перекладина-плей -->
    <path
        android:fillColor="#6FF0C4"
        android:pathData="M214,184 L214,328 L336,256 Z" />
</vector>
`;
  await writeIfChanged(path.join(resDir, 'drawable', 'hw_icon_foreground.xml'), foreground);

  const adaptive = `<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/hw_icon_background" />
    <foreground android:drawable="@drawable/hw_icon_foreground" />
    <monochrome android:drawable="@drawable/hw_icon_foreground" />
</adaptive-icon>
`;
  await ensureDir(path.join(resDir, 'mipmap-anydpi-v26'));
  await writeIfChanged(
    path.join(resDir, 'mipmap-anydpi-v26', 'ic_launcher.xml'),
    adaptive,
  );
  await writeIfChanged(
    path.join(resDir, 'mipmap-anydpi-v26', 'ic_launcher_round.xml'),
    adaptive,
  );
}

async function copySiteAssets() {
  await copyAsset('test-page.html');
  await copyAsset('test-video.mp4');
}

async function hashAssets() {
  const pairs = ['test-page.html', 'test-video.mp4'];
  const rows = [];
  for (const name of pairs) {
    const bytes = await readFile(path.join(assetsDir, name));
    rows.push(`${name}  ${createHash('sha256').update(bytes).digest('hex')}`);
  }
  await writeIfChanged(
    path.join(assetsDir, 'heliwatch-assets.sha256'),
    `${rows.join('\n')}\n`,
  );
}

async function main() {
  if (!(await exists(genAndroid))) {
    throw new Error(
      'src-tauri/gen/android не найден. Выполните `pnpm tauri android init`, затем `pnpm android:patch`.',
    );
  }
  log(`проект: ${path.relative(root, genAndroid)}`);

  await patchAppGradle();
  await patchManifest();
  await patchMainActivity();
  await patchStrings();
  await patchThemes();
  await writeBrandingResources();
  await copySiteAssets();
  await hashAssets();

  log(`обновлено файлов: ${changedFiles.length}, без изменений: ${skippedFiles.length}`);
  for (const file of changedFiles) {
    log(`  изменён ${file}`);
  }
  log('готово. Проверка: pnpm android:doctor');
}

main().catch((error) => {
  process.stderr.write(`[android:patch] ОШИБКА: ${error.message}\n`);
  process.exitCode = 1;
});
