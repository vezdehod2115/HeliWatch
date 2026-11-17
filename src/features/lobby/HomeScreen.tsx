import { useEffect, useRef, useState, type FormEvent } from 'react';
import { BrandMark, Icon } from '../../app/icons';
import {
  listRecentRooms,
  type RecentRoom,
} from '../../db/repo/rooms';
import type { LocalProfile } from '../../db/repo/identity';
import type { Identity } from '../../net/identity';
import { NAME_MAX, NAME_MIN } from '../../db/repo/profile';
import {
  ROOM_LIMIT_MAX,
  ROOM_LIMIT_MIN,
  normalizePassword,
  parseRoomInput,
  type RoomMode,
} from '../../net/protocol';
import { LobbyList } from './LobbyList';
import { useLobby } from './useLobby';
import { DEFAULT_ROOM_LIMIT, type RoomSetup } from './types';

interface HomeScreenProps {
  identity: Identity;
  profile: LocalProfile;
  persisted: boolean;
  initialCode: { code: string; at: number } | null;
  onCreate: (setup: RoomSetup) => void;
  onJoin: (code: string, password: string | null) => void;
  onOpenRecent: (code: string, mode: RoomMode) => void;
  onRename: (name: string) => Promise<boolean>;
  onCodeConsumed?: () => void;
  notify: (text: string) => void;
  /** Разделы этапа 7: друзья, личка, статистика, настройки, профиль. */
  onOpenFriends: () => void;
  onOpenDm: () => void;
  onOpenStats: () => void;
  onOpenSettings: () => void;
  onOpenProfile: () => void;
  friendsCount: number;
  pendingFriends: number;
  unreadDm: number;
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

/** Главный экран: лобби, создание комнаты, вход по коду и недавние комнаты. */
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
  onOpenFriends,
  onOpenDm,
  onOpenStats,
  onOpenSettings,
  onOpenProfile,
  friendsCount,
  pendingFriends,
  unreadDm,
}: HomeScreenProps) {
  const lobby = useLobby();
  const [name, setName] = useState(profile.displayName);
  const [nameBusy, setNameBusy] = useState(false);
  const [joinValue, setJoinValue] = useState('');
  const [joinPassword, setJoinPassword] = useState('');
  const [joinError, setJoinError] = useState<string | null>(null);
  const [mode, setMode] = useState<RoomMode>('site');
  const [title, setTitle] = useState('');
  const [limit, setLimit] = useState(DEFAULT_ROOM_LIMIT);
  const [closed, setClosed] = useState(false);
  const [knock, setKnock] = useState(false);
  const [password, setPassword] = useState('');
  const [createError, setCreateError] = useState<string | null>(null);
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
    const rawPassword = joinPassword.trim();
    const normalized = rawPassword ? normalizePassword(rawPassword) : null;
    if (rawPassword && !normalized) {
      setJoinError('Пароль от 4 до 64 символов');
      return;
    }
    setJoinError(null);
    onJoin(code, normalized);
  };

  const submitCreate = () => {
    const rawPassword = password.trim();
    const normalized = rawPassword ? normalizePassword(rawPassword) : null;
    if (rawPassword && !normalized) {
      setCreateError('Пароль от 4 до 64 символов');
      return;
    }
    setCreateError(null);
    onCreate({
      mode,
      title: title.trim(),
      limit: mode === 'stream' ? 3 : Math.max(ROOM_LIMIT_MIN, Math.min(ROOM_LIMIT_MAX, limit)),
      closed,
      knock,
      password: normalized,
    });
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

        <nav className="hw-navgrid" aria-label="Разделы">
          <button type="button" className="hw-navbtn" onClick={onOpenFriends}>
            <Icon name="users" size={20} />
            <span>
              <strong>Друзья</strong>
              <small>
                {friendsCount > 0 ? `${friendsCount} в друзьях` : 'пригласить по ссылке'}
              </small>
            </span>
            {pendingFriends > 0 ? <span className="hw-unread">{pendingFriends}</span> : null}
          </button>
          <button type="button" className="hw-navbtn" onClick={onOpenDm}>
            <Icon name="chat" size={20} />
            <span>
              <strong>Личные</strong>
              <small>{unreadDm > 0 ? `${unreadDm} новых` : 'отдельно от комнаты'}</small>
            </span>
            {unreadDm > 0 ? <span className="hw-unread">{unreadDm}</span> : null}
          </button>
          <button type="button" className="hw-navbtn" onClick={onOpenStats}>
            <Icon name="history" size={20} />
            <span>
              <strong>Статистика</strong>
              <small>время вместе</small>
            </span>
          </button>
          <button type="button" className="hw-navbtn" onClick={onOpenSettings}>
            <Icon name="settings" size={20} />
            <span>
              <strong>Настройки</strong>
              <small>акцент, TURN, бэкап</small>
            </span>
          </button>
          <button type="button" className="hw-navbtn" onClick={onOpenProfile}>
            <Icon name="users" size={20} />
            <span>
              <strong>Профиль</strong>
              <small>{profile.displayName}</small>
            </span>
          </button>
        </nav>

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

        <LobbyList
          cards={lobby.cards}
          phase={lobby.phase}
          error={lobby.error}
          strategy={lobby.strategy}
          onJoin={(code, cardPassword) => onJoin(code, cardPassword)}
          onRefresh={lobby.refresh}
        />

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
              aria-checked={mode === 'stream'}
              className={`hw-mode${mode === 'stream' ? ' is-active' : ''}`}
              onClick={() => setMode('stream')}
            >
              <strong>Файл с моего телефона</strong>
              <span>Хост выбирает видео и раздаёт его 1–2 зрителям по WebRTC. У зрителей нет файла — только просмотр.</span>
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={mode === 'local'}
              className={`hw-mode${mode === 'local' ? ' is-active' : ''}`}
              onClick={() => setMode('local')}
            >
              <strong>Свой файл у каждого</strong>
              <span>У каждого телефона свой файл. Синхронизируется только таймкод — размеры и кодеки могут отличаться.</span>
            </button>
          </div>

          <div className="hw-create-grid">
            <label className="hw-create-row">
              <span>Название</span>
              <input
                className="hw-field"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                maxLength={48}
                placeholder={`Комната ${mode === 'site' ? 'по коду' : mode === 'stream' ? 'с раздачей' : 'с файлом'}`}
              />
            </label>
            <label className="hw-create-row">
              <span>Участников</span>
              <select
                className="hw-field"
                value={mode === 'stream' ? 3 : limit}
                onChange={(event) => setLimit(Number(event.target.value))}
                disabled={mode === 'stream'}
                aria-label="Максимум участников"
              >
                {[2, 3, 4, 5, 6].map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </label>
            <label className="hw-create-row">
              <span>Пароль</span>
              <input
                className="hw-field"
                value={password}
                onChange={(event) => {
                  setPassword(event.target.value);
                  setCreateError(null);
                }}
                type="password"
                autoComplete="off"
                maxLength={64}
                placeholder="без пароля"
              />
            </label>
          </div>

          <div className="hw-toggles">
            <button
              type="button"
              className={`hw-toggle${closed ? ' is-on' : ''}`}
              aria-pressed={closed}
              onClick={() => setClosed((value) => !value)}
            >
              <Icon name="lock" size={15} />
              <span>
                <strong>Закрытая</strong>
                <small>не публикуется в лобби, вход только по коду</small>
              </span>
            </button>
            <button
              type="button"
              className={`hw-toggle${knock ? ' is-on' : ''}`}
              aria-pressed={knock}
              onClick={() => setKnock((value) => !value)}
            >
              <Icon name="door" size={15} />
              <span>
                <strong>Стучаться</strong>
                <small>новых пускаем только после подтверждения</small>
              </span>
            </button>
          </div>

          {createError && <p className="hw-formerror">{createError}</p>}
          {!closed && (
            <p className="hw-note">
              Открытая комната попадает в список лобби. Карточка исчезает при
              заполнении, закрытии или через 70 секунд после ухода хоста.
            </p>
          )}
          {password.trim() && (
            <p className="hw-note">
              Пароль — ключ сигналинга: комната живёт в отдельном канале,
              производном от кода и пароля, поэтому без пароля вас не найдут даже
              зная код. Хост дополнительно проверяет хеш пароля при входе.
            </p>
          )}
          {mode === 'stream' ? (
            <p className="hw-note">
              Раздача идёт напрямую с вашего телефона: канал мобильного хоста
              ограничивает комнату двумя зрителями, а нагрев и расход батареи
              выше. MKV может не воспроизводиться — приоритет у MP4 и WebM.
            </p>
          ) : null}
          <button type="button" className="hw-primary" onClick={submitCreate}>
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
          <form className="hw-inlineform" onSubmit={submitJoin}>
            <input
              className="hw-field"
              value={joinPassword}
              onChange={(event) => {
                setJoinPassword(event.target.value);
                setJoinError(null);
              }}
              type="password"
              autoComplete="off"
              maxLength={64}
              placeholder="Пароль, если комната закрыта"
              aria-label="Пароль комнаты (если есть)"
            />
          </form>
          {joinError && <p className="hw-formerror">{joinError}</p>}
          <p className="hw-note">
            Ссылка <code>heliwatch://r/&lt;код&gt;</code> открывает приложение сразу
            на этой комнате. Код чувствителен к регистру только на вид — мы
            приводим его к верхнему. У комнаты с паролем код без пароля не
            соединит: сигналинг у неё в другом канале.
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
                      {room.mode === 'site'
                        ? 'сайт'
                        : room.mode === 'stream'
                          ? 'раздача'
                          : 'файл'}
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
            идут напрямую. Лобби, пароли, стук и модерация уже в этой сборке.
          </span>
        </footer>
      </div>
    </div>
  );
}
