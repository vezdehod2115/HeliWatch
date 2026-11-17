/*
 * Ducking (В§2.5, В§2.2): РїРѕРєР° РєС‚Рѕ-С‚Рѕ РіРѕРІРѕСЂРёС‚, Р·РІСѓРє РІРёРґРµРѕ РїСЂРёРіР»СѓС€Р°РµС‚СЃСЏ, С‡С‚РѕР±С‹
 * РіРѕР»РѕСЃ Р±С‹Р» СЃР»С‹С€РµРЅ. РџСЂРёРјРµРЅСЏРµС‚СЃСЏ Рє СЃР°Р№С‚Сѓ (РєРѕРјР°РЅРґР° page-hook `setVolume`) РёР»Рё Рє
 * Р»РѕРєР°Р»СЊРЅРѕРјСѓ <video> (mode C) С‡РµСЂРµР· РєРѕР»Р±СЌРє `apply`.
 *
 * Р РµС€РµРЅРёРµ вЂ” С‡РёСЃС‚Р°СЏ Р»РѕРіРёРєР° СЃ С‚Р°Р№РјРµСЂРѕРј СѓРґРµСЂР¶Р°РЅРёСЏ: РїСЂРѕРІРµСЂРёС‚СЊ РµС‘ РјРѕР¶РЅРѕ РІ Node,
 * РїРѕСЌС‚РѕРјСѓ С‡Р°СЃС‹ Рё set/clearTimeout РїРѕРґСЃС‚Р°РІР»СЏСЋС‚СЃСЏ.
 */

export const DUCK_VOLUME = 0.22;
export const DUCK_HOLD_MS = 1200;
export const FULL_VOLUME = 1;

export interface DuckingControllerOptions {
  /** РљСѓРґР° РѕС‚РїСЂР°РІРёС‚СЊ РіСЂРѕРјРєРѕСЃС‚СЊ: 0вЂ¦1. Р’С‹Р·С‹РІР°РµС‚СЃСЏ С‚РѕР»СЊРєРѕ РїСЂРё РёР·РјРµРЅРµРЅРёРё. */
  apply: (volume: number) => void;
  enabled?: boolean;
  duckVolume?: number;
  holdMs?: number;
  setTimer?: (handler: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

/**
 * РљС‚Рѕ РіРѕРІРѕСЂРёС‚ вЂ” С‚РѕС‚ РІ РјРЅРѕР¶РµСЃС‚РІРµ. Р“СЂРѕРјРєРѕСЃС‚СЊ РїР°РґР°РµС‚ СЃСЂР°Р·Сѓ, РІРѕР·РІСЂР°С‰Р°РµС‚СЃСЏ С‡РµСЂРµР·
 * `holdMs` РїРѕСЃР»Рµ РїРѕСЃР»РµРґРЅРµРіРѕ РіРѕР»РѕСЃР°; РІС‹РєР»СЋС‡РµРЅРЅС‹Р№ ducking РІРѕР·РІСЂР°С‰Р°РµС‚ Р·РІСѓРє СЃСЂР°Р·Сѓ.
 */
export class DuckingController {
  private readonly apply: (volume: number) => void;
  private readonly duckVolume: number;
  private readonly holdMs: number;
  private readonly setTimer: (handler: () => void, ms: number) => ReturnType<typeof setTimeout>;
  private readonly clearTimer: (timer: ReturnType<typeof setTimeout>) => void;
  private readonly speakers = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private enabledValue: boolean;
  private ducked = false;

  constructor(options: DuckingControllerOptions) {
    this.apply = options.apply;
    this.enabledValue = options.enabled ?? true;
    this.duckVolume = options.duckVolume ?? DUCK_VOLUME;
    this.holdMs = options.holdMs ?? DUCK_HOLD_MS;
    this.setTimer = options.setTimer ?? ((handler, ms) => setTimeout(handler, ms));
    this.clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer));
  }

  get enabled(): boolean {
    return this.enabledValue;
  }

  get isDucked(): boolean {
    return this.ducked;
  }

  get speakingCount(): number {
    return this.speakers.size;
  }

  /** `key` вЂ” 'self' РёР»Рё userId РїРёСЂР°. */
  setSpeaking(key: string, speaking: boolean): void {
    const wasSpeaking = this.speakers.has(key);
    if (speaking) {
      this.speakers.add(key);
    } else {
      this.speakers.delete(key);
    }
    if (speaking && !wasSpeaking) {
      this.duckNow();
      return;
    }
    if (!speaking && wasSpeaking && this.speakers.size === 0) {
      this.scheduleRestore();
    }
  }

  setEnabled(enabled: boolean): void {
    if (this.enabledValue === enabled) {
      return;
    }
    this.enabledValue = enabled;
    if (!enabled) {
      this.restoreNow();
    } else if (this.speakers.size > 0) {
      this.duckNow();
    }
  }

  /** РџСЂРѕСЃС‚РѕРµ СѓРїСЂР°РІР»РµРЅРёРµ РёР· РЅР°СЃС‚СЂРѕРµРє: В«РїСЂРёРіР»СѓС€Р°С‚СЊ Р·РІСѓРє РїСЂРё РіРѕР»РѕСЃРµВ». */
  toggle(): void {
    this.setEnabled(!this.enabledValue);
  }

  dispose(): void {
    if (this.timer) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
    this.speakers.clear();
  }

  private duckNow(): void {
    if (!this.enabledValue) {
      return;
    }
    if (this.timer) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
    if (this.ducked) {
      return;
    }
    this.ducked = true;
    this.apply(this.duckVolume);
  }

  private scheduleRestore(): void {
    if (this.timer) {
      this.clearTimer(this.timer);
    }
    this.timer = this.setTimer(() => {
      this.timer = null;
      if (this.speakers.size === 0) {
        this.restoreNow();
      }
    }, this.holdMs);
  }

  private restoreNow(): void {
    if (this.timer) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
    if (!this.ducked) {
      return;
    }
    this.ducked = false;
    this.apply(FULL_VOLUME);
  }
}
