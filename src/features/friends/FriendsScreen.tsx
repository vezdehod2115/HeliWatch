/*
 * Экран «Друзья» (этап 7): приглашение по ссылке, заявки и список друзей.
 *
 * Приглашение работает без сервера: приглашающий держит комнату
 * `invite-<hash(userId)>`, пока экран открыт, а открывший ссылку отправляет
 * подписанную заявку. Если кто-то не на связи, заявка ложится в outbox и
 * доставится при следующей встрече — поэтому «Отправлено» здесь честное.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { PageHeader } from '../../app/PageHeader';
import { Icon } from '../../app/icons';
import { relativeTime } from '../../app/time';
import type { LocalProfile } from '../../db/repo/identity';
import { friendInviteLink, parseFriendInput } from '../../net/protocol';
import { fingerprintOf, type Identity } from '../../net/identity';
import { DmChannels } from '../../net/dmChannels';
import { dropFriendRequest } from '../../net/dm';
import { useFriendsStore } from '../../stores/friends';
import { useSettingsStore } from '../../stores/settings';
import { setFriendBlocked } from '../../db/repo/friends';
import { Avatar } from '../profile/Avatar';

interface FriendsScreenProps {
  identity: Identity;
  profile: LocalProfile;
  /** userId из deep link `heliwatch://f/...`: подставляем в поле. */
  initialInviteUserId: string | null;
  onBack: () => void;
  onOpenDm: (userId: string) => void;
  onOpenProfile: () => void;
  notify: (text: string) => void;
}

