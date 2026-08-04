// Integration test — kick-off-next-stage WS round-trip (ARCHITECTURE §9.3).
//
// Boots the REAL server in-process (createServer({port:0,…})) with an INJECTED FAKE
// `query` engine (never live Claude) recording SpawnParams into calls[], pins a
// project, opens a real `ws` client, sends `{type:'kick-off-next-stage', path, stage}`,
// and asserts the observable contract:
//   AC1 — Decide: one recorded spawn with cwd = project root, role = 'builder',
//         prompt = '/architect'; a `session-state` frame reports the session running.
//   AC4 — Access control + no extra write: exactly one spawn recorded for the valid
//         Decide send (only the session anchor is written — no project-level stage
//         write from this test's perspective, which only observes the WS surface).
//   AC2 (fail-closed) — an UNPINNED path yields no spawn and no session-state frame;
//         a path OUTSIDE projectRoots (pinned but not under the configured root) also
//         yields no spawn; the gateway stays up — a subsequent valid Decide still spawns.
//   AC3 — Build: yields NO spawn (kickoffPromptForStage('Build') === null).
// Isolation: per-test tmp DB + real tmp project dirs; afterEach stops the server +
// removes the DB sidecars and fixture dirs. NO live Claude.

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
// first iteration, then stays open until interrupt() (never throws for this suite —
// no error-path assertions here).
function makeFakeSession(sdkId: string): EngineSession {
  let resolveOpen: (() => void) | null = null;
  const openWait = new Promise<void>((r) => {
    resolveOpen = r;
  });

  async function* gen(): AsyncGenerator<EngineMessage> {
    yield { type: 'system', subtype: 'init', session_id: sdkId };
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
    onQuestionRequest: (): void => {},
    answerQuestion: (): void => {},
    end: (): void => {
      resolveOpen?.();
    },
  });
}

function makeFakeEngine(): { query: QueryFn; calls: SpawnParams[] } {
  const calls: SpawnParams[] = [];
  let counter = 0;
  const query: QueryFn = (params) => {
    calls.push(params);
    counter += 1;
    return makeFakeSession(`sdk-${counter}`);
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
  const path = join(tmpdir(), `devos-kickoff-${randomUUID()}.db`);
  tmpDbPaths.push(path);
  return path;
}

// A REAL project dir under tmpdir — spawn requires the cwd to realpath-resolve
// within a configured project root (the security containment guard), so the fixture
// must exist on disk and the server is started with projectRoots = [tmpdir()].
function makeProjectDir(): string {
  const path = join(tmpdir(), `devos-kickoff-proj-${randomUUID()}`);
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

describe('kick-off-next-stage WS round-trip', () => {
  it('AC1/AC4 — Decide spawns exactly one builder session with the /architect prompt', async () => {
    const project = makeProjectDir();
    const engine = makeFakeEngine();
    const server = await startServer(makeTmpDbPath(), engine.query);
    server.instance.registry.pin(project);

    const client = await connect(server.url);
    const framePromise = client.waitForSessionState(
      (f) => f.path === project && f.session.status === 'running',
      5000,
    );
    client.send({ type: 'kick-off-next-stage', path: project, stage: 'Decide' });
    const frame = await framePromise;

    // Exactly one spawn — the session anchor only, no extra write.
    expect(engine.calls).toHaveLength(1);
    expect(engine.calls[0]?.cwd).toBe(project);
    expect(engine.calls[0]?.role).toBe('builder');
    expect(engine.calls[0]?.prompt).toBe('/architect');

    expect(frame.session.status).toBe('running');
    expect(frame.session.role).toBe('builder');
    expect(frame.session.projectPath).toBe(project);
  }, 15000);

  it('AC2 — fail-closed: an unpinned path yields no spawn; the gateway stays up', async () => {
    const pinned = makeProjectDir();
    const foreign = join(tmpdir(), `devos-kickoff-foreign-${randomUUID()}`);
    const engine = makeFakeEngine();
    const server = await startServer(makeTmpDbPath(), engine.query);
    server.instance.registry.pin(pinned); // only `pinned` is allowlisted

    const client = await connect(server.url);

    // Kick-off on the FOREIGN (unpinned) path — must be dropped, no engine call.
    client.send({ type: 'kick-off-next-stage', path: foreign, stage: 'Decide' });

    // Bounded wait for the (never-arriving) frame on the foreign path — proves the
    // drop, not just a race with the valid send below.
    await expect(
      client.waitForSessionState((f) => f.path === foreign, 500),
    ).rejects.toThrow();
    expect(engine.calls).toHaveLength(0);

    // A subsequent valid Decide on the pinned path still spawns — the gateway stayed up.
    const valid = client.waitForSessionState(
      (f) => f.path === pinned && f.session.status === 'running',
      5000,
    );
    client.send({ type: 'kick-off-next-stage', path: pinned, stage: 'Decide' });
    await valid;

    expect(engine.calls).toHaveLength(1);
    expect(engine.calls[0]?.cwd).toBe(pinned);
  }, 15000);

  it('AC2 — fail-closed: a pinned path outside project roots yields no spawn', async () => {
    // A directory that exists but is NOT under the server's configured projectRoots
    // ([tmpdir()]) — pinning accepts any absolute path, so the containment guard
    // (isWithinProjectRoots) is the only thing standing between this and a spawn.
    const outsideRoots = join(tmpdir(), '..', `devos-kickoff-outside-${randomUUID()}`);
    mkdirSync(outsideRoots, { recursive: true });
    tmpDirs.push(outsideRoots);

    const pinned = makeProjectDir();
    const engine = makeFakeEngine();
    const server = await startServer(makeTmpDbPath(), engine.query);
    server.instance.registry.pin(outsideRoots);
    server.instance.registry.pin(pinned);

    const client = await connect(server.url);

    client.send({ type: 'kick-off-next-stage', path: outsideRoots, stage: 'Decide' });
    await expect(
      client.waitForSessionState((f) => f.path === outsideRoots, 500),
    ).rejects.toThrow();
    expect(engine.calls).toHaveLength(0);

    // The gateway stayed up — a valid Decide on the properly-rooted pinned path spawns.
    const valid = client.waitForSessionState(
      (f) => f.path === pinned && f.session.status === 'running',
      5000,
    );
    client.send({ type: 'kick-off-next-stage', path: pinned, stage: 'Decide' });
    await valid;

    expect(engine.calls).toHaveLength(1);
    expect(engine.calls[0]?.cwd).toBe(pinned);
  }, 15000);

  it('AC3 — Build yields no spawn (kickoffPromptForStage returns null)', async () => {
    const project = makeProjectDir();
    const engine = makeFakeEngine();
    const server = await startServer(makeTmpDbPath(), engine.query);
    server.instance.registry.pin(project);

    const client = await connect(server.url);

    client.send({ type: 'kick-off-next-stage', path: project, stage: 'Build' });
    await expect(
      client.waitForSessionState((f) => f.path === project, 500),
    ).rejects.toThrow();
    expect(engine.calls).toHaveLength(0);
  }, 15000);
});
