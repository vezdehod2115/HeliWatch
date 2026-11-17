/*
 * Статистика (этап 7): сводка, время по друзьям и последние сессии.
 * Все цифры приходят из SQLite, store не считает время сам.
 */

import { create } from 'zustand';
import {
  countSessions,
  listPeerTotals,
  listSessions,
  type PeerTotal,
  type SessionRecord,
} from '../db/repo/stats';

export interface StatsSummary {
  sessions: number;
  secondsTotal: number;
  secondsWatch: number;
  secondsVoice: number;
  friends: number;
  lastAt: number;
}

export interface StatsState {
  status: 'idle' | 'loading' | 'ready';
  summary: StatsSummary;
  peers: PeerTotal[];
  sessions: SessionRecord[];
  error: string | null;
  load: () => Promise<void>;
}

const empty: StatsSummary = {
  sessions: 0,
  secondsTotal: 0,
  secondsWatch: 0,
  secondsVoice: 0,
  friends: 0,
  lastAt: 0,
};

export const useStatsStore = create<StatsState>((set) => ({
  status: 'idle',
  summary: empty,
  peers: [],
  sessions: [],
  error: null,

  load: async () => {
    set({ status: 'loading', error: null });
    try {
      const [peers, sessions, sessionCount] = await Promise.all([
        listPeerTotals(),
        listSessions(40),
        countSessions(),
      ]);
      const summary: StatsSummary = {
        sessions: sessionCount,
        secondsTotal: peers.reduce((sum, peer) => sum + peer.secondsTotal, 0),
        secondsWatch: peers.reduce((sum, peer) => sum + peer.secondsWatch, 0),
        secondsVoice: peers.reduce((sum, peer) => sum + peer.secondsVoice, 0),
        friends: peers.length,
        lastAt: peers.reduce((max, peer) => Math.max(max, peer.lastMeetAt), 0),
      };
      set({ status: 'ready', peers, sessions, summary });
    } catch (error) {
      set({
        status: 'ready',
        error: error instanceof Error ? error.message : 'Не удалось прочитать статистику',
      });
    }
  },
}));
