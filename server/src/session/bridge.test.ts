// Unit tests — the Bridge pipeline state machine, driven with the REAL
// SessionManager over a controllable fake engine + a real in-memory DB/registry.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { openDatabase } from '../db/database.js';
import { createRegistry, type Registry } from '../registry/registry.js';
import type { BridgeStateSnapshot } from '../ws-protocol.js';
import {
  createBridge,
  defaultDraftPrBody,
  defaultReadReviewReport,
  defaultReadReviewVerdict,
  type Bridge,
} from './bridge.js';
import type { OpenPrAdapter, OpenPrParams } from './pr-adapter.js';
import type { EngineMessage, EngineSession, QueryFn, SpawnParams } from './session-engine.js';
import { createSessionManager, type SessionManager } from './session-manager.js';
import { createSessionStore } from './session-store.js';
import type { Role } from './roles.js';
import type { Roster } from './roster-reader.js';

const PROJECT = '/tmp/devos-bridge-project';

/** A controllable fake EngineSession: push any message, end, or throw on demand. */
function makeSession(): {
  session: EngineSession;
  emit: (message: EngineMessage) => void;
  emitInit: (sessionId: string) => void;
  finish: () => void;
  throwError: (err: unknown) => void;
  ended: () => boolean;
} {
  const buffer: EngineMessage[] = [];
  let resolveNext: (() => void) | null = null;
  let done = false;
  let error: unknown = null;
  let endCalled = false;

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
    send: async (): Promise<void> => {},
    onPermissionRequest: (): void => {},
    resolvePermission: (): void => {},
    end: (): void => {
      endCalled = true;
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
    ended: () => endCalled,
  };
}

/** A `result` engine message carrying the given cost/usage metrics. */
function resultMessage(inputTokens: number): EngineMessage {
  return {
    type: 'result',
    duration_ms: 100,
    num_turns: 1,
    total_cost_usd: 0.05,
    usage: { input_tokens: inputTokens, output_tokens: 20 },
    is_error: false,
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
  phases: [],
  skills: [],
  agent: name,
  model: 'claude-opus-5[1m]',
  effort: 'medium',
  producesArtifacts: [],
});

