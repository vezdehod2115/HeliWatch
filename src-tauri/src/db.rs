//! Миграции SQLite для `@tauri-apps/plugin-sql`.
//!
//! Схема соответствует `src/db/migrations.ts` и §5 плана. Миграции живут в
//! Rust, чтобы применяться один раз при `Database.load()` на любом устройстве.
//! Этап 2 создаёт только profile/keys/settings/recent_rooms; таблицы друзей,
//! DM, сессий и статистики добавят следующие этапы отдельными версиями.

use tauri_plugin_sql::{Migration, MigrationKind};

pub const DB_URL: &str = "sqlite:heliwatch.db";

pub fn migrations() -> Vec<Migration> {
    vec![Migration {
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
    }]
}
