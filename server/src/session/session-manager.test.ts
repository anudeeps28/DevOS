// Unit tests — SessionManager spawn / multiplex / lifecycle with a DETERMINISTIC
// FAKE engine. No live Claude. A real in-memory DB + store backs persistence.

import { describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../db/database.js';
import { createRegistry } from '../registry/registry.js';
import type { TranscriptEvent } from '../ws-protocol.js';
import type { CostLedgerInsert, CostUsageAggregate } from './cost-ledger-store.js';
import { createSessionStore } from './session-store.js';
import { createSessionManager, type SessionSnapshot } from './session-manager.js';
import type {
  EngineMessage,
  EnginePermissionRequest,
  EngineQuestionRequest,
  EngineSession,
  PermissionDecision,
  QueryFn,
  SpawnParams,
} from './session-engine.js';

const PROJECT = '/tmp/devos-sm-project';

/** A controllable fake EngineSession: push any message, end, throw, steer, or interrupt on demand. */
function makeSession(opts: { endsOnInterrupt?: boolean } = {}): {
  session: EngineSession;
  emit: (message: EngineMessage) => void;
  emitInit: (sessionId: string) => void;
  finish: () => void;
  throwError: (err: unknown) => void;
  interrupted: () => boolean;
  interruptCount: () => number;
  sent: () => string[];
  emitPermissionRequest: (req: EnginePermissionRequest) => void;
  resolvePermissionCalls: () => Array<{ requestId: string; decision: PermissionDecision }>;
  emitQuestionRequest: (req: EngineQuestionRequest) => void;
  answerQuestionCalls: () => Array<{ requestId: string; answer: string }>;
} {
  // Whether interrupt() ends the generator. Default true (models stopAll's shutdown
  // interrupt, closing the stream). Set false to model per-turn interrupt that leaves
  // the session running.
  const endsOnInterrupt = opts.endsOnInterrupt ?? true;
  const buffer: EngineMessage[] = [];
  let resolveNext: (() => void) | null = null;
  let done = false;
  let error: unknown = null;
  let wasInterrupted = false;
  let interruptCalls = 0;
  const sentTexts: string[] = [];
  let permissionListener: ((req: EnginePermissionRequest) => void) | null = null;
  const resolvePermissionCalls: Array<{ requestId: string; decision: PermissionDecision }> = [];
  let questionListener: ((req: EngineQuestionRequest) => void) | null = null;
  const answerQuestionCalls: Array<{ requestId: string; answer: string }> = [];

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
      wasInterrupted = true;
      interruptCalls += 1;
      if (endsOnInterrupt) {
        done = true;
        wake();
      }
      return undefined;
    },
    send: async (text: string): Promise<void> => {
      sentTexts.push(text);
    },
    onPermissionRequest: (listener: (req: EnginePermissionRequest) => void): void => {
      permissionListener = listener;
    },
    resolvePermission: (requestId: string, decision: PermissionDecision): void => {
      resolvePermissionCalls.push({ requestId, decision });
    },
    onQuestionRequest: (listener: (req: EngineQuestionRequest) => void): void => {
      questionListener = listener;
    },
    answerQuestion: (requestId: string, answer: string): void => {
      answerQuestionCalls.push({ requestId, answer });
    },
    end: (): void => {
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
    interrupted: () => wasInterrupted,
    interruptCount: () => interruptCalls,
    sent: () => [...sentTexts],
    emitPermissionRequest: (req) => {
      permissionListener?.(req);
    },
    resolvePermissionCalls: () => [...resolvePermissionCalls],
    emitQuestionRequest: (req) => {
      questionListener?.(req);
    },
    answerQuestionCalls: () => [...answerQuestionCalls],
  };
}

function freshStore(): ReturnType<typeof createSessionStore> {
  const db = openDatabase(':memory:');
  createRegistry(db).pin(PROJECT);
  return createSessionStore(db);
}

/** Resolve when a snapshot matching `predicate` is emitted (or reject on timeout). */
function waitFor(
  emissions: SessionSnapshot[],
  predicate: (s: SessionSnapshot) => boolean,
  timeoutMs = 1000,
): Promise<SessionSnapshot> {
  return new Promise((resolve, reject) => {
    const existing = emissions.find(predicate);
    if (existing) {
      resolve(existing);
      return;
    }
    const start = Date.now();
    const timer = setInterval(() => {
      const hit = emissions.find(predicate);
      if (hit) {
        clearInterval(timer);
        resolve(hit);
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(timer);
        reject(new Error('timed out waiting for snapshot'));
      }
    }, 5);
  });
}

