import { addPluginListener, invoke } from '@tauri-apps/api/core';
import type { SiteEvent } from '../features/site/types';

/** Есть ли нативный мост (в браузере предпросмотра его нет). */
export function isNativeRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/**
 * Вызов команды плагина heliwatch. Ошибки не роняют UI: команды этапа 1
 * не критичны, а пользователю показываем понятный тост.
 */
export async function callPlugin<T = null>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T | null> {
  if (!isNativeRuntime()) {
    return null;
  }
  try {
    return await invoke<T>(`plugin:heliwatch|${command}`, args ?? {});
  } catch (error) {
    console.warn(`[heliwatch] команда ${command} не выполнена`, error);
    return null;
  }
}

/**
 * Подписка на события плагина. Возвращает функцию отписки.
 * События идут через Channel: так устроены мобильные плагины Tauri.
 */
export async function onSiteEvent(
  handler: (event: SiteEvent) => void,
): Promise<() => void> {
  const listener = await addPluginListener<SiteEvent>(
    'heliwatch',
    'site-event',
    handler,
  );
  return () => {
    void listener.unregister().catch(() => undefined);
  };
}
