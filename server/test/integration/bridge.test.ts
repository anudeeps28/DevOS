// Integration test (THE GATE) — Bridge pipeline over the live WS transport.
//
// Boots the REAL server in-process (createServer({port:0,…})) with an INJECTED FAKE
// `query` engine (never live Claude), pins a project carrying a real
// `.claude/harness-roles.json` roster, opens a real `ws` client, sends
// `{type:'bridge-start', path}`, and asserts the observable contract:
//   AC1 — bridge-start spawns the FIRST pipeline role (builder) and reports
//         `bridge-state` with `gate:'awaiting-approval'` after it ends cleanly, with
//         only ONE spawn/query call so far (the next role is NOT auto-spawned since
//         auto_advance defaults OFF); `gate-approve` then advances to the SECOND
//         pipeline role (reviewer), producing a second spawn/query call.
//   AC-access — a `bridge-start` for an UNPINNED / out-of-roots path yields no spawn
//         and the socket stays open for a valid subsequent flow (fails closed).
//
// The fake engine yields a `system/init` message then finishes (returns) immediately,
// so every spawned session ends cleanly — the Bridge sees a clean `ended` and (with
// auto_advance off) pauses at `awaiting-approval`.
// Isolation: per-test tmp DB + real tmp project dirs (with a copied real roster fixture
// under `.claude/harness-roles.json`) so `readRoster` succeeds and the spawn
// containment guard passes; afterEach stops the server + removes the DB sidecars and
// fixture dirs. NO live Claude.

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { createServer } from '../../src/index.js';
import { WS_PATH } from '../../src/config.js';
import type { BridgeStateSnapshot } from '../../src/ws-protocol.js';
import type { EngineMessage, EngineSession, QueryFn, SpawnParams } from '../../src/session/session-engine.js';

// Self-provision a minimal valid roster fixture rather than copy the repo's
// real `.claude/harness-roles.json` — a machine/CI-independent path (the repo
// checks out at a different absolute path on the CI runner). Mirrors the shape
// `readRoster` validates: schemaVersion 2, a pipeline whose every entry has a
// matching `roles.<name>` def (v2 shape: phases[]/model/effort, no stages). The
// test only depends on the builder → reviewer ordering.
const TEST_ROSTER = {
  schemaVersion: 2,
  pipeline: ['builder', 'reviewer'],
  roles: {
    builder: {
      displayName: 'Builder',
      phases: [{ id: 'coding', displayName: 'Shipwright' }],
      skills: [],
      agent: 'builder',
      model: 'claude-opus-5[1m]',
      effort: 'medium',
      producesArtifacts: [],
    },
    reviewer: {
      displayName: 'Reviewer',
      phases: [{ id: 'reviewing', displayName: 'Warden' }],
      skills: [],
      agent: 'reviewer',
      model: 'claude-opus-5[1m]',
      effort: 'high',
      producesArtifacts: [],
    },
  },
} as const;

function isBridgeStateFrame(value: unknown): value is BridgeStateSnapshot {
  if (typeof value !== 'object' || value === null) return false;
  const frame = value as Record<string, unknown>;
  return (
    frame.type === 'bridge-state' &&
    typeof frame.path === 'string' &&
    typeof frame.gate === 'string'
  );
}

