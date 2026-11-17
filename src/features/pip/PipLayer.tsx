import { useEffect, useState } from 'react';
import { Icon } from '../../app/icons';
import { formatPipUptime } from './pipState';

interface PipLayerProps {
  /** Одна строка: последнее сообщение или подпись пустого чата. */
  message: string;
  micOn: boolean;
  /** Время в комнате — счётчик заодно доказывает, что таймеры WebView живы. */
  startedAt: number;
}

/**
 * Компактный слой PiP: видео остаётся (сайт — нативный WebView, файл — React),
 * поверх снизу только строка сообщения, состояние микрофона и время в комнате.
 *
 * Панели, чат и адресная строка в PiP не рендерятся: касания там всё равно
 * гасит контейнер, а окно должно показывать видео.
 */
export function PipLayer({ message, micOn, startedAt }: PipLayerProps) {
  const [uptime, setUptime] = useState(() => Date.now() - startedAt);

  useEffect(() => {
    const tick = () => setUptime(Date.now() - startedAt);
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [startedAt]);

  return (
    <div className="hw-pipline" data-hw-region="pip-line" aria-hidden="true">
      <span className={`hw-pipline-mic${micOn ? ' is-on' : ''}`}>
        <Icon name={micOn ? 'mic' : 'mic-off'} size={14} />
      </span>
      <span className="hw-pipline-text">{message}</span>
      <span className="hw-pipline-time">{formatPipUptime(uptime)}</span>
    </div>
  );
}
