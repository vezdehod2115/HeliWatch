/*
 * Профиль (этап 7): имя, цвет, аватар, отпечаток и ссылка-приглашение.
 * Ключ и userId здесь только показываются: идентичность создаётся один раз и
 * хранится в SQLite, менять её из UI нельзя (смена ключа ломает друзей и DM).
 */

import { useEffect, useRef, useState } from 'react';
import { PageHeader } from '../../app/PageHeader';
import { Icon } from '../../app/icons';
import { NAME_COLORS, NAME_MAX, NAME_MIN } from '../../db/repo/profile';
import { saveAvatar } from '../../db/repo/media';
import type { LocalProfile } from '../../db/repo/identity';
import { friendInviteLink } from '../../net/protocol';
import type { Identity } from '../../net/identity';
import { useProfileStore } from '../../stores/profile';
import { prepareAvatar } from '../chat/imagePrep';
import { Avatar } from './Avatar';

interface ProfileScreenProps {
  identity: Identity;
  profile: LocalProfile;
  persisted: boolean;
  onBack: () => void;
  onOpenFriends: () => void;
  notify: (text: string) => void;
}

export function ProfileScreen({
  identity,
  profile,
  persisted,
  onBack,
  onOpenFriends,
  notify,
}: ProfileScreenProps) {
  const rename = useProfileStore((state) => state.rename);
  const setColor = useProfileStore((state) => state.setColor);
  const setAvatar = useProfileStore((state) => state.setAvatar);
  const [name, setName] = useState(profile.displayName);
  const [busy, setBusy] = useState(false);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [showId, setShowId] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setName(profile.displayName);
  }, [profile.displayName]);

  const saveName = async (): Promise<void> => {
    setBusy(true);
    const ok = await rename(name);
    setBusy(false);
    notify(
      ok
        ? 'Имя сохранено'
        : `Имя должно быть от ${NAME_MIN} до ${NAME_MAX} символов`,
    );
  };

  const changeColor = async (color: string): Promise<void> => {
    const ok = await setColor(color);
    if (ok) {
      notify('Цвет имени обновлён');
    }
  };

  const pickAvatar = async (file: File): Promise<void> => {
    setAvatarBusy(true);
    try {
      const prepared = await prepareAvatar(file);
      const hash = await saveAvatar(prepared.bytes, prepared.mime);
      if (!hash) {
        notify('Не удалось сохранить аватар: файловый кэш недоступен');
        return;
      }
      await setAvatar(hash);
      notify('Аватар обновлён');
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Не удалось подготовить аватар');
    } finally {
      setAvatarBusy(false);
    }
  };

  const copyInvite = async (): Promise<void> => {
    const link = friendInviteLink(identity.userId);
    try {
      await navigator.clipboard.writeText(link);
      notify('Ссылка-приглашение скопирована');
    } catch {
      notify(link);
    }
  };

  return (
    <div className="hw-screen" data-hw-region="profile">
      <PageHeader
        title="Профиль"
        subtitle={persisted ? 'данные в SQLite на этом телефоне' : 'предпросмотр: не сохраняется'}
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
        <section className="hw-card hw-profilehero">
          <div className="hw-profileavatar">
            <Avatar hash={profile.avatarHash} name={profile.displayName} color={profile.nameColor} size={76} />
            <input
              ref={fileInput}
              type="file"
              accept="image/*"
              className="hw-fileinput"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = '';
                if (file) {
                  void pickAvatar(file);
                }
              }}
            />
            <div className="hw-profileavatar-actions">
              <button
                type="button"
                className="hw-ghost"
                onClick={() => fileInput.current?.click()}
                disabled={avatarBusy}
              >
                {avatarBusy ? 'Готовим…' : 'Сменить аватар'}
              </button>
              {profile.avatarHash ? (
                <button
                  type="button"
                  className="hw-linkbtn"
                  onClick={() => {
                    void setAvatar(null);
                    notify('Аватар снят');
                  }}
                >
                  Убрать
                </button>
              ) : null}
            </div>
          </div>
          <div className="hw-profilemeta">
            <strong style={{ color: profile.nameColor }}>{profile.displayName}</strong>
            <span>
              Отпечаток <b>{identity.fingerprint}</b>
            </span>
            <span>{persisted ? 'ключ ECDSA P-256 в SQLite' : 'эфемерная identity'}</span>
          </div>
        </section>

        <section className="hw-card">
          <div className="hw-card-head">
            <Icon name="users" size={18} />
            <h2>Имя и цвет</h2>
          </div>
          <form
            className="hw-inlineform"
            onSubmit={(event) => {
              event.preventDefault();
              void saveName();
            }}
          >
            <input
              className="hw-field"
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={NAME_MAX}
              aria-label="Ваше имя"
              placeholder="Как вас зовут"
            />
            <button type="submit" className="hw-ghost" disabled={busy}>
              Сохранить
            </button>
          </form>
          <div className="hw-colors" role="radiogroup" aria-label="Цвет имени">
            {NAME_COLORS.map((color) => (
              <button
                key={color}
                type="button"
                role="radio"
                aria-checked={profile.nameColor.toLowerCase() === color}
                className={`hw-color${profile.nameColor.toLowerCase() === color ? ' is-active' : ''}`}
                style={{ background: color }}
                onClick={() => void changeColor(color)}
                aria-label={`Цвет ${color}`}
              />
            ))}
          </div>
          <p className="hw-note">
            Цвет виден в комнате и в друзьях. Он не связан с акцентом темы: акцент
            берётся из кадра видео.
          </p>
        </section>

        <section className="hw-card">
          <div className="hw-card-head">
            <Icon name="link" size={18} />
            <h2>Приглашение в друзья</h2>
          </div>
          <p className="hw-note">
            Ссылка содержит ваш публичный ключ — это и есть идентификатор. Приватный
            ключ не покидает устройство и не показывается даже здесь.
          </p>
          <div className="hw-inlineform">
            <button type="button" className="hw-primary hw-primary--compact" onClick={() => void copyInvite()}>
              <Icon name="copy" size={15} /> Скопировать ссылку
            </button>
            <button type="button" className="hw-ghost" onClick={onOpenFriends}>
              К друзьям
            </button>
          </div>
          <button
            type="button"
            className="hw-linkbtn"
            onClick={() => setShowId((value) => !value)}
          >
            {showId ? 'Скрыть userId' : 'Показать userId'}
          </button>
          {showId ? <code className="hw-userid">{identity.userId}</code> : null}
        </section>

        <section className="hw-card">
          <div className="hw-card-head">
            <Icon name="lock" size={18} />
            <h2>Что нужно знать</h2>
          </div>
          <p className="hw-note">
            Профиль, ключи, друзья и личка хранятся только на этом телефоне.
            Синхронизации между устройствами нет — для переноса есть бэкап в
            настройках. Файл с ключами = ваша личность, поэтому ключи включаются
            отдельным переключателем.
          </p>
        </section>
      </div>
    </div>
  );
}
