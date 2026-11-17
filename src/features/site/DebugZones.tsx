import type { RegionPayload } from '../../native/regions';
import type { TapTarget } from './types';

interface DebugZonesProps {
  payload: RegionPayload | null;
  tap: { target: TapTarget; x: number; y: number } | null;
  onClose: () => void;
}

/**
 * Экран «Отладка → зоны касания»: рисует прямоугольники, отправленные в Kotlin.
 * Кликабельна только кнопка «Закрыть»: остальные касания гасятся (blocking).
 */
export function DebugZones({ payload, tap, onClose }: DebugZonesProps) {
  return (
    <div
      className="hw-zones"
      role="dialog"
      aria-modal="true"
      aria-label="Зоны касания"
      data-hw-block
    >
      {payload?.regions.map((region) => (
        <div
          key={region.id}
          className="hw-zone-box"
          style={{
            left: `${region.x}px`,
            top: `${region.y}px`,
            width: `${region.w}px`,
            height: `${region.h}px`,
          }}
        >
          {region.id} · {Math.round(region.w)}×{Math.round(region.h)}
        </div>
      ))}

      <div className="hw-zones-head">
        <strong>Зоны касания</strong>
        <span className="hw-zones-meta">
          {payload
            ? `${payload.regions.length} шт · dpr ${payload.dpr.toFixed(2)}`
            : 'нет данных'}
          {tap ? ` · тап: ${tap.target}` : ''}
        </span>
        <button
          type="button"
          className="hw-zone-close"
          data-hw-region="zones-close"
          onClick={onClose}
        >
          Закрыть
        </button>
      </div>
    </div>
  );
}
