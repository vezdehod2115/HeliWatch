import { useState, type FormEvent } from 'react';
import { Icon } from '../../app/icons';

interface BrowseOverlayProps {
  url: string;
  title: string;
  found: boolean;
  playing: boolean;
  onBack: () => void;
  onSearch: (query: string) => void;
  onGoogle: () => void;
  onYoutube: () => void;
  onWatchHere: () => void;
  onAddToQueue: () => void;
}

function displayUrl(url: string): string {
  return url.replace(/^https?:\/\//, '').replace(/\/$/, '');
}

/**
 * Полноэкранный поиск (этап 8): все меню комнаты скрыты, пользователь сам
 * ищет сайт. Как только на странице находится играющее видео, RoomScreen
 * возвращает его в окно комнаты. Верхняя плашка — единственный React-слой,
 * остальное отдано сайту.
 */
export function BrowseOverlay({
  url,
  title,
  found,
  playing,
  onBack,
  onSearch,
  onGoogle,
  onYoutube,
  onWatchHere,
  onAddToQueue,
}: BrowseOverlayProps) {
  const [query, setQuery] = useState('');

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const text = query.trim();
    if (text) {
      onSearch(text);
      setQuery('');
    }
  };

  return (
    <div className="hw-browse" data-hw-region="browse">
      <div className="hw-browse-bar">
        <button
          type="button"
          className="hw-iconbtn hw-browse-back"
          onClick={onBack}
          aria-label="Вернуться в комнату"
          title="Вернуться в комнату"
        >
          <Icon name="back" size={18} />
        </button>
        <form className="hw-browse-search" onSubmit={submit}>
          <Icon name="search" size={16} />
          <input
            className="hw-browse-input"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Что смотрим? Google"
            inputMode="search"
            enterKeyHint="search"
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            aria-label="Поиск видео"
          />
        </form>
        <button
          type="button"
          className="hw-iconbtn"
          onClick={onBack}
          aria-label="Закрыть поиск"
        >
          <Icon name="close" size={18} />
        </button>
      </div>

      <div className="hw-browse-row">
        <button type="button" className="hw-chip" onClick={onGoogle}>
          Google
        </button>
        <button type="button" className="hw-chip" onClick={onYoutube}>
          YouTube
        </button>
        <span className="hw-browse-page" title={title || displayUrl(url)}>
          {title || displayUrl(url) || 'Поиск'}
        </span>
        {found ? (
          <>
            <button type="button" className="hw-chip is-active" onClick={onWatchHere}>
              <Icon name="play" size={13} /> {playing ? 'В комнате' : 'Смотреть'}
            </button>
            <button
              type="button"
              className="hw-chip"
              onClick={onAddToQueue}
              title="Добавить в очередь"
            >
              <Icon name="plus" size={13} /> В очередь
            </button>
          </>
        ) : null}
      </div>

      <p className="hw-browse-hint">
        Выберите ролик на сайте — HeliWatch вернёт вас в комнату, и видео
        заиграет в окне. Кнопка «назад» вернёт комнату без смены видео.
      </p>
    </div>
  );
}