describe('SessionManager', () => {
  it('AC1 — spawn starts the engine with cwd+role, persists the row, reports running', async () => {
    const store = freshStore();
    const calls: SpawnParams[] = [];
    const fake = makeSession();
    const query: QueryFn = (params) => {
      calls.push(params);
      return fake.session;
    };
    const mgr = createSessionManager({ store, query });
    const emissions: SessionSnapshot[] = [];
    mgr.onState((s) => emissions.push(s));

    const snap = await mgr.spawn({ projectPath: PROJECT, role: 'builder' });

    // Engine invoked with cwd = project root and the requested role.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.cwd).toBe(PROJECT);
    expect(calls[0]?.role).toBe('builder');

    // Reports running + a persisted row carrying the role.
    expect(snap.status).toBe('running');
    const row = store.get(snap.id);
    expect(row?.role).toBe('builder');
    expect(row?.status).toBe('running');
    expect(emissions.some((e) => e.id === snap.id && e.status === 'running')).toBe(true);

    // Init captured → sdk session id persisted.
    fake.emitInit('sdk-init-1');
    await waitFor(emissions, (e) => e.id === snap.id && e.sdkSessionId === 'sdk-init-1');
    expect(store.get(snap.id)?.sdkSessionId).toBe('sdk-init-1');

    // Stream ends → status ended.
    fake.finish();
    await waitFor(emissions, (e) => e.id === snap.id && e.status === 'ended');
    expect(store.get(snap.id)?.status).toBe('ended');
  });

  it('AC2 — two spawns run concurrently as distinct live sessions', async () => {
    const store = freshStore();
    const a = makeSession();
    const b = makeSession();
    const sessions = [a.session, b.session];
    let i = 0;
    const query: QueryFn = () => sessions[i++] as EngineSession;
    const mgr = createSessionManager({ store, query });

    const snapA = await mgr.spawn({ projectPath: PROJECT, role: 'builder' });
    const snapB = await mgr.spawn({ projectPath: PROJECT, role: 'reviewer' });

    expect(snapA.id).not.toBe(snapB.id);
    const listed = mgr.list();
    expect(listed).toHaveLength(2);
    expect(listed.every((s) => s.status === 'running')).toBe(true);
    expect(new Set(listed.map((s) => s.id)).size).toBe(2);

    // Both are independently interruptible.
    await mgr.stopAll();
    expect(a.interrupted()).toBe(true);
    expect(b.interrupted()).toBe(true);
  });

  it('AC4 — one session throwing is isolated; siblings stay running', async () => {
    const store = freshStore();
    const bad = makeSession();
    const good = makeSession();
    const sessions = [bad.session, good.session];
    let i = 0;
    const query: QueryFn = () => sessions[i++] as EngineSession;
    const mgr = createSessionManager({ store, query });
    const emissions: SessionSnapshot[] = [];
    mgr.onState((s) => emissions.push(s));

    const badSnap = await mgr.spawn({ projectPath: PROJECT, role: 'reviewer' });
    const goodSnap = await mgr.spawn({ projectPath: PROJECT, role: 'reviewer' });

    // The bad session's generator throws — spawn already returned, must not crash.
    bad.throwError(new Error('boom'));
    await waitFor(emissions, (e) => e.id === badSnap.id && e.status === 'errored');

    // The sibling is unaffected — still live + running.
    expect(store.get(badSnap.id)?.status).toBe('errored');
    const live = mgr.list();
    expect(live.map((s) => s.id)).toContain(goodSnap.id);
    expect(live.find((s) => s.id === goodSnap.id)?.status).toBe('running');
    // The errored session was removed from the live map.
    expect(live.map((s) => s.id)).not.toContain(badSnap.id);

    await mgr.stopAll();
  });

  it('defaults the query seam to the real engine when none injected', () => {
    const store = freshStore();
    // Constructing with no query must not throw (defaults to defaultQuery).
    expect(() => createSessionManager({ store })).not.toThrow();
  });

  it('AC2b — passes model/effort through to query(), defaulting when absent', async () => {
    const store = freshStore();
    const calls: SpawnParams[] = [];
    const fake = makeSession();
    const other = makeSession();
    const sessions = [fake.session, other.session];
    let i = 0;
    const query: QueryFn = (params) => {
      calls.push(params);
      return sessions[i++] as EngineSession;
    };
    const mgr = createSessionManager({ store, query });

    await mgr.spawn({
      projectPath: PROJECT,
      role: 'builder',
      model: 'claude-opus-5[1m]',
      effort: 'high',
    });
    expect(calls[0]?.model).toBe('claude-opus-5[1m]');
    expect(calls[0]?.effort).toBe('high');

    await mgr.spawn({ projectPath: PROJECT, role: 'reviewer' });
    expect(calls[1]?.model).toBe('inherit');
    expect(calls[1]?.effort).toBe('medium');
  });
});

