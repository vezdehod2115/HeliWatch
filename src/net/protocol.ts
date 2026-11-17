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
export const ROOM_LIMIT_MIN = 2;
export const ROOM_LIMIT_MAX = 6;
/** Название комнаты в карточке лобби (§4.8, этап 6). */
export const ROOM_TITLE_MAX = 48;
/** Пароль комнаты — ключ сигналинга и то, что хост проверяет в join (§4.2). */
export const ROOM_PASSWORD_MIN = 4;
export const ROOM_PASSWORD_MAX = 64;

/** Лобби — отдельная trystero-комната, карточки открытых комнат (§4.8). */
export const LOBBY_ROOM_ID = 'heliwatch-lobby-v1';
/** Карточка живёт 70 секунд без announce (TTL), announce — раз в 25 ± 5 с. */
export const LOBBY_CARD_TTL_MS = 70_000;
export const LOBBY_ANNOUNCE_MS = 25_000;
export const LOBBY_ANNOUNCE_JITTER_MS = 5_000;
/** Антиспам: не чаще одной публикации карточки в 5 секунд на хост. */
export const LOBBY_PUBLISH_MIN_GAP_MS = 5_000;
/** Ответ хоста на lobby-probe — не чаще раза в секунду. */
export const LOBBY_PROBE_MIN_GAP_MS = 1_000;

/** Стрим файла хоста (§4.1, этап 5): 1–2 зрителя, всего до 3 участников. */
export const STREAM_MAX_VIEWERS = 2;
export const STREAM_ROOM_LIMIT = STREAM_MAX_VIEWERS + 1;
/** Имя файла в state/stream-start: только для интерфейса, не для доступа. */
export const STREAM_FILE_NAME_MAX = 200;
/** Канвас-фоллбэк рисует не шире 1280 px по длинной стороне. */
export const STREAM_CAPTURE_MAX_SIDE = 1280;
export const STREAM_CAPTURE_FPS = 30;

/** Лимит комнаты зависит от режима: в B больше двух зрителей не подключаем. */
export function roomLimitForMode(mode: RoomMode): number {
  return mode === 'stream' ? STREAM_ROOM_LIMIT : ROOM_LIMIT_DEFAULT;
}

/** Nonce живёт 60 секунд и гасится после использования (§4.4 плана). */
export const NONCE_TTL_MS = 60_000;

/**
 * Режимы §4.1: `site` — A (сайт/стриминг), `stream` — B (файл хоста раздаётся
 * зрителям), `local` — C (у каждого свой файл, синхронизируется время).
 */
export type RoomMode = 'site' | 'local' | 'stream';
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
  /** Имя файла для режима B (у хоста) или C — только для интерфейса. */
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
  /**
   * SHA-256 пароля комнаты (§4.2, этап 6). Пароль дополнительно входит в
   * идентификатор сигналинга, поэтому без него гость не найдёт хост вообще.
   */
  pwHash?: string;
}

/** Хост меняет карточку комнаты; сообщение подписывается (§4.3). */
export interface RoomMetaPayload {
  title?: string;
  limit?: number;
  closed?: boolean;
  knock?: boolean;
}

/** `kick`/`ban` (§4.3, этап 6): цель, причина и срок для бана. */
export interface KickPayload {
  target: string;
  reason?: string;
  /** Для бана: timestamp окончания; отсутствует — навсегда. */
  until?: number;
}

/** `mute-request`: хост просит участника выключить микрофон. */
export interface MuteRequestPayload {
  target: string;
}

/** `host-transfer`: подписанное назначение нового хоста. */
export interface HostTransferPayload {
  target: string;
  epoch: number;
}

/** `host-claim`: новый хост объявляет эпоху (в том числе после ухода хоста). */
export interface HostClaimPayload {
  epoch: number;
}

/** `join-accept` / `join-deny` (§4.2): ответ хоста на «стук». */
export interface JoinDecisionPayload {
  reason?: string;
}

/**
 * Карточка комнаты в лобби (§4.8). Закрытая комната (`closed`) в лобби не
 * публикуется вовсе — она открывается только по коду.
 */
