#!/usr/bin/env node
/**
 * Проверяет, что `src-tauri/gen/android` содержит все правки HeliWatch
 * (маркеры HW:PATCH, compileSdk, манифест, MainActivity, ассеты, иконки)
 * и что версии синхронизированы. Падает с кодом 1, если что-то потеряно.
 */
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const genAndroid = path.join(root, 'src-tauri', 'gen', 'android');
const appDir = path.join(genAndroid, 'app');
const mainDir = path.join(appDir, 'src', 'main');
const resDir = path.join(mainDir, 'res');

const failures = [];
const warnings = [];
const checks = [];

function check(label, condition, detail = '') {
  if (condition) {
    checks.push(label);
  } else {
    failures.push(detail ? `${label}: ${detail}` : label);
  }
}

async function readText(filePath) {
  return (await readFile(filePath, 'utf8')).replace(/\r\n/g, '\n');
}

async function readOptional(filePath) {
  try {
    return await readText(filePath);
  } catch {
    return null;
  }
}

async function exists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function checkVersion() {
  const packageJson = JSON.parse(await readText(path.join(root, 'package.json')));
  const tauriConf = JSON.parse(await readText(path.join(root, 'src-tauri', 'tauri.conf.json')));
  const cargo = await readText(path.join(root, 'src-tauri', 'Cargo.toml'));
  const pluginCargo = await readText(
    path.join(root, 'src-tauri', 'plugins', 'heliwatch', 'Cargo.toml'),
  );
  const cargoVersion = cargo.match(/\[package\][\s\S]*?\nversion\s*=\s*"([^"]+)"/)?.[1];
  const pluginVersion = pluginCargo.match(/\[package\][\s\S]*?\nversion\s*=\s*"([^"]+)"/)?.[1];

  check('package.json version задан', Boolean(packageJson.version));
  check(
    'версия package.json = tauri.conf.json',
    packageJson.version === tauriConf.version,
    `${packageJson.version} != ${tauriConf.version}`,
  );
  check(
    'версия package.json = Cargo.toml',
    packageJson.version === cargoVersion,
    `${packageJson.version} != ${cargoVersion}`,
  );
  check(
    'версия package.json = плагин Cargo.toml',
    packageJson.version === pluginVersion,
    `${packageJson.version} != ${pluginVersion}`,
  );

  const [major, minor, patch] = String(packageJson.version).split('.').map(Number);
  const expectedCode = major * 10000 + minor * 100 + patch;
  check(
    `bundle.android.versionCode = ${expectedCode}`,
    Number(tauriConf.bundle?.android?.versionCode) === expectedCode,
    `сейчас ${tauriConf.bundle?.android?.versionCode}`,
  );
}

async function checkGradle() {
  const buildGradle = await readOptional(path.join(appDir, 'build.gradle.kts'));
  if (!buildGradle) {
    failures.push('app/build.gradle.kts отсутствует — нужен pnpm tauri android init');
    return;
  }
  check('compileSdk = 36', /compileSdk\s*=\s*36\b/.test(buildGradle));
  check('targetSdk = 36', /targetSdk\s*=\s*36\b/.test(buildGradle));
  check('minSdk = 26', /minSdk\s*=\s*26\b/.test(buildGradle));

  const settings = await readOptional(path.join(genAndroid, 'settings.gradle'));
  check('settings.gradle на месте', settings !== null);

  // Tauri CLI генерирует эти файлы из cargo metadata перед сборкой Gradle.
  const tauriSettings = await readOptional(path.join(genAndroid, 'tauri.settings.gradle'));
  if (tauriSettings) {
    check(
      'tauri.settings.gradle содержит плагин heliwatch',
      tauriSettings.includes('tauri-plugin-heliwatch'),
    );
  } else {
    warnings.push(
      'tauri.settings.gradle ещё не создан: появится на первой сборке Tauri (CLI подключает плагин сам)',
    );
  }

  const tauriBuild = await readOptional(path.join(genAndroid, 'tauri.build.gradle.kts'));
  check(
    'app/build.gradle.kts подключает Kotlin-плагин',
    buildGradle.includes('tauri-plugin-heliwatch'),
  );
  if (tauriBuild) {
    check(
      'tauri.build.gradle.kts или app/build.gradle.kts подключает плагин',
      tauriBuild.includes('tauri-plugin-heliwatch') ||
        buildGradle.includes(':tauri-plugin-heliwatch'),
    );
  }
}