const ROSTER: Roster = Object.freeze({
  schemaVersion: 2,
  pipeline: Object.freeze(['builder', 'reviewer'] as const) as readonly Role[],
  roles: Object.freeze({
    builder: ROLE_DEF('builder'),
    reviewer: ROLE_DEF('reviewer'),
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
    expect(queryFactory.calls[0]?.role).toBe('builder');

    const builder = queryFactory.sessionAt(0);
    builder.emitInit('sdk-builder-1');
    builder.finish();

    await waitUntil(() => bridge.getState(PROJECT)?.gate === 'awaiting-approval');
    // No second spawn happened while awaiting approval.
    expect(queryFactory.calls).toHaveLength(1);
    expect(states.some((s) => s.gate === 'awaiting-approval')).toBe(true);

    bridge.approveGate(PROJECT);
    await waitUntil(() => queryFactory.calls.length === 2);
    expect(queryFactory.calls[1]?.role).toBe('reviewer');
    expect(bridge.getState(PROJECT)?.gate).toBe('running');
  });

  it('AC2 — auto_advance ON: next role spawns automatically, no awaiting-approval frame', async () => {
    const { sessionManager, registry, queryFactory } = freshEnv();
    registry.setPrefs(PROJECT, { auto_advance: true });
    const bridge = createBridge({ sessionManager, registry, resolveRoster: () => ROSTER });
    const states = collectStates(bridge);

    bridge.start(PROJECT);
    await waitUntil(() => queryFactory.calls.length === 1);

    const builder = queryFactory.sessionAt(0);
    builder.emitInit('sdk-builder-2');
    builder.finish();

    await waitUntil(() => queryFactory.calls.length === 2);
    expect(queryFactory.calls[1]?.role).toBe('reviewer');
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
      stage: 'builder',
    });

    const builder = queryFactory.sessionAt(0);
    builder.emitInit('sdk-builder-3');
    builder.finish();

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
    const builder = queryFactory.sessionAt(0);
    builder.emitInit('sdk-builder-paused-err');
    builder.throwError(new Error('boom'));

    // Give the state machine a moment to (not) rework.
    await new Promise((r) => setTimeout(r, 50));
    expect(queryFactory.calls).toHaveLength(1); // no builder rework spawn
    expect(bridge.getState(PROJECT)?.gate).toBe('awaiting-approval'); // still parked
    expect(bridge.getInbox(PROJECT)).toHaveLength(1); // the interrupt item, no escalation added
  });

  it('AC4 — errored + a failure report respawns builder with prompt === report', async () => {
    const { sessionManager, registry, queryFactory } = freshEnv();
    const bridge = createBridge({
      sessionManager,
      registry,
      resolveRoster: () => ROSTER,
      readFailureReport: () => 'FIX THE BUILD',
    });

    bridge.start(PROJECT);
    await waitUntil(() => queryFactory.calls.length === 1);

    const builder = queryFactory.sessionAt(0);
    builder.emitInit('sdk-builder-4');
    builder.throwError(new Error('boom'));

    await waitUntil(() => queryFactory.calls.length === 2);
    expect(queryFactory.calls[1]?.role).toBe('builder');
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

    const builder = queryFactory.sessionAt(0);
    builder.emitInit('sdk-builder-5');
    builder.throwError(new Error('boom'));

    await waitUntil(() => bridge.getState(PROJECT)?.gate === 'escalated');
    expect(queryFactory.calls).toHaveLength(1);
    expect(bridge.getInbox(PROJECT)).toHaveLength(1);
    expect(bridge.getInbox(PROJECT)[0]).toMatchObject({ kind: 'escalation', stage: 'builder' });
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

  it('AC3 — reviewer BLOCK verdict respawns a fresh builder with prompt === review report, gate reworking', async () => {
    const { sessionManager, registry, queryFactory } = freshEnv();
    registry.setPrefs(PROJECT, { auto_advance: true });
    const bridge = createBridge({
      sessionManager,
      registry,
      resolveRoster: () => ROSTER,
      readReviewVerdict: () => 'BLOCK',
      readReviewReport: () => 'FIX THE REVIEW FINDINGS',
    });

    bridge.start(PROJECT);
    await waitUntil(() => queryFactory.calls.length === 1);
    expect(queryFactory.calls[0]?.role).toBe('builder');

    const builder = queryFactory.sessionAt(0);
    builder.emitInit('sdk-builder-block-1');
    builder.finish();

    await waitUntil(() => queryFactory.calls.length === 2);
    expect(queryFactory.calls[1]?.role).toBe('reviewer');

    const reviewer = queryFactory.sessionAt(1);
    reviewer.emitInit('sdk-reviewer-block-1');
    reviewer.finish();

    await waitUntil(() => queryFactory.calls.length === 3);
    expect(queryFactory.calls[2]?.role).toBe('builder');
    expect(queryFactory.calls[2]?.prompt).toBe('FIX THE REVIEW FINDINGS');
    expect(bridge.getState(PROJECT)?.gate).toBe('reworking');
  });

  it('AC3 — reviewer BLOCK verdict repeated past the rework cap escalates instead of looping forever', async () => {
    const { sessionManager, registry, queryFactory } = freshEnv();
    registry.setPrefs(PROJECT, { auto_advance: true });
    const bridge = createBridge({
      sessionManager,
      registry,
      resolveRoster: () => ROSTER,
      readReviewVerdict: () => 'BLOCK',
      readReviewReport: () => 'FIX IT AGAIN',
    });

    bridge.start(PROJECT);
    await waitUntil(() => queryFactory.calls.length === 1);

    // Drive 3 full builder->reviewer BLOCK cycles (reworkCount 0,1,2 < cap 3 => rework each time).
    for (let cycle = 0; cycle < 3; cycle++) {
      const builderIndex = cycle * 2;
      queryFactory.sessionAt(builderIndex).finish();
      await waitUntil(() => queryFactory.calls.length === builderIndex + 2);
      expect(queryFactory.calls[builderIndex + 1]?.role).toBe('reviewer');

      queryFactory.sessionAt(builderIndex + 1).finish();
      await waitUntil(() => queryFactory.calls.length === builderIndex + 3);
      expect(queryFactory.calls[builderIndex + 2]?.role).toBe('builder');
      expect(bridge.getState(PROJECT)?.gate).toBe('reworking');
    }

    // 4th reviewer BLOCK: reworkCount is now 3, no longer < cap 3 — escalate, no further spawn.
    const finalBuilderIndex = 6;
    queryFactory.sessionAt(finalBuilderIndex).finish();
    await waitUntil(() => queryFactory.calls.length === finalBuilderIndex + 2);
    queryFactory.sessionAt(finalBuilderIndex + 1).finish();

    await waitUntil(() => bridge.getState(PROJECT)?.gate === 'escalated');
    expect(queryFactory.calls).toHaveLength(8); // no further builder spawn beyond the 3 reworks
    expect(bridge.getInbox(PROJECT)).toHaveLength(1);
    expect(bridge.getInbox(PROJECT)[0]).toMatchObject({ kind: 'escalation' });
  });

  it('AC4 — reviewer CLEAR verdict drafts the PR body and invokes the openPr adapter, gate done', async () => {
    const { sessionManager, registry, queryFactory } = freshEnv();
    registry.setPrefs(PROJECT, { auto_advance: true });
    const openPrCalls: OpenPrParams[] = [];
    const fakeOpenPr: OpenPrAdapter = async (params) => {
      openPrCalls.push(params);
      return { ok: true, url: 'https://x/pr/1' };
    };
    const draft = {
      title: 'Add feature X',
      body: 'This PR adds feature X.',
      verdicts: ['builder: PASS', 'reviewer: CLEAR'],
      advisories: ['consider adding more tests'],
    };
    const bridge = createBridge({
      sessionManager,
      registry,
      resolveRoster: () => ROSTER,
      readReviewVerdict: () => 'CLEAR',
      draftPrBody: () => draft,
      openPr: fakeOpenPr,
    });

    bridge.start(PROJECT);
    await waitUntil(() => queryFactory.calls.length === 1);

    const builder = queryFactory.sessionAt(0);
    builder.emitInit('sdk-builder-clear-1');
    builder.finish();

    await waitUntil(() => queryFactory.calls.length === 2);
    const reviewer = queryFactory.sessionAt(1);
    reviewer.emitInit('sdk-reviewer-clear-1');
    reviewer.finish();

    await waitUntil(() => bridge.getState(PROJECT)?.gate === 'done');
    expect(openPrCalls).toHaveLength(1);
    expect(openPrCalls[0]).toMatchObject({
      projectPath: PROJECT,
      title: draft.title,
      body: draft.body,
      verdicts: draft.verdicts,
      advisories: draft.advisories,
    });
  });

  it('AC4 — openPr adapter loud failure (codePlatform:none) escalates with the adapter error, never done', async () => {
    const { sessionManager, registry, queryFactory } = freshEnv();
    registry.setPrefs(PROJECT, { auto_advance: true });
    const fakeOpenPr: OpenPrAdapter = async () => ({
      ok: false,
      error: 'No code platform configured',
    });
    const bridge = createBridge({
      sessionManager,
      registry,
      resolveRoster: () => ROSTER,
      readReviewVerdict: () => 'CLEAR',
      draftPrBody: () => ({ title: 't', body: 'b', verdicts: [], advisories: [] }),
      openPr: fakeOpenPr,
    });

    bridge.start(PROJECT);
    await waitUntil(() => queryFactory.calls.length === 1);

    queryFactory.sessionAt(0).finish();
    await waitUntil(() => queryFactory.calls.length === 2);
    queryFactory.sessionAt(1).finish();

    await waitUntil(() => bridge.getState(PROJECT)?.gate === 'escalated');
    expect(bridge.getState(PROJECT)?.gate).not.toBe('done');
    expect(bridge.getInbox(PROJECT)).toHaveLength(1);
    expect(bridge.getInbox(PROJECT)[0]).toMatchObject({
      kind: 'escalation',
      reason: 'No code platform configured',
    });
  });

  it('AC2 (wiring) — threads the roster-declared model/effort into EVERY spawn (builder + reviewer)', async () => {
    const { sessionManager, registry, queryFactory } = freshEnv();
    registry.setPrefs(PROJECT, { auto_advance: true });
    // Distinct efforts per role prove the spawn sources from run.roles[role], not a constant.
    const roster: Roster = Object.freeze({
      schemaVersion: 2,
      pipeline: Object.freeze(['builder', 'reviewer'] as const) as readonly Role[],
      roles: Object.freeze({
        builder: { ...ROLE_DEF('builder'), effort: 'medium' },
        reviewer: { ...ROLE_DEF('reviewer'), effort: 'high' },
      }),
    } as Roster);
    // Null verdict on the reviewer's end → defer to human; keeps the run from opening a PR here.
    const bridge = createBridge({
      sessionManager,
      registry,
      resolveRoster: () => roster,
      readReviewVerdict: () => null,
    });

    bridge.start(PROJECT, 'WORK-42');
    await waitUntil(() => queryFactory.calls.length === 1);
    expect(queryFactory.calls[0]?.role).toBe('builder');
    expect(queryFactory.calls[0]?.model).toBe('claude-opus-5[1m]');
    expect(queryFactory.calls[0]?.effort).toBe('medium');

    const builder = queryFactory.sessionAt(0);
    builder.emitInit('sdk-wiring-b');
    builder.finish();

    await waitUntil(() => queryFactory.calls.length === 2);
    expect(queryFactory.calls[1]?.role).toBe('reviewer');
    expect(queryFactory.calls[1]?.model).toBe('claude-opus-5[1m]');
    expect(queryFactory.calls[1]?.effort).toBe('high');
  });
});