export interface LobbyCard {
  code: string;
  title: string;
  mode: RoomMode;
  closed: boolean;
  limit: number;
  count: number;
  hasPassword: boolean;
  /** Комната пускает только после подтверждения хостом («стук»). */
  knock?: boolean;
  hostUserId: string;
  updatedAt: number;
}

/** `lobby-announce` / `lobby-update` / `lobby-remove` несут одну карточку. */
export interface LobbyCardPayload {
  card: LobbyCard;
}

/**
 * Пароль как ключ сигналинга: комната с паролем живёт в trystero-комнате,
 * производной от кода и пароля. Без пароля гость не найдёт хост в сигналинге,
 * даже зная код.
 */
export async function signalingRoomId(
  code: string,
  password?: string | null,
): Promise<string> {
  const normalized = normalizePassword(password);
  if (!normalized) {
    return code;
  }
  const digest = await sha256Base64Url(`heliwatch/sig/v1/${code}\n${normalized}`);
  return `${code}-${digest.slice(0, 12)}`;
}

/** Хеш пароля для `join`: привязываем к коду, чтобы хеш нельзя было перенести. */
export async function passwordHash(code: string, password: string): Promise<string> {
  return sha256Base64Url(`heliwatch/pw/v1/${code}\n${password}`);
}

/** Пароль без внешних пробелов; слишком короткий/длинный — не пароль. */
export function normalizePassword(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') {
    return null;
  }
  const trimmed = raw.trim();
  if (trimmed.length < ROOM_PASSWORD_MIN || trimmed.length > ROOM_PASSWORD_MAX) {
    return null;
  }
  return trimmed;
}

export async function sha256Base64Url(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(text),
  );
  const bytes = new Uint8Array(digest);
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

/** Название комнаты: обрезаем пробелы и длину, пустое — дефолт. */
export function normalizeRoomTitle(raw: string | null | undefined, code: string): string {
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  if (!trimmed) {
    return `Комната ${code}`;
  }
  return trimmed.slice(0, ROOM_TITLE_MAX);
}

export function normalizeRoomLimit(limit: unknown, mode: RoomMode): number {
  const fallback = roomLimitForMode(mode);
  if (mode === 'stream') {
    // В режиме B лимит жёстко 3: канал мобильного хоста (§4.1).
    return fallback;
  }
  if (typeof limit !== 'number' || !Number.isInteger(limit)) {
    return fallback;
  }
  return Math.min(ROOM_LIMIT_MAX, Math.max(ROOM_LIMIT_MIN, limit));
}

export function isRoomMetaPayload(value: unknown): value is RoomMetaPayload {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const data = value as Record<string, unknown>;
  if (
    data.title === undefined &&
    data.limit === undefined &&
    data.closed === undefined &&
    data.knock === undefined
  ) {
    return false;
  }
  if (
    data.title !== undefined &&
    (typeof data.title !== 'string' ||
      data.title.trim().length === 0 ||
      data.title.length > ROOM_TITLE_MAX)
  ) {
    return false;
  }
  if (
    data.limit !== undefined &&
    (typeof data.limit !== 'number' ||
      !Number.isInteger(data.limit) ||
      data.limit < ROOM_LIMIT_MIN ||
      data.limit > ROOM_LIMIT_MAX)
  ) {
    return false;
  }
  if (data.closed !== undefined && typeof data.closed !== 'boolean') {
    return false;
  }
  if (data.knock !== undefined && typeof data.knock !== 'boolean') {
    return false;
  }
  return true;
}

export function isKickPayload(value: unknown): value is KickPayload {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const data = value as Record<string, unknown>;
  if (typeof data.target !== 'string' || data.target.length === 0) {
    return false;
  }
  if (data.reason !== undefined && typeof data.reason !== 'string') {
    return false;
  }
  if (data.until !== undefined) {
    if (typeof data.until !== 'number' || !Number.isFinite(data.until) || data.until < 0) {
      return false;
    }
  }
  return true;
}

