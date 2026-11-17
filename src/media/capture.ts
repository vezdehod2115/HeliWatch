/*
 * Захват видео с телефона хоста для стрима файла (режим B, этап 5).
 *
 * Основной путь — `HTMLVideoElement.captureStream()`: Chromium отдаёт кадры
 * декодера как есть, без перерисовки. Если его нет или видео не даёт
 * видеотрек, включается фоллбэк canvas + WebAudio: кадры рисуются на canvas
 * 30 раз в секунду, звук идёт через `AudioContext.createMediaElementSource`.
 *
 * Файл выбирается штатным пикером и играет из blob-URL, поэтому canvas не
 * tainted и `drawImage` не бросает SecurityError. Для сторонних сайтов этот
 * модуль не используется: там режим A и второй WebView.
 */

import {
  STREAM_CAPTURE_FPS,
  STREAM_CAPTURE_MAX_SIDE,
  type StreamCaptureKind,
} from '../net/protocol';

/** Размер кадра фоллбэка: не увеличиваем видео и не выходим за 1280 px. */
export function fitStreamSize(
  width: number,
  height: number,
  maxSide: number = STREAM_CAPTURE_MAX_SIDE,
): { width: number; height: number } {
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0 ||
    !Number.isFinite(maxSide) ||
    maxSide <= 0
  ) {
    return { width: 0, height: 0 };
  }
  const scale = Math.min(1, maxSide / Math.max(width, height));
  return {
    width: Math.max(2, Math.round(width * scale)),
    height: Math.max(2, Math.round(height * scale)),
  };
}

/** `.mkv` играет не на всех прошивках — предупреждаем до выбора файла. */
export function isMkvName(name: string): boolean {
  return /\.mkv$/i.test(name.trim());
}

/** Чем захватываем кадр: прямым API или canvas-фоллбэком. */
export function preferredCaptureMethod(video: {
  captureStream?: unknown;
  mozCaptureStream?: unknown;
}): 'captureStream' | 'canvas' {
  return typeof video.captureStream === 'function' || typeof video.mozCaptureStream === 'function'
    ? 'captureStream'
    : 'canvas';
}

/** Понятная причина, почему раздача не началась. */
export function describeCaptureError(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return 'Не удалось захватить видео: проверьте, что файл воспроизводится';
}

export interface VideoCapture {
  stream: MediaStream;
  kind: StreamCaptureKind;
  width: number;
  height: number;
  /**
   * `AudioContext` создаётся до первого жеста и стартует в suspended.
   * Хост вызывает это из обработчика play — без жеста звук не пойдёт.
   */
  resume: () => Promise<void>;
  dispose: () => void;
}

interface AudioCapture {
  context: AudioContext;
  source: MediaElementAudioSourceNode;
  destination: MediaStreamAudioDestinationNode;
  track: MediaStreamTrack | null;
}

interface AudioGraph {
  context: AudioContext;
  source: MediaElementAudioSourceNode;
}

/**
 * `createMediaElementSource` можно вызвать для элемента только один раз.
 * Граф (контекст+источник) кешируем на элемент, а destination создаём заново
 * на каждый захват: так смена файла не ломает звук и не копит контексты.
 */
const audioGraphs = new WeakMap<HTMLVideoElement, AudioGraph>();

type CaptureElement = HTMLVideoElement & {
  captureStream?: () => MediaStream;
  mozCaptureStream?: () => MediaStream;
};

function createAudioCapture(video: HTMLVideoElement): AudioCapture | null {
  const scope = globalThis as unknown as {
    AudioContext?: typeof AudioContext;
    webkitAudioContext?: typeof AudioContext;
  };
  const Ctor = scope.AudioContext ?? scope.webkitAudioContext;
  if (!Ctor) {
    return null;
  }
  try {
    let graph = audioGraphs.get(video);
    if (!graph) {
      const context = new Ctor();
      const source = context.createMediaElementSource(video);
      // Слышим файл локально; микрофонный стрим идёт отдельным destination.
      source.connect(context.destination);
      graph = { context, source };
      audioGraphs.set(video, graph);
    }
    const destination = graph.context.createMediaStreamDestination();
    graph.source.connect(destination);
    return {
      context: graph.context,
      source: graph.source,
      destination,
      track: destination.stream.getAudioTracks()[0] ?? null,
    };
  } catch {
    // Элемент уже был подключён к другому AudioContext или нет звука.
    return null;
  }
}

