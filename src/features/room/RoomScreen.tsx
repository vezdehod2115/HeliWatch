import { useCallback, useEffect, useRef, useState } from 'react';
import { BottomBar } from '../site/BottomBar';
import { TopBar } from '../site/TopBar';
import { RoomBar } from './RoomBar';
import { LocalPlayer, type LocalPlayerHandle } from '../localplay/LocalPlayer';
import type { SiteController } from '../site/useSiteController';
import { TEST_PAGE_URL, YOUTUBE_URL, normalizeUrl } from '../../native/siteBridge';
import type { LocalProfile } from '../../db/repo/identity';
import { roomLink } from '../../net/protocol';
import {
  actionFromVideoEvent,
  projectState,
  type PlaybackAction,
  type PlaybackSample,
  type PlaybackState,
  type RoomMode,
  type RoomRole,
} from '../../net/protocol';
import type { Identity } from '../../net/identity';
import { RoomClient, type RoomEvent } from '../../net/room';
import { connectTrystero } from '../../net/trystero';
import { useRoomStore } from '../../stores/room';
import { type PlaybackView } from '../../app/playback';
import { Icon } from '../../app/icons';

interface RoomScreenProps {
  code: string;
  role: RoomRole;
  initialMode: RoomMode | null;
  identity: Identity;
  profile: LocalProfile;
  site: SiteController;
  zonesOpen: boolean;
  onToggleZones: () => void;
  onLeave: () => void;
  onJoined: (code: string, mode: RoomMode) => void;
  notify: (text: string) => void;
}

interface LocalFile {
  name: string;
  size: number;
  url: string;
}

const EMPTY_VIEW: PlaybackView = {
  found: false,
  playing: false,
  time: 0,
  duration: 0,
  rate: 1,
};

function sampleFromView(view: PlaybackView, action: PlaybackAction): PlaybackSample {
  return {
    playing: action.kind === 'play' ? true : action.kind === 'pause' ? false : view.playing,
    time: action.kind === 'seek' ? (action.t ?? view.time) : view.time,
    rate: action.kind === 'rate' ? (action.rate ?? view.rate) : view.rate,
    duration: view.duration,
  };
}

function videoDataSample(data: Record<string, unknown>): PlaybackSample {
  return {
    playing: data.playing === true,
    time: typeof data.time === 'number' ? data.time : 0,
    rate: typeof data.rate === 'number' ? data.rate : 1,
    duration: typeof data.duration === 'number' ? data.duration : 0,
  };
}

