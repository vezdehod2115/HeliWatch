/*
 * Сессии и статистика встреч (этап 7, §5).
 *
 * Сессия открывается при входе в комнату и обновляется heartbeat'ом каждые
 * 30 секунд. Если приложение упало, при следующем старте «зависшие» сессии
 * закрываются временем последнего heartbeat (`end_reason = timeout`), поэтому
 * статистика переживает краш, а не показывает вечную комнату.
 *
 * `peer_stats` — агрегат по дням: секунды вместе, секунды просмотра, секунды
 * с включённым микрофоном и счётчики режимов.
 */

import { executeSql, selectRows } from '../index';
import type { PeerStatsRow, SessionRow } from '../migrations';

export type SessionEndReason =
  | 'left'
  | 'host-left'
  | 'timeout'
  | 'kick'
  | 'banned'
  | 'closed'
  | 'error';

export interface SessionPeer {
  userId: string;
  name: string;
}

export interface SessionRecord {
  id: string;
  roomCode: string;
  mode: 'site' | 'local' | 'stream';
  startedAt: number;
  endedAt: number | null;
  lastHeartbeat: number;
  endReason: SessionEndReason | null;
  peers: SessionPeer[];
  hostUserId: string | null;
}

export interface PeerStats {
  peerUserId: string;
  day: string;
  sessions: number;
  secondsTotal: number;
  secondsVoice: number;
  secondsWatch: number;
  modes: Record<string, number>;
  lastMeetAt: number;
}

export interface PeerTotal {
  peerUserId: string;
  sessions: number;
  secondsTotal: number;
  secondsVoice: number;
  secondsWatch: number;
  lastMeetAt: number;
}

const SESSION_COLUMNS = `id, room_code, mode, started_at, ended_at, last_heartbeat, end_reason, peers_json, host_user_id`;

function parsePeers(raw: string): SessionPeer[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .filter((item): item is SessionPeer => {
        return (
          typeof item === 'object' &&
          item !== null &&
          typeof (item as SessionPeer).userId === 'string' &&
          typeof (item as SessionPeer).name === 'string'
        );
      })
      .map((item) => ({ userId: item.userId, name: item.name }));
  } catch {
    return [];
  }
}

function parseModes(raw: string): Record<string, number> {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) {
      return {};
    }
    const result: Record<string, number> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'number' && Number.isFinite(value)) {
        result[key] = value;
      }
    }
    return result;
  } catch {
    return {};
  }
}

function toSession(row: SessionRow): SessionRecord {
  return {
    id: row.id,
    roomCode: row.room_code,
    mode:
      row.mode === 'local' ? 'local' : row.mode === 'stream' ? 'stream' : 'site',
    startedAt: Number(row.started_at) || 0,
    endedAt: row.ended_at === null ? null : Number(row.ended_at),
    lastHeartbeat: Number(row.last_heartbeat) || 0,
    endReason: (row.end_reason as SessionEndReason | null) ?? null,
    peers: parsePeers(row.peers_json),
    hostUserId: row.host_user_id,
  };
}

function toPeerStats(row: PeerStatsRow): PeerStats {
  return {
    peerUserId: row.peer_user_id,
    day: row.day,
    sessions: Number(row.sessions) || 0,
    secondsTotal: Number(row.seconds_total) || 0,
    secondsVoice: Number(row.seconds_voice) || 0,
    secondsWatch: Number(row.seconds_watch) || 0,
    modes: parseModes(row.modes_json),
    lastMeetAt: Number(row.last_meet_at) || 0,
  };
}

