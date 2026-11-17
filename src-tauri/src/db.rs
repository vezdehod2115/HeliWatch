//! Миграции SQLite для `@tauri-apps/plugin-sql`.
//!
//! Схема соответствует `src/db/migrations.ts` и §5 плана. Миграции живут в
//! Rust, чтобы применяться один раз при `Database.load()` на любом устройстве.
//! Этап 2 создал profile/keys/settings/recent_rooms, этап 3 добавляет room_chat
//! (история чата комнаты — только по желанию пользователя), этап 6 — blocklist
//! (локальный бан-лист хоста) и режим `stream` в recent_rooms. Таблицы друзей,
//! DM, сессий и статистики добавят следующие этапы отдельными версиями.

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
    ]
}
