import { describe, expect, it } from 'vitest';
import {
  actionFromVideoEvent,
  canonicalJson,
  createEnvelope,
  createNonce,
  createUlid,
  generateRoomCode,
  isEnvelope,
  isNonceFresh,
  isStateRefresh,
  isValidState,
  normalizeRoomCode,
  parseRoomInput,
  projectState,
  roomLink,
  shouldApplyState,
  signingInput,
  type Envelope,
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
