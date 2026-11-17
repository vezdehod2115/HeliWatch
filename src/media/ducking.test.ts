import { describe, expect, it } from 'vitest';
import { DUCK_HOLD_MS, DUCK_VOLUME, DuckingController, FULL_VOLUME } from './ducking';

/** Ручные таймеры: проверяем удержание без ожидания реального времени. */
function manualClock() {
  const applied: number[] = [];
  let pending: { handler: () => void; ms: number } | null = null;
  const controller = new DuckingController({
    apply: (volume) => applied.push(volume),
    setTimer: (handler, ms) => {
      pending = { handler, ms };
      return 1 as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: () => {
      pending = null;
    },
  });
  return {
    controller,
    applied,
    fire() {
      const timer = pending;
      pending = null;
      timer?.handler();
    },
    get pending() {
      return pending;
    },
  };
}

describe('DuckingController', () => {
  it('приглушает звук сразу, как только кто-то заговорил', () => {
    const clock = manualClock();
    clock.controller.setSpeaking('self', true);
    expect(clock.applied).toEqual([DUCK_VOLUME]);
    expect(clock.controller.isDucked).toBe(true);
  });

  it('не дёргает звук на повторных отчётах и от второго говорящего', () => {
    const clock = manualClock();
    clock.controller.setSpeaking('self', true);
    clock.controller.setSpeaking('self', true);
    clock.controller.setSpeaking('peer-a', true);
    expect(clock.applied).toEqual([DUCK_VOLUME]);
    expect(clock.controller.speakingCount).toBe(2);
  });

  it('возвращает громкость через 1200 мс после последнего голоса', () => {
    const clock = manualClock();
    clock.controller.setSpeaking('self', true);
    clock.controller.setSpeaking('self', false);
    expect(clock.pending?.ms).toBe(DUCK_HOLD_MS);
    clock.fire();
    expect(clock.applied).toEqual([DUCK_VOLUME, FULL_VOLUME]);
    expect(clock.controller.isDucked).toBe(false);
  });

  it('не возвращает звук, пока говорит второй участник', () => {
    const clock = manualClock();
    clock.controller.setSpeaking('self', true);
    clock.controller.setSpeaking('peer-a', true);
    clock.controller.setSpeaking('self', false);
    expect(clock.pending).toBeNull();
    clock.controller.setSpeaking('peer-a', false);
    clock.fire();
    expect(clock.applied).toEqual([DUCK_VOLUME, FULL_VOLUME]);
  });

  it('выключенный ducking не трогает громкость', () => {
    const clock = manualClock();
    clock.controller.setEnabled(false);
    clock.controller.setSpeaking('self', true);
    expect(clock.applied).toEqual([]);
  });

  it('выключение возвращает звук сразу', () => {
    const clock = manualClock();
    clock.controller.setSpeaking('self', true);
    clock.controller.setEnabled(false);
    expect(clock.applied).toEqual([DUCK_VOLUME, FULL_VOLUME]);
    clock.controller.setEnabled(true);
    expect(clock.applied).toEqual([DUCK_VOLUME, FULL_VOLUME, DUCK_VOLUME]);
  });

  it('dispose снимает таймер и не возвращает звук', () => {
    const clock = manualClock();
    clock.controller.setSpeaking('self', true);
    clock.controller.setSpeaking('self', false);
    clock.controller.dispose();
    expect(clock.pending).toBeNull();
  });
});
