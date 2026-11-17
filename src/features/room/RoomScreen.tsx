import { useCallback, useEffect, useRef, useState } from 'react';
import { BottomBar } from '../site/BottomBar';
import { TopBar } from '../site/TopBar';
import { RoomBar } from './RoomBar';
import { VideoWindow, type VideoWindowRect } from './VideoWindow';
import { RoomQueue } from './RoomQueue';
import { BrowseOverlay } from './BrowseOverlay';
import { LocalPlayer, type LocalPlayerHandle } from '../localplay/LocalPlayer';
import {
  RemoteStreamPlayer,
  type RemoteStreamPlayerHandle,
} from '../videofile/RemoteStreamPlayer';
import { describeCaptureError, isMkvName } from '../../media/capture';
import { StreamEngine } from '../../media/stream';
import {
  STREAM_MKV_WARNING,
  STREAM_VIEWER_WARNING,
  captureLabel,
  streamStatusLine,
  viewersLabel,
} from '../videofile/streamCopy';
import { ChatDock } from '../chat/ChatDock';
import { ChatPanel } from '../chat/ChatPanel';
import { FloatingReactions } from '../chat/Reactions';
import { ImageViewer } from '../chat/ImageViewer';
import { RemoteAudio } from '../voice/RemoteAudio';
import { imageUrlFromBytes, prepareImage, type PreparedImage } from '../chat/imagePrep';
import type { SiteController } from '../site/useSiteController';
import { TEST_PAGE_URL, YOUTUBE_URL, normalizeUrl, sendSiteCommand } from '../../native/siteBridge';
import type { LocalProfile } from '../../db/repo/identity';
import { LOBBY_ROOM_ID, roomLink } from '../../net/protocol';
import {
  QUEUE_MAX,
  actionFromVideoEvent,
  projectState,
  STREAM_MAX_VIEWERS,
  type ChatMessage,
  type PlaybackAction,
  type PlaybackSample,
  type PlaybackState,
  type QueueItem,
  type RoomMetaPayload,
  type RoomMode,
  type RoomRole,
  type StreamStartData,
} from '../../net/protocol';
import type { Identity } from '../../net/identity';
import { RoomClient, type RoomEvent } from '../../net/room';
import { connectTrystero } from '../../net/trystero';
import { LobbyPublisher } from '../../net/lobby';
import { ModerationPanel } from './ModerationPanel';
import { JoinRequests } from './JoinRequests';
import type { RoomSetup } from '../lobby/types';
import { useRoomStore } from '../../stores/room';
import { useChatStore } from '../../stores/chat';
import { useSettingsStore } from '../../stores/settings';
import { useFriendsStore } from '../../stores/friends';
import { SETTINGS_KEYS, readSetting, writeSetting } from '../../db/repo/settings';
import { listRoomMessages, saveRoomMessage } from '../../db/repo/chat';
import { listBlocks, pruneBlocks, blockUser, BAN_SESSION_MS } from '../../db/repo/blocklist';
import { attachDmImage } from '../../db/repo/dm';
import { updateFriendAvatar } from '../../db/repo/friends';
import {
  mediaImageUrl,
  readAvatarBytes,
  saveAvatar,
  saveMediaImage,
} from '../../db/repo/media';
import { sanitizeRecent } from '../chat/emoji';
import { DuckingController } from '../../media/ducking';
import { VoiceEngine, describeVoiceError, isVoiceSupported } from '../../media/voice';
import {
  pushNoFrame,
  pushSiteFrame,
  resetAccent,
  setAccentPip,
} from '../../media/accentRuntime';
import {
  flushOutboxToPeer,
  handleDmEvent,
  rememberIncomingDmImage,
  type DmContext,
} from '../../net/dm';
import { SessionTracker } from '../stats/sessionTracker';
import { type PlaybackView } from '../../app/playback';
import { Icon } from '../../app/icons';
import { PipLayer } from '../pip/PipLayer';
import {
  pipMessageLine,
  sessionPayload,
  sessionSignature,
  type SessionPayloadInput,
} from '../pip/pipState';
import { enterPip, readSessionInfo, updatePipState } from '../../native/pip';
import { setRegionSyncPaused } from '../../native/regions';
import {
  setKeepScreenOn,
  startSession,
  stopSession,
  updateSession,
} from '../../native/service';

interface RoomScreenProps {
  code: string;
  role: RoomRole;
  initialMode: RoomMode | null;
  /** Настройки созданной комнаты (у гостя null — они придут в welcome). */
  setup: RoomSetup | null;
  password: string | null;
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

const TYPING_IDLE_MS = 2500;
const DEFAULT_REACTION_X = 0.5;
const DEFAULT_REACTION_Y = 0.62;
/** Поиск (этап 8): тап по окну без видео открывает Google. */
const GOOGLE_URL = 'https://www.google.com/';
const GOOGLE_SEARCH_URL = 'https://www.google.com/search?q=';
const WINDOW_RADIUS = 18;

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

/** Комната: транспорт, синхронизация, голос и чат (режимы A и C). */
export function RoomScreen({
  code,
  role,
  initialMode,
  setup,
  password,
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
  const chat = useChatStore();
  const settings = useSettingsStore();
  const [localView, setLocalView] = useState<PlaybackView>(EMPTY_VIEW);
  const [localFile, setLocalFile] = useState<LocalFile | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [reactionsOpen, setReactionsOpen] = useState(false);
  const [viewerImageId, setViewerImageId] = useState<string | null>(null);
  const [remoteStreams, setRemoteStreams] = useState<Record<string, MediaStream>>({});
  const [voiceActive, setVoiceActive] = useState(false);
  const [voiceMuted, setVoiceMuted] = useState(false);
  const [voiceBusy, setVoiceBusy] = useState(false);
  const [voiceLevel, setVoiceLevel] = useState(0);
  const [speaking, setSpeaking] = useState<Record<string, string>>({});
  const [pipActive, setPipActive] = useState(false);
  const [pipSupported, setPipSupported] = useState(true);
  const [moderationOpen, setModerationOpen] = useState(false);
  // Стрим файла хоста (этап 5): у хоста — исходящий поток, у зрителя — входящий.
  const [hostStreaming, setHostStreaming] = useState(false);
  const [streamInfo, setStreamInfo] = useState<StreamStartData | null>(null);
  const [streamStarted, setStreamStarted] = useState(false);
  const [streamStopped, setStreamStopped] = useState(false);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [remotePlaying, setRemotePlaying] = useState(false);
  const [remoteDimensions, setRemoteDimensions] = useState({ width: 0, height: 0 });
  const [ageGateHidden, setAgeGateHidden] = useState(false);
  // Этап 8: видео-окно комнаты, полноэкранный поиск и очередь видео.
  const [browse, setBrowse] = useState(false);
  const [windowControls, setWindowControls] = useState(false);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [queueIndex, setQueueIndex] = useState(0);
  const [queueOpen, setQueueOpen] = useState(false);

  const clientRef = useRef<RoomClient | null>(null);
  const siteRef = useRef(site);
  const lobbyRef = useRef<LobbyPublisher | null>(null);
  /** Локальный бан-лист: хост не пускает забаненных, гость не идёт к ним. */
  const blockedRef = useRef<Set<string>>(new Set());
  const localRef = useRef<LocalPlayerHandle>(null);
  const remoteRef = useRef<RemoteStreamPlayerHandle>(null);
  const streamEngineRef = useRef<StreamEngine | null>(null);
  const streamInfoRef = useRef<StreamStartData | null>(null);
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
  const voiceEngineRef = useRef<VoiceEngine | null>(null);
  const duckingRef = useRef<DuckingController | null>(null);
  const memberNameRef = useRef<(peerId: string) => string>(() => 'Друг');
  const preparedRef = useRef(new Map<string, PreparedImage>());
  const viewerRef = useRef<string | null>(null);
  const typingTimer = useRef<number | null>(null);
  const sessionStarted = useRef(false);
  const sessionStartedAt = useRef(Date.now());
  const sessionSignatureRef = useRef('');
  const notificationWarned = useRef(false);
  const notificationCheck = useRef<number | null>(null);
  /** Статистика сессии (этап 7): играем/микрофон читаются на каждом тике. */
  const trackerRef = useRef<SessionTracker | null>(null);
  const endReasonRef = useRef<'left' | 'host-left' | 'timeout' | 'kick' | 'banned' | 'closed' | 'error'>(
    'left',
  );
  const playingRef = useRef(false);
  const micOnRef = useRef(false);
  /** Кому уже отправили свой аватар в этой комнате (по userId). */
  const avatarSentRef = useRef(new Set<string>());
  const pipHandlers = useRef<{
    toggle: () => void;
    mic: () => void;
    leave: () => void;
  }>({
    toggle: () => undefined,
    mic: () => undefined,
    leave: () => undefined,
  });
  /** Этап 8: поиск, окно и очередь. */
  const browseRef = useRef(false);
  const urlRef = useRef('');
  const browseStartUrl = useRef('');
  const roomUrlRef = useRef('');
  const lastWindowSig = useRef('');
  const returnTimer = useRef<number | null>(null);
  const controlsTimer = useRef<number | null>(null);
  const queueRef = useRef<QueueItem[]>([]);
  const queueIndexRef = useRef(0);
  const lastRectRef = useRef<VideoWindowRect | null>(null);
  const resumePlaybackRef = useRef<() => void>(() => undefined);
  const nextQueueRef = useRef<() => void>(() => undefined);

  notifyRef.current = notify;
  onLeaveRef.current = onLeave;
  onJoinedRef.current = onJoined;
  siteRef.current = site;
  modeRef.current = snapshot.mode;
  localFileRef.current = localFile;
  streamInfoRef.current = streamInfo;
  viewerRef.current = viewerImageId;
  browseRef.current = browse;
  urlRef.current = site.status.url;
  queueRef.current = queue;
  queueIndexRef.current = queueIndex;
  /** Хост «по факту»: после передачи/миграции роль в снимке меняется. */
  const selfHost =
    snapshot.hostUserId !== null
      ? snapshot.hostUserId === identity.userId
      : role === 'host';
  memberNameRef.current = (peerId: string) => {
    const member = useRoomStore
      .getState()
      .members.find((item) => item.peerId === peerId);
    return member?.name ?? 'Друг';
  };

  // ---------- Фон и PiP: снимок комнаты для нативного слоя (этап 4) ----------

  const buildSessionInput = useCallback((): SessionPayloadInput => {
    const state = useRoomStore.getState();
    const mode = state.mode;
    const siteVideo = siteRef.current.status.video;
    const local = localRef.current;
    const file = localFileRef.current;
    const messages = useChatStore.getState().messages;
    const last = messages.length > 0 ? messages[messages.length - 1] : null;
    const streamFile =
      streamInfoRef.current?.fileName ?? state.playback?.src.fileName ?? file?.name ?? '';
    const dimensions =
      mode === 'site'
        ? { width: siteVideo.width, height: siteVideo.height }
        : mode === 'stream' && role === 'guest'
          ? remoteDimensions
          : (local?.dimensions() ?? { width: 0, height: 0 });
    return {
      code,
      title:
        mode === 'site'
          ? siteRef.current.status.title
          : mode === 'stream'
            ? streamFile
            : (file?.name ?? ''),
      mode,
      roomActive: state.phase === 'joined',
      playing:
        mode === 'site'
          ? siteVideo.playing
          : mode === 'stream' && role === 'guest'
            ? remotePlaying
            : (local?.sample().playing ?? false),
      micOn: voiceActive && !voiceMuted,
      message: pipMessageLine(last),
      videoWidth: dimensions.width,
      videoHeight: dimensions.height,
      pipEnabled: settings.pipEnabled,
    };
  }, [code, voiceActive, voiceMuted, role, remoteDimensions, remotePlaying, settings.pipEnabled]);

  useEffect(() => {
    void readSessionInfo().then((info) => {
      if (info) {
        setPipSupported(info.pipSupported);
      }
    });
  }, []);

  // Один и тот же снимок уходит и в PiP, и в сервис уведомления.
  useEffect(() => {
    if (snapshot.phase !== 'joined') {
      return;
    }
    const input = buildSessionInput();
    const payload = sessionPayload(input);
    const signature = sessionSignature(payload);
    if (signature === sessionSignatureRef.current) {
      return;
    }
    sessionSignatureRef.current = signature;

    if (!sessionStarted.current) {
      sessionStarted.current = true;
      sessionStartedAt.current = Date.now();
      void startSession(input).then((result) => {
        if (!result.ok && result.error) {
          notifyRef.current(result.error);
        }
        if (result.notifications === false && !notificationWarned.current) {
          // Разрешение спрашивается асинхронно: перепроверяем через пару секунд,
          // иначе предупреждение появится даже при только что выданном доступе.
          notificationCheck.current = window.setTimeout(() => {
            notificationCheck.current = null;
            void readSessionInfo().then((info) => {
              if (!info || info.notifications || notificationWarned.current) {
                return;
              }
              notificationWarned.current = true;
              notifyRef.current('Уведомление скрыто: разрешите уведомления для HeliWatch');
            });
          }, 2500);
        }
      });
    } else {
      void updateSession(input);
    }
    void updatePipState(input);
  }, [
    buildSessionInput,
    snapshot.phase,
    snapshot.mode,
    site.status.video,
    localView,
    localFile,
    chat.messages,
    voiceActive,
    voiceMuted,
    settings.pipEnabled,
  ]);

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
    lobbyRef.current?.stop();
    lobbyRef.current = null;
    if (client) {
      void client.stop(client.selfIsHost ? 'host-left' : 'left');
    }
    onLeaveRef.current();
  }, []);

