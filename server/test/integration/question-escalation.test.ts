// Integration test (THE GATE) — Question + Escalation cards' server round-trip over the
// live WS transport.
//
// Boots the REAL server in-process (createServer({port:0,…})) with an INJECTED FAKE
// `query` engine (never live Claude) whose fake `EngineSession`s expose
// `onQuestionRequest`/`answerQuestion` directly to the test (mirroring
// permission-cards.test.ts's `makePermissionSession` pattern, but without a real
// broker — the fake captures the listener/calls itself), and a `bridge-start` pipeline
// driven through the REAL Bridge + SessionManager (mirroring bridge.test.ts's harness).
// Asserts on observable Bridge state (the broadcast `bridge-state` frames) + fake-engine
// call capture, per test-strategy.md's observability plan:
//   AC1 — a fake session raises a question (with chips) -> the broadcast bridge-state
//         carries a `question` inbox item with chips, gate='awaiting-approval' -> a
//         `question-answer {path, answer}` inbound frame resolves it: the fake engine's
//         `answerQuestion` is called with the parked requestId + answer, the question
//         item clears, gate returns to 'running'.
//   FAIL-CLOSED — a `question-answer` for an UNPINNED path is a silent no-op.
//   AC2 — a run driven to gate='escalated' (an errored builder with no failure report,
//         mirroring bridge.test.ts's `driveToEscalated`) resolves via each of the three
//         `escalation-choice` values: let-debug-try / give-guidance respawn the build
//         role (reworkCount reset, gate='reworking') with the debug prompt / guidance
//         notes; take-over clears the inbox and leaves gate='escalated'.
//   FAIL-CLOSED — an `escalation-choice` for an UNPINNED path is a silent no-op.
//
// Isolation: per-test tmp DB + real tmp project dirs (carrying a roster fixture so
// `readRoster` succeeds and the spawn containment guard passes); afterEach stops the
// server + removes DB sidecars and fixture dirs. NO live Claude.

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { createServer } from '../../src/index.js';
import { WS_PATH } from '../../src/config.js';
import { DEBUG_TAKEOVER_PROMPT } from '../../src/session/bridge.js';
import type {
  EngineMessage,
  EngineQuestionRequest,
  EngineSession,
  QueryFn,
  SpawnParams,
} from '../../src/session/session-engine.js';

// Self-provision a minimal valid roster fixture — a machine/CI-independent path (the
// repo checks out at a different absolute path on the CI runner). Mirrors bridge.test.ts's
// TEST_ROSTER: v2 shape, builder -> reviewer.
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

// ---------------------------------------------------------------------------
// Frame shapes observed by the in-test client (loose mirrors of the wire types).
// ---------------------------------------------------------------------------

type AnyFrame = Record<string, unknown> & { readonly type: string };

interface BridgeInboxItemWire {
  readonly stage: string;
  readonly kind: 'interrupt' | 'question' | 'escalation';
  readonly reason: string;
  readonly chips?: readonly string[];
  readonly ts: number;
}

interface BridgeStateFrame extends AnyFrame {
  readonly type: 'bridge-state';
  readonly path: string;
  readonly stage: string;
  readonly gate: string;
  readonly sessionId: string | null;
  readonly inbox: readonly BridgeInboxItemWire[];
  readonly reworkCount: number;
}

function isAnyFrame(value: unknown): value is AnyFrame {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>)['type'] === 'string'
  );
}

function isBridgeStateFrame(frame: AnyFrame): frame is BridgeStateFrame {
  return (
    frame.type === 'bridge-state' &&
    typeof frame['path'] === 'string' &&
    typeof frame['gate'] === 'string' &&
    Array.isArray(frame['inbox'])
  );
}

// ---------------------------------------------------------------------------
// Fake engine sessions — no live SDK, no real broker; the fake IS the capture point.
// ---------------------------------------------------------------------------

interface FakeQuestionSpawn {
  readonly params: SpawnParams;
  /** Fire the session's `onQuestionRequest` listener directly — the fake's stand-in for
   * the SDK calling the `ask_operator` MCP tool. */
  readonly raiseQuestion: (question: string, chips: readonly string[], requestId: string) => void;
  /** Every `answerQuestion(requestId, answer)` call the fake session received. */
  readonly answerCalls: () => readonly { readonly requestId: string; readonly answer: string }[];
  readonly release: () => void;
}

