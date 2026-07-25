// Integration test — lifecycle-signals read round-trip over the live WS transport.
//
// Boots the REAL server in-process on a free port (PORT=0), pins per-test tmp PROJECT
// fixtures (the read handlers now allowlist to PINNED projects — access control),
// opens a real `ws` client, sends `{type:'lifecycle-signals', path}`, awaits the
// snapshot frame, and asserts on `state.signals`:
//   AC1 — docs/SPEC.md + docs/ARCHITECTURE.md, no started story → hasDefineDocs only.
//   AC2 — a started tasks/stories/<id>/executor-state.md (Progress) → hasStartedStory;
//         two sequential reads over fresh sockets return equal signals (never cached).
//   Access control — an UNPINNED path yields NO frame (dropped by the allowlist).
//   Fan-out — two pinned fixtures bursted on ONE socket → both frames resolve.
//
// The whole-project STAGE is composed on the CLIENT from these signals + the card's
// tracker-state (see web/src/lib/lifecycle.test.ts) — the server no longer reads the
// tracker or `git status` for the lifecycle. Tmp fixtures are not git repos, so the
// git-derived signals are false here; git precision is covered in the unit test.
//
// Isolation: per-test tmp fixtures + tmp DB; afterEach removes them. No project roots.

import { promises as fs } from 'node:fs';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { createServer, type DevOsServer } from '../../src/index.js';
import { WS_PATH } from '../../src/config.js';
import type { LifecycleSignals } from '../../src/ws-protocol.js';

interface LifecycleSignalsFrame {
  readonly type: 'lifecycle-signals';
  readonly path: string;
  readonly state: { readonly path: string; readonly signals: LifecycleSignals };
}

function isLifecycleSignalsFrame(value: unknown): value is LifecycleSignalsFrame {
  if (typeof value !== 'object' || value === null) return false;
  const frame = value as Record<string, unknown>;
  return (
    frame.type === 'lifecycle-signals' &&
    typeof frame.path === 'string' &&
    typeof frame.state === 'object' &&
    frame.state !== null
  );
}

interface TestClient {
  readonly send: (message: unknown) => void;
  readonly waitForLifecycleSignals: (
    predicate: (frame: LifecycleSignalsFrame) => boolean,
    timeoutMs: number,
  ) => Promise<LifecycleSignalsFrame>;
  readonly close: () => void;
}

interface Waiter<T> {
  readonly predicate: (frame: T) => boolean;
  readonly resolve: (frame: T) => void;
  readonly reject: (err: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

function openClient(url: string, openTimeoutMs = 3000): Promise<TestClient> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    let waiters: Array<Waiter<LifecycleSignalsFrame>> = [];
    let opened = false;

    const openTimer = setTimeout(() => {
      if (!opened) {
        socket.removeAllListeners();
        socket.close();
        reject(new Error(`Timed out after ${openTimeoutMs}ms waiting for ws 'open'`));
      }
    }, openTimeoutMs);

    const failAll = (error: Error): void => {
      const pending = waiters;
      waiters = [];
      for (const waiter of pending) {
        clearTimeout(waiter.timer);
        waiter.reject(error);
      }
    };

    socket.on('error', (err) => {
      const error = err instanceof Error ? err : new Error(String(err));
      if (!opened) {
        clearTimeout(openTimer);
        reject(error);
        return;
      }
      failAll(error);
    });

    socket.on('message', (data) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(data.toString());
      } catch {
        return;
      }

      if (isLifecycleSignalsFrame(parsed)) {
        const frame = parsed;
        const stillWaiting: Array<Waiter<LifecycleSignalsFrame>> = [];
        for (const waiter of waiters) {
          if (waiter.predicate(frame)) {
            clearTimeout(waiter.timer);
            waiter.resolve(frame);
          } else {
            stillWaiting.push(waiter);
          }
        }
        waiters = stillWaiting;
        return;
      }
      // Heartbeat / registry / anything else — ignore.
    });

    socket.on('open', () => {
      opened = true;
      clearTimeout(openTimer);
      resolve({
        send: (message: unknown) => socket.send(JSON.stringify(message)),
        waitForLifecycleSignals: (predicate, timeoutMs) =>
          new Promise<LifecycleSignalsFrame>((res, rej) => {
            const timer = setTimeout(() => {
              waiters = waiters.filter((w) => w.timer !== timer);
              rej(
                new Error(
                  `Timed out after ${timeoutMs}ms waiting for a matching lifecycle-signals snapshot`,
                ),
              );
            }, timeoutMs);
            waiters.push({ predicate, resolve: res, reject: rej, timer });
          }),
        close: () => {
          socket.removeAllListeners();
          socket.close();
        },
      });
    });
  });
}

// Per-test resources, torn down in afterEach.
const activeClients: TestClient[] = [];
const activeStops: Array<() => Promise<void>> = [];
const tmpDbPaths: string[] = [];
const tmpRoots: string[] = [];

function makeTmpDbPath(): string {
  const path = join(tmpdir(), `devos-lifecyclesignals-${randomUUID()}.db`);
  tmpDbPaths.push(path);
  return path;
}

async function makeTmpRoot(prefix: string): Promise<string> {
  const root = join(tmpdir(), `devos-lifecyclesignals-${prefix}-${randomUUID()}`);
  tmpRoots.push(root);
  await fs.mkdir(root, { recursive: true });
  return root;
}

