/*
 * Автокоррекция расхождения воспроизведения (§4.5.3) и лимиты команд.
 *
 * Чистые функции без таймеров и DOM: их проверяют тесты, а UI лишь исполняет
 * решение. Пороги из плана: > 1.5 с — seek, 0.3–1.5 с — временная скорость
 * 1.05/0.95 на 4 секунды, < 0.3 с — ничего. Не чаще одной коррекции в 2 с.
 */

import type { PlaybackAction, PlaybackSample, PlaybackState } from './protocol';
import { clampRate, projectState } from './protocol';

export const SEEK_THRESHOLD_SEC = 1.5;
export const RATE_THRESHOLD_SEC = 0.3;
export const RATE_HOLD_MS = 4000;
export const CORRECTION_COOLDOWN_MS = 2000;

export interface CorrectionInput {
  local: PlaybackSample;
  remote: PlaybackState;
  /** Локальное время получения state (performance.now/Date.now — одно и то же). */
  receivedAt: number;
  now: number;
  /** Когда применялась предыдущая коррекция; 0 — ещё не было. */
  lastCorrectionAt: number;
}

/**
 * Решение о коррекции. `null` — расхождение в норме или сработал cooldown.
 * Возвращаемое действие применяется без повторной отправки в сеть.
 */
export function planCorrection(input: CorrectionInput): PlaybackAction | null {
  const { local, remote, receivedAt, now, lastCorrectionAt } = input;

  if (now - lastCorrectionAt < CORRECTION_COOLDOWN_MS) {
    return null;
  }

  // Сначала выравниваем play/pause: пока состояния разные, seek бессмысленен.
  if (local.playing !== remote.playing) {
    return { kind: remote.playing ? 'play' : 'pause' };
  }

  if (!remote.playing) {
    return null;
  }

  const projected = projectState(remote, receivedAt, now);
  const drift = local.time - projected;
  const distance = Math.abs(drift);

  if (distance > SEEK_THRESHOLD_SEC) {
    return { kind: 'seek', t: projected };
  }

  if (distance >= RATE_THRESHOLD_SEC) {
    // Догоняем или притормаживаем; исходную скорость вернёт UI по holdMs.
    const factor = drift > 0 ? 0.95 : 1.05;
    return {
      kind: 'rate',
      rate: clampRate(remote.rate * factor),
      holdMs: RATE_HOLD_MS,
      restoreRate: remote.rate,
    };
  }

  return null;
}

/**
 * Ограничитель команд на пира: не больше 5 команд за 5 секунд (§4.5.3).
 * Нужен и на приёме (чтобы шумный пир не дёргал видео), и на отправке.
 */
export class CommandRateLimiter {
  private readonly max: number;
  private readonly windowMs: number;
  private windowStartedAt = 0;
  private count = 0;

  constructor(max = 5, windowMs = 5000) {
    this.max = max;
    this.windowMs = windowMs;
  }

  allow(now: number): boolean {
    if (now - this.windowStartedAt >= this.windowMs) {
      this.windowStartedAt = now;
      this.count = 0;
    }
    this.count += 1;
    return this.count <= this.max;
  }

  reset(): void {
    this.windowStartedAt = 0;
    this.count = 0;
  }
}

/** Оценка дрейфа для диагностики в интерфейсе (без принятия решения). */
export function driftSeconds(
  localTime: number,
  remote: PlaybackState,
  receivedAt: number,
  now: number,
): number {
  return localTime - projectState(remote, receivedAt, now);
}
