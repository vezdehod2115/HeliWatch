/*
 * trystero 0.26.0 (pin из §2.7 плана).
 *
 * Один JSON-action `hw` на комнату; вся криптография — своя, в identity.ts.
 * Стратегии сигналинга по §4.8: nostr → mqtt → torrent. В 0.26 подпути
 * `trystero/mqtt` и `trystero/torrent` превратились в пустые заглушки,
 * поэтому стратегии берём из пакетов `@trystero-p2p/*` той же версии.
 */

import type { JoinRoomConfig, JsonValue } from 'trystero';
import { APP_ID } from './protocol';
import type { Channel } from './transport';

export type StrategyId = 'nostr' | 'mqtt' | 'torrent';

export const STRATEGIES: readonly StrategyId[] = ['nostr', 'mqtt', 'torrent'];

export const STRATEGY_LABELS: Record<StrategyId, string> = {
  nostr: 'Nostr',
  mqtt: 'MQTT',
  torrent: 'BitTorrent',
};

/**
 * ICE из §4.8: публичные STUN + best-effort TURN Open Relay. Свой TURN
 * появится в настройках на этапе 7; здесь достаточно рабочего дефолта.
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

type StrategyModule = {
  joinRoom: (config: JoinRoomConfig, roomId: string) => RoomLike;
  selfId: string;
};

type RoomLike = {
  makeAction: (namespace: string) => {
    send: (data: JsonValue, options?: { target?: string }) => Promise<void>;
    onMessage: ((data: unknown, context: { peerId: string }) => void) | null;
  };
  onPeerJoin: ((peerId: string) => void) | null;
  onPeerLeave: ((peerId: string) => void) | null;
  getPeers: () => Record<string, unknown>;
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

  private readonly room: RoomLike;
  private readonly getRelaySockets?: RelayGetter;
  private readonly action: {
    send: (data: JsonValue, options?: { target?: string }) => Promise<void>;
    onMessage: ((data: unknown, context: { peerId: string }) => void) | null;
  };
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

    room.onPeerJoin = (peerId) => {
      if (!this.closed) {
        this.onPeerJoin?.(peerId);
      }
    };
    room.onPeerLeave = (peerId) => {
      if (!this.closed) {
        this.onPeerLeave?.(peerId);
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
    void this.room.leave().catch(() => undefined);
  }
}

/** Подключиться к комнате выбранной стратегией. */
export async function connectTrystero(
  strategy: StrategyId,
  code: string,
): Promise<Channel> {
  const { module, getRelaySockets } = await loadStrategy(strategy);
  const room = module.joinRoom(ROOM_CONFIG, code);
  return new TrysteroChannel(strategy, room, module.selfId, getRelaySockets);
}