  // ---------- Чат: отправка ----------

  const persistMessage = useCallback((message: ChatMessage) => {
    if (!useChatStore.getState().saveHistory || message.kind !== 'text' || !message.text) {
      return;
    }
    void saveRoomMessage(code, message).catch(() => undefined);
  }, [code]);

  const sendChat = useCallback(() => {
    const client = clientRef.current;
    if (!client) {
      return;
    }
    const store = useChatStore.getState();
    const message = client.sendChat(store.draft);
    if (!message) {
      if (store.draft.trim()) {
        notifyRef.current('Слишком быстро — попробуйте ещё раз');
      }
      return;
    }
    store.addMessage(message);
    store.setDraft('');
    persistMessage(message);
    client.sendTyping(false);
    if (typingTimer.current !== null) {
      window.clearTimeout(typingTimer.current);
      typingTimer.current = null;
    }
  }, [persistMessage]);

  const onDraft = useCallback((text: string) => {
    const store = useChatStore.getState();
    store.setDraft(text);
    const client = clientRef.current;
    if (!client) {
      return;
    }
    client.sendTyping(text.trim().length > 0);
    if (typingTimer.current !== null) {
      window.clearTimeout(typingTimer.current);
    }
    typingTimer.current = window.setTimeout(() => {
      typingTimer.current = null;
      clientRef.current?.sendTyping(false);
    }, TYPING_IDLE_MS);
  }, []);

  const rememberEmoji = useCallback((emoji: string) => {
    const store = useChatStore.getState();
    store.rememberEmoji(emoji);
    void writeSetting(SETTINGS_KEYS.emojiRecent, store.recents).catch(() => undefined);
  }, []);

  const onEmoji = useCallback(
    (emoji: string) => {
      const store = useChatStore.getState();
      store.setDraft(`${store.draft}${emoji}`);
      store.setEmojiOpen(false);
      rememberEmoji(emoji);
    },
    [rememberEmoji],
  );

  const sendReaction = useCallback(
    (emoji: string) => {
      const client = clientRef.current;
      if (!client) {
        return;
      }
      const sent = client.sendReaction(emoji, { x: DEFAULT_REACTION_X, y: DEFAULT_REACTION_Y });
      if (!sent) {
        return;
      }
      useChatStore.getState().addReaction({
        emoji,
        from: identity.userId,
        name: profile.displayName,
        x: DEFAULT_REACTION_X,
        y: DEFAULT_REACTION_Y,
        self: true,
      });
      rememberEmoji(emoji);
      setReactionsOpen(false);
    },
    [identity.userId, profile.displayName, rememberEmoji],
  );

  /** Отправка фото: прогресс, отмена и повтор живут в ChatPanel. */
  const sendPreparedImage = useCallback((prepared: PreparedImage) => {
    const client = clientRef.current;
    const store = useChatStore.getState();
    if (!client) {
      return;
    }
    let imageId = '';
    const handle = client.sendImage(
      { bytes: prepared.bytes, mime: prepared.mime, w: prepared.w, h: prepared.h },
      {
        onProgress: (sent, total) => {
          if (!imageId) {
            return;
          }
          useChatStore.getState().setTransfer({
            id: imageId,
            direction: 'out',
            progress: sent,
            total,
          });
        },
      },
    );
    imageId = handle.id;
    preparedRef.current.set(imageId, prepared);
    store.setImage(imageId, prepared.previewUrl);
    store.addMessage({
      id: imageId,
      from: identity.userId,
      name: profile.displayName,
      color: profile.nameColor,
      ts: Date.now(),
      kind: 'image',
      imageId,
      self: true,
      pending: true,
    });
    store.setTransfer({
      id: imageId,
      direction: 'out',
      progress: 0,
      total: prepared.bytes.byteLength,
    });
    void handle.done.then((result) => {
      const state = useChatStore.getState();
      state.clearTransfer(imageId);
      if (result.ok) {
        state.updateMessage(imageId, { pending: false });
        preparedRef.current.delete(imageId);
        return;
      }
      state.updateMessage(imageId, {
        pending: false,
        failed: true,
        text: result.cancelled ? 'Отменено' : undefined,
      });
      if (!result.cancelled) {
        notifyRef.current(result.error ?? 'Фото не доставлено');
      }
    });
  }, [identity.userId, profile.displayName, profile.nameColor]);

  const onPhoto = useCallback(
    (file: File) => {
      void prepareImage(file)
        .then((prepared) => sendPreparedImage(prepared))
        .catch((error: unknown) => {
          notifyRef.current(
            error instanceof Error ? error.message : 'Не удалось подготовить фото',
          );
        });
    },
    [sendPreparedImage],
  );

  const onRetryImage = useCallback(
    (messageId: string) => {
      const prepared = preparedRef.current.get(messageId);
      if (prepared) {
        sendPreparedImage(prepared);
        return;
      }
      notifyRef.current('Выберите фото заново');
    },
    [sendPreparedImage],
  );

