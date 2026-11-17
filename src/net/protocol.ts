/*
 * Протокол HeliWatch v1: конверт сообщения, короткие коды комнат, ULID,
 * переменные состояния воспроизведения и чистая логика разрешения конфликтов.
 *
 * Здесь нет ни WebRTC, ни DOM: файл можно тестировать в Node, чем и пользуется
 * `src/net/protocol.test.ts`. Транспорт и аутентификация — в room.ts.
 */

export const PROTOCOL_VERSION = 1;
export const APP_ID = 'heliwatch-v1';

export const ROOM_CODE_LENGTH = 6;
export const ROOM_LIMIT_DEFAULT = 4;
export const ROOM_LIMIT_MAX = 6;

/** Nonce живёт 60 секунд и гасится после использования (§4.4 плана). */
export const NONCE_TTL_MS = 60_000;

export type RoomMode = 'site' | 'local';
export type RoomRole = 'host' | 'guest';

/** Допустимые множители скорости: 0.25…4, как в page-hook. */
export const MIN_RATE = 0.25;
export const MAX_RATE = 4;

export interface ProfilePayload {
  name: string;
  color: string;
  avatarHash?: string;
}

export interface PlaybackSource {
  mode: RoomMode;
  /** URL сайта для режима A. */
  url?: string;
  /** Имя локального файла для режима C — только для интерфейса. */
  fileName?: string;
  size?: number;
  duration: number;
}

/**
 * Состояние воспроизведения от driver'а. `seq` — Lamport-счётчик комнаты,
 * `by` — userId автора (он же driver).
 */
export interface PlaybackState {
  playing: boolean;
  t: number;
  rate: number;
  src: PlaybackSource;
  seq: number;
  by: string;
}

export interface PlaybackSample {
  playing: boolean;
  time: number;
  rate: number;
  duration: number;
}

export interface PlaybackAction {
  kind: 'play' | 'pause' | 'seek' | 'rate';
  t?: number;
  rate?: number;
  /** Для временной коррекции: когда вернуть исходную скорость. */
  holdMs?: number;
  restoreRate?: number;
}

export interface MemberInfo {
  userId: string;
  peerId: string;
  name: string;
  color: string;
  avatarHash?: string;
  joinedAt: number;
  host: boolean;
}

export interface RoomMeta {
  code: string;
  title: string;
  mode: RoomMode;
  limit: number;
  closed: boolean;
  knock: boolean;
}

/** Конверт §4.1: всё, что уходит в DataChannel через trystero-action `hw`. */
export interface Envelope<T = unknown> {
  v: number;
  t: string;
  id: string;
  ts: number;
  from: string;
  to?: string;
  rid: string;
  d: T;
  sig?: string;
}

export interface HelloData {
  nonce: string;
  pub: JsonWebKey;
  userId: string;
  host: boolean;
  profile: ProfilePayload;
  ver: number;
}

export interface JoinData {
  nonce: string;
  peerId: string;
  profile: ProfilePayload;
  ver: number;
}

export interface WelcomeData {
  nonce: string;
  hostUserId: string;
  room: RoomMeta;
  members: MemberInfo[];
  state: PlaybackState;
  epoch: number;
}

export interface StateData {
  playing: boolean;
  t: number;
  rate: number;
  src: PlaybackSource;
  seq: number;
  by: string;
}

export interface CommandData {
  t?: number;
  rate?: number;
}

export interface ResyncData {
  to?: string;
}

export interface SiteUrlData {
  url: string;
}

export interface ByeData {
  reason: 'left' | 'host-left' | 'kicked' | 'banned' | 'closed';
}

export interface JoinDenyData {
  reason: string;
}

export interface StateVersion {
  seq: number;
  by: string;
}

// ---------- Канонизация и подписи ----------

/**
 * Детерминированный JSON для подписи: ключи объектов сортируются, undefined
 * опускается, массивы сохраняют порядок. Подпись не зависит от порядка полей.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  const type = typeof value;
  if (type === 'string' || type === 'number' || type === 'boolean') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  if (type === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort();
    const body = keys
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',');
    return `{${body}}`;
  }
  // Функции/символы в протоколе не встречаются; для устойчивости — null.
  return 'null';
}

/**
 * Вход подписи: canonicalJson конверта без `sig` + тег типа.
 * Тег защищает от переноса подписи между типами сообщений (§4.4).
 */
export function signingInput(envelope: Envelope): string {
  const body: Record<string, unknown> = {
    v: envelope.v,
    t: envelope.t,
    id: envelope.id,
    ts: envelope.ts,
    from: envelope.from,
    rid: envelope.rid,
    d: envelope.d,
  };
  if (envelope.to !== undefined) {
    body.to = envelope.to;
  }
  return `${canonicalJson(body)}heliwatch/v1/${envelope.t}`;
}