function tryDirectVideo(video: CaptureElement): MediaStream | null {
  const method = video.captureStream ?? video.mozCaptureStream;
  if (typeof method !== 'function') {
    return null;
  }
  try {
    const stream = method.call(video);
    if (stream.getVideoTracks().length === 0) {
      return null;
    }
    return stream;
  } catch {
    return null;
  }
}

function startCanvasVideo(
  video: HTMLVideoElement,
  width: number,
  height: number,
): { stream: MediaStream; stop: () => void } | null {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { alpha: false });
  if (!context) {
    return null;
  }
  try {
    // Захват canvas всегда доступен в Chromium; рисуем без перерисовки DOM.
    const stream = canvas.captureStream(STREAM_CAPTURE_FPS);
    if (stream.getVideoTracks().length === 0) {
      return null;
    }
    const draw = (): void => {
      if (video.readyState < 2) {
        return;
      }
      // Кадр декодера может быть больше canvas — объект fit не искажает кадр.
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
    };
    draw();
    const timer = globalThis.setInterval(draw, Math.round(1000 / STREAM_CAPTURE_FPS));
    return {
      stream,
      stop: () => {
        globalThis.clearInterval(timer);
        for (const track of stream.getTracks()) {
          track.stop();
        }
      },
    };
  } catch {
    return null;
  }
}

/**
 * Захватить воспроизводимый `<video>` в MediaStream для WebRTC.
 *
 * Видео берём из `captureStream` (если получилось) иначе из canvas. Звук —
 * из `captureStream` (если там есть аудиотрек) иначе из WebAudio: так хост
 * слышит файл сам и не получает рассинхрон между двумя источниками.
 */
export async function captureVideo(video: HTMLVideoElement): Promise<VideoCapture> {
  if (!video) {
    throw new Error('Плеер не готов: сначала выберите видео');
  }
  const element = video as CaptureElement;
  const size = fitStreamSize(video.videoWidth, video.videoHeight);

  const direct = tryDirectVideo(element);
  // Если прямой захват уже отдал звук и элемента ещё нет в WebAudio-графе,
  // WebAudio не подключаем: иначе он перехватил бы локальное воспроизведение.
  const directAudio = direct?.getAudioTracks()[0] ?? null;
  const audio =
    !directAudio || audioGraphs.has(video) ? createAudioCapture(video) : null;
  let canvas: { stream: MediaStream; stop: () => void } | null = null;
  let kind: StreamCaptureKind = 'direct';

  let videoTrack = direct?.getVideoTracks()[0] ?? null;
  if (!videoTrack) {
    // Без размеров кадра canvas не нарисует: ждём metadata у элемента.
    if (size.width < 2 || size.height < 2) {
      audio?.destination.disconnect();
      throw new Error('Видео ещё не загрузило кадр: подождите секунду и нажмите play');
    }
    canvas = startCanvasVideo(video, size.width, size.height);
    videoTrack = canvas?.stream.getVideoTracks()[0] ?? null;
    kind = 'canvas';
  }

  if (!videoTrack) {
    canvas?.stop();
    audio?.destination.disconnect();
    throw new Error('Этот файл не отдаёт видео: кодек не поддерживается WebView');
  }

  const audioTrack = audio?.track ?? directAudio ?? null;
  const tracks: MediaStreamTrack[] = [videoTrack];
  if (audioTrack) {
    tracks.push(audioTrack);
  }
  const stream = new MediaStream(tracks);
  let disposed = false;

  return {
    stream,
    kind,
    width: size.width || video.videoWidth,
    height: size.height || video.videoHeight,
    resume: async () => {
      if (!audio || disposed) {
        return;
      }
      if (audio.context.state === 'suspended') {
        await audio.context.resume().catch(() => undefined);
      }
    },
    dispose: () => {
      if (disposed) {
        return;
      }
      disposed = true;
      canvas?.stop();
      for (const track of stream.getTracks()) {
        track.stop();
      }
      // Треки direct тоже принадлежат нам: останавливаем их отдельно,
      // потому что в stream попали копии ссылок.
      for (const track of direct?.getTracks() ?? []) {
        track.stop();
      }
      if (audio) {
        try {
          // Источник и контекст остаются: их переиспользует следующий файл.
          // Отключаем только destination этого захвата.
          audio.destination.disconnect();
        } catch {
          // Узел уже отключён.
        }
      }
    },
  };
}
