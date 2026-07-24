// Integration test — tracker-state read round-trip over the live WS transport.
//
// Boots the REAL server in-process on a free port (PORT=0) with an explicit,
// per-test on-disk SQLite file AND per-test tmp PROJECT fixtures, opens a real
// `ws` client, sends `{type:'tracker-state', path}`, awaits the snapshot frame,
// and asserts on `state`:
//   AC1 — a fixture whose stub adapter echoes a known Todoist JSON array →
//         reachable:true with nextTask matching the top open (highest-priority,
//         non-milestone) item's title / id / priority.
//   AC2 — a fixture whose adapter `exit 1` (or has no script) → reachable:false,
//         nextTask:null, and the gateway STAYS UP for a subsequent healthy read.
//   Fan-out — a healthy fixture and a broken fixture bursted together on ONE
//         socket → BOTH frames resolve; the broken (reachable:false) one does not
//         stall the healthy one (per-path flood-guard regression, mirrors
//         git-state's fan-out test).
//
// Each fixture is a tmp PROJECT dir carrying `.claude/.harness-manifest.json`
// (`{"tracker":"todoist"}`) and an executable (chmod 0o755) stub adapter at
// `.claude/trackers/active/get-sprint-issues.sh`. NO live tracker — the stub script
// echoes a fixed payload or exits non-zero.
//
// Isolation: every test uses its OWN tmp fixtures + tmp DB file (never the real
// app-data DB). afterEach removes the fixture trees and the .db/.db-wal/.db-shm
// sidecars. The server is created with NO project roots — every read targets an
// explicit absolute path, so discovery never interferes.

import { promises as fs } from 'node:fs';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { createServer } from '../../src/index.js';
import { WS_PATH } from '../../src/config.js';
import type { TrackerState } from '../../src/ws-protocol.js';

// A known Todoist task list emitted by the healthy stub adapter. The top open item
// is id 202 (priority 4 = p1 highest). Item 303 also has priority 4 but is
// `isUncompletable` (a milestone container) and must be excluded, so 202 wins.
const TODOIST_PAYLOAD = [
  { id: '101', content: 'Low priority chore', priority: 1 },
  {
    id: '202',
    content: 'Ship the tracker adapter gateway',
    priority: 4,
    url: 'https://todoist.com/showTask?id=202',
  },
  { id: '303', content: 'M1 milestone', priority: 4, isUncompletable: true },
  { id: '404', content: 'Medium task', priority: 2 },
];

// The expected top open item after normalization (highest priority, non-milestone).
const TOP_TASK = {
  id: '202',
  title: 'Ship the tracker adapter gateway',
  priority: 4,
} as const;

interface TrackerStateFrame {
  readonly type: 'tracker-state';
  readonly path: string;
  readonly state: TrackerState;
}

function isTrackerStateFrame(value: unknown): value is TrackerStateFrame {
  if (typeof value !== 'object' || value === null) return false;
  const frame = value as Record<string, unknown>;
  return (
    frame.type === 'tracker-state' &&
    typeof frame.path === 'string' &&
    typeof frame.state === 'object' &&
    frame.state !== null
  );
}

// A thin test client around a real `ws` socket. `waitForTrackerState` resolves on
// the next FUTURE tracker-state frame matching a predicate, with a safety-net
// timeout — the timer only guards against a hung/absent stream. Heartbeats and
// other frames are ignored by the waiter.
interface TestClient {
  readonly send: (message: unknown) => void;
  readonly waitForTrackerState: (
    predicate: (frame: TrackerStateFrame) => boolean,
    timeoutMs: number,
  ) => Promise<TrackerStateFrame>;
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
    let trackerStateWaiters: Array<Waiter<TrackerStateFrame>> = [];
    let opened = false;

    const openTimer = setTimeout(() => {
      if (!opened) {
        socket.removeAllListeners();
        socket.close();
        reject(new Error(`Timed out after ${openTimeoutMs}ms waiting for ws 'open'`));
      }
    }, openTimeoutMs);

    const failAll = (error: Error): void => {
      const pending = trackerStateWaiters;
      trackerStateWaiters = [];
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
        // Non-JSON on the wire is not expected from the server; ignore.
        return;
      }

