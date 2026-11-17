import { useEffect, useRef, useState, type FormEvent } from 'react';
import { BrandMark, Icon } from '../../app/icons';
import {
  listRecentRooms,
  type RecentRoom,
} from '../../db/repo/rooms';
import type { LocalProfile } from '../../db/repo/identity';
import type { Identity } from '../../net/identity';
import { NAME_MAX, NAME_MIN } from '../../db/repo/profile';
import { parseRoomInput, type RoomMode } from '../../net/protocol';

interface HomeScreenProps {
  identity: Identity;
  profile: LocalProfile;
  persisted: boolean;
  initialCode: { code: string; at: number } | null;
  onCreate: (mode: RoomMode) => void;
  onJoin: (code: string) => void;
  onOpenRecent: (code: string, mode: RoomMode) => void;
  onRename: (name: string) => Promise<boolean>;
  onCodeConsumed?: () => void;
  notify: (text: string) => void;
}

function relativeTime(timestamp: number): string {
  const minutes = Math.max(0, Math.round((Date.now() - timestamp) / 60000));
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
  return `${Math.round(hours / 24)} дн назад`;
}

/** Главный экран: профиль, создание комнаты, вход по коду и недавние комнаты. */
export function HomeScreen({
  identity,
  profile,
  persisted,
  initialCode,
  onCreate,
  onJoin,
  onOpenRecent,
  onRename,
  onCodeConsumed,
  notify,
}: HomeScreenProps) {
  const [name, setName] = useState(profile.displayName);
  const [nameBusy, setNameBusy] = useState(false);
  const [joinValue, setJoinValue] = useState('');
  const [joinError, setJoinError] = useState<string | null>(null);
  const [mode, setMode] = useState<RoomMode>('site');
  const [recent, setRecent] = useState<RecentRoom[]>([]);
  const joinRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setName(profile.displayName);
  }, [profile.displayName]);

  useEffect(() => {
    let alive = true;
    void listRecentRooms(5).then((rows) => {
      if (alive) {
        setRecent(rows);
      }
    });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!initialCode) {
      return;
    }
    setJoinValue(initialCode.code);
    setJoinError(null);
    joinRef.current?.focus();
    onCodeConsumed?.();
  }, [initialCode, onCodeConsumed]);

  const saveName = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setNameBusy(true);
    const ok = await onRename(name);
    setNameBusy(false);
    if (ok) {
      notify('Имя сохранено');
    } else {
      notify(`Имя должно быть от ${NAME_MIN} до ${NAME_MAX} символов`);
    }
  };

  const submitJoin = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const code = parseRoomInput(joinValue);
    if (!code) {
      setJoinError('Нужен код из 6 символов или ссылка heliwatch://r/<код>');
      joinRef.current?.focus();
      return;
    }
    setJoinError(null);
    onJoin(code);
  };

  return (
    <div className="hw-home" data-hw-region="home">
      <div className="hw-home-scroll">
        <header className="hw-home-hero">
          <BrandMark size={52} />
          <div>
            <h1>HeliWatch</h1>
            <p>Смотрите вместе — сайт или файл, с синхронизацией и голосом.</p>
          </div>
          <span className="hw-brand-version">{__APP_VERSION__}</span>
        </header>

        <section className="hw-card">
          <div className="hw-card-head">
            <Icon name="users" size={18} />
            <h2>Вы в комнате</h2>
          </div>
          <form className="hw-inlineform" onSubmit={saveName}>
            <input
              className="hw-field"
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={NAME_MAX}
              aria-label="Ваше имя"
              placeholder="Как вас зовут"
            />
            <button type="submit" className="hw-ghost" disabled={nameBusy}>
              Сохранить
            </button>
          </form>
          <div className="hw-idrow">
            <span>
              Отпечаток <b>{identity.fingerprint}</b>
            </span>
            <span className={persisted ? 'hw-storage' : 'hw-storage is-warn'}>
              {persisted ? 'ключ в SQLite' : 'предпросмотр: данные не сохраняются'}
            </span>
          </div>
        </section>

        <section className="hw-card">
          <div className="hw-card-head">
            <Icon name="play" size={18} />
            <h2>Создать комнату</h2>
          </div>
          <div className="hw-modes" role="radiogroup" aria-label="Режим комнаты">
            <button
              type="button"
              role="radio"
              aria-checked={mode === 'site'}
              className={`hw-mode${mode === 'site' ? ' is-active' : ''}`}
              onClick={() => setMode('site')}
            >
              <strong>Сайт или стриминг</strong>
              <span>YouTube, Rutube и другие сайты в нижнем WebView. Синхронизируются play/pause/seek и скорость.</span>
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={mode === 'local'}
              className={`hw-mode${mode === 'local' ? ' is-active' : ''}`}
              onClick={() => setMode('local')}
            >
              <strong>Свой файл</strong>
              <span>У каждого телефона свой файл. Синхронизируется только таймкод — размеры могут отличаться.</span>
            </button>
          </div>
          <button
            type="button"
            className="hw-primary"
            onClick={() => onCreate(mode)}
          >
            Создать комнату и получить код
          </button>
        </section>

        <section className="hw-card">
          <div className="hw-card-head">
            <Icon name="link" size={18} />
            <h2>Войти по коду</h2>
          </div>
          <form className="hw-inlineform" onSubmit={submitJoin}>
            <input
              ref={joinRef}
              className={`hw-field hw-codeinput${joinError ? ' is-invalid' : ''}`}
              value={joinValue}
              onChange={(event) => {
                setJoinValue(event.target.value);
                setJoinError(null);
              }}
              placeholder="ABC234 или heliwatch://r/ABC234"
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
              inputMode="text"
              aria-label="Код или ссылка на комнату"
              aria-invalid={Boolean(joinError)}
            />
            <button type="submit" className="hw-primary hw-primary--compact">
              Войти
            </button>
          </form>
          {joinError && <p className="hw-formerror">{joinError}</p>}
          <p className="hw-note">
            Ссылка <code>heliwatch://r/&lt;код&gt;</code> открывает приложение сразу
            на этой комнате. Код чувствителен к регистру только на вид — мы
            приводим его к верхнему.
          </p>
        </section>

        {recent.length > 0 && (
          <section className="hw-card">
            <div className="hw-card-head">
              <Icon name="reload" size={18} />
              <h2>Недавние комнаты</h2>
            </div>
            <ul className="hw-recent">
              {recent.map((room) => (
                <li key={room.code}>
                  <button
                    type="button"
                    className="hw-recent-row"
                    onClick={() => onOpenRecent(room.code, room.mode)}
                  >
                    <span className="hw-recent-code">{room.code}</span>
                    <span className="hw-recent-mode">
                      {room.mode === 'site' ? 'сайт' : 'файл'}
                    </span>
                    <span className="hw-recent-time">{relativeTime(room.lastJoinAt)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        <footer className="hw-home-footer">
          <span className="hw-dot is-live" />
          <span>
            P2P без своих серверов: сигналинг — публичные релеи, медиа и данные
            идут напрямую. Голос, чат и PiP появятся на следующих этапах.
          </span>
        </footer>
      </div>
    </div>
  );
}
