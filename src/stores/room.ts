/*
 * Снимок комнаты для интерфейса. Им владеет RoomClient (net/room.ts) через
 * колбэки; React читает его из zustand и не хранит сетевую логику.
 */

import { create } from 'zustand';
import type {
  MemberInfo,
  PlaybackState,
  RoomMode,
  RoomRole,
} from '../net/protocol';
import type { JoinRequestInfo, RoomPhase } from '../net/room';

export interface RoomSnapshot {
  phase: RoomPhase;
  code: string;
  role: RoomRole;
  mode: RoomMode;
  strategy: string;
  selfUserId: string;
  selfPeerId: string;
  hostUserId: string | null;
  members: MemberInfo[];
  playback: PlaybackState | null;
  /** Момент получения state локальным временем — для проекции времени. */
  stateReceivedAt: number;
  error: string | null;
  hint: string | null;
  peerCount: number;
  /** Последний измеренный дрейф в секундах — для диагностики. */
  drift: number | null;
  /** Текущий driver (по последнему state). */
  driverId: string | null;
  /** Настройки комнаты из welcome/room-meta (этап 6). */
  title: string;
  limit: number;
  closed: boolean;
  knock: boolean;
  /** Эпоха хоста: меняется при передаче и миграции. */
  epoch: number;
  /** «Стуки» — у хоста, пока он не принял решение. */
  joinRequests: JoinRequestInfo[];
}

export interface RoomStore extends RoomSnapshot {
  patch: (patch: Partial<RoomSnapshot>) => void;
  reset: () => void;
}

const initial: RoomSnapshot = {
  phase: 'connecting',
  code: '',
  role: 'guest',
  mode: 'site',
  strategy: '',
  selfUserId: '',
  selfPeerId: '',
  hostUserId: null,
  members: [],
  playback: null,
  stateReceivedAt: 0,
  error: null,
  hint: null,
  peerCount: 0,
  drift: null,
  driverId: null,
  title: '',
  limit: 4,
  closed: false,
  knock: false,
  epoch: 1,
  joinRequests: [],
};

export const useRoomStore = create<RoomStore>((set) => ({
  ...initial,
  patch: (patch) => set(patch),
  reset: () => set(initial),
}));
