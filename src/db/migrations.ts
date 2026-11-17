/*
 * Схема локальной БД HeliWatch (SQLite через @tauri-apps/plugin-sql).
 *
 * Сами миграции выполняются в Rust (`src-tauri/src/db.rs`) при `Database.load`,
 * а этот файл — единственное место, где описаны имена таблиц, колонок и типы
 * строк для TypeScript. Дублировать SQL здесь нельзя: источник истины — Rust.
 */

export const DB_URL = 'sqlite:heliwatch.db';
export const SCHEMA_VERSION = 3;

export interface ProfileRow {
  id: number;
  user_id: string;
  display_name: string;
  name_color: string;
  avatar_hash: string | null;
  created_at: number;
}

export interface KeysRow {
  id: number;
  public_jwk: string;
  private_jwk: string;
  created_at: number;
}

export interface SettingRow {
  key: string;
  value_json: string;
}

export interface RecentRoomRow {
  code: string;
  mode: string;
  last_join_at: number;
}

/** История чата комнаты (этап 3, §5): пишется только по желанию. */
export interface RoomChatRow {
  id: string;
  room_code: string;
  ts: number;
  from_user_id: string;
  kind: string;
  body: string;
  image_path: string | null;
  saved: number;
}

/**
 * Локальный бан-лист хоста (этап 6, §5). `expires_at = 0` — навсегда,
 * иначе timestamp окончания. Гость тоже пишет сюда того, кто его забанил,
 * чтобы случайно не вернуться.
 */
export interface BlocklistRow {
  user_id: string;
  reason: string;
  created_at: number;
  expires_at: number;
}