/** A fixture with SPEC + ARCHITECTURE docs and no started story → hasDefineDocs. */
async function makeDefineFixture(prefix = 'define'): Promise<string> {
  const root = await makeTmpRoot(prefix);
  const docs = join(root, 'docs');
  await fs.mkdir(docs, { recursive: true });
  await fs.writeFile(join(docs, 'SPEC.md'), '# Spec\n');
  await fs.writeFile(join(docs, 'ARCHITECTURE.md'), '# Architecture\n');
  return root;
}

/** A fixture with a started story (executor-state.md w/ Progress) → hasStartedStory. */
async function makeStartedStoryFixture(prefix = 'build'): Promise<string> {
  const root = await makeTmpRoot(prefix);
  const storyDir = join(root, 'tasks', 'stories', 'S1');
  await fs.mkdir(storyDir, { recursive: true });
  await fs.writeFile(
    join(storyDir, 'executor-state.md'),
    '# Executor State\n\n## Progress\n\n| Task | Result |\n',
  );
  return root;
}

interface RunningServer {
  readonly instance: DevOsServer;
  readonly url: string;
  readonly stop: () => Promise<void>;
}

async function startServer(dbPath: string): Promise<RunningServer> {
  const instance = createServer({ port: 0, dbPath, projectRoots: [] });
  const address: AddressInfo = await instance.start();
  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    await instance.stop();
  };
  activeStops.push(stop);
  return { instance, url: `ws://127.0.0.1:${address.port}${WS_PATH}`, stop };
}

afterEach(async () => {
  for (const client of activeClients.splice(0)) {
    client.close();
  }
  for (const stop of activeStops.splice(0)) {
    await stop().catch(() => undefined);
  }
  for (const root of tmpRoots.splice(0)) {
    await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
  for (const path of tmpDbPaths.splice(0)) {
    for (const suffix of ['', '-wal', '-shm']) {
      rmSync(`${path}${suffix}`, { force: true });
    }
  }
});

async function connect(url: string): Promise<TestClient> {
  const client = await openClient(url);
  activeClients.push(client);
  return client;
}

// Read lifecycle signals for `path` over a FRESH socket. Each new socket resets the
// per-socket flood-guard, so every read is accepted immediately — proving the server
// never memoizes (each read re-derives).
async function readSignals(url: string, path: string): Promise<LifecycleSignals> {
  const client = await connect(url);
  const framePromise = client.waitForLifecycleSignals((f) => f.path === path, 5000);
  client.send({ type: 'lifecycle-signals', path });
  const frame = await framePromise;
  return frame.state.signals;
}

describe('lifecycle-signals read round-trip over the live WS transport', () => {
  it('AC1 — docs present, no started story → hasDefineDocs, not hasStartedStory', async () => {
    const dbPath = makeTmpDbPath();
    const server = await startServer(dbPath);
    const project = await makeDefineFixture('ac1');
    server.instance.registry.pin(project);

    const signals = await readSignals(server.url, project);
    expect(signals.hasDefineDocs).toBe(true);
    expect(signals.hasStartedStory).toBe(false);

    await server.stop();
  }, 15000);

  it('AC2 — a started story → hasStartedStory; sequential reads are stable (never cached)', async () => {
    const dbPath = makeTmpDbPath();
    const server = await startServer(dbPath);
    const project = await makeStartedStoryFixture('ac2');
    server.instance.registry.pin(project);

    const first = await readSignals(server.url, project);
    const second = await readSignals(server.url, project);

    expect(first.hasStartedStory).toBe(true);
    expect(second).toEqual(first);

    await server.stop();
  }, 15000);

  it('access control — an UNPINNED path yields no frame (dropped by the allowlist)', async () => {
    const dbPath = makeTmpDbPath();
    const server = await startServer(dbPath);
    const pinned = await makeDefineFixture('pinned');
    const unpinned = await makeStartedStoryFixture('unpinned');
    server.instance.registry.pin(pinned);
    // NOTE: `unpinned` is deliberately NOT pinned.

    const client = await connect(server.url);
    const unpinnedResult = client
      .waitForLifecycleSignals((f) => f.path === unpinned, 800)
      .then(() => 'got-frame')
      .catch(() => 'dropped');
    const pinnedPromise = client.waitForLifecycleSignals((f) => f.path === pinned, 5000);
    client.send({ type: 'lifecycle-signals', path: unpinned });
    client.send({ type: 'lifecycle-signals', path: pinned });

    const pinnedFrame = await pinnedPromise;
    expect(pinnedFrame.state.signals.hasDefineDocs).toBe(true);
    expect(await unpinnedResult).toBe('dropped');

    await server.stop();
  }, 15000);

  it('fans out per-path on a SINGLE socket — two pinned fixtures both resolve', async () => {
    const dbPath = makeTmpDbPath();
    const server = await startServer(dbPath);
    const define = await makeDefineFixture('fanout-define');
    const build = await makeStartedStoryFixture('fanout-build');
    server.instance.registry.pin(define);
    server.instance.registry.pin(build);

    const client = await connect(server.url);
    const definePromise = client.waitForLifecycleSignals((f) => f.path === define, 8000);
    const buildPromise = client.waitForLifecycleSignals((f) => f.path === build, 8000);
    client.send({ type: 'lifecycle-signals', path: define });
    client.send({ type: 'lifecycle-signals', path: build });

    const [defineFrame, buildFrame] = await Promise.all([definePromise, buildPromise]);
    expect(defineFrame.state.signals.hasDefineDocs).toBe(true);
    expect(buildFrame.state.signals.hasStartedStory).toBe(true);

    await server.stop();
  }, 15000);
});
