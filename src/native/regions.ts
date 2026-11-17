import { sendTapRegions } from './siteBridge';

export interface TapRegion {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface RegionPayload {
  v: 1;
  dpr: number;
  blocking: boolean;
  regions: TapRegion[];
}

const MAX_REGIONS = 12;
const DEBOUNCE_MS = 80;
const HEARTBEAT_MS = 1000;

function isVisible(element: HTMLElement, rect: DOMRect): boolean {
  if (rect.width < 2 || rect.height < 2) {
    return false;
  }
  const style = window.getComputedStyle(element);
  if (style.visibility === 'hidden' || style.display === 'none') {
    return false;
  }
  if (Number.parseFloat(style.opacity || '1') < 0.05) {
    return false;
  }
  // checkVisibility есть в свежих WebView; для старых достаточно проверок выше.
  if (typeof element.checkVisibility === 'function') {
    return element.checkVisibility({ checkOpacity: false, checkVisibilityCSS: true });
  }
  return true;
}

/** Прямоугольники интерактивных слоёв React в CSS-пикселях. */
export function collectTapRegions(): TapRegion[] {
  const nodes = Array.from(
    document.querySelectorAll<HTMLElement>('[data-hw-region]'),
  );
  const regions: TapRegion[] = [];
  for (const element of nodes) {
    const rect = element.getBoundingClientRect();
    if (!isVisible(element, rect)) {
      continue;
    }
    regions.push({
      id: element.dataset.hwRegion ?? 'region',
      x: Math.round(rect.left * 100) / 100,
      y: Math.round(rect.top * 100) / 100,
      w: Math.round(rect.width * 100) / 100,
      h: Math.round(rect.height * 100) / 100,
    });
  }
  // Большие области важнее мелких: при лимите отбрасываем хвост.
  regions.sort((a, b) => b.w * b.h - a.w * a.h);
  return regions.slice(0, MAX_REGIONS);
}

export function snapshotRegions(blocking: boolean): RegionPayload {
  return {
    v: 1,
    // CSS px → физические px в Kotlin делаем именно этим коэффициентом.
    dpr: window.devicePixelRatio || 1,
    blocking,
    regions: collectTapRegions(),
  };
}

/**
 * Следит за раскладкой оверлея и отправляет зоны в Kotlin:
 * ResizeObserver + ориентация + клавиатура + transitionend, дебаунс 80 мс,
 * плюс медленный heartbeat — страховка от пропущенных изменений.
 */
export function startRegionSync(
  getBlocking: () => boolean,
  onPayload?: (payload: RegionPayload) => void,
): () => void {
  let stopped = false;
  let timer: number | null = null;
  let lastSentAt = 0;

  const send = (): void => {
    if (stopped) {
      return;
    }
    timer = null;
    const payload = snapshotRegions(getBlocking());
    lastSentAt = performance.now();
    onPayload?.(payload);
    void sendTapRegions(payload);
  };

  const schedule = (): void => {
    if (stopped || timer !== null) {
      return;
    }
    const wait = Math.max(DEBOUNCE_MS - (performance.now() - lastSentAt), 0);
    timer = window.setTimeout(send, wait);
  };

  const resizeObserver =
    typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(() => schedule());

  resizeObserver?.observe(document.documentElement);
  if (document.body) {
    resizeObserver?.observe(document.body);
  }
  document.querySelectorAll<HTMLElement>('[data-hw-region]').forEach((element) => {
    resizeObserver?.observe(element);
  });

  window.addEventListener('resize', schedule);
  window.addEventListener('orientationchange', schedule);
  window.visualViewport?.addEventListener('resize', schedule);
  window.visualViewport?.addEventListener('scroll', schedule);
  document.addEventListener('focusin', schedule, true);
  document.addEventListener('focusout', schedule, true);
  document.addEventListener('transitionend', schedule, true);
  void document.fonts?.ready.then(schedule);

  const heartbeat = window.setInterval(send, HEARTBEAT_MS);
  schedule();

  return () => {
    stopped = true;
    if (timer !== null) {
      window.clearTimeout(timer);
    }
    window.clearInterval(heartbeat);
    resizeObserver?.disconnect();
    window.removeEventListener('resize', schedule);
    window.removeEventListener('orientationchange', schedule);
    window.visualViewport?.removeEventListener('resize', schedule);
    window.visualViewport?.removeEventListener('scroll', schedule);
    document.removeEventListener('focusin', schedule, true);
    document.removeEventListener('focusout', schedule, true);
    document.removeEventListener('transitionend', schedule, true);
  };
}
