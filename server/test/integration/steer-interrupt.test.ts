// Integration test (THE GATE) — steer + interrupt over the live WS transport.
//
// Boots the REAL server in-process (createServer({port:0,…})) with an INJECTED FAKE
// `query` engine (never live Claude), pins a project, opens a real `ws` client, spawns
// a session, and asserts the observable steer/interrupt contract (story 6h6hMV8QfFvwCMP8):
//   AC1 — a `session-input {sessionId,text}` frame pushes the text into the live input
//         stream: the client sees a `user-text` echo event (the human's own message)
//         AND a following `assistant-text` event acknowledging it; the fake's `send`
//         spy recorded the text.
//   AC2 — a `session-interrupt {sessionId}` frame invokes the engine's `interrupt()`
//         (spy call count 1) and the session STAYS running — it is never terminated.
//   AC3 — fail-closed: a `session-input`/`session-interrupt` for an unknown session,
//         or for a session whose project is not pinned, is a silent no-op (the fake's
//         spies stay unchanged and no `user-text` transcript frame is emitted).
//
// The fake engine is a queue-backed steerable session: it yields `system/init`, then
// loops reading an internal input queue, emitting one `assistant` (`Ack: <text>`) turn
// per pushed message. `send(text)` records the text into a spy AND drives the next turn;
// `interrupt()` records the call and does NOT complete the generator (the turn aborts,
// the session lives on); a test-controlled `release()` ends the generator for clean
// teardown. Isolation: per-test tmp DB + real tmp project dirs (projectRoots=[tmpdir()]);
// afterEach stops the server + removes DB sidecars and fixture dirs. NO live Claude.

import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { createServer } from '../../src/index.js';
import { WS_PATH } from '../../src/config.js';
import type { EngineMessage, EngineSession, QueryFn, SpawnParams } from '../../src/session/session-engine.js';

// ---------------------------------------------------------------------------
// Frame shapes observed by the in-test client (loose mirrors of the wire types).
// ---------------------------------------------------------------------------

type AnyFrame = Record<string, unknown> & { readonly type: string };

interface SessionStateFrame extends AnyFrame {
  readonly type: 'session-state';
  readonly path: string;
  readonly session: {
    readonly id: string;
    readonly projectPath: string;
    readonly role: string;
    readonly status: string;
    readonly sdkSessionId: string | null;
  };
}

interface TranscriptEventWire {
  readonly kind: string;
  readonly sessionId: string;
  readonly seq: number;
  readonly ts: number;
  readonly [key: string]: unknown;
}

interface TranscriptFrame extends AnyFrame {
  readonly type: 'session-transcript';
  readonly path: string;
  readonly sessionId: string;
  readonly events: readonly TranscriptEventWire[];
}

function isAnyFrame(value: unknown): value is AnyFrame {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>)['type'] === 'string'
  );
}

function isSessionStateFrame(frame: AnyFrame): frame is SessionStateFrame {
  return (
    frame.type === 'session-state' &&
    typeof frame['path'] === 'string' &&
    typeof frame['session'] === 'object' &&
    frame['session'] !== null
  );
}

function isTranscriptFrame(frame: AnyFrame): frame is TranscriptFrame {
  return (
    frame.type === 'session-transcript' &&
    typeof frame['path'] === 'string' &&
    typeof frame['sessionId'] === 'string' &&
    Array.isArray(frame['events'])
  );
}

// ---------------------------------------------------------------------------
// Fake engine — queue-backed, steerable, holds open until released.
// ---------------------------------------------------------------------------

interface FakeSpawn {
  readonly params: SpawnParams;
  /** Every text pushed via engine.send(). */
  readonly sent: () => readonly string[];
  /** How many times engine.interrupt() was called. */
  readonly interruptCount: () => number;
  /** End the generator so the consume loop finishes (clean teardown). */
  readonly release: () => void;
}

/**
 * A steerable session: yields `system/init`, then loops reading an internal input
 * queue. Each pushed message drives one `assistant` turn whose text acknowledges the
 * input (`Ack: <text>`). `interrupt()` records the call but does NOT complete the
 * generator (per-turn abort; the session stays running). `release()` closes it.
 */
