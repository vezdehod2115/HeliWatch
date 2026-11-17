/*
 * Загрузка или создание локальной identity.
 *
 * В APK ключи и профиль лежат в SQLite. В браузере предпросмотра (нет Tauri)
 * создаётся эфемерная identity в памяти — этого достаточно, чтобы посмотреть
 * интерфейс, но комнаты там не работают.
 */

import {
  createIdentity,
  identityFromStored,
  type Identity,
} from '../../net/identity';
import { isNativeRuntime } from '../../native/nativeBridge';
import { readKeys, saveKeys } from './keys';
import {
  colorForSeed,
  defaultDisplayName,
  readProfile,
  saveProfile,
} from './profile';

export interface LocalProfile {
  userId: string;
  displayName: string;
  nameColor: string;
  avatarHash: string | null;
  createdAt: number;
}

export interface LoadedIdentity {
  identity: Identity;
  profile: LocalProfile;
  /** true — данные сохранены в SQLite; false — предпросмотр в браузере. */
  persisted: boolean;
}

function profileFromIdentity(identity: Identity): LocalProfile {
  return {
    userId: identity.userId,
    displayName: defaultDisplayName(identity.userId),
    nameColor: colorForSeed(identity.userId),
    avatarHash: null,
    createdAt: identity.createdAt,
  };
}

async function createPersistedIdentity(): Promise<LoadedIdentity> {
  const identity = await createIdentity();
  const profile = profileFromIdentity(identity);
  const keysSaved = await saveKeys(
    JSON.stringify(identity.publicJwk),
    JSON.stringify(identity.privateJwk),
    identity.createdAt,
  );
  const profileSaved = await saveProfile(profile);
  return { identity, profile, persisted: keysSaved && profileSaved };
}

export async function loadOrCreateIdentity(): Promise<LoadedIdentity> {
  if (!isNativeRuntime()) {
    const identity = await createIdentity();
    return { identity, profile: profileFromIdentity(identity), persisted: false };
  }

  const keysRow = await readKeys();
  if (!keysRow) {
    return createPersistedIdentity();
  }

  let identity: Identity;
  try {
    identity = await identityFromStored(
      JSON.parse(keysRow.public_jwk) as JsonWebKey,
      JSON.parse(keysRow.private_jwk) as JsonWebKey,
      Number(keysRow.created_at),
    );
  } catch (error) {
    // Не подменяем личность молча: пишем в консоль и создаём новую пару,
    // иначе приложение останется без возможности войти в комнату.
    console.error('[heliwatch] ключи повреждены, создаём новую identity', error);
    return createPersistedIdentity();
  }

  const row = await readProfile();
  if (!row || row.user_id !== identity.userId) {
    const profile = profileFromIdentity(identity);
    const saved = await saveProfile(profile);
    return { identity, profile, persisted: saved };
  }

  return {
    identity,
    profile: {
      userId: row.user_id,
      displayName: row.display_name,
      nameColor: row.name_color,
      avatarHash: row.avatar_hash,
      createdAt: Number(row.created_at),
    },
    persisted: true,
  };
}
