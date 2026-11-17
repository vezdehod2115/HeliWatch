import { describe, expect, it } from 'vitest';
import {
  EMOJI_CATEGORIES,
  QUICK_REACTIONS,
  RECENT_LIMIT,
  REACTION_LABELS,
  isKnownEmoji,
  pushRecent,
  sanitizeRecent,
} from './emoji';
import { isEmojiSequence, isReactionPayload } from '../../net/protocol';

describe('каталог эмодзи', () => {
  it('категории непустые, id уникальны, эмодзи — валидные последовательности', () => {
    const ids = new Set<string>();
    expect(EMOJI_CATEGORIES.length).toBeGreaterThanOrEqual(5);
    for (const category of EMOJI_CATEGORIES) {
      expect(ids.has(category.id)).toBe(false);
      ids.add(category.id);
      expect(category.emoji.length).toBeGreaterThan(10);
      for (const emoji of category.emoji) {
        expect(isEmojiSequence(emoji)).toBe(true);
      }
    }
  });

  it('быстрых реакций ровно 6–8 и все с подписями', () => {
    expect(QUICK_REACTIONS.length).toBeGreaterThanOrEqual(6);
    expect(QUICK_REACTIONS.length).toBeLessThanOrEqual(8);
    expect(new Set(QUICK_REACTIONS).size).toBe(QUICK_REACTIONS.length);
    for (const emoji of QUICK_REACTIONS) {
      expect(isReactionPayload({ emoji })).toBe(true);
      expect(REACTION_LABELS[emoji]).toBeTruthy();
      expect(isKnownEmoji(emoji)).toBe(true);
    }
  });
});

describe('недавние эмодзи', () => {
  it('свежий эмодзи встаёт в начало и не дублируется', () => {
    const start = ['😀', '😂', '🔥'];
    expect(pushRecent(start, '🔥')).toEqual(['🔥', '😀', '😂']);
    expect(pushRecent(start, '👍')).toEqual(['👍', '😀', '😂', '🔥']);
  });

  it('длина недавних ограничена', () => {
    let recents: string[] = [];
    for (let index = 0; index < RECENT_LIMIT + 5; index += 1) {
      recents = pushRecent(recents, `e${index}`);
    }
    expect(recents).toHaveLength(RECENT_LIMIT);
    expect(recents[0]).toBe(`e${RECENT_LIMIT + 4}`);
  });

  it('sanitizeRecent выбрасывает мусор из SQLite', () => {
    expect(sanitizeRecent(null)).toEqual([]);
    expect(sanitizeRecent('😀')).toEqual([]);
    expect(sanitizeRecent(['😀', 42, '', '😀', null, '🔥'])).toEqual(['😀', '🔥']);
  });
});

describe('валидация реакций', () => {
  it('текст и цифры реакцией не считаются', () => {
    expect(isEmojiSequence('привет')).toBe(false);
    expect(isEmojiSequence('123')).toBe(false);
    expect(isEmojiSequence('')).toBe(false);
    expect(isReactionPayload({ emoji: 'hello' })).toBe(false);
    expect(isReactionPayload({ emoji: '👍' })).toBe(true);
  });

  it('флаги и составные эмодзи проходят', () => {
    expect(isEmojiSequence('🇷🇺')).toBe(true);
    expect(isEmojiSequence('👨‍👩‍👧')).toBe(true);
    expect(isEmojiSequence('👋🏽')).toBe(true);
  });

  it('координаты проверяются', () => {
    expect(isReactionPayload({ emoji: '🔥', x: 0.5, y: 0.2 })).toBe(true);
    expect(isReactionPayload({ emoji: '🔥', x: 'top' })).toBe(false);
  });
});