  const onCancelTransfer = useCallback((imageId: string) => {
    clientRef.current?.cancelImage(imageId);
  }, []);

  const toggleSaveHistory = useCallback(() => {
    const store = useChatStore.getState();
    const next = !store.saveHistory;
    store.setSaveHistory(next);
    void useSettingsStore.getState().update('chatHistory', next);
    if (next) {
      for (const message of store.messages) {
        if (message.kind === 'text' && message.text) {
          void saveRoomMessage(code, message).catch(() => undefined);
        }
      }
      notifyRef.current('История чата сохраняется на этом телефоне');
    } else {
      notifyRef.current('История чата больше не сохраняется');
    }
  }, [code]);

  // ---------- Голос ----------

  const toggleMic = useCallback(() => {
    const client = clientRef.current;
    const engine = voiceEngineRef.current;
    if (!client || !engine) {
      return;
    }
    if (!engine.active) {
      setVoiceBusy(true);
      void engine
        .start()
        .then((stream) => {
          client.attachVoice(stream);
          client.setMicMuted(false);
          setVoiceActive(true);
          setVoiceMuted(false);
        })
        .catch((error: unknown) => {
          notifyRef.current(describeVoiceError(error));
        })
        .finally(() => setVoiceBusy(false));
      return;
    }
    const muted = !client.micMuted;
    engine.setMuted(muted);
    client.setMicMuted(muted);
    setVoiceMuted(muted);
  }, []);

  // ---------- Этап 7: настройки, статистика и личка ----------

  // Ducking и age-gate меняются в настройках — применяем на лету.
  useEffect(() => {
    duckingRef.current?.setEnabled(settings.voiceDucking);
  }, [settings.voiceDucking]);

  useEffect(() => {
    void sendSiteCommand({ cmd: 'setAgeGate', on: settings.ageGate });
  }, [settings.ageGate]);

  // Статистика: сессия открывается при входе в комнату (phase = joined).
  useEffect(() => {
    if (snapshot.phase !== 'joined' || trackerRef.current) {
      return;
    }
    const peers = snapshot.members
      .filter((member) => member.userId !== identity.userId)
      .map((member) => ({ userId: member.userId, name: member.name }));
    const tracker = new SessionTracker({
      code,
      mode: snapshot.mode,
      isPlaying: () => playingRef.current,
      isMicOn: () => micOnRef.current,
    });
    trackerRef.current = tracker;
    void tracker.start(snapshot.hostUserId, peers);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot.phase, snapshot.mode, snapshot.hostUserId, identity.userId, code]);

