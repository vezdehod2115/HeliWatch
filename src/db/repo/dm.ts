/*
 * Личные сообщения (этап 7, §4.3, §5). Хранятся отдельно от `room_chat`:
 * чат комнаты и личка не должны смешиваться ни в типах, ни в запросах, ни в UI.
 *
 * `status` описывает исходящие: pending → sent (ушло в канал) → delivered
 * (получатель подтвердил `dm-ack`). Входящие сразу delivered: они уже здесь.
 */

import { executeSql, selectRows } from '../index';
import type { DmMessageRow } from '../migrations';

export type DmDir = 'in' | 'out';
export type DmKind = 'text' | 'image';
export type DmStatus = 'pending' | 'sent' | 'delivered';

export interface DmMessage {
  id: string;
  peerUserId: string;
  dir: DmDir;
  kind: DmKind;
  body: string;
  imagePath: string | null;
  ts: number;
  status: DmStatus;
  sig: string | null;
}

export interface DmConversation {
  peerUserId: string;
  last: DmMessage | null;
  unread: number;
}

const COLUMNS = `id, peer_user_id, dir, kind, body, image_path, ts, status, sig`;

function toMessage(row: DmMessageRow): DmMessage {
  return {
    id: row.id,
    peerUserId: row.peer_user_id,
    dir: row.dir === 'in' ? 'in' : 'out',
    kind: row.kind === 'image' ? 'image' : 'text',
    body: row.body,
    imagePath: row.image_path,
    ts: Number(row.ts) || 0,
    status:
      row.status === 'delivered' ? 'delivered' : row.status === 'pending' ? 'pending' : 'sent',
    sig: row.sig,
  };
}

/** Исходящее сообщение до отправки: pending, пока его не принял канал. */
export async function addOutgoingDm(message: {
  id: string;
  peerUserId: string;
  kind: DmKind;
  body: string;
  ts: number;
  sig?: string | null;
}): Promise<boolean> {
  return executeSql(
    `INSERT INTO dm_messages (id, peer_user_id, dir, kind, body, image_path, ts, status, sig)
     VALUES ($1, $2, 'out', $3, $4, NULL, $5, 'pending', $6)
     ON CONFLICT(id) DO NOTHING`,
    [message.id, message.peerUserId, message.kind, message.body, message.ts, message.sig ?? null],
  );
}

/** Входящее сообщение: повторная доставка из outbox не создаёт дубль. */
export async function addIncomingDm(message: {
  id: string;
  peerUserId: string;
  kind: DmKind;
  body: string;
  ts: number;
  sig?: string | null;
  imagePath?: string | null;
}): Promise<boolean> {
  return executeSql(
    `INSERT INTO dm_messages (id, peer_user_id, dir, kind, body, image_path, ts, status, sig)
     VALUES ($1, $2, 'in', $3, $4, $5, $6, 'delivered', $7)
     ON CONFLICT(id) DO NOTHING`,
    [
      message.id,
      message.peerUserId,
      message.kind,
      message.body,
      message.imagePath ?? null,
      message.ts,
      message.sig ?? null,
    ],
  );
}

export async function setDmStatus(id: string, status: DmStatus): Promise<boolean> {
  return executeSql('UPDATE dm_messages SET status = $2 WHERE id = $1', [id, status]);
}

export async function setDmImagePath(
  id: string,
  imagePath: string,
): Promise<boolean> {
  return executeSql('UPDATE dm_messages SET image_path = $2 WHERE id = $1', [id, imagePath]);
}

/**
 * Привязать пришедшее фото к сообщению. У входящего `dm-message` с картинкой
 * в `body` лежит imageId (в БД нет отдельной колонки), по нему и находим строку.
 */
export async function attachDmImage(imageId: string, imagePath: string): Promise<boolean> {
  return executeSql(
    `UPDATE dm_messages SET image_path = $2 WHERE kind = 'image' AND body = $1`,
    [imageId, imagePath],
  );
}

export async function listConversation(
  peerUserId: string,
  limit = 200,
): Promise<DmMessage[]> {
  const rows = await selectRows<DmMessageRow>(
    `SELECT ${COLUMNS} FROM dm_messages
     WHERE peer_user_id = $1
     ORDER BY ts DESC LIMIT $2`,
    [peerUserId, Math.max(1, Math.min(1000, limit))],
  );
  return rows.map(toMessage).reverse();
}

export async function listLastMessages(): Promise<Map<string, DmMessage>> {
  const rows = await selectRows<DmMessageRow>(
    `SELECT ${COLUMNS} FROM dm_messages AS m
     WHERE ts = (SELECT MAX(ts) FROM dm_messages WHERE peer_user_id = m.peer_user_id)`,
  );
  const result = new Map<string, DmMessage>();
  for (const row of rows) {
    const message = toMessage(row);
    const existing = result.get(message.peerUserId);
    if (!existing || existing.ts < message.ts) {
      result.set(message.peerUserId, message);
    }
  }
  return result;
}

/** Сколько входящих пришло после отметки прочтения (по каждому другу). */
export async function countUnread(readMarks: Record<string, number>): Promise<Record<string, number>> {
  const rows = await selectRows<{ peer_user_id: string; ts: number }>(
    `SELECT peer_user_id, ts FROM dm_messages WHERE dir = 'in'`,
  );
  const unread: Record<string, number> = {};
  for (const row of rows) {
    const mark = readMarks[row.peer_user_id] ?? 0;
    if (Number(row.ts) > mark) {
      unread[row.peer_user_id] = (unread[row.peer_user_id] ?? 0) + 1;
    }
  }
  return unread;
}

export async function listAllDmMessages(): Promise<DmMessage[]> {
  const rows = await selectRows<DmMessageRow>(
    `SELECT ${COLUMNS} FROM dm_messages ORDER BY ts ASC`,
  );
  return rows.map(toMessage);
}

export async function deleteDmMessage(id: string): Promise<boolean> {
  return executeSql('DELETE FROM dm_messages WHERE id = $1', [id]);
}

/** Импорт бэкапа: сообщение вставляется как есть, дубликаты пропускаются. */
export async function importDmMessage(message: DmMessage): Promise<boolean> {
  return executeSql(
    `INSERT INTO dm_messages (id, peer_user_id, dir, kind, body, image_path, ts, status, sig)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT(id) DO NOTHING`,
    [
      message.id,
      message.peerUserId,
      message.dir,
      message.kind,
      message.body,
      message.imagePath,
      message.ts,
      message.status,
      message.sig,
    ],
  );
}

export async function clearDmMessages(): Promise<boolean> {
  return executeSql('DELETE FROM dm_messages');
}
