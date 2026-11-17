import { Icon } from '../../app/icons';
import type { ChatMessage } from '../../net/protocol';
import { QUICK_REACTIONS, REACTION_LABELS } from './emoji';

export interface VoiceView {
  supported: boolean;
  active: boolean;
  muted: boolean;
  /** Уровень микрофона 0…1. */
  level: number;
  /** Кто сейчас говорит (имена). */
  speaking: string[];
  busy: boolean;
}

interface ChatDockProps {
  lastMessage: ChatMessage | null;
  unread: number;
  open: boolean;
  reactionsOpen: boolean;
  voice: VoiceView;
  onOpen: () => void;
  onToggleReactions: () => void;
  onReaction: (emoji: string) => void;
  onToggleMic: () => void;
}

function lastMessageText(message: ChatMessage | null): string {
  if (!message) {
    return 'Чат комнаты — напишите первым';
  }
  if (message.kind === 'image') {
    return message.pending ? 'Фото передаётся…' : '📷 Фото';
  }
  return message.text ?? '';
}

/**
 * Нижний док комнаты: микрофон, строка последнего сообщения и быстрые реакции.
 * Всегда виден поверх видео, но занимает одну строку — тап-регион небольшой.
 */
export function ChatDock({
  lastMessage,
  unread,
  open,
  reactionsOpen,
  voice,
  onOpen,
  onToggleReactions,
  onReaction,
  onToggleMic,
}: ChatDockProps) {
  const micLabel = voice.active
    ? voice.muted
      ? 'Включить микрофон'
      : 'Выключить микрофон'
    : 'Включить голос';
  const speaker = voice.speaking.filter(Boolean);

  return (
    <div className="hw-chatdock" data-hw-region="chatdock">
      <button
        type="button"
        className={`hw-mic${voice.active ? ' is-on' : ''}${voice.muted ? ' is-muted' : ''}`}
        onClick={onToggleMic}
        disabled={!voice.supported || voice.busy}
        aria-pressed={voice.active && !voice.muted}
        aria-label={micLabel}
        title={voice.supported ? micLabel : 'Микрофон доступен только в приложении'}
      >
        <Icon name={voice.muted || !voice.active ? 'mic-off' : 'mic'} size={18} />
        <span
          className="hw-mic-level"
          style={{ transform: `scaleX(${voice.active && !voice.muted ? Math.max(0.06, voice.level) : 0.06})` }}
          aria-hidden="true"
        />
      </button>

      <button
        type="button"
        className={`hw-lastmsg${open ? ' is-open' : ''}`}
        onClick={onOpen}
        aria-label="Открыть чат комнаты"
      >
        {speaker.length > 0 ? (
          <span className="hw-speakline">
            <span className="hw-speaking-dot" aria-hidden="true" />
            {speaker.length === 1 ? `Говорит ${speaker[0]}` : `Говорят: ${speaker.join(', ')}`}
          </span>
        ) : (
          <span className="hw-lastmsg-text">
            {lastMessage?.kind === 'text' && lastMessage.text ? (
              <>
                <b style={{ color: lastMessage.self ? undefined : lastMessage.color }}>
                  {lastMessage.self ? 'Вы' : lastMessage.name}:
                </b>{' '}
                {lastMessageText(lastMessage)}
              </>
            ) : (
              lastMessageText(lastMessage)
            )}
          </span>
        )}
        {unread > 0 && !open ? (
          <span className="hw-unread" aria-label={`${unread} новых сообщений`}>
            {unread > 99 ? '99+' : unread}
          </span>
        ) : null}
      </button>

      <button
        type="button"
        className={`hw-iconbtn hw-iconbtn--dock${reactionsOpen ? ' is-active' : ''}`}
        onClick={onToggleReactions}
        aria-expanded={reactionsOpen}
        aria-label="Быстрые реакции"
        title="Реакции"
      >
        <Icon name="emoji" size={18} />
      </button>

      <button
        type="button"
        className={`hw-iconbtn hw-iconbtn--dock${open ? ' is-active' : ''}`}
        onClick={onOpen}
        aria-label="Чат"
        title="Чат"
      >
        <Icon name="chat" size={18} />
      </button>

      {reactionsOpen ? (
        // Свой тап-регион: поповер выходит за пределы дока, иначе его кнопки
        // уходили бы в site-WebView.
        <div
          className="hw-reactionbar"
          data-hw-region="reactions"
          role="group"
          aria-label="Быстрые реакции"
        >
          {QUICK_REACTIONS.map((emoji) => (
            <button
              key={emoji}
              type="button"
              className="hw-reactionbtn"
              onClick={() => onReaction(emoji)}
              title={REACTION_LABELS[emoji] ?? emoji}
              aria-label={REACTION_LABELS[emoji] ?? emoji}
            >
              {emoji}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