/** Локальная дата `YYYY-MM-DD`: статистика по дням не зависит от UTC. */
export function dayKey(at = Date.now()): string {
  const date = new Date(at);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

export async function openSession(input: {
  id: string;
  roomCode: string;
  mode: SessionRecord['mode'];
  startedAt: number;
  peers: SessionPeer[];
  hostUserId: string | null;
}): Promise<boolean> {
  return executeSql(
    `INSERT INTO sessions (id, room_code, mode, started_at, ended_at, last_heartbeat, end_reason, peers_json, host_user_id)
     VALUES ($1, $2, $3, $4, NULL, $4, NULL, $5, $6)
     ON CONFLICT(id) DO NOTHING`,
    [
      input.id,
      input.roomCode,
      input.mode,
      input.startedAt,
      JSON.stringify(input.peers),
      input.hostUserId,
    ],
  );
}

export async function heartbeatSession(
  id: string,
  at = Date.now(),
  peers?: SessionPeer[],
  hostUserId?: string | null,
): Promise<boolean> {
  if (peers) {
    return executeSql(
      `UPDATE sessions SET last_heartbeat = $2, peers_json = $3,
         host_user_id = COALESCE($4, host_user_id)
       WHERE id = $1 AND ended_at IS NULL`,
      [id, at, JSON.stringify(peers), hostUserId ?? null],
    );
  }
  return executeSql(
    'UPDATE sessions SET last_heartbeat = $2 WHERE id = $1 AND ended_at IS NULL',
    [id, at],
  );
}

export async function closeSession(
  id: string,
  endedAt: number,
  reason: SessionEndReason,
): Promise<boolean> {
  return executeSql(
    `UPDATE sessions SET ended_at = $2, end_reason = $3, last_heartbeat = MAX(last_heartbeat, $2)
     WHERE id = $1 AND ended_at IS NULL`,
    [id, endedAt, reason],
  );
}

/**
 * Старт приложения: незакрытые сессии получают `ended_at = last_heartbeat`.
 * Так обрыв процесса не оставляет «вечную комнату» в статистике.
 */
export async function closeStaleSessions(): Promise<number> {
  const rows = await selectRows<{ id: string }>(
    'SELECT id FROM sessions WHERE ended_at IS NULL',
  );
  if (rows.length === 0) {
    return 0;
  }
  let closed = 0;
  for (const row of rows) {
    const done = await executeSql(
      `UPDATE sessions SET ended_at = last_heartbeat, end_reason = 'timeout'
       WHERE id = $1 AND ended_at IS NULL`,
      [row.id],
    );
    if (done) {
      closed += 1;
    }
  }
  return closed;
}

export async function listSessions(limit = 50): Promise<SessionRecord[]> {
  const rows = await selectRows<SessionRow>(
    `SELECT ${SESSION_COLUMNS} FROM sessions
     ORDER BY started_at DESC LIMIT $1`,
    [Math.max(1, Math.min(500, limit))],
  );
  return rows.map(toSession);
}

/** Всего сессий (в том числе старше показанных 40) — для сводки. */
export async function countSessions(): Promise<number> {
  const rows = await selectRows<{ total: number }>('SELECT COUNT(*) AS total FROM sessions');
  return Number(rows[0]?.total ?? 0);
}

export async function listAllSessions(): Promise<SessionRecord[]> {
  const rows = await selectRows<SessionRow>(
    `SELECT ${SESSION_COLUMNS} FROM sessions ORDER BY started_at ASC`,
  );
  return rows.map(toSession);
}

/**
 * Начислить время с другом. Вызывается пачками раз в 30 секунд, поэтому
 * одинаковый результат даёт и штатный выход, и обрыв: записано то, что
 * успело попасть в SQLite.
 */
export async function addPeerTime(input: {
  peerUserId: string;
  at?: number;
  secondsTotal: number;
  secondsWatch?: number;
  secondsVoice?: number;
  mode: SessionRecord['mode'];
  newSession?: boolean;
}): Promise<boolean> {
  const at = input.at ?? Date.now();
  const day = dayKey(at);
  const rows = await selectRows<PeerStatsRow>(
    `SELECT peer_user_id, day, sessions, seconds_total, seconds_voice, seconds_watch, modes_json, last_meet_at
     FROM peer_stats WHERE peer_user_id = $1 AND day = $2`,
    [input.peerUserId, day],
  );
  const modes = rows[0] ? parseModes(rows[0].modes_json) : {};
  if (input.newSession) {
    modes[input.mode] = (modes[input.mode] ?? 0) + 1;
  }
  const total = Math.max(0, Math.round(input.secondsTotal));
  const watch = Math.max(0, Math.round(input.secondsWatch ?? 0));
  const voice = Math.max(0, Math.round(input.secondsVoice ?? 0));
  return executeSql(
    `INSERT INTO peer_stats (peer_user_id, day, sessions, seconds_total, seconds_voice, seconds_watch, modes_json, last_meet_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT(peer_user_id, day) DO UPDATE SET
       sessions = peer_stats.sessions + excluded.sessions,
       seconds_total = peer_stats.seconds_total + excluded.seconds_total,
       seconds_voice = peer_stats.seconds_voice + excluded.seconds_voice,
       seconds_watch = peer_stats.seconds_watch + excluded.seconds_watch,
       modes_json = excluded.modes_json,
       last_meet_at = MAX(peer_stats.last_meet_at, excluded.last_meet_at)`,
    [
      input.peerUserId,
      day,
      input.newSession ? 1 : 0,
      total,
      voice,
      watch,
      JSON.stringify(modes),
      at,
    ],
  );
}

export async function listPeerStats(): Promise<PeerStats[]> {
  const rows = await selectRows<PeerStatsRow>(
    `SELECT peer_user_id, day, sessions, seconds_total, seconds_voice, seconds_watch, modes_json, last_meet_at
     FROM peer_stats ORDER BY day DESC, seconds_total DESC`,
  );
  return rows.map(toPeerStats);
}

export async function listPeerTotals(): Promise<PeerTotal[]> {
  const rows = await selectRows<{
    peer_user_id: string;
    sessions: number;
    seconds_total: number;
    seconds_voice: number;
    seconds_watch: number;
    last_meet_at: number;
  }>(
    `SELECT peer_user_id,
            SUM(sessions) AS sessions,
            SUM(seconds_total) AS seconds_total,
            SUM(seconds_voice) AS seconds_voice,
            SUM(seconds_watch) AS seconds_watch,
            MAX(last_meet_at) AS last_meet_at
     FROM peer_stats GROUP BY peer_user_id ORDER BY seconds_total DESC`,
  );
  return rows.map((row) => ({
    peerUserId: row.peer_user_id,
    sessions: Number(row.sessions) || 0,
    secondsTotal: Number(row.seconds_total) || 0,
    secondsVoice: Number(row.seconds_voice) || 0,
    secondsWatch: Number(row.seconds_watch) || 0,
    lastMeetAt: Number(row.last_meet_at) || 0,
  }));
}

/** Импорт бэкапа: агрегат заменяется записью из файла. */
export async function importPeerStats(stats: PeerStats[]): Promise<void> {
  for (const stat of stats) {
    await executeSql(
      `INSERT INTO peer_stats (peer_user_id, day, sessions, seconds_total, seconds_voice, seconds_watch, modes_json, last_meet_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT(peer_user_id, day) DO UPDATE SET
         sessions = excluded.sessions,
         seconds_total = excluded.seconds_total,
         seconds_voice = excluded.seconds_voice,
         seconds_watch = excluded.seconds_watch,
         modes_json = excluded.modes_json,
         last_meet_at = MAX(peer_stats.last_meet_at, excluded.last_meet_at)`,
      [
        stat.peerUserId,
        stat.day,
        stat.sessions,
        stat.secondsTotal,
        stat.secondsVoice,
        stat.secondsWatch,
        JSON.stringify(stat.modes),
        stat.lastMeetAt,
      ],
    );
  }
}

export async function clearSessions(): Promise<boolean> {
  return executeSql('DELETE FROM sessions');
}

/** Импорт сессии из бэкапа: дубликат по id пропускается. */
export async function importSession(session: SessionRecord): Promise<boolean> {
  return executeSql(
    `INSERT INTO sessions (id, room_code, mode, started_at, ended_at, last_heartbeat, end_reason, peers_json, host_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT(id) DO NOTHING`,
    [
      session.id,
      session.roomCode,
      session.mode,
      session.startedAt,
      session.endedAt,
      session.lastHeartbeat,
      session.endReason,
      JSON.stringify(session.peers),
      session.hostUserId,
    ],
  );
}

export async function clearPeerStats(): Promise<boolean> {
  return executeSql('DELETE FROM peer_stats');
}