describe('SessionManager steer + interrupt', () => {
  it('sendInput echoes a user-text transcript event AND pushes the text into the engine', async () => {
    const store = freshStore();
    const fake = makeSession();
    const mgr = createSessionManager({ store, query: () => fake.session });
    const received: TranscriptEvent[] = [];
    mgr.onTranscript((_path, _id, events) => received.push(...events));

    const snap = await mgr.spawn({ projectPath: PROJECT, role: 'builder' });
    mgr.sendInput(snap.id, 'focus on the auth module');
    await waitUntil(() => received.some((e) => e.kind === 'user-text'));

    const echo = received.find((e) => e.kind === 'user-text');
    expect(echo).toMatchObject({
      kind: 'user-text',
      text: 'focus on the auth module',
      sessionId: snap.id,
    });
    expect(Object.isFrozen(echo)).toBe(true);
    // The full text reaches the engine's live input stream.
    expect(fake.sent()).toEqual(['focus on the auth module']);

    fake.finish();
    await mgr.stopAll();
  });

  it('sendInput for an unknown/ended session is a guarded no-op (no throw, no echo, no send)', async () => {
    const store = freshStore();
    const fake = makeSession();
    const mgr = createSessionManager({ store, query: () => fake.session });
    const received: TranscriptEvent[] = [];
    mgr.onTranscript((_path, _id, events) => received.push(...events));

    await mgr.spawn({ projectPath: PROJECT, role: 'builder' });
    expect(() => mgr.sendInput('does-not-exist', 'hello')).not.toThrow();
    expect(fake.sent()).toEqual([]);
    expect(received).toHaveLength(0);

    fake.finish();
    await mgr.stopAll();
  });

  it('a rejecting engine.send is isolated — never crashes and a sibling stays running', async () => {
    const store = freshStore();
    const bad = makeSession();
    const good = makeSession();
    const sessions = [bad.session, good.session];
    let i = 0;
    const mgr = createSessionManager({ store, query: () => sessions[i++] as EngineSession });

    const badSnap = await mgr.spawn({ projectPath: PROJECT, role: 'reviewer' });
    const goodSnap = await mgr.spawn({ projectPath: PROJECT, role: 'reviewer' });

    // Swap in a send that rejects — sendInput must swallow it (per-session isolation).
    (bad.session as unknown as { send: (t: string) => Promise<void> }).send = async () => {
      throw new Error('send boom');
    };

    expect(() => mgr.sendInput(badSnap.id, 'x')).not.toThrow();
    // Give the rejected promise a tick to settle (caught inside sendInput).
    await new Promise((r) => setTimeout(r, 5));
    expect(mgr.list().find((s) => s.id === goodSnap.id)?.status).toBe('running');

    bad.finish();
    good.finish();
    await mgr.stopAll();
  });

  it('interrupt aborts the current turn but does NOT end the session (stays running)', async () => {
    const store = freshStore();
    const fake = makeSession({ endsOnInterrupt: false });
    const mgr = createSessionManager({ store, query: () => fake.session });

    const snap = await mgr.spawn({ projectPath: PROJECT, role: 'builder' });
    await mgr.interrupt(snap.id);

    expect(fake.interruptCount()).toBe(1);
    // Session is NOT terminated — the manager still lists it as running.
    expect(mgr.list().find((s) => s.id === snap.id)?.status).toBe('running');

    fake.finish();
    await mgr.stopAll();
  });

  it('interrupt for an unknown/ended session is a guarded no-op', async () => {
    const store = freshStore();
    const fake = makeSession();
    const mgr = createSessionManager({ store, query: () => fake.session });

    await mgr.spawn({ projectPath: PROJECT, role: 'builder' });
    await expect(mgr.interrupt('nope')).resolves.toBeUndefined();
    expect(fake.interruptCount()).toBe(0);

    fake.finish();
    await mgr.stopAll();
  });
});

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

/** An assistant message carrying a single text block. */
function assistantText(text: string): EngineMessage {
  return { type: 'assistant', message: { content: [{ type: 'text', text }] } };
}

/** A `result` engine message carrying the given cost/usage metrics. */
function resultMessage(totalCostUsd: number, inputTokens: number, outputTokens: number): EngineMessage {
  return {
    type: 'result',
    duration_ms: 100,
    num_turns: 1,
    total_cost_usd: totalCostUsd,
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
    is_error: false,
  };
}

const CANNED_AGGREGATE: CostUsageAggregate = Object.freeze({
  costTodayUsd: 1.23,
  inputTokensToday: 100,
  outputTokensToday: 200,
  sinceEpochMs: 0,
});

/** A fake CostLedgerStore that records insert() calls and returns a canned aggregate. */
function makeFakeCostLedger(opts: { throwOnInsert?: boolean } = {}): {
  costLedger: { insert: (row: CostLedgerInsert) => void; costToday: () => CostUsageAggregate };
  inserts: CostLedgerInsert[];
} {
  const inserts: CostLedgerInsert[] = [];
  const costLedger = {
    insert: (row: CostLedgerInsert): void => {
      inserts.push(row);
      if (opts.throwOnInsert === true) {
        throw new Error('ledger insert boom');
      }
    },
    costToday: (): CostUsageAggregate => CANNED_AGGREGATE,
  };
  return { costLedger, inserts };
}

