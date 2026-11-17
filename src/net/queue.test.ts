import { describe, expect, it } from 'vitest';
import {
  QUEUE_MAX,
  normalizeQueueData,
  normalizeQueueItem,
} from './protocol';

describe('Очередь видео (этап 8)', () => {
  it('нормализует ссылку и обрезает название', () => {
    expect(normalizeQueueItem({ url: 'https://youtu.be/abc', title: '  Ролик  ' })).toEqual({
      url: 'https://youtu.be/abc',
      title: 'Ролик',
    });
    expect(normalizeQueueItem({ url: 'https://youtu.be/abc' })?.title).toBe('youtu.be/abc');
    expect(
      normalizeQueueItem({ url: 'https://youtu.be/abc', title: 'x'.repeat(500) })?.title,
    ).toHaveLength(120);
  });

  it('отклоняет не-URL и javascript:', () => {
    expect(normalizeQueueItem({ url: 'javascript:alert(1)' })).toBeNull();
    expect(normalizeQueueItem({ url: '' })).toBeNull();
    expect(normalizeQueueItem(null)).toBeNull();
    expect(normalizeQueueItem({ url: 42 })).toBeNull();
  });

  it('ограничивает очередь и индекс', () => {
    const items = Array.from({ length: QUEUE_MAX + 1 }, (_, index) => ({
      url: `https://example.com/${index}`,
      title: `${index}`,
    }));
    expect(normalizeQueueData({ items, index: 0 })).toBeNull();

    const valid = normalizeQueueData({ items: items.slice(0, 3), index: 99 });
    expect(valid?.index).toBe(2);
    expect(normalizeQueueData({ items: [], index: 5 })?.index).toBe(0);
    expect(normalizeQueueData({ items: [], index: -3 })?.index).toBe(0);
    expect(normalizeQueueData({ items: [{ url: 'ftp://x' }] })).toBeNull();
    expect(normalizeQueueData({ items: 'nope' })).toBeNull();
  });
});
