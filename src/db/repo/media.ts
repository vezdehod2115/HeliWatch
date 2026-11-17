/*
 * Файловый кэш фото и аватаров (этап 7, §4.7).
 *
 * Файлы лежат в app-cache (фото) и app-data (аватары), а SQLite хранит только
 * индекс: хеш, путь, размер и время последнего чтения. Это даёт LRU без
 * раздувания базы: фото ≤ 2 МБ, общий предел 200 МБ, аватары — 50 файлов/5 МБ.
 *
 * Картинки отдаются в UI blob-URL'ами: так не нужен asset-протокол и его
 * scope, а в браузере предпросмотра всё просто возвращает null.
 */

import { BaseDirectory, exists, mkdir, readFile, remove, writeFile } from '@tauri-apps/plugin-fs';
import { executeSql, selectRows } from '../index';
import type { AvatarRow, MediaCacheRow } from '../migrations';
import { sha256Hex } from '../../net/blobs';
import { isNativeRuntime } from '../../native/nativeBridge';

/** Общий предел кэша фото — 200 МБ (§4.7). */
export const MEDIA_CACHE_BYTES = 200 * 1024 * 1024;
/** Аватары: 50 файлов и 5 МБ вместе с индексом (§4.7). */
export const AVATAR_MAX_FILES = 50;
export const AVATAR_MAX_BYTES = 5 * 1024 * 1024;
/** Аватар хранится 128×128 (§4.7). */
export const AVATAR_SIDE = 128;

const MEDIA_DIR = 'heliwatch-media';
const AVATAR_DIR = 'heliwatch-avatars';
const URL_CACHE_LIMIT = 48;

const mediaUrls = new Map<string, string>();
const avatarUrls = new Map<string, string>();
let dirsReady: Promise<boolean> | null = null;

function extensionFor(mime: string): string {
  if (mime === 'image/png') {
    return 'png';
  }
  if (mime === 'image/webp') {
    return 'webp';
  }
  return 'jpg';
}

async function ensureDirs(): Promise<boolean> {
  if (!isNativeRuntime()) {
    return false;
  }
  if (!dirsReady) {
    dirsReady = (async () => {
      try {
        const media = await exists(MEDIA_DIR, { baseDir: BaseDirectory.AppCache });
        if (!media) {
          await mkdir(MEDIA_DIR, { baseDir: BaseDirectory.AppCache, recursive: true });
        }
        const avatars = await exists(AVATAR_DIR, { baseDir: BaseDirectory.AppData });
        if (!avatars) {
          await mkdir(AVATAR_DIR, { baseDir: BaseDirectory.AppData, recursive: true });
        }
        return true;
      } catch (error) {
        console.warn('[heliwatch] не удалось создать каталоги кэша', error);
        return false;
      }
    })();
  }
  return dirsReady;
}

function rememberUrl(
  cache: Map<string, string>,
  hash: string,
  url: string,
): void {
  const previous = cache.get(hash);
  if (previous) {
    URL.revokeObjectURL(previous);
  }
  cache.set(hash, url);
  while (cache.size > URL_CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (typeof oldest !== 'string') {
      break;
    }
    const oldUrl = cache.get(oldest);
    cache.delete(oldest);
    if (oldUrl) {
      URL.revokeObjectURL(oldUrl);
    }
  }
}

/** Хеш содержимого: одинаковые фото не занимают место дважды. */
export async function hashImage(bytes: Uint8Array): Promise<string> {
  return sha256Hex(bytes);
}

/**
 * Положить фото в кэш. Возвращает хеш и путь или null, если файловый слой
 * недоступен (браузер предпросмотра). Хеш уже есть — файл не перезаписываем.
 */