describe('SessionManager transcript', () => {
  it('emits ordered init/assistant-text/tool-use/tool-result/result events via onTranscript', async () => {
    const store = freshStore();
    const fake = makeSession();
    const mgr = createSessionManager({ store, query: () => fake.session });
    const received: TranscriptEvent[] = [];
    const paths: string[] = [];
    mgr.onTranscript((projectPath, sessionId, events) => {
      paths.push(projectPath);
      received.push(...events);
      expect(events.every((e) => e.sessionId === sessionId)).toBe(true);
    });

    const snap = await mgr.spawn({ projectPath: PROJECT, role: 'builder' });

    fake.emitInit('sdk-t-1');
    fake.emit({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'hello there' },
          { type: 'tool_use', id: 'tu-1', name: 'Bash', input: { command: 'ls' } },
        ],
      },
    });
    fake.emit({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'tu-1', content: 'ok', is_error: false }] },
    });
    fake.emit({
      type: 'result',
      duration_ms: 1234,
      num_turns: 2,
      total_cost_usd: 0.05,
      usage: { input_tokens: 10, output_tokens: 20 },
      is_error: false,
    });

    await waitUntil(() => received.length >= 5);
    expect(paths.every((p) => p === PROJECT)).toBe(true);
    expect(received.map((e) => e.kind)).toEqual([
      'init',
      'assistant-text',
      'tool-use',
      'tool-result',
      'result',
    ]);
    // Monotonic per-session seq, stamped identity, frozen events.
    expect(received.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4]);
    expect(received.every((e) => e.sessionId === snap.id)).toBe(true);
    expect(received.every((e) => Object.isFrozen(e))).toBe(true);
    const result = received[4];
    expect(result).toMatchObject({
      kind: 'result',
      durationMs: 1234,
      numTurns: 2,
      totalCostUsd: 0.05,
      inputTokens: 10,
      outputTokens: 20,
      isError: false,
    });

    fake.finish();
    await mgr.stopAll();
  });

  it('bounds the ring buffer at 500 events, dropping the oldest', async () => {
    const store = freshStore();
    const fake = makeSession();
    const mgr = createSessionManager({ store, query: () => fake.session });
    let seen = 0;
    mgr.onTranscript((_path, _id, events) => {
      seen += events.length;
    });

    const snap = await mgr.spawn({ projectPath: PROJECT, role: 'reviewer' });
    const total = 510;
    for (let n = 0; n < total; n += 1) fake.emit(assistantText(`msg-${n}`));
    await waitUntil(() => seen >= total);

    const buffered = mgr.getTranscript(snap.id);
    expect(buffered).toHaveLength(500);
    // The oldest 10 were dropped; seq keeps counting monotonically.
    expect(buffered[0]?.seq).toBe(10);
    expect(buffered[499]?.seq).toBe(509);
    expect(buffered[0]).toMatchObject({ kind: 'assistant-text', text: 'msg-10' });

    fake.finish();
    await mgr.stopAll();
  });

  it('getTranscript returns the live buffer (frozen copy) and [] once the session ends', async () => {
    const store = freshStore();
    const fake = makeSession();
    const mgr = createSessionManager({ store, query: () => fake.session });
    const emissions: SessionSnapshot[] = [];
    mgr.onState((s) => emissions.push(s));
    let seen = 0;
    mgr.onTranscript((_path, _id, events) => {
      seen += events.length;
    });

    const snap = await mgr.spawn({ projectPath: PROJECT, role: 'builder' });
    fake.emitInit('sdk-t-2');
    fake.emit(assistantText('still here'));
    await waitUntil(() => seen >= 2);

    const liveTranscript = mgr.getTranscript(snap.id);
    expect(liveTranscript.map((e) => e.kind)).toEqual(['init', 'assistant-text']);
    expect(Object.isFrozen(liveTranscript)).toBe(true);
    // Unknown ids are empty too.
    expect(mgr.getTranscript('nope')).toEqual([]);

    // Buffer dies with the live session (AC4 — nothing persisted, nothing retained).
    fake.finish();
    await waitFor(emissions, (e) => e.id === snap.id && e.status === 'ended');
    expect(mgr.getTranscript(snap.id)).toEqual([]);
  });

  it('a poisoned message or throwing listener never flips status; sibling unaffected', async () => {
    const store = freshStore();
    const victim = makeSession();
    const sibling = makeSession();
    const sessions = [victim.session, sibling.session];
    let i = 0;
    const query: QueryFn = () => sessions[i++] as EngineSession;
    const mgr = createSessionManager({ store, query });
    const emissions: SessionSnapshot[] = [];
    mgr.onState((s) => emissions.push(s));
    const received: TranscriptEvent[] = [];
    // First listener always throws — must be guarded per listener, later listeners still run.
    mgr.onTranscript(() => {
      throw new Error('listener boom');
    });
    mgr.onTranscript((_path, _id, events) => {
      received.push(...events);
    });

    const victimSnap = await mgr.spawn({ projectPath: PROJECT, role: 'reviewer' });
    const siblingSnap = await mgr.spawn({ projectPath: PROJECT, role: 'reviewer' });

    // A poisoned message whose content access throws mid-normalization. (`type`
    // itself stays readable — the status-derivation path reads it too.)
    const poisoned = { type: 'assistant' } as EngineMessage;
    Object.defineProperty(poisoned, 'message', {
      get() {
        throw new Error('poisoned message');
      },
    });
    victim.emit(poisoned);
    victim.emit(assistantText('survived'));
    await waitUntil(() => received.some((e) => e.kind === 'assistant-text'));

    // Poisoned message skipped, good message still captured despite the bad listener.
    expect(received.map((e) => e.kind)).toEqual(['assistant-text']);

    // The victim ends 'ended' — NOT 'errored' — and the sibling stays running (AC5).
    victim.finish();
    await waitFor(emissions, (e) => e.id === victimSnap.id && e.status === 'ended');
    expect(store.get(victimSnap.id)?.status).toBe('ended');
    expect(mgr.list().find((s) => s.id === siblingSnap.id)?.status).toBe('running');

    await mgr.stopAll();
  });

  it('never writes transcript data to the store (in-memory only, AC4)', async () => {
    const inner = freshStore();
    // The store object is frozen — record write calls through a delegating wrapper.
    const insertCalls: unknown[][] = [];
    const updateCalls: unknown[][] = [];
    const store: typeof inner = {
      insert: (input) => {
        insertCalls.push([input]);
        return inner.insert(input);
      },
      updateStatus: (id, status, sdkSessionId) => {
        updateCalls.push([id, status, sdkSessionId]);
        inner.updateStatus(id, status, sdkSessionId);
      },
      list: () => inner.list(),
      get: (id) => inner.get(id),
      listByWorkItem: (workItemId, projectPath) => inner.listByWorkItem(workItemId, projectPath),
    };
    const fake = makeSession();
    const mgr = createSessionManager({ store, query: () => fake.session });
    const emissions: SessionSnapshot[] = [];
    mgr.onState((s) => emissions.push(s));
    let seen = 0;
    mgr.onTranscript((_path, _id, events) => {
      seen += events.length;
    });

    const snap = await mgr.spawn({ projectPath: PROJECT, role: 'builder' });
    fake.emitInit('sdk-t-3');
    fake.emit(assistantText('TRANSCRIPT-MARKER-TEXT'));
    fake.finish();
    await waitFor(emissions, (e) => e.id === snap.id && e.status === 'ended');
    await waitUntil(() => seen >= 2);

    // Only the anchor-row writes happened — and none of them carry transcript content.
    expect(insertCalls).toHaveLength(1);
    for (const call of [...insertCalls, ...updateCalls]) {
      expect(JSON.stringify(call)).not.toContain('TRANSCRIPT-MARKER-TEXT');
    }
    expect(updateCalls.every(([, status]) => status === 'running' || status === 'ended')).toBe(true);
  });
});

