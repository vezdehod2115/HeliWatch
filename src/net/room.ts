/*
 * Комната HeliWatch: nonce-аутентификация (§4.2), подписи join/welcome (§4.4),
 * синхронизация состояния (§4.5) и автопереподключение (§4.8).
 *
 * RoomClient не знает ни про сайт, ни про <video>: он принимает/отдаёт
 * PlaybackAction и PlaybackSample, а применяет их UI (RoomScreen). Транспорт —
 * интерфейс Channel, поэтому протокол тестируется в Node фейковым каналом.
 */

import {
  CommandRateLimiter,
  planCorrection,
} from './sync';
import type { Identity } from './identity';
import { publicKeyMatchesUserId, signEnvelope, verifyEnvelope } from './identity';
import {
  CHAT_MAX_LENGTH,
  CHAT_MIN_GAP_MS,
  PROTOCOL_VERSION,
  ROOM_LIMIT_DEFAULT,
  ROOM_LIMIT_MAX,
  ROOM_LIMIT_MIN,
  createEnvelope,
  createNonce,
  createUlid,
  isCapabilityData,
  isChatPayload,
  isEmojiSequence,
  isEnvelope,
  isHostClaimPayload,
  isHostTransferPayload,
  isImageCancelPayload,
  isImageEndPayload,
  isKickPayload,
  isMuteRequestPayload,
  isNonceFresh,
  isReactionPayload,
  isRoomMetaPayload,
  isStateRefresh,
  isStreamStartData,
  isStreamStopData,
  isTypingPayload,
  isValidState,
  normalizeChatText,
  normalizePassword,
  normalizeRoomCode,
  normalizeRoomLimit,
  normalizeRoomTitle,
  passwordHash,
  pickSuccessor,
  sampleFromState,
  shouldApplyState,
  signalingRoomId,
  stateFromSample,
  type ByeData,
  type CapabilityData,
  type ChatMessage,
  type Envelope,
  type HelloData,
  type HostClaimPayload,
  type HostTransferPayload,
  type ImageScope,
  type JoinData,
  type KickPayload,
  type MemberInfo,
  type MuteRequestPayload,
  type PlaybackAction,
  type PlaybackSample,
  type PlaybackSource,
  type PlaybackState,
  type ProfilePayload,
  type ReactionPayload,
  type RoomMeta,
  type RoomMetaPayload,
  type RoomMode,
  type RoomRole,
  type SiteUrlData,
  type StateVersion,
  type StreamStartData,
  type StreamStopData,
  type TypingPayload,
  type WelcomeData,
} from './protocol';
import type { Channel } from './transport';
import {
  ImageReceiver,
  sendImage,
  type BlobTransport,
  type ImageTransferInfo,
  type SendImageResult,
} from './blobs';
import { STRATEGIES, type StrategyId } from './trystero';

export type RoomPhase =
  | 'connecting'
  | 'waiting'
  | 'joined'
  | 'reconnecting'
  | 'closed'
  | 'error';

/** «Стук»: гость прошёл проверку подписи и ждёт решения хоста (§4.2, этап 6). */
export interface JoinRequestInfo {
  userId: string;
  peerId: string;
  name: string;
  color: string;
  at: number;
}

export type RoomEvent =
  | { type: 'phase'; phase: RoomPhase; message?: string }
  | { type: 'strategy'; strategy: string; relays: number }
  | { type: 'members'; members: MemberInfo[] }
  | {
      type: 'joined';
      meta: RoomMeta;
      members: MemberInfo[];
      hostUserId: string;
      state: PlaybackState;
    }
  | { type: 'meta'; meta: RoomMeta }
  | { type: 'host-changed'; hostUserId: string; epoch: number; self: boolean }
  | { type: 'join-request'; request: JoinRequestInfo }
  | {
      type: 'join-decision';
      accepted: boolean;
      userId: string;
      name: string;
      reason?: string;
    }
  | { type: 'moderation'; action: 'kick' | 'ban'; userId: string; name: string; until?: number }
  | { type: 'kicked'; reason: 'kicked' | 'banned'; by: string; until?: number }
  | { type: 'mute-request'; by: string; name: string }
  | { type: 'state'; state: PlaybackState; receivedAt: number; drift: number | null }
  | { type: 'command'; action: PlaybackAction; from: string }
  | { type: 'correction'; action: PlaybackAction }
  | { type: 'site-url'; url: string }
  | { type: 'hint'; message: string | null }
  | { type: 'chat'; message: ChatMessage }
  | { type: 'reaction'; from: string; name: string; emoji: string; x?: number; y?: number }
  | { type: 'typing'; from: string; name: string; on: boolean }
  | { type: 'image-start'; info: ImageTransferInfo }
  | { type: 'image-progress'; info: ImageTransferInfo }
  | {
      type: 'image';
      id: string;
      from: string;
      name: string;
      color: string;
      mime: string;
      w: number;
      h: number;
      ts: number;
      bytes: Uint8Array;
    }
  | { type: 'image-error'; id: string; reason: string }
  | { type: 'voice-stream'; peerId: string; userId: string | null; stream: MediaStream }
  | {
      type: 'screen-stream';
      peerId: string;
      userId: string | null;
      stream: MediaStream;
    }
  | { type: 'stream-start'; info: StreamStartData }
  | { type: 'stream-stop'; reason: string }
  | { type: 'capability'; capability: CapabilityData }
  | { type: 'peer-left'; peerId: string; userId?: string }
  | { type: 'debug'; peers: number; seq: number; driverId: string | null }
  | { type: 'error'; message: string }
  | { type: 'closed'; reason: string };

export interface RoomClientOptions {
  code: string;
  role: RoomRole;
  mode: RoomMode;
  identity: Identity;
  profile: ProfilePayload;
  /**
   * Второй аргумент — идентификатор trystero-комнаты. Для комнаты с паролем он
   * производный от пароля (§4.8): без пароля гость не найдёт хост в сигналинге.
   */
  connect: (strategy: StrategyId, roomId: string) => Promise<Channel>;
  onEvent: (event: RoomEvent) => void;
  initialUrl?: string;
  now?: () => number;
  /** Таймеры выключаются в тестах, чтобы процесс завершался сразу. */
  autoTimers?: boolean;
  /** Настройки комнаты, которые задаёт хост при создании (этап 6). */
  meta?: Partial<Pick<RoomMeta, 'title' | 'limit' | 'closed' | 'knock'>>;
  /** Пароль комнаты: ключ сигналинга и проверка в join. */
  password?: string | null;
  /** Хост сверяет локальный бан-лист перед входом гостя. */
  isBanned?: (userId: string) => boolean | Promise<boolean>;
}

interface PeerAuth {
  peerId: string;
  userId?: string;
  pub?: JsonWebKey;
  /** Nonce, который пир прислал в своём hello (для подписи welcome). */
  remoteNonce?: string;
  remoteNonceAt?: number;
  /** Nonce, который мы прислали этому пиру (проверка его join). */
  localNonce?: string;
  localNonceAt?: number;
  localNonceUsed?: boolean;
  host: boolean;
  joined: boolean;
  /** Прошёл подпись, но ждёт решения хоста («стук»). */
  pending?: boolean;
  profile?: ProfilePayload;
  joinedAt?: number;
  limiter: CommandRateLimiter;
  /** Чат и реакции: защита от флуда от одного пира. */
  chatLimiter: CommandRateLimiter;
}

const MAX_SEEN_IDS = 128;
const CONNECT_CHECK_MS = 8000;
const MONITOR_MS = 4000;
const HEARTBEAT_MS = 5000;
const RECONNECT_BASE_MS = 2000;
const RECONNECT_MAX_MS = 60_000;
const CONNECT_HINT_MS = 12_000;
/** Чат и реакции: 12 сообщений за 5 секунд от одного пира — предел. */
const SOCIAL_MESSAGES_PER_WINDOW = 12;
const SOCIAL_WINDOW_MS = 5000;
/** Пауза между своими сообщениями: защита от случайного даблтапа (§4.7). */
const SELF_CHAT_GAP_MS = CHAT_MIN_GAP_MS;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function validProfile(value: unknown): ProfilePayload | null {
  if (!isRecord(value)) {
    return null;
  }
  const name = typeof value.name === 'string' ? value.name.trim() : '';
  const color = typeof value.color === 'string' ? value.color : '';
  if (name.length < 1 || name.length > 24 || !/^#[0-9a-f]{6}$/i.test(color)) {
    return null;
  }
  const avatarHash =
    typeof value.avatarHash === 'string' && value.avatarHash.length <= 128
      ? value.avatarHash
      : undefined;
  return avatarHash ? { name, color, avatarHash } : { name, color };
}

function validPublicJwk(value: unknown): value is JsonWebKey {
  if (!isRecord(value)) {
    return false;
  }
  return (
    value.kty === 'EC' &&
    value.crv === 'P-256' &&
    typeof value.x === 'string' &&
    value.x.length <= 128 &&
    typeof value.y === 'string' &&
    value.y.length <= 128
  );
}

function validUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) {
    return false;
  }
  return /^(https?|file):\/\//i.test(value);
}

function actionFromMessage(
  type: string,
  data: unknown,
): PlaybackAction | null {
  if (type === 'play') {
    return { kind: 'play' };
  }
  if (type === 'pause') {
    return { kind: 'pause' };
  }
  if (!isRecord(data)) {
    return null;
  }
  if (type === 'seek') {
    const time = typeof data.t === 'number' ? data.t : Number.NaN;
    return Number.isFinite(time) && time >= 0 ? { kind: 'seek', t: time } : null;
  }
  if (type === 'rate') {
    const rate = typeof data.rate === 'number' ? data.rate : Number.NaN;
    return Number.isFinite(rate) && rate >= 0.25 && rate <= 4
      ? { kind: 'rate', rate }
      : null;
  }
  return null;
}