/** A session that yields `system/init` then holds open until released — captures its
 * `onQuestionRequest` listener and every `answerQuestion` call directly (no real broker;
 * the test drives `raiseQuestion` itself, mirroring how the SDK would invoke the tool). */
function makeQuestionSession(sdkId: string): FakeQuestionSpawn & { readonly engine: EngineSession } {
  let listener: ((req: EngineQuestionRequest) => void) | null = null;
  const answerCalls: { requestId: string; answer: string }[] = [];
  let unpark: (() => void) | null = null;
  let released = false;

  const wake = (): void => {
    if (unpark !== null) {
      const r = unpark;
      unpark = null;
      r();
    }
  };

  async function* gen(): AsyncGenerator<EngineMessage> {
    yield { type: 'system', subtype: 'init', session_id: sdkId };
    if (released) return;
    await new Promise<void>((resolve) => {
      unpark = resolve;
    });
  }

  const release = (): void => {
    released = true;
    wake();
  };

  const engine: EngineSession = Object.assign(gen(), {
    interrupt: async (): Promise<unknown> => {
      release();
      return undefined;
    },
    send: async (): Promise<void> => {},
    onPermissionRequest: (): void => {},
    resolvePermission: (): void => {},
    onQuestionRequest: (l: (req: EngineQuestionRequest) => void): void => {
      listener = l;
    },
    answerQuestion: (requestId: string, answer: string): void => {
      answerCalls.push({ requestId, answer });
    },
    end: (): void => release(),
  });

  return {
    engine,
    params: undefined as unknown as SpawnParams, // overwritten by makeFakeEngine below
    raiseQuestion: (question, chips, requestId) => {
      listener?.({ requestId, question, chips });
    },
    answerCalls: () => [...answerCalls],
    release,
  };
}

function makeFakeEngine(): { query: QueryFn; spawns: FakeQuestionSpawn[] } {
  const spawns: FakeQuestionSpawn[] = [];
  let counter = 0;
  const query: QueryFn = (params) => {
    counter += 1;
    const session = makeQuestionSession(`sdk-${counter}`);
    spawns.push({ ...session, params });
    return session.engine;
  };
  return { query, spawns };
}

// A session that yields `system/init` then throws — an `errored` end. With no
// `.claude/failure-reports/<stage>.md` on disk, the Bridge's default `readFailureReport`
// returns null, so `handleErrored` escalates immediately (mirrors bridge.test.ts's
// `driveToEscalated`, which passes `readFailureReport: () => null` explicitly — this
// integration harness can't inject that dep, so it relies on the file genuinely being
// absent instead).
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

// A session that yields `system/init` then holds open until `interrupt()`/`end()`
// releases it — used for the reworked builder respawn after an escalation choice, so
// the run stays observably at `gate:'reworking'` with the respawn's `SpawnParams`
// captured, instead of racing an immediate clean `ended` into the next pipeline
// advance. `interrupt()` releases the generator (mirrors `server.stop()` ->
// `stopAll()`'s teardown interrupt of every live session on afterEach).
function makeHoldingSession(sdkId: string): EngineSession {
  let unpark: (() => void) | null = null;
  let released = false;

  const wake = (): void => {
    if (unpark !== null) {
      const r = unpark;
      unpark = null;
      r();
    }
  };

  async function* gen(): AsyncGenerator<EngineMessage> {
    yield { type: 'system', subtype: 'init', session_id: sdkId };
    if (released) return;
    await new Promise<void>((resolve) => {
      unpark = resolve;
    });
  }

  const release = (): void => {
    released = true;
    wake();
  };

  return Object.assign(gen(), {
    interrupt: async (): Promise<unknown> => {
      release();
      return undefined;
    },
    send: async (): Promise<void> => {},
    onPermissionRequest: (): void => {},
    resolvePermission: (): void => {},
    onQuestionRequest: (): void => {},
    answerQuestion: (): void => {},
    end: (): void => release(),
  });
}

/** First spawn errors (no failure report on disk -> immediate escalate); every
 * subsequent spawn (an escalation-choice respawn) holds open. */
function makeEscalatingEngine(): { query: QueryFn; calls: SpawnParams[] } {
  const calls: SpawnParams[] = [];
  let counter = 0;
  const query: QueryFn = (params) => {
    calls.push(params);
    counter += 1;
    return counter === 1 ? makeErroringSession(`sdk-${counter}`) : makeHoldingSession(`sdk-${counter}`);
  };
  return { query, calls };
}

