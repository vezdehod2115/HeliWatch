/*
 * Статистика (этап 7): сколько времени вместе, с кем и в каких режимах.
 *
 * Сессии переживают краш: каждая пишет heartbeat, а «зависшие» строки при
 * старте закрываются временем последнего heartbeat. Поэтому цифры здесь — это
 * то, что реально успело попасть в SQLite, а не оценка «на глаз».
 */

import { useEffect } from 'react';
import { PageHeader } from '../../app/PageHeader';
import { Icon } from '../../app/icons';
import { formatDuration, relativeTime } from '../../app/time';
import { useStatsStore } from '../../stores/stats';
import { useFriendsStore } from '../../stores/friends';
import { Avatar } from '../profile/Avatar';

interface StatsScreenProps {
  onBack: () => void;
  notify: (text: string) => void;
}

const MODE_LABEL: Record<string, string> = {
  site: 'Сайт',
  stream: 'Файл хоста',
  local: 'Свой файл',
};

const REASON_LABEL: Record<string, string> = {
  left: 'вышли',
  'host-left': 'хост ушёл',
  timeout: 'обрыв',
  kick: 'исключён',
  banned: 'бан',
  closed: 'комната закрыта',
  error: 'ошибка',
};

export function StatsScreen({ onBack, notify }: StatsScreenProps) {
  const { status, summary, peers, sessions, error, load } = useStatsStore();
  const friends = useFriendsStore((state) => state.friends);

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (error) {
      notify(error);
    }
  }, [error, notify]);

  const friendOf = (userId: string) => friends.find((item) => item.userId === userId);

  return (
    <div className="hw-screen" data-hw-region="stats">
      <PageHeader
        title="Статистика"
        subtitle="Время вместе, по друзьям и сессиям"
        onBack={onBack}
        right={
          <button
            type="button"
            className="hw-iconbtn"
            onClick={() => void load()}
            aria-label="Обновить"
          >
            <Icon name="reload" size={20} />
          </button>
        }
      />
      <div className="hw-screen-scroll">
        <section className="hw-statgrid">
          <div className="hw-stat">
            <span>Всего вместе</span>
            <b>{formatDuration(summary.secondsTotal)}</b>
          </div>
          <div className="hw-stat">
            <span>Сессий</span>
            <b>{summary.sessions}</b>
          </div>
          <div className="hw-stat">
            <span>Просмотр</span>
            <b>{formatDuration(summary.secondsWatch)}</b>
          </div>
          <div className="hw-stat">
            <span>С голосом</span>
            <b>{formatDuration(summary.secondsVoice)}</b>
          </div>
        </section>

        <section className="hw-card">
          <div className="hw-card-head">
            <Icon name="users" size={18} />
            <h2>По друзьям</h2>
          </div>
          {peers.length === 0 ? (
            <p className="hw-note">
              Пока нет встреч. Статистика пишется, когда вы в комнате с кем-то:
              каждые 30 секунд время собеседника попадает в SQLite. Если приложение
              упало, при следующем старте сессия закроется временем последнего
              heartbeat — данные не потеряются.
            </p>
          ) : (
            <ul className="hw-friendlist">
              {peers.map((peer) => {
                const friend = friendOf(peer.peerUserId);
                return (
                  <li key={peer.peerUserId} className="hw-friendrow">
                    <Avatar
                      hash={friend?.avatarHash ?? null}
                      name={friend?.displayName ?? 'Друг'}
                      color={friend?.nameColor ?? '#6ff0c4'}
                      size={36}
                    />
                    <div className="hw-friend-main">
                      <strong style={{ color: friend?.nameColor ?? '#e9fffa' }}>
                        {friend?.displayName ?? 'Друг'}
                      </strong>
                      <span>
                        {peer.sessions} сессий · {formatDuration(peer.secondsWatch)} просмотра
                        · {formatDuration(peer.secondsVoice)} с голосом
                      </span>
                    </div>
                    <span className="hw-statvalue">{formatDuration(peer.secondsTotal)}</span>
                    <span className="hw-statwhen">{relativeTime(peer.lastMeetAt)}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section className="hw-card">
          <div className="hw-card-head">
            <Icon name="history" size={18} />
            <h2>Последние сессии</h2>
          </div>
          {sessions.length === 0 ? (
            <p className="hw-note">Здесь появятся комнаты, в которых вы были.</p>
          ) : (
            <ul className="hw-sessionlist">
              {sessions.map((session) => {
                const duration = Math.max(
                  0,
                  Math.round(((session.endedAt ?? session.lastHeartbeat) - session.startedAt) / 1000),
                );
                return (
                  <li key={session.id} className="hw-sessionrow">
                    <span className="hw-sessioncode">{session.roomCode}</span>
                    <span className="hw-sessionmode">{MODE_LABEL[session.mode] ?? session.mode}</span>
                    <span className="hw-sessionduration">{formatDuration(duration)}</span>
                    <span className="hw-sessionwhen">{relativeTime(session.startedAt)}</span>
                    <span
                      className={`hw-sessionend${session.endReason === 'timeout' || session.endReason === 'error' ? ' is-warn' : ''}`}
                    >
                      {session.endReason ? REASON_LABEL[session.endReason] ?? session.endReason : 'идёт'}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
          {status === 'loading' ? <p className="hw-note">Читаем статистику…</p> : null}
        </section>
      </div>
    </div>
  );
}
