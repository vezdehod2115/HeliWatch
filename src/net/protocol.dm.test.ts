import { describe, expect, it } from 'vitest';
import {
  FRIEND_LINK_PREFIX,
  createEnvelope,
  createUlid,
  friendInviteLink,
  inviteRoomId,
  isDmAckPayload,
  isDmMessagePayload,
  isDmOutboxOfferPayload,
  isDmOutboxSyncPayload,
  isFriendCard,
  isFriendRequestPayload,
  isUserId,
  pairRoomId,
  parseFriendInput,
  type DmMessagePayload,
} from './protocol';

const USER_ID = 'A'.repeat(80);
const OTHER_ID = 'B'.repeat(80);

describe('приглашение в друзья', () => {
  it('собирает и разбирает ссылку', () => {
    const link = friendInviteLink(USER_ID);
    expect(link.startsWith(FRIEND_LINK_PREFIX)).toBe(true);
    expect(parseFriendInput(link)).toBe(USER_ID);
    expect(parseFriendInput(`Держи ссылку: ${link} — заходи`)).toBe(USER_ID);
    expect(parseFriendInput(USER_ID)).toBe(USER_ID);
    expect(parseFriendInput('hel iwatch://f/short')).toBeNull();
    expect(parseFriendInput('')).toBeNull();
    expect(parseFriendInput('https://example.com')).toBeNull();
  });

  it('userId — это base64url-ключ, а не произвольная строка', () => {
    expect(isUserId(USER_ID)).toBe(true);
    expect(isUserId('has spaces'.padEnd(80, 'x'))).toBe(false);
    expect(isUserId('x'.repeat(10))).toBe(false);
  });

  it('парная и инвайт-комната детерминированы и не зависят от порядка', async () => {
    const left = await pairRoomId(USER_ID, OTHER_ID);
    const right = await pairRoomId(OTHER_ID, USER_ID);
    expect(left).toBe(right);
    expect(left.startsWith('dm-')).toBe(true);
    const invite = await inviteRoomId(USER_ID);
    expect(invite.startsWith('invite-')).toBe(true);
    expect(await inviteRoomId(OTHER_ID)).not.toBe(invite);
  });
});

describe('валидация friend-* и dm-*', () => {
  it('карточка друга: имя 1–24, цвет #rrggbb, аватар ≤128', () => {
    expect(isFriendCard({ name: 'Аня', color: '#6ff0c4' })).toBe(true);
    expect(isFriendCard({ name: 'Аня', color: '#6FF0C4', avatarHash: 'a'.repeat(128) })).toBe(
      true,
    );
    expect(isFriendCard({ name: '', color: '#6ff0c4' })).toBe(false);
    expect(isFriendCard({ name: 'Аня', color: 'green' })).toBe(false);
    expect(isFriendCard({ name: 'Аня', color: '#6ff0c4', avatarHash: 'a'.repeat(129) })).toBe(
      false,
    );
  });

  it('заявка в друзья: записка до 120 символов', () => {
    expect(
      isFriendRequestPayload({ name: 'Аня', color: '#6ff0c4', note: 'привет' }),
    ).toBe(true);
    expect(
      isFriendRequestPayload({ name: 'Аня', color: '#6ff0c4', note: 'x'.repeat(121) }),
    ).toBe(false);
    expect(isFriendRequestPayload({ name: 'Аня', color: '#6ff0c4', note: 5 })).toBe(false);
  });

  it('dm-message: текст или imageId, но не оба сразу', () => {
    const base: DmMessagePayload = {
      msgId: createUlid(),
      kind: 'text',
      text: 'привет',
      ts: Date.now(),
    };
    expect(isDmMessagePayload(base)).toBe(true);
    expect(isDmMessagePayload({ ...base, kind: 'image', text: undefined, imageId: 'abcdefgh' })).toBe(
      true,
    );
    expect(isDmMessagePayload({ ...base, kind: 'image', text: 'и текст', imageId: 'abcdefgh' })).toBe(
      false,
    );
    expect(isDmMessagePayload({ ...base, text: '' })).toBe(false);
    expect(isDmMessagePayload({ ...base, text: 'x'.repeat(4001) })).toBe(false);
    expect(isDmMessagePayload({ ...base, ts: 0 })).toBe(false);
    expect(isDmMessagePayload({ ...base, msgId: 'short' })).toBe(false);
  });

  it('dm-ack и outbox-пакеты', () => {
    const msgId = createUlid();
    expect(isDmAckPayload({ msgId })).toBe(true);
    expect(isDmAckPayload({ msgId: 'x' })).toBe(false);

    expect(isDmOutboxSyncPayload({ ids: [msgId] })).toBe(true);
    expect(isDmOutboxSyncPayload({ ids: ['x'] })).toBe(false);
    expect(isDmOutboxSyncPayload({ ids: new Array(51).fill(msgId) })).toBe(false);

    const envelope = createEnvelope(
      'dm-message',
      { msgId, kind: 'text', text: 'привет', ts: Date.now() },
      USER_ID,
      'room',
      { to: OTHER_ID },
    );
    envelope.sig = 'signature';
    expect(isDmOutboxOfferPayload({ messages: [envelope] })).toBe(true);
    expect(isDmOutboxOfferPayload({ messages: [{ ...envelope, sig: undefined }] })).toBe(false);
    expect(isDmOutboxOfferPayload({ messages: [] })).toBe(false);
  });
});
