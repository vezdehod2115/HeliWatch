import { useCallback, useEffect, useRef, useState } from 'react';
import { HomeScreen } from '../features/lobby/HomeScreen';
import { type RoomSetup } from '../features/lobby/types';
import { RoomScreen } from '../features/room/RoomScreen';
import { DebugZones } from '../features/site/DebugZones';
import { useSiteController } from '../features/site/useSiteController';
import { startRegionSync, type RegionPayload } from '../native/regions';
import {
  touchRecentRoom,
} from '../db/repo/rooms';
import { generateRoomCode, type RoomMode, type RoomRole } from '../net/protocol';
import { useProfileStore } from '../stores/profile';
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
    };

const TOAST_MS = 3400;

/** Корень приложения: главная, комната, зоны касания и уведомления. */
export function Shell() {
  const site = useSiteController();
  const profileStatus = useProfileStore((state) => state.status);
  const identity = useProfileStore((state) => state.identity);
  const profile = useProfileStore((state) => state.profile);
  const persisted = useProfileStore((state) => state.persisted);
  const profileError = useProfileStore((state) => state.error);
  const loadProfile = useProfileStore((state) => state.load);
  const rename = useProfileStore((state) => state.rename);

  const [screen, setScreen] = useState<Screen>({ name: 'home' });
  const [zonesOpen, setZonesOpen] = useState(false);
  const [regionPayload, setRegionPayload] = useState<RegionPayload | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [deepPrefill, setDeepPrefill] = useState<{ code: string; at: number } | null>(null);
  const toastTimer = useRef<number | null>(null);
  const lastDeepAt = useRef(0);
  const lastNoticeAt = useRef(0);
  const backRootSeen = useRef(site.status.backRootAt);
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
  }, [loadProfile]);

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
      notify('Ссылка получена, но вы уже в комнате');
    }
  }, [deepLink, notify]);

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

  // Зоны касания: пересчёт при смене экрана и после анимаций панелей.
  const screenKey =
    screen.name === 'room' ? `room:${screen.code}:${screen.role}` : 'home';
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

  const createRoom = useCallback(
    (setup: RoomSetup) => {
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
    },
    [],
  );

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
      {screen.name === 'home' ? (
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
        />
      ) : (
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
