import { Icon } from '../../app/icons';
import { formatTime, type PlaybackView } from '../../app/playback';

interface BottomBarProps {
  view: PlaybackView;
  label: string;
  mode: 'site' | 'local';
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onTogglePlay: () => void;
  onSeek: (seconds: number) => void;
  onRate: (rate: number) => void;
  onReload?: () => void;
  /** «Синхронизировать ко мне»: взять управление и разослать своё время. */
  onSyncToMe: () => void;
  canSync: boolean;
  driverLabel?: string;
}

const RATES = [0.75, 1, 1.25, 1.5] as const;

/** Нижняя панель: транспорт, скорость и синхронизация комнаты. */
export function BottomBar({
  view,
  label,
  mode,
  collapsed,
  onToggleCollapsed,
  onTogglePlay,
  onSeek,
  onRate,
  onReload,
  onSyncToMe,
  canSync,
  driverLabel,
}: BottomBarProps) {
  const { found, playing, time, duration, rate } = view;

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
          <Icon name={playing ? 'pause' : 'play'} size={16} />
          <span>{formatTime(time)}</span>
          <Icon name="chevron-up" size={16} />
        </button>
      ) : (
        <>
          <div className="hw-videorow">
            <span className={`hw-dot${playing ? ' is-live' : ''}`} />
            <span className={`hw-video-label${playing ? ' is-live' : ''}`}>{label}</span>
            {mode === 'site' && (
              <span className="hw-badge" title="Режим «Сайт»">
                сайт
              </span>
            )}
            {mode === 'local' && (
              <span className="hw-badge" title="Локальный файл">
                файл
              </span>
            )}
            <span className="hw-time">
              {found ? `${formatTime(time)} / ${formatTime(duration)}` : '—'}
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
              disabled={!found}
              aria-label="Назад на 10 секунд"
            >
              −10 с
            </button>
            <button
              type="button"
              className="hw-play"
              onClick={onTogglePlay}
              disabled={!found}
              aria-label={playing ? 'Пауза' : 'Играть'}
            >
              <Icon name={playing ? 'pause' : 'play'} size={24} />
            </button>
            <button
              type="button"
              className="hw-tbtn"
              onClick={() => onSeek(10)}
              disabled={!found}
              aria-label="Вперёд на 10 секунд"
            >
              +10 с
            </button>
            <button
              type="button"
              className="hw-tbtn hw-tbtn--sync"
              onClick={onSyncToMe}
              disabled={!canSync}
              aria-label="Синхронизировать всех ко мне"
            >
              Ко мне
            </button>
            {mode === 'site' && onReload && (
              <button
                type="button"
                className="hw-tbtn hw-tbtn--icon"
                onClick={onReload}
                aria-label="Перезагрузить сайт"
              >
                <Icon name="reload" size={18} />
              </button>
            )}
          </div>

          <div className="hw-raterow">
            <span className="hw-rate-label">Скорость</span>
            {RATES.map((value) => (
              <button
                key={value}
                type="button"
                className={`hw-rate${Math.abs(rate - value) < 0.01 ? ' is-active' : ''}`}
                onClick={() => onRate(value)}
                disabled={!found}
              >
                {value}×
              </button>
            ))}
            {driverLabel && <span className="hw-driver">{driverLabel}</span>}
          </div>
        </>
      )}
    </footer>
  );
}
