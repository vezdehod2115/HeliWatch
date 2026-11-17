/*
 * Чанкинг фото по DataChannel (§4.7).
 *
 * Контроль — JSON-сообщениями `image-start/chunk/end/cancel` (action `hw`),
 * полезная нагрузка — бинарными кадрами action `hw-blob`. Кадр устроен так:
 *
 *   [uint32 BE: длина JSON-заголовка][UTF-8 JSON {t, id, i}][байты чанка]
 *
 * Заголовок внутри кадра делает приём независимым от порядка доставки действий
 * и от того, сколько отправителей шлют фото одновременно.
 *
 * У trystero нет доступа к `bufferedAmount`, поэтому backpressure сделан
 * честным ожиданием: чанки уходят последовательно с небольшой паузой, а не
 * залпом на 2 МБ.
 */

import {
  IMAGE_CHUNK_SIZE,
  IMAGE_MAX_BYTES,
  IMAGE_MAX_CHUNKS,
  IMAGE_MIN_BYTES,
  IMAGE_TIMEOUT_MS,
  imageChunkCount,
  isImageStartPayload,
  type ImageScope,
  type ImageStartPayload,
} from './protocol';

const HEADER_LIMIT = 512;
const DEFAULT_CHUNK_GAP_MS = 8;
const MAX_TRANSFERS = 2;

export interface DecodedFrame {
  header: { t: string; id: string; i: number };
  chunk: Uint8Array;
}

export function encodeChunkFrame(header: { t: string; id: string; i: number }, chunk: Uint8Array): ArrayBuffer {
  const json = JSON.stringify(header);
  const headerBytes = new TextEncoder().encode(json);
  const frame = new Uint8Array(4 + headerBytes.length + chunk.byteLength);
  new DataView(frame.buffer).setUint32(0, headerBytes.byteLength);
  frame.set(headerBytes, 4);
  frame.set(chunk, 4 + headerBytes.byteLength);
  return frame.buffer;
}

export function decodeChunkFrame(raw: unknown): DecodedFrame | null {
  let bytes: Uint8Array | null = null;
  if (raw instanceof ArrayBuffer) {
    bytes = new Uint8Array(raw);
  } else if (ArrayBuffer.isView(raw)) {
    bytes = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
  }
  if (!bytes || bytes.byteLength < 5) {
    return null;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerLength = view.getUint32(0);
  if (headerLength <= 0 || headerLength > HEADER_LIMIT) {
    return null;
  }
  if (bytes.byteLength < 4 + headerLength) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + headerLength)));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return null;
  }
  const header = parsed as Record<string, unknown>;
  if (
    header.t !== 'image-chunk' ||
    typeof header.id !== 'string' ||
    typeof header.i !== 'number' ||
    !Number.isInteger(header.i) ||
    header.i < 0 ||
    header.i >= IMAGE_MAX_CHUNKS
  ) {
    return null;
  }
  return {
    header: { t: 'image-chunk', id: header.id, i: header.i },
    chunk: bytes.slice(4 + headerLength),
  };
}

