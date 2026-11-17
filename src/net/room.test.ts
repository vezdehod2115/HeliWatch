import { describe, expect, it } from 'vitest';
import {
  createEnvelope,
  generateRoomCode,
  type Envelope,
  type HelloData,
  type JoinData,
  type ProfilePayload,
  type PlaybackSample,
} from './protocol';
import { createIdentity, signEnvelope } from './identity';
import { RoomClient, type RoomEvent } from './room';
import type { Channel } from './transport';

const profile = (name: string): ProfilePayload => ({ name, color: '#6ff0c4' });

class FakeChannel implements Channel {
  readonly selfId: string;
  readonly strategy = 'fake';
  onPeerJoin: ((peerId: string) => void) | null = null;
  onPeerLeave: ((peerId: string) => void) | null = null;
  onMessage: ((data: unknown, peerId: string) => void) | null = null;
  readonly peers = new Map<string, FakeChannel>();
  readonly received: unknown[] = [];

  constructor(selfId: string) {
    this.selfId = selfId;
  }

  send(data: unknown, to?: string): void {
    const copy = JSON.parse(JSON.stringify(data)) as unknown;
    const targets = to ? [this.peers.get(to)] : [...this.peers.values()];
    for (const target of targets) {
      target?.received.push(copy);
      target?.onMessage?.(copy, this.selfId);
    }
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

const SAMPLE: PlaybackSample = {
  playing: true,
  time: 12,
  rate: 1,
  duration: 100,
};

async function settle(...clients: RoomClient[]): Promise<void> {
  for (let round = 0; round < 12; round += 1) {
    await Promise.all(clients.map((client) => client.whenIdle()));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  await Promise.all(clients.map((client) => client.whenIdle()));
}

async function createPair(): Promise<{
  host: RoomClient;
  guest: RoomClient;
  hostChannel: FakeChannel;
  guestChannel: FakeChannel;
  hostEvents: RoomEvent[];
  guestEvents: RoomEvent[];
}> {
  const code = generateRoomCode(new Uint8Array([1, 2, 3, 4, 5, 6]));
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
  return { host, guest, hostChannel, guestChannel, hostEvents, guestEvents };
}

describe('RoomClient: nonce-аутентификация и синхронизация', () => {
  it('хост и гость проходят hello → join → welcome', async () => {
    const { host, guest } = await createPair();
    expect(host.phase).toBe('joined');
    expect(guest.phase).toBe('joined');
    expect(guest.hostId).toBe(host.selfUserId);
    expect(host.memberList.map((member) => member.name).sort()).toEqual(['Гость', 'Хост']);
    expect(guest.memberList).toHaveLength(2);
    expect(guest.playback.src.url).toBe('https://example.com/');
  });

  it('play/pause/seek/rate доходят и seq растёт', async () => {
    const { host, guest } = await createPair();
    host.publishAction({ kind: 'play' }, SAMPLE);
    await settle(host, guest);

    expect(guest.playback.playing).toBe(true);
    expect(guest.playback.t).toBe(12);
    expect(guest.playback.by).toBe(host.selfUserId);
    expect(guest.playback.seq).toBe(1);

    guest.publishAction({ kind: 'seek', t: 42 }, { ...SAMPLE, time: 42 });
    await settle(host, guest);

    expect(host.playback.t).toBe(42);
    expect(host.playback.by).toBe(guest.selfUserId);
    expect(host.playback.seq).toBe(2);
  });

  it('«Синхронизировать ко мне» перехватывает driver', async () => {
    const { host, guest } = await createPair();
    host.publishAction({ kind: 'pause' }, { ...SAMPLE, playing: false, time: 30 });
    await settle(host, guest);

    guest.takeover({ playing: false, time: 5, rate: 1, duration: 100 });
    await settle(host, guest);

    expect(guest.playback.by).toBe(guest.selfUserId);
    expect(host.playback.by).toBe(guest.selfUserId);
    expect(host.playback.t).toBe(5);
  });

  it('state с меньшим seq не применяется', async () => {
    const { host, guest, hostChannel, guestChannel } = await createPair();
    host.publishAction({ kind: 'play' }, SAMPLE);
    await settle(host, guest);
    host.publishAction({ kind: 'seek', t: 60 }, { ...SAMPLE, time: 60 });
    await settle(host, guest);
    expect(guest.playback.seq).toBe(2);
    expect(guest.playback.t).toBe(60);

    const stale = createEnvelope(
      'state',
      {
        playing: false,
        t: 1,
        rate: 1,
        src: { mode: 'site', duration: 100 },
        seq: 1,
        by: host.selfUserId,
      },
      host.selfUserId,
      host.code,
    );
    hostChannel.send(stale, guestChannel.selfId);
    await settle(guest);

    expect(guest.playback.seq).toBe(2);
    expect(guest.playback.t).toBe(60);
  });

  it('коррекция срабатывает на расхождении > 1.5 с', async () => {
    const { host, guest, guestEvents } = await createPair();
    host.publishAction({ kind: 'play' }, SAMPLE);
    await settle(host, guest);

    guest.checkCorrection({ playing: true, time: 20, rate: 1, duration: 100 });
    const correction = guestEvents.find((event) => event.type === 'correction');
    expect(correction).toBeDefined();
    if (correction?.type === 'correction') {
      expect(correction.action.kind).toBe('seek');
    }
  });

  it('неверная подпись join отклоняется, повторный nonce — тоже', async () => {
    const code = generateRoomCode(new Uint8Array([9, 8, 7, 6, 5, 4]));
    const hostIdentity = await createIdentity();
    const rogueIdentity = await createIdentity();
    const hostChannel = new FakeChannel('peer-host');
    const rogueChannel = new FakeChannel('peer-rogue');
    const events: RoomEvent[] = [];
    const host = new RoomClient({
      code,
      role: 'host',
      mode: 'site',
      identity: hostIdentity,
      profile: profile('Хост'),
      connect: async () => hostChannel,
      onEvent: (event) => events.push(event),
      autoTimers: false,
    });
    await host.start();

    let hostNonce = '';
    rogueChannel.onMessage = (data) => {
      const envelope = data as Envelope;
      if (envelope.t === 'hello') {
        hostNonce = (envelope.d as HelloData).nonce;
        void sendRogueHello(hostNonce);
      }
    };

    const sendRogueHello = async (nonce: string): Promise<void> => {
      const hello: HelloData = {
        nonce: 'rogue-nonce-1234567890',
        pub: rogueIdentity.publicJwk,
        userId: rogueIdentity.userId,
        host: false,
        profile: profile('Взломщик'),
        ver: 1,
      };
      rogueChannel.send(createEnvelope('hello', hello, rogueIdentity.userId, code));
      const join: JoinData = {
        nonce,
        peerId: rogueChannel.selfId,
        profile: profile('Взломщик'),
        ver: 1,
      };
      const envelope = createEnvelope('join', join, rogueIdentity.userId, code, {
        to: hostChannel.selfId,
      });
      envelope.sig = await signEnvelope(envelope, rogueIdentity.privateJwk);
      // Портим подпись уже после подписи.
      envelope.ts += 1;
      rogueChannel.send(envelope);
    };

    hostChannel.link(rogueChannel);
    await settle(host);
    expect(host.memberList).toHaveLength(1);
    expect(
      events.some((event) => event.type === 'error' && event.message.includes('неверная подпись')),
    ).toBe(true);

    // Повторяем с корректной подписью: nonce ещё не погашен — вход проходит.
    const join: JoinData = {
      nonce: hostNonce,
      peerId: rogueChannel.selfId,
      profile: profile('Взломщик'),
      ver: 1,
    };
    const valid = createEnvelope('join', join, rogueIdentity.userId, code, {
      to: hostChannel.selfId,
    });
    valid.sig = await signEnvelope(valid, rogueIdentity.privateJwk);
    rogueChannel.send(valid);
    await settle(host);
    expect(host.memberList).toHaveLength(2);

    // Тот же nonce второй раз: хост обязан отклонить.
    const replay = { ...valid, id: '01J00000000000000000000001' };
    replay.sig = await signEnvelope(replay, rogueIdentity.privateJwk);
    rogueChannel.send(replay);
    await settle(host);

    const denied = rogueChannel.received.filter(
      (message) => (message as Envelope).t === 'join-deny',
    );
    expect(denied.length).toBeGreaterThan(0);
    const lastDenied = denied[denied.length - 1] as Envelope<{ reason: string }>;
    expect(lastDenied.d.reason).toBe('nonce-replayed');
  });
});
