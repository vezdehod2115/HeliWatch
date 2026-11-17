import { afterEach, describe, expect, it } from 'vitest';
import {
  LOBBY_ROOM_ID,
  createEnvelope,
  type Envelope,
  type LobbyCard,
} from './protocol';
import { createIdentity, signEnvelope, type Identity } from './identity';
import { LobbyClient, LobbyPublisher } from './lobby';
import type { Channel } from './transport';

class FakeChannel implements Channel {
  readonly selfId: string;
  readonly strategy = 'fake';
  onPeerJoin: ((peerId: string) => void) | null = null;
  onPeerLeave: ((peerId: string) => void) | null = null;
  onMessage: ((data: unknown, peerId: string) => void) | null = null;
  onBlobMessage: ((data: unknown, peerId: string) => void) | null = null;
  onPeerStream:
    | ((stream: MediaStream, peerId: string, metadata?: unknown) => void)
    | null = null;
  readonly peers = new Map<string, FakeChannel>();

  constructor(selfId: string) {
    this.selfId = selfId;
  }

  send(data: unknown, to?: string): void {
    const copy = JSON.parse(JSON.stringify(data)) as unknown;
    const targets = to ? [this.peers.get(to)] : [...this.peers.values()];
    for (const target of targets) {
      target?.onMessage?.(copy, this.selfId);
    }
  }

  sendBlob(): void {
    // Лобби не использует бинарные сообщения.
  }

  knownPeers(): string[] {
    return [...this.peers.keys()];
  }

  relayCount(): number {
    return 1;
  }

  leave(): void {
    for (const peer of this.peers.values()) {
      peer.peers.delete(this.selfId);
    }
    this.peers.clear();
  }

  link(other: FakeChannel): void {
    this.peers.set(other.selfId, other);
    other.peers.set(this.selfId, this);
    this.onPeerJoin?.(other.selfId);
    other.onPeerJoin?.(this.selfId);
  }
}

const CARD: LobbyCard = {
  code: 'ABC234',
  title: 'Вечерний сериал',
  mode: 'site',
  closed: false,
  limit: 4,
  count: 2,
  hasPassword: true,
  knock: true,
  hostUserId: '',
  updatedAt: 0,
};

async function settle(client: LobbyClient, rounds = 8): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await client.whenIdle();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  await client.whenIdle();
}

async function createLobby(options: {
  card?: Partial<LobbyCard> | null;
  isBlockedHost?: (userId: string) => boolean;
} = {}): Promise<{
  identity: Identity;
  publisherChannel: FakeChannel;
  clientChannel: FakeChannel;
  publisher: LobbyPublisher;
  client: LobbyClient;
  clock: { value: number };
  events: Array<{ type: string; message?: string }>;
}> {
  const clock = { value: 1_700_000_000_000 };
  const now = () => clock.value;
  const identity = await createIdentity();
  const publisherChannel = new FakeChannel('peer-host');
  const clientChannel = new FakeChannel('peer-viewer');
  const events: Array<{ type: string; message?: string }> = [];

  const makeCard = (): LobbyCard | null => {
    if (options.card === null) {
      return null;
    }
    return {
      ...CARD,
      hostUserId: identity.userId,
      updatedAt: clock.value,
      ...options.card,
    };
  };

  const publisher = new LobbyPublisher({
    identity,
    card: makeCard,
    connect: async () => publisherChannel,
    now,
    autoTimers: false,
  });
  const client = new LobbyClient({
    connect: async () => clientChannel,
    onEvent: (event) => events.push(event as { type: string; message?: string }),
    now,
    autoTimers: false,
    isBlockedHost: options.isBlockedHost,
  });

  return {
    identity,
    publisherChannel,
    clientChannel,
    publisher,
    client,
    clock,
    events,
  };
}

const clients: LobbyClient[] = [];
const publishers: LobbyPublisher[] = [];

afterEach(() => {
  for (const client of clients.splice(0)) {
    client.stop();
  }
  for (const publisher of publishers.splice(0)) {
    publisher.stop();
  }
});

