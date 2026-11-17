/*
 * Схема локальной БД HeliWatch (SQLite через @tauri-apps/plugin-sql).
 *
 * Сами миграции выполняются в Rust (`src-tauri/src/db.rs`) при `Database.load`,
 * а этот файл — единственное место, где описаны имена таблиц, колонок и типы
 * строк для TypeScript. Дублировать SQL здесь нельзя: источник истины — Rust.
 */

export const DB_URL = 'sqlite:heliwatch.db';
export const SCHEMA_VERSION = 4;

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

/** Друг (этап 7): взаимное подтверждение, последняя встреча, блокировка. */
export interface FriendRow {
  user_id: string;
  display_name: string;
  name_color: string;
  avatar_hash: string | null;
  added_at: number;
  last_meet_at: number | null;
  blocked: number;
}

/** Личное сообщение (§4.3, этап 7). Отдельно от `room_chat`. */
export interface DmMessageRow {
  id: string;
  peer_user_id: string;
  dir: 'in' | 'out';
  kind: 'text' | 'image';
  body: string;
  image_path: string | null;
  ts: number;
  status: 'pending' | 'sent' | 'delivered';
  sig: string | null;
}

/** Очередь недоставленного: friend-*, dm-message, dm-ack (§4.3, этап 7). */
export interface OutboxRow {
  id: string;
  to_user_id: string;
  payload_json: string;
  sig: string | null;
  created_at: number;
  attempts: number;
  next_attempt_at: number;
  status: 'pending' | 'sent' | 'delivered';
}

/** Сессия комнаты (§5): устойчивость к крашам через heartbeat. */
export interface SessionRow {
  id: string;
  room_code: string;
  mode: string;
  started_at: number;
  ended_at: number | null;
  last_heartbeat: number;
  end_reason: string | null;
  peers_json: string;
  host_user_id: string | null;
}

/** Статистика встреч с другом по дням (§5). */
export interface PeerStatsRow {
  peer_user_id: string;
  day: string;
  sessions: number;
  seconds_total: number;
  seconds_voice: number;
  seconds_watch: number;
  modes_json: string;
  last_meet_at: number;
}

/** Аватар в файловом кэше: LRU 50 файлов / 5 МБ (§4.7, этап 7). */
export interface AvatarRow {
  hash: string;
  path: string;
  size: number;
  last_used_at: number;
}

/**
 * Файловый кэш фото (LRU 200 МБ, §4.7). Таблица — индекс кэша: сами файлы
 * лежат в app-cache, а здесь только путь, размер и время последнего чтения.
 */
export interface MediaCacheRow {
  hash: string;
  path: string;
  size: number;
  mime: string;
  w: number;
  h: number;
  last_used_at: number;
}
