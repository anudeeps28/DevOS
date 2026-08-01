// Unit tests — CostLedgerStore insert + local-midnight-boundary aggregation.
//
// Uses a real in-memory DB (openDatabase(':memory:')). `cost_ledger` has a FK to
// sessions(id) with foreign_keys ON, so each test seeds a project + session first.

import { describe, expect, it } from 'vitest';
import { openDatabase } from '../db/database.js';
import { createRegistry } from '../registry/registry.js';
import { createSessionStore } from './session-store.js';
import { createCostLedgerStore } from './cost-ledger-store.js';

const PROJECT = '/tmp/devos-fixture-project';

function freshStore(): { store: ReturnType<typeof createCostLedgerStore> } {
  const db = openDatabase(':memory:');
  createRegistry(db).pin(PROJECT);
  createSessionStore(db).insert({
    id: 'sess-1',
    projectPath: PROJECT,
    role: 'builder',
    status: 'running',
  });
  return { store: createCostLedgerStore(db) };
}

// A fixed reference time so the local-midnight boundary is deterministic.
const FIXED_NOW = new Date(2026, 6, 15, 12, 0, 0, 0).getTime();

function localMidnight(referenceMs: number): number {
  const d = new Date(referenceMs);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

describe('CostLedgerStore', () => {
  it('insert then costToday returns that row cost + tokens', () => {
    const { store } = freshStore();
    store.insert({
      sessionId: 'sess-1',
      inputTokens: 100,
      outputTokens: 50,
      costUsd: 1.25,
      at: FIXED_NOW,
    });

    const aggregate = store.costToday(FIXED_NOW);
    expect(aggregate.costTodayUsd).toBe(1.25);
    expect(aggregate.inputTokensToday).toBe(100);
    expect(aggregate.outputTokensToday).toBe(50);
    expect(aggregate.sinceEpochMs).toBe(localMidnight(FIXED_NOW));
  });

  it('excludes a row stamped before local midnight, includes one after', () => {
    const { store } = freshStore();
    const midnight = localMidnight(FIXED_NOW);

    store.insert({
      sessionId: 'sess-1',
      inputTokens: 10,
      outputTokens: 5,
      costUsd: 0.1,
      at: midnight - 1,
    });
    store.insert({
      sessionId: 'sess-1',
      inputTokens: 20,
      outputTokens: 10,
      costUsd: 0.2,
      at: midnight + 1,
    });

    const aggregate = store.costToday(FIXED_NOW);
    expect(aggregate.costTodayUsd).toBeCloseTo(0.2);
    expect(aggregate.inputTokensToday).toBe(20);
    expect(aggregate.outputTokensToday).toBe(10);
  });

  it('returns an all-zero aggregate for an empty table', () => {
    const { store } = freshStore();
    const aggregate = store.costToday(FIXED_NOW);
    expect(aggregate.costTodayUsd).toBe(0);
    expect(aggregate.inputTokensToday).toBe(0);
    expect(aggregate.outputTokensToday).toBe(0);
  });

  it('sums two rows within the same day', () => {
    const { store } = freshStore();
    store.insert({
      sessionId: 'sess-1',
      inputTokens: 100,
      outputTokens: 50,
      costUsd: 1.0,
      at: FIXED_NOW,
    });
    store.insert({
      sessionId: 'sess-1',
      inputTokens: 200,
      outputTokens: 75,
      costUsd: 2.5,
      at: FIXED_NOW + 1000,
    });

    const aggregate = store.costToday(FIXED_NOW);
    expect(aggregate.costTodayUsd).toBeCloseTo(3.5);
    expect(aggregate.inputTokensToday).toBe(300);
    expect(aggregate.outputTokensToday).toBe(125);
  });

  it('returns frozen objects', () => {
    const { store } = freshStore();
    const aggregate = store.costToday(FIXED_NOW);
    expect(Object.isFrozen(aggregate)).toBe(true);
  });
});