export class RoomClient {
  readonly code: string;
  readonly role: RoomRole;
  readonly selfUserId: string;

  private readonly identity: Identity;
  private readonly profile: ProfilePayload;
  private readonly connect: (strategy: StrategyId, roomId: string) => Promise<Channel>;
  private readonly emit: (event: RoomEvent) => void;
  private readonly now: () => number;
  private readonly autoTimers: boolean;

  private phaseValue: RoomPhase = 'connecting';
  private channelValue: Channel | null = null;
  private strategyIndex = 0;
  private stopped = false;
  private meta: RoomMeta;
  private stateValue: PlaybackState;
  private version: StateVersion;
  private stateReceivedAt = 0;
  private hostUserId: string | null = null;
  /** Эпоха хоста: растёт при передаче и миграции (§4.5, этап 6). */
  private epochValue = 1;
  private selfPeerId = '';
  private selfJoinedAt = 0;
  private peers = new Map<string, PeerAuth>();
  private members = new Map<string, MemberInfo>();
  /** «Стук»: подпись проверена, ждём решения хоста. */
  private readonly pendingJoins = new Map<string, JoinRequestInfo>();
  private readonly isBanned: (userId: string) => boolean | Promise<boolean>;
  private readonly password: string | null;
  private passwordHashValue = '';
  private seenIds = new Set<string>();
  private queue: Promise<void> = Promise.resolve();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connectCheckTimer: ReturnType<typeof setTimeout> | null = null;
  private monitorTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private hintTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnects = 0;
  private openedAt = 0;
  private hintShown = false;
  private lastLocal: PlaybackSample | null = null;
  private lastCorrectionAt = 0;
  private relayCount = 0;
  /** Микрофон комнаты: переиспользуется при реконнекте без getUserMedia. */
  private voiceStream: MediaStream | null = null;
  private micMutedValue = false;
  private lastChatAt = 0;
  private lastTypingAt = 0;
  /** Отменённые пользователем исходящие фото. */
  private readonly cancelledImages = new Set<string>();
  private readonly images: ImageReceiver;
  /** Исходящий стрим файла хоста: переживает реконнект, как и микрофон. */
  private screenStream: MediaStream | null = null;
  /** Последний stream-start: его получает и поздно подключившийся зритель. */
  private streamInfo: StreamStartData | null = null;
  private streamActive = false;
  private capability: CapabilityData | null = null;
  /** Поток, пришедший раньше welcome: отдаём зрителю после авторизации. */
  private readonly pendingScreens = new Map<string, MediaStream>();

  constructor(options: RoomClientOptions) {
    const code = normalizeRoomCode(options.code);
    if (!code) {
      throw new Error('Некорректный код комнаты');
    }
    this.code = code;
    this.role = options.role;
    this.identity = options.identity;
    this.selfUserId = options.identity.userId;
    this.profile = options.profile;
    this.connect = options.connect;
    this.emit = options.onEvent;
    this.now = options.now ?? (() => Date.now());
    this.autoTimers = options.autoTimers ?? true;
    this.selfJoinedAt = this.now();
    this.openedAt = this.selfJoinedAt;
    this.password = normalizePassword(options.password ?? null);
    this.isBanned = options.isBanned ?? (() => false);
    const limit = normalizeRoomLimit(options.meta?.limit, options.mode);
    this.meta = {
      code,
      title: normalizeRoomTitle(options.meta?.title, code),
      mode: options.mode,
      limit,
      closed: options.meta?.closed === true,
      knock: options.meta?.knock === true,
    };
    if (options.role === 'host') {
      // Хост — авторитет комнаты с самого начала: welcome и проверка join.
      this.hostUserId = this.selfUserId;
    }
    this.stateValue = {
      playing: false,
      t: 0,
      rate: 1,
      src: {
        mode: options.mode,
        url: options.mode === 'site' ? options.initialUrl : undefined,
        duration: 0,
      },
      seq: 0,
      by: this.selfUserId,
    };
    this.version = { seq: 0, by: this.selfUserId };
    this.images = new ImageReceiver({
      onStart: (info) => this.emit({ type: 'image-start', info }),
      onProgress: (info) => this.emit({ type: 'image-progress', info }),
      onComplete: (image) => {
        const peer = this.peers.get(image.fromPeer);
        const userId = peer?.userId ?? '';
        const member = userId ? this.members.get(userId) : undefined;
        this.emit({
          type: 'image',
          id: image.id,
          from: userId,
          name: member?.name ?? peer?.profile?.name ?? 'Друг',
          color: member?.color ?? peer?.profile?.color ?? '#6ff0c4',
          mime: image.mime,
          w: image.w,
          h: image.h,
          ts: this.now(),
          bytes: image.bytes,
        });
      },
      onError: ({ id, reason }) => this.emit({ type: 'image-error', id, reason }),
      onReject: (id, peerId, reason) => this.send('image-cancel', { id, reason }, peerId),
    });
  }

  // ---------- Публичное состояние ----------

  get phase(): RoomPhase {
    return this.phaseValue;
  }

  get playback(): PlaybackState {
    return this.stateValue;
  }

  get hostId(): string | null {
    return this.hostUserId;
  }

  /** Текущий хост — это я. После миграции роль меняется на лету (§4.5). */
  get selfIsHost(): boolean {
    return this.hostUserId !== null && this.hostUserId === this.selfUserId;
  }

  /** Эпоха хоста: защищает от «двух хостов» после передачи и ухода. */
  get epoch(): number {
    return this.epochValue;
  }

  get roomMeta(): RoomMeta {
    return this.meta;
  }

  get memberCount(): number {
    return this.memberList.length;
  }

  get joinRequests(): JoinRequestInfo[] {
    return [...this.pendingJoins.values()];
  }

  get peerCount(): number {
    return this.peers.size;
  }

  get memberList(): MemberInfo[] {
    const self: MemberInfo = {
      userId: this.selfUserId,
      peerId: this.selfPeerId,
      name: this.profile.name,
      color: this.profile.color,
      avatarHash: this.profile.avatarHash,
      joinedAt: this.selfJoinedAt,
      host: this.selfIsHost,
    };
    const all = [self, ...this.members.values()].filter(
      (member, index, list) => list.findIndex((item) => item.userId === member.userId) === index,
    );
    return all.sort((left, right) => {
      if (left.host !== right.host) {
        return left.host ? -1 : 1;
      }
      return left.joinedAt - right.joinedAt;
    });
  }

  /** Идёт ли раздача файла с этого устройства (режим B, этап 5). */
  get streaming(): boolean {
    return this.streamActive;
  }

  get lastStreamInfo(): StreamStartData | null {
    return this.streamInfo;
  }

  // ---------- Запуск и остановка ----------

  async start(): Promise<void> {
    this.stopped = false;
    this.openedAt = this.now();
    if (this.password) {
      // Хеш нужен и хосту (проверка join), и гостю (поле pwHash в join).
      this.passwordHashValue = await passwordHash(this.code, this.password);
    }
    await this.openChannel();
    this.startTimers();
  }

