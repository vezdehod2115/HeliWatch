/*
 * Подписи и предупреждения для режима B: их видит хост и зритель.
 * Чистые функции без React — проверяются в streamCopy.test.ts.
 */

import { STREAM_MAX_VIEWERS, type StreamCaptureKind } from '../../net/protocol';

export const STREAM_VIEWER_WARNING =
  `Раздача идёт с вашего телефона: до ${STREAM_MAX_VIEWERS} зрителей, ` +
  'все получают видео напрямую. При двух зрителях телефон греется сильнее.';

export const STREAM_MKV_WARNING =
  'MKV может не воспроизводиться в WebView. Если после выбора нет картинки, ' +
  'перекодируйте файл в MP4 (H.264/AAC) или WebM.';

/** «1 зритель» / «2 зрителя» / «0 зрителей». */
export function viewersLabel(count: number): string {
  const safe = Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
  const mod10 = safe % 10;
  const mod100 = safe % 100;
  let word = 'зрителей';
  if (mod10 === 1 && mod100 !== 11) {
    word = 'зритель';
  } else if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) {
    word = 'зрителя';
  }
  return `${safe} ${word}`;
}

/** Короткая строка состояния раздачи для шапки/панели. */
export function streamStatusLine(input: {
  streaming: boolean;
  viewers: number;
  error?: string | null;
}): string {
  if (input.error) {
    return input.error;
  }
  if (!input.streaming) {
    return 'Раздача выключена';
  }
  return `В эфире · ${viewersLabel(input.viewers)}`;
}

/** Как назвать способ захвата в диагностике и пустом состоянии. */
export function captureLabel(kind: StreamCaptureKind | null): string {
  if (kind === 'direct') {
    return 'прямой захват видео';
  }
  if (kind === 'canvas') {
    return 'canvas-фоллбэк';
  }
  return 'захват не начат';
}

/** Подсказка зрителю вместо чёрного экрана. */
export function viewerWaitingText(status: {
  hasStream: boolean;
  started: boolean;
  stopped: boolean;
  error?: string | null;
}): string {
  if (status.error) {
    return status.error;
  }
  if (status.stopped) {
    return 'Хост остановил раздачу';
  }
  if (status.hasStream) {
    return 'Поток получен, включаем…';
  }
  if (status.started) {
    return 'Хост начал раздачу — ждём видео';
  }
  return 'Хост ещё не выбрал файл';
}
