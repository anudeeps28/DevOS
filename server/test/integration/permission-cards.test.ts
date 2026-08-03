// Integration test (THE GATE) — permission cards over the live WS transport.
//
// Boots the REAL server in-process (createServer({port:0,…})) with an INJECTED FAKE
// `query` engine (never live Claude) whose fake EngineSession wires the REAL
// `createPermissionBroker` (session-engine.ts) so the manager's real
// `onPermissionRequest` subscription fires exactly as it does with the live SDK.
// Cloned from steer-interrupt.test.ts's harness (server boot, tmp DB, tmp project
// pinning, real `ws` client, frame-waiting helpers) — adapted from steer/interrupt
// frames to permission-request/permission-decision frames (story 6h6hMVH97RxgPmPg):
//   AC1 — triggering the broker's `canUseTool` parks a Promise AND broadcasts a
//         `permission-request` frame carrying {sessionId, requestId, toolName, input}
//         while the Promise stays PENDING. (The sibling fail-closed case — a KNOWN
//         session owned by an UNPINNED project — can't be reconstructed at this layer;
//         see the in-test note, mirroring steer-interrupt.test.ts's AC3 note.)
//   AC2 — a `permission-decision {sessionId, requestId, decision}` frame resolves the
//         parked Promise (`allow` → `{behavior:'allow'}`, `deny` →
//         `{behavior:'deny', message:<string>}`) AND a `permission` audit transcript
//         frame is observed on the wire; the session stays running either way (the
//         turn is never aborted).
//   AC3 — covered by the T7 unit regression on `buildSessionOptions` (session-engine
//         unit tests) — not re-asserted here.
//   AC4 — a `permission-decision` for an UNKNOWN session id is a silent no-op (the
//         parked Promise stays pending; no crash). On teardown (`server.stop()` →
//         `sessionManager.stopAll()`) a still-parked request resolves to a fail-closed
//         deny.
//
// The fake engine's `EngineSession` wraps the REAL `PermissionBroker`: `canUseTool` is
// exposed directly to the test so it can trigger + observe pending/resolved state.
// `interrupt()` ends the fake session's generator (mirroring `defaultQuery`'s
// `q.interrupt()` closing the stream), whose `finally` calls `broker.denyAll()` — the
// same fail-closed teardown path the real engine exercises. Isolation: per-test tmp DB
// + real tmp project dirs (projectRoots=[tmpdir()]); afterEach stops the server +
// removes DB sidecars and fixture dirs. NO live Claude.

import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import { createServer } from '../../src/index.js';
import { WS_PATH } from '../../src/config.js';
import {
  createPermissionBroker,
  type EngineMessage,
  type EngineSession,
  type PermissionBroker,
  type QueryFn,
  type SpawnParams,
} from '../../src/session/session-engine.js';

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

