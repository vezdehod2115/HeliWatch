/*
 * Транспортный канал комнаты. Интерфейс отделён от trystero, чтобы RoomClient
 * можно было тестировать с фейковым каналом в Node (см. room.test.ts).
 */

export interface Channel {
  readonly selfId: string;
  readonly strategy: string;
  onPeerJoin: ((peerId: string) => void) | null;
  onPeerLeave: ((peerId: string) => void) | null;
  onMessage: ((data: unknown, peerId: string) => void) | null;
  send: (data: unknown, to?: string) => void;
  knownPeers: () => string[];
  /** Сколько открытых сокетов релея: 0 — сигналинг недоступен. */
  relayCount: () => number;
  leave: () => void;
}
