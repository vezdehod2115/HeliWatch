import type { VideoWindowRect } from './VideoWindow';

interface RoomBackdropProps {
  /** Прямоугольник видео-окна: всё остальное закрывается зелёным фоном. */
  hole: VideoWindowRect | null;
}

/**
 * Непрозрачный фон комнаты (этап 8.2).
 *
 * Сайт живёт в нативном WebView под прозрачным React-слоем, и раньше его
 * содержимое просвечивало в щелях между панелями (например, внизу под
 * свёрнутым плеером). Теперь весь экран закрыт зелёным фоном, а прозрачным
 * остаётся только прямоугольник видео-окна — и то лишь когда на странице
 * реально найдено видео. Четыре панели вместо `clip-path` — так проще и
 * надёжнее в старых WebView.
 */
export function RoomBackdrop({ hole }: RoomBackdropProps) {
  if (!hole) {
    return <div className="hw-room-backdrop is-full" data-hw-block aria-hidden="true" />;
  }
  const top = Math.max(0, Math.round(hole.y));
  const left = Math.max(0, Math.round(hole.x));
  const width = Math.max(0, Math.round(hole.w));
  const height = Math.max(0, Math.round(hole.h));
  return (
    <>
      <div
        className="hw-room-backdrop"
        data-hw-block
        aria-hidden="true"
        style={{ left: 0, right: 0, top: 0, height: top }}
      />
      <div
        className="hw-room-backdrop"
        data-hw-block
        aria-hidden="true"
        style={{ left: 0, right: 0, top: top + height, bottom: 0 }}
      />
      <div
        className="hw-room-backdrop"
        data-hw-block
        aria-hidden="true"
        style={{ left: 0, top, width: left, height }}
      />
      <div
        className="hw-room-backdrop"
        data-hw-block
        aria-hidden="true"
        style={{ left: left + width, right: 0, top, height }}
      />
    </>
  );
}
