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
  /** Размер кадра: пропорции окна PiP (этап 4). */
  width: number;
  height: number;
}

export interface SiteNotice {
  text: string;
  at: number;
}

export interface DeepLink {
  code: string;
  at: number;
}

/** Ссылка-приглашение в друзья из deep link `heliwatch://f/<userId>`. */
export interface FriendDeepLink {
  userId: string;
  at: number;
}

/** Age-gate на сайте (best effort, этап 7): только подсказка, без обхода. */
export interface AgeGateInfo {
  detected: boolean;
  host: string;
  hint: string;
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
  /** userId из ссылки heliwatch://f/<userId>: заявка в друзья. */
  friendLink: FriendDeepLink | null;
  /** Счётчик системных «назад» на корне истории — Shell решает, что делать. */
  backRootAt: number;
  /** Системный back при открытой панели React (чат, эмодзи, фото). */
  backOverlayAt: number;
  /** Сайт просит подтвердить возраст: подсказка поверх видео. */
  ageGate: AgeGateInfo | null;
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
    width: 0,
    height: 0,
  },
  fullscreen: false,
  lastTap: null,
  notice: null,
  deepLink: null,
  friendLink: null,
  backRootAt: 0,
  backOverlayAt: 0,
  ageGate: null,
};
