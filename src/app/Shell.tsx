import { useCallback, useEffect, useRef, useState } from 'react';
import { HomeScreen } from '../features/lobby/HomeScreen';
import { type RoomSetup } from '../features/lobby/types';
import { RoomScreen } from '../features/room/RoomScreen';
import { DebugZones } from '../features/site/DebugZones';
import { useSiteController } from '../features/site/useSiteController';
import { FriendsScreen } from '../features/friends/FriendsScreen';
import { DmScreen } from '../features/dm/DmScreen';
import { ProfileScreen } from '../features/profile/ProfileScreen';
import { StatsScreen } from '../features/stats/StatsScreen';
import { SettingsScreen } from '../features/settings/SettingsScreen';
import { AboutScreen } from '../features/about/AboutScreen';
import { startRegionSync, type RegionPayload } from '../native/regions';
import { touchRecentRoom } from '../db/repo/rooms';
import { closeStaleSessions } from '../db/repo/stats';
import { pruneOutbox } from '../db/repo/outbox';
import { generateRoomCode, type RoomMode, type RoomRole } from '../net/protocol';
import { closeAllDmChannels } from '../net/dmChannels';
import { useProfileStore } from '../stores/profile';
import { useFriendsStore } from '../stores/friends';
import { useSettingsStore } from '../stores/settings';
import { setAccentEnabled, startAccentTicker } from '../media/accentRuntime';
import { BrandMark } from './icons';

type Screen =
  | { name: 'home' }
  | {
      name: 'room';
      code: string;
      role: RoomRole;
      mode: RoomMode | null;
      setup: RoomSetup | null;
      password: string | null;
    }
  | { name: 'friends'; inviteUserId: string | null }
  | { name: 'dm'; peerUserId: string | null }
  | { name: 'profile' }
  | { name: 'stats' }
  | { name: 'settings' }
  | { name: 'about' };

const TOAST_MS = 3400;

