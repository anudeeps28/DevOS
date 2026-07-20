// Integration test — discovery scan + pin round-trip over the live WS transport.
//
// Boots the REAL server in-process on a free port (PORT=0) with an explicit,
// per-test on-disk SQLite file AND a per-test tmp fixture ROOT, opens a real `ws`
// client, and proves:
//   AC1 — a `discover` frame returns candidates that INCLUDE a child holding a
//         `.claude/` directory and EXCLUDE a sibling that has none.
//   AC2 — pinning a candidate path round-trips into the registry snapshot, and a
//         subsequent `discover` EXCLUDES the now-pinned path.
//
// Isolation: every test uses its OWN tmp fixture root + tmp DB file (never the
// real app-data DB). afterEach removes the fixture tree and the .db/.db-wal/.db-shm
// sidecars.

import { mkdir, rm } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { createServer } from '../../src/index.js';
import { WS_PATH } from '../../src/config.js';
import type { Candidate, ProjectAnchor } from '../../src/ws-protocol.js';

interface RegistryFrame {
  readonly type: 'registry';
  readonly projects: readonly ProjectAnchor[];
}

interface CandidatesFrame {
  readonly type: 'candidates';
  readonly candidates: readonly Candidate[];
}

function isRegistryFrame(value: unknown): value is RegistryFrame {
  if (typeof value !== 'object' || value === null) return false;
  const frame = value as Record<string, unknown>;
  return frame.type === 'registry' && Array.isArray(frame.projects);
}

function isCandidatesFrame(value: unknown): value is CandidatesFrame {
  if (typeof value !== 'object' || value === null) return false;
  const frame = value as Record<string, unknown>;
  return frame.type === 'candidates' && Array.isArray(frame.candidates);
}

function registryHasPath(frame: RegistryFrame, path: string): boolean {
  return frame.projects.some((project) => project.path === path);
}

function candidateHasPath(frame: CandidatesFrame, path: string): boolean {
  return frame.candidates.some((candidate) => candidate.path === path);
}

// A thin test client around a real `ws` socket. `waitForRegistry` / `waitForCandidates`
// resolve on the next FUTURE frame of that kind matching a predicate, with a safety-net
// timeout — the timer only guards against a hung/absent stream. Heartbeats and frames of
// the other kind are ignored by each waiter.
interface TestClient {
  readonly send: (message: unknown) => void;
  readonly waitForRegistry: (
    predicate: (frame: RegistryFrame) => boolean,
    timeoutMs: number,
  ) => Promise<RegistryFrame>;
  readonly waitForCandidates: (
    predicate: (frame: CandidatesFrame) => boolean,
    timeoutMs: number,
  ) => Promise<CandidatesFrame>;
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
    let registryWaiters: Array<Waiter<RegistryFrame>> = [];
    let candidateWaiters: Array<Waiter<CandidatesFrame>> = [];
    let opened = false;

    const openTimer = setTimeout(() => {
      if (!opened) {
        socket.removeAllListeners();
        socket.close();
        reject(new Error(`Timed out after ${openTimeoutMs}ms waiting for ws 'open'`));
      }
    }, openTimeoutMs);

