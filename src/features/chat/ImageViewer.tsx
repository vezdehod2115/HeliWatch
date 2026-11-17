import { useEffect, useRef, type TouchEvent } from 'react';
import { Icon } from '../../app/icons';

interface ImageViewerProps {
  url: string;
  onClose: () => void;
}

/**
 * Полноэкранный просмотр фото из чата: тап-регион `imageviewer` перекрывает всё,
 * вертикальный свайп вниз или крестик закрывают.
 */
export function ImageViewer({ url, onClose }: ImageViewerProps) {
  const startY = useRef<number | null>(null);
  const offset = useRef(0);
  const imageRef = useRef<HTMLImageElement>(null);

  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const onTouchStart = (event: TouchEvent<HTMLDivElement>): void => {
    startY.current = event.touches[0]?.clientY ?? null;
    offset.current = 0;
  };

  const onTouchMove = (event: TouchEvent<HTMLDivElement>): void => {
    if (startY.current === null) {
      return;
    }
    const delta = (event.touches[0]?.clientY ?? startY.current) - startY.current;
    offset.current = Math.max(0, delta);
    const image = imageRef.current;
    if (image) {
      image.style.transform = `translateY(${Math.min(160, offset.current)}px) scale(${
        1 - Math.min(0.18, offset.current / 1600)
      })`;
    }
  };

  const onTouchEnd = (): void => {
    startY.current = null;
    if (offset.current > 90) {
      onClose();
      return;
    }
    const image = imageRef.current;
    if (image) {
      image.style.transform = '';
    }
  };

  return (
    <div
      className="hw-imageviewer"
      data-hw-region="imageviewer"
      data-hw-block
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      role="dialog"
      aria-label="Фото из чата"
    >
      <button
        type="button"
        className="hw-imageviewer-close"
        onClick={onClose}
        aria-label="Закрыть фото"
      >
        <Icon name="close" size={20} />
      </button>
      <img ref={imageRef} src={url} alt="Фото из чата" draggable={false} />
      <span className="hw-imageviewer-hint">Свайп вниз — закрыть</span>
    </div>
  );
}
