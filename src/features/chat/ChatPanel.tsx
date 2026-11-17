import { useEffect, useRef, type ChangeEvent, type KeyboardEvent } from 'react';
import { Icon } from '../../app/icons';
import type { ChatMessage } from '../../net/protocol';
import type { ChatTransfer } from '../../stores/chat';
import { EmojiPanel } from './EmojiPanel';
import { QUICK_REACTIONS, REACTION_LABELS } from './emoji';

interface ChatPanelProps {
  messages: ChatMessage[];
  images: Record<string, string>;
  transfers: Record<string, ChatTransfer>;
  typingNames: string[];
  draft: string;
  emojiOpen: boolean;
  recents: string[];
  saveHistory: boolean;
  notice: string | null;
  onDraft: (text: string) => void;
  onSend: () => void;
  onClose: () => void;
  onPhoto: (file: File) => void;
  onRetry: (messageId: string) => void;
  onCancelTransfer: (id: string) => void;
  onOpenImage: (imageId: string) => void;
  onEmoji: (emoji: string) => void;
  onReact: (emoji: string) => void;
  onToggleEmoji: () => void;
  onToggleSaveHistory: () => void;
}

function timeLabel(ts: number): string {
  const date = new Date(ts);
  const hours = date.getHours().toString().padStart(2, '0');
  const minutes = date.getMinutes().toString().padStart(2, '0');
  return `${hours}:${minutes}`;
}

function progressPercent(transfer: ChatTransfer | undefined): number {
  if (!transfer || transfer.total <= 0) {
    return 0;
  }
  return Math.min(100, Math.round((transfer.progress / transfer.total) * 100));
}

function MessageBubble({
  message,
  imageUrl,
  transfer,
  onOpenImage,
  onRetry,
  onCancelTransfer,
}: {
  message: ChatMessage;
  imageUrl?: string;
  transfer?: ChatTransfer;
  onOpenImage: (imageId: string) => void;
  onRetry: (messageId: string) => void;
  onCancelTransfer: (id: string) => void;
}) {
  const mine = message.self === true;
  return (
    <div className={`hw-msg${mine ? ' is-self' : ''}`}>
      {!mine && (
        <span className="hw-msg-author" style={{ color: message.color }}>
          {message.name}
        </span>
      )}
      <div className={`hw-bubble${message.failed ? ' is-failed' : ''}`}>
        {message.kind === 'image' ? (
          imageUrl ? (
            <button
              type="button"
              className="hw-msgimage"
              onClick={() => message.imageId && onOpenImage(message.imageId)}
              aria-label="Открыть фото"
            >
              <img src={imageUrl} alt="Фото из чата" />
            </button>
          ) : (
            <div className="hw-msgimage-pending">
              <Icon name="photo" size={18} />
              <span>
                {message.failed
                  ? 'Фото не доставлено'
                  : `Передача фото${transfer ? ` · ${progressPercent(transfer)}%` : '…'}`}
              </span>
              {!message.failed && message.imageId && (
                <button
                  type="button"
                  className="hw-linkbtn"
                  onClick={() => onCancelTransfer(message.imageId ?? '')}
                >
                  Отмена
                </button>
              )}
              {message.failed && (
                <button
                  type="button"
                  className="hw-linkbtn"
                  onClick={() => onRetry(message.id)}
                >
                  Повторить
                </button>
              )}
            </div>
          )
        ) : (
          <span className="hw-msgtext">{message.text}</span>
        )}
        <span className="hw-msg-time">{timeLabel(message.ts)}</span>
      </div>
      {transfer && message.kind === 'image' && (
        <span className="hw-msg-progress" aria-hidden="true">
          <span style={{ width: `${progressPercent(transfer)}%` }} />
        </span>
      )}
    </div>
  );
}

/**
 * Панель чата поверх видео (§7 этапа 3): сообщения, фото с прогрессом,
 * эмодзи-панель, быстрые реакции и переключатель истории.
 *
 * Тап-роутинг: панель — один регион `chat`, эмодзи-панель — вложенный `emojipanel`.
 */
