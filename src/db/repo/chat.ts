/*
 * История чата комнаты (§5, `room_chat`).
 *
 * По умолчанию история НЕ пишется: правило «история — только по желанию».
 * Пользователь включает сохранение в панели чата, после чего сообщения комнаты
 * ложатся в SQLite и возвращаются при повторном входе в ту же комнату.
 * Фото в историю не попадают: они живут в памяти сессии до этапа 7 (LRU-кэш
 * файлов появится вместе с plugin-fs).
 */

import type { ChatMessage } from '../../net/protocol';
import { executeSql, selectRows } from '../index';
import type { RoomChatRow } from '../migrations';

export const CHAT_HISTORY_LIMIT = 300;

export interface StoredRoomMessage {
  id: string;
  roomCode: string;
  ts: number;
  from: string;
  kind: 'text' | 'image';
  body: string;
  imagePath: string | null;
}

export async function saveRoomMessage(
  roomCode: string,
  message: ChatMessage,
): Promise<boolean> {
  if (message.kind === 'image' && !message.text) {
    return false;
  }
  return executeSql(
    `INSERT INTO room_chat (id, room_code, ts, from_user_id, kind, body, image_path, saved)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 1)
     ON CONFLICT(id) DO UPDATE SET body = excluded.body, saved = 1`,
    [
      message.id,
      roomCode,
      message.ts,
      message.from,
      message.kind,
      message.text ?? '',
      null,
    ],
  );
}

export async function listRoomMessages(
  roomCode: string,
  limit: number = CHAT_HISTORY_LIMIT,
): Promise<StoredRoomMessage[]> {
  const rows = await selectRows<RoomChatRow>(
    `SELECT id, room_code, ts, from_user_id, kind, body, image_path, saved
       FROM room_chat
      WHERE room_code = $1
      ORDER BY ts DESC
      LIMIT $2`,
    [roomCode, Math.max(1, Math.min(CHAT_HISTORY_LIMIT, limit))],
  );
  // В базе берём последние N, в чат отдаём в хронологическом порядке.
  return rows
    .filter((row) => row.id && row.room_code)
    .map((row) => ({
      id: row.id,
      roomCode: row.room_code,
      ts: Number(row.ts),
      from: row.from_user_id,
      kind: row.kind === 'image' ? ('image' as const) : ('text' as const),
      body: row.body ?? '',
      imagePath: row.image_path ?? null,
    }))
    .sort((left, right) => left.ts - right.ts);
}

export async function clearRoomMessages(roomCode: string): Promise<boolean> {
  return executeSql('DELETE FROM room_chat WHERE room_code = $1', [roomCode]);
}

export async function countRoomMessages(roomCode: string): Promise<number> {
  const rows = await selectRows<{ total: number }>(
    'SELECT COUNT(*) AS total FROM room_chat WHERE room_code = $1',
    [roomCode],
  );
  return Number(rows[0]?.total ?? 0);
}

/** Старые записи чистим при старте: держим не больше 30 последних комнат. */
export async function trimRoomChat(keepRooms = 30): Promise<boolean> {
  return executeSql(
    `DELETE FROM room_chat WHERE room_code NOT IN (
       SELECT room_code FROM room_chat GROUP BY room_code
        ORDER BY MAX(ts) DESC LIMIT $1
     )`,
    [keepRooms],
  );
}
