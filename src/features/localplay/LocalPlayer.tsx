import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  type ChangeEvent,
  type MouseEvent,
} from 'react';
import { Icon } from '../../app/icons';
import type { PlaybackView } from '../../app/playback';
import type { PlaybackAction, PlaybackSample } from '../../net/protocol';

export interface LocalPlayerHandle {
  apply: (action: PlaybackAction) => void;
  sample: () => PlaybackSample;
  seekTo: (time: number) => void;
  duration: () => number;
  /** Громкость 0…1: ducking приглушает локальный файл, пока кто-то говорит. */
  setVolume: (volume: number) => void;
  /** Размер кадра: пропорции окна PiP (этап 4). */
  dimensions: () => { width: number; height: number };
  /** Сам элемент: из него StreamEngine берёт кадры для раздачи (этап 5). */
  video: () => HTMLVideoElement | null;
}

interface LocalPlayerProps {
  src: string | null;
  fileName: string | null;
  /**
   * `local` — режим C, у каждого свой файл; `stream` — режим B, файл хоста
   * раздаётся зрителям (этап 5).
   */
  variant?: 'local' | 'stream';
  streaming?: boolean;
  viewers?: number;
  onPick: (file: File) => void;
  onMetadata: (duration: number) => void;
  onProgress: (view: PlaybackView) => void;
  onUserAction: (action: PlaybackAction, sample: PlaybackSample) => void;
  onNotice: (text: string) => void;
  /** Первый play: разблокировать звук захвата (AudioContext). */
  onPlayed?: () => void;
}

const REMOTE_GUARD_MS = 800;
const PROGRESS_MS = 250;

/**
 * Локальный файл в React-WebView (режим C). Файл выбирается штатным input:
 * на Android это системный пикер, а blob-URL играет без content://-разрешений.
 *
 * Remote-команды применяются с 800-мс защитой от эха: вызванные ими события
 * play/pause/seeked/ratechange не уходят обратно в комнату.
 */
