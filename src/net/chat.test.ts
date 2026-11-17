import { describe, expect, it } from 'vitest';
import {
  CHAT_MAX_LENGTH,
  IMAGE_CHUNK_SIZE,
  IMAGE_MAX_BYTES,
  imageChunkCount,
  isChatPayload,
  isImageCancelPayload,
  isImageChunkPayload,
  isImageEndPayload,
  isImageStartPayload,
  isTypingPayload,
  normalizeChatText,
} from './protocol';

const SHA = 'a'.repeat(64);

function imageStart(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const size = IMAGE_CHUNK_SIZE * 2;
  return {
    id: 'image-0001',
    mime: 'image/jpeg',
    size,
    w: 1280,
    h: 720,
    chunks: imageChunkCount(size),
    sha256: SHA,
    scope: 'chat',
    ...overrides,
  };
}

describe('normalizeChatText', () => {
  it('обрезает пробелы и пустые переводы строк', () => {
    expect(normalizeChatText('  привет  ')).toBe('привет');
    expect(normalizeChatText('a\n\n\n\nb')).toBe('a\n\nb');
    expect(normalizeChatText('   \n  ')).toBeNull();
    expect(normalizeChatText('')).toBeNull();
  });

  it('убирает управляющие символы и ограничивает длину', () => {
    expect(normalizeChatText('a\u0007b')).toBe('ab');
    const long = 'x'.repeat(CHAT_MAX_LENGTH + 500);
    expect(normalizeChatText(long)?.length).toBe(CHAT_MAX_LENGTH);
  });
});

describe('isChatPayload', () => {
  it('принимает текст с replyTo и без', () => {
    expect(isChatPayload({ text: 'привет' })).toBe(true);
    expect(isChatPayload({ text: 'привет', replyTo: 'msg-1' })).toBe(true);
  });

  it('отклоняет пустой и слишком длинный текст', () => {
    expect(isChatPayload({ text: '' })).toBe(false);
    expect(isChatPayload({ text: 'x'.repeat(CHAT_MAX_LENGTH + 1) })).toBe(false);
    expect(isChatPayload(null)).toBe(false);
    expect(isChatPayload({ text: 42 })).toBe(false);
  });
});

describe('isTypingPayload', () => {
  it('принимает только boolean', () => {
    expect(isTypingPayload({ on: true })).toBe(true);
    expect(isTypingPayload({ on: 'yes' })).toBe(false);
    expect(isTypingPayload({})).toBe(false);
  });
});

describe('isImageStartPayload', () => {
  it('принимает корректное описание фото', () => {
    expect(isImageStartPayload(imageStart())).toBe(true);
  });

  it('проверяет mime, размер, число чанков и SHA-256', () => {
    expect(isImageStartPayload(imageStart({ mime: 'image/gif' }))).toBe(false);
    expect(isImageStartPayload(imageStart({ size: IMAGE_MAX_BYTES + 1 }))).toBe(false);
    expect(isImageStartPayload(imageStart({ size: 10 }))).toBe(false);
    expect(isImageStartPayload(imageStart({ chunks: 999 }))).toBe(false);
    expect(isImageStartPayload(imageStart({ sha256: 'not-hex' }))).toBe(false);
    expect(isImageStartPayload(imageStart({ id: 'short' }))).toBe(false);
    expect(isImageStartPayload(imageStart({ scope: 'dm' }))).toBe(true);
    expect(isImageStartPayload(imageStart({ scope: 'public' }))).toBe(false);
  });
});

describe('служебные сообщения фото', () => {
  it('chunk/end/cancel валидируются отдельно', () => {
    expect(isImageChunkPayload({ id: 'image-0001', i: 0 })).toBe(true);
    expect(isImageChunkPayload({ id: 'image-0001', i: -1 })).toBe(false);
    expect(isImageChunkPayload({ id: 'image-0001', i: 1.5 })).toBe(false);
    expect(isImageEndPayload({ id: 'image-0001' })).toBe(true);
    expect(isImageEndPayload({})).toBe(false);
    expect(isImageCancelPayload({ id: 'image-0001', reason: 'checksum' })).toBe(true);
    expect(isImageCancelPayload({ id: 'image-0001', reason: 7 })).toBe(false);
  });
});
