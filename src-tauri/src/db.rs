//! Миграции SQLite для `@tauri-apps/plugin-sql`.
//!
//! Схема соответствует `src/db/migrations.ts` и §5 плана. Миграции живут в
//! Rust, чтобы применяться один раз при `Database.load()` на любом устройстве.
//! Этап 2 создал profile/keys/settings/recent_rooms, этап 3 добавляет room_chat
//! (история чата комнаты — только по желанию пользователя), этап 6 — blocklist
//! (локальный бан-лист хоста) и режим `stream` в recent_rooms. Этап 7 добавляет
//! друзей, личные сообщения, outbox, сессии/статистику, аватары и файловый
//! кэш фото (LRU 200 МБ).

use tauri_plugin_sql::{Migration, MigrationKind};

pub const DB_URL: &str = "sqlite:heliwatch.db";

pub fn migrations() -> Vec<Migration> {
    vec![
        Migration {
            version: 1,
            description: "profile, keys, settings, recent_rooms",
            sql: r#"
CREATE TABLE IF NOT EXISTS profile (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    user_id TEXT NOT NULL,
    display_name TEXT NOT NULL,
    name_color TEXT NOT NULL DEFAULT '#6ff0c4',
    avatar_hash TEXT,
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS keys (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    public_jwk TEXT NOT NULL,
    private_jwk TEXT NOT NULL,
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS recent_rooms (
    code TEXT PRIMARY KEY,
    mode TEXT NOT NULL CHECK (mode IN ('site', 'local')),
    last_join_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_recent_rooms_at ON recent_rooms (last_join_at DESC);
"#,
            kind: MigrationKind::Up,
        },
        Migration {
            version: 2,
            description: "room_chat — история чата комнаты (по желанию)",
            sql: r#"
CREATE TABLE IF NOT EXISTS room_chat (
    id TEXT PRIMARY KEY,
    room_code TEXT NOT NULL,
    ts INTEGER NOT NULL,
    from_user_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('text', 'image')),
    body TEXT NOT NULL DEFAULT '',
    image_path TEXT,
    saved INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_room_chat_room_ts ON room_chat (room_code, ts);
CREATE INDEX IF NOT EXISTS idx_room_chat_ts ON room_chat (ts);
"#,
            kind: MigrationKind::Up,
        },
        Migration {
            version: 3,
            description: "blocklist, recent_rooms с режимом stream (этап 6)",
            sql: r#"
CREATE TABLE IF NOT EXISTS blocklist (
    user_id TEXT PRIMARY KEY,
    reason TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_blocklist_expires ON blocklist (expires_at);

CREATE TABLE recent_rooms_v3 (
    code TEXT PRIMARY KEY,
    mode TEXT NOT NULL CHECK (mode IN ('site', 'local', 'stream')),
    last_join_at INTEGER NOT NULL
);

INSERT OR IGNORE INTO recent_rooms_v3 (code, mode, last_join_at)
    SELECT code, mode, last_join_at FROM recent_rooms;

DROP TABLE recent_rooms;

ALTER TABLE recent_rooms_v3 RENAME TO recent_rooms;

CREATE INDEX IF NOT EXISTS idx_recent_rooms_at ON recent_rooms (last_join_at DESC);
"#,
            kind: MigrationKind::Up,
        },
        Migration {
            version: 4,
            description: "друзья, DM, outbox, сессии, статистика, аватары, кэш фото (этап 7)",
            sql: r#"
CREATE TABLE IF NOT EXISTS friends (
    user_id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    name_color TEXT NOT NULL DEFAULT '#6ff0c4',
    avatar_hash TEXT,
    added_at INTEGER NOT NULL,
    last_meet_at INTEGER,
    blocked INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_friends_added ON friends (added_at DESC);

CREATE TABLE IF NOT EXISTS dm_messages (
    id TEXT PRIMARY KEY,
    peer_user_id TEXT NOT NULL,
    dir TEXT NOT NULL CHECK (dir IN ('in', 'out')),
    kind TEXT NOT NULL CHECK (kind IN ('text', 'image')),
    body TEXT NOT NULL DEFAULT '',
    image_path TEXT,
    ts INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'sent' CHECK (status IN ('pending', 'sent', 'delivered')),
    sig TEXT
);

CREATE INDEX IF NOT EXISTS idx_dm_peer_ts ON dm_messages (peer_user_id, ts);
CREATE INDEX IF NOT EXISTS idx_dm_ts ON dm_messages (ts);

CREATE TABLE IF NOT EXISTS outbox (
    id TEXT PRIMARY KEY,
    to_user_id TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    sig TEXT,
    created_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'delivered'))
);

CREATE INDEX IF NOT EXISTS idx_outbox_due ON outbox (status, next_attempt_at);

CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    room_code TEXT NOT NULL,
    mode TEXT NOT NULL CHECK (mode IN ('site', 'local', 'stream')),
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    last_heartbeat INTEGER NOT NULL,
    end_reason TEXT CHECK (end_reason IN ('left', 'host-left', 'timeout', 'kick', 'banned', 'closed', 'error')),
    peers_json TEXT NOT NULL DEFAULT '[]',
    host_user_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_sessions_started ON sessions (started_at DESC);

CREATE TABLE IF NOT EXISTS peer_stats (
    peer_user_id TEXT NOT NULL,
    day TEXT NOT NULL,
    sessions INTEGER NOT NULL DEFAULT 0,
    seconds_total INTEGER NOT NULL DEFAULT 0,
    seconds_voice INTEGER NOT NULL DEFAULT 0,
    seconds_watch INTEGER NOT NULL DEFAULT 0,
    modes_json TEXT NOT NULL DEFAULT '{}',
    last_meet_at INTEGER NOT NULL,
    PRIMARY KEY (peer_user_id, day)
);

CREATE TABLE IF NOT EXISTS avatars (
    hash TEXT PRIMARY KEY,
    path TEXT NOT NULL,
    size INTEGER NOT NULL,
    last_used_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_avatars_used ON avatars (last_used_at);

CREATE TABLE IF NOT EXISTS media_cache (
    hash TEXT PRIMARY KEY,
    path TEXT NOT NULL,
    size INTEGER NOT NULL,
    mime TEXT NOT NULL DEFAULT 'image/jpeg',
    w INTEGER NOT NULL DEFAULT 0,
    h INTEGER NOT NULL DEFAULT 0,
    last_used_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_media_used ON media_cache (last_used_at);
"#,
            kind: MigrationKind::Up,
        },
    ]
}
