#!/usr/bin/env node
/**
 * Генерирует иконки для всех платформ из docs/branding/icon-source.png.
 * Android-манифест ссылается на @mipmap/ic_launcher; PNG кладёт `tauri icon`,
 * а адаптивную иконку (mipmap-anydpi-v26) добавляет apply-android-patches.mjs.
 */
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'docs', 'branding', 'icon-source.png');
const output = path.join(root, 'src-tauri', 'icons');
const androidRes = path.join(root, 'src-tauri', 'gen', 'android', 'app', 'src', 'main', 'res');
const cli = path.join(root, 'node_modules', '@tauri-apps', 'cli', 'tauri.js');

async function exists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function copyDir(sourceDir, targetDir) {
  await mkdir(targetDir, { recursive: true });
  for (const entry of await readdir(sourceDir, { withFileTypes: true })) {
    const from = path.join(sourceDir, entry.name);
    const to = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      await copyDir(from, to);
    } else {
      await copyFile(from, to);
    }
  }
}

if (!(await exists(source))) {
  process.stderr.write(
    `[icons] нет ${path.relative(root, source)} — сначала сгенерируйте PNG из docs/branding/logo-mark.svg\n`,
  );
  process.exit(1);
}

process.stdout.write('[icons] tauri icon\n');
execFileSync(process.execPath, [cli, 'icon', source, '--output', output], {
  cwd: root,
  stdio: 'inherit',
});

// tauri icon для Android пишет mipmap-* в сгенерированный проект; на случай
// другой версии CLI поддерживаем и вариант src-tauri/icons/android.
const androidIcons = path.join(output, 'android');
if (await exists(androidIcons)) {
  for (const entry of await readdir(androidIcons, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('mipmap-')) {
      continue;
    }
    await copyDir(
      path.join(androidIcons, entry.name),
      path.join(androidRes, entry.name),
    );
  }
  process.stdout.write('[icons] Android mipmap-* скопированы в gen/android\n');
} else {
  process.stdout.write('[icons] Android mipmap-* обновлены в gen/android напрямую\n');
}

process.stdout.write('[icons] готово\n');
