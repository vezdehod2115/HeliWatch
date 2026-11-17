import { describe, expect, it } from 'vitest';
import {
  actionFromVideoEvent,
  canonicalJson,
  createEnvelope,
  createNonce,
  createUlid,
  generateRoomCode,
  isCapabilityData,
  isEnvelope,
  isHostTransferPayload,
  isKickPayload,
  isLobbyCard,
  isLobbyCardPayload,
  isNonceFresh,
  isRoomMetaPayload,
  isStateRefresh,
  isStreamStartData,
  isStreamStopData,
  isValidState,
  normalizePassword,
  normalizeRoomCode,
  normalizeRoomLimit,
  normalizeRoomTitle,
  parseRoomInput,
  passwordHash,
  pickSuccessor,
  projectState,
  roomLimitForMode,
  roomLink,
  shouldApplyState,
  signalingRoomId,
  signingInput,
  type Envelope,
  type LobbyCard,
  type PlaybackState,
} from './protocol';

describe('canonicalJson', () => {
  it('сортирует ключи и опускает undefined', () => {
    expect(canonicalJson({ b: 1, a: 2, c: undefined })).toBe('{"a":2,"b":1}');
    expect(canonicalJson({ a: [3, { z: 1, y: 2 }] })).toBe('{"a":[3,{"y":2,"z":1}]}');
  });

  it('не зависит от порядка вставки ключей', () => {
    const first = { v: 1, t: 'x', d: { b: true, a: 'q' } };
    const second = { d: { a: 'q', b: true }, t: 'x', v: 1 };
    expect(canonicalJson(first)).toBe(canonicalJson(second));
  });
});

describe('envelope', () => {
  const envelope: Envelope = {
    v: 1,
    t: 'state',
    id: '01J00000000000000000000000',
    ts: 1,
    from: 'user',
    rid: 'ABC123',
    d: { seq: 1 },
  };

  it('включает тег типа в подписываемый вход', () => {
    const input = signingInput(envelope);
    expect(input.endsWith('heliwatch/v1/state')).toBe(true);
    expect(signingInput({ ...envelope, t: 'play' })).not.toBe(input);
  });

  it('не подписывает поле sig', () => {
    expect(signingInput({ ...envelope, sig: 'a' })).toBe(signingInput({ ...envelope, sig: 'b' }));
  });

  it('валидирует форму и rid', () => {
    expect(isEnvelope(envelope, 'ABC123')).toBe(true);
    expect(isEnvelope(envelope, 'ZZZ999')).toBe(false);
    expect(isEnvelope({ ...envelope, v: 2 })).toBe(false);
    expect(isEnvelope({ ...envelope, d: null })).toBe(false);
  });

  it('createEnvelope проставляет версию, rid и адресата', () => {
    const created = createEnvelope('hello', { a: 1 }, 'me', 'ABC123', { to: 'peer', now: 5 });
    expect(created.v).toBe(1);
    expect(created.rid).toBe('ABC123');
    expect(created.to).toBe('peer');
    expect(created.ts).toBe(5);
    expect(created.id).toHaveLength(26);
  });
});

describe('ULID', () => {
  it('26 символов Crockford и уникальность в пределах миллисекунды', () => {
    const first = createUlid(1_700_000_000_000);
    const second = createUlid(1_700_000_000_000);
    expect(first).toHaveLength(26);
    expect(second).toHaveLength(26);
    expect(first).not.toBe(second);
  });
});

describe('коды комнат', () => {
  it('генерирует 6 символов из разрешённого алфавита', () => {
    const code = generateRoomCode(new Uint8Array([0, 1, 2, 3, 4, 5]));
    expect(code).toHaveLength(6);
    expect(normalizeRoomCode(code)).toBe(code);
  });

  it('нормализует регистр и похожие буквы', () => {
    expect(normalizeRoomCode('abc-def')).toBe('ABCDEF');
    expect(normalizeRoomCode('oi l0ab')).toBe('0110AB');
    expect(normalizeRoomCode('ABC')).toBeNull();
    expect(normalizeRoomCode('ABC!@#')).toBeNull();
  });

  it('разбирает ссылку и текст с ней', () => {
    expect(parseRoomInput(roomLink('ABC234'))).toBe('ABC234');
    expect(parseRoomInput('заходи heliwatch://r/abc-234')).toBe('ABC234');
    expect(parseRoomInput('ABC234')).toBe('ABC234');
    expect(parseRoomInput('https://example.com')).toBeNull();
  });
});

describe('nonce', () => {
  it('свежий только внутри TTL', () => {
    const nonce = createNonce(new Uint8Array(16).fill(7));
    expect(nonce.length).toBeGreaterThan(0);
    expect(isNonceFresh(1000, 1000)).toBe(true);
    expect(isNonceFresh(60_000, 0)).toBe(true);
    expect(isNonceFresh(60_001, 0)).toBe(false);
    expect(isNonceFresh(0, 10)).toBe(false);
  });
});

