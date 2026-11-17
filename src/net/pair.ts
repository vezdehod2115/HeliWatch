/*
 * Парная и инвайт-комната друзей (§4.8, этап 7).
 *
 * Маленький клиент поверх того же trystero-транспорта, что и комната: два
 * человека встречаются в фиксированной комнате `dm-<hash(пары)>`, а приглашение
 * по ссылке — в комнате `invite-<hash(userId пригласившего)>`. Никакого сервера:
 * обмен — подписанные конверты, ключ проверяется по `userId` (§4.4), поэтому
 * доверять самому каналу не нужно.
 *
 * Здесь только транспорт и проверка подписей. Запись в SQLite, outbox и UI
 * живут в `src/net/dm.ts` — так клиент остаётся тестируемым.
 */

import type { Identity } from './identity';
import { signEnvelope, verifyEnvelopeWithUserId } from './identity';
import type { Channel } from './transport';
import { STRATEGIES, type StrategyId } from './trystero';
import {
  ImageReceiver,
  sendImage,
  type ImageTransferInfo,
  type SendImageResult,
} from './blobs';
import {
  PROTOCOL_VERSION,
  createEnvelope,
  createNonce,
  createUlid,
  isDmAckPayload,
  isDmMessagePayload,
  isDmOutboxOfferPayload,
  isDmOutboxSyncPayload,
  isFriendCard,
  isFriendRequestPayload,
  isImageCancelPayload,
  isImageEndPayload,
  isImageStartPayload,
  isNonceFresh,
  type DmMessagePayload,
  type Envelope,
  type FriendCard,
  type ProfilePayload,
} from './protocol';

export type PairRoomKind = 'pair' | 'invite';

export type PairRoomPhase = 'connecting' | 'online' | 'closed' | 'error';

export interface DmHelloPayload {
  nonce: string;
  profile: ProfilePayload;
  kind: PairRoomKind;
}

export interface DmHelloAckPayload {
  nonce: string;
}

export type PairRoomEvent =
  | { type: 'phase'; phase: PairRoomPhase; message?: string }
  | { type: 'ready'; peerId: string; userId: string; profile: ProfilePayload }
  | { type: 'friend-request'; from: string; card: FriendCard; note?: string }
  | { type: 'friend-accepted'; from: string; card: FriendCard }
  | { type: 'friend-removed'; from: string }
  | { type: 'dm'; from: string; payload: DmMessagePayload; envelope: Envelope }
  | { type: 'dm-ack'; from: string; msgId: string }
  | { type: 'dm-outbox'; from: string; messages: Envelope[] }
  | { type: 'dm-outbox-sync'; from: string; ids: string[] }
  | { type: 'image-start'; info: ImageTransferInfo }
  | { type: 'image-progress'; info: ImageTransferInfo }
  | {
      type: 'image';
      id: string;
      from: string;
      mime: string;
      w: number;
      h: number;
      bytes: Uint8Array;
    }
  | { type: 'image-error'; id: string; reason: string }
  | { type: 'error'; message: string };

export interface PairRoomOptions {
  roomId: string;
  kind: PairRoomKind;
  identity: Identity;
  profile: ProfilePayload;
  connect: (strategy: StrategyId, roomId: string) => Promise<Channel>;
  onEvent: (event: PairRoomEvent) => void;
  /** Для парной комнаты — единственный допустимый собеседник. */
  allowedUsers?: string[];
  /** Заблокированные не допускаются даже по ссылке-приглашению. */
  isBlocked?: (userId: string) => boolean;
  now?: () => number;
  autoTimers?: boolean;
}

interface PairPeer {
  peerId: string;
  userId: string;
  pub?: JsonWebKey;
  profile: ProfilePayload;
  nonce?: string;
  nonceAt?: number;
  acked: boolean;
  ready: boolean;
  /** Подписанный hello проверен: сообщения этого пира принимаем. */
  verified: boolean;
}

const CONNECT_WAIT_MS = 6000;
const MAX_SEEN = 128;

export class PairRoom {
  readonly roomId: string;
  readonly kind: PairRoomKind;
  readonly selfUserId: string;

  private readonly identity: Identity;
  private readonly profile: ProfilePayload;
  private readonly connect: PairRoomOptions['connect'];
  private readonly emit: (event: PairRoomEvent) => void;
  private readonly allowed: Set<string>;
  private readonly blocked: (userId: string) => boolean;
  private readonly now: () => number;

  private channel: Channel | null = null;
  private phaseValue: PairRoomPhase = 'connecting';
  private stopped = false;
  private readonly peers = new Map<string, PairPeer>();
  private readonly seenIds = new Set<string>();
  private strategyIndex = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** Фото в личке: тот же чанкинг 16 КиБ, что и в чате комнаты (§4.7). */
  private readonly images: ImageReceiver;
  private readonly cancelledImages = new Set<string>();

