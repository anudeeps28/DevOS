// Integration test — cost/usage ledger row + `cost-usage` WS broadcast + snapshot.
//
// Boots the REAL server in-process (createServer({port:0,…})) with an INJECTED FAKE
// `query` engine (never live Claude), pins a real tmp project dir (projectRoots =
// [tmpdir()] so the spawn containment guard passes), opens real `ws` clients, and
// asserts the observable contract:
//   AC1 — a builder session's `result` message inserts EXACTLY ONE `cost_ledger` row,
//         mapped correctly (session_id/input_tokens/output_tokens/cost_usd/at) —
//         verified via `server.costLedger.costToday()` AND a direct SELECT against
//         the same on-disk DB.
//   AC2 — a connected client receives a `cost-usage` broadcast after the write, and a
//         SECOND client that connects AFTER the write immediately gets a `cost-usage`
//         snapshot carrying the same non-zero figures.
//
// Isolation: per-test tmp DB (a real file, so a second connection can read it) + real
// tmp project dirs; afterEach stops the server + removes the DB sidecars and fixture
// dirs. NO live Claude.

import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { openDatabase } from '../../src/db/database.js';
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
  };
}

interface CostUsageFrame {
  readonly type: 'cost-usage';
  readonly costTodayUsd: number;
  readonly inputTokensToday: number;
  readonly outputTokensToday: number;
  readonly sinceEpochMs: number;
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

function isCostUsageFrame(value: unknown): value is CostUsageFrame {
  if (typeof value !== 'object' || value === null) return false;
  const frame = value as Record<string, unknown>;
  return frame.type === 'cost-usage' && typeof frame.costTodayUsd === 'number';
}

// A controllable fake session: push any message on demand (init/result/etc), stays
// open until interrupt(). Mirrors session-manager.test.ts's makeSession() (simplified
// to only what this test needs — no permission/steer plumbing).
function makeControllableSession(): { session: EngineSession; emit: (message: EngineMessage) => void } {
  const buffer: EngineMessage[] = [];
  let resolveNext: (() => void) | null = null;
  let done = false;

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
      if (done) return;
      await new Promise<void>((r) => {
        resolveNext = r;
      });
    }
  }

  const session: EngineSession = Object.assign(gen(), {
    interrupt: async (): Promise<unknown> => {
      done = true;
      wake();
      return undefined;
    },
    send: async (): Promise<void> => {},
    onPermissionRequest: (): void => {},
    resolvePermission: (): void => {},
    onQuestionRequest: (): void => {},
    answerQuestion: (): void => {},
    end: (): void => {
      done = true;
      wake();
    },
  });

  return {
    session,
    emit: (message) => {
      buffer.push(message);
      wake();
    },
  };
}

function makeFakeEngine(): {
  query: QueryFn;
  calls: SpawnParams[];
  emitFns: Array<(message: EngineMessage) => void>;
} {
  const calls: SpawnParams[] = [];
  const emitFns: Array<(message: EngineMessage) => void> = [];
  const query: QueryFn = (params) => {
    calls.push(params);
    const { session, emit } = makeControllableSession();
    emitFns.push(emit);
    return session;
  };
  return { query, calls, emitFns };
}

interface Waiter<T> {
  readonly predicate: (frame: T) => boolean;
  readonly resolve: (frame: T) => void;
  readonly reject: (err: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface TestClient {
  readonly send: (message: unknown) => void;
  readonly waitForSessionState: (
    predicate: (frame: SessionStateFrame) => boolean,
    timeoutMs: number,
  ) => Promise<SessionStateFrame>;
  readonly waitForCostUsage: (
    predicate: (frame: CostUsageFrame) => boolean,
    timeoutMs: number,
  ) => Promise<CostUsageFrame>;
  readonly close: () => void;
}

function openClient(url: string, openTimeoutMs = 3000): Promise<TestClient> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    let stateWaiters: Array<Waiter<SessionStateFrame>> = [];
    let costWaiters: Array<Waiter<CostUsageFrame>> = [];
    const seenState: SessionStateFrame[] = [];
    const seenCost: CostUsageFrame[] = [];
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
      const pendingState = stateWaiters;
      stateWaiters = [];
      for (const waiter of pendingState) {
        clearTimeout(waiter.timer);
        waiter.reject(error);
      }
      const pendingCost = costWaiters;
      costWaiters = [];
      for (const waiter of pendingCost) {
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

      if (isSessionStateFrame(parsed)) {
        seenState.push(parsed);
        const stillWaiting: Array<Waiter<SessionStateFrame>> = [];
        for (const waiter of stateWaiters) {
          if (waiter.predicate(parsed)) {
            clearTimeout(waiter.timer);
            waiter.resolve(parsed);
          } else {
            stillWaiting.push(waiter);
          }
        }
        stateWaiters = stillWaiting;
        return;
      }

      if (isCostUsageFrame(parsed)) {
        seenCost.push(parsed);
        const stillWaiting: Array<Waiter<CostUsageFrame>> = [];
        for (const waiter of costWaiters) {
          if (waiter.predicate(parsed)) {
            clearTimeout(waiter.timer);
            waiter.resolve(parsed);
          } else {
            stillWaiting.push(waiter);
          }
        }
        costWaiters = stillWaiting;
        return;
      }
    });

