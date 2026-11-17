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
  PROTOCOL_VERSION,
  ROOM_LIMIT_DEFAULT,
  ROOM_LIMIT_MAX,
  createEnvelope,
  createNonce,
  isEnvelope,
  isNonceFresh,
  isStateRefresh,
  isValidState,
  normalizeRoomCode,
  sampleFromState,
  shouldApplyState,
  stateFromSample,
  type ByeData,
  type Envelope,
  type HelloData,
  type JoinData,
  type MemberInfo,
  type PlaybackAction,
  type PlaybackSample,
  type PlaybackSource,
  type PlaybackState,
  type ProfilePayload,
  type RoomMeta,
  type RoomMode,
  type RoomRole,
  type SiteUrlData,
  type StateVersion,
  type WelcomeData,
} from './protocol';
import type { Channel } from './transport';
import { STRATEGIES, type StrategyId } from './trystero';

export type RoomPhase =
  | 'connecting'
  | 'waiting'
  | 'joined'
  | 'reconnecting'
  | 'closed'
  | 'error';

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
  | { type: 'state'; state: PlaybackState; receivedAt: number; drift: number | null }
  | { type: 'command'; action: PlaybackAction; from: string }
  | { type: 'correction'; action: PlaybackAction }
  | { type: 'site-url'; url: string }
  | { type: 'hint'; message: string | null }
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
  connect: (strategy: StrategyId) => Promise<Channel>;
  onEvent: (event: RoomEvent) => void;
  initialUrl?: string;
  now?: () => number;
  /** Таймеры выключаются в тестах, чтобы процесс завершался сразу. */
  autoTimers?: boolean;
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
  profile?: ProfilePayload;
  joinedAt?: number;
  limiter: CommandRateLimiter;
}

