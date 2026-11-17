/*
 * Личные сообщения и друзья поверх DataChannel (этап 7, §4.3).
 *
 * Модуль знает про SQLite и outbox, но не про React и не про конкретный
 * транспорт: комната, парная комната и инвайт-комната дают одинаковый набор
 * методов (createSigned/sendEnvelope/sendJson), поэтому одна и та же логика
 * работает везде, а UI получает общий поток событий.
 *
 * Ключевое правило: друг — это только взаимное подтверждение. Одиночный
 * `friend-request` лежит в ожидающих и на запись в друзьях не влияет.
 */

import type { Identity } from './identity';
import type { Envelope, FriendCard } from './protocol';
import {
  DM_OUTBOX_MAX,
  DM_TEXT_MAX,
  FRIEND_NOTE_MAX,
  createUlid,
  isDmMessagePayload,
  isEnvelope,
  isFriendCard,
  isFriendRequestPayload,
  normalizeChatText,
  type DmMessagePayload,
} from './protocol';
import { addIncomingDm, addOutgoingDm, setDmImagePath, setDmStatus } from '../db/repo/dm';
import {
  getFriend,
  listFriends,
  removeFriend,
  upsertFriend,
} from '../db/repo/friends';
import {
  countOutbox,
  enqueueOutbox,
  listOutboxForPeer,
  markOutboxDelivered,
  markOutboxDeliveredByMessageId,
  markOutboxSent,
  deleteOutbox,
} from '../db/repo/outbox';
import {
  SETTINGS_KEYS,
  readSetting,
  readSettingsByPrefix,
  writeSetting,
} from '../db/repo/settings';

export interface DmProfile {
  name: string;
  color: string;
  avatarHash?: string | null;
}

/**
 * Общий транспорт для комнаты, парной и инвайт-комнаты. `PairRoom` и
 * `RoomClient` реализуют его без наследования.
 */
export interface DmTransportLike {
  createSigned(type: string, data: unknown, toUserId: string): Promise<Envelope | null>;
  sendEnvelope(envelope: Envelope, toUserId?: string): boolean;
  sendJson(type: string, data: unknown, toUserId?: string): boolean;
  hasPeer?(userId: string): boolean;
}

export interface PendingFriendRequest {
  userId: string;
  name: string;
  color: string;
  avatarHash?: string;
  note?: string;
  at: number;
}

export type DmIncomingEvent =
  | { type: 'friend-request'; from: string; card: FriendCard; note?: string }
  | { type: 'friend-accepted'; from: string; card: FriendCard }
  | { type: 'friend-removed'; from: string }
  | { type: 'dm'; from: string; payload: DmMessagePayload; envelope: Envelope }
  | { type: 'dm-ack'; from: string; msgId: string }
  | { type: 'dm-outbox'; from: string; messages: Envelope[] }
  | { type: 'dm-outbox-sync'; from: string; ids: string[] };

export interface DmContext {
  transport: DmTransportLike;
  selfUserId: string;
  identity: Identity;
  profile: DmProfile;
  notify: (text: string) => void;
  /** UI просит перечитать сообщения/друзей. */
  onChange?: () => void;
}

/** Когда `sent` без ack повторяем предложение outbox, а не долбим канал. */
const RETRY_OFFER_MS = 60_000;

/**
 * Фото и `dm-message` могут прийти в любом порядке: чанки — бинарным action,
 * ссылка на них — JSON-сообщением. Держим небольшую карту imageId → путь,
 * чтобы сообщение, пришедшее вторым, сразу получило `image_path`.
 */
const incomingImages = new Map<string, string>();

export function rememberIncomingDmImage(imageId: string, path: string): void {
  if (incomingImages.size >= 32) {
    const oldest = incomingImages.keys().next().value;
    if (typeof oldest === 'string') {
      incomingImages.delete(oldest);
    }
  }
  incomingImages.set(imageId, path);
}

function cardToProfile(card: FriendCard): DmProfile {
  return { name: card.name, color: card.color, avatarHash: card.avatarHash };
}

export async function readFriendRequests(): Promise<PendingFriendRequest[]> {
  const raw = await readSetting<unknown>(SETTINGS_KEYS.friendPending, []);
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.filter((item): item is PendingFriendRequest => {
    if (typeof item !== 'object' || item === null) {
      return false;
    }
    const data = item as Record<string, unknown>;
    return (
      typeof data.userId === 'string' &&
      typeof data.name === 'string' &&
      typeof data.color === 'string' &&
      typeof data.at === 'number'
    );
  });
}

