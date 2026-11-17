import { describe, expect, it } from 'vitest';
import { createIdentity } from './identity';
import { PairRoom, type PairRoomEvent } from './pair';
import { createUlid, pairRoomId } from './protocol';
import type { Channel } from './transport';

class LinkChannel implements Channel {
  readonly selfId: string;
  readonly strategy = 'fake';
  onPeerJoin: ((peerId: string) => void) | null = null;
  onPeerLeave: ((peerId: string) => void) | null = null;
  onMessage: ((data: unknown, peerId: string) => void) | null = null;
  onBlobMessage: ((data: unknown, peerId: string) => void) | null = null;
  onPeerStream:
    | ((stream: MediaStream, peerId: string, metadata?: unknown) => void)
    | null = null;
  private readonly peers = new Map<string, LinkChannel>();

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

  link(other: LinkChannel): void {
    this.peers.set(other.selfId, other);
    other.peers.set(this.selfId, this);
    this.onPeerJoin?.(other.selfId);
    other.onPeerJoin?.(this.selfId);
  }
}

async function settle(rounds = 20): Promise<void> {
  for (let round = 0; round < rounds; round += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

describe('PairRoom: парная и инвайт-комната', () => {
  it('после подписанного hello обе стороны получают ready', async () => {
    const a = await createIdentity();
    const b = await createIdentity();
    const roomId = await pairRoomId(a.userId, b.userId);
    const chA = new LinkChannel('peer-a');
    const chB = new LinkChannel('peer-b');
    const eventsA: PairRoomEvent[] = [];
    const eventsB: PairRoomEvent[] = [];
    const roomA = new PairRoom({
      roomId,
      kind: 'pair',
      identity: a,
      profile: { name: 'Аня', color: '#6ff0c4' },
      connect: async () => chA,
      allowedUsers: [b.userId],
      onEvent: (event) => eventsA.push(event),
    });
    const roomB = new PairRoom({
      roomId,
      kind: 'pair',
      identity: b,
      profile: { name: 'Боря', color: '#8ab4ff' },
      connect: async () => chB,
      allowedUsers: [a.userId],
      onEvent: (event) => eventsB.push(event),
    });
    await roomA.start();
    await roomB.start();
    chA.link(chB);
    await settle();

    expect(eventsA).toContainEqual(
      expect.objectContaining({ type: 'ready', userId: b.userId }),
    );
    expect(eventsB).toContainEqual(
      expect.objectContaining({ type: 'ready', userId: a.userId }),
    );

    // Текст лички доходит по тому же каналу с проверкой подписи.
    const payload = {
      msgId: createUlid(),
      kind: 'text' as const,
      text: 'привет',
      ts: Date.now(),
    };
    const envelope = await roomA.createSigned('dm-message', payload, b.userId);
    expect(envelope).not.toBeNull();
    if (envelope) {
      roomA.sendEnvelope(envelope, b.userId);
    }
    await settle();
    expect(eventsB).toContainEqual(
      expect.objectContaining({
        type: 'dm',
        from: a.userId,
        payload: expect.objectContaining({ text: 'привет' }),
      }),
    );

    await roomA.stop();
    await roomB.stop();
  });

  it('не пускает в парную комнату третьего участника', async () => {
    const a = await createIdentity();
    const b = await createIdentity();
    const intruder = await createIdentity();
    const roomId = await pairRoomId(a.userId, b.userId);
    const chA = new LinkChannel('peer-a');
    const chC = new LinkChannel('peer-c');
    const eventsA: PairRoomEvent[] = [];
    const roomA = new PairRoom({
      roomId,
      kind: 'pair',
      identity: a,
      profile: { name: 'Аня', color: '#6ff0c4' },
      connect: async () => chA,
      allowedUsers: [b.userId],
      onEvent: (event) => eventsA.push(event),
    });
    const roomC = new PairRoom({
      roomId,
      kind: 'pair',
      identity: intruder,
      profile: { name: 'Чужой', color: '#ff8494' },
      connect: async () => chC,
      allowedUsers: [b.userId],
      onEvent: () => undefined,
    });
    await roomA.start();
    await roomC.start();
    chA.link(chC);
    await settle();

    expect(eventsA).not.toContainEqual(
      expect.objectContaining({ type: 'ready', userId: intruder.userId }),
    );
    expect(eventsA).toContainEqual(
      expect.objectContaining({ type: 'error' }),
    );
    await roomA.stop();
    await roomC.stop();
  });
});