// A roster whose builder carries the big-window model, so a single result crossing
// 850_000 input tokens crosses the 80% context-usage threshold (context-watcher.ts).
const BIG_MODEL = 'claude-opus-4-8[1m]';
const ROSTER_BIG_WINDOW: Roster = Object.freeze({
  schemaVersion: 2,
  pipeline: Object.freeze(['builder', 'reviewer'] as const) as readonly Role[],
  roles: Object.freeze({
    builder: { ...ROLE_DEF('builder'), model: BIG_MODEL },
    reviewer: ROLE_DEF('reviewer'),
  }),
} as Roster);

describe('Bridge context-recycle respawn', () => {
  it('under the cap: respawns the same-stage session with a resume prompt, ends the old session, and moves currentSessionId', async () => {
    const { sessionManager, registry, queryFactory } = freshEnv();
    const bridge = createBridge({ sessionManager, registry, resolveRoster: () => ROSTER_BIG_WINDOW });

    bridge.start(PROJECT, 'WORK-CTX');
    await waitUntil(() => queryFactory.calls.length === 1);
    expect(queryFactory.calls[0]?.role).toBe('builder');

    const builder = queryFactory.sessionAt(0);
    builder.emitInit('sdk-builder-ctx-1');
    const firstSessionId = bridge.getState(PROJECT)?.sessionId;
    expect(firstSessionId).toBeTruthy();

    // Crosses 80% of the 1M-token window (850_000 / 1_000_000 = 0.85).
    builder.emit(resultMessage(850_000));

    await waitUntil(() => queryFactory.calls.length === 2);
    expect(queryFactory.calls[1]?.role).toBe('builder');
    expect(queryFactory.calls[1]?.prompt).toContain('context-recycle RESUME');

    const newSessionId = bridge.getState(PROJECT)?.sessionId;
    expect(newSessionId).not.toBe(firstSessionId);
    await waitUntil(() => builder.ended());
    expect(builder.ended()).toBe(true);

    // Release the respawned session's slot so it doesn't linger held for other tests.
    queryFactory.sessionAt(1).finish();
  });

  it('at/after the cap: the next crossing escalates instead of respawning again', async () => {
    const { sessionManager, registry, queryFactory } = freshEnv();
    const bridge = createBridge({
      sessionManager,
      registry,
      resolveRoster: () => ROSTER_BIG_WINDOW,
      contextRespawnCap: 1,
    });

    bridge.start(PROJECT, 'WORK-CTX-CAP');
    await waitUntil(() => queryFactory.calls.length === 1);

    const first = queryFactory.sessionAt(0);
    first.emitInit('sdk-builder-cap-1');
    first.emit(resultMessage(850_000));

    // First crossing respawns (contextRespawnCount 0 -> 1, under cap 1).
    await waitUntil(() => queryFactory.calls.length === 2);
    expect(queryFactory.calls[1]?.role).toBe('builder');

    const second = queryFactory.sessionAt(1);
    second.emitInit('sdk-builder-cap-2');
    second.emit(resultMessage(900_000));

    // Second crossing: contextRespawnCount (1) is no longer < cap (1) — escalate.
    await waitUntil(() => bridge.getState(PROJECT)?.gate === 'escalated');
    expect(queryFactory.calls).toHaveLength(2); // no third spawn
    expect(bridge.getInbox(PROJECT)).toHaveLength(1);
    expect(bridge.getInbox(PROJECT)[0]).toMatchObject({
      kind: 'escalation',
      reason: 'task too big — split it',
    });

    // Release the second session's slot so it doesn't linger held for other tests.
    second.finish();
  });

  it("the recycled (old) session's ended does not advance the pipeline index", async () => {
    const { sessionManager, registry, queryFactory } = freshEnv();
    const bridge = createBridge({ sessionManager, registry, resolveRoster: () => ROSTER_BIG_WINDOW });

    bridge.start(PROJECT, 'WORK-CTX-RECYCLE');
    await waitUntil(() => queryFactory.calls.length === 1);

    const oldSession = queryFactory.sessionAt(0);
    oldSession.emitInit('sdk-builder-recycle-1');
    oldSession.emit(resultMessage(850_000));

    await waitUntil(() => queryFactory.calls.length === 2);
    expect(bridge.getState(PROJECT)?.stage).toBe('builder');
    const stateBeforeOldEnd = bridge.getState(PROJECT);

    // The OLD session's stream now finishes naturally (endAtBoundary already closed it).
    // Its 'ended' state no longer correlates to the run's currentSessionId, so it must
    // not trigger any pipeline advance.
    await waitUntil(() => oldSession.ended());
    await new Promise((r) => setTimeout(r, 50));

    expect(queryFactory.calls).toHaveLength(2); // no further spawn (e.g. reviewer)
    expect(bridge.getState(PROJECT)?.stage).toBe('builder');
    expect(bridge.getState(PROJECT)?.sessionId).toBe(stateBeforeOldEnd?.sessionId);
    expect(bridge.getState(PROJECT)?.gate).not.toBe('done');
  });
});