  async stop(reason: 'left' | 'host-left' = 'left'): Promise<void> {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    this.clearTimers();
    if (this.channelValue && this.phaseValue !== 'closed' && this.phaseValue !== 'error') {
      const bye: ByeData = { reason: reason === 'host-left' ? 'host-left' : 'left' };
      const envelope = createEnvelope('bye', bye, this.selfUserId, this.code, {
        now: this.now(),
      });
      this.channelValue.send(envelope);
      // Даём DataChannel пару миллисекунд, чтобы bye ушёл до leave().
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
    this.images.dispose();
    this.screenStream = null;
    this.streamActive = false;
    this.streamInfo = null;
    this.pendingScreens.clear();
    this.disposeChannel();
    this.setPhase('closed');
    this.emit({ type: 'closed', reason });
  }

  /** Дождаться обработки всех входящих сообщений (для тестов). */
  async whenIdle(): Promise<void> {
    await this.queue;
  }

  // ---------- Действия пользователя ----------

  /**
   * Пользователь нажал play/pause/seek/rate: состояние двигает seq и рассылает
   * команду для мгновенного применения у остальных.
   */
  publishAction(action: PlaybackAction, sample: PlaybackSample): void {
    if (!this.canControl()) {
      return;
    }
    const source = this.sourceWithDuration(sample);
    const seq = this.stateValue.seq + 1;
    this.stateValue = stateFromSample(sample, source, seq, this.selfUserId);
    this.version = { seq, by: this.selfUserId };
    this.lastLocal = sample;
    this.sendCommand(action);
    this.sendState();
    this.emitDebug();
  }

  /** «Синхронизировать ко мне»: стать driver'ом и разослать своё состояние. */
  takeover(sample: PlaybackSample): void {
    if (!this.canControl()) {
      return;
    }
    const seq = this.stateValue.seq + 1;
    this.stateValue = stateFromSample(sample, this.sourceWithDuration(sample), seq, this.selfUserId);
    this.version = { seq, by: this.selfUserId };
    this.lastLocal = sample;
    this.sendState();
    this.emitDebug();
  }

  /** Попросить driver'а прислать актуальное состояние. */
  requestResync(): void {
    if (!this.canPublish()) {
      return;
    }
    this.send('resync', {});
  }

  /** Смена источника (URL сайта или выбранный файл). */
  publishSource(source: PlaybackSource, sample: PlaybackSample): void {
    if (!this.canControl()) {
      return;
    }
    const seq = this.stateValue.seq + 1;
    this.stateValue = stateFromSample(
      sample,
      { ...source, duration: sample.duration || source.duration },
      seq,
      this.selfUserId,
    );
    this.version = { seq, by: this.selfUserId };
    this.lastLocal = sample;
    this.sendState();
    this.emitDebug();
  }

  /** Хост сменил URL сайта: state + отдельное сообщение site-url. */
  publishSiteUrl(url: string): void {
    if (!this.selfIsHost || !this.canControl()) {
      return;
    }
    const seq = this.stateValue.seq + 1;
    this.stateValue = {
      ...this.stateValue,
      src: { mode: 'site', url, duration: this.stateValue.src.duration },
      seq,
      by: this.selfUserId,
    };
    this.version = { seq, by: this.selfUserId };
    const data: SiteUrlData = { url };
    this.sendState();
    this.send('site-url', data);
  }

  // ---------- Модерация и настройки комнаты (этап 6) ----------

  /** Хост меняет название, лимит, закрытость и «стук»; сообщение подписано. */
  updateRoomMeta(patch: RoomMetaPayload): boolean {
    if (!this.selfIsHost || !this.canPublish() || !isRoomMetaPayload(patch)) {
      return false;
    }
    const limit =
      patch.limit !== undefined
        ? Math.max(this.memberCount, normalizeRoomLimit(patch.limit, this.meta.mode))
        : this.meta.limit;
    const next: RoomMetaPayload = {
      title: patch.title !== undefined ? normalizeRoomTitle(patch.title, this.code) : undefined,
      limit,
      closed: patch.closed ?? this.meta.closed,
      knock: patch.knock ?? this.meta.knock,
    };
    this.meta = {
      ...this.meta,
      title: next.title ?? this.meta.title,
      limit,
      closed: next.closed === true,
      knock: next.knock === true,
    };
    void this.sendSigned('room-meta', next);
    this.emit({ type: 'meta', meta: this.meta });
    this.emitMembers();
    return true;
  }

  /** Принять «стук»: гость получает welcome и появляется в составе. */
  acceptJoin(userId: string): boolean {
    if (!this.selfIsHost) {
      return false;
    }
    const entry = [...this.pendingJoins.values()].find((item) => item.userId === userId);
    if (!entry) {
      return false;
    }
    const peer = this.peers.get(entry.peerId);
    const profile = peer?.profile;
    if (!peer || !profile) {
      this.pendingJoins.delete(entry.peerId);
      return false;
    }
    if (peer.localNonceUsed || !isNonceFresh(this.now(), peer.localNonceAt ?? 0)) {
      // Пока хост думал, nonce истёк: просим гостя постучаться заново.
      this.denyJoin(userId, 'nonce-expired');
      return false;
    }
    this.send('join-accept', {}, entry.peerId);
    this.pendingJoins.delete(entry.peerId);
    void this.admitJoin(entry.peerId, profile);
    this.emit({ type: 'join-decision', accepted: true, userId, name: entry.name });
    return true;
  }

  /** Отклонить «стук»: гость видит понятную ошибку, а не пустое ожидание. */
  denyJoin(userId: string, reason = 'knock-denied'): boolean {
    if (!this.selfIsHost) {
      return false;
    }
    const entry = [...this.pendingJoins.values()].find((item) => item.userId === userId);
    if (!entry) {
      return false;
    }
    this.send('join-deny', { reason }, entry.peerId);
    const peer = this.peers.get(entry.peerId);
    if (peer) {
      peer.pending = false;
    }
    this.pendingJoins.delete(entry.peerId);
    this.emit({ type: 'join-decision', accepted: false, userId, name: entry.name, reason });
    return true;
  }

  /** Кик: подписанное сообщение всем, участник исчезает из состава. */
  kick(userId: string, reason = 'host-kick'): boolean {
    return this.removeMember(userId, 'kick', { target: userId, reason });
  }

  /** Бан: подписанное сообщение + срок; хост ещё и пишет его в бан-лист. */
  ban(userId: string, reason = 'host-ban', until?: number): boolean {
    const payload: KickPayload = until !== undefined ? { target: userId, reason, until } : { target: userId, reason };
    return this.removeMember(userId, 'ban', payload, until);
  }

  private removeMember(
    userId: string,
    type: 'kick' | 'ban',
    payload: KickPayload,
    until?: number,
  ): boolean {
    if (!this.selfIsHost || !this.canPublish()) {
      return false;
    }
    const member = this.members.get(userId);
    const peer = this.peerForUser(userId);
    if (!member && !peer) {
      return false;
    }
    void this.sendSigned(type, payload);
    this.members.delete(userId);
    if (peer) {
      this.peers.delete(peer.peerId);
      this.pendingScreens.delete(peer.peerId);
    }
    this.emit({
      type: 'moderation',
      action: type === 'ban' ? 'ban' : 'kick',
      userId,
      name: member?.name ?? peer?.profile?.name ?? 'Участник',
      until,
    });
    this.emitMembers();
    this.broadcastWelcome();
    this.emit({
      type: 'peer-left',
      peerId: peer?.peerId ?? member?.peerId ?? '',
      userId,
    });
    this.emitDebug();
    return true;
  }

  /** Попросить участника выключить микрофон (best effort, без подписи). */
  requestMute(userId: string): boolean {
    if (!this.selfIsHost || !this.canPublish()) {
      return false;
    }
    const peer = this.peerForUser(userId);
    if (!peer) {
      return false;
    }
    const payload: MuteRequestPayload = { target: userId };
    this.send('mute-request', payload, peer.peerId);
    return true;
  }

  /** Передать хост другому участнику (только A/C, подписанный host-transfer). */
  transferHost(userId: string): boolean {
    if (!this.selfIsHost || !this.canPublish() || userId === this.selfUserId) {
      return false;
    }
    if (!this.members.has(userId) && !this.peersHasUser(userId)) {
      return false;
    }
    const epoch = this.epochValue + 1;
    const payload: HostTransferPayload = { target: userId, epoch };
    void this.sendSigned('host-transfer', payload);
    this.epochValue = epoch;
    this.hostUserId = userId;
    this.pendingJoins.clear();
    this.emit({
      type: 'host-changed',
      hostUserId: userId,
      epoch,
      self: false,
    });
    this.emitMembers();
    this.emitDebug();
    return true;
  }

  /** Закрыть комнату для всех: подписанный room-meta + bye: closed. */
  closeRoom(): void {
    if (!this.selfIsHost || !this.canPublish()) {
      return;
    }
    this.meta = { ...this.meta, closed: true };
    void this.sendSigned('room-meta', { closed: true } satisfies RoomMetaPayload);
    this.send('bye', { reason: 'closed' } satisfies ByeData);
    this.finish('closed');
  }

  private peerForUser(userId: string): PeerAuth | null {
    for (const peer of this.peers.values()) {
      if (peer.userId === userId) {
        return peer;
      }
    }
    const member = this.members.get(userId);
    return member ? (this.peers.get(member.peerId) ?? null) : null;
  }

  // ---------- Стрим файла хоста (этап 5) ----------

  /** Подключить исходящий видеопоток. Поздние зрители получат его сами. */
  attachScreen(stream: MediaStream): void {
    this.screenStream = stream;
    this.channelValue?.addScreenStream?.(stream);
  }

  /** Остановить раздачу на транспорте, не трогая сами треки. */
  detachScreen(): void {
    const stream = this.screenStream;
    this.screenStream = null;
    if (stream) {
      this.channelValue?.removeScreenStream?.(stream);
    }
  }

  /** `stream-start`: хост начал раздавать файл (только режим B). */
  publishStreamStart(info: StreamStartData): void {
    if (
      !this.selfIsHost ||
      this.meta.mode !== 'stream' ||
      !this.canControl() ||
      !isStreamStartData(info)
    ) {
      return;
    }
    this.streamInfo = info;
    this.streamActive = true;
    this.send('stream-start', info);
  }

  /** `stream-stop`: раздача окончена; у зрителей гаснет картинка. */
  publishStreamStop(reason: StreamStopData['reason'] = 'host-stop'): void {
    if (!this.selfIsHost || !this.canPublish()) {
      return;
    }
    const wasActive = this.streamActive;
    this.streamActive = false;
    this.streamInfo = null;
    if (wasActive) {
      const data: StreamStopData = { reason };
      this.send('stream-stop', data);
    }
  }

  /** `capability`: честно сообщаем, умеет ли устройство захватывать видео. */
  publishCapability(capability: CapabilityData): void {
    if (!this.selfIsHost || this.meta.mode !== 'stream' || !this.canPublish()) {
      return;
    }
    if (!isCapabilityData(capability)) {
      return;
    }
    this.capability = capability;
    this.send('capability', capability);
  }

  /** Отметить локальное воспроизведение и, если нужно, скорректировать. */
  checkCorrection(sample: PlaybackSample): void {
    this.lastLocal = sample;
    this.applyCorrection();
  }

  // ---------- Чат, реакции, фото (§4.3, §4.7) ----------

  /**
   * Отправить сообщение в чат комнаты. Возвращает готовую запись для UI или
   * null, если текст пустой/слишком частый. Своё сообщение не ждёт сети.
   */
  sendChat(raw: string, replyTo?: string): ChatMessage | null {
    const text = normalizeChatText(raw);
    if (!text || text.length > CHAT_MAX_LENGTH) {
      return null;
    }
    if (!this.canPublish()) {
      return null;
    }
    const now = this.now();
    if (now - this.lastChatAt < SELF_CHAT_GAP_MS) {
      return null;
    }
    this.lastChatAt = now;
    const id = createUlid(now);
    this.send('room-chat', replyTo ? { text, replyTo } : { text }, undefined, id);
    return {
      id,
      from: this.selfUserId,
      name: this.profile.name,
      color: this.profile.color,
      ts: now,
      kind: 'text',
      text,
      replyTo,
      self: true,
    };
  }

  /** Реакция: одиночный эмодзи, опционально с координатами на видео. */
  sendReaction(emoji: string, position?: { x: number; y: number }): ReactionPayload | null {
    if (!isEmojiSequence(emoji) || !this.canPublish()) {
      return null;
    }
    const payload: ReactionPayload = { emoji };
    if (position) {
      payload.x = Math.min(1, Math.max(0, position.x));
      payload.y = Math.min(1, Math.max(0, position.y));
    }
    this.send('reaction', payload);
    return payload;
  }

  /** «Печатает…»: не чаще одного сообщения в 1.5 с, чтобы не грузить канал. */
  sendTyping(on: boolean): void {
    if (!this.canPublish()) {
      return;
    }
    const now = this.now();
    if (on && now - this.lastTypingAt < 1500) {
      return;
    }
    this.lastTypingAt = now;
    const payload: TypingPayload = { on };
    this.send('typing', payload);
  }

  /**
   * Отправить фото с прогрессом и отменой. Возвращает объект с `cancel()`:
   * UI показывает прогресс, а пользователь может прервать передачу.
   */
  sendImage(
    input: { bytes: Uint8Array; mime: string; w: number; h: number },
    handlers: {
      onProgress?: (sent: number, total: number) => void;
      scope?: ImageScope;
    } = {},
  ): { id: string; cancel: () => void; done: Promise<SendImageResult> } {
    const id = createUlid(this.now());
    if (!this.canPublish()) {
      return {
        id,
        cancel: () => undefined,
        done: Promise.resolve({ ok: false, cancelled: false, chunks: 0, error: 'Комната не готова' }),
      };
    }
    const done = sendImage({
      transport: this.blobTransport(),
      id,
      bytes: input.bytes,
      mime: input.mime,
      w: input.w,
      h: input.h,
      scope: handlers.scope ?? 'chat',
      isCancelled: () => this.cancelledImages.has(id) || this.stopped,
      onProgress: handlers.onProgress,
    }).then((result) => {
      this.cancelledImages.delete(id);
      if (!result.ok && !result.cancelled) {
        this.emit({ type: 'image-error', id, reason: result.error ?? 'send-failed' });
      }
      return result;
    });
    return {
      id,
      cancel: () => {
        this.cancelledImages.add(id);
      },
      done,
    };
  }

  /** Отменить своё исходящее фото (кнопка «Отмена» в интерфейсе). */
  cancelImage(id: string): void {
    this.cancelledImages.add(id);
  }

  // ---------- Голос (§4.6) ----------

  /**
   * Подключить микрофон. Вызывается один раз при включении голоса; дальше
   * mute/unmute идут через replaceTrack и не требуют renegotiation.
   */
  attachVoice(stream: MediaStream): void {
    this.voiceStream = stream;
    const track = stream.getAudioTracks()[0];
    if (track) {
      track.enabled = !this.micMutedValue;
    }
    this.channelValue?.addStream?.(stream);
  }

  get voiceAttached(): boolean {
    return this.voiceStream !== null;
  }

  setMicMuted(muted: boolean): void {
    this.micMutedValue = muted;
    const track = this.voiceStream?.getAudioTracks()[0];
    if (!track) {
      return;
    }
    this.channelValue?.setMicMuted?.(track, muted);
  }

  get micMuted(): boolean {
    return this.micMutedValue;
  }

  // ---------- Канал и стратегии ----------

  private async openChannel(): Promise<void> {
    if (this.stopped) {
      return;
    }
    this.resetPeerState();
    const strategy = STRATEGIES[this.strategyIndex % STRATEGIES.length] ?? 'nostr';
    this.setPhase(this.selfIsHost ? 'waiting' : 'connecting');
    let channel: Channel;
    try {
      // Комната с паролем живёт в другом trystero-roomId (§4.8): код без
      // пароля в сигналинге бесполезен.
      const roomId = await signalingRoomId(this.code, this.password);
      channel = await this.connect(strategy, roomId);
    } catch (error) {
      this.emit({
        type: 'error',
        message: `Сигналинг ${strategy} недоступен: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
      this.scheduleReconnect();
      return;
    }
    if (this.stopped) {
      channel.leave();
      return;
    }
    this.channelValue = channel;
    this.selfPeerId = channel.selfId;
    this.openedAt = this.now();
    this.relayCount = channel.relayCount();
    this.bindChannel(channel);
    if (this.voiceStream) {
      // После реконнекта микрофон возвращаем в новое соединение.
      channel.addStream?.(this.voiceStream);
    }
    if (this.screenStream) {
      // Раздача файла тоже переживает смену стратегии сигналинга.
      channel.addScreenStream?.(this.screenStream);
    }
    this.emit({ type: 'strategy', strategy, relays: this.relayCountValue() });
    this.emitMembers();
    this.armConnectCheck();
    if (this.selfIsHost) {
      this.setPhase('joined');
    }
    if (this.hintShown) {
      this.emit({ type: 'hint', message: null });
      this.hintShown = false;
    }
    this.emitDebug();
  }

  private bindChannel(channel: Channel): void {
    channel.onPeerJoin = (peerId) => this.handlePeerJoin(peerId);
    channel.onPeerLeave = (peerId) => this.handlePeerLeave(peerId);
    channel.onMessage = (data, peerId) => {
      this.queue = this.queue
        .then(() => this.handleMessage(data, peerId))
        .catch((error: unknown) => {
          console.warn('[heliwatch] ошибка обработки сообщения', error);
        });
    };
    channel.onBlobMessage = (data, peerId) => {
      // Чанки идут через ту же очередь, что и JSON: `image-start` всегда
      // обрабатывается раньше первого кадра, порядок DataChannel сохранён.
      this.queue = this.queue
        .then(() => {
          if (this.peers.get(peerId)?.joined) {
            this.images.frame(peerId, data);
          }
        })
        .catch((error: unknown) => {
          console.warn('[heliwatch] ошибка приёма чанка фото', error);
        });
    };
    channel.onPeerStream = (stream, peerId, metadata) => {
      const peer = this.peers.get(peerId);
      const meta = isRecord(metadata) ? metadata : null;
      const screen =
        meta?.kind === 'screen' ||
        (meta?.kind !== 'voice' && stream.getVideoTracks().length > 0);
      if (screen) {
        // Стрим файла хоста: зритель рисует его отдельным <video>. Метаданные
        // и медиа могут обогнать welcome — поток придержим до авторизации.
        if (
          peer?.joined ||
          (!this.selfIsHost && peer?.userId && peer.userId === this.hostUserId)
        ) {
          this.emit({
            type: 'screen-stream',
            peerId,
            userId: peer?.userId ?? null,
            stream,
          });
        } else if (!this.selfIsHost) {
          this.pendingScreens.set(peerId, stream);
        }
        return;
      }
      this.emit({
        type: 'voice-stream',
        peerId,
        userId: peer?.userId ?? null,
        stream,
      });
    };
  }

  private disposeChannel(): void {
    const channel = this.channelValue;
    this.channelValue = null;
    if (channel) {
      channel.onPeerJoin = null;
      channel.onPeerLeave = null;
      channel.onMessage = null;
      channel.onBlobMessage = null;
      channel.onPeerStream = null;
      channel.leave();
    }
  }

  private armConnectCheck(): void {
    if (!this.autoTimers) {
      return;
    }
    this.clearConnectCheck();
    this.connectCheckTimer = setTimeout(() => {
      this.connectCheckTimer = null;
      if (this.stopped) {
        return;
      }
      const relays = this.relayCountValue();
      const peers = this.channelValue?.knownPeers().length ?? 0;
      if (peers === 0 && relays === 0) {
        this.strategyIndex = (this.strategyIndex + 1) % STRATEGIES.length;
        if (this.strategyIndex === 0) {
          this.scheduleReconnect();
          return;
        }
        void this.openChannel();
        return;
      }
      if (!this.hintShown && peers === 0) {
        this.hintShown = true;
        this.emit({
          type: 'hint',
          message: this.noPeersHint(),
        });
      }
      this.armConnectCheck();
    }, CONNECT_CHECK_MS);
  }

  /**
   * Подсказка «никого нет». У комнаты с паролем причина чаще всего — неверный
   * пароль: сигналинг-комната у неё другая, и хост просто не находится.
   */
  private noPeersHint(): string {
    if (this.password) {
      return 'Никто не отвечает. Проверьте код и пароль: с неверным паролем комната не находится в сигналинге, а не отклоняет вход.';
    }
    return 'Пока никого нет. Проверьте код комнаты и сеть; при симметричном NAT может понадобиться TURN.';
  }

  private startTimers(): void {
    if (!this.autoTimers) {
      return;
    }
    this.monitorTimer = setInterval(() => this.monitor(), MONITOR_MS);
    this.heartbeatTimer = setInterval(() => this.heartbeat(), HEARTBEAT_MS);
    this.hintTimer = setTimeout(() => {
      this.hintTimer = null;
      if (!this.stopped && this.peers.size === 0 && !this.hintShown) {
        this.hintShown = true;
        this.emit({ type: 'hint', message: this.noPeersHint() });
      }
    }, CONNECT_HINT_MS);
  }

  private monitor(): void {
    if (this.stopped || !this.channelValue) {
      return;
    }
    this.relayCount = this.relayCountValue();
    this.emit({
      type: 'strategy',
      strategy: this.channelValue.strategy,
      relays: this.relayCount,
    });
    const peers = this.channelValue.knownPeers().length;
    if (peers === 0 && this.relayCount === 0 && this.now() - this.openedAt > CONNECT_CHECK_MS) {
      this.strategyIndex = (this.strategyIndex + 1) % STRATEGIES.length;
      void this.openChannel();
      return;
    }
    // Гость потерял хоста без bye (обрыв сети): переподключаемся.
    if (
      !this.selfIsHost &&
      this.hostUserId !== null &&
      peers === 0 &&
      this.phaseValue === 'joined'
    ) {
      this.scheduleReconnect();
    }
    this.emitDebug();
  }

  private heartbeat(): void {
    if (this.phaseValue !== 'joined' || this.stateValue.by !== this.selfUserId) {
      return;
    }
    // Периодический state не двигает seq: у остальных это refresh, а не конфликт.
    this.sendState();
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) {
      return;
    }
    this.reconnects += 1;
    const delay = Math.min(
      RECONNECT_MAX_MS,
      RECONNECT_BASE_MS * 2 ** Math.min(5, this.reconnects - 1),
    );
    this.setPhase('reconnecting');
    this.emit({
      type: 'hint',
      message: `Переподключение через ${Math.round(delay / 1000)} с…`,
    });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.openChannel();
    }, delay);
  }

  private resetPeerState(): void {
    const wasHost = this.selfIsHost;
    this.peers.clear();
    this.members.clear();
    this.pendingJoins.clear();
    // Хост после реконнекта снова хост: иначе он перестанет принимать join.
    this.hostUserId = wasHost ? this.selfUserId : null;
    this.disposeChannel();
  }

  private setPhase(phase: RoomPhase, message?: string): void {
    this.phaseValue = phase;
    this.emit({ type: 'phase', phase, message });
  }

  private canPublish(): boolean {
    return !this.stopped && this.phaseValue === 'joined' && this.channelValue !== null;
  }

  /**
   * Кто управляет воспроизведением: в режиме B (файл хоста) — только хост,
   * зритель получает уже собранный поток и не может перемотать его у себя.
   */
  private canControl(): boolean {
    return this.canPublish() && !(this.meta.mode === 'stream' && !this.selfIsHost);
  }

  // ---------- Входящие сообщения ----------

  private async handleMessage(raw: unknown, peerId: string): Promise<void> {
    if (this.stopped || !isEnvelope(raw, this.code)) {
      return;
    }
    if (this.seenIds.has(raw.id)) {
      return;
    }
    this.rememberId(raw.id);

    switch (raw.t) {
      case 'hello':
        await this.handleHello(raw, peerId);
        return;
      case 'join':
        // После миграции хоста join принимает уже другой участник (§4.5).
        if (this.selfIsHost) {
          await this.handleJoin(raw, peerId);
        }
        return;
      case 'welcome':
        if (!this.selfIsHost) {
          await this.handleWelcome(raw, peerId);
        }
        return;
      case 'join-deny':
        this.handleJoinDeny(raw);
        return;
      case 'join-accept':
        // Гость просто ждёт welcome; accept нужен только чтобы снять «стук».
        return;
      case 'host-transfer':
        await this.handleHostTransfer(raw, peerId);
        return;
      case 'host-claim':
        this.handleHostClaim(raw);
        return;
      default:
        break;
    }

    const peer = this.peers.get(peerId);
    if (!peer?.joined) {
      return;
    }
    if (peer.userId && raw.from !== peer.userId) {
      return;
    }

    switch (raw.t) {
      case 'state':
        this.handleState(raw);
        return;
      case 'play':
      case 'pause':
      case 'seek':
      case 'rate':
        this.handleCommand(raw, peer);
        return;
      case 'resync':
        this.handleResync(raw, peer);
        return;
      case 'site-url':
        this.handleSiteUrl(raw);
        return;
      case 'stream-start':
        this.handleStreamStart(raw);
        return;
      case 'stream-stop':
        if (isStreamStopData(raw.d)) {
          this.emit({ type: 'stream-stop', reason: raw.d.reason ?? 'host-stop' });
        }
        return;
      case 'capability':
        if (isCapabilityData(raw.d)) {
          this.emit({ type: 'capability', capability: raw.d });
        }
        return;
      case 'bye':
        this.handleBye(raw, peer);
        return;
      case 'room-chat':
        this.handleChat(raw, peer);
        return;
      case 'reaction':
        this.handleReaction(raw, peer);
        return;
      case 'typing':
        this.handleTyping(raw, peer);
        return;
      case 'image-start':
        if (this.peerSocialAllowed(peer)) {
          this.images.start(peer.peerId, raw.d);
        }
        return;
      case 'image-chunk':
        // Чанки приходят только бинарным action `hw-blob` (см. net/blobs.ts),
        // JSON-вариант протокола оставлен на будущее и сейчас игнорируется.
        return;
      case 'image-end':
        if (isImageEndPayload(raw.d)) {
          this.images.end(peer.peerId, raw.d.id);
        }
        return;
      case 'image-cancel':
        if (isImageCancelPayload(raw.d)) {
          this.images.cancel(peer.peerId, raw.d.id);
        }
        return;
      case 'room-meta':
        await this.handleRoomMeta(raw, peer);
        return;
      case 'mute-request':
        this.handleMuteRequest(raw);
        return;
      case 'kick':
      case 'ban':
        await this.handleModeration(raw, peer);
        return;
      default:
        // Остальные типы протокола появятся на следующих этапах.
        return;
    }
  }

  private handleChat(
    envelope: { id: string; from: string; ts: number; d: unknown },
    peer: PeerAuth,
  ): void {
    if (!isChatPayload(envelope.d) || !this.peerSocialAllowed(peer)) {
      return;
    }
    const profile = peer.profile ?? { name: 'Друг', color: '#6ff0c4' };
    this.emit({
      type: 'chat',
      message: {
        id: envelope.id,
        from: envelope.from,
        name: profile.name,
        color: profile.color,
        ts: typeof envelope.ts === 'number' ? envelope.ts : this.now(),
        kind: 'text',
        text: envelope.d.text.slice(0, CHAT_MAX_LENGTH),
        replyTo: envelope.d.replyTo,
        self: false,
      },
    });
  }

  private handleReaction(
    envelope: { from: string; d: unknown },
    peer: PeerAuth,
  ): void {
    if (!isReactionPayload(envelope.d) || !this.peerSocialAllowed(peer)) {
      return;
    }
    const profile = peer.profile ?? { name: 'Друг', color: '#6ff0c4' };
    this.emit({
      type: 'reaction',
      from: envelope.from,
      name: profile.name,
      emoji: envelope.d.emoji,
      x: envelope.d.x,
      y: envelope.d.y,
    });
  }

  private handleTyping(envelope: { from: string; d: unknown }, peer: PeerAuth): void {
    if (!isTypingPayload(envelope.d)) {
      return;
    }
    const profile = peer.profile ?? { name: 'Друг', color: '#6ff0c4' };
    this.emit({ type: 'typing', from: envelope.from, name: profile.name, on: envelope.d.on });
  }

  private peerSocialAllowed(peer: PeerAuth): boolean {
    return peer.chatLimiter.allow(this.now());
  }

  private handlePeerJoin(peerId: string): void {
    if (this.stopped || peerId === this.selfPeerId) {
      return;
    }
    const existing = this.peers.get(peerId);
    if (existing) {
      // Повторный onPeerJoin — это новое соединение с тем же peerId:
      // старую аутентификацию сбрасываем и заново обмениваемся nonce.
      if (existing.userId) {
        this.members.delete(existing.userId);
        this.emitMembers();
      }
      existing.userId = undefined;
      existing.pub = undefined;
      existing.remoteNonce = undefined;
      existing.remoteNonceAt = undefined;
      existing.localNonce = undefined;
      existing.localNonceAt = undefined;
      existing.localNonceUsed = false;
      existing.host = false;
      existing.joined = false;
      existing.profile = undefined;
      existing.joinedAt = undefined;
      existing.limiter.reset();
      existing.chatLimiter.reset();
      this.sendHello(peerId);
      this.emit({ type: 'hint', message: null });
      this.hintShown = false;
      this.emitDebug();
      return;
    }
    this.peers.set(peerId, {
      peerId,
      host: false,
      joined: false,
      limiter: new CommandRateLimiter(),
      chatLimiter: new CommandRateLimiter(SOCIAL_MESSAGES_PER_WINDOW, SOCIAL_WINDOW_MS),
    });
    this.sendHello(peerId);
    this.emit({ type: 'hint', message: null });
    this.hintShown = false;
    this.emitDebug();
  }

  private handlePeerLeave(peerId: string): void {
    const peer = this.peers.get(peerId);
    this.peers.delete(peerId);
    this.pendingScreens.delete(peerId);
    if (peer?.userId) {
      this.members.delete(peer.userId);
      this.emit({
        type: 'peer-left',
        peerId,
        userId: peer.userId,
      });
      this.emitMembers();
      if (!this.selfIsHost && peer.userId === this.hostUserId) {
        // Без bye это обрыв сети, а не осознанный выход хоста.
        this.scheduleReconnect();
      }
    }
    this.emitDebug();
  }

  private async handleHello(
    envelope: { from: string; d: unknown },
    peerId: string,
  ): Promise<void> {
    const data = envelope.d as Partial<HelloData>;
    if (
      typeof data.nonce !== 'string' ||
      data.nonce.length < 8 ||
      typeof data.userId !== 'string' ||
      typeof data.host !== 'boolean' ||
      data.ver !== PROTOCOL_VERSION ||
      !validPublicJwk(data.pub)
    ) {
      return;
    }
    if (!(await publicKeyMatchesUserId(data.pub, data.userId))) {
      this.emit({ type: 'error', message: 'Пир прислал ключ, не совпадающий с userId' });
      return;
    }
    const profile = validProfile(data.profile);
    if (!profile) {
      return;
    }
    const existing = this.peers.get(peerId);
    if (existing?.userId && existing.userId !== data.userId) {
      return;
    }
    const peer: PeerAuth = existing ?? {
      peerId,
      host: false,
      joined: false,
      limiter: new CommandRateLimiter(),
      chatLimiter: new CommandRateLimiter(SOCIAL_MESSAGES_PER_WINDOW, SOCIAL_WINDOW_MS),
    };
    peer.userId = data.userId;
    peer.pub = data.pub;
    peer.remoteNonce = data.nonce;
    peer.remoteNonceAt = this.now();
    peer.host = data.host;
    peer.profile = profile;
    this.peers.set(peerId, peer);

    if (this.members.has(data.userId)) {
      // Состав подтверждён хостом в welcome: сообщения этого пира принимаем.
      peer.joined = true;
    }

    if (!this.selfIsHost && data.host) {
      if (this.hostUserId && this.hostUserId !== data.userId) {
        return;
      }
      this.hostUserId = data.userId;
      await this.sendJoin(peerId, data.nonce);
    }
  }

  private async sendHello(peerId: string): Promise<void> {
    const nonce = createNonce();
    const peer = this.peers.get(peerId);
    if (peer) {
      peer.localNonce = nonce;
      peer.localNonceAt = this.now();
      peer.localNonceUsed = false;
    }
    const data: HelloData = {
      nonce,
      pub: this.identity.publicJwk,
      userId: this.selfUserId,
      host: this.selfIsHost,
      profile: this.profile,
      ver: PROTOCOL_VERSION,
    };
    this.send('hello', data, peerId);
  }

  private async sendJoin(peerId: string, nonce: string): Promise<void> {
    const data: JoinData = {
      nonce,
      peerId: this.selfPeerId,
      profile: this.profile,
      ver: PROTOCOL_VERSION,
    };
    if (this.password) {
      // Гость доказывает знание пароля: хеш привязан к коду комнаты.
      if (!this.passwordHashValue) {
        this.passwordHashValue = await passwordHash(this.code, this.password);
      }
      data.pwHash = this.passwordHashValue;
    }
    await this.sendSigned('join', data, peerId);
  }

  private async handleJoin(
    envelope: { from: string; d: unknown; sig?: string },
    peerId: string,
  ): Promise<void> {
    const peer = this.peers.get(peerId);
    if (!peer?.userId || !peer.pub || !peer.localNonce) {
      this.send('join-deny', { reason: 'no-hello' }, peerId);
      return;
    }
    const data = envelope.d as Partial<JoinData>;
    if (
      typeof data.nonce !== 'string' ||
      typeof data.peerId !== 'string' ||
      data.ver !== PROTOCOL_VERSION
    ) {
      this.send('join-deny', { reason: 'bad-join' }, peerId);
      return;
    }
    if (data.peerId !== peerId) {
      this.send('join-deny', { reason: 'peer-mismatch' }, peerId);
      return;
    }
    if (this.memberCount + 1 > this.meta.limit) {
      this.send('join-deny', { reason: 'room-full' }, peerId);
      return;
    }
    if (data.nonce !== peer.localNonce) {
      this.send('join-deny', { reason: 'wrong-nonce' }, peerId);
      return;
    }
    if (peer.localNonceUsed) {
      this.send('join-deny', { reason: 'nonce-replayed' }, peerId);
      return;
    }
    if (!isNonceFresh(this.now(), peer.localNonceAt ?? 0)) {
      this.send('join-deny', { reason: 'nonce-expired' }, peerId);
      return;
    }
    if (this.password && data.pwHash !== this.passwordHashValue) {
      this.send('join-deny', { reason: 'wrong-password' }, peerId);
      return;
    }
    if (await this.isBanned(peer.userId)) {
      // Бан-лист локальный (§4.2, этап 6): хост не пускает забаненного.
      this.send('join-deny', { reason: 'banned' }, peerId);
      return;
    }
    const profile = validProfile(data.profile);
    if (!profile) {
      this.send('join-deny', { reason: 'bad-profile' }, peerId);
      return;
    }
    const verified = await verifyEnvelope(envelope as Envelope, peer.pub);
    if (!verified || envelope.from !== peer.userId) {
      this.send('join-deny', { reason: 'bad-signature' }, peerId);
      this.emit({ type: 'error', message: 'Отклонён вход: неверная подпись' });
      return;
    }
    if (this.meta.knock) {
      // «Стук»: подпись проверена, но вход подтверждает человек в UI хоста.
      peer.pending = true;
      const request: JoinRequestInfo = {
        userId: peer.userId,
        peerId,
        name: profile.name,
        color: profile.color,
        at: this.now(),
      };
      this.pendingJoins.set(peerId, request);
      this.emit({ type: 'join-request', request });
      return;
    }
    await this.admitJoin(peerId, profile);
  }

  /**
   * Принять гостя, прошедшего проверки: добавить в состав, отправить welcome и
   * разослать обновлённый состав остальным.
   */
  private async admitJoin(peerId: string, profile: ProfilePayload): Promise<void> {
    const peer = this.peers.get(peerId);
    if (!peer?.userId || peer.joined) {
      return;
    }
    if (this.memberCount + 1 > this.meta.limit) {
      this.send('join-deny', { reason: 'room-full' }, peerId);
      return;
    }
    if (!peer.localNonce || peer.localNonceUsed) {
      this.send('join-deny', { reason: 'nonce-replayed' }, peerId);
      return;
    }
    if (!isNonceFresh(this.now(), peer.localNonceAt ?? 0)) {
      this.send('join-deny', { reason: 'nonce-expired' }, peerId);
      return;
    }
    peer.localNonceUsed = true;
    peer.joined = true;
    peer.pending = false;
    peer.profile = profile;
    peer.joinedAt = this.now();
    this.pendingJoins.delete(peerId);
    this.members.set(peer.userId, {
      userId: peer.userId,
      peerId,
      name: profile.name,
      color: profile.color,
      avatarHash: profile.avatarHash,
      joinedAt: peer.joinedAt,
      host: peer.userId === this.selfUserId,
    });
    this.emitMembers();
    // Остальные гости видят состав только через welcome: обновляем его.
    this.broadcastWelcome();
    await this.sendWelcome(peerId);
    // Поздно подключившийся зритель узнаёт о текущей раздаче и возможностях.
    if (this.streamActive && this.screenStream) {
      this.channelValue?.addScreenStream?.(this.screenStream, peerId);
    }
    if (this.streamActive && this.streamInfo) {
      this.send('stream-start', this.streamInfo, peerId);
    }
    if (this.meta.mode === 'stream' && this.capability) {
      this.send('capability', this.capability, peerId);
    }
    this.setPhase('joined');
    this.reconnects = 0;
    this.emitDebug();
  }

  private async sendWelcome(peerId: string): Promise<void> {
    const peer = this.peers.get(peerId);
    if (!peer || !peer.remoteNonce || !this.selfIsHost) {
      return;
    }
    const data: WelcomeData = {
      nonce: peer.remoteNonce,
      hostUserId: this.selfUserId,
      room: this.meta,
      members: this.memberList,
      state: this.stateValue,
      epoch: this.epochValue,
    };
    await this.sendSigned('welcome', data, peerId);
  }

  /** Состав изменился: у всех гостей должен обновиться список участников. */
  private broadcastWelcome(): void {
    if (!this.selfIsHost) {
      return;
    }
    for (const peer of this.peers.values()) {
      if (peer.joined) {
        void this.sendWelcome(peer.peerId);
      }
    }
  }

  private async handleWelcome(
    envelope: { from: string; d: unknown },
    peerId: string,
  ): Promise<void> {
    const hostPeer = this.peers.get(peerId);
    if (!hostPeer?.pub || !hostPeer.userId || hostPeer.userId !== this.hostUserId) {
      return;
    }
    const data = envelope.d as Partial<WelcomeData>;
    if (
      typeof data.nonce !== 'string' ||
      data.nonce !== hostPeer.localNonce ||
      typeof data.hostUserId !== 'string' ||
      data.hostUserId !== this.hostUserId ||
      typeof data.state !== 'object' ||
      data.state === null ||
      !Array.isArray(data.members) ||
      typeof data.room !== 'object' ||
      data.room === null
    ) {
      this.emit({ type: 'error', message: 'Некорректный welcome от хоста' });
      return;
    }
    const room = data.room as RoomMeta;
    if (
      room.code !== this.code ||
      (room.mode !== 'site' && room.mode !== 'local' && room.mode !== 'stream')
    ) {
      this.emit({ type: 'error', message: 'Welcome от другой комнаты' });
      return;
    }
    const stateBy = isRecord(data.state)
      ? typeof (data.state as Record<string, unknown>).by === 'string'
        ? (data.state as { by: string }).by
        : ''
      : '';
    if (!isValidState(data.state, stateBy)) {
      // State в welcome может быть authored не хостом: в A/C driver — любой
      // участник, а welcome подписан хостом и потому доверенный.
      this.emit({ type: 'error', message: 'Welcome с некорректным state' });
      return;
    }
    const verified = await verifyEnvelope(envelope as Envelope, hostPeer.pub);
    if (!verified || envelope.from !== hostPeer.userId) {
      this.emit({ type: 'error', message: 'Отклонён welcome: неверная подпись хоста' });
      return;
    }

    // Повторный welcome — это обновление состава после входа/выхода гостя:
    // состояние и playback не трогаем, иначе можно откатить свежий state.
    if (this.phaseValue === 'joined') {
      const epoch = typeof data.epoch === 'number' ? data.epoch : this.epochValue;
      if (epoch < this.epochValue) {
        return;
      }
      this.epochValue = epoch;
      this.applyRoomMeta(room);
      this.applyMembers(data.members);
      this.emitMembers();
      this.emit({ type: 'meta', meta: this.meta });
      return;
    }

    this.epochValue =
      typeof data.epoch === 'number' && data.epoch > 0 ? data.epoch : this.epochValue;
    this.applyRoomMeta(room);
    this.applyMembers(data.members);
    hostPeer.joined = true;
    this.stateValue = data.state;
    this.version = { seq: data.state.seq, by: data.state.by };
    this.stateReceivedAt = this.now();
    this.reconnects = 0;
    this.setPhase('joined');
    const pendingScreen = this.pendingScreens.get(peerId);
    if (pendingScreen) {
      this.pendingScreens.delete(peerId);
      this.emit({
        type: 'screen-stream',
        peerId,
        userId: hostPeer.userId,
        stream: pendingScreen,
      });
    }
    this.emitMembers();
    this.emit({
      type: 'joined',
      meta: this.meta,
      members: this.memberList,
      hostUserId: this.hostUserId,
      state: this.stateValue,
    });
    this.emitDebug();
  }

  private applyRoomMeta(room: RoomMeta): void {
    this.meta = {
      code: this.code,
      title: normalizeRoomTitle(room.title, this.code),
      mode: room.mode,
      limit: Math.min(
        ROOM_LIMIT_MAX,
        Math.max(ROOM_LIMIT_MIN, Number(room.limit) || ROOM_LIMIT_DEFAULT),
      ),
      closed: room.closed === true,
      knock: room.knock === true,
    };
  }

  private applyMembers(rawMembers: unknown[]): void {
    this.members.clear();
    for (const rawMember of rawMembers) {
      const member = rawMember as Partial<MemberInfo>;
      if (
        typeof member.userId !== 'string' ||
        typeof member.peerId !== 'string' ||
        typeof member.name !== 'string' ||
        typeof member.color !== 'string' ||
        member.userId === this.selfUserId
      ) {
        continue;
      }
      this.members.set(member.userId, {
        userId: member.userId,
        peerId: member.peerId,
        name: member.name,
        color: member.color,
        avatarHash:
          typeof member.avatarHash === 'string' ? member.avatarHash : undefined,
        joinedAt: typeof member.joinedAt === 'number' ? member.joinedAt : this.now(),
        host: member.host === true,
      });
      // Хост поручился за состав: гости могут принимать сообщения друг друга
      // (mesh), не повторяя join на каждую пару (§4.2, этап 6).
      const peer = this.peers.get(member.peerId);
      if (peer) {
        peer.joined = true;
        peer.userId = member.userId;
      }
    }
  }

  private handleJoinDeny(envelope: { d: unknown }): void {
    const data = envelope.d as { reason?: unknown };
    const reason = typeof data.reason === 'string' ? data.reason : 'unknown';
    const messages: Record<string, string> = {
      'bad-signature': 'Хост отклонил вход: неверная подпись',
      'wrong-nonce': 'Хост отклонил вход: чужой nonce',
      'nonce-replayed': 'Хост отклонил вход: nonce уже использован',
      'nonce-expired': 'Хост отклонил вход: nonce истёк',
      'room-full': 'В комнате нет свободных мест',
      'peer-mismatch': 'Ошибка канала: peerId не совпадает',
      'bad-profile': 'Хост отклонил профиль',
      'no-hello': 'Хост не получил hello',
      'wrong-password': 'Неверный пароль комнаты',
      banned: 'Хост заблокировал вход в эту комнату с вашего устройства',
      'knock-denied': 'Хост отклонил ваш запрос на вход',
    };
    this.setPhase('error');
    this.emit({ type: 'error', message: messages[reason] ?? `Хост отклонил вход: ${reason}` });
  }

  private handleState(envelope: { from: string; d: unknown }): void {
    if (!isValidState(envelope.d, envelope.from)) {
      return;
    }
    const next = envelope.d;
    const refresh = isStateRefresh(this.version, { seq: next.seq, by: next.by });
    if (!shouldApplyState(this.version, { seq: next.seq, by: next.by }) && !refresh) {
      return;
    }
    // Refresh принимаем только от текущего driver'а, иначе это подделка seq.
    if (refresh && this.stateValue.by !== next.by) {
      return;
    }
    this.stateValue = {
      playing: next.playing,
      t: next.t,
      rate: next.rate,
      src: next.src,
      seq: next.seq,
      by: next.by,
    };
    this.version = { seq: next.seq, by: next.by };
    this.stateReceivedAt = this.now();
    const drift = this.lastLocal
      ? this.lastLocal.time -
        sampleFromState(this.stateValue, this.stateReceivedAt, this.now()).time
      : null;
    this.emit({
      type: 'state',
      state: this.stateValue,
      receivedAt: this.stateReceivedAt,
      drift,
    });
    this.applyCorrection();
    this.emitDebug();
  }

  private handleCommand(
    envelope: { from: string; t: string; d: unknown },
    peer: PeerAuth,
  ): void {
    if (!peer.limiter.allow(this.now())) {
      return;
    }
    // Команду принимаем только от текущего driver'а: он авторитет по времени.
    if (this.stateValue.by !== envelope.from) {
      return;
    }
    const action = actionFromMessage(envelope.t, envelope.d);
    if (!action) {
      return;
    }
    this.emit({ type: 'command', action, from: envelope.from });
  }

  private handleResync(envelope: { d: unknown }, peer: PeerAuth): void {
    const data = envelope.d as { to?: unknown };
    const to = typeof data.to === 'string' ? data.to : undefined;
    if (to && to !== this.selfUserId) {
      return;
    }
    // Отвечает только текущий driver, чтобы не множить state.
    if (this.stateValue.by !== this.selfUserId) {
      return;
    }
    this.sendState(to ? peer.peerId : undefined);
  }

  private handleSiteUrl(envelope: { from: string; d: unknown }): void {
    if (this.selfIsHost || envelope.from !== this.hostUserId) {
      return;
    }
    const data = envelope.d as { url?: unknown };
    if (!validUrl(data.url)) {
      return;
    }
    this.stateValue = {
      ...this.stateValue,
      src: { mode: 'site', url: data.url, duration: this.stateValue.src.duration },
    };
    this.emit({ type: 'site-url', url: data.url });
  }

  private handleStreamStart(envelope: { from: string; d: unknown }): void {
    if (
      this.selfIsHost ||
      this.meta.mode !== 'stream' ||
      envelope.from !== this.hostUserId ||
      !isStreamStartData(envelope.d)
    ) {
      return;
    }
    this.emit({ type: 'stream-start', info: envelope.d });
    this.emit({ type: 'hint', message: null });
  }

  private handleBye(envelope: { from: string; d: unknown }, peer: PeerAuth): void {
    const data = envelope.d as { reason?: unknown };
    const reason = typeof data.reason === 'string' ? data.reason : 'left';
    const wasHost = peer.userId !== undefined && peer.userId === this.hostUserId;
    if (peer.userId) {
      this.members.delete(peer.userId);
    }
    this.peers.delete(peer.peerId);
    this.pendingScreens.delete(peer.peerId);
    this.emitMembers();
    this.emit({ type: 'peer-left', peerId: peer.peerId, userId: peer.userId });
    if (!wasHost) {
      return;
    }
    if (reason === 'closed') {
      this.finish('closed');
      this.emit({ type: 'error', message: 'Хост закрыл комнату' });
      return;
    }
    if (reason === 'host-left' || reason === 'left') {
      // Режим B: поток шёл с телефона хоста — миграции нет (§4.5).
      if (this.meta.mode === 'stream') {
        this.finish('host-left');
        this.emit({ type: 'error', message: 'Хост закрыл комнату' });
        return;
      }
      this.migrateHost();
    }
  }

  /**
   * Хост ушёл, режим A/C: выбираем преемника детерминированно (минимальный
   * userId среди оставшихся), преемник объявляет host-claim с новой эпохой.
   */
  private migrateHost(): void {
    // Только состав, подтверждённый хостом: случайный пир в сигналинге не
    // должен выиграть выборы. Недостающие члены приходят в welcome-обновлении.
    const candidates: MemberInfo[] = [
      ...this.members.values(),
      {
        userId: this.selfUserId,
        peerId: this.selfPeerId,
        name: this.profile.name,
        color: this.profile.color,
        joinedAt: this.selfJoinedAt,
        host: false,
      },
    ];
    const unique = candidates.filter(
      (member, index, list) =>
        list.findIndex((item) => item.userId === member.userId) === index,
    );
    const successor = pickSuccessor(unique);
    if (!successor) {
      // Остались только мы и ушёл хост — комната закрывается.
      this.finish('host-left');
      return;
    }
    this.epochValue += 1;
    this.hostUserId = successor;
    if (successor === this.selfUserId) {
      this.becomeHost();
      return;
    }
    this.emit({
      type: 'host-changed',
      hostUserId: successor,
      epoch: this.epochValue,
      self: false,
    });
    this.emitDebug();
  }

  /** Стать хостом после миграции: собрать состав из mesh и объявить эпоху. */
  private becomeHost(): void {
    const previousMembers = [...this.members.values()];
    this.members.clear();
    for (const member of previousMembers) {
      if (member.userId !== this.selfUserId) {
        this.members.set(member.userId, { ...member, host: false });
      }
    }
    this.hostUserId = this.selfUserId;
    this.emitMembers();
    this.emit({
      type: 'host-changed',
      hostUserId: this.selfUserId,
      epoch: this.epochValue,
      self: true,
    });
    const claim: HostClaimPayload = { epoch: this.epochValue };
    this.send('host-claim', claim);
    // Новый хост сразу рассылает состав: у гостей он мог устареть.
    this.broadcastWelcome();
    this.setPhase('joined');
    this.emitDebug();
  }

  private async handleRoomMeta(
    envelope: { from: string; d: unknown },
    peer: PeerAuth,
  ): Promise<void> {
    if (envelope.from !== this.hostUserId || !peer.pub) {
      return;
    }
    if (!isRoomMetaPayload(envelope.d)) {
      return;
    }
    const verified = await verifyEnvelope(envelope as Envelope, peer.pub);
    if (!verified) {
      return;
    }
    const patch = envelope.d;
    const next: RoomMeta = {
      ...this.meta,
      title:
        patch.title !== undefined
          ? normalizeRoomTitle(patch.title, this.code)
          : this.meta.title,
      limit:
        patch.limit !== undefined
          ? normalizeRoomLimit(patch.limit, this.meta.mode)
          : this.meta.limit,
      closed: patch.closed ?? this.meta.closed,
      knock: patch.knock ?? this.meta.knock,
    };
    this.meta = next;
    this.emit({ type: 'meta', meta: this.meta });
    this.emitMembers();
  }

  private handleMuteRequest(envelope: { from: string; d: unknown }): void {
    if (!isMuteRequestPayload(envelope.d)) {
      return;
    }
    if (envelope.from !== this.hostUserId || envelope.d.target !== this.selfUserId) {
      return;
    }
    const host = this.memberList.find((member) => member.userId === this.hostUserId);
    this.emit({
      type: 'mute-request',
      by: envelope.from,
      name: host?.name ?? 'Хост',
    });
  }

  private async handleModeration(
    envelope: { t: string; from: string; d: unknown },
    peer: PeerAuth,
  ): Promise<void> {
    if (envelope.from !== this.hostUserId || !peer.pub || !isKickPayload(envelope.d)) {
      return;
    }
    const verified = await verifyEnvelope(envelope as Envelope, peer.pub);
    if (!verified) {
      return;
    }
    const target = envelope.d.target;
    if (target === this.selfUserId) {
      const reason: 'kicked' | 'banned' = envelope.t === 'ban' ? 'banned' : 'kicked';
      this.emit({
        type: 'kicked',
        reason,
        by: envelope.from,
        until: envelope.d.until,
      });
      this.finish(reason);
      return;
    }
    const member = this.members.get(target);
    if (member) {
      this.members.delete(target);
      const peerId = member.peerId;
      this.peers.delete(peerId);
      this.emitMembers();
      this.emit({ type: 'peer-left', peerId, userId: target });
    }
  }

  private async handleHostTransfer(
    envelope: { from: string; d: unknown },
    peerId: string,
  ): Promise<void> {
    if (!isHostTransferPayload(envelope.d)) {
      return;
    }
    const hostPeer = this.peers.get(peerId);
    if (
      !hostPeer?.pub ||
      envelope.from !== this.hostUserId ||
      envelope.from === envelope.d.target ||
      envelope.d.epoch <= this.epochValue
    ) {
      return;
    }
    const verified = await verifyEnvelope(envelope as Envelope, hostPeer.pub);
    if (!verified) {
      return;
    }
    const target = envelope.d.target;
    const known =
      target === this.selfUserId || this.members.has(target) || this.peersHasUser(target);
    if (!known) {
      return;
    }
    this.epochValue = envelope.d.epoch;
    this.hostUserId = target;
    if (target === this.selfUserId) {
      this.becomeHost();
      return;
    }
    this.emit({
      type: 'host-changed',
      hostUserId: target,
      epoch: this.epochValue,
      self: false,
    });
    this.emitDebug();
  }

  private handleHostClaim(envelope: { from: string; d: unknown }): void {
    if (!isHostClaimPayload(envelope.d)) {
      return;
    }
    if (envelope.from !== this.hostUserId) {
      return;
    }
    if (envelope.d.epoch < this.epochValue) {
      return;
    }
    this.epochValue = envelope.d.epoch;
    this.emitDebug();
  }

  private peersHasUser(userId: string): boolean {
    for (const peer of this.peers.values()) {
      if (peer.userId === userId) {
        return true;
      }
    }
    return false;
  }

  /** Завершить комнату локально (закрыта, кик, бан, уход хоста). */
  private finish(reason: string): void {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    this.clearTimers();
    this.images.dispose();
    this.screenStream = null;
    this.streamActive = false;
    this.streamInfo = null;
    this.pendingScreens.clear();
    this.pendingJoins.clear();
    this.disposeChannel();
    this.setPhase('closed');
    this.emit({ type: 'closed', reason });
  }

  private applyCorrection(): void {
    if (!this.lastLocal || this.stateValue.by === this.selfUserId) {
      return;
    }
    if (this.phaseValue !== 'joined') {
      return;
    }
    const now = this.now();
    const action = planCorrection({
      local: this.lastLocal,
      remote: this.stateValue,
      receivedAt: this.stateReceivedAt,
      now,
      lastCorrectionAt: this.lastCorrectionAt,
    });
    if (!action) {
      return;
    }
    this.lastCorrectionAt = now;
    this.emit({ type: 'correction', action });
  }

  // ---------- Отправка ----------

  private send(type: string, data: unknown, to?: string, id?: string): void {
    if (!this.channelValue) {
      return;
    }
    const envelope = createEnvelope(type, data, this.selfUserId, this.code, {
      to,
      now: this.now(),
      id,
    });
    this.channelValue.send(envelope, to);
  }

  /** Транспорт чанков фото: JSON-контроль + бинарные кадры (§4.1). */
  private blobTransport(): BlobTransport {
    return {
      sendJson: (type, data, to) => this.send(type, data, to),
      sendBlob: (frame, to) => this.channelValue?.sendBlob(frame, to),
    };
  }

  private async sendSigned(type: string, data: unknown, to?: string): Promise<void> {
    if (!this.channelValue) {
      return;
    }
    const envelope = createEnvelope(type, data, this.selfUserId, this.code, {
      to,
      now: this.now(),
    });
    try {
      envelope.sig = await signEnvelope(envelope, this.identity.privateJwk);
    } catch (error) {
      this.emit({
        type: 'error',
        message: `Не удалось подписать ${type}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
      return;
    }
    this.channelValue.send(envelope, to);
  }

  private sendCommand(action: PlaybackAction): void {
    switch (action.kind) {
      case 'play':
      case 'pause':
        this.send(action.kind, {});
        break;
      case 'seek':
        this.send('seek', { t: action.t ?? 0 });
        break;
      case 'rate':
        this.send('rate', { rate: action.rate ?? 1 });
        break;
      default:
        break;
    }
  }

  private sendState(to?: string): void {
    this.send(
      'state',
      {
        playing: this.stateValue.playing,
        t: this.stateValue.t,
        rate: this.stateValue.rate,
        src: this.stateValue.src,
        seq: this.stateValue.seq,
        by: this.stateValue.by,
      },
      to,
    );
  }

  private sourceWithDuration(sample: PlaybackSample): PlaybackSource {
    return {
      ...this.stateValue.src,
      duration: sample.duration > 0 ? sample.duration : this.stateValue.src.duration,
    };
  }

  // ---------- Служебное ----------

  private emitMembers(): void {
    this.emit({ type: 'members', members: this.memberList });
  }

  private emitDebug(): void {
    this.emit({
      type: 'debug',
      peers: this.peers.size,
      seq: this.stateValue.seq,
      driverId: this.stateValue.by,
    });
  }

  private relayCountValue(): number {
    return this.channelValue?.relayCount() ?? 0;
  }

  private rememberId(id: string): void {
    this.seenIds.add(id);
    if (this.seenIds.size > MAX_SEEN_IDS) {
      const oldest = this.seenIds.values().next().value;
      if (typeof oldest === 'string') {
        this.seenIds.delete(oldest);
      }
    }
  }

  private clearConnectCheck(): void {
    if (this.connectCheckTimer) {
      clearTimeout(this.connectCheckTimer);
      this.connectCheckTimer = null;
    }
  }

  private clearTimers(): void {
    this.clearConnectCheck();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.monitorTimer) {
      clearInterval(this.monitorTimer);
      this.monitorTimer = null;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.hintTimer) {
      clearTimeout(this.hintTimer);
      this.hintTimer = null;
    }
  }
}