export const LocalPlayer = forwardRef<LocalPlayerHandle, LocalPlayerProps>(
  function LocalPlayer(
    {
      src,
      fileName,
      variant = 'local',
      streaming = false,
      viewers = 0,
      onPick,
      onMetadata,
      onProgress,
      onUserAction,
      onNotice,
      onPlayed,
    },
    ref,
  ) {
    const videoRef = useRef<HTMLVideoElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);
    const suppressUntil = useRef(0);
    const pending = useRef<PlaybackAction[]>([]);
    const lastProgress = useRef(0);
    const isStream = variant === 'stream';

    const currentSample = (): PlaybackSample => {
      const video = videoRef.current;
      return {
        playing: video ? !video.paused : false,
        time: video?.currentTime ?? 0,
        rate: video?.playbackRate ?? 1,
        duration: video && Number.isFinite(video.duration) ? video.duration : 0,
      };
    };

    const view = (): PlaybackView => {
      const sample = currentSample();
      return {
        found: Boolean(videoRef.current?.src),
        playing: sample.playing,
        time: sample.time,
        duration: sample.duration,
        rate: sample.rate,
      };
    };

    const applyNow = (action: PlaybackAction): void => {
      const video = videoRef.current;
      if (!video) {
        pending.current.push(action);
        return;
      }
      suppressUntil.current = Date.now() + REMOTE_GUARD_MS;
      switch (action.kind) {
        case 'play':
          void video.play().catch(() => {
            onNotice('Браузер заблокировал автозапуск: нажмите play');
          });
          break;
        case 'pause':
          video.pause();
          break;
        case 'seek':
          try {
            video.currentTime = Math.max(0, action.t ?? 0);
          } catch {
            pending.current.push(action);
          }
          break;
        case 'rate': {
          const rate = action.rate ?? 1;
          video.playbackRate = Math.min(4, Math.max(0.25, rate));
          break;
        }
        default:
          break;
      }
    };

    useImperativeHandle(
      ref,
      () => ({
        apply: (action) => {
          if (videoRef.current && videoRef.current.readyState >= 1) {
            applyNow(action);
          } else {
            pending.current.push(action);
          }
        },
        sample: currentSample,
        seekTo: (time) => applyNow({ kind: 'seek', t: time }),
        duration: () => currentSample().duration,
        setVolume: (volume) => {
          const video = videoRef.current;
          if (video) {
            video.volume = Math.min(1, Math.max(0, volume));
          }
        },
        dimensions: () => {
          const video = videoRef.current;
          return {
            width: video?.videoWidth ?? 0,
            height: video?.videoHeight ?? 0,
          };
        },
        video: () => videoRef.current,
      }),
      [],
    );

    useEffect(() => {
      const video = videoRef.current;
      if (!video) {
        return;
      }
      pending.current = [];
      suppressUntil.current = Date.now() + REMOTE_GUARD_MS;
      video.load();
    }, [src]);

    const report = (action: PlaybackAction): void => {
      if (Date.now() < suppressUntil.current) {
        return;
      }
      onUserAction(action, currentSample());
    };

    const handleProgress = (force = false): void => {
      const now = Date.now();
      if (!force && now - lastProgress.current < PROGRESS_MS) {
        return;
      }
      lastProgress.current = now;
      onProgress(view());
    };

    const onLoadedMetadata = (): void => {
      const video = videoRef.current;
      if (!video) {
        return;
      }
      const duration = Number.isFinite(video.duration) ? video.duration : 0;
      onMetadata(duration);
      const actions = pending.current;
      pending.current = [];
      for (const action of actions) {
        applyNow(action);
      }
      handleProgress(true);
    };

    const toggle = (event: MouseEvent): void => {
      event.stopPropagation();
      const video = videoRef.current;
      if (!video) {
        inputRef.current?.click();
        return;
      }
      if (video.paused) {
        void video.play().catch(() => onNotice('Не удалось запустить видео'));
      } else {
        video.pause();
      }
    };

    const onFile = (event: ChangeEvent<HTMLInputElement>): void => {
      const file = event.target.files?.[0];
      event.target.value = '';
      if (file) {
        onPick(file);
      }
    };

    return (
      <div className="hw-player" data-hw-region="player">
        <input
          ref={inputRef}
          className="hw-fileinput"
          type="file"
          accept="video/*,.mkv"
          onChange={onFile}
          aria-hidden="true"
          tabIndex={-1}
        />
        {src ? (
          <>
            <video
              ref={videoRef}
              className="hw-video"
              src={src}
              playsInline
              preload="metadata"
              onClick={toggle}
              onLoadedMetadata={onLoadedMetadata}
              onTimeUpdate={() => handleProgress()}
              onPlay={() => {
                onPlayed?.();
                report({ kind: 'play' });
                handleProgress(true);
              }}
              onPause={() => {
                report({ kind: 'pause' });
                handleProgress(true);
              }}
              onSeeked={() => {
                const video = videoRef.current;
                report({ kind: 'seek', t: video?.currentTime ?? 0 });
                handleProgress(true);
              }}
              onRateChange={() => {
                const video = videoRef.current;
                report({ kind: 'rate', rate: video?.playbackRate ?? 1 });
              }}
              onError={() => {
                onNotice(
                  isStream
                    ? 'WebView не открыл этот файл. Для MKV перекодируйте в MP4 (H.264/AAC).'
                    : 'Не удалось открыть файл: кодек не поддерживается',
                );
              }}
              onEnded={() => {
                const video = videoRef.current;
                report({
                  kind: 'pause',
                  t: Number.isFinite(video?.duration) ? (video?.duration ?? 0) : 0,
                });
              }}
            />
            {!view().playing && (
              <button
                type="button"
                className="hw-player-play"
                onClick={toggle}
                aria-label="Играть"
              >
                <Icon name="play" size={38} />
              </button>
            )}
            <div className="hw-player-file">
              <Icon name={isStream ? 'broadcast' : 'video'} size={14} />
              <span>{fileName}</span>
              {isStream && streaming ? (
                <span className="hw-livechip">
                  эфир · {viewers}
                </span>
              ) : null}
              <button
                type="button"
                className="hw-linkbtn"
                onClick={(event) => {
                  event.stopPropagation();
                  inputRef.current?.click();
                }}
              >
                {isStream ? 'Другой файл' : 'Сменить'}
              </button>
            </div>
          </>
        ) : (
          <div className="hw-player-empty">
            <div className="hw-player-empty-mark">
              <Icon name={isStream ? 'broadcast' : 'video'} size={40} />
            </div>
            <strong>{isStream ? 'Файл для раздачи' : 'Файл ещё не выбран'}</strong>
            <p>
              {isStream
                ? `Выберите видео — зрители (до 2) получат его напрямую с вашего телефона. Пауза и перемотка синхронны. MKV может не играть.`
                : 'В режиме C у каждого свой файл: синхронизируется только время. Размеры и кодеки могут отличаться.'}
            </p>
            <button
              type="button"
              className="hw-primary"
              onClick={(event) => {
                event.stopPropagation();
                inputRef.current?.click();
              }}
            >
              {isStream ? 'Выбрать файл для раздачи' : 'Выбрать видео'}
            </button>
          </div>
        )}
      </div>
    );
  },
);
