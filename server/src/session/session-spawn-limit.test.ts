// Unit tests for the global session-spawn semaphore.
//
// Deterministic (macrotask flushes, no sleeps). Because the semaphore is module-global,
// each test fully drains its slots so state never leaks into the next. Proves:
//   1. up to the cap acquires immediately; the next parks until a release;
//   2. release is one-shot — a double release frees only one slot;
//   3. acquisition past the queue cap rejects, then the queue still drains.

import { describe, expect, it } from 'vitest';
import {
  MAX_CONCURRENT_SESSIONS,
  MAX_SESSION_SPAWN_QUEUE,
  acquireSessionSlot,
  type ReleaseSlot,
} from './session-spawn-limit.js';

/** Flush microtask + macrotask queues so parked acquires can proceed. */
function tick(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

describe('acquireSessionSlot', () => {
  it('grants up to the cap immediately and parks the next until a release', async () => {
    const held: ReleaseSlot[] = [];
    for (let i = 0; i < MAX_CONCURRENT_SESSIONS; i++) held.push(await acquireSessionSlot());

    // The cap is saturated — the next acquisition must park.
    let granted = false;
    const parked = acquireSessionSlot().then((r) => {
      granted = true;
      return r;
    });
    await tick();
    expect(granted).toBe(false);

    // Releasing one held slot hands it directly to the parked waiter.
    held[0]?.();
    await tick();
    expect(granted).toBe(true);

    // Drain fully (held[0] already released — one-shot, so don't call it again).
    (await parked)();
    for (let i = 1; i < held.length; i++) held[i]?.();
  });

  it('release is one-shot — calling it twice frees only one slot', async () => {
    const first = await acquireSessionSlot();
    const rest: ReleaseSlot[] = [];
    for (let i = 1; i < MAX_CONCURRENT_SESSIONS; i++) rest.push(await acquireSessionSlot());

    // Park two behind the full cap.
    let a = false;
    let b = false;
    const pa = acquireSessionSlot().then((r) => {
      a = true;
      return r;
    });
    const pb = acquireSessionSlot().then((r) => {
      b = true;
      return r;
    });
    await tick();
    expect(a).toBe(false);
    expect(b).toBe(false);

    // Double-release `first` — must hand exactly ONE slot (to pa), never two.
    first();
    first();
    await tick();
    expect(a).toBe(true);
    expect(b).toBe(false); // the second (no-op) release did not free a slot for pb

    // Drain.
    (await pa)();
    await tick();
    expect(b).toBe(true);
    (await pb)();
    for (const r of rest) r();
  });

  it('rejects acquisition past the queue cap, then still drains', async () => {
    const held: ReleaseSlot[] = [];
    for (let i = 0; i < MAX_CONCURRENT_SESSIONS; i++) held.push(await acquireSessionSlot());

    // Fill the waiter queue to exactly the cap; each self-releases on grant so the
    // whole queue cascades to empty once the held slots are freed.
    const queued = Array.from({ length: MAX_SESSION_SPAWN_QUEUE }, () =>
      acquireSessionSlot().then((r) => {
        r();
        return 'ok' as const;
      }),
    );
    await tick();

    // One more acquisition — the queue is full, so it MUST reject.
    await expect(acquireSessionSlot()).rejects.toThrow(/queue full/i);

    // Release the held slots → cascade-drains every queued waiter.
    for (const r of held) r();
    expect(await Promise.all(queued)).toEqual(
      Array.from({ length: MAX_SESSION_SPAWN_QUEUE }, () => 'ok'),
    );

    // A fresh acquisition now succeeds — the semaphore fully drained.
    const fresh = await acquireSessionSlot();
    fresh();
  });
});