  constructor(options: PairRoomOptions) {
    this.roomId = options.roomId;
    this.kind = options.kind;
    this.selfUserId = options.identity.userId;
    this.identity = options.identity;
    this.profile = options.profile;
    this.connect = options.connect;
    this.emit = options.onEvent;
    this.allowed = new Set(options.allowedUsers ?? []);
    this.blocked = options.isBlocked ?? (() => false);
    this.now = options.now ?? (() => Date.now());
    void options.autoTimers;
    this.images = new ImageReceiver({
      onStart: (info) => this.emit({ type: 'image-start', info }),
      onProgress: (info) => this.emit({ type: 'image-progress', info }),
      onComplete: (image) => {
        const peer = this.peers.get(image.fromPeer);
        this.emit({
          type: 'image',
          id: image.id,
          from: peer?.userId ?? '',
          mime: image.mime,
          w: image.w,
          h: image.h,
          bytes: image.bytes,
        });
      },
      onError: ({ id, reason }) => this.emit({ type: 'image-error', id, reason }),
      onReject: (id, peerId, reason) => {
        const peer = this.peers.get(peerId);
        if (peer?.userId) {
          this.sendJson('image-cancel', { id, reason }, peer.userId);
        }
      },
    });
  }

  get phase(): PairRoomPhase {
    return this.phaseValue;
  }

  get onlineUserIds(): string[] {
    return [...this.peers.values()]
      .filter((peer) => peer.ready)
      .map((peer) => peer.userId);
  }

  get isOnline(): boolean {
    return this.peers.size > 0;
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.open();
  }

  async stop(): Promise<void> {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.disposeChannel();
    this.setPhase('closed');
  }

  hasPeer(userId: string): boolean {
    return [...this.peers.values()].some((peer) => peer.userId === userId && peer.ready);
  }

  peerIdFor(userId: string): string | null {
    for (const peer of this.peers.values()) {
      if (peer.userId === userId && peer.ready) {
        return peer.peerId;
      }
    }
    return null;
  }

