/*
 * Динамический акцент из кадра видео (§2.5, этап 7).
 *
 * Цепочка: кадр 16×16 → средний цвет в линейном пространстве → OKLCH-коррекция
 * (L 0.62–0.86, C ≥ 0.06, оттенок сохраняется, при C < 0.05 — мятный) →
 * проверка контраста к фону ≥ 4.5:1 → EMA-сглаживание → дедбенд ΔE < 4 →
 * не чаще 1.5 с → CSS-переменные `--hw-accent` / `--hw-accent-rgb`.
 *
 * Фоллбэк `#6ff0c4` включается, когда кадра нет, видео на паузе, canvas
 * tainted, акцент выключен в настройках или комната закрыта. В PiP самплинг
 * продолжается раз в 2 секунды.
 */

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export interface Lch {
  l: number;
  c: number;
  h: number;
}

export interface AccentColor {
  hex: string;
  rgb: Rgb;
  lch: Lch;
}

/** Мятный акцент HeliWatch — фоллбэк и «фирменный» цвет (§2.5). */
export const ACCENT_FALLBACK = '#6ff0c4';
/** Фон приложения: контраст считаем именно к нему. */
export const ACCENT_BACKGROUND: Rgb = { r: 6, g: 32, b: 29 };
export const ACCENT_L_MIN = 0.62;
export const ACCENT_L_MAX = 0.86;
export const ACCENT_C_MIN = 0.06;
export const ACCENT_C_FALLBACK = 0.11;
export const ACCENT_MIN_CONTRAST = 4.5;
export const ACCENT_SAMPLE_MS = 1500;
export const ACCENT_SAMPLE_PIP_MS = 2000;
/** Нет кадра дольше этого — возвращаем мятный. */
export const ACCENT_IDLE_MS = 4500;
/** ΔE меньше этого не перерисовываем: мигание раздражает больше пользы. */
export const ACCENT_DEADBAND = 4;
export const ACCENT_EMA_ALPHA = 0.35;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function srgbToLinear(channel: number): number {
  const value = clamp(channel, 0, 255) / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

export function linearToSrgb(channel: number): number {
  const value = clamp(channel, 0, 1);
  const encoded =
    value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055;
  return Math.round(clamp(encoded, 0, 1) * 255);
}

/** Относительная яркость WCAG — она же Y в линейном RGB. */
export function relativeLuminance(rgb: Rgb): number {
  return (
    0.2126 * srgbToLinear(rgb.r) +
    0.7152 * srgbToLinear(rgb.g) +
    0.0722 * srgbToLinear(rgb.b)
  );
}

export function contrastRatio(left: Rgb, right: Rgb): number {
  const a = relativeLuminance(left);
  const b = relativeLuminance(right);
  const lighter = Math.max(a, b);
  const darker = Math.min(a, b);
  return (lighter + 0.05) / (darker + 0.05);
}

export function rgbToOklab(rgb: Rgb): { L: number; a: number; b: number } {
  const r = srgbToLinear(rgb.r);
  const g = srgbToLinear(rgb.g);
  const b = srgbToLinear(rgb.b);
  const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
  const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
  const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;
  const lRoot = Math.cbrt(l);
  const mRoot = Math.cbrt(m);
  const sRoot = Math.cbrt(s);
  return {
    L: 0.2104542553 * lRoot + 0.793617785 * mRoot - 0.0040720468 * sRoot,
    a: 1.9779984951 * lRoot - 2.428592205 * mRoot + 0.4505937099 * sRoot,
    b: 0.0259040371 * lRoot + 0.7827717662 * mRoot - 0.808675766 * sRoot,
  };
}

export function oklabToRgb(L: number, a: number, b: number): Rgb {
  const lRoot = L + 0.3963377774 * a + 0.2158037573 * b;
  const mRoot = L - 0.1055613458 * a - 0.0638541728 * b;
  const sRoot = L - 0.0894841775 * a - 1.291485548 * b;
  const l = lRoot ** 3;
  const m = mRoot ** 3;
  const s = sRoot ** 3;
  const r = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const blue = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;
  return {
    r: linearToSrgb(r),
    g: linearToSrgb(g),
    b: linearToSrgb(blue),
  };
}

export function rgbToOklch(rgb: Rgb): Lch {
  const lab = rgbToOklab(rgb);
  const c = Math.sqrt(lab.a * lab.a + lab.b * lab.b);
  const h = ((Math.atan2(lab.b, lab.a) * 180) / Math.PI + 360) % 360;
  return { l: lab.L, c, h };
}

export function oklchToRgb(lch: Lch): Rgb {
  const radians = (lch.h * Math.PI) / 180;
  return oklabToRgb(lch.l, Math.cos(radians) * lch.c, Math.sin(radians) * lch.c);
}

export function rgbToHex(rgb: Rgb): string {
  return `#${[rgb.r, rgb.g, rgb.b]
    .map((value) => clamp(Math.round(value), 0, 255).toString(16).padStart(2, '0'))
    .join('')}`;
}

export function hexToRgb(hex: string): Rgb | null {
  const match = hex.trim().match(/^#?([0-9a-f]{6})$/i);
  if (!match?.[1]) {
    return null;
  }
  const value = match[1];
  return {
    r: parseInt(value.slice(0, 2), 16),
    g: parseInt(value.slice(2, 4), 16),
    b: parseInt(value.slice(4, 6), 16),
  };
}

/** Мятный оттенок берём из фоллбэка, чтобы «нечего показать» не меняло тему. */
const MINT_LCH = rgbToOklch({ r: 0x6f, g: 0xf0, b: 0xc4 });

/** ΔE в OKLab, умноженный на 100: порог 4 — заметная, но не мигающая разница. */
export function deltaE(left: Rgb, right: Rgb): number {
  const a = rgbToOklab(left);
  const b = rgbToOklab(right);
  return (
    Math.sqrt((a.L - b.L) ** 2 + (a.a - b.a) ** 2 + (a.b - b.b) ** 2) * 100
  );
}

/**
 * Привести цвет кадра к акценту темы. Оттенок сохраняется, светлота
 * зажимается в безопасный диапазон, слишком серый цвет заменяется мятным.
 */
export function correctAccent(rgb: Rgb): AccentColor {
  const source = rgbToOklch(rgb);
  const minted = source.c < 0.05;
  let lch: Lch = {
    l: clamp(source.l, ACCENT_L_MIN, ACCENT_L_MAX),
    c: Math.max(minted ? ACCENT_C_FALLBACK : source.c, ACCENT_C_MIN),
    h: minted ? MINT_LCH.h : source.h,
  };

  // Геймут: уменьшаем насыщенность, пока sRGB не станет допустимым.
  let candidate = oklchToRgb(lch);
  let guard = 0;
  while (!inGamut(candidate) && guard < 24) {
    lch = { ...lch, c: Math.max(ACCENT_C_MIN, lch.c - 0.008) };
    candidate = oklchToRgb(lch);
    guard += 1;
  }
  // Контраст к тёмному фону: поднимаем светлоту в разрешённых границах.
  guard = 0;
  while (
    contrastRatio(candidate, ACCENT_BACKGROUND) < ACCENT_MIN_CONTRAST &&
    lch.l < ACCENT_L_MAX &&
    guard < 24
  ) {
    lch = { ...lch, l: Math.min(ACCENT_L_MAX, lch.l + 0.02) };
    candidate = oklchToRgb(lch);
    guard += 1;
  }

  return { hex: rgbToHex(candidate), rgb: candidate, lch };
}

function inGamut(rgb: Rgb): boolean {
  return [rgb.r, rgb.g, rgb.b].every((value) => value >= 0 && value <= 255);
}

/**
 * Фоллбэк — ровно фирменный мятный `#6ff0c4`, без OKLCH-коррекции: он должен
 * совпадать с `theme.css` и логотипом.
 */
export const FALLBACK_ACCENT: AccentColor = {
  hex: ACCENT_FALLBACK,
  rgb: hexToRgb(ACCENT_FALLBACK) ?? { r: 111, g: 240, b: 196 },
  lch: rgbToOklch(hexToRgb(ACCENT_FALLBACK) ?? { r: 111, g: 240, b: 196 }),
};

/**
 * Средний цвет кадра в линейном пространстве. Почти чёрные и белые пиксели
 * отбрасываются: иначе тёмные поля вокруг видео дают «серый» акцент.
 */
export function averageFrameColor(
  data: Uint8ClampedArray | Uint8Array,
  minLuminance = 0.02,
  maxLuminance = 0.95,
): Rgb | null {
  let r = 0;
  let g = 0;
  let b = 0;
  let weight = 0;
  const pixels = Math.floor(data.length / 4);
  for (let index = 0; index < pixels; index += 1) {
    const offset = index * 4;
    if ((data[offset + 3] ?? 255) < 24) {
      continue;
    }
    const red = data[offset] ?? 0;
    const green = data[offset + 1] ?? 0;
    const blue = data[offset + 2] ?? 0;
    const lr = srgbToLinear(red);
    const lg = srgbToLinear(green);
    const lb = srgbToLinear(blue);
    const luminance = 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
    if (luminance < minLuminance || luminance > maxLuminance) {
      continue;
    }
    r += lr;
    g += lg;
    b += lb;
    weight += 1;
  }
  if (weight === 0) {
    return null;
  }
  return {
    r: linearToSrgb(r / weight),
    g: linearToSrgb(g / weight),
    b: linearToSrgb(b / weight),
  };
}

export type FrameSample = { rgb: Rgb | null; tainted: boolean };

/** Кадр из локального `<video>` (режимы B/C): canvas не tainted для blob/asset. */
export function sampleVideoFrame(
  video: HTMLVideoElement,
  canvas?: HTMLCanvasElement,
): FrameSample {
  if (!video.videoWidth || !video.videoHeight) {
    return { rgb: null, tainted: false };
  }
  const surface = canvas ?? document.createElement('canvas');
  surface.width = 16;
  surface.height = 16;
  const context = surface.getContext('2d', { willReadFrequently: true });
  if (!context) {
    return { rgb: null, tainted: false };
  }
  try {
    context.drawImage(video, 0, 0, 16, 16);
    const frame = context.getImageData(0, 0, 16, 16);
    return { rgb: averageFrameColor(frame.data), tainted: false };
  } catch {
    return { rgb: null, tainted: true };
  }
}

/**
 * Разбор события `frame` из site-hook: `{rgb:{r,g,b}|null, w, h}`.
 * `rgb:null` приходит при tainted canvas — это повод для фоллбэка.
 */
export function accentFromSiteFrame(data: unknown): FrameSample {
  if (typeof data !== 'object' || data === null) {
    return { rgb: null, tainted: false };
  }
  const record = data as Record<string, unknown>;
  const rgb = record.rgb;
  if (rgb === null) {
    return { rgb: null, tainted: true };
  }
  if (typeof rgb !== 'object' || rgb === null) {
    return { rgb: null, tainted: false };
  }
  const value = rgb as Record<string, unknown>;
  const r = typeof value.r === 'number' ? value.r : Number.NaN;
  const g = typeof value.g === 'number' ? value.g : Number.NaN;
  const b = typeof value.b === 'number' ? value.b : Number.NaN;
  if (![r, g, b].every((channel) => Number.isFinite(channel) && channel >= 0 && channel <= 255)) {
    return { rgb: null, tainted: false };
  }
  return { rgb: { r, g, b }, tainted: false };
}

export interface AccentControllerOptions {
  apply?: (accent: AccentColor) => void;
  now?: () => number;
  /** Интервал между применениями: 1.5 с в обычном режиме, 2 с в PiP. */
  intervalMs?: number;
  /** Через сколько без кадров возвращаем мятный. */
  idleMs?: number;
}

/**
 * Контроллер акцента: принимает кадры, сглаживает и решает, когда менять тему.
 * Ничего не знает про DOM, кроме `apply`-колбэка, поэтому тестируется в Node.
 */
export class AccentController {
  private readonly apply: (accent: AccentColor) => void;
  private readonly now: () => number;
  private readonly idleMs: number;
  private intervalMs: number;

  private enabled = true;
  private pip = false;
  private current: AccentColor = FALLBACK_ACCENT;
  private lastAppliedAt = 0;
  private lastFrameAt = 0;
  private appliedFallback = false;

  constructor(options: AccentControllerOptions = {}) {
    this.apply = options.apply ?? (() => undefined);
    this.now = options.now ?? (() => Date.now());
    this.idleMs = options.idleMs ?? ACCENT_IDLE_MS;
    this.intervalMs = options.intervalMs ?? ACCENT_SAMPLE_MS;
  }

  get currentAccent(): AccentColor {
    return this.current;
  }

  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) {
      return;
    }
    this.enabled = enabled;
    if (!enabled) {
      this.applyFallback(true);
    } else {
      this.lastFrameAt = this.now();
      this.appliedFallback = false;
    }
  }

  setPip(pip: boolean): void {
    this.pip = pip;
    this.intervalMs = pip ? ACCENT_SAMPLE_PIP_MS : ACCENT_SAMPLE_MS;
  }

  get inPip(): boolean {
    return this.pip;
  }

  /** Новый кадр: null — видео на паузе или кадра нет. */
  push(rgb: Rgb | null, now = this.now()): void {
    if (!this.enabled) {
      return;
    }
    this.lastFrameAt = now;
    if (!rgb) {
      this.applyFallback();
      return;
    }
    if (
      this.lastAppliedAt !== 0 &&
      now - this.lastAppliedAt < this.intervalMs
    ) {
      return;
    }
    const corrected = correctAccent(rgb);
    if (
      this.current.hex !== FALLBACK_ACCENT.hex &&
      deltaE(corrected.rgb, this.current.rgb) < ACCENT_DEADBAND
    ) {
      this.lastAppliedAt = now;
      return;
    }
    // EMA: тема не «прыгает» между соседними кадрами.
    const blended = blendAccent(this.current, corrected, ACCENT_EMA_ALPHA);
    this.current = blended;
    this.lastAppliedAt = now;
    this.appliedFallback = false;
    this.apply(blended);
  }

  /** Явный фоллбэк: пауза, tainted canvas, выключенный акцент, уход из комнаты. */
  applyFallback(force = false): void {
    if (!force && this.appliedFallback) {
      return;
    }
    this.appliedFallback = true;
    if (this.current.hex === FALLBACK_ACCENT.hex) {
      return;
    }
    this.current = FALLBACK_ACCENT;
    this.apply(FALLBACK_ACCENT);
  }

  /** Периодическая проверка простоя: кадров нет — тема возвращается к мятной. */
  tick(now = this.now()): void {
    if (!this.enabled) {
      return;
    }
    if (this.lastFrameAt > 0 && now - this.lastFrameAt > this.idleMs) {
      this.applyFallback();
    }
  }

  reset(): void {
    this.current = FALLBACK_ACCENT;
    this.lastAppliedAt = 0;
    this.lastFrameAt = 0;
    this.appliedFallback = false;
    this.apply(FALLBACK_ACCENT);
  }
}

