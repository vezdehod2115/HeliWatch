/*
 * Парная комната и комната приглашения: жизненный цикл для UI (этап 7).
 *
 * Парная комната открывается, пока экран личных сообщений на экране и друг
 * онлайн; комната приглашения — пока открыт экран «Друзья» и ждёт перехода по
 * ссылке. Обе закрываются, когда приложение ушло в фон (§4.8): без сервера
 * «всегда онлайн» стоил бы батареи, а DM всё равно доставится из outbox.
 */

import type { Identity } from './identity';
import { signEnvelope } from './identity';
import type { LocalProfile } from '../db/repo/identity';
import type { PairRoomEvent, PairRoomPhase } from './pair';
import { PairRoom } from './pair';
import { connectTrystero } from './trystero';
import {
  inviteRoomId,
  pairRoomId,
  createEnvelope,
} from './protocol';
import {
  flushOutboxToPeer,
  handleDmEvent,
  sendDmImageMessage,
  sendDmText,
  sendFriendAccept,
  sendFriendRemove,
  sendFriendRequest,
  type DmContext,
  type DmIncomingEvent,
  type DmTransportLike,
} from './dm';
import type { FriendCard } from './protocol';
import type { ImageTransferInfo } from './blobs';

export type PairImageEvent =
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
  | { type: 'image-error'; id: string; reason: string };

export interface DmChannelsOptions {
  identity: Identity;
  profile: LocalProfile;
  notify: (text: string) => void;
  onChange: () => void;
  onPairPhase?: (phase: PairRoomPhase | 'idle') => void;
  onInvitePhase?: (phase: PairRoomPhase | 'idle') => void;
  onImage?: (event: PairImageEvent) => void;
  isBlocked?: (userId: string) => boolean;
}

/** Все открытые каналы: Shell закрывает их по событию «приложение в фоне». */
const active = new Set<DmChannels>();

/** Закрыть парные и инвайт-комнаты во всех экранах (уход в фон, §4.8). */
export function closeAllDmChannels(): void {
  for (const channels of active) {
    channels.stopPair();
    channels.stopInvite();
  }
}

function toIncoming(event: PairRoomEvent): DmIncomingEvent | null {
  switch (event.type) {
    case 'friend-request':
      return {
        type: 'friend-request',
        from: event.from,
        card: event.card,
        note: event.note,
      };
    case 'friend-accepted':
      return { type: 'friend-accepted', from: event.from, card: event.card };
    case 'friend-removed':
      return { type: 'friend-removed', from: event.from };
    case 'dm':
      return {
        type: 'dm',
        from: event.from,
        payload: event.payload,
        envelope: event.envelope,
      };
    case 'dm-ack':
      return { type: 'dm-ack', from: event.from, msgId: event.msgId };
    case 'dm-outbox':
      return { type: 'dm-outbox', from: event.from, messages: event.messages };
    case 'dm-outbox-sync':
      return { type: 'dm-outbox-sync', from: event.from, ids: event.ids };
    default:
      return null;
  }
}

export class DmChannels {
  readonly selfUserId: string;

  private readonly options: DmChannelsOptions;
  private pair: PairRoom | null = null;
  private invite: PairRoom | null = null;
  private pairPhaseValue: PairRoomPhase | 'idle' = 'idle';
  private invitePhaseValue: PairRoomPhase | 'idle' = 'idle';
  private pairUserId: string | null = null;
  private disposed = false;

  constructor(options: DmChannelsOptions) {
    this.options = options;
    this.selfUserId = options.identity.userId;
    active.add(this);
  }

  get pairPhase(): PairRoomPhase | 'idle' {
    return this.pairPhaseValue;
  }

  get invitePhase(): PairRoomPhase | 'idle' {
    return this.invitePhaseValue;
  }

  get pairOnline(): boolean {
    return this.pair?.isOnline === true;
  }

