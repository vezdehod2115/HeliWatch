import { describe, expect, it } from 'vitest';
import {
  STREAM_MKV_WARNING,
  STREAM_VIEWER_WARNING,
  captureLabel,
  streamStatusLine,
  viewerWaitingText,
  viewersLabel,
} from './streamCopy';

describe('viewersLabel', () => {
  it('склоняет слово «зритель»', () => {
    expect(viewersLabel(0)).toBe('0 зрителей');
    expect(viewersLabel(1)).toBe('1 зритель');
    expect(viewersLabel(2)).toBe('2 зрителя');
    expect(viewersLabel(11)).toBe('11 зрителей');
    expect(viewersLabel(22)).toBe('22 зрителя');
  });
});

describe('streamStatusLine', () => {
  it('отличает выключенную раздачу, эфир и ошибку', () => {
    expect(streamStatusLine({ streaming: false, viewers: 0 })).toBe('Раздача выключена');
    expect(streamStatusLine({ streaming: true, viewers: 2 })).toBe('В эфире · 2 зрителя');
    expect(
      streamStatusLine({ streaming: true, viewers: 1, error: 'кодек не поддерживается' }),
    ).toBe('кодек не поддерживается');
  });
});

describe('captureLabel', () => {
  it('называет способ захвата', () => {
    expect(captureLabel('direct')).toBe('прямой захват видео');
    expect(captureLabel('canvas')).toBe('canvas-фоллбэк');
    expect(captureLabel(null)).toBe('захват не начат');
  });
});

describe('viewerWaitingText', () => {
  it('объясняет, чего ждёт зритель', () => {
    expect(viewerWaitingText({ hasStream: false, started: false, stopped: false })).toBe(
      'Хост ещё не выбрал файл',
    );
    expect(viewerWaitingText({ hasStream: false, started: true, stopped: false })).toBe(
      'Хост начал раздачу — ждём видео',
    );
    expect(viewerWaitingText({ hasStream: false, started: false, stopped: true })).toBe(
      'Хост остановил раздачу',
    );
    expect(
      viewerWaitingText({ hasStream: false, started: true, stopped: false, error: 'нет видео' }),
    ).toBe('нет видео');
  });
});

describe('предупреждения режима B', () => {
  it('говорят про двух зрителей и MKV', () => {
    expect(STREAM_VIEWER_WARNING).toContain('2 зрителей');
    expect(STREAM_MKV_WARNING).toContain('MP4');
  });
});
