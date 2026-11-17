/*
 * Бэкап (этап 7, §5): один JSON-файл `heliwatch-backup-YYYYMMDD-HHmm.json`.
 *
 * Формат: `{format:"heliwatch-backup", schema:1, app, exportedAt, checksum,
 * profile, identity|null, friends, blocklist, dm_messages, sessions,
 * peer_stats, settings, media?}`. Медиа по умолчанию не включается: фото
 * лежат в файловом кэше и в бэкап не попадают (в §5 поле `media` опционально).
 *
 * Файл выбирается нативным диалогом (SAF на Android возвращает `content://`),
 * а пишет/читает `plugin-fs`: на Android он разрешает content-URI через
 * ContentResolver, на desktop — обычный путь. Диалог добавляет выбранный файл
 * в scope, поэтому прав на весь диск не нужно.
 */

import { open, save } from '@tauri-apps/plugin-dialog';
import { readTextFile, writeTextFile } from '@tauri-apps/plugin-fs';
import {
  BACKUP_SCHEMA,
  BACKUP_FORMAT,
  backupChecksum,
  isBackupFile,
  type BackupFile,
  type BackupIdentity,
  type BackupPayload,
  type BackupProfile,
} from './backupFormat';
import { readProfile, saveProfile } from './repo/profile';
import { readKeys, saveKeys } from './repo/keys';
import { listFriends, importFriend, clearFriends } from './repo/friends';
import { listAllBlocks, importBlockEntry, clearBlocks } from './repo/blocklist';
import {
  listAllDmMessages,
  importDmMessage,
  clearDmMessages,
} from './repo/dm';
import {
  listAllSessions,
  importSession,
  listPeerStats,
  importPeerStats,
  clearSessions,
  clearPeerStats,
} from './repo/stats';
import {
  listSettings,
  writeSettingsBulk,
  clearSettings,
} from './repo/settings';
import { isNativeRuntime } from '../native/nativeBridge';
import { identityFromStored } from '../net/identity';

export const BACKUP_APP_VERSION =
  typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.0.0';

export type BackupMode = 'merge' | 'replace';

export interface BackupExportOptions {
  includeIdentity: boolean;
  includeMedia?: boolean;
}

export interface BackupResult {
  ok: boolean;
  cancelled?: boolean;
  path?: string;
  error?: string;
  stats?: BackupRestoreStats;
}

export interface BackupRestoreStats {
  friends: number;
  messages: number;
  sessions: number;
  settings: number;
  identity: boolean;
}

/** Имя файла по §5: `heliwatch-backup-YYYYMMDD-HHmm.json`. */
export function backupFileName(at = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `heliwatch-backup-${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(
    at.getDate(),
  )}-${pad(at.getHours())}${pad(at.getMinutes())}.json`;
}

/** Собрать бэкап из локальной БД (без записи файла). */
export async function buildBackupPayload(
  options: BackupExportOptions,
): Promise<BackupPayload> {
  const [profileRow, keysRow, friends, blocklist, dmMessages, sessions, peerStats, settings] =
    await Promise.all([
      readProfile(),
      options.includeIdentity ? readKeys() : Promise.resolve(null),
      listFriends(true),
      listAllBlocks(),
      listAllDmMessages(),
      listAllSessions(),
      listPeerStats(),
      listSettings(),
    ]);

  const profile: BackupProfile | null = profileRow
    ? {
        userId: profileRow.user_id,
        displayName: profileRow.display_name,
        nameColor: profileRow.name_color,
        avatarHash: profileRow.avatar_hash,
        createdAt: Number(profileRow.created_at) || 0,
      }
    : null;

  let identity: BackupIdentity | null = null;
  if (options.includeIdentity && keysRow) {
    try {
      identity = {
        publicJwk: JSON.parse(keysRow.public_jwk) as JsonWebKey,
        privateJwk: JSON.parse(keysRow.private_jwk) as JsonWebKey,
        createdAt: Number(keysRow.created_at) || 0,
      };
    } catch {
      identity = null;
    }
  }

  const payload: BackupPayload = {
    format: BACKUP_FORMAT,
    schema: BACKUP_SCHEMA,
    app: BACKUP_APP_VERSION,
    exportedAt: Date.now(),
    profile,
    identity,
    friends: friends.map((friend) => ({
      userId: friend.userId,
      displayName: friend.displayName,
      nameColor: friend.nameColor,
      avatarHash: friend.avatarHash,
      addedAt: friend.addedAt,
      lastMeetAt: friend.lastMeetAt,
      blocked: friend.blocked,
    })),
    blocklist,
    dmMessages,
    sessions,
    peerStats,
    settings,
  };
  return payload;
}

/** Полный файл: данные + контрольная сумма. */
export async function buildBackupFile(
  options: BackupExportOptions,
): Promise<BackupFile> {
  const payload = await buildBackupPayload(options);
  return { ...payload, checksum: await backupChecksum(payload) };
}

