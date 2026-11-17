/*
 * Идентичность HeliWatch: WebCrypto ECDSA P-256 (§4.4).
 *
 * `userId` — это base64url(SPKI DER) публичного ключа, то есть сам публичный
 * ключ и есть идентификатор. Приватный ключ в открытом виде живёт только в
 * SQLite приложения (обёртка Android Keystore — 0.8+), в логах его нет.
 *
 * Подпись: ECDSA-SHA256 над signingInput(конверт) — см. protocol.ts.
 */

import type { Envelope } from './protocol';
import { signingInput } from './protocol';

export interface Identity {
  userId: string;
  /** 8 символов для интерфейса: производная от userId, не секрет. */
  fingerprint: string;
  publicJwk: JsonWebKey;
  privateJwk: JsonWebKey;
  createdAt: number;
}

const ECDSA = { name: 'ECDSA', namedCurve: 'P-256' } as const;
const ECDSA_SIGN = { name: 'ECDSA', hash: 'SHA-256' } as const;
const TEXT = new TextEncoder();
const BASE32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return globalThis
    .btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export function base64UrlDecode(value: string): Uint8Array {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  const binary = globalThis.atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function base32(bytes: Uint8Array): string {
  let output = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      output += BASE32[(buffer >> bits) & 31];
    }
  }
  if (bits > 0) {
    output += BASE32[(buffer << (5 - bits)) & 31];
  }
  return output;
}

export async function fingerprintOf(userId: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', TEXT.encode(userId));
  return base32(new Uint8Array(digest)).slice(0, 8);
}

async function importPrivate(privateJwk: JsonWebKey): Promise<CryptoKey> {
  return globalThis.crypto.subtle.importKey('jwk', privateJwk, ECDSA, false, ['sign']);
}

async function importPublic(publicJwk: JsonWebKey): Promise<CryptoKey> {
  // extractable=true только для публичного ключа: из него выводится userId.
  return globalThis.crypto.subtle.importKey('jwk', publicJwk, ECDSA, true, ['verify']);
}

async function userIdFromPublicKey(publicKey: CryptoKey): Promise<string> {
  const spki = await globalThis.crypto.subtle.exportKey('spki', publicKey);
  return base64UrlEncode(new Uint8Array(spki));
}

/** Новый ключ + userId + короткий отпечаток. */
export async function createIdentity(now: number = Date.now()): Promise<Identity> {
  const pair = (await globalThis.crypto.subtle.generateKey(ECDSA, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const publicJwk = await globalThis.crypto.subtle.exportKey('jwk', pair.publicKey);
  const privateJwk = await globalThis.crypto.subtle.exportKey('jwk', pair.privateKey);
  const userId = await userIdFromPublicKey(pair.publicKey);
  return {
    userId,
    fingerprint: await fingerprintOf(userId),
    publicJwk,
    privateJwk,
    createdAt: now,
  };
}

/**
 * Восстановление identity из сохранённых JWK. userId выводится заново из
 * публичного ключа — доверять сохранённой строке не нужно.
 */
export async function identityFromStored(
  publicJwk: JsonWebKey,
  privateJwk: JsonWebKey,
  createdAt: number,
): Promise<Identity> {
  const publicKey = await importPublic(publicJwk);
  const userId = await userIdFromPublicKey(publicKey);
  return {
    userId,
    fingerprint: await fingerprintOf(userId),
    publicJwk,
    privateJwk,
    createdAt,
  };
}

/** Совпадает ли публичный ключ с заявленным userId. */
export async function publicKeyMatchesUserId(
  publicJwk: JsonWebKey,
  userId: string,
): Promise<boolean> {
  try {
    const publicKey = await importPublic(publicJwk);
    return (await userIdFromPublicKey(publicKey)) === userId;
  } catch {
    return false;
  }
}

/**
 * Публичный ключ по userId: userId и есть SPKI DER в base64url. Нужен лобби
 * (этап 6): карточку подписывает хост, а гости проверяют подпись, не общаясь с
 * ним напрямую по DataChannel.
 */
export async function publicKeyFromUserId(userId: string): Promise<JsonWebKey | null> {
  try {
    const der = base64UrlDecode(userId);
    const key = await globalThis.crypto.subtle.importKey(
      'spki',
      der as unknown as BufferSource,
      ECDSA,
      true,
      ['verify'],
    );
    return await globalThis.crypto.subtle.exportKey('jwk', key);
  } catch {
    return null;
  }
}

/** Проверка подписи конверта по одному userId (без hello и обмена ключами). */
export async function verifyEnvelopeWithUserId(
  envelope: Envelope,
  userId: string,
): Promise<boolean> {
  const publicJwk = await publicKeyFromUserId(userId);
  if (!publicJwk) {
    return false;
  }
  if (!(await publicKeyMatchesUserId(publicJwk, userId))) {
    return false;
  }
  return verifyEnvelope(envelope, publicJwk);
}

/** Подписать конверт. Возвращает base64url(ECDSA P-256, 64 байта). */
export async function signEnvelope(
  envelope: Envelope,
  privateJwk: JsonWebKey,
): Promise<string> {
  const key = await importPrivate(privateJwk);
  const signature = await globalThis.crypto.subtle.sign(
    ECDSA_SIGN,
    key,
    TEXT.encode(signingInput(envelope)),
  );
  return base64UrlEncode(new Uint8Array(signature));
}

/** Проверить подпись конверта. Любая ошибка — просто `false`. */
export async function verifyEnvelope(
  envelope: Envelope,
  publicJwk: JsonWebKey,
): Promise<boolean> {
  if (!envelope.sig) {
    return false;
  }
  try {
    const key = await importPublic(publicJwk);
    const signature = base64UrlDecode(envelope.sig);
    return await globalThis.crypto.subtle.verify(
      ECDSA_SIGN,
      key,
      signature as unknown as BufferSource,
      TEXT.encode(signingInput(envelope)),
    );
  } catch {
    return false;
  }
}
