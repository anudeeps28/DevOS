// Unit tests — the Bridge pipeline state machine, driven with the REAL
// SessionManager over a controllable fake engine + a real in-memory DB/registry.

import { describe, expect, it } from 'vitest';
import { openDatabase } from '../db/database.js';
import { createRegistry, type Registry } from '../registry/registry.js';
import type { BridgeStateSnapshot } from '../ws-protocol.js';
import { createBridge, type Bridge } from './bridge.js';
import type { EngineMessage, EngineSession, QueryFn, SpawnParams } from './session-engine.js';
import { createSessionManager, type SessionManager } from './session-manager.js';
import { createSessionStore } from './session-store.js';
import type { Role } from './roles.js';
import type { Roster } from './roster-reader.js';

const PROJECT = '/tmp/devos-bridge-project';

/** A controllable fake EngineSession: push any message, end, or throw on demand. */
function makeSession(): {
  session: EngineSession;
  emitInit: (sessionId: string) => void;
  finish: () => void;
  throwError: (err: unknown) => void;
} {
  const buffer: EngineMessage[] = [];
  let resolveNext: (() => void) | null = null;
  let done = false;
  let error: unknown = null;

  const wake = (): void => {
    if (resolveNext !== null) {
      const r = resolveNext;
      resolveNext = null;
      r();
    }
  };

  async function* gen(): AsyncGenerator<EngineMessage> {
    for (;;) {
      const next = buffer.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      if (error !== null) throw error;
      if (done) return;
      await new Promise<void>((r) => {
        resolveNext = r;
      });
    }
  }

  const session: EngineSession = Object.assign(gen(), {
    interrupt: async (): Promise<unknown> => {
      done = true;
      wake();
      return undefined;
    },
  });

  return {
    session,
    emitInit: (sessionId) => {
      buffer.push({ type: 'system', subtype: 'init', session_id: sessionId });
      wake();
    },
    finish: () => {
      done = true;
      wake();
    },
    throwError: (err) => {
      error = err;
      wake();
    },
  };
}

/** Dispenses a fresh fake session for every `query()` call and records the params. */
function makeQueryFactory(): {
  query: QueryFn;
  calls: SpawnParams[];
  sessionAt: (i: number) => ReturnType<typeof makeSession>;
} {
  const calls: SpawnParams[] = [];
  const dispensed: ReturnType<typeof makeSession>[] = [];
  const query: QueryFn = (params) => {
    calls.push(params);
    const fake = makeSession();
    dispensed.push(fake);
    return fake.session;
  };
  return {
    query,
    calls,
    sessionAt: (i) => {
      const fake = dispensed[i];
      if (fake === undefined) throw new Error(`no session dispensed at index ${i}`);
      return fake;
    },
  };
}

/** Poll until `condition` is true (or reject on timeout). */
function waitUntil(condition: () => boolean, timeoutMs = 1000): Promise<void> {
  return new Promise((resolve, reject) => {
    if (condition()) {
      resolve();
      return;
    }
    const start = Date.now();
    const timer = setInterval(() => {
      if (condition()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(timer);
        reject(new Error('timed out waiting for condition'));
      }
    }, 5);
  });
}

const ROLE_DEF = (name: string) => ({
  displayName: name,
  stages: [],
  skills: [],
  agent: name,
  producesArtifacts: [],
});

const ROSTER: Roster = Object.freeze({
  schemaVersion: 1,
  pipeline: Object.freeze(['navigator', 'shipwright', 'lookout'] as const) as readonly Role[],
  roles: Object.freeze({
    navigator: ROLE_DEF('navigator'),
    shipwright: ROLE_DEF('shipwright'),
    lookout: ROLE_DEF('lookout'),
    warden: ROLE_DEF('warden'),
    harbormaster: ROLE_DEF('harbormaster'),
  }),
} as Roster);

