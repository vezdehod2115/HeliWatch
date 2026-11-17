/*
 * Лобби (§4.8, этап 6): отдельная trystero-комната `heliwatch-lobby-v1`, где
 * хосты публикуют карточки открытых комнат, а гости их видят.
 *
 * Карточки:
 *  - announce раз в 25 ± 5 с, update при изменении, remove при закрытии/заполнении;
 *  - TTL 70 с: убитый хост исчезает из списка сам, без сервера;
 *  - подписаны ECDSA ключом хоста (userId = публичный ключ), поэтому гость
 *    проверяет авторство, не подключаясь к самой комнате;
 *  - антиспам: не чаще одной публикации карточки в 5 секунд на хост.
 *
 * `LobbyClient` — браузер списка (без карточки), `LobbyPublisher` — карточка
 * хоста. Это два разных подключения: у хоста лобби живёт фоном, пока комната
 * открыта, у гостя лобби закрывается при входе в комнату.
 */

import { signEnvelope, verifyEnvelopeWithUserId, type Identity } from './identity';
import {
  LOBBY_ANNOUNCE_JITTER_MS,
  LOBBY_ANNOUNCE_MS,
  LOBBY_CARD_TTL_MS,
  LOBBY_PROBE_MIN_GAP_MS,
  LOBBY_PUBLISH_MIN_GAP_MS,
  LOBBY_ROOM_ID,
  createEnvelope,
  isEnvelope,
  isLobbyCardPayload,
  type LobbyCard,
} from './protocol';
import { STRATEGIES, type StrategyId } from './trystero';
import type { Channel } from './transport';

export type LobbyPhase = 'connecting' | 'open' | 'closed' | 'error';

export type LobbyEvent =
  | { type: 'phase'; phase: LobbyPhase; message?: string }
  | { type: 'cards'; cards: LobbyCard[] }
  | { type: 'strategy'; strategy: string; relays: number }
  | { type: 'error'; message: string };

export interface LobbyClientOptions {
  connect: (strategy: StrategyId) => Promise<Channel>;
  onEvent: (event: LobbyEvent) => void;
  now?: () => number;
  /** Таймеры выключаются в тестах. */
  autoTimers?: boolean;
  /** Локальный блок-лист: карточки заблокированных хостов не показываем. */
  isBlockedHost?: (userId: string) => boolean;
}

interface CachedCard {
  card: LobbyCard;
  seenAt: number;
}

const CONNECT_TIMEOUT_MS = 8000;
const SWEEP_MS = 5000;
const RETRY_MS = 20_000;
/** Подпись `from` у probe: проверять её никто не будет, но конверт валиден. */
const LOBBY_PROBE_FROM = 'lobby-anon';

/** Снимок карточки для UI/протокола: `updatedAt` подставляется при отправке. */
export interface LobbyCardInput {
  code: string;
  title: string;
  mode: LobbyCard['mode'];
  closed: boolean;
  limit: number;
  count: number;
  hasPassword: boolean;
  knock?: boolean;
  hostUserId: string;
  updatedAt?: number;
}

export function buildLobbyCard(input: LobbyCardInput, now: number): LobbyCard {
  return {
    code: input.code,
    title: input.title,
    mode: input.mode,
    closed: input.closed,
    limit: input.limit,
    count: input.count,
    hasPassword: input.hasPassword,
    knock: input.knock === true,
    hostUserId: input.hostUserId,
    updatedAt: input.updatedAt ?? now,
  };
}

/** Браузер лобби: слушает карточки, шлёт probe новым пирам. */
export class LobbyClient {
  private readonly connect: (strategy: StrategyId) => Promise<Channel>;
  private readonly emit: (event: LobbyEvent) => void;
  private readonly now: () => number;
  private readonly autoTimers: boolean;
  private readonly isBlockedHost: (userId: string) => boolean;

  private readonly cards = new Map<string, CachedCard>();
  private readonly lastPublish = new Map<string, number>();
  private channelValue: Channel | null = null;
  private phaseValue: LobbyPhase = 'connecting';
  private strategyIndex = 0;
  private stopped = true;
  private queue: Promise<void> = Promise.resolve();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private lastProbeAt = 0;

  constructor(options: LobbyClientOptions) {
    this.connect = options.connect;
    this.emit = options.onEvent;
    this.now = options.now ?? (() => Date.now());
    this.autoTimers = options.autoTimers ?? true;
    this.isBlockedHost = options.isBlockedHost ?? (() => false);
  }

  get phase(): LobbyPhase {
    return this.phaseValue;
  }