      if (isTrackerStateFrame(parsed)) {
        const frame = parsed;
        const stillWaiting: Array<Waiter<TrackerStateFrame>> = [];
        for (const waiter of trackerStateWaiters) {
          if (waiter.predicate(frame)) {
            clearTimeout(waiter.timer);
            waiter.resolve(frame);
          } else {
            stillWaiting.push(waiter);
          }
        }
        trackerStateWaiters = stillWaiting;
        return;
      }
      // Heartbeat / registry / anything else — ignore.
    });

    socket.on('open', () => {
      opened = true;
      clearTimeout(openTimer);
      resolve({
        send: (message: unknown) => socket.send(JSON.stringify(message)),
        waitForTrackerState: (predicate, timeoutMs) =>
          new Promise<TrackerStateFrame>((res, rej) => {
            const timer = setTimeout(() => {
              trackerStateWaiters = trackerStateWaiters.filter((w) => w.timer !== timer);
              rej(
                new Error(
                  `Timed out after ${timeoutMs}ms waiting for a matching tracker-state snapshot`,
                ),
              );
            }, timeoutMs);
            trackerStateWaiters.push({ predicate, resolve: res, reject: rej, timer });
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
  const path = join(tmpdir(), `devos-trackerstate-${randomUUID()}.db`);
  tmpDbPaths.push(path);
  return path;
}

/** Create a tracked tmp root directory (recursively removed in afterEach). */
async function makeTmpRoot(prefix: string): Promise<string> {
  const root = join(tmpdir(), `devos-trackerstate-${prefix}-${randomUUID()}`);
  tmpRoots.push(root);
  await fs.mkdir(root, { recursive: true });
  return root;
}

/**
 * Build a tmp PROJECT fixture: a `.claude/.harness-manifest.json` carrying the
 * given tracker field plus an executable `.claude/trackers/active/get-sprint-issues.sh`
 * whose body is `scriptBody`. Returns the project root path.
 */
async function makeProjectFixture(
  prefix: string,
  tracker: string,
  scriptBody: string,
): Promise<string> {
  const root = await makeTmpRoot(prefix);
  const claudeDir = join(root, '.claude');
  const adapterDir = join(claudeDir, 'trackers', 'active');
  await fs.mkdir(adapterDir, { recursive: true });
  await fs.writeFile(
    join(claudeDir, '.harness-manifest.json'),
    `${JSON.stringify({ tracker }, null, 2)}\n`,
  );
  const scriptPath = join(adapterDir, 'get-sprint-issues.sh');
  await fs.writeFile(scriptPath, scriptBody);
  await fs.chmod(scriptPath, 0o755);
  return root;
}

/** A healthy adapter that echoes the known Todoist JSON array on stdout. */
async function makeHealthyFixture(prefix = 'healthy'): Promise<string> {
  const body = `#!/bin/bash\ncat <<'JSON'\n${JSON.stringify(TODOIST_PAYLOAD)}\nJSON\n`;
  return makeProjectFixture(prefix, 'todoist', body);
}

/** A broken adapter that exits non-zero without emitting a payload. */
async function makeBrokenFixture(prefix = 'broken'): Promise<string> {
  return makeProjectFixture(prefix, 'todoist', '#!/bin/bash\nexit 1\n');
}

interface RunningServer {
  readonly address: AddressInfo;
  readonly url: string;
  readonly stop: () => Promise<void>;
}

async function startServer(dbPath: string): Promise<RunningServer> {
  // No project roots: tracker-state reads target explicit absolute paths, so
  // discovery never runs and never interferes with the frames under test.
  const instance = createServer({ port: 0, dbPath, projectRoots: [] });
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

// Read tracker state for `path` over a FRESH socket. Each new socket resets the
// per-socket TRACKER_STATE_MIN_INTERVAL_MS flood-guard to 0, so every read here is
// accepted immediately and independently — no debounce interference, and it proves
// the server never memoizes (each read hits `readTrackerState` afresh).
async function readState(url: string, path: string): Promise<TrackerState> {
  const client = await connect(url);
  const framePromise = client.waitForTrackerState((f) => f.path === path, 5000);
  client.send({ type: 'tracker-state', path });
  const frame = await framePromise;
  return frame.state;
}

describe('tracker-state read round-trip over the live WS transport', () => {
  it('AC1 — a healthy adapter yields reachable:true with the top open task', async () => {
    // Given: a pinned project whose stub adapter echoes a known Todoist list.
    const dbPath = makeTmpDbPath();
    const server = await startServer(dbPath);
    const project = await makeHealthyFixture('ac1');

    // When: reading tracker state over the live WS transport.
    const state = await readState(server.url, project);

    // Then: reachable, tracker labelled, and nextTask is the top open (non-milestone)
    // item — id 202 / priority 4, NOT the priority-4 milestone (303).
    expect(state.reachable).toBe(true);
    expect(state.tracker).toBe('todoist');
    expect(state.nextTask).not.toBeNull();
    expect(state.nextTask?.id).toBe(TOP_TASK.id);
    expect(state.nextTask?.title).toBe(TOP_TASK.title);
    expect(state.nextTask?.priority).toBe(TOP_TASK.priority);

    await server.stop();
  }, 15000);

  it('AC2 — a broken adapter yields reachable:false; gateway stays up', async () => {
    // Given: a project whose adapter exits non-zero, and one with no script at all.
    const dbPath = makeTmpDbPath();
    const server = await startServer(dbPath);
    const broken = await makeBrokenFixture('ac2-exit1');

    // A fixture with a manifest but NO adapter script.
    const noScript = await makeTmpRoot('ac2-noscript');
    await fs.mkdir(join(noScript, '.claude'), { recursive: true });
    await fs.writeFile(
      join(noScript, '.claude', '.harness-manifest.json'),
      `${JSON.stringify({ tracker: 'todoist' })}\n`,
    );

    // When: reading the broken adapter → a well-formed unreachable frame.
    const brokenState = await readState(server.url, broken);
    expect(brokenState.reachable).toBe(false);
    expect(brokenState.nextTask).toBeNull();

    // When: reading the missing-script project → also unreachable, never throws.
    const noScriptState = await readState(server.url, noScript);
    expect(noScriptState.reachable).toBe(false);
    expect(noScriptState.nextTask).toBeNull();

    // Then: the gateway is still UP — a subsequent healthy read round-trips.
    const healthy = await makeHealthyFixture('ac2-real');
    const healthyState = await readState(server.url, healthy);
    expect(healthyState.reachable).toBe(true);
    expect(healthyState.nextTask?.id).toBe(TOP_TASK.id);

    await server.stop();
  }, 15000);

  it('fans out per-path on a SINGLE socket — a broken path does not stall a healthy one', async () => {
    // Regression for the per-socket flood-guard: the client bursts one tracker-state
    // frame per pinned project on ONE socket. A per-socket scalar guard would drop
    // the second path; the guard must be keyed per-path so both distinct paths pass.
    // A broken (reachable:false) path must not block the healthy one from resolving.
    const dbPath = makeTmpDbPath();
    const server = await startServer(dbPath);

    const healthy = await makeHealthyFixture('fanout-healthy');
    const broken = await makeBrokenFixture('fanout-broken');

    // When: a single client bursts both requests on ONE socket.
    const client = await connect(server.url);
    const healthyPromise = client.waitForTrackerState((f) => f.path === healthy, 8000);
    const brokenPromise = client.waitForTrackerState((f) => f.path === broken, 8000);
    client.send({ type: 'tracker-state', path: healthy });
    client.send({ type: 'tracker-state', path: broken });

    const [healthyFrame, brokenFrame] = await Promise.all([healthyPromise, brokenPromise]);

    // Then: BOTH frames resolved — the broken path did not stall the healthy one.
    expect(healthyFrame.state.reachable).toBe(true);
    expect(healthyFrame.state.nextTask?.id).toBe(TOP_TASK.id);
    expect(brokenFrame.state.reachable).toBe(false);
    expect(brokenFrame.state.nextTask).toBeNull();

    await server.stop();
  }, 15000);
});
