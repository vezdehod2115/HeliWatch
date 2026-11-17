import { describe, expect, it } from 'vitest';
import {
  SpeakingDetector,
  describeVoiceError,
  levelFromDb,
  rmsFromSamples,
  rmsToDb,
} from './voice';

/** RMS, соответствующий уровню в dBFS (для проверки порогов). */
function rmsForDb(db: number): number {
  return 10 ** (db / 20);
}

describe('уровень микрофона', () => {
  it('RMS считает среднее по сэмплам', () => {
    expect(rmsFromSamples(new Float32Array(0))).toBe(0);
    expect(rmsFromSamples(new Float32Array([1, -1, 1, -1]))).toBeCloseTo(1, 5);
    expect(rmsFromSamples(new Float32Array([0.5, 0.5]))).toBeCloseTo(0.5, 5);
  });

  it('dBFS ограничен снизу и не уходит в −∞', () => {
    expect(rmsToDb(0)).toBe(-80);
    expect(rmsToDb(1)).toBe(0);
    expect(rmsToDb(0.01)).toBeCloseTo(-40, 5);
  });

  it('уровень для полоски лежит в 0…1', () => {
    expect(levelFromDb(-80)).toBe(0);
    expect(levelFromDb(0)).toBe(1);
    expect(levelFromDb(-30)).toBeCloseTo(0.5, 5);
  });
});

describe('SpeakingDetector', () => {
  it('включается на −42 dBFS и держится в гистерезисе', () => {
    const detector = new SpeakingDetector();
    expect(detector.feed(rmsForDb(-60), 0).speaking).toBe(false);
    expect(detector.feed(rmsForDb(-30), 100).speaking).toBe(true);
    // Между порогами состояние не меняется: индикатор не мигает.
    expect(detector.feed(rmsForDb(-46), 200).speaking).toBe(true);
    expect(detector.feed(rmsForDb(-46), 900).speaking).toBe(true);
  });

  it('выключается после 600 мс тишины ниже −48 dBFS', () => {
    const detector = new SpeakingDetector();
    detector.feed(rmsForDb(-30), 0);
    expect(detector.feed(rmsForDb(-60), 100).speaking).toBe(true);
    expect(detector.feed(rmsForDb(-60), 400).speaking).toBe(true);
    expect(detector.feed(rmsForDb(-60), 800).speaking).toBe(false);
  });

  it('reset сбрасывает состояние', () => {
    const detector = new SpeakingDetector();
    detector.feed(rmsForDb(-30), 0);
    expect(detector.speaking).toBe(true);
    detector.reset();
    expect(detector.speaking).toBe(false);
  });
});

describe('describeVoiceError', () => {
  it('объясняет отказ в разрешении и занятый микрофон', () => {
    expect(describeVoiceError({ name: 'NotAllowedError' })).toContain('разрешите запись');
    expect(describeVoiceError({ name: 'NotFoundError' })).toContain('не найден микрофон');
    expect(describeVoiceError({ name: 'NotReadableError' })).toContain('занят');
    expect(describeVoiceError(new Error('boom'))).toContain('boom');
    expect(describeVoiceError(null)).toContain('Не удалось включить микрофон');
  });
});