function makeSteerableSession(sdkId: string): {
  engine: EngineSession;
  sent: () => readonly string[];
  interruptCount: () => number;
  release: () => void;
} {
  const queue: string[] = [];
  const sentTexts: string[] = [];
  let interruptCalls = 0;
  let resolveNext: (() => void) | null = null;
  let closed = false;

  const wake = (): void => {
    if (resolveNext !== null) {
      const r = resolveNext;
      resolveNext = null;
      r();
    }
  };

  async function* gen(): AsyncGenerator<EngineMessage> {
    yield { type: 'system', subtype: 'init', session_id: sdkId };
    for (;;) {
      const next = queue.shift();
      if (next !== undefined) {
        yield {
          type: 'assistant',
          message: { content: [{ type: 'text', text: `Ack: ${next}` }] },
        };
        continue;
      }
      if (closed) return;
      await new Promise<void>((r) => {
        resolveNext = r;
      });
    }
  }

  const engine: EngineSession = Object.assign(gen(), {
    // Records the interrupt but leaves the generator OPEN — the turn aborts, the
    // session lives on. Teardown ends it via release(), not via interrupt.
    interrupt: async (): Promise<unknown> => {
      interruptCalls += 1;
      return undefined;
    },
    send: async (text: string): Promise<void> => {
      sentTexts.push(text);
      queue.push(text);
      wake();
    },
    onPermissionRequest: (): void => {},
    resolvePermission: (): void => {},
  });

  return {
    engine,
    sent: () => [...sentTexts],
    interruptCount: () => interruptCalls,
    release: () => {
      closed = true;
      wake();
    },
  };
}

function makeFakeEngine(): { query: QueryFn; spawns: FakeSpawn[] } {
  const spawns: FakeSpawn[] = [];
  let counter = 0;
  const query: QueryFn = (params) => {
    counter += 1;
    const { engine, sent, interruptCount, release } = makeSteerableSession(`sdk-${counter}`);
    spawns.push({ params, sent, interruptCount, release });
    return engine;
  };
  return { query, spawns };
}

// ---------------------------------------------------------------------------
// In-test WS client — collects every typed frame; generic predicate waiter.
// ---------------------------------------------------------------------------

interface Waiter {
  readonly predicate: (frame: AnyFrame) => boolean;
  readonly resolve: (frame: AnyFrame) => void;
  readonly reject: (err: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface TestClient {
  readonly send: (message: unknown) => void;
  readonly waitForFrame: (
    predicate: (frame: AnyFrame) => boolean,
    timeoutMs: number,
    label: string,
  ) => Promise<AnyFrame>;
  readonly transcriptFrames: (sessionId: string) => TranscriptFrame[];
  readonly sessionStateFrames: () => SessionStateFrame[];
  readonly close: () => void;
}

function openClient(url: string, openTimeoutMs = 3000): Promise<TestClient> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    let waiters: Waiter[] = [];
    const seen: AnyFrame[] = [];
    let opened = false;

    const openTimer = setTimeout(() => {
      if (!opened) {
        socket.removeAllListeners();
        socket.close();
        reject(new Error(`Timed out after ${openTimeoutMs}ms waiting for ws 'open'`));
      }
    }, openTimeoutMs);

    socket.on('error', (err) => {
      const error = err instanceof Error ? err : new Error(String(err));
      if (!opened) {
        clearTimeout(openTimer);
        reject(error);
        return;
      }
      const pending = waiters;
      waiters = [];
      for (const waiter of pending) {
        clearTimeout(waiter.timer);
        waiter.reject(error);
      }
    });

    socket.on('message', (data) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (!isAnyFrame(parsed)) return;
      seen.push(parsed);
      const stillWaiting: Waiter[] = [];
      for (const waiter of waiters) {
        if (waiter.predicate(parsed)) {
          clearTimeout(waiter.timer);
          waiter.resolve(parsed);
        } else {
          stillWaiting.push(waiter);
        }
      }
      waiters = stillWaiting;
    });

