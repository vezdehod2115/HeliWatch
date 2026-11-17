/*
 * Ключи идентичности в SQLite. Приватный JWK — app-private: таблица живёт в
 * песочнице приложения, в лог и в бэкап по умолчанию не попадает.
 */

import { executeSql, selectRows } from '../index';
import type { KeysRow } from '../migrations';

export async function readKeys(): Promise<KeysRow | null> {
  const rows = await selectRows<KeysRow>(
    'SELECT id, public_jwk, private_jwk, created_at FROM keys WHERE id = 1',
  );
  return rows[0] ?? null;
}

export async function saveKeys(
  publicJwk: string,
  privateJwk: string,
  createdAt: number,
): Promise<boolean> {
  return executeSql(
    `INSERT INTO keys (id, public_jwk, private_jwk, created_at)
     VALUES (1, $1, $2, $3)
     ON CONFLICT(id) DO UPDATE SET
       public_jwk = excluded.public_jwk,
       private_jwk = excluded.private_jwk,
       created_at = excluded.created_at`,
    [publicJwk, privateJwk, createdAt],
  );
}
