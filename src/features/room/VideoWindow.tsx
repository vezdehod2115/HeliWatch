import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Icon } from '../../app/icons';
import { formatTime } from '../../app/playback';

export interface VideoWindowRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface VideoWindowProps {
  /** На странице нашлось видео: в окне показывается кадр сайта. */
  found: boolean;
  playing: boolean;
  time: number;
  duration: number;
  title: string;
  isHost: boolean;
  /** Управление доступно (гость в режиме B смотрит без кнопок). */
  viewOnly: boolean;
  controlsOpen: boolean;
  queueCount: number;
  browserAvailable: boolean;
  onRect: (rect: VideoWindowRect) => void;
  /** Тап по окну: открыть поиск (пусто) или показать/скрыть панель. */
  onTap: () => void;
  onToggleControls: () => void;
  onTogglePlay: () => void;
  onSeekTo: (seconds: number) => void;
  onSeekBy: (seconds: number) => void;
  onSearch: () => void;
  onQueue: () => void;
  onAddToQueue: () => void;
}

/**
 * Видео-окно комнаты (этап 8).
 *
 * Кадр сайта живёт в нативном WebView под React: page-hook выносит <video> в
 * прямоугольник этого окна (setWindow), поэтому React рисует только рамку,
 * заголовок и управление. Тап по окну без видео открывает поиск, с видео —
 * показывает панель управления, как в YouTube.
 */