describe('Bridge default handoff readers (tasks/stories/<id>/ contract)', () => {
  it('reads verdict + report from evaluation.md and the PR body from pr-body.md', () => {
    const root = mkdtempSync(join(tmpdir(), 'devos-bridge-readers-'));
    try {
      const storyDir = join(root, 'tasks', 'stories', 'WORK-9');
      mkdirSync(storyDir, { recursive: true });

      // CHANGES REQUIRED → BLOCK; the whole evaluation is the rework work order.
      writeFileSync(
        join(storyDir, 'evaluation.md'),
        '# Evaluation\n\nVerdict: CHANGES REQUIRED\n\n- BLOCK: null deref at foo.ts:12\n',
      );
      expect(defaultReadReviewVerdict(root, 'WORK-9')).toBe('BLOCK');
      expect(defaultReadReviewReport(root, 'WORK-9')).toContain('CHANGES REQUIRED');

      // APPROVE → CLEAR.
      writeFileSync(join(storyDir, 'evaluation.md'), '# Evaluation\n\nVerdict: APPROVE\n\nNothing blocking.\n');
      expect(defaultReadReviewVerdict(root, 'WORK-9')).toBe('CLEAR');

      // PR body: first non-empty line (leading #s stripped) is the title.
      writeFileSync(join(storyDir, 'pr-body.md'), '# Add two-session consolidation\n\nBody paragraph.\n');
      const draft = defaultDraftPrBody(root, 'WORK-9');
      expect(draft?.title).toBe('Add two-session consolidation');
      expect(draft?.body).toContain('Body paragraph.');
      expect(draft?.verdicts).toEqual(['CLEAR']);
      expect(draft?.advisories).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns null (never throws) for a missing workItemId or missing files', () => {
    expect(defaultReadReviewVerdict('/nonexistent-project', undefined)).toBeNull();
    expect(defaultReadReviewVerdict('/nonexistent-project', 'X')).toBeNull();
    expect(defaultReadReviewReport('/nonexistent-project', 'X')).toBeNull();
    expect(defaultDraftPrBody('/nonexistent-project', 'X')).toBeNull();
  });
});
