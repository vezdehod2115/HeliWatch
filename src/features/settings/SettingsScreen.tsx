/*
 * Настройки (этап 7): акцент, прозрачность чата, голос, PiP, парная комната,
 * TURN, age-gate и бэкап.
 *
 * Каждое изменение сразу пишется в SQLite (`settings`) и применяется без
 * перезапуска: ICE-настройки подхватит следующее соединение, акцент — ближайший
 * кадр, прозрачность — CSS-переменная.
 */

import { useEffect, useState } from 'react';
import { PageHeader } from '../../app/PageHeader';
import { Icon } from '../../app/icons';
import { clearMediaCache, mediaCacheSize } from '../../db/repo/media';
import { backupFileName, exportBackup, importBackup } from '../../db/backup';
import { useSettingsStore } from '../../stores/settings';

interface SettingsScreenProps {
  onBack: () => void;
  onOpenAbout: () => void;
  notify: (text: string) => void;
}

const TURN_EXAMPLE =
  '[{"urls":"turn:my.example.com:3478","username":"user","credential":"secret"}]';

type BooleanSetting =
  | 'accentEnabled'
  | 'voiceDucking'
  | 'chatHistory'
  | 'pipEnabled'
  | 'dmPairRoom'
  | 'turnOnly'
  | 'ageGate';