  useEffect(() => {
    const tracker = trackerRef.current;
    if (!tracker) {
      return;
    }
    void tracker.updatePeers(
      snapshot.members
        .filter((member) => member.userId !== identity.userId)
        .map((member) => ({ userId: member.userId, name: member.name })),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot.members, identity.userId]);

  // ---------- Жизненный цикл комнаты ----------

  useEffect(() => {
    useRoomStore.getState().reset();
    useRoomStore.getState().patch({
      code,
      role,
      mode: initialMode ?? 'site',
      phase: role === 'host' ? 'joined' : 'connecting',
      selfUserId: identity.userId,
      driverId: identity.userId,
      hostUserId: role === 'host' ? identity.userId : null,
      title: setup?.title?.trim() || `Комната ${code}`,
      limit: setup?.limit ?? (initialMode === 'stream' ? 3 : 4),
      closed: setup?.closed ?? false,
      knock: setup?.knock ?? false,
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

    // Бан-лист этапа 6: хост не пускает забаненных, гость помнит обидчика.
    void pruneBlocks()
      .then(() => listBlocks())
      .then((entries) => {
        blockedRef.current = new Set(entries.map((entry) => entry.userId));
      })
      .catch(() => undefined);

    const chatStore = useChatStore.getState();
    chatStore.init(code);

    // Настройки этапа 7 уже загружены Shell: история, ducking и акцент берутся
    // из store, а из SQLite читаем только недавние эмодзи.
    void (async () => {
      const recents = await readSetting<unknown>(SETTINGS_KEYS.emojiRecent, []);
      const store = useChatStore.getState();
      store.setSaveHistory(settings.chatHistory);
      store.setRecents(sanitizeRecent(recents));
      duckingRef.current?.setEnabled(settings.voiceDucking);
      if (settings.chatHistory) {
        const stored = await listRoomMessages(code);
        const messages: ChatMessage[] = [];
        for (const row of stored) {
          const self = row.from === identity.userId;
          const base = {
            id: row.id,
            from: row.from,
            name: self ? profile.displayName : 'Друг',
            color: self ? profile.nameColor : '#9dbfb7',
            ts: row.ts,
            self,
          };
          if (row.kind === 'text') {
            messages.push({ ...base, kind: 'text', text: row.body });
            continue;
          }
          if (!row.imagePath) {
            continue;
          }
          const url = await mediaImageUrl(row.imagePath);
          if (!url) {
            continue;
          }
          useChatStore.getState().setImage(row.id, url);
          messages.push({ ...base, kind: 'image', imageId: row.id });
        }
        if (messages.length > 0) {
          useChatStore.getState().loadMessages(messages);
        }
      }
    })();

    // Age-gate: подсказка включается/выключается настройкой (этап 7).
    void sendSiteCommand({ cmd: 'setAgeGate', on: settings.ageGate });

    // Голос и ducking живут столько же, сколько комната.
    const engine = new VoiceEngine({
      onLocal: (decision) => {
        setVoiceLevel(decision.level);
        duckingRef.current?.setSpeaking('self', decision.speaking);
        setSpeaking((prev) => {
          if (decision.speaking) {
            return prev.self === profile.displayName
              ? prev
              : { ...prev, self: profile.displayName };
          }
          if (!('self' in prev)) {
            return prev;
          }
          const next = { ...prev };
          delete next.self;
          return next;
        });
      },
      onRemote: (peerId, decision) => {
        const name = memberNameRef.current(peerId);
        duckingRef.current?.setSpeaking(peerId, decision.speaking);
        setSpeaking((prev) => {
          if (decision.speaking) {
            return prev[peerId] === name ? prev : { ...prev, [peerId]: name };
          }
          if (!(peerId in prev)) {
            return prev;
          }
          const next = { ...prev };
          delete next[peerId];
          return next;
        });
      },
    });
    voiceEngineRef.current = engine;
    duckingRef.current = new DuckingController({
      enabled: true,
      apply: (volume) => {
        if (modeRef.current === 'site') {
          siteRef.current.setVolume(volume);
        } else if (modeRef.current === 'stream' && role === 'guest') {
          remoteRef.current?.setVolume(volume);
        } else {
          localRef.current?.setVolume(volume);
        }
      },
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
        case 'meta':
          store.patch({
            title: event.meta.title,
            limit: event.meta.limit,
            closed: event.meta.closed,
            knock: event.meta.knock,
            mode: event.meta.mode,
          });
          break;
        case 'host-changed': {
          store.patch({ hostUserId: event.hostUserId, epoch: event.epoch });
          if (event.self) {
            notifyRef.current('Вы теперь хост комнаты');
          } else {
            const host = store.members.find(
              (member) => member.userId === event.hostUserId,
            );
            notifyRef.current(`Хост комнаты теперь ${host?.name ?? 'друг'}`);
          }
          break;
        }
        case 'join-request': {
          const requests = useRoomStore
            .getState()
            .joinRequests.filter((item) => item.userId !== event.request.userId);
          store.patch({ joinRequests: [...requests, event.request] });
          notifyRef.current(`${event.request.name} просится в комнату`);
          break;
        }
        case 'join-decision':
          store.patch({
            joinRequests: useRoomStore
              .getState()
              .joinRequests.filter((item) => item.userId !== event.userId),
          });
          notifyRef.current(
            event.accepted
              ? `${event.name} в комнате`
              : `Вход ${event.name} отклонён`,
          );
          break;
        case 'moderation':
          notifyRef.current(
            event.action === 'ban'
              ? `${event.name} забанен`
              : `${event.name} исключён из комнаты`,
          );
          if (event.action === 'ban') {
            blockedRef.current.add(event.userId);
            void blockUser(
              event.userId,
              'забанен хостом комнаты',
              event.until !== undefined ? 'session' : 'forever',
            ).catch(() => undefined);
          }
          break;
        case 'kicked':
          endReasonRef.current = event.reason === 'banned' ? 'banned' : 'kick';
          store.patch({
            error:
              event.reason === 'banned'
                ? 'Хост забанил вас в этой комнате'
                : 'Хост исключил вас из комнаты',
          });
          if (event.reason === 'banned') {
            // Локально запоминаем, кто забанил: обратно не стучимся.
            blockedRef.current.add(event.by);
            void blockUser(event.by, 'забанил вас', 'session').catch(() => undefined);
          }
          break;
        case 'mute-request': {
          const client = clientRef.current;
          voiceEngineRef.current?.setMuted(true);
          client?.setMicMuted(true);
          setVoiceMuted(true);
          notifyRef.current(`${event.name} попросил выключить микрофон`);
          break;
        }
        case 'joined': {
          modeRef.current = event.meta.mode;
          store.patch({
            phase: 'joined',
            mode: event.meta.mode,
            members: event.members,
            hostUserId: event.hostUserId,
            title: event.meta.title,
            limit: event.meta.limit,
            closed: event.meta.closed,
            knock: event.meta.knock,
            playback: event.state,
            stateReceivedAt: Date.now(),
            driverId: event.state.by,
            error: null,
          });
          onJoinedRef.current(code, event.meta.mode);
          if (event.meta.mode === 'stream') {
            // Поток мог прийти раньше welcome — не выбрасываем его.
            setStreamStarted(false);
            setStreamStopped(false);
            setStreamError(null);
            // Имя файла уже в state: зритель видит его до прихода потока.
            if (event.state.src.fileName) {
              const info: StreamStartData = {
                fileName: event.state.src.fileName,
                duration: event.state.src.duration,
                maxViewers: STREAM_MAX_VIEWERS,
                capture: 'direct',
              };
              streamInfoRef.current = info;
              setStreamInfo(info);
            }
          }
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
        case 'queue': {
          // Очередь ведёт хост: у гостя — только отображение.
          queueRef.current = event.items;
          queueIndexRef.current = event.index;
          setQueue(event.items);
          setQueueIndex(event.index);
          break;
        }
        case 'hint':
          store.patch({ hint: event.message });
          break;
        case 'chat': {
          const chatState = useChatStore.getState();
          chatState.setNotice(null);
          chatState.addMessage(event.message);
          if (chatState.saveHistory) {
            void saveRoomMessage(code, event.message).catch(() => undefined);
          }
          break;
        }
        case 'reaction':
          useChatStore.getState().addReaction({
            emoji: event.emoji,
            from: event.from,
            name: event.name,
            x: typeof event.x === 'number' ? event.x : DEFAULT_REACTION_X,
            y: typeof event.y === 'number' ? event.y : DEFAULT_REACTION_Y,
            self: false,
          });
          break;
        case 'typing':
          useChatStore.getState().setTyping(event.from, event.name, event.on);
          break;
        // ---------- Этап 7: друзья и личка прямо в комнате ----------
        case 'peer-ready': {
          // Пир авторизован: предлагаем всё, что накопилось в outbox.
          const client = clientRef.current;
          if (client) {
            void flushOutboxToPeer(client, identity.userId, event.userId);
            // Аватар (этап 7): 128×128 чанками, один раз на пира. Хеш в
            // profile/профиле друга позволяет не пересылать его повторно.
            if (profile.avatarHash && !avatarSentRef.current.has(event.userId)) {
              avatarSentRef.current.add(event.userId);
              void readAvatarBytes(profile.avatarHash).then((bytes) => {
                if (!bytes) {
                  return;
                }
                client.sendImage(
                  { bytes, mime: 'image/jpeg', w: 128, h: 128 },
                  { scope: 'avatar', to: event.peerId },
                );
              });
            }
          }
          break;
        }
        case 'friend-request':
        case 'friend-accepted':
        case 'friend-removed':
        case 'dm':
        case 'dm-ack':
        case 'dm-outbox':
        case 'dm-outbox-sync': {
          const client = clientRef.current;
          if (!client) {
            break;
          }
          const context: DmContext = {
            transport: client,
            selfUserId: identity.userId,
            identity,
            profile: {
              name: profile.displayName,
              color: profile.nameColor,
              avatarHash: profile.avatarHash,
            },
            notify: (text) => notifyRef.current(text),
            onChange: () => {
              void useFriendsStore.getState().refresh();
            },
          };
          void handleDmEvent(event, context);
          break;
        }
        case 'image-start': {
          if (event.info.scope === 'dm' || event.info.scope === 'avatar') {
            // Фото лички и аватары не попадают в чат комнаты.
            break;
          }
          const chatState = useChatStore.getState();
          chatState.setTransfer({
            id: event.info.id,
            direction: 'in',
            progress: event.info.received,
            total: event.info.size,
          });
          chatState.addMessage({
            id: event.info.id,
            from: '',
            name: 'Друг',
            color: '#9dbfb7',
            ts: Date.now(),
            kind: 'image',
            imageId: event.info.id,
            pending: true,
          });
          break;
        }
        case 'image-progress': {
          if (event.info.scope === 'dm' || event.info.scope === 'avatar') {
            break;
          }
          useChatStore.getState().setTransfer({
            id: event.info.id,
            direction: 'in',
            progress: event.info.received,
            total: event.info.size,
          });
          break;
        }
        case 'image': {
          if (event.scope === 'avatar') {
            // Аватар друга: кладём в кэш и обновляем только существующую
            // запись друга — из чужого аватара дружба не появляется.
            if (event.bytes.byteLength > 256 * 1024 || !event.from) {
              break;
            }
            void saveAvatar(event.bytes, event.mime).then(async (hash) => {
              if (!hash) {
                return;
              }
              await updateFriendAvatar(event.from, hash);
              await useFriendsStore.getState().refresh();
            });
            break;
          }
          if (event.scope === 'dm') {
            // Личное фото: кладём в файловый кэш и привязываем к dm-сообщению.
            void saveMediaImage(event.bytes, event.mime, event.w, event.h).then(
              async (saved) => {
                if (!saved) {
                  return;
                }
                rememberIncomingDmImage(event.id, saved.path);
                await attachDmImage(event.id, saved.path);
                await useFriendsStore.getState().refresh();
              },
            );
            break;
          }
          const chatState = useChatStore.getState();
          const url = imageUrlFromBytes(event.bytes, event.mime);
          chatState.setImage(event.id, url);
          chatState.clearTransfer(event.id);
          chatState.setNotice(null);
          // Сообщение могло появиться ещё на `image-start` — тогда обновляем его.
          chatState.updateMessage(event.id, {
            from: event.from,
            name: event.name,
            color: event.color,
            ts: event.ts,
            pending: false,
            failed: false,
          });
          const imageMessage: ChatMessage = {
            id: event.id,
            from: event.from,
            name: event.name,
            color: event.color,
            ts: event.ts,
            kind: 'image',
            imageId: event.id,
            pending: false,
          };
          chatState.addMessage(imageMessage);
          // Файловый кэш этапа 7: фото переживает перезапуск в истории.
          void saveMediaImage(event.bytes, event.mime, event.w, event.h).then(
            (saved) => {
              if (saved && useChatStore.getState().saveHistory) {
                void saveRoomMessage(code, imageMessage, saved.path).catch(
                  () => undefined,
                );
              }
            },
          );
          break;
        }
        case 'image-error': {
          if (event.scope === 'dm' || event.scope === 'avatar') {
            break;
          }
          const chatState = useChatStore.getState();
          chatState.clearTransfer(event.id);
          chatState.updateMessage(event.id, { pending: false, failed: true });
          chatState.setNotice(
            event.reason === 'checksum' || event.reason === 'size'
              ? 'Фото дошло с ошибкой — попробуйте отправить снова'
              : 'Фото не доставлено — повторите отправку',
          );
          break;
        }
        case 'voice-stream':
          setRemoteStreams((prev) => ({ ...prev, [event.peerId]: event.stream }));
          voiceEngineRef.current?.attachRemote(event.peerId, event.stream);
          break;
        case 'screen-stream':
          setRemoteStream(event.stream);
          setRemotePlaying(false);
          setStreamStarted(true);
          setStreamStopped(false);
          setStreamError(null);
          break;
        case 'stream-start':
          setStreamInfo(event.info);
          streamInfoRef.current = event.info;
          setStreamStarted(true);
          setStreamStopped(false);
          setStreamError(null);
          notifyRef.current(
            `Хост раздаёт ${event.info.fileName ?? 'файл'}${event.info.capture === 'canvas' ? ' (canvas-фоллбэк)' : ''}`,
          );
          break;
        case 'stream-stop':
          setRemoteStream(null);
          setRemotePlaying(false);
          setStreamStarted(false);
          setStreamStopped(true);
          break;
        case 'capability':
          if (!event.capability.canCapture) {
            setStreamError(
              'Хост не может раздавать видео на этом устройстве: файл не открылся',
            );
          }
          break;
        case 'error':
          endReasonRef.current = 'error';
          store.patch({ error: event.message });
          notifyRef.current(event.message);
          break;
        case 'closed':
          endReasonRef.current =
            typeof event.reason === 'string' && event.reason === 'host-left'
              ? 'host-left'
              : 'closed';
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
          setRemoteStreams((prev) => {
            if (!(event.peerId in prev)) {
              return prev;
            }
            const next = { ...prev };
            delete next[event.peerId];
            return next;
          });
          voiceEngineRef.current?.detachRemote(event.peerId);
          if (
            useRoomStore.getState().mode === 'stream' &&
            event.userId === useRoomStore.getState().hostUserId
          ) {
            setRemoteStream(null);
            setRemotePlaying(false);
            setStreamStopped(true);
          }
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
      connect: (strategy, roomId) => connectTrystero(strategy, roomId),
      onEvent: handleEvent,
      meta: {
        title: setup?.title,
        limit: setup?.limit,
        closed: setup?.closed,
        knock: setup?.knock,
      },
      password,
      isBanned: (userId) => blockedRef.current.has(userId),
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
      lobbyRef.current?.stop();
      lobbyRef.current = null;
      if (client.phase !== 'closed' && client.phase !== 'error') {
        // Новый хост (после миграции) уходит так же, как обычный хост.
        void client.stop(client.selfIsHost ? 'host-left' : 'left');
      }
      if (correctionTimer.current !== null) {
        window.clearTimeout(correctionTimer.current);
        correctionTimer.current = null;
      }
      if (closeTimer.current !== null) {
        window.clearTimeout(closeTimer.current);
        closeTimer.current = null;
      }
      if (typingTimer.current !== null) {
        window.clearTimeout(typingTimer.current);
        typingTimer.current = null;
      }
      if (notificationCheck.current !== null) {
        window.clearTimeout(notificationCheck.current);
        notificationCheck.current = null;
      }
      engine.stop();
      voiceEngineRef.current = null;
      duckingRef.current?.dispose();
      duckingRef.current = null;
      // Голос закончился — возвращаем сайту полную громкость.
      siteRef.current.setVolume(1);
      // Комната закрыта: сервис, WakeLock и автовход в PiP выключаются.
      void stopSession();
      // Статистика: закрываем сессию причиной, которую запомнили обработчики.
      const tracker = trackerRef.current;
      trackerRef.current = null;
      void tracker?.stop(endReasonRef.current);
      resetAccent();
      useChatStore.getState().reset();
      setRemoteStreams({});
    };
    // Параметры комнаты фиксируются при монтировании: смена кода — новый экран.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // События страницы: действия пользователя на сайте уходят в комнату.
  useEffect(
    () =>
      site.onEvent((event) => {
        // Динамический акцент (§2.5): кадр из site-hook. Не требует авторизации
        // комнаты — цвет можно считать сразу, но вне комнаты он не применяется.
        if (event.t === 'page' && event.event === 'frame') {
          if (modeRef.current === 'site') {
            pushSiteFrame(event.data);
          }
          return;
        }
        if (event.t === 'pip-mode') {
          const on = event.on === true;
          setPipActive(on);
          setAccentPip(on);
          if (on) {
            // В PiP панели не нужны: остаётся видео и строка сообщения.
            const chatState = useChatStore.getState();
            chatState.setOpen(false);
            chatState.setEmojiOpen(false);
            setReactionsOpen(false);
            setViewerImageId(null);
            setModerationOpen(false);
            setQueueOpen(false);
            exitBrowse(false);
          }
          return;
        }
        if (event.t === 'resume-playback') {
          // Activity вернулась из фона/PiP: система могла поставить видео на паузу.
          resumePlaybackRef.current();
          return;
        }
        if (event.t === 'pip-action') {
          const action = typeof event.action === 'string' ? event.action : '';
          const handlers = pipHandlers.current;
          if (action === 'toggle') {
            handlers.toggle();
          } else if (action === 'mic') {
            handlers.mic();
          } else if (action === 'leave') {
            handlers.leave();
          }
          return;
        }
        if (event.t === 'back-overlay') {
          // Системный back при открытой панели: закрываем верхнюю.
          if (browseRef.current) {
            exitBrowse(true);
            return;
          }
          if (queueOpen) {
            setQueueOpen(false);
            return;
          }
          if (moderationOpen) {
            setModerationOpen(false);
            return;
          }
          if (viewerRef.current) {
            setViewerImageId(null);
            return;
          }
          const chatState = useChatStore.getState();
          if (chatState.emojiOpen) {
            chatState.setEmojiOpen(false);
            return;
          }
          if (chatState.open) {
            chatState.setOpen(false);
          }
          return;
        }
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
        // Новая страница получила инжект: возвращаем рамку окна, иначе сайт
        // останется на весь экран без видео-окна.
        if (event.event === 'hook-ready') {
          const rect = lastRectRef.current;
          if (rect && !browseRef.current) {
            window.setTimeout(() => {
              if (!browseRef.current) {
                lastWindowSig.current = '';
                handleWindowRect(rect);
              }
            }, 180);
          }
          return;
        }
        const videoEvent = typeof data.event === 'string' ? data.event : '';
        if (!videoEvent || videoEvent.startsWith('remote-')) {
          return;
        }
        // Поиск (этап 8): выбрали ролик на сайте — возвращаемся в комнату,
        // видео заиграет в окне. Google-выдачу не считаем выбором.
        if (browseRef.current && (videoEvent === 'found' || videoEvent === 'playing')) {
          let host = '';
          try {
            host = new URL(urlRef.current).hostname;
          } catch {
            host = '';
          }
          if (!host || !/(^|\.)google\./i.test(host)) {
            if (returnTimer.current !== null) {
              window.clearTimeout(returnTimer.current);
            }
            returnTimer.current = window.setTimeout(() => {
              returnTimer.current = null;
              if (!browseRef.current) {
                return;
              }
              roomUrlRef.current = urlRef.current;
              browseRef.current = false;
              setBrowse(false);
              lastWindowSig.current = '';
            }, 700);
          }
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
        // Очередь: по окончании ролика хост включает следующий.
        if (videoEvent === 'ended') {
          nextQueueRef.current();
        }
      }),
    [site.onEvent, reportAction, moderationOpen, queueOpen],
  );

  // Системный back перехватывается, только пока открыта панель React.
  useEffect(() => {
    const captured =
      chat.open ||
      chat.emojiOpen ||
      viewerImageId !== null ||
      moderationOpen ||
      queueOpen ||
      browse;
    siteRef.current.setBackCapture(captured);
    return () => {
      // Уходим из комнаты с открытой панелью — back снова принадлежит истории.
      siteRef.current.setBackCapture(false);
    };
  }, [chat.open, chat.emojiOpen, viewerImageId, moderationOpen, queueOpen, browse]);

  // «Печатает…» протухает само: чистим раз в секунду, пока чат открыт.
  useEffect(() => {
    const timer = window.setInterval(() => {
      useChatStore.getState().pruneTyping();
    }, 1000);
    return () => window.clearInterval(timer);
  }, []);

  // Хост публикует адрес сайта: обычная навигация внутри WebView тоже.
  useEffect(() => {
    if (!selfHost || snapshot.mode !== 'site' || snapshot.phase !== 'joined') {
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
  }, [site.status.url, snapshot.mode, snapshot.phase, snapshot.hostUserId, role, identity.userId]);

  // Системный back на корне истории сайта выходит из комнаты.
  useEffect(() => {
    if (site.status.backRootAt > backAtMount.current) {
      if (browseRef.current) {
        exitBrowse(true);
        return;
      }
      leave();
    }
  }, [site.status.backRootAt, leave]);

  const stopHostStream = useCallback(
    (reason: 'host-stop' | 'error' | 'ended' = 'host-stop') => {
      setHostStreaming(false);
      const engine = streamEngineRef.current;
      streamEngineRef.current = null;
      engine?.stop();
      const client = clientRef.current;
      if (client) {
        client.publishStreamStop(reason);
        client.detachScreen();
      }
    },
    [],
  );

  const startHostStream = useCallback(
    async (video: HTMLVideoElement | null, file: LocalFile, duration: number) => {
      const client = clientRef.current;
      if (!client || role !== 'host' || modeRef.current !== 'stream') {
        return;
      }
      if (!video) {
        notifyRef.current('Плеер не готов: выберите файл ещё раз');
        return;
      }
      stopHostStream('host-stop');
      const engine = new StreamEngine();
      streamEngineRef.current = engine;
      try {
        const result = await engine.start(video);
        if (streamEngineRef.current !== engine) {
          // Комнату закрыли или выбрали другой файл, пока шёл захват.
          engine.stop();
          return;
        }
        // Если браузер уже разрешил звук — включаем; иначе сделаем это на play.
        engine.resumeAudio();
        setHostStreaming(true);
        setStreamError(null);
        client.attachScreen(result.stream);
        const info: StreamStartData = {
          fileName: file.name,
          duration: duration || 0,
          maxViewers: STREAM_MAX_VIEWERS,
          capture: result.kind,
        };
        streamInfoRef.current = info;
        setStreamInfo(info);
        client.publishStreamStart(info);
        client.publishCapability({
          canCapture: true,
          maxViewers: STREAM_MAX_VIEWERS,
          capture: result.kind,
        });
        notifyRef.current(
          `Раздача началась · ${captureLabel(result.kind)} · ${viewersLabel(
            Math.max(0, useRoomStore.getState().members.length - 1),
          )}`,
        );
      } catch (error: unknown) {
        if (streamEngineRef.current !== engine) {
          return;
        }
        streamEngineRef.current = null;
        engine.stop();
        setHostStreaming(false);
        const message = describeCaptureError(error);
        setStreamError(message);
        notifyRef.current(message);
        client.publishCapability({ canCapture: false, maxViewers: 0 });
      }
    },
    [role, stopHostStream],
  );

  const pickFile = useCallback(
    (file: File) => {
      // Смена файла в режиме B: старую раздачу гасим до подмены blob-URL.
      if (modeRef.current === 'stream' && role === 'host') {
        stopHostStream('host-stop');
        streamInfoRef.current = null;
        setStreamInfo(null);
        setStreamStarted(false);
        setStreamStopped(false);
        setStreamError(null);
        if (isMkvName(file.name)) {
          notifyRef.current(STREAM_MKV_WARNING);
        } else {
          notifyRef.current(STREAM_VIEWER_WARNING);
        }
      }
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
      if (modeRef.current !== 'stream') {
        notifyRef.current(`Файл выбран: ${file.name}`);
      }
    },
    [role, stopHostStream],
  );

  // Освобождаем blob-URL и захват при размонтировании.
  useEffect(
    () => () => {
      streamEngineRef.current?.stop();
      streamEngineRef.current = null;
      const file = localFileRef.current;
      if (file) {
        URL.revokeObjectURL(file.url);
      }
      for (const prepared of preparedRef.current.values()) {
        URL.revokeObjectURL(prepared.previewUrl);
      }
      preparedRef.current.clear();
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
      if (modeRef.current === 'stream' && role === 'host') {
        clientRef.current?.publishSource(
          {
            mode: 'stream',
            fileName: file.name,
            size: file.size,
            duration: duration || 0,
          },
          sample,
        );
        void startHostStream(localRef.current?.video() ?? null, file, duration);
        setLocalView((current) => ({
          ...current,
          found: true,
          duration: duration || current.duration,
        }));
        return;
      }
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
    [applyStateToLocal, identity.userId, role, startHostStream],
  );

  const onPlayed = useCallback(() => {
    streamEngineRef.current?.resumeAudio();
  }, []);

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
  const roomFull = snapshot.members.length >= snapshot.limit;
  const streamViewer = snapshot.mode === 'stream' && !selfHost;

  const moderateKick = (userId: string) => {
    if (clientRef.current?.kick(userId)) {
      notifyRef.current('Участник исключён');
    }
  };

  const moderateBan = (userId: string, scope: 'session' | 'forever') => {
    const until = scope === 'session' ? Date.now() + BAN_SESSION_MS : undefined;
    if (clientRef.current?.ban(userId, 'host-ban', until)) {
      blockedRef.current.add(userId);
      notifyRef.current(
        scope === 'forever' ? 'Участник забанен навсегда' : 'Участник забанен на сессию',
      );
    }
  };

  const moderateMute = (userId: string) => {
    clientRef.current?.requestMute(userId);
    notifyRef.current('Запрос на мут отправлен');
  };

  const moderateTransfer = (userId: string) => {
    clientRef.current?.transferHost(userId);
    setModerationOpen(false);
    notifyRef.current('Хост передан участнику');
  };

  const updateMeta = (patch: RoomMetaPayload) => {
    if (!clientRef.current?.updateRoomMeta(patch)) {
      notifyRef.current('Не удалось изменить настройки комнаты');
    }
  };

  const closeRoom = () => {
    clientRef.current?.closeRoom();
    setModerationOpen(false);
  };

  const acceptJoin = (userId: string) => {
    clientRef.current?.acceptJoin(userId);
  };

  const denyJoin = (userId: string) => {
    clientRef.current?.denyJoin(userId);
  };

  // Карточка в лобби живёт фоном, пока комната открыта и есть места (§4.8).
  useEffect(() => {
    if (!selfHost || snapshot.phase !== 'joined' || snapshot.closed || roomFull) {
      const publisher = lobbyRef.current;
      lobbyRef.current = null;
      if (publisher) {
        if (snapshot.closed || roomFull) {
          publisher.remove();
        } else {
          publisher.stop();
        }
      }
      return;
    }
    if (!lobbyRef.current) {
      const publisher = new LobbyPublisher({
        identity,
        connect: (strategy) => connectTrystero(strategy, LOBBY_ROOM_ID),
        onEvent: (event) => {
          if (event.type === 'error') {
            notifyRef.current(event.message);
          }
        },
        card: () => {
          const state = useRoomStore.getState();
          return {
            code,
            title: state.title || `Комната ${code}`,
            mode: state.mode,
            closed: state.closed,
            limit: state.limit,
            count: state.members.length,
            hasPassword: Boolean(password),
            knock: state.knock,
            hostUserId: identity.userId,
          };
        },
      });
      lobbyRef.current = publisher;
      void publisher.start();
      return;
    }
    lobbyRef.current.update();
  }, [
    selfHost,
    snapshot.phase,
    snapshot.closed,
    snapshot.members.length,
    snapshot.limit,
    snapshot.title,
    roomFull,
    identity,
    code,
    password,
  ]);

  const hostViewers = Math.max(0, snapshot.members.length - 1);
  const streamFile =
    streamInfo?.fileName ?? snapshot.playback?.src.fileName ?? localFile?.name ?? null;
  const streamPlayback = snapshot.playback;
  const streamTime =
    streamPlayback && streamPlayback.src.mode === 'stream'
      ? projectState(streamPlayback, snapshot.stateReceivedAt || Date.now(), Date.now())
      : 0;
  const view: PlaybackView =
    snapshot.mode === 'site'
      ? {
          found: siteVideo.found,
          playing: siteVideo.playing,
          time: siteVideo.time,
          duration: siteVideo.duration,
          rate: siteVideo.rate,
        }
      : snapshot.mode === 'stream'
        ? {
            found: remoteStream !== null || streamStarted || Boolean(localFile),
            playing: streamViewer
              ? remotePlaying || streamPlayback?.playing === true
              : localView.playing,
            time: streamViewer ? streamTime : localView.time,
            duration: streamPlayback?.src.duration ?? localView.duration,
            rate: streamPlayback?.rate ?? localView.rate,
          }
        : localView;

  const found =
    snapshot.mode === 'site'
      ? siteVideo.found
      : snapshot.mode === 'stream'
        ? streamViewer
          ? remoteStream !== null
          : Boolean(localFile) && localView.found
        : Boolean(localFile) && localView.found;
  const label =
    snapshot.mode === 'site'
      ? siteVideo.found
        ? siteVideo.playing
          ? 'Играет'
          : 'Пауза'
        : 'Видео не найдено'
      : snapshot.mode === 'stream'
        ? streamViewer
          ? streamFile ?? (streamStopped ? 'Раздача остановлена' : 'Ждём файл хоста')
          : streamFile ?? 'Файл не выбран'
        : localFile
          ? localFile.name
          : 'Файл не выбран';

  // Экран не гаснет, пока комната открыта и идёт воспроизведение (этап 4).
  useEffect(() => {
    void setKeepScreenOn(snapshot.phase === 'joined' && view.playing);
  }, [snapshot.phase, view.playing]);

  // Акцент: пауза — это отсутствие кадра, поэтому сразу мятный. Здесь же
  // держим актуальные «играем/микрофон» для тика статистики.
  useEffect(() => {
    playingRef.current = view.playing;
    micOnRef.current = voiceActive && !voiceMuted;
    if (!view.playing) {
      pushNoFrame();
    }
  }, [view.playing, voiceActive, voiceMuted]);

  // Новая подсказка age-gate снова показывается, даже если прошлую скрыли.
  useEffect(() => {
    setAgeGateHidden(false);
  }, [site.status.ageGate?.at]);

  const applyAndReport = (action: PlaybackAction) => {
    if (!found || streamViewer) {
      return;
    }
    if (snapshot.mode === 'site') {
      siteRef.current.applyPlayback(action);
    } else if (snapshot.mode === 'stream') {
      // Хост управляет своим файлом: пауза и seek меняют сам видеопоток.
      localRef.current?.apply(action);
      setLocalView((current) => ({
        ...current,
        playing:
          action.kind === 'play' ? true : action.kind === 'pause' ? false : current.playing,
        time: action.kind === 'seek' ? (action.t ?? current.time) : current.time,
        rate: action.kind === 'rate' ? (action.rate ?? current.rate) : current.rate,
      }));
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

  // Кнопки PiP и уведомления вызывают те же обработчики, что и панель.
  pipHandlers.current = { toggle: togglePlay, mic: toggleMic, leave };

  // Возврат из фона/PiP: если система поставила видео на паузу, продолжаем.
  resumePlaybackRef.current = () => {
    if (useRoomStore.getState().phase !== 'joined') {
      return;
    }
    if (modeRef.current === 'site') {
      const video = siteRef.current.status.video;
      if (video.playing || !video.found) {
        return;
      }
      siteRef.current.applyPlayback({ kind: 'play' });
      reportAction(
        { kind: 'play' },
        { playing: true, time: video.time, rate: video.rate, duration: video.duration },
      );
      return;
    }
    const local = localRef.current;
    if (!local || local.sample().playing) {
      return;
    }
    local.apply({ kind: 'play' });
    reportAction({ kind: 'play' }, { ...local.sample(), playing: true });
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
    if (!client || streamViewer) {
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

  /** Кнопка PiP в шапке: то же, что жест «домой» на Android 12+. */
  const enterPipMode = useCallback(() => {
    void enterPip().then((result) => {
      if (!result.ok) {
        notifyRef.current(result.error ?? 'PiP недоступен на этом устройстве');
        return;
      }
      const chatState = useChatStore.getState();
      chatState.setOpen(false);
      chatState.setEmojiOpen(false);
      setViewerImageId(null);
      setReactionsOpen(false);
    });
  }, []);

  const openSite = (input: string) => {
    if (!selfHost) {
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

  // ---------- Этап 8: видео-окно, полноэкранный поиск и очередь ----------

  const publishQueueState = (items: QueueItem[], index: number): void => {
    const clamped = Math.min(Math.max(0, index), Math.max(0, items.length - 1));
    queueRef.current = items;
    queueIndexRef.current = clamped;
    setQueue(items);
    setQueueIndex(clamped);
    clientRef.current?.publishQueue(items, clamped);
  };

  const addCurrentToQueue = (): void => {
    if (!selfHost) {
      notifyRef.current('Очередью управляет хост');
      return;
    }
    if (!siteRef.current.status.video.found) {
      notifyRef.current('Сначала откройте видео на сайте');
      return;
    }
    const url = urlRef.current;
    if (!/^(https?|file):\/\//i.test(url)) {
      notifyRef.current('Не понял адрес страницы с видео');
      return;
    }
    const title = siteRef.current.status.title || url;
    const rest = queueRef.current.filter((item) => item.url !== url);
    const next = [...rest, { url, title }].slice(-QUEUE_MAX);
    publishQueueState(next, next.length - 1);
    notifyRef.current(`Видео в очереди: ${next.length}`);
  };

  const playQueueIndex = (index: number): void => {
    const item = queueRef.current[index];
    if (!item) {
      return;
    }
    if (!selfHost) {
      notifyRef.current('Очередью управляет хост');
      return;
    }
    queueIndexRef.current = index;
    setQueueIndex(index);
    clientRef.current?.publishQueue(queueRef.current, index);
    roomUrlRef.current = item.url;
    browseRef.current = false;
    setBrowse(false);
    setQueueOpen(false);
    lastWindowSig.current = '';
    void siteRef.current.openUrl(item.url).then(() => {
      clientRef.current?.publishSiteUrl(item.url);
    });
    notifyRef.current(`Играем: ${item.title}`);
  };

  const nextInQueue = (auto = false): void => {
    const items = queueRef.current;
    if (!selfHost || items.length === 0) {
      return;
    }
    const current = items.findIndex((item) => item.url === urlRef.current);
    const base = current >= 0 ? current : queueIndexRef.current;
    if (base + 1 < items.length) {
      playQueueIndex(base + 1);
    } else if (!auto) {
      notifyRef.current('Очередь закончилась');
    }
  };
  nextQueueRef.current = () => nextInQueue(true);

  const removeQueueIndex = (index: number): void => {
    if (!selfHost) {
      return;
    }
    const items = queueRef.current.filter((_, itemIndex) => itemIndex !== index);
    let active = queueIndexRef.current;
    if (index < active) {
      active -= 1;
    }
    if (active >= items.length) {
      active = Math.max(0, items.length - 1);
    }
    publishQueueState(items, active);
  };

  const clearQueue = (): void => {
    if (!selfHost) {
      return;
    }
    publishQueueState([], 0);
  };

  const searchSite = (query: string): void => {
    if (!selfHost) {
      notifyRef.current('Ссылку выбирает хост комнаты');
      return;
    }
    const text = query.trim();
    const url = text ? `${GOOGLE_SEARCH_URL}${encodeURIComponent(text)}` : GOOGLE_URL;
    void siteRef.current.openUrl(url);
  };

  const openBrowsePage = (url: string): void => {
    if (!selfHost) {
      notifyRef.current('Ссылку выбирает хост комнаты');
      return;
    }
    void siteRef.current.openUrl(url);
  };

  /** Тап по окну без видео: меню комнаты скрываются, открывается поиск. */
  const enterBrowse = (): void => {
    if (modeRef.current !== 'site') {
      return;
    }
    if (!selfHost) {
      notifyRef.current('Ссылку выбирает хост комнаты');
      return;
    }
    browseStartUrl.current = urlRef.current;
    if (!roomUrlRef.current) {
      roomUrlRef.current = urlRef.current;
    }
    browseRef.current = true;
    setBrowse(true);
    setWindowControls(false);
    setQueueOpen(false);
    setModerationOpen(false);
    setViewerImageId(null);
    setReactionsOpen(false);
    const chatState = useChatStore.getState();
    chatState.setOpen(false);
    chatState.setEmojiOpen(false);
    lastWindowSig.current = '';
    void sendSiteCommand({ cmd: 'setWindow', on: false });
    if (!/^https:\/\/(www\.)?google\./i.test(urlRef.current)) {
      void siteRef.current.openUrl(GOOGLE_URL);
    }
  };

  /** Возврат в комнату из поиска: без выбранного видео — прежняя страница. */
  const exitBrowse = (restore = true): void => {
    if (!browseRef.current) {
      return;
    }
    browseRef.current = false;
    setBrowse(false);
    if (returnTimer.current !== null) {
      window.clearTimeout(returnTimer.current);
      returnTimer.current = null;
    }
    const target = roomUrlRef.current;
    const current = urlRef.current;
    if (restore && target && target !== current && !siteRef.current.status.video.found) {
      void siteRef.current.openUrl(target);
    }
    lastWindowSig.current = '';
  };

  const handleWindowRect = useCallback((rect: VideoWindowRect): void => {
    lastRectRef.current = rect;
    if (modeRef.current !== 'site' || browseRef.current) {
      return;
    }
    const x = Math.round(rect.x);
    const y = Math.round(rect.y);
    const w = Math.round(rect.w);
    const h = Math.round(rect.h);
    if (w <= 0 || h <= 0) {
      return;
    }
    const signature = `${x}:${y}:${w}:${h}`;
    if (signature === lastWindowSig.current) {
      return;
    }
    lastWindowSig.current = signature;
    void sendSiteCommand({
      cmd: 'setWindow',
      on: true,
      x,
      y,
      w,
      h,
      radius: WINDOW_RADIUS,
    });
  }, []);

  const handleWindowTap = (): void => {
    if (!found) {
      enterBrowse();
      return;
    }
    setWindowControls((value) => !value);
    if (controlsTimer.current !== null) {
      window.clearTimeout(controlsTimer.current);
    }
    controlsTimer.current = window.setTimeout(() => {
      controlsTimer.current = null;
      setWindowControls(false);
    }, 4200);
  };

  // PiP: панелей нет — не гоняем зоны касания в Kotlin каждую секунду.
  useEffect(() => {
    setRegionSyncPaused(pipActive);
    return () => setRegionSyncPaused(false);
  }, [pipActive]);

  // Поиск: пока меню скрыто, страница показывается целиком (без рамки окна).
  useEffect(() => {
    if (snapshot.mode !== 'site') {
      return;
    }
    if (browse) {
      lastWindowSig.current = '';
      void sendSiteCommand({ cmd: 'setWindow', on: false });
    }
  }, [browse, snapshot.mode]);

  // Новая страница (навигация) теряет frame-класс: ставим окно заново.
  useEffect(() => {
    if (browse || snapshot.mode !== 'site') {
      return;
    }
    const timer = window.setTimeout(() => {
      const rect = lastRectRef.current;
      if (!rect) {
        return;
      }
      lastWindowSig.current = '';
      handleWindowRect(rect);
    }, 900);
    return () => window.clearTimeout(timer);
  }, [site.status.url, site.status.hookReady, browse, snapshot.mode, handleWindowRect]);

  // После PiP возвращаем окно: системный слой мог перерисовать страницу.
  useEffect(() => {
    if (!pipActive) {
      lastWindowSig.current = '';
    }
  }, [pipActive]);

  // Хост публикует очередь при смене состава: поздний гость получит актуальный
  // список (welcome его не несёт).
  useEffect(() => {
    if (!selfHost || snapshot.mode !== 'site' || snapshot.phase !== 'joined') {
      return;
    }
    clientRef.current?.publishQueue(queueRef.current, queueIndexRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selfHost, snapshot.mode, snapshot.phase, snapshot.members.length]);

  // Уход из комнаты: снимаем рамку страницы, чтобы сайт не остался обрезанным.
  useEffect(
    () => () => {
      if (returnTimer.current !== null) {
        window.clearTimeout(returnTimer.current);
      }
      if (controlsTimer.current !== null) {
        window.clearTimeout(controlsTimer.current);
      }
      void sendSiteCommand({ cmd: 'setWindow', on: false });
    },
    [],
  );

  const driverName =
    snapshot.driverId === identity.userId
      ? 'Ведёте вы'
      : snapshot.driverId
        ? `Ведёт ${snapshot.members.find((member) => member.userId === snapshot.driverId)?.name ?? 'друг'}`
        : undefined;

  const waiting = snapshot.phase === 'connecting' || snapshot.phase === 'reconnecting';
  const lastMessage = chat.messages.length > 0 ? (chat.messages[chat.messages.length - 1] ?? null) : null;
  const typingNames = Object.values(chat.typing).map((peer) => peer.name);
  const speakingNames = Object.values(speaking);
  const viewerUrl = viewerImageId ? chat.images[viewerImageId] : undefined;

  return (
    <div
      className={`hw-app hw-app--room hw-app--${snapshot.mode}${
        pipActive ? ' hw-app--pip' : ''
      }${browse ? ' hw-app--browsing' : ''}`}
    >
      {!pipActive && !browse && (
        <RoomBar
          code={code}
          title={snapshot.title}
          role={role}
          mode={snapshot.mode}
          phase={snapshot.phase}
          strategy={snapshot.strategy}
          peerCount={snapshot.peerCount}
          members={snapshot.members}
          limit={snapshot.limit}
          closed={snapshot.closed}
          knock={snapshot.knock}
          pendingCount={snapshot.joinRequests.length}
          selfUserId={identity.userId}
          hostUserId={snapshot.hostUserId}
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
          onOpenMembers={() => setModerationOpen((value) => !value)}
          onPip={enterPipMode}
          pipAvailable={pipSupported && settings.pipEnabled}
        />
      )}

      {!pipActive && !browse && selfHost && (
        <JoinRequests
          requests={snapshot.joinRequests}
          onAccept={acceptJoin}
          onDeny={denyJoin}
        />
      )}

      {!pipActive && !browse && snapshot.mode === 'stream' && role === 'host' && (
        <div className="hw-streambar" aria-live="polite">
          <Icon name="broadcast" size={16} />
          <span className="hw-streambar-text">
            {streamStatusLine({
              streaming: hostStreaming,
              viewers: hostViewers,
              error: streamError,
            })}
          </span>
          <span className="hw-streambar-hint">
            {hostStreaming
              ? `${captureLabel(streamInfo?.capture ?? null)} · до ${STREAM_MAX_VIEWERS} зрителей`
              : 'Выберите файл — зрители получат видео напрямую'}
          </span>
        </div>
      )}

      {!pipActive && !browse && snapshot.mode === 'site' && (
        <TopBar
          status={site.status}
          zonesOpen={zonesOpen}
          onOpen={openSite}
          onTestPage={() => {
            if (selfHost) {
              void siteRef.current.openUrl(TEST_PAGE_URL);
              clientRef.current?.publishSiteUrl(TEST_PAGE_URL);
            }
          }}
          onYoutube={() => {
            if (selfHost) {
              void siteRef.current.openUrl(YOUTUBE_URL);
              clientRef.current?.publishSiteUrl(YOUTUBE_URL);
            }
          }}
          onNav={site.nav}
          onToggleZones={onToggleZones}
          onSearch={enterBrowse}
          onQueue={() => setQueueOpen(true)}
          queueCount={queue.length}
          compact
          addressLocked={!selfHost}
        />
      )}

      <div className={`hw-mid${pipActive ? ' hw-mid--pip' : ''}`}>
        {snapshot.mode === 'site' ? (
          <main className={`hw-stage${browse ? ' hw-stage--browse' : ''}`}>
            {!pipActive && !browse && waiting && (
              <div className="hw-roomwait" data-hw-region="roomwait">
                <span className="hw-spinner" aria-hidden="true" />
                <strong>
                  {snapshot.phase === 'reconnecting'
                    ? 'Переподключаемся…'
                    : 'Подключаемся к комнате'}
                </strong>
                <span>Код {code}. Сайт откроется, когда хост ответит.</span>
              </div>
            )}
            {!pipActive && !browse && !waiting && (
              <VideoWindow
                found={siteVideo.found}
                playing={view.playing}
                time={view.time}
                duration={view.duration}
                title={site.status.title || siteVideo.src}
                isHost={selfHost}
                viewOnly={false}
                controlsOpen={windowControls}
                queueCount={queue.length}
                browserAvailable={selfHost}
                onRect={handleWindowRect}
                onTap={handleWindowTap}
                onToggleControls={() => setWindowControls((value) => !value)}
                onTogglePlay={togglePlay}
                onSeekTo={(seconds) => applyAndReport({ kind: 'seek', t: seconds })}
                onSeekBy={seekBy}
                onSearch={enterBrowse}
                onQueue={() => setQueueOpen(true)}
                onAddToQueue={addCurrentToQueue}
              />
            )}
          </main>
        ) : snapshot.mode === 'stream' && streamViewer ? (
          <RemoteStreamPlayer
            ref={remoteRef}
            stream={remoteStream}
            fileName={streamFile ?? undefined}
            started={streamStarted}
            stopped={streamStopped}
            error={streamError}
            hostName={
              snapshot.members.find((member) => member.userId === snapshot.hostUserId)?.name
            }
            onNotice={(text) => notifyRef.current(text)}
            onVideoState={(state) => {
              setRemotePlaying(state.playing);
              setRemoteDimensions((current) =>
                current.width === state.width && current.height === state.height
                  ? current
                  : { width: state.width, height: state.height },
              );
            }}
          />
        ) : (
          <LocalPlayer
            ref={localRef}
            src={localFile?.url ?? null}
            fileName={localFile?.name ?? null}
            variant={snapshot.mode === 'stream' ? 'stream' : 'local'}
            streaming={hostStreaming}
            viewers={hostViewers}
            onPick={pickFile}
            onMetadata={onMetadata}
            onProgress={onProgress}
            onUserAction={onLocalUserAction}
            onPlayed={onPlayed}
            onNotice={(text) => notifyRef.current(text)}
          />
        )}

        {!pipActive && !browse && chat.open && (
          <ChatPanel
            messages={chat.messages}
            images={chat.images}
            transfers={chat.transfers}
            typingNames={typingNames}
            draft={chat.draft}
            emojiOpen={chat.emojiOpen}
            recents={chat.recents}
            saveHistory={chat.saveHistory}
            notice={chat.notice}
            onDraft={onDraft}
            onSend={sendChat}
            onClose={() => useChatStore.getState().setOpen(false)}
            onPhoto={onPhoto}
            onRetry={onRetryImage}
            onCancelTransfer={onCancelTransfer}
            onOpenImage={(id) => setViewerImageId(id)}
            onEmoji={onEmoji}
            onReact={sendReaction}
            onToggleEmoji={() => useChatStore.getState().setEmojiOpen(!chat.emojiOpen)}
            onToggleSaveHistory={toggleSaveHistory}
          />
        )}
      </div>

      {!pipActive && !browse && (
        <FloatingReactions
          reactions={chat.reactions}
          onDone={(key) => useChatStore.getState().dropReaction(key)}
        />
      )}

      {!pipActive &&
        !browse &&
        settings.ageGate &&
        site.status.ageGate?.detected &&
        !ageGateHidden && (
        <div className="hw-agegate" data-hw-region="agegate">
          <Icon name="lock" size={18} />
          <div className="hw-agegate-text">
            <strong>Сайт просит подтвердить возраст</strong>
            <p>
              HeliWatch не обходит возрастные ограничения. Войдите в аккаунт в окне
              сайта или откройте это видео в браузере.
            </p>
          </div>
          <button
            type="button"
            className="hw-iconbtn hw-iconbtn--small"
            onClick={() => setAgeGateHidden(true)}
            aria-label="Скрыть подсказку"
          >
            <Icon name="close" size={16} />
          </button>
        </div>
      )}

      {!pipActive && !browse && (
        <ChatDock
          lastMessage={lastMessage}
          unread={chat.unread}
          open={chat.open}
          reactionsOpen={reactionsOpen}
          voice={{
            supported: isVoiceSupported(),
            active: voiceActive,
            muted: voiceMuted,
            level: voiceLevel,
            speaking: speakingNames,
            busy: voiceBusy,
          }}
          onOpen={() => {
            const store = useChatStore.getState();
            store.setOpen(!store.open);
            if (store.open) {
              setReactionsOpen(false);
            }
          }}
          onToggleReactions={() => setReactionsOpen((value) => !value)}
          onReaction={sendReaction}
          onToggleMic={toggleMic}
        />
      )}

      {!pipActive && !browse && (
        <BottomBar
          view={view}
          label={label}
          mode={snapshot.mode}
          collapsed={collapsed}
          onToggleCollapsed={() => setCollapsed((value) => !value)}
          onTogglePlay={togglePlay}
          onSeek={seekBy}
          onSeekTo={(seconds) => applyAndReport({ kind: 'seek', t: seconds })}
          onRate={setRate}
          onReload={site.reload}
          onSyncToMe={syncToMe}
          canSync={snapshot.phase === 'joined' && found}
          viewOnly={streamViewer}
          driverLabel={driverName}
        />
      )}

      {pipActive && (
        <PipLayer
          message={pipMessageLine(lastMessage)}
          micOn={voiceActive && !voiceMuted}
          startedAt={sessionStartedAt.current}
        />
      )}

      {!pipActive && browse && (
        <BrowseOverlay
          url={site.status.url}
          title={site.status.title}
          found={siteVideo.found}
          playing={siteVideo.playing}
          onBack={() => exitBrowse(true)}
          onSearch={searchSite}
          onGoogle={() => openBrowsePage(GOOGLE_URL)}
          onYoutube={() => openBrowsePage(YOUTUBE_URL)}
          onWatchHere={() => exitBrowse(false)}
          onAddToQueue={addCurrentToQueue}
        />
      )}

      {!pipActive && (
        <RoomQueue
          open={queueOpen}
          items={queue}
          index={queueIndex}
          canEdit={selfHost}
          currentUrl={site.status.url}
          onClose={() => setQueueOpen(false)}
          onPlay={playQueueIndex}
          onRemove={removeQueueIndex}
          onAddCurrent={addCurrentToQueue}
          onClear={clearQueue}
        />
      )}

      {!pipActive && viewerImageId && viewerUrl && (
        <ImageViewer url={viewerUrl} onClose={() => setViewerImageId(null)} />
      )}

      {!pipActive && (
        <ModerationPanel
          open={moderationOpen}
          members={snapshot.members}
          selfUserId={identity.userId}
          hostUserId={snapshot.hostUserId}
          canModerate={selfHost}
          title={snapshot.title}
          limit={snapshot.limit}
          closed={snapshot.closed}
          knock={snapshot.knock}
          mode={snapshot.mode}
          pendingCount={snapshot.joinRequests.length}
          onClose={() => setModerationOpen(false)}
          onKick={moderateKick}
          onBan={moderateBan}
          onMute={moderateMute}
          onTransfer={moderateTransfer}
          onMeta={updateMeta}
          onCloseRoom={closeRoom}
        />
      )}

      <RemoteAudio streams={remoteStreams} volume={settings.voiceVolume} />

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
