/*
 * ICE-настройки (§4.8, этап 7): свой TURN и режим «только TURN».
 *
 * Пользователь вставляет JSON вида `[{"urls":"turn:host:3478","username":"u",
 * "credential":"p"}]`. Настройка живёт в SQLite, а этот модуль переводит её в
 * `RTCIceServer[]` и отдаёт транспорту. Невалидный JSON не ломает соединение:
 * остаются публичные STUN/TURN и понятная ошибка в настройках.
 */

/** Сколько своих серверов принимаем: больше — уже не «свой TURN», а свалка. */
export const TURN_MAX_SERVERS = 8;
/** Свой TURN добавляется к публичным STUN, а не заменяет их. */
export interface IceOverrides {
  servers: RTCIceServer[];
  relayOnly: boolean;
}

const EMPTY: IceOverrides = { servers: [], relayOnly: false };

let overrides: IceOverrides = EMPTY;

export type TurnParseResult =
  | { ok: true; servers: RTCIceServer[] }
  | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function normalizeUrls(raw: unknown): string[] | null {
  const list = typeof raw === 'string' ? [raw] : Array.isArray(raw) ? raw : null;
  if (!list || list.length === 0 || list.length > 8) {
    return null;
  }
  const urls: string[] = [];
  for (const item of list) {
    if (typeof item !== 'string' || item.length > 256) {
      return null;
    }
    const value = item.trim();
    if (!/^(stun|stuns|turn|turns):/i.test(value)) {
      return null;
    }
    urls.push(value);
  }
  return urls;
}

/**
 * Разбор JSON из настроек. Принимает массив RTCIceServer или один объект.
 * Возвращает понятную ошибку, а не молчаливое игнорирование.
 */
export function parseTurnJson(raw: string): TurnParseResult {
  const text = raw.trim();
  if (!text) {
    return { ok: true, servers: [] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: 'TURN: это не JSON' };
  }
  const items = Array.isArray(parsed) ? parsed : [parsed];
  if (items.length === 0) {
    return { ok: true, servers: [] };
  }
  if (items.length > TURN_MAX_SERVERS) {
    return { ok: false, error: `TURN: не больше ${TURN_MAX_SERVERS} серверов` };
  }
  const servers: RTCIceServer[] = [];
  for (const item of items) {
    if (!isRecord(item)) {
      return { ok: false, error: 'TURN: каждый сервер — объект' };
    }
    const urls = normalizeUrls(item.urls);
    if (!urls) {
      return { ok: false, error: 'TURN: urls должны начинаться с turn:, turns:, stun: или stuns:' };
    }
    const server: RTCIceServer = { urls: urls.length === 1 ? urls[0]! : urls };
    if (item.username !== undefined) {
      if (typeof item.username !== 'string' || item.username.length > 128) {
        return { ok: false, error: 'TURN: username — строка до 128 символов' };
      }
      server.username = item.username;
    }
    if (item.credential !== undefined) {
      if (typeof item.credential !== 'string' || item.credential.length > 256) {
        return { ok: false, error: 'TURN: credential — строка до 256 символов' };
      }
      server.credential = item.credential;
    }
    servers.push(server);
  }
  return { ok: true, servers };
}

/** Сохранить настройки для следующего `connectTrystero`. */
export function setIceOverrides(next: IceOverrides): void {
  overrides = {
    servers: next.servers.slice(0, TURN_MAX_SERVERS),
    relayOnly: next.relayOnly,
  };
}

export function getIceOverrides(): IceOverrides {
  return overrides;
}

/** Итоговый rtcConfig: публичные STUN/TURN + свой TURN, при желании — только TURN. */
export function buildRtcConfig(baseServers: RTCIceServer[]): RTCConfiguration {
  const iceServers = [...baseServers, ...overrides.servers];
  const config: RTCConfiguration = {
    iceServers,
    iceCandidatePoolSize: 2,
  };
  if (overrides.relayOnly) {
    config.iceTransportPolicy = 'relay';
  }
  return config;
}
