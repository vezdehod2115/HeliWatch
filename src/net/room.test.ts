import { describe, expect, it } from 'vitest';
import {
  createEnvelope,
  generateRoomCode,
  type Envelope,
  type HelloData,
  type JoinData,
  type ProfilePayload,
  type PlaybackSample,
  type RoomMode,
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
  onBlobMessage: ((data: unknown, peerId: string) => void) | null = null;
  onPeerStream:
    | ((stream: MediaStream, peerId: string, metadata?: unknown) => void)
    | null = null;
  readonly peers = new Map<string, FakeChannel>();
  readonly received: unknown[] = [];
  readonly receivedBlobs: unknown[] = [];
  /** Записи вызовов голосового API: проверяем replaceTrack без renegotiation. */
  readonly streamCalls: string[] = [];
  /** Записи видеопотока: addScreenStream/removeScreenStream (этап 5). */
  readonly screenStreams: MediaStream[] = [];
  readonly removedScreenStreams: MediaStream[] = [];
  micTrack: MediaStreamTrack | null = null;
  mutedCalls: boolean[] = [];

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

  sendBlob(data: ArrayBuffer, to?: string): void {
    const copy = data.slice(0);
    const targets = to ? [this.peers.get(to)] : [...this.peers.values()];
    for (const target of targets) {
      target?.receivedBlobs.push(copy);
      target?.onBlobMessage?.(copy, this.selfId);
    }
  }

  addStream(stream: MediaStream): void {
    this.micTrack = stream.getAudioTracks?.()[0] ?? null;
    this.streamCalls.push('addStream');
  }

  addScreenStream(stream: MediaStream): void {
    this.screenStreams.push(stream);
  }

  removeScreenStream(stream: MediaStream): void {
    this.removedScreenStreams.push(stream);
  }

  setMicMuted(track: MediaStreamTrack, muted: boolean): void {
    this.mutedCalls.push(muted);
    void track;
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

async function createPair(
  mode: RoomMode = 'site',
  beforeSettle?: (hostChannel: FakeChannel, guestChannel: FakeChannel) => void,
): Promise<{
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
    mode,
    identity: hostIdentity,
    profile: profile('Хост'),
    connect: async () => hostChannel,
    onEvent: (event) => hostEvents.push(event),
    initialUrl: mode === 'site' ? 'https://example.com/' : undefined,
    autoTimers: false,
  });
  const guest = new RoomClient({
    code,
    role: 'guest',
    // Гость не знает режим до welcome: начальный режим перезапишет хост.
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
  beforeSettle?.(hostChannel, guestChannel);
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

describe('RoomClient: чат, реакции, «печатает…»', () => {
  it('сообщение доходит до собеседника с именем и цветом', async () => {
    const { host, guest, guestEvents } = await createPair();
    const sent = host.sendChat('Привет из комнаты');
    expect(sent?.self).toBe(true);
    expect(sent?.text).toBe('Привет из комнаты');
    await settle(host, guest);

    const chat = guestEvents.find((event) => event.type === 'chat');
    expect(chat).toBeDefined();
    if (chat?.type === 'chat') {
      expect(chat.message.text).toBe('Привет из комнаты');
      expect(chat.message.name).toBe('Хост');
      expect(chat.message.color).toBe('#6ff0c4');
      expect(chat.message.self).toBe(false);
      expect(chat.message.id).toBe(sent?.id);
    }
  });

  it('пустой текст не отправляется, ответ с replyTo сохраняется', async () => {
    const { host, guest, guestEvents } = await createPair();
    expect(host.sendChat('   ')).toBeNull();
    await settle(host, guest);
    expect(guestEvents.some((event) => event.type === 'chat')).toBe(false);

    host.sendChat('ответ', 'msg-previous');
    await settle(host, guest);
    const chat = guestEvents.filter((event) => event.type === 'chat').pop();
    if (chat?.type === 'chat') {
      expect(chat.message.replyTo).toBe('msg-previous');
    } else {
      throw new Error('сообщение не дошло');
    }
  });

  it('флуд от одного пира режется лимитом 12 сообщений', async () => {
    const { host, guest, hostEvents, guestChannel } = await createPair();
    // Антифлуд отправителя обходим: бьём сырыми конвертами, как шумный пир.
    for (let index = 0; index < 20; index += 1) {
      guestChannel.send(
        createEnvelope('room-chat', { text: `сообщение ${index}` }, guest.selfUserId, host.code),
      );
    }
    await settle(host, guest);
    const delivered = hostEvents.filter((event) => event.type === 'chat');
    expect(delivered.length).toBe(12);
  });

  it('реакция и typing доходят до собеседника', async () => {
    const { host, guest, guestEvents } = await createPair();
    expect(host.sendReaction('🔥', { x: 0.2, y: 0.8 })).not.toBeNull();
    expect(host.sendReaction('не эмодзи')).toBeNull();
    host.sendTyping(true);
    await settle(host, guest);

    const reaction = guestEvents.find((event) => event.type === 'reaction');
    expect(reaction).toBeDefined();
    if (reaction?.type === 'reaction') {
      expect(reaction.emoji).toBe('🔥');
      expect(reaction.name).toBe('Хост');
      expect(reaction.x).toBeCloseTo(0.2, 5);
    }
    const typing = guestEvents.find((event) => event.type === 'typing');
    if (typing?.type === 'typing') {
      expect(typing.on).toBe(true);
      expect(typing.name).toBe('Хост');
    } else {
      throw new Error('typing не дошёл');
    }
  });
});

describe('RoomClient: стрим файла хоста (этап 5)', () => {
  function fakeScreenStream(): MediaStream {
    return {
      getVideoTracks: () => [{}],
      getAudioTracks: () => [],
      getTracks: () => [],
    } as unknown as MediaStream;
  }

  it('хост в режиме stream объявляет лимит 3 и принимает только двух зрителей', async () => {
    const code = generateRoomCode(new Uint8Array([5, 5, 5, 5, 5, 5]));
    const hostIdentity = await createIdentity();
    const hostChannel = new FakeChannel('peer-host');
    const host = new RoomClient({
      code,
      role: 'host',
      mode: 'stream',
      identity: hostIdentity,
      profile: profile('Хост'),
      connect: async () => hostChannel,
      onEvent: () => undefined,
      autoTimers: false,
    });
    await host.start();

    const guests: RoomClient[] = [];
    for (let index = 0; index < 3; index += 1) {
      const identity = await createIdentity();
      const channel = new FakeChannel(`peer-guest-${index}`);
      const guest = new RoomClient({
        code,
        role: 'guest',
        mode: 'site',
        identity,
        profile: profile(`Гость ${index}`),
        connect: async () => channel,
        onEvent: () => undefined,
        autoTimers: false,
      });
      await guest.start();
      hostChannel.link(channel);
      guests.push(guest);
    }
    await settle(host, ...guests);

    expect(host.memberList).toHaveLength(3);
    expect(guests[0]?.phase).toBe('joined');
    expect(guests[1]?.phase).toBe('joined');
    expect(guests[2]?.phase).toBe('error');
  });

  it('stream-start/stream-stop доходят зрителю и состояние ведёт хост', async () => {
    const { host, guest, guestEvents } = await createPair('stream');
    expect(guest.playback.src.mode).toBe('stream');

    host.publishStreamStart({
      fileName: 'movie.mp4',
      duration: 120,
      maxViewers: 2,
      capture: 'direct',
    });
    await settle(host, guest);
    const start = guestEvents.find((event) => event.type === 'stream-start');
    expect(start).toBeDefined();
    if (start?.type === 'stream-start') {
      expect(start.info.fileName).toBe('movie.mp4');
      expect(start.info.maxViewers).toBe(2);
    }
    expect(host.streaming).toBe(true);

    // Зритель не может перехватить управление: play/pause публикует только хост.
    guest.publishAction({ kind: 'play' }, SAMPLE);
    await settle(host, guest);
    expect(host.playback.by).toBe(host.selfUserId);

    host.publishStreamStop('host-stop');
    await settle(host, guest);
    expect(host.streaming).toBe(false);
    expect(guestEvents.some((event) => event.type === 'stream-stop')).toBe(true);
  });

  it('видеопоток хоста приходит отдельным screen-stream, а не голосом', async () => {
    const { host, guest, hostChannel, guestChannel, guestEvents } = await createPair('stream');
    guestChannel.onPeerStream?.(fakeScreenStream(), hostChannel.selfId, { kind: 'screen' });
    await settle(guest);
    expect(guestEvents.some((event) => event.type === 'screen-stream')).toBe(true);
    expect(guestEvents.some((event) => event.type === 'voice-stream')).toBe(false);
    expect(host.phase).toBe('joined');
  });

  it('видеопоток, пришедший раньше welcome, не теряется', async () => {
    const { guestEvents } = await createPair('stream', (hostChannel, guestChannel) => {
      guestChannel.onPeerStream?.(fakeScreenStream(), hostChannel.selfId, { kind: 'screen' });
    });
    expect(guestEvents.some((event) => event.type === 'screen-stream')).toBe(true);
  });

  it('attachScreen/detachScreen передают поток в транспорт и снимают его', async () => {
    const { host, hostChannel } = await createPair('stream');
    const stream = fakeScreenStream();
    host.attachScreen(stream);
    expect(hostChannel.screenStreams).toContain(stream);

    host.detachScreen();
    expect(hostChannel.removedScreenStreams).toContain(stream);
  });
});

describe('RoomClient: фото и голос', () => {
  it('фото проходит чанками и собирается у получателя', async () => {
    const { host, guest, guestEvents } = await createPair();
    const bytes = new Uint8Array(1000);
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = index % 251;
    }
    const handle = host.sendImage({ bytes, mime: 'image/jpeg', w: 320, h: 240 });
    const result = await handle.done;
    expect(result.ok).toBe(true);
    await settle(host, guest);
    await new Promise((resolve) => setTimeout(resolve, 30));
    await settle(host, guest);

    const image = guestEvents.find((event) => event.type === 'image');
    if (image?.type !== 'image') {
      throw new Error('фото не собралось');
    }
    expect(image.bytes.byteLength).toBe(bytes.byteLength);
    expect(image.mime).toBe('image/jpeg');
    expect(image.name).toBe('Хост');
  });

  it('микрофон идёт addStream, mute — setMicMuted без повторного addStream', async () => {
    const { host, hostChannel } = await createPair();
    const track = { kind: 'audio', enabled: true } as unknown as MediaStreamTrack;
    const stream = {
      getAudioTracks: () => [track],
      getTracks: () => [track],
    } as unknown as MediaStream;

    host.attachVoice(stream);
    expect(hostChannel.streamCalls).toEqual(['addStream']);
    expect(track.enabled).toBe(true);

    host.setMicMuted(true);
    expect(hostChannel.mutedCalls).toEqual([true]);
    expect(host.micMuted).toBe(true);

    host.setMicMuted(false);
    expect(hostChannel.mutedCalls).toEqual([true, false]);
    // Повторного addStream (renegotiation) нет — только replaceTrack.
    expect(hostChannel.streamCalls).toEqual(['addStream']);
  });
});

interface Stage6HostConfig {
  hostMode?: RoomMode;
  hostTitle?: string;
  hostLimit?: number;
  hostClosed?: boolean;
  hostKnock?: boolean;
  hostPassword?: string | null;
  banned?: Set<string>;
}

async function stage6Pair(config: Stage6HostConfig = {}): Promise<{
  code: string;
  host: RoomClient;
  guest: RoomClient;
  hostChannel: FakeChannel;
  guestChannel: FakeChannel;
  hostEvents: RoomEvent[];
  guestEvents: RoomEvent[];
  hostIdentity: Awaited<ReturnType<typeof createIdentity>>;
  guestIdentity: Awaited<ReturnType<typeof createIdentity>>;
}> {
  const code = generateRoomCode(new Uint8Array([7, 1, 2, 3, 4, 5]));
  const hostIdentity = await createIdentity();
  const guestIdentity = await createIdentity();
  const hostChannel = new FakeChannel('peer-host');
  const guestChannel = new FakeChannel('peer-guest');
  const hostEvents: RoomEvent[] = [];
  const guestEvents: RoomEvent[] = [];

  const host = new RoomClient({
    code,
    role: 'host',
    mode: config.hostMode ?? 'site',
    identity: hostIdentity,
    profile: profile('Хост'),
    connect: async () => hostChannel,
    onEvent: (event) => hostEvents.push(event),
    autoTimers: false,
    meta: {
      title: config.hostTitle,
      limit: config.hostLimit,
      closed: config.hostClosed,
      knock: config.hostKnock,
    },
    password: config.hostPassword ?? null,
    isBanned: (userId) => config.banned?.has(userId) === true,
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
    password: config.hostPassword ?? null,
  });

  await host.start();
  await guest.start();
  hostChannel.link(guestChannel);
  await settle(host, guest);
  return {
    code,
    host,
    guest,
    hostChannel,
    guestChannel,
    hostEvents,
    guestEvents,
    hostIdentity,
    guestIdentity,
  };
}

async function addStage6Guest(
  host: RoomClient,
  hostChannel: FakeChannel,
  name: string,
): Promise<{
  guest: RoomClient;
  channel: FakeChannel;
  events: RoomEvent[];
}> {
  const identity = await createIdentity();
  const channel = new FakeChannel(`peer-${name}`);
  const events: RoomEvent[] = [];
  const guest = new RoomClient({
    code: host.code,
    role: 'guest',
    mode: 'site',
    identity,
    profile: profile(name),
    connect: async () => channel,
    onEvent: (event) => events.push(event),
    autoTimers: false,
  });
  await guest.start();
  hostChannel.link(channel);
  await settle(host, guest);
  return { guest, channel, events };
}

describe('RoomClient: открытые/закрытые комнаты и пароль (этап 6)', () => {
  it('пароль комнаты проверяется при входе, без него — отказ', async () => {
    const { host, hostChannel, guestEvents, hostIdentity } = await stage6Pair({
      hostPassword: 'тайный кот',
      hostTitle: 'С паролем',
    });
    expect(host.selfIsHost).toBe(true);
    expect(host.hostId).toBe(hostIdentity.userId);
    expect(host.roomMeta.title).toBe('С паролем');

    // Гость без пароля: хост отклоняет join.
    const noPasswordIdentity = await createIdentity();
    const noPasswordChannel = new FakeChannel('peer-nopass');
    const noPasswordEvents: RoomEvent[] = [];
    const noPassword = new RoomClient({
      code: host.code,
      role: 'guest',
      mode: 'site',
      identity: noPasswordIdentity,
      profile: profile('Без пароля'),
      connect: async () => noPasswordChannel,
      onEvent: (event) => noPasswordEvents.push(event),
      autoTimers: false,
    });
    await noPassword.start();
    hostChannel.link(noPasswordChannel);
    await settle(host, noPassword);
    expect(noPassword.phase).toBe('error');
    expect(
      noPasswordEvents.some(
        (event) => event.type === 'error' && event.message.includes('Неверный пароль'),
      ),
    ).toBe(true);
    expect(guestEvents.length).toBeGreaterThanOrEqual(0);
  });

  it('«стук»: гость ждёт, хост принимает и отклоняет', async () => {
    const { host, guest, hostChannel, hostEvents, guestEvents } = await stage6Pair({
      hostKnock: true,
    });
    expect(host.memberList).toHaveLength(1);
    expect(guest.phase).not.toBe('joined');
    const request = hostEvents.find((event) => event.type === 'join-request');
    expect(request).toBeDefined();
    let requester = '';
    if (request?.type === 'join-request') {
      requester = request.request.userId;
      expect(request.request.name).toBe('Гость');
    }
    expect(host.joinRequests).toHaveLength(1);

    expect(host.acceptJoin(requester)).toBe(true);
    await settle(host, guest);
    expect(guest.phase).toBe('joined');
    expect(host.memberList).toHaveLength(2);

    // Второй гость: хост отклоняет стук.
    const second = await addStage6Guest(host, hostChannel, 'Гость-2');
    const pending = host.joinRequests[0];
    expect(pending).toBeDefined();
    if (pending) {
      expect(host.denyJoin(pending.userId, 'knock-denied')).toBe(true);
      await settle(host, second.guest);
      expect(second.guest.phase).toBe('error');
      expect(
        second.events.some(
          (event) => event.type === 'error' && event.message.includes('отклонил'),
        ),
      ).toBe(true);
    }
    // У первого гостя welcome обновил состав.
    expect(guestEvents.some((event) => event.type === 'members')).toBe(true);
  });

  it('лимит комнаты: третий гость не входит, если лимит 2', async () => {
    const { host, guest, hostChannel } = await stage6Pair({ hostLimit: 2 });
    expect(host.memberList).toHaveLength(2);
    expect(guest.phase).toBe('joined');

    const extra = await addStage6Guest(host, hostChannel, 'Лишний');
    expect(extra.guest.phase).toBe('error');
    expect(
      extra.events.some(
        (event) => event.type === 'error' && event.message.includes('нет свободных мест'),
      ),
    ).toBe(true);
  });

  it('бан-лист хоста не пускает забаненного гостя', async () => {
    const first = await stage6Pair();
    const bannedId = first.guest.selfUserId;

    // Тот же человек (тот же ключ) пробует зайти снова, а хост его помнит.
    const hostChannel = new FakeChannel('peer-host-2');
    const guestChannel = new FakeChannel('peer-guest-2');
    const guestEvents: RoomEvent[] = [];
    const bannedHost = new RoomClient({
      code: first.code,
      role: 'host',
      mode: 'site',
      identity: first.hostIdentity,
      profile: profile('Хост'),
      connect: async () => hostChannel,
      onEvent: () => undefined,
      autoTimers: false,
      isBanned: (userId) => userId === bannedId,
    });
    const returning = new RoomClient({
      code: first.code,
      role: 'guest',
      mode: 'site',
      identity: first.guestIdentity,
      profile: profile('Забаненный'),
      connect: async () => guestChannel,
      onEvent: (event) => guestEvents.push(event),
      autoTimers: false,
    });
    await bannedHost.start();
    await returning.start();
    hostChannel.link(guestChannel);
    await settle(bannedHost, returning);

    expect(returning.phase).toBe('error');
    expect(
      guestEvents.some(
        (event) => event.type === 'error' && event.message.includes('заблокировал'),
      ),
    ).toBe(true);
    expect(bannedHost.memberList).toHaveLength(1);
  });

  it('кик убирает участника и сообщает ему причину', async () => {
    const { host, guest, hostEvents, guestEvents } = await stage6Pair();
    const kicked = host.kick(guest.selfUserId, 'шум');
    expect(kicked).toBe(true);
    await settle(host, guest);
    expect(host.memberList).toHaveLength(1);
    expect(
      hostEvents.some((event) => event.type === 'moderation' && event.action === 'kick'),
    ).toBe(true);
    expect(
      guestEvents.some((event) => event.type === 'kicked' && event.reason === 'kicked'),
    ).toBe(true);
    expect(guest.phase).toBe('closed');
  });

  it('бан закрывает комнату для цели и попадает в события', async () => {
    const { host, guest, guestEvents } = await stage6Pair();
    const until = Date.now() + 1000;
    expect(host.ban(guest.selfUserId, 'спам', until)).toBe(true);
    await settle(host, guest);
    const banned = guestEvents.find((event) => event.type === 'kicked');
    if (banned?.type !== 'kicked') {
      throw new Error('бан не дошёл');
    }
    expect(banned.reason).toBe('banned');
    expect(banned.until).toBe(until);
    expect(guest.phase).toBe('closed');
  });

  it('mute-request доходит до цели, остальные его не видят', async () => {
    const { host, guest, guestEvents } = await stage6Pair();
    expect(host.requestMute(guest.selfUserId)).toBe(true);
    await settle(host, guest);
    expect(
      guestEvents.some((event) => event.type === 'mute-request' && event.name === 'Хост'),
    ).toBe(true);
  });

  it('передача хоста: гость становится хостом с новой эпохой', async () => {
    const { host, guest, hostEvents, guestEvents } = await stage6Pair();
    const epochBefore = guest.epoch;
    expect(host.transferHost(guest.selfUserId)).toBe(true);
    await settle(host, guest);

    expect(guest.selfIsHost).toBe(true);
    expect(guest.hostId).toBe(guest.selfUserId);
    expect(guest.epoch).toBeGreaterThan(epochBefore);
    expect(host.selfIsHost).toBe(false);
    expect(host.hostId).toBe(guest.selfUserId);
    expect(
      hostEvents.some((event) => event.type === 'host-changed' && !event.self),
    ).toBe(true);
    expect(
      guestEvents.some((event) => event.type === 'host-changed' && event.self),
    ).toBe(true);
  });

  it('уход хоста в режиме A: преемник продолжает комнату, эпоха растёт', async () => {
    const pair = await stage6Pair();
    const epoch = pair.guest.epoch;
    await pair.host.stop('host-left');
    await settle(pair.guest);
    expect(pair.guest.phase).toBe('joined');
    expect(pair.guest.selfIsHost).toBe(true);
    expect(pair.guest.hostId).toBe(pair.guest.selfUserId);
    expect(pair.guest.epoch).toBe(epoch + 1);
    expect(pair.guest.memberList).toHaveLength(1);
  });

  it('уход хоста в режиме B закрывает комнату: миграции нет', async () => {
    const pair = await stage6Pair({ hostMode: 'stream' });
    await pair.host.stop('host-left');
    await settle(pair.guest);
    expect(pair.guest.phase).toBe('closed');
    expect(pair.guest.selfIsHost).toBe(false);
  });

  it('room-meta от хоста меняет название и лимит у гостя', async () => {
    const { host, guest, guestEvents } = await stage6Pair();
    expect(host.updateRoomMeta({ title: 'Кино на двоих', limit: 6, closed: false })).toBe(
      true,
    );
    await settle(host, guest);
    expect(guest.roomMeta.title).toBe('Кино на двоих');
    expect(guest.roomMeta.limit).toBe(6);
    expect(guestEvents.some((event) => event.type === 'meta')).toBe(true);
  });

  it('гость не может менять настройки, кикать и передавать хост', async () => {
    const { host, guest, hostEvents } = await stage6Pair();
    expect(guest.updateRoomMeta({ title: 'Взлом' })).toBe(false);
    expect(guest.kick(host.selfUserId)).toBe(false);
    expect(guest.transferHost(host.selfUserId)).toBe(false);
    await settle(host, guest);
    expect(host.roomMeta.title).not.toBe('Взлом');
    expect(hostEvents.some((event) => event.type === 'moderation')).toBe(false);
  });

  it('гость-гость: состояние принимается после поручительства хоста', async () => {
    const { host, guest, hostChannel, guestChannel } = await stage6Pair();
    const second = await addStage6Guest(host, hostChannel, 'Гость-2');
    // trystero поднимает mesh: гости соединены друг с другом напрямую.
    guestChannel.link(second.channel);
    await settle(host, guest, second.guest);

    guest.takeover({ playing: true, time: 7, rate: 1, duration: 100 });
    await settle(host, guest, second.guest);
    expect(second.guest.playback.by).toBe(guest.selfUserId);
    expect(second.guest.playback.t).toBe(7);
  });

  it('поздний гость получает welcome с чужим driver и всё равно входит', async () => {
    const { host, guest, hostChannel, guestChannel } = await stage6Pair();
    const second = await addStage6Guest(host, hostChannel, 'Гость-2');
    guestChannel.link(second.channel);
    await settle(host, guest, second.guest);

    guest.publishAction({ kind: 'seek', t: 42 }, { ...SAMPLE, time: 42 });
    await settle(host, guest, second.guest);
    expect(host.playback.by).toBe(guest.selfUserId);

    const third = await addStage6Guest(host, hostChannel, 'Гость-3');
    expect(third.guest.phase).toBe('joined');
    expect(third.guest.playback.by).toBe(guest.selfUserId);
    expect(third.guest.playback.t).toBe(42);
  });

  it('миграция при трёх участниках выбирает одного хоста по userId', async () => {
    const { host, guest, hostChannel, guestChannel } = await stage6Pair();
    const second = await addStage6Guest(host, hostChannel, 'Гость-2');
    guestChannel.link(second.channel);
    await settle(host, guest, second.guest);

    await host.stop('host-left');
    await settle(guest, second.guest);

    const expected = [guest.selfUserId, second.guest.selfUserId].sort()[0];
    expect(guest.hostId).toBe(expected);
    expect(second.guest.hostId).toBe(expected);
    expect(guest.selfIsHost).toBe(guest.selfUserId === expected);
    expect(second.guest.selfIsHost).toBe(second.guest.selfUserId === expected);
    expect(guest.memberList.map((member) => member.userId).sort()).toEqual(
      [guest.selfUserId, second.guest.selfUserId].sort(),
    );
  });
});

describe('RoomClient: очередь видео (этап 8)', () => {
  it('хост публикует очередь, гость видит её и не может менять', async () => {
    const { host, guest, hostEvents, guestEvents } = await createPair();
    host.publishQueue(
      [
        { url: 'https://youtu.be/a', title: 'Первый' },
        { url: 'https://youtu.be/b', title: 'Второй' },
      ],
      1,
    );
    await settle(host, guest);

    const received = guestEvents.filter((event) => event.type === 'queue');
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      type: 'queue',
      index: 1,
      items: [
        { url: 'https://youtu.be/a', title: 'Первый' },
        { url: 'https://youtu.be/b', title: 'Второй' },
      ],
    });

    // Гость не хост: его очередь не должна приниматься ни хостом, ни им самим.
    guest.publishQueue([{ url: 'https://youtu.be/c', title: 'Третий' }], 0);
    await settle(host, guest);
    expect(guestEvents.filter((event) => event.type === 'queue')).toHaveLength(1);
    expect(hostEvents.some((event) => event.type === 'queue')).toBe(false);
  });
});