describe('SessionManager permission relay', () => {
  it('onPermissionRequest fires the listener with (projectPath, sessionId, req)', async () => {
    const store = freshStore();
    const fake = makeSession();
    const mgr = createSessionManager({ store, query: () => fake.session });
    const received: Array<{ projectPath: string; sessionId: string; req: EnginePermissionRequest }> = [];
    mgr.onPermissionRequest((projectPath, sessionId, req) => {
      received.push({ projectPath, sessionId, req });
    });

    const snap = await mgr.spawn({ projectPath: PROJECT, role: 'builder' });

    const request: EnginePermissionRequest = {
      requestId: 'req-1',
      toolUseId: 'tu-1',
      toolName: 'Bash',
      title: null,
      input: '{"command":"ls"}',
      ts: 1_700_000_000_000,
    };
    fake.emitPermissionRequest(request);

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({ projectPath: PROJECT, sessionId: snap.id, req: request });

    fake.finish();
    await mgr.stopAll();
  });

  it('resolvePermission for a live session calls through to the engine and emits a permission audit event', async () => {
    const store = freshStore();
    const fake = makeSession();
    const mgr = createSessionManager({ store, query: () => fake.session });
    const received: TranscriptEvent[] = [];
    mgr.onTranscript((_path, _id, events) => received.push(...events));

    const snap = await mgr.spawn({ projectPath: PROJECT, role: 'builder' });
    fake.emitPermissionRequest({
      requestId: 'req-2',
      toolUseId: 'tu-2',
      toolName: 'Bash',
      title: null,
      input: '{}',
      ts: 1_700_000_000_000,
    });

    mgr.resolvePermission(snap.id, 'req-2', 'deny');

    expect(fake.resolvePermissionCalls()).toEqual([{ requestId: 'req-2', decision: 'deny' }]);
    const auditEvent = received.find((e) => e.kind === 'permission');
    expect(auditEvent).toMatchObject({
      kind: 'permission',
      requestId: 'req-2',
      toolName: 'Bash',
      decision: 'deny',
      sessionId: snap.id,
    });
    expect(Object.isFrozen(auditEvent)).toBe(true);

    fake.finish();
    await mgr.stopAll();
  });

  it('resolvePermission for an unknown session id is a silent no-op', async () => {
    const store = freshStore();
    const fake = makeSession();
    const mgr = createSessionManager({ store, query: () => fake.session });

    await mgr.spawn({ projectPath: PROJECT, role: 'builder' });
    expect(() => mgr.resolvePermission('does-not-exist', 'req-x', 'allow')).not.toThrow();
    expect(fake.resolvePermissionCalls()).toEqual([]);

    fake.finish();
    await mgr.stopAll();
  });

  it('resolvePermission for an unknown/stale requestId on a live session is an idempotent no-op (no phantom audit)', async () => {
    const store = freshStore();
    const fake = makeSession();
    const mgr = createSessionManager({ store, query: () => fake.session });
    const received: TranscriptEvent[] = [];
    mgr.onTranscript((_path, _id, events) => received.push(...events));

    const snap = await mgr.spawn({ projectPath: PROJECT, role: 'builder' });
    // No request was ever raised for 'ghost-req' — a forged/stale decision must NOT reach
    // the engine and must NOT inject a phantom permission audit event.
    mgr.resolvePermission(snap.id, 'ghost-req', 'allow');

    expect(fake.resolvePermissionCalls()).toEqual([]);
    expect(received.some((e) => e.kind === 'permission')).toBe(false);

    fake.finish();
    await mgr.stopAll();
  });

  it('resolvePermission is idempotent for a repeated decision on the same requestId', async () => {
    const store = freshStore();
    const fake = makeSession();
    const mgr = createSessionManager({ store, query: () => fake.session });
    const received: TranscriptEvent[] = [];
    mgr.onTranscript((_path, _id, events) => received.push(...events));

    const snap = await mgr.spawn({ projectPath: PROJECT, role: 'builder' });
    fake.emitPermissionRequest({
      requestId: 'req-dup',
      toolUseId: 'tu-dup',
      toolName: 'Write',
      title: null,
      input: '{}',
      ts: 1_700_000_000_000,
    });

    // First decision resolves + audits; a second click (e.g. from another tab) is a no-op.
    mgr.resolvePermission(snap.id, 'req-dup', 'allow');
    mgr.resolvePermission(snap.id, 'req-dup', 'deny');

    expect(fake.resolvePermissionCalls()).toEqual([{ requestId: 'req-dup', decision: 'allow' }]);
    expect(received.filter((e) => e.kind === 'permission')).toHaveLength(1);

    fake.finish();
    await mgr.stopAll();
  });

  it('AC4: resolvePermission with "allow-always" calls through to the engine and emits a permission audit event carrying that decision', async () => {
    const store = freshStore();
    const fake = makeSession();
    const mgr = createSessionManager({ store, query: () => fake.session });
    const received: TranscriptEvent[] = [];
    mgr.onTranscript((_path, _id, events) => received.push(...events));

    const snap = await mgr.spawn({ projectPath: PROJECT, role: 'builder' });
    fake.emitPermissionRequest({
      requestId: 'req-always',
      toolUseId: 'tu-always',
      toolName: 'Bash',
      title: null,
      input: '{}',
      ts: 1_700_000_000_000,
    });

    mgr.resolvePermission(snap.id, 'req-always', 'allow-always');

    expect(fake.resolvePermissionCalls()).toEqual([{ requestId: 'req-always', decision: 'allow-always' }]);
    const auditEvent = received.find((e) => e.kind === 'permission');
    expect(auditEvent).toMatchObject({
      kind: 'permission',
      requestId: 'req-always',
      toolName: 'Bash',
      decision: 'allow-always',
      sessionId: snap.id,
    });
    expect(Object.isFrozen(auditEvent)).toBe(true);

    fake.finish();
    await mgr.stopAll();
  });

  it('AC4 (regression): resolvePermission with "allow-always" for an unknown/stale requestId is an idempotent no-op (no phantom audit)', async () => {
    const store = freshStore();
    const fake = makeSession();
    const mgr = createSessionManager({ store, query: () => fake.session });
    const received: TranscriptEvent[] = [];
    mgr.onTranscript((_path, _id, events) => received.push(...events));

    const snap = await mgr.spawn({ projectPath: PROJECT, role: 'builder' });
    // No request was ever raised for 'ghost-req-always' — a forged/stale decision must
    // NOT reach the engine and must NOT inject a phantom permission audit event.
    mgr.resolvePermission(snap.id, 'ghost-req-always', 'allow-always');

    expect(fake.resolvePermissionCalls()).toEqual([]);
    expect(received.some((e) => e.kind === 'permission')).toBe(false);

    fake.finish();
    await mgr.stopAll();
  });
});

