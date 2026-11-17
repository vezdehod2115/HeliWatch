/*
 * trystero 0.26.0 (pin из §2.7 плана).
 *
 * JSON-action `hw` — сообщения комнаты, бинарный `hw-blob` — чанки фото (§4.1).
 * Голос: микрофон уходит MediaStream-треком, вкл/выкл — `sender.replaceTrack`
 * без renegotiation (§4.6). Вся криптография — своя, в identity.ts.
 * Стратегии сигналинга по §4.8: nostr → mqtt → torrent. В 0.26 подпути
 * `trystero/mqtt` и `trystero/torrent` превратились в пустые заглушки,
 * поэтому стратегии берём из пакетов `@trystero-p2p/*` той же версии.
 */

import type { JoinRoomConfig, JsonValue } from 'trystero';
import { APP_ID } from './protocol';
import { buildRtcConfig } from './ice';
import type { Channel } from './transport';

export type StrategyId = 'nostr' | 'mqtt' | 'torrent';

export const STRATEGIES: readonly StrategyId[] = ['nostr', 'mqtt', 'torrent'];

export const STRATEGY_LABELS: Record<StrategyId, string> = {
  nostr: 'Nostr',
  mqtt: 'MQTT',
  torrent: 'BitTorrent',
};

/**
 * ICE из §4.8: публичные STUN + best-effort TURN Open Relay. Свой TURN и режим
 * «только TURN» приходят из настроек этапа 7 (`net/ice.ts`) и добавляются к
 * этому набору, а не заменяют его.
 */
const ICE_SERVERS: RTCIceServer[] = [
  {
    urls: [
      'stun:stun.l.google.com:19302',
      'stun:stun1.l.google.com:19302',
      'stun:stun.cloudflare.com:3478',
    ],
  },
  {
    urls: [
      'turn:openrelay.metered.ca:80',
      'turn:openrelay.metered.ca:443',
      'turn:openrelay.metered.ca:443?transport=tcp',
    ],
    username: 'openrelayproject',
    credential: 'openrelayproject',
  },
];

const ROOM_CONFIG: JoinRoomConfig = {
  appId: APP_ID,
  rtcConfig: {
    iceServers: ICE_SERVERS,
    iceCandidatePoolSize: 2,
  },
  relayConfig: {
    warnOnRelayFailure: false,
  },
};

/** Конфиг на каждое подключение: TURN из настроек мог измениться. */
function roomConfig(): JoinRoomConfig {
  return {
    ...ROOM_CONFIG,
    rtcConfig: buildRtcConfig(ICE_SERVERS),
  };
}

type ActionLike = {
  send: (data: JsonValue, options?: { target?: string }) => Promise<void>;
  onMessage: ((data: unknown, context: { peerId: string }) => void) | null;
};

type StrategyModule = {
  joinRoom: (config: JoinRoomConfig, roomId: string) => RoomLike;
  selfId: string;
};

type RoomLike = {
  makeAction: (namespace: string) => ActionLike;
  onPeerJoin: ((peerId: string) => void) | null;
  onPeerLeave: ((peerId: string) => void) | null;
  onPeerStream: ((
    stream: MediaStream,
    peerId: string,
    metadata?: JsonValue,
  ) => void) | null;
  getPeers: () => Record<string, RTCPeerConnection>;
  addStream: (
    stream: MediaStream,
    options?: { target?: string; metadata?: JsonValue },
  ) => Promise<void>[];
  removeStream: (stream: MediaStream, options?: { target?: string }) => void;
  leave: () => Promise<void>;
};

type RelayGetter = () => Record<string, unknown>;

function countOpenRelays(getter: RelayGetter | undefined): number {
  if (!getter) {
    return 0;
  }
  try {
    const sockets = getter();
    if (!sockets || typeof sockets !== 'object') {
      return 0;
    }
    return Object.values(sockets).filter((socket) => {
      if (!socket || typeof socket !== 'object') {
        return false;
      }
      const record = socket as { readyState?: unknown; connected?: unknown };
      return record.readyState === 1 || record.connected === true;
    }).length;
  } catch {
    return 0;
  }
}

async function loadStrategy(strategy: StrategyId): Promise<{
  module: StrategyModule;
  getRelaySockets?: RelayGetter;
}> {
  switch (strategy) {
    case 'nostr': {
      const module = (await import('trystero/nostr')) as unknown as StrategyModule & {
        getRelaySockets?: RelayGetter;
      };
      return { module, getRelaySockets: module.getRelaySockets };
    }
    case 'mqtt': {
      const module = (await import('@trystero-p2p/mqtt')) as unknown as StrategyModule & {
        getRelaySockets?: RelayGetter;
      };
      return { module, getRelaySockets: module.getRelaySockets };
    }
    case 'torrent': {
      const module = (await import('@trystero-p2p/torrent')) as unknown as StrategyModule & {
        getRelaySockets?: RelayGetter;
      };
      return { module, getRelaySockets: module.getRelaySockets };
    }
    default: {
      throw new Error(`Неизвестная стратегия сигналинга: ${String(strategy)}`);
    }
  }
}

