/*
 * Локальный бан-лист (§5, этап 6): хост банит участника, гость запоминает того,
 * кто его забанил. Сервера нет, поэтому бан живёт только на устройстве.
 *
 * `expires_at = 0` — навсегда. Бан «на сессию» получает конкретный timestamp:
 * конца комнаты заранее не знает никто, поэтому практическая замена сессии —
 * сутки; после них запись сама перестаёт действовать и вычищается.
 */

import { executeSql, selectRows } from '../index';
import type { BlocklistRow } from '../migrations';

/** «Бан на сессию»: сутки — разумная замена неизвестному концу комнаты. */
export const BAN_SESSION_MS = 24 * 60 * 60 * 1000;
/** Навсегда: expires_at = 0. */
export const BAN_FOREVER = 0;

export type BanScope = 'session' | 'forever';

export interface BlockEntry {
  userId: string;
  reason: string;
  createdAt: number;
  /** 0 — навсегда. */
  expiresAt: number;
}

/** Когда истекает бан выбранного вида. */
export function banExpiry(scope: BanScope, now: number = Date.now()): number {
  return scope === 'forever' ? BAN_FOREVER : now + BAN_SESSION_MS;
}

export function isBanActive(entry: BlockEntry, now: number = Date.now()): boolean {
  return entry.expiresAt === BAN_FOREVER || entry.expiresAt > now;
}

export async function blockUser(
  userId: string,
  reason: string,
  scope: BanScope = 'session',
  now: number = Date.now(),
): Promise<boolean> {
  if (!userId) {
    return false;
  }
  return executeSql(
    `INSERT INTO blocklist (user_id, reason, created_at, expires_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT(user_id) DO UPDATE SET
       reason = excluded.reason,
       created_at = excluded.created_at,
       expires_at = excluded.expires_at`,
    [userId, reason.slice(0, 200), now, banExpiry(scope, now)],
  );
}

export async function unblockUser(userId: string): Promise<boolean> {
  return executeSql('DELETE FROM blocklist WHERE user_id = $1', [userId]);
}

/** Действующие записи: вечные + те, чей срок ещё не вышел. */
export async function listBlocks(now: number = Date.now()): Promise<BlockEntry[]> {
  const rows = await selectRows<BlocklistRow>(
    `SELECT user_id, reason, created_at, expires_at
     FROM blocklist
     WHERE expires_at = 0 OR expires_at > $1
     ORDER BY created_at DESC`,
    [now],
  );
  return rows.map((row) => ({
    userId: row.user_id,
    reason: row.reason ?? '',
    createdAt: Number(row.created_at),
    expiresAt: Number(row.expires_at),
  }));
}

export async function isBlocked(userId: string, now: number = Date.now()): Promise<boolean> {
  if (!userId) {
    return false;
  }
  const rows = await selectRows<{ user_id: string }>(
    `SELECT user_id FROM blocklist
     WHERE user_id = $1 AND (expires_at = 0 OR expires_at > $2)
     LIMIT 1`,
    [userId, now],
  );
  return rows.length > 0;
}

/** Чистка истёкших записей; вызывается при входе в комнату/лобби. */
export async function pruneBlocks(now: number = Date.now()): Promise<boolean> {
  return executeSql('DELETE FROM blocklist WHERE expires_at != 0 AND expires_at <= $1', [
    now,
  ]);
}
