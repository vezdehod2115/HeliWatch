import { describe, expect, it } from 'vitest';
import { createIdentity, signEnvelope } from './identity';
import {
  createUlid,
  generateRoomCode,
  type DmMessagePayload,
  type ProfilePayload,
} from './protocol';
import { RoomClient, type RoomEvent } from './room';
import type { Channel } from './transport';

const profile = (name: string): ProfilePayload => ({ name, color: '#6ff0c4' });

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

  sendBlob(): void {}

  knownPeers(): string[] {
    return [...this.peers.keys()];
  }

  relayCount(): number {
    return 1;
  }

  leave(): void {
    this.peers.clear();
  }

  link(other: FakeChannel): void {
    this.peers.set(other.selfId, other);
    other.peers.set(this.selfId, this);
    this.onPeerJoin?.(other.selfId);
    other.onPeerJoin?.(this.selfId);
  }
}

async function drain(rounds = 10): Promise<void> {
  for (let round = 0; round < rounds; round += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

async function settle(...clients: RoomClient[]): Promise<void> {
  for (let round = 0; round < 12; round += 1) {
    await Promise.all(clients.map((client) => client.whenIdle()));
    await drain();
  }
  await Promise.all(clients.map((client) => client.whenIdle()));
}

async function createRoom() {
  const code = generateRoomCode(new Uint8Array([9, 8, 7, 6, 5, 4]));
  const hostIdentity = await createIdentity();
  const guestIdentity = await createIdentity();
  const hostChannel = new FakeChannel('peer-host');
  const guestChannel = new FakeChannel('peer-guest');
  const hostEvents: RoomEvent[] = [];
  const guestEvents: RoomEvent[] = [];
  const host = new RoomClient({
    code,
    role: 'host',
    mode: 'site',
    identity: hostIdentity,
    profile: profile('Хост'),
    connect: async () => hostChannel,
    onEvent: (event) => hostEvents.push(event),
    initialUrl: 'https://example.com/',
    autoTimers: false,
  });
  const guest = new RoomClient({
    code,
    role: 'guest',
    mode: 'site',
    identity: guestIdentity,
    profile: profile('Гость'),
    connect: async () => guestChannel,
    onEvent: (event) => guestEvents.push(event),
    autoTimers: false,
  });
  await host.start();
  await guest.start();
  hostChannel.link(guestChannel);
  await settle(host, guest);
  return {
    host,
    guest,
    hostIdentity,
    guestIdentity,
    hostEvents,
    guestEvents,
    hostChannel,
    guestChannel,
  };
}

function dmPayload(text: string): DmMessagePayload {
  return {
    msgId: createUlid(),
    kind: 'text',
    text,
    ts: Date.now(),
  };
}

describe('RoomClient: друзья и личка (этап 7)', () => {
  it('сообщает peer-ready с userId после авторизации пира', async () => {
    const { hostIdentity, guestIdentity, hostEvents, guestEvents } = await createRoom();
    expect(hostEvents).toContainEqual(
      expect.objectContaining({
        type: 'peer-ready',
        userId: guestIdentity.userId,
      }),
    );
    expect(guestEvents).toContainEqual(
      expect.objectContaining({
        type: 'peer-ready',
        userId: hostIdentity.userId,
      }),
    );
  });

  it('принимает подписанную заявку в друзья и отклоняет поддельную', async () => {
    const { guest, hostIdentity, guestIdentity, hostEvents } = await createRoom();
    const good = await guest.createSigned(
      'friend-request',
      { name: 'Гость', color: '#8ab4ff', note: 'привет' },
      hostIdentity.userId,
    );
    expect(good).not.toBeNull();
    if (good) {
      guest.sendEnvelope(good, hostIdentity.userId);
    }
    await drain();
    expect(hostEvents).toContainEqual(
      expect.objectContaining({
        type: 'friend-request',
        from: guestIdentity.userId,
        note: 'привет',
      }),
    );

    const forged = await guest.createSigned(
      'friend-request',
      { name: 'Гость', color: '#8ab4ff' },
      hostIdentity.userId,
    );
    const other = await createIdentity();
    if (forged) {
      forged.sig = await signEnvelope(forged, other.privateJwk);
      hostEvents.length = 0;
      guest.sendEnvelope(forged, hostIdentity.userId);
      await drain();
      expect(hostEvents).not.toContainEqual(
        expect.objectContaining({ type: 'friend-request' }),
      );
    }
  });

  it('доставляет личное сообщение и подтверждение dm-ack', async () => {
    const { guest, host, hostIdentity, guestIdentity, hostEvents, guestEvents } =
      await createRoom();
    const payload = dmPayload('привет из лички');
    const envelope = await guest.createSigned('dm-message', payload, hostIdentity.userId);
    expect(envelope).not.toBeNull();
    if (envelope) {
      guest.sendEnvelope(envelope, hostIdentity.userId);
    }
    await drain();
    expect(hostEvents).toContainEqual(
      expect.objectContaining({
        type: 'dm',
        from: guestIdentity.userId,
        payload: expect.objectContaining({ kind: 'text', text: 'привет из лички' }),
      }),
    );

    host.sendJson('dm-ack', { msgId: payload.msgId, ts: Date.now() }, guestIdentity.userId);
    await drain();
    expect(guestEvents).toContainEqual(
      expect.objectContaining({
        type: 'dm-ack',
        from: hostIdentity.userId,
        msgId: payload.msgId,
      }),
    );
  });

  it('проверяет подписи внутри dm-outbox-offer и выбрасывает подделку', async () => {
    const { guest, hostIdentity, guestIdentity, hostEvents } = await createRoom();
    const valid = await guest.createSigned('dm-message', dmPayload('из outbox'), hostIdentity.userId);
    const friend = await guest.createSigned(
      'friend-request',
      { name: 'Гость', color: '#8ab4ff' },
      hostIdentity.userId,
    );
    expect(valid && friend).toBeTruthy();
    if (!valid || !friend) {
      return;
    }
    const intruder = await createIdentity();
    const fake = { ...valid, id: createUlid(), d: dmPayload('подделка') };
    fake.sig = await signEnvelope(fake, intruder.privateJwk);
    hostEvents.length = 0;
    guest.sendJson(
      'dm-outbox-offer',
      { messages: [valid, friend, fake] },
      hostIdentity.userId,
    );
    // Три проверки подписи идут цепочкой await — одного тика мало.
    for (let round = 0; round < 10; round += 1) {
      await drain();
    }
    const offer = hostEvents.find((event) => event.type === 'dm-outbox');
    expect(offer).toBeTruthy();
    if (offer && offer.type === 'dm-outbox') {
      expect(offer.from).toBe(guestIdentity.userId);
      expect(offer.messages).toHaveLength(2);
      expect(offer.messages.every((message) => message.sig)).toBe(true);
    }
  });

  it('игнорирует dm-ack от неавторизованного пира', async () => {
    const { guest, guestIdentity, hostChannel, guestEvents } = await createRoom();
    guestEvents.length = 0;
    // Кадр с чужим `from` уходит в guest от имени хоста: RoomClient сверяет
    // envelope.from с userId, которого ждёт от этого peerId.
    const fake = {
      v: 1,
      t: 'dm-ack',
      id: createUlid(),
      ts: Date.now(),
      from: 'X'.repeat(80),
      rid: guest.code,
      to: guestIdentity.userId,
      d: { msgId: createUlid() },
    };
    hostChannel.send(fake, 'peer-guest');
    await drain();
    expect(guestEvents).not.toContainEqual(expect.objectContaining({ type: 'dm-ack' }));
  });
});