export async function saveMediaImage(
  bytes: Uint8Array,
  mime: string,
  w: number,
  h: number,
): Promise<{ hash: string; path: string } | null> {
  if (!(await ensureDirs())) {
    return null;
  }
  const hash = await hashImage(bytes);
  const rows = await selectRows<MediaCacheRow>(
    'SELECT hash, path, size, last_used_at FROM media_cache WHERE hash = $1',
    [hash],
  );
  const now = Date.now();
  if (rows[0]) {
    await executeSql('UPDATE media_cache SET last_used_at = $2 WHERE hash = $1', [hash, now]);
    return { hash, path: rows[0].path };
  }
  const relative = `${MEDIA_DIR}/${hash}.${extensionFor(mime)}`;
  try {
    await writeFile(relative, bytes, { baseDir: BaseDirectory.AppCache });
  } catch (error) {
    console.warn('[heliwatch] не удалось записать фото в кэш', error);
    return null;
  }
  const saved = await executeSql(
    `INSERT INTO media_cache (hash, path, size, mime, w, h, last_used_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT(hash) DO UPDATE SET last_used_at = excluded.last_used_at`,
    [hash, relative, bytes.byteLength, mime, Math.max(0, Math.round(w)), Math.max(0, Math.round(h)), now],
  );
  if (!saved) {
    return { hash, path: relative };
  }
  await trimMediaCache();
  return { hash, path: relative };
}

/** Blob-URL для фото из кэша; при повторном вызове — из памяти. */
export async function mediaImageUrl(hash: string): Promise<string | null> {
  const cached = mediaUrls.get(hash);
  if (cached) {
    return cached;
  }
  if (!(await ensureDirs())) {
    return null;
  }
  const rows = await selectRows<MediaCacheRow>(
    'SELECT path, mime FROM media_cache WHERE hash = $1',
    [hash],
  );
  const row = rows[0];
  if (!row) {
    return null;
  }
  try {
    const bytes = await readFile(row.path, { baseDir: BaseDirectory.AppCache });
    const url = URL.createObjectURL(
      new Blob([bytes as unknown as BlobPart], { type: row.mime || 'image/jpeg' }),
    );
    rememberUrl(mediaUrls, hash, url);
    await executeSql('UPDATE media_cache SET last_used_at = $2 WHERE hash = $1', [
      hash,
      Date.now(),
    ]);
    return url;
  } catch (error) {
    console.warn('[heliwatch] фото не прочиталось из кэша', error);
    return null;
  }
}

/** Удалить самое старое, пока кэш не уложится в 200 МБ. */
export async function trimMediaCache(maxBytes = MEDIA_CACHE_BYTES): Promise<number> {
  if (!(await ensureDirs())) {
    return 0;
  }
  const rows = await selectRows<{ hash: string; path: string; size: number }>(
    'SELECT hash, path, size FROM media_cache ORDER BY last_used_at ASC',
  );
  let total = rows.reduce((sum, row) => sum + (Number(row.size) || 0), 0);
  let removed = 0;
  for (const row of rows) {
    if (total <= maxBytes) {
      break;
    }
    const size = Number(row.size) || 0;
    try {
      await remove(row.path, { baseDir: BaseDirectory.AppCache });
    } catch {
      /* файла уже нет — просто чистим индекс */
    }
    await executeSql('DELETE FROM media_cache WHERE hash = $1', [row.hash]);
    // Ссылки в истории не должны указывать на удалённый файл.
    await executeSql('UPDATE dm_messages SET image_path = NULL WHERE image_path = $1', [
      row.path,
    ]);
    await executeSql('UPDATE room_chat SET image_path = NULL WHERE image_path = $1', [
      row.path,
    ]);
    const url = mediaUrls.get(row.hash);
    if (url) {
      URL.revokeObjectURL(url);
      mediaUrls.delete(row.hash);
    }
    total -= size;
    removed += 1;
  }
  return removed;
}

/**
 * Аватар: 128×128, ≤ 5 МБ на все. Хранится в app-data, потому что должен
 * переживать очистку кэша.
 */