describe('SessionManager question relay', () => {
  it('onQuestionRequest fires the listener with (projectPath, sessionId, req)', async () => {
    const store = freshStore();
    const fake = makeSession();
    const mgr = createSessionManager({ store, query: () => fake.session });
    const received: Array<{ projectPath: string; sessionId: string; req: EngineQuestionRequest }> = [];
    mgr.onQuestionRequest((projectPath, sessionId, req) => {
      received.push({ projectPath, sessionId, req });
    });

    const snap = await mgr.spawn({ projectPath: PROJECT, role: 'builder' });

    const request: EngineQuestionRequest = {
      requestId: 'q-1',
      question: 'Which config?',
      chips: ['A', 'B'],
    };
    fake.emitQuestionRequest(request);

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({ projectPath: PROJECT, sessionId: snap.id, req: request });

    fake.finish();
    await mgr.stopAll();
  });

  it('answerQuestion for a live session calls through to the engine and echoes a user-text event', async () => {
    const store = freshStore();
    const fake = makeSession();
    const mgr = createSessionManager({ store, query: () => fake.session });
    const received: TranscriptEvent[] = [];
    mgr.onTranscript((_path, _id, events) => received.push(...events));

    const snap = await mgr.spawn({ projectPath: PROJECT, role: 'builder' });
    fake.emitQuestionRequest({ requestId: 'q-2', question: 'Proceed?', chips: [] });

    mgr.answerQuestion(snap.id, 'q-2', 'yes');

    expect(fake.answerQuestionCalls()).toEqual([{ requestId: 'q-2', answer: 'yes' }]);
    const echo = received.find((e) => e.kind === 'user-text');
    expect(echo).toMatchObject({ kind: 'user-text', text: 'yes', sessionId: snap.id });
    expect(Object.isFrozen(echo)).toBe(true);

    fake.finish();
    await mgr.stopAll();
  });

  it('answerQuestion for an unknown session id is a silent no-op', async () => {
    const store = freshStore();
    const fake = makeSession();
    const mgr = createSessionManager({ store, query: () => fake.session });

    await mgr.spawn({ projectPath: PROJECT, role: 'builder' });
    expect(() => mgr.answerQuestion('does-not-exist', 'q-x', 'yes')).not.toThrow();
    expect(fake.answerQuestionCalls()).toEqual([]);

    fake.finish();
    await mgr.stopAll();
  });

  it('answerQuestion for an unknown/stale requestId on a live session is an idempotent no-op (no phantom echo)', async () => {
    const store = freshStore();
    const fake = makeSession();
    const mgr = createSessionManager({ store, query: () => fake.session });
    const received: TranscriptEvent[] = [];
    mgr.onTranscript((_path, _id, events) => received.push(...events));

    const snap = await mgr.spawn({ projectPath: PROJECT, role: 'builder' });
    // No question was ever raised for 'ghost-q' — a forged/stale answer must NOT reach the
    // engine and must NOT inject a phantom user-text echo.
    mgr.answerQuestion(snap.id, 'ghost-q', 'yes');

    expect(fake.answerQuestionCalls()).toEqual([]);
    expect(received.some((e) => e.kind === 'user-text')).toBe(false);

    fake.finish();
    await mgr.stopAll();
  });

  it('answerQuestion is idempotent for a repeated answer on the same requestId', async () => {
    const store = freshStore();
    const fake = makeSession();
    const mgr = createSessionManager({ store, query: () => fake.session });
    const received: TranscriptEvent[] = [];
    mgr.onTranscript((_path, _id, events) => received.push(...events));

    const snap = await mgr.spawn({ projectPath: PROJECT, role: 'builder' });
    fake.emitQuestionRequest({ requestId: 'q-dup', question: 'Q?', chips: [] });

    // First answer resolves + echoes; a second submit (e.g. from another tab) is a no-op.
    mgr.answerQuestion(snap.id, 'q-dup', 'first');
    mgr.answerQuestion(snap.id, 'q-dup', 'second');

    expect(fake.answerQuestionCalls()).toEqual([{ requestId: 'q-dup', answer: 'first' }]);
    expect(received.filter((e) => e.kind === 'user-text')).toHaveLength(1);

    fake.finish();
    await mgr.stopAll();
  });
});

