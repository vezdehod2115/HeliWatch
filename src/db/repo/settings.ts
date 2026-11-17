/*
 * Настройки: key/value с JSON. localStorage не используем — WebView может
 * почистить хранилище, а SQLite переживает перезапуск (правило §5 плана).
 */

import { executeSql, selectRows } from '../index';
import type { SettingRow } from '../migrations';

/** Ключи настроек этапа 3 (§5, `settings`). */
export const SETTINGS_KEYS = {
  /** Сохранять историю чата комнаты в SQLite (по умолчанию выключено). */
  chatHistory: 'chat.saveHistory',
  /** Приглушать звук видео, пока кто-то говорит (по умолчанию включено). */
  voiceDucking: 'voice.ducking',
  /** Недавние эмодзи — сверху панели. */
  emojiRecent: 'chat.emojiRecent',
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
