/*
 * Учёт сессии комнаты для статистики (этап 7, §5).
 *
 * Строка `sessions` открывается при входе и живёт до выхода; каждые 30 секунд
 * пишется heartbeat и время каждого собеседника. Если процесс убили, следующий
 * старт закрывает сессию временем последнего heartbeat (`closeStaleSessions`),
 * поэтому статистика не теряет уже записанное и не показывает «вечную комнату».
 */

import { createUlid } from '../../net/protocol';
import type { RoomMode } from '../../net/protocol';
import {
  addPeerTime,
  closeSession,
  heartbeatSession,
  openSession,
  type SessionEndReason,
  type SessionPeer,
} from '../../db/repo/stats';
import { touchFriendMeet } from '../../db/repo/friends';

export const STATS_TICK_MS = 30_000;

export interface SessionTrackerOptions {
  code: string;
  mode: RoomMode;
  isPlaying: () => boolean;
  isMicOn: () => boolean;
  now?: () => number;
}

export class SessionTracker {
  private readonly id: string;
  private readonly options: SessionTrackerOptions;
  private readonly now: () => number;
  private readonly seen = new Set<string>();
  private peers: SessionPeer[] = [];
  private started = false;
  private lastTick = 0;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(options: SessionTrackerOptions) {
    this.id = createUlid();
    this.options = options;
    this.now = options.now ?? (() => Date.now());
  }

  get sessionId(): string {
    return this.id;
  }

  /** Открыть сессию; безопасно вызывать повторно — второй раз ничего не делает. */
  async start(hostUserId: string | null, peers: SessionPeer[]): Promise<void> {
    if (this.started) {
      return;
    }
    this.started = true;
    this.lastTick = this.now();
    await openSession({
      id: this.id,
      roomCode: this.options.code,
      mode: this.options.mode,
      startedAt: this.lastTick,
      peers,
      hostUserId,
    });
    await this.applyPeers(peers);
    this.timer = setInterval(() => {
      void this.tick();
    }, STATS_TICK_MS);
  }

  /** Состав изменился: новым участникам засчитываем встречу и сессию. */
  async updatePeers(peers: SessionPeer[]): Promise<void> {
    if (!this.started) {
      return;
    }
    const changed =
      peers.length !== this.peers.length ||
      peers.some((peer, index) => peer.userId !== this.peers[index]?.userId);
    this.peers = peers;
    if (!changed) {
      return;
    }
    await heartbeatSession(this.id, this.now(), peers);
    await this.applyPeers(peers);
  }

  private async applyPeers(peers: SessionPeer[]): Promise<void> {
    for (const peer of peers) {
      if (this.seen.has(peer.userId)) {
        continue;
      }
      this.seen.add(peer.userId);
      // Новая встреча: +1 к сессиям и отметка последней встречи у друга.
      await addPeerTime({
        peerUserId: peer.userId,
        at: this.now(),
        secondsTotal: 0,
        mode: this.options.mode,
        newSession: true,
      });
      await touchFriendMeet(peer.userId, this.now());
    }
  }

  private async tick(): Promise<void> {
    if (!this.started) {
      return;
    }
    const now = this.now();
    const elapsed = Math.max(0, Math.round((now - this.lastTick) / 1000));
    this.lastTick = now;
    if (elapsed === 0 || this.peers.length === 0) {
      await heartbeatSession(this.id, now, this.peers);
      return;
    }
    const playing = this.options.isPlaying();
    const micOn = this.options.isMicOn();
    for (const peer of this.peers) {
      await addPeerTime({
        peerUserId: peer.userId,
        at: now,
        secondsTotal: elapsed,
        secondsWatch: playing ? elapsed : 0,
        secondsVoice: micOn ? elapsed : 0,
        mode: this.options.mode,
      });
    }
    await heartbeatSession(this.id, now, this.peers);
  }

  /** Закрыть сессию: дописываем последний неполный интервал. */
  async stop(reason: SessionEndReason): Promise<void> {
    if (!this.started) {
      return;
    }
    this.started = false;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    const now = this.now();
    const elapsed = Math.max(0, Math.round((now - this.lastTick) / 1000));
    if (elapsed > 0 && this.peers.length > 0) {
      const playing = this.options.isPlaying();
      const micOn = this.options.isMicOn();
      for (const peer of this.peers) {
        await addPeerTime({
          peerUserId: peer.userId,
          at: now,
          secondsTotal: elapsed,
          secondsWatch: playing ? elapsed : 0,
          secondsVoice: micOn ? elapsed : 0,
          mode: this.options.mode,
        });
      }
    }
    await closeSession(this.id, now, reason);
  }
}
