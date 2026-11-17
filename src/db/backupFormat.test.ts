import { describe, expect, it } from 'vitest';
import {
  BACKUP_FORMAT,
  BACKUP_SCHEMA,
  backupChecksum,
  isBackupFile,
  type BackupFile,
  type BackupPayload,
} from './backupFormat';

function emptyPayload(): BackupPayload {
  return {
    format: BACKUP_FORMAT,
    schema: BACKUP_SCHEMA,
    app: '0.7.0',
    exportedAt: 1_700_000_000_000,
    profile: {
      userId: 'A'.repeat(80),
      displayName: 'Аня',
      nameColor: '#6ff0c4',
      avatarHash: null,
      createdAt: 1_600_000_000_000,
    },
    identity: null,
    friends: [
      {
        userId: 'B'.repeat(80),
        displayName: 'Боря',
        nameColor: '#8ab4ff',
        avatarHash: 'hash',
        addedAt: 1_650_000_000_000,
        lastMeetAt: 1_700_000_000_000,
        blocked: false,
      },
    ],
    blocklist: [
      { userId: 'C'.repeat(80), reason: 'спам', createdAt: 1, expiresAt: 0 },
    ],
    dmMessages: [
      {
        id: 'MSG1',
        peerUserId: 'B'.repeat(80),
        dir: 'out',
        kind: 'text',
        body: 'привет',
        imagePath: null,
        ts: 1_700_000_000_000,
        status: 'delivered',
        sig: null,
      },
    ],
    sessions: [
      {
        id: 'S1',
        roomCode: 'ABC234',
        mode: 'site',
        startedAt: 1_700_000_000_000,
        endedAt: 1_700_000_100_000,
        lastHeartbeat: 1_700_000_090_000,
        endReason: 'left',
        peers: [{ userId: 'B'.repeat(80), name: 'Боря' }],
        hostUserId: 'A'.repeat(80),
      },
    ],
    peerStats: [
      {
        peerUserId: 'B'.repeat(80),
        day: '2026-11-17',
        sessions: 2,
        secondsTotal: 3600,
        secondsVoice: 1200,
        secondsWatch: 2400,
        modes: { site: 2 },
        lastMeetAt: 1_700_000_000_000,
      },
    ],
    settings: [{ key: 'accent.enabled', value: true }],
  };
}

async function makeFile(): Promise<BackupFile> {
  const payload = emptyPayload();
  return { ...payload, checksum: await backupChecksum(payload) };
}

describe('формат бэкапа', () => {
  it('собранный файл проходит структурную проверку', async () => {
    const file = await makeFile();
    expect(isBackupFile(file)).toBe(true);
    expect(file.checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it('изменённые данные ломают контрольную сумму', async () => {
    const file = await makeFile();
    const { checksum: _checksum, ...payload } = file;
    const tampered: BackupPayload = { ...payload, app: '9.9.9' };
    expect(await backupChecksum(tampered)).not.toBe(file.checksum);
  });

  it('отклоняет чужой формат, схему и отсутствующие таблицы', async () => {
    const file = await makeFile();
    expect(isBackupFile({ ...file, format: 'other' })).toBe(false);
    expect(isBackupFile({ ...file, schema: 2 })).toBe(false);
    expect(isBackupFile({ ...file, checksum: 'not-hex' })).toBe(false);
    expect(isBackupFile({ ...file, friends: 'нет' })).toBe(false);
    expect(isBackupFile({ ...file, dmMessages: [{ id: 1 }] })).toBe(false);
    expect(isBackupFile({ ...file, peerStats: [{}] })).toBe(false);
    expect(isBackupFile({ ...file, settings: [{ value: 1 }] })).toBe(false);
    expect(isBackupFile(null)).toBe(false);
  });

  it('identity — либо null, либо валидная пара JWK', async () => {
    const file = await makeFile();
    expect(
      isBackupFile({
        ...file,
        identity: { publicJwk: { kty: 'EC' }, privateJwk: {}, createdAt: 1 },
      }),
    ).toBe(false);
    const jwk = { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' };
    expect(
      isBackupFile({
        ...file,
        identity: { publicJwk: jwk, privateJwk: { ...jwk, d: 'd' }, createdAt: 1 },
      }),
    ).toBe(true);
  });
});
