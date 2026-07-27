// Unit tests — SessionManager spawn / multiplex / lifecycle with a DETERMINISTIC
// FAKE engine. No live Claude. A real in-memory DB + store backs persistence.

import { describe, expect, it } from 'vitest';
import { openDatabase } from '../db/database.js';
import { createRegistry } from '../registry/registry.js';
import type { TranscriptEvent } from '../ws-protocol.js';
import { createSessionStore } from './session-store.js';
import { createSessionManager, type SessionSnapshot } from './session-manager.js';
import type { EngineMessage, EngineSession, QueryFn, SpawnParams } from './session-engine.js';

const PROJECT = '/tmp/devos-sm-project';

/** A controllable fake EngineSession: push any message, end, or throw on demand. */
function makeSession(): {
  session: EngineSession;
  emit: (message: EngineMessage) => void;
  emitInit: (sessionId: string) => void;
  finish: () => void;
  throwError: (err: unknown) => void;
  interrupted: () => boolean;
} {
  const buffer: EngineMessage[] = [];
  let resolveNext: (() => void) | null = null;
  let done = false;
  let error: unknown = null;
  let wasInterrupted = false;

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
      done = true;
      wake();
      return undefined;
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

    const snap = await mgr.spawn({ projectPath: PROJECT, role: 'shipwright' });

    // Engine invoked with cwd = project root and the requested role.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.cwd).toBe(PROJECT);
    expect(calls[0]?.role).toBe('shipwright');

    // Reports running + a persisted row carrying the role.
    expect(snap.status).toBe('running');
    const row = store.get(snap.id);
    expect(row?.role).toBe('shipwright');
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

    const snapA = await mgr.spawn({ projectPath: PROJECT, role: 'navigator' });
    const snapB = await mgr.spawn({ projectPath: PROJECT, role: 'lookout' });

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

    const badSnap = await mgr.spawn({ projectPath: PROJECT, role: 'warden' });
    const goodSnap = await mgr.spawn({ projectPath: PROJECT, role: 'harbormaster' });

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

    const snap = await mgr.spawn({ projectPath: PROJECT, role: 'shipwright' });

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

    const snap = await mgr.spawn({ projectPath: PROJECT, role: 'lookout' });
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

    const snap = await mgr.spawn({ projectPath: PROJECT, role: 'navigator' });
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

    const victimSnap = await mgr.spawn({ projectPath: PROJECT, role: 'warden' });
    const siblingSnap = await mgr.spawn({ projectPath: PROJECT, role: 'harbormaster' });

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
    };
    const fake = makeSession();
    const mgr = createSessionManager({ store, query: () => fake.session });
    const emissions: SessionSnapshot[] = [];
    mgr.onState((s) => emissions.push(s));
    let seen = 0;
    mgr.onTranscript((_path, _id, events) => {
      seen += events.length;
    });

    const snap = await mgr.spawn({ projectPath: PROJECT, role: 'shipwright' });
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