    socket.on('open', () => {
      opened = true;
      clearTimeout(openTimer);
      resolve({
        send: (message) => socket.send(JSON.stringify(message)),
        waitForSessionState: (predicate, timeoutMs) =>
          new Promise<SessionStateFrame>((res, rej) => {
            const existing = seenState.find(predicate);
            if (existing) {
              res(existing);
              return;
            }
            const timer = setTimeout(() => {
              stateWaiters = stateWaiters.filter((w) => w.timer !== timer);
              rej(new Error(`Timed out after ${timeoutMs}ms waiting for a session-state frame`));
            }, timeoutMs);
            stateWaiters.push({ predicate, resolve: res, reject: rej, timer });
          }),
        waitForCostUsage: (predicate, timeoutMs) =>
          new Promise<CostUsageFrame>((res, rej) => {
            const existing = seenCost.find(predicate);
            if (existing) {
              res(existing);
              return;
            }
            const timer = setTimeout(() => {
              costWaiters = costWaiters.filter((w) => w.timer !== timer);
              rej(new Error(`Timed out after ${timeoutMs}ms waiting for a cost-usage frame`));
            }, timeoutMs);
            costWaiters.push({ predicate, resolve: res, reject: rej, timer });
          }),
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
  const path = join(tmpdir(), `devos-costusage-${randomUUID()}.db`);
  tmpDbPaths.push(path);
  return path;
}

// A REAL project dir under tmpdir — spawn requires the cwd to realpath-resolve
// within a configured project root (the security containment guard), so the fixture
// must exist on disk and the server is started with projectRoots = [tmpdir()].
function makeProjectDir(): string {
  const path = join(tmpdir(), `devos-costusage-proj-${randomUUID()}`);
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

interface CostLedgerRow {
  readonly session_id: string;
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cost_usd: number;
  readonly at: number;
}

/** A direct, second connection to the SAME on-disk DB — proves cardinality via SQL. */
function readLedgerRowsDirect(dbPath: string): readonly CostLedgerRow[] {
  const handle = openDatabase(dbPath);
  try {
    return handle.raw.prepare('SELECT session_id, input_tokens, output_tokens, cost_usd, at FROM cost_ledger').all() as CostLedgerRow[];
  } finally {
    handle.close();
  }
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

describe('cost/usage ledger row + cost-usage WS broadcast/snapshot', () => {
  it('AC1 — a `result` message inserts exactly one cost_ledger row, correctly mapped', async () => {
    const project = makeProjectDir();
    const dbPath = makeTmpDbPath();
    const engine = makeFakeEngine();
    const server = await startServer(dbPath, engine.query);
    server.instance.registry.pin(project);

    const client = await connect(server.url);
    const running = client.waitForSessionState(
      (f) => f.path === project && f.session.status === 'running',
      5000,
    );
    client.send({ type: 'session-spawn', path: project, role: 'builder', workItemId: 'WI-COST' });
    const spawned = await running;

    const emit = engine.emitFns[0];
    if (emit === undefined) throw new Error('expected the fake engine to have spawned one session');

    const broadcastPromise = client.waitForCostUsage((f) => f.costTodayUsd > 0, 5000);

    emit({ type: 'system', subtype: 'init', session_id: 'sdk-cost-1' });
    emit({
      type: 'result',
      duration_ms: 100,
      num_turns: 1,
      total_cost_usd: 0.4567,
      usage: { input_tokens: 111, output_tokens: 222 },
      is_error: false,
    });

    const broadcast = await broadcastPromise;
    expect(broadcast.costTodayUsd).toBeCloseTo(0.4567, 6);
    expect(broadcast.inputTokensToday).toBe(111);
    expect(broadcast.outputTokensToday).toBe(222);

    // Aggregate read via the store's own public surface.
    const aggregate = server.instance.costLedger.costToday();
    expect(aggregate.costTodayUsd).toBeCloseTo(0.4567, 6);
    expect(aggregate.inputTokensToday).toBe(111);
    expect(aggregate.outputTokensToday).toBe(222);

    // Cardinality + field mapping via a DIRECT SELECT on the same on-disk DB.
    const rows = readLedgerRowsDirect(dbPath);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row?.session_id).toBe(spawned.session.id);
    expect(row?.input_tokens).toBe(111);
    expect(row?.output_tokens).toBe(222);
    expect(row?.cost_usd).toBeCloseTo(0.4567, 6);
    expect(typeof row?.at).toBe('number');
  }, 15000);

  it('AC2 — a connected client gets the broadcast on write; a client connecting AFTER gets a matching snapshot', async () => {
    const project = makeProjectDir();
    const dbPath = makeTmpDbPath();
    const engine = makeFakeEngine();
    const server = await startServer(dbPath, engine.query);
    server.instance.registry.pin(project);

    const client = await connect(server.url);
    const running = client.waitForSessionState(
      (f) => f.path === project && f.session.status === 'running',
      5000,
    );
    client.send({ type: 'session-spawn', path: project, role: 'builder', workItemId: 'WI-COST-2' });
    await running;

    const emit = engine.emitFns[0];
    if (emit === undefined) throw new Error('expected the fake engine to have spawned one session');

    const broadcastPromise = client.waitForCostUsage((f) => f.costTodayUsd > 0, 5000);
    emit({ type: 'system', subtype: 'init', session_id: 'sdk-cost-2' });
    emit({
      type: 'result',
      duration_ms: 100,
      num_turns: 1,
      total_cost_usd: 1.5,
      usage: { input_tokens: 50, output_tokens: 75 },
      is_error: false,
    });
    const broadcast = await broadcastPromise;
    expect(broadcast.costTodayUsd).toBeCloseTo(1.5, 6);

    // A SECOND client connecting AFTER the row is written must see the same
    // non-zero aggregate immediately, as its initial connect snapshot.
    const secondClient = await connect(server.url);
    const snapshot = await secondClient.waitForCostUsage((f) => f.costTodayUsd > 0, 5000);
    expect(snapshot.costTodayUsd).toBeCloseTo(1.5, 6);
    expect(snapshot.inputTokensToday).toBe(50);
    expect(snapshot.outputTokensToday).toBe(75);
  }, 15000);
});
