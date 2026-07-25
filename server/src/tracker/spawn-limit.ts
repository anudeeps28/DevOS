// Global bounded semaphore for tracker-adapter bash spawns.
//
// readTrackerState shells out to each project's own adapter via
// execFile('bash', …). With many pinned projects a single WS frame can fan out
// into one spawn per project; without a cap that is an unbounded burst of shell
// processes (memory / PID DoS). This module caps the number of concurrent
// spawns process-wide and queues the rest FIFO — the slot is ALWAYS released in
// a finally, even when the wrapped fn rejects, so a failing adapter never leaks
// a slot. Module-level state is intentional: the cap is global to the process,
// not per-caller. No external dependencies.

export const MAX_CONCURRENT_TRACKER_SPAWNS = 4;

// Hard cap on how many callers may be parked waiting for a slot. Without it the
// waiters array is unbounded: a flood of read frames fanning out across many pinned
// projects faster than the adapters drain could grow the queue without limit
// (memory pressure). Past the cap, a new acquisition is REJECTED — the tracker-reader
// treats that rejection as a normal read failure (drop-don't-throw → "unreachable"),
// so the burst degrades gracefully instead of accumulating unbounded promises.
export const MAX_SPAWN_QUEUE = 64;

// Number of slots currently held (running fns, including any just handed off to
// a waiter). Never exceeds MAX_CONCURRENT_TRACKER_SPAWNS.
let inFlight = 0;

// FIFO queue of resolvers for callers parked at the cap. Resolving one hands it
// the releasing caller's slot directly (inFlight is not decremented on hand-off).
const waiters: Array<() => void> = [];

/**
 * Acquire a slot, resolving immediately if one is free or once one frees up. When
 * every slot is held AND the waiter queue is already at MAX_SPAWN_QUEUE, reject
 * instead of parking an unbounded number of callers.
 */
function acquire(): Promise<void> {
  if (inFlight < MAX_CONCURRENT_TRACKER_SPAWNS) {
    inFlight += 1;
    return Promise.resolve();
  }
  if (waiters.length >= MAX_SPAWN_QUEUE) {
    return Promise.reject(
      new Error(
        `Tracker spawn queue full (${MAX_SPAWN_QUEUE} already waiting) — refusing to park another spawn.`,
      ),
    );
  }
  return new Promise<void>((resolve) => {
    waiters.push(resolve);
  });
}

/**
 * Release a held slot. If a caller is waiting, hand it the slot directly (keep
 * inFlight unchanged); otherwise free the slot by decrementing inFlight.
 */
function release(): void {
  const next = waiters.shift();
  if (next !== undefined) {
    next();
  } else {
    inFlight -= 1;
  }
}

/**
 * Run `fn` under the global spawn cap: at most MAX_CONCURRENT_TRACKER_SPAWNS
 * `fn`s run at once; the rest queue FIFO. The slot is always released in a
 * finally, so a rejecting `fn` still frees its slot for the next waiter.
 */
export async function withSpawnSlot<T>(fn: () => Promise<T>): Promise<T> {
  await acquire();
  try {
    return await fn();
  } finally {
    release();
  }
}
