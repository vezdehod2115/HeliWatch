import { useCallback, useEffect, useRef, useState } from 'react';
import {
  BLANK_URL,
  TEST_PAGE_URL,
  YOUTUBE_URL,
  captureBack,
  initSite,
  navigateSite,
  normalizeUrl,
  openSite,
  sendSiteCommand,
  setSiteVolume,
  subscribeSiteEvents,
} from '../../native/siteBridge';
import { isNativeRuntime } from '../../native/nativeBridge';
import type { PlaybackAction } from '../../net/protocol';
import { applySiteEvent } from './applySiteEvent';
import { EMPTY_STATUS, type NavAction, type SiteEvent, type SiteStatus } from './types';

const notice = (text: string) => ({
  text,
  at: Date.now(),
});

export interface SiteController {
  status: SiteStatus;
  open: (input: string) => Promise<boolean>;
  openUrl: (url: string) => Promise<boolean>;
  nav: (action: NavAction) => void;
  reload: () => void;
  applyPlayback: (action: PlaybackAction) => void;
  /** Громкость видео сайта 0…1 (ducking при голосе, этап 3). */
  setVolume: (volume: number) => void;
  /** Перехват системного back, пока открыта панель React. */
  setBackCapture: (on: boolean) => void;
  openTestPage: () => void;
  openYoutube: () => void;
  /** Подписка на «сырые» события для синхронизации комнаты. */
  onEvent: (listener: (event: SiteEvent) => void) => () => void;
}

/**
 * Старт нативного слоя: подписка на события, передача site-hook в Kotlin,
 * первая загрузка тестовой страницы. Повторно не запускается.
 *
 * Хук живёт в Shell всё время работы приложения, поэтому WebView сайта не
 * перезагружается при переходе «главная → комната → главная».
 */
export function useSiteController(): SiteController {
  const [status, setStatus] = useState<SiteStatus>(EMPTY_STATUS);
  const statusRef = useRef(status);
  statusRef.current = status;
  const booted = useRef(false);
  const listeners = useRef(new Set<(event: SiteEvent) => void>());

  useEffect(() => {
    if (booted.current) {
      return;
    }
    booted.current = true;
    let disposed = false;
    let unlisten: (() => void) | undefined;

    const boot = async (): Promise<void> => {
      if (!isNativeRuntime()) {
        setStatus((current) => ({
          ...current,
          notice: notice(
            'Открыто в браузере: второй WebView и тач-роутинг доступны только в APK',
          ),
        }));
        return;
      }
      unlisten = await subscribeSiteEvents((event) => {
        if (disposed) {
          return;
        }
        setStatus((current) => applySiteEvent(current, event));
        for (const listener of listeners.current) {
          try {
            listener(event);
          } catch (error) {
            console.warn('[heliwatch] обработчик события сайта упал', error);
          }
        }
      });
      const ok = await initSite();
      if (!ok) {
        setStatus((current) => ({
          ...current,
          notice: notice('Инжект не принят нативным слоем: сайт откроется без моста'),
        }));
      }
      if (!disposed) {
        // Этап 8.1: на старте — пустая зелёная страница, а не тестовая.
        // Тестовая остаётся только диагностическим ассетом и не открывается.
        await openSite(BLANK_URL);
      }
    };

    void boot();

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  const onEvent = useCallback((listener: (event: SiteEvent) => void) => {
    listeners.current.add(listener);
    return () => {
      listeners.current.delete(listener);
    };
  }, []);

  const openUrl = useCallback(async (url: string): Promise<boolean> => {
    if (!url) {
      return false;
    }
    setStatus((current) => ({ ...current, loading: true }));
    await openSite(url);
    return true;
  }, []);

  const open = useCallback(
    async (input: string): Promise<boolean> => {
      const url = normalizeUrl(input);
      if (!url) {
        setStatus((current) => ({
          ...current,
          notice: notice('Не понял адрес: введите youtube.com или test'),
        }));
        return false;
      }
      return openUrl(url);
    },
    [openUrl],
  );

  const nav = useCallback((action: NavAction) => {
    void navigateSite(action);
  }, []);

  const reload = useCallback(() => {
    void navigateSite('reload');
  }, []);

  /** Команда из сети: page-hook сам гасит эхо на 800 мс. */
  const applyPlayback = useCallback((action: PlaybackAction) => {
    switch (action.kind) {
      case 'play':
        void sendSiteCommand({ cmd: 'play' });
        break;
      case 'pause':
        void sendSiteCommand({ cmd: 'pause' });
        break;
      case 'seek':
        void sendSiteCommand({ cmd: 'seek', t: action.t ?? 0 });
        break;
      case 'rate':
        void sendSiteCommand({ cmd: 'setRate', rate: action.rate ?? 1 });
        break;
      default:
        break;
    }
  }, []);

  const setVolume = useCallback((volume: number) => {
    void setSiteVolume(Math.min(1, Math.max(0, volume)));
  }, []);

  const setBackCapture = useCallback((on: boolean) => {
    void captureBack(on);
  }, []);

  const openTestPage = useCallback(() => {
    void openUrl(TEST_PAGE_URL);
  }, [openUrl]);

  const openYoutube = useCallback(() => {
    void openUrl(YOUTUBE_URL);
  }, [openUrl]);

  return {
    status,
    open,
    openUrl,
    nav,
    reload,
    applyPlayback,
    setVolume,
    setBackCapture,
    openTestPage,
    openYoutube,
    onEvent,
  };
}