/** SHA-256 в hex: используется для проверки целостности фото. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes as unknown as BufferSource);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export interface BlobTransport {
  sendJson: (type: string, data: unknown, to?: string) => void;
  sendBlob: (frame: ArrayBuffer, to?: string) => void;
}

export interface SendImageOptions {
  transport: BlobTransport;
  id: string;
  bytes: Uint8Array;
  mime: string;
  w: number;
  h: number;
  to?: string;
  scope?: ImageScope;
  /** Пользователь нажал «Отмена»: между чанками отправка прекращается. */
  isCancelled?: () => boolean;
  onProgress?: (sent: number, total: number) => void;
  chunkGapMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface SendImageResult {
  ok: boolean;
  cancelled: boolean;
  chunks: number;
  error?: string;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Отправка фото: `image-start` → чанки 16 КиБ → `image-end`.
 * Отмена — `image-cancel`, чтобы получатель выбросил недособранное фото.
 */
export async function sendImage(options: SendImageOptions): Promise<SendImageResult> {
  const { transport, id, bytes, mime, w, h } = options;
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1) {
    return { ok: false, cancelled: false, chunks: 0, error: 'Некорректный размер фото' };
  }
  if (bytes.byteLength < IMAGE_MIN_BYTES) {
    return { ok: false, cancelled: false, chunks: 0, error: 'Файл слишком мал' };
  }
  if (bytes.byteLength > IMAGE_MAX_BYTES) {
    return { ok: false, cancelled: false, chunks: 0, error: 'Фото больше 2 МБ' };
  }
  const chunks = imageChunkCount(bytes.byteLength);
  const sha256 = await sha256Hex(bytes);
  const meta: ImageStartPayload = {
    id,
    mime,
    size: bytes.byteLength,
    w,
    h,
    chunks,
    sha256,
    scope: options.scope ?? 'chat',
  };
  transport.sendJson('image-start', meta, options.to);

  const gap = Math.max(0, options.chunkGapMs ?? DEFAULT_CHUNK_GAP_MS);
  const sleep = options.sleep ?? defaultSleep;
  let sent = 0;

  for (let index = 0; index < chunks; index += 1) {
    if (options.isCancelled?.()) {
      transport.sendJson('image-cancel', { id, reason: 'cancelled' }, options.to);
      return { ok: false, cancelled: true, chunks: index };
    }
    const start = index * IMAGE_CHUNK_SIZE;
    const chunk = bytes.subarray(start, Math.min(bytes.byteLength, start + IMAGE_CHUNK_SIZE));
    transport.sendBlob(
      encodeChunkFrame({ t: 'image-chunk', id, i: index }, chunk),
      options.to,
    );
    sent = Math.min(bytes.byteLength, start + chunk.byteLength);
    options.onProgress?.(sent, bytes.byteLength);
    if (gap > 0 && index + 1 < chunks) {
      await sleep(gap);
    }
  }

  transport.sendJson('image-end', { id }, options.to);
  return { ok: true, cancelled: false, chunks };
}

export interface IncomingImage {
  id: string;
  fromPeer: string;
  mime: string;
  w: number;
  h: number;
  bytes: Uint8Array;
  /** Чат комнаты или личка: UI не должен смешивать эти потоки. */
  scope: ImageScope;
}

export interface ImageTransferInfo {
  id: string;
  fromPeer: string;
  mime: string;
  w: number;
  h: number;
  size: number;
  chunks: number;
  received: number;
  scope: ImageScope;
}

export interface ImageReceiverOptions {
  timeoutMs?: number;
  onStart?: (info: ImageTransferInfo) => void;
  onProgress?: (info: ImageTransferInfo) => void;
  onComplete?: (image: IncomingImage) => void;
  onError?: (info: { id: string; fromPeer: string; reason: string; scope?: ImageScope }) => void;
  /** Попросить отправителя остановиться (проверка SHA-256 не прошла). */
  onReject?: (id: string, fromPeer: string, reason: string) => void;
}

interface Transfer {
  meta: ImageStartPayload;
  fromPeer: string;
  chunks: Array<Uint8Array | undefined>;
  receivedChunks: number;
  receivedBytes: number;
  timer: ReturnType<typeof setTimeout> | null;
  finished: boolean;
}

/**
 * Сборка входящих фото. Проверки: границы из `image-start`, ровно `chunks`
 * чанков, размер и SHA-256. Таймаут — 30 с от старта (§4.7).
 */
export class ImageReceiver {
  private readonly transfers = new Map<string, Transfer>();
  private readonly options: ImageReceiverOptions;
  private readonly timeoutMs: number;
  private disposed = false;

  constructor(options: ImageReceiverOptions = {}) {
    this.options = options;
    this.timeoutMs = options.timeoutMs ?? IMAGE_TIMEOUT_MS;
  }

  get size(): number {
    return this.transfers.size;
  }

  start(fromPeer: string, rawMeta: unknown): boolean {
    if (this.disposed || !isImageStartPayload(rawMeta)) {
      return false;
    }
    const meta = rawMeta;
    if (this.transfers.has(meta.id)) {
      return false;
    }
    if (this.transfers.size >= MAX_TRANSFERS) {
      this.reject(meta.id, fromPeer, 'busy');
      return false;
    }
    const chunks: Array<Uint8Array | undefined> = new Array(meta.chunks).fill(undefined);
    const transfer: Transfer = {
      meta,
      fromPeer,
      chunks,
      receivedChunks: 0,
      receivedBytes: 0,
      timer: null,
      finished: false,
    };
    this.transfers.set(meta.id, transfer);
    transfer.timer = setTimeout(() => {
      this.fail(transfer, 'timeout');
    }, this.timeoutMs);
    this.options.onStart?.(this.info(transfer));
    return true;
  }

