import { Icon } from '../../app/icons';
import type { QueueItem } from '../../net/protocol';

interface RoomQueueProps {
  open: boolean;
  items: QueueItem[];
  index: number;
  canEdit: boolean;
  currentUrl: string;
  onClose: () => void;
  onPlay: (index: number) => void;
  onRemove: (index: number) => void;
  onAddCurrent: () => void;
  onClear: () => void;
}

function displayUrl(url: string): string {
  return url.replace(/^https?:\/\//, '').replace(/\/$/, '');
}

/**
 * Очередь видео комнаты (этап 8): общий список ссылок, который ведёт хост.
 * Гость видит те же элементы, но не может их менять.
 */
export function RoomQueue({
  open,
  items,
  index,
  canEdit,
  currentUrl,
  onClose,
  onPlay,
  onRemove,
  onAddCurrent,
  onClear,
}: RoomQueueProps) {
  if (!open) {
    return null;
  }

  return (
    <div
      className="hw-modal hw-queue"
      role="dialog"
      aria-modal="true"
      aria-label="Очередь видео"
      data-hw-region="queue"
      data-hw-block
    >
      <div className="hw-modal-card hw-queue-card">
        <header className="hw-modal-head">
          <Icon name="list" size={18} />
          <h2>Очередь видео</h2>
          <span className="hw-moderation-count">{items.length}</span>
          <button
            type="button"
            className="hw-iconbtn"
            onClick={onClose}
            aria-label="Закрыть очередь"
          >
            <Icon name="close" size={18} />
          </button>
        </header>

        {items.length === 0 ? (
          <p className="hw-note">
            Очередь пуста. Найдите видео в поиске и добавьте его кнопкой «+» —
            оно заиграет у всех в комнате, когда вы нажмёте на него в списке.
          </p>
        ) : (
          <ul className="hw-queue-list">
            {items.map((item, itemIndex) => {
              const active = itemIndex === index || item.url === currentUrl;
              return (
                <li
                  key={`${item.url}:${itemIndex}`}
                  className={`hw-queue-row${active ? ' is-active' : ''}`}
                >
                  <button
                    type="button"
                    className="hw-queue-main"
                    onClick={() => (canEdit ? onPlay(itemIndex) : undefined)}
                    disabled={!canEdit}
                    aria-label={`Смотреть ${item.title}`}
                  >
                    <span className="hw-queue-index">
                      {active ? <Icon name="play" size={13} /> : itemIndex + 1}
                    </span>
                    <span className="hw-queue-text">
                      <strong>{item.title}</strong>
                      <small>{displayUrl(item.url)}</small>
                    </span>
                  </button>
                  {canEdit ? (
                    <button
                      type="button"
                      className="hw-iconbtn hw-iconbtn--small"
                      onClick={() => onRemove(itemIndex)}
                      aria-label={`Убрать ${item.title} из очереди`}
                    >
                      <Icon name="trash" size={16} />
                    </button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}

        {canEdit ? (
          <div className="hw-queue-actions">
            <button type="button" className="hw-primary hw-primary--compact" onClick={onAddCurrent}>
              <Icon name="plus" size={16} /> Добавить текущее видео
            </button>
            {items.length > 0 ? (
              <button type="button" className="hw-ghost" onClick={onClear}>
                Очистить
              </button>
            ) : null}
          </div>
        ) : (
          <p className="hw-note">Очередью управляет хост комнаты.</p>
        )}
      </div>
    </div>
  );
}
