import { useCallback, useEffect, useRef, useState } from 'react';
import { LobbyClient, type LobbyPhase } from '../../net/lobby';
import { LOBBY_ROOM_ID, type LobbyCard } from '../../net/protocol';
import { connectTrystero } from '../../net/trystero';
import { listBlocks, pruneBlocks } from '../../db/repo/blocklist';

export interface LobbyView {
  phase: LobbyPhase;
  cards: LobbyCard[];
  error: string | null;
  strategy: string;
  refresh: () => void;
}

const EMPTY: Omit<LobbyView, 'refresh'> = {
  phase: 'connecting',
  cards: [],
  error: null,
  strategy: '',
};

/**
 * Лобби на главной: подключается к `heliwatch-lobby-v1` на время показа
 * главного экрана и отключается при входе в комнату (§4.8).
 */
export function useLobby(): LobbyView {
  const [view, setView] = useState<Omit<LobbyView, 'refresh'>>(EMPTY);
  const [restartKey, setRestartKey] = useState(0);
  const clientRef = useRef<LobbyClient | null>(null);
  const blockedRef = useRef<Set<string>>(new Set());

  // Локальный блок-лист: карточки тех, кого мы заблокировали, не показываем.
  useEffect(() => {
    let alive = true;
    void pruneBlocks()
      .then(() => listBlocks())
      .then((entries) => {
        if (!alive) {
          return;
        }
        blockedRef.current = new Set(entries.map((entry) => entry.userId));
        const client = clientRef.current;
        if (client) {
          setView((current) => ({ ...current, cards: client.cardList }));
        }
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [restartKey]);

  useEffect(() => {
    const client = new LobbyClient({
      connect: (strategy) => connectTrystero(strategy, LOBBY_ROOM_ID),
      isBlockedHost: (userId) => blockedRef.current.has(userId),
      onEvent: (event) => {
        if (event.type === 'cards') {
          setView((current) => ({ ...current, cards: event.cards }));
          return;
        }
        if (event.type === 'phase') {
          setView((current) => ({
            ...current,
            phase: event.phase,
            error: event.phase === 'error' ? (event.message ?? current.error) : current.error,
          }));
          return;
        }
        if (event.type === 'strategy') {
          setView((current) => ({ ...current, strategy: event.strategy }));
          return;
        }
        setView((current) => ({ ...current, error: event.message }));
      },
    });
    clientRef.current = client;
    void client.start();
    return () => {
      clientRef.current = null;
      client.stop();
    };
  }, [restartKey]);

  const refresh = useCallback(() => {
    setView(EMPTY);
    setRestartKey((value) => value + 1);
  }, []);

  return { ...view, refresh };
}
