/*
 * Транспортный канал комнаты. Интерфейс отделён от trystero, чтобы RoomClient
 * можно было тестировать с фейковым каналом в Node (см. room.test.ts).
 *
 * Голос и фото живут здесь же: `hw` — JSON-сообщения, `hw-blob` — бинарные
 * чанки (§4.1), а микрофон идёт MediaStream-треками через transceiver'ы.
 */

export interface Channel {
  readonly selfId: string;
  readonly strategy: string;
  onPeerJoin: ((peerId: string) => void) | null;
  onPeerLeave: ((peerId: string) => void) | null;
  onMessage: ((data: unknown, peerId: string) => void) | null;
  /** Бинарный action `hw-blob`: кадр чанка фото (см. net/blobs.ts). */
  onBlobMessage: ((data: unknown, peerId: string) => void) | null;
  /** Входящий голосовой поток пира (trystero onPeerStream). */
  onPeerStream: ((stream: MediaStream, peerId: string) => void) | null;
  send: (data: unknown, to?: string) => void;
  sendBlob: (data: ArrayBuffer, to?: string) => void;
  knownPeers: () => string[];
  /** Сколько открытых сокетов релея: 0 — сигналинг недоступен. */
  relayCount: () => number;
  /**
   * Голос: добавить поток во все соединения. Первое включение микрофона —
   * единственная renegotiation за сессию (§4.6).
   */
  addStream?: (stream: MediaStream) => void;
  /**
   * Микрофон вкл/выкл через `sender.replaceTrack(track | null)` —
   * без renegotiation и без повторного `getUserMedia`.
   */
  setMicMuted?: (track: MediaStreamTrack, muted: boolean) => void;
  leave: () => void;
}