describe('SessionManager cost usage', () => {
  it('records one ledger row per result message and emits the aggregate via onCostUsage', async () => {
    const store = freshStore();
    const fake = makeSession();
    const { costLedger, inserts } = makeFakeCostLedger();
    const mgr = createSessionManager({ store, query: () => fake.session, costLedger });
    const usages: CostUsageAggregate[] = [];
    mgr.onCostUsage((usage) => usages.push(usage));

    const snap = await mgr.spawn({ projectPath: PROJECT, role: 'builder' });
    fake.emit(resultMessage(0.05, 10, 20));

    await waitUntil(() => inserts.length >= 1);

    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toMatchObject({
      sessionId: snap.id,
      inputTokens: 10,
      outputTokens: 20,
      costUsd: 0.05,
    });
    expect(usages).toContainEqual(CANNED_AGGREGATE);

    fake.finish();
    await mgr.stopAll();
  });

  it('a throwing costLedger.insert is isolated — status still ends "ended", no rethrow', async () => {
    const store = freshStore();
    const fake = makeSession();
    const { costLedger, inserts } = makeFakeCostLedger({ throwOnInsert: true });
    const mgr = createSessionManager({ store, query: () => fake.session, costLedger });
    const emissions: SessionSnapshot[] = [];
    mgr.onState((s) => emissions.push(s));

    const snap = await mgr.spawn({ projectPath: PROJECT, role: 'builder' });
    fake.emit(resultMessage(0.05, 10, 20));
    await waitUntil(() => inserts.length >= 1);

    fake.finish();
    await waitFor(emissions, (e) => e.id === snap.id && e.status === 'ended');
    expect(store.get(snap.id)?.status).toBe('ended');

    await mgr.stopAll();
  });

  it('with no costLedger dep, a result message is a no-op (no throw)', async () => {
    const store = freshStore();
    const fake = makeSession();
    const mgr = createSessionManager({ store, query: () => fake.session });
    const emissions: SessionSnapshot[] = [];
    mgr.onState((s) => emissions.push(s));

    const snap = await mgr.spawn({ projectPath: PROJECT, role: 'builder' });
    expect(() => fake.emit(resultMessage(0.05, 10, 20))).not.toThrow();

    fake.finish();
    await waitFor(emissions, (e) => e.id === snap.id && e.status === 'ended');
    expect(store.get(snap.id)?.status).toBe('ended');

    await mgr.stopAll();
  });

  it('drops a negative result body — no ledger row, status still "ended"', async () => {
    const store = freshStore();
    const fake = makeSession();
    const { costLedger, inserts } = makeFakeCostLedger();
    const mgr = createSessionManager({ store, query: () => fake.session, costLedger });
    const usages: CostUsageAggregate[] = [];
    const emissions: SessionSnapshot[] = [];
    mgr.onCostUsage((usage) => usages.push(usage));
    mgr.onState((s) => emissions.push(s));

    const snap = await mgr.spawn({ projectPath: PROJECT, role: 'builder' });
    // A negative cost, a negative input-token count, and a negative output-token count
    // are each poison for the account-wide SUM and must be dropped at the boundary.
    fake.emit(resultMessage(-0.01, 10, 20));
    fake.emit(resultMessage(0.05, -5, 20));
    fake.emit(resultMessage(0.05, 10, -1));

    fake.finish();
    await waitFor(emissions, (e) => e.id === snap.id && e.status === 'ended');

    expect(inserts).toHaveLength(0);
    expect(usages).toHaveLength(0);
    expect(store.get(snap.id)?.status).toBe('ended');

    await mgr.stopAll();
  });
});