export function isMuteRequestPayload(value: unknown): value is MuteRequestPayload {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>).target === 'string' &&
    ((value as Record<string, unknown>).target as string).length > 0
  );
}

export function isHostTransferPayload(value: unknown): value is HostTransferPayload {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const data = value as Record<string, unknown>;
  return (
    typeof data.target === 'string' &&
    data.target.length > 0 &&
    typeof data.epoch === 'number' &&
    Number.isInteger(data.epoch) &&
    data.epoch > 0
  );
}

export function isHostClaimPayload(value: unknown): value is HostClaimPayload {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>).epoch === 'number' &&
    Number.isInteger((value as Record<string, unknown>).epoch as number) &&
    ((value as Record<string, unknown>).epoch as number) > 0
  );
}

export function isJoinDecisionPayload(value: unknown): value is JoinDecisionPayload {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const data = value as Record<string, unknown>;
  return data.reason === undefined || typeof data.reason === 'string';
}

export function isLobbyCard(value: unknown): value is LobbyCard {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const data = value as Record<string, unknown>;
  if (typeof data.code !== 'string' || normalizeRoomCode(data.code) !== data.code) {
    return false;
  }
  if (
    typeof data.title !== 'string' ||
    data.title.trim().length === 0 ||
    data.title.length > ROOM_TITLE_MAX
  ) {
    return false;
  }
  if (data.mode !== 'site' && data.mode !== 'local' && data.mode !== 'stream') {
    return false;
  }
  if (typeof data.closed !== 'boolean' || typeof data.hasPassword !== 'boolean') {
    return false;
  }
  if (data.knock !== undefined && typeof data.knock !== 'boolean') {
    return false;
  }
  if (
    typeof data.limit !== 'number' ||
    !Number.isInteger(data.limit) ||
    data.limit < ROOM_LIMIT_MIN ||
    data.limit > ROOM_LIMIT_MAX
  ) {
    return false;
  }
  if (
    typeof data.count !== 'number' ||
    !Number.isInteger(data.count) ||
    data.count < 1 ||
    data.count > data.limit
  ) {
    return false;
  }
  if (
    typeof data.hostUserId !== 'string' ||
    data.hostUserId.length === 0 ||
    data.hostUserId.length > 512
  ) {
    return false;
  }
  if (
    typeof data.updatedAt !== 'number' ||
    !Number.isFinite(data.updatedAt) ||
    data.updatedAt <= 0
  ) {
    return false;
  }
  return true;
}

export function isLobbyCardPayload(value: unknown): value is LobbyCardPayload {
  return (
    typeof value === 'object' &&
    value !== null &&
    isLobbyCard((value as Record<string, unknown>).card)
  );
}

/**
 * Участник для выборов нового хоста после ухода текущего (§4.5, этап 6).
 * `joinedAt` намеренно не используется: он приходит с часов хоста и у гостей
 * расходится, поэтому выборы были бы недетерминированными. Порядок по userId
 * (лексикографически) одинаков у всех участников и не зависит от часов.
 */
