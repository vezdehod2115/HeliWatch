/*
 * Друзья и счётчики лички для интерфейса. Данные читаются из SQLite через
 * репозитории; сеть и подтверждения — в `net/dm.ts`, поэтому store ничего не
 * отправляет и остаётся предсказуемым.
 */

import { create } from 'zustand';
import { listFriends, type Friend } from '../db/repo/friends';
import { countUnread } from '../db/repo/dm';
import { countOutbox } from '../db/repo/outbox';
import { readDmReadMarks, readFriendRequests, type PendingFriendRequest } from '../net/dm';

export type FriendsStatus = 'idle' | 'loading' | 'ready';

export interface FriendsState {
  status: FriendsStatus;
  friends: Friend[];
  requests: PendingFriendRequest[];
  /** Исходящие заявки и сообщения, ждущие встречи. */
  outgoing: number;
  unread: Record<string, number>;
  unreadTotal: number;
  error: string | null;
  load: () => Promise<void>;
  refresh: () => Promise<void>;
}

export const useFriendsStore = create<FriendsState>((set, get) => ({
  status: 'idle',
  friends: [],
  requests: [],
  outgoing: 0,
  unread: {},
  unreadTotal: 0,
  error: null,

  load: async () => {
    if (get().status === 'loading') {
      return;
    }
    set({ status: 'loading', error: null });
    await get().refresh();
    set({ status: 'ready' });
  },

  refresh: async () => {
    try {
      const [friends, requests, outgoing, marks] = await Promise.all([
        listFriends(),
        readFriendRequests(),
        countOutbox(),
        readDmReadMarks(),
      ]);
      const unread = await countUnread(marks);
      const unreadTotal = Object.values(unread).reduce((sum, value) => sum + value, 0);
      set({ friends, requests, outgoing, unread, unreadTotal, error: null });
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : 'Не удалось прочитать друзей',
      });
    }
  },
}));
