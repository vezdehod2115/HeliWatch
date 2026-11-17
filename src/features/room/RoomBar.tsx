import { useState } from 'react';
import { Icon } from '../../app/icons';
import type { MemberInfo, RoomMode, RoomRole } from '../../net/protocol';
import type { RoomPhase } from '../../net/room';

interface RoomBarProps {
  code: string;
  role: RoomRole;
  mode: RoomMode;
  phase: RoomPhase;
  strategy: string;
  peerCount: number;
  members: MemberInfo[];
  selfUserId: string;
  driverId: string | null;
  seq: number;
  drift: number | null;
  hint: string | null;
  error: string | null;
  zonesOpen: boolean;
  onLeave: () => void;
  onCopy: () => void;
  onResync: () => void;
  onToggleZones: () => void;
  /** Вход в PiP (этап 4): доступен, когда комната открыта. */
  onPip: () => void;
  pipAvailable: boolean;
}

const PHASE_LABELS: Record<RoomPhase, string> = {
  connecting: 'Подключение',
  waiting: 'Ожидание',
  joined: 'В комнате',
  reconnecting: 'Переподключение',
  closed: 'Закрыта',
  error: 'Ошибка',
};

function shortId(value: string | null): string {
  if (!value) {
    return '—';
  }
  return value.replace(/[^A-Za-z0-9]/g, '').slice(0, 8);
}

/** Компактная шапка комнаты: код, состояние связи, участники и диагностика. */
export function RoomBar({
  code,
  role,
  mode,
  phase,
  strategy,
  peerCount,
  members,
  selfUserId,
  driverId,
  seq,
  drift,
  hint,
  error,
  zonesOpen,
  onLeave,
  onCopy,
  onResync,
  onToggleZones,
  onPip,
  pipAvailable,
}: RoomBarProps) {
  const [debugOpen, setDebugOpen] = useState(false);
  const live = phase === 'joined';
  const driver = driverId === selfUserId ? 'вы' : shortId(driverId);

  return (
    <header className="hw-roombar" data-hw-region="roombar">
      <div className="hw-roombar-main">
        <button
          type="button"
          className="hw-iconbtn"
          onClick={onLeave}
          aria-label="Выйти из комнаты"
          title="Выйти"
        >
          <Icon name="back" size={20} />
        </button>
        <button
          type="button"
          className="hw-roomcode"
          onClick={onCopy}
          title="Скопировать ссылку на комнату"
        >
          <span className="hw-roomcode-label">КОД</span>
          <strong>{code}</strong>
          <Icon name="copy" size={14} />
        </button>
        <span className={`hw-dot${live ? ' is-live' : phase === 'error' ? ' is-busy' : ''}`} />
        <span className="hw-roomphase">
          {PHASE_LABELS[phase]}
          {live && peerCount > 1 ? ` · ${peerCount}` : ''}
        </span>
        <button
          type="button"
          className="hw-iconbtn"
          onClick={onResync}
          aria-label="Запросить состояние у ведущего"
          title="Догнать ведущего"
          disabled={!live}
        >
          <Icon name="sync" size={18} />
        </button>
        <button
          type="button"
          className="hw-iconbtn"
          onClick={onPip}
          aria-label="Смотреть в маленьком окне"
          title="PiP"
          disabled={!pipAvailable || !live}
        >
          <Icon name="pip" size={18} />
        </button>
        <button
          type="button"
          className={`hw-iconbtn${zonesOpen ? ' is-active' : ''}`}
          onClick={onToggleZones}
          aria-pressed={zonesOpen}
          aria-label="Показать зоны касания"
          title="Зоны касания"
        >
          <Icon name="bug" size={18} />
        </button>
      </div>

      <div className="hw-roombar-meta">
        <span className="hw-modechip">{mode === 'site' ? 'сайт' : 'локальный файл'}</span>
        <span className="hw-strategychip">
          {strategy || '…'}
          {live && peerCount === 0 ? ' · ждём второго' : ''}
        </span>
        <div className="hw-members">
          {members.map((member) => (
            <span
              key={member.userId}
              className="hw-member"
              style={{ borderColor: member.color }}
              title={`${member.name}${member.host ? ' · хост' : ''}`}
            >
              <span className="hw-member-dot" style={{ background: member.color }} />
              {member.name}
              {member.host ? <span className="hw-member-host">хост</span> : null}
              {member.userId === driverId ? <span className="hw-member-driver">ведёт</span> : null}
            </span>
          ))}
        </div>
        <button
          type="button"
          className="hw-linkbtn"
          onClick={() => setDebugOpen((value) => !value)}
          aria-expanded={debugOpen}
        >
          {debugOpen ? 'Скрыть' : 'Диагностика'}
        </button>
      </div>

      {(hint || error) && (
        <div className={`hw-roomhint${error ? ' is-error' : ''}`} role="status">
          {error ?? hint}
        </div>
      )}

      {debugOpen && (
        <div className="hw-roomdebug">
          <span>вы {shortId(selfUserId)}</span>
          <span>ведёт {driver}</span>
          <span>seq {seq}</span>
          <span>drift {drift === null ? '—' : `${drift.toFixed(2)} с`}</span>
          <span>участников {members.length}</span>
          <span>{role === 'host' ? 'хост' : 'гость'}</span>
        </div>
      )}
    </header>
  );
}