export function pickSuccessor(
  members: ReadonlyArray<{ userId: string; host: boolean }>,
): string | null {
  const candidates = members
    .filter((member) => !member.host && member.userId.length > 0)
    .map((member) => member.userId)
    .sort();
  return candidates[0] ?? null;
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

/**
 * Как хост захватил кадр: прямой `video.captureStream()` или фоллбэк
 * canvas + WebAudio (§2.3, этап 5). Поле нужно зрителю для диагностики.
 */
export type StreamCaptureKind = 'direct' | 'canvas';

/** `stream-start` (§4.3): хост начал раздавать файл. */
export interface StreamStartData {
  fileName?: string;
  /** Хеш файла, если хост смог его посчитать: сейчас не обязателен. */
  videoHash?: string;
  duration?: number;
  /** Максимум зрителей, которых принимает хост (1–2 по §4.1). */
  maxViewers: number;
  capture: StreamCaptureKind;
}

/** `stream-stop` (§4.3): раздача окончена; зритель показывает заглушку. */
export interface StreamStopData {
  reason?: 'host-stop' | 'error' | 'ended';
}

/** `capability` (§4.3): может ли хост вообще захватывать видео. */
export interface CapabilityData {
  canCapture: boolean;
  maxViewers: number;
  capture?: StreamCaptureKind;
  videoHash?: string;
}

export function isStreamCaptureKind(value: unknown): value is StreamCaptureKind {
  return value === 'direct' || value === 'canvas';
}

export function isStreamStartData(value: unknown): value is StreamStartData {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const data = value as Record<string, unknown>;
  if (
    typeof data.maxViewers !== 'number' ||
    !Number.isInteger(data.maxViewers) ||
    data.maxViewers < 1 ||
    data.maxViewers > STREAM_MAX_VIEWERS
  ) {
    return false;
  }
  if (!isStreamCaptureKind(data.capture)) {
    return false;
  }
  if (
    data.fileName !== undefined &&
    (typeof data.fileName !== 'string' || data.fileName.length > STREAM_FILE_NAME_MAX)
  ) {
    return false;
  }
  if (
    data.videoHash !== undefined &&
    (typeof data.videoHash !== 'string' || data.videoHash.length > 128)
  ) {
    return false;
  }
  if (
    data.duration !== undefined &&
    (typeof data.duration !== 'number' || !Number.isFinite(data.duration) || data.duration < 0)
  ) {
    return false;
  }
  return true;
}

export function isStreamStopData(value: unknown): value is StreamStopData {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const data = value as Record<string, unknown>;
  return (
    data.reason === undefined ||
    data.reason === 'host-stop' ||
    data.reason === 'error' ||
    data.reason === 'ended'
  );
}

export function isCapabilityData(value: unknown): value is CapabilityData {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const data = value as Record<string, unknown>;
  if (typeof data.canCapture !== 'boolean') {
    return false;
  }
  if (
    typeof data.maxViewers !== 'number' ||
    !Number.isInteger(data.maxViewers) ||
    data.maxViewers < 0 ||
    data.maxViewers > STREAM_MAX_VIEWERS
  ) {
    return false;
  }
  if (data.capture !== undefined && !isStreamCaptureKind(data.capture)) {
    return false;
  }
  if (
    data.videoHash !== undefined &&
    (typeof data.videoHash !== 'string' || data.videoHash.length > 128)
  ) {
    return false;
  }
  return true;
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

// ---------- Чат комнаты, реакции и фото (§4.3, §4.7) ----------

/** Лимит текста сообщения из §4.7. */
export const CHAT_MAX_LENGTH = 4000;
/** Антифлуд отправителя: не чаще одного сообщения в 120 мс. */
export const CHAT_MIN_GAP_MS = 120;
/** Состояние «печатает» живёт 4 секунды без обновления. */
export const TYPING_TTL_MS = 4000;
/** Реакция — одиночный эмодзи (возможны ZWJ-последовательности). */
export const REACTION_MAX_LENGTH = 16;

/** Чанк `hw-blob` — 16 КиБ, как в §4.7. */
export const IMAGE_CHUNK_SIZE = 16 * 1024;
/** После клиентского сжатия фото не больше 2 МБ. */
export const IMAGE_MAX_BYTES = 2 * 1024 * 1024;
export const IMAGE_MAX_SIDE = 1280;
export const IMAGE_PREVIEW_SIDE = 256;
export const IMAGE_QUALITY = 0.8;
export const IMAGE_TIMEOUT_MS = 30_000;
export const IMAGE_MAX_CHUNKS = Math.ceil(IMAGE_MAX_BYTES / IMAGE_CHUNK_SIZE);
export const IMAGE_MIN_BYTES = 64;

export type ImageScope = 'chat' | 'dm' | 'avatar';

export interface ChatPayload {
  text: string;
  replyTo?: string;
}

export interface ReactionPayload {
  emoji: string;
  x?: number;
  y?: number;
}

export interface TypingPayload {
  on: boolean;
}

export interface ImageStartPayload {
  id: string;
  mime: string;
  size: number;
  w: number;
  h: number;
  chunks: number;
  sha256: string;
  scope: ImageScope;
}

export interface ImageChunkPayload {
  id: string;
  i: number;
}

export interface ImageEndPayload {
  id: string;
}

export interface ImageCancelPayload {
  id: string;
  reason?: string;
}

/** Сообщение чата в том виде, в котором его показывает интерфейс. */
export type ChatKind = 'text' | 'image';

export interface ChatMessage {
  id: string;
  /** userId автора. */
  from: string;
  name: string;
  color: string;
  ts: number;
  kind: ChatKind;
  text?: string;
  replyTo?: string;
  imageId?: string;
  imageW?: number;
  imageH?: number;
  /** Своё сообщение: показываем справа и без подписи. */
  self?: boolean;
  /** Фото ещё передаётся. */
  pending?: boolean;
  /** Доставка сорвалась — можно повторить. */
  failed?: boolean;
}

export function imageChunkCount(size: number): number {
  if (!Number.isFinite(size) || size <= 0) {
    return 0;
  }
  return Math.ceil(size / IMAGE_CHUNK_SIZE);
}

/**
 * Текст сообщения: обрезаем пробелы, выкидываем управляющие символы и
 * ограничиваем длину. Пустой текст — null (отправлять нечего).
 */
export function normalizeChatText(raw: string): string | null {
  const cleaned = raw
    .replace(/\r\n/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!cleaned) {
    return null;
  }
  return cleaned.slice(0, CHAT_MAX_LENGTH);
}

/**
 * Эмодзи-последовательность: пиктограммы, variation selector, ZWJ и модификаторы
 * тона кожи. Буквы и цифры запрещены — реакцией нельзя прислать текст.
 */
export function isEmojiSequence(value: string): boolean {
  if (!value || value.length > REACTION_MAX_LENGTH * 4) {
    return false;
  }
  // В флагах нет Extended_Pictographic — только Regional_Indicator.
  if (!/[\p{Extended_Pictographic}\p{Regional_Indicator}]/u.test(value)) {
    return false;
  }
  return /^(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|\uFE0F|\u200D|[\u{1F3FB}-\u{1F3FF}])+$/u.test(
    value,
  );
}

export function isChatPayload(value: unknown): value is ChatPayload {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const data = value as Record<string, unknown>;
  if (typeof data.text !== 'string' || data.text.length === 0) {
    return false;
  }
  if (data.text.length > CHAT_MAX_LENGTH) {
    return false;
  }
  if (data.replyTo !== undefined && typeof data.replyTo !== 'string') {
    return false;
  }
  return true;
}

export function isReactionPayload(value: unknown): value is ReactionPayload {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const data = value as Record<string, unknown>;
  if (typeof data.emoji !== 'string' || !isEmojiSequence(data.emoji)) {
    return false;
  }
  for (const key of ['x', 'y'] as const) {
    const coordinate = data[key];
    if (coordinate !== undefined && (typeof coordinate !== 'number' || !Number.isFinite(coordinate))) {
      return false;
    }
  }
  return true;
}

export function isTypingPayload(value: unknown): value is TypingPayload {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>).on === 'boolean'
  );
}