// ---------- ULID ----------

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

function encodeTime(time: number): string {
  let rest = Math.max(0, Math.floor(time));
  let output = '';
  for (let index = 0; index < 10; index += 1) {
    const digit = rest % 32;
    output = CROCKFORD[digit] + output;
    rest = Math.floor(rest / 32);
  }
  return output;
}

let lastUlidTime = -1;
let lastUlidRandom: number[] = [];

/**
 * ULID: 10 символов времени + 16 случайных, Crockford base32.
 * В пределах одной миллисекунды случайная часть инкрементируется —
 * идентификаторы остаются уникальными и сортируемыми.
 */
export function createUlid(now: number = Date.now(), bytes?: Uint8Array): string {
  const random = bytes ? Array.from(bytes.subarray(0, 16)) : Array.from(randomBytes(16));
  if (now === lastUlidTime) {
    for (let index = lastUlidRandom.length - 1; index >= 0; index -= 1) {
      const value = (lastUlidRandom[index] ?? 0) + 1;
      if (value <= 31) {
        lastUlidRandom[index] = value;
        break;
      }
      lastUlidRandom[index] = 0;
    }
  } else {
    lastUlidRandom = random;
  }
  lastUlidTime = now;
  const randomPart = lastUlidRandom
    .map((value) => CROCKFORD[value & 31])
    .join('');
  return `${encodeTime(now)}${randomPart}`;
}

// ---------- Коды комнат и ссылки ----------

export const ROOM_CODE_ALPHABET = CROCKFORD;
const CODE_ALIASES: Record<string, string> = { O: '0', I: '1', L: '1' };

/**
 * Нормализация кода из 6 символов: регистр, пробелы/дефисы, похожие буквы
 * (O→0, I/L→1). Всё, что не входит в Crockford base32, отклоняется.
 */
export function normalizeRoomCode(raw: string): string | null {
  const cleaned = raw
    .trim()
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '');
  const mapped = Array.from(cleaned)
    .map((char) => CODE_ALIASES[char] ?? char)
    .join('');
  if (mapped.length !== ROOM_CODE_LENGTH) {
    return null;
  }
  for (const char of mapped) {
    if (!ROOM_CODE_ALPHABET.includes(char)) {
      return null;
    }
  }
  return mapped;
}

export function generateRoomCode(bytes?: Uint8Array): string {
  const random = bytes ?? randomBytes(ROOM_CODE_LENGTH);
  let code = '';
  for (let index = 0; index < ROOM_CODE_LENGTH; index += 1) {
    code += ROOM_CODE_ALPHABET[(random[index] ?? 0) % 32];
  }
  return code;
}

export function roomLink(code: string): string {
  return `heliwatch://r/${code}`;
}

/**
 * Принимает код (`abc-123`), ссылку `heliwatch://r/<code>` и текст с такой
 * ссылкой (её удобно вставлять из мессенджера).
 */
export function parseRoomInput(raw: string): string | null {
  const value = raw.trim();
  if (!value) {
    return null;
  }
  const match = value.match(/heliwatch:\/\/(?:r\/)?([0-9a-z-]+)/i);
  if (match?.[1]) {
    return normalizeRoomCode(match[1]);
  }
  return normalizeRoomCode(value);
}

// ---------- Nonce ----------