async function saveFriendRequests(list: PendingFriendRequest[]): Promise<void> {
  await writeSetting(SETTINGS_KEYS.friendPending, list.slice(0, 32));
}

export async function addFriendRequest(request: PendingFriendRequest): Promise<void> {
  const list = await readFriendRequests();
  const next = list.filter((item) => item.userId !== request.userId);
  next.push(request);
  await saveFriendRequests(next);
}

export async function dropFriendRequest(userId: string): Promise<void> {
  const list = await readFriendRequests();
  const next = list.filter((item) => item.userId !== userId);
  if (next.length !== list.length) {
    await saveFriendRequests(next);
  }
}

/** Отметки прочтения лички: `dm.lastRead.<userId>`. */
export async function readDmReadMarks(): Promise<Record<string, number>> {
  const values = await readSettingsByPrefix(SETTINGS_KEYS.dmReadPrefix);
  const result: Record<string, number> = {};
  for (const [userId, value] of Object.entries(values)) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      result[userId] = value;
    }
  }
  return result;
}

export async function markConversationRead(peerUserId: string): Promise<void> {
  await writeSetting(`${SETTINGS_KEYS.dmReadPrefix}${peerUserId}`, Date.now());
}

/** Подписать и поставить в outbox; сразу отправить, если друг на связи. */
export async function queueSignedToPeer(
  context: DmContext,
  type: string,
  data: unknown,
  toUserId: string,
  options: { messageId?: string } = {},
): Promise<Envelope | null> {
  const envelope = await context.transport.createSigned(type, data, toUserId);
  if (!envelope) {
    return null;
  }
  await enqueueOutbox({
    id: envelope.id,
    toUserId,
    payload: envelope,
    sig: envelope.sig ?? null,
  });
  if (context.transport.hasPeer?.(toUserId)) {
    const sent = context.transport.sendEnvelope(envelope, toUserId);
    if (sent) {
      await markOutboxSent(envelope.id, Date.now() + RETRY_OFFER_MS);
      if (options.messageId) {
        await setDmStatus(options.messageId, 'sent');
      }
    }
  }
  return envelope;
}

/** Заявка в друзья: ссылка не нужна — userId приходит из приглашения. */
export async function sendFriendRequest(
  context: DmContext,
  toUserId: string,
  note?: string,
): Promise<boolean> {
  if (context.selfUserId === toUserId) {
    return false;
  }
  const payload = {
    name: context.profile.name,
    color: context.profile.color,
    avatarHash: context.profile.avatarHash ?? undefined,
    note: note ? note.slice(0, FRIEND_NOTE_MAX) : undefined,
  };
  const envelope = await queueSignedToPeer(context, 'friend-request', payload, toUserId);
  return envelope !== null;
}

/**
 * Подтверждение дружбы: запись появляется сразу у обоих. Оно тоже уходит в
 * outbox — если собеседник отключился, подтверждение дождётся встречи.
 */
export async function sendFriendAccept(
  context: DmContext,
  toUserId: string,
  card?: FriendCard,
): Promise<boolean> {
  const friend = await getFriend(toUserId);
  const profile = card ? cardToProfile(card) : null;
  if (!friend && !profile) {
    return false;
  }
  const payload = {
    name: context.profile.name,
    color: context.profile.color,
    avatarHash: context.profile.avatarHash ?? undefined,
  };
  const envelope = await queueSignedToPeer(context, 'friend-accept', payload, toUserId);
  await dropFriendRequest(toUserId);
  await deleteOutboxFriendRequests(toUserId);
  if (envelope) {
    await upsertFriend({
      userId: toUserId,
      displayName: friend?.displayName ?? profile?.name ?? 'Друг',
      nameColor: friend?.nameColor ?? profile?.color ?? '#6ff0c4',
      avatarHash: friend?.avatarHash ?? profile?.avatarHash ?? null,
    });
  }
  return envelope !== null;
}

async function deleteOutboxFriendRequests(userId: string): Promise<void> {
  const entries = await listOutboxForPeer(userId);
  for (const entry of entries) {
    if (outboxType(entry.payloadJson) === 'friend-request') {
      await deleteOutbox(entry.id);
    }
  }
}

function outboxType(payloadJson: string): string | null {
  try {
    const parsed: unknown = JSON.parse(payloadJson);
    return isEnvelope(parsed) ? parsed.t : null;
  } catch {
    return null;
  }
}

export async function sendFriendRemove(context: DmContext, toUserId: string): Promise<void> {
  await removeFriend(toUserId);
  await dropFriendRequest(toUserId);
  await queueSignedToPeer(context, 'friend-remove', {}, toUserId);
  context.onChange?.();
}

