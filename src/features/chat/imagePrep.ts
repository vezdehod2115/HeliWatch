/*
 * Подготовка фото к отправке (§4.7): сжатие в canvas до 1280 px по длинной
 * стороне и JPEG 0.8, пока файл не влезет в 2 МБ. Кодирование — только в
 * WebView, поэтому модуль живёт в features, а не в net.
 */

import {
  IMAGE_MAX_BYTES,
  IMAGE_MAX_SIDE,
  IMAGE_QUALITY,
  IMAGE_PREVIEW_SIDE,
} from '../../net/protocol';

export type ImageMime = 'image/jpeg' | 'image/png' | 'image/webp';

export interface PreparedImage {
  bytes: Uint8Array;
  mime: ImageMime;
  w: number;
  h: number;
  /** Object URL на сжатый JPEG — для локального превью в чате. */
  previewUrl: string;
}

interface BitmapLike {
  width: number;
  height: number;
  close?: () => void;
}

async function loadBitmap(file: File): Promise<BitmapLike> {
  const CanvasBitmap = (globalThis as { createImageBitmap?: (source: Blob) => Promise<ImageBitmap> })
    .createImageBitmap;
  if (typeof CanvasBitmap === 'function') {
    return await CanvasBitmap(file);
  }
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.decoding = 'async';
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error('Не удалось прочитать изображение'));
      image.src = url;
    });
    return image;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function scaleTo(width: number, height: number, maxSide: number): { w: number; h: number } {
  const longest = Math.max(width, height);
  if (longest <= maxSide || longest === 0) {
    return { w: Math.max(1, width), h: Math.max(1, height) };
  }
  const ratio = maxSide / longest;
  return {
    w: Math.max(1, Math.round(width * ratio)),
    h: Math.max(1, Math.round(height * ratio)),
  };
}

function canvasToBytes(canvas: HTMLCanvasElement, mime: ImageMime, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) {
          resolve(blob);
        } else {
          reject(new Error('Не удалось сжать изображение'));
        }
      },
      mime,
      quality,
    );
  });
}

/**
 * Сжать выбранное фото. Пробуем JPEG 0.8 → 0.7 → 0.6 → уменьшение до 960 px.
 * Если файл не изображение или итог больше 2 МБ — понятная ошибка.
 */
export async function prepareImage(file: File): Promise<PreparedImage> {
  if (!file.type.startsWith('image/')) {
    throw new Error('Это не изображение');
  }
  if (file.size > 24 * 1024 * 1024) {
    throw new Error('Файл больше 24 МБ — выберите фото поменьше');
  }
  const bitmap = await loadBitmap(file);
  const attempts: Array<{ side: number; quality: number }> = [
    { side: IMAGE_MAX_SIDE, quality: IMAGE_QUALITY },
    { side: IMAGE_MAX_SIDE, quality: 0.7 },
    { side: 960, quality: 0.65 },
    { side: 720, quality: 0.6 },
  ];

  try {
    for (const attempt of attempts) {
      const size = scaleTo(bitmap.width, bitmap.height, attempt.side);
      const canvas = document.createElement('canvas');
      canvas.width = size.w;
      canvas.height = size.h;
      const context = canvas.getContext('2d');
      if (!context) {
        throw new Error('Canvas недоступен на этом устройстве');
      }
      context.imageSmoothingQuality = 'high';
      context.drawImage(bitmap as unknown as CanvasImageSource, 0, 0, size.w, size.h);
      const blob = await canvasToBytes(canvas, 'image/jpeg', attempt.quality);
      if (blob.size <= IMAGE_MAX_BYTES) {
        const bytes = new Uint8Array(await blob.arrayBuffer());
        return {
          bytes,
          mime: 'image/jpeg',
          w: size.w,
          h: size.h,
          previewUrl: URL.createObjectURL(blob),
        };
      }
    }
  } finally {
    bitmap.close?.();
  }

  throw new Error('Не удалось ужать фото до 2 МБ — выберите кадр поменьше');
}

/** Миниатюра 256 px для превью и (в будущем) истории (§4.7). */
export async function makePreviewDataUrl(bytes: Uint8Array, mime: string): Promise<string | null> {
  try {
    const blob = new Blob([bytes as unknown as BlobPart], { type: mime });
    const bitmap = await loadBitmap(new File([blob], 'preview.jpg', { type: mime }));
    const size = scaleTo(bitmap.width, bitmap.height, IMAGE_PREVIEW_SIDE);
    const canvas = document.createElement('canvas');
    canvas.width = size.w;
    canvas.height = size.h;
    const context = canvas.getContext('2d');
    if (!context) {
      return null;
    }
    context.drawImage(bitmap as unknown as CanvasImageSource, 0, 0, size.w, size.h);
    bitmap.close?.();
    return canvas.toDataURL('image/jpeg', 0.7);
  } catch {
    return null;
  }
}

/** URL из входящих байт: показываем фото в полноэкранном просмотре. */
export function imageUrlFromBytes(bytes: Uint8Array, mime: string): string {
  return URL.createObjectURL(new Blob([bytes as unknown as BlobPart], { type: mime }));
}