  /** Кадр из `hw-blob` от пира. */
  frame(fromPeer: string, raw: unknown): boolean {
    const decoded = decodeChunkFrame(raw);
    if (!decoded) {
      return false;
    }
    const transfer = this.transfers.get(decoded.header.id);
    if (!transfer || transfer.finished || transfer.fromPeer !== fromPeer) {
      return false;
    }
    const index = decoded.header.i;
    if (index >= transfer.meta.chunks) {
      this.fail(transfer, 'chunk-range');
      return false;
    }
    if (transfer.chunks[index]) {
      // Повторные чанки (ретрансляция) не ломают сборку.
      return true;
    }
    if (decoded.chunk.byteLength > IMAGE_CHUNK_SIZE) {
      this.fail(transfer, 'chunk-too-big');
      return false;
    }
    transfer.chunks[index] = decoded.chunk;
    transfer.receivedChunks += 1;
    transfer.receivedBytes += decoded.chunk.byteLength;
    if (transfer.receivedBytes > transfer.meta.size) {
      this.fail(transfer, 'size');
      return false;
    }
    this.options.onProgress?.(this.info(transfer));
    return true;
  }

  /** `image-end`: все чанки на месте — проверяем размер и хеш. */
  end(fromPeer: string, id: string): void {
    const transfer = this.transfers.get(id);
    if (!transfer || transfer.finished || transfer.fromPeer !== fromPeer) {
      return;
    }
    if (transfer.receivedChunks !== transfer.meta.chunks) {
      this.fail(transfer, 'incomplete');
      return;
    }
    const bytes = new Uint8Array(transfer.meta.size);
    let offset = 0;
    for (const chunk of transfer.chunks) {
      if (!chunk) {
        this.fail(transfer, 'incomplete');
        return;
      }
      if (offset + chunk.byteLength > bytes.byteLength) {
        this.fail(transfer, 'size');
        return;
      }
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    if (offset !== transfer.meta.size) {
      this.fail(transfer, 'size');
      return;
    }
    void this.verify(transfer, bytes);
  }

  /** `image-cancel` от отправителя. */
  cancel(fromPeer: string, id: string): void {
    const transfer = this.transfers.get(id);
    if (!transfer || transfer.finished || transfer.fromPeer !== fromPeer) {
      return;
    }
    this.finish(transfer);
    this.options.onError?.({
      id: transfer.meta.id,
      fromPeer: transfer.fromPeer,
      reason: 'cancelled',
      scope: transfer.meta.scope,
    });
  }

  dispose(): void {
    this.disposed = true;
    for (const transfer of this.transfers.values()) {
      if (transfer.timer) {
        clearTimeout(transfer.timer);
      }
    }
    this.transfers.clear();
  }

  private async verify(transfer: Transfer, bytes: Uint8Array): Promise<void> {
    let sha = '';
    try {
      sha = await sha256Hex(bytes);
    } catch {
      this.fail(transfer, 'hash');
      return;
    }
    if (sha !== transfer.meta.sha256) {
      this.fail(transfer, 'checksum');
      return;
    }
    if (transfer.finished) {
      return;
    }
    this.finish(transfer);
    this.options.onComplete?.({
      id: transfer.meta.id,
      fromPeer: transfer.fromPeer,
      mime: transfer.meta.mime,
      w: transfer.meta.w,
      h: transfer.meta.h,
      bytes,
      scope: transfer.meta.scope,
    });
  }

  private fail(transfer: Transfer, reason: string): void {
    this.finish(transfer);
    this.options.onError?.({
      id: transfer.meta.id,
      fromPeer: transfer.fromPeer,
      reason,
      scope: transfer.meta.scope,
    });
    this.options.onReject?.(transfer.meta.id, transfer.fromPeer, reason);
  }

  private reject(id: string, fromPeer: string, reason: string): void {
    this.options.onError?.({ id, fromPeer, reason });
    this.options.onReject?.(id, fromPeer, reason);
  }

  private finish(transfer: Transfer): void {
    transfer.finished = true;
    if (transfer.timer) {
      clearTimeout(transfer.timer);
      transfer.timer = null;
    }
    this.transfers.delete(transfer.meta.id);
  }

  private info(transfer: Transfer): ImageTransferInfo {
    return {
      id: transfer.meta.id,
      fromPeer: transfer.fromPeer,
      mime: transfer.meta.mime,
      w: transfer.meta.w,
      h: transfer.meta.h,
      size: transfer.meta.size,
      chunks: transfer.meta.chunks,
      received: transfer.receivedBytes,
      scope: transfer.meta.scope,
    };
  }
}
