// Integration test (THE GATE) — session spawn + multiplex over the live WS transport.
//
// Boots the REAL server in-process (createServer({port:0,…})) with an INJECTED FAKE
// `query` engine (never live Claude), pins a project, opens a real `ws` client, sends
// `{type:'session-spawn', path, role}`, and asserts the observable contract:
//   AC1 — Spawn: the engine is called with { cwd: projectRoot, role }; a
//         `session-state` frame reports the session `running` with that role.
//   AC2 — Multiplex: two spawns → two distinct running sessions, concurrently live.
//   AC4 — Access control + robustness: an UNPINNED-path spawn yields no frame and the
//         gateway stays up for a valid spawn; a fake generator that throws marks only
//         that session errored while a sibling stays running.
//
// The fake engine's throw behavior is opt-in per test via `throwsForRole` (AC4
// isolation uses 'reviewer'); by default no role throws, so it yields init then
// stays open until interrupt.
// Isolation: per-test tmp DB + real tmp project dirs (projectRoots=[tmpdir()] so the
// spawn containment guard passes); afterEach stops the server + removes the DB
// sidecars and fixture dirs. NO live Claude.

import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { createServer } from '../../src/index.js';
import { WS_PATH } from '../../src/config.js';
import type {
  EngineMessage,
  EngineSession,
  QueryFn,
  SpawnParams,
} from '../../src/session/session-engine.js';

interface SessionStateFrame {
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

function isSessionStateFrame(value: unknown): value is SessionStateFrame {
  if (typeof value !== 'object' || value === null) return false;
  const frame = value as Record<string, unknown>;
  return (
    frame.type === 'session-state' &&
    typeof frame.path === 'string' &&
    typeof frame.session === 'object' &&
    frame.session !== null
  );
}

// A self-driving fake session: yields a `system/init` (with a unique sdk id) on the
// first iteration, then either throws (AC4) or stays open until interrupt().
function makeFakeSession(sdkId: string, throwAfterInit: boolean): EngineSession {
  let resolveOpen: (() => void) | null = null;
  const openWait = new Promise<void>((r) => {
    resolveOpen = r;
  });

  async function* gen(): AsyncGenerator<EngineMessage> {
    yield { type: 'system', subtype: 'init', session_id: sdkId };
    if (throwAfterInit) throw new Error('fake engine failure');
    await openWait; // stay open (long-lived) until interrupt closes it
  }

  return Object.assign(gen(), {
    interrupt: async (): Promise<unknown> => {
      resolveOpen?.();
      return undefined;
    },
    send: async (): Promise<void> => {},
    onPermissionRequest: (): void => {},
    resolvePermission: (): void => {},
    end: (): void => {
      resolveOpen?.();
    },
  });
}

// `throwsForRole` lets a test opt a specific role INTO the fake-failure path
// (AC4 isolation); by default no role throws, so concurrent spawns of different
// roles (AC2) both stay open.
function makeFakeEngine(throwsForRole?: string): { query: QueryFn; calls: SpawnParams[] } {
  const calls: SpawnParams[] = [];
  let counter = 0;
  const query: QueryFn = (params) => {
    calls.push(params);
    counter += 1;
    return makeFakeSession(`sdk-${counter}`, params.role === throwsForRole);
  };
  return { query, calls };
}

interface Waiter {
  readonly predicate: (frame: SessionStateFrame) => boolean;
  readonly resolve: (frame: SessionStateFrame) => void;
  readonly reject: (err: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface TestClient {
  readonly send: (message: unknown) => void;
  readonly waitForSessionState: (
    predicate: (frame: SessionStateFrame) => boolean,
    timeoutMs: number,
  ) => Promise<SessionStateFrame>;
  readonly seen: () => SessionStateFrame[];
  readonly close: () => void;
}

function openClient(url: string, openTimeoutMs = 3000): Promise<TestClient> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    let waiters: Waiter[] = [];
    const seen: SessionStateFrame[] = [];
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
      if (!isSessionStateFrame(parsed)) return;
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
        waitForSessionState: (predicate, timeoutMs) =>
          new Promise<SessionStateFrame>((res, rej) => {
            const existing = seen.find(predicate);
            if (existing) {
              res(existing);
              return;
            }
            const timer = setTimeout(() => {
              waiters = waiters.filter((w) => w.timer !== timer);
              rej(new Error(`Timed out after ${timeoutMs}ms waiting for a session-state frame`));
            }, timeoutMs);
            waiters.push({ predicate, resolve: res, reject: rej, timer });
          }),
        seen: () => [...seen],
        close: () => {
          socket.removeAllListeners();
          socket.close();
        },
      });
    });
  });
}

const activeClients: TestClient[] = [];
const activeStops: Array<() => Promise<void>> = [];
const tmpDbPaths: string[] = [];
const tmpDirs: string[] = [];

function makeTmpDbPath(): string {
  const path = join(tmpdir(), `devos-sessionmgr-${randomUUID()}.db`);
  tmpDbPaths.push(path);
  return path;
}

