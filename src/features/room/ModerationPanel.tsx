import { useEffect, useState } from 'react';
import { Icon } from '../../app/icons';
import {
  ROOM_LIMIT_MAX,
  ROOM_LIMIT_MIN,
  type MemberInfo,
  type RoomMetaPayload,
  type RoomMode,
} from '../../net/protocol';

interface ModerationPanelProps {
  open: boolean;
  members: MemberInfo[];
  selfUserId: string;
  hostUserId: string | null;
  canModerate: boolean;
  title: string;
  limit: number;
  closed: boolean;
  knock: boolean;
  mode: RoomMode;
  pendingCount: number;
  onClose: () => void;
  onKick: (userId: string) => void;
  onBan: (userId: string, scope: 'session' | 'forever') => void;
  onMute: (userId: string) => void;
  onTransfer: (userId: string) => void;
  onMeta: (patch: RoomMetaPayload) => void;
  onCloseRoom: () => void;
}

/**
 * Участники и модерация (§4.3, этап 6): у хоста — кик, бан, просьба выключить
 * микрофон, передача хоста и настройки комнаты; у гостя — только состав.
 */
export function ModerationPanel({
  open,
  members,
  selfUserId,
  hostUserId,
  canModerate,
  title,
  limit,
  closed,
  knock,
  mode,
  pendingCount,
  onClose,
  onKick,
  onBan,
  onMute,
  onTransfer,
  onMeta,
  onCloseRoom,
}: ModerationPanelProps) {
  const [banFor, setBanFor] = useState<string | null>(null);
  const [titleDraft, setTitleDraft] = useState(title);

  useEffect(() => {
    if (open) {
      setBanFor(null);
      setTitleDraft(title);
    }
  }, [open, title]);

  if (!open) {
    return null;
  }

  return (
    <div className="hw-modal" role="dialog" aria-modal="true" aria-label="Участники комнаты">
      <div className="hw-modal-card hw-moderation">
        <header className="hw-modal-head">
          <Icon name="users" size={18} />
          <h2>Участники</h2>
          <span className="hw-moderation-count">
            {members.length}/{limit}
          </span>
          <button
            type="button"
            className="hw-iconbtn"
            onClick={onClose}
            aria-label="Закрыть участников"
          >
            <Icon name="close" size={18} />
          </button>
        </header>

        {pendingCount > 0 && (
          <p className="hw-note">
            Ждут подтверждения: {pendingCount}. Карточка «Стучатся» появится
            поверх комнаты.
          </p>
        )}

        <ul className="hw-moderation-list">
          {members.map((member) => {
            const isSelf = member.userId === selfUserId;
            const isHost = member.userId === hostUserId || member.host;
            return (
              <li key={member.userId} className="hw-moderation-row">
                <span className="hw-member-dot" style={{ background: member.color }} />
                <div className="hw-moderation-name">
                  <strong>{member.name}</strong>
                  <span className="hw-moderation-flags">
                    {isHost ? (
                      <span className="hw-metaflag">
                        <Icon name="crown" size={11} /> хост
                      </span>
                    ) : null}
                    {isSelf ? <span className="hw-metaflag">вы</span> : null}
                  </span>
                </div>

                {canModerate && !isSelf ? (
                  <div className="hw-moderation-actions">
                    <button
                      type="button"
                      className="hw-iconbtn"
                      title="Попросить выключить микрофон"
                      aria-label={`Попросить ${member.name} выключить микрофон`}
                      onClick={() => onMute(member.userId)}
                    >
                      <Icon name="mic-off" size={16} />
                    </button>
                    <button
                      type="button"
                      className="hw-iconbtn"
                      title="Передать хост"
                      aria-label={`Передать хост ${member.name}`}
                      onClick={() => onTransfer(member.userId)}
                    >
                      <Icon name="crown" size={16} />
                    </button>
                    <button
                      type="button"
                      className="hw-iconbtn"
                      title="Исключить"
                      aria-label={`Исключить ${member.name}`}
                      onClick={() => onKick(member.userId)}
                    >
                      <Icon name="close" size={16} />
                    </button>
                    <button
                      type="button"
                      className="hw-iconbtn is-danger"
                      title="Забанить"
                      aria-label={`Забанить ${member.name}`}
                      onClick={() => setBanFor(banFor === member.userId ? null : member.userId)}
                    >
                      <Icon name="lock" size={16} />
                    </button>
                  </div>
                ) : null}

                {banFor === member.userId ? (
                  <div className="hw-banrow">
                    <span>Бан:</span>
                    <button
                      type="button"
                      className="hw-ghost"
                      onClick={() => {
                        setBanFor(null);
                        onBan(member.userId, 'session');
                      }}
                    >
                      на сессию
                    </button>
                    <button
                      type="button"
                      className="hw-ghost is-danger"
                      onClick={() => {
                        setBanFor(null);
                        onBan(member.userId, 'forever');
                      }}
                    >
                      навсегда
                    </button>
                    <button
                      type="button"
                      className="hw-ghost"
                      onClick={() => setBanFor(null)}
                    >
                      отмена
                    </button>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>

        {canModerate ? (
          <section className="hw-moderation-settings">
            <h3>
              <Icon name="settings" size={15} /> Настройки комнаты
            </h3>
            <div className="hw-inlineform">
              <input
                className="hw-field"
                value={titleDraft}
                onChange={(event) => setTitleDraft(event.target.value)}
                maxLength={48}
                aria-label="Название комнаты"
                placeholder="Название комнаты"
              />
              <button
                type="button"
                className="hw-ghost"
                onClick={() => onMeta({ title: titleDraft.trim() || title })}
                disabled={!titleDraft.trim() || titleDraft.trim() === title}
              >
                Сохранить
              </button>
            </div>
            <div className="hw-create-row">
              <span>Участников</span>
              <select
                className="hw-field"
                value={limit}
                disabled={mode === 'stream'}
                onChange={(event) => onMeta({ limit: Number(event.target.value) })}
                aria-label="Лимит участников"
              >
                {[ROOM_LIMIT_MIN, 3, 4, 5, ROOM_LIMIT_MAX].map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </div>
            <div className="hw-toggles">
              <button
                type="button"
                className={`hw-toggle${closed ? ' is-on' : ''}`}
                aria-pressed={closed}
                onClick={() => onMeta({ closed: !closed })}
              >
                <Icon name="lock" size={15} />
                <span>
                  <strong>Закрытая</strong>
                  <small>в лобби не показывается</small>
                </span>
              </button>
              <button
                type="button"
                className={`hw-toggle${knock ? ' is-on' : ''}`}
                aria-pressed={knock}
                onClick={() => onMeta({ knock: !knock })}
              >
                <Icon name="door" size={15} />
                <span>
                  <strong>Стучаться</strong>
                  <small>вход с подтверждением</small>
                </span>
              </button>
            </div>
            <button type="button" className="hw-ghost is-danger hw-close-room" onClick={onCloseRoom}>
              Закрыть комнату для всех
            </button>
          </section>
        ) : (
          <p className="hw-note">
            Управлять комнатой может только хост. Он же видит «стук» и решает,
            кого впустить.
          </p>
        )}
      </div>
    </div>
  );
}
