import { describe, expect, it, vi } from 'vitest';
import { createHeartbeat, type HeartbeatMessage } from './heartbeat.js';

// A manually-driven fake timer: captures the tick callback so tests advance it
// explicitly, with zero reliance on real time.
function makeManualTimer() {
  let tickFn: (() => void) | null = null;
  const handle = Object.freeze({ token: 'fake-timer' });

  const setIntervalFn = vi.fn((cb: () => void, _ms: number): unknown => {
    tickFn = cb;
    return handle;
  });
  const clearIntervalFn = vi.fn((_handle: unknown): void => {
    tickFn = null;
  });

  const tick = (): void => {
    if (tickFn === null) throw new Error('timer not started');
    tickFn();
  };

  return { setIntervalFn, clearIntervalFn, tick, handle };
}

describe('createHeartbeat', () => {
  it('emits monotonically increasing seq starting at 1, with a numeric ts', () => {
    const timer = makeManualTimer();
    const frames: HeartbeatMessage[] = [];
    let clock = 1000;

    const hb = createHeartbeat({
      intervalMs: 1000,
      emit: (m) => frames.push(m),
      now: () => (clock += 1000),
      setIntervalFn: timer.setIntervalFn,
      clearIntervalFn: timer.clearIntervalFn,
    });

    hb.start();
    timer.tick();
    timer.tick();
    timer.tick();

    expect(frames.map((f) => f.seq)).toEqual([1, 2, 3]);
    for (const f of frames) {
      expect(f.type).toBe('heartbeat');
      expect(typeof f.ts).toBe('number');
      expect(Number.isFinite(f.ts)).toBe(true);
    }
    // ts advances with the injected clock
    expect(frames[1]!.ts).toBeGreaterThan(frames[0]!.ts);
  });

  it('matches the pinned frame shape { type, seq, ts }', () => {
    const timer = makeManualTimer();
    const frames: HeartbeatMessage[] = [];

    const hb = createHeartbeat({
      intervalMs: 1000,
      emit: (m) => frames.push(m),
      now: () => 42,
      setIntervalFn: timer.setIntervalFn,
      clearIntervalFn: timer.clearIntervalFn,
    });

    hb.start();
    timer.tick();

    expect(frames[0]).toEqual({ type: 'heartbeat', seq: 1, ts: 42 });
    expect(Object.keys(frames[0]!).sort()).toEqual(['seq', 'ts', 'type']);
  });

  it('creates a new frozen object each tick; prior frames are never mutated', () => {
    const timer = makeManualTimer();
    const frames: HeartbeatMessage[] = [];
    let clock = 0;

    const hb = createHeartbeat({
      intervalMs: 1000,
      emit: (m) => frames.push(m),
      now: () => (clock += 5),
      setIntervalFn: timer.setIntervalFn,
      clearIntervalFn: timer.clearIntervalFn,
    });

    hb.start();
    timer.tick(); // seq 1, ts 5
    timer.tick(); // seq 2, ts 10

    // Distinct object references, each frozen.
    expect(frames[0]).not.toBe(frames[1]);
    expect(Object.isFrozen(frames[0])).toBe(true);
    expect(Object.isFrozen(frames[1])).toBe(true);

    // Mutating a frame throws (module strict mode) and leaves it unchanged.
    expect(() => {
      (frames[0] as { seq: number }).seq = 999;
    }).toThrow(TypeError);
    expect(frames[0]).toEqual({ type: 'heartbeat', seq: 1, ts: 5 });

    // Emitting more frames does not disturb the earlier one.
    timer.tick(); // seq 3
    expect(frames[0]).toEqual({ type: 'heartbeat', seq: 1, ts: 5 });
  });

  it('stops emitting after stop() and clears the timer', () => {
    const timer = makeManualTimer();
    const frames: HeartbeatMessage[] = [];

    const hb = createHeartbeat({
      intervalMs: 1000,
      emit: (m) => frames.push(m),
      now: () => 1,
      setIntervalFn: timer.setIntervalFn,
      clearIntervalFn: timer.clearIntervalFn,
    });

    hb.start();
    timer.tick();
    timer.tick();
    expect(frames).toHaveLength(2);
    expect(hb.isRunning()).toBe(true);

    hb.stop();
    expect(timer.clearIntervalFn).toHaveBeenCalledWith(timer.handle);
    expect(hb.isRunning()).toBe(false);

    // No further frames arrive after stop (the captured tick is detached).
    expect(() => timer.tick()).toThrow('timer not started');
    expect(frames).toHaveLength(2);
  });

  it('ignores double start() and no-ops stop() when not running', () => {
    const timer = makeManualTimer();

    const hb = createHeartbeat({
      intervalMs: 1000,
      emit: () => undefined,
      setIntervalFn: timer.setIntervalFn,
      clearIntervalFn: timer.clearIntervalFn,
    });

    expect(hb.isRunning()).toBe(false);
    hb.stop(); // no-op, must not throw
    expect(timer.clearIntervalFn).not.toHaveBeenCalled();

    hb.start();
    hb.start(); // second start ignored
    expect(timer.setIntervalFn).toHaveBeenCalledTimes(1);
  });
});
