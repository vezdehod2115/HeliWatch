import { describe, expect, it } from 'vitest';
import {
  ACCENT_C_MIN,
  ACCENT_DEADBAND,
  ACCENT_FALLBACK,
  ACCENT_L_MAX,
  ACCENT_L_MIN,
  ACCENT_MIN_CONTRAST,
  ACCENT_SAMPLE_MS,
  ACCENT_SAMPLE_PIP_MS,
  ACCENT_BACKGROUND,
  AccentController,
  FALLBACK_ACCENT,
  accentCssVariables,
  accentFromSiteFrame,
  averageFrameColor,
  contrastRatio,
  correctAccent,
  deltaE,
  hexToRgb,
  oklchToRgb,
  rgbToHex,
  rgbToOklch,
  sampleVideoFrame,
  type AccentColor,
} from './accent';

describe('акцент: цветовая математика', () => {
  it('переводит hex в rgb и обратно', () => {
    expect(hexToRgb('#6ff0c4')).toEqual({ r: 111, g: 240, b: 196 });
    expect(rgbToHex({ r: 111, g: 240, b: 196 })).toBe('#6ff0c4');
    expect(hexToRgb('nope')).toBeNull();
  });

  it('OKLCH-конверсия сохраняет цвет в пределах округления', () => {
    const original = { r: 220, g: 70, b: 90 };
    const restored = oklchToRgb(rgbToOklch(original));
    expect(Math.abs(restored.r - original.r)).toBeLessThanOrEqual(1);
    expect(Math.abs(restored.g - original.g)).toBeLessThanOrEqual(1);
    expect(Math.abs(restored.b - original.b)).toBeLessThanOrEqual(1);
  });

  it('коррекция держит L и C в безопасном диапазоне', () => {
    for (const color of [
      { r: 255, g: 255, b: 255 },
      { r: 2, g: 2, b: 2 },
      { r: 128, g: 128, b: 128 },
      { r: 200, g: 40, b: 40 },
      { r: 30, g: 80, b: 220 },
    ]) {
      const accent = correctAccent(color);
      expect(accent.lch.l).toBeGreaterThanOrEqual(ACCENT_L_MIN - 0.001);
      expect(accent.lch.l).toBeLessThanOrEqual(ACCENT_L_MAX + 0.001);
      expect(accent.lch.c).toBeGreaterThanOrEqual(ACCENT_C_MIN - 0.001);
      expect(contrastRatio(accent.rgb, ACCENT_BACKGROUND)).toBeGreaterThanOrEqual(
        ACCENT_MIN_CONTRAST,
      );
    }
  });

  it('серый и белый цвет превращаются в мятный оттенок, а не в грязь', () => {
    const mintHue = rgbToOklch(FALLBACK_ACCENT.rgb).h;
    const gray = correctAccent({ r: 128, g: 128, b: 128 });
    expect(Math.abs(gray.lch.h - mintHue)).toBeLessThan(2);
    expect(gray.lch.c).toBeGreaterThanOrEqual(0.1);
  });

  it('дедбенд считает ΔE, а не разницу каналов', () => {
    const base = { r: 100, g: 180, b: 160 };
    expect(deltaE(base, base)).toBe(0);
    expect(deltaE(base, { r: 110, g: 185, b: 165 })).toBeLessThan(ACCENT_DEADBAND);
    expect(deltaE(base, { r: 240, g: 30, b: 40 })).toBeGreaterThan(ACCENT_DEADBAND);
  });

  it('средний цвет игнорирует чёрные поля и прозрачные пиксели', () => {
    const data = new Uint8ClampedArray([
      0, 0, 0, 255,
      0, 0, 0, 255,
      200, 60, 40, 255,
      0, 0, 0, 0,
    ]);
    const rgb = averageFrameColor(data);
    expect(rgb).not.toBeNull();
    expect(rgb?.r).toBeGreaterThan(150);
  });

  it('полностью чёрный кадр — это отсутствие цвета', () => {
    const data = new Uint8ClampedArray(16 * 4);
    expect(averageFrameColor(data)).toBeNull();
  });
});

describe('акцент: события и CSS', () => {
  it('разбирает кадр из site-hook и tainted-сигнал', () => {
    expect(accentFromSiteFrame({ rgb: { r: 10, g: 200, b: 120 }, w: 640, h: 360 })).toEqual({
      rgb: { r: 10, g: 200, b: 120 },
      tainted: false,
    });
    expect(accentFromSiteFrame({ rgb: null })).toEqual({ rgb: null, tainted: true });
    expect(accentFromSiteFrame({ rgb: { r: 999, g: 0, b: 0 } })).toEqual({
      rgb: null,
      tainted: false,
    });
    expect(accentFromSiteFrame(undefined)).toEqual({ rgb: null, tainted: false });
  });

  it('отдаёт переменные --hw-accent*', () => {
    const vars = accentCssVariables(FALLBACK_ACCENT);
    expect(vars['--hw-accent-rgb']).toBe('111 240 196');
    expect(vars['--hw-accent']).toBe(ACCENT_FALLBACK);
    expect(vars['--hw-accent-soft']).toContain('rgb(111 240 196');
  });

  it('локальный <video> без кадра не считается tainted', () => {
    const video = { videoWidth: 0, videoHeight: 0 } as HTMLVideoElement;
    expect(sampleVideoFrame(video)).toEqual({ rgb: null, tainted: false });
  });
});