export function createNonce(bytes: Uint8Array = randomBytes(16)): string {
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

export function isNonceFresh(now: number, seenAt: number, ttlMs: number = NONCE_TTL_MS): boolean {
  return now - seenAt >= 0 && now - seenAt <= ttlMs;
}

// ---------- Конверт ----------

/** Валидация внешней формы конверта до любой криптографии. */
export function isEnvelope(value: unknown, rid?: string): value is Envelope {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (record.v !== PROTOCOL_VERSION) {
    return false;
  }
  if (typeof record.t !== 'string' || record.t.length === 0 || record.t.length > 32) {
    return false;
  }
  if (typeof record.id !== 'string' || record.id.length < 10 || record.id.length > 64) {
    return false;
  }
  if (typeof record.ts !== 'number' || !Number.isFinite(record.ts)) {
    return false;
  }
  if (typeof record.from !== 'string' || record.from.length === 0) {
    return false;
  }
  if (typeof record.rid !== 'string' || record.rid.length === 0) {
    return false;
  }
  if (rid !== undefined && record.rid !== rid) {
    return false;
  }
  if (record.to !== undefined && typeof record.to !== 'string') {
    return false;
  }
  if (typeof record.d !== 'object' || record.d === null) {
    return false;
  }
  if (record.sig !== undefined && typeof record.sig !== 'string') {
    return false;
  }
  return true;
}

export interface EnvelopeOptions {
  to?: string;
  now?: number;
  id?: string;
}

export function createEnvelope<T>(
  type: string,
  data: T,
  from: string,
  rid: string,
  options: EnvelopeOptions = {},
): Envelope<T> {
  const envelope: Envelope<T> = {
    v: PROTOCOL_VERSION,
    t: type,
    id: options.id ?? createUlid(options.now),
    ts: options.now ?? Date.now(),
    from,
    rid,
    d: data,
  };
  if (options.to !== undefined) {
    envelope.to = options.to;
  }
  return envelope;
}

// ---------- Lamport seq §4.5 ----------

/**
 * Применяем состояние только если seq больше; при равенстве побеждает
 * лексикографически больший userId. Это снимает гонку одновременной перемотки.
 */
export function shouldApplyState(
  current: StateVersion | null,
  next: StateVersion,
): boolean {
  if (!current) {
    return true;
  }
  if (next.seq !== current.seq) {
    return next.seq > current.seq;
  }
  return next.by > current.by;
}

/** Периодический state от того же driver'а: время уточняем, seq не двигаем. */
export function isStateRefresh(
  current: StateVersion | null,
  next: StateVersion,
): boolean {
  return current !== null && current.seq === next.seq && current.by === next.by;
}

// ---------- Состояние воспроизведения ----------

export function clampRate(rate: number): number {
  if (!Number.isFinite(rate)) {
    return 1;
  }
  return Math.min(MAX_RATE, Math.max(MIN_RATE, rate));
}

/** Куда «уехало» состояние driver'а к моменту now. */
export function projectState(state: PlaybackState, receivedAt: number, now: number): number {
  const elapsedSeconds = Math.max(0, now - receivedAt) / 1000;
  const projected = state.playing ? state.t + elapsedSeconds * state.rate : state.t;
  const duration = state.src.duration;
  if (duration > 0) {
    return Math.min(duration, Math.max(0, projected));
  }
  return Math.max(0, projected);
}

export function sampleFromState(
  state: PlaybackState,
  receivedAt: number,
  now: number,
): PlaybackSample {
  return {
    playing: state.playing,
    time: projectState(state, receivedAt, now),
    rate: state.rate,
    duration: state.src.duration,
  };
}

/** Валидация `state` из сети: типы, границы, авторство. */
export function isValidState(value: unknown, from: string): value is StateData {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const data = value as Record<string, unknown>;
  if (typeof data.playing !== 'boolean') {
    return false;
  }
  if (typeof data.t !== 'number' || !Number.isFinite(data.t) || data.t < 0) {
    return false;
  }
  if (typeof data.rate !== 'number' || !Number.isFinite(data.rate)) {
    return false;
  }
  if (typeof data.seq !== 'number' || !Number.isInteger(data.seq) || data.seq < 0) {
    return false;
  }
  if (typeof data.by !== 'string' || data.by !== from) {
    return false;
  }
  const src = data.src;
  if (typeof src !== 'object' || src === null) {
    return false;
  }
  const source = src as Record<string, unknown>;
  if (source.mode !== 'site' && source.mode !== 'local') {
    return false;
  }
  if (typeof source.duration !== 'number' || !Number.isFinite(source.duration) || source.duration < 0) {
    return false;
  }
  if (source.url !== undefined && typeof source.url !== 'string') {
    return false;
  }
  if (source.fileName !== undefined && typeof source.fileName !== 'string') {
    return false;
  }
  if (source.size !== undefined && typeof source.size !== 'number') {
    return false;
  }
  return true;
}

export function stateFromSample(
  sample: PlaybackSample,
  source: PlaybackSource,
  seq: number,
  by: string,
): PlaybackState {
  return {
    playing: sample.playing,
    t: sample.time,
    rate: clampRate(sample.rate),
    src: source,
    seq,
    by,
  };
}

/** Событие page-hook → действие комнаты. `remote-*` не транслируется. */
export function actionFromVideoEvent(
  event: string,
  data: { time?: unknown; rate?: unknown; duration?: unknown },
): PlaybackAction | null {
  const time =
    typeof data.time === 'number' && Number.isFinite(data.time) ? Math.max(0, data.time) : 0;
  switch (event) {
    case 'play':
      return { kind: 'play' };
    case 'pause':
      return { kind: 'pause' };
    case 'seeked':
      return { kind: 'seek', t: time };
    case 'ratechange': {
      const rate = typeof data.rate === 'number' ? clampRate(data.rate) : 1;
      return { kind: 'rate', rate };
    }
    case 'ended': {
      const duration =
        typeof data.duration === 'number' && Number.isFinite(data.duration)
          ? Math.max(0, data.duration)
          : time;
      return { kind: 'pause', t: duration };
    }
    default:
      return null;
  }
}
