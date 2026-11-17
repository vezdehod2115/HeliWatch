/*
 * Друзья (этап 7, §5). Запись появляется только после взаимного подтверждения:
 * `friend-request` сам по себе друга не создаёт, иначе любой, кто узнал ваш
 * userId, мог бы писать вам в личку.
 */

import { executeSql, selectRows } from '../index';
import type { FriendRow } from '../migrations';

export interface Friend {
  userId: string;
  displayName: string;
  nameColor: string;
  avatarHash: string | null;
  addedAt: number;
  lastMeetAt: number | null;
  blocked: boolean;
}

function toFriend(row: FriendRow): Friend {
  return {
    userId: row.user_id,
    displayName: row.display_name,
    nameColor: row.name_color,
    avatarHash: row.avatar_hash,
    addedAt: Number(row.added_at) || 0,
    lastMeetAt: row.last_meet_at === null ? null : Number(row.last_meet_at),
    blocked: Number(row.blocked) === 1,
  };
}

const COLUMNS = `user_id, display_name, name_color, avatar_hash, added_at, last_meet_at, blocked`;

export async function listFriends(includeBlocked = false): Promise<Friend[]> {
  const rows = await selectRows<FriendRow>(
    `SELECT ${COLUMNS} FROM friends ORDER BY last_meet_at DESC, added_at DESC`,
  );
  return rows.map(toFriend).filter((friend) => includeBlocked || !friend.blocked);
}

export async function getFriend(userId: string): Promise<Friend | null> {
  const rows = await selectRows<FriendRow>(
    `SELECT ${COLUMNS} FROM friends WHERE user_id = $1`,
    [userId],
  );
  const row = rows[0];
  return row ? toFriend(row) : null;
}

export async function isFriend(userId: string): Promise<boolean> {
  return (await getFriend(userId)) !== null;
}

/**
 * Добавить друга или обновить его карточку. `added_at` не перезаписывается:
 * дата знакомства остаётся исходной.
 */
export async function upsertFriend(friend: {
  userId: string;
  displayName: string;
  nameColor: string;
  avatarHash?: string | null;
  addedAt?: number;
}): Promise<boolean> {
  return executeSql(
    `INSERT INTO friends (user_id, display_name, name_color, avatar_hash, added_at, last_meet_at, blocked)
     VALUES ($1, $2, $3, $4, $5, NULL, 0)
     ON CONFLICT(user_id) DO UPDATE SET
       display_name = excluded.display_name,
       name_color = excluded.name_color,
       avatar_hash = COALESCE(excluded.avatar_hash, friends.avatar_hash)`,
    [
      friend.userId,
      friend.displayName,
      friend.nameColor,
      friend.avatarHash ?? null,
      friend.addedAt ?? Date.now(),
    ],
  );
}

export async function removeFriend(userId: string): Promise<boolean> {
  return executeSql('DELETE FROM friends WHERE user_id = $1', [userId]);
}

/** Отметить встречу: используется для сортировки и «давно не виделись». */
export async function touchFriendMeet(userId: string, at = Date.now()): Promise<boolean> {
  return executeSql(
    `UPDATE friends SET last_meet_at = $2
     WHERE user_id = $1 AND (last_meet_at IS NULL OR last_meet_at < $2)`,
    [userId, at],
  );
}

export async function setFriendBlocked(userId: string, blocked: boolean): Promise<boolean> {
  return executeSql('UPDATE friends SET blocked = $2 WHERE user_id = $1', [
    userId,
    blocked ? 1 : 0,
  ]);
}

/** Аватар, полученный от друга: запись не создаётся, обновляется только своя. */
export async function updateFriendAvatar(
  userId: string,
  avatarHash: string,
): Promise<boolean> {
  return executeSql('UPDATE friends SET avatar_hash = $2 WHERE user_id = $1', [
    userId,
    avatarHash,
  ]);
}

export async function clearFriends(): Promise<boolean> {
  return executeSql('DELETE FROM friends');
}

/** Полное восстановление записи из бэкапа: даты и блокировка сохраняются. */
export async function importFriend(friend: {
  userId: string;
  displayName: string;
  nameColor: string;
  avatarHash: string | null;
  addedAt: number;
  lastMeetAt: number | null;
  blocked: boolean;
}): Promise<boolean> {
  return executeSql(
    `INSERT INTO friends (user_id, display_name, name_color, avatar_hash, added_at, last_meet_at, blocked)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT(user_id) DO UPDATE SET
       display_name = excluded.display_name,
       name_color = excluded.name_color,
       avatar_hash = COALESCE(excluded.avatar_hash, friends.avatar_hash),
       added_at = MIN(friends.added_at, excluded.added_at),
       last_meet_at = MAX(COALESCE(friends.last_meet_at, 0), COALESCE(excluded.last_meet_at, 0)),
       blocked = MAX(friends.blocked, excluded.blocked)`,
    [
      friend.userId,
      friend.displayName,
      friend.nameColor,
      friend.avatarHash,
      friend.addedAt,
      friend.lastMeetAt,
      friend.blocked ? 1 : 0,
    ],
  );
}