const MAX_SEEN_IDS = 128;
const CONNECT_CHECK_MS = 8000;
const MONITOR_MS = 4000;
const HEARTBEAT_MS = 5000;
const RECONNECT_BASE_MS = 2000;
const RECONNECT_MAX_MS = 60_000;
const CONNECT_HINT_MS = 12_000;

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
  private readonly connect: (strategy: StrategyId) => Promise<Channel>;
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
  private selfPeerId = '';
  private selfJoinedAt = 0;
  private peers = new Map<string, PeerAuth>();
  private members = new Map<string, MemberInfo>();
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
    this.meta = {
      code,
      title: `Комната ${code}`,
      mode: options.mode,
      limit: ROOM_LIMIT_DEFAULT,
      closed: false,
      knock: false,
    };
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
      host: this.role === 'host',
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

  // ---------- Запуск и остановка ----------

  async start(): Promise<void> {
    this.stopped = false;
    this.openedAt = this.now();
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
    if (!this.canPublish()) {
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
    if (!this.canPublish()) {
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
    if (!this.canPublish()) {
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
    if (this.role !== 'host' || !this.canPublish()) {
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

  /** Отметить локальное воспроизведение и, если нужно, скорректировать. */
  checkCorrection(sample: PlaybackSample): void {
    this.lastLocal = sample;
    this.applyCorrection();
  }

  // ---------- Канал и стратегии ----------

  private async openChannel(): Promise<void> {
    if (this.stopped) {
      return;
    }
    this.resetPeerState();
    const strategy = STRATEGIES[this.strategyIndex % STRATEGIES.length] ?? 'nostr';
    this.setPhase(this.role === 'host' ? 'waiting' : 'connecting');
    let channel: Channel;
    try {
      channel = await this.connect(strategy);
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
    this.emit({ type: 'strategy', strategy, relays: this.relayCountValue() });
    this.emitMembers();
    this.armConnectCheck();
    if (this.role === 'host') {
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
  }

  private disposeChannel(): void {
    const channel = this.channelValue;
    this.channelValue = null;
    if (channel) {
      channel.onPeerJoin = null;
      channel.onPeerLeave = null;
      channel.onMessage = null;
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
          message:
            'Пока никого нет. Проверьте код комнаты и сеть; при симметричном NAT может понадобиться TURN.',
        });
      }
      this.armConnectCheck();
    }, CONNECT_CHECK_MS);
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
        this.emit({
          type: 'hint',
          message:
            'Соединение ещё не установлено. Проверьте код, сеть и доступность релеев; при симметричном NAT нужен TURN.',
        });
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
      this.role === 'guest' &&
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
    this.peers.clear();
    this.members.clear();
    this.hostUserId = null;
    this.disposeChannel();
  }

  private setPhase(phase: RoomPhase, message?: string): void {
    this.phaseValue = phase;
    this.emit({ type: 'phase', phase, message });
  }

  private canPublish(): boolean {
    return !this.stopped && this.phaseValue === 'joined' && this.channelValue !== null;
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
        if (this.role === 'host') {
          await this.handleJoin(raw, peerId);
        }
        return;
      case 'welcome':
        if (this.role === 'guest') {
          await this.handleWelcome(raw, peerId);
        }
        return;
      case 'join-deny':
        this.handleJoinDeny(raw);
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
      case 'bye':
        this.handleBye(raw, peer);
        return;
      default:
        // Остальные типы протокола появятся на этапах 3–7.
        return;
    }
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
    });
    this.sendHello(peerId);
    this.emit({ type: 'hint', message: null });
    this.hintShown = false;
    this.emitDebug();
  }

  private handlePeerLeave(peerId: string): void {
    const peer = this.peers.get(peerId);
    this.peers.delete(peerId);
    if (peer?.userId) {
      this.members.delete(peer.userId);
      this.emit({
        type: 'peer-left',
        peerId,
        userId: peer.userId,
      });
      this.emitMembers();
      if (this.role === 'guest' && peer.userId === this.hostUserId) {
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
    };
    peer.userId = data.userId;
    peer.pub = data.pub;
    peer.remoteNonce = data.nonce;
    peer.remoteNonceAt = this.now();
    peer.host = data.host;
    peer.profile = profile;
    this.peers.set(peerId, peer);

    if (this.role === 'guest' && data.host) {
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
      host: this.role === 'host',
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
    if (this.members.size + 2 > this.meta.limit) {
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
    peer.localNonceUsed = true;
    peer.joined = true;
    peer.profile = profile;
    peer.joinedAt = this.now();
    this.members.set(peer.userId, {
      userId: peer.userId,
      peerId,
      name: profile.name,
      color: profile.color,
      avatarHash: profile.avatarHash,
      joinedAt: peer.joinedAt,
      host: false,
    });
    this.emitMembers();
    if (this.hostUserId === null) {
      this.hostUserId = this.selfUserId;
    }
    await this.sendWelcome(peerId);
    this.setPhase('joined');
    this.reconnects = 0;
    this.emitDebug();
  }

  private async sendWelcome(peerId: string): Promise<void> {
    const peer = this.peers.get(peerId);
    if (!peer || !peer.remoteNonce) {
      return;
    }
    const data: WelcomeData = {
      nonce: peer.remoteNonce,
      hostUserId: this.selfUserId,
      room: this.meta,
      members: this.memberList,
      state: this.stateValue,
      epoch: 1,
    };
    await this.sendSigned('welcome', data, peerId);
  }

  private async handleWelcome(
    envelope: { from: string; d: unknown },
    peerId: string,
  ): Promise<void> {
    if (this.phaseValue === 'joined') {
      // Повторный welcome (реплей) не должен сбрасывать уже собранную комнату.
      return;
    }
    const hostPeer = this.peers.get(peerId);
    if (
      !hostPeer?.pub ||
      !hostPeer.userId ||
      hostPeer.userId !== this.hostUserId ||
      !hostPeer.host
    ) {
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
    if (room.code !== this.code || (room.mode !== 'site' && room.mode !== 'local')) {
      this.emit({ type: 'error', message: 'Welcome от другой комнаты' });
      return;
    }
    if (!isValidState(data.state, envelope.from)) {
      this.emit({ type: 'error', message: 'Welcome с некорректным state' });
      return;
    }
    const verified = await verifyEnvelope(envelope as Envelope, hostPeer.pub);
    if (!verified || envelope.from !== hostPeer.userId) {
      this.emit({ type: 'error', message: 'Отклонён welcome: неверная подпись хоста' });
      return;
    }

    this.meta = {
      ...room,
      limit: Math.min(ROOM_LIMIT_MAX, Math.max(2, Number(room.limit) || ROOM_LIMIT_DEFAULT)),
    };
    this.members.clear();
    for (const rawMember of data.members) {
      const member = rawMember as Partial<MemberInfo>;
      if (
        typeof member.userId !== 'string' ||
        typeof member.peerId !== 'string' ||
        typeof member.name !== 'string' ||
        typeof member.color !== 'string'
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
    }
    hostPeer.joined = true;
    this.stateValue = data.state;
    this.version = { seq: data.state.seq, by: data.state.by };
    this.stateReceivedAt = this.now();
    this.reconnects = 0;
    this.setPhase('joined');
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
    if (this.role === 'host' || envelope.from !== this.hostUserId) {
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

  private handleBye(envelope: { from: string; d: unknown }, peer: PeerAuth): void {
    const data = envelope.d as { reason?: unknown };
    const reason = typeof data.reason === 'string' ? data.reason : 'left';
    if (peer.userId) {
      this.members.delete(peer.userId);
    }
    this.peers.delete(peer.peerId);
    this.emitMembers();
    this.emit({ type: 'peer-left', peerId: peer.peerId, userId: peer.userId });
    if (
      this.role === 'guest' &&
      peer.userId === this.hostUserId &&
      (reason === 'host-left' || reason === 'closed')
    ) {
      this.stopped = true;
      this.clearTimers();
      this.disposeChannel();
      this.setPhase('closed');
      this.emit({ type: 'closed', reason });
      this.emit({ type: 'error', message: 'Хост закрыл комнату' });
    }
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

  private send(type: string, data: unknown, to?: string): void {
    if (!this.channelValue) {
      return;
    }
    const envelope = createEnvelope(type, data, this.selfUserId, this.code, {
      to,
      now: this.now(),
    });
    this.channelValue.send(envelope, to);
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
