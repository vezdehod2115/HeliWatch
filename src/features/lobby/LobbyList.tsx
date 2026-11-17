import { useState, type FormEvent } from 'react';
import { Icon } from '../../app/icons';
import type { LobbyCard, RoomMode } from '../../net/protocol';
import type { LobbyPhase } from '../../net/lobby';

interface LobbyListProps {
  cards: LobbyCard[];
  phase: LobbyPhase;
  error: string | null;
  strategy: string;
  onJoin: (code: string, password: string | null) => void;
  onRefresh: () => void;
}

const MODE_LABELS: Record<RoomMode, string> = {
  site: 'сайт',
  local: 'свой файл',
  stream: 'файл хоста',
};

function statusLine(phase: LobbyPhase, cards: number): string {
  if (phase === 'connecting') {
    return 'Ищем открытые комнаты…';
  }
  if (phase === 'error') {
    return 'Лобби недоступно';
  }
  if (cards === 0) {
    return 'Пока никто не открыл комнату. Создайте свою — код появится у вас.';
  }
  return `Сейчас в лобби ${cards} ${cards === 1 ? 'комната' : cards < 5 ? 'комнаты' : 'комнат'}`;
}

/** Открытые комнаты из лобби: карточки исчезают через 70 с после ухода хоста. */
export function LobbyList({
  cards,
  phase,
  error,
  strategy,
  onJoin,
  onRefresh,
}: LobbyListProps) {
  const [passwordFor, setPasswordFor] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [joinError, setJoinError] = useState<string | null>(null);

  const submitPassword = (event: FormEvent<HTMLFormElement>, code: string) => {
    event.preventDefault();
    const value = password.trim();
    if (value.length < 4) {
      setJoinError('Пароль от 4 символов');
      return;
    }
    setJoinError(null);
    onJoin(code, value);
  };

  return (
    <section className="hw-card" aria-label="Открытые комнаты">
      <div className="hw-card-head">
        <Icon name="users" size={18} />
        <h2>Открытые комнаты</h2>
        <button
          type="button"
          className="hw-linkbtn hw-lobby-refresh"
          onClick={onRefresh}
          disabled={phase === 'connecting'}
        >
          <Icon name="reload" size={14} />
          Обновить
        </button>
      </div>

      <p className={`hw-note${error ? ' hw-lobby-error' : ''}`}>
        {error ?? statusLine(phase, cards.length)}
        {phase === 'open' && strategy ? ` · ${strategy}` : ''}
      </p>

      {cards.length > 0 && (
        <ul className="hw-lobby-list">
          {cards.map((card) => {
            const asking = passwordFor === card.code;
            return (
              <li key={card.code} className="hw-lobby-item">
                <div className="hw-lobby-row">
                  <div className="hw-lobby-main">
                    <strong className="hw-lobby-title" title={card.title}>
                      {card.title}
                    </strong>
                    <div className="hw-lobby-meta">
                      <span className="hw-lobby-code">{card.code}</span>
                      <span className="hw-modechip">{MODE_LABELS[card.mode]}</span>
                      <span className="hw-lobby-count">
                        {card.count}/{card.limit}
                      </span>
                      {card.hasPassword ? (
                        <span className="hw-lobby-badge">
                          <Icon name="lock" size={11} /> пароль
                        </span>
                      ) : null}
                      {card.knock ? (
                        <span className="hw-lobby-badge">
                          <Icon name="door" size={11} /> стук
                        </span>
                      ) : null}
                    </div>
                  </div>
                  <button
                    type="button"
                    className="hw-primary hw-primary--compact"
                    onClick={() => {
                      setPassword('');
                      setJoinError(null);
                      if (card.hasPassword) {
                        setPasswordFor(asking ? null : card.code);
                        return;
                      }
                      onJoin(card.code, null);
                    }}
                  >
                    {asking ? 'Отмена' : 'Войти'}
                  </button>
                </div>

                {asking && (
                  <form
                    className="hw-inlineform hw-lobby-password"
                    onSubmit={(event) => submitPassword(event, card.code)}
                  >
                    <input
                      className={`hw-field${joinError ? ' is-invalid' : ''}`}
                      value={password}
                      onChange={(event) => {
                        setPassword(event.target.value);
                        setJoinError(null);
                      }}
                      type="password"
                      autoComplete="off"
                      placeholder="Пароль комнаты"
                      aria-label={`Пароль комнаты ${card.code}`}
                      autoFocus
                    />
                    <button type="submit" className="hw-ghost">
                      Войти
                    </button>
                  </form>
                )}
                {asking && joinError && <p className="hw-formerror">{joinError}</p>}
              </li>
            );
          })}
        </ul>
      )}

      <p className="hw-note">
        Закрытые комнаты в лобби не попадают: их открывают только по коду.
        Карточка исчезает через 70 секунд после ухода хоста.
      </p>
    </section>
  );
}
