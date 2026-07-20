// Pure, testable heartbeat logic.
//
// Produces the pinned server->client heartbeat frame:
//   { type: 'heartbeat', seq: <monotonic number>, ts: <epoch ms> }
//
// `seq` starts at 1 and increments once per tick. Every tick creates a NEW frozen
// object — prior frames are never mutated. The timer is injectable so unit tests
// can drive ticks deterministically without real time.

export interface HeartbeatMessage {
  readonly type: 'heartbeat';
  readonly seq: number;
  readonly ts: number;
}

// setInterval-/clearInterval-like shapes. The handle is opaque (`unknown`) so a
// fake timer in tests can return any token.
export type SetIntervalLike = (callback: () => void, ms: number) => unknown;
export type ClearIntervalLike = (handle: unknown) => void;

export interface HeartbeatOptions {
  readonly emit: (message: HeartbeatMessage) => void;
  readonly intervalMs: number;
  readonly now?: () => number;
  readonly setIntervalFn?: SetIntervalLike;
  readonly clearIntervalFn?: ClearIntervalLike;
}

export interface HeartbeatController {
  readonly start: () => void;
  readonly stop: () => void;
  readonly isRunning: () => boolean;
}

const defaultSetInterval: SetIntervalLike = (cb, ms) => setInterval(cb, ms);
const defaultClearInterval: ClearIntervalLike = (handle) =>
  clearInterval(handle as ReturnType<typeof setInterval>);

export function createHeartbeat(options: HeartbeatOptions): HeartbeatController {
  const now = options.now ?? Date.now;
  const setIntervalFn = options.setIntervalFn ?? defaultSetInterval;
  const clearIntervalFn = options.clearIntervalFn ?? defaultClearInterval;

  // Local counter + handle are the only mutable state; each tick still emits a
  // brand-new frozen message object (no message is ever mutated).
  let seq = 0;
  let handle: unknown = null;

  const tick = (): void => {
    seq += 1;
    const message = Object.freeze<HeartbeatMessage>({
      type: 'heartbeat',
      seq,
      ts: now(),
    });
    options.emit(message);
  };

  const start = (): void => {
    if (handle !== null) return; // already running — ignore double-start
    handle = setIntervalFn(tick, options.intervalMs);
  };

  const stop = (): void => {
    if (handle === null) return;
    clearIntervalFn(handle);
    handle = null;
  };

  const isRunning = (): boolean => handle !== null;

  return Object.freeze({ start, stop, isRunning });
}
