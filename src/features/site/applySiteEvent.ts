import { normalizeRoomCode, parseFriendInput } from '../../net/protocol';
import type { SiteEvent, SiteStatus, VideoInfo } from './types';

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const num = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;

const str = (value: unknown, fallback = ''): string =>
  typeof value === 'string' ? value : fallback;

const bool = (value: unknown, fallback = false): boolean =>
  typeof value === 'boolean' ? value : fallback;

const clampTime = (time: number, duration: number): number => {
  if (time < 0) {
    return 0;
  }
  return duration > 0 ? Math.min(time, duration) : time;
};

function applyPageEvent(
  state: SiteStatus,
  event: string,
  raw: unknown,
): SiteStatus {
  const data = isObject(raw) ? raw : {};
  switch (event) {
    case 'hook-ready': {
      const count = num(data.videoCount, state.video.count);
      return {
        ...state,
        hookReady: true,
        url: str(data.href, state.url),
        title: str(data.title, state.title),
        video: {
          ...state.video,
          count,
          found: count > 0,
        },
      };
    }
    case 'video': {
      const count = num(data.count, state.video.count);
      const duration = num(data.duration, state.video.duration);
      const video: VideoInfo = {
        found: count > 0,
        count,
        playing: bool(data.playing, state.video.playing),
        time: clampTime(num(data.time, state.video.time), duration),
        duration,
        rate: num(data.rate, state.video.rate),
        muted: bool(data.muted, state.video.muted),
        width: num(data.width, state.video.width),
        height: num(data.height, state.video.height),
      };
      return { ...state, video };
    }
    case 'note':
      return {
        ...state,
        notice: {
          text: str(data.message, 'Сайт сообщил о проблеме'),
          at: Date.now(),
        },
      };
    case 'age-gate': {
      // Best effort: только подсказка «сайт просит подтвердить возраст».
      if (!bool(data.detected, false)) {
        return { ...state, ageGate: null };
      }
      return {
        ...state,
        ageGate: {
          detected: true,
          host: str(data.host),
          hint: str(data.hint),
          at: Date.now(),
        },
      };
    }
    default: {
      // page-hook присылает remote-play/pause/seek/setRate после применения
      // команды из комнаты: это тоже снимок видео, обновляем состояние.
      if (event.startsWith('remote-') && 'time' in data) {
        const count = num(data.count, state.video.count);
        const duration = num(data.duration, state.video.duration);
        return {
          ...state,
          video: {
            found: count > 0,
            count,
            playing: bool(data.playing, state.video.playing),
            time: clampTime(num(data.time, state.video.time), duration),
            duration,
            rate: num(data.rate, state.video.rate),
            muted: bool(data.muted, state.video.muted),
            width: num(data.width, state.video.width),
            height: num(data.height, state.video.height),
          },
        };
      }
      return state;
    }
  }
}

/** Чистое преобразование event → state: так проще тестировать на этапе 2. */
export function applySiteEvent(state: SiteStatus, event: SiteEvent): SiteStatus {
  switch (event.t) {
    case 'nav':
      return {
        ...state,
        url: str(event.url, state.url),
        title: str(event.title, state.title),
        canGoBack: bool(event.canGoBack, state.canGoBack),
        canGoForward: bool(event.canGoForward, state.canGoForward),
        loading: bool(event.loading, state.loading),
      };
    case 'hook': {
      const count = num(event.videoCount, state.video.count);
      return {
        ...state,
        hookReady: bool(event.ready, state.hookReady),
        video: { ...state.video, count, found: count > 0 },
      };
    }
    case 'tap':
      return {
        ...state,
        lastTap: {
          target:
            event.target === 'react' || event.target === 'site' || event.target === 'blocked'
              ? event.target
              : 'site',
          x: num(event.x, 0),
          y: num(event.y, 0),
          at: Date.now(),
        },
      };
    case 'fullscreen':
      return { ...state, fullscreen: bool(event.on, false) };
    case 'deeplink': {
      const userId = typeof event.friend === 'string' ? parseFriendInput(event.friend) : null;
      if (userId) {
        return { ...state, friendLink: { userId, at: Date.now() } };
      }
      const code = normalizeRoomCode(str(event.code));
      return code ? { ...state, deepLink: { code, at: Date.now() } } : state;
    }
    case 'back-root':
      return {
        ...state,
        backRootAt: state.backRootAt + 1,
      };
    case 'back-overlay':
      // Панель React (чат/эмодзи/фото) сама решает, что закрыть.
      return {
        ...state,
        backOverlayAt: state.backOverlayAt + 1,
      };
    case 'error':
      return {
        ...state,
        notice: {
          text: str(event.message, 'Ошибка нативного слоя'),
          at: Date.now(),
        },
      };
    case 'page':
      return applyPageEvent(state, str(event.event), event.data);
    default:
      return state;
  }
}
