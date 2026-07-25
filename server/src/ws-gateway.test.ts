// Unit tests for pruneFloodGuard (server/src/ws-gateway.ts) — the pure bound on a
// per-socket, per-PATH flood-guard Map. Proves it (1) drops expired entries first,
// (2) evicts oldest-inserted entries when still over cap, and (3) keeps the Map
// bounded / is a no-op while under the cap.

import { describe, expect, it } from 'vitest';

import { FLOOD_GUARD_MAX_KEYS, pruneFloodGuard } from './ws-gateway.js';

const WINDOW_MS = 200;

/** Build a Map of `count` keys, each stamped at `now - ageMs`, in insertion order. */
function buildMap(count: number, now: number, ageMs: number, prefix = 'p'): Map<string, number> {
  const map = new Map<string, number>();
  for (let i = 0; i < count; i += 1) {
    map.set(`${prefix}-${i}`, now - ageMs);
  }
  return map;
}

describe('pruneFloodGuard', () => {
  it('is a no-op while the Map is under the cap', () => {
    const now = 1_000_000;
    const map = buildMap(FLOOD_GUARD_MAX_KEYS - 1, now, 0);
    const before = new Map(map);

    pruneFloodGuard(map, now, WINDOW_MS);

    expect(map.size).toBe(FLOOD_GUARD_MAX_KEYS - 1);
    expect([...map.keys()]).toEqual([...before.keys()]);
  });

  it('drops expired entries first when at the cap', () => {
    const now = 1_000_000;
    const map = new Map<string, number>();

    // Half expired (older than the window), inserted first.
    const expiredCount = FLOOD_GUARD_MAX_KEYS / 2;
    for (let i = 0; i < expiredCount; i += 1) {
      map.set(`expired-${i}`, now - WINDOW_MS - 1);
    }
    // Half still fresh, inserted after.
    const freshCount = FLOOD_GUARD_MAX_KEYS - expiredCount;
    for (let i = 0; i < freshCount; i += 1) {
      map.set(`fresh-${i}`, now);
    }
    expect(map.size).toBe(FLOOD_GUARD_MAX_KEYS);

    pruneFloodGuard(map, now, WINDOW_MS);

    // Only the fresh entries survive; dropping the expired ones brought it under cap,
    // so no fresh entry was evicted.
    expect(map.size).toBe(freshCount);
    for (let i = 0; i < freshCount; i += 1) {
      expect(map.has(`fresh-${i}`)).toBe(true);
    }
    for (let i = 0; i < expiredCount; i += 1) {
      expect(map.has(`expired-${i}`)).toBe(false);
    }
  });

  it('evicts oldest-inserted entries when still over cap after expiry sweep', () => {
    const now = 1_000_000;
    // All fresh (none expired) and OVER the cap, so the expiry sweep frees nothing
    // and the loop must evict oldest-inserted until under the cap.
    const over = FLOOD_GUARD_MAX_KEYS + 5;
    const map = buildMap(over, now, 0);

    pruneFloodGuard(map, now, WINDOW_MS);

    // Bounded strictly under the cap.
    expect(map.size).toBe(FLOOD_GUARD_MAX_KEYS - 1);

    // The oldest-inserted keys were the ones evicted; the newest all survive.
    const evictedCount = over - (FLOOD_GUARD_MAX_KEYS - 1);
    for (let i = 0; i < evictedCount; i += 1) {
      expect(map.has(`p-${i}`)).toBe(false);
    }
    expect(map.has(`p-${over - 1}`)).toBe(true);
  });

  it('keeps the Map bounded under the cap regardless of input size', () => {
    const now = 1_000_000;
    const map = buildMap(FLOOD_GUARD_MAX_KEYS * 3, now, 0);

    pruneFloodGuard(map, now, WINDOW_MS);

    expect(map.size).toBeLessThan(FLOOD_GUARD_MAX_KEYS);
  });
});