describe('Lamport seq', () => {
  it('больший seq побеждает, равный — по userId', () => {
    expect(shouldApplyState(null, { seq: 1, by: 'a' })).toBe(true);
    expect(shouldApplyState({ seq: 2, by: 'a' }, { seq: 1, by: 'z' })).toBe(false);
    expect(shouldApplyState({ seq: 2, by: 'a' }, { seq: 2, by: 'b' })).toBe(true);
    expect(shouldApplyState({ seq: 2, by: 'b' }, { seq: 2, by: 'a' })).toBe(false);
    expect(isStateRefresh({ seq: 2, by: 'a' }, { seq: 2, by: 'a' })).toBe(true);
    expect(isStateRefresh({ seq: 2, by: 'a' }, { seq: 3, by: 'a' })).toBe(false);
  });
});

describe('воспроизведение', () => {
  const state: PlaybackState = {
    playing: true,
    t: 10,
    rate: 1,
    src: { mode: 'site', url: 'https://example.com', duration: 100 },
    seq: 3,
    by: 'user',
  };

  it('проецирует время с учётом паузы и duration', () => {
    expect(projectState(state, 1000, 3000)).toBe(12);
    expect(projectState({ ...state, playing: false }, 1000, 3000)).toBe(10);
    expect(projectState({ ...state, t: 99 }, 0, 5000)).toBe(100);
  });

  it('валидирует state и авторство', () => {
    expect(isValidState(state, 'user')).toBe(true);
    expect(isValidState(state, 'other')).toBe(false);
    expect(isValidState({ ...state, rate: 'fast' }, 'user')).toBe(false);
    expect(isValidState({ ...state, src: { mode: 'x', duration: 0 } }, 'user')).toBe(false);
  });

  it('превращает события page-hook в действия', () => {
    expect(actionFromVideoEvent('play', {})).toEqual({ kind: 'play' });
    expect(actionFromVideoEvent('seeked', { time: 42 })).toEqual({ kind: 'seek', t: 42 });
    expect(actionFromVideoEvent('ratechange', { rate: 1.5 })).toEqual({ kind: 'rate', rate: 1.5 });
    expect(actionFromVideoEvent('ended', { duration: 99 })).toEqual({ kind: 'pause', t: 99 });
    expect(actionFromVideoEvent('timeupdate', { time: 5 })).toBeNull();
    expect(actionFromVideoEvent('remote-play', {})).toBeNull();
  });
});

describe('стрим файла хоста (этап 5)', () => {
  it('лимит комнаты в режиме stream — 3 участника', () => {
    expect(roomLimitForMode('stream')).toBe(3);
    expect(roomLimitForMode('site')).toBe(4);
    expect(roomLimitForMode('local')).toBe(4);
  });

  it('stream-start принимает только 1–2 зрителя и известный способ захвата', () => {
    expect(
      isStreamStartData({ maxViewers: 2, capture: 'direct', fileName: 'a.mp4', duration: 90 }),
    ).toBe(true);
    expect(isStreamStartData({ maxViewers: 0, capture: 'direct' })).toBe(false);
    expect(isStreamStartData({ maxViewers: 3, capture: 'direct' })).toBe(false);
    expect(isStreamStartData({ maxViewers: 2, capture: 'unknown' })).toBe(false);
    expect(isStreamStartData({ maxViewers: 2, capture: 'canvas', duration: -1 })).toBe(false);
  });

  it('stream-stop и capability валидируются', () => {
    expect(isStreamStopData({ reason: 'host-stop' })).toBe(true);
    expect(isStreamStopData({ reason: 'что-то' })).toBe(false);
    expect(isCapabilityData({ canCapture: true, maxViewers: 2, capture: 'canvas' })).toBe(true);
    expect(isCapabilityData({ canCapture: false, maxViewers: 0 })).toBe(true);
    expect(isCapabilityData({ canCapture: 'yes', maxViewers: 2 })).toBe(false);
  });

  it('state с источником stream проходит валидацию', () => {
    expect(
      isValidState(
        {
          playing: true,
          t: 10,
          rate: 1,
          src: { mode: 'stream', fileName: 'host.mp4', duration: 100 },
          seq: 3,
          by: 'user-host',
        },
        'user-host',
      ),
    ).toBe(true);
  });
});

