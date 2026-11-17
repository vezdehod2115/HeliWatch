/*
 * Личные сообщения (этап 7): отдельный экран и отдельное хранилище.
 *
 * Пока открыт диалог и включена настройка «Парная комната друзей», приложение
 * держит фиксированную комнату `dm-<hash(пары)>` — сообщения и фото доходят
 * сразу. Без неё текст всё равно сохраняется и уходит в outbox, а доставится
 * при следующей встрече в комнате. Чат комнаты и личка нигде не смешиваются.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { PageHeader } from '../../app/PageHeader';
import { Icon } from '../../app/icons';
import { formatClock, relativeTime } from '../../app/time';
import type { LocalProfile } from '../../db/repo/identity';
import { attachDmImage, type DmMessage } from '../../db/repo/dm';
import { mediaImageUrl, saveMediaImage } from '../../db/repo/media';
import type { Identity } from '../../net/identity';
import { DmChannels, type PairImageEvent } from '../../net/dmChannels';
import { markConversationRead, rememberIncomingDmImage } from '../../net/dm';
import { useDmStore } from '../../stores/dm';
import { useFriendsStore } from '../../stores/friends';
import { useSettingsStore } from '../../stores/settings';
import { prepareImage } from '../chat/imagePrep';
import { ImageViewer } from '../chat/ImageViewer';
import { Avatar } from '../profile/Avatar';

interface DmScreenProps {
  identity: Identity;
  profile: LocalProfile;
  initialPeerUserId: string | null;
  onBack: () => void;
  onOpenFriends: () => void;
  notify: (text: string) => void;
}

const PEER_NAMES_FALLBACK = 'Друг';

export function DmScreen({
  identity,
  profile,
  initialPeerUserId,
  onBack,
  onOpenFriends,
  notify,
}: DmScreenProps) {
  const peers = useDmStore((state) => state.peers);
  const activePeer = useDmStore((state) => state.activePeer);
  const messages = useDmStore((state) => state.messages);
  const images = useDmStore((state) => state.images);
  const transfers = useDmStore((state) => state.transfers);
  const draft = useDmStore((state) => state.draft);
  const setDraft = useDmStore((state) => state.setDraft);
  const loadPeers = useDmStore((state) => state.loadPeers);
  const openPeer = useDmStore((state) => state.openPeer);
  const closePeer = useDmStore((state) => state.closePeer);
  const reloadActive = useDmStore((state) => state.reloadActive);
  const setImageUrl = useDmStore((state) => state.setImageUrl);
  const setTransfer = useDmStore((state) => state.setTransfer);
  const clearTransfer = useDmStore((state) => state.clearTransfer);

  const friends = useFriendsStore((state) => state.friends);
  const unread = useFriendsStore((state) => state.unread);
  const refreshFriends = useFriendsStore((state) => state.refresh);
  const pairRoomEnabled = useSettingsStore((state) => state.dmPairRoom);

  const [pairOnline, setPairOnline] = useState(false);
  const [pairPhase, setPairPhase] = useState<'idle' | 'connecting' | 'online' | 'error' | 'closed'>(
    'idle',
  );
  const [photoBusy, setPhotoBusy] = useState(false);
  const [viewerPath, setViewerPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const channelsRef = useRef<DmChannels | null>(null);
  const photoInput = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const activePeerRef = useRef<string | null>(null);
  activePeerRef.current = activePeer;

  const friendOf = (userId: string) => friends.find((item) => item.userId === userId);

  // Каналы создаём один раз: даже без парной комнаты нужен локальный транспорт,
  // который подписывает и кладёт сообщения в outbox.
  useEffect(() => {
    const channels = new DmChannels({
      identity,
      profile,
      notify,
      onChange: () => {
        void reloadActive();
        void loadPeers();
        // Пока диалог открыт, входящее сразу считается прочитанным.
        const peerId = activePeerRef.current;
        if (peerId) {
          void markConversationRead(peerId).then(() => refreshFriends());
        } else {
          void refreshFriends();
        }
      },
      onPairPhase: (phase) => {
        setPairPhase(phase);
        if (phase === 'online' || phase === 'closed' || phase === 'error') {
          setPairOnline(channelsRef.current?.pairOnline === true);
        }
      },
      onImage: (event) => {
        void handleImageEvent(event);
      },
    });
    channelsRef.current = channels;
    void loadPeers();
    return () => {
      channels.dispose();
      channelsRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity.userId]);

  const handleImageEvent = useCallback(
    async (event: PairImageEvent): Promise<void> => {
      if (event.type === 'image-start' || event.type === 'image-progress') {
        setTransfer({
          id: event.info.id,
          direction: 'in',
          progress: event.info.received,
          total: event.info.size,
        });
        return;
      }
      if (event.type === 'image-error') {
        clearTransfer(event.id);
        notify('Фото в личке не доставлено');
        return;
      }
      if (event.type !== 'image') {
        return;
      }
      clearTransfer(event.id);
      const saved = await saveMediaImage(event.bytes, event.mime, event.w, event.h);
      if (!saved) {
        notify('Фото пришло, но файловый кэш недоступен');
        return;
      }
      rememberIncomingDmImage(event.id, saved.path);
      await attachDmImage(event.id, saved.path);
      const url = await mediaImageUrl(saved.path);
      if (url) {
        setImageUrl(saved.path, url);
      }
      await reloadActive();
      await loadPeers();
      await refreshFriends();
    },
    [clearTransfer, loadPeers, notify, refreshFriends, reloadActive, setImageUrl, setTransfer],
  );

  const openConversation = useCallback(
    async (peerUserId: string): Promise<void> => {
      setError(null);
      await openPeer(peerUserId);
      await markConversationRead(peerUserId);
      await refreshFriends();
      const channels = channelsRef.current;
      if (channels && pairRoomEnabled) {
        await channels.startPair(peerUserId);
        setPairOnline(channels.pairOnline);
      }
    },
    [openPeer, pairRoomEnabled, refreshFriends],
  );

  useEffect(() => {
    if (!initialPeerUserId) {
      return;
    }
    void openConversation(initialPeerUserId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialPeerUserId]);

  // Парная комната привязана к открытому диалогу и настройке.
  useEffect(() => {
    const channels = channelsRef.current;
    if (!channels) {
      return;
    }
    if (!activePeer || !pairRoomEnabled) {
      channels.stopPair();
      setPairOnline(false);
      setPairPhase('idle');
      return;
    }
    let alive = true;
    void channels.startPair(activePeer).then(() => {
      if (alive) {
        setPairOnline(channels.pairOnline);
      }
    });
    return () => {
      alive = false;
    };
  }, [activePeer, pairRoomEnabled]);

  // Присутствие друга меняется по событиям канала: обновляем раз в секунду,
  // чтобы подпись «онлайн/офлайн» не врала между событиями.
  useEffect(() => {
    if (!activePeer || !pairRoomEnabled) {
      return;
    }
    const timer = window.setInterval(() => {
      setPairOnline(channelsRef.current?.pairOnline === true);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [activePeer, pairRoomEnabled]);

  useEffect(() => {
    const list = listRef.current;
    if (list) {
      list.scrollTop = list.scrollHeight;
    }
  }, [messages.length, activePeer]);

  const send = async (): Promise<void> => {
    const peer = activePeer;
    const channels = channelsRef.current;
    const text = draft.trim();
    if (!peer || !channels || !text) {
      return;
    }
    setDraft('');
    const id = await channels.sendText(peer, text);
    if (!id) {
      setDraft(text);
      setError('Не удалось отправить сообщение');
      return;
    }
    setError(null);
    await reloadActive();
    await loadPeers();
  };

  const sendPhoto = async (file: File): Promise<void> => {
    const peer = activePeer;
    const channels = channelsRef.current;
    if (!peer || !channels) {
      return;
    }
    if (!channels.pairOnline) {
      notify(
        pairRoomEnabled
          ? 'Друг не на связи — фото отправится, когда он появится'
          : 'Фото в личку отправляются в парной комнате: включите её в настройках',
      );
      return;
    }
    setPhotoBusy(true);
    try {
      const prepared = await prepareImage(file);
      const saved = await saveMediaImage(prepared.bytes, prepared.mime, prepared.w, prepared.h);
      const id = await channels.sendPhoto(
        peer,
        {
          bytes: prepared.bytes,
          mime: prepared.mime,
          w: prepared.w,
          h: prepared.h,
          imagePath: saved?.path ?? null,
        },
        (sent, total) => {
          setTransfer({ id: `out-${peer}`, direction: 'out', progress: sent, total });
        },
      );
      clearTransfer(`out-${peer}`);
      URL.revokeObjectURL(prepared.previewUrl);
      if (!id) {
        notify('Фото не отправлено — друг отключился');
      }
      await reloadActive();
      await loadPeers();
    } catch (caught) {
      notify(caught instanceof Error ? caught.message : 'Не удалось подготовить фото');
    } finally {
      setPhotoBusy(false);
    }
  };

  const peer = activePeer ? friendOf(activePeer) : null;
  const presence = !pairRoomEnabled
    ? 'парная комната выключена — доставка при встрече'
    : pairOnline
      ? 'онлайн — сообщения доставляются сразу'
      : pairPhase === 'connecting'
        ? 'подключаемся…'
        : 'офлайн — доставим при встрече';
  const statusLabel = (message: DmMessage): string => {
    if (message.dir === 'in') {
      return formatClock(message.ts);
    }
    if (message.status === 'delivered') {
      return `${formatClock(message.ts)} · доставлено`;
    }
    if (message.status === 'sent') {
      return `${formatClock(message.ts)} · отправлено`;
    }
    return `${formatClock(message.ts)} · ждёт встречи`;
  };

  if (!activePeer) {
    return (
      <div className="hw-screen" data-hw-region="dm">
        <PageHeader
          title="Личные сообщения"
          subtitle={peers.length > 0 ? `${peers.length} диалогов` : 'Пока пусто'}
          onBack={onBack}
          right={
            <button
              type="button"
              className="hw-iconbtn"
              onClick={onOpenFriends}
              aria-label="Друзья"
            >
              <Icon name="users" size={20} />
            </button>
          }
        />
        <div className="hw-screen-scroll">
          {peers.length === 0 ? (
            <div className="hw-card">
              <div className="hw-card-head">
                <Icon name="chat" size={18} />
                <h2>Ни одного диалога</h2>
              </div>
              <p className="hw-note">
                Здесь только личка с друзьями — она не смешивается с чатом комнаты.
                Добавьте друга и начните переписку: без сервера сообщения дождутся
                встречи.
              </p>
              <button type="button" className="hw-primary" onClick={onOpenFriends}>
                Перейти к друзьям
              </button>
            </div>
          ) : (
            <ul className="hw-dmlist">
              {peers.map((entry) => {
                const info = friendOf(entry.peerUserId);
                const unreadCount = unread[entry.peerUserId] ?? 0;
                const last = entry.lastMessage;
                return (
                  <li key={entry.peerUserId}>
                    <button
                      type="button"
                      className="hw-dmpeer"
                      onClick={() => void openConversation(entry.peerUserId)}
                    >
                      <Avatar
                        hash={info?.avatarHash ?? null}
                        name={info?.displayName ?? PEER_NAMES_FALLBACK}
                        color={info?.nameColor ?? '#6ff0c4'}
                      />
                      <span className="hw-dmpeer-main">
                        <strong>{info?.displayName ?? PEER_NAMES_FALLBACK}</strong>
                        <span>
                          {last
                            ? last.kind === 'image'
                              ? 'фото'
                              : last.body.slice(0, 64)
                            : 'нет сообщений'}
                        </span>
                      </span>
                      <span className="hw-dmpeer-side">
                        <span>{last ? relativeTime(last.ts) : ''}</span>
                        {unreadCount > 0 ? <span className="hw-unread">{unreadCount}</span> : null}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="hw-screen hw-screen--dm" data-hw-region="dm">
      <PageHeader
        title={peer?.displayName ?? PEER_NAMES_FALLBACK}
        subtitle={presence}
        onBack={() => {
          closePeer();
          void loadPeers();
        }}
        right={
          <span className={`hw-presence${pairOnline ? ' is-online' : ''}`}>
            <span className="hw-dot" />
            {pairOnline ? 'на связи' : 'офлайн'}
          </span>
        }
      />

      <div className="hw-dmthread" ref={listRef}>
        {messages.length === 0 ? (
          <p className="hw-chatempty">
            Сообщения видны только вам и другу. Без парной комнаты они уйдут в
            outbox и доставятся при следующей встрече.
          </p>
        ) : (
          messages.map((message) => {
            const self = message.dir === 'out';
            const imageUrl = message.imagePath ? images[message.imagePath] : undefined;
            const progress = transfers[`out-${message.peerUserId}`];
            return (
              <div key={message.id} className={`hw-dmmsg${self ? ' is-self' : ''}`}>
                <div className={`hw-dmbubble${message.status === 'pending' ? ' is-pending' : ''}`}>
                  {message.kind === 'image' ? (
                    imageUrl ? (
                      <button
                        type="button"
                        className="hw-msgimage"
                        onClick={() => setViewerPath(message.imagePath)}
                      >
                        <img src={imageUrl} alt="Фото" />
                      </button>
                    ) : (
                      <span className="hw-msgimage-pending">Фото загружается…</span>
                    )
                  ) : (
                    <span className="hw-msgtext">{message.body}</span>
                  )}
                  <span className="hw-msg-time">{statusLabel(message)}</span>
                  {self && progress ? (
                    <span className="hw-msg-progress">
                      <span
                        style={{
                          width: `${Math.min(100, Math.round((progress.progress / Math.max(1, progress.total)) * 100))}%`,
                        }}
                      />
                    </span>
                  ) : null}
                </div>
              </div>
            );
          })
        )}
      </div>

      {error ? <p className="hw-formerror hw-dmerror">{error}</p> : null}

      <form
        className="hw-composer hw-dmcomposer"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <input
          ref={photoInput}
          type="file"
          accept="image/*"
          className="hw-fileinput"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (file) {
              void sendPhoto(file);
            }
          }}
        />
        <button
          type="button"
          className="hw-iconbtn hw-iconbtn--dock"
          onClick={() => photoInput.current?.click()}
          disabled={photoBusy}
          aria-label="Отправить фото"
        >
          <Icon name="photo" size={20} />
        </button>
        <textarea
          className="hw-chatinput"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              void send();
            }
          }}
          rows={1}
          maxLength={4000}
          placeholder="Сообщение другу"
          aria-label="Текст личного сообщения"
        />
        <button type="submit" className="hw-send" disabled={!draft.trim()} aria-label="Отправить">
          <Icon name="send" size={19} />
        </button>
      </form>

      {viewerPath && images[viewerPath] ? (
        <ImageViewer url={images[viewerPath]!} onClose={() => setViewerPath(null)} />
      ) : null}
    </div>
  );
}
