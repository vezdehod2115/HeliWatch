/*
 * Формат бэкапа HeliWatch (§5, этап 7) и его проверка.
 *
 * Вынесено отдельно от `backup.ts`, потому что здесь нет Tauri-плагинов:
 * формат, контрольная сумма и валидация тестируются в Node (vitest), а
 * диалоги и запись файла — в `backup.ts`.
 */

import { canonicalJson } from '../net/protocol';
import { sha256Hex } from '../net/blobs';
import type { BlockEntry } from './repo/blocklist';
import type { DmMessage } from './repo/dm';
import type { SessionRecord, PeerStats } from './repo/stats';

export const BACKUP_FORMAT = 'heliwatch-backup';
export const BACKUP_SCHEMA = 1;

export interface BackupProfile {
  userId: string;
  displayName: string;
  nameColor: string;
  avatarHash: string | null;
  createdAt: number;
}

export interface BackupIdentity {
  publicJwk: JsonWebKey;
  privateJwk: JsonWebKey;
  createdAt: number;
}

export interface BackupFriend {
  userId: string;
  displayName: string;
  nameColor: string;
  avatarHash: string | null;
  addedAt: number;
  lastMeetAt: number | null;
  blocked: boolean;
}

export interface BackupSetting {
  key: string;
  value: unknown;
}

export interface BackupPayload {
  format: string;
  schema: number;
  app: string;
  exportedAt: number;
  profile: BackupProfile | null;
  identity: BackupIdentity | null;
  friends: BackupFriend[];
  blocklist: BlockEntry[];
  dmMessages: DmMessage[];
  sessions: SessionRecord[];
  peerStats: PeerStats[];
  settings: BackupSetting[];
  media?: Record<string, string>;
}

export interface BackupFile extends BackupPayload {
  checksum: string;
}

/** SHA-256 от канонического JSON без самого поля checksum. */
export async function backupChecksum(payload: BackupPayload): Promise<string> {
  const text = `${BACKUP_FORMAT}/v${BACKUP_SCHEMA}/${canonicalJson(payload)}`;
  return sha256Hex(new TextEncoder().encode(text));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isJwk(value: unknown): value is JsonWebKey {
  return (
    isRecord(value) &&
    value.kty === 'EC' &&
    value.crv === 'P-256' &&
    typeof value.x === 'string' &&
    typeof value.y === 'string'
  );
}

function isProfile(value: unknown): value is BackupProfile {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.userId === 'string' &&
    typeof value.displayName === 'string' &&
    typeof value.nameColor === 'string' &&
    (value.avatarHash === null || typeof value.avatarHash === 'string') &&
    typeof value.createdAt === 'number'
  );
}

function isIdentity(value: unknown): value is BackupIdentity {
  return (
    isRecord(value) &&
    isJwk(value.publicJwk) &&
    isJwk(value.privateJwk) &&
    typeof value.createdAt === 'number'
  );
}

function isFriend(value: unknown): value is BackupFriend {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.userId === 'string' &&
    typeof value.displayName === 'string' &&
    typeof value.nameColor === 'string' &&
    (value.avatarHash === null || typeof value.avatarHash === 'string') &&
    typeof value.addedAt === 'number' &&
    (value.lastMeetAt === null || typeof value.lastMeetAt === 'number') &&
    typeof value.blocked === 'boolean'
  );
}

function isDmMessage(value: unknown): value is DmMessage {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.id === 'string' &&
    typeof value.peerUserId === 'string' &&
    (value.dir === 'in' || value.dir === 'out') &&
    (value.kind === 'text' || value.kind === 'image') &&
    typeof value.body === 'string' &&
    (value.imagePath === null || typeof value.imagePath === 'string') &&
    typeof value.ts === 'number' &&
    (value.status === 'pending' || value.status === 'sent' || value.status === 'delivered') &&
    (value.sig === null || typeof value.sig === 'string')
  );
}

function isBlock(value: unknown): value is BlockEntry {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.userId === 'string' &&
    typeof value.reason === 'string' &&
    typeof value.createdAt === 'number' &&
    typeof value.expiresAt === 'number'
  );
}

function isSession(value: unknown): value is SessionRecord {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.id === 'string' &&
    typeof value.roomCode === 'string' &&
    (value.mode === 'site' || value.mode === 'local' || value.mode === 'stream') &&
    typeof value.startedAt === 'number' &&
    (value.endedAt === null || typeof value.endedAt === 'number') &&
    typeof value.lastHeartbeat === 'number' &&
    (value.endReason === null || typeof value.endReason === 'string') &&
    Array.isArray(value.peers) &&
    value.peers.every(
      (peer) =>
        isRecord(peer) && typeof peer.userId === 'string' && typeof peer.name === 'string',
    ) &&
    (value.hostUserId === null || typeof value.hostUserId === 'string')
  );
}

function isPeerStats(value: unknown): value is PeerStats {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.peerUserId === 'string' &&
    typeof value.day === 'string' &&
    typeof value.sessions === 'number' &&
    typeof value.secondsTotal === 'number' &&
    typeof value.secondsVoice === 'number' &&
    typeof value.secondsWatch === 'number' &&
    isRecord(value.modes) &&
    typeof value.lastMeetAt === 'number'
  );
}

function isSetting(value: unknown): value is BackupSetting {
  return isRecord(value) && typeof value.key === 'string' && value.key.length <= 128;
}

/** Структурная проверка файла до сверки checksum и записи в БД. */
export function isBackupFile(value: unknown): value is BackupFile {
  if (!isRecord(value)) {
    return false;
  }
  if (value.format !== BACKUP_FORMAT || value.schema !== BACKUP_SCHEMA) {
    return false;
  }
  if (typeof value.app !== 'string' || typeof value.exportedAt !== 'number') {
    return false;
  }
  if (typeof value.checksum !== 'string' || !/^[0-9a-f]{64}$/.test(value.checksum)) {
    return false;
  }
  if (value.profile !== null && !isProfile(value.profile)) {
    return false;
  }
  if (value.identity !== null && !isIdentity(value.identity)) {
    return false;
  }
  if (!Array.isArray(value.friends) || !value.friends.every(isFriend)) {
    return false;
  }
  if (!Array.isArray(value.blocklist) || !value.blocklist.every(isBlock)) {
    return false;
  }
  if (!Array.isArray(value.dmMessages) || !value.dmMessages.every(isDmMessage)) {
    return false;
  }
  if (!Array.isArray(value.sessions) || !value.sessions.every(isSession)) {
    return false;
  }
  if (!Array.isArray(value.peerStats) || !value.peerStats.every(isPeerStats)) {
    return false;
  }
  if (!Array.isArray(value.settings) || !value.settings.every(isSetting)) {
    return false;
  }
  if (value.media !== undefined && !isRecord(value.media)) {
    return false;
  }
  return true;
}