describe('AccentController', () => {
  function makeController(nowRef: { value: number }, applied: AccentColor[]) {
    return new AccentController({
      now: () => nowRef.value,
      apply: (accent) => applied.push(accent),
      idleMs: 4000,
    });
  }

  it('применяет не чаще интервала и переключается на 2 с в PiP', () => {
    const nowRef = { value: 1000 };
    const applied: AccentColor[] = [];
    const controller = makeController(nowRef, applied);
    // Первый кадр применяется сразу: lastAppliedAt = 0.
    controller.push({ r: 220, g: 60, b: 60 }, nowRef.value);
    expect(applied).toHaveLength(1);
    nowRef.value += 500;
    controller.push({ r: 30, g: 60, b: 220 }, nowRef.value);
    expect(applied).toHaveLength(1);
    nowRef.value += 1200;
    controller.push({ r: 30, g: 60, b: 220 }, nowRef.value);
    expect(applied).toHaveLength(2);

    controller.setPip(true);
    const pipApplied = applied.length;
    nowRef.value += ACCENT_SAMPLE_MS;
    controller.push({ r: 30, g: 200, b: 120 }, nowRef.value);
    expect(applied.length).toBe(pipApplied);
    nowRef.value += ACCENT_SAMPLE_PIP_MS - ACCENT_SAMPLE_MS + 1;
    controller.push({ r: 30, g: 200, b: 120 }, nowRef.value);
    expect(applied.length).toBe(pipApplied + 1);
  });

  it('не перерисовывает тему из-за ΔE меньше дедбенда', () => {
    const nowRef = { value: 10_000 };
    const applied: AccentColor[] = [];
    const controller = makeController(nowRef, applied);
    // EMA сходится к цвету за несколько кадров; дедбенд проверяем на
    // установившемся акценте, а не на первом переходе от мятного.
    for (let step = 0; step < 12; step += 1) {
      nowRef.value += ACCENT_SAMPLE_MS + 1;
      controller.push({ r: 220, g: 60, b: 60 }, nowRef.value);
    }
    const settled = applied.length;
    nowRef.value += ACCENT_SAMPLE_MS + 1;
    controller.push({ r: 221, g: 61, b: 60 }, nowRef.value);
    expect(applied.length).toBe(settled);
  });

  it('null и простой возвращают мятный фоллбэк', () => {
    const nowRef = { value: 20_000 };
    const applied: AccentColor[] = [];
    const controller = makeController(nowRef, applied);
    controller.push({ r: 220, g: 60, b: 60 }, nowRef.value);
    expect(applied.at(-1)?.hex).not.toBe(ACCENT_FALLBACK);
    nowRef.value += ACCENT_SAMPLE_MS + 1;
    controller.push(null, nowRef.value);
    expect(applied.at(-1)?.hex).toBe(ACCENT_FALLBACK);

    nowRef.value += ACCENT_SAMPLE_MS + 1;
    controller.push({ r: 30, g: 200, b: 120 }, nowRef.value);
    nowRef.value += 5000;
    controller.tick(nowRef.value);
    expect(controller.currentAccent.hex).toBe(ACCENT_FALLBACK);
  });

  it('выключенный акцент не реагирует на кадры и сразу сбрасывается', () => {
    const nowRef = { value: 30_000 };
    const applied: AccentColor[] = [];
    const controller = makeController(nowRef, applied);
    controller.push({ r: 220, g: 60, b: 60 }, nowRef.value);
    controller.setEnabled(false);
    expect(applied.at(-1)?.hex).toBe(ACCENT_FALLBACK);
    nowRef.value += 5000;
    controller.push({ r: 20, g: 200, b: 90 }, nowRef.value);
    expect(applied.at(-1)?.hex).toBe(ACCENT_FALLBACK);
  });

  it('EMA не даёт скачка между соседними кадрами', () => {
    const nowRef = { value: 40_000 };
    const applied: AccentColor[] = [];
    const controller = makeController(nowRef, applied);
    controller.push({ r: 230, g: 60, b: 60 }, nowRef.value);
    const red = applied.at(-1);
    nowRef.value += ACCENT_SAMPLE_MS + 1;
    controller.push({ r: 30, g: 70, b: 230 }, nowRef.value);
    const blue = applied.at(-1);
    expect(red && blue).toBeTruthy();
    if (red && blue) {
      const ratio = blue.lch.l / Math.max(0.0001, red.lch.l);
      expect(ratio).toBeLessThan(2);
    }
  });
});
