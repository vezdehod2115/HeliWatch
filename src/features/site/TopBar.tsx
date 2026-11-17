import { useEffect, useRef, useState, type FormEvent } from 'react';
import { displayUrl, normalizeUrl } from '../../native/siteBridge';
import type { NavAction, SiteStatus } from '../../features/site/types';
import { BrandMark, Icon } from '../../app/icons';

interface TopBarProps {
  status: SiteStatus;
  zonesOpen: boolean;
  onOpen: (input: string) => void;
  onTestPage: () => void;
  onYoutube: () => void;
  onNav: (action: NavAction) => void;
  onToggleZones: () => void;
  /** Компактный режим для комнаты: навигация и поиск, без адресной строки. */
  compact?: boolean;
  /** В комнате адрес задаёт хост — гостю поле только для чтения. */
  addressLocked?: boolean;
  /**
   * Открыть полноэкранный поиск (Google) и вернуться в комнату после выбора
   * видео. В компактном режиме адресной строки нет — её заменяет эта кнопка.
   */
  onSearch?: () => void;
  /** Видео-очередь комнаты открывается из той же панели. */
  onQueue?: () => void;
  queueCount?: number;
}

/** Верхняя панель: адрес, навигация и быстрые режимы. */
export function TopBar({
  status,
  zonesOpen,
  onOpen,
  onTestPage,
  onYoutube,
  onNav,
  onToggleZones,
  compact = false,
  addressLocked = false,
  onSearch,
  onQueue,
  queueCount = 0,
}: TopBarProps) {
  const [value, setValue] = useState(() => displayUrl(status.url));
  const [focused, setFocused] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!focused) {
      setValue(displayUrl(status.url));
      setInvalid(false);
    }
  }, [status.url, focused]);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (addressLocked) {
      return;
    }
    const url = normalizeUrl(value);
    if (!url) {
      setInvalid(true);
      inputRef.current?.focus();
      return;
    }
    setInvalid(false);
    inputRef.current?.blur();
    onOpen(url);
  };

  const isTestPage = status.url.includes('test-page.html');
  const isYoutube = status.url.includes('youtube.com');
  const pageLabel = status.title || displayUrl(status.url) || 'Найти видео';

  // Этап 8: в комнате адресной строки нет. Вместо неё — навигация сайта и
  // поиск: тап открывает Google, выбранный на сайте ролик возвращает в комнату.
  if (compact) {
    return (
      <header className="hw-panel hw-topbar is-compact" data-hw-region="topbar">
        <div className="hw-navrow">
          <button
            type="button"
            className="hw-iconbtn"
            onClick={() => onNav('back')}
            disabled={!status.canGoBack}
            aria-label="Назад по истории сайта"
          >
            <Icon name="back" />
          </button>
          <button
            type="button"
            className="hw-iconbtn"
            onClick={() => onNav('forward')}
            disabled={!status.canGoForward}
            aria-label="Вперёд по истории сайта"
          >
            <Icon name="forward" />
          </button>
          <button
            type="button"
            className="hw-iconbtn"
            onClick={() => onNav('reload')}
            aria-label="Перезагрузить сайт"
          >
            <Icon name="reload" />
          </button>

          <span className="hw-pagetitle" title={pageLabel}>
            <span
              className={`hw-dot${
                status.loading ? ' is-busy' : status.hookReady ? ' is-live' : ''
              }`}
            />
            <span className="hw-pagetitle-text">{pageLabel}</span>
          </span>

          {onQueue && (
            <button
              type="button"
              className="hw-iconbtn hw-iconbtn--queue"
              onClick={onQueue}
              aria-label="Очередь видео"
              title="Очередь видео"
            >
              <Icon name="list" size={18} />
              {queueCount > 0 ? <span className="hw-iconbadge">{queueCount}</span> : null}
            </button>
          )}

          <button
            type="button"
            className="hw-iconbtn hw-iconbtn--search"
            onClick={onSearch}
            disabled={addressLocked || !onSearch}
            aria-label="Найти видео"
            title="Найти видео"
          >
            <Icon name="search" size={18} />
          </button>

          <button
            type="button"
            className={`hw-iconbtn${zonesOpen ? ' is-active' : ''}`}
            onClick={onToggleZones}
            aria-pressed={zonesOpen}
            aria-label="Показать зоны касания"
            title="Зоны касания"
          >
            <Icon name="bug" size={17} />
          </button>
        </div>
      </header>
    );
  }

  return (
    <header className="hw-panel hw-topbar" data-hw-region="topbar">
      <div className="hw-brandrow">
        <div className="hw-brand">
          <BrandMark />
          <span className="hw-brand-name">HeliWatch</span>
          <span className="hw-brand-version">{__APP_VERSION__}</span>
        </div>
        <div className="hw-chips">
          <button
            type="button"
            className={`hw-chip${isTestPage ? ' is-active' : ''}`}
            onClick={onTestPage}
          >
            Тест
          </button>
          <button
            type="button"
            className={`hw-chip${isYoutube ? ' is-active' : ''}`}
            onClick={onYoutube}
          >
            YouTube
          </button>
          <button
            type="button"
            className={`hw-iconbtn${zonesOpen ? ' is-active' : ''}`}
            onClick={onToggleZones}
            aria-pressed={zonesOpen}
            aria-label="Показать зоны касания"
            title="Зоны касания"
          >
            <Icon name="bug" size={18} />
          </button>
        </div>
      </div>

      <form className="hw-urlrow" onSubmit={submit} noValidate>
        <button
          type="button"
          className="hw-iconbtn"
          onClick={() => onNav('back')}
          disabled={!status.canGoBack}
          aria-label="Назад по истории сайта"
        >
          <Icon name="back" />
        </button>
        <button
          type="button"
          className="hw-iconbtn"
          onClick={() => onNav('forward')}
          disabled={!status.canGoForward}
          aria-label="Вперёд по истории сайта"
        >
          <Icon name="forward" />
        </button>
        <button
          type="button"
          className="hw-iconbtn"
          onClick={() => onNav('reload')}
          aria-label="Перезагрузить сайт"
        >
          <Icon name="reload" />
        </button>
        <input
          ref={inputRef}
          className={`hw-url${invalid ? ' is-invalid' : ''}`}
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
            setInvalid(false);
          }}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          placeholder={addressLocked ? 'Адрес задаёт хост' : 'youtube.com или test'}
          inputMode="url"
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="go"
          aria-label="Адрес сайта"
          aria-invalid={invalid}
          readOnly={addressLocked}
        />
        <button type="submit" className="hw-go" disabled={addressLocked}>
          Открыть
        </button>
      </form>

      <div className="hw-statusrow">
        <span
          className={`hw-dot${
            status.loading ? ' is-busy' : status.hookReady ? ' is-live' : ''
          }`}
        />
        <span>
          {status.loading
            ? 'Загрузка'
            : status.hookReady
              ? 'Инжект активен'
              : 'Ожидание сайта'}
        </span>
        <span className="hw-page-title">
          {status.title || (isTestPage ? 'Тестовая страница' : 'Сайт не загружен')}
        </span>
        {status.video.count > 0 && (
          <span className="hw-badge" title="Найдено видео">
            <Icon name="video" size={13} /> {status.video.count}
          </span>
        )}
      </div>
    </header>
  );
}
