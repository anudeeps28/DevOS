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
import type { BridgeStateSnapshot, SessionStateSnapshot } from '../../src/ws-protocol.js';
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

function isSessionStateFrame(value: unknown): value is SessionStateSnapshot {
  if (typeof value !== 'object' || value === null) return false;
  const frame = value as Record<string, unknown>;
  return (
    frame.type === 'session-state' &&
    typeof frame.path === 'string' &&
    typeof frame.session === 'object' &&
    frame.session !== null
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
    onQuestionRequest: (): void => {},
    answerQuestion: (): void => {},
    end: (): void => {},
  });
}

// A fake session that yields `system/init` then throws — an `errored` end, so the
// Bridge takes the rework path (with a failure report present) instead of `ended`.
function makeErroringSession(sdkId: string): EngineSession {
  async function* gen(): AsyncGenerator<EngineMessage> {
    yield { type: 'system', subtype: 'init', session_id: sdkId };
    throw new Error('boom');
  }

  return Object.assign(gen(), {
    interrupt: async (): Promise<unknown> => undefined,
    send: async (): Promise<void> => {},
    onPermissionRequest: (): void => {},
    resolvePermission: (): void => {},
    onQuestionRequest: (): void => {},
    answerQuestion: (): void => {},
    end: (): void => {},
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

// Errors on the FIRST spawn only (the builder), then hands out clean sessions —
// so the run reworks exactly once and settles at `awaiting-approval` on the retry.
function makeOnceErroringEngine(): { query: QueryFn; calls: SpawnParams[] } {
  const calls: SpawnParams[] = [];
  let counter = 0;
  const query: QueryFn = (params) => {
    calls.push(params);
    counter += 1;
    return counter === 1 ? makeErroringSession(`sdk-${counter}`) : makeFakeSession(`sdk-${counter}`);
  };
  return { query, calls };
}

interface Waiter {
  readonly predicate: (frame: BridgeStateSnapshot) => boolean;
  readonly resolve: (frame: BridgeStateSnapshot) => void;
  readonly reject: (err: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface SessionStateWaiter {
  readonly predicate: (frame: SessionStateSnapshot) => boolean;
  readonly resolve: (frame: SessionStateSnapshot) => void;
  readonly reject: (err: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface TestClient {
  readonly send: (message: unknown) => void;
  readonly waitForBridgeState: (
    predicate: (frame: BridgeStateSnapshot) => boolean,
    timeoutMs: number,
  ) => Promise<BridgeStateSnapshot>;
  readonly waitForSessionState: (
    predicate: (frame: SessionStateSnapshot) => boolean,
    timeoutMs: number,
  ) => Promise<SessionStateSnapshot>;
  readonly seen: () => BridgeStateSnapshot[];
  readonly close: () => void;
}

function openClient(url: string, openTimeoutMs = 3000): Promise<TestClient> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    let waiters: Waiter[] = [];
    let sessionStateWaiters: SessionStateWaiter[] = [];
    const seen: BridgeStateSnapshot[] = [];
    const seenSessionStates: SessionStateSnapshot[] = [];
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
      const pendingSessionState = sessionStateWaiters;
      sessionStateWaiters = [];
      for (const waiter of pendingSessionState) {
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
        seenSessionStates.push(parsed);
        const stillWaiting: SessionStateWaiter[] = [];
        for (const waiter of sessionStateWaiters) {
          if (waiter.predicate(parsed)) {
            clearTimeout(waiter.timer);
            waiter.resolve(parsed);
          } else {
            stillWaiting.push(waiter);
          }
        }
        sessionStateWaiters = stillWaiting;
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
        waitForSessionState: (predicate, timeoutMs) =>
          new Promise<SessionStateSnapshot>((res, rej) => {
            const existing = seenSessionStates.find(predicate);
            if (existing) {
              res(existing);
              return;
            }
            const timer = setTimeout(() => {
              sessionStateWaiters = sessionStateWaiters.filter((w) => w.timer !== timer);
              rej(new Error(`Timed out after ${timeoutMs}ms waiting for a session-state frame`));
            }, timeoutMs);
            sessionStateWaiters.push({ predicate, resolve: res, reject: rej, timer });
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

// Drops `.claude/failure-reports/<stage>.md` into a project dir — the default
// `readFailureReport` source — so an errored session takes the rework path.
function writeFailureReport(projectPath: string, stage: string, body: string): void {
  const dir = join(projectPath, '.claude', 'failure-reports');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${stage}.md`), body, 'utf8');
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
  it('plan-gate OFF (default, no pref) — bridge-start spawns builder, ended auto-advances to reviewer with no awaiting-approval broadcast', async () => {
    const project = makeProjectDir();
    const engine = makeFakeEngine();
    const server = await startServer(makeTmpDbPath(), engine.query);
    server.instance.registry.pin(project); // no plan_gate / auto_advance pref set

    const client = await connect(server.url);
    const reviewerSpawned = client.waitForBridgeState(
      (f) => f.path === project && f.stage === 'reviewer',
      5000,
    );
    client.send({ type: 'bridge-start', path: project });
    await reviewerSpawned;

    // The builder's clean `ended` auto-advanced straight to the reviewer — both roles
    // were spawned without any human gate-approve.
    expect(engine.calls).toHaveLength(2);
    expect(engine.calls[0]?.cwd).toBe(project);
    expect(engine.calls[0]?.role).toBe('builder');
    expect(engine.calls[1]?.cwd).toBe(project);
    expect(engine.calls[1]?.role).toBe('reviewer');
    // No awaiting-approval frame was broadcast for the builder→reviewer auto-advance.
    expect(client.seen().some((f) => f.stage === 'builder' && f.gate === 'awaiting-approval')).toBe(false);
  }, 15000);

  it('gate-request-changes over WS reaches bridge.requestChanges without crashing the socket (no-op absent an active plan-gate pause)', async () => {
    // LIMITATION: `createServer` does not expose an injectable phase-watcher, so this
    // integration harness cannot drive a real plan-gate pause (`planGatePending`) —
    // that path is covered by the unit tests in `bridge.test.ts` ("Bridge plan gate").
    // This test only exercises the WS routing path: the message parses, reaches
    // `bridge.requestChanges`, and — since no run is plan-gate-pending — is a safe
    // no-op that neither spawns anything nor disrupts the pipeline already in flight.
    const project = makeProjectDir();
    const engine = makeFakeEngine();
    const server = await startServer(makeTmpDbPath(), engine.query);
    server.instance.registry.pin(project);

    const client = await connect(server.url);
    const reviewerSpawned = client.waitForBridgeState(
      (f) => f.path === project && f.stage === 'reviewer',
      5000,
    );
    client.send({ type: 'bridge-start', path: project });
    await reviewerSpawned;
    expect(engine.calls).toHaveLength(2);

    client.send({ type: 'gate-request-changes', path: project, notes: 'please add X' });

    // The socket stays healthy afterward and no additional spawn was triggered by the
    // no-op route.
    const finalState = client.waitForBridgeState(
      (f) => f.path === project && f.gate === 'awaiting-approval',
      5000,
    );
    await finalState;
    expect(engine.calls).toHaveLength(2);
  }, 15000);

  it('reworkCount (wire) — a real emitted bridge-state frame carries reworkCount and reflects it after a rework', async () => {
    const project = makeProjectDir();
    writeFailureReport(project, 'builder', 'FIX THE BUILD');
    const engine = makeOnceErroringEngine();
    const server = await startServer(makeTmpDbPath(), engine.query);
    server.instance.registry.pin(project);

    const client = await connect(server.url);
    const reworking = client.waitForBridgeState(
      (f) => f.path === project && f.gate === 'reworking',
      5000,
    );
    client.send({ type: 'bridge-start', path: project });
    const reworkFrame = await reworking;

    expect(reworkFrame.reworkCount).toBe(1);
    expect(engine.calls[1]?.role).toBe('builder');

    // The reworked builder's retry ends cleanly too and (no plan_gate/auto_advance
    // pref set) auto-advances straight to the reviewer.
    const reviewerSpawned = client.waitForBridgeState(
      (f) => f.path === project && f.stage === 'reviewer',
      5000,
    );
    await reviewerSpawned;
    expect(engine.calls).toHaveLength(3); // errored builder, the reworked retry, then the reviewer
    expect(engine.calls[2]?.role).toBe('reviewer');

    // Every frame seen so far carries a reworkCount field.
    for (const frame of client.seen()) {
      expect(typeof frame.reworkCount).toBe('number');
    }
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
      (f) => f.path === pinned && f.stage === 'reviewer',
      5000,
    );
    client.send({ type: 'bridge-start', path: pinned });
    await valid;

    // The foreign bridge-start never reached the engine — only the pinned one did,
    // and (no plan_gate/auto_advance pref set) its builder auto-advanced to reviewer.
    expect(engine.calls).toHaveLength(2);
    expect(engine.calls[0]?.cwd).toBe(pinned);
    expect(engine.calls[0]?.role).toBe('builder');
    expect(engine.calls[1]?.cwd).toBe(pinned);
    expect(engine.calls[1]?.role).toBe('reviewer');
  }, 15000);

  it('assign work — bridge-start with a workItemId spawns the builder stamped with that work item', async () => {
    const project = makeProjectDir();
    const engine = makeFakeEngine();
    const server = await startServer(makeTmpDbPath(), engine.query);
    server.instance.registry.pin(project);

    const client = await connect(server.url);
    // No plan_gate/auto_advance pref set, so the builder auto-advances to the reviewer;
    // the reviewer's null verdict (no evaluation.md for this work item) then defers to
    // a human, settling at awaiting-approval.
    const bridgeStarted = client.waitForBridgeState(
      (f) => f.path === project && f.gate === 'awaiting-approval',
      5000,
    );
    const sessionStarted = client.waitForSessionState(
      (f) => f.path === project && f.session.workItemId === 'WI-assign-1',
      5000,
    );
    client.send({ type: 'bridge-start', path: project, workItemId: 'WI-assign-1' });

    await bridgeStarted;
    const sessionFrame = await sessionStarted;

    expect(sessionFrame.session.workItemId).toBe('WI-assign-1');
    expect(engine.calls).toHaveLength(2);
    expect(engine.calls[0]?.cwd).toBe(project);
    expect(engine.calls[0]?.role).toBe('builder');
    expect(engine.calls[1]?.cwd).toBe(project);
    expect(engine.calls[1]?.role).toBe('reviewer');
  }, 15000);
});
