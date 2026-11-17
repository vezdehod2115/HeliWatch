import type { SiteStatus } from './types';
import { Icon } from '../../app/icons';

interface BottomBarProps {
  status: SiteStatus;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onTogglePlay: () => void;
  onSeek: (seconds: number) => void;
  onReload: () => void;
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return '0:00';
  }
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;
  const ss = String(rest).padStart(2, '0');
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${ss}`;
  }
  return `${minutes}:${ss}`;
}

/** Нижняя панель: состояние видео страницы и тестовые команды через мост. */
export function BottomBar({
  status,
  collapsed,
  onToggleCollapsed,
  onTogglePlay,
  onSeek,
  onReload,
}: BottomBarProps) {
  const { video, hookReady } = status;
  const label = !hookReady
    ? 'Инжект не готов'
    : video.found
      ? video.playing
        ? 'Играет'
        : 'Пауза'
      : 'Видео не найдено';

  return (
    <footer
      className={`hw-panel hw-bottombar${collapsed ? ' is-collapsed' : ''}`}
      data-hw-region="bottombar"
    >
      {collapsed ? (
        <button
          type="button"
          className="hw-collapsed"
          onClick={onToggleCollapsed}
          aria-label="Развернуть панель управления"
        >
          <Icon name={video.playing ? 'pause' : 'play'} size={16} />
          <span>{formatTime(video.time)}</span>
          <Icon name="chevron-up" size={16} />
        </button>
      ) : (
        <>
          <div className="hw-videorow">
            <span className={`hw-dot${video.playing ? ' is-live' : ''}`} />
            <span className={`hw-video-label${video.playing ? ' is-live' : ''}`}>
              {label}
            </span>
            {hookReady && (
              <span className="hw-badge" title="page-hook внедрён">
                hook
              </span>
            )}
            <span className="hw-time">
              {video.found
                ? `${formatTime(video.time)} / ${formatTime(video.duration)}`
                : '—'}
            </span>
            <button
              type="button"
              className="hw-collapsebtn"
              onClick={onToggleCollapsed}
              aria-label="Свернуть панель управления"
            >
              <Icon name="chevron-down" size={18} />
            </button>
          </div>

          <div className="hw-transport">
            <button
              type="button"
              className="hw-tbtn"
              onClick={() => onSeek(-10)}
              disabled={!video.found}
              aria-label="Назад на 10 секунд"
            >
              −10 с
            </button>
            <button
              type="button"
              className="hw-play"
              onClick={onTogglePlay}
              disabled={!video.found}
              aria-label={video.playing ? 'Пауза' : 'Играть'}
            >
              <Icon name={video.playing ? 'pause' : 'play'} size={24} />
            </button>
            <button
              type="button"
              className="hw-tbtn"
              onClick={() => onSeek(10)}
              disabled={!video.found}
              aria-label="Вперёд на 10 секунд"
            >
              +10 с
            </button>
            <button
              type="button"
              className="hw-tbtn hw-tbtn--icon"
              onClick={onReload}
              aria-label="Перезагрузить сайт"
            >
              <Icon name="reload" size={18} />
            </button>
          </div>
        </>
      )}
    </footer>
  );
}
