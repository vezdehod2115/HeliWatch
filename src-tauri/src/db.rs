//! Миграции SQLite для `@tauri-apps/plugin-sql`.
//!
//! Схема соответствует `src/db/migrations.ts` и §5 плана. Миграции живут в
//! Rust, чтобы применяться один раз при `Database.load()` на любом устройстве.
//! Этап 2 создал profile/keys/settings/recent_rooms, этап 3 добавляет room_chat
//! (история чата комнаты — только по желанию пользователя). Таблицы друзей,
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
    ]
}