export function FriendsScreen({
  identity,
  profile,
  initialInviteUserId,
  onBack,
  onOpenDm,
  onOpenProfile,
  notify,
}: FriendsScreenProps) {
  const friends = useFriendsStore((state) => state.friends);
  const requests = useFriendsStore((state) => state.requests);
  const outgoing = useFriendsStore((state) => state.outgoing);
  const unread = useFriendsStore((state) => state.unread);
  const refresh = useFriendsStore((state) => state.refresh);
  const pairRoomEnabled = useSettingsStore((state) => state.dmPairRoom);

  const [linkValue, setLinkValue] = useState('');
  const [addValue, setAddValue] = useState('');
  const [addError, setAddError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [fingerprints, setFingerprints] = useState<Record<string, string>>({});
  const channelsRef = useRef<DmChannels | null>(null);
  const linkRef = useRef<HTMLInputElement>(null);

  const inviteLink = useMemo(() => friendInviteLink(identity.userId), [identity.userId]);

  useEffect(() => {
    const channels = new DmChannels({
      identity,
      profile,
      notify,
      onChange: () => {
        void refresh();
      },
      isBlocked: () => false,
    });
    channelsRef.current = channels;
    void channels.startInvite();
    void refresh();
    return () => {
      channels.dispose();
      channelsRef.current = null;
    };
    // Профиль меняется редко: пересоздавать канал из-за имени не нужно.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity.userId]);

  useEffect(() => {
    if (initialInviteUserId) {
      setAddValue(friendInviteLink(initialInviteUserId));
      linkRef.current?.focus();
    }
  }, [initialInviteUserId]);

  useEffect(() => {
    let alive = true;
    const run = async (): Promise<void> => {
      const entries = await Promise.all(
        friends.map(async (friend) => [friend.userId, await fingerprintOf(friend.userId)] as const),
      );
      if (alive) {
        setFingerprints(Object.fromEntries(entries));
      }
    };
    void run();
    return () => {
      alive = false;
    };
  }, [friends]);

  const copyInvite = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(inviteLink);
      notify('Ссылка-приглашение скопирована');
    } catch {
      setLinkValue(inviteLink);
      notify('Скопируйте ссылку из поля ниже');
    }
  };

  const sendRequest = async (): Promise<void> => {
    const userId = parseFriendInput(addValue);
    if (!userId) {
      setAddError('Нужна ссылка heliwatch://f/… или userId из приглашения');
      return;
    }
    if (userId === identity.userId) {
      setAddError('Это ваша собственная ссылка');
      return;
    }
    if (friends.some((friend) => friend.userId === userId)) {
      setAddError('Этот человек уже у вас в друзьях');
      return;
    }
    const channels = channelsRef.current;
    if (!channels) {
      return;
    }
    setBusy(true);
    setAddError(null);
    try {
      await channels.joinInvite(userId);
      const sent = await channels.requestFriend(userId);
      if (sent) {
        notify('Заявка отправлена — доставим, когда друг будет на связи');
        setAddValue('');
        await refresh();
      } else {
        setAddError('Не удалось создать заявку');
      }
    } finally {
      setBusy(false);
    }
  };

  const acceptRequest = async (userId: string): Promise<void> => {
    const request = requests.find((item) => item.userId === userId);
    const channels = channelsRef.current;
    if (!request || !channels) {
      return;
    }
    const ok = await channels.acceptFriend(userId, {
      name: request.name,
      color: request.color,
      avatarHash: request.avatarHash,
    });
    if (ok) {
      notify(`${request.name} теперь у вас в друзьях`);
      await refresh();
    } else {
      notify('Не удалось подтвердить дружбу');
    }
  };

  const declineRequest = async (userId: string): Promise<void> => {
    await dropFriendRequest(userId);
    await refresh();
  };

  const removeFriend = async (userId: string, name: string): Promise<void> => {
    const channels = channelsRef.current;
    if (!channels) {
      return;
    }
    await channels.removeFriend(userId);
    setRemoving(null);
    notify(`${name} удалён из друзей`);
    await refresh();
  };

  const toggleBlock = async (userId: string, blocked: boolean): Promise<void> => {
    await setFriendBlocked(userId, blocked);
    await refresh();
    notify(
      blocked
        ? 'Друг заблокирован: заявки и личка от него игнорируются'
        : 'Блокировка снята',
    );
  };

  const inviteOnline = channelsRef.current?.inviteOnline === true;

  return (
    <div className="hw-screen" data-hw-region="friends">
      <PageHeader
        title="Друзья"
        subtitle={
          friends.length > 0
            ? `${friends.length} в друзьях${outgoing > 0 ? ` · ${outgoing} ждёт доставки` : ''}`
            : 'Пока никого — пригласите по ссылке'
        }
        onBack={onBack}
        right={
          <button type="button" className="hw-iconbtn" onClick={onOpenProfile} aria-label="Профиль">
            <Icon name="users" size={20} />
          </button>
        }
      />

      <div className="hw-screen-scroll">
        <section className="hw-card">
          <div className="hw-card-head">
            <Icon name="link" size={18} />
            <h2>Пригласить по ссылке</h2>
          </div>
          <p className="hw-note">
            Отправьте ссылку другу любым мессенджером. Пока экран открыт, ваш телефон
            слушает комнату приглашения: как только друг откроет ссылку, заявка придёт
            сюда, и вы подтвердите дружбу.
          </p>
          <div className="hw-invitelink">
            <code>{inviteLink}</code>
          </div>
          <div className="hw-inlineform">
            <button type="button" className="hw-ghost" onClick={() => void copyInvite()}>
              <Icon name="copy" size={15} /> Скопировать
            </button>
            <span className={`hw-presence${inviteOnline ? ' is-online' : ''}`}>
              <span className="hw-dot" />
              {inviteOnline ? 'друг на связи' : 'ждём, пока откроют ссылку'}
            </span>
          </div>
          {linkValue ? <p className="hw-note hw-selectable">{linkValue}</p> : null}
        </section>

        <section className="hw-card">
          <div className="hw-card-head">
            <Icon name="users" size={18} />
            <h2>Добавить по ссылке или коду</h2>
          </div>
          <form
            className="hw-inlineform"
            onSubmit={(event) => {
              event.preventDefault();
              void sendRequest();
            }}
          >
            <input
              ref={linkRef}
              className={`hw-field${addError ? ' is-invalid' : ''}`}
              value={addValue}
              onChange={(event) => {
                setAddValue(event.target.value);
                setAddError(null);
              }}
              placeholder="heliwatch://f/… или userId"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              aria-label="Ссылка-приглашение или userId"
              aria-invalid={Boolean(addError)}
            />
            <button type="submit" className="hw-primary hw-primary--compact" disabled={busy}>
              {busy ? '…' : 'В друзья'}
            </button>
          </form>
          {addError ? <p className="hw-formerror">{addError}</p> : null}
          <p className="hw-note">
            Заявка подписана вашим ключом. Без сервера она не теряется: если друг
            офлайн, она уходит в outbox и доставится при следующей встрече в комнате
            или в парной комнате.
          </p>
        </section>

        {requests.length > 0 ? (
          <section className="hw-card">
            <div className="hw-card-head">
              <Icon name="door" size={18} />
              <h2>Заявки</h2>
            </div>
            <ul className="hw-requestlist">
              {requests.map((request) => (
                <li key={request.userId} className="hw-request">
                  <Avatar hash={request.avatarHash} name={request.name} color={request.color} />
                  <div className="hw-request-main">
                    <strong>{request.name}</strong>
                    <span>
                      {relativeTime(request.at)}
                      {request.note ? ` · «${request.note}»` : ''}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="hw-primary hw-primary--compact"
                    onClick={() => void acceptRequest(request.userId)}
                  >
                    Принять
                  </button>
                  <button
                    type="button"
                    className="hw-ghost"
                    onClick={() => void declineRequest(request.userId)}
                  >
                    Отклонить
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <section className="hw-card">
          <div className="hw-card-head">
            <Icon name="users" size={18} />
            <h2>Ваши друзья</h2>
          </div>
          {friends.length === 0 ? (
            <p className="hw-note">
              Друзья появляются только по взаимному подтверждению. Ссылка выше даёт
              другу возможность отправить заявку, но не добавляет его автоматически.
            </p>
          ) : (
            <ul className="hw-friendlist">
              {friends.map((friend) => (
                <li key={friend.userId} className="hw-friendrow">
                  <Avatar
                    hash={friend.avatarHash}
                    name={friend.displayName}
                    color={friend.nameColor}
                  />
                  <div className="hw-friend-main">
                    <strong style={{ color: friend.nameColor }}>{friend.displayName}</strong>
                    <span>
                      {fingerprints[friend.userId] ?? '…'} ·{' '}
                      {relativeTime(friend.lastMeetAt ?? 0)}
                      {friend.blocked ? ' · заблокирован' : ''}
                    </span>
                  </div>
                  {typeof unread[friend.userId] === 'number' && unread[friend.userId]! > 0 ? (
                    <span className="hw-unread">{unread[friend.userId]}</span>
                  ) : null}
                  <button
                    type="button"
                    className="hw-ghost hw-ghost--compact"
                    onClick={() => onOpenDm(friend.userId)}
                  >
                    <Icon name="chat" size={15} /> Написать
                  </button>
                  {removing === friend.userId ? (
                    <>
                      <button
                        type="button"
                        className="hw-ghost hw-ghost--danger"
                        onClick={() => void removeFriend(friend.userId, friend.displayName)}
                      >
                        Удалить
                      </button>
                      <button
                        type="button"
                        className="hw-linkbtn"
                        onClick={() => setRemoving(null)}
                      >
                        Отмена
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="hw-iconbtn hw-iconbtn--small"
                      onClick={() => setRemoving(friend.userId)}
                      aria-label="Удалить из друзей"
                    >
                      <Icon name="close" size={16} />
                    </button>
                  )}
                  <button
                    type="button"
                    className={`hw-linkbtn${friend.blocked ? ' is-danger' : ''}`}
                    onClick={() => void toggleBlock(friend.userId, !friend.blocked)}
                  >
                    {friend.blocked ? 'Разблокировать' : 'Блокировать'}
                  </button>
                </li>
              ))}
            </ul>
          )}
          <p className="hw-note">
            {pairRoomEnabled
              ? 'Парная комната включена: пока экран личных сообщений открыт, друг на связи и сообщения доставляются сразу.'
              : 'Парная комната выключена (по умолчанию): личка копится в outbox и доставляется при следующей встрече. Включить — в настройках.'}
          </p>
        </section>
      </div>
    </div>
  );
}
