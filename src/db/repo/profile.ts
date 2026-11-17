/*
 * Профиль: имя (2–24 символа), цвет и будущий аватар. Одна строка id=1.
 */

import { executeSql, selectRows } from '../index';
import type { ProfileRow } from '../migrations';

export const NAME_MIN = 2;
export const NAME_MAX = 24;

/** Палитра имён; цвет из неё попадает в чипы участников комнаты. */
export const NAME_COLORS = ['#6ff0c4', '#8ab4ff', '#ffd166', '#ff9eb5', '#c4a7ff'] as const;

export function normalizeDisplayName(raw: string): string | null {
  const value = raw.trim().replace(/\s+/g, ' ');
  if (value.length < NAME_MIN || value.length > NAME_MAX) {
    return null;
  }
  return value;
}

export function defaultDisplayName(seed: string): string {
  let hash = 0;
  for (const char of seed) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }
  return `Гость-${(hash % 9000) + 1000}`;
}

export function colorForSeed(seed: string): string {
  let hash = 0;
  for (const char of seed) {
    hash = (hash * 33 + char.charCodeAt(0)) >>> 0;
  }
  return NAME_COLORS[hash % NAME_COLORS.length] ?? NAME_COLORS[0];
}

export async function readProfile(): Promise<ProfileRow | null> {
  const rows = await selectRows<ProfileRow>(
    `SELECT id, user_id, display_name, name_color, avatar_hash, created_at
     FROM profile WHERE id = 1`,
  );
  return rows[0] ?? null;
}

export async function saveProfile(row: {
  userId: string;
  displayName: string;
  nameColor: string;
  avatarHash: string | null;
  createdAt: number;
}): Promise<boolean> {
  return executeSql(
    `INSERT INTO profile (id, user_id, display_name, name_color, avatar_hash, created_at)
     VALUES (1, $1, $2, $3, $4, $5)
     ON CONFLICT(id) DO UPDATE SET
       user_id = excluded.user_id,
       display_name = excluded.display_name,
       name_color = excluded.name_color,
       avatar_hash = excluded.avatar_hash,
       created_at = excluded.created_at`,
    [row.userId, row.displayName, row.nameColor, row.avatarHash, row.createdAt],
  );
}

export async function updateDisplayName(displayName: string): Promise<boolean> {
  return executeSql('UPDATE profile SET display_name = $1 WHERE id = 1', [displayName]);
}

export async function updateNameColor(nameColor: string): Promise<boolean> {
  if (!/^#[0-9a-f]{6}$/i.test(nameColor)) {
    return false;
  }
  return executeSql('UPDATE profile SET name_color = $1 WHERE id = 1', [nameColor]);
}

export async function updateProfileAvatar(avatarHash: string | null): Promise<boolean> {
  return executeSql('UPDATE profile SET avatar_hash = $1 WHERE id = 1', [avatarHash]);
}
