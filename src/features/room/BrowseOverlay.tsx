import { Icon } from '../../app/icons';

interface BrowseOverlayProps {
  onBack: () => void;
  /** Быстрый переход на YouTube, не выходя из режима поиска. */
  onYoutube: () => void;
}

/**
 * Режим поиска (этап 8.2): меню комнаты скрыты, сайт занимает весь экран.
 *
 * Из React остаётся только компактная панель внизу слева: «В комнату» и
 * «YouTube». Поисковой строки, чипов и подсказок больше нет — они налезали на
 * шапку сайта. Поиск идёт на самом сайте; выбранный ролик вернёт в комнату.
 */
export function BrowseOverlay({ onBack, onYoutube }: BrowseOverlayProps) {
  return (
    <div className="hw-browse-actions" data-hw-region="browse">
      <button
        type="button"
        className="hw-browse-fab"
        onClick={onBack}
        aria-label="Вернуться в комнату"
      >
        <Icon name="back" size={18} />
        <span>В комнату</span>
      </button>
      <button
        type="button"
        className="hw-browse-fab"
        onClick={onYoutube}
        aria-label="Открыть YouTube"
      >
        <Icon name="play" size={16} />
        <span>YouTube</span>
      </button>
    </div>
  );
}