/** Комната: транспорт, синхронизация и два режима — сайт (A) и файл (C). */
export function RoomScreen({
  code,
  role,
  initialMode,
  identity,
  profile,
  site,
  zonesOpen,
  onToggleZones,
  onLeave,
  onJoined,
  notify,
}: RoomScreenProps) {
  const snapshot = useRoomStore();
  const [localView, setLocalView] = useState<PlaybackView>(EMPTY_VIEW);
  const [localFile, setLocalFile] = useState<LocalFile | null>(null);
  const [collapsed, setCollapsed] = useState(false);

  const clientRef = useRef<RoomClient | null>(null);
  const siteRef = useRef(site);
  const localRef = useRef<LocalPlayerHandle>(null);
  const localFileRef = useRef<LocalFile | null>(null);
  const modeRef = useRef<RoomMode>(initialMode ?? 'site');
  const applyingRemoteUntil = useRef(0);
  const correctionTimer = useRef<number | null>(null);
  const lastCorrectionCheck = useRef(0);
  const lastLoadedUrl = useRef('');
  const lastPublishedUrl = useRef('');
  const leaving = useRef(false);
  const backAtMount = useRef(site.status.backRootAt);
  const closeTimer = useRef<number | null>(null);
  const notifyRef = useRef(notify);
  const onLeaveRef = useRef(onLeave);
  const onJoinedRef = useRef(onJoined);

  notifyRef.current = notify;
  onLeaveRef.current = onLeave;
  onJoinedRef.current = onJoined;
  siteRef.current = site;
  modeRef.current = snapshot.mode;
  localFileRef.current = localFile;

  const applyRemote = useCallback((action: PlaybackAction) => {
    applyingRemoteUntil.current = Date.now() + 800;
    if (modeRef.current === 'site') {
      siteRef.current.applyPlayback(action);
    } else {
      localRef.current?.apply(action);
    }
  }, []);

  const applyStateToLocal = useCallback(
    (state: PlaybackState) => {
      if (modeRef.current !== 'local' || !localRef.current) {
        return;
      }
      const receivedAt = useRoomStore.getState().stateReceivedAt || Date.now();
      const projected = projectState(state, receivedAt, Date.now());
      applyRemote({ kind: 'seek', t: projected });
      applyRemote({ kind: 'rate', rate: state.rate });
      applyRemote({ kind: state.playing ? 'play' : 'pause' });
    },
    [applyRemote],
  );

  const applyCorrection = useCallback(
    (action: PlaybackAction) => {
      if (action.kind === 'rate' && action.holdMs && action.restoreRate !== undefined) {
        applyRemote({ kind: 'rate', rate: action.rate ?? 1 });
        if (correctionTimer.current !== null) {
          window.clearTimeout(correctionTimer.current);
        }
        correctionTimer.current = window.setTimeout(() => {
          correctionTimer.current = null;
          applyRemote({ kind: 'rate', rate: action.restoreRate ?? 1 });
        }, action.holdMs);
        return;
      }
      applyRemote(action);
    },
    [applyRemote],
  );

  const reportAction = useCallback((action: PlaybackAction, sample: PlaybackSample) => {
    if (Date.now() < applyingRemoteUntil.current) {
      return;
    }
    if (useRoomStore.getState().phase !== 'joined') {
      return;
    }
    clientRef.current?.publishAction(action, sample);
  }, []);

  const loadSiteOnce = useCallback((url: string) => {
    if (!url || url === lastLoadedUrl.current) {
      return;
    }
    lastLoadedUrl.current = url;
    void siteRef.current.openUrl(url);
  }, []);

  const leave = useCallback(() => {
    if (leaving.current) {
      return;
    }
    leaving.current = true;
    const client = clientRef.current;
    clientRef.current = null;
    if (client) {
      void client.stop(role === 'host' ? 'host-left' : 'left');
    }
    onLeaveRef.current();
  }, [role]);

  useEffect(() => {
    useRoomStore.getState().reset();
    useRoomStore.getState().patch({
      code,
      role,
      mode: initialMode ?? 'site',
      phase: role === 'host' ? 'joined' : 'connecting',
      selfUserId: identity.userId,
      driverId: identity.userId,
      members: [
        {
          userId: identity.userId,
          peerId: '',
          name: profile.displayName,
          color: profile.nameColor,
          avatarHash: profile.avatarHash ?? undefined,
          joinedAt: Date.now(),
          host: role === 'host',
        },
      ],
    });

    const handleEvent = (event: RoomEvent) => {
      const store = useRoomStore.getState();
      switch (event.type) {
        case 'phase':
          store.patch({ phase: event.phase });
          break;
        case 'strategy':
          store.patch({ strategy: event.strategy });
          break;
        case 'members':
          store.patch({ members: event.members });
          break;
        case 'joined': {
          modeRef.current = event.meta.mode;
          store.patch({
            phase: 'joined',
            mode: event.meta.mode,
            members: event.members,
            hostUserId: event.hostUserId,
            playback: event.state,
            stateReceivedAt: Date.now(),
            driverId: event.state.by,
            error: null,
          });
          onJoinedRef.current(code, event.meta.mode);
          if (event.meta.mode === 'site') {
            if (event.state.src.url) {
              lastPublishedUrl.current = event.state.src.url;
              if (role === 'guest') {
                loadSiteOnce(event.state.src.url);
              }
            }
          } else if (role === 'guest' || localFileRef.current) {
            applyStateToLocal(event.state);
          }
          break;
        }
        case 'state': {
          store.patch({
            playback: event.state,
            driverId: event.state.by,
            stateReceivedAt: event.receivedAt,
            drift: event.drift,
          });
          if (
            role === 'guest' &&
            event.state.src.mode === 'site' &&
            event.state.src.url
          ) {
            loadSiteOnce(event.state.src.url);
          }
          break;
        }
        case 'command':
          applyRemote(event.action);
          break;
        case 'correction':
          applyCorrection(event.action);
          break;
        case 'site-url':
          if (role === 'guest') {
            loadSiteOnce(event.url);
          }
          break;
        case 'hint':
          store.patch({ hint: event.message });
          break;
        case 'error':
          store.patch({ error: event.message });
          notifyRef.current(event.message);
          break;
        case 'closed':
          store.patch({ phase: 'closed' });
          if (closeTimer.current !== null) {
            window.clearTimeout(closeTimer.current);
          }
          closeTimer.current = window.setTimeout(() => {
            closeTimer.current = null;
            leave();
          }, 1800);
          break;
        case 'peer-left':
          break;
        case 'debug':
          store.patch({ peerCount: event.peers, driverId: event.driverId });
          break;
        default:
          break;
      }
    };

    const client = new RoomClient({
      code,
      role,
      mode: initialMode ?? 'site',
      identity,
      profile: {
        name: profile.displayName,
        color: profile.nameColor,
        avatarHash: profile.avatarHash ?? undefined,
      },
      connect: (strategy) => connectTrystero(strategy, code),
      onEvent: handleEvent,
      initialUrl:
        role === 'host' && (initialMode ?? 'site') === 'site'
          ? siteRef.current.status.url || TEST_PAGE_URL
          : undefined,
    });
    clientRef.current = client;
    lastPublishedUrl.current = client.playback.src.url ?? '';
    void client.start();

    return () => {
      clientRef.current = null;
      if (client.phase !== 'closed' && client.phase !== 'error') {
        void client.stop(role === 'host' ? 'host-left' : 'left');
      }
      if (correctionTimer.current !== null) {
        window.clearTimeout(correctionTimer.current);
        correctionTimer.current = null;
      }
      if (closeTimer.current !== null) {
        window.clearTimeout(closeTimer.current);
        closeTimer.current = null;
      }
    };
    // Параметры комнаты фиксируются при монтировании: смена кода — новый экран.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // События страницы: действия пользователя на сайте уходят в комнату.
  useEffect(
    () =>
      site.onEvent((event) => {
        if (event.t !== 'page' || modeRef.current !== 'site') {
          return;
        }
        const store = useRoomStore.getState();
        if (store.phase !== 'joined') {
          return;
        }
        const data =
          typeof event.data === 'object' && event.data !== null
            ? (event.data as Record<string, unknown>)
            : {};
        const videoEvent = typeof data.event === 'string' ? data.event : '';
        if (!videoEvent || videoEvent.startsWith('remote-')) {
          return;
        }
        if (Date.now() < applyingRemoteUntil.current) {
          return;
        }
        const sample = videoDataSample(data);
        if (videoEvent === 'timeupdate' || videoEvent === 'playing') {
          const now = Date.now();
          if (now - lastCorrectionCheck.current >= 1000) {
            lastCorrectionCheck.current = now;
            clientRef.current?.checkCorrection(sample);
          }
        }
        const action = actionFromVideoEvent(videoEvent, data);
        if (action) {
          reportAction(action, sample);
        }
      }),
    [site.onEvent, reportAction],
  );

  // Хост публикует адрес сайта: обычная навигация внутри WebView тоже.
  useEffect(() => {
    if (role !== 'host' || snapshot.mode !== 'site' || snapshot.phase !== 'joined') {
      return;
    }
    const url = site.status.url;
    if (!url || !/^(https?|file):\/\//i.test(url)) {
      return;
    }
    if (url === lastPublishedUrl.current) {
      return;
    }
    lastPublishedUrl.current = url;
    clientRef.current?.publishSiteUrl(url);
  }, [site.status.url, snapshot.mode, snapshot.phase, role]);

  // Системный back на корне истории сайта выходит из комнаты.
  useEffect(() => {
    if (site.status.backRootAt > backAtMount.current) {
      leave();
    }
  }, [site.status.backRootAt, leave]);

  const pickFile = useCallback(
    (file: File) => {
      const previous = localFileRef.current;
      if (previous) {
        URL.revokeObjectURL(previous.url);
      }
      const next: LocalFile = {
        name: file.name,
        size: file.size,
        url: URL.createObjectURL(file),
      };
      localFileRef.current = next;
      setLocalFile(next);
      setLocalView({ ...EMPTY_VIEW });
      notifyRef.current(`Файл выбран: ${file.name}`);
    },
    [],
  );

  // Освобождаем blob-URL при размонтировании.
  useEffect(
    () => () => {
      const file = localFileRef.current;
      if (file) {
        URL.revokeObjectURL(file.url);
      }
    },
    [],
  );

  const onMetadata = useCallback(
    (duration: number) => {
      const file = localFileRef.current;
      if (!file) {
        return;
      }
      const sample: PlaybackSample = {
        playing: false,
        time: 0,
        rate: 1,
        duration: duration || 0,
      };
      // Источник публикует хост (у него продолжительность в state) или
      // текущий driver. Просто выбор файла гостем не должен перехватывать
      // управление — иначе гость молча станет ведущим.
      const isDriver = useRoomStore.getState().driverId === identity.userId;
      if (role === 'host' || isDriver) {
        clientRef.current?.publishSource(
          {
            mode: 'local',
            fileName: file.name,
            size: file.size,
            duration: duration || 0,
          },
          sample,
        );
      }
      const remote = useRoomStore.getState().playback;
      if (remote && remote.by !== identity.userId) {
        applyStateToLocal(remote);
      }
      setLocalView((current) => ({
        ...current,
        found: true,
        duration: duration || current.duration,
      }));
      notifyRef.current('Файл готов — время синхронизируется');
    },
    [applyStateToLocal, identity.userId],
  );

  const onProgress = useCallback((view: PlaybackView) => {
    setLocalView(view);
    if (Date.now() < applyingRemoteUntil.current) {
      return;
    }
    if (useRoomStore.getState().phase !== 'joined') {
      return;
    }
    const now = Date.now();
    if (now - lastCorrectionCheck.current < 1000) {
      return;
    }
    lastCorrectionCheck.current = now;
    clientRef.current?.checkCorrection({
      playing: view.playing,
      time: view.time,
      rate: view.rate,
      duration: view.duration,
    });
  }, []);

  const onLocalUserAction = useCallback(
    (action: PlaybackAction, sample: PlaybackSample) => {
      reportAction(action, sample);
    },
    [reportAction],
  );

  const siteVideo = site.status.video;
  const view: PlaybackView =
    snapshot.mode === 'site'
      ? {
          found: siteVideo.found,
          playing: siteVideo.playing,
          time: siteVideo.time,
          duration: siteVideo.duration,
          rate: siteVideo.rate,
        }
      : localView;

  const found = snapshot.mode === 'site' ? siteVideo.found : Boolean(localFile) && localView.found;
  const label =
    snapshot.mode === 'site'
      ? siteVideo.found
        ? siteVideo.playing
          ? 'Играет'
          : 'Пауза'
        : 'Видео не найдено'
      : localFile
        ? localFile.name
        : 'Файл не выбран';

  const applyAndReport = (action: PlaybackAction) => {
    if (!found) {
      return;
    }
    if (snapshot.mode === 'site') {
      siteRef.current.applyPlayback(action);
    } else {
      localRef.current?.apply(action);
      setLocalView((current) => ({
        ...current,
        playing:
          action.kind === 'play' ? true : action.kind === 'pause' ? false : current.playing,
        time: action.kind === 'seek' ? (action.t ?? current.time) : current.time,
        rate: action.kind === 'rate' ? (action.rate ?? current.rate) : current.rate,
      }));
    }
    reportAction(action, sampleFromView(view, action));
  };

  const togglePlay = () => {
    applyAndReport({ kind: view.playing ? 'pause' : 'play' });
  };

  const seekBy = (seconds: number) => {
    if (!found) {
      return;
    }
    const duration = view.duration > 0 ? view.duration : Number.POSITIVE_INFINITY;
    const target = Math.min(duration, Math.max(0, view.time + seconds));
    applyAndReport({ kind: 'seek', t: target });
  };

  const setRate = (rate: number) => {
    applyAndReport({ kind: 'rate', rate });
  };

  const syncToMe = () => {
    const client = clientRef.current;
    if (!client) {
      return;
    }
    client.takeover({
      playing: view.playing,
      time: view.time,
      rate: view.rate,
      duration: view.duration,
    });
    notifyRef.current('Теперь ваше время — главное');
  };

  const requestResync = () => {
    clientRef.current?.requestResync();
    notifyRef.current('Запросили состояние у ведущего');
  };

  const openSite = (input: string) => {
    if (role !== 'host') {
      return;
    }
    const url = normalizeUrl(input);
    if (!url) {
      notifyRef.current('Не понял адрес сайта');
      return;
    }
    void siteRef.current.openUrl(url).then(() => {
      clientRef.current?.publishSiteUrl(url);
    });
  };

  const copyLink = async () => {
    const link = roomLink(code);
    try {
      await navigator.clipboard.writeText(link);
      notifyRef.current('Ссылка скопирована');
    } catch {
      notifyRef.current(link);
    }
  };

  const driverName =
    snapshot.driverId === identity.userId
      ? 'Ведёте вы'
      : snapshot.driverId
        ? `Ведёт ${snapshot.members.find((member) => member.userId === snapshot.driverId)?.name ?? 'друг'}`
        : undefined;

  const waiting = snapshot.phase === 'connecting' || snapshot.phase === 'reconnecting';

  return (
    <div className={`hw-app hw-app--room hw-app--${snapshot.mode}`}>
      <RoomBar
        code={code}
        role={role}
        mode={snapshot.mode}
        phase={snapshot.phase}
        strategy={snapshot.strategy}
        peerCount={snapshot.peerCount}
        members={snapshot.members}
        selfUserId={identity.userId}
        driverId={snapshot.driverId}
        seq={snapshot.playback?.seq ?? 0}
        drift={snapshot.drift}
        hint={snapshot.hint}
        error={snapshot.error}
        zonesOpen={zonesOpen}
        onLeave={leave}
        onCopy={() => void copyLink()}
        onResync={requestResync}
        onToggleZones={onToggleZones}
      />

      {snapshot.mode === 'site' && (
        <TopBar
          status={site.status}
          zonesOpen={zonesOpen}
          onOpen={openSite}
          onTestPage={() => {
            if (role === 'host') {
              void siteRef.current.openUrl(TEST_PAGE_URL);
              clientRef.current?.publishSiteUrl(TEST_PAGE_URL);
            }
          }}
          onYoutube={() => {
            if (role === 'host') {
              void siteRef.current.openUrl(YOUTUBE_URL);
              clientRef.current?.publishSiteUrl(YOUTUBE_URL);
            }
          }}
          onNav={site.nav}
          onToggleZones={onToggleZones}
          compact
          addressLocked={role === 'guest'}
        />
      )}

      {snapshot.mode === 'site' ? (
        <main className="hw-stage" aria-hidden="true">
          {waiting && (
            <div className="hw-roomwait" data-hw-region="roomwait">
              <span className="hw-spinner" aria-hidden="true" />
              <strong>{snapshot.phase === 'reconnecting' ? 'Переподключаемся…' : 'Подключаемся к комнате'}</strong>
              <span>Код {code}. Сайт откроется, когда хост ответит.</span>
            </div>
          )}
        </main>
      ) : (
        <LocalPlayer
          ref={localRef}
          src={localFile?.url ?? null}
          fileName={localFile?.name ?? null}
          onPick={pickFile}
          onMetadata={onMetadata}
          onProgress={onProgress}
          onUserAction={onLocalUserAction}
          onNotice={(text) => notifyRef.current(text)}
        />
      )}

      <BottomBar
        view={view}
        label={label}
        mode={snapshot.mode}
        collapsed={collapsed}
        onToggleCollapsed={() => setCollapsed((value) => !value)}
        onTogglePlay={togglePlay}
        onSeek={seekBy}
        onRate={setRate}
        onReload={site.reload}
        onSyncToMe={syncToMe}
        canSync={snapshot.phase === 'joined' && found}
        driverLabel={driverName}
      />

      {(snapshot.phase === 'closed' || snapshot.phase === 'error') && (
        <div className="hw-roommsg" data-hw-region="roommsg">
          <div className="hw-roommsg-card">
            <Icon name={snapshot.phase === 'error' ? 'close' : 'users'} size={28} />
            <h2>{snapshot.phase === 'error' ? 'Комната недоступна' : 'Комната закрыта'}</h2>
            <p>{snapshot.error ?? 'Соединение завершено.'}</p>
            <button type="button" className="hw-primary" onClick={leave}>
              На главную
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