export async function saveAvatar(bytes: Uint8Array, mime = 'image/jpeg'): Promise<string | null> {
  if (!(await ensureDirs())) {
    return null;
  }
  const hash = await hashImage(bytes);
  const rows = await selectRows<AvatarRow>('SELECT hash FROM avatars WHERE hash = $1', [hash]);
  const now = Date.now();
  if (rows[0]) {
    await executeSql('UPDATE avatars SET last_used_at = $2 WHERE hash = $1', [hash, now]);
    return hash;
  }
  const relative = `${AVATAR_DIR}/${hash}.${extensionFor(mime)}`;
  try {
    await writeFile(relative, bytes, { baseDir: BaseDirectory.AppData });
  } catch (error) {
    console.warn('[heliwatch] не удалось записать аватар', error);
    return null;
  }
  const saved = await executeSql(
    `INSERT INTO avatars (hash, path, size, last_used_at) VALUES ($1, $2, $3, $4)
     ON CONFLICT(hash) DO UPDATE SET last_used_at = excluded.last_used_at`,
    [hash, relative, bytes.byteLength, now],
  );
  if (!saved) {
    return hash;
  }
  await trimAvatars();
  return hash;
}

/** Байты аватара для отправки другу при встрече (этап 7). */
export async function readAvatarBytes(hash: string): Promise<Uint8Array | null> {
  if (!(await ensureDirs())) {
    return null;
  }
  const rows = await selectRows<AvatarRow>('SELECT path FROM avatars WHERE hash = $1', [hash]);
  const row = rows[0];
  if (!row) {
    return null;
  }
  try {
    return await readFile(row.path, { baseDir: BaseDirectory.AppData });
  } catch {
    return null;
  }
}

export async function avatarUrl(hash: string): Promise<string | null> {
  const cached = avatarUrls.get(hash);
  if (cached) {
    return cached;
  }
  if (!(await ensureDirs())) {
    return null;
  }
  const rows = await selectRows<AvatarRow>('SELECT path FROM avatars WHERE hash = $1', [hash]);
  const row = rows[0];
  if (!row) {
    return null;
  }
  try {
    const bytes = await readFile(row.path, { baseDir: BaseDirectory.AppData });
    const url = URL.createObjectURL(
      new Blob([bytes as unknown as BlobPart], { type: 'image/jpeg' }),
    );
    rememberUrl(avatarUrls, hash, url);
    await executeSql('UPDATE avatars SET last_used_at = $2 WHERE hash = $1', [
      hash,
      Date.now(),
    ]);
    return url;
  } catch {
    return null;
  }
}

/** LRU аватаров: не больше 50 файлов и 5 МБ. */
export async function trimAvatars(): Promise<number> {
  if (!(await ensureDirs())) {
    return 0;
  }
  const rows = await selectRows<{ hash: string; path: string; size: number }>(
    'SELECT hash, path, size FROM avatars ORDER BY last_used_at ASC',
  );
  let total = rows.reduce((sum, row) => sum + (Number(row.size) || 0), 0);
  let count = rows.length;
  let removed = 0;
  for (const row of rows) {
    if (count <= AVATAR_MAX_FILES && total <= AVATAR_MAX_BYTES) {
      break;
    }
    try {
      await remove(row.path, { baseDir: BaseDirectory.AppData });
    } catch {
      /* файла нет */
    }
    await executeSql('DELETE FROM avatars WHERE hash = $1', [row.hash]);
    total -= Number(row.size) || 0;
    count -= 1;
    removed += 1;
  }
  return removed;
}

/** Суммарный размер кэша фото — для экрана настроек. */
export async function mediaCacheSize(): Promise<{ bytes: number; files: number }> {
  const rows = await selectRows<{ size: number }>('SELECT size FROM media_cache');
  return {
    bytes: rows.reduce((sum, row) => sum + (Number(row.size) || 0), 0),
    files: rows.length,
  };
}

export async function clearMediaCache(): Promise<void> {
  if (!(await ensureDirs())) {
    return;
  }
  const rows = await selectRows<{ hash: string; path: string }>(
    'SELECT hash, path FROM media_cache',
  );
  for (const row of rows) {
    try {
      await remove(row.path, { baseDir: BaseDirectory.AppCache });
    } catch {
      /* файла нет */
    }
    const url = mediaUrls.get(row.hash);
    if (url) {
      URL.revokeObjectURL(url);
      mediaUrls.delete(row.hash);
    }
  }
  await executeSql('DELETE FROM media_cache');
  await executeSql('UPDATE dm_messages SET image_path = NULL');
  await executeSql('UPDATE room_chat SET image_path = NULL');
}