export function VideoWindow({
  found,
  playing,
  time,
  duration,
  title,
  isHost,
  viewOnly,
  controlsOpen,
  queueCount,
  browserAvailable,
  onRect,
  onTap,
  onToggleControls,
  onTogglePlay,
  onSeekTo,
  onSeekBy,
  onSearch,
  onQueue,
  onAddToQueue,
}: VideoWindowProps) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [dragValue, setDragValue] = useState<number | null>(null);
  const maxDuration = Number.isFinite(duration) && duration > 0 ? duration : 0;
  const shownTime = dragValue ?? (Number.isFinite(time) ? time : 0);
  const controlsVisible = found && controlsOpen && !viewOnly;
  const locked = viewOnly || !found;

  // Прямоугольник окна в CSS-пикселях страницы: по нему page-hook ставит <video>.
  useEffect(() => {
    const element = boxRef.current;
    if (!element) {
      return;
    }
    const report = (): void => {
      const rect = element.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) {
        return;
      }
      onRect({ x: rect.left, y: rect.top, w: rect.width, h: rect.height });
    };
    const observer =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(report);
    observer?.observe(element);
    window.addEventListener('resize', report);
    window.visualViewport?.addEventListener('resize', report);
    window.visualViewport?.addEventListener('scroll', report);
    report();
    const timer = window.setTimeout(report, 250);
    return () => {
      window.clearTimeout(timer);
      observer?.disconnect();
      window.removeEventListener('resize', report);
      window.visualViewport?.removeEventListener('resize', report);
      window.visualViewport?.removeEventListener('scroll', report);
    };
  }, [onRect]);

  const commitSeek = (): void => {
    if (dragValue !== null && !locked) {
      const target = Math.max(0, Math.min(maxDuration || dragValue, dragValue));
      onSeekTo(target);
    }
    setDragValue(null);
  };

  return (
    <div
      ref={boxRef}
      className={`hw-videowindow${found ? ' is-found' : ' is-empty'}${
        controlsVisible ? ' has-controls' : ''
      }`}
      data-hw-region="videowindow"
      onClick={() => {
        if (!found) {
          if (browserAvailable) {
            onSearch();
          } else {
            onTap();
          }
          return;
        }
        onTap();
      }}
      role="group"
      aria-label="Окно видео комнаты"
    >
      {!found && (
        <div className="hw-videowindow-empty">
          <span className="hw-videowindow-mark">
            <Icon name={isHost ? 'search' : 'video'} size={30} />
          </span>
          <strong>{isHost ? 'Найдите видео' : 'Ждём видео от хоста'}</strong>
          <p>
            {isHost
              ? 'Тап по окну откроет поиск. Выберите ролик на сайте — он вернётся сюда и заиграет в этом окне.'
              : 'Хост выбирает сайт и ролик. Видео появится здесь автоматически.'}
          </p>
          {isHost && browserAvailable ? (
            <button
              type="button"
              className="hw-primary hw-primary--compact"
              onClick={(event) => {
                event.stopPropagation();
                onSearch();
              }}
            >
              <Icon name="search" size={16} /> Найти видео
            </button>
          ) : null}
        </div>
      )}

      {found && (
        <>
          <div className="hw-videowindow-top">
            <span className="hw-videowindow-title">{title || 'Видео'}</span>
            {queueCount > 0 ? (
              <button
                type="button"
                className="hw-videowindow-chip"
                onClick={(event) => {
                  event.stopPropagation();
                  onQueue();
                }}
                aria-label="Очередь видео"
              >
                <Icon name="list" size={13} /> {queueCount}
              </button>
            ) : null}
          </div>

          {!playing && !controlsVisible ? (
            <button
              type="button"
              className="hw-videowindow-play"
              onClick={(event) => {
                event.stopPropagation();
                onTogglePlay();
              }}
              aria-label="Играть"
            >
              <Icon name="play" size={34} />
            </button>
          ) : null}

          {controlsVisible && (
            <div
              className="hw-videowindow-controls"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="hw-videowindow-row">
                <button
                  type="button"
                  className="hw-iconbtn hw-iconbtn--small"
                  onClick={onSearch}
                  aria-label="Найти другое видео"
                  title="Найти видео"
                >
                  <Icon name="search" size={18} />
                </button>
                <button
                  type="button"
                  className="hw-videowindow-playbtn"
                  onClick={onTogglePlay}
                  disabled={locked}
                  aria-label={playing ? 'Пауза' : 'Играть'}
                >
                  <Icon name={playing ? 'pause' : 'play'} size={22} />
                </button>
                <button
                  type="button"
                  className="hw-iconbtn hw-iconbtn--small"
                  onClick={onAddToQueue}
                  aria-label="Добавить в очередь"
                  title="В очередь"
                >
                  <Icon name="plus" size={18} />
                </button>
                <button
                  type="button"
                  className="hw-iconbtn hw-iconbtn--small"
                  onClick={onQueue}
                  aria-label="Очередь видео"
                  title="Очередь"
                >
                  <Icon name="list" size={18} />
                </button>
                <button
                  type="button"
                  className="hw-iconbtn hw-iconbtn--small"
                  onClick={onToggleControls}
                  aria-label="Скрыть панель"
                  title="Скрыть"
                >
                  <Icon name="chevron-down" size={18} />
                </button>
              </div>

              <div className="hw-videowindow-seek">
                <span>{formatTime(shownTime)}</span>
                <input
                  type="range"
                  className="hw-seek"
                  min={0}
                  max={maxDuration || 0}
                  step={0.1}
                  value={maxDuration ? Math.min(maxDuration, Math.max(0, shownTime)) : 0}
                  disabled={locked || maxDuration <= 0}
                  onChange={(event) => setDragValue(Number(event.target.value))}
                  onPointerUp={commitSeek}
                  onPointerCancel={commitSeek}
                  onTouchEnd={commitSeek}
                  onKeyUp={commitSeek}
                  onBlur={commitSeek}
                  aria-label="Перемотка видео"
                  style={
                    {
                      '--hw-seek-progress': `${
                        maxDuration > 0 ? Math.min(100, (shownTime / maxDuration) * 100) : 0
                      }%`,
                    } as CSSProperties
                  }
                />
                <span>{maxDuration > 0 ? formatTime(maxDuration) : '—'}</span>
              </div>

              <div className="hw-videowindow-row hw-videowindow-row--sub">
                <button
                  type="button"
                  className="hw-tbtn"
                  onClick={() => onSeekBy(-10)}
                  disabled={locked}
                >
                  −10 с
                </button>
                <button
                  type="button"
                  className="hw-tbtn"
                  onClick={() => onSeekBy(10)}
                  disabled={locked}
                >
                  +10 с
                </button>
                <span className="hw-videowindow-hint">тап по видео — панель</span>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