async function checkManifest() {
  const manifest = await readOptional(path.join(mainDir, 'AndroidManifest.xml'));
  if (!manifest) {
    failures.push('AndroidManifest.xml отсутствует');
    return;
  }
  check('маркер HW:PATCH:ACTIVITY', manifest.includes('<!-- HW:PATCH:ACTIVITY -->'));
  const configChanges = manifest.match(/android:configChanges="([^"]*)"/)?.[1] ?? '';
  check(
    'configChanges содержит density/orientation/screenSize',
    ['density', 'orientation', 'screenSize', 'smallestScreenSize'].every((flag) =>
      configChanges.split('|').includes(flag),
    ),
    configChanges,
  );
  check(
    'windowSoftInputMode=adjustResize',
    manifest.includes('android:windowSoftInputMode="adjustResize"'),
  );
  check('resizeableActivity=true', manifest.includes('android:resizeableActivity="true"'));
  check('scheme heliwatch объявлен', /<data\s+android:scheme="heliwatch"/.test(manifest));
  check('label приложения = app_name', manifest.includes('android:label="@string/app_name"'));
}

async function checkMainActivity() {
  const filePath = path.join(mainDir, 'java', 'dev', 'heliwatch', 'app', 'MainActivity.kt');
  const content = await readOptional(filePath);
  if (!content) {
    failures.push('MainActivity.kt отсутствует');
    return;
  }
  check('импорт HeliWatchBridge', content.includes('import dev.heliwatch.HeliWatchBridge'));
  check(
    'маркеры HW:PATCH:MAIN',
    content.includes('// HW:PATCH:MAIN:BEGIN') && content.includes('// HW:PATCH:MAIN:END'),
  );
  check('вызов HeliWatchBridge.install(this)', content.includes('HeliWatchBridge.install(this)'));
  check(
    'маркеры HW:PATCH:INTENT',
    content.includes('// HW:PATCH:INTENT:BEGIN') && content.includes('// HW:PATCH:INTENT:END'),
  );
  check(
    'onNewIntent → HeliWatchBridge.handleIntent',
    content.includes('override fun onNewIntent(') &&
      content.includes('HeliWatchBridge.handleIntent(intent)'),
  );
}

async function checkResources() {
  const strings = await readOptional(path.join(resDir, 'values', 'strings.xml'));
  check('strings: app_name = HeliWatch', strings?.includes('>HeliWatch<') ?? false);
  const branding = await readOptional(path.join(resDir, 'values', 'hw_branding.xml'));
  check('hw_branding.xml с цветами', branding?.includes('hw_icon_background') ?? false);
  const theme = await readOptional(path.join(resDir, 'values', 'themes.xml'));
  check('тёмная тема Material3', theme?.includes('Theme.Material3.Dark.NoActionBar') ?? false);
  check('windowBackground темы', theme?.includes('android:windowBackground') ?? false);
  const adaptive = await readOptional(
    path.join(resDir, 'mipmap-anydpi-v26', 'ic_launcher.xml'),
  );
  check('адаптивная иконка ic_launcher', adaptive?.includes('<adaptive-icon') ?? false);
  const foreground = await readOptional(
    path.join(resDir, 'drawable', 'hw_icon_foreground.xml'),
  );
  check('вектор foreground иконки', foreground?.includes('<vector') ?? false);
}

async function checkAssets() {
  const names = ['test-page.html', 'test-video.mp4'];
  for (const name of names) {
    const source = path.join(root, 'public', name);
    const target = path.join(mainDir, 'assets', name);
    if (!(await exists(source))) {
      failures.push(`public/${name} отсутствует`);
      continue;
    }
    if (!(await exists(target))) {
      failures.push(`ассет ${name} не скопирован в gen/android/app/src/main/assets`);
      continue;
    }
    const [sourceBytes, targetBytes] = await Promise.all([
      readFile(source),
      readFile(target),
    ]);
    check(`ассет ${name} синхронизирован`, sha256(sourceBytes) === sha256(targetBytes));
  }
}

