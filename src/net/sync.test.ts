import { describe, expect, it } from 'vitest';
import { CommandRateLimiter, planCorrection } from './sync';
import type { PlaybackSample, PlaybackState } from './protocol';

const local = (overrides: Partial<PlaybackSample> = {}): PlaybackSample => ({
  playing: true,
  time: 10,
  rate: 1,
  duration: 100,
  ...overrides,
});

const remote = (overrides: Partial<PlaybackState> = {}): PlaybackState => ({
  playing: true,
  t: 10,
  rate: 1,
  src: { mode: 'site', url: 'https://example.com', duration: 100 },
  seq: 1,
  by: 'host',
  ...overrides,
});

const plan = (
  localSample: PlaybackSample,
  remoteState: PlaybackState,
  options: { now?: number; receivedAt?: number; lastCorrectionAt?: number } = {},
) =>
  planCorrection({
    local: localSample,
    remote: remoteState,
    receivedAt: options.receivedAt ?? 1000,
    now: options.now ?? 3000,
    lastCorrectionAt: options.lastCorrectionAt ?? 0,
  });

describe('planCorrection', () => {
  it('выравнивает play/pause в первую очередь', () => {
    expect(plan(local({ playing: false }), remote())).toEqual({ kind: 'play' });
    expect(plan(local({ playing: true }), remote({ playing: false }))).toEqual({ kind: 'pause' });
  });

  it('точное совпадение не трогает', () => {
    // remote t=10 при now-receivedAt=2 c → 12; local = 12.
    expect(plan(local({ time: 12 }), remote())).toBeNull();
  });

  it('расхождение > 1.5 с — seek к спроецированному времени', () => {
    const action = plan(local({ time: 20 }), remote());
    expect(action).toEqual({ kind: 'seek', t: 12 });
  });

  it('расхождение 0.3–1.5 с — временная скорость', () => {
    const ahead = plan(local({ time: 13 }), remote());
    expect(ahead?.kind).toBe('rate');
    expect(ahead?.rate).toBeCloseTo(0.95, 5);
    expect(ahead?.holdMs).toBe(4000);

    const behind = plan(local({ time: 11 }), remote());
    expect(behind?.kind).toBe('rate');
    expect(behind?.rate).toBeCloseTo(1.05, 5);
  });

  it('расхождение < 0.3 с игнорируется', () => {
    expect(plan(local({ time: 12.2 }), remote())).toBeNull();
  });

  it('не чаще одной коррекции в 2 секунды', () => {
    expect(plan(local({ time: 20 }), remote(), { lastCorrectionAt: 2000 })).toBeNull();
    expect(
      plan(local({ time: 20 }), remote(), { lastCorrectionAt: 1000, now: 3000 }),
    ).not.toBeNull();
  });

  it('на паузе seek не нужен', () => {
    expect(plan(local({ time: 20 }), remote({ playing: false }))).toEqual({ kind: 'pause' });
  });
});

describe('CommandRateLimiter', () => {
  it('пропускает 5 команд за окно и сбрасывается', () => {
    const limiter = new CommandRateLimiter(5, 5000);
    for (let index = 0; index < 5; index += 1) {
      expect(limiter.allow(1000)).toBe(true);
    }
    expect(limiter.allow(1000)).toBe(false);
    expect(limiter.allow(6001)).toBe(true);
  });
});
