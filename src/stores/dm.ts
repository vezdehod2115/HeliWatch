/*
 * Личные сообщения: список диалогов, открытый диалог и фото из файлового кэша.
 *
 * Важное отличие от чата комнаты: DM не смешиваются с `room_chat` ни в БД, ни
 * в этом store. Фото здесь живут blob-URL'ами из кэша (LRU 200 МБ, §4.7), а не
 * только в памяти сессии.
 */

import { create } from 'zustand';
import {
  listConversation,
  listLastMessages,
  setDmStatus,
  type DmMessage,
} from '../db/repo/dm';
import { mediaImageUrl } from '../db/repo/media';

export type DmStatus = 'idle' | 'loading' | 'ready';

export interface DmPeerSummary {
  peerUserId: string;
  lastMessage: DmMessage | null;
  unread: number;
}

export interface DmTransferState {
  id: string;
  direction: 'in' | 'out';
  progress: number;
  total: number;
}

export interface DmState {
  status: DmStatus;
  peers: DmPeerSummary[];
  activePeer: string | null;
  messages: DmMessage[];
  /** imageId/msgId → blob URL из кэша. */
  images: Record<string, string>;
  transfers: Record<string, DmTransferState>;
  draft: string;
  error: string | null;

  loadPeers: () => Promise<void>;
  openPeer: (peerUserId: string) => Promise<void>;
  reloadActive: () => Promise<void>;
  closePeer: () => void;
  setDraft: (draft: string) => void;
  markDelivered: (msgId: string) => Promise<void>;
  setImageUrl: (id: string, url: string) => void;
  resolveImages: () => Promise<void>;
  setTransfer: (transfer: DmTransferState) => void;
  clearTransfer: (id: string) => void;
}

export const useDmStore = create<DmState>((set, get) => ({
  status: 'idle',
  peers: [],
  activePeer: null,
  messages: [],
  images: {},
  transfers: {},
  draft: '',
  error: null,

  loadPeers: async () => {
    if (get().status === 'loading') {
      return;
    }
    set({ status: 'loading', error: null });
    try {
      const last = await listLastMessages();
      const peers: DmPeerSummary[] = [...last.entries()].map(([peerUserId, message]) => ({
        peerUserId,
        lastMessage: message,
        unread: 0,
      }));
      peers.sort((left, right) => (right.lastMessage?.ts ?? 0) - (left.lastMessage?.ts ?? 0));
      set({ peers, status: 'ready' });
    } catch (error) {
      set({
        status: 'ready',
        error: error instanceof Error ? error.message : 'Не удалось прочитать диалоги',
      });
    }
  },

  openPeer: async (peerUserId) => {
    set({ activePeer: peerUserId, messages: [], draft: '' });
    await get().reloadActive();
  },

  reloadActive: async () => {
    const peer = get().activePeer;
    if (!peer) {
      return;
    }
    const messages = await listConversation(peer);
    set({ messages });
    await get().resolveImages();
    const last = await listLastMessages();
    set((state) => ({
      peers: state.peers.map((item) =>
        item.peerUserId === peer
          ? { ...item, lastMessage: last.get(peer) ?? item.lastMessage }
          : item,
      ),
    }));
  },

  closePeer: () => set({ activePeer: null, messages: [], draft: '' }),

  setDraft: (draft) => set({ draft: draft.slice(0, 4000) }),

  markDelivered: async (msgId) => {
    await setDmStatus(msgId, 'delivered');
    set((state) => ({
      messages: state.messages.map((message) =>
        message.id === msgId ? { ...message, status: 'delivered' } : message,
      ),
    }));
  },

  setImageUrl: (id, url) => set((state) => ({ images: { ...state.images, [id]: url } })),

  /** Подтянуть из кэша все фото открытого диалога, которых нет в памяти. */
  resolveImages: async () => {
    const messages = get().messages;
    const images = get().images;
    const next = { ...images };
    let changed = false;
    for (const message of messages) {
      if (message.kind !== 'image' || !message.imagePath) {
        continue;
      }
      const key = message.imagePath;
      if (next[key]) {
        continue;
      }
      const url = await mediaImageUrl(message.imagePath);
      if (url) {
        next[key] = url;
        changed = true;
      }
    }
    if (changed) {
      set({ images: next });
    }
  },

  setTransfer: (transfer) =>
    set((state) => ({ transfers: { ...state.transfers, [transfer.id]: transfer } })),

  clearTransfer: (id) =>
    set((state) => {
      if (!state.transfers[id]) {
        return state;
      }
      const next = { ...state.transfers };
      delete next[id];
      return { transfers: next };
    }),
}));