class TrysteroChannel implements Channel {
  readonly selfId: string;
  readonly strategy: string;
  onPeerJoin: ((peerId: string) => void) | null = null;
  onPeerLeave: ((peerId: string) => void) | null = null;
  onMessage: ((data: unknown, peerId: string) => void) | null = null;
  onBlobMessage: ((data: unknown, peerId: string) => void) | null = null;
  onPeerStream:
    | ((stream: MediaStream, peerId: string, metadata?: unknown) => void)
    | null = null;

  private readonly room: RoomLike;
  private readonly getRelaySockets?: RelayGetter;
  private readonly action: ActionLike;
  private readonly blobAction: ActionLike;
  private micTrack: MediaStreamTrack | null = null;
  private micStream: MediaStream | null = null;
  private micMuted = false;
  /** Sender'ы микрофона по пирам: нужны, когда трек снят через replaceTrack(null). */
  private readonly micSenders = new Map<string, RTCRtpSender>();
  /** Стрим файла хоста: кеш нужен, чтобы отдать его поздно подключившемуся пиру. */
  private screenStream: MediaStream | null = null;
  private closed = false;

  constructor(
    strategy: StrategyId,
    room: RoomLike,
    selfId: string,
    getRelaySockets?: RelayGetter,
  ) {
    this.strategy = strategy;
    this.room = room;
    this.selfId = selfId;
    this.getRelaySockets = getRelaySockets;

    const action = room.makeAction('hw');
    this.action = action;
    action.onMessage = (data, context) => {
      if (!this.closed) {
        this.onMessage?.(data, context.peerId);
      }
    };

    const blobAction = room.makeAction('hw-blob');
    this.blobAction = blobAction;
    blobAction.onMessage = (data, context) => {
      if (!this.closed) {
        this.onBlobMessage?.(data, context.peerId);
      }
    };

    room.onPeerJoin = (peerId) => {
      if (this.closed) {
        return;
      }
      // Поздно подключившемуся пиру микрофон нужен без getUserMedia.
      if (this.micTrack) {
        this.sendMicTo(peerId);
      }
      this.onPeerJoin?.(peerId);
    };
    room.onPeerLeave = (peerId) => {
      this.micSenders.delete(peerId);
      if (!this.closed) {
        this.onPeerLeave?.(peerId);
      }
    };
    room.onPeerStream = (stream, peerId, metadata) => {
      if (!this.closed) {
        this.onPeerStream?.(stream, peerId, metadata);
      }
    };
  }

  send(data: unknown, to?: string): void {
    if (this.closed) {
      return;
    }
    void this.action
      .send(data as JsonValue, to ? { target: to } : undefined)
      .catch((error: unknown) => {
        console.warn('[heliwatch] не удалось отправить сообщение', error);
      });
  }

  sendBlob(data: ArrayBuffer, to?: string): void {
    if (this.closed) {
      return;
    }
    void this.blobAction
      .send(data as unknown as JsonValue, to ? { target: to } : undefined)
      .catch((error: unknown) => {
        console.warn('[heliwatch] не удалось отправить чанк фото', error);
      });
  }

  addStream(stream: MediaStream): void {
    if (this.closed) {
      return;
    }
    const track = stream.getAudioTracks()[0] ?? null;
    if (!track) {
      return;
    }
    this.micTrack = track;
    this.micStream = stream;
    this.micMuted = !track.enabled;
    try {
      // Первое включение микрофона: одна renegotiation на соединение (§4.6).
      const pending = this.room.addStream(stream, {
        metadata: { kind: 'voice' },
      });
      void Promise.all(pending)
        .then(() => {
          if (this.closed) {
            return;
          }
          this.indexMicSenders();
          if (this.micMuted) {
            this.applyMicMuted(true);
          }
        })
        .catch((error: unknown) => {
          console.warn('[heliwatch] не удалось добавить микрофон', error);
        });
    } catch (error) {
      console.warn('[heliwatch] addStream упал', error);
      return;
    }
  }

  setMicMuted(track: MediaStreamTrack, muted: boolean): void {
    if (this.closed) {
      return;
    }
    if (!this.micTrack) {
      this.micTrack = track;
    }
    this.micMuted = muted;
    this.indexMicSenders();
    this.applyMicMuted(muted);
  }

  // ---------- Стрим файла хоста (этап 5) ----------