// A self-driving fake session: yields a `system/init` (with a unique sdk id) then
// returns immediately — a clean, fast `ended` (never a live/errored session).
function makeFakeSession(sdkId: string): EngineSession {
  async function* gen(): AsyncGenerator<EngineMessage> {
    yield { type: 'system', subtype: 'init', session_id: sdkId };
  }

  return Object.assign(gen(), {
    interrupt: async (): Promise<unknown> => undefined,
    send: async (): Promise<void> => {},
    onPermissionRequest: (): void => {},
    resolvePermission: (): void => {},
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
  readonly predicate: (frame: BridgeStateSnapshot) => boolean;
  readonly resolve: (frame: BridgeStateSnapshot) => void;
  readonly reject: (err: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface TestClient {
  readonly send: (message: unknown) => void;
  readonly waitForBridgeState: (
    predicate: (frame: BridgeStateSnapshot) => boolean,
    timeoutMs: number,
  ) => Promise<BridgeStateSnapshot>;
  readonly seen: () => BridgeStateSnapshot[];
  readonly close: () => void;
}

function openClient(url: string, openTimeoutMs = 3000): Promise<TestClient> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    let waiters: Waiter[] = [];
    const seen: BridgeStateSnapshot[] = [];
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
      if (!isBridgeStateFrame(parsed)) return;
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
        waitForBridgeState: (predicate, timeoutMs) =>
          new Promise<BridgeStateSnapshot>((res, rej) => {
            const existing = seen.find(predicate);
            if (existing) {
              res(existing);
              return;
            }
            const timer = setTimeout(() => {
              waiters = waiters.filter((w) => w.timer !== timer);
              rej(new Error(`Timed out after ${timeoutMs}ms waiting for a bridge-state frame`));
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
  const path = join(tmpdir(), `devos-bridge-${randomUUID()}.db`);
  tmpDbPaths.push(path);
  return path;
}

// A REAL project dir under tmpdir carrying a copy of the real `.claude/harness-roles.json`
// roster — spawn requires the cwd to realpath-resolve within a configured project root
// (the security containment guard) and the Bridge requires `readRoster` to succeed.
function makeProjectDir(): string {
  const path = join(tmpdir(), `devos-bridge-proj-${randomUUID()}`);
  const claudeDir = join(path, '.claude');
  mkdirSync(claudeDir, { recursive: true });
  writeFileSync(join(claudeDir, 'harness-roles.json'), JSON.stringify(TEST_ROSTER), 'utf8');
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

describe('Bridge pipeline over the live WS transport', () => {
  it('AC1 — bridge-start spawns builder only, then gate-approve spawns reviewer', async () => {
    const project = makeProjectDir();
    const engine = makeFakeEngine();
    const server = await startServer(makeTmpDbPath(), engine.query);
    server.instance.registry.pin(project); // auto_advance defaults OFF

    const client = await connect(server.url);
    const awaitingApproval = client.waitForBridgeState(
      (f) => f.path === project && f.gate === 'awaiting-approval',
      5000,
    );
    client.send({ type: 'bridge-start', path: project });
    await awaitingApproval;

    // Only the first pipeline role (builder) was spawned so far — the next role
    // must NOT be auto-spawned while auto_advance is off.
    expect(engine.calls).toHaveLength(1);
    expect(engine.calls[0]?.cwd).toBe(project);
    expect(engine.calls[0]?.role).toBe('builder');

    const reviewerSpawned = client.waitForBridgeState(
      (f) => f.path === project && f.stage === 'reviewer',
      5000,
    );
    client.send({ type: 'gate-approve', path: project });
    await reviewerSpawned;

    // gate-approve advanced the pipeline to the SECOND role (reviewer).
    expect(engine.calls).toHaveLength(2);
    expect(engine.calls[1]?.cwd).toBe(project);
    expect(engine.calls[1]?.role).toBe('reviewer');
  }, 15000);

  it('AC-access — an unpinned/out-of-roots bridge-start is dropped; the socket stays up', async () => {
    const pinned = makeProjectDir();
    const foreign = join(tmpdir(), `devos-bridge-foreign-${randomUUID()}`);
    const engine = makeFakeEngine();
    const server = await startServer(makeTmpDbPath(), engine.query);
    server.instance.registry.pin(pinned); // only `pinned` is allowlisted

    const client = await connect(server.url);

    // bridge-start on the FOREIGN (unpinned) path — must be dropped, no engine call.
    client.send({ type: 'bridge-start', path: foreign });

    // Give the server a beat, then confirm a valid bridge-start on the pinned path
    // still works — the earlier drop must not have wedged the socket/gateway.
    const valid = client.waitForBridgeState(
      (f) => f.path === pinned && f.gate === 'awaiting-approval',
      5000,
    );
    client.send({ type: 'bridge-start', path: pinned });
    await valid;

    // The foreign bridge-start never reached the engine — only the pinned one did.
    expect(engine.calls).toHaveLength(1);
    expect(engine.calls[0]?.cwd).toBe(pinned);
    expect(engine.calls[0]?.role).toBe('builder');
  }, 15000);
});