    const failAll = (error: Error): void => {
      const pendingRegistry = registryWaiters;
      const pendingCandidates = candidateWaiters;
      registryWaiters = [];
      candidateWaiters = [];
      for (const waiter of pendingRegistry) {
        clearTimeout(waiter.timer);
        waiter.reject(error);
      }
      for (const waiter of pendingCandidates) {
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
        // Non-JSON on the wire is not expected from the server; ignore.
        return;
      }

      if (isRegistryFrame(parsed)) {
        const frame = parsed;
        const stillWaiting: Array<Waiter<RegistryFrame>> = [];
        for (const waiter of registryWaiters) {
          if (waiter.predicate(frame)) {
            clearTimeout(waiter.timer);
            waiter.resolve(frame);
          } else {
            stillWaiting.push(waiter);
          }
        }
        registryWaiters = stillWaiting;
        return;
      }

      if (isCandidatesFrame(parsed)) {
        const frame = parsed;
        const stillWaiting: Array<Waiter<CandidatesFrame>> = [];
        for (const waiter of candidateWaiters) {
          if (waiter.predicate(frame)) {
            clearTimeout(waiter.timer);
            waiter.resolve(frame);
          } else {
            stillWaiting.push(waiter);
          }
        }
        candidateWaiters = stillWaiting;
        return;
      }
      // Heartbeat / anything else — ignore.
    });

    socket.on('open', () => {
      opened = true;
      clearTimeout(openTimer);
      resolve({
        send: (message: unknown) => socket.send(JSON.stringify(message)),
        waitForRegistry: (predicate, timeoutMs) =>
          new Promise<RegistryFrame>((res, rej) => {
            const timer = setTimeout(() => {
              registryWaiters = registryWaiters.filter((w) => w.timer !== timer);
              rej(
                new Error(
                  `Timed out after ${timeoutMs}ms waiting for a matching registry snapshot`,
                ),
              );
            }, timeoutMs);
            registryWaiters.push({ predicate, resolve: res, reject: rej, timer });
          }),
        waitForCandidates: (predicate, timeoutMs) =>
          new Promise<CandidatesFrame>((res, rej) => {
            const timer = setTimeout(() => {
              candidateWaiters = candidateWaiters.filter((w) => w.timer !== timer);
              rej(
                new Error(
                  `Timed out after ${timeoutMs}ms waiting for a matching candidates snapshot`,
                ),
              );
            }, timeoutMs);
            candidateWaiters.push({ predicate, resolve: res, reject: rej, timer });
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
  const path = join(tmpdir(), `devos-discover-${randomUUID()}.db`);
  tmpDbPaths.push(path);
  return path;
}

// Build a tmp fixture root with two children: `alpha/` (holds a `.claude/` dir,
// a discovery candidate) and `beta/` (no `.claude/`, must never be a candidate).
async function makeFixtureRoot(): Promise<string> {
  const root = join(tmpdir(), `devos-discover-root-${randomUUID()}`);
  tmpRoots.push(root);
  await mkdir(join(root, 'alpha', '.claude'), { recursive: true });
  await mkdir(join(root, 'beta'), { recursive: true });
  return root;
}

interface RunningServer {
  readonly address: AddressInfo;
  readonly url: string;
  readonly stop: () => Promise<void>;
}

async function startServer(dbPath: string, projectRoots: readonly string[]): Promise<RunningServer> {
  const instance = createServer({ port: 0, dbPath, projectRoots });
  const address = await instance.start();
  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    await instance.stop();
  };
  activeStops.push(stop);
  return { address, url: `ws://127.0.0.1:${address.port}${WS_PATH}`, stop };
}

afterEach(async () => {
  for (const client of activeClients.splice(0)) {
    client.close();
  }
  // Guarded stop — safe even if a test already stopped its server.
  for (const stop of activeStops.splice(0)) {
    await stop().catch(() => undefined);
  }
  for (const root of tmpRoots.splice(0)) {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
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

// Assert that NO `candidates` frame arrives on this client within `ms`. Resolves
// when the window elapses with none seen (the throttle held); rejects if one
// arrives. `waitForCandidates` only matches FUTURE frames, so a prior scan's
// snapshot — already consumed by an earlier waiter — never trips this.
async function expectNoCandidatesWithin(client: TestClient, ms: number): Promise<void> {
  try {
    await client.waitForCandidates(() => true, ms);
  } catch {
    return; // timed out with no candidates frame — the per-socket throttle dropped the repeat
  }
  throw new Error(`Expected no candidates frame within ${ms}ms, but one arrived`);
}

describe('discovery scan + pin round-trip over the live WS transport', () => {
  it('AC1 — discover returns the .claude child and excludes the bare sibling', async () => {
    // Given: the real server bound to a free port, scanning our fixture root.
    const dbPath = makeTmpDbPath();
    const fixtureRoot = await makeFixtureRoot();
    const server = await startServer(dbPath, [fixtureRoot]);
    const alphaPath = join(fixtureRoot, 'alpha');
    const betaPath = join(fixtureRoot, 'beta');

    const client = await connect(server.url);

    // When: the client requests a discovery scan.
    const candidatesPromise = client.waitForCandidates(
      (f) => candidateHasPath(f, alphaPath),
      3000,
    );
    client.send({ type: 'discover' });
    const snapshot = await candidatesPromise;

    // Then: alpha (has `.claude/`) is a candidate; beta (no `.claude/`) is not.
    expect(candidateHasPath(snapshot, alphaPath)).toBe(true);
    expect(candidateHasPath(snapshot, betaPath)).toBe(false);

    const alpha = snapshot.candidates.find((c) => c.path === alphaPath);
    expect(alpha).toEqual({
      path: alphaPath,
      displayName: 'alpha',
      hasClaudeInstall: true,
    });

    await server.stop();
  }, 15000);

  it('AC2 — pinning a candidate excludes it from a later discover', async () => {
    // Given: the real server scanning our fixture root, with a connected client.
    const dbPath = makeTmpDbPath();
    const fixtureRoot = await makeFixtureRoot();
    const server = await startServer(dbPath, [fixtureRoot]);
    const alphaPath = join(fixtureRoot, 'alpha');
    const client = await connect(server.url);

    // Sanity: alpha starts out as a candidate.
    const firstScan = client.waitForCandidates((f) => candidateHasPath(f, alphaPath), 3000);
    client.send({ type: 'discover' });
    expect(candidateHasPath(await firstScan, alphaPath)).toBe(true);

    // When: the client pins the alpha candidate path → the registry snapshot includes it.
    const pinned = client.waitForRegistry((f) => registryHasPath(f, alphaPath), 3000);
    client.send({ type: 'pin', path: alphaPath, displayName: 'alpha' });
    const pinnedSnapshot = await pinned;
    expect(registryHasPath(pinnedSnapshot, alphaPath)).toBe(true);

    // When: the client re-discovers → alpha is now EXCLUDED (already pinned).
    // The per-socket discover throttle (DISCOVER_MIN_INTERVAL_MS) would drop an
    // immediate re-discover on the SAME socket, so open a fresh client for the
    // re-scan — a realistic "new tab / reconnect" and unaffected by the throttle.
    const client2 = await connect(server.url);
    const secondScan = client2.waitForCandidates((f) => !candidateHasPath(f, alphaPath), 3000);
    client2.send({ type: 'discover' });
    const secondSnapshot = await secondScan;
    expect(candidateHasPath(secondSnapshot, alphaPath)).toBe(false);

    await server.stop();
  }, 15000);

  it('AC3 — a second discover on the same socket within the throttle window is dropped', async () => {
    // Given: the real server scanning our fixture root, with a connected client.
    const dbPath = makeTmpDbPath();
    const fixtureRoot = await makeFixtureRoot();
    const server = await startServer(dbPath, [fixtureRoot]);
    const alphaPath = join(fixtureRoot, 'alpha');
    const client = await connect(server.url);

    // When: the client requests a discovery scan → the first candidates frame arrives.
    const firstScan = client.waitForCandidates((f) => candidateHasPath(f, alphaPath), 3000);
    client.send({ type: 'discover' });
    await firstScan;

    // When: the client IMMEDIATELY re-discovers, well inside the 500ms per-socket window.
    // Then: no second candidates frame arrives (250ms < DISCOVER_MIN_INTERVAL_MS) — the throttle drops it.
    const noSecond = expectNoCandidatesWithin(client, 250);
    client.send({ type: 'discover' });
    await noSecond;

    await server.stop();
  }, 15000);
});
