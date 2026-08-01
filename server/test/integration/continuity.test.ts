// Integration test (THE GATE) — context-recycle continuity, exercised against the
// REAL SessionManager + Bridge with a fake `QueryFn` (never live Claude).
//
// Drives a fake, controllable builder session past the 80% context-window threshold
// (window = 1,000,000 for `claude-opus-4-8[1m]`) and asserts the observable contract:
//   AC1 — crossing 80% respawns a FRESH session for the same stage: the new spawn's
//         prompt carries the resume-prompt markers (story-file content + the
//         never-compact directive), the OLD session's `end()` is called
//         (endAtBoundary), and the run's `currentSessionId` moves to the new session.
//   AC2 — the live session's SessionManager snapshot carries the correct workItemId.
//   AC3 — the sessions store persists every respawn under the SAME work_item_id.
//   AC4 — once the per-run respawn cap (injected at 2) is reached, a further crossing
//         escalates the run (`gate: 'escalated'`, inbox reason "task too big — split
//         it") instead of spawning a further session.
//   regression — the recycled (old) session's later `ended` does NOT advance the
//         pipeline (stage stays on the same role) or open a PR.
//
// Self-provisions a minimal `tasks/stories/<id>/` fixture (plan.md/executor-state.md)
// under a real tmp project dir so `buildResumePrompt`'s file reads succeed — cleaned
// up in afterEach. NO live Claude; NO WS transport — Bridge's own public state API
// (`getState`/`onState`) is the observation surface, per bridge.test.ts's approach to
// asserting bridge-state without inventing new bridge surface.

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';

import { openDatabase, type DatabaseHandle } from '../../src/db/database.js';
import { createRegistry } from '../../src/registry/registry.js';
import { createSessionStore } from '../../src/session/session-store.js';
import { createSessionManager, type SessionSnapshot } from '../../src/session/session-manager.js';
import { createBridge } from '../../src/session/bridge.js';
import type { OpenPrAdapter } from '../../src/session/pr-adapter.js';
import type { Roster } from '../../src/session/roster-reader.js';
import type {
  EngineMessage,
  EngineSession,
  QueryFn,
  SpawnParams,
} from '../../src/session/session-engine.js';
import type { BridgeStateSnapshot } from '../../src/ws-protocol.js';

// A builder model whose context window is the 1,000,000-token override
// (context-watcher.ts MODEL_CONTEXT_WINDOWS) — 80% is 800,000 tokens.
const BUILDER_MODEL = 'claude-opus-4-8[1m]';

const TEST_ROSTER: Roster = Object.freeze({
  schemaVersion: 2,
  pipeline: ['builder', 'reviewer'],
  roles: {
    builder: {
      displayName: 'Builder',
      phases: [{ id: 'coding', displayName: 'Shipwright' }],
      skills: [],
      agent: 'builder',
      model: BUILDER_MODEL,
      effort: 'medium',
      producesArtifacts: [],
    },
    reviewer: {
      displayName: 'Reviewer',
      phases: [{ id: 'reviewing', displayName: 'Warden' }],
      skills: [],
      agent: 'reviewer',
      model: BUILDER_MODEL,
      effort: 'high',
      producesArtifacts: [],
    },
  },
}) as unknown as Roster;

const WORK_ITEM_ID = 'CONT1NU1TY';
const PLAN_MARKER = 'PLAN-FIXTURE-MARKER-9f31c2';
const EXECUTOR_STATE_MARKER = 'EXEC-STATE-FIXTURE-MARKER-7ab04e';

/** A controllable fake session: push any message on demand, ends on `end()`/`interrupt()`. */
function makeControllableSession(): {
  session: EngineSession;
  emit: (message: EngineMessage) => void;
  endCallCount: () => number;
} {
  const buffer: EngineMessage[] = [];
  let resolveNext: (() => void) | null = null;
  let done = false;
  let endCalls = 0;

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
    send: async (): Promise<void> => {},
    onPermissionRequest: (): void => {},
    resolvePermission: (): void => {},
    end: (): void => {
      endCalls += 1;
      done = true;
      wake();
    },
  });

  return {
    session,
    emit: (message) => {
      buffer.push(message);
      wake();
    },
    endCallCount: () => endCalls,
  };
}

interface FakeEngine {
  readonly query: QueryFn;
  readonly calls: SpawnParams[];
  readonly controllers: Array<ReturnType<typeof makeControllableSession>>;
}

function makeFakeEngine(): FakeEngine {
  const calls: SpawnParams[] = [];
  const controllers: Array<ReturnType<typeof makeControllableSession>> = [];
  const query: QueryFn = (params) => {
    calls.push(params);
    const controller = makeControllableSession();
    controllers.push(controller);
    return controller.session;
  };
  return { query, calls, controllers };
}

