// Integration test — registry persistence over the live WS transport.
//
// Boots the REAL server in-process on a free port (PORT=0) with an explicit,
// per-test on-disk SQLite file, opens a real `ws` client, and proves:
//   AC1 — a pinned anchor survives a full server restart (re-opened DB file).
//   AC3 — pin → unpin round-trips over the wire (snapshot reflects both).
//   AC3 — malformed inbound frames are dropped without crashing or emitting a
//         snapshot, and the connection stays alive for a subsequent valid pin.
//
// Isolation (AC4): every test uses its OWN tmp DB file (never the real app-data
// DB) and removes the .db/.db-wal/.db-shm sidecars in afterEach.

import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { createServer } from '../../src/index.js';
import { openDatabase } from '../../src/db/database.js';
import { WS_PATH } from '../../src/config.js';
import type { ProjectAnchor } from '../../src/ws-protocol.js';

interface RegistryFrame {
  readonly type: 'registry';
  readonly projects: readonly ProjectAnchor[];
}

function isRegistryFrame(value: unknown): value is RegistryFrame {
  if (typeof value !== 'object' || value === null) return false;
  const frame = value as Record<string, unknown>;
  return frame.type === 'registry' && Array.isArray(frame.projects);
}

function hasPath(frame: RegistryFrame, path: string): boolean {
  return frame.projects.some((project) => project.path === path);
}

// A thin test client around a real `ws` socket. `received` records every registry
// frame (heartbeats are filtered out) for count-based assertions; `waitForRegistry`
// resolves on the next FUTURE registry frame matching a predicate, with a safety-net
// timeout — the timer only guards against a hung/absent stream.
interface TestClient {
  readonly received: readonly RegistryFrame[];
  readonly send: (message: unknown) => void;
  readonly sendRaw: (raw: string) => void;
  readonly waitForRegistry: (
    predicate: (frame: RegistryFrame) => boolean,
    timeoutMs: number,
  ) => Promise<RegistryFrame>;
  readonly close: () => void;
}

interface Waiter {
  readonly predicate: (frame: RegistryFrame) => boolean;
  readonly resolve: (frame: RegistryFrame) => void;
  readonly reject: (err: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

function openClient(url: string, openTimeoutMs = 3000): Promise<TestClient> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const received: RegistryFrame[] = [];
    let waiters: Waiter[] = [];
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
      // Fail any pending waiters on a live-connection error.
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
        // Non-JSON on the wire is not expected from the server; ignore.
        return;
      }
      // Heartbeat frames legitimately share this socket — skip anything that
      // isn't a registry snapshot.
      if (!isRegistryFrame(parsed)) return;