/** Текст личного сообщения: pending → sent → delivered по `dm-ack`. */
export async function sendDmText(
  context: DmContext,
  toUserId: string,
  raw: string,
): Promise<string | null> {
  const text = normalizeChatText(raw);
  if (!text || text.length > DM_TEXT_MAX) {
    return null;
  }
  const msgId = createUlid();
  const payload: DmMessagePayload = {
    msgId,
    kind: 'text',
    text,
    ts: Date.now(),
  };
  await addOutgoingDm({
    id: msgId,
    peerUserId: toUserId,
    kind: 'text',
    body: text,
    ts: payload.ts,
  });
  const envelope = await queueSignedToPeer(context, 'dm-message', payload, toUserId, {
    messageId: msgId,
  });
  if (!envelope) {
    await setDmStatus(msgId, 'pending');
    return null;
  }
  return msgId;
}

/** Сообщение с фото: сначала байты, потом `dm-message` со ссылкой на imageId. */
export async function sendDmImageMessage(
  context: DmContext,
  toUserId: string,
  imageId: string,
  imagePath: string | null,
): Promise<string | null> {
  const msgId = createUlid();
  const payload: DmMessagePayload = {
    msgId,
    kind: 'image',
    imageId,
    ts: Date.now(),
  };
  await addOutgoingDm({
    id: msgId,
    peerUserId: toUserId,
    kind: 'image',
    body: '',
    ts: payload.ts,
  });
  if (imagePath) {
    await setDmImagePath(msgId, imagePath);
  }
  const envelope = await queueSignedToPeer(context, 'dm-message', payload, toUserId, {
    messageId: msgId,
  });
  return envelope ? msgId : null;
}

/** Предложить другу всё, что накопилось в outbox, одним сообщением. */
export async function flushOutboxToPeer(
  transport: DmTransportLike,
  selfUserId: string,
  peerUserId: string,
): Promise<number> {
  const entries = await listOutboxForPeer(peerUserId);
  if (entries.length === 0) {
    return 0;
  }
  const messages: Envelope[] = [];
  for (const entry of entries) {
    try {
      const parsed: unknown = JSON.parse(entry.payloadJson);
      if (!isEnvelope(parsed) || parsed.from !== selfUserId) {
        continue;
      }
      if (parsed.sig !== entry.sig && entry.sig) {
        parsed.sig = entry.sig;
      }
      if (!parsed.sig) {
        continue;
      }
      messages.push(parsed);
    } catch {
      continue;
    }
  }
  if (messages.length === 0) {
    return 0;
  }
  const chunk = messages.slice(0, DM_OUTBOX_MAX);
  const sent = transport.sendJson('dm-outbox-offer', { messages: chunk }, peerUserId);
  if (!sent) {
    return 0;
  }
  const now = Date.now();
  for (const entry of entries.slice(0, chunk.length)) {
    await markOutboxSent(entry.id, now + RETRY_OFFER_MS);
    try {
      const parsed: unknown = JSON.parse(entry.payloadJson);
      if (isEnvelope(parsed) && parsed.t === 'dm-message' && isDmMessagePayload(parsed.d)) {
        await setDmStatus(parsed.d.msgId, 'sent');
      }
    } catch {
      /* битый payload не должен ломать flush */
    }
  }
  return chunk.length;
}

/** Сколько исходящего ещё не доставлено — для бейджа в интерфейсе. */
export async function pendingOutboxCount(): Promise<number> {
  return countOutbox();
}

/**
 * Обработать входящее событие друга/лички. Возвращает true, если это событие
 * относилось к этапу 7 (тогда комнатный обработчик не должен его дублировать).
 */
