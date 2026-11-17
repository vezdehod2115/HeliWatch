/*
 * Настройки: key/value с JSON. localStorage не используем — WebView может
 * почистить хранилище, а SQLite переживает перезапуск (правило §5 плана).
 */

import { executeSql, selectRows } from '../index';
import type { SettingRow } from '../migrations';

/** Ключи настроек (§5): этап 3 + этап 7. */
export const SETTINGS_KEYS = {
  /** Сохранять историю чата комнаты в SQLite (по умолчанию выключено). */
  chatHistory: 'chat.saveHistory',
  /** Приглушать звук видео, пока кто-то говорит (по умолчанию включено). */
  voiceDucking: 'voice.ducking',
  /** Недавние эмодзи — сверху панели. */
  emojiRecent: 'chat.emojiRecent',

  /** Динамический акцент из кадра видео (по умолчанию включён, §2.5). */
  accentEnabled: 'accent.enabled',
  /** Прозрачность панели чата поверх видео: 0.55…1. */
  chatOpacity: 'chat.opacity',
  /** Громкость голоса собеседников: 0…1. */
  voiceVolume: 'voice.volume',
  /** Свой TURN в JSON-виде (массив RTCIceServer из §4.8). */
  turnJson: 'net.turnJson',
  /** Только TURN: для отладки симметричного NAT. */
  turnOnly: 'net.turnOnly',
  /** Парная комната друзей (по умолчанию выключена, §4.8). */
  dmPairRoom: 'dm.pairRoom',
  /** PiP-автовход при уходе из приложения (по умолчанию включён, §2.4). */
  pipEnabled: 'pip.enabled',
  /** Best effort обход age-gate на YouTube (по умолчанию включён, этап 7). */
  ageGate: 'site.ageGate',
  /** Префикс отметок прочтения личных сообщений: `dm.lastRead.<userId>`. */
  dmReadPrefix: 'dm.lastRead.',
  /** Входящие заявки в друзья, ждущие решения (без сервера, §4.3). */
  friendPending: 'friend.pending',
} as const;

export async function readSetting<T>(key: string, fallback: T): Promise<T> {
  const rows = await selectRows<SettingRow>(
    'SELECT key, value_json FROM settings WHERE key = $1',
    [key],
  );
  const raw = rows[0]?.value_json;
  if (!raw) {
    return fallback;
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export async function writeSetting(key: string, value: unknown): Promise<boolean> {
  return executeSql(
    `INSERT INTO settings (key, value_json) VALUES ($1, $2)
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`,
    [key, JSON.stringify(value)],
  );
}

export async function readSettingsByPrefix(prefix: string): Promise<Record<string, unknown>> {
  const rows = await selectRows<SettingRow>(
    `SELECT key, value_json FROM settings WHERE key LIKE $1`,
    [`${prefix.replace(/[%_]/g, '')}%`],
  );
  const result: Record<string, unknown> = {};
  for (const row of rows) {
    try {
      result[row.key.slice(prefix.length)] = JSON.parse(row.value_json);
    } catch {
      /* битое значение пропускаем */
    }
  }
  return result;
}

export async function deleteSetting(key: string): Promise<boolean> {
  return executeSql('DELETE FROM settings WHERE key = $1', [key]);
}

/** Полный список настроек для бэкапа. */
export async function listSettings(): Promise<Array<{ key: string; value: unknown }>> {
  const rows = await selectRows<SettingRow>('SELECT key, value_json FROM settings ORDER BY key');
  const result: Array<{ key: string; value: unknown }> = [];
  for (const row of rows) {
    try {
      result.push({ key: row.key, value: JSON.parse(row.value_json) });
    } catch {
      /* битое значение не переносим */
    }
  }
  return result;
}

export async function writeSettingsBulk(
  entries: Array<{ key: string; value: unknown }>,
): Promise<void> {
  for (const entry of entries) {
    if (typeof entry.key !== 'string' || entry.key.length === 0 || entry.key.length > 128) {
      continue;
    }
    await writeSetting(entry.key, entry.value);
  }
}

export async function clearSettings(): Promise<boolean> {
  return executeSql('DELETE FROM settings');
}