      received.push(parsed);
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
        get received() {
          return received;
        },
        send: (message: unknown) => socket.send(JSON.stringify(message)),
        sendRaw: (raw: string) => socket.send(raw),
        waitForRegistry: (predicate, timeoutMs) =>
          new Promise<RegistryFrame>((res, rej) => {
            const timer = setTimeout(() => {
              waiters = waiters.filter((w) => w.timer !== timer);
              rej(
                new Error(
                  `Timed out after ${timeoutMs}ms waiting for a matching registry snapshot`,
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

function makeTmpDbPath(): string {
  const path = join(tmpdir(), `devos-persist-${randomUUID()}.db`);
  tmpDbPaths.push(path);
  return path;
}

interface RunningServer {
  readonly address: AddressInfo;
  readonly url: string;
  readonly stop: () => Promise<void>;
}

async function startServer(dbPath: string): Promise<RunningServer> {
  const instance = createServer({ port: 0, dbPath });
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

describe('registry persistence over the live WS transport', () => {
  it('AC1 — a pinned anchor survives a full server restart (re-opened DB file)', async () => {
    // Given: the real server on a free port with an explicit on-disk DB file.
    const dbPath = makeTmpDbPath();
    const server = await startServer(dbPath);
    const projectPath = join(tmpdir(), `devos-project-${randomUUID()}`);

    const client = await connect(server.url);

    // When: the client pins a project with a displayName + uiPrefs.
    const snapshotPromise = client.waitForRegistry((f) => hasPath(f, projectPath), 3000);
    client.send({ type: 'pin', path: projectPath, displayName: 'X', uiPrefs: { a: 1 } });
    const snapshot = await snapshotPromise;

    // Then: the pushed snapshot reflects the anchor exactly.
    const anchor = snapshot.projects.find((p) => p.path === projectPath);
    expect(anchor).toBeDefined();
    expect(anchor?.pinned).toBe(true);
    expect(anchor?.displayName).toBe('X');
    expect(anchor?.uiPrefs).toEqual({ a: 1 });

    // When: the server is fully stopped (closes its DB, checkpointing WAL).
    await server.stop();

    // Then: re-opening the SAME DB file shows the row survived the restart.
    const reopened = openDatabase(dbPath);
    try {
      const row = reopened.raw
        .prepare('SELECT * FROM projects WHERE path = ?')
        .get(projectPath) as
        | {
            path: string;
            display_name: string | null;
            pinned: number;
            ui_prefs_json: string | null;
            created_at: number;
          }
        | undefined;

      expect(row).toBeDefined();
      expect(row?.path).toBe(projectPath);
      expect(row?.display_name).toBe('X');
      expect(row?.pinned).toBe(1);
      expect(row?.ui_prefs_json).not.toBeNull();
      expect(JSON.parse(row!.ui_prefs_json!)).toEqual({ a: 1 });
      expect(typeof row?.created_at).toBe('number');
      expect(Number.isFinite(row?.created_at)).toBe(true);
    } finally {
      reopened.close();
    }
  }, 15000);

  it('AC3 — pin then unpin round-trips over the wire', async () => {
    // Given: a fresh server + fresh tmp DB and a connected client.
    const dbPath = makeTmpDbPath();
    const server = await startServer(dbPath);
    const projectPath = join(tmpdir(), `devos-project-${randomUUID()}`);
    const client = await connect(server.url);

    // When: the client pins the path → the snapshot contains it.
    const pinned = client.waitForRegistry((f) => hasPath(f, projectPath), 3000);
    client.send({ type: 'pin', path: projectPath, displayName: 'RoundTrip' });
    const pinnedSnapshot = await pinned;
    expect(hasPath(pinnedSnapshot, projectPath)).toBe(true);

    // When: the client unpins the same path → a later snapshot omits it.
    const unpinned = client.waitForRegistry((f) => !hasPath(f, projectPath), 3000);
    client.send({ type: 'unpin', path: projectPath });
    const unpinnedSnapshot = await unpinned;
    expect(hasPath(unpinnedSnapshot, projectPath)).toBe(false);

    await server.stop();
  }, 15000);

  it('AC3 — malformed frames are dropped without crashing or emitting a snapshot', async () => {
    // Given: a fresh server + tmp DB and a connected client that has already
    // received its initial connect snapshot.
    const dbPath = makeTmpDbPath();
    const server = await startServer(dbPath);
    const projectPath = join(tmpdir(), `devos-project-${randomUUID()}`);
    const client = await connect(server.url);

    // When: the client sends a malformed pin (no path) and a non-JSON string.
    client.send({ type: 'pin' }); // missing required `path`
    client.sendRaw('this is not json');

    // And then: a VALID pin — proving the connection is still alive.
    const valid = client.waitForRegistry((f) => hasPath(f, projectPath), 3000);
    client.send({ type: 'pin', path: projectPath, displayName: 'AfterMalformed' });
    const snapshot = await valid;

    // Then: the valid pin round-tripped. TCP ordering guarantees the gateway's
    // single connect snapshot arrived before this one, so the malformed frames
    // produced NO snapshots iff exactly two registry frames were received in
    // total (initial empty snapshot + this valid pin) and only one contains the
    // path.
    expect(hasPath(snapshot, projectPath)).toBe(true);
    expect(client.received.filter((f) => hasPath(f, projectPath))).toHaveLength(1);
    expect(client.received).toHaveLength(2);

    await server.stop();
  }, 15000);
});
