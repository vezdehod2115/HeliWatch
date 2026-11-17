/*
 * Настройки приложения (этап 7): акцент, прозрачность чата, голос, TURN, PiP,
 * парная комната и age-gate. Значения живут в SQLite (`settings`), store лишь
 * кэширует их для UI и сразу применяет сетевые побочные эффекты (ICE).
 */

import { create } from 'zustand';
import { SETTINGS_KEYS, readSetting, writeSetting } from '../db/repo/settings';
import { parseTurnJson, setIceOverrides } from '../net/ice';

export interface AppSettings {
  accentEnabled: boolean;
  chatOpacity: number;
  voiceVolume: number;
  voiceDucking: boolean;
  chatHistory: boolean;
  turnJson: string;
  turnOnly: boolean;
  dmPairRoom: boolean;
  pipEnabled: boolean;
  ageGate: boolean;
}

export const DEFAULT_SETTINGS: AppSettings = {
  accentEnabled: true,
  chatOpacity: 0.9,
  voiceVolume: 1,
  voiceDucking: true,
  chatHistory: false,
  turnJson: '',
  turnOnly: false,
  dmPairRoom: false,
  pipEnabled: true,
  ageGate: true,
};

const KEY_MAP: Record<keyof AppSettings, string> = {
  accentEnabled: SETTINGS_KEYS.accentEnabled,
  chatOpacity: SETTINGS_KEYS.chatOpacity,
  voiceVolume: SETTINGS_KEYS.voiceVolume,
  voiceDucking: SETTINGS_KEYS.voiceDucking,
  chatHistory: SETTINGS_KEYS.chatHistory,
  turnJson: SETTINGS_KEYS.turnJson,
  turnOnly: SETTINGS_KEYS.turnOnly,
  dmPairRoom: SETTINGS_KEYS.dmPairRoom,
  pipEnabled: SETTINGS_KEYS.pipEnabled,
  ageGate: SETTINGS_KEYS.ageGate,
};

export type SettingsStatus = 'idle' | 'loading' | 'ready';

export interface SettingsState extends AppSettings {
  status: SettingsStatus;
  /** Ошибка разбора TURN JSON — показывается в настройках, не ломает сеть. */
  turnError: string | null;
  load: () => Promise<void>;
  update: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => Promise<void>;
  setTurnJson: (raw: string) => Promise<boolean>;
}

function clampOpacity(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_SETTINGS.chatOpacity;
  }
  return Math.min(1, Math.max(0.55, value));
}

function clampVolume(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_SETTINGS.voiceVolume;
  }
  return Math.min(1, Math.max(0, value));
}

function applyIce(turnJson: string, turnOnly: boolean): string | null {
  const parsed = parseTurnJson(turnJson);
  if (!parsed.ok) {
    setIceOverrides({ servers: [], relayOnly: turnOnly });
    return parsed.error;
  }
  setIceOverrides({ servers: parsed.servers, relayOnly: turnOnly });
  return null;
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  ...DEFAULT_SETTINGS,
  status: 'idle',
  turnError: null,

  load: async () => {
    if (get().status === 'loading' || get().status === 'ready') {
      return;
    }
    set({ status: 'loading' });
    const [
      accentEnabled,
      chatOpacity,
      voiceVolume,
      voiceDucking,
      chatHistory,
      turnJson,
      turnOnly,
      dmPairRoom,
      pipEnabled,
      ageGate,
    ] = await Promise.all([
      readSetting<boolean>(SETTINGS_KEYS.accentEnabled, DEFAULT_SETTINGS.accentEnabled),
      readSetting<number>(SETTINGS_KEYS.chatOpacity, DEFAULT_SETTINGS.chatOpacity),
      readSetting<number>(SETTINGS_KEYS.voiceVolume, DEFAULT_SETTINGS.voiceVolume),
      readSetting<boolean>(SETTINGS_KEYS.voiceDucking, DEFAULT_SETTINGS.voiceDucking),
      readSetting<boolean>(SETTINGS_KEYS.chatHistory, DEFAULT_SETTINGS.chatHistory),
      readSetting<string>(SETTINGS_KEYS.turnJson, DEFAULT_SETTINGS.turnJson),
      readSetting<boolean>(SETTINGS_KEYS.turnOnly, DEFAULT_SETTINGS.turnOnly),
      readSetting<boolean>(SETTINGS_KEYS.dmPairRoom, DEFAULT_SETTINGS.dmPairRoom),
      readSetting<boolean>(SETTINGS_KEYS.pipEnabled, DEFAULT_SETTINGS.pipEnabled),
      readSetting<boolean>(SETTINGS_KEYS.ageGate, DEFAULT_SETTINGS.ageGate),
    ]);
    const next: AppSettings = {
      accentEnabled: accentEnabled !== false,
      chatOpacity: clampOpacity(chatOpacity),
      voiceVolume: clampVolume(voiceVolume),
      voiceDucking: voiceDucking !== false,
      chatHistory: chatHistory === true,
      turnJson: typeof turnJson === 'string' ? turnJson : '',
      turnOnly: turnOnly === true,
      dmPairRoom: dmPairRoom === true,
      pipEnabled: pipEnabled !== false,
      ageGate: ageGate !== false,
    };
    const turnError = applyIce(next.turnJson, next.turnOnly);
    set({ ...next, status: 'ready', turnError });
  },

  update: async (key, value) => {
    const normalized =
      key === 'chatOpacity'
        ? clampOpacity(value)
        : key === 'voiceVolume'
          ? clampVolume(value)
          : value;
    set({ [key]: normalized } as Partial<SettingsState>);
    await writeSetting(KEY_MAP[key], normalized);
    if (key === 'turnJson' || key === 'turnOnly') {
      const state = get();
      const turnError = applyIce(state.turnJson, state.turnOnly);
      set({ turnError });
    }
  },

  setTurnJson: async (raw: string) => {
    const parsed = parseTurnJson(raw);
    if (!parsed.ok) {
      set({ turnError: parsed.error });
      return false;
    }
    set({ turnJson: raw });
    await writeSetting(SETTINGS_KEYS.turnJson, raw);
    const state = get();
    set({ turnError: applyIce(raw, state.turnOnly) });
    return true;
  },
}));
