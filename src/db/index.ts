/*
 * Доступ к SQLite. В браузере предпросмотра нативного плагина нет — все
 * функции возвращают пустой результат, а приложение работает на эфемерной
 * identity (см. db/repo/identity.ts).
 */

import Database from '@tauri-apps/plugin-sql';
import { isNativeRuntime } from '../native/nativeBridge';
import { DB_URL } from './migrations';

let database: Promise<Database | null> | null = null;

export function getDb(): Promise<Database | null> {
  if (!database) {
    database = isNativeRuntime()
      ? Database.load(DB_URL).catch((error: unknown) => {
          console.error('[heliwatch] не удалось открыть SQLite', error);
          return null;
        })
      : Promise.resolve(null);
  }
  return database;
}

/** SELECT: при ошибке — пустой массив и запись в консоль, UI не падает. */
export async function selectRows<T>(
  query: string,
  values: unknown[] = [],
): Promise<T[]> {
  const db = await getDb();
  if (!db) {
    return [];
  }
  try {
    return await db.select<T[]>(query, values);
  } catch (error) {
    console.error('[heliwatch] SELECT не выполнен', query, error);
    return [];
  }
}

/** INSERT/UPDATE/DELETE: true — запрос прошёл. */
export async function executeSql(
  query: string,
  values: unknown[] = [],
): Promise<boolean> {
  const db = await getDb();
  if (!db) {
    return false;
  }
  try {
    await db.execute(query, values);
    return true;
  } catch (error) {
    console.error('[heliwatch] SQL не выполнен', query, error);
    return false;
  }
}
