import { useEffect } from 'react';
import type { FloatingReaction } from '../../stores/chat';
import { REACTION_FLOAT_MS } from './emoji';

interface FloatingReactionsProps {
  reactions: FloatingReaction[];
  onDone: (key: string) => void;
}

function FloatingReactionItem({
  reaction,
  onDone,
}: {
  reaction: FloatingReaction;
  onDone: (key: string) => void;
}) {
  useEffect(() => {
    const timer = window.setTimeout(() => onDone(reaction.key), REACTION_FLOAT_MS);
    return () => window.clearTimeout(timer);
  }, [reaction.key, onDone]);

  return (
    <span
      className={`hw-floating${reaction.self ? ' is-self' : ''}`}
      style={{ left: `${reaction.x * 100}%`, top: `${reaction.y * 100}%` }}
      aria-hidden="true"
    >
      <span className="hw-floating-emoji">{reaction.emoji}</span>
      <span className="hw-floating-name" style={{ color: reaction.self ? undefined : '#9dbfb7' }}>
        {reaction.name}
      </span>
    </span>
  );
}

/** Всплывающие реакции поверх видео: тап по эмодзи виден всем в комнате. */
export function FloatingReactions({ reactions, onDone }: FloatingReactionsProps) {
  if (reactions.length === 0) {
    return null;
  }
  return (
    // Без data-hw-region: слой декоративный, иначе он на 2.6 с перекрывал бы
    // тапы по сайту под видео.
    <div className="hw-floating-layer">
      {reactions.map((reaction) => (
        <FloatingReactionItem key={reaction.key} reaction={reaction} onDone={onDone} />
      ))}
    </div>
  );
}
