/*
 * Чистая логика PiP-слоя и фонового снимка комнаты.
 *
 * Здесь нет ни нативных вызовов, ни React: только преобразования, которые
 * проверяются тестами (`pipState.test.ts`). Нативную часть вызывают
 * `native/pip.ts` и `native/service.ts`.
 */

import type { RoomMode } from '../../net/protocol';

/** Лимиты Android PiP: система отклоняет окна вне этого диапазона. */
export const PIP_MIN_ASPECT = 0.42;
export const PIP_MAX_ASPECT = 2.39;
export const DEFAULT_ASPECT = 16 / 9;

export type PipActionId = 'toggle' | 'mic' | 'expand' | 'leave';
export type PipActionIcon = 'play' | 'pause' | 'mic' | 'mic-off' | 'expand' | 'close';

export interface PipAction {
  id: PipActionId;
  label: string;
  icon: PipActionIcon;
  active: boolean;
}

export interface PipControls {
  playing: boolean;
  micOn: boolean;
  micAvailable: boolean;
}

export interface PipCapability {
  roomActive: boolean;
  pipSupported: boolean;
  inPip: boolean;
}

/** Пропорции текущего видео: мусор и нули дают 16:9, значения — в лимитах PiP. */
export function pipAspect(width: number | undefined, height: number | undefined): number {
  if (
    typeof width !== 'number' ||
    typeof height !== 'number' ||
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    return DEFAULT_ASPECT;
  }
  const aspect = width / height;
  return Math.min(PIP_MAX_ASPECT, Math.max(PIP_MIN_ASPECT, aspect));
}

/** Действия окна PiP: пауза/плей, микрофон и «развернуть». */
export function pipActions(state: PipControls): PipAction[] {
  const actions: PipAction[] = [
    {
      id: 'toggle',
      label: state.playing ? 'Пауза' : 'Играть',
      icon: state.playing ? 'pause' : 'play',
      active: state.playing,
    },
  ];
  if (state.micAvailable) {
    actions.push({
      id: 'mic',
      label: state.micOn ? 'Выключить микрофон' : 'Включить микрофон',
      icon: state.micOn ? 'mic' : 'mic-off',
      active: state.micOn,
    });
  }
  actions.push({ id: 'expand', label: 'Развернуть', icon: 'expand', active: false });
  return actions;
}

/** Кнопки уведомления: те же действия плюс выход из комнаты. */
export function notificationActions(state: PipControls): PipAction[] {
  return [
    ...pipActions(state).filter((action) => action.id !== 'expand'),
    { id: 'leave', label: 'Выйти из комнаты', icon: 'close', active: false },
  ];
}

/** Можно ли входить в PiP: сначала должна быть комната. */
export function shouldEnterPip(state: PipCapability): { ok: boolean; reason?: string } {
  if (!state.roomActive) {
    return { ok: false, reason: 'Сначала войдите в комнату' };
  }
  if (!state.pipSupported) {
    return { ok: false, reason: 'Устройство не поддерживает PiP' };
  }
  return { ok: true };
}

/** Одна строка для PiP-окна: текст, «Фото» или подпись пустого чата. */
export function pipMessageLine(
  message: { kind?: string; text?: string } | null | undefined,
  empty = 'Чат комнаты',
): string {
  if (!message) {
    return empty;
  }
  const raw = (message.text ?? '').replace(/\s+/g, ' ').trim();
  if (raw) {
    return raw.length > 120 ? `${raw.slice(0, 119)}…` : raw;
  }
  if (message.kind === 'image') {
    return 'Фото в чате';
  }
  return empty;
}

/** Время в комнате для PiP-полосы: m:ss, после часа — h:mm:ss. */
export function formatPipUptime(ms: number): string {
  const total = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const ss = String(seconds).padStart(2, '0');
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${ss}`;
  }
  return `${minutes}:${ss}`;
}

export interface SessionPayloadInput {
  code: string;
  title?: string;
  mode: RoomMode;
  roomActive: boolean;
  playing: boolean;
  micOn: boolean;
  message?: string;
  videoWidth?: number;
  videoHeight?: number;
  /** Автовход в PiP из настроек (§4.8, этап 7). По умолчанию включён. */
  pipEnabled?: boolean;
}

/** Снимок для Kotlin: сервис, уведомление и параметры PiP. */
export interface SessionPayload {
  code: string;
  title: string;
  mode: RoomMode;
  roomActive: boolean;
  playing: boolean;
  micOn: boolean;
  message: string;
  videoWidth: number;
  videoHeight: number;
  pipEnabled: boolean;
}

export function sessionPayload(input: SessionPayloadInput): SessionPayload {
  return {
    code: input.code,
    title: (input.title ?? '').slice(0, 80),
    mode: input.mode,
    roomActive: input.roomActive,
    playing: input.playing,
    micOn: input.micOn,
    message: (input.message ?? '').replace(/\s+/g, ' ').slice(0, 140),
    videoWidth: Math.max(0, Math.round(input.videoWidth ?? 0)),
    videoHeight: Math.max(0, Math.round(input.videoHeight ?? 0)),
    pipEnabled: input.pipEnabled !== false,
  };
}

/** Одинаковый снимок не нужно отправлять в Kotlin повторно. */
export function sessionSignature(payload: SessionPayload): string {
  return [
    payload.code,
    payload.title,
    payload.mode,
    payload.roomActive ? '1' : '0',
    payload.playing ? '1' : '0',
    payload.micOn ? '1' : '0',
    payload.message,
    payload.videoWidth,
    payload.videoHeight,
    payload.pipEnabled ? '1' : '0',
  ].join('|');
}