describe('этап 6: пароль как ключ сигналинга', () => {
  it('комната без пароля живёт под кодом', async () => {
    expect(await signalingRoomId('ABC234', null)).toBe('ABC234');
    expect(await signalingRoomId('ABC234', '   ')).toBe('ABC234');
  });

  it('пароль меняет идентификатор сигналинга детерминированно', async () => {
    const first = await signalingRoomId('ABC234', 'тайный кот');
    const again = await signalingRoomId('ABC234', 'тайный кот');
    const other = await signalingRoomId('ABC234', 'другой кот');
    expect(first).toBe(again);
    expect(first).not.toBe(other);
    expect(first.startsWith('ABC234-')).toBe(true);
    expect(first.length).toBeGreaterThan('ABC234'.length + 6);
  });

  it('хеш пароля привязан к коду комнаты', async () => {
    const one = await passwordHash('ABC234', 'секрет');
    const same = await passwordHash('ABC234', 'секрет');
    const otherRoom = await passwordHash('XYZ789', 'секрет');
    expect(one).toBe(same);
    expect(one).not.toBe(otherRoom);
    expect(one).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('пароль короче 4 символов не считается паролем', () => {
    expect(normalizePassword('123')).toBeNull();
    expect(normalizePassword(' 1234 ')).toBe('1234');
    expect(normalizePassword('')).toBeNull();
    expect(normalizePassword('x'.repeat(65))).toBeNull();
  });
});

describe('этап 6: карточка лобби', () => {
  const card = (patch: Partial<LobbyCard> = {}): LobbyCard => ({
    code: 'ABC234',
    title: 'Вечерний сериал',
    mode: 'site',
    closed: false,
    limit: 4,
    count: 2,
    hasPassword: true,
    knock: true,
    hostUserId: 'host-user',
    updatedAt: 1_700_000_000_000,
    ...patch,
  });

  it('валидная карточка проходит, полезна и упаковка', () => {
    expect(isLobbyCard(card())).toBe(true);
    expect(isLobbyCardPayload({ card: card() })).toBe(true);
  });

  it('закрытая карточка валидна: отсутствие в лобби решает хост', () => {
    expect(isLobbyCard(card({ closed: true }))).toBe(true);
  });

  it('count не больше лимита, лимит в границах 2–6', () => {
    expect(isLobbyCard(card({ count: 4, limit: 4 }))).toBe(true);
    expect(isLobbyCard(card({ count: 5, limit: 4 }))).toBe(false);
    expect(isLobbyCard(card({ limit: 1 }))).toBe(false);
    expect(isLobbyCard(card({ limit: 7 }))).toBe(false);
  });

  it('код нормализован, режим известен, hostUserId не пуст', () => {
    expect(isLobbyCard(card({ code: 'abc234' }))).toBe(false);
    expect(isLobbyCard(card({ mode: 'movie' as LobbyCard['mode'] }))).toBe(false);
    expect(isLobbyCard(card({ hostUserId: '' }))).toBe(false);
    expect(isLobbyCard(card({ title: '   ' }))).toBe(false);
    expect(isLobbyCard(card({ knock: 'да' as unknown as boolean }))).toBe(false);
  });
});

describe('этап 6: room-meta, кик и выборы хоста', () => {
  it('room-meta принимает частичные правки и отвергает мусор', () => {
    expect(isRoomMetaPayload({ title: 'Новое имя' })).toBe(true);
    expect(isRoomMetaPayload({ closed: true, knock: false })).toBe(true);
    expect(isRoomMetaPayload({ limit: 6 })).toBe(true);
    expect(isRoomMetaPayload({})).toBe(false);
    expect(isRoomMetaPayload({ limit: 1 })).toBe(false);
    expect(isRoomMetaPayload({ title: 'x'.repeat(60) })).toBe(false);
    expect(isRoomMetaPayload({ closed: 'yes' })).toBe(false);
  });

  it('kick/ban: цель обязательна, срок не отрицательный', () => {
    expect(isKickPayload({ target: 'user-a' })).toBe(true);
    expect(isKickPayload({ target: 'user-a', reason: 'спам', until: 123 })).toBe(true);
    expect(isKickPayload({ target: '' })).toBe(false);
    expect(isKickPayload({ target: 'user-a', until: -1 })).toBe(false);
    expect(isHostTransferPayload({ target: 'user-a', epoch: 2 })).toBe(true);
    expect(isHostTransferPayload({ target: 'user-a', epoch: 0 })).toBe(false);
  });

  it('преемник хоста выбирается по userId, а не по часам устройств', () => {
    expect(
      pickSuccessor([
        { userId: 'user-c', host: false },
        { userId: 'user-a', host: false },
        { userId: 'host', host: true },
      ]),
    ).toBe('user-a');
    expect(pickSuccessor([{ userId: 'host', host: true }])).toBeNull();
    expect(pickSuccessor([])).toBeNull();
  });
});

describe('этап 6: нормализация настроек комнаты', () => {
  it('название обрезается, пустое — дефолт по коду', () => {
    expect(normalizeRoomTitle('  Кино  ', 'ABC234')).toBe('Кино');
    expect(normalizeRoomTitle('', 'ABC234')).toBe('Комната ABC234');
    expect(normalizeRoomTitle('x'.repeat(80), 'ABC234')).toHaveLength(48);
  });

  it('лимит в режиме B жёстко 3, иначе 2–6', () => {
    expect(normalizeRoomLimit(6, 'stream')).toBe(3);
    expect(normalizeRoomLimit(6, 'site')).toBe(6);
    expect(normalizeRoomLimit(1, 'site')).toBe(2);
    expect(normalizeRoomLimit(Number.NaN, 'site')).toBe(4);
  });
});
