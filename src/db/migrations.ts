/*
 * Схема локальной БД HeliWatch (SQLite через @tauri-apps/plugin-sql).
 *
 * Сами миграции выполняются в Rust (`src-tauri/src/db.rs`) при `Database.load`,
 * а этот файл — единственное место, где описаны имена таблиц, колонок и типы
 * строк для TypeScript. Дублировать SQL здесь нельзя: источник истины — Rust.
 */

export const DB_URL = 'sqlite:heliwatch.db';
export const SCHEMA_VERSION = 1;

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