    socket.on('open', () => {
      opened = true;
      clearTimeout(openTimer);
      resolve({
        send: (message) => socket.send(JSON.stringify(message)),
        waitForFrame: (predicate, timeoutMs, label) =>
          new Promise<AnyFrame>((res, rej) => {
            const existing = seen.find(predicate);
            if (existing) {
              res(existing);
              return;
            }
            const timer = setTimeout(() => {
              waiters = waiters.filter((w) => w.timer !== timer);
              rej(new Error(`Timed out after ${timeoutMs}ms waiting for ${label}`));
            }, timeoutMs);
            waiters.push({ predicate, resolve: res, reject: rej, timer });
          }),
        transcriptFrames: (sessionId) =>
          seen.filter(isTranscriptFrame).filter((f) => f.sessionId === sessionId),
        sessionStateFrames: () => seen.filter(isSessionStateFrame),
        close: () => {
          socket.removeAllListeners();
          socket.close();
        },
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Predicate + assertion helpers.
// ---------------------------------------------------------------------------

function sessionRunning(role: string): (frame: AnyFrame) => boolean {
  return (f) =>
    isSessionStateFrame(f) && f.session.role === role && f.session.status === 'running';
}

function sessionEnded(id: string): (frame: AnyFrame) => boolean {
  return (f) => isSessionStateFrame(f) && f.session.id === id && f.session.status === 'ended';
}

function transcriptWithKind(sessionId: string, kind: string): (frame: AnyFrame) => boolean {
  return (f) =>
    isTranscriptFrame(f) && f.sessionId === sessionId && f.events.some((e) => e.kind === kind);
}

function gitStateFor(path: string): (frame: AnyFrame) => boolean {
  return (f) => f.type === 'git-state' && f['path'] === path;
}

/** All transcript events a client has received for one session, flattened in order. */
function allEvents(client: TestClient, sessionId: string): TranscriptEventWire[] {
  return client.transcriptFrames(sessionId).flatMap((f) => [...f.events]);
}

// ---------------------------------------------------------------------------
// Server + fixture lifecycle (mirrors transcript.test.ts).
// ---------------------------------------------------------------------------

const activeClients: TestClient[] = [];
const activeStops: Array<() => Promise<void>> = [];
const tmpDbPaths: string[] = [];
const tmpDirs: string[] = [];

function makeTmpDbPath(): string {
  const path = join(tmpdir(), `devos-steer-${randomUUID()}.db`);
  tmpDbPaths.push(path);
  return path;
}

// A REAL project dir under tmpdir — the spawn containment guard requires the cwd to
// realpath-resolve within a configured project root (projectRoots = [tmpdir()]).
function makeProjectDir(): string {
  const path = join(tmpdir(), `devos-proj-${randomUUID()}`);
  mkdirSync(path, { recursive: true });
  tmpDirs.push(path);
  return path;
}

interface RunningServer {
  readonly instance: import('../../src/index.js').DevOsServer;
  readonly url: string;
  readonly stop: () => Promise<void>;
}

async function startServer(dbPath: string, query: QueryFn): Promise<RunningServer> {
  const instance = createServer({ port: 0, dbPath, projectRoots: [tmpdir()], query });
  const address = (await instance.start()) as AddressInfo;
  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    await instance.stop();
  };
  activeStops.push(stop);
  return { instance, url: `ws://127.0.0.1:${address.port}${WS_PATH}`, stop };
}

async function connect(url: string): Promise<TestClient> {
  const client = await openClient(url);
  activeClients.push(client);
  return client;
}

/** Spawn one session and wait for its `running` session-state frame. */
async function spawnSession(client: TestClient, project: string, role: string): Promise<string> {
  const framePromise = client.waitForFrame(sessionRunning(role), 5000, `${role} running`);
  client.send({ type: 'session-spawn', path: project, role });
  const frame = (await framePromise) as SessionStateFrame;
  return frame.session.id;
}

afterEach(async () => {
  for (const client of activeClients.splice(0)) client.close();
  for (const stop of activeStops.splice(0)) await stop().catch(() => undefined);
  for (const path of tmpDbPaths.splice(0)) {
    for (const suffix of ['', '-wal', '-shm']) {
      rmSync(`${path}${suffix}`, { force: true });
    }
  }
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The gate.
// ---------------------------------------------------------------------------

describe('steer + interrupt over the live WS transport', () => {
  it('AC1+AC2 — steer echoes user-text + drives an assistant reply, then interrupt fires without ending the session', async () => {
    const project = makeProjectDir();
    const engine = makeFakeEngine();
    const server = await startServer(makeTmpDbPath(), engine.query);
    server.instance.registry.pin(project);

    const client = await connect(server.url);
    const sessionId = await spawnSession(client, project, 'builder');

    // AC1 — steer: the typed message is echoed as a user-text event AND drives an
    // assistant `Ack:` reply that streams back on the existing session-transcript frame.
    const steerText = 'refactor the parser';
    client.send({ type: 'session-input', sessionId, text: steerText });
    await client.waitForFrame(transcriptWithKind(sessionId, 'assistant-text'), 5000, 'assistant ack');

    const events = allEvents(client, sessionId);
    const echo = events.find((e) => e.kind === 'user-text');
    expect(echo?.['text']).toBe(steerText);
    const ack = events.find((e) => e.kind === 'assistant-text');
    expect(String(ack?.['text'])).toBe(`Ack: ${steerText}`);
    // The human echo is ordered before the assistant reply.
    expect((echo?.seq ?? 0)).toBeLessThan(ack?.seq ?? 0);
    // The full text reached the engine's live input stream.
    expect(engine.spawns[0]?.sent()).toEqual([steerText]);

    // AC2 — interrupt: the engine's interrupt() fires and the session STAYS running.
    client.send({ type: 'session-interrupt', sessionId });
    // Fence: a git-state round-trip guarantees the (async) interrupt was processed.
    client.send({ type: 'git-state', path: project });
    await client.waitForFrame(gitStateFor(project), 5000, 'git-state fence');

    expect(engine.spawns[0]?.interruptCount()).toBe(1);
    // The manager still lists the session as running — it was NOT terminated.
    const live = server.instance.sessionManager.list();
    expect(live.some((s) => s.id === sessionId && s.status === 'running')).toBe(true);
    // No ended/errored state frame was ever emitted for this session.
    const statuses = client
      .sessionStateFrames()
      .filter((f) => f.session.id === sessionId)
      .map((f) => f.session.status);
    expect(statuses).not.toContain('ended');
    expect(statuses).not.toContain('errored');

    // Teardown: release the session and let it end cleanly before the server stops.
    engine.spawns[0]?.release();
    await client.waitForFrame(sessionEnded(sessionId), 5000, 'session ended');
  }, 15000);

  it('AC3 — steer/interrupt for an unknown session are silent no-ops (fail closed)', async () => {
    // NOTE: the sibling fail-closed case (a KNOWN session whose project is not pinned)
    // is proven at the gateway unit layer — server/src/ws-gateway.test.ts, "is a no-op
    // when the owning path is not pinned (fails closed) — steer and interrupt". It can't
    // be reconstructed here because a live session holds a FOREIGN KEY on its project row,
    // so the project can't be unpinned while the session lives. This gate covers the
    // unknown-session path over the real transport.
    const project = makeProjectDir();
    const engine = makeFakeEngine();
    const server = await startServer(makeTmpDbPath(), engine.query);
    server.instance.registry.pin(project);

    const client = await connect(server.url);
    const sessionId = await spawnSession(client, project, 'builder');

    // Unknown session — neither frame has any effect.
    client.send({ type: 'session-input', sessionId: 'does-not-exist', text: 'nope' });
    client.send({ type: 'session-interrupt', sessionId: 'does-not-exist' });

    // Fence: once the git-state reply arrives, every earlier same-socket frame has been
    // fully processed by the gateway.
    client.send({ type: 'git-state', path: project });
    await client.waitForFrame(gitStateFor(project), 5000, 'git-state fence');

    // The engine saw NO steer and NO interrupt — both frames failed closed.
    expect(engine.spawns[0]?.sent()).toEqual([]);
    expect(engine.spawns[0]?.interruptCount()).toBe(0);
    // No user-text echo was ever emitted for the live session (only its own init).
    const userTextEvents = allEvents(client, sessionId).filter((e) => e.kind === 'user-text');
    expect(userTextEvents).toEqual([]);

    // Teardown: release the session and wait for the manager to drop it.
    engine.spawns[0]?.release();
    await client.waitForFrame(sessionEnded(sessionId), 5000, 'session ended');
  }, 15000);
});
