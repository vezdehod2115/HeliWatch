/*
 * Рантайм динамического акцента (§2.5): один контроллер на приложение.
 *
 * Shell включает/выключает акцент по настройке, RoomScreen кормит его кадрами
 * из site-WebView (режим A) или из локального `<video>` (режимы B/C), а при
 * выходе из комнаты возвращает мятный. PiP переключает интервал на 2 секунды.
 */

import {
  ACCENT_SAMPLE_MS,
  AccentController,
  accentFromSiteFrame,
  applyAccentToDocument,
  sampleVideoFrame,
} from './accent';

let controller: AccentController | null = null;
let enabled = true;
let ticker: ReturnType<typeof setInterval> | null = null;

function instance(): AccentController {
  if (!controller) {
    controller = new AccentController({ apply: applyAccentToDocument });
  }
  return controller;
}

export function accentController(): AccentController {
  return instance();
}

/** Включить/выключить акцент по настройке (по умолчанию включён, §2.5). */
export function setAccentEnabled(on: boolean): void {
  enabled = on;
  instance().setEnabled(on);
}

export function isAccentEnabled(): boolean {
  return enabled;
}

/** Кадр из site-hook (режим A). Tainted canvas приходит как `rgb:null`. */
export function pushSiteFrame(data: unknown): void {
  if (!enabled) {
    return;
  }
  const sample = accentFromSiteFrame(data);
  instance().push(sample.rgb);
}

/** Кадр из локального `<video>` (режимы B/C) или из входящего потока. */
export function pushVideoFrame(video: HTMLVideoElement | null): void {
  if (!enabled || !video) {
    return;
  }
  const sample = sampleVideoFrame(video);
  instance().push(sample.rgb);
}

/** Нет кадра / пауза / выключенный акцент → мятный. */
export function pushNoFrame(): void {
  if (!enabled) {
    return;
  }
  instance().push(null);
}

export function setAccentPip(pip: boolean): void {
  instance().setPip(pip);
}

/** Сбросить акцент к мятному (выход из комнаты, выключение в настройках). */
export function resetAccent(): void {
  instance().reset();
}

/**
 * Тикер простоя: если кадров нет дольше 4.5 с, тема возвращается к мятной.
 * Запускается один раз из Shell; возвращает функцию остановки.
 */
export function startAccentTicker(): () => void {
  if (ticker !== null) {
    return () => undefined;
  }
  ticker = setInterval(() => {
    instance().tick();
    // Медленные кадры из <video> не шлются событием: снимаем их сами.
    if (!enabled || typeof document === 'undefined') {
      return;
    }
    const video = document.querySelector<HTMLVideoElement>('video.hw-video');
    if (video && !video.paused && video.readyState >= 2) {
      pushVideoFrame(video);
    }
  }, ACCENT_SAMPLE_MS);
  return () => {
    if (ticker !== null) {
      clearInterval(ticker);
      ticker = null;
    }
  };
}

export { ACCENT_SAMPLE_MS };
