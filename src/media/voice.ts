/*
 * Голос комнаты (§4.6).
 *
 * Микрофон берётся один раз с эхо- и шумоподавлением; вкл/выкл идёт через
 * `sender.replaceTrack` (net/trystero.ts) и не запускает renegotiation.
 * Индикатор речи и уровень считаются по AnalyserNode: чистые расчёты вынесены
 * в SpeakingDetector, чтобы их можно было проверить в Node без WebAudio.
 */

export const VOICE_CONSTRAINTS: MediaStreamConstraints = {
  audio: {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    channelCount: 1,
  },
  video: false,
};

/** Порог «говорит»: −42 dBFS, отпускание — ниже −48 dBFS. */
export const SPEAKING_ON_DB = -42;
export const SPEAKING_OFF_DB = -48;
export const SPEAKING_HOLD_MS = 600;
/** Как часто обновляем уровень в интерфейсе. */
export const LEVEL_INTERVAL_MS = 120;

export function rmsFromSamples(samples: Float32Array): number {
  if (samples.length === 0) {
    return 0;
  }
  let sum = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const value = samples[index] ?? 0;
    sum += value * value;
  }
  return Math.sqrt(sum / samples.length);
}

/** RMS → dBFS. Ноль и почти-ноль дают −80 dB, чтобы не уходить в −∞. */
export function rmsToDb(rms: number): number {
  const safe = Math.max(rms, 1e-4);
  return Math.max(-80, Math.min(0, 20 * Math.log10(safe)));
}

/** Уровень 0…1 для полоски микрофона. */
export function levelFromDb(db: number): number {
  return Math.max(0, Math.min(1, (db + 60) / 60));
}

export interface SpeakingDecision {
  speaking: boolean;
  level: number;
  db: number;
}

/**
 * Гистерезис индикатора речи: включается на −42 dBFS, выключается на −48 dBFS
 * после 600 мс тишины. Так мигание не дёргает интерфейс и ducking.
 */
export class SpeakingDetector {
  private speakingValue = false;
  private quietSince = 0;
  private readonly onDb: number;
  private readonly offDb: number;
  private readonly holdMs: number;

  constructor(options: { onDb?: number; offDb?: number; holdMs?: number } = {}) {
    this.onDb = options.onDb ?? SPEAKING_ON_DB;
    this.offDb = options.offDb ?? SPEAKING_OFF_DB;
    this.holdMs = options.holdMs ?? SPEAKING_HOLD_MS;
  }

  get speaking(): boolean {
    return this.speakingValue;
  }

  feed(rms: number, now: number): SpeakingDecision {
    const db = rmsToDb(rms);
    const level = levelFromDb(db);
    if (db >= this.onDb) {
      this.speakingValue = true;
      this.quietSince = 0;
    } else if (this.speakingValue) {
      // Тишина копится, пока уровень ниже порога включения, но мигание
      // «говорит/молчит» начинается только ниже порога выключения.
      if (this.quietSince === 0) {
        this.quietSince = now;
      }
      if (db <= this.offDb && now - this.quietSince >= this.holdMs) {
        this.speakingValue = false;
        this.quietSince = 0;
      }
    } else {
      this.quietSince = 0;
    }
    return { speaking: this.speakingValue, level, db };
  }

  reset(): void {
    this.speakingValue = false;
    this.quietSince = 0;
  }
}

export interface VoiceEngineCallbacks {
  onLocal?: (decision: SpeakingDecision) => void;
  onRemote?: (peerId: string, decision: SpeakingDecision) => void;
  onRemoteStream?: (peerId: string, stream: MediaStream) => void;
}

interface RemoteAnalyser {
  ctx: AudioContext;
  source: MediaStreamAudioSourceNode;
  analyser: AnalyserNode;
  detector: SpeakingDetector;
  timer: ReturnType<typeof setInterval> | null;
}

/**
 * Микрофон, уровни и входящие голоса.
 *
 * Свой поток анализирует один AudioContext; на каждый входящий поток — свой,
 * он закрывается вместе с пиром. Так слушатель без микрофона всё равно видит,
 * кто говорит, и не держит лишний контекст после выхода участника.
 */
export class VoiceEngine {
  private readonly callbacks: VoiceEngineCallbacks;
  private localStream: MediaStream | null = null;
  private localContext: AudioContext | null = null;
  private localAnalyser: AnalyserNode | null = null;
  private localDetector = new SpeakingDetector();
  private localTimer: ReturnType<typeof setInterval> | null = null;
  private localBuffer: Float32Array | null = null;
  private readonly remotes = new Map<string, RemoteAnalyser>();
  private stopped = false;

  constructor(callbacks: VoiceEngineCallbacks = {}) {
    this.callbacks = callbacks;
  }

  get stream(): MediaStream | null {
    return this.localStream;
  }

  get active(): boolean {
    return this.localStream !== null;
  }

  /** Запросить микрофон. Ошибку разбирает UI через describeVoiceError. */
  async start(): Promise<MediaStream> {
    if (this.localStream) {
      return this.localStream;
    }
    if (!isVoiceSupported()) {
      throw new Error('Микрофон доступен только в приложении HeliWatch');
    }
    const stream = await navigator.mediaDevices.getUserMedia(VOICE_CONSTRAINTS);
    this.localStream = stream;
    this.attachLocalAnalyser(stream);
    return stream;
  }