  addScreenStream(stream: MediaStream, peerId?: string): void {
    if (this.closed || stream.getVideoTracks().length === 0) {
      return;
    }
    this.screenStream = stream;
    if (peerId) {
      // Новый зритель получает поток только после успешного welcome.
      this.sendScreenTo(peerId, stream);
      return;
    }
    try {
      const pending = this.room.addStream(stream, {
        metadata: { kind: 'screen' },
      });
      void Promise.all(pending).catch((error: unknown) => {
        console.warn('[heliwatch] не удалось добавить видеопоток', error);
      });
    } catch (error) {
      console.warn('[heliwatch] addStream видеопотока упал', error);
    }
  }

  removeScreenStream(stream: MediaStream): void {
    if (this.screenStream === stream) {
      this.screenStream = null;
    }
    if (this.closed) {
      return;
    }
    try {
      // removeStream сам инициирует renegotiation на каждом соединении.
      this.room.removeStream(stream);
    } catch (error) {
      console.warn('[heliwatch] не удалось убрать видеопоток', error);
    }
  }

  knownPeers(): string[] {
    if (this.closed) {
      return [];
    }
    try {
      return Object.keys(this.room.getPeers());
    } catch {
      return [];
    }
  }

  relayCount(): number {
    return countOpenRelays(this.getRelaySockets);
  }

  leave(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.onPeerJoin = null;
    this.onPeerLeave = null;
    this.onMessage = null;
    this.onBlobMessage = null;
    this.onPeerStream = null;
    this.micTrack = null;
    this.micStream = null;
    this.micSenders.clear();
    this.screenStream = null;
    void this.room.leave().catch(() => undefined);
  }

  // ---------- Микрофон ----------

  private indexMicSenders(): void {
    if (!this.micTrack) {
      return;
    }
    try {
      for (const [peerId, pc] of this.peerConnections()) {
        const sender = pc.getSenders().find((item) => item.track === this.micTrack);
        if (sender) {
          this.micSenders.set(peerId, sender);
        }
      }
    } catch (error) {
      console.warn('[heliwatch] не удалось найти sender микрофона', error);
    }
  }

  private applyMicMuted(muted: boolean): void {
    const track = this.micTrack;
    if (!track) {
      return;
    }
    for (const [peerId, pc] of this.peerConnections()) {
      const sender = this.micSenderFor(peerId, pc);
      if (!sender) {
        continue;
      }
      // replaceTrack(null) — тишина без renegotiation; обратно — тот же трек.
      void Promise.resolve(sender.replaceTrack(muted ? null : track)).catch((error: unknown) => {
        console.warn('[heliwatch] replaceTrack микрофона не сработал', error);
      });
    }
  }

  private micSenderFor(peerId: string, pc: RTCPeerConnection): RTCRtpSender | null {
    const cached = this.micSenders.get(peerId);
    if (cached) {
      return cached;
    }
    try {
      const senders = pc.getSenders();
      const sender =
        senders.find((item) => item.track === this.micTrack) ??
        senders.find((item) => item.track?.kind === 'audio') ??
        null;
      if (sender) {
        this.micSenders.set(peerId, sender);
      }
      return sender;
    } catch {
      return null;
    }
  }

  private sendMicTo(peerId: string): void {
    const stream = this.micStream;
    if (!stream) {
      return;
    }
    try {
      // Поздний пир получает микрофон своим addStream — в рамках его соединения.
      const pending = this.room.addStream(stream, {
        target: peerId,
        metadata: { kind: 'voice' },
      });
      void Promise.all(pending)
        .then(() => {
          if (this.closed) {
            return;
          }
          this.indexMicSenders();
          if (this.micMuted) {
            this.applyMicMuted(true);
          }
        })
        .catch((error: unknown) => {
          console.warn('[heliwatch] микрофон для нового пира не добавлен', error);
        });
    } catch (error) {
      console.warn('[heliwatch] getPeers недоступен', error);
    }
  }

  private sendScreenTo(peerId: string, stream: MediaStream): void {
    try {
      const pending = this.room.addStream(stream, {
        target: peerId,
        metadata: { kind: 'screen' },
      });
      void Promise.all(pending).catch((error: unknown) => {
        console.warn('[heliwatch] видеопоток для нового пира не добавлен', error);
      });
    } catch (error) {
      console.warn('[heliwatch] getPeers недоступен для видеопотока', error);
    }
  }

  private peerConnections(): Array<[string, RTCPeerConnection]> {
    try {
      return Object.entries(this.room.getPeers());
    } catch {
      return [];
    }
  }
}

/** Подключиться к комнате выбранной стратегией. */
export async function connectTrystero(
  strategy: StrategyId,
  code: string,
): Promise<Channel> {
  const { module, getRelaySockets } = await loadStrategy(strategy);
  const room = module.joinRoom(roomConfig(), code);
  return new TrysteroChannel(strategy, room, module.selfId, getRelaySockets);
}