function blendAccent(from: AccentColor, to: AccentColor, alpha: number): AccentColor {
  const a = clamp(alpha, 0, 1);
  const lch: Lch = {
    l: from.lch.l + (to.lch.l - from.lch.l) * a,
    c: from.lch.c + (to.lch.c - from.lch.c) * a,
    h: blendHue(from.lch.h, to.lch.h, a),
  };
  const rgb = oklchToRgb(lch);
  return { hex: rgbToHex(rgb), rgb, lch };
}

/** Кратчайшая дуга между оттенками: 350° → 10° не должно идти через 180°. */
function blendHue(from: number, to: number, alpha: number): number {
  let delta = ((to - from + 540) % 360) - 180;
  if (Number.isNaN(delta)) {
    delta = 0;
  }
  return (from + delta * alpha + 360) % 360;
}

/** CSS-переменные темы: одно место, куда пишет контроллер. */
export function accentCssVariables(accent: AccentColor): Record<string, string> {
  const { r, g, b } = accent.rgb;
  return {
    '--hw-accent-rgb': `${r} ${g} ${b}`,
    '--hw-accent': accent.hex,
    '--hw-accent-soft': `rgb(${r} ${g} ${b} / 0.14)`,
    '--hw-accent-deep': `color-mix(in srgb, ${accent.hex} 72%, #000)`,
  };
}

/** Применить акцент к документу (§2.5): `--accent` на `:root`. */
export function applyAccentToDocument(accent: AccentColor): void {
  if (typeof document === 'undefined') {
    return;
  }
  const style = document.documentElement.style;
  for (const [key, value] of Object.entries(accentCssVariables(accent))) {
    style.setProperty(key, value);
  }
}