interface PermissionRequestFrame extends AnyFrame {
  readonly type: 'permission-request';
  readonly path: string;
  readonly sessionId: string;
  readonly requestId: string;
  readonly toolUseId: string | null;
  readonly toolName: string;
  readonly title: string | null;
  readonly input: string;
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

function isPermissionRequestFrame(frame: AnyFrame): frame is PermissionRequestFrame {
  return (
    frame.type === 'permission-request' &&
    typeof frame['path'] === 'string' &&
    typeof frame['sessionId'] === 'string' &&
    typeof frame['requestId'] === 'string' &&
    typeof frame['toolName'] === 'string'
  );
}

// ---------------------------------------------------------------------------
// Fake engine — wraps the REAL permission broker; holds open until released.
// ---------------------------------------------------------------------------

interface FakeSpawn {
  readonly params: SpawnParams;
  /** The REAL broker wired into this session — trigger/observe `canUseTool` directly. */
  readonly broker: PermissionBroker;
  /** End the generator (mirrors the real engine's `interrupt()` closing the stream). */
  readonly release: () => void;
}

/**
 * A session that yields `system/init` then holds open. Its `EngineSession` wraps the
 * REAL `createPermissionBroker()` — `onPermissionRequest`/`resolvePermission` delegate
 * to it, exactly like `defaultQuery`. `interrupt()`/`release()` end the generator; the
 * wrapper's `finally` calls `broker.denyAll()`, mirroring `withInputClose` in
 * session-engine.ts (fail-closed teardown for any still-parked request).
 */
function makePermissionSession(sdkId: string): {
  engine: EngineSession;
  broker: PermissionBroker;
  release: () => void;
} {
  const broker = createPermissionBroker();
  let unpark: (() => void) | null = null;
  let released = false;

  const wake = (): void => {
    if (unpark !== null) {
      const r = unpark;
      unpark = null;
      r();
    }
  };

  async function* inner(): AsyncGenerator<EngineMessage> {
    yield { type: 'system', subtype: 'init', session_id: sdkId };
    if (released) return;
    await new Promise<void>((resolve) => {
      unpark = resolve;
    });
  }

  async function* wrapped(): AsyncGenerator<EngineMessage> {
    try {
      yield* inner();
    } finally {
      broker.denyAll();
    }
  }

  const release = (): void => {
    released = true;
    wake();
  };

  const engine: EngineSession = Object.assign(wrapped(), {
    interrupt: async (): Promise<unknown> => {
      release();
      return undefined;
    },
    send: async (): Promise<void> => {},
    onPermissionRequest: (listener) => broker.onRequest(listener),
    resolvePermission: (requestId, decision) => broker.resolve(requestId, decision),
    onQuestionRequest: (): void => {},
    answerQuestion: (): void => {},
    end: (): void => release(),
  } satisfies Pick<
    EngineSession,
    'interrupt' | 'send' | 'onPermissionRequest' | 'resolvePermission' | 'onQuestionRequest' | 'answerQuestion' | 'end'
  >);

  return { engine, broker, release };
}

function makeFakeEngine(): { query: QueryFn; spawns: FakeSpawn[] } {
  const spawns: FakeSpawn[] = [];
  let counter = 0;
  const query: QueryFn = (params) => {
    counter += 1;
    const { engine, broker, release } = makePermissionSession(`sdk-${counter}`);
    spawns.push({ params, broker, release });
    return engine;
  };
  return { query, spawns };
}

/** Trigger the REAL broker's `canUseTool` and expose the parked Promise + its pending state. */
function parkPermission(
  broker: PermissionBroker,
  toolName: string,
  input: Record<string, unknown>,
  requestId: string,
): { readonly promise: Promise<PermissionResult | null>; readonly isPending: () => boolean } {
  let pending = true;
  const controller = new AbortController();
  const promise = broker.canUseTool(toolName, input, {
    signal: controller.signal,
    toolUseID: `tu-${requestId}`,
    requestId,
  });
  void promise.finally(() => {
    pending = false;
  });
  return { promise, isPending: () => pending };
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
  readonly permissionRequestFrames: () => PermissionRequestFrame[];
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
        permissionRequestFrames: () => seen.filter(isPermissionRequestFrame),
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

function permissionRequestFor(sessionId: string, requestId: string): (frame: AnyFrame) => boolean {
  return (f) =>
    isPermissionRequestFrame(f) && f.sessionId === sessionId && f.requestId === requestId;
}

function transcriptWithPermissionDecision(
  sessionId: string,
  requestId: string,
): (frame: AnyFrame) => boolean {
  return (f) =>
    isTranscriptFrame(f) &&
    f.sessionId === sessionId &&
    f.events.some((e) => e.kind === 'permission' && e['requestId'] === requestId);
}

function gitStateFor(path: string): (frame: AnyFrame) => boolean {
  return (f) => f.type === 'git-state' && f['path'] === path;
}

/** All transcript events a client has received for one session, flattened in order. */
function allEvents(client: TestClient, sessionId: string): TranscriptEventWire[] {
  return client.transcriptFrames(sessionId).flatMap((f) => [...f.events]);
}

// ---------------------------------------------------------------------------
// Server + fixture lifecycle (mirrors steer-interrupt.test.ts).
// ---------------------------------------------------------------------------

const activeClients: TestClient[] = [];
const activeStops: Array<() => Promise<void>> = [];
const tmpDbPaths: string[] = [];
const tmpDirs: string[] = [];

function makeTmpDbPath(): string {
  const path = join(tmpdir(), `devos-permcards-${randomUUID()}.db`);
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

describe('permission cards over the live WS transport', () => {
  it('AC1 — canUseTool parks a Promise + broadcasts a permission-request frame carrying {sessionId, requestId, toolName, input}', async () => {
    const project = makeProjectDir();
    const engine = makeFakeEngine();
    const server = await startServer(makeTmpDbPath(), engine.query);
    server.instance.registry.pin(project);

    const client = await connect(server.url);
    const sessionId = await spawnSession(client, project, 'builder');
    const broker = engine.spawns[0]?.broker;
    if (broker === undefined) throw new Error('expected a spawned session broker');

    const requestId = 'req-ac1';
    const park = parkPermission(broker, 'Bash', { command: 'ls -la' }, requestId);

    const frame = (await client.waitForFrame(
      permissionRequestFor(sessionId, requestId),
      5000,
      'permission-request frame',
    )) as PermissionRequestFrame;
    expect(frame.sessionId).toBe(sessionId);
    expect(frame.requestId).toBe(requestId);
    expect(frame.toolName).toBe('Bash');
    expect(typeof frame.input).toBe('string');
    // The engine's canUseTool Promise is still parked — no decision has been made.
    expect(park.isPending()).toBe(true);

    // NOTE: the sibling fail-closed case (a KNOWN session whose project is not
    // pinned) is proven at the gateway unit layer — see ws-gateway.test.ts
    // 'ws-gateway permission routing' > 'is a no-op when the owning path is not
    // pinned (fails closed)' and 'broadcasts nothing for a permission-request whose
    // path is not pinned (fails closed)'. It can't be reconstructed here: `sessions.
    // project_path` carries a FOREIGN KEY on `projects(path)` that is never released
    // (rows persist for history even after a session ends), so once a project has ever
    // hosted a session it can never be unpinned again for the life of the DB. AC4 below
    // covers the reachable fail-closed path at this layer — an UNKNOWN session id.

    // Teardown: resolve the request and release the session cleanly.
    broker.resolve(requestId, 'allow');
    await park.promise;
    engine.spawns[0]?.release();
    await client.waitForFrame(sessionEnded(sessionId), 5000, 'session ended');
  }, 15000);

  it('AC2 — permission-decision resolves the parked Promise + emits a permission audit frame; the session stays running', async () => {
    const project = makeProjectDir();
    const engine = makeFakeEngine();
    const server = await startServer(makeTmpDbPath(), engine.query);
    server.instance.registry.pin(project);

    const client = await connect(server.url);
    const sessionId = await spawnSession(client, project, 'builder');
    const broker = engine.spawns[0]?.broker;
    if (broker === undefined) throw new Error('expected a spawned session broker');

    // allow
    const allowRequestId = 'req-allow';
    const allowPark = parkPermission(broker, 'Read', { path: 'a.txt' }, allowRequestId);
    await client.waitForFrame(
      permissionRequestFor(sessionId, allowRequestId),
      5000,
      'permission-request (allow)',
    );
    client.send({ type: 'permission-decision', sessionId, requestId: allowRequestId, decision: 'allow' });
    await client.waitForFrame(
      transcriptWithPermissionDecision(sessionId, allowRequestId),
      5000,
      'permission audit (allow)',
    );
    expect(await allowPark.promise).toEqual({ behavior: 'allow' });
    const allowAudit = allEvents(client, sessionId).find(
      (e) => e.kind === 'permission' && e['requestId'] === allowRequestId,
    );
    expect(allowAudit?.['decision']).toBe('allow');

    // deny
    const denyRequestId = 'req-deny';
    const denyPark = parkPermission(broker, 'Bash', { command: 'rm -rf /' }, denyRequestId);
    await client.waitForFrame(
      permissionRequestFor(sessionId, denyRequestId),
      5000,
      'permission-request (deny)',
    );
    client.send({ type: 'permission-decision', sessionId, requestId: denyRequestId, decision: 'deny' });
    await client.waitForFrame(
      transcriptWithPermissionDecision(sessionId, denyRequestId),
      5000,
      'permission audit (deny)',
    );
    const denyResult = await denyPark.promise;
    expect(denyResult).toMatchObject({ behavior: 'deny' });
    expect(typeof (denyResult as { message?: unknown } | null)?.message).toBe('string');
    const denyAudit = allEvents(client, sessionId).find(
      (e) => e.kind === 'permission' && e['requestId'] === denyRequestId,
    );
    expect(denyAudit?.['decision']).toBe('deny');

    // Neither decision aborted the session — it stays running throughout.
    const live = server.instance.sessionManager.list();
    expect(live.some((s) => s.id === sessionId && s.status === 'running')).toBe(true);
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

  it('AC4 — a permission-decision for an unknown session is a silent no-op; teardown fail-closes any still-parked request', async () => {
    // NOTE: the sibling fail-closed case (a KNOWN session whose project is not
    // pinned) can't be reconstructed at this layer — see the note in the AC1 test
    // above (FOREIGN KEY on `projects(path)` never releases once a session has ever
    // been spawned for that path). This test covers the reachable no-op path: an
    // UNKNOWN session id.
    const project = makeProjectDir();
    const engine = makeFakeEngine();
    const server = await startServer(makeTmpDbPath(), engine.query);
    server.instance.registry.pin(project);

    const client = await connect(server.url);
    const sessionId = await spawnSession(client, project, 'builder');
    const broker = engine.spawns[0]?.broker;
    if (broker === undefined) throw new Error('expected a spawned session broker');

    const requestId = 'req-noop';
    const park = parkPermission(broker, 'Bash', { command: 'ls' }, requestId);
    await client.waitForFrame(permissionRequestFor(sessionId, requestId), 5000, 'permission-request');

    // Unknown session id — silent no-op.
    client.send({ type: 'permission-decision', sessionId: 'does-not-exist', requestId, decision: 'allow' });

    // Fence: once the git-state reply arrives, every earlier same-socket frame has
    // been fully processed by the gateway.
    client.send({ type: 'git-state', path: project });
    await client.waitForFrame(gitStateFor(project), 5000, 'git-state fence');

    // The decision failed closed — the Promise never settled.
    expect(park.isPending()).toBe(true);

    // Teardown fail-closed: `server.stop()` → `sessionManager.stopAll()` interrupts
    // every live session, ending its generator — the broker's `denyAll()` fires for
    // any still-parked request (mirrors the real engine's `withInputClose` teardown).
    await server.stop();
    expect(await park.promise).toEqual({ behavior: 'deny', message: 'session ended' });
  }, 15000);
});
