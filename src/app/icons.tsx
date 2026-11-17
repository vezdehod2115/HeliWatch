export type IconName =
  | 'back'
  | 'forward'
  | 'reload'
  | 'play'
  | 'pause'
  | 'bug'
  | 'chevron-down'
  | 'chevron-up'
  | 'video'
  | 'link'
  | 'users'
  | 'sync'
  | 'copy'
  | 'close'
  | 'mic'
  | 'mic-off'
  | 'chat'
  | 'emoji'
  | 'send'
  | 'photo'
  | 'history'
  | 'broadcast'
  | 'pip'
  | 'lock'
  | 'door'
  | 'crown'
  | 'settings';

interface IconProps {
  name: IconName;
  size?: number;
}

/** Небольшие line-иконки в стиле темы; без внешних библиотек. */
export function Icon({ name, size = 20 }: IconProps) {
  const common = {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
    focusable: false,
  };

  switch (name) {
    case 'back':
      return (
        <svg {...common}>
          <path d="M15 5 8 12l7 7" />
        </svg>
      );
    case 'forward':
      return (
        <svg {...common}>
          <path d="m9 5 7 7-7 7" />
        </svg>
      );
    case 'reload':
      return (
        <svg {...common}>
          <path d="M20 12a8 8 0 1 1-2.34-5.66" />
          <path d="M20 4v4h-4" />
        </svg>
      );
    case 'play':
      return (
        <svg {...common} fill="currentColor" stroke="none">
          <path d="M8.2 4.6 19 12 8.2 19.4Z" />
        </svg>
      );
    case 'pause':
      return (
        <svg {...common} strokeWidth={2.6}>
          <path d="M9 5v14" />
          <path d="M15 5v14" />
        </svg>
      );
    case 'bug':
      return (
        <svg {...common}>
          <rect x="8" y="8" width="8" height="11" rx="4" />
          <path d="M12 8V5M8.5 11H4M16 11h4.5M8.5 15H4.5M15.5 15h4M9 19l-2 2M15 19l2 2" />
        </svg>
      );
    case 'chevron-down':
      return (
        <svg {...common}>
          <path d="m6 9 6 6 6-6" />
        </svg>
      );
    case 'chevron-up':
      return (
        <svg {...common}>
          <path d="m6 15 6-6 6 6" />
        </svg>
      );
    case 'video':
      return (
        <svg {...common}>
          <rect x="3" y="6" width="13" height="12" rx="2.5" />
          <path d="m16 10 5-2.6v9.2L16 14Z" />
        </svg>
      );
    case 'link':
      return (
        <svg {...common}>
          <path d="M10 14a4 4 0 0 0 5.66 0l2.5-2.5a4 4 0 0 0-5.66-5.66l-1.4 1.4" />
          <path d="M14 10a4 4 0 0 0-5.66 0L5.84 12.5a4 4 0 0 0 5.66 5.66l1.4-1.4" />
        </svg>
      );
    case 'users':
      return (
        <svg {...common}>
          <circle cx="9" cy="8" r="3.2" />
          <path d="M3.5 19a5.5 5.5 0 0 1 11 0" />
          <path d="M16 5.6a3 3 0 0 1 0 5.8M17.5 19a5.4 5.4 0 0 0-2.2-4.3" />
        </svg>
      );
    case 'sync':
      return (
        <svg {...common}>
          <path d="M20 7v5h-5" />
          <path d="M4 17v-5h5" />
          <path d="M6.1 9a7 7 0 0 1 11.4-2L20 9M4 15l2.5 2a7 7 0 0 0 11.4-2" />
        </svg>
      );
    case 'copy':
      return (
        <svg {...common}>
          <rect x="9" y="9" width="11" height="11" rx="2.5" />
          <path d="M15 9V6.5A2.5 2.5 0 0 0 12.5 4h-6A2.5 2.5 0 0 0 4 6.5v6A2.5 2.5 0 0 0 6.5 15H9" />
        </svg>
      );
    case 'close':
      return (
        <svg {...common}>
          <path d="m6 6 12 12M18 6 6 18" />
        </svg>
      );
    case 'mic':
      return (
        <svg {...common}>
          <rect x="9" y="3" width="6" height="11" rx="3" />
          <path d="M5.5 11a6.5 6.5 0 0 0 13 0" />
          <path d="M12 17.5V21M9 21h6" />
        </svg>
      );
    case 'mic-off':
      return (
        <svg {...common}>
          <rect x="9" y="3" width="6" height="11" rx="3" />
          <path d="M5.5 11a6.5 6.5 0 0 0 10.2 5.3M18.5 11a6.5 6.5 0 0 1-.4 2.2" />
          <path d="M12 17.5V21M9 21h6" />
          <path d="m4 4 16 16" />
        </svg>
      );
    case 'chat':
      return (
        <svg {...common}>
          <path d="M20 15a3 3 0 0 1-3 3H9l-5 3V6a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3Z" />
          <path d="M8 9h8M8 13h5" />
        </svg>
      );
    case 'emoji':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="9" />
          <path d="M8.5 14.5a4.5 4.5 0 0 0 7 0" />
          <path d="M9 9.5h.01M15 9.5h.01" />
        </svg>
      );
    case 'send':
      return (
        <svg {...common}>
          <path d="M4 12 20 4l-7 16-2.5-6.5Z" />
          <path d="m10.5 13.5 3.5-3.5" />
        </svg>
      );
    case 'photo':
      return (
        <svg {...common}>
          <rect x="3" y="5" width="18" height="14" rx="3" />
          <circle cx="9" cy="10.5" r="1.6" />
          <path d="m4.5 17 4.2-4a2 2 0 0 1 2.7 0l2.4 2.3 1.9-1.8a2 2 0 0 1 2.7 0l1.1 1" />
        </svg>
      );
    case 'history':
      return (
        <svg {...common}>
          <path d="M4 12a8 8 0 1 0 2.3-5.6" />
          <path d="M4 5v4h4" />
          <path d="M12 8v4.5l3 1.8" />
        </svg>
      );
    case 'broadcast':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="2.4" fill="currentColor" stroke="none" />
          <path d="M7.8 7.8a6 6 0 0 0 0 8.4M16.2 7.8a6 6 0 0 1 0 8.4" />
          <path d="M4.9 4.9a10 10 0 0 0 0 14.2M19.1 4.9a10 10 0 0 1 0 14.2" />
        </svg>
      );
    case 'pip':
      return (
        <svg {...common}>
          <rect x="3" y="5" width="18" height="14" rx="2.6" />
          <rect x="12" y="11" width="7" height="6" rx="1.2" fill="currentColor" stroke="none" />
        </svg>
      );
    case 'lock':
      return (
        <svg {...common}>
          <rect x="4.5" y="10" width="15" height="10" rx="2.6" />
          <path d="M8 10V7.5a4 4 0 0 1 8 0V10" />
          <path d="M12 14v2.5" />
        </svg>
      );
    case 'door':
      return (
        <svg {...common}>
          <path d="M4 20h16" />
          <path d="M6 20V5.5A1.5 1.5 0 0 1 7.5 4h9A1.5 1.5 0 0 1 18 5.5V20" />
          <circle cx="14.6" cy="12.4" r="1" fill="currentColor" stroke="none" />
        </svg>
      );
    case 'crown':
      return (
        <svg {...common}>
          <path d="M4 17h16l-1.4-9-4.1 3.4L12 6l-2.5 5.4L5.4 8 4 17Z" />
          <path d="M5 20h14" />
        </svg>
      );
    case 'settings':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="3.2" />
          <path d="M12 3.5v2M12 18.5v2M3.5 12h2M18.5 12h2M6 6l1.4 1.4M16.6 16.6 18 18M18 6l-1.4 1.4M7.4 16.6 6 18" />
        </svg>
      );
    default:
      return null;
  }
}

/** Логотип-знак (H-плеер) для React-панели. */
export function BrandMark({ size = 28 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 512 512"
      aria-hidden
      focusable={false}
      className="hw-brand-mark"
    >
      <rect width="512" height="512" rx="116" fill="#06201d" />
      <rect x="104" y="142" width="66" height="228" rx="33" fill="#6ff0c4" />
      <rect x="342" y="142" width="66" height="228" rx="33" fill="#6ff0c4" />
      <path d="M214 184v144l122-72Z" fill="#6ff0c4" />
    </svg>
  );
}
