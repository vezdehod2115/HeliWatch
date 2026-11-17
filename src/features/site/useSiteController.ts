import { useCallback, useEffect, useRef, useState } from 'react';
import {
  TEST_PAGE_URL,
  YOUTUBE_URL,
  initSite,
  navigateSite,
  normalizeUrl,
  openSite,
  sendSiteCommand,
  subscribeSiteEvents,
} from '../../native/siteBridge';
import { isNativeRuntime } from '../../native/nativeBridge';
import { applySiteEvent } from './applySiteEvent';
import { EMPTY_STATUS, type NavAction, type SiteStatus } from './types';

const notice = (text: string) => ({
  text,
  at: Date.now(),
});

export interface SiteController {
  status: SiteStatus;
  open: (input: string) => Promise<boolean>;
  nav: (action: NavAction) => void;
  reload: () => void;
  togglePlay: () => void;
  seekBy: (seconds: number) => void;
  openTestPage: () => void;
  openYoutube: () => void;
}

/**
 * Старт нативного слоя: подписка на события, передача site-hook в Kotlin,
 * первая загрузка тестовой страницы. Повторно не запускается.
 */
export function useSiteController(): SiteController {
  const [status, setStatus] = useState<SiteStatus>(EMPTY_STATUS);
  const statusRef = useRef(status);
  statusRef.current = status;
  const booted = useRef(false);

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
        if (!disposed) {
          setStatus((current) => applySiteEvent(current, event));
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
        await openSite(TEST_PAGE_URL);
      }
    };

    void boot();

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  const open = useCallback(async (input: string): Promise<boolean> => {
    const url = normalizeUrl(input);
    if (!url) {
      setStatus((current) => ({
        ...current,
        notice: notice('Не понял адрес: введите youtube.com или test'),
      }));
      return false;
    }
    setStatus((current) => ({ ...current, loading: true }));
    await openSite(url);
    return true;
  }, []);

  const nav = useCallback((action: NavAction) => {
    void navigateSite(action);
  }, []);

  const reload = useCallback(() => {
    void navigateSite('reload');
  }, []);

  const togglePlay = useCallback(() => {
    const cmd = statusRef.current.video.playing ? 'pause' : 'play';
    void sendSiteCommand({ cmd });
  }, []);

  const seekBy = useCallback((seconds: number) => {
    const target = Math.max(0, statusRef.current.video.time + seconds);
    void sendSiteCommand({ cmd: 'seek', t: target });
  }, []);

  const openTestPage = useCallback(() => {
    void open(TEST_PAGE_URL);
  }, [open]);

  const openYoutube = useCallback(() => {
    void open(YOUTUBE_URL);
  }, [open]);

  return {
    status,
    open,
    nav,
    reload,
    togglePlay,
    seekBy,
    openTestPage,
    openYoutube,
  };
}
