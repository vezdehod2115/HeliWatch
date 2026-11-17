/*
 * Эмодзи-панель (§7, этап 3): категории и недавние сверху.
 *
 * Только системные Unicode-эмодзи — без библиотек и спрайтов: WebView Android
 * рисует их сам, а размер APK не растёт. Недавние хранятся в SQLite
 * (`chat.emojiRecent`), потому что localStorage в WebView недолговечен (§5).
 */

export interface EmojiCategory {
  id: string;
  label: string;
  emoji: readonly string[];
}

export const EMOJI_CATEGORIES: readonly EmojiCategory[] = [
  {
    id: 'smileys',
    label: 'Смайлы',
    emoji: [
      '😀', '😃', '😄', '😁', '😆', '😅', '😂', '🤣', '🙂', '😉',
      '😊', '😇', '😍', '🥰', '😘', '😋', '😜', '🤪', '🤔', '🤨',
      '😐', '😴', '😌', '😎', '🥳', '😢', '😭', '😤', '😡', '🤯',
      '😳', '😱', '🥺', '🙃', '😏', '🤗',
    ],
  },
  {
    id: 'gestures',
    label: 'Жесты',
    emoji: [
      '👍', '👎', '👌', '✌️', '🤞', '🤟', '🤘', '👋', '🙌', '👏',
      '🤝', '🙏', '💪', '👀', '✊', '🤙', '🫡', '🤷', '🙋', '🫶',
    ],
  },
  {
    id: 'hearts',
    label: 'Сердца',
    emoji: [
      '❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '💔', '💖',
      '💘', '💝', '💞', '💓', '💗', '✨', '🌟', '⭐',
    ],
  },
  {
    id: 'animals',
    label: 'Животные',
    emoji: [
      '🐶', '🐱', '🐭', '🐹', '🐰', '🦊', '🐻', '🐼', '🐨', '🐯',
      '🦁', '🐮', '🐷', '🐸', '🐵', '🦄', '🐝', '🦋', '🐢', '🐙',
    ],
  },
  {
    id: 'food',
    label: 'Еда',
    emoji: [
      '🍎', '🍕', '🍔', '🍟', '🌮', '🍿', '🍩', '🍪', '🎂', '🍰',
      '🍫', '🍺', '☕', '🍷', '🥂', '🍜', '🍣', '🍦',
    ],
  },
  {
    id: 'objects',
    label: 'Разное',
    emoji: [
      '🔥', '💯', '💀', '🎉', '🎬', '🍿', '🎮', '🎵', '🎧', '⚡',
      '💡', '🚀', '🌙', '🎯', '🏆', '📷', '💬', '🕹️',
    ],
  },
];

/** Быстрые реакции: 8 штук — по ширине панели без прокрутки (§7). */
export const QUICK_REACTIONS: readonly string[] = [
  '👍', '❤️', '😂', '😮', '😢', '🔥', '👏', '💀',
];

export const REACTION_LABELS: Record<string, string> = {
  '👍': 'Класс',
  '❤️': 'Сердце',
  '😂': 'Смешно',
  '😮': 'Ого',
  '😢': 'Грустно',
  '🔥': 'Огонь',
  '👏': 'Браво',
  '💀': 'Умер от смеха',
};

export const RECENT_LIMIT = 16;
/** Сколько живёт всплывающая реакция на видео. */
export const REACTION_FLOAT_MS = 2600;
export const REACTION_MAX_FLOAT = 12;

const ALL_EMOJI = new Set(EMOJI_CATEGORIES.flatMap((category) => category.emoji));

export function isKnownEmoji(value: string): boolean {
  return ALL_EMOJI.has(value) || QUICK_REACTIONS.includes(value);
}

/**
 * Недавние: свежий эмодзи — в начало, повторы не дублируются, длина ограничена.
 * Возвращает новый массив (zustand любит неизменяемые значения).
 */
export function pushRecent(
  recent: readonly string[],
  emoji: string,
  limit: number = RECENT_LIMIT,
): string[] {
  if (!emoji) {
    return [...recent];
  }
  return [emoji, ...recent.filter((item) => item !== emoji)].slice(0, Math.max(1, limit));
}

/** Проверка значения из SQLite: массив строк-эмодзи, без мусора. */
export function sanitizeRecent(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || !item || seen.has(item)) {
      continue;
    }
    seen.add(item);
    result.push(item);
    if (result.length >= RECENT_LIMIT) {
      break;
    }
  }
  return result;
}

export function firstCategory(): EmojiCategory {
  const [first] = EMOJI_CATEGORIES;
  if (!first) {
    throw new Error('Каталог эмодзи пуст');
  }
  return first;
}