describe('SessionManager context usage', () => {
  const BIG_MODEL = 'claude-opus-4-8[1m]';

  it('fires onContextUsage exactly once when a result crosses 80% of the model window; not below threshold', async () => {
    const store = freshStore();
    const fake = makeSession();
    const mgr = createSessionManager({ store, query: () => fake.session });
    const signals: Parameters<Parameters<typeof mgr.onContextUsage>[0]>[0][] = [];
    mgr.onContextUsage((signal) => signals.push(signal));

    const snap = await mgr.spawn({ projectPath: PROJECT, role: 'builder', model: BIG_MODEL });

    // Below threshold (100_000 / 1_000_000 = 0.1) — must not fire.
    fake.emit(resultMessage(0.01, 100_000, 20));
    await new Promise((r) => setTimeout(r, 20));
    expect(signals).toHaveLength(0);

    // Crosses threshold (850_000 / 1_000_000 = 0.85).
    fake.emit(resultMessage(0.02, 850_000, 20));
    await waitUntil(() => signals.length >= 1);

    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      sessionId: snap.id,
      model: BIG_MODEL,
    });
    expect(signals[0]?.fraction).toBeGreaterThanOrEqual(0.8);

    // A second over-threshold result on the SAME session must NOT fire again (latch).
    fake.emit(resultMessage(0.02, 900_000, 20));
    await new Promise((r) => setTimeout(r, 20));
    expect(signals).toHaveLength(1);

    fake.finish();
    await mgr.stopAll();
  });

  it('sizes the window off the model reported on system/init — no fire at 160k, fires at >=800k', async () => {
    const store = freshStore();
    const fake = makeSession();
    const mgr = createSessionManager({ store, query: () => fake.session });
    const signals: Parameters<Parameters<typeof mgr.onContextUsage>[0]>[0][] = [];
    mgr.onContextUsage((signal) => signals.push(signal));

    const snap = await mgr.spawn({ projectPath: PROJECT, role: 'builder' });

    fake.emit({ type: 'system', subtype: 'init', session_id: 'sdk-init-model', model: 'claude-opus-4-8[1m]' });
    await waitUntil(() => store.get(snap.id)?.sdkSessionId === 'sdk-init-model');

    // 160_000 / 1_000_000 (captured window) = 0.16 — must NOT fire. Under the old buggy
    // 200k sizing this would be 0.8 and WOULD fire; this is the regression oracle.
    fake.emit(resultMessage(0.01, 160_000, 20));
    await new Promise((r) => setTimeout(r, 20));
    expect(signals).toHaveLength(0);

    // 800_000 / 1_000_000 = 0.8 — crosses threshold.
    fake.emit(resultMessage(0.02, 800_000, 20));
    await waitUntil(() => signals.length >= 1);

    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      sessionId: snap.id,
      model: 'claude-opus-4-8[1m]',
      windowTokens: 1_000_000,
    });
    expect(signals[0]?.fraction).toBeGreaterThanOrEqual(0.8);

    fake.finish();
    await mgr.stopAll();
  });

  it('sizes off the roster-declared contextWindow — authoritative even with no init model', async () => {
    const store = freshStore();
    const fake = makeSession();
    const mgr = createSessionManager({ store, query: () => fake.session });
    const signals: Parameters<Parameters<typeof mgr.onContextUsage>[0]>[0][] = [];
    mgr.onContextUsage((signal) => signals.push(signal));

    // Spawn with a declared 1M window but the placeholder model and NO system/init model —
    // the declared window alone must drive the recycle sizing.
    const snap = await mgr.spawn({
      projectPath: PROJECT,
      role: 'builder',
      contextWindow: 1_000_000,
    });

    fake.emit(resultMessage(0.01, 160_000, 20));
    await new Promise((r) => setTimeout(r, 20));
    expect(signals).toHaveLength(0);

    fake.emit(resultMessage(0.02, 800_000, 20));
    await waitUntil(() => signals.length >= 1);

    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({ sessionId: snap.id, windowTokens: 1_000_000 });
    expect(signals[0]?.fraction).toBeGreaterThanOrEqual(0.8);

    fake.finish();
    await mgr.stopAll();
  });

  it('warns AT MOST ONCE when recycling against the guessed 200k default (no window, unknown model)', async () => {
    const store = freshStore();
    const fake = makeSession();
    const mgr = createSessionManager({ store, query: () => fake.session });
    const signals: Parameters<Parameters<typeof mgr.onContextUsage>[0]>[0][] = [];
    mgr.onContextUsage((signal) => signals.push(signal));
    const configWarnings: Parameters<Parameters<typeof mgr.onContextConfigWarning>[0]>[0][] = [];
    mgr.onContextConfigWarning((warning) => configWarnings.push(warning));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      // No contextWindow and no system/init model → windowModel is the 'inherit' placeholder,
      // which resolves to the 200k default and is NOT a known window.
      const snap = await mgr.spawn({ projectPath: PROJECT, role: 'builder' });

      // Two BELOW-threshold results (100k, 120k of 200k) — each reaches the warn check but must
      // not fire the recycle signal; the warn latch limits the warning to exactly one.
      fake.emit(resultMessage(0.01, 100_000, 20));
      fake.emit(resultMessage(0.01, 120_000, 20));
      await new Promise((r) => setTimeout(r, 20));
      expect(signals).toHaveLength(0);

      const windowWarnings = warnSpy.mock.calls.filter((c) =>
        String(c[0]).includes('no declared or known context window'),
      );
      expect(windowWarnings).toHaveLength(1);

      // The human-visible signal fires exactly once too (same latch), carrying the fallback
      // window and the (sanitized) model — so the Bridge can surface it in the Needs-you inbox.
      expect(configWarnings).toHaveLength(1);
      expect(configWarnings[0]).toMatchObject({
        sessionId: snap.id,
        model: 'inherit',
        fallbackWindow: 200_000,
      });

      // A crossing result now fires against the 200k default window.
      fake.emit(resultMessage(0.02, 170_000, 20));
      await waitUntil(() => signals.length >= 1);
      expect(signals[0]).toMatchObject({ sessionId: snap.id, windowTokens: 200_000 });

      fake.finish();
      await mgr.stopAll();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('endAtBoundary calls the engine end(); an unknown id is a guarded no-op', async () => {
    const store = freshStore();
    const fake = makeSession();
    const mgr = createSessionManager({ store, query: () => fake.session });
    const emissions: SessionSnapshot[] = [];
    mgr.onState((s) => emissions.push(s));

    const snap = await mgr.spawn({ projectPath: PROJECT, role: 'builder' });

    // Unknown id — guarded no-op, no throw.
    expect(() => mgr.endAtBoundary('does-not-exist')).not.toThrow();

    // Known id — calls through to the fake engine's end(), which closes the stream and
    // the consume loop then settles the session to 'ended'.
    mgr.endAtBoundary(snap.id);
    await waitFor(emissions, (e) => e.id === snap.id && e.status === 'ended');
    expect(store.get(snap.id)?.status).toBe('ended');

    await mgr.stopAll();
  });
});
