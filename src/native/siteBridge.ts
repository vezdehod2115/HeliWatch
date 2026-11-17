import hookSource from './inject/site-hook.js?raw';
import type { NavAction, SiteEvent } from '../features/site/types';
import { callPlugin, isNativeRuntime, onSiteEvent } from './nativeBridge';
import type { RegionPayload } from './regions';

/** Локальная тестовая страница лежит в assets APK (см. apply-android-patches.mjs). */
export const TEST_PAGE_URL = 'file:///android_asset/test-page.html';
/**
 * Пустая страница комнаты: ровный зелёный фон вместо тестовой страницы.
 * Пока хост не выбрал сайт, за прозрачным React-слоем не должно быть контента.
 */
export const BLANK_URL = 'file:///android_asset/blank.html';
export const YOUTUBE_URL = 'https://m.youtube.com/';

export type SiteUnlisten = () => void;

/** Первый старт: отдаём Kotlin исходник инжекта. Вызывается один раз за сессию. */
export async function initSite(hook: string = hookSource): Promise<boolean> {
  const result = await callPlugin<{ ok?: boolean }>('site_init', { hook });
  return result?.ok === true;
}

export async function openSite(url: string): Promise<void> {
  await callPlugin('site_load', { url });
}

export async function navigateSite(action: NavAction): Promise<void> {
  await callPlugin('site_nav', { action });
}

/** Команда в page-hook: play/pause/seek/setRate/setVolume/probe. */
export async function sendSiteCommand(
  cmd: Record<string, unknown>,
): Promise<void> {
  await callPlugin('site_cmd', { cmd });
}

/**
 * Перехват системного «назад» для оверлеев React (§ этап 3): пока панель чата
 * открыта, back не уходит в историю сайта, а присылает событие `back-overlay`.
 */
export async function captureBack(on: boolean): Promise<void> {
  await navigateSite(on ? 'back-capture-on' : 'back-capture-off');
}

/** Громкость видео сайта 0…1: используется ducking'ом при голосе. */
export async function setSiteVolume(volume: number): Promise<void> {
  await callPlugin('site_cmd', { cmd: { cmd: 'setVolume', volume } });
}

/**
 * Режим поиска: сдвинуть сайт под строку состояния, чтобы шапка сайта
 * (поиск YouTube/Google) не пряталась за часами и батареей.
 */
export async function setBrowseInset(on: boolean): Promise<void> {
  await navigateSite(on ? 'browse-inset-on' : 'browse-inset-off');
}

/** Прямоугольники React-слоя для роутинга касаний. */
export async function sendTapRegions(payload: RegionPayload): Promise<void> {
  await callPlugin('site_regions', { payload });
}

export function subscribeSiteEvents(
  handler: (event: SiteEvent) => void,
): Promise<SiteUnlisten> {
  return onSiteEvent(handler);
}

export { isNativeRuntime };

/**
 * Приводит ввод к URL: `youtube.com` → `https://youtube.com`,
 * `test` → локальная тестовая страница, пусто/мусор → null.
 */
export function normalizeUrl(raw: string): string | null {
  const value = raw.trim();
  if (!value) {
    return null;
  }
  if (/^(https?|file):\/\//i.test(value)) {
    return value;
  }
  if (/^(test|тест|test-page)$/i.test(value)) {
    return TEST_PAGE_URL;
  }
  if (/^[\w-]+(\.[\w-]+)+([/?#].*)?$/.test(value)) {
    return `https://${value}`;
  }
  return null;
}

/** Человекочитаемый адрес для строки ввода. */
export function displayUrl(url: string): string {
  if (!url) {
    return '';
  }
  if (url.includes('test-page.html')) {
    return 'test-page.html';
  }
  return url.replace(/^https?:\/\//, '').replace(/\/$/, '');
}
