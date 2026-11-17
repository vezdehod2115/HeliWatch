import { describe, expect, it } from 'vitest';
import {
  describeCaptureError,
  fitStreamSize,
  isMkvName,
  preferredCaptureMethod,
} from './capture';

describe('fitStreamSize', () => {
  it('не увеличивает маленькое видео', () => {
    expect(fitStreamSize(640, 360)).toEqual({ width: 640, height: 360 });
  });

  it('вписывает большое видео в 1280 px по длинной стороне', () => {
    expect(fitStreamSize(3840, 2160)).toEqual({ width: 1280, height: 720 });
    expect(fitStreamSize(1080, 1920)).toEqual({ width: 720, height: 1280 });
  });

  it('мусор и нули дают нулевой размер', () => {
    expect(fitStreamSize(0, 1080)).toEqual({ width: 0, height: 0 });
    expect(fitStreamSize(Number.NaN, 1080)).toEqual({ width: 0, height: 0 });
    expect(fitStreamSize(-10, 10)).toEqual({ width: 0, height: 0 });
  });
});

describe('isMkvName', () => {
  it('ловит MKV в любом регистре и не путает с MP4', () => {
    expect(isMkvName('movie.mkv')).toBe(true);
    expect(isMkvName('MOVIE.MKV')).toBe(true);
    expect(isMkvName('movie.Mp4')).toBe(false);
    expect(isMkvName('mkv')).toBe(false);
  });
});

describe('preferredCaptureMethod', () => {
  it('выбирает captureStream, если он есть, иначе canvas', () => {
    expect(preferredCaptureMethod({ captureStream: () => undefined })).toBe('captureStream');
    expect(preferredCaptureMethod({ mozCaptureStream: () => undefined })).toBe('captureStream');
    expect(preferredCaptureMethod({})).toBe('canvas');
  });
});

describe('describeCaptureError', () => {
  it('показывает текст ошибки или общую подсказку', () => {
    expect(describeCaptureError(new Error('кодек не поддерживается'))).toBe(
      'кодек не поддерживается',
    );
    expect(describeCaptureError('строка')).toContain('Не удалось захватить видео');
  });
});