function freshEnv(): { sessionManager: SessionManager; registry: Registry; queryFactory: ReturnType<typeof makeQueryFactory> } {
  const db = openDatabase(':memory:');
  const registry = createRegistry(db);
  registry.pin(PROJECT);
  const store = createSessionStore(db);
  const queryFactory = makeQueryFactory();
  const sessionManager = createSessionManager({ store, query: queryFactory.query });
  return { sessionManager, registry, queryFactory };
}

function collectStates(bridge: Bridge): BridgeStateSnapshot[] {
  const states: BridgeStateSnapshot[] = [];
  bridge.onState((s) => states.push(s));
  return states;
}

describe('Bridge', () => {
  it('AC1 — auto_advance OFF: ended pauses at awaiting-approval; approveGate spawns the next role', async () => {
    const { sessionManager, registry, queryFactory } = freshEnv();
    const bridge = createBridge({ sessionManager, registry, resolveRoster: () => ROSTER });
    const states = collectStates(bridge);

    bridge.start(PROJECT);
    await waitUntil(() => queryFactory.calls.length === 1);
    expect(queryFactory.calls[0]?.role).toBe('navigator');

    const navigator = queryFactory.sessionAt(0);
    navigator.emitInit('sdk-nav-1');
    navigator.finish();

    await waitUntil(() => bridge.getState(PROJECT)?.gate === 'awaiting-approval');
    // No second spawn happened while awaiting approval.
    expect(queryFactory.calls).toHaveLength(1);
    expect(states.some((s) => s.gate === 'awaiting-approval')).toBe(true);

    bridge.approveGate(PROJECT);
    await waitUntil(() => queryFactory.calls.length === 2);
    expect(queryFactory.calls[1]?.role).toBe('shipwright');
    expect(bridge.getState(PROJECT)?.gate).toBe('running');
  });

  it('AC2 — auto_advance ON: next role spawns automatically, no awaiting-approval frame', async () => {
    const { sessionManager, registry, queryFactory } = freshEnv();
    registry.setPrefs(PROJECT, { auto_advance: true });
    const bridge = createBridge({ sessionManager, registry, resolveRoster: () => ROSTER });
    const states = collectStates(bridge);

    bridge.start(PROJECT);
    await waitUntil(() => queryFactory.calls.length === 1);

    const navigator = queryFactory.sessionAt(0);
    navigator.emitInit('sdk-nav-2');
    navigator.finish();

    await waitUntil(() => queryFactory.calls.length === 2);
    expect(queryFactory.calls[1]?.role).toBe('shipwright');
    expect(states.some((s) => s.gate === 'awaiting-approval')).toBe(false);
  });

  it('AC3 — interrupt during a stage parks the inbox and pauses even with auto_advance ON; a subsequent ended does not auto-advance', async () => {
    const { sessionManager, registry, queryFactory } = freshEnv();
    registry.setPrefs(PROJECT, { auto_advance: true });
    const bridge = createBridge({ sessionManager, registry, resolveRoster: () => ROSTER });

    bridge.start(PROJECT);
    await waitUntil(() => queryFactory.calls.length === 1);

    bridge.interrupt(PROJECT, 'interrupt', 'need human input');
    expect(bridge.getState(PROJECT)?.gate).toBe('awaiting-approval');
    expect(bridge.getInbox(PROJECT)).toHaveLength(1);
    expect(bridge.getInbox(PROJECT)[0]).toMatchObject({
      kind: 'interrupt',
      reason: 'need human input',
      stage: 'navigator',
    });

    const navigator = queryFactory.sessionAt(0);
    navigator.emitInit('sdk-nav-3');
    navigator.finish();

    // Give the state machine a moment to (not) advance.
    await new Promise((r) => setTimeout(r, 50));
    expect(queryFactory.calls).toHaveLength(1);
    expect(bridge.getState(PROJECT)?.gate).toBe('awaiting-approval');
  });

  it('AC3 — an interrupt pauses the errored path too: a session that errors after an interrupt does not rework/escalate', async () => {
    const { sessionManager, registry, queryFactory } = freshEnv();
    const bridge = createBridge({
      sessionManager,
      registry,
      resolveRoster: () => ROSTER,
      readFailureReport: () => 'FIX THE BUILD',
    });

    bridge.start(PROJECT);
    await waitUntil(() => queryFactory.calls.length === 1);

    // Human interrupts mid-stage, then the still-running session errors out.
    bridge.interrupt(PROJECT, 'interrupt', 'hold — investigating');
    const navigator = queryFactory.sessionAt(0);
    navigator.emitInit('sdk-nav-paused-err');
    navigator.throwError(new Error('boom'));

    // Give the state machine a moment to (not) rework.
    await new Promise((r) => setTimeout(r, 50));
    expect(queryFactory.calls).toHaveLength(1); // no shipwright rework spawn
    expect(bridge.getState(PROJECT)?.gate).toBe('awaiting-approval'); // still parked
    expect(bridge.getInbox(PROJECT)).toHaveLength(1); // the interrupt item, no escalation added
  });

  it('AC4 — errored + a failure report respawns shipwright with prompt === report', async () => {
    const { sessionManager, registry, queryFactory } = freshEnv();
    const bridge = createBridge({
      sessionManager,
      registry,
      resolveRoster: () => ROSTER,
      readFailureReport: () => 'FIX THE BUILD',
    });

    bridge.start(PROJECT);
    await waitUntil(() => queryFactory.calls.length === 1);

    const navigator = queryFactory.sessionAt(0);
    navigator.emitInit('sdk-nav-4');
    navigator.throwError(new Error('boom'));

    await waitUntil(() => queryFactory.calls.length === 2);
    expect(queryFactory.calls[1]?.role).toBe('shipwright');
    expect(queryFactory.calls[1]?.prompt).toBe('FIX THE BUILD');
    expect(bridge.getState(PROJECT)?.gate).toBe('reworking');
  });

  it('AC4 — errored + no failure report escalates without respawning', async () => {
    const { sessionManager, registry, queryFactory } = freshEnv();
    const bridge = createBridge({
      sessionManager,
      registry,
      resolveRoster: () => ROSTER,
      readFailureReport: () => null,
    });

    bridge.start(PROJECT);
    await waitUntil(() => queryFactory.calls.length === 1);

    const navigator = queryFactory.sessionAt(0);
    navigator.emitInit('sdk-nav-5');
    navigator.throwError(new Error('boom'));

    await waitUntil(() => bridge.getState(PROJECT)?.gate === 'escalated');
    expect(queryFactory.calls).toHaveLength(1);
    expect(bridge.getInbox(PROJECT)).toHaveLength(1);
    expect(bridge.getInbox(PROJECT)[0]).toMatchObject({ kind: 'escalation', stage: 'navigator' });
  });

  it('AC4 — rework loop-cap: repeated errors beyond the cap escalate instead of looping forever', async () => {
    const { sessionManager, registry, queryFactory } = freshEnv();
    const bridge = createBridge({
      sessionManager,
      registry,
      resolveRoster: () => ROSTER,
      readFailureReport: () => 'FIX IT',
      reworkLoopCap: 1,
    });

    bridge.start(PROJECT);
    await waitUntil(() => queryFactory.calls.length === 1);

    // First error: rework (reworkCount 0 < cap 1).
    queryFactory.sessionAt(0).throwError(new Error('boom-1'));
    await waitUntil(() => queryFactory.calls.length === 2);
    expect(bridge.getState(PROJECT)?.gate).toBe('reworking');

    // Second error: reworkCount (1) is no longer < cap (1) — escalate, no 3rd spawn.
    queryFactory.sessionAt(1).throwError(new Error('boom-2'));
    await waitUntil(() => bridge.getState(PROJECT)?.gate === 'escalated');
    expect(queryFactory.calls).toHaveLength(2);
    expect(bridge.getInbox(PROJECT)).toHaveLength(1);
  });
});