export function isImageStartPayload(value: unknown): value is ImageStartPayload {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const data = value as Record<string, unknown>;
  if (typeof data.id !== 'string' || data.id.length < 8 || data.id.length > 64) {
    return false;
  }
  if (typeof data.mime !== 'string' || !/^image\/(png|jpeg|webp)$/.test(data.mime)) {
    return false;
  }
  if (
    typeof data.size !== 'number' ||
    !Number.isInteger(data.size) ||
    data.size < IMAGE_MIN_BYTES ||
    data.size > IMAGE_MAX_BYTES
  ) {
    return false;
  }
  for (const key of ['w', 'h'] as const) {
    const side = data[key];
    if (typeof side !== 'number' || !Number.isInteger(side) || side < 1 || side > 8192) {
      return false;
    }
  }
  if (
    typeof data.chunks !== 'number' ||
    !Number.isInteger(data.chunks) ||
    data.chunks !== imageChunkCount(data.size) ||
    data.chunks > IMAGE_MAX_CHUNKS
  ) {
    return false;
  }
  if (typeof data.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(data.sha256)) {
    return false;
  }
  if (data.scope !== 'chat' && data.scope !== 'dm' && data.scope !== 'avatar') {
    return false;
  }
  return true;
}

export function isImageChunkPayload(value: unknown): value is ImageChunkPayload {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const data = value as Record<string, unknown>;
  return (
    typeof data.id === 'string' &&
    data.id.length >= 8 &&
    typeof data.i === 'number' &&
    Number.isInteger(data.i) &&
    data.i >= 0 &&
    data.i < IMAGE_MAX_CHUNKS
  );
}