  get inviteOnline(): boolean {
    return this.invite?.isOnline === true;
  }

  get inviteTransport(): DmTransportLike | null {
    return this.invite;
  }

  get pairTransport(): DmTransportLike | null {
    return this.pair;
  }

  /** Транспорт для лички: сначала парная комната, иначе — комната встречи. */
  transportFor(userId: string): DmTransportLike | null {
    if (this.pair?.hasPeer(userId)) {
      return this.pair;
    }
    if (this.invite?.hasPeer(userId)) {
      return this.invite;
    }
    return null;
  }

  async startPair(friendUserId: string): Promise<void> {
    if (this.disposed) {
      return;
    }
    if (this.pairUserId === friendUserId && this.pair && this.pairPhaseValue !== 'error') {
      return;
    }
    this.stopPair();
    this.pairUserId = friendUserId;
    const roomId = await pairRoomId(this.selfUserId, friendUserId);
    if (this.disposed) {
      return;
    }
    const room = new PairRoom({
      roomId,
      kind: 'pair',
      identity: this.options.identity,
      profile: {
        name: this.options.profile.displayName,
        color: this.options.profile.nameColor,
        avatarHash: this.options.profile.avatarHash ?? undefined,
      },
      connect: (strategy, id) => connectTrystero(strategy, id),
      allowedUsers: [friendUserId],
      isBlocked: this.options.isBlocked,
      onEvent: (event) => this.onPairEvent(event, 'pair'),
    });
    this.pair = room;
    this.setPhase('pair', 'connecting');
    await room.start();
  }

  stopPair(): void {
    const room = this.pair;
    this.pair = null;
    this.pairUserId = null;
    if (room) {
      void room.stop();
    }
    this.setPhase('pair', 'idle');
  }

  async startInvite(): Promise<void> {
    if (this.disposed || this.invite) {
      return;
    }
    const roomId = await inviteRoomId(this.selfUserId);
    await this.openInvite(roomId, []);
  }

  /**
   * Подключиться к комнате приглашения пригласившего: ссылка знает только его
   * userId, поэтому комната производна от него.
   */
  async joinInvite(inviterUserId: string): Promise<void> {
    this.stopInvite();
    const roomId = await inviteRoomId(inviterUserId);
    await this.openInvite(roomId, [inviterUserId]);
  }

  private async openInvite(roomId: string, allowedUsers: string[]): Promise<void> {
    if (this.disposed) {
      return;
    }
    const room = new PairRoom({
      roomId,
      kind: 'invite',
      identity: this.options.identity,
      profile: {
        name: this.options.profile.displayName,
        color: this.options.profile.nameColor,
        avatarHash: this.options.profile.avatarHash ?? undefined,
      },
      connect: (strategy, id) => connectTrystero(strategy, id),
      allowedUsers,
      isBlocked: this.options.isBlocked,
      onEvent: (event) => this.onPairEvent(event, 'invite'),
    });
    this.invite = room;
    this.setPhase('invite', 'connecting');
    await room.start();
  }

  stopInvite(): void {
    const room = this.invite;
    this.invite = null;
    if (room) {
      void room.stop();
    }
    this.setPhase('invite', 'idle');
  }

  dispose(): void {
    this.disposed = true;
    active.delete(this);
    this.stopPair();
    this.stopInvite();
  }

  /**
   * Текст в личку. Друг не на связи — сообщение всё равно сохраняется и уходит
   * в outbox, чтобы доставиться при следующей встрече (§4.3).
   */
  async sendText(toUserId: string, text: string): Promise<string | null> {
    const transport = this.transportFor(toUserId) ?? this.localTransport();
    return sendDmText(this.context(transport), toUserId, text);
  }

