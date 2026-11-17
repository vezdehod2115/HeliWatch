import { useEffect, useState } from 'react';
import { avatarUrl } from '../../db/repo/media';

interface AvatarProps {
  hash: string | null | undefined;
  name: string;
  color?: string;
  size?: number;
}

/**
 * Аватар из файлового кэша с фоллбэком на инициалы. Blob-URL живёт в кэше
 * `db/repo/media.ts`, компонент только просит его по хешу.
 */
export function Avatar({ hash, name, color = '#6ff0c4', size = 40 }: AvatarProps) {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    if (!hash) {
      setUrl(null);
      return () => {
        alive = false;
      };
    }
    void avatarUrl(hash).then((value) => {
      if (alive) {
        setUrl(value);
      }
    });
    return () => {
      alive = false;
    };
  }, [hash]);

  const initials = name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join('');

  return (
    <span
      className={`hw-avatar${url ? ' is-photo' : ''}`}
      style={{
        width: size,
        height: size,
        background: url ? undefined : `color-mix(in srgb, ${color} 22%, transparent)`,
        color: url ? undefined : color,
        fontSize: Math.max(11, Math.round(size * 0.34)),
      }}
      aria-hidden="true"
    >
      {url ? <img src={url} alt="" loading="lazy" /> : initials || '?'}
    </span>
  );
}
