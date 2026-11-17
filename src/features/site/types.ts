/** Состояние сайта, собранное из событий нативного слоя. */
export type TapTarget = 'react' | 'site' | 'blocked';

export interface VideoInfo {
  found: boolean;
  count: number;
  playing: boolean;
  time: number;
  duration: number;
  rate: number;
  muted: boolean;
}

export interface SiteNotice {
  text: string;
  at: number;
}

export interface DeepLink {
  code: string;
  at: number;
}

export interface SiteStatus {
  url: string;
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
  loading: boolean;
  hookReady: boolean;
  video: VideoInfo;
  fullscreen: boolean;
  lastTap: { target: TapTarget; x: number; y: number; at: number } | null;
  notice: SiteNotice | null;
  /** Код из ссылки heliwatch://r/<code>, пришедшей в Activity. */
  deepLink: DeepLink | null;
  /** Счётчик системных «назад» на корне истории — Shell решает, что делать. */
  backRootAt: number;
  /** Системный back при открытой панели React (чат, эмодзи, фото). */
  backOverlayAt: number;
}

/** Событие из Kotlin: нативное (nav/tap/...) либо обёрнутое событие страницы. */
export interface SiteEvent {
  t?: string;
  event?: string;
  data?: unknown;
  [key: string]: unknown;
}

export type NavAction =
  | 'back'
  | 'forward'
  | 'reload'
  | 'stop'
  | 'back-capture-on'
  | 'back-capture-off';

export const EMPTY_STATUS: SiteStatus = {
  url: '',
  title: '',
  canGoBack: false,
  canGoForward: false,
  loading: false,
  hookReady: false,
  video: {
    found: false,
    count: 0,
    playing: false,
    time: 0,
    duration: 0,
    rate: 1,
    muted: false,
  },
  fullscreen: false,
  lastTap: null,
  notice: null,
  deepLink: null,
  backRootAt: 0,
  backOverlayAt: 0,
};