  get cardList(): LobbyCard[] {
    this.prune();
    return [...this.cards.values()]
      .filter((entry) => !this.isBlockedHost(entry.card.hostUserId))
      .map((entry) => entry.card)
      .sort((left, right) => right.updatedAt - left.updatedAt);
  }

  async start(): Promise<void> {
    if (!this.stopped) {
      return;
    }
    this.stopped = false;
    this.cards.clear();
    this.lastPublish.clear();
    await this.openChannel();
    if (!this.autoTimers || this.stopped) {
      return;
    }
    this.sweepTimer = setInterval(() => {
      this.prune();
      this.emitCards();
    }, SWEEP_MS);
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    this.disposeChannel();
    this.cards.clear();
    this.setPhase('closed');
  }

  /** Дождаться обработки входящих (для тестов). */
  async whenIdle(): Promise<void> {
    await this.queue;
  }

  /** Probe: новый пир в лобби просит хостов прислать карточки. */
  probe(): void {
    if (!this.channelValue || this.now() - this.lastProbeAt < LOBBY_PROBE_MIN_GAP_MS) {
      return;
    }
    this.lastProbeAt = this.now();
    this.send('lobby-probe', {});
  }

  private async openChannel(): Promise<void> {
    if (this.stopped) {
      return;
    }
    this.disposeChannel();
    const strategy = STRATEGIES[this.strategyIndex % STRATEGIES.length] ?? 'nostr';
    this.setPhase('connecting');
    let channel: Channel;
    try {
      channel = await this.connect(strategy);
    } catch (error) {
      this.emit({
        type: 'error',
        message: `Лобби недоступно (${strategy}): ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
      this.nextStrategy();
      return;
    }
    if (this.stopped) {
      channel.leave();
      return;
    }
    this.channelValue = channel;
    this.bind(channel);
    this.setPhase('open');
    this.emit({
      type: 'strategy',
      strategy,
      relays: channel.relayCount(),
    });
    this.armConnectCheck();
  }

  private bind(channel: Channel): void {
    channel.onPeerJoin = (peerId) => {
      if (this.stopped) {
        return;
      }
      // Новенький в лобби: просим карточки (§4.8).
      this.lastProbeAt = 0;
      this.probe();
      void peerId;
    };
    channel.onPeerLeave = () => undefined;
    channel.onMessage = (data, peerId) => {
      this.queue = this.queue
        .then(() => this.handleMessage(data, peerId))
        .catch((error: unknown) => {
          console.warn('[heliwatch] ошибка обработки карточки лобби', error);
        });
    };
    channel.onBlobMessage = null;
    channel.onPeerStream = null;
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
    if (this.connectTimer) {
      clearTimeout(this.connectTimer);
    }
    this.connectTimer = setTimeout(() => {
      this.connectTimer = null;
      if (this.stopped || !this.channelValue) {
        return;
      }
      if (this.channelValue.relayCount() === 0) {
        this.nextStrategy();
        return;
      }
      this.armConnectCheck();
    }, CONNECT_TIMEOUT_MS);
  }

  private nextStrategy(): void {
    this.strategyIndex = (this.strategyIndex + 1) % STRATEGIES.length;
    if (this.strategyIndex === 0) {
      // Все стратегии перебраны: ждём и пробуем снова, молча не зависаем.
      this.setPhase('error', 'Лобби недоступно: публичные релеи не отвечают');
      if (!this.autoTimers) {
        return;
      }
      if (this.retryTimer) {
        clearTimeout(this.retryTimer);
      }
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        void this.openChannel();
      }, RETRY_MS);
      return;
    }
    void this.openChannel();
  }

  private async handleMessage(raw: unknown, peerId: string): Promise<void> {
    if (this.stopped || !isEnvelope(raw, LOBBY_ROOM_ID)) {
      return;
    }
    if (raw.t === 'lobby-announce' || raw.t === 'lobby-update' || raw.t === 'lobby-remove') {
      await this.handleCard(raw, peerId);
    }
  }

  private async handleCard(
    envelope: {
      t: string;
      from: string;
      d: unknown;
      v: number;
      id: string;
      ts: number;
      rid: string;
      to?: string;
      sig?: string;
    },
    peerId: string,
  ): Promise<void> {
    if (!isLobbyCardPayload(envelope.d)) {
      return;
    }
    const card = envelope.d.card;
    if (card.hostUserId !== envelope.from) {
      return;
    }
    const verified = await verifyEnvelopeWithUserId(envelope, card.hostUserId);
    if (!verified) {
      return;
    }
    const now = this.now();
    if (envelope.t !== 'lobby-remove') {
      const last = this.lastPublish.get(card.hostUserId) ?? 0;
      // Спам карточками: одна публикация в 5 секунд на хост (§4.8).
      if (now - last < LOBBY_PUBLISH_MIN_GAP_MS) {
        return;
      }
      this.lastPublish.set(card.hostUserId, now);
      this.cards.set(card.code, { card, seenAt: now });
    } else {
      this.cards.delete(card.code);
    }
    void peerId;
    this.emitCards();
  }

  private prune(): void {
    const now = this.now();
    for (const [code, entry] of this.cards) {
      if (now - entry.seenAt > LOBBY_CARD_TTL_MS) {
        this.cards.delete(code);
      }
    }
  }

  private emitCards(): void {
    this.emit({ type: 'cards', cards: this.cardList });
  }

  private send(type: string, data: unknown, to?: string): void {
    if (!this.channelValue) {
      return;
    }
    // From у probe пустой по смыслу: отправитель в лобби анонимный участник.
    const envelope = createEnvelope(type, data, LOBBY_PROBE_FROM, LOBBY_ROOM_ID, {
      to,
      now: this.now(),
    });
    this.channelValue.send(envelope, to);
  }

  private setPhase(phase: LobbyPhase, message?: string): void {
    this.phaseValue = phase;
    this.emit({ type: 'phase', phase, message });
  }

  private clearTimers(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    if (this.connectTimer) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }
}

export type LobbyPublisherEvent =
  | { type: 'phase'; phase: LobbyPhase; message?: string }
  | { type: 'error'; message: string };

export interface LobbyPublisherOptions {
  identity: Identity;
  /** Карточка комнаты в момент отправки; null — публиковать нечего. */
  card: () => LobbyCardInput | null;
  connect: (strategy: StrategyId) => Promise<Channel>;
  onEvent?: (event: LobbyPublisherEvent) => void;
  now?: () => number;
  autoTimers?: boolean;
}

/**
 * Карточка хоста в лобби. Публикуется фоном, пока комната открыта; заполнение
 * или закрытие снимает карточку и отключает лобби (§4.8).
 */
export class LobbyPublisher {
  private readonly identity: Identity;
  private readonly cardSource: () => LobbyCardInput | null;
  private readonly connect: (strategy: StrategyId) => Promise<Channel>;
  private readonly emitEvent: (event: LobbyPublisherEvent) => void;
  private readonly now: () => number;
  private readonly autoTimers: boolean;

  private channelValue: Channel | null = null;
  private stopped = true;
  private strategyIndex = 0;
  private announceTimer: ReturnType<typeof setTimeout> | null = null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private lastPublishAt = 0;
  private lastProbeReplyAt = 0;
  private current: LobbyCard | null = null;

  constructor(options: LobbyPublisherOptions) {
    this.identity = options.identity;
    this.cardSource = options.card;
    this.connect = options.connect;
    this.emitEvent = options.onEvent ?? (() => undefined);
    this.now = options.now ?? (() => Date.now());
    this.autoTimers = options.autoTimers ?? true;
  }

  get active(): boolean {
    return !this.stopped;
  }

  async start(): Promise<void> {
    if (!this.stopped) {
      return;
    }
    this.stopped = false;
    await this.openChannel();
    if (!this.stopped && this.channelValue) {
      await this.publish('lobby-announce');
      this.scheduleAnnounce();
    }
  }

  /** Изменился состав/название/лимит: обновляем карточку с учётом антиспама. */
  update(): void {
    if (this.stopped || !this.channelValue) {
      return;
    }
    const card = this.cardSource();
    if (!card || card.closed || card.count >= card.limit) {
      this.remove();
      return;
    }
    const wait = this.lastPublishAt + LOBBY_PUBLISH_MIN_GAP_MS - this.now();
    if (wait <= 0) {
      void this.publish('lobby-update');
      this.scheduleAnnounce();
      return;
    }
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
    }
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      if (!this.stopped) {
        void this.publish('lobby-update');
        this.scheduleAnnounce();
      }
    }, wait);
  }

  /** Карточка исчезает из лобби: комната закрыта или заполнена. */
  remove(): void {
    if (this.stopped) {
      return;
    }
    const card = this.current ?? this.cardSnapshot();
    void (async () => {
      if (card) {
        await this.publishCard('lobby-remove', card);
      }
      this.stop();
    })();
  }

  stop(): void {
    if (this.stopped && !this.channelValue) {
      return;
    }
    this.stopped = true;
    this.clearTimers();
    this.disposeChannel();
    this.emitEvent({ type: 'phase', phase: 'closed' });
  }

  /** Дождаться отправки (для тестов). */
  async publishNow(): Promise<void> {
    if (!this.stopped) {
      await this.publish('lobby-update');
    }
  }

  private cardSnapshot(): LobbyCard | null {
    const input = this.cardSource();
    if (!input) {
      return null;
    }
    return buildLobbyCard(input, this.now());
  }

  private async publish(type: 'lobby-announce' | 'lobby-update'): Promise<void> {
    const card = this.cardSnapshot();
    if (!card || card.closed || card.count >= card.limit) {
      // Закрытые и заполненные комнаты в лобби не публикуются вовсе.
      return;
    }
    await this.publishCard(type, card);
    this.lastPublishAt = this.now();
  }

  private async publishCard(
    type: 'lobby-announce' | 'lobby-update' | 'lobby-remove',
    card: LobbyCard,
    to?: string,
  ): Promise<void> {
    if (!this.channelValue) {
      return;
    }
    const envelope = createEnvelope(type, { card }, this.identity.userId, LOBBY_ROOM_ID, {
      to,
      now: this.now(),
    });
    try {
      envelope.sig = await signEnvelope(envelope, this.identity.privateJwk);
    } catch (error) {
      this.emitEvent({
        type: 'error',
        message: `Не удалось подписать карточку: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
      return;
    }
    this.current = type === 'lobby-remove' ? null : card;
    this.channelValue.send(envelope, to);
  }

  private scheduleAnnounce(): void {
    if (!this.autoTimers || this.stopped) {
      return;
    }
    if (this.announceTimer) {
      clearTimeout(this.announceTimer);
    }
    const jitter = Math.round((Math.random() * 2 - 1) * LOBBY_ANNOUNCE_JITTER_MS);
    const delay = Math.max(5000, LOBBY_ANNOUNCE_MS + jitter);
    this.announceTimer = setTimeout(() => {
      this.announceTimer = null;
      void this.publish('lobby-announce').then(() => this.scheduleAnnounce());
    }, delay);
  }

  private async openChannel(): Promise<void> {
    if (this.stopped) {
      return;
    }
    this.disposeChannel();
    const strategy = STRATEGIES[this.strategyIndex % STRATEGIES.length] ?? 'nostr';
    let channel: Channel;
    try {
      channel = await this.connect(strategy);
    } catch (error) {
      this.emitEvent({
        type: 'error',
        message: `Карточка не опубликована (${strategy}): ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
      this.strategyIndex = (this.strategyIndex + 1) % STRATEGIES.length;
      if (this.autoTimers) {
        // Не сдаёмся после одной неудачной стратегии: пробуем снова.
        this.retryTimer = setTimeout(() => {
          this.retryTimer = null;
          if (this.stopped) {
            return;
          }
          void this.openChannel().then(async () => {
            if (this.stopped || !this.channelValue) {
              return;
            }
            await this.publish('lobby-announce');
            this.scheduleAnnounce();
          });
        }, CONNECT_TIMEOUT_MS);
      }
      return;
    }
    if (this.stopped) {
      channel.leave();
      return;
    }
    this.channelValue = channel;
    channel.onPeerJoin = (peerId) => {
      if (this.stopped) {
        return;
      }
      // Ответ на стук новичка — не чаще раза в секунду.
      const now = this.now();
      if (now - this.lastProbeReplyAt < LOBBY_PROBE_MIN_GAP_MS) {
        return;
      }
      const card = this.cardSnapshot();
      if (!card) {
        return;
      }
      this.lastProbeReplyAt = now;
      void this.publishCard('lobby-announce', card, peerId);
    };
    channel.onPeerLeave = () => undefined;
    channel.onMessage = (data, peerId) => {
      // Ответ на стук новичка — не чаще раза в секунду (§4.8).
      if (this.stopped || !isEnvelope(data, LOBBY_ROOM_ID)) {
        return;
      }
      if (data.t !== 'lobby-probe') {
        return;
      }
      const now = this.now();
      if (now - this.lastProbeReplyAt < LOBBY_PROBE_MIN_GAP_MS) {
        return;
      }
      const card = this.cardSnapshot();
      if (!card) {
        return;
      }
      this.lastProbeReplyAt = now;
      void this.publishCard('lobby-announce', card, peerId);
    };
    channel.onBlobMessage = null;
    channel.onPeerStream = null;
    this.emitEvent({ type: 'phase', phase: 'open' });
    if (this.autoTimers) {
      this.connectTimer = setTimeout(() => {
        this.connectTimer = null;
        if (!this.stopped && this.channelValue && this.channelValue.relayCount() === 0) {
          this.strategyIndex = (this.strategyIndex + 1) % STRATEGIES.length;
          void this.openChannel();
        }
      }, CONNECT_TIMEOUT_MS);
    }
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

  private clearTimers(): void {
    if (this.announceTimer) {
      clearTimeout(this.announceTimer);
      this.announceTimer = null;
    }
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.connectTimer) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }
}
