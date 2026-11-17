import { callPlugin, isNativeRuntime } from './nativeBridge';
import { sessionPayload, type SessionPayloadInput } from '../features/pip/pipState';

/** Состояние нативного слоя PiP: поддержка устройства и текущий режим. */
export interface NativeSessionInfo {
  pipSupported: boolean;
  inPip: boolean;
  notifications: boolean;
  mic: boolean;
  serviceRunning: boolean;
  roomActive: boolean;
  sdk: number;
}

/**
 * Снимок для PiP: пропорции видео, состояние кнопок и строка сообщения.
 * Kotlin пересчитывает `sourceRectHint` и `setPictureInPictureParams`.
 */
export async function updatePipState(input: SessionPayloadInput): Promise<void> {
  if (!isNativeRuntime()) {
    return;
  }
  await callPlugin('pip_update', { state: sessionPayload(input) });
}

/** Ручной вход в PiP из панели комнаты. */
export async function enterPip(): Promise<{ ok: boolean; error?: string }> {
  if (!isNativeRuntime()) {
    return { ok: false, error: 'PiP доступен только в APK' };
  }
  const result = await callPlugin<{ ok?: boolean; error?: string }>('pip_enter');
  return { ok: result?.ok === true, error: result?.error };
}

/** Поддержка PiP, разрешение на уведомления, состояние сервиса. */
export async function readSessionInfo(): Promise<NativeSessionInfo | null> {
  if (!isNativeRuntime()) {
    return null;
  }
  return callPlugin<NativeSessionInfo>('session_info');
}

export { isNativeRuntime };
