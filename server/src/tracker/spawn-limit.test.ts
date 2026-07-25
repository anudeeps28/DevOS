// Unit tests for the global bash-spawn semaphore.
//
// All timing is driven by controllable deferred promises + macrotask flushes
// (setImmediate) — never sleeps — so the tests are deterministic. They prove:
//   1. observed peak concurrency never exceeds the cap; all tasks resolve;
//   2. a rejecting task still releases its slot so a queued task runs after it.

import { describe, expect, it } from 'vitest';

import { MAX_CONCURRENT_TRACKER_SPAWNS, MAX_SPAWN_QUEUE, withSpawnSlot } from './spawn-limit.js';

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Flush the microtask+macrotask queues so parked acquires can proceed. */
function tick(): Promise<void> {
  return new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

describe('withSpawnSlot', () => {
  it('never exceeds the cap and resolves all tasks', async () => {
    const total = 10;
    const gates = Array.from({ length: total }, () => deferred<number>());

    let current = 0;
    let peak = 0;

    const runs = gates.map((gate) =>
      withSpawnSlot(async () => {
        current += 1;
        peak = Math.max(peak, current);
        const value = await gate.promise;
        current -= 1;
        return value;
      }),
    );

    // Let the first wave enter: exactly the cap should be running, the rest queued.
    await tick();
    expect(current).toBe(MAX_CONCURRENT_TRACKER_SPAWNS);
    expect(peak).toBe(MAX_CONCURRENT_TRACKER_SPAWNS);

    // Release them one at a time; each freed slot lets exactly one queued task in,
    // so concurrency must never climb above the cap.
    for (const [index, gate] of gates.entries()) {
      gate.resolve(index);
      await tick();
      expect(current).toBeLessThanOrEqual(MAX_CONCURRENT_TRACKER_SPAWNS);
    }

    const results = await Promise.all(runs);
    expect(results).toEqual(Array.from({ length: total }, (_, i) => i));
    expect(peak).toBe(MAX_CONCURRENT_TRACKER_SPAWNS);
    expect(peak).toBeLessThanOrEqual(MAX_CONCURRENT_TRACKER_SPAWNS);
  });

  it('releases the slot even when the task rejects, letting a queued task run', async () => {
    const cap = MAX_CONCURRENT_TRACKER_SPAWNS;

    // Saturate every slot with tasks that will reject.
    const rejecters = Array.from({ length: cap }, () => deferred<never>());
    const rejectingRuns = rejecters.map((gate) =>
      withSpawnSlot(() => gate.promise).catch(() => 'rejected' as const),
    );

    // Queue one more task behind the full set.
    let laterRan = false;
    const laterGate = deferred<string>();
    const later = withSpawnSlot(async () => {
      laterRan = true;
      return laterGate.promise;
    });

    // With all slots held by the rejecters, the queued task cannot have started.
    await tick();
    expect(laterRan).toBe(false);

    // Reject every in-flight task; each MUST release its slot in the finally.
    for (const gate of rejecters) {
      gate.reject(new Error('adapter boom'));
    }
    await tick();

    // A freed slot let the queued task run despite several preceding rejections.
    expect(laterRan).toBe(true);

    laterGate.resolve('done');
    await expect(later).resolves.toBe('done');
    expect(await Promise.all(rejectingRuns)).toEqual(Array.from({ length: cap }, () => 'rejected'));
  });

  it('rejects acquisition past the queue cap, then still drains normally', async () => {
    const cap = MAX_CONCURRENT_TRACKER_SPAWNS;

    // Saturate every running slot with tasks held open by a gate.
    const runningGates = Array.from({ length: cap }, () => deferred<string>());
    const running = runningGates.map((gate) => withSpawnSlot(() => gate.promise));

    // Fill the waiter queue to exactly MAX_SPAWN_QUEUE — all of these park.
    const queuedGates = Array.from({ length: MAX_SPAWN_QUEUE }, () => deferred<string>());
    const queued = queuedGates.map((gate) => withSpawnSlot(() => gate.promise));

    await tick();

    // One more acquisition — the queue is full, so it MUST reject (drop-don't-throw
    // at the tracker-reader collapses this to an "unreachable" read).
    await expect(withSpawnSlot(async () => 'overflow')).rejects.toThrow(/queue full/i);

    // The cap-th caller rejecting must not have disturbed running or queued work:
    // release everything and prove every slot drains and resolves in order.
    for (const [index, gate] of runningGates.entries()) {
      gate.resolve(`run-${index}`);
    }
    for (const [index, gate] of queuedGates.entries()) {
      gate.resolve(`queued-${index}`);
    }
    await tick();

    expect(await Promise.all(running)).toEqual(
      Array.from({ length: cap }, (_, i) => `run-${i}`),
    );
    expect(await Promise.all(queued)).toEqual(
      Array.from({ length: MAX_SPAWN_QUEUE }, (_, i) => `queued-${i}`),
    );

    // A fresh acquisition now succeeds — the queue fully drained.
    await expect(withSpawnSlot(async () => 'after-drain')).resolves.toBe('after-drain');
  });
});
