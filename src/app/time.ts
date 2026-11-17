/** Человекочитаемое время и длительность для друзей и статистики. */

export function relativeTime(timestamp: number, now = Date.now()): string {
  if (!timestamp) {
    return 'ещё не встречались';
  }
  const minutes = Math.max(0, Math.round((now - timestamp) / 60_000));
  if (minutes < 1) {
    return 'только что';
  }
  if (minutes < 60) {
    return `${minutes} мин назад`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return `${hours} ч назад`;
  }
  const days = Math.round(hours / 24);
  if (days < 30) {
    return `${days} дн назад`;
  }
  return new Date(timestamp).toLocaleDateString('ru-RU', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (hours > 0) {
    return `${hours} ч ${minutes} мин`;
  }
  if (minutes > 0) {
    return `${minutes} мин`;
  }
  return `${total} с`;
}

export function formatClock(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString('ru-RU', {
    hour: '2-digit',
    minute: '2-digit',
  });
}
