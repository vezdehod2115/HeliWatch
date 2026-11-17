import { callPlugin, isNativeRuntime } from './nativeBridge';
import { sessionPayload, type SessionPayloadInput } from '../features/pip/pipState';

export interface SessionStartResult {
  ok: boolean;
  error?: string;
  /** false — Android 13+ не показал уведомление: разрешение не выдано. */
  notifications?: boolean;
}

/**
 * Комната открыта: foreground-сервис, уведомление, автовход в PiP.
 * Заодно Kotlin просит разрешение на уведомления (Android 13+).
 */
export async function startSession(input: SessionPayloadInput): Promise<SessionStartResult> {
  if (!isNativeRuntime()) {
    return { ok: true };
  }
  const result = await callPlugin<SessionStartResult>('session_start', {
    state: sessionPayload(input),
  });
  return result ?? { ok: false, error: 'Нативный слой не ответил' };
}

/** Смена воспроизведения, микрофона или последнего сообщения. */
export async function updateSession(input: SessionPayloadInput): Promise<void> {
  if (!isNativeRuntime()) {
    return;
  }
  await callPlugin('session_update', { state: sessionPayload(input) });
}

/** Комната закрыта: сервис, WakeLock и автовход в PiP выключаются. */
export async function stopSession(): Promise<void> {
  if (!isNativeRuntime()) {
    return;
  }
  await callPlugin('session_stop');
}

/** Экран не гаснет, пока идёт воспроизведение (FLAG_KEEP_SCREEN_ON). */
export async function setKeepScreenOn(on: boolean): Promise<void> {
  if (!isNativeRuntime()) {
    return;
  }
  await callPlugin('keep_screen_on', { on });
}

export { isNativeRuntime };