// ---------------------------------------------------------------------------
// In-test WS client — collects every bridge-state frame; generic predicate waiter.
// ---------------------------------------------------------------------------

interface Waiter {
  readonly predicate: (frame: BridgeStateFrame) => boolean;
  readonly resolve: (frame: BridgeStateFrame) => void;
  readonly reject: (err: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface TestClient {
  readonly send: (message: unknown) => void;
  readonly waitForBridgeState: (
    predicate: (frame: BridgeStateFrame) => boolean,
    timeoutMs: number,
    label: string,
  ) => Promise<BridgeStateFrame>;
  /** Like `waitForBridgeState`, but NEVER matches an already-seen frame — only a frame
   * that arrives strictly after this call. Needed when the target `gate`/inbox shape
   * can also match an earlier, unrelated frame (e.g. `gate:'running'` right after the
   * initial spawn), which would otherwise resolve immediately on stale state. */
  readonly waitForNextBridgeState: (
    predicate: (frame: BridgeStateFrame) => boolean,
    timeoutMs: number,
    label: string,
  ) => Promise<BridgeStateFrame>;
  readonly waitForGitState: (path: string, timeoutMs: number) => Promise<void>;
  readonly close: () => void;
}

function openClient(url: string, openTimeoutMs = 3000): Promise<TestClient> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    let waiters: Waiter[] = [];
    let gitStateWaiters: Array<{
      readonly path: string;
      readonly resolve: () => void;
      readonly timer: ReturnType<typeof setTimeout>;
    }> = [];
    const seen: BridgeStateFrame[] = [];
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
      if (parsed.type === 'git-state' && typeof parsed['path'] === 'string') {
        const path = parsed['path'] as string;
        const stillWaiting: typeof gitStateWaiters = [];
        for (const waiter of gitStateWaiters) {
          if (waiter.path === path) {
            clearTimeout(waiter.timer);
            waiter.resolve();
          } else {
            stillWaiting.push(waiter);
          }
        }
        gitStateWaiters = stillWaiting;
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
        waitForBridgeState: (predicate, timeoutMs, label) =>
          new Promise<BridgeStateFrame>((res, rej) => {
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
        waitForNextBridgeState: (predicate, timeoutMs, label) =>
          new Promise<BridgeStateFrame>((res, rej) => {
            const timer = setTimeout(() => {
              waiters = waiters.filter((w) => w.timer !== timer);
              rej(new Error(`Timed out after ${timeoutMs}ms waiting for ${label}`));
            }, timeoutMs);
            waiters.push({ predicate, resolve: res, reject: rej, timer });
          }),
        waitForGitState: (path, timeoutMs) =>
          new Promise<void>((res, rej) => {
            const timer = setTimeout(() => {
              gitStateWaiters = gitStateWaiters.filter((w) => w.timer !== timer);
              rej(new Error(`Timed out after ${timeoutMs}ms waiting for git-state fence`));
            }, timeoutMs);
            gitStateWaiters.push({ path, resolve: res, timer });
          }),
        close: () => {
          socket.removeAllListeners();
          socket.close();
        },
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Server + fixture lifecycle (mirrors bridge.test.ts / permission-cards.test.ts).
// ---------------------------------------------------------------------------

const activeClients: TestClient[] = [];
const activeStops: Array<() => Promise<void>> = [];
const tmpDbPaths: string[] = [];
const tmpDirs: string[] = [];

function makeTmpDbPath(): string {
  const path = join(tmpdir(), `devos-qesc-${randomUUID()}.db`);
  tmpDbPaths.push(path);
  return path;
}

// A REAL project dir under tmpdir carrying a roster fixture — spawn requires the cwd to
// realpath-resolve within a configured project root, and the Bridge requires
// `readRoster` to succeed. No `.claude/failure-reports/` dir — deliberately absent, so
// an errored builder escalates immediately rather than reworking.
function makeProjectDir(): string {
  const path = join(tmpdir(), `devos-qesc-proj-${randomUUID()}`);
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

// The fake sessions used below deliberately HOLD OPEN (never end on their own) so the
// test can assert on a stable mid-run state. `server.stop()` -> `sessionManager.stopAll()`
// interrupts every still-live session at teardown, which ends it — and an unpaused
// Bridge run auto-advances on a clean `ended` (bridge.ts's `handleEnded`), spawning the
// NEXT pipeline role from the very same fake engine, which ALSO holds open and was
// never captured by `stopAll`'s snapshot, hanging teardown indefinitely. Explicitly
// pausing the run (`bridge-interrupt`) before a test ends sidesteps this: `handleEnded`
// sees `run.paused` and stops at `awaiting-approval` instead of advancing, so teardown's
// single interrupt cleanly settles the one live session with no cascade.
async function pauseRunForTeardown(client: TestClient, project: string): Promise<void> {
  const paused = client.waitForNextBridgeState(
    (f) => f.path === project && f.gate === 'awaiting-approval',
    5000,
    'bridge-state paused for teardown',
  );
  client.send({ type: 'bridge-interrupt', path: project, reason: 'test teardown' });
  await paused;
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

describe('Question + Escalation cards over the live WS transport', () => {
  it('AC1 — question round-trip: raise (chips, awaiting-approval) -> question-answer -> answerQuestion called, item cleared, gate running', async () => {
    const project = makeProjectDir();
    const engine = makeFakeEngine();
    const server = await startServer(makeTmpDbPath(), engine.query);
    server.instance.registry.pin(project);

    const client = await connect(server.url);
    const builderSpawned = client.waitForBridgeState(
      (f) => f.path === project && f.stage === 'builder',
      5000,
      'builder spawned',
    );
    client.send({ type: 'bridge-start', path: project });
    await builderSpawned;

    const builder = engine.spawns[0];
    if (builder === undefined) throw new Error('expected a spawned builder session');

    const requestId = 'req-question-1';
    const parked = client.waitForBridgeState(
      (f) =>
        f.path === project &&
        f.gate === 'awaiting-approval' &&
        f.inbox.some((item) => item.kind === 'question' && item.chips !== undefined),
      5000,
      'bridge-state carrying the parked question item',
    );
    builder.raiseQuestion('Which approach should the agent take?', ['Option A', 'Option B'], requestId);
    const parkedFrame = await parked;

    const questionItem = parkedFrame.inbox.find(
      (item) => item.kind === 'question' && item.chips !== undefined,
    );
    expect(questionItem?.chips).toEqual(['Option A', 'Option B']);
    expect(questionItem?.reason).toBe('Which approach should the agent take?');
    // The turn is genuinely paused — no answerQuestion call has happened yet.
    expect(builder.answerCalls()).toEqual([]);

    const resumed = client.waitForNextBridgeState(
      (f) => f.path === project && f.gate === 'running',
      5000,
      'bridge-state back to running',
    );
    client.send({ type: 'question-answer', path: project, answer: 'Option A' });
    const resumedFrame = await resumed;

    expect(builder.answerCalls()).toEqual([{ requestId, answer: 'Option A' }]);
    expect(resumedFrame.inbox.some((item) => item.kind === 'question' && item.chips !== undefined)).toBe(
      false,
    );

    await pauseRunForTeardown(client, project);
  }, 15000);

  it('FAIL-CLOSED — a question-answer for an unpinned path is a no-op', async () => {
    const project = makeProjectDir();
    const foreign = join(tmpdir(), `devos-qesc-foreign-${randomUUID()}`);
    const engine = makeFakeEngine();
    const server = await startServer(makeTmpDbPath(), engine.query);
    server.instance.registry.pin(project); // only `project` is allowlisted

    const client = await connect(server.url);
    const builderSpawned = client.waitForBridgeState(
      (f) => f.path === project && f.stage === 'builder',
      5000,
      'builder spawned',
    );
    client.send({ type: 'bridge-start', path: project });
    await builderSpawned;

    const builder = engine.spawns[0];
    if (builder === undefined) throw new Error('expected a spawned builder session');

    const requestId = 'req-question-noop';
    const parked = client.waitForBridgeState(
      (f) =>
        f.path === project &&
        f.gate === 'awaiting-approval' &&
        f.inbox.some((item) => item.kind === 'question' && item.chips !== undefined),
      5000,
      'bridge-state carrying the parked question item',
    );
    builder.raiseQuestion('Pick one', [], requestId);
    await parked;

    // question-answer for the FOREIGN (unpinned) path — must be dropped, no engine call.
    client.send({ type: 'question-answer', path: foreign, answer: 'nope' });

    // Fence: once a git-state reply for the pinned project arrives, the earlier same-
    // socket frame has been fully processed by the gateway.
    client.send({ type: 'git-state', path: project });
    await client.waitForGitState(project, 5000);

    expect(builder.answerCalls()).toEqual([]);
    expect(server.instance.bridge.getState(project)?.gate).toBe('awaiting-approval');
  }, 15000);

  describe('AC2 — escalation choices', () => {
    async function driveToEscalated(): Promise<{
      readonly server: RunningServer;
      readonly client: TestClient;
      readonly project: string;
      readonly calls: SpawnParams[];
    }> {
      const project = makeProjectDir();
      const engine = makeEscalatingEngine();
      const server = await startServer(makeTmpDbPath(), engine.query);
      server.instance.registry.pin(project);

      const client = await connect(server.url);
      const escalated = client.waitForBridgeState(
        (f) => f.path === project && f.gate === 'escalated',
        5000,
        'bridge-state escalated',
      );
      client.send({ type: 'bridge-start', path: project });
      await escalated;

      expect(engine.calls).toHaveLength(1);
      return { server, client, project, calls: engine.calls };
    }

    it('let-debug-try resets reworkCount + respawns the build role with the debug prompt', async () => {
      const { client, project, calls } = await driveToEscalated();

      const reworking = client.waitForBridgeState(
        (f) => f.path === project && f.gate === 'reworking',
        5000,
        'bridge-state reworking',
      );
      client.send({ type: 'escalation-choice', path: project, choice: 'let-debug-try' });
      const reworkFrame = await reworking;

      expect(reworkFrame.reworkCount).toBe(0);
      expect(reworkFrame.inbox).toHaveLength(0);
      expect(calls).toHaveLength(2);
      expect(calls[1]?.role).toBe('builder');
      expect(calls[1]?.prompt).toBe(DEBUG_TAKEOVER_PROMPT);

      await pauseRunForTeardown(client, project);
    }, 15000);

    it('give-guidance respawns the build role with the operator notes as the prompt', async () => {
      const { client, project, calls } = await driveToEscalated();

      const reworking = client.waitForBridgeState(
        (f) => f.path === project && f.gate === 'reworking',
        5000,
        'bridge-state reworking',
      );
      client.send({
        type: 'escalation-choice',
        path: project,
        choice: 'give-guidance',
        notes: 'try a different library',
      });
      await reworking;

      expect(calls).toHaveLength(2);
      expect(calls[1]?.role).toBe('builder');
      expect(calls[1]?.prompt).toBe('try a different library');

      await pauseRunForTeardown(client, project);
    }, 15000);

    it('take-over clears the inbox and leaves gate escalated (Bridge relinquishes)', async () => {
      const { client, project, calls } = await driveToEscalated();

      const cleared = client.waitForBridgeState(
        (f) => f.path === project && f.gate === 'escalated' && f.inbox.length === 0,
        5000,
        'bridge-state cleared, still escalated',
      );
      client.send({ type: 'escalation-choice', path: project, choice: 'take-over' });
      const clearedFrame = await cleared;

      expect(clearedFrame.gate).toBe('escalated');
      expect(clearedFrame.inbox).toHaveLength(0);
      // No respawn — the Bridge relinquishes.
      expect(calls).toHaveLength(1);
    }, 15000);
  });

  it('FAIL-CLOSED — an escalation-choice for an unpinned path is a no-op', async () => {
    const project = makeProjectDir();
    const foreign = join(tmpdir(), `devos-qesc-esc-foreign-${randomUUID()}`);
    const engine = makeEscalatingEngine();
    const server = await startServer(makeTmpDbPath(), engine.query);
    server.instance.registry.pin(project); // only `project` is allowlisted

    const client = await connect(server.url);
    const escalated = client.waitForBridgeState(
      (f) => f.path === project && f.gate === 'escalated',
      5000,
      'bridge-state escalated',
    );
    client.send({ type: 'bridge-start', path: project });
    await escalated;
    expect(engine.calls).toHaveLength(1);

    // escalation-choice for the FOREIGN (unpinned) path — must be dropped, no respawn.
    client.send({ type: 'escalation-choice', path: foreign, choice: 'take-over' });

    // Fence: once a git-state reply for the pinned project arrives, the earlier same-
    // socket frame has been fully processed by the gateway.
    client.send({ type: 'git-state', path: project });
    await client.waitForGitState(project, 5000);

    expect(engine.calls).toHaveLength(1);
    const state = server.instance.bridge.getState(project);
    expect(state?.gate).toBe('escalated');
    expect(state?.inbox.length).toBeGreaterThan(0);
  }, 15000);
});