export function SettingsScreen({ onBack, onOpenAbout, notify }: SettingsScreenProps) {
  const settings = useSettingsStore();
  const [turnDraft, setTurnDraft] = useState(settings.turnJson);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [includeIdentity, setIncludeIdentity] = useState(false);
  const [replaceStep, setReplaceStep] = useState(false);
  const [cache, setCache] = useState<{ bytes: number; files: number } | null>(null);

  useEffect(() => {
    setTurnDraft(settings.turnJson);
  }, [settings.turnJson]);

  useEffect(() => {
    void mediaCacheSize().then(setCache);
  }, []);

  const toggle = async (key: BooleanSetting, value: boolean): Promise<void> => {
    await settings.update(key, value);
  };

  const saveTurn = async (): Promise<void> => {
    const ok = await settings.setTurnJson(turnDraft);
    const turnError = useSettingsStore.getState().turnError;
    setMessage(ok ? 'TURN сохранён: применится к следующему соединению' : (turnError ?? 'TURN: проверьте JSON'));
  };

  const doExport = async (): Promise<void> => {
    setBusy('export');
    setMessage(null);
    try {
      const result = await exportBackup({ includeIdentity });
      if (result.ok) {
        setMessage(
          `Бэкап сохранён: ${backupFileName()}${
            includeIdentity ? ' · с ключами (файл = ваша личность)' : ' · без ключей'
          }`,
        );
        notify('Бэкап сохранён');
      } else if (!result.cancelled) {
        setMessage(result.error ?? 'Не удалось сохранить бэкап');
      }
    } finally {
      setBusy(null);
    }
  };

  const doImport = async (mode: 'merge' | 'replace'): Promise<void> => {
    setBusy(`import-${mode}`);
    setMessage(null);
    try {
      const result = await importBackup(mode);
      if (result.ok) {
        const stats = result.stats;
        setMessage(
          `Импорт завершён: друзей ${stats?.friends ?? 0}, сообщений ${stats?.messages ?? 0}, сессий ${stats?.sessions ?? 0}, настроек ${stats?.settings ?? 0}`,
        );
        notify('Импорт завершён, интерфейс перезапустится');
        window.setTimeout(() => {
          window.location.reload();
        }, 1600);
      } else if (!result.cancelled) {
        setMessage(result.error ?? 'Не удалось прочитать бэкап');
      }
    } finally {
      setBusy(null);
      setReplaceStep(false);
    }
  };

  const clearCache = async (): Promise<void> => {
    setBusy('cache');
    try {
      await clearMediaCache();
      setCache(await mediaCacheSize());
      notify('Кэш фото очищен');
    } finally {
      setBusy(null);
    }
  };

  const cacheLabel = cache
    ? `${cache.files} файлов · ${(cache.bytes / (1024 * 1024)).toFixed(1)} МБ из 200 МБ`
    : 'считаем…';

  return (
    <div className="hw-screen" data-hw-region="settings">
      <PageHeader
        title="Настройки"
        subtitle={`HeliWatch ${__APP_VERSION__}`}
        onBack={onBack}
        right={
          <button type="button" className="hw-iconbtn" onClick={onOpenAbout} aria-label="О приложении">
            <Icon name="bug" size={20} />
          </button>
        }
      />
      <div className="hw-screen-scroll">
        <section className="hw-card">
          <div className="hw-card-head">
            <Icon name="emoji" size={18} />
            <h2>Внешний вид</h2>
          </div>
          <button
            type="button"
            className={`hw-toggle${settings.accentEnabled ? ' is-on' : ''}`}
            aria-pressed={settings.accentEnabled}
            onClick={() => void toggle('accentEnabled', !settings.accentEnabled)}
          >
            <Icon name="broadcast" size={16} />
            <span>
              <strong>Динамический акцент</strong>
              <small>
                цвет из кадра видео; при tainted canvas, паузе и вне комнаты —
                мятный. По умолчанию включён.
              </small>
            </span>
          </button>
          <label className="hw-slider">
            <span>
              <strong>Прозрачность панели чата</strong>
              <small>{Math.round(settings.chatOpacity * 100)}%</small>
            </span>
            <input
              type="range"
              min={55}
              max={100}
              step={1}
              value={Math.round(settings.chatOpacity * 100)}
              onChange={(event) =>
                void settings.update('chatOpacity', Number(event.target.value) / 100)
              }
              aria-label="Прозрачность панели чата"
            />
          </label>
        </section>

        <section className="hw-card">
          <div className="hw-card-head">
            <Icon name="mic" size={18} />
            <h2>Голос и чат</h2>
          </div>
          <label className="hw-slider">
            <span>
              <strong>Громкость собеседников</strong>
              <small>{Math.round(settings.voiceVolume * 100)}%</small>
            </span>
            <input
              type="range"
              min={0}
              max={100}
              step={5}
              value={Math.round(settings.voiceVolume * 100)}
              onChange={(event) =>
                void settings.update('voiceVolume', Number(event.target.value) / 100)
              }
              aria-label="Громкость голоса"
            />
          </label>
          <button
            type="button"
            className={`hw-toggle${settings.voiceDucking ? ' is-on' : ''}`}
            aria-pressed={settings.voiceDucking}
            onClick={() => void toggle('voiceDucking', !settings.voiceDucking)}
          >
            <Icon name="video" size={16} />
            <span>
              <strong>Приглушать видео, когда говорят</strong>
              <small>ducking до 22% на время речи; по умолчанию включено</small>
            </span>
          </button>
          <button
            type="button"
            className={`hw-toggle${settings.chatHistory ? ' is-on' : ''}`}
            aria-pressed={settings.chatHistory}
            onClick={() => void toggle('chatHistory', !settings.chatHistory)}
          >
            <Icon name="history" size={16} />
            <span>
              <strong>Сохранять историю чата комнаты</strong>
              <small>только этот телефон, фото — в файловом кэше</small>
            </span>
          </button>
        </section>

        <section className="hw-card">
          <div className="hw-card-head">
            <Icon name="pip" size={18} />
            <h2>Фон и PiP</h2>
          </div>
          <button
            type="button"
            className={`hw-toggle${settings.pipEnabled ? ' is-on' : ''}`}
            aria-pressed={settings.pipEnabled}
            onClick={() => void toggle('pipEnabled', !settings.pipEnabled)}
          >
            <Icon name="pip" size={16} />
            <span>
              <strong>PiP и автовход</strong>
              <small>при уходе из приложения, пока комната активна; кнопка PiP тоже скрывается</small>
            </span>
          </button>
        </section>

        <section className="hw-card">
          <div className="hw-card-head">
            <Icon name="users" size={18} />
            <h2>Друзья</h2>
          </div>
          <button
            type="button"
            className={`hw-toggle${settings.dmPairRoom ? ' is-on' : ''}`}
            aria-pressed={settings.dmPairRoom}
            onClick={() => void toggle('dmPairRoom', !settings.dmPairRoom)}
          >
            <Icon name="chat" size={16} />
            <span>
              <strong>Парная комната друзей</strong>
              <small>
                пока экран лички открыт, друг на связи и сообщения доставляются
                сразу; расходует батарею. По умолчанию выключено — тогда доставка
                при следующей встрече.
              </small>
            </span>
          </button>
        </section>

        <section className="hw-card">
          <div className="hw-card-head">
            <Icon name="link" size={18} />
            <h2>Сеть и TURN</h2>
          </div>
          <p className="hw-note">
            Свой TURN помогает при симметричном NAT. JSON — массив RTCIceServer,
            например:
          </p>
          <code className="hw-codeblock">{TURN_EXAMPLE}</code>
          <textarea
            className="hw-textarea"
            value={turnDraft}
            onChange={(event) => setTurnDraft(event.target.value)}
            rows={4}
            spellCheck={false}
            autoCapitalize="none"
            placeholder="[] — использовать только публичные STUN/TURN"
            aria-label="Свой TURN в JSON"
          />
          {settings.turnError ? <p className="hw-formerror">{settings.turnError}</p> : null}
          <div className="hw-inlineform">
            <button type="button" className="hw-primary hw-primary--compact" onClick={() => void saveTurn()}>
              Сохранить TURN
            </button>
            <button
              type="button"
              className={`hw-toggle hw-toggle--inline${settings.turnOnly ? ' is-on' : ''}`}
              aria-pressed={settings.turnOnly}
              onClick={() => void toggle('turnOnly', !settings.turnOnly)}
            >
              <span>
                <strong>Только TURN</strong>
                <small>для отладки</small>
              </span>
            </button>
          </div>
          <p className="hw-note">
            Публичные STUN (Google, Cloudflare) и Open Relay остаются в наборе:
            свой TURN добавляется к ним. Режим «только TURN» отключает прямые
            кандидаты — соединение пойдёт через релей.
          </p>
        </section>

        <section className="hw-card">
          <div className="hw-card-head">
            <Icon name="lock" size={18} />
            <h2>Сайт</h2>
          </div>
          <button
            type="button"
            className={`hw-toggle${settings.ageGate ? ' is-on' : ''}`}
            aria-pressed={settings.ageGate}
            onClick={() => void toggle('ageGate', !settings.ageGate)}
          >
            <Icon name="video" size={16} />
            <span>
              <strong>Подсказка про age-gate</strong>
              <small>
                если YouTube просит подтвердить возраст, показываем объяснение.
                Ограничение не обходится — только честная подсказка.
              </small>
            </span>
          </button>
        </section>

        <section className="hw-card">
          <div className="hw-card-head">
            <Icon name="history" size={18} />
            <h2>Бэкап и данные</h2>
          </div>
          <p className="hw-note">
            Один JSON-файл: профиль, друзья, бан-лист, личка, сессии, статистика и
            настройки. Медиа по умолчанию не включаются. Файл с ключами = ваша
            личность: включайте его только для переноса на своё устройство.
          </p>
          <label className="hw-check">
            <input
              type="checkbox"
              checked={includeIdentity}
              onChange={(event) => setIncludeIdentity(event.target.checked)}
            />
            <span>Включить ключи идентичности (осторожно)</span>
          </label>
          {includeIdentity ? (
            <p className="hw-note hw-note--warning">
              Бэкап с ключами позволит войти в ваши комнаты и читать личку тому, у
              кого окажется файл.
            </p>
          ) : null}
          <div className="hw-inlineform">
            <button
              type="button"
              className="hw-primary hw-primary--compact"
              onClick={() => void doExport()}
              disabled={busy !== null}
            >
              <Icon name="copy" size={15} /> Экспорт
            </button>
            <button
              type="button"
              className="hw-ghost"
              onClick={() => void doImport('merge')}
              disabled={busy !== null}
            >
              Импорт (слить)
            </button>
            {!replaceStep ? (
              <button
                type="button"
                className="hw-ghost hw-ghost--danger"
                onClick={() => setReplaceStep(true)}
                disabled={busy !== null}
              >
                Импорт (заменить)
              </button>
            ) : (
              <>
                <button
                  type="button"
                  className="hw-ghost hw-ghost--danger"
                  onClick={() => void doImport('replace')}
                  disabled={busy !== null}
                >
                  Да, заменить всё
                </button>
                <button type="button" className="hw-linkbtn" onClick={() => setReplaceStep(false)}>
                  Отмена
                </button>
              </>
            )}
          </div>
          <p className="hw-note">
            «Слить» не затирает локальное: друзья и сообщения добавляются, настройки —
            только недостающие ключи. «Заменить» очищает таблицы и переносит файл
            целиком. После импорта интерфейс перезапустится.
          </p>
          {message ? <p className="hw-note hw-selectable">{message}</p> : null}
        </section>

        <section className="hw-card">
          <div className="hw-card-head">
            <Icon name="photo" size={18} />
            <h2>Файловый кэш фото</h2>
          </div>
          <p className="hw-note">
            Сжатые фото чата и лички кэшируются на телефоне: {cacheLabel}. Старое
            вытесняется автоматически (LRU), кэш можно очистить вручную — фото в
            истории комнаты после этого не восстановятся.
          </p>
          <button
            type="button"
            className="hw-ghost"
            onClick={() => void clearCache()}
            disabled={busy !== null}
          >
            Очистить кэш фото
          </button>
        </section>

        <section className="hw-card">
          <div className="hw-card-head">
            <Icon name="bug" size={18} />
            <h2>О приложении</h2>
          </div>
          <p className="hw-note">
            Версия {__APP_VERSION__}. HeliWatch — независимый проект под MIT; своих
            серверов нет.
          </p>
          <button type="button" className="hw-ghost" onClick={onOpenAbout}>
            Открыть «О приложении»
          </button>
        </section>
      </div>
    </div>
  );
}
