import { useState } from 'react';
import {
  EMOJI_CATEGORIES,
  RECENT_LIMIT,
  firstCategory,
} from './emoji';

interface EmojiPanelProps {
  recents: string[];
  onPick: (emoji: string) => void;
}

/**
 * Панель эмодзи: недавние сверху, дальше категории (§7).
 * Системные Unicode-эмодзи, без библиотек и картинок.
 */
export function EmojiPanel({ recents, onPick }: EmojiPanelProps) {
  const [categoryId, setCategoryId] = useState<string>('recent');
  const recentList = recents.slice(0, RECENT_LIMIT);
  const activeCategory =
    EMOJI_CATEGORIES.find((category) => category.id === categoryId) ?? firstCategory();
  const showRecent = categoryId === 'recent';
  const emoji = showRecent ? recentList : activeCategory.emoji;

  return (
    <div className="hw-emojipanel" data-hw-region="emojipanel">
      <div className="hw-emojitabs" role="tablist" aria-label="Категории эмодзи">
        <button
          type="button"
          role="tab"
          aria-selected={showRecent}
          className={`hw-emojitab${showRecent ? ' is-active' : ''}`}
          onClick={() => setCategoryId('recent')}
          title="Недавние"
        >
          🕘
        </button>
        {EMOJI_CATEGORIES.map((category) => (
          <button
            key={category.id}
            type="button"
            role="tab"
            aria-selected={!showRecent && category.id === activeCategory.id}
            className={`hw-emojitab${
              !showRecent && category.id === activeCategory.id ? ' is-active' : ''
            }`}
            onClick={() => setCategoryId(category.id)}
            title={category.label}
          >
            {category.emoji[0] ?? category.label}
          </button>
        ))}
      </div>

      {showRecent && emoji.length === 0 ? (
        <p className="hw-emojihint">
          Здесь появятся недавние эмодзи — они хранятся на этом телефоне.
        </p>
      ) : (
        <div className="hw-emojigrid" role="tabpanel">
          {emoji.map((item, index) => (
            <button
              key={`${item}-${index}`}
              type="button"
              className="hw-emojibtn"
              onClick={() => onPick(item)}
              aria-label={`Эмодзи ${item}`}
            >
              {item}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
