// Global bounded semaphore for concurrent owned sessions.
//
// Each owned session is a live Agent-SDK `query()` generator backed by a `claude`
// subprocess. This module is the LOCAL RESOURCE CAP (ARCHITECTURE §5 row 3, "cap
// concurrent sessions"): it bounds the number of *live* subprocesses process-wide so a
// spawn burst can't exhaust PIDs/memory — a slot is held for the whole session lifetime
// and released when the session ends. Mirrors tracker/spawn-limit.ts, but exposes
// acquire→release (not withSlot(fn)) because a session outlives its spawn call.
//
// NOTE: this is the machine-resource cap, NOT the subscription rate-limit "waiting"
// signal (ARCHITECTURE §3/§5 row 2). That genuine "waiting — plan limit" state is
// SDK-stream-driven (the subscription's 429-equivalent) and is a first-class fleet
// state DEFERRED to a later M2 task; today a spawn parked at the cap surfaces no
// queued/waiting state. Module-level state is intentional: the cap is global. No deps.

export const MAX_CONCURRENT_SESSIONS = 8;

// Hard cap on callers parked waiting for a slot. Past this, a new acquisition is
// REJECTED so a spawn flood degrades gracefully (the caller reports a spawn failure)
// instead of growing the waiter queue without bound.
export const MAX_SESSION_SPAWN_QUEUE = 64;

let inFlight = 0;
const waiters: Array<() => void> = [];

/** A one-shot release for a held slot. Calling it more than once is a no-op. */
export type ReleaseSlot = () => void;

/**
 * Acquire a session slot, resolving once one is free. Returns a one-shot release
 * function the caller MUST call when the session ends (via finally). Rejects when
 * every slot is held AND the waiter queue is already at MAX_SESSION_SPAWN_QUEUE.
 */
export function acquireSessionSlot(): Promise<ReleaseSlot> {
  const makeRelease = (): ReleaseSlot => {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = waiters.shift();
      if (next !== undefined) {
        next(); // hand the slot directly to the next waiter (inFlight unchanged)
      } else {
        inFlight -= 1;
      }
    };
  };

  if (inFlight < MAX_CONCURRENT_SESSIONS) {
    inFlight += 1;
    return Promise.resolve(makeRelease());
  }
  if (waiters.length >= MAX_SESSION_SPAWN_QUEUE) {
    return Promise.reject(
      new Error(
        `Session spawn queue full (${MAX_SESSION_SPAWN_QUEUE} already waiting) — refusing to park another spawn.`,
      ),
    );
  }
  return new Promise<ReleaseSlot>((resolve) => {
    waiters.push(() => resolve(makeRelease()));
  });
}