export async function handleDmEvent(
  event: DmIncomingEvent,
  context: DmContext,
): Promise<void> {
  switch (event.type) {
    case 'friend-request': {
      const existing = await getFriend(event.from);
      if (existing) {
        // Уже друзья: повторная заявка — просто подтверждаем.
        await sendFriendAccept(context, event.from);
        return;
      }
      const outgoing = await listOutboxForPeer(event.from);
      const mutual = outgoing.some(
        (entry) => outboxType(entry.payloadJson) === 'friend-request',
      );
      if (mutual) {
        // Встречные заявки: обе стороны хотели дружбы — подтверждаем молча.
        await upsertFriend({
          userId: event.from,
          displayName: event.card.name,
          nameColor: event.card.color,
          avatarHash: event.card.avatarHash,
        });
        await deleteOutboxFriendRequests(event.from);
        await dropFriendRequest(event.from);
        await sendFriendAccept(context, event.from);
        context.notify(`Вы теперь друзья: ${event.card.name}`);
        context.onChange?.();
        return;
      }
      await addFriendRequest({
        userId: event.from,
        name: event.card.name,
        color: event.card.color,
        avatarHash: event.card.avatarHash,
        note: event.note,
        at: Date.now(),
      });
      context.notify(`${event.card.name} просит добавить в друзья`);
      context.onChange?.();
      return;
    }
    case 'friend-accepted': {
      await upsertFriend({
        userId: event.from,
        displayName: event.card.name,
        nameColor: event.card.color,
        avatarHash: event.card.avatarHash,
      });
      await deleteOutboxFriendRequests(event.from);
      await dropFriendRequest(event.from);
      context.notify(`${event.card.name} теперь у вас в друзьях`);
      context.onChange?.();
      return;
    }
    case 'friend-removed': {
      const friend = await getFriend(event.from);
      await removeFriend(event.from);
      if (friend) {
        context.notify(`${friend.displayName} удалил вас из друзей`);
      }
      context.onChange?.();
      return;
    }
    case 'dm': {
      await handleIncomingDm(event, context);
      return;
    }
    case 'dm-ack': {
      await setDmStatus(event.msgId, 'delivered');
      await markOutboxDelivered(event.msgId);
      await markOutboxDeliveredByMessageId(event.msgId);
      context.onChange?.();
      return;
    }
    case 'dm-outbox': {
      for (const message of event.messages) {
        if (!isEnvelope(message)) {
          continue;
        }
        if (message.t === 'dm-message' && isDmMessagePayload(message.d)) {
          await handleIncomingDm(
            { type: 'dm', from: message.from, payload: message.d, envelope: message },
            context,
            true,
          );
        } else if (message.t === 'friend-request' && isFriendRequestPayload(message.d)) {
          await handleDmEvent(
            {
              type: 'friend-request',
              from: message.from,
              card: {
                name: message.d.name,
                color: message.d.color,
                avatarHash: message.d.avatarHash,
              },
              note: message.d.note,
            },
            context,
          );
        } else if (message.t === 'friend-accept' && isFriendCard(message.d)) {
          await handleDmEvent(
            {
              type: 'friend-accepted',
              from: message.from,
              card: {
                name: message.d.name,
                color: message.d.color,
                avatarHash: message.d.avatarHash,
              },
            },
            context,
          );
        }
      }
      context.onChange?.();
      return;
    }
    case 'dm-outbox-sync': {
      if (event.ids.length > 0) {
        await flushOutboxToPeer(context.transport, context.selfUserId, event.from);
      }
      return;
    }
    default:
      return;
  }
}

async function handleIncomingDm(
  event: Extract<DmIncomingEvent, { type: 'dm' }>,
  context: DmContext,
  fromOutbox = false,
): Promise<void> {
  const friend = await getFriend(event.from);
  if (!friend) {
    // Личка только для друзей: чужой канал не должен класть сообщения в БД.
    return;
  }
  const inserted = await addIncomingDm({
    id: event.payload.msgId,
    peerUserId: event.from,
    kind: event.payload.kind,
    // У фото в body лежит imageId: по нему файл из `image-*` привязывается к
    // сообщению (отдельной колонки под imageId в §5 нет).
    body:
      event.payload.kind === 'image'
        ? (event.payload.imageId ?? '')
        : (event.payload.text ?? ''),
    ts: event.payload.ts,
    sig: event.envelope.sig ?? null,
    imagePath:
      event.payload.kind === 'image'
        ? incomingImages.get(event.payload.imageId ?? '') ?? null
        : null,
  });
  if (inserted && event.payload.kind === 'image' && event.payload.imageId) {
    const path = incomingImages.get(event.payload.imageId);
    if (path) {
      await setDmImagePath(event.payload.msgId, path);
    }
  }
  if (inserted) {
    context.transport.sendJson(
      'dm-ack',
      { msgId: event.payload.msgId, ts: Date.now() },
      event.from,
    );
    if (!fromOutbox) {
      context.notify(`${friend.displayName}: личное сообщение`);
    }
  }
  context.onChange?.();
}

/** Друзья для UI: один вызов вместо трёх репозиториев. */
export async function listFriendCards(): Promise<
  Array<{ userId: string; name: string; color: string; avatarHash: string | null }>
> {
  const friends = await listFriends();
  return friends.map((friend) => ({
    userId: friend.userId,
    name: friend.displayName,
    color: friend.nameColor,
    avatarHash: friend.avatarHash,
  }));
}

export { cardToProfile };