  /** Фото в личку: чанки, кэш и запись в dm_messages. */
  async sendPhoto(
    toUserId: string,
    input: {
      bytes: Uint8Array;
      mime: string;
      w: number;
      h: number;
      imagePath: string | null;
    },
    onProgress?: (sent: number, total: number) => void,
  ): Promise<string | null> {
    const room = this.pair?.hasPeer(toUserId) ? this.pair : null;
    if (!room) {
      return null;
    }
    const handle = room.sendImage(
      { bytes: input.bytes, mime: input.mime, w: input.w, h: input.h },
      { toUserId, onProgress },
    );
    const result = await handle.done;
    if (!result.ok) {
      return null;
    }
    return sendDmImageMessage(
      this.context(room),
      toUserId,
      handle.id,
      input.imagePath,
    );
  }

  /** Заявка в друзья: сразу, если человек на связи, иначе — в outbox. */
  async requestFriend(toUserId: string, note?: string): Promise<boolean> {
    const transport = this.transportFor(toUserId) ?? this.localTransport();
    return sendFriendRequest(this.context(transport), toUserId, note);
  }

  async acceptFriend(toUserId: string, card?: FriendCard): Promise<boolean> {
    const transport = this.transportFor(toUserId) ?? this.localTransport();
    return sendFriendAccept(this.context(transport), toUserId, card);
  }

  async removeFriend(toUserId: string): Promise<void> {
    const transport = this.transportFor(toUserId) ?? this.localTransport();
    await sendFriendRemove(this.context(transport), toUserId);
  }

  /**
   * Транспорт без канала: подписывает конверт и кладёт его в outbox. Нужен,
   * когда друг офлайн — DM и заявки ждут встречи, а не теряются.
   */
  private localTransport(): DmTransportLike {
    return {
      createSigned: async (type, data, toUserId) => {
        const envelope = createEnvelope(type, data, this.selfUserId, 'dm-outbox', {
          to: toUserId,
        });
        try {
          envelope.sig = await signEnvelope(envelope, this.options.identity.privateJwk);
        } catch {
          return null;
        }
        return envelope;
      },
      sendEnvelope: () => false,
      sendJson: () => false,
      hasPeer: () => false,
    };
  }

  private context(transport: DmTransportLike): DmContext {
    return {
      transport,
      selfUserId: this.selfUserId,
      identity: this.options.identity,
      profile: {
        name: this.options.profile.displayName,
        color: this.options.profile.nameColor,
        avatarHash: this.options.profile.avatarHash ?? null,
      },
      notify: this.options.notify,
      onChange: this.options.onChange,
    };
  }

  private setPhase(kind: 'pair' | 'invite', phase: PairRoomPhase | 'idle'): void {
    if (kind === 'pair') {
      this.pairPhaseValue = phase;
      this.options.onPairPhase?.(phase);
    } else {
      this.invitePhaseValue = phase;
      this.options.onInvitePhase?.(phase);
    }
  }

  private onPairEvent(event: PairRoomEvent, kind: 'pair' | 'invite'): void {
    if (this.disposed) {
      return;
    }
    const room = kind === 'pair' ? this.pair : this.invite;
    switch (event.type) {
      case 'phase':
        this.setPhase(kind, event.phase);
        return;
      case 'ready': {
        this.options.notify(
          kind === 'pair'
            ? `${event.profile.name} на связи — сообщения доставляются сразу`
            : `${event.profile.name} открыл приглашение`,
        );
        if (room) {
          void flushOutboxToPeer(room, this.selfUserId, event.userId).catch(
            () => undefined,
          );
        }
        this.options.onChange();
        return;
      }
      case 'image-start':
      case 'image-progress':
      case 'image-error':
        this.options.onImage?.(event);
        return;
      case 'image':
        this.options.onImage?.(event);
        return;
      case 'error':
        this.options.notify(event.message);
        return;
      default: {
        const incoming = toIncoming(event);
        if (incoming && room) {
          void handleDmEvent(incoming, this.context(room)).catch(() => undefined);
        }
        return;
      }
    }
  }
}
