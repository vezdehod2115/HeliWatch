/*
 * Outbox (этап 7, §4.3): недоставленные friend-* и dm-message ждут встречи.
 *
 * Сервера нет, поэтому «отправить» = положить подписанный конверт в SQLite и
 * попробовать передать его при любом живом канале (комната, парная комната,
 * инвайт-комната). Получатель отвечает `dm-ack`, и только тогда запись
 * помечается delivered. Повторы — с экспоненциальной паузой.
 */

import { executeSql, selectRows } from '../index';
import type { OutboxRow } from '../migrations';

export type OutboxStatus = 'pending' | 'sent' | 'delivered';

export interface OutboxEntry {
  id: string;
  toUserId: string;
  payloadJson: string;
  sig: string | null;
  createdAt: number;
  attempts: number;
  nextAttemptAt: number;
  status: OutboxStatus;
}

/** Пауза до следующей попытки: 30 с → 2 мин → 5 мин → 15 мин → 60 мин. */
const BACKOFF_MS = [30_000, 120_000, 300_000, 900_000, 3_600_000];

export function outboxBackoffMs(attempts: number): number {
  const index = Math.min(BACKOFF_MS.length - 1, Math.max(0, attempts - 1));
  return BACKOFF_MS[index] ?? BACKOFF_MS[0]!;
}

const COLUMNS = `id, to_user_id, payload_json, sig, created_at, attempts, next_attempt_at, status`;

function toEntry(row: OutboxRow): OutboxEntry {
  return {
    id: row.id,
    toUserId: row.to_user_id,
    payloadJson: row.payload_json,
    sig: row.sig,
    createdAt: Number(row.created_at) || 0,
    attempts: Number(row.attempts) || 0,
    nextAttemptAt: Number(row.next_attempt_at) || 0,
    status:
      row.status === 'delivered' ? 'delivered' : row.status === 'sent' ? 'sent' : 'pending',
  };
}

export async function enqueueOutbox(entry: {
  id: string;
  toUserId: string;
  payload: unknown;
  sig?: string | null;
  createdAt?: number;
}): Promise<boolean> {
  return executeSql(
    `INSERT INTO outbox (id, to_user_id, payload_json, sig, created_at, attempts, next_attempt_at, status)
     VALUES ($1, $2, $3, $4, $5, 0, 0, 'pending')
     ON CONFLICT(id) DO NOTHING`,
    [
      entry.id,
      entry.toUserId,
      JSON.stringify(entry.payload),
      entry.sig ?? null,
      entry.createdAt ?? Date.now(),
    ],
  );
}

/** Всё, что пора отправить: pending и sent (без ack) с наступившим сроком. */
export async function listDueOutbox(
  now = Date.now(),
  limit = 64,
): Promise<OutboxEntry[]> {
  const rows = await selectRows<OutboxRow>(
    `SELECT ${COLUMNS} FROM outbox
     WHERE status != 'delivered' AND next_attempt_at <= $1
     ORDER BY created_at ASC LIMIT $2`,
    [now, Math.max(1, Math.min(200, limit))],
  );
  return rows.map(toEntry);
}

export async function listOutboxForPeer(userId: string): Promise<OutboxEntry[]> {
  const rows = await selectRows<OutboxRow>(
    `SELECT ${COLUMNS} FROM outbox
     WHERE to_user_id = $1 AND status != 'delivered'
     ORDER BY created_at ASC`,
    [userId],
  );
  return rows.map(toEntry);
}

export async function listAllOutbox(): Promise<OutboxEntry[]> {
  const rows = await selectRows<OutboxRow>(
    `SELECT ${COLUMNS} FROM outbox ORDER BY created_at ASC`,
  );
  return rows.map(toEntry);
}

export async function countOutbox(): Promise<number> {
  const rows = await selectRows<{ count: number }>(
    `SELECT COUNT(*) AS count FROM outbox WHERE status != 'delivered'`,
  );
  return Number(rows[0]?.count ?? 0);
}

/**
 * Конверт ушёл в канал: ждём `dm-ack`. Повторная попытка — только после
 * `nextAttemptAt`: без этого flush на каждом событии забивал бы канал копиями.
 */
export async function markOutboxSent(
  id: string,
  nextAttemptAt = Date.now() + 60_000,
): Promise<boolean> {
  return executeSql(
    `UPDATE outbox SET status = 'sent', next_attempt_at = $2
     WHERE id = $1 AND status != 'delivered'`,
    [id, nextAttemptAt],
  );
}

/**
 * Ack приходит по `msgId` из `dm-message`, а id записи outbox — это id
 * конверта. Находим строку по полю payload, чтобы доставка закрывалась точно.
 */
export async function markOutboxDeliveredByMessageId(msgId: string): Promise<boolean> {
  if (!/^[A-Za-z0-9]{10,64}$/.test(msgId)) {
    return false;
  }
  return executeSql(
    `UPDATE outbox SET status = 'delivered'
     WHERE status != 'delivered' AND payload_json LIKE $1`,
    [`%"msgId":"${msgId}"%`],
  );
}

export async function markOutboxDelivered(id: string): Promise<boolean> {
  return executeSql(`UPDATE outbox SET status = 'delivered' WHERE id = $1`, [id]);
}

/** Попытка не удалась (или получатель не ответил): считаем и откладываем. */
export async function bumpOutboxAttempt(
  id: string,
  now = Date.now(),
): Promise<boolean> {
  const rows = await selectRows<{ attempts: number }>(
    'SELECT attempts FROM outbox WHERE id = $1',
    [id],
  );
  const row = rows[0];
  if (!row) {
    return false;
  }
  const attempts = Number(row.attempts) + 1;
  return executeSql(
    `UPDATE outbox SET attempts = $2, next_attempt_at = $3, status = 'pending'
     WHERE id = $1`,
    [id, attempts, now + outboxBackoffMs(attempts)],
  );
}

export async function deleteOutbox(id: string): Promise<boolean> {
  return executeSql('DELETE FROM outbox WHERE id = $1', [id]);
}

export async function importOutboxEntry(entry: OutboxEntry): Promise<boolean> {
  return executeSql(
    `INSERT INTO outbox (id, to_user_id, payload_json, sig, created_at, attempts, next_attempt_at, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT(id) DO NOTHING`,
    [
      entry.id,
      entry.toUserId,
      entry.payloadJson,
      entry.sig,
      entry.createdAt,
      entry.attempts,
      entry.nextAttemptAt,
      entry.status,
    ],
  );
}

/** Доставленное храним сутки: нужно для диагностики и порядка в очереди. */
export async function pruneOutbox(now = Date.now()): Promise<boolean> {
  return executeSql(
    `DELETE FROM outbox WHERE status = 'delivered' AND created_at < $1`,
    [now - 24 * 60 * 60 * 1000],
  );
}

export async function clearOutbox(): Promise<boolean> {
  return executeSql('DELETE FROM outbox');
}
