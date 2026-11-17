/*
 * Состояние чата комнаты: сообщения, «печатает…», прогресс фото, реакции,
 * панель, черновик и недавние эмодзи. Сеть и SQLite живут снаружи (RoomScreen,
 * db/repo/chat.ts), поэтому store остаётся простым и предсказуемым.
 */

import { create } from 'zustand';
import type { ChatMessage } from '../net/protocol';
import { RECENT_LIMIT, pushRecent } from '../features/chat/emoji';

export interface ChatTransfer {
  id: string;
  direction: 'out' | 'in';
  /** Сколько байт передано/получено. */
  progress: number;
  total: number;
  name?: string;
}

export interface FloatingReaction {
  key: string;
  emoji: string;
  from: string;
  name: string;
  /** Координаты нажатия в долях экрана (0…1). */
  x: number;
  y: number;
  at: number;
  self: boolean;
}

export interface TypingPeer {
  name: string;
  until: number;
}

const MAX_MESSAGES = 300;

export interface ChatState {
  roomCode: string;
  messages: ChatMessage[];
  /** imageId → object URL (фото живут в памяти сессии). */
  images: Record<string, string>;
  transfers: Record<string, ChatTransfer>;
  reactions: FloatingReaction[];
  typing: Record<string, TypingPeer>;
  unread: number;
  open: boolean;
  emojiOpen: boolean;
  draft: string;
  recents: string[];
  saveHistory: boolean;
  notice: string | null;

  init: (roomCode: string, options?: { recents?: string[]; saveHistory?: boolean }) => void;
  reset: () => void;
  setOpen: (open: boolean) => void;
  setEmojiOpen: (open: boolean) => void;
  setDraft: (draft: string) => void;
  setSaveHistory: (save: boolean) => void;
  setNotice: (notice: string | null) => void;
  addMessage: (message: ChatMessage) => void;
  updateMessage: (id: string, patch: Partial<ChatMessage>) => void;
  loadMessages: (messages: ChatMessage[]) => void;
  setImage: (id: string, url: string) => void;
  clearImage: (id: string) => void;
  setTransfer: (transfer: ChatTransfer) => void;
  clearTransfer: (id: string) => void;
  addReaction: (reaction: Omit<FloatingReaction, 'key' | 'at'>) => string;
  dropReaction: (key: string) => void;
  setTyping: (userId: string, name: string, on: boolean, now?: number) => void;
  pruneTyping: (now?: number) => void;
  rememberEmoji: (emoji: string) => void;
  setRecents: (recents: string[]) => void;
}

const initial = {
  roomCode: '',
  messages: [] as ChatMessage[],
  images: {} as Record<string, string>,
  transfers: {} as Record<string, ChatTransfer>,
  reactions: [] as FloatingReaction[],
  typing: {} as Record<string, TypingPeer>,
  unread: 0,
  open: false,
  emojiOpen: false,
  draft: '',
  recents: [] as string[],
  saveHistory: false,
  notice: null as string | null,
};

let reactionSeq = 0;

export const useChatStore = create<ChatState>((set, get) => ({
  ...initial,

  init: (roomCode, options = {}) => {
    revokeImages(get().images);
    set({
      ...initial,
      roomCode,
      recents: (options.recents ?? []).slice(0, RECENT_LIMIT),
      saveHistory: options.saveHistory ?? false,
    });
  },

  reset: () => {
    revokeImages(get().images);
    set({ ...initial });
  },

  setOpen: (open) =>
    set((state) => ({
      open,
      unread: open ? 0 : state.unread,
      emojiOpen: open ? state.emojiOpen : false,
    })),

  setEmojiOpen: (open) => set({ emojiOpen: open }),

  setDraft: (draft) => set({ draft: draft.slice(0, 4000) }),

  setSaveHistory: (save) => set({ saveHistory: save }),

  setNotice: (notice) => set({ notice }),

  addMessage: (message) => {
    const state = get();
    const exists = state.messages.some((item) => item.id === message.id);
    if (exists) {
      return;
    }
    const messages = [...state.messages, message].slice(-MAX_MESSAGES);
    const unread = message.self || state.open ? state.unread : state.unread + 1;
    set({ messages, unread });
  },

  updateMessage: (id, patch) =>
    set((state) => ({
      messages: state.messages.map((message) =>
        message.id === id ? { ...message, ...patch } : message,
      ),
    })),

  loadMessages: (messages) => set({ messages: messages.slice(-MAX_MESSAGES) }),

  setImage: (id, url) => set((state) => ({ images: { ...state.images, [id]: url } })),

  clearImage: (id) =>
    set((state) => {
      const url = state.images[id];
      if (!url) {
        return state;
      }
      URL.revokeObjectURL(url);
      const next = { ...state.images };
      delete next[id];
      return { images: next };
    }),

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

  addReaction: (reaction) => {
    reactionSeq += 1;
    const key = `r${reactionSeq}`;
    const now = Date.now();
    const entry: FloatingReaction = { ...reaction, key, at: now };
    set((state) => ({
      // Больше дюжины одновременных реакций — уже шум; старые вытесняем.
      reactions: [...state.reactions.filter((item) => now - item.at < 6000), entry].slice(-12),
    }));
    return key;
  },

  dropReaction: (key) =>
    set((state) => ({ reactions: state.reactions.filter((item) => item.key !== key) })),

  setTyping: (userId, name, on, now = Date.now()) =>
    set((state) => {
      const typing = { ...state.typing };
      if (on) {
        typing[userId] = { name, until: now + 4000 };
      } else {
        delete typing[userId];
      }
      return { typing };
    }),

  pruneTyping: (now = Date.now()) =>
    set((state) => {
      const entries = Object.entries(state.typing).filter(([, peer]) => peer.until > now);
      if (entries.length === Object.keys(state.typing).length) {
        return state;
      }
      return { typing: Object.fromEntries(entries) };
    }),

  rememberEmoji: (emoji) =>
    set((state) => ({ recents: pushRecent(state.recents, emoji, RECENT_LIMIT) })),

  setRecents: (recents) => set({ recents: sanitize(recents) }),
}));

function sanitize(values: string[]): string[] {  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (!value || seen.has(value)) {
      continue;
    }
    seen.add(value);
    result.push(value);
    if (result.length >= RECENT_LIMIT) {
      break;
    }
  }
  return result;
}

/** Object URL'ы фото освобождаем при выходе из комнаты — иначе утечка памяти. */
function revokeImages(images: Record<string, string>): void {
  for (const url of Object.values(images)) {
    if (url) {
      URL.revokeObjectURL(url);
    }
  }
}