/** Корень приложения: главная, комната, друзья/личка и настройки. */
export function Shell() {
  const site = useSiteController();
  const profileStatus = useProfileStore((state) => state.status);
  const identity = useProfileStore((state) => state.identity);
  const profile = useProfileStore((state) => state.profile);
  const persisted = useProfileStore((state) => state.persisted);
  const profileError = useProfileStore((state) => state.error);
  const loadProfile = useProfileStore((state) => state.load);
  const rename = useProfileStore((state) => state.rename);

  const loadSettings = useSettingsStore((state) => state.load);
  const settingsStatus = useSettingsStore((state) => state.status);
  const accentEnabled = useSettingsStore((state) => state.accentEnabled);
  const chatOpacity = useSettingsStore((state) => state.chatOpacity);

  const friendsCount = useFriendsStore((state) => state.friends.length);
  const pendingFriends = useFriendsStore((state) => state.requests.length);
  const unreadDm = useFriendsStore((state) => state.unreadTotal);
  const refreshFriends = useFriendsStore((state) => state.refresh);
  const loadFriends = useFriendsStore((state) => state.load);

  const [screen, setScreen] = useState<Screen>({ name: 'home' });
  const [zonesOpen, setZonesOpen] = useState(false);
  const [regionPayload, setRegionPayload] = useState<RegionPayload | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [deepPrefill, setDeepPrefill] = useState<{ code: string; at: number } | null>(null);
  const toastTimer = useRef<number | null>(null);
  const lastDeepAt = useRef(0);
  const lastFriendLinkAt = useRef(0);
  const lastNoticeAt = useRef(0);
  const backRootSeen = useRef(site.status.backRootAt);
  const backOverlaySeen = useRef(site.status.backOverlayAt);
  const staleChecked = useRef(false);
  const screenRef = useRef(screen);
  screenRef.current = screen;

  const notify = useCallback((text: string) => {
    setToast(text);
    if (toastTimer.current !== null) {
      window.clearTimeout(toastTimer.current);
    }
    toastTimer.current = window.setTimeout(() => {
      setToast(null);
      toastTimer.current = null;
    }, TOAST_MS);
  }, []);

  useEffect(() => {
    void loadProfile();
    void loadSettings();
    void loadFriends();
  }, [loadProfile, loadSettings, loadFriends]);

  // Сессии, оборванные прошлым запуском, закрываем временем heartbeat (§5).
  useEffect(() => {
    if (staleChecked.current) {
      return;
    }
    staleChecked.current = true;
    void pruneOutbox().catch(() => undefined);
    void closeStaleSessions().then((count) => {
      if (count > 0) {
        notify(`Закрыто сессий после обрыва: ${count}`);
      }
    });
  }, [notify]);

  // Акцент (§2.5): настройка + тикер простоя. Кадры приходят из комнаты.
  useEffect(() => {
    if (settingsStatus !== 'ready') {
      return;
    }
    setAccentEnabled(accentEnabled);
  }, [settingsStatus, accentEnabled]);

  useEffect(() => {
    const stop = startAccentTicker();
    return stop;
  }, []);

  // Прозрачность панели чата — одна CSS-переменная.
  useEffect(() => {
    document.documentElement.style.setProperty(
      '--hw-chat-alpha',
      String(Math.min(1, Math.max(0.55, chatOpacity))),
    );
  }, [chatOpacity]);

  useEffect(
    () => () => {
      if (toastTimer.current !== null) {
        window.clearTimeout(toastTimer.current);
      }
    },
    [],
  );

  // Нативные уведомления (ошибки страницы, инжект, back-root и т.п.).
  const notice = site.status.notice;
  useEffect(() => {
    if (!notice || notice.at === lastNoticeAt.current) {
      return;
    }
    lastNoticeAt.current = notice.at;
    if (screenRef.current.name === 'home') {
      notify(notice.text);
    }
  }, [notice, notify]);

  // Приложение ушло в фон: парные и инвайт-комнаты закрываются (§4.8).
  useEffect(
    () =>
      site.onEvent((event) => {
        if (event.t === 'app-state' && event.active === false) {
          closeAllDmChannels();
        }
      }),
    [site],
  );

  // Ссылка heliwatch://r/<code>: на главной подставляем код, в комнате игнорируем.
  const deepLink = site.status.deepLink;
  useEffect(() => {
    if (!deepLink || deepLink.at === lastDeepAt.current) {
      return;
    }
    lastDeepAt.current = deepLink.at;
    if (screenRef.current.name === 'home') {
      setDeepPrefill(deepLink);
      notify(`Код из ссылки: ${deepLink.code}`);
    } else {
      notify('Ссылка получена, но вы уже вне главной');
    }
  }, [deepLink, notify]);

  // Ссылка-приглашение heliwatch://f/<userId>: открываем друзей с подстановкой.
  const friendLink = site.status.friendLink;
  useEffect(() => {
    if (!friendLink || friendLink.at === lastFriendLinkAt.current) {
      return;
    }
    lastFriendLinkAt.current = friendLink.at;
    setScreen({ name: 'friends', inviteUserId: friendLink.userId });
    notify('Приглашение в друзья: отправьте заявку');
  }, [friendLink, notify]);

  // Системный back: в комнате выходим, на главной снова показываем подсказку.
  useEffect(() => {
    if (site.status.backRootAt <= backRootSeen.current) {
      return;
    }
    backRootSeen.current = site.status.backRootAt;
    if (screenRef.current.name === 'home') {
      notify('Ещё раз «назад» — выход из HeliWatch');
    }
  }, [site.status.backRootAt, notify]);

  const subScreen = screen.name !== 'home' && screen.name !== 'room';

  // Back на обычных экранах: перехватываем у истории сайта, пока экран открыт.
  useEffect(() => {
    if (!subScreen) {
      return;
    }
    site.setBackCapture(true);
    return () => {
      site.setBackCapture(false);
    };
  }, [subScreen, site]);

  useEffect(() => {
    if (site.status.backOverlayAt <= backOverlaySeen.current) {
      return;
    }
    backOverlaySeen.current = site.status.backOverlayAt;
    if (screenRef.current.name !== 'home' && screenRef.current.name !== 'room') {
      setScreen({ name: 'home' });
    }
  }, [site.status.backOverlayAt]);

  // Бейджи друзей обновляем при возвращении на главную.
  useEffect(() => {
    if (screen.name === 'home') {
      void refreshFriends();
    }
  }, [screen.name, refreshFriends]);

  // Зоны касания: пересчёт при смене экрана и после анимаций панелей.
  const screenKey = screen.name === 'room' ? `room:${screen.code}:${screen.role}` : screen.name;
  useEffect(
    () =>
      startRegionSync(
        () => zonesOpen,
        zonesOpen ? setRegionPayload : undefined,
      ),
    [zonesOpen, screenKey],
  );

  useEffect(() => {
    if (!zonesOpen) {
      setRegionPayload(null);
    }
  }, [zonesOpen]);

  const leaveRoom = useCallback(() => {
    const current = screenRef.current;
    if (current.name === 'room') {
      notify(current.role === 'host' ? 'Комната закрыта' : 'Вы вышли из комнаты');
    }
    setScreen({ name: 'home' });
  }, [notify]);

  const createRoom = useCallback((setup: RoomSetup) => {
    const code = generateRoomCode();
    void touchRecentRoom(code, setup.mode).catch(() => undefined);
    setScreen({
      name: 'room',
      code,
      role: 'host',
      mode: setup.mode,
      setup,
      password: setup.password,
    });
  }, []);

  const joinRoom = useCallback((code: string, password: string | null) => {
    setScreen({
      name: 'room',
      code,
      role: 'guest',
      mode: null,
      setup: null,
      password,
    });
  }, []);

  const openRecent = useCallback((code: string, mode: RoomMode) => {
    setScreen({
      name: 'room',
      code,
      role: 'guest',
      mode,
      setup: null,
      password: null,
    });
  }, []);

  const handleJoined = useCallback((code: string, mode: RoomMode) => {
    void touchRecentRoom(code, mode).catch(() => undefined);
  }, []);

  const goHome = useCallback(() => setScreen({ name: 'home' }), []);

  if (profileStatus !== 'ready' || !identity || !profile) {
    return (
      <div className="hw-app">
        <div className="hw-splash" data-hw-region="splash">
          <BrandMark size={64} />
          <h1>HeliWatch</h1>
          {profileStatus === 'error' ? (
            <>
              <p className="hw-formerror">
                {profileError ?? 'Не удалось подготовить профиль и ключи'}
              </p>
              <button type="button" className="hw-primary" onClick={() => void loadProfile()}>
                Повторить
              </button>
            </>
          ) : (
            <p>Готовим ключи и локальную базу…</p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="hw-app">
      {screen.name === 'home' && (
        <HomeScreen
          identity={identity}
          profile={profile}
          persisted={persisted}
          initialCode={deepPrefill}
          onCreate={createRoom}
          onJoin={joinRoom}
          onOpenRecent={openRecent}
          onRename={rename}
          onCodeConsumed={() => setDeepPrefill(null)}
          notify={notify}
          onOpenFriends={() => setScreen({ name: 'friends', inviteUserId: null })}
          onOpenDm={() => setScreen({ name: 'dm', peerUserId: null })}
          onOpenStats={() => setScreen({ name: 'stats' })}
          onOpenSettings={() => setScreen({ name: 'settings' })}
          onOpenProfile={() => setScreen({ name: 'profile' })}
          friendsCount={friendsCount}
          pendingFriends={pendingFriends}
          unreadDm={unreadDm}
        />
      )}

      {screen.name === 'friends' && (
        <FriendsScreen
          identity={identity}
          profile={profile}
          initialInviteUserId={screen.inviteUserId}
          onBack={goHome}
          onOpenDm={(peerUserId) => setScreen({ name: 'dm', peerUserId })}
          onOpenProfile={() => setScreen({ name: 'profile' })}
          notify={notify}
        />
      )}

      {screen.name === 'dm' && (
        <DmScreen
          identity={identity}
          profile={profile}
          initialPeerUserId={screen.peerUserId}
          onBack={goHome}
          onOpenFriends={() => setScreen({ name: 'friends', inviteUserId: null })}
          notify={notify}
        />
      )}

      {screen.name === 'profile' && (
        <ProfileScreen
          identity={identity}
          profile={profile}
          persisted={persisted}
          onBack={goHome}
          onOpenFriends={() => setScreen({ name: 'friends', inviteUserId: null })}
          notify={notify}
        />
      )}

      {screen.name === 'stats' && <StatsScreen onBack={goHome} notify={notify} />}

      {screen.name === 'settings' && (
        <SettingsScreen
          onBack={goHome}
          onOpenAbout={() => setScreen({ name: 'about' })}
          notify={notify}
        />
      )}

      {screen.name === 'about' && (
        <AboutScreen onBack={goHome} onOpenSettings={() => setScreen({ name: 'settings' })} />
      )}

      {screen.name === 'room' && (
        <RoomScreen
          key={`${screen.code}:${screen.role}`}
          code={screen.code}
          role={screen.role}
          initialMode={screen.mode}
          setup={screen.setup}
          password={screen.password}
          identity={identity}
          profile={profile}
          site={site}
          zonesOpen={zonesOpen}
          onToggleZones={() => setZonesOpen((value) => !value)}
          onLeave={leaveRoom}
          onJoined={handleJoined}
          notify={notify}
        />
      )}

      {zonesOpen && (
        <DebugZones
          payload={regionPayload}
          tap={site.status.lastTap}
          onClose={() => setZonesOpen(false)}
        />
      )}

      <div className="hw-toast-slot" role="status" aria-live="polite">
        {toast ? <div className="hw-toast">{toast}</div> : null}
      </div>
    </div>
  );
}
