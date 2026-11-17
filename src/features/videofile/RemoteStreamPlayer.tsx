import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
import { Icon } from '../../app/icons';
import { viewerWaitingText } from './streamCopy';

export interface RemoteStreamPlayerHandle {
  setVolume: (volume: number) => void;
  dimensions: () => { width: number; height: number };
  playing: () => boolean;
  play: () => void;
}

interface RemoteStreamPlayerProps {
  stream: MediaStream | null;
  fileName?: string;
  /** Хост уже прислал stream-start (поток может ещё идти). */
  started: boolean;
  /** Хост прислал stream-stop. */
  stopped: boolean;
  error?: string | null;
  hostName?: string;
  onNotice: (text: string) => void;
  onVideoState?: (state: { playing: boolean; width: number; height: number }) => void;
}

/**
 * Экран зрителя в режиме B: хост раздаёт свой файл, поэтому у зрителя нет
 * ни выбора файла, ни перемотки. Остаётся видео, звук и понятное состояние
 * ожидания — чёрный экран без объяснения хуже ошибки.
 */
export const RemoteStreamPlayer = forwardRef<
  RemoteStreamPlayerHandle,
  RemoteStreamPlayerProps
>(function RemoteStreamPlayer(
  { stream, fileName, started, stopped, error, hostName, onNotice, onVideoState },
  ref,
) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [needsGesture, setNeedsGesture] = useState(false);
  const [mutedFallback, setMutedFallback] = useState(false);

  const report = (): void => {
    const video = videoRef.current;
    onVideoState?.({
      playing: Boolean(video && !video.paused),
      width: video?.videoWidth ?? 0,
      height: video?.videoHeight ?? 0,
    });
  };

  const tryPlay = (muted = false): void => {
    const video = videoRef.current;
    if (!video) {
      return;
    }
    video.muted = muted;
    setMutedFallback(muted);
    void video
      .play()
      .then(() => {
        setNeedsGesture(false);
        report();
      })
      .catch(() => {
        // Автоплей с звуком в WebView может быть запрещён до касания.
        setNeedsGesture(true);
        report();
      });
  };

  useImperativeHandle(
    ref,
    () => ({
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
      playing: () => Boolean(videoRef.current && !videoRef.current.paused),
      play: () => tryPlay(false),
    }),
    [],
  );

  useEffect(() => {
    const video = videoRef.current;
    if (!video) {
      return;
    }
    video.srcObject = stream;
    if (stream) {
      tryPlay(false);
    } else {
      setNeedsGesture(false);
    }
    return () => {
      if (video.srcObject === stream) {
        video.srcObject = null;
      }
    };
  }, [stream]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) {
      return;
    }
    const onState = (): void => report();
    video.addEventListener('playing', onState);
    video.addEventListener('pause', onState);
    video.addEventListener('loadedmetadata', onState);
    return () => {
      video.removeEventListener('playing', onState);
      video.removeEventListener('pause', onState);
      video.removeEventListener('loadedmetadata', onState);
    };
  }, []);

  const waiting = viewerWaitingText({
    hasStream: stream !== null,
    started,
    stopped,
    error,
  });
  const showOverlay = !stream || needsGesture;

  return (
    <div className="hw-streamplayer" data-hw-region="player">
      <video
        ref={videoRef}
        className="hw-video"
        playsInline
        autoPlay
        muted={mutedFallback}
        onClick={() => {
          const video = videoRef.current;
          if (!video || !stream) {
            return;
          }
          if (needsGesture) {
            tryPlay(false);
            return;
          }
          if (video.paused) {
            void video.play().catch(() => setNeedsGesture(true));
          }
        }}
        onPlaying={report}
        onPause={report}
        onLoadedMetadata={report}
        onError={() => onNotice('Поток от хоста не открылся: попросите перезапустить раздачу')}
      />

      {showOverlay && (
        <div className="hw-streamplayer-wait">
          {stream && needsGesture ? (
            <>
              <div className="hw-player-empty-mark">
                <Icon name="play" size={36} />
              </div>
              <strong>Включите звук и видео</strong>
              <p>Android не разрешает автозапуск со звуком без касания.</p>
              <button type="button" className="hw-primary" onClick={() => tryPlay(false)}>
                Включить
              </button>
            </>
          ) : (
            <>
              <span className={`hw-spinner${stopped || error ? ' is-idle' : ''}`} aria-hidden="true" />
              <strong>{fileName ?? 'Файл хоста'}</strong>
              <p>{waiting}</p>
              {hostName ? <span className="hw-streamplayer-host">Раздаёт {hostName}</span> : null}
            </>
          )}
        </div>
      )}

      {stream && !showOverlay && (
        <div className="hw-streamplayer-bar">
          <span className="hw-dot is-live" />
          <Icon name="video" size={14} />
          <span className="hw-streamplayer-name">{fileName ?? 'Файл хоста'}</span>
          <span className="hw-streamplayer-view">только просмотр</span>
        </div>
      )}
    </div>
  );
});
