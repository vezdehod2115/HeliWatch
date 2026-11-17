/*
 * Раздача файла с телефона хоста (режим B, этап 5).
 *
 * `StreamEngine` держит один захват на комнату: старт, повторный старт при
 * смене файла, разблокировку звука после жеста и остановку. UI (RoomScreen)
 * связывает его с `RoomClient.attachScreen` и сообщениями `stream-start`.
 */

import { captureVideo, type VideoCapture } from './capture';
import type { StreamCaptureKind } from '../net/protocol';

export interface StreamStartResult {
  stream: MediaStream;
  kind: StreamCaptureKind;
  width: number;
  height: number;
}

export class StreamEngine {
  private capture: VideoCapture | null = null;

  get active(): boolean {
    return this.capture !== null;
  }

  get stream(): MediaStream | null {
    return this.capture?.stream ?? null;
  }

  get kind(): StreamCaptureKind | null {
    return this.capture?.kind ?? null;
  }

  /** Начать захват. Старый захват (если был) останавливается. */
  async start(video: HTMLVideoElement): Promise<StreamStartResult> {
    this.stop();
    const capture = await captureVideo(video);
    this.capture = capture;
    return {
      stream: capture.stream,
      kind: capture.kind,
      width: capture.width,
      height: capture.height,
    };
  }

  /** Вызвать из обработчика play: AudioContext стартует только по жесту. */
  resumeAudio(): void {
    if (this.capture) {
      void this.capture.resume().catch(() => undefined);
    }
  }

  stop(): void {
    if (this.capture) {
      this.capture.dispose();
      this.capture = null;
    }
  }
}
