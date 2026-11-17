import { describe, expect, it, vi } from 'vitest';
import {
  IMAGE_CHUNK_SIZE,
  IMAGE_MAX_BYTES,
  imageChunkCount,
  type ImageStartPayload,
} from './protocol';
import {
  ImageReceiver,
  decodeChunkFrame,
  encodeChunkFrame,
  sendImage,
  sha256Hex,
} from './blobs';

function makeBytes(length: number, seed = 7): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let index = 0; index < length; index += 1) {
    bytes[index] = (index * seed + 13) & 0xff;
  }
  return bytes;
}

interface SentFrame {
  type: string;
  data: Record<string, unknown>;
}

function fakeTransport() {
  const json: SentFrame[] = [];
  const blobs: ArrayBuffer[] = [];
  return {
    json,
    blobs,
    transport: {
      sendJson: (type: string, data: unknown) => {
        json.push({ type, data: data as Record<string, unknown> });
      },
      sendBlob: (frame: ArrayBuffer) => {
        blobs.push(frame);
      },
    },
  };
}

describe('кадры чанков фото', () => {
  it('encode/decode сохраняет заголовок и байты', () => {
    const chunk = makeBytes(1024);
    const frame = encodeChunkFrame({ t: 'image-chunk', id: 'image-one-1', i: 3 }, chunk);
    const decoded = decodeChunkFrame(frame);
    expect(decoded?.header.id).toBe('image-one-1');
    expect(decoded?.header.i).toBe(3);
    expect(Array.from(decoded?.chunk ?? [])).toEqual(Array.from(chunk));
  });

  it('отклоняет мусор и чужие типы', () => {
    expect(decodeChunkFrame(new ArrayBuffer(2))).toBeNull();
    expect(decodeChunkFrame('строка')).toBeNull();
    const bad = new TextEncoder().encode(JSON.stringify({ t: 'hw', id: 'x', i: 0 }));
    const frame = new Uint8Array(4 + bad.byteLength);
    new DataView(frame.buffer).setUint32(0, bad.byteLength);
    frame.set(bad, 4);
    expect(decodeChunkFrame(frame.buffer)).toBeNull();
  });

  it('считает чанки по 16 КиБ', () => {
    expect(imageChunkCount(0)).toBe(0);
    expect(imageChunkCount(1)).toBe(1);
    expect(imageChunkCount(IMAGE_CHUNK_SIZE)).toBe(1);
    expect(imageChunkCount(IMAGE_CHUNK_SIZE + 1)).toBe(2);
  });
});

describe('sendImage', () => {
  it('шлёт image-start, чанки по 16 КиБ и image-end с верным SHA-256', async () => {
    const bytes = makeBytes(IMAGE_CHUNK_SIZE * 2 + 100);
    const { json, blobs, transport } = fakeTransport();
    const progress: number[] = [];
    const result = await sendImage({
      transport,
      id: 'image-42-01',
      bytes,
      mime: 'image/jpeg',
      w: 640,
      h: 480,
      onProgress: (sent) => progress.push(sent),
      chunkGapMs: 0,
    });

    expect(result.ok).toBe(true);
    expect(result.chunks).toBe(3);
    expect(json.map((item) => item.type)).toEqual(['image-start', 'image-end']);
    const start = json[0]?.data as unknown as ImageStartPayload;
    expect(start.size).toBe(bytes.byteLength);
    expect(start.chunks).toBe(3);
    expect(start.sha256).toBe(await sha256Hex(bytes));
    expect(blobs).toHaveLength(3);
    expect(progress).toEqual([IMAGE_CHUNK_SIZE, IMAGE_CHUNK_SIZE * 2, bytes.byteLength]);

    const decoded = blobs.map((frame) => decodeChunkFrame(frame));
    expect(decoded.map((item) => item?.header.i)).toEqual([0, 1, 2]);
    const total = decoded.reduce((sum, item) => sum + (item?.chunk.byteLength ?? 0), 0);
    expect(total).toBe(bytes.byteLength);
  });

  it('отмена между чанками шлёт image-cancel', async () => {
    const bytes = makeBytes(IMAGE_CHUNK_SIZE * 4);
    const { json, blobs, transport } = fakeTransport();
    let sent = 0;
    const result = await sendImage({
      transport,
      id: 'image-cancel-01',
      bytes,
      mime: 'image/jpeg',
      w: 100,
      h: 100,
      chunkGapMs: 0,
      isCancelled: () => sent >= 2,
      onProgress: () => {
        sent += 1;
      },
    });

    expect(result.cancelled).toBe(true);
    expect(result.ok).toBe(false);
    expect(blobs.length).toBe(2);
    expect(json[json.length - 1]?.type).toBe('image-cancel');
  });

  it('не отправляет фото больше 2 МБ и слишком маленькие файлы', async () => {
    const { transport, json } = fakeTransport();
    const big = await sendImage({
      transport,
      id: 'image-big-01',
      bytes: makeBytes(IMAGE_MAX_BYTES + 1),
      mime: 'image/jpeg',
      w: 10,
      h: 10,
    });
    expect(big.ok).toBe(false);
    expect(big.error).toContain('2 МБ');

    const tiny = await sendImage({
      transport,
      id: 'image-tiny-01',
      bytes: makeBytes(8),
      mime: 'image/jpeg',
      w: 10,
      h: 10,
    });
    expect(tiny.ok).toBe(false);
    expect(json).toHaveLength(0);
  });
});

