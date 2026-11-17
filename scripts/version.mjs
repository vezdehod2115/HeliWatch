#!/usr/bin/env node
/** Синхронно меняет версию в package.json, Cargo.toml, tauri.conf.json, versionCode. */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = process.argv[2];

if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
  process.stderr.write('Использование: pnpm version:set X.Y.Z (например, 0.2.0)\n');
  process.exit(1);
}

const [major, minor, patch] = version.split('.').map(Number);
const versionCode = major * 10000 + minor * 100 + patch;

async function updateJson(relativePath, mutate) {
  const filePath = path.join(root, relativePath);
  const data = JSON.parse(await readFile(filePath, 'utf8'));
  mutate(data);
  await writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  process.stdout.write(`[version] ${relativePath}: ${data.version}\n`);
}

async function updateCargo(relativePath) {
  const filePath = path.join(root, relativePath);
  const content = await readFile(filePath, 'utf8');
  const next = content.replace(
    /(\[package\][\s\S]*?\nversion\s*=\s*")[^"]+(")/,
    `$1${version}$2`,
  );
  if (next === content) {
    throw new Error(`не удалось обновить версию в ${relativePath}`);
  }
  await writeFile(filePath, next, 'utf8');
  process.stdout.write(`[version] ${relativePath}: ${version}\n`);
}

await updateJson('package.json', (data) => {
  data.version = version;
});
await updateJson('src-tauri/tauri.conf.json', (data) => {
  data.version = version;
  data.bundle = data.bundle ?? {};
  data.bundle.android = data.bundle.android ?? {};
  data.bundle.android.versionCode = versionCode;
});
await updateCargo('src-tauri/Cargo.toml');
await updateCargo('src-tauri/plugins/heliwatch/Cargo.toml');

process.stdout.write(`[version] versionCode = ${versionCode}\n`);
process.stdout.write('[version] готово. Cargo.lock обновится при следующей сборке.\n');
