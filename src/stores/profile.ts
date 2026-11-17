/*
 * Профиль и identity приложения. Загружается один раз при старте Shell.
 */

import { create } from 'zustand';
import {
  loadOrCreateIdentity,
  type LocalProfile,
} from '../db/repo/identity';
import {
  normalizeDisplayName,
  updateDisplayName,
  updateNameColor,
  updateProfileAvatar,
} from '../db/repo/profile';
import type { Identity } from '../net/identity';

type ProfileStatus = 'idle' | 'loading' | 'ready' | 'error';

interface ProfileState {
  status: ProfileStatus;
  identity: Identity | null;
  profile: LocalProfile | null;
  persisted: boolean;
  error: string | null;
  load: () => Promise<void>;
  reload: () => Promise<void>;
  rename: (raw: string) => Promise<boolean>;
  setColor: (color: string) => Promise<boolean>;
  setAvatar: (hash: string | null) => Promise<boolean>;
}

export const useProfileStore = create<ProfileState>((set, get) => ({
  status: 'idle',
  identity: null,
  profile: null,
  persisted: false,
  error: null,

  load: async () => {
    if (get().status === 'loading' || get().status === 'ready') {
      return;
    }
    set({ status: 'loading', error: null });
    try {
      const loaded = await loadOrCreateIdentity();
      set({
        status: 'ready',
        identity: loaded.identity,
        profile: loaded.profile,
        persisted: loaded.persisted,
        error: null,
      });
    } catch (error) {
      set({
        status: 'error',
        error: error instanceof Error ? error.message : 'Не удалось создать identity',
      });
    }
  },

  rename: async (raw: string) => {
    const name = normalizeDisplayName(raw);
    const state = get();
    if (!name || !state.profile) {
      return false;
    }
    if (state.persisted) {
      await updateDisplayName(name);
    }
    set({
      profile: { ...state.profile, displayName: name },
    });
    return true;
  },

  reload: async () => {
    set({ status: 'idle', error: null });
    await get().load();
  },

  setColor: async (color: string) => {
    if (!/^#[0-9a-f]{6}$/i.test(color)) {
      return false;
    }
    const state = get();
    if (!state.profile) {
      return false;
    }
    if (state.persisted) {
      await updateNameColor(color);
    }
    set({ profile: { ...state.profile, nameColor: color } });
    return true;
  },

  setAvatar: async (hash: string | null) => {
    const state = get();
    if (!state.profile) {
      return false;
    }
    if (state.persisted) {
      await updateProfileAvatar(hash);
    }
    set({ profile: { ...state.profile, avatarHash: hash } });
    return true;
  },
}));