/**
 * Экспорт: диалог сохранения → Rust-команда записи. Возвращает путь, чтобы UI
 * показал, куда сохранилось.
 */
export async function exportBackup(options: BackupExportOptions): Promise<BackupResult> {
  if (!isNativeRuntime()) {
    return {
      ok: false,
      error: 'Экспорт доступен в приложении: в браузере нет системного диалога',
    };
  }
  try {
    const file = await buildBackupFile(options);
    const contents = JSON.stringify(file, null, 2);
    const path = await save({
      defaultPath: backupFileName(),
      filters: [{ name: 'HeliWatch backup', extensions: ['json'] }],
    });
    if (!path) {
      return { ok: false, cancelled: true };
    }
    await writeTextFile(path, contents);
    return { ok: true, path };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Импорт: выбор файла → проверка формата/схемы/checksum → запись по режиму. */
export async function importBackup(mode: BackupMode): Promise<BackupResult> {
  if (!isNativeRuntime()) {
    return {
      ok: false,
      error: 'Импорт доступен в приложении: в браузере нет системного диалога',
    };
  }
  try {
    const selected = await open({
      multiple: false,
      directory: false,
      filters: [{ name: 'HeliWatch backup', extensions: ['json'] }],
    });
    if (!selected || Array.isArray(selected)) {
      return { ok: false, cancelled: true };
    }
    const text = await readTextFile(selected);
    const parsed = await parseBackupText(text);
    if (!parsed.ok) {
      return { ok: false, error: parsed.error };
    }
    const stats = await restoreBackup(parsed.file, mode);
    return { ok: true, path: selected, stats };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function parseBackupText(
  text: string,
): Promise<{ ok: true; file: BackupFile } | { ok: false; error: string }> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, error: 'Это не JSON-файл бэкапа' };
  }
  if (!isBackupFile(value)) {
    return {
      ok: false,
      error: 'Не бэкап HeliWatch: нужен format=heliwatch-backup и schema=1',
    };
  }
  const { checksum, ...payload } = value;
  const expected = await backupChecksum(payload as BackupPayload);
  if (checksum !== expected) {
    return { ok: false, error: 'Контрольная сумма не совпала: файл повреждён' };
  }
  return { ok: true, file: value };
}

/**
 * Записать бэкап в БД. `merge` не затирает локальные данные (друзья, DM и
 * сессии добавляются, настройки — только недостающие ключи); `replace`
 * заменяет таблицы целиком, включая идентичность, если она есть в файле.
 */
export async function restoreBackup(
  file: BackupFile,
  mode: BackupMode,
): Promise<BackupRestoreStats> {
  const stats: BackupRestoreStats = {
    friends: 0,
    messages: 0,
    sessions: 0,
    settings: 0,
    identity: false,
  };

  if (mode === 'replace') {
    await Promise.all([clearFriends(), clearBlocks(), clearDmMessages(), clearSessions(), clearPeerStats()]);
  }

  for (const friend of file.friends) {
    if (await importFriend(friend)) {
      stats.friends += 1;
    }
  }
  for (const entry of file.blocklist) {
    await importBlockEntry(entry);
  }
  for (const message of file.dmMessages) {
    if (await importDmMessage(message)) {
      stats.messages += 1;
    }
  }
  for (const session of file.sessions) {
    if (await importSession(session)) {
      stats.sessions += 1;
    }
  }
  await importPeerStats(file.peerStats);

  if (mode === 'replace') {
    await clearSettings();
    await writeSettingsBulk(file.settings);
    stats.settings = file.settings.length;
  } else {
    const local = new Set((await listSettings()).map((entry) => entry.key));
    const missing = file.settings.filter((entry) => !local.has(entry.key));
    await writeSettingsBulk(missing);
    stats.settings = missing.length;
  }

  // Идентичность переносим только вместе с полной заменой: смена ключа
  // делает старых друзей и переписку «чужими». Дополнительно проверяем, что
  // приватный ключ действительно даёт userId из профиля — иначе бэкап
  // восстановил бы «профиль без личности».
  if (mode === 'replace' && file.identity && file.profile) {
    let derivedUserId = '';
    try {
      const identity = await identityFromStored(
        file.identity.publicJwk,
        file.identity.privateJwk,
        file.identity.createdAt,
      );
      derivedUserId = identity.userId;
    } catch {
      derivedUserId = '';
    }
    if (derivedUserId === file.profile.userId) {
      const savedKeys = await saveKeys(
        JSON.stringify(file.identity.publicJwk),
        JSON.stringify(file.identity.privateJwk),
        file.identity.createdAt,
      );
      const savedProfile = await saveProfile({
        userId: file.profile.userId,
        displayName: file.profile.displayName,
        nameColor: file.profile.nameColor,
        avatarHash: file.profile.avatarHash,
        createdAt: file.profile.createdAt,
      });
      stats.identity = savedKeys && savedProfile;
    }
  }

  return stats;
}