  /** Включить/выключить микрофон: трек остаётся, тишина — на выходе. */
  setMuted(muted: boolean): void {
    const track = this.localStream?.getAudioTracks()[0];
    if (track) {
      track.enabled = !muted;
    }
    if (this.localAnalyser) {
      this.localAnalyser.smoothingTimeConstant = 0.5;
    }
    if (muted) {
      this.localDetector.reset();
      this.callbacks.onLocal?.({ speaking: false, level: 0, db: -80 });
    }
  }

  /** Входящий голос пира: играем и показываем индикатор речи. */
  attachRemote(peerId: string, stream: MediaStream): void {
    if (this.stopped || this.remotes.has(peerId)) {
      return;
    }
    this.callbacks.onRemoteStream?.(peerId, stream);
    const AudioContextCtor = getAudioContextCtor();
    if (!AudioContextCtor) {
      return;
    }
    try {
      const ctx = new AudioContextCtor();
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);
      const detector = new SpeakingDetector();
      const buffer = new Float32Array(analyser.fftSize);
      const remote: RemoteAnalyser = { ctx, source, analyser, detector, timer: null };
      remote.timer = setInterval(() => {
        if (this.stopped) {
          return;
        }
        analyser.getFloatTimeDomainData(buffer as Float32Array<ArrayBuffer>);
        const decision = detector.feed(rmsFromSamples(buffer), Date.now());
        this.callbacks.onRemote?.(peerId, decision);
      }, LEVEL_INTERVAL_MS);
      this.remotes.set(peerId, remote);
      void ctx.resume().catch(() => undefined);
    } catch (error) {
      console.warn('[heliwatch] не удалось подключить голос пира', error);
    }
  }

  detachRemote(peerId: string): void {
    const remote = this.remotes.get(peerId);
    if (!remote) {
      return;
    }
    this.remotes.delete(peerId);
    if (remote.timer) {
      clearInterval(remote.timer);
    }
    try {
      remote.source.disconnect();
      remote.analyser.disconnect();
      void remote.ctx.close().catch(() => undefined);
    } catch {
      /* соединение уже закрыто */
    }
    this.callbacks.onRemote?.(peerId, { speaking: false, level: 0, db: -80 });
  }

  stop(): void {
    this.stopped = true;
    if (this.localTimer) {
      clearInterval(this.localTimer);
      this.localTimer = null;
    }
    for (const peerId of [...this.remotes.keys()]) {
      this.detachRemote(peerId);
    }
    if (this.localStream) {
      for (const track of this.localStream.getTracks()) {
        track.stop();
      }
      this.localStream = null;
    }
    this.localAnalyser = null;
    if (this.localContext) {
      void this.localContext.close().catch(() => undefined);
      this.localContext = null;
    }
  }

  private attachLocalAnalyser(stream: MediaStream): void {
    const AudioContextCtor = getAudioContextCtor();
    if (!AudioContextCtor) {
      return;
    }
    try {
      const ctx = new AudioContextCtor();
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.6;
      source.connect(analyser);
      this.localContext = ctx;
      this.localAnalyser = analyser;
      this.localBuffer = new Float32Array(analyser.fftSize);
      void ctx.resume().catch(() => undefined);
      this.localTimer = setInterval(() => {
        const analyserNode = this.localAnalyser;
        const buffer = this.localBuffer;
        if (this.stopped || !analyserNode || !buffer) {
          return;
        }
        const track = this.localStream?.getAudioTracks()[0];
        if (track && !track.enabled) {
          return;
        }
        analyserNode.getFloatTimeDomainData(buffer as Float32Array<ArrayBuffer>);
        this.callbacks.onLocal?.(
          this.localDetector.feed(rmsFromSamples(buffer), Date.now()),
        );
      }, LEVEL_INTERVAL_MS);
    } catch (error) {
      console.warn('[heliwatch] микрофон есть, но анализатор не поднялся', error);
    }
  }
}

type AudioContextCtor = typeof AudioContext;

function getAudioContextCtor(): AudioContextCtor | null {
  const scope = globalThis as unknown as {
    AudioContext?: AudioContextCtor;
    webkitAudioContext?: AudioContextCtor;
  };
  return scope.AudioContext ?? scope.webkitAudioContext ?? null;
}

export function isVoiceSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof navigator.mediaDevices?.getUserMedia === 'function'
  );
}

/** Понятный текст для ошибок getUserMedia (§ чеклист этапа 3). */
export function describeVoiceError(error: unknown): string {
  const name = typeof error === 'object' && error !== null && 'name' in error
    ? String((error as { name?: unknown }).name)
    : '';
  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
    case 'SecurityError':
      return 'Микрофон запрещён: разрешите запись звука в настройках Android для HeliWatch';
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return 'На телефоне не найден микрофон';
    case 'NotReadableError':
    case 'TrackStartError':
      return 'Микрофон занят другим приложением — закройте его и попробуйте снова';
    case 'OverconstrainedError':
    case 'ConstraintNotSatisfiedError':
      return 'Микрофон не поддерживает нужные параметры записи';
    case 'AbortError':
      return 'Запись с микрофона прервалась — попробуйте ещё раз';
    default:
      break;
  }
  if (error instanceof Error && error.message) {
    return `Не удалось включить микрофон: ${error.message}`;
  }
  return 'Не удалось включить микрофон';
}
