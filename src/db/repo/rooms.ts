/*
 * Недавние комнаты: код + режим + время. Нужны для возврата в комнату после
 * выхода и для быстрого входа по ссылке.
 */

import type { RoomMode } from '../../net/protocol';
import { executeSql, selectRows } from '../index';
import type { RecentRoomRow } from '../migrations';

export interface RecentRoom {
  code: string;
  mode: RoomMode;
  lastJoinAt: number;
}

export async function touchRecentRoom(
  code: string,
  mode: RoomMode,
  now: number = Date.now(),
): Promise<boolean> {
  return executeSql(
    `INSERT INTO recent_rooms (code, mode, last_join_at) VALUES ($1, $2, $3)
     ON CONFLICT(code) DO UPDATE SET
       mode = excluded.mode,
       last_join_at = excluded.last_join_at`,
    [code, mode, now],
  );
}

export async function listRecentRooms(limit = 5): Promise<RecentRoom[]> {
  const rows = await selectRows<RecentRoomRow>(
    'SELECT code, mode, last_join_at FROM recent_rooms ORDER BY last_join_at DESC LIMIT $1',
    [limit],
  );
  return rows
    .map((row) => ({
      code: row.code,
      mode:
        row.mode === 'local'
          ? ('local' as const)
          : row.mode === 'stream'
            ? ('stream' as const)
            : ('site' as const),
      lastJoinAt: Number(row.last_join_at),
    }))
    .filter((row) => row.code.length > 0);
}

export async function removeRecentRoom(code: string): Promise<boolean> {
  return executeSql('DELETE FROM recent_rooms WHERE code = $1', [code]);
}