async function checkPlugin() {
  const pluginRoot = path.join(root, 'src-tauri', 'plugins', 'heliwatch');
  const required = [
    'Cargo.toml',
    'build.rs',
    'src/lib.rs',
    'android/build.gradle.kts',
    'android/src/main/AndroidManifest.xml',
    'android/src/main/java/dev/heliwatch/HeliWatchPlugin.kt',
    'android/src/main/java/dev/heliwatch/HeliWatchBridge.kt',
    'android/src/main/java/dev/heliwatch/HeliWatchContainer.kt',
    'android/src/main/java/dev/heliwatch/WebViewTapRouter.kt',
    'android/src/main/java/dev/heliwatch/SiteWebViewFactory.kt',
    'android/src/main/java/dev/heliwatch/SiteWebViewClient.kt',
    'android/src/main/java/dev/heliwatch/SiteChromeClient.kt',
    'android/src/main/java/dev/heliwatch/NativeBridge.kt',
    'android/src/main/java/dev/heliwatch/PageHook.kt',
    'permissions/default.toml',
  ];
  for (const relative of required) {
    check(`плагин: ${relative}`, await exists(path.join(pluginRoot, relative)));
  }

  const manifest = await readOptional(
    path.join(pluginRoot, 'android/src/main/AndroidManifest.xml'),
  );
  for (const permission of [
    'android.permission.INTERNET',
    'android.permission.RECORD_AUDIO',
    'android.permission.MODIFY_AUDIO_SETTINGS',
    'android.permission.WAKE_LOCK',
    'android.permission.FOREGROUND_SERVICE',
    'android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK',
    'android.permission.FOREGROUND_SERVICE_MICROPHONE',
    'android.permission.POST_NOTIFICATIONS',
    'android.permission.READ_MEDIA_VIDEO',
    'android.permission.READ_MEDIA_IMAGES',
    'android.permission.READ_EXTERNAL_STORAGE',
  ]) {
    check(`разрешение ${permission}`, manifest?.includes(permission) ?? false);
  }

  const permissions = await readOptional(path.join(pluginRoot, 'permissions/default.toml'));
  check(
    'permissions: allow-register-listener',
    permissions?.includes('allow-register-listener') ?? false,
  );
  check('permissions: allow-site-regions', permissions?.includes('allow-site-regions') ?? false);

  const nativeBridge = await readOptional(
    path.join(pluginRoot, 'android/src/main/java/dev/heliwatch/NativeBridge.kt'),
  );
  check(
    'NativeBridge: @JavascriptInterface',
    nativeBridge?.includes('@JavascriptInterface') ?? false,
  );
  check(
    'NativeBridge: лимит 30/с',
    nativeBridge?.includes('MAX_MESSAGES_PER_WINDOW = 30') ?? false,
  );
  check('NativeBridge: лимит 4 КБ', nativeBridge?.includes('4096') ?? false);

  const container = await readOptional(
    path.join(pluginRoot, 'android/src/main/java/dev/heliwatch/HeliWatchContainer.kt'),
  );
  check(
    'контейнер: dispatchTouchEvent',
    container?.includes('override fun dispatchTouchEvent') ?? false,
  );
  check('контейнер: slop 6dp', container?.includes('6f * resources.displayMetrics.density') ?? false);
}

async function main() {
  if (!(await exists(genAndroid))) {
    process.stderr.write(
      '[android:doctor] src-tauri/gen/android не найден: выполните pnpm tauri android init && pnpm android:patch\n',
    );
    process.exitCode = 1;
    return;
  }

  await checkVersion();
  await checkGradle();
  await checkManifest();
  await checkMainActivity();
  await checkResources();
  await checkAssets();
  await checkPlugin();

  for (const warning of warnings) {
    process.stdout.write(`[android:doctor] ВНИМАНИЕ: ${warning}\n`);
  }
  if (failures.length > 0) {
    process.stderr.write(`[android:doctor] Провалено проверок: ${failures.length}\n`);
    for (const failure of failures) {
      process.stderr.write(`  ✗ ${failure}\n`);
    }
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    `[android:doctor] OK: ${checks.length} проверок пройдено, ${warnings.length} предупреждений\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`[android:doctor] ОШИБКА: ${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});