// A REAL project dir under tmpdir — spawn now requires the cwd to realpath-resolve
// within a configured project root (the security containment guard), so the fixture
// must exist on disk and the server is started with projectRoots = [tmpdir()].
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
  // projectRoots = [tmpdir()] so the real tmp project fixtures pass the spawn
  // containment guard (a spawn cwd must resolve within a configured project root).
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

describe('session spawn + multiplex over the live WS transport', () => {
  it('AC1 — a spawn starts the engine with cwd+role and reports running', async () => {
    const project = makeProjectDir();
    const engine = makeFakeEngine();
    const server = await startServer(makeTmpDbPath(), engine.query);
    server.instance.registry.pin(project);

    const client = await connect(server.url);
    const framePromise = client.waitForSessionState(
      (f) => f.path === project && f.session.status === 'running',
      5000,
    );
    client.send({ type: 'session-spawn', path: project, role: 'builder' });
    const frame = await framePromise;

    // Engine invoked with cwd = project root and the requested role.
    expect(engine.calls).toHaveLength(1);
    expect(engine.calls[0]?.cwd).toBe(project);
    expect(engine.calls[0]?.role).toBe('builder');

    // The frame reports a running session carrying the role for this project.
    expect(frame.session.status).toBe('running');
    expect(frame.session.role).toBe('builder');
    expect(frame.session.projectPath).toBe(project);
    expect(frame.session.id.length).toBeGreaterThan(0);

    // The manager lists it as a live running session.
    const live = server.instance.sessionManager.list();
    expect(live).toHaveLength(1);
    expect(live[0]?.role).toBe('builder');
    expect(live[0]?.status).toBe('running');
  }, 15000);

  it('AC2 — two spawns run concurrently as distinct live sessions', async () => {
    const project = makeProjectDir();
    const engine = makeFakeEngine();
    const server = await startServer(makeTmpDbPath(), engine.query);
    server.instance.registry.pin(project);

    const client = await connect(server.url);
    const first = client.waitForSessionState(
      (f) => f.session.role === 'builder' && f.session.status === 'running',
      5000,
    );
    const second = client.waitForSessionState(
      (f) => f.session.role === 'reviewer' && f.session.status === 'running',
      5000,
    );
    client.send({ type: 'session-spawn', path: project, role: 'builder' });
    client.send({ type: 'session-spawn', path: project, role: 'reviewer' });

    const [a, b] = await Promise.all([first, second]);
    expect(a.session.id).not.toBe(b.session.id);

    const live = server.instance.sessionManager.list();
    expect(live).toHaveLength(2);
    expect(live.every((s) => s.status === 'running')).toBe(true);
    expect(new Set(live.map((s) => s.id)).size).toBe(2);
  }, 15000);

  it('AC4 — an unpinned-path spawn is dropped; the gateway stays up', async () => {
    const pinned = makeProjectDir();
    const foreign = join(tmpdir(), `devos-foreign-${randomUUID()}`);
    const engine = makeFakeEngine();
    const server = await startServer(makeTmpDbPath(), engine.query);
    server.instance.registry.pin(pinned); // only `pinned` is allowlisted

    const client = await connect(server.url);

    // Spawn on the FOREIGN (unpinned) path — must be dropped, no engine call.
    client.send({ type: 'session-spawn', path: foreign, role: 'builder' });
    // Give the server a beat, then confirm a valid spawn on the pinned path works.
    const valid = client.waitForSessionState(
      (f) => f.path === pinned && f.session.status === 'running',
      5000,
    );
    client.send({ type: 'session-spawn', path: pinned, role: 'builder' });
    await valid;

    // The foreign spawn never reached the engine — only the pinned one did.
    expect(engine.calls).toHaveLength(1);
    expect(engine.calls[0]?.cwd).toBe(pinned);
    expect(server.instance.sessionManager.list().every((s) => s.projectPath === pinned)).toBe(true);
  }, 15000);

  it('AC4 — one session throwing is isolated; a sibling stays running', async () => {
    const project = makeProjectDir();
    const engine = makeFakeEngine('reviewer');
    const server = await startServer(makeTmpDbPath(), engine.query);
    server.instance.registry.pin(project);

    const client = await connect(server.url);
    // 'reviewer' throws after init; 'builder' stays open.
    const goodRunning = client.waitForSessionState(
      (f) => f.session.role === 'builder' && f.session.status === 'running',
      5000,
    );
    const badErrored = client.waitForSessionState(
      (f) => f.session.role === 'reviewer' && f.session.status === 'errored',
      5000,
    );
    client.send({ type: 'session-spawn', path: project, role: 'builder' });
    client.send({ type: 'session-spawn', path: project, role: 'reviewer' });

    await Promise.all([goodRunning, badErrored]);

    // The errored session is gone from the live map; the sibling is still running.
    const live = server.instance.sessionManager.list();
    expect(live.some((s) => s.role === 'builder' && s.status === 'running')).toBe(true);
    expect(live.some((s) => s.role === 'reviewer')).toBe(false);
  }, 15000);
});