export function isImageEndPayload(value: unknown): value is ImageEndPayload {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>).id === 'string'
  );
}

export function isImageCancelPayload(value: unknown): value is ImageCancelPayload {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const data = value as Record<string, unknown>;
  if (typeof data.id !== 'string') {
    return false;
  }
  if (data.reason !== undefined && typeof data.reason !== 'string') {
    return false;
  }
  return true;
}

// ---------- Друзья и личные сообщения (этап 7) ----------

/** Текст личного сообщения — тот же предел, что и у чата комнаты (§4.7). */
export const DM_TEXT_MAX = CHAT_MAX_LENGTH;
/** Записка к заявке в друзья: короткая, чтобы не превращалась в чат. */
export const FRIEND_NOTE_MAX = 120;
/** Ссылка-приглашение в друзья: `heliwatch://f/<userId>`. */
export const FRIEND_LINK_PREFIX = 'heliwatch://f/';
/** userId — base64url(SPKI DER P-256); короче 60 символов не бывает. */
export const USER_ID_MIN = 60;
export const USER_ID_MAX = 200;
/** Пачка outbox за одно рукопожатие: больше не нужно, канал не резиновый. */
export const DM_OUTBOX_MAX = 50;

/** Карточка человека в friend-request / friend-accept. */
export interface FriendCard {
  name: string;
  color: string;
  avatarHash?: string;
}

export interface FriendRequestPayload extends FriendCard {
  note?: string;
}

export type FriendAcceptPayload = FriendCard;

/** `dm-message` (§4.3): текст или ссылка на уже переданное фото. */
export interface DmMessagePayload {
  msgId: string;
  kind: 'text' | 'image';
  text?: string;
  imageId?: string;
  ts: number;
}

export interface DmAckPayload {
  msgId: string;
  ts?: number;
}

/** `dm-outbox-sync`: «есть ли у тебя эти сообщения?» — ids, которые ждут ack. */
export interface DmOutboxSyncPayload {
  ids: string[];
}

/**
 * `dm-outbox-offer`: недоставленные подписанные конверты. Получатель проверяет
 * подпись каждого и не доверяет отправителю канала на слово (§4.4).
 */
export interface DmOutboxOfferPayload {
  messages: Envelope[];
}

export function isUserId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= USER_ID_MIN &&
    value.length <= USER_ID_MAX &&
    /^[A-Za-z0-9_-]+$/.test(value)
  );
}

export function isFriendCard(value: unknown): value is FriendCard {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const data = value as Record<string, unknown>;
  if (typeof data.name !== 'string') {
    return false;
  }
  const name = data.name.trim();
  if (name.length < 1 || name.length > 24) {
    return false;
  }
  if (typeof data.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(data.color)) {
    return false;
  }
  if (
    data.avatarHash !== undefined &&
    (typeof data.avatarHash !== 'string' || data.avatarHash.length > 128)
  ) {
    return false;
  }
  return true;
}

export function isFriendRequestPayload(value: unknown): value is FriendRequestPayload {
  if (!isFriendCard(value)) {
    return false;
  }
  const note = (value as FriendRequestPayload).note;
  return note === undefined || (typeof note === 'string' && note.length <= FRIEND_NOTE_MAX);
}