  async createSigned(type: string, data: unknown, toUserId?: string): Promise<Envelope | null> {
    const envelope = createEnvelope(type, data, this.selfUserId, this.roomId, {
      to: toUserId || undefined,
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
      return null;
    }
    return envelope;
  }

  sendEnvelope(envelope: Envelope, toUserId?: string): boolean {
    if (!this.channel) {
      return false;
    }
    if (toUserId === undefined) {
      this.channel.send(envelope);
      return true;
    }
    const peerId = this.peerIdFor(toUserId);
    if (!peerId) {
      return false;
    }
    this.channel.send(envelope, peerId);
    return true;
  }

  sendJson(type: string, data: unknown, toUserId?: string): boolean {
    if (!this.channel || !toUserId) {
      return false;
    }
    const peerId = this.peerIdFor(toUserId);
    if (!peerId) {
      return false;
    }
    this.channel.send(
      createEnvelope(type, data, this.selfUserId, this.roomId, { to: toUserId, now: this.now() }),
      peerId,
    );
    return true;
  }

  /** Фото в личку: чанки 16 КиБ по тому же action `hw-blob` (§4.7). */
  sendImage(
    input: { bytes: Uint8Array; mime: string; w: number; h: number },
    options: { toUserId?: string; onProgress?: (sent: number, total: number) => void } = {},
  ): { id: string; done: Promise<SendImageResult> } {
    const id = createUlid();
    const to = options.toUserId;
    const done = sendImage({
      transport: {
        sendJson: (type, data, toUserId) => {
          if (toUserId) {
            this.sendJson(type, data, toUserId);
          }
        },
        sendBlob: (frame, toUserId) => {
          if (!toUserId) {
            return;
          }
          const peerId = this.peerIdFor(toUserId);
          if (peerId) {
            this.channel?.sendBlob(frame, peerId);
          }
        },
      },
      id,
      bytes: input.bytes,
      mime: input.mime,
      w: input.w,
      h: input.h,
      scope: 'dm',
      to,
      onProgress: options.onProgress,
      isCancelled: () => this.cancelledImages.has(id),
    });
    return { id, done };
  }

  cancelImage(id: string): void {
    this.cancelledImages.add(id);
  }

  // ---------- Канал ----------

  private async open(): Promise<void> {
    if (this.stopped) {
      return;
    }
    this.setPhase('connecting');
    const strategy: StrategyId =
      STRATEGIES[this.strategyIndex % STRATEGIES.length] ?? STRATEGIES[0]!;
    try {
      const channel = await withTimeout(
        this.connect(strategy, this.roomId),
        CONNECT_WAIT_MS,
        'Сигналинг не ответил',
      );
      if (this.stopped) {
        channel.leave();
        return;
      }
      this.channel = channel;
      this.bind(channel);
      this.setPhase('online');
    } catch (error) {
      // Одна упавшая стратегия не должна ломать парную комнату: пробуем дальше.
      if (this.strategyIndex + 1 < STRATEGIES.length) {
        this.strategyIndex += 1;
        await this.open();
        return;
      }
      this.emit({
        type: 'error',
        message: `Парная комната недоступна: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
      this.setPhase('error', error instanceof Error ? error.message : undefined);
    }
  }

  private bind(channel: Channel): void {
    channel.onPeerJoin = (peerId) => {
      if (this.stopped) {
        return;
      }
      this.peers.set(peerId, {
        peerId,
        userId: '',
        profile: { name: 'Друг', color: '#6ff0c4' },
        acked: false,
        ready: false,
        verified: false,
      });
      void this.sendHello(peerId);
    };
    channel.onPeerLeave = (peerId) => {
      const peer = this.peers.get(peerId);
      this.peers.delete(peerId);
      if (peer?.userId) {
        this.emit({ type: 'phase', phase: 'online' });
      }
    };
    channel.onMessage = (data, peerId) => {
      void this.handleMessage(data, peerId);
    };
    channel.onBlobMessage = (data, peerId) => {
      this.images.frame(peerId, data);
    };
  }

  private disposeChannel(): void {
    const channel = this.channel;
    this.channel = null;
    this.peers.clear();
    this.images.dispose();
    if (channel) {
      channel.onPeerJoin = null;
      channel.onPeerLeave = null;
      channel.onMessage = null;
      channel.onBlobMessage = null;
      channel.leave();
    }
  }

  private setPhase(phase: PairRoomPhase, message?: string): void {
    if (this.phaseValue === phase) {
      return;
    }
    this.phaseValue = phase;
    this.emit({ type: 'phase', phase, message });
  }

  // ---------- Рукопожатие ----------

  private async sendHello(peerId: string): Promise<void> {
    const nonce = createNonce();
    const payload: DmHelloPayload = {
      nonce,
      profile: this.profile,
      kind: this.kind,
    };
    // hello — широковещательный в этой комнате: адресат определяется каналом,
    // поэтому `to` в конверте нет (иначе подпись связана с чужим userId).
    const envelope = await this.createSigned('dm-hello', payload);
    if (!envelope || !this.channel) {
      return;
    }
    const peer = this.peers.get(peerId);
    if (peer) {
      peer.nonce = nonce;
      peer.nonceAt = this.now();
    }
    this.channel.send(envelope, peerId);
  }

  private async handleMessage(raw: unknown, peerId: string): Promise<void> {
    if (this.stopped || typeof raw !== 'object' || raw === null) {
      return;
    }
    const envelope = raw as Envelope;
    if (
      envelope.v !== PROTOCOL_VERSION ||
      envelope.rid !== this.roomId ||
      typeof envelope.t !== 'string' ||
      typeof envelope.from !== 'string' ||
      typeof envelope.id !== 'string' ||
      typeof envelope.ts !== 'number' ||
      typeof envelope.d !== 'object' ||
      envelope.d === null
    ) {
      return;
    }
    if (this.seenIds.has(envelope.id)) {
      return;
    }
    this.seenIds.add(envelope.id);
    if (this.seenIds.size > MAX_SEEN) {
      const oldest = this.seenIds.values().next().value;
      if (typeof oldest === 'string') {
        this.seenIds.delete(oldest);
      }
    }
    if (envelope.from === this.selfUserId) {
      return;
    }

    const peer = this.peers.get(peerId);
    if (envelope.t === 'dm-hello') {
      await this.handleHello(envelope as Envelope<DmHelloPayload>, peerId, peer);
      return;
    }
    if (envelope.t === 'dm-hello-ack') {
      await this.handleHelloAck(envelope as Envelope<DmHelloAckPayload>, peer);
      return;
    }
    if (!peer?.verified || !peer.userId || envelope.from !== peer.userId) {
      return;
    }

    switch (envelope.t) {
      case 'friend-request': {
        if (!isFriendRequestPayload(envelope.d)) {
          return;
        }
        if (!(await verifyEnvelopeWithUserId(envelope, envelope.from))) {
          return;
        }
        this.emit({
          type: 'friend-request',
          from: envelope.from,
          card: {
            name: envelope.d.name,
            color: envelope.d.color,
            avatarHash: envelope.d.avatarHash,
          },
          note: envelope.d.note,
        });
        return;
      }
      case 'friend-accept': {
        if (!isFriendCard(envelope.d)) {
          return;
        }
        if (!(await verifyEnvelopeWithUserId(envelope, envelope.from))) {
          return;
        }
        this.emit({
          type: 'friend-accepted',
          from: envelope.from,
          card: {
            name: envelope.d.name,
            color: envelope.d.color,
            avatarHash: envelope.d.avatarHash,
          },
        });
        return;
      }
      case 'friend-remove': {
        if (!(await verifyEnvelopeWithUserId(envelope, envelope.from))) {
          return;
        }
        this.emit({ type: 'friend-removed', from: envelope.from });
        return;
      }
      case 'dm-message': {
        if (!isDmMessagePayload(envelope.d)) {
          return;
        }
        if (!(await verifyEnvelopeWithUserId(envelope, envelope.from))) {
          return;
        }
        this.emit({ type: 'dm', from: envelope.from, payload: envelope.d, envelope });
        return;
      }
      case 'dm-ack': {
        if (!isDmAckPayload(envelope.d)) {
          return;
        }
        this.emit({ type: 'dm-ack', from: envelope.from, msgId: envelope.d.msgId });
        return;
      }
      case 'dm-outbox-offer': {
        if (!isDmOutboxOfferPayload(envelope.d)) {
          return;
        }
        const accepted: Envelope[] = [];
        for (const message of envelope.d.messages) {
          if (message.from !== peer.userId || message.to !== this.selfUserId) {
            continue;
          }
          if (!(await verifyEnvelopeWithUserId(message, message.from))) {
            continue;
          }
          accepted.push(message);
        }
        if (accepted.length > 0) {
          this.emit({ type: 'dm-outbox', from: peer.userId, messages: accepted });
        }
        return;
      }
      case 'image-start': {
        if (isImageStartPayload(envelope.d)) {
          this.images.start(peerId, envelope.d);
        }
        return;
      }
      case 'image-end': {
        if (isImageEndPayload(envelope.d)) {
          this.images.end(peerId, envelope.d.id);
        }
        return;
      }
      case 'image-cancel': {
        if (isImageCancelPayload(envelope.d)) {
          this.images.cancel(peerId, envelope.d.id);
        }
        return;
      }
      case 'dm-outbox-sync': {
        if (isDmOutboxSyncPayload(envelope.d)) {
          this.emit({ type: 'dm-outbox-sync', from: envelope.from, ids: envelope.d.ids });
        }
        return;
      }
      default:
        return;
    }
  }

  private async handleHello(
    envelope: Envelope<DmHelloPayload>,
    peerId: string,
    peer: PairPeer | undefined,
  ): Promise<void> {
    const payload = envelope.d;
    if (
      typeof payload.nonce !== 'string' ||
      payload.nonce.length < 8 ||
      payload.kind !== this.kind ||
      !isProfile(payload.profile)
    ) {
      return;
    }
    if (this.allowed.size > 0 && !this.allowed.has(envelope.from)) {
      this.emit({ type: 'error', message: 'В парную комнату пришёл не тот участник' });
      return;
    }
    if (this.blocked(envelope.from)) {
      return;
    }
    if (!(await verifyEnvelopeWithUserId(envelope, envelope.from))) {
      return;
    }
    const entry: PairPeer = peer ?? {
      peerId,
      userId: envelope.from,
      profile: payload.profile,
      acked: false,
      ready: false,
      verified: false,
    };
    if (entry.userId && entry.userId !== envelope.from) {
      return;
    }
    entry.peerId = peerId;
    entry.userId = envelope.from;
    entry.profile = payload.profile;
    entry.verified = true;
    this.peers.set(peerId, entry);
    // Подтверждаем nonce: собеседник видит, что мы живы и приняли его ключ.
    const ack = await this.createSigned(
      'dm-hello-ack',
      { nonce: payload.nonce } satisfies DmHelloAckPayload,
      envelope.from,
    );
    if (ack) {
      this.channel?.send(ack, peerId);
    }
    this.markReady(entry);
  }

  private async handleHelloAck(envelope: Envelope<DmHelloAckPayload>, peer: PairPeer | undefined): Promise<void> {
    if (!peer || !peer.verified || !isNonceFresh(this.now(), peer.nonceAt ?? 0)) {
      return;
    }
    if (typeof envelope.d.nonce !== 'string' || envelope.d.nonce !== peer.nonce) {
      return;
    }
    if (!(await verifyEnvelopeWithUserId(envelope, envelope.from))) {
      return;
    }
    peer.acked = true;
    this.markReady(peer);
  }

  private markReady(peer: PairPeer): void {
    if (peer.ready) {
      return;
    }
    peer.ready = true;
    this.emit({
      type: 'ready',
      peerId: peer.peerId,
      userId: peer.userId,
      profile: peer.profile,
    });
  }
}

function isProfile(value: unknown): value is ProfilePayload {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const data = value as Record<string, unknown>;
  return (
    typeof data.name === 'string' &&
    data.name.trim().length > 0 &&
    data.name.length <= 24 &&
    typeof data.color === 'string' &&
    /^#[0-9a-f]{6}$/i.test(data.color)
  );
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}