export function ChatPanel({
  messages,
  images,
  transfers,
  typingNames,
  draft,
  emojiOpen,
  recents,
  saveHistory,
  notice,
  onDraft,
  onSend,
  onClose,
  onPhoto,
  onRetry,
  onCancelTransfer,
  onOpenImage,
  onEmoji,
  onReact,
  onToggleEmoji,
  onToggleSaveHistory,
}: ChatPanelProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const list = listRef.current;
    if (list) {
      list.scrollTop = list.scrollHeight;
    }
  }, [messages.length, typingNames.length, emojiOpen]);

  const onFile = (event: ChangeEvent<HTMLInputElement>): void => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file) {
      onPhoto(file);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      onSend();
    }
  };

  return (
    <section className="hw-chatpanel" data-hw-region="chat" aria-label="Чат комнаты">
      <header className="hw-chathead">
        <button
          type="button"
          className="hw-iconbtn hw-iconbtn--small"
          onClick={onClose}
          aria-label="Свернуть чат"
          title="Свернуть"
        >
          <Icon name="chevron-down" size={18} />
        </button>
        <strong>Чат комнаты</strong>
        <button
          type="button"
          className={`hw-iconbtn hw-iconbtn--small${saveHistory ? ' is-active' : ''}`}
          onClick={onToggleSaveHistory}
          aria-pressed={saveHistory}
          title={
            saveHistory
              ? 'История чата сохраняется на этом телефоне'
              : 'Сохранять историю чата на этом телефоне'
          }
          aria-label="Сохранять историю чата"
        >
          <Icon name="history" size={18} />
        </button>
      </header>

      <div className="hw-chatmessages" ref={listRef}>
        {messages.length === 0 ? (
          <p className="hw-chatempty">
            Пока пусто. Сообщения и фото видят все в комнате — как только сеть их
            доставит.
          </p>
        ) : (
          messages.map((message) => (
            <MessageBubble
              key={message.id}
              message={message}
              imageUrl={message.imageId ? images[message.imageId] : undefined}
              transfer={message.imageId ? transfers[message.imageId] : undefined}
              onOpenImage={onOpenImage}
              onRetry={onRetry}
              onCancelTransfer={onCancelTransfer}
            />
          ))
        )}
        {typingNames.length > 0 && (
          <p className="hw-typing" role="status">
            {typingNames.length === 1
              ? `${typingNames[0]} печатает…`
              : `Печатают: ${typingNames.join(', ')}`}
          </p>
        )}
      </div>

      {notice ? (
        <p className="hw-chatnotice" role="status">
          {notice}
        </p>
      ) : null}

      {emojiOpen && <EmojiPanel recents={recents} onPick={onEmoji} />}

      <div className="hw-reactionsrow" role="group" aria-label="Реакции на видео">
        {QUICK_REACTIONS.map((emoji) => (
          <button
            key={emoji}
            type="button"
            className="hw-reactionbtn"
            onClick={() => onReact(emoji)}
            title={REACTION_LABELS[emoji] ?? emoji}
            aria-label={REACTION_LABELS[emoji] ?? emoji}
          >
            {emoji}
          </button>
        ))}
      </div>

      <div className="hw-composer">
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          className="hw-fileinput"
          onChange={onFile}
          aria-hidden="true"
          tabIndex={-1}
        />
        <button
          type="button"
          className="hw-iconbtn hw-iconbtn--small"
          onClick={() => fileRef.current?.click()}
          aria-label="Отправить фото"
          title="Фото до 2 МБ"
        >
          <Icon name="photo" size={20} />
        </button>
        <button
          type="button"
          className={`hw-iconbtn hw-iconbtn--small${emojiOpen ? ' is-active' : ''}`}
          onClick={onToggleEmoji}
          aria-pressed={emojiOpen}
          aria-label="Эмодзи"
          title="Эмодзи"
        >
          <Icon name="emoji" size={20} />
        </button>
        <textarea
          className="hw-chatinput"
          value={draft}
          onChange={(event) => onDraft(event.target.value)}
          onKeyDown={onKeyDown}
          rows={1}
          maxLength={4000}
          placeholder="Сообщение…"
          aria-label="Сообщение"
        />
        <button
          type="button"
          className="hw-send"
          onClick={onSend}
          disabled={draft.trim().length === 0}
          aria-label="Отправить"
        >
          <Icon name="send" size={20} />
        </button>
      </div>
    </section>
  );
}