export function isDmMessagePayload(value: unknown): value is DmMessagePayload {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const data = value as Record<string, unknown>;
  if (typeof data.msgId !== 'string' || data.msgId.length < 10 || data.msgId.length > 64) {
    return false;
  }
  if (typeof data.ts !== 'number' || !Number.isFinite(data.ts) || data.ts <= 0) {
    return false;
  }
  if (data.kind === 'text') {
    return (
      typeof data.text === 'string' &&
      data.text.trim().length > 0 &&
      data.text.length <= DM_TEXT_MAX &&
      data.imageId === undefined
    );
  }
  if (data.kind === 'image') {
    return (
      typeof data.imageId === 'string' &&
      data.imageId.length >= 8 &&
      data.imageId.length <= 64 &&
      data.text === undefined
    );
  }
  return false;
}

export function isDmAckPayload(value: unknown): value is DmAckPayload {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const data = value as Record<string, unknown>;
  if (typeof data.msgId !== 'string' || data.msgId.length < 10 || data.msgId.length > 64) {
    return false;
  }
  return data.ts === undefined || (typeof data.ts === 'number' && Number.isFinite(data.ts));
}

export function isDmOutboxSyncPayload(value: unknown): value is DmOutboxSyncPayload {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const ids = (value as Record<string, unknown>).ids;
  return (
    Array.isArray(ids) &&
    ids.length <= DM_OUTBOX_MAX &&
    ids.every((id) => typeof id === 'string' && id.length >= 10 && id.length <= 64)
  );
}

export function isDmOutboxOfferPayload(value: unknown): value is DmOutboxOfferPayload {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const messages = (value as Record<string, unknown>).messages;
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > DM_OUTBOX_MAX) {
    return false;
  }
  return messages.every(
    (item) => isEnvelope(item) && typeof (item as Envelope).sig === 'string',
  );
}

/** Ссылка-приглашение в друзья: тот же формат deep link, что и у комнаты. */
export function friendInviteLink(userId: string): string {
  return `${FRIEND_LINK_PREFIX}${userId}`;
}

/**
 * Принимает ссылку `heliwatch://f/<userId>` (в том числе вставленную внутри
 * текста мессенджера) или сам userId. Возвращает userId либо null.
 */
export function parseFriendInput(raw: string): string | null {
  const value = raw.trim();
  if (!value) {
    return null;
  }
  const match = value.match(/heliwatch:\/\/f\/([A-Za-z0-9_-]{60,200})/i);
  if (match?.[1] && isUserId(match[1])) {
    return match[1];
  }
  const compact = value.replace(/\s+/g, '');
  return isUserId(compact) ? compact : null;
}

/**
 * Идентификатор парной комнаты друзей (§4.8): фиксированный для пары,
 * не зависит от того, кто открыл её первым. `dm-<hash>` вместо `dm:` — чтобы
 * не спорить с разделителями релеев, смысл тот же.
 */
export async function pairRoomId(left: string, right: string): Promise<string> {
  const [first, second] = [left, right].sort();
  const digest = await sha256Base64Url(`heliwatch/dm/v1\n${first}\n${second}`);
  return `dm-${digest.slice(0, 24)}`;
}

/**
 * Комната ожидания приглашения: ссылка знает только userId пригласившего,
 * поэтому комната производна от него. Кто открыл ссылку — подключается сюда.
 */
export async function inviteRoomId(userId: string): Promise<string> {
  const digest = await sha256Base64Url(`heliwatch/invite/v1\n${userId}`);
  return `invite-${digest.slice(0, 24)}`;
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
  if (source.mode !== 'site' && source.mode !== 'local' && source.mode !== 'stream') {
    return false;
  }
  if (typeof source.duration !== 'number' || !Number.isFinite(source.duration) || source.duration < 0) {
    return false;
  }
  if (source.url !== undefined && typeof source.url !== 'string') {
    return false;
  }
  if (
    source.fileName !== undefined &&
    (typeof source.fileName !== 'string' || source.fileName.length > STREAM_FILE_NAME_MAX)
  ) {
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
