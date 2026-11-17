import { Icon } from '../../app/icons';

interface BrowseOverlayProps {
  onBack: () => void;
}

/**
 * Режим поиска (этап 8.1): меню комнаты скрыты, сайт занимает весь экран.
 *
 * Из React остаётся только компактная кнопка возврата внизу слева — без
 * поисковой строки, подсказок и чипов, которые налезали на шапку Google.
 * Искать можно прямо на сайте; выбранный ролик вернёт в комнату автоматически.
 */
export function BrowseOverlay({ onBack }: BrowseOverlayProps) {
  return (
    <button
      type="button"
      className="hw-browse-fab"
      data-hw-region="browse"
      onClick={onBack}
      aria-label="Вернуться в комнату"
    >
      <Icon name="back" size={18} />
      <span>В комнату</span>
    </button>
  );
}