interface Waiter<T> {
  readonly predicate: (value: T) => boolean;
  readonly resolve: (value: T) => void;
  readonly reject: (err: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

/** A tiny in-process collector/waiter mirroring the WS-test waitForX helpers, but
 * bound directly to an EventEmitter-style `subscribe` (no transport involved). */
function makeCollector<T>(subscribe: (listener: (value: T) => void) => () => void): {
  readonly seen: () => T[];
  readonly waitFor: (predicate: (value: T) => boolean, timeoutMs?: number) => Promise<T>;
} {
  const seen: T[] = [];
  let waiters: Array<Waiter<T>> = [];
  subscribe((value) => {
    seen.push(value);
    const stillWaiting: Array<Waiter<T>> = [];
    for (const waiter of waiters) {
      if (waiter.predicate(value)) {
        clearTimeout(waiter.timer);
        waiter.resolve(value);
      } else {
        stillWaiting.push(waiter);
      }
    }
    waiters = stillWaiting;
  });
  return {
    seen: () => [...seen],
    waitFor: (predicate, timeoutMs = 5000) =>
      new Promise<T>((resolve, reject) => {
        const existing = seen.find(predicate);
        if (existing !== undefined) {
          resolve(existing);
          return;
        }
        const timer = setTimeout(() => {
          waiters = waiters.filter((w) => w.timer !== timer);
          reject(new Error(`Timed out after ${timeoutMs}ms waiting for a matching value`));
        }, timeoutMs);
        waiters.push({ predicate, resolve, reject, timer });
      }),
  };
}

const tmpDirs: string[] = [];
const dbHandles: DatabaseHandle[] = [];

function makeProjectDir(): string {
  const path = join(tmpdir(), `devos-continuity-proj-${randomUUID()}`);
  mkdirSync(path, { recursive: true });
  tmpDirs.push(path);
  return path;
}

/** Self-provision the minimal story-file fixture `buildResumePrompt` reads. */
function writeStoryFixture(projectPath: string, workItemId: string): void {
  const storyDir = join(projectPath, 'tasks', 'stories', workItemId);
  mkdirSync(storyDir, { recursive: true });
  writeFileSync(join(storyDir, 'plan.md'), `# Plan\n\n${PLAN_MARKER}\n`, 'utf8');
  writeFileSync(
    join(storyDir, 'executor-state.md'),
    `# Executor state\n\n${EXECUTOR_STATE_MARKER}\n`,
    'utf8',
  );
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  for (const db of dbHandles.splice(0)) {
    db.close();
  }
});

describe('context-recycle continuity — real SessionManager + Bridge, fake QueryFn', () => {
  it('AC1-AC4 + regression: respawn-with-resume-prompt, persisted continuity, cap->escalate, inert recycled session', async () => {
    const project = makeProjectDir();
    writeStoryFixture(project, WORK_ITEM_ID);

    const db = openDatabase(':memory:');
    dbHandles.push(db);
    const store = createSessionStore(db);
    const registry = createRegistry(db);
    registry.pin(project);

    const engine = makeFakeEngine();
    const sessionManager = createSessionManager({ store, query: engine.query });

    const openPrCalls: unknown[] = [];
    const openPr: OpenPrAdapter = async (input) => {
      openPrCalls.push(input);
      return { ok: true, url: 'https://example.invalid/pr/1' };
    };

    const bridge = createBridge({
      sessionManager,
      registry,
      resolveRoster: () => TEST_ROSTER,
      contextRespawnCap: 2,
      openPr,
    });

    const bridgeStates = makeCollector<BridgeStateSnapshot>((l) => bridge.onState(l));
    const sessionStates = makeCollector<SessionSnapshot>((l) => sessionManager.onState(l));

    // --- Kick off: builder spawns as session A. ---
    bridge.start(project, WORK_ITEM_ID);
    const firstState = await bridgeStates.waitFor((f) => f.sessionId !== null);
    expect(engine.calls).toHaveLength(1);
    expect(engine.calls[0]?.role).toBe('builder');
    expect(engine.calls[0]?.model).toBe(BUILDER_MODEL);
    expect(firstState.stage).toBe('builder');

    const sessionAId = firstState.sessionId;
    if (sessionAId === null) throw new Error('expected a session id after bridge.start');
    const controllerA = engine.controllers[0];
    if (controllerA === undefined) throw new Error('expected the fake engine to have spawned session A');

    // AC2 — the live session snapshot carries the correct workItemId.
    expect(sessionManager.get(sessionAId)?.workItemId).toBe(WORK_ITEM_ID);

    // --- Cross 80% on session A (900,000 >= 800,000 = 80% of the 1,000,000 window). ---
    controllerA.emit({ type: 'system', subtype: 'init', session_id: 'sdk-A' });
    const respawnedAfterA = bridgeStates.waitFor(
      (f) => f.sessionId !== null && f.sessionId !== sessionAId,
    );
    controllerA.emit({
      type: 'result',
      duration_ms: 100,
      num_turns: 1,
      total_cost_usd: 1,
      usage: { input_tokens: 900_000, output_tokens: 100 },
      is_error: false,
    });
    const afterA = await respawnedAfterA;

    // AC1 — a fresh session (B) was spawned for the SAME stage, with a resume prompt.
    expect(engine.calls).toHaveLength(2);
    expect(afterA.stage).toBe('builder');
    const sessionBId = afterA.sessionId;
    if (sessionBId === null) throw new Error('expected a session id for the respawned session B');
    expect(sessionBId).not.toBe(sessionAId);
    expect(bridge.getState(project)?.sessionId).toBe(sessionBId);

    const respawnPromptB = engine.calls[1]?.prompt ?? '';
    expect(respawnPromptB).toContain(WORK_ITEM_ID);
    expect(respawnPromptB).toContain(PLAN_MARKER);
    expect(respawnPromptB).toContain(EXECUTOR_STATE_MARKER);
    expect(respawnPromptB).toContain('NEVER rely on conversation compaction');
    expect(engine.calls[1]?.role).toBe('builder');
    expect(engine.calls[1]?.model).toBe(BUILDER_MODEL);

    // Old session A's `end()` was called (endAtBoundary), and its consume loop then
    // reports `ended` — but that later `ended` must NOT advance the pipeline: the
    // run's currentSessionId has already moved to B, so the stage stays 'builder' and
    // the gate never reaches 'done' because of A's ended (regression).
    await sessionStates.waitFor((s) => s.id === sessionAId && s.status === 'ended');
    expect(controllerA.endCallCount()).toBeGreaterThanOrEqual(1);
    expect(bridge.getState(project)?.stage).toBe('builder');
    expect(bridge.getState(project)?.gate).not.toBe('done');
    expect(openPrCalls).toHaveLength(0);

    // AC2 — the new live session (B) also carries the correct workItemId.
    expect(sessionManager.get(sessionBId)?.workItemId).toBe(WORK_ITEM_ID);

    // AC3 — the store persists BOTH sessions under the same work_item_id.
    const rowsAfterFirstRespawn = store.listByWorkItem(WORK_ITEM_ID, project);
    expect(rowsAfterFirstRespawn).toHaveLength(2);
    expect(rowsAfterFirstRespawn.map((r) => r.id).sort()).toEqual([sessionAId, sessionBId].sort());

    // --- Cross 80% on session B — second respawn (still under the cap of 2). ---
    const controllerB = engine.controllers[1];
    if (controllerB === undefined) throw new Error('expected the fake engine to have spawned session B');
    controllerB.emit({ type: 'system', subtype: 'init', session_id: 'sdk-B' });
    const respawnedAfterB = bridgeStates.waitFor(
      (f) => f.sessionId !== null && f.sessionId !== sessionAId && f.sessionId !== sessionBId,
    );
    controllerB.emit({
      type: 'result',
      duration_ms: 100,
      num_turns: 1,
      total_cost_usd: 1,
      usage: { input_tokens: 900_000, output_tokens: 100 },
      is_error: false,
    });
    const afterB = await respawnedAfterB;

    expect(engine.calls).toHaveLength(3);
    const sessionCId = afterB.sessionId;
    if (sessionCId === null) throw new Error('expected a session id for the respawned session C');
    expect(bridge.getState(project)?.gate).not.toBe('escalated');

    const rowsAfterSecondRespawn = store.listByWorkItem(WORK_ITEM_ID, project);
    expect(rowsAfterSecondRespawn).toHaveLength(3);

    // --- Cross 80% on session C — the cap (2) is now exhausted: escalate, no respawn. ---
    const controllerC = engine.controllers[2];
    if (controllerC === undefined) throw new Error('expected the fake engine to have spawned session C');
    controllerC.emit({ type: 'system', subtype: 'init', session_id: 'sdk-C' });
    const escalated = bridgeStates.waitFor((f) => f.gate === 'escalated');
    controllerC.emit({
      type: 'result',
      duration_ms: 100,
      num_turns: 1,
      total_cost_usd: 1,
      usage: { input_tokens: 900_000, output_tokens: 100 },
      is_error: false,
    });
    const escalatedState = await escalated;

    // AC4 — capped at 2 respawns; the 3rd crossing escalates instead of spawning again.
    expect(engine.calls).toHaveLength(3);
    expect(escalatedState.sessionId).toBe(sessionCId);
    const escalation = escalatedState.inbox.at(-1);
    expect(escalation?.kind).toBe('escalation');
    expect(escalation?.reason).toBe('task too big — split it');
    expect(bridge.getState(project)?.gate).toBe('escalated');
    expect(openPrCalls).toHaveLength(0);
  }, 15000);
});
