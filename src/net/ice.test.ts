import { describe, expect, it } from 'vitest';
import {
  TURN_MAX_SERVERS,
  buildRtcConfig,
  getIceOverrides,
  parseTurnJson,
  setIceOverrides,
} from './ice';

const base: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }];

describe('TURN из настроек', () => {
  it('пустая строка — это «свой TURN не задан»', () => {
    expect(parseTurnJson('')).toEqual({ ok: true, servers: [] });
    expect(parseTurnJson('   ')).toEqual({ ok: true, servers: [] });
  });

  it('принимает один объект и массив RTCIceServer', () => {
    const single = parseTurnJson(
      '{"urls":"turn:example.com:3478","username":"u","credential":"p"}',
    );
    expect(single.ok).toBe(true);
    if (single.ok) {
      expect(single.servers).toHaveLength(1);
      expect(single.servers[0]).toMatchObject({
        urls: 'turn:example.com:3478',
        username: 'u',
        credential: 'p',
      });
    }

    const many = parseTurnJson(
      JSON.stringify([
        { urls: ['turn:example.com:3478?transport=udp', 'turns:example.com:443'] },
        { urls: 'stun:example.com:3478' },
      ]),
    );
    expect(many.ok).toBe(true);
    if (many.ok) {
      expect(many.servers).toHaveLength(2);
      expect(many.servers[0]?.urls).toHaveLength(2);
    }
  });

  it('объясняет ошибку, а не молчит', () => {
    expect(parseTurnJson('{') ).toEqual({ ok: false, error: 'TURN: это не JSON' });
    expect(parseTurnJson('{"urls":"http://example.com"}')).toMatchObject({ ok: false });
    expect(parseTurnJson('{"urls":"turn:example.com:3478","username":5}')).toMatchObject({
      ok: false,
    });
    expect(parseTurnJson('null')).toEqual({ ok: false, error: 'TURN: каждый сервер — объект' });
    const tooMany = new Array(TURN_MAX_SERVERS + 1)
      .fill({ urls: 'turn:example.com:3478' })
      .map((item) => item);
    expect(parseTurnJson(JSON.stringify(tooMany))).toEqual({
      ok: false,
      error: `TURN: не больше ${TURN_MAX_SERVERS} серверов`,
    });
  });
});

describe('rtcConfig с настройками', () => {
  it('добавляет свой TURN к публичным STUN', () => {
    setIceOverrides({ servers: [{ urls: 'turn:my.example:3478' }], relayOnly: false });
    const config = buildRtcConfig(base);
    expect(config.iceServers).toHaveLength(2);
    expect(config.iceTransportPolicy).toBeUndefined();
    expect(getIceOverrides().servers).toHaveLength(1);
  });

  it('режим «только TURN» выставляет relay', () => {
    setIceOverrides({ servers: [], relayOnly: true });
    const config = buildRtcConfig(base);
    expect(config.iceTransportPolicy).toBe('relay');
    // Возвращаем дефолт, чтобы тест не влиял на другие файлы.
    setIceOverrides({ servers: [], relayOnly: false });
  });
});
