import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ASPECT,
  PIP_MAX_ASPECT,
  PIP_MIN_ASPECT,
  formatPipUptime,
  notificationActions,
  pipActions,
  pipAspect,
  pipMessageLine,
  sessionPayload,
  sessionSignature,
  shouldEnterPip,
} from './pipState';

describe('pipAspect', () => {
  it('берёт пропорции видео', () => {
    expect(pipAspect(1920, 1080)).toBeCloseTo(16 / 9, 5);
    expect(pipAspect(1080, 1920)).toBeCloseTo(9 / 16, 5);
  });

  it('мусор, нули и отрицательные значения дают 16:9', () => {
    expect(pipAspect(0, 0)).toBe(DEFAULT_ASPECT);
    expect(pipAspect(undefined, 1080)).toBe(DEFAULT_ASPECT);
    expect(pipAspect(Number.NaN, 1080)).toBe(DEFAULT_ASPECT);
    expect(pipAspect(-1920, 1080)).toBe(DEFAULT_ASPECT);
  });

  it('обрезает слишком узкие и слишком широкие кадры по лимитам Android', () => {
    expect(pipAspect(100, 1000)).toBe(PIP_MIN_ASPECT);
    expect(pipAspect(4000, 100)).toBe(PIP_MAX_ASPECT);
  });
});

describe('pipActions', () => {
  it('на паузе предлагает play, при воспроизведении — pause', () => {
    const paused = pipActions({ playing: false, micOn: false, micAvailable: true });
    expect(paused[0]).toMatchObject({ id: 'toggle', icon: 'play', label: 'Играть' });

    const playing = pipActions({ playing: true, micOn: true, micAvailable: true });
    expect(playing[0]).toMatchObject({ id: 'toggle', icon: 'pause', label: 'Пауза' });
    expect(playing[1]).toMatchObject({ id: 'mic', icon: 'mic', active: true });
  });

  it('без голоса микрофонной кнопки нет, но «развернуть» остаётся', () => {
    const actions = pipActions({ playing: false, micOn: false, micAvailable: false });
    expect(actions.map((action) => action.id)).toEqual(['toggle', 'expand']);
  });

  it('в уведомлении есть выход из комнаты и нет «развернуть»', () => {
    const actions = notificationActions({ playing: true, micOn: false, micAvailable: true });
    const ids = actions.map((action) => action.id);
    expect(ids).toContain('leave');
    expect(ids).not.toContain('expand');
    expect(ids).toEqual(['toggle', 'mic', 'leave']);
  });
});

describe('shouldEnterPip', () => {
  it('без комнаты вход запрещён', () => {
    expect(shouldEnterPip({ roomActive: false, pipSupported: true, inPip: false })).toEqual({
      ok: false,
      reason: 'Сначала войдите в комнату',
    });
  });

  it('без поддержки PiP на устройстве вход запрещён', () => {
    expect(shouldEnterPip({ roomActive: true, pipSupported: false, inPip: false })).toEqual({
      ok: false,
      reason: 'Устройство не поддерживает PiP',
    });
  });

  it('в комнате на поддерживаемом устройстве вход разрешён', () => {
    expect(shouldEnterPip({ roomActive: true, pipSupported: true, inPip: false })).toEqual({
      ok: true,
    });
  });
});

describe('pipMessageLine', () => {
  it('сжимает пробелы и обрезает длинный текст', () => {
    expect(pipMessageLine({ kind: 'text', text: '  привет   всем ' })).toBe('привет всем');
    const long = pipMessageLine({ kind: 'text', text: 'x'.repeat(300) });
    expect(long).toHaveLength(120);
    expect(long.endsWith('…')).toBe(true);
  });

  it('для фото и пустого чата даёт понятную подпись', () => {
    expect(pipMessageLine({ kind: 'image', text: '' })).toBe('Фото в чате');
    expect(pipMessageLine(null)).toBe('Чат комнаты');
    expect(pipMessageLine({ kind: 'text', text: '   ' })).toBe('Чат комнаты');
  });
});

describe('formatPipUptime', () => {
  it('форматирует время в комнате', () => {
    expect(formatPipUptime(0)).toBe('0:00');
    expect(formatPipUptime(65_000)).toBe('1:05');
    expect(formatPipUptime(3_725_000)).toBe('1:02:05');
    expect(formatPipUptime(Number.NaN)).toBe('0:00');
  });
});

describe('sessionPayload', () => {
  const base = {
    code: 'ABC123',
    title: '  Комната  ',
    mode: 'site' as const,
    roomActive: true,
    playing: true,
    micOn: false,
    message: 'привет\nвсем',
    videoWidth: 1920.4,
    videoHeight: 1080.6,
  };

  it('нормализует строки и округляет размеры', () => {
    const payload = sessionPayload(base);
    expect(payload.message).toBe('привет всем');
    expect(payload.videoWidth).toBe(1920);
    expect(payload.videoHeight).toBe(1081);
    expect(payload.title).toBe('  Комната  ');
  });

  it('одинаковый снимок даёт одинаковую подпись, а изменившийся — разную', () => {
    const first = sessionSignature(sessionPayload(base));
    const second = sessionSignature(sessionPayload({ ...base }));
    expect(second).toBe(first);

    const paused = sessionSignature(sessionPayload({ ...base, playing: false }));
    expect(paused).not.toBe(first);

    const muted = sessionSignature(sessionPayload({ ...base, micOn: true }));
    expect(muted).not.toBe(first);

    const otherMessage = sessionSignature(sessionPayload({ ...base, message: 'другое' }));
    expect(otherMessage).not.toBe(first);
  });

  it('не пропускает отрицательные размеры кадра', () => {
    const payload = sessionPayload({ ...base, videoWidth: -10, videoHeight: -5 });
    expect(payload.videoWidth).toBe(0);
    expect(payload.videoHeight).toBe(0);
  });
});