describe('лобби: карточки и подписи', () => {
  it('подписанная карточка хоста доходит до браузера', async () => {
    const { publisher, client, publisherChannel, clientChannel } = await createLobby();
    clients.push(client);
    publishers.push(publisher);
    publisherChannel.link(clientChannel);

    await client.start();
    await publisher.start();
    await settle(client);

    expect(client.cardList).toHaveLength(1);
    const card = client.cardList[0];
    expect(card?.code).toBe('ABC234');
    expect(card?.title).toBe('Вечерний сериал');
    expect(card?.hasPassword).toBe(true);
    expect(card?.knock).toBe(true);
  });

  it('карточка с испорченной подписью отбрасывается', async () => {
    const { identity, publisher, client, publisherChannel, clientChannel, clock } =
      await createLobby();
    clients.push(client);
    publishers.push(publisher);
    publisherChannel.link(clientChannel);
    await client.start();
    await publisher.start();
    await settle(client);

    const forged: Envelope = createEnvelope(
      'lobby-announce',
      { card: { ...CARD, hostUserId: identity.userId, title: 'Взлом', updatedAt: clock.value } },
      identity.userId,
      LOBBY_ROOM_ID,
      { now: clock.value + 6000 },
    );
    forged.sig = await signEnvelope(forged, identity.privateJwk);
    // Подменяем содержимое после подписи.
    (forged.d as { card: LobbyCard }).card.title = 'Подмена';
    clientChannel.onMessage?.(forged, publisherChannel.selfId);
    await settle(client);

    expect(client.cardList).toHaveLength(1);
    expect(client.cardList[0]?.title).toBe('Вечерний сериал');
  });

  it('карточка исчезает по TTL 70 секунд', async () => {
    const { publisher, client, publisherChannel, clientChannel, clock } = await createLobby();
    clients.push(client);
    publishers.push(publisher);
    publisherChannel.link(clientChannel);
    await client.start();
    await publisher.start();
    await settle(client);
    expect(client.cardList).toHaveLength(1);

    clock.value += 71_000;
    expect(client.cardList).toHaveLength(0);
  });

  it('спам карточками режется: не чаще одной публикации в 5 секунд', async () => {
    const { identity, publisher, client, publisherChannel, clientChannel, clock } =
      await createLobby();
    clients.push(client);
    publishers.push(publisher);
    publisherChannel.link(clientChannel);
    await client.start();
    await publisher.start();
    await settle(client);
    expect(client.cardList[0]?.title).toBe('Вечерний сериал');

    const spam: Envelope = createEnvelope(
      'lobby-update',
      {
        card: {
          ...CARD,
          hostUserId: identity.userId,
          title: 'Спам',
          updatedAt: clock.value + 1000,
        },
      },
      identity.userId,
      LOBBY_ROOM_ID,
      { now: clock.value + 1000 },
    );
    spam.sig = await signEnvelope(spam, identity.privateJwk);
    clientChannel.onMessage?.(spam, publisherChannel.selfId);
    await settle(client);
    expect(client.cardList[0]?.title).toBe('Вечерний сериал');

    // Через 5 секунд та же карточка уже принимается.
    clock.value += 6000;
    clientChannel.onMessage?.(spam, publisherChannel.selfId);
    await settle(client);
    expect(client.cardList[0]?.title).toBe('Спам');
  });

  it('lobby-probe заставляет хоста прислать карточку', async () => {
    const { publisher, client, publisherChannel, clientChannel } = await createLobby();
    clients.push(client);
    publishers.push(publisher);
    await client.start();
    await publisher.start();
    // Связываем после старта: хост уже в лобби, гость «приходит» позже.
    publisherChannel.link(clientChannel);
    await settle(client);
    expect(client.cardList).toHaveLength(1);
  });

  it('lobby-remove снимает карточку, а закрытая комната не публикуется', async () => {
    const { publisher, client, publisherChannel, clientChannel } = await createLobby();
    clients.push(client);
    publishers.push(publisher);
    publisherChannel.link(clientChannel);
    await client.start();
    await publisher.start();
    await settle(client);
    expect(client.cardList).toHaveLength(1);

    publisher.remove();
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    await settle(client);
    expect(client.cardList).toHaveLength(0);

    const closed = await createLobby({ card: { closed: true } });
    clients.push(closed.client);
    publishers.push(closed.publisher);
    closed.publisherChannel.link(closed.clientChannel);
    await closed.client.start();
    await closed.publisher.start();
    await settle(closed.client);
    expect(closed.client.cardList).toHaveLength(0);
  });

  it('карточки заблокированных хостов не показываются', async () => {
    const { identity, publisher, client, publisherChannel, clientChannel } =
      await createLobby({ isBlockedHost: (userId) => userId === identity.userId });
    clients.push(client);
    publishers.push(publisher);
    publisherChannel.link(clientChannel);
    await client.start();
    await publisher.start();
    await settle(client);
    expect(client.cardList).toHaveLength(0);
  });
});