describe('ImageReceiver', () => {
  async function prepare(length: number) {
    const bytes = makeBytes(length);
    const sha256 = await sha256Hex(bytes);
    const chunks = imageChunkCount(bytes.byteLength);
    const meta: ImageStartPayload = {
      id: 'image-in-0001',
      mime: 'image/jpeg',
      size: bytes.byteLength,
      w: 1280,
      h: 720,
      chunks,
      sha256,
      scope: 'chat',
    };
    const frames: ArrayBuffer[] = [];
    for (let index = 0; index < chunks; index += 1) {
      const start = index * IMAGE_CHUNK_SIZE;
      frames.push(
        encodeChunkFrame(
          { t: 'image-chunk', id: meta.id, i: index },
          bytes.subarray(start, Math.min(bytes.byteLength, start + IMAGE_CHUNK_SIZE)),
        ),
      );
    }
    return { bytes, meta, frames };
  }

  it('собирает фото, проверяет хеш и отдаёт прогресс', async () => {
    const { bytes, meta, frames } = await prepare(IMAGE_CHUNK_SIZE + 500);
    const completed: number[] = [];
    const progress: number[] = [];
    const receiver = new ImageReceiver({
      onComplete: (image) => completed.push(image.bytes.byteLength),
      onProgress: (info) => progress.push(info.received),
    });

    expect(receiver.start('peer-1', meta)).toBe(true);
    for (const frame of frames) {
      expect(receiver.frame('peer-1', frame)).toBe(true);
    }
    receiver.end('peer-1', meta.id);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(completed).toEqual([bytes.byteLength]);
    expect(progress.length).toBe(2);
    expect(receiver.size).toBe(0);
  });

  it('неверный SHA-256 — ошибка checksum и просьба остановиться', async () => {
    const { bytes, meta, frames } = await prepare(IMAGE_CHUNK_SIZE + 500);
    const errors: string[] = [];
    const rejected: string[] = [];
    const receiver = new ImageReceiver({
      onError: (info) => errors.push(info.reason),
      onReject: (_id, _peer, reason) => rejected.push(reason),
      onComplete: () => {
        throw new Error('не должно случиться');
      },
    });
    // Портим последний байт в последнем чанке.
    const last = new Uint8Array(frames[frames.length - 1] ?? new ArrayBuffer(0));
    last[last.byteLength - 1] = (last[last.byteLength - 1] ?? 0) ^ 0xff;
    frames[frames.length - 1] = last.buffer;

    receiver.start('peer-1', meta);
    receiver.frame('peer-1', frames[0] as ArrayBuffer);
    receiver.frame('peer-1', frames[1] as ArrayBuffer);
    receiver.end('peer-1', meta.id);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(errors).toEqual(['checksum']);
    expect(rejected).toEqual(['checksum']);
    expect(bytes.byteLength).toBe(meta.size);
  });

  it('end без чанков — incomplete, чужой пир игнорируется', async () => {
    const { meta, frames } = await prepare(1000);
    const errors: string[] = [];
    const receiver = new ImageReceiver({ onError: (info) => errors.push(info.reason) });
    receiver.start('peer-1', meta);
    expect(receiver.frame('peer-2', frames[0] as ArrayBuffer)).toBe(false);
    receiver.end('peer-1', meta.id);
    expect(errors).toEqual(['incomplete']);
  });

  it('таймаут 30 с закрывает передачу', async () => {
    vi.useFakeTimers();
    try {
      const { meta } = await prepare(1000);
      const errors: string[] = [];
      const receiver = new ImageReceiver({ onError: (info) => errors.push(info.reason) });
      receiver.start('peer-1', meta);
      vi.advanceTimersByTime(30_001);
      expect(errors).toEqual(['timeout']);
      expect(receiver.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('отклоняет третье одновременное фото', async () => {
    const receiver = new ImageReceiver();
    const base = {
      mime: 'image/jpeg',
      size: 1000,
      w: 100,
      h: 100,
      chunks: 1,
      sha256: 'a'.repeat(64),
      scope: 'chat' as const,
    };
    expect(receiver.start('p', { ...base, id: 'image-a-0001' })).toBe(true);
    expect(receiver.start('p', { ...base, id: 'image-b-0001' })).toBe(true);
    expect(receiver.start('p', { ...base, id: 'image-c-0001' })).toBe(false);
    receiver.dispose();
  });
});
